# Zepto PayTo Payment lifecycle and recovery contract

Checked: 2026-08-12

## Decision-ready contract

PayMe should create one durable PayTo Payment intent for each accepted PayTo Agreement, persist one permanent caller-supplied Zepto payment UID and the immutable request before network I/O, and send `Zepto-API-Version: 20260101` explicitly. A `201` means that Zepto created the payment, not that money moved. The obligation remains locked against another payment while the Zepto resource is `created`, `submitting`, `pending`, or `under_investigation`; only `settled` completes it.

If creation has an ambiguous outcome, PayMe should reconcile `GET /payto/payments/{uid}` and treat `422 ZPPAY00` as evidence that the same UID already exists, then retrieve it. It must never substitute a new UID for the same obligation. Zepto does not document `Idempotency-Key` semantics for this endpoint.

A failed submission may be retried only through `POST /payto/payments/{payment_uid}/retry`, on the same resource, when the current failure says `retryable: true`. PayMe should impose its own smaller bounded retry policy in addition to Zepto's limits. It must not automatically repeat a retry POST whose outcome was ambiguous: the public contract exposes neither retry-call idempotency nor an attempt identifier. That case needs sandbox characterization or written Zepto confirmation before production automation.

Webhooks are prompt notifications, not an ordered event log. Verify and durably accept them, deduplicate retransmissions, and reconcile the current resource by UID. Preserve provider and local evidence because Zepto exposes no PayTo Payment history endpoint.

## Source baseline and version

### Documented facts

- Zepto's versioning guide lists `20250101` (the legacy `v1.0` alias) and `20260101`. It says omitted version headers default to `20250101`, while a specific version is selected with `Zepto-API-Version` ([API Versioning](https://docs.zeptopayments.com/reference/api-versioning)).
- The repository's pinned [`20260101` PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml) was byte-for-byte identical to Zepto's [official `20260101` PayTo OpenAPI](https://go.zeptopayments.com/api-docs/pay-to/20260101/openapi.yaml) when checked (SHA-256 `37a6a992640b6eb637374510d40a7013cac8981e68eb8ac83dd0c39d96c588e0`). It is therefore the precise wire contract used below.
- Zepto's documentation selector also exposed a `20270101` branch when checked. Its downloadable PayTo OpenAPI differed from `20260101` only in `info.version` and the version-header example. However, the versioning guide did not list `20270101` as available. This research does not infer production readiness from a discoverable future-version artifact.

### Design inference

PayMe should explicitly pin `Zepto-API-Version: 20260101` rather than inherit the legacy default or follow the documentation portal's changing default. A version upgrade should be a reviewed change against a newly pinned OpenAPI.

## Creating a PayTo Payment

### Preconditions and required request

Zepto documents two preconditions: the PayTo Agreement must be active, and the payment attributes must conform to its authorized terms ([Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)). The current [create-payment OpenAPI](https://docs.zeptopayments.com/reference/post_payto-payments) requires:

| Field | Current `20260101` contract |
| --- | --- |
| `uid` | Caller-supplied unique identifier; 1–64 characters matching `^[A-Za-z0-9_~.-]{1,64}$` |
| `agreement_uid` | Target agreement UID; 1–64 RFC 3986 unreserved characters |
| `amount` | Integer cents; minimum 1, maximum 1,000,000,000 |
| `priority` | `attended` or `unattended` |

Optional fields are:

- `reference`: printable ASCII, maximum 35 characters;
- `description`: maximum 280 characters;
- `creditor_reference`: printable ASCII, 1–35 characters;
- `creditor`: optional if creditor details exist on the agreement; when present, it requires `party_name`, `ultimate_party_name`, and `account_identifier`;
- `debtor`: optional party-name overrides, available only to integrators with Zepto's extended-KYC permission;
- `last_payment`: required for balloon terms, `false` for a non-final balloon payment, and absent for non-balloon agreements;
- `metadata`: flat values only, maximum 2 KB, copied to related webhook events as `resource_metadata`;
- `sandbox`: sandbox-only lifecycle simulation.

A successful `201` returns `{ data: Payment }`. That resource includes the supplied payment and agreement UIDs, current state, amount, priority, party/account snapshots, reference fields, failure details when applicable, `created_at`, metadata, and resource links. The guide says the initial state is `created` ([Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)); it is not evidence of settlement.

The endpoint documents `400`, `401`, `403`, `422`, and `500`. The `422` family covers agreement state/term violations, payment limits, party mismatches, invalid account conditions, and duplicate UID (`ZPPAY00`) ([PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)).

### Documentation inconsistencies

- The prose guide presents creditor subfields as required, while the current OpenAPI makes the `creditor` object optional when the agreement already has creditor details. The versioned OpenAPI is the authoritative wire schema.
- Zepto's reference wording and prose guide disagree about whether the payment reference or a debtor-set agreement reference takes precedence. PayMe should not use the statement reference as its sole correlation key; use the supplied UID and internal IDs/metadata.
- The prose lifecycle calls the second state **Submitted**, while the OpenAPI wire enum is `submitting`. Code should store and accept `submitting`.

### PayMe inference

The activation-triggered background collection is `unattended`; Zepto describes `attended` as an active e-commerce-style checkout. Because the agreed PayMe policy uses immutable agreement routing, omit `creditor` when the agreement already owns the creditor snapshot instead of rereading a user's current Payment Destination.

## UID uniqueness and ambiguous creation

### Documented facts

- Zepto says the supplied payment `uid` ensures uniqueness between the integrator and Zepto ([create-payment reference](https://docs.zeptopayments.com/reference/post_payto-payments)).
- Reusing an existing PayTo Payment UID produces `422` code `ZPPAY00`, “Duplicate UID” ([PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)). It does not replay the original `201` response.
- `GET /payto/payments/{payment_uid}` retrieves a payment by the caller-supplied UID and documents `200` or `404`. `GET /payto/payments` can also filter by agreement UID, state, and creation-date range ([PayTo Webhooks & Polling](https://docs.zeptopayments.com/docs/webhooks-polling), [PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)).

### Explicitly not documented

- The PayTo OpenAPI does not define `Idempotency-Key` on creation or retry. Zepto's general [Idempotent Requests](https://docs.zeptopayments.com/reference/idempotent-requests) page names standard Payments, Payment Requests, Transfers, and Refunds, but not PayTo Payments. Its 24-hour expiry, `409`, rapid-duplicate `503`, and response behavior must not be applied to `/payto/payments` without Zepto confirmation.
- Zepto publishes no create-to-GET consistency bound and no interval after which a `404` proves an ambiguous create was never accepted.
- The docs do not say whether retrying the same create request after a `404` can race delayed resource visibility.

### Recovery inference

1. Before calling Zepto, durably persist one stable UID and the exact immutable create payload.
2. After a timeout, disconnect, `500`, or any unknown response, call `GET /payto/payments/{uid}`.
3. If found, adopt that resource regardless of whether the original `201` arrived.
4. If a same-UID create returns `ZPPAY00`, interpret it as “reconcile the existing resource by GET,” not as a new obligation failure.
5. Never issue a fresh UID for the same obligation: it bypasses Zepto's only documented permanent uniqueness boundary and can debit twice.
6. A bounded same-UID reconciliation/re-submit policy may be safe, but the delay and replay rule must be characterized in sandbox or confirmed by Zepto. Persistent ambiguity should move to attention-required, not to a new UID.

## Lifecycle and authoritative outcomes

### Documented state model

The current OpenAPI exposes these values:

```text
created -> submitting -> [pending] -> [under_investigation] -> settled | failed
```

The prose guide defines them as follows ([Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)):

| State | Provider meaning | PayMe consequence |
| --- | --- | --- |
| `created` | Zepto accepted creation (`201`) | Initiated, not paid; retain one-payment lock |
| `submitting` | Submitted to NPP and awaiting the payer participant | Unresolved; retain lock |
| `pending` | No final status within 35 seconds | Unresolved; retain lock and reconcile |
| `under_investigation` | No final payer-bank status after Zepto's automated resolution; manual intervention required | Unresolved; retain lock, do not retry or create another payment |
| `settled` | Funds successfully debited and credited | Obligation complete |
| `failed` | Funds were not successfully debited or credited; `failure` supplies `code`, `title`, `detail`, and `retryable` | Attempt ended; retry only via the retry endpoint when permitted |

Zepto's guide states that `settled` and `failed` are final and that an NPP-submitted PayTo payment is irrevocable and cannot be cancelled. The current PayTo API has no payment cancellation endpoint. “Failed is final” describes the submission outcome, but Zepto can reopen the same payment resource through its explicit retry endpoint. `settled` remains irrevocably complete.

The create contract defines webhook events for `payto_payment.pending`, `payto_payment.under_investigation`, `payto_payment.failed`, and `payto_payment.settled`. A failed event carries the failure object ([PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)).

### Authority inference

Treat a verified webhook as a prompt state signal and `GET /payto/payments/{uid}` as the repair view of current provider state. Never infer settlement from `201`, retry `202`, elapsed time, or a local operator action. Where ordering or contradictory observations matter, reconcile GET before applying a destructive transition.

## Failed-payment retry

### Documented contract

`POST /payto/payments/{payment_uid}/retry` is allowed only for a failed payment whose current `failure.retryable` is `true` ([retry-payment reference](https://docs.zeptopayments.com/reference/post_payto-payments-payment-uid-retry), [PayTo reason codes](https://docs.zeptopayments.com/reference/payto-reason-codes)). It retries the existing payment UID, not a newly created payment.

Zepto documents these limits:

- up to 10 retries while within the related agreement's validity dates;
- no more than 5 submissions in a 24-hour period, with the original submission included in that count;
- current state, validity, retry limits, and cooldown can still reject the request.

Success is `202` with no body. The current OpenAPI permits an optional replacement `creditor` object, defaulting to the agreement creditor or existing payment creditor, plus sandbox simulation. This is more precise than the prose guide's “Request payload not applicable.” PayMe's immutable-routing policy should not replace creditor details during retry.

Documented `422` retry errors are:

| Code | Meaning |
| --- | --- |
| `ZPPRY00` | Payment is not in a retryable state |
| `ZPPRY01` | Maximum retries reached |
| `ZPPRY02` | Related agreement is no longer valid |
| `ZPPRY03` | Retry cooldown; detail supplies a next time |
| `ZPPRY04` | Next allowed retry would be after agreement validity |
| `ZPPRY05` | Creditor cannot change for a refund-facilitating payment |
| `ZPREF06` | Refund-total constraint |

The retry endpoint declares settled and failed callbacks. It does not document a retry attempt resource or history.

### Explicitly not documented

- There is no retry idempotency key, attempt ID, attempt count, last-retry time, or structured `next_retry_at` on the payment resource.
- After an ambiguous retry POST, the public API cannot distinguish “the request never arrived” from “the retry was accepted and the same payment rapidly failed again.”
- Zepto does not state that replaying an ambiguous retry POST is safe; doing so may consume another provider allowance.
- Retry callbacks list only settled and failed even though retry sandbox simulations include investigation scenarios. The docs do not resolve this mismatch.

### Recovery inference and open provider question

On an ambiguous retry outcome, do not immediately call retry again. First reconcile the same payment by GET and inspect newly received provider event IDs. If the resource remains the same failed snapshot and no event arrives, the public contract provides insufficient evidence for safe automatic replay.

Before production automatic retries, characterize that case in sandbox or obtain Zepto's written rule for how to establish whether a retry request was accepted. PayMe should also maintain a smaller local retry budget, never retry `pending` or `under_investigation`, and never implement retry as a new payment UID.

## Webhook delivery contract

### PayTo event shape

The `20260101` PayTo OpenAPI defines a PayTo webhook as one event object, not the general Zepto webhook guide's transaction array:

```json
{
  "data": {
    "id": "UUIDv7 event ID",
    "type": "payto_payment.settled",
    "published_at": "date-time",
    "resource_uid": "caller-supplied payment UID",
    "resource_type": "payto_payment",
    "body": null,
    "resource_metadata": {}
  },
  "links": {
    "resource": "https://api.zeptopayments.com/payto/payments/<uid>"
  }
}
```

For `payto_payment.failed`, `data.body.failure` contains the failure object. Validate this PayTo-specific shape from the OpenAPI. The general guide's `{ event, data: [...] }` schema and “data may contain multiple transactions” warning apply to Zepto's general webhook families, not to the current PayTo event schema ([PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml), [Setting up your webhooks](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)).

### Shared delivery, deduplication, and signature facts

Zepto's [webhook guide](https://docs.zeptopayments.com/docs/setting-up-your-webhooks) documents that:

- delivery order is not guaranteed;
- Zepto guarantees at least one delivery **attempt**, not exactly-once delivery;
- production retries no-response deliveries every 5 minutes for 1 hour, while sandbox retries only once;
- any received HTTP response, including 4xx or 5xx, counts as successful delivery and suppresses further retries;
- `Split-Request-ID` is a UUID unique to a webhook event and remains unchanged on retransmission;
- `Split-Signature` contains a Unix timestamp and one or more signatures;
- signature verification is HMAC-SHA256 over `<timestamp>.<exact request body>` using the endpoint-specific secret, with constant-time comparison and an application-chosen timestamp tolerance.

Zepto does not state that `Split-Request-ID` equals PayTo `data.id`, so retain both. It also prescribes no timestamp tolerance and gives no ordering guarantee for UUIDv7 event IDs or `published_at`.

### Handler inference

1. Read and preserve the exact body used in the signature calculation.
2. Verify the signature and timestamp before state change.
3. Durably deduplicate by `Split-Request-ID`; also preserve `data.id`.
4. Durably accept the event before returning any HTTP response, because even a `500` prevents Zepto retry.
5. Do not apply events by arrival order. Use them to wake reconciliation when the transition could conflict with current state.
6. Keep the payment lock through `pending` and `under_investigation` until authoritative `settled` or `failed`.

## Reconciliation and evidence

### Documented sources

Zepto exposes:

1. `GET /payto/payments/{uid}` for the current individual resource;
2. `GET /payto/payments` for successfully submitted payments, filterable by state, agreement UID, and creation dates;
3. signed PayTo event notifications with event ID, publication time, resource UID, resource metadata, failure details when relevant, and a resource URL.

Unlike PayTo Agreements, `20260101` has no PayTo Payment history endpoint. The payment resource has no settlement timestamp, bank transaction ID, NPP end-to-end identifier, retry history, attempt count, or last-retry time. Zepto does not explicitly publish a “GET beats webhook” authority hierarchy ([PayTo Webhooks & Polling](https://docs.zeptopayments.com/docs/webhooks-polling), [PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)).

### Evidence PayMe should preserve

This is a design inference from the documented omissions and recovery needs:

- PayMe obligation ID, permanent Zepto payment UID, and agreement UID;
- exact immutable create payload and explicit API version;
- each create and retry call's start/end times, HTTP outcome, and uncertainty classification;
- current provider resource, its `created_at`, amount, references, party/account snapshots, and observation time;
- failure `code`, `title`, `detail`, and `retryable`;
- every PayTo `data.id`, `published_at`, event type, `resource_uid`, and `resource_metadata`;
- `Split-Request-ID`, signature-verification result, received time, and safely retained or redacted raw event;
- every GET observation and local retry decision.

Sensitive account evidence must follow PayMe's encryption and redaction policy. A verified settled event or a current GET showing `settled` is provider evidence of completion; PayMe should still preserve the observation rather than allowing an operator to manufacture settlement locally.

## Newly surfaced decisions

1. **Ambiguous retry replay rule:** define a production-safe wait/replay rule through a sandbox experiment or written Zepto confirmation, because the public contract exposes no retry idempotency or attempt evidence.
2. **Timestamp tolerance:** choose PayMe's accepted `Split-Signature` age/skew window and secret-rotation policy; Zepto deliberately leaves the tolerance to the integrator.
3. **Reconciliation cadence and attention threshold:** choose polling intervals and the point at which persistent create ambiguity, `pending`, or `under_investigation` becomes operator-visible attention required.
4. **Evidence retention/redaction:** decide retention periods and which party/account fields may be stored in raw versus encrypted/redacted form.

## Primary sources

- [Zepto PayTo API `20260101` OpenAPI](https://go.zeptopayments.com/api-docs/pay-to/20260101/openapi.yaml)
- [Repository-pinned Zepto PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)
- [Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)
- [Create a PayTo Payment endpoint](https://docs.zeptopayments.com/reference/post_payto-payments)
- [Retry a PayTo Payment endpoint](https://docs.zeptopayments.com/reference/post_payto-payments-payment-uid-retry)
- [PayTo reason codes](https://docs.zeptopayments.com/reference/payto-reason-codes)
- [PayTo Webhooks & Polling](https://docs.zeptopayments.com/docs/webhooks-polling)
- [Setting up your webhooks](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)
- [API Versioning](https://docs.zeptopayments.com/reference/api-versioning)
- [Idempotent Requests](https://docs.zeptopayments.com/reference/idempotent-requests)
