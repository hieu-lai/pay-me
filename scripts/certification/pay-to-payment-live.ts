import { createHash } from 'node:crypto'

import { PAYTO_PAYMENT_API_VERSION } from './pay-to-payment'

export const LIVE_CERTIFICATION_REQUIREMENTS = [
  'exactly-one-creation-and-authoritative-settlement',
  'repeated-activation',
  'repeated-webhook-delivery',
  'create-response-loss-and-same-uid-get-recovery',
  'retryable-failure-and-retry',
  'non-retryable-failure',
  'pending',
  'under-investigation',
  'missed-webhook-recovery',
  'duplicate-webhook-recovery',
  'reordered-webhook-recovery',
  'multi-payer-mixed-outcomes',
] as const

type LiveCertificationRequirement =
  (typeof LIVE_CERTIFICATION_REQUIREMENTS)[number]

type PassedScenario = {
  requirement: LiveCertificationRequirement
  result: 'passed'
  evidence: string
}

type ProviderLimitationScenario = {
  requirement: LiveCertificationRequirement
  result: 'provider_limitation'
  evidence: string
  deterministicEvidence: ReadonlyArray<string>
  zeptoConfirmation: string
  confirmationKind: string
}

type IncompleteScenario = {
  requirement: LiveCertificationRequirement
  result: 'incomplete'
  evidence: string
  deterministicEvidence: ReadonlyArray<string>
  missingEvidence: string
}

export type LiveCertificationScenario =
  PassedScenario | ProviderLimitationScenario | IncompleteScenario

export type LiveCertificationInput = {
  certifiedCommit: string
  evidenceDate: string
  environment: string
  apiVersion: string
  configurationFingerprint: string
  credentialFingerprint: string
  worktreeClean: boolean
  scenarios: ReadonlyArray<LiveCertificationScenario>
}

function validateBoundedEvidence(value: string, label: string) {
  if (
    value.length === 0 ||
    value.length > 500 ||
    !/^[A-Za-z0-9 ._:/#(),;-]+$/.test(value) ||
    /(?:token|secret|authorization)[=:]/i.test(value)
  ) {
    throw new Error(`${label} must be bounded sanitized evidence.`)
  }
}

function validateInput(input: LiveCertificationInput) {
  if (!/^[0-9a-f]{40}$/.test(input.certifiedCommit)) {
    throw new Error('Certified commit must be a 40-character Git commit.')
  }
  if (!input.worktreeClean) {
    throw new Error('Live certification requires a clean worktree.')
  }
  if (input.environment !== 'sandbox') {
    throw new Error('Live certification is sandbox-only.')
  }
  if (input.apiVersion !== PAYTO_PAYMENT_API_VERSION) {
    throw new Error(
      `Live certification requires API version ${PAYTO_PAYMENT_API_VERSION}.`,
    )
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.evidenceDate)) {
    throw new Error('Live certification evidence date is invalid.')
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.configurationFingerprint)) {
    throw new Error('Live certification configuration fingerprint is invalid.')
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.credentialFingerprint)) {
    throw new Error('Live certification credential fingerprint is invalid.')
  }

  for (const requirement of LIVE_CERTIFICATION_REQUIREMENTS) {
    const results = input.scenarios.filter(
      (scenario) => scenario.requirement === requirement,
    )
    if (results.length === 0) {
      throw new Error(`Missing mandatory live scenario: ${requirement}`)
    }
    if (results.length !== 1) {
      throw new Error(`Live scenario must appear exactly once: ${requirement}`)
    }
  }
  if (input.scenarios.length !== LIVE_CERTIFICATION_REQUIREMENTS.length) {
    throw new Error('Live certification contains an unknown scenario.')
  }

  for (const scenario of input.scenarios) {
    validateBoundedEvidence(scenario.evidence, 'Live scenario evidence')
    if (scenario.result !== 'passed') {
      if (scenario.deterministicEvidence.length === 0) {
        throw new Error('Non-live evidence requires deterministic evidence.')
      }
      for (const reference of scenario.deterministicEvidence) {
        validateBoundedEvidence(reference, 'Deterministic evidence reference')
      }
    }
    if (scenario.result === 'provider_limitation') {
      if (
        scenario.confirmationKind !== 'direct_written_zepto_confirmation' ||
        !/^https:\/\/[^\s]+$/.test(scenario.zeptoConfirmation)
      ) {
        throw new Error(
          'Provider limitation requires written Zepto confirmation.',
        )
      }
    } else if (scenario.result === 'incomplete') {
      validateBoundedEvidence(scenario.missingEvidence, 'Missing evidence')
    }
  }
}

export function liveCertificationFingerprint(input: LiveCertificationInput) {
  validateInput(input)
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        certifiedCommit: input.certifiedCommit,
        evidenceDate: input.evidenceDate,
        environment: input.environment,
        apiVersion: input.apiVersion,
        configurationFingerprint: input.configurationFingerprint,
        credentialFingerprint: input.credentialFingerprint,
        scenarios: input.scenarios,
      }),
    )
    .digest('base64url')
}

export function buildLiveCertificationReport(
  input: LiveCertificationInput,
): string {
  validateInput(input)
  const fingerprint = liveCertificationFingerprint(input)
  const certificationStatus = input.scenarios.some(
    (scenario) => scenario.result === 'incomplete',
  )
    ? 'NOT CERTIFIED'
    : 'CERTIFIED'
  const scenarioRows = input.scenarios
    .map((scenario) => {
      const result =
        scenario.result === 'passed'
          ? 'PASS'
          : scenario.result === 'provider_limitation'
            ? 'PROVIDER LIMITATION'
            : 'INCOMPLETE'
      const support =
        scenario.result === 'passed'
          ? 'Live Zepto sandbox observation'
          : scenario.result === 'provider_limitation'
            ? `${scenario.deterministicEvidence.map((path) => `\`${path}\``).join('; ')}; [direct written Zepto confirmation](${scenario.zeptoConfirmation})`
            : `${scenario.deterministicEvidence.map((path) => `\`${path}\``).join('; ')}; missing: ${scenario.missingEvidence}`
      return `| \`${scenario.requirement}\` | ${result} | ${scenario.evidence} | ${support} |`
    })
    .join('\n')

  return `# PayTo Payment live Zepto sandbox certification

| Field | Recorded value |
| --- | --- |
| Certification status | ${certificationStatus} |
| Commit | \`${input.certifiedCommit}\` |
| Evidence date | ${input.evidenceDate} |
| Environment | Zepto sandbox |
| API version | \`${input.apiVersion}\` |
| Configuration fingerprint | \`${input.configurationFingerprint}\` |
| Credential fingerprint | \`${input.credentialFingerprint}\` |
| Certification fingerprint | \`${fingerprint}\` |
| Evidence class | Live provider-connected sandbox drill through the production Zepto adapter |

## Mandatory scenario evidence

| Requirement | Result | Sanitized observation | Supporting evidence |
| --- | --- | --- | --- |
${scenarioRows}

Provider payloads, account details, credentials, raw webhook bodies, and routing details are intentionally excluded. Identifiers in observations are one-way fingerprints rather than provider UIDs.

## Activation decision

Production activation remains denied. This sandbox certification does not change a runtime gate and does not replace engineering, operations, security, legal/compliance, or Zepto approval.

## Freshness and invalidation

This evidence expires 30 days after ${input.evidenceDate}. A material change to the commit, API version, sandbox environment, credential, or configuration fingerprint invalidates it sooner.
`
}
