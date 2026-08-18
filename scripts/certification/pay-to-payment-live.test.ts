import { describe, expect, test } from 'vitest'

import {
  LIVE_CERTIFICATION_REQUIREMENTS,
  buildLiveCertificationReport,
  liveCertificationFingerprint,
} from './pay-to-payment-live'

const passedScenarios = LIVE_CERTIFICATION_REQUIREMENTS.map((requirement) => ({
  requirement,
  result: 'passed' as const,
  evidence: `${requirement} observed through the live sandbox seam`,
}))

function validInput() {
  return {
    certifiedCommit: 'a'.repeat(40),
    evidenceDate: '2026-08-18',
    environment: 'sandbox' as const,
    apiVersion: '20260101' as const,
    configurationFingerprint: 'sandbox-payment-v1',
    credentialFingerprint: 'c'.repeat(43),
    worktreeClean: true,
    scenarios: passedScenarios,
  }
}

describe('PayTo Payment live sandbox certification', () => {
  test('renders a sanitized commit-bound report without changing the production gate', () => {
    const report = buildLiveCertificationReport(validInput())

    expect(report).toContain(`Commit | \`${'a'.repeat(40)}\``)
    expect(report).toContain('Evidence date | 2026-08-18')
    expect(report).toContain('Environment | Zepto sandbox')
    expect(report).toContain('API version | `20260101`')
    expect(report).toContain('Configuration fingerprint | `sandbox-payment-v1`')
    expect(report).toMatch(/Certification fingerprint \| `[A-Za-z0-9_-]{43}`/)
    expect(report).toContain('Production activation remains denied')
    expect(report).toContain('Certification status | CERTIFIED')
    expect(report).not.toContain('sensitive-provider-payload')
    expect(report).not.toContain('sensitive-routing-details')
  })

  test('requires exactly one result for every mandatory live scenario', () => {
    const valid = validInput()

    expect(() =>
      buildLiveCertificationReport({
        ...valid,
        scenarios: valid.scenarios.slice(1),
      }),
    ).toThrow('mandatory live scenario')
    expect(() =>
      buildLiveCertificationReport({
        ...valid,
        scenarios: [...valid.scenarios, valid.scenarios[0]],
      }),
    ).toThrow('exactly once')
  })

  test('accepts a provider limitation only with deterministic evidence and written Zepto confirmation', () => {
    const valid = validInput()
    const limitation = {
      requirement: valid.scenarios[0].requirement,
      result: 'provider_limitation' as const,
      evidence: 'Zepto sandbox cannot force this delivery order',
      deterministicEvidence: ['convex/zeptoWebhook.test.ts'],
      zeptoConfirmation:
        'https://docs.zeptopayments.com/docs/setting-up-your-webhooks',
      confirmationKind: 'direct_written_zepto_confirmation' as const,
    }

    expect(() =>
      buildLiveCertificationReport({
        ...valid,
        scenarios: [
          { ...limitation, zeptoConfirmation: '' },
          ...valid.scenarios.slice(1),
        ],
      }),
    ).toThrow('written Zepto confirmation')

    expect(
      buildLiveCertificationReport({
        ...valid,
        scenarios: [limitation, ...valid.scenarios.slice(1)],
      }),
    ).toContain('PROVIDER LIMITATION')
  })

  test('renders incomplete mandatory evidence as not certified', () => {
    const valid = validInput()
    const report = buildLiveCertificationReport({
      ...valid,
      scenarios: [
        {
          requirement: valid.scenarios[0].requirement,
          result: 'incomplete' as const,
          evidence:
            'The live adapter outcome was observed but the workflow seam was not',
          deterministicEvidence: ['convex/payToPayments.test.ts'],
          missingEvidence: 'End-to-end sandbox workflow fixture',
        },
        ...valid.scenarios.slice(1),
      ],
    })

    expect(report).toContain('Certification status | NOT CERTIFIED')
    expect(report).toContain('INCOMPLETE')
    expect(report).toContain('End-to-end sandbox workflow fixture')
  })

  test('invalidates live evidence when a material binding changes', () => {
    const valid = validInput()
    const original = liveCertificationFingerprint(valid)

    expect(
      liveCertificationFingerprint({
        ...valid,
        certifiedCommit: 'b'.repeat(40),
      }),
    ).not.toBe(original)
    expect(
      liveCertificationFingerprint({
        ...valid,
        configurationFingerprint: 'sandbox-payment-v2',
      }),
    ).not.toBe(original)
    expect(() =>
      liveCertificationFingerprint({ ...valid, worktreeClean: false }),
    ).toThrow('clean worktree')
  })
})
