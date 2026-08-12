# PayTo Payment integration seams

## Question

Where does the current Convex system establish confirmed active PayTo Agreements, schedule durable work, ingest Zepto webhooks, reconcile provider state, preserve evidence, and project Money Request data? This note maps those seams and constraints without selecting a PayTo Payment architecture.

## Executive answer

The current system has one authoritative **confirmed-active boundary**: `payToAgreementReconciliation.recordSuccess`. Agreement creation and signed webhooks may both project `active`, but they deliberately write it with `lifecycleConfidence: 'provisional'`. A leased GET reconciliation promotes a known provider state to `confirmed`, records normalized evidence, and schedules the next check. For an active agreement, that same path runs again on a daily cadence, so “confirmed active” is a repeatable observation rather than a one-shot event.

PayMe already has two durable-work patterns: a bounded Workpool-backed agreement-creation workflow, and database work items dispatched by a cron into leased reconciliation actions. It also has a signed, transactionally deduplicated webhook ingress, but that ingress currently accepts only `payto_agreement` resources and discards the resource type after validation. Money Request projections expose agreement creation/lifecycle/tracking state to the requester and each payer while hiding provider IDs and encrypted routing data. There is no payment persistence, evidence, work item, reconciliation, or public projection yet.

## Existing flow

### 1. Money Request acceptance allocates immutable provider intent

`moneyRequests.submit` allocates a UUID for each payer, then calls one internal mutation with every allocation ([`convex/moneyRequests.ts:439-510`](../../convex/moneyRequests.ts#L439-L510)). `moneyRequests.accept` atomically inserts:

- the Money Request, including fixed AUD cents, description, and the creditor routing snapshot;
- one sandbox Zepto PayTo Agreement per payer, including its stable provider UID and debtor routing snapshot;
- initial `local_accepted` evidence;
- one creation work item per agreement; and
- one Workpool action per agreement ([`convex/moneyRequests.ts:643-695`](../../convex/moneyRequests.ts#L643-L695)).

The schema indexes agreements by Money Request, payer, the pair, and `(environment, providerUid)`; it stores lifecycle confidence independently from lifecycle state ([`convex/schema.ts:57-141`](../../convex/schema.ts#L57-L141)). The routing snapshots contain encrypted account data plus masked display and key metadata, rather than pointers alone ([`convex/validators/payToAgreements.ts:25-31`](../../convex/validators/payToAgreements.ts#L25-L31)). A test confirms those snapshots survive later deletion of the source payment destination ([`convex/moneyRequests.test.ts:2228-2255`](../../convex/moneyRequests.test.ts#L2228-L2255)).

**Invariant:** the provider UID and payment terms originate before external work and survive retries. Provider work does not reread mutable default destinations; agreement creation claims the stored Money Request and agreement snapshots ([`convex/payToAgreementCreation.ts:113-227`](../../convex/payToAgreementCreation.ts#L113-L227)).

### 2. Agreement creation establishes only provisional lifecycle truth

Agreement creation uses a dedicated Workpool configured for five-way parallelism with automatic action retries disabled ([`convex/lib/agreementCreationPool.ts:1-10`](../../convex/lib/agreementCreationPool.ts#L1-L10)). The creation state machine owns explicit leases, POST/GET attempt evidence, ambiguity verification, and delayed re-enqueueing. On every claim it also schedules a delayed copy of the action at the lease horizon, so a crashed worker cannot strand the work ([`convex/payToAgreementCreation.ts:100-110`](../../convex/payToAgreementCreation.ts#L100-L110), [`convex/payToAgreementCreation.ts:135-227`](../../convex/payToAgreementCreation.ts#L135-L227)).

When POST or same-UID verification finds the agreement, `recordCreated`:

- marks creation complete;
- copies the provider lifecycle state with **provisional** confidence;
- records normalized creation evidence;
- completes the creation work item; and
- creates or updates a reconciliation work item due 30 minutes later ([`convex/payToAgreementCreation.ts:336-413`](../../convex/payToAgreementCreation.ts#L336-L413)).

Therefore even a create response whose state is `active` is not the accepted trigger described by the product policy: the creation boundary never writes confirmed lifecycle confidence.

### 3. Signed webhooks are provisional signals that force confirmation

The HTTP route at `/zepto/webhooks` reads exact raw bytes, verifies the `split-signature` and timestamp, parses the normalized payload, and calls a single internal mutation; verification or parsing failures do not call the mutation ([`convex/http.ts:223-271`](../../convex/http.ts#L223-L271), [`convex/http.ts:291-303`](../../convex/http.ts#L291-L303)). Signature tests cover exact-byte binding and timestamp tolerance ([`convex/lib/zepto/webhook.test.ts:32-105`](../../convex/lib/zepto/webhook.test.ts#L32-L105)).

`zeptoWebhook.applyDelivery` is one Convex transaction. It deduplicates first by delivery ID and then by provider event ID, stores normalized delivery/event records, looks up the agreement by sandbox provider UID, applies supported lifecycle events provisionally, preserves confirmed terminal truth and newer provisional signals, appends agreement evidence, and upserts reconciliation work for immediate availability ([`convex/zeptoWebhook.ts:27-184`](../../convex/zeptoWebhook.ts#L27-L184)). Tests show multi-item delivery state, evidence, and reconciliation are committed together, and that an activated signal appears publicly as `ready` but `provisional` ([`convex/zeptoWebhook.test.ts:244-321`](../../convex/zeptoWebhook.test.ts#L244-L321)). Delivery replays and event replays are no-ops, while a new event beside a duplicate still commits ([`convex/zeptoWebhook.test.ts:424-460`](../../convex/zeptoWebhook.test.ts#L424-L460)).

**Current webhook constraint:** the parser rejects every resource whose `resource_type` is not exactly `payto_agreement` ([`convex/http.ts:190-220`](../../convex/http.ts#L190-L220)). The normalized webhook item and persisted event do not carry a resource-type discriminator ([`convex/validators/zeptoWebhook.ts:17-36`](../../convex/validators/zeptoWebhook.ts#L17-L36)). Consequently the existing ingress cannot accept PayTo Payment events without an explicit resource-routing and persistence decision.

### 4. GET reconciliation establishes confirmed active

Reconciliation work is stored separately per agreement, with queued/running/stopped state, availability time, lease identity/expiry, failure counters, outage start, and last-success time ([`convex/schema.ts:262-279`](../../convex/schema.ts#L262-L279)). A one-minute cron finds due queued work and expired leases, then uses the Convex scheduler to launch reconciliation actions ([`convex/crons.ts:1-14`](../../convex/crons.ts#L1-L14), [`convex/payToAgreementReconciliation.ts:384-419`](../../convex/payToAgreementReconciliation.ts#L384-L419)).

The action claims a three-minute lease, GETs the agreement by stable UID, and writes the outcome only if the lease token is still current and unexpired ([`convex/payToAgreementReconciliation.ts:43-120`](../../convex/payToAgreementReconciliation.ts#L43-L120), [`convex/payToAgreementReconciliation.ts:451-510`](../../convex/payToAgreementReconciliation.ts#L451-L510)). `recordSuccess` is the concrete confirmed-active seam: for a known non-contradictory state it patches lifecycle confidence to `confirmed`, clears provisional publication metadata and failures, marks tracking current, reschedules the work, and appends `provider_lifecycle_get_observed` evidence ([`convex/payToAgreementReconciliation.ts:151-194`](../../convex/payToAgreementReconciliation.ts#L151-L194), [`convex/payToAgreementReconciliation.ts:251-258`](../../convex/payToAgreementReconciliation.ts#L251-L258)). The integration test proves `active` becomes public `ready` with confirmed confidence and is next due after 24 hours ([`convex/payToAgreementReconciliation.test.ts:194-245`](../../convex/payToAgreementReconciliation.test.ts#L194-L245)).

The schedule is state-sensitive: pending/created agreements poll after 30 minutes; active, suspended, and unknown states poll daily; confirmed terminal states stop ([`convex/payToAgreementReconciliationState.ts:23-31`](../../convex/payToAgreementReconciliationState.ts#L23-L31)). Reconciliation preserves a confirmed terminal state when GET contradicts it, and instead marks the record for review ([`convex/payToAgreementReconciliationState.ts:51-76`](../../convex/payToAgreementReconciliationState.ts#L51-L76), [`convex/payToAgreementReconciliation.test.ts:337-370`](../../convex/payToAgreementReconciliation.test.ts#L337-L370)). Duplicate workers cannot claim a live lease, an expired lease can be replaced, and a stale result is rejected ([`convex/payToAgreementReconciliation.test.ts:468-510`](../../convex/payToAgreementReconciliation.test.ts#L468-L510)).

**Trigger constraint:** confirmed active is not edge-triggered today. A webhook can make reconciliation immediately due, and the daily poll can confirm `active` repeatedly. Any future transfer trigger must distinguish “this obligation already has its one payment intent” from “active was confirmed again”; checking only the observed state/confidence is insufficient.

## Reusable seams and their limits

| Concern                  | Existing seam                                                         | Reusable property                                                                                | Current limit for PayTo Payments                                               |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Stable external identity | UID allocated before provider work in `moneyRequests.submit`/`accept` | Same UID is reused across uncertain POST/GET recovery                                            | No payment UID is allocated or persisted                                       |
| Atomic activation record | `payToAgreementReconciliation.recordSuccess`                          | Confirmed lifecycle write, work reschedule, and evidence share one transaction                   | It can observe confirmed active repeatedly and has no payment uniqueness guard |
| Bounded creation work    | Agreement Workpool + explicit work/evidence state                     | Parallelism cap, no implicit action retries, leases, delayed recovery                            | Workpool is named and configured specifically for agreement creation           |
| Long-lived repair        | Reconciliation DB work item + minute cron + scheduler                 | Due scan, expired-lease recovery, bounded batch of 50                                            | Schema and dispatcher are agreement-specific                                   |
| Trusted provider signal  | `/zepto/webhooks` + `applyDelivery`                                   | Exact-byte signature verification, delivery/event dedupe, atomic commit                          | Parser permits only `payto_agreement`; stored event lacks resource type        |
| Provider truth           | GET adapter + leased `recordSuccess`                                  | Runtime response checks, confirmed projection, contradiction handling                            | Only agreement GET/history adapters exist                                      |
| Evidence                 | `payToAgreementEvidence`, delivery and event tables                   | Normalized categories and identifiers rather than retaining HTTP responses                       | Every evidence variant has an agreement foreign key; no payment evidence model |
| User projection          | `moneyRequests.get`, requested/assigned lists                         | Requester sees all payer obligations; payer sees only their own; provider internals stay private | Public vocabulary covers agreement creation/lifecycle/tracking only            |

The generated Zepto client already contains create/list/get PayTo Payment operations ([`convex/lib/zepto/generated/payTo.ts:1064-1229`](../../convex/lib/zepto/generated/payTo.ts#L1064-L1229)) and the payment-retry operation ([`convex/lib/zepto/generated/payTo.ts:1298-1372`](../../convex/lib/zepto/generated/payTo.ts#L1298-L1372)). Its transport retries POST `/payto/payments` only when the request body carries a caller UID ([`convex/lib/zepto/client.ts:23-27`](../../convex/lib/zepto/client.ts#L23-L27), [`convex/lib/zepto/client.ts:93-121`](../../convex/lib/zepto/client.ts#L93-L121)). A test exercises this exact UID-gated retry behavior ([`convex/lib/zepto/client.test.ts:336-357`](../../convex/lib/zepto/client.test.ts#L336-L357)). There is, however, no application-owned payment adapter comparable to `lib/zepto/agreement.ts` or `lib/zepto/reconciliation.ts`, so response validation and domain normalization remain unimplemented.

## Evidence and privacy constraints

The schema separates stable domain state, append-only agreement evidence, provider delivery/event dedupe, and operational work state ([`convex/schema.ts:76-305`](../../convex/schema.ts#L76-L305)). Creation evidence records attempt numbers, safe categories, provider state, and timestamps rather than provider response bodies. Reconciliation evidence similarly stores state/outcome or normalized error category; provider history evidence is reduced to counts, event types, and latest publication time ([`convex/schema.ts:143-250`](../../convex/schema.ts#L143-L250)).

Public Money Request detail maps raw agreement states to user meanings (`active` becomes `ready`) and omits provider UID, routing snapshots, causes, and evidence ([`convex/moneyRequests.ts:714-838`](../../convex/moneyRequests.ts#L714-L838)). The requester detail loads every agreement, while payer detail resolves only the viewer's agreement ([`convex/moneyRequests.ts:897-960`](../../convex/moneyRequests.ts#L897-L960)). Requested-list summaries count creation, lifecycle, and tracking meanings across payers ([`convex/moneyRequests.ts:860-922`](../../convex/moneyRequests.ts#L860-L922)); tests explicitly assert that provider UID and debtor snapshots do not leak through that list ([`convex/moneyRequests.test.ts:1806-1824`](../../convex/moneyRequests.test.ts#L1806-L1824)).

These are established information-flow constraints for any payment status: provider identity and sensitive routing data are internal, requester aggregation is cross-payer, and a payer's view is scoped to their own obligation.

## Environment constraint

All persisted agreements currently declare literal `provider: 'zepto'`, `environment: 'sandbox'`, and API version `20260101` ([`convex/schema.ts:76-85`](../../convex/schema.ts#L76-L85)). Agreement creation and reconciliation call `createSandboxZeptoClientFromEnv`, which rejects non-sandbox configuration and requires the sandbox token ([`convex/lib/zepto/env.ts:22-44`](../../convex/lib/zepto/env.ts#L22-L44)). The shared client itself knows both sandbox and production origins and blocks sandbox simulation outside sandbox ([`convex/lib/zepto/client.ts:40-69`](../../convex/lib/zepto/client.ts#L40-L69), [`convex/lib/zepto/client.ts:241-275`](../../convex/lib/zepto/client.ts#L241-L275)), but the current orchestration is intentionally sandbox-only.

## Decisions and fog surfaced (not resolved here)

1. **Where is the durable one-payment invariant owned?** Confirmed-active writes repeat. A future payment intent needs a unique relationship to one payer obligation and an atomic guard against repeated activation confirmation, webhook replay, cron replay, and worker recovery.
2. **Which durable-work pattern owns payment creation and reconciliation?** The codebase offers a bounded Workpool state machine and a cron-dispatched leased work table, but both are agreement-specific and solve different timing shapes.
3. **How should webhook resources be discriminated and routed?** Payment events cannot pass the current parser. A decision is needed on shared versus resource-specific ingress normalization, dedupe identity, event storage, evidence, and transactional routing.
4. **What is authoritative for payment lifecycle truth?** Agreement webhooks are provisional and GET is confirmed. Payment settlement, failure, pending, and investigation need an explicit confidence/ordering/reconciliation policy, including missed and contradictory signals.
5. **How is payment status projected?** Existing requester and payer authorization seams are reusable, but the aggregate Money Request vocabulary and per-obligation payment vocabulary do not yet exist.
6. **What evidence is retained for payment attempts and outcomes?** The current convention strongly favors bounded normalized evidence and no raw HTTP responses, but the exact provider identifiers, failure fields, retryability, and operator recovery facts remain to be selected.
7. **How does sandbox certification graduate to production?** Current orchestration cannot run against production by construction. The rollout gate, persisted environment model, credential path, and production enablement work remain separate decisions.

## Test-backed invariants to preserve

- A signed activation webhook may make the agreement `ready`, but only provisionally; reconciliation is scheduled immediately ([`convex/zeptoWebhook.test.ts:244-321`](../../convex/zeptoWebhook.test.ts#L244-L321)).
- GET reconciliation is the confirmation boundary for `active`, retains normalized evidence, and remains scheduled daily ([`convex/payToAgreementReconciliation.test.ts:194-245`](../../convex/payToAgreementReconciliation.test.ts#L194-L245)).
- Replayed deliveries/events and duplicate workers are harmless; expired work is recoverable ([`convex/zeptoWebhook.test.ts:424-460`](../../convex/zeptoWebhook.test.ts#L424-L460), [`convex/payToAgreementReconciliation.test.ts:468-510`](../../convex/payToAgreementReconciliation.test.ts#L468-L510)).
- Confirmed terminal agreement truth is not overwritten by later contradictory webhook or GET evidence ([`convex/zeptoWebhook.test.ts:462-503`](../../convex/zeptoWebhook.test.ts#L462-L503), [`convex/payToAgreementReconciliation.test.ts:337-370`](../../convex/payToAgreementReconciliation.test.ts#L337-L370)).
- Money Request state is partitioned per payer, source routing terms remain immutable, and public projections do not expose provider or encrypted routing internals ([`convex/moneyRequests.test.ts:1733-1764`](../../convex/moneyRequests.test.ts#L1733-L1764), [`convex/moneyRequests.test.ts:2228-2255`](../../convex/moneyRequests.test.ts#L2228-L2255)).
