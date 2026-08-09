# Zepto PayTo agreement contract for PayMe Money Requests

Checked: 2026-08-09

## Decision

PayMe can design the sandbox workflow around one `POST /payto/agreements` call per Payer, using the repository's pinned Zepto API version `20260101`. The public contract supports a different Debtor and Creditor, and both parties can be identified by either a BBAN (BSB plus account number) or a PayID.

Three qualifications must remain explicit:

1. **The public documentation does not unambiguously specify the field combination for exactly one lifetime payment.** The best-supported candidate is fixed terms with `frequency: "adhoc"`, `count: 1`, and the requested amount in cents. Zepto documents those fields individually and documents one-off PayTo use cases, but it describes `count` as a number per frequency period and leaves the `adhoc` period undefined. PayMe must obtain written Zepto confirmation that this combination authorizes exactly one payment over the agreement's lifetime before the backend specification locks it.
2. **PayID cannot be resolved only inside the already-chosen asynchronous post-submit worker.** Zepto requires a successful alias-resolution request before agreement creation, including the requesting end user's stable ID and actual remote IP, and its customer-experience guidance requires real-time validation feedback before checkout is finalized. The implementation-ready first slice should therefore be BBAN-only unless the map separately designs a pre-submit ingress that captures the end-user IP and returns a safe PayID-validation result.
3. **Schema support is not commercial permission.** The create schema accepts a custom Creditor, but public documentation does not prove that PayMe's account may create agreements between arbitrary end-user Debtors and Creditors. PayTo enablement, TPP/client status, compliance conditions, scopes, webhooks, and account-specific limits must be confirmed directly with Zepto.

The repository already contains the official `20260101` [PayTo OpenAPI document](../../convex/lib/zepto/openapi/pay-to.yaml), its [generated TypeScript surface](../../convex/lib/zepto/generated/payTo.ts), and a [transport that pins the version header and selects sandbox/production origins](../../convex/lib/zepto/client.ts). No provider client generation work is needed for this planning effort.

## Create contract

The endpoint is `POST /payto/agreements`, authenticated with a Bearer token and an explicit `Zepto-API-Version: 20260101` header. A successful request returns `201` with `data` containing the agreement; the initial provider state is normally `pending`. Zepto's current API reference and the repository's pinned OpenAPI agree on the following request shape ([create-agreement reference](https://docs.zeptopayments.com/reference/post_payto-agreements), [official `20260101` PayTo OpenAPI](https://go.zeptopayments.com/api-docs/pay-to/20260101/openapi.yaml)).

| Field                                      | Public contract                                                                                                                                                          | PayMe implication                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `uid`                                      | Required, 1-64 RFC 3986 unreserved characters (`A-Z`, `a-z`, digits, `_~.-`); unique between the integrator and Zepto.                                                   | Generate and persist one immutable UID per Money Request/Payer pair before scheduling remote work.                                        |
| `purpose`                                  | Required enum: `mortgage`, `utility`, `loan`, `dependant_support`, `gambling`, `retail`, `salary`, `personal`, `government`, `pension`, `tax`, or `other`.               | The product specification must choose a truthful fixed value or expose a constrained input; this cannot be derived from the amount alone. |
| `description`                              | Required, 1-140 printable ASCII characters.                                                                                                                              | Validate before persistence and define what the Payer will see.                                                                           |
| `debtor`                                   | Required `party_name` and `account_identifier`; `ultimate_party_name` is optional and defaults to `party_name`.                                                          | Resolve the Payer's authoritative name and Default Destination server-side.                                                               |
| `creditor`                                 | Optional/nullable in the schema, but when supplied requires `party_name`, `ultimate_party_name`, and `account_identifier`.                                               | Supply the Requester's authoritative names and Default Destination; whether PayMe may do this is an account-eligibility gate.             |
| `payment_terms`                            | Required discriminated object. Fixed terms require `type`, `frequency`, and integer-cent `amount` from 1 to 1,000,000,000; `count` is optional but must be at least 1.   | Use the candidate below only after Zepto confirms the one-off semantics.                                                                  |
| `initiator`                                | Optional custom initiator with `name`, `legal_name`, and exactly one of ABN or ACN in the published schema. Values are ignored unless the merchant is approved as a TPP. | Do not put a PayMe User here by default. Confirm whether PayMe, a Zepto Client, or another legal entity is the Initiator.                 |
| `resolution_requested_before`              | Optional UTC date-time; defaults to five days after creation and is informational unless paired with `cancel_if_unresolved`.                                             | If PayMe promises an expiry, set both fields explicitly rather than assuming the display deadline cancels the agreement.                  |
| `cancel_if_unresolved`                     | Optional; requires `resolution_requested_before`.                                                                                                                        | Decide explicitly in the lifecycle ticket.                                                                                                |
| `validity_start_date`, `validity_end_date` | Optional dates interpreted in Australia/Sydney time.                                                                                                                     | Omit unless product semantics require a bounded authorization window; these are not a substitute for one-payment terms.                   |
| `metadata`                                 | Optional flat custom object, at most 2 KiB, included in associated webhooks as `resource_metadata`.                                                                      | Store only opaque PayMe correlation IDs, never decrypted account details or other unnecessary PII.                                        |
| `sandbox`                                  | Sandbox-only simulation selector and optional delay.                                                                                                                     | Use fixtures such as `debtor_accept`, `debtor_decline`, `expire`, and account/alias failures for certification.                           |

Subject to Zepto's written confirmation of one-lifetime-payment semantics, the provider request should have this shape:

```json
{
  "uid": "payme_agreement_<stable-id>",
  "purpose": "personal",
  "description": "<validated Money Request description>",
  "debtor": {
    "party_name": "<Payer's authoritative name>",
    "account_identifier": {
      "type": "bban",
      "value": "123456-98765432"
    }
  },
  "creditor": {
    "party_name": "<Requester's authoritative name>",
    "ultimate_party_name": "<Requester's authoritative name>",
    "account_identifier": {
      "type": "bban",
      "value": "123456-12345678"
    }
  },
  "payment_terms": {
    "type": "fixed",
    "frequency": "adhoc",
    "amount": 2500,
    "count": 1
  },
  "metadata": {
    "money_request_id": "<opaque-id>",
    "money_request_agreement_id": "<opaque-id>"
  }
}
```

`purpose: "personal"` in this example is a product recommendation, not a fact established by Zepto; PayMe must ensure it truthfully describes every supported Money Request or choose another allowed value.

## Why the one-off terms still require confirmation

Zepto says PayTo supports one-off and ad-hoc experiences, defines `adhoc` as payment on request/as necessary, and says `count` limits payments per frequency period. It also says omitting `count` for `adhoc` permits unlimited payments. Those facts support setting `count: 1`, but the public guide does not say in so many words that an ad-hoc agreement has one lifetime period. Zepto's reason codes include `MCOC` (agreement suspended because the once-off collection occurred), which proves the platform represents once-off collection, but the docs do not map that behavior to a specific create payload ([creating a PayTo Agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement), [PayTo FAQ](https://docs.zeptopayments.com/docs/payto-faqs), [PayTo reason codes](https://docs.zeptopayments.com/reference/payto-reason-codes)).

Consequently, downstream work may prototype `fixed + adhoc + count 1`, but production-shaped domain and retry decisions must not treat the one-payment guarantee as settled until Zepto confirms it. Initiating the later payment remains outside this map's destination.

## Account identifiers and PayID gating

The agreement contract accepts these account identifier types for either party ([create-agreement guide](https://docs.zeptopayments.com/docs/creating-a-payto-agreement), [PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)):

- `bban`: six-digit BSB, a hyphen, then a 1-28 character account number (Zepto's schema example is `123456-98765432`).
- `alias_phone`: an international phone PayID in Zepto's required form.
- `alias_email`: a lowercase email PayID matching Zepto's schema.
- `alias_abn`: a 9- or 11-digit alias.
- `alias_organisation_identifier`: a 1-256 printable-ASCII organization identifier.

Before either a Debtor or Creditor PayID is used in agreement creation, Zepto says alias resolution is compulsory. `POST /payto/alias_resolution` requires the alias `type`, alias `value`, and `requester: { id, remote_ip }`; the requester ID is a stable 1-64 character integrator identifier and the IP must be the actual IPv4/IPv6 address of the end user making the lookup. Only a `200` response permits continuing. Zepto says the returned `display_name` can validate the customer record and that the UI should provide real-time validity feedback; the product design must decide exactly what confirmation is safe to display. The API token needs the `pay_to_aliases` scope ([PayTo alias-resolution guide](https://docs.zeptopayments.com/docs/payto-alias-resolution), [alias-resolution endpoint](https://docs.zeptopayments.com/reference/post_payto-alias-resolution)).

This conflicts with the current backend-only, return-immediately submission shape in two practical ways: a scheduled Convex action does not inherently possess the originating browser's remote IP, and post-submit validation cannot provide the required pre-finalization name feedback. Passing a client-asserted IP as ordinary mutation data would not meet the documented fraud-control purpose. Therefore BBAN is the implementation-ready subset; PayID requires a separately designed trusted HTTP ingress plus UI confirmation before the Money Request mutation commits.

Alias resolution can return `422` for invalid/not-found aliases, disabled service, and account-, remote-IP-, or requester-ID-level lookup limits, and `503` when the addressing service is unavailable. Zepto does not publish the numeric alias-resolution limits and says it will explain fraud controls and limits in technical discussions.

## Initiator, TPP, Clients, and commercial boundaries

The API distinguishes the Creditor (who receives money) from the Initiator (the party that instantiates the agreement). Custom Initiator values are honored only for accounts approved as Third Party Processors; otherwise Zepto substitutes the registered account details ([creating a PayTo Agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement)).

The public Clients API separately models clients of a platform and permits the `payto` service, but the published PayTo `20260101` request schema offers custom Initiator ABN or ACN only. Its `ZPAGR18` error text also mentions `client_id`, which is absent from that schema. This is a primary-source contract inconsistency, not permission to send `client_id` ([create Client reference](https://docs.zeptopayments.com/reference/post_clients), [PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)). PayMe must ask Zepto which legal/client model applies and obtain the correct versioned schema if Zepto expects a client identifier.

Public documentation proves that the payload can carry an arbitrary Creditor account and accurate Creditor party names. It does **not** prove that PayMe's actual account is contractually or operationally permitted to collect from one end user for direct settlement to another end user's account. That permission, required KYC/AML data, TPP or client onboarding, terms, and settlement model are PayMe-account-specific facts.

## UID, duplicate creation, and ambiguous outcomes

Agreement creation is not one of the endpoints covered by Zepto's `Idempotency-Key` contract; that header is documented only for Payments, Payment Requests, Transfers, and Refunds. Agreements instead use the caller-supplied `uid`, and the OpenAPI error set defines `ZPAGR00` for a duplicate agreement UID ([idempotent requests](https://docs.zeptopayments.com/reference/idempotent-requests), [PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)).

This supports uniqueness but does not document replay of the original `201` response. Safe orchestration is therefore:

1. Persist an immutable provider UID before the first POST.
2. Never generate a new UID for a retry of the same Money Request/Payer intent.
3. After a timeout, network error, crash, or duplicate-UID response, reconcile with `GET /payto/agreements/{uid}` before deciding whether another POST is safe.
4. Treat `404` as evidence that the provider does not currently expose the agreement, not by itself as proof that an immediately preceding ambiguous POST can never complete; use bounded retry/reconciliation policy in the orchestration ticket.

The repository's client currently classifies PayTo creates carrying a UID as transport-retryable. Callers still need the duplicate-UID/GET reconciliation above because Zepto does not promise idempotent response replay for agreement creation ([Zepto client](../../convex/lib/zepto/client.ts)).

## Lifecycle, webhooks, and reconciliation

The provider agreement states are `pending`, `created`, `active`, `suspended`, `cancelled`, `declined`, `failed`, and `expired`. `pending` means accepted by Zepto; `created` means an MMS ID exists and Debtor authorization is pending; `active` means the Debtor accepted. Zepto explicitly calls `declined`, `expired`, and `cancelled` irrevocable. `active` and `suspended` are not terminal because the agreement can later be suspended, reactivated, or cancelled ([creating a PayTo Agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement), [agreement schema](../../convex/lib/zepto/openapi/pay-to.yaml)).

For the creation-and-tracking destination, subscribe at minimum to agreement activation, decline, expiry, failure, cancellation, suspension, and reactivation events. The versioned OpenAPI also enumerates amendment and operation-failure events; PayMe should safely retain or ignore unknown agreement events even though initiating modifications is outside this map. Event payloads identify the object with `resource_uid`, `resource_type`, and an event `type` ([PayTo webhooks and polling](https://docs.zeptopayments.com/docs/webhooks-polling), [generated webhook union](../../convex/lib/zepto/generated/payTo.ts)).

Zepto signs the exact `<unix_timestamp>.<raw_body>` with HMAC-SHA256 in `Split-Signature`; verification should use a per-endpoint secret, constant-time comparison, and a local timestamp tolerance. `Split-Request-ID` remains stable across retransmission and is the delivery deduplication key. Delivery order is not guaranteed, `data` can contain multiple objects, and Zepto guarantees at least one attempt rather than exactly once. Critically, any HTTP response code counts as delivered; only no response is retried. Production retries no-response deliveries every five minutes for one hour, while sandbox retries only once ([webhook setup and delivery promises](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)).

Webhooks therefore cannot be the sole source of truth. Reconcile by stable UID with `GET /payto/agreements/{uid}` and use `GET /payto/agreements/{uid}/history` when state-transition evidence is needed. `GET /payto/agreements` provides paginated repair/backfill (1-100 rows per page) and state/date filters ([PayTo webhooks and polling](https://docs.zeptopayments.com/docs/webhooks-polling), [show agreement](https://docs.zeptopayments.com/reference/get_payto-agreements-agreement-uid), [list agreements](https://docs.zeptopayments.com/reference/get_payto-agreements)).

## Authentication, environments, scopes, limits, and errors

Zepto uses Bearer tokens. For the sandbox single-account integration, its guide recommends a dedicated service user and Personal Access Token; PATs do not expire but can be deleted. The documented scopes relevant to this destination are `pay_to_agreements`, `pay_to_aliases` if PayID is enabled, and `webhooks` for webhook management. PayTo payments are out of scope, so `pay_to_payments` is not required for this map's implementation ([getting started in sandbox](https://docs.zeptopayments.com/docs/getting-started-in-sandbox)).

Use `https://api.sandbox.zeptopayments.com` for the current destination and `https://api.zeptopayments.com` only after a separate production-readiness decision. Sandbox is fully simulated and adds scenario controls; production webhooks require HTTPS, while sandbox accepts HTTP or HTTPS. Amounts are integer cents, and dates/times follow Zepto's documented UTC/Australia-Sydney rules ([Zepto environments](https://docs.zeptopayments.com/docs/zepto-environments), [sandbox PayTo simulations](https://docs.zeptopayments.com/docs/sandbox-testing-simulations)).

Always send `Zepto-API-Version: 20260101`: omitting it selects legacy `20250101`. Zepto currently lists `20250101` and `20260101` as available versions, and the repo-generated types are pinned to `20260101` ([API versioning](https://docs.zeptopayments.com/reference/api-versioning), [OpenAPI downloads](https://docs.zeptopayments.com/reference/openapi-specifications)).

Publicly documented creation limits and errors include:

- six agreement creation attempts per Debtor account in 24 hours;
- an additional account-level daily creation limit (`ZPAGR16`) whose numeric value is not public;
- `400` for structural validation, `401` for an invalid/expired token, `403` for insufficient permission, `422` for semantic/business failures, and `500` for server errors;
- synchronous `422` reasons including duplicate UID, invalid dates/terms, unsupported Debtor institution, invalid Creditor account, missing/misconfigured Initiator identity, and Debtor/account daily limits;
- asynchronous `failed`/`declined` state reasons for network, account, authorization, regulatory, fraud, and other participant outcomes.

Each Payer must remain an independent operation. A failure or limit for one Debtor must not roll back agreements already created for other Payers.

## Facts requiring direct Zepto confirmation

The public contract is sufficient to design the provider boundary, but not to activate PayMe's model. The account-eligibility task must obtain written answers to all of these:

1. Is PayMe's sandbox account enabled for `pay_to_agreements`, Owner/Application webhooks, and—if retained—`pay_to_aliases`? What are the exact enabled scopes on the token/application?
2. May PayMe create agreements where the Creditor and Debtor are unrelated PayMe end users and settlement goes directly to the Requester's arbitrary BBAN/PayID?
3. Is PayMe the Initiator, a TPP for each Requester, or a parent platform required to onboard each Requester through the Clients API? What names and legal identifiers must the Payer see?
4. Does `{ type: "fixed", frequency: "adhoc", amount: <cents>, count: 1 }` authorize exactly one payment over the agreement's lifetime, and what provider state/event follows that eventual payment?
5. What account-specific daily agreement limit, concurrency/rate limits, alias-resolution limits, and production thresholds apply?
6. What KYC/AML, consent, data-retention, dispute, customer-support, and other compliance obligations attach to PayMe's end-user model?
7. Which webhook events are enabled for PayMe, what signing secrets/rotation procedure apply, and does Zepto recommend any reconciliation cadence for unresolved agreements?
8. If Zepto expects a Client-backed Initiator, what versioned create-agreement request field replaces or supplements ABN/ACN, given that `client_id` appears in error text but not the published request schema?

Until items 2-4 are confirmed, the map should treat the provider contract as technically shaped but the end-user money flow and exact one-off guarantee as gated.

## Primary sources

- [Zepto create-agreement API reference](https://docs.zeptopayments.com/reference/post_payto-agreements)
- [Zepto `20260101` PayTo OpenAPI YAML](https://go.zeptopayments.com/api-docs/pay-to/20260101/openapi.yaml)
- [Creating a PayTo Agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement)
- [PayTo Alias Resolution](https://docs.zeptopayments.com/docs/payto-alias-resolution)
- [PayTo Webhooks & Polling](https://docs.zeptopayments.com/docs/webhooks-polling)
- [Setting up your webhooks](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)
- [Idempotent Requests](https://docs.zeptopayments.com/reference/idempotent-requests)
- [PayTo reason codes](https://docs.zeptopayments.com/reference/payto-reason-codes)
- [Getting Started in Sandbox](https://docs.zeptopayments.com/docs/getting-started-in-sandbox)
- [Zepto Environments](https://docs.zeptopayments.com/docs/zepto-environments)
- [API Versioning](https://docs.zeptopayments.com/reference/api-versioning)
- [OpenAPI Specifications](https://docs.zeptopayments.com/reference/openapi-specifications)
- [Create Client API reference](https://docs.zeptopayments.com/reference/post_clients)
- [PayTo Sandbox Testing & Simulations](https://docs.zeptopayments.com/docs/sandbox-testing-simulations)
