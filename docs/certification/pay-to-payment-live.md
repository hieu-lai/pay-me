# PayTo Payment live Zepto sandbox certification

| Field                     | Certified value                                                            |
| ------------------------- | -------------------------------------------------------------------------- |
| Commit                    | `6055adbeef0daec22a608c9a1fa0e694c5d706fd`                                 |
| Evidence date             | 2026-08-18                                                                 |
| Environment               | Zepto sandbox                                                              |
| API version               | `20260101`                                                                 |
| Configuration fingerprint | `payme-live-sandbox-20260818`                                              |
| Credential fingerprint    | `0Ic3JHa81pvS9O6Rf0WPvOk6AOy1nmolrOGzeKxTl3g`                              |
| Certification fingerprint | `5947lB2yiCe_6ZRot3DjL8KaalRZlRMF_FEyeTDBvyY`                              |
| Evidence class            | Live provider-connected sandbox drill through the production Zepto adapter |

## Mandatory scenario evidence

| Requirement                                         | Result              | Sanitized observation                                                                                                                                                                     | Supporting evidence                                                                                                                                       |
| --------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exactly-one-creation-and-authoritative-settlement` | PASS                | Payment fingerprint TP6EVl1bHKVXkJr6: one create POST and authoritative GET-confirmed settlement.                                                                                         | Live Zepto sandbox observation                                                                                                                            |
| `repeated-activation`                               | PASS                | Workflow Payment fingerprint FZTKw2NxwaN0CND7 matched twice with one durable create operation.                                                                                            | Live Zepto sandbox observation                                                                                                                            |
| `repeated-webhook-delivery`                         | PROVIDER LIMITATION | Zepto documents delivery semantics but exposes no API control that deterministically forces this delivery pattern.                                                                        | `convex/zeptoWebhook.test.ts`; `convex/payToPayments.test.ts`; [written Zepto confirmation](https://docs.zeptopayments.com/docs/setting-up-your-webhooks) |
| `create-response-loss-and-same-uid-get-recovery`    | PASS                | Payment fingerprint OkxFNLjLc8aGNvK5 recovered by same-UID GET after deliberate create-response loss.                                                                                     | Live Zepto sandbox observation                                                                                                                            |
| `retryable-failure-and-retry`                       | PASS                | Payment fingerprint IDRdnuN77P_oD8FJ failed retryably, retried the same resource, and settled authoritatively.                                                                            | Live Zepto sandbox observation                                                                                                                            |
| `non-retryable-failure`                             | PASS                | Payment fingerprint IEKq_4Beo3Oo9HFi reached GET-confirmed non-retryable failure.                                                                                                         | Live Zepto sandbox observation                                                                                                                            |
| `pending`                                           | PROVIDER LIMITATION | Zepto documents pending as a lifecycle state but exposes no sandbox simulation that deterministically holds a Payment pending.                                                            | `convex/payToPayments.test.ts`; [written Zepto confirmation](https://go.zeptopayments.com/api-docs/zepto/20260101/openapi.yaml)                           |
| `under-investigation`                               | PASS                | Payment fingerprint qB5uOVCgvjqvQ3lV reached GET-confirmed under-investigation state without a second create.                                                                             | Live Zepto sandbox observation                                                                                                                            |
| `missed-webhook-recovery`                           | PROVIDER LIMITATION | Zepto documents delivery semantics but exposes no API control that deterministically forces this delivery pattern.                                                                        | `convex/payToPaymentReconciliation.test.ts`; [written Zepto confirmation](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)                   |
| `duplicate-webhook-recovery`                        | PROVIDER LIMITATION | Zepto documents delivery semantics but exposes no API control that deterministically forces this delivery pattern.                                                                        | `convex/zeptoWebhook.test.ts`; [written Zepto confirmation](https://docs.zeptopayments.com/docs/setting-up-your-webhooks)                                 |
| `reordered-webhook-recovery`                        | PROVIDER LIMITATION | Zepto documents delivery semantics but exposes no API control that deterministically forces this delivery pattern.                                                                        | `convex/zeptoWebhook.test.ts`; `convex/payToPayments.test.ts`; [written Zepto confirmation](https://docs.zeptopayments.com/docs/setting-up-your-webhooks) |
| `multi-payer-mixed-outcomes`                        | PASS                | Independent Payment fingerprints TSHNWx9RQg8xyLJl and rvCYuotG-YvnoaFB reached settled and failed outcomes; deterministic Money Request projection evidence remains separately certified. | Live Zepto sandbox observation                                                                                                                            |

Provider payloads, account details, credentials, raw webhook bodies, and routing details are intentionally excluded. Identifiers in observations are one-way fingerprints rather than provider UIDs.

## Activation decision

Production activation remains denied. This sandbox certification does not change a runtime gate and does not replace engineering, operations, security, legal/compliance, or Zepto approval.

## Freshness and invalidation

This evidence expires 30 days after 2026-08-18. A material change to the commit, API version, sandbox environment, credential, or configuration fingerprint invalidates it sooner.
