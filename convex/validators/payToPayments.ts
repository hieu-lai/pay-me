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

export const payToPaymentAttentionValidator = v.object({
  kind: v.literal('intent_fingerprint_mismatch'),
  expectedFingerprint: v.string(),
  observedFingerprint: v.string(),
  observedAt: v.number(),
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

export const payToPaymentOperationValidator = v.object({
  payToPaymentId: v.id('payToPayments'),
  operationId: v.string(),
  operationKind: payToPaymentOperationKindValidator,
  intentFingerprint: v.string(),
  authorizedAt: v.number(),
  outcome: v.optional(
    v.object({
      classification: payToPaymentOperationClassificationValidator,
      observedAt: v.number(),
    }),
  ),
})

export const payToPaymentEvidenceSourceValidator = literals(
  'create_response',
  'per_uid_get',
  'webhook',
)

export const payToPaymentEvidenceValidator = v.object({
  payToPaymentId: v.id('payToPayments'),
  source: payToPaymentEvidenceSourceValidator,
  intentFingerprint: v.string(),
  observedAt: v.number(),
})
