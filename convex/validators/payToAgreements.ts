import { literals } from 'convex-helpers/validators'
import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { paymentDestinationTypeConvexValidator } from './paymentDestinations'

export const providerAgreementStates = [
  'pending',
  'created',
  'active',
  'suspended',
  'cancelled',
  'declined',
  'failed',
  'expired',
] as const

export const providerAgreementStateValidator = literals(
  ...providerAgreementStates,
)
export type ProviderAgreementState = Infer<
  typeof providerAgreementStateValidator
>

export const routingSnapshotValidator = v.object({
  kind: paymentDestinationTypeConvexValidator,
  maskedDisplay: v.string(),
  ciphertext: v.string(),
  nonce: v.string(),
  keyVersion: v.string(),
})

export const bankAccountRoutingSnapshotValidator = v.object({
  ...routingSnapshotValidator.fields,
  kind: v.literal('bban'),
})
