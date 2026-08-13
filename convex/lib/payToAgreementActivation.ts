import type {
  ActivationProvenancePolicy,
  AgreementEvidenceSource,
} from '../validators/payToAgreements'

export function firstConfirmedActivePatch(input: {
  activationProvenancePolicy: ActivationProvenancePolicy | undefined
  confirmationSource: AgreementEvidenceSource
  existingFirstConfirmedActiveAt: number | undefined
  observedAt: number
  providerState: string
}): { firstConfirmedActiveAt: number } | undefined {
  if (
    input.confirmationSource !== 'per_uid_get' ||
    input.providerState !== 'active' ||
    input.activationProvenancePolicy !== 'track_first_confirmation' ||
    input.existingFirstConfirmedActiveAt !== undefined
  ) {
    return
  }
  return { firstConfirmedActiveAt: input.observedAt }
}
