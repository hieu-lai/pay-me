import { literals } from 'convex-helpers/validators'
import type { Infer } from 'convex/values'
import { v } from 'convex/values'

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

export const bankAccountRoutingSnapshotValidator = v.object({
  kind: v.literal('bban'),
  maskedDisplay: v.string(),
  ciphertext: v.string(),
  nonce: v.string(),
  keyVersion: v.string(),
})
