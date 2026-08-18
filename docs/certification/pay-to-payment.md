# PayTo Payment deterministic certification

| Field                     | Certified value                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Commit                    | `1526d547956355be542a934d0b475ade1990efb9`                                                   |
| Evidence date             | 2026-08-18                                                                                   |
| Environment               | Zepto sandbox                                                                                |
| API version               | `20260101`                                                                                   |
| Configuration fingerprint | `deterministic-test-fixtures-v1`                                                             |
| Credential fingerprint    | `dcAnXbcpzqnEGb-9sKU4DgeVXAgSlP2svESDKJK8iIg`                                                |
| Certification fingerprint | `glmCtsRABB810sQIZYf6W52U8QTF74HdRwGZ1AkDcdY`                                                |
| Evidence class            | Deterministic automated certification through production code seams; no live provider access |

## Command results

| Gate                | Command             | Result        |
| ------------------- | ------------------- | ------------- |
| formatting          | `bun run check`     | PASS (exit 0) |
| linting             | `bun run lint`      | PASS (exit 0) |
| type-checking       | `bun run typecheck` | PASS (exit 0) |
| complete-test-suite | `bun run test`      | PASS (exit 0) |
| production-build    | `bun run build`     | PASS (exit 0) |

All commands ran from a clean worktree at the exact certified commit. Command output is excluded so credentials, routing details, provider payloads, raw webhook bodies, environment values, and other sensitive material cannot enter this evidence.

## Mandatory scenario evidence

| Area                                             | Mandatory requirement                  | Automated evidence                                                     | Deterministic drill                                                                                                                                                    | Safety outcome                                                                                                                           |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly-once intent and provider dispatch        | `exactly-once-intent-and-dispatch`     | `convex/payToPayments.test.ts`                                         | Repeated and concurrent confirmation, worker crashes, stale leases, and create/retry transport failures cross the production Payment interface and adapter seam.       | One immutable intent, permanent provider UID, durable operation identity, and at most one POST per semantic authorization.               |
| Creation ambiguity and recovery                  | `creation-ambiguity`                   | `convex/payToPayments.test.ts`                                         | Lost responses, duplicate UID, provider absence, malformed success, and bounded same-UID recovery use explicit clocks and normalized adapter evidence.                 | Ambiguity reconciles by GET and never allocates a replacement UID or an unbounded POST loop.                                             |
| Authoritative lifecycle truth                    | `lifecycle-truth`                      | `convex/payToPayments.test.ts`                                         | Validated GET evidence covers every safe lifecycle, unknown states, missed webhooks, outages, and post-settlement contradictions.                                      | GET is authoritative, settlement is absorbing, and provisional or unknown evidence cannot rewrite confirmed truth.                       |
| Conservative retry policy                        | `retry-policy`                         | `convex/payToPayments.test.ts`                                         | Fake-clock drills exercise fresh-GET eligibility, fixed backoff, agreement expiry, rolling and lifetime budgets, cooldown, concurrency, and ambiguous acknowledgement. | Only GET-confirmed retryable failure can progress; ambiguous retry acknowledgement locks automatic replay.                               |
| Authenticated webhook intake                     | `webhooks`                             | `convex/lib/zepto/webhook.test.ts`; `convex/zeptoWebhook.test.ts`      | Exact-byte HMAC, stale/forged signatures, delivery and event replay, reordering, mixed resources, unsupported events, and storage failure cross shared ingress.        | Only durably accepted authenticated evidence is acknowledged; events schedule GET without becoming lifecycle authority.                  |
| Payer and Money Request projections              | `projections`, `multi-payer-isolation` | `convex/payToPayments.test.ts`                                         | Mixed independent Payer outcomes and simultaneous transitions update production projections in real Convex transactions.                                               | Counts remain exact and non-negative, sibling truth remains isolated, and the Money Request is paid only when every Payer is paid.       |
| Production gates and automatic safety stops      | `gates`                                | `convex/payToPayments.test.ts`; `convex/payToPaymentRollout.test.ts`   | Default denial, cutoff and allowlist admission, concurrent caps, prerequisite drift, staged rollout, and safety causes cross the durable gate boundary.                | Money-moving dispatch fails closed while webhook intake and GET reconciliation remain available for started Payments.                    |
| Operator authorization and policy-bound recovery | `authorization`                        | `convex/payToPaymentOperators.test.ts`                                 | Unauthenticated, insufficient-role, impersonation, forced-state, immediate-GET, no-op, and safe-resume requests cross public operator functions.                       | Server-derived identity and module policy authorize recovery; every request leaves bounded audit evidence.                               |
| Evidence redaction and diagnostic safety         | `redaction`                            | `convex/payToPaymentOperators.test.ts`; `convex/payToPayments.test.ts` | Representative routing ciphertext, auth material, lease tokens, raw states, and provider failure detail are driven through diagnostics and evidence seams.             | Documents, diagnostics, telemetry, and this manifest retain only allowlisted normalized evidence and fingerprints.                       |
| Bounded evidence retention                       | `retention`                            | `convex/payToPaymentRetention.test.ts`                                 | Explicit clocks cross calendar and category boundaries while bounded cleanup preserves permanent duplicate-prevention identity.                                        | Audit evidence, mechanics, and rejected-delivery metadata follow their distinct retention periods without weakening exactly-once safety. |

Every named test above was present and runnable before the quality gates ran. A missing, skipped, todo, or quarantined mandatory scenario fails certification and no manifest is emitted.

## Activation decision

This report certifies deterministic behavior for the recorded commit, environment, pinned API version, configuration fingerprint, and credential fingerprint only. Production activation remains denied: certification does not change a runtime gate, grant provider access, supply independent approvals, or replace fresh sanitized live Zepto sandbox evidence.

## Known gaps

- Live Zepto sandbox drills, provider delivery, quotas, enabled scopes, and production credentials are outside this deterministic evidence class and require fresh sanitized live evidence.
- Ambiguous retry acknowledgement remains locked against automatic replay. Production approval requires written Zepto confirmation of a safe replay contract; deterministic evidence cannot close that provider gap.
- Independent engineering, operations, security, legal/compliance, and Zepto approvals remain required before production initiation.

## Invalidation and rerun triggers

Rerun `bun run certify:pay-to-payment` after any material change to code, API version, environment, credentials, Payment configuration, this manifest, or referenced scenario evidence. A changed bound value produces a different certification fingerprint and invalidates the applicable prior evidence. Live sandbox evidence remains separate and subject to its own freshness and approval rules.
