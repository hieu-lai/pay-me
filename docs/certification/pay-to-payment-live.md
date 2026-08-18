# PayTo Payment live Zepto sandbox certification

| Field                     | Recorded value                                                             |
| ------------------------- | -------------------------------------------------------------------------- |
| Certification status      | NOT CERTIFIED                                                              |
| Commit                    | `e05a8b91769245edc24075c4b7e05942ec2ef782`                                 |
| Evidence date             | 2026-08-18                                                                 |
| Environment               | Zepto sandbox                                                              |
| API version               | `20260101`                                                                 |
| Configuration fingerprint | `payme-live-sandbox-20260818`                                              |
| Credential fingerprint    | `0Ic3JHa81pvS9O6Rf0WPvOk6AOy1nmolrOGzeKxTl3g`                              |
| Certification fingerprint | `FGL_WHo26gThdcp3NBqz16ayYtI0-CXD1mrwgm2xYH8`                              |
| Evidence class            | Live provider-connected sandbox drill through the production Zepto adapter |

## Mandatory scenario evidence

| Requirement                                         | Result     | Sanitized observation                                                                                                | Supporting evidence                                                                                                                                    |
| --------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exactly-one-creation-and-authoritative-settlement` | INCOMPLETE | Payment fingerprint wDBF7EsXIBgFH2FN: the adapter issued one create POST and authoritative GET confirmed settlement. | `convex/payToPayments.test.ts`; missing: One live workflow activation proving durable immutable intent through settlement                              |
| `repeated-activation`                               | PASS       | Workflow Payment fingerprint FZTKw2NxwaN0CND7 matched twice with one durable create operation.                       | Live Zepto sandbox observation                                                                                                                         |
| `repeated-webhook-delivery`                         | INCOMPLETE | The live run did not force Zepto to deliver the same webhook repeatedly.                                             | `convex/zeptoWebhook.test.ts`; `convex/payToPayments.test.ts`; missing: Direct written Zepto confirmation or a reproducible repeated-delivery fixture  |
| `create-response-loss-and-same-uid-get-recovery`    | PASS       | Payment fingerprint AWxxd557BjGgp9bX recovered by same-UID GET after deliberate create-response loss.                | Live Zepto sandbox observation                                                                                                                         |
| `retryable-failure-and-retry`                       | PASS       | Payment fingerprint ll_GaFvOcKxyE1o5 failed retryably, retried the same resource, and settled authoritatively.       | Live Zepto sandbox observation                                                                                                                         |
| `non-retryable-failure`                             | PASS       | Payment fingerprint xCxH7uSjtkhJn_AM reached GET-confirmed non-retryable failure.                                    | Live Zepto sandbox observation                                                                                                                         |
| `pending`                                           | INCOMPLETE | Zepto documents pending but the available sandbox simulations did not deterministically hold a Payment pending.      | `convex/payToPayments.test.ts`; missing: Direct written Zepto confirmation or a reproducible live pending fixture                                      |
| `under-investigation`                               | PASS       | Payment fingerprint j9I1LKR_qQmLKCTr reached GET-confirmed under-investigation state without a second create.        | Live Zepto sandbox observation                                                                                                                         |
| `missed-webhook-recovery`                           | INCOMPLETE | The live run did not force Zepto to omit a webhook for a workflow Payment.                                           | `convex/payToPayments.test.ts`; missing: Direct written Zepto confirmation or a reproducible missed-delivery fixture                                   |
| `duplicate-webhook-recovery`                        | INCOMPLETE | The live run did not force duplicate Zepto webhook delivery.                                                         | `convex/zeptoWebhook.test.ts`; missing: Direct written Zepto confirmation or a reproducible duplicate-delivery fixture                                 |
| `reordered-webhook-recovery`                        | INCOMPLETE | The live run did not force reordered Zepto webhook delivery.                                                         | `convex/zeptoWebhook.test.ts`; `convex/payToPayments.test.ts`; missing: Direct written Zepto confirmation or a reproducible reordered-delivery fixture |
| `multi-payer-mixed-outcomes`                        | INCOMPLETE | Independent Payment fingerprints AuuVqCmi05cC_jAd and Bagj-zvbEW3sdP2u reached settled and failed provider outcomes. | `convex/payToPayments.test.ts`; missing: One live multi-Payer Money Request projecting both provider outcomes                                          |

Provider payloads, account details, credentials, raw webhook bodies, and routing details are intentionally excluded. Identifiers in observations are one-way fingerprints rather than provider UIDs.

## Activation decision

Production activation remains denied. This sandbox certification does not change a runtime gate and does not replace engineering, operations, security, legal/compliance, or Zepto approval.

## Freshness and invalidation

This evidence expires 30 days after 2026-08-18. A material change to the commit, API version, sandbox environment, credential, or configuration fingerprint invalidates it sooner.
