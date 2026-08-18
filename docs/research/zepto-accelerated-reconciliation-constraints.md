# Zepto constraints for accelerated PayTo reconciliation

Checked: 2026-08-18

## Decision

PayMe can safely remove its own scheduling delay: a relevant, durably accepted PayTo webhook may trigger one immediate same-UID GET, while the periodic sweep remains as recovery. Zepto explicitly presents webhooks and direct polling as complementary ways to learn an asynchronous PayTo outcome, and provides individual Agreement and Payment GET endpoints ([PayTo overview](https://docs.zeptopayments.com/docs/payto-overview), [PayTo webhooks and polling](https://docs.zeptopayments.com/docs/webhooks-polling), [show Agreement](https://docs.zeptopayments.com/reference/get_payto-agreements-agreement-uid), [show Payment](https://docs.zeptopayments.com/reference/get_payto-payments-payment-uid)).

That is the limit of what the public contract supports confidently. The current first-party material does **not** publish a read-after-webhook or read-after-write consistency bound, a PayTo GET rate/concurrency allowance, a general PayTo `429`/`Retry-After` contract, or a numeric webhook delivery-time SLA. Faster repeated polling or more provider concurrency therefore needs sandbox characterization and written Zepto confirmation before it becomes a production assumption.

## Evidence by question

### Agreement webhook timing

- PayTo operations are asynchronous: a valid creation request returns `201 Created` with a reference, and the outcome is later available by webhook or polling. Zepto describes outcome webhooks as real-time notifications, but gives no numeric publication or delivery bound ([PayTo overview](https://docs.zeptopayments.com/docs/payto-overview)).
- Once the debtor authorises an Agreement, Zepto says it becomes active and Zepto pushes an activation webhook. The webhook is therefore a strong prompt to reconcile, but the guide does not state when the Agreement GET projection becomes active relative to publication or delivery of that webhook ([Creating a PayTo Agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement)).
- The activation event contains the supplied Agreement UID, a Zepto publication timestamp, and the MMS Agreement ID; the webhook-and-polling guide also exposes the same-UID Agreement GET route ([PayTo webhooks and polling](https://docs.zeptopayments.com/docs/webhooks-polling)).

**Unknown:** no reviewed first-party source defines maximum debtor-authorisation-to-publish time, publish-to-delivery time, or a minimum delay before GET will reflect `active`.

### Payment outcome and settlement timing

- Zepto expects a final result within a few seconds after the NPP receives the Payment initiation, with an NPP outlier SLA around 30 seconds. It defines `pending` when no final status has arrived 35 seconds after successful initiation, and may later move a Payment to `under_investigation` before a final settled or failed state ([Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)).
- Zepto's July 2025 PayTo Index reports a 4.85-second median across its anonymised platform data from October 2023 through 16 July 2025, including more than 1.1 million initiated Payments. This first-party aggregate is useful as a benchmark, not an account-specific SLA or a tail-latency guarantee ([Zepto PayTo Index, July 2025](https://zepto.com.au/uploads/documents/Zepto_PayToIndex_July2025_DataUpdate.pdf)).
- `settled` means the funds have been successfully debited and credited; `201 Created`, `submitting`, and `pending` are not settlement. Zepto sends the outcome webhook after it receives the final NPP status ([Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)).
- The latest PayTo reference supports `attended` and `unattended` priorities and says attended Payments are prioritised. The guide gives an e-commerce checkout as the attended example and a loan collection as the unattended example ([create Payment](https://docs.zeptopayments.com/reference/post_payto-payments), [Creating a PayTo Payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)). PayMe currently hard-codes `unattended` in [`convex/lib/zepto/payment.ts`](../../convex/lib/zepto/payment.ts). Whether this product interaction qualifies as attended, and what latency improvement it buys, are not documented; this is a separate provider/product decision rather than a safe scheduler tweak.

**Unknown:** the few-seconds/around-30-seconds statements start at NPP receipt, not necessarily PayMe's POST start or `201` receipt. Zepto publishes no separate final-status-to-webhook-delivery SLA or percentile distribution.

### GET consistency

- The official guides endorse direct polling and the current API exposes individual Agreement and Payment GETs that return the resource's current state ([PayTo webhooks and polling](https://docs.zeptopayments.com/docs/webhooks-polling), [show Agreement](https://docs.zeptopayments.com/reference/get_payto-agreements-agreement-uid), [show Payment](https://docs.zeptopayments.com/reference/get_payto-payments-payment-uid)).
- Neither those references nor the pinned `20260101` [PayTo OpenAPI contract](../../convex/lib/zepto/openapi/pay-to.yaml) states strong consistency, monotonic reads, read-your-write, read-after-event, propagation lag, caching semantics, or a recommended polling interval. Zepto's [official specification index](https://docs.zeptopayments.com/reference/openapi-specifications) identifies `20260101` as the downloadable current contract reviewed here.
- Existing live-sandbox evidence shows that same-UID GET can recover a lost create response and can authoritatively observe settlement, but that certification explicitly leaves provider delivery and quotas uncertified ([live Zepto sandbox certification](../certification/pay-to-payment-live.md)). It is capability evidence, not a consistency-time guarantee.
- The supplied 2026-08-18 handoff adds one narrow observation: an Agreement GET about 48 seconds after its activation webhook returned active, and that Payment's settlement webhook followed Payment creation by about 0.8 seconds. This single sandbox path was delayed by PayMe's minute dispatcher and did not sample an immediate post-webhook GET, so it cannot establish read-after-event consistency or a production distribution.

**Inference:** an immediate GET is safe when a stale/nonterminal result merely keeps the resource unresolved and schedules bounded recovery. It is not safe to interpret one stale result as evidence that the authenticated webhook was false or that a new provider resource should be created.

### Request rate, concurrency, and backpressure

- Zepto says sandbox accounts have limits and asks integrators to contact the Zepto team before volume or performance testing, but publishes no values on that page ([Zepto environments](https://docs.zeptopayments.com/docs/zepto-environments)).
- Zepto separately limits Agreement creation to six attempts per debtor account in 24 hours. That protects a business action and does not define GET polling capacity ([Creating a PayTo Agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement)).
- The current PayTo create-Payment reference documents business-limit errors such as an account daily amount limit and Agreement frequency/count limits. Those are money-flow constraints, not an API request-rate or concurrency budget ([create Payment](https://docs.zeptopayments.com/reference/post_payto-payments)).
- The pinned PayTo OpenAPI contract lists `200/201`, validation/auth, `404`, and `500` responses for the relevant individual GET/create routes, but no `429` response or response header contract ([pinned PayTo OpenAPI](../../convex/lib/zepto/openapi/pay-to.yaml)). Absence from the contract does not prove throttling cannot occur.

**Unknown:** production and sandbox requests per second, burst size, concurrent-request allowance, whether GETs and POSTs share a quota, and what response signals quota exhaustion. Written account-specific confirmation is required before intentionally increasing GET frequency or Workpool concurrency.

### `Retry-After` and delivery retry behavior

- Zepto documents `Retry-After` for a narrow core-API idempotency case: two requests with the same `Idempotency-Key` in quick succession may return `503`, after which the client should wait for the header's number of seconds. That page does not apply this guarantee to PayTo same-UID GETs or define a general `429` contract ([Idempotent Requests](https://docs.zeptopayments.com/reference/idempotent-requests)).
- PayTo creation instead uses the caller-supplied UID to enforce uniqueness. The Payment reference requires the UID and describes it as ensuring uniqueness between the integrator and Zepto ([create Payment](https://docs.zeptopayments.com/reference/post_payto-payments)).
- A provider Payment retry is documented only after failure with `retryable: true`; Zepto caps retries at ten during the Agreement validity period and five attempts within 24 hours, including the first submission ([retry Payment](https://docs.zeptopayments.com/reference/post_payto-payments-payment-uid-retry)). Faster reconciliation must not turn provisional states or ambiguous acknowledgement into faster replay.
- PayMe's adapter defensively parses `Retry-After`, retries retryable GET failures, and caps an in-request wait at 30 seconds, but that is local policy rather than a documented PayTo provider guarantee ([`convex/lib/zepto/client.ts`](../../convex/lib/zepto/client.ts)).
- For outbound webhooks, Zepto retries only when it receives no HTTP response at all. It treats any HTTP response, including 4xx/5xx, as delivery completion; otherwise it retries every five minutes for one hour, with only one retry in sandbox. Order is not guaranteed and only at least one attempt is promised ([Setting up your webhooks](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)).

**Consequence:** webhook handling must durably record the signal before responding and retain GET-based missed-delivery recovery. Returning an error status does not ask Zepto to redeliver.

## Acceleration boundary

### Supported now

1. After durably deduplicating and recording an Agreement or Payment webhook, schedule one immediate same-UID GET. Preserve lease fencing and let an existing in-flight lease retain the webhook's urgency for its next run.
2. Keep the periodic dispatcher as a repair sweep for missed scheduling, crashes, and webhook loss. Removing its phase delay from the healthy path does not increase the normal-path provider call count.
3. For a nonterminal Payment, schedule its next locally permitted reconciliation directly instead of waiting for the next minute-aligned sweep. Start conservatively; exact cadence remains an application policy until provider limits are known.
4. Instrument webhook `published_at` to receipt, receipt to GET start, GET duration, Payment POST duration, POST to terminal provider observation, and terminal observation to durable settlement. Report healthy and degraded paths separately.

### Requires characterization or written confirmation

1. Immediate-GET visibility after Agreement activation and Payment terminal webhooks, including repeated trials across debtor institutions and both sandbox and production-shaped environments.
2. Account-specific GET rate, burst, and concurrency limits; quota scopes; `429`/`503` behavior; and whether/when `Retry-After` is supplied.
3. A polling cadence for `created`/`submitting` versus `pending`/`under_investigation`, including how the NPP's around-30-second outlier window should shape backoff.
4. The semantic eligibility and measured benefit of changing PayMe from `unattended` to `attended` priority.
5. Numeric Agreement/Payment webhook publication and delivery percentiles. “Real-time” is not a contractual latency budget.

### Must remain prohibited

1. Do not create a Payment from the activation webhook alone under PayMe's accepted safety boundary; require same-UID Agreement GET confirmation of `active`.
2. Do not mark money paid from `201 Created`, `created`, `submitting`, `pending`, or the mere receipt of a provisional webhook. Record settlement only from authoritative confirmed `settled` state.
3. Do not allocate a replacement Agreement or Payment UID because an immediate GET is stale, missing, timed out, or ambiguous. Preserve the one durable provider identity and reconcile ambiguity by that UID.
4. Do not automatically retry a failed Payment without fresh GET-confirmed retryability, and do not treat `pending` or `under_investigation` as a retryable failure.
5. Do not raise provider polling frequency or concurrency beyond the current envelope merely to hit a latency target until quota and consistency behavior are characterized and rollout is gated.
6. Do not weaken signature verification, durable deduplication, monotonic terminal state, leases, retry bounds, or the recovery sweep to save latency.

## Provider questions to close

Ask Zepto for written answers tied to PayMe's account and API version `20260101`:

1. After Zepto publishes a PayTo Agreement or Payment webhook, when is the corresponding same-UID GET guaranteed to show that state?
2. After `POST /payto/agreements` or `POST /payto/payments` returns, what read-your-write behavior is guaranteed for same-UID GET?
3. What are PayMe's sandbox and production GET request-rate, burst, and concurrent-request limits, and are quotas shared with money-moving POSTs?
4. Which status and headers signal throttling or temporary backpressure on PayTo GET, and must `Retry-After` be honoured?
5. What webhook publish and delivery percentiles should PayMe design for after the MMS/NPP result exists?
6. Does PayMe's payer-waiting flow qualify as `attended`, and is that designation contractually allowed to influence prioritisation?

Until those answers arrive, optimize local dispatch latency first and treat provider timing as an engineering SLO measured from production-shaped evidence, not a customer guarantee.
