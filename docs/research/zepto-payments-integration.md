# Zepto Payments integration research

Checked: 2026-08-09

## Recommendation

Zepto's public integration surface is a versioned REST API plus official OpenAPI specifications. I found no official public JavaScript/TypeScript SDK in Zepto's documentation or [public GitHub organisation](https://github.com/zeptofs); this is an inference from the official public sources, not an explicit Zepto statement. Zepto does publish downloadable OpenAPI specifications and explicitly invites integrators to import them into client tools ([OpenAPI specifications](https://docs.zeptopayments.com/reference/openapi-specifications), [Zepto API 20260101 YAML](https://go.zeptopayments.com/api-docs/zepto/20260101/openapi.yaml)).

The `20260101` surface is split across seven downloadable specifications rather than one aggregate file:

- [Core Zepto](https://go.zeptopayments.com/api-docs/zepto/20260101/openapi.yaml)
- [PayTo](https://go.zeptopayments.com/api-docs/pay-to/20260101/openapi.yaml)
- [Clients (Alpha)](https://go.zeptopayments.com/api-docs/clients/20260101/openapi.yaml)
- [Merchant Reports](https://go.zeptopayments.com/api-docs/merchant-reports/20260101/openapi.yaml)
- [Investigations](https://go.zeptopayments.com/api-docs/investigations/20260101/openapi.yaml)
- [Notifications](https://go.zeptopayments.com/api-docs/notifications/20260101/openapi.yaml)
- [Confirmation of Payee / Zepto Validate](https://go.zeptopayments.com/api-docs/cop/20260101/openapi.yaml)

Together they currently describe 75 outbound operations. Notifications is webhook-only. The rendered `POST /agreements/kyc` reference has a standalone embedded schema but is absent from the downloadable specifications, so the generated client deliberately excludes it. The Investigations evidence-upload schema describes a binary multipart body without naming a multipart field; callers must supply the `FormData` serializer rather than the wrapper inventing an undocumented field name.

The best implementation for this repository is therefore:

1. Pin all seven `20260101` OpenAPI specifications and generate TypeScript types from them.
2. Put a small application-owned `zepto` adapter around the generated surface. The adapter should own authentication, the API-version header, idempotency, timeouts/retries, runtime response validation, and mapping Zepto objects into PayMe domain objects.
3. Call that adapter only from server-side Convex actions. Keep tokens, bank details, and Zepto responses out of the browser.
4. Treat a payment as an asynchronous workflow, finalized by signed and deduplicated webhooks with GET-based reconciliation as a safety net.

Do not install the npm package named `zepto`; that name is associated with the unrelated Zepto.js browser library. Also do not let generated OpenAPI types become the PayMe domain model. Some schemas in the official specification are deliberately broad (for example, some response `data` fields are plain objects), so validate responses at runtime and map only the fields PayMe needs.

## Product fit for PayMe

PayMe currently lets a user specify a **Payment Destination**—a Bank Account or PayID—where another person should send requested money ([project context](../../CONTEXT.md)). Zepto offers several distinct money flows, and they are not interchangeable.

### Standard payout: only a partial fit

The standard payout path is:

1. `POST /contacts/anyone` to create a Contact to pay.
2. `POST /payments` with the Contact ID, source Zepto bank/float account, amount, maturation time, and payment channels.
3. Track the resulting payout/transactions to a terminal state.

The current Contact request accepts name, email, BSB, and account number. The current Payment request accepts exactly one payout whose recipient is a Contact ID ([Add a Contact](https://docs.zeptopayments.com/reference/addananyonecontact), [Make a Payment](https://docs.zeptopayments.com/reference/makeapayment), [Payments lifecycle](https://docs.zeptopayments.com/reference/payments-1)). This maps to PayMe's Bank Account destination, but the documented payout path does not accept an existing recipient PayID directly.

More importantly, `/payments` disburses funds from the authenticated merchant's Zepto-linked bank or float account. It does not make the requesting PayMe user pay from their own bank account. This is appropriate only if PayMe intends to fund or intermediate the payout.

### PayTo collection: different payer experience

PayTo can collect from a payer in real time, but it first requires a PayTo Agreement that the payer authorizes in their banking app. The high-level flow is `POST /payto/agreements`, wait for the agreement to become active, then `POST /payto/payments` and wait for the final webhook. Payments must conform to the authorized agreement terms ([integration overview](https://docs.zeptopayments.com/docs/integration-overview), [creating an agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement), [creating a PayTo payment](https://docs.zeptopayments.com/docs/creating-a-payto-payment)).

PayTo supports BSB/account identifiers and PayID aliases for agreement parties. A PayID must first pass Zepto's alias-resolution endpoint, which also requires the end user's identifier and IP address ([PayTo alias resolution](https://docs.zeptopayments.com/docs/payto-alias-resolution)). This is potentially useful if PayMe becomes the payment initiator, but it is not a one-click substitute for displaying a Payment Destination. Confirm the required commercial, compliance, and Third Party Processor/client model with Zepto before designing this as peer-to-peer payment initiation.

Zepto's agreement guide says custom merchant/initiator details are used when the Zepto account has been approved as a Third Party Processor; otherwise the registered Zepto account details are used and supplied initiator values are ignored ([creating an agreement](https://docs.zeptopayments.com/docs/creating-a-payto-agreement)). That makes Zepto approval a hard discovery item if the creditor is an arbitrary third-party PayMe user rather than PayMe itself.

### Direct Debit collection: also agreement-based

The core `POST /payment_requests` flow collects funds from a Contact into the authenticated merchant's bank account and requires an accepted Agreement; without a valid Agreement, an Anyone Contact request is rejected ([Request Payment](https://docs.zeptopayments.com/reference/makeapaymentrequest), [Payment Requests](https://docs.zeptopayments.com/reference/payment-requests-1)). It does not directly pay an arbitrary PayMe user's Payment Destination. Like PayTo, this is a merchant collection product, not the outbound `/payments` product and not a generic payer-to-recipient transfer.

### PayID receivables: not an existing PayID payout

Zepto's receivable-Contact feature assigns each customer a new PayID on a domain legally owned and configured by the merchant, then settles incoming money into the merchant's PayID-enabled float account. The feature requires Zepto enablement and has PayID lifecycle obligations ([Receivable Payments via PayID](https://docs.zeptopayments.com/docs/receivable-payments-via-payid), [Add a Receivable Contact](https://docs.zeptopayments.com/reference/addareceivablecontact)). It does not send money to a PayMe user's pre-existing PayID, so it should not be confused with the existing PayID Payment Destination.

### Practical first slice

If the intended feature is platform-funded payouts, start with Bank Account destinations only and the Contact + Payment flow. Store the Zepto Contact ID against the PayMe Payment Destination and reuse it until the destination changes. Before supporting PayID payouts or user-funded peer-to-peer payments, ask Zepto to confirm the exact supported product and onboarding model.

If the intended feature remains "show the payer where to send money," no Zepto integration is required for the core flow. Zepto becomes relevant only when PayMe itself initiates, receives, stores, or reconciles funds.

## Authentication and environments

Zepto uses bearer tokens over HTTPS. For a single PayMe-owned Zepto account, the simplest server-to-server setup is a Personal Access Token created for a dedicated service user. Zepto recommends a service user to avoid disruption when a human team member leaves; a Personal Access Token does not expire but can be revoked ([Getting Started in Sandbox](https://docs.zeptopayments.com/docs/getting-started-in-sandbox)). Grant only the required scopes—initially `contacts`, `payments`, and the read scope needed for reconciliation.

If PayMe will act on behalf of multiple independently owned Zepto accounts, use OAuth2 authorization-code and refresh-token grants instead. Access tokens last two hours. Refresh tokens do not expire, but they rotate and are single-use, so a refresh must atomically persist the newly returned refresh token before another worker can use the old one ([OAuth Grant Flow](https://docs.zeptopayments.com/docs/oauth-grant-flow)).

| Environment | API base URL                             | Portal/OAuth host                       |
| ----------- | ---------------------------------------- | --------------------------------------- |
| Sandbox     | `https://api.sandbox.zeptopayments.com/` | `https://go.sandbox.zeptopayments.com/` |
| Production  | `https://api.zeptopayments.com/`         | `https://go.zeptopayments.com/`         |

The official environment guide also specifies JSON, integer-cent amounts, UTC ISO-8601 timestamps, and static outbound webhook IPs ([Zepto Environments](https://docs.zeptopayments.com/docs/zepto-environments)). Zepto documents TLS 1.2 for API connections ([Zepto API](https://docs.zeptopayments.com/docs/zepto-api)).

Every request in a new integration should explicitly send:

```http
Authorization: Bearer <server-side token>
Accept: application/json
Content-Type: application/json
Zepto-API-Version: 20260101
```

If the version header is omitted, Zepto defaults to legacy version `20250101`; the current documented versions are `20250101` and `20260101` ([API Versioning](https://docs.zeptopayments.com/reference/api-versioning)).

For this codebase, add the base URL, token or OAuth credentials, source bank-account ID, and webhook secret to the typed Convex environment configuration in `convex/convex.config.ts`. Use different values for sandbox and production deployments. Never expose them as `VITE_*` browser variables.

## Idempotency and outbound retries

`Idempotency-Key` is required on the POST endpoints for Payments, Payment Requests, Transfers, and Refunds. A key may be up to 256 characters; Zepto recommends a UUIDv7 or another suitably random value. Keys expire after 24 hours. A duplicate key during that window returns `409 Conflict`, with `meta.resource_ref` identifying the previously created resource. A rapid duplicate may return `503 Service Unavailable`, in which case the client must respect `Retry-After` ([Idempotent Requests](https://docs.zeptopayments.com/reference/idempotent-requests)).

PayMe should generate and persist one stable idempotency key when the business operation is created, before making the network request. An ambiguous timeout must retry with the same key. Generating a fresh key for a retry can create a duplicate payment. Because Zepto's server-side key expires after 24 hours, PayMe must also enforce its own permanent uniqueness constraint on the business operation.

Suggested outbound state:

- PayMe operation ID and owner
- immutable amount, currency, and Payment Destination snapshot/reference
- Zepto Contact ID
- idempotency key
- Zepto Payment and payout references
- current normalized status and raw provider status
- attempt timestamps and last error

Do not mark a payout paid from the `201 Created` response. A Zepto Payment is a container; its payout/transactions change status, and a payout can be reversed if the recipient cannot be credited ([Payments lifecycle](https://docs.zeptopayments.com/reference/payments-1)).

## Webhooks and reconciliation

Expose a Convex HTTP action such as `POST /zepto/webhooks`. It must read and preserve the exact raw body before parsing JSON.

Zepto sends:

- `Split-Signature: <unix_timestamp>.<hex_hmac>`: calculate HMAC-SHA256 over `<timestamp>.<raw_body>` with the endpoint-specific secret, compare in constant time, and enforce a timestamp tolerance.
- `Split-Request-ID: <uuid>`: the ID remains the same for a retransmitted event and should be the database deduplication key.

The payload's `data` field is an array and can contain more than one transaction. Delivery order is not guaranteed, and Zepto promises at least one delivery attempt—not exactly once. Production retries no-response deliveries every five minutes for one hour; sandbox retries only once. A crucial caveat is that Zepto considers a delivery complete whenever it receives any HTTP response code, including a 4xx or 5xx ([Setting up your webhooks](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)).

The handler should therefore:

1. Reject malformed or invalid signatures before any state change.
2. In one durable internal mutation, insert the `Split-Request-ID` if unseen and apply monotonic/idempotent state changes for every `data` item.
3. Return quickly only after that durable mutation succeeds.
4. Keep the raw event or a redacted audit record sufficient for investigation.
5. Periodically reconcile unresolved operations through Zepto GET endpoints, because a webhook can be delayed, out of order, or permanently missed.

Static source IPs can be an additional allowlist control, but signature verification remains the trust mechanism; IP addresses can change and should be read from the current [environment guide](https://docs.zeptopayments.com/docs/zepto-environments), not hard-coded without an operational update process.

## Repository-shaped implementation plan

No application code was changed as part of this research. A future implementation should be split along these boundaries:

1. **Provider adapter** — generated OpenAPI artifacts plus a small handwritten client for headers, auth, timeouts, safe retry classification, runtime validation, and error normalization.
2. **Payment workflow** — a public authenticated Convex action validates the request and ownership, an internal mutation creates the immutable operation/idempotency record, the action calls Zepto, then an internal mutation records the response.
3. **Webhook boundary** — a Convex HTTP action verifies the raw request, then delegates all database changes to internal mutations. The existing Clerk webhook in `convex/http.ts` demonstrates the HTTP-action/internal-mutation seam, but Zepto verification must operate on raw bytes with its own HMAC scheme.
4. **Reconciliation** — scheduled work or an operator-triggered internal action polls non-terminal operations and repairs state from Zepto's source of truth.
5. **Tests** — unit-test signature verification and response mapping; use mocked users to test ownership and duplicate-submit rejection; replay duplicate/out-of-order webhook fixtures; exercise sandbox success, rejection, reversal, timeout, `409`, and `503` paths.

## Questions to resolve with Zepto before coding

1. Is PayMe funding payouts from one PayMe/Zepto merchant account, or should each payer fund their own transfer?
2. Does Zepto support payout to an existing arbitrary PayID under PayMe's intended product, despite the current `/contacts/anyone` schema requiring BSB/account details?
3. If PayMe initiates payments between end users, does Zepto require the Clients API, sub-merchant onboarding, TPP status, KYC/AML controls, or a stored-value/float product?
4. Which scopes and webhook event types should PayMe enable for the chosen product?
5. What production transaction, daily, concurrency, and alias-resolution limits apply to PayMe's account? The public reference documents possible limit errors but not one universal account limit.
6. What reconciliation and incident process does Zepto recommend when it receives a webhook HTTP response but PayMe fails immediately afterward?

The answers to the first three questions determine the domain model and money-flow architecture. They should be settled before implementing the client.
