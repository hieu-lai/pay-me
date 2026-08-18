import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import {
  CERTIFICATION_COMMANDS,
  CERTIFICATION_SCENARIOS,
  MANDATORY_CERTIFICATION_REQUIREMENTS,
  buildCertificationReport,
  certificationFingerprint,
  verifyCertificationEvidence,
} from './pay-to-payment'

const certifiedCommit = 'a'.repeat(40)

function successfulResults() {
  return CERTIFICATION_COMMANDS.map(({ id, displayCommand }) => ({
    id,
    displayCommand,
    exitCode: 0,
  }))
}

function validInput() {
  return {
    certifiedCommit,
    evidenceDate: '2026-08-18',
    environment: 'sandbox' as const,
    apiVersion: '20260101' as const,
    configurationFingerprint: 'configuration-v1',
    credentialFingerprint: 'c'.repeat(43),
    worktreeClean: true,
    results: successfulResults(),
  }
}

describe('PayTo Payment deterministic certification', () => {
  test('requires every release gate and mandatory production safety scenario', () => {
    expect(MANDATORY_CERTIFICATION_REQUIREMENTS).toEqual([
      'exactly-once-intent-and-dispatch',
      'creation-ambiguity',
      'lifecycle-truth',
      'retry-policy',
      'webhooks',
      'projections',
      'gates',
      'authorization',
      'redaction',
      'retention',
      'multi-payer-isolation',
    ])
    expect(
      new Set(
        CERTIFICATION_SCENARIOS.flatMap(({ requirements }) => requirements),
      ),
    ).toEqual(new Set(MANDATORY_CERTIFICATION_REQUIREMENTS))
  })

  test.each([
    ['missing', 'the named test has been removed'],
    ['skipped', "test.skip('the named test'"],
    ['quarantined', "test('the named test', { quarantine: true }"],
  ])('fails when mandatory evidence is %s', async (_reason, source) => {
    const firstReference = CERTIFICATION_SCENARIOS[0].evidence[0]
    const firstTestName = firstReference.testNames[0]

    await expect(
      verifyCertificationEvidence(async (path) =>
        path === firstReference.path
          ? source.replace('the named test', firstTestName)
          : (CERTIFICATION_SCENARIOS.flatMap(({ evidence }) => evidence)
              .find((reference) => reference.path === path)
              ?.testNames.map((name) => `test('${name}', () => {})`)
              .join('\n') ?? ''),
      ),
    ).rejects.toThrow(
      /Certification (test is missing|evidence is not runnable)/,
    )
  })

  test('finds every mandatory scenario at its production test seam', async () => {
    await expect(
      verifyCertificationEvidence((path) => readFile(path, 'utf8')),
    ).resolves.toBeUndefined()
  })

  test('renders sanitized evidence bound to code and runtime configuration', () => {
    const report = buildCertificationReport(validInput())

    expect(report).toContain(certifiedCommit)
    expect(report).toContain('Evidence date | 2026-08-18')
    expect(report).toContain('Environment | Zepto sandbox')
    expect(report).toContain('API version | `20260101`')
    expect(report).toContain('Configuration fingerprint | `configuration-v1`')
    expect(report).toContain(`Credential fingerprint | \`${'c'.repeat(43)}\``)
    expect(report).toMatch(/Certification fingerprint \| `[A-Za-z0-9_-]{43}`/)
    expect(report).toContain('Production activation remains denied')
    expect(report).not.toContain('sensitive-routing-details')
    expect(report).not.toContain('sensitive-provider-payload')
    expect(report).not.toContain('sensitive-credential')
  })

  test('invalidates evidence when any bound input or release gate is invalid', () => {
    const valid = validInput()

    expect(() =>
      buildCertificationReport({ ...valid, certifiedCommit: 'main' }),
    ).toThrow('40-character Git commit')
    expect(() =>
      buildCertificationReport({ ...valid, worktreeClean: false }),
    ).toThrow('clean worktree')
    expect(() =>
      buildCertificationReport({ ...valid, apiVersion: '20250101' }),
    ).toThrow('API version')
    expect(() =>
      buildCertificationReport({
        ...valid,
        configurationFingerprint: 'secret=do-not-record-this',
      }),
    ).toThrow('configuration fingerprint')
    expect(() =>
      buildCertificationReport({
        ...valid,
        results: valid.results.map((result, index) =>
          index === 3 ? { ...result, exitCode: 1 } : result,
        ),
      }),
    ).toThrow('Certification command failed')
  })

  test('changes the certification identity for every material binding', () => {
    const valid = validInput()
    const original = certificationFingerprint(valid)

    expect(
      certificationFingerprint({
        ...valid,
        certifiedCommit: 'b'.repeat(40),
      }),
    ).not.toBe(original)
    expect(
      certificationFingerprint({ ...valid, environment: 'production' }),
    ).not.toBe(original)
    expect(
      certificationFingerprint({
        ...valid,
        configurationFingerprint: 'configuration-v2',
      }),
    ).not.toBe(original)
    expect(
      certificationFingerprint({
        ...valid,
        credentialFingerprint: 'd'.repeat(43),
      }),
    ).not.toBe(original)
  })
})
