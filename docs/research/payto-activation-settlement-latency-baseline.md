# PayTo activation-to-settlement latency baseline

Checked: 2026-08-18

## Question and scope

What currently determines the time from durable receipt of a PayTo Agreement activation webhook to recording GET-confirmed PayTo Payment settlement, in healthy operation and in degraded operation involving missed webhooks, backlogs, or in-flight reconciliation races?

This note is a baseline, not an implementation plan. It preserves the existing safety contract: an activation webhook is provisional until the Agreement's per-UID GET confirms `active`; a Payment POST response and Payment webhooks are provisional; settlement is recorded only from a fenced per-UID Payment GET; one permanent Payment identity is retained per Agreement.

## Evidence and limits

The measured sample comes from the 2026-08-18 development-deployment investigation recorded in `/private/tmp/pay-me-handoff-2026-08-18.md` (`friendly-caribou-987`). The source artifact contains deployed Convex timestamps but no provider payloads, credentials, routing details, or user data. Its relevant raw timestamps are copied below so the evidence survives beyond that temporary file. The Wayfinder map independently preserves the headline measurements in its [Notes](https://github.com/hieu-lai/pay-me/issues/64).

The configured timings and queue behavior below come from the repository at this branch's parent commit. They are bounds imposed by code, not measurements of Convex scheduler or Workpool service latency. No additional live payment was initiated for this research.

## Measured sample

| Event | Epoch milliseconds | Since activation webhook |
| --- | ---: | ---: |
| Agreement document created | `1787018201937.572` | -1.403 s |
| Activation webhook observed/durably recorded | `1787018203341` | 0 |
| Agreement reconciliation lease claimed | `1787018251020` | 47.679 s |
| Agreement GET confirmed `active` | `1787018251351` | 48.010 s |
| Payment document created | `1787018251353.3606` | 48.012 s |
| Settlement webhook observed/durably recorded | `1787018252141` | 48.800 s |
| Payment GET-confirmed settlement recorded | `1787018253318` | 49.977 s |

The sample decomposes as follows:

- Activation webhook to Agreement reconciliation claim: **47.679 s** (95.4% of the 49.977 s activation-to-recorded-settlement interval).
- Agreement provider GET: **331 ms**.
- Confirmed activation to Payment document creation: **2.36 ms**.
- Payment document creation to settlement webhook receipt: **787.64 ms**.
- Settlement webhook receipt to GET-confirmed settlement recording: **1.177 s**.
- Confirmed activation/Payment establishment to recorded settlement: **1.967 s**.

The 47.679-second interval is consistent with the activation webhook arriving after a one-minute Agreement reconciliation cron tick. The webhook transaction only makes the Agreement work item due; the next cron dispatches it ([webhook queueing](../../convex/zeptoWebhook.ts#L246-L270), [one-minute dispatcher](../../convex/crons.ts#L7-L12), [50-item dispatch](../../convex/payToAgreementReconciliation.ts#L421-L455)). The 331-ms GET and 2.36-ms local insertion show that neither provider confirmation nor Payment intent creation dominated this sample.

The 1.177 seconds after the settlement webhook includes an explicit one-second scheduling delay plus the Payment GET and recording mutation. The code schedules that GET from the durably applied webhook and retains the webhook only as provisional evidence ([webhook observation](../../convex/payToPayments.ts#L1255-L1281), [one-second schedule and fencing](../../convex/payToPayments.ts#L1122-L1157), [authoritative GET application](../../convex/payToPayments.ts#L2208-L2319)). This sample does not expose separate provider POST, provider settlement, webhook transport, Workpool queue, and Payment GET durations, so no provider-only settlement distribution can be inferred from it.

## Configured healthy path

| Phase | Controller | Current scheduling/capacity | Worst configured addition without backlog or service failure |
| --- | --- | --- | --- |
| Validate and commit activation webhook | PayMe | Signature verification, parsing, deduplication, and one durable mutation before HTTP 200 ([handler](../../convex/http.ts#L244-L332)) | No explicit delay; runtime and database latency are unbounded by application configuration. |
| Make Agreement confirmation due | PayMe | Webhook inserts/patches a queued work item at `receivedAt`, but schedules no action ([queueing](../../convex/zeptoWebhook.ts#L246-L270)) | Up to almost 60 s of cron phase. |
| Dispatch Agreement GET | PayMe | Cron every 1 minute; at most 50 due or expired items per tick ([cron](../../convex/crons.ts#L7-L12), [dispatcher](../../convex/payToAgreementReconciliation.ts#L421-L455)) | Less than one cron interval only when fewer than 50 older items are ahead and the cron/scheduler runs normally. |
| Confirm Agreement | Provider plus PayMe | Per-UID GET; 10 s timeout per attempt, two automatic retries by default, with 250 ms then 500 ms local backoff or a provider `Retry-After` of at most 30 s per retry ([client defaults](../../convex/lib/zepto/client.ts#L12-L17), [retry loop](../../convex/lib/zepto/client.ts#L278-L317), [Agreement action](../../convex/payToAgreementReconciliation.ts#L488-L545)) | Repeated timeouts can occupy about 30.75 s; retryable responses with the largest accepted `Retry-After` can keep the action open for up to roughly 90 s including three full attempts. A healthy call has no configured minimum and was 331 ms in the sample. |
| Create durable Payment intent | PayMe | Same mutation that records confirmed `active`; permanent provider UID and create work are inserted, then an action is enqueued ([eligibility and insert](../../convex/payToPayments.ts#L696-L854)) | No explicit delay; local transaction time plus Workpool queue time. |
| Dispatch Payment POST | PayMe plus provider | Payment-creation Workpool has max parallelism 5 and no automatic action retries ([pool](../../convex/lib/paymentCreationPool.ts#L1-L11)); POST has one 10 s attempt (`maxRetries: 0`) ([action](../../convex/payToPaymentCreation.ts#L61-L133)) | Queue time has no finite application bound; once started, the provider attempt times out after 10 s. |
| Confirm Payment lifecycle | PayMe plus provider | Successful POST and every Payment webhook call `makePayToPaymentReconciliationDue`, which schedules a GET after 1 s ([POST result](../../convex/payToPayments.ts#L1678-L1736), [scheduler](../../convex/payToPayments.ts#L1122-L1157)); Payment GET has no client retry and a 10 s timeout ([action](../../convex/payToPaymentReconciliation.ts#L486-L550)) | 1 s intentional scheduling delay plus scheduler, GET, and mutation latency; the GET can take 10 s before failing. |
| Record settlement | PayMe | Only a current three-minute reconciliation lease may apply GET evidence; `settled` is then projected as paid ([lease check](../../convex/payToPayments.ts#L1099-L1120), [settlement mutation](../../convex/payToPayments.ts#L2208-L2319)) | No explicit post-GET delay. |

The healthy webhook-driven sample therefore had roughly **49.0 seconds of PayMe scheduling/confirmation time** and less than one second between Payment creation and provider settlement-webhook receipt. The sample cannot assign the latter interval wholly to the provider because it also includes Payment Workpool dispatch, POST, and webhook transport.

## Degraded paths and deliberate windows

### Missed Agreement activation webhook

When Agreement creation is accepted from the POST response, the first lifecycle reconciliation is queued 30 minutes later. Confirmed `pending` and `created` states continue on a 30-minute cadence; `active`, `suspended`, and unknown states use a 24-hour cadence ([creation scheduling](../../convex/payToAgreementCreation.ts#L347-L450), [state schedule](../../convex/payToAgreementReconciliationState.ts#L23-L30)). Because these work items are not self-scheduled, each due time also waits for the next one-minute cron phase. If activation happens immediately after a GET that still reports `pending`, a missed webhook can therefore leave activation undiscovered for **about 30 minutes plus up to almost one minute**, before provider and runtime latency.

The 30-minute cadence is a deliberate fallback/provider-load window. The additional cron phase is accidental scheduler latency.

### Missed Payment settlement webhook

Successful Payment creation schedules a GET after one second. If it does not yet observe settlement and no later webhook arrives, subsequent work relies on the one-minute cron ([Payment cron](../../convex/crons.ts#L14-L19)). The configured state/age cadence is ([schedule](../../convex/payToPaymentReconciliationState.ts#L9-L25)):

| Last GET-confirmed state | Payment age | Deliberate next-GET delay | Additional cron phase |
| --- | --- | ---: | ---: |
| `created` / `submitting` | up to 15 min | 1 min | <1 min |
| `created` / `submitting` | 15-60 min | 5 min | <1 min |
| `created` / `submitting` | 1-24 h | 15 min | <1 min |
| `created` / `submitting` | over 24 h | 1 h | <1 min |
| `pending` | up to 1 h | 5 min | <1 min |
| `pending` | 1-24 h | 15 min | <1 min |
| `pending` | over 24 h | 1 h | <1 min |
| `under_investigation` | up to 24 h | 1 h | <1 min |
| `under_investigation` | over 24 h | 6 h | <1 min |

Thus a settlement that occurs just after a young `created`/`submitting` GET can take nearly **two minutes** to be recorded without a webhook: one minute of intentional polling cadence plus almost one minute of accidental cron phase, then GET/mutation latency. A `pending` Payment can take nearly six minutes under the same reasoning. There is no finite end-to-end guarantee because provider settlement itself is outside PayMe's control.

### Provider/read failures and ambiguous creation

- Agreement GET failures use 30 s, 2 min, 15 min, 1 h, and 6 h delays, then a daily review cadence after six failures or 24 hours ([failure policy](../../convex/payToAgreementReconciliationState.ts#L79-L93)). Those due times rely on the one-minute cron, so cron phase is additive.
- Ordinary Payment GET failures reuse the safe lifecycle polling delay and alert after six consecutive failures or 24 hours ([failure policy](../../convex/payToPaymentReconciliationState.ts#L72-L85), [failure recording](../../convex/payToPaymentReconciliation.ts#L427-L481)). They also rely on the one-minute cron.
- A Payment create attempt gets a 10-second outcome watchdog. Ambiguous creation is reconciled by GET at 30 s, 2 min, 5 min, 10 min, and 15 min targets, and automatic recovery ends after 15 minutes, three POST attempts, or two recovery cycles ([creation bounds](../../convex/payToPayments.ts#L63-L68), [watchdog](../../convex/payToPayments.ts#L1583-L1642), [GET targets](../../convex/payToPaymentReconciliation.ts#L36-L43)). These are deliberate duplicate-prevention and ambiguity windows. The ambiguity GETs self-schedule at exact targets; if provider absence returns work to `create_pending`, the 30-second creation-recovery cron adds up to almost 30 seconds before the next create action ([absence recovery](../../convex/payToPayments.ts#L2136-L2204), [recovery cron](../../convex/crons.ts#L21-L26)).
- Agreement, Payment creation, and Payment reconciliation leases are three minutes. A crashed worker remains fenced until expiry; cron recovery then adds up to almost 60 seconds for Agreement/Payment reconciliation or almost 30 seconds for Payment creation ([Agreement lease](../../convex/payToAgreementReconciliation.ts#L28-L29), [Payment leases](../../convex/payToPayments.ts#L63-L66), [reconciliation lease](../../convex/payToPaymentReconciliation.ts#L36-L43)). Lease duration is a deliberate safety window; cron phase after expiry is accidental.

### Queue backlog and concurrency

Agreement and Payment reconciliation each dispatch at most 50 due/expired items per one-minute tick. Payment creation recovery dispatches at most 50 per 30-second tick. A backlog larger than a batch therefore adds at least one cadence per additional batch, and sustained arrivals above drain capacity make the worst case unbounded ([Agreement dispatcher](../../convex/payToAgreementReconciliation.ts#L421-L455), [Payment dispatcher](../../convex/payToPaymentReconciliation.ts#L259-L297), [creation recovery](../../convex/payToPayments.ts#L2404-L2441)).

Payment creation is the only healthy-path provider phase with an explicit concurrency ceiling: Workpool max parallelism 5. Agreement and Payment reconciliation dispatchers schedule up to 50 independent actions per tick and have no application-level provider concurrency limiter. Daily count/value gates bound money movement but do not bound concurrent GETs ([capacity fields](../../convex/validators/payToPayments.ts#L64-L67), [creation pool](../../convex/lib/paymentCreationPool.ts#L1-L11)).

All three payment queues warn only after work is more than five minutes overdue; Agreement reconciliation warns at five minutes as well. These are observability thresholds, not latency bounds ([Payment warning](../../convex/lib/payToPaymentTelemetry.ts#L105-L147), [Agreement warning](../../convex/payToAgreementReconciliation.ts#L438-L447)).

### In-flight webhook races

Payment reconciliation explicitly preserves urgency. If a Payment webhook arrives while a GET lease is running, it records `refreshRequestedAt`; when the GET completes, the mutation makes another GET immediately due and schedules it after one second ([running-work refresh](../../convex/payToPayments.ts#L1141-L1148), [follow-up](../../convex/payToPayments.ts#L2228-L2239), [schedule](../../convex/payToPayments.ts#L2393-L2399)). This costs an extra authoritative GET but avoids losing a possibly newer webhook signal.

Agreement reconciliation lacks the equivalent marker. An Agreement webhook patches a running work item to `queued` and pulls `availableAt` forward but leaves its lease token in place. The in-flight GET may still record under that lease and overwrite the work item with its normal next cadence—30 minutes for a stale `pending` result or 24 hours for `active`—thereby losing the webhook's urgency ([webhook patch](../../convex/zeptoWebhook.ts#L253-L262), [lease authorization](../../convex/payToAgreementReconciliationState.ts#L96-L106), [success overwrite](../../convex/payToAgreementReconciliation.ts#L183-L215)). If that GET sees `active`, it creates the Payment immediately; the risky latency case is a stale/pre-activation GET that completes after the activation webhook was committed.

## Controlled versus provider-controlled time

| Category | Phases |
| --- | --- |
| PayMe-controlled accidental latency | Agreement webhook waits for cron; cron phase after every non-self-scheduled due time; batch caps and Workpool backlog; lost Agreement-webhook urgency during an in-flight GET; recovery cron phase after lease expiry or confirmed provider absence. |
| PayMe-controlled deliberate safety/load windows | One-second Payment confirmation delay; three-minute leases; state-dependent reconciliation cadences; 10-second create-outcome watchdog; bounded ambiguity GET targets and 15-minute recovery window; retry/review delays. |
| Provider/network-controlled | Agreement and Payment GET response time and read freshness; Payment POST response; time until the provider establishes/settles/fails a Payment; webhook publication and delivery. The client caps individual attempts at 10 seconds but cannot bound provider lifecycle completion. |
| Convex-service-controlled but not app-bounded | Scheduler start latency, action/mutation execution latency, Workpool service queue overhead, database contention/retries. |

## Safe candidate changes supported by this baseline

These candidates remove accidental waits while preserving provider call cadence, concurrency ceilings, GET authority, leases, permanent identity, and cron recovery:

1. **Schedule Agreement reconciliation when the webhook transaction commits the due work item.** Keep the one-minute cron as recovery. Deduplicate within the delivery as today and let the lease claim reject duplicate scheduled actions. This removes the observed nearly-one-minute phase without trusting the webhook as lifecycle truth.
2. **Add Agreement `refreshRequestedAt` semantics equivalent to Payment reconciliation.** A webhook arriving during a running Agreement GET should cause a follow-up GET after the current lease completes, instead of allowing a stale result to overwrite webhook urgency.
3. **Self-schedule every nonterminal Agreement and Payment reconciliation for its exact `availableAt`.** Keep the existing 30-minute/24-hour Agreement and state/age Payment cadences and keep crons as recovery sweeps. This removes only the extra cron phase, so it does not increase the intended provider call frequency.
4. **Self-schedule lease-expiry and provider-absence recovery at the already chosen deadline.** Keep the three-minute lease and ambiguity windows unchanged; use cron only if the exact watchdog is lost. This removes at most one cron phase without shortening fencing.
5. **Instrument the whole activation-to-settlement path before setting an SLO.** Persist or emit bounded timestamps for webhook receipt, work due, action claim, provider attempt start/end, Payment intent creation, POST completion, Payment webhook receipt, GET claim/completion, and settlement commit. Current settlement metrics start at `establishedAt`, which is the Agreement's first confirmed-active timestamp, and aggregate only average/max over a recent sample; they do not expose scheduler, queue, provider, or webhook phases ([metric emission](../../convex/payToPayments.ts#L2241-L2252), [aggregate snapshot](../../convex/payToPaymentMonitoring.ts#L134-L215)).

Do **not** lower the one-second Payment confirmation delay, the three-minute leases, provider retry/ambiguity windows, or state-based GET cadence from this evidence alone. Also do not raise Workpool parallelism or add reconciliation concurrency without Zepto quota and read-consistency evidence. Those changes would alter provider load or correctness windows rather than merely removing accidental scheduling phase.

## Baseline conclusion

The only live sample reached GET-confirmed settlement **49.977 seconds after durable activation-webhook receipt**, and **47.679 seconds** of that was waiting for the Agreement reconciliation cron. The fastest safe first change is therefore immediate, fenced Agreement reconciliation dispatch from the committed webhook, with the minute cron retained as recovery. Exact self-scheduling and lease-aware refresh semantics remove additional degraded-path phase delays without changing provider call cadence. Provider-only settlement time and sustainable concurrency remain unknown and require per-hop instrumentation plus repeated sandbox/production-shaped measurements before they can support an engineering SLO.
