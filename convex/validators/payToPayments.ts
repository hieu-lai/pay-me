import { literals } from 'convex-helpers/validators'
import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { routingSnapshotValidator } from './payToAgreements'

export const payToPaymentGateModeValidator = literals(
  'disabled',
  'reconcile_only',
  'enabled_for_new_confirmations',
)
export type PayToPaymentGateMode = Infer<typeof payToPaymentGateModeValidator>

export const payToPaymentActivationCohortValidator = v.object({
  kind: v.literal('payer_allowlist'),
})

export const payToPaymentCapacityLimitsValidator = v.object({
  dailyPaymentCount: v.number(),
  dailyPaymentValueCents: v.number(),
})

export const payToPaymentApprovalReferencesValidator = v.object({
  engineering: v.string(),
  operations: v.string(),
  security: v.string(),
  legalCompliance: v.string(),
  zepto: v.string(),
})

export const payToPaymentProductionCapacityReservationValidator = v.object({
  budgetDate: v.string(),
  paymentCount: v.literal(1),
  paymentValueCents: v.number(),
})

export const payToPaymentCreationStateValidator = literals(
  'create_pending',
  'creation_uncertain',
  'provider_established',
  'creation_attention_required',
)

export const payToPaymentRoutingIntentValidator = v.object({
  sourceCreditorPaymentDestinationId: v.id('paymentDestinations'),
  sourceDebtorPaymentDestinationId: v.id('paymentDestinations'),
  creditorSnapshot: routingSnapshotValidator,
  debtorSnapshot: routingSnapshotValidator,
})

export const payToPaymentIntentValidator = v.object({
  agreementProviderUid: v.string(),
  amount: v.object({
    cents: v.number(),
    currency: v.literal('AUD'),
  }),
  routing: payToPaymentRoutingIntentValidator,
  priority: v.literal('unattended'),
  apiVersion: v.literal('20260101'),
  fingerprint: v.string(),
})

export const payToPaymentOperationKindValidator = literals(
  'create',
  'retry',
  'get',
)

export const payToPaymentOperationClassificationValidator = literals(
  'completed',
  'uncertain',
  'refused',
)

export const payToPaymentDispatchCertaintyValidator = literals(
  'not_dispatched',
  'possibly_dispatched',
)

export const providerPayToPaymentStates = [
  'created',
  'submitting',
  'pending',
  'under_investigation',
  'failed',
  'settled',
] as const
export const providerPayToPaymentStateValidator = literals(
  ...providerPayToPaymentStates,
)
export type ProviderPayToPaymentState = Infer<
  typeof providerPayToPaymentStateValidator
>

export const payToPaymentAttentionValidator = v.union(
  v.object({
    kind: v.literal('intent_fingerprint_mismatch'),
    expectedFingerprint: v.string(),
    observedFingerprint: v.string(),
    observedAt: v.number(),
  }),
  v.object({
    kind: v.literal('unknown_provider_state'),
    observedAt: v.number(),
  }),
  v.object({
    kind: v.literal('settlement_contradiction'),
    observedState: providerPayToPaymentStateValidator,
    observedAt: v.number(),
  }),
  v.object({
    kind: v.literal('creation_recovery_required'),
    reason: literals(
      'recovery_exhausted',
      'deterministic_failure',
      'agreement_invalid',
    ),
    observedAt: v.number(),
  }),
  v.object({
    kind: v.literal('retry_acknowledgement_uncertain'),
    observedAt: v.number(),
  }),
)

export const payToPaymentCreateErrorCategories = [
  'aborted',
  'configuration',
  'duplicate_uid',
  'http',
  'invalid_response',
  'network',
  'sandbox_only',
  'timeout',
  'uid_mismatch',
  'unclassified',
] as const
export const payToPaymentCreateErrorCategoryValidator = literals(
  ...payToPaymentCreateErrorCategories,
)
export type PayToPaymentCreateErrorCategory = Infer<
  typeof payToPaymentCreateErrorCategoryValidator
>

export const payToPaymentOperatorReasonValidator = literals(
  'investigate_provider_state',
  'recover_stalled_work',
  'respond_to_alert',
  'verify_payment_outcome',
)

export const payToPaymentOperatorActionValidator = literals(
  'request_reconciliation',
  'request_resume',
)

export const payToPaymentOperatorDecisionValidator = literals(
  'authorized',
  'refused',
  'no_op',
)

export const payToPaymentOperatorResultCodeValidator = literals(
  'scheduled',
  'already_due',
  'unauthenticated',
  'insufficient_role',
  'payment_not_found',
  'attention_required',
  'operation_not_allowed',
)

export const payToPaymentOperationValidator = v.object({
  payToPaymentId: v.id('payToPayments'),
  operationId: v.string(),
  operationKind: payToPaymentOperationKindValidator,
  providerUid: v.optional(v.string()),
  apiVersion: v.optional(v.literal('20260101')),
  productionActivationId: v.optional(v.id('payToPaymentActivations')),
  dispatchCertainty: v.optional(payToPaymentDispatchCertaintyValidator),
  intentFingerprint: v.string(),
  requestFingerprint: v.optional(v.string()),
  authorizedAt: v.number(),
  leaseToken: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
  dispatchStartedAt: v.optional(v.number()),
  mechanicsRetiredAt: v.optional(v.number()),
  outcome: v.optional(
    v.object({
      classification: payToPaymentOperationClassificationValidator,
      observedAt: v.number(),
    }),
  ),
})

export const payToPaymentEvidenceSourceValidator = literals(
  'create_response',
  'retry_response',
  'per_uid_get',
  'webhook',
)

export const payToPaymentEvidenceValidator = v.object({
  payToPaymentId: v.id('payToPayments'),
  source: payToPaymentEvidenceSourceValidator,
  intentFingerprint: v.string(),
  operationId: v.optional(v.string()),
  operationKind: v.optional(payToPaymentOperationKindValidator),
  providerUid: v.optional(v.string()),
  apiVersion: v.optional(v.literal('20260101')),
  dispatchCertainty: v.optional(payToPaymentDispatchCertaintyValidator),
  operationAuthorizedAt: v.optional(v.number()),
  operationLeaseExpiresAt: v.optional(v.number()),
  operationDispatchStartedAt: v.optional(v.number()),
  leaseToken: v.optional(v.string()),
  requestFingerprint: v.optional(v.string()),
  classification: v.optional(payToPaymentOperationClassificationValidator),
  providerState: v.optional(v.string()),
  providerFailureCode: v.optional(v.string()),
  providerFailureRetryable: v.optional(v.boolean()),
  providerAbsent: v.optional(v.boolean()),
  deliveryId: v.optional(v.string()),
  providerEventId: v.optional(v.string()),
  eventType: v.optional(v.string()),
  providerPublishedAt: v.optional(v.number()),
  providerCreatedAt: v.optional(v.number()),
  errorCategory: v.optional(payToPaymentCreateErrorCategoryValidator),
  outcome: v.optional(
    literals('confirmed', 'unknown', 'contradiction', 'failure', 'absence'),
  ),
  consecutiveFailures: v.optional(v.number()),
  mechanicsRetiredAt: v.optional(v.number()),
  observedAt: v.number(),
})
