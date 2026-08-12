import { describe, expect, test } from 'vitest'

import {
  CERTIFICATION_COMMANDS,
  CERTIFICATION_SCENARIOS,
  buildCertificationReport,
} from './bank-account-money-request'

const certifiedCommit = 'a'.repeat(40)

describe('Bank Account Money Request automated certification', () => {
  test('requires every release quality gate and mandatory deterministic scenario', () => {
    expect(CERTIFICATION_COMMANDS.map(({ id }) => id)).toEqual([
      'formatting',
      'linting',
      'type-checking',
      'complete-test-suite',
      'production-build',
    ])

    const covered = new Set(
      CERTIFICATION_SCENARIOS.flatMap(({ requirements }) => requirements),
    )
    expect(covered).toEqual(
      new Set([
        'valid-and-adversarial-ingress',
        'atomic-allocation',
        'idempotency',
        'mixed-group-outcomes',
        'ambiguous-creation',
        'retry-budgets',
        'leases',
        'role-authorization',
        'information-flow',
        'webhook-authenticity-and-deduplication',
        'reconciliation',
        'targeted-recovery',
        'network-ambiguity',
        'action-crashes',
        'duplicate-delivery',
        'forged-webhooks',
        'unknown-provider-states',
        'provider-rejection',
        'missed-webhook-repair',
        'bounded-rate-limiting',
        'authentication',
        'csrf',
        'attestation',
        'trusted-ip-handling',
        'sibling-authorization',
        'destination-races',
        'redaction',
        'internal-only-operations',
        'production-denial',
      ]),
    )
  })

  test('renders only successful, clean, sandbox certification evidence', () => {
    const report = buildCertificationReport({
      certifiedCommit,
      evidenceDate: '2026-08-12',
      worktreeClean: true,
      results: CERTIFICATION_COMMANDS.map(({ id, displayCommand }) => ({
        id,
        displayCommand,
        exitCode: 0,
      })),
    })

    expect(report).toContain(certifiedCommit)
    expect(report).toContain(
      'Environment | Zepto sandbox (simulated HTTP boundary)',
    )
    expect(report).toContain('API version | `20260101`')
    expect(report).toContain('Known automated-coverage gaps')
    expect(report).toContain('Production activation remains denied')
    expect(report).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
    expect(report).not.toMatch(/\b\d{6}-\d{5,10}\b/)
    expect(report).not.toMatch(
      /(?:bearer|token|secret|signature)\s*[:=]\s*\S+/i,
    )
  })

  test('refuses failed commands, dirty commits, and malformed commit identities', () => {
    const valid = {
      certifiedCommit,
      evidenceDate: '2026-08-12',
      worktreeClean: true,
      results: CERTIFICATION_COMMANDS.map(({ id, displayCommand }) => ({
        id,
        displayCommand,
        exitCode: 0,
      })),
    }

    expect(() =>
      buildCertificationReport({
        ...valid,
        results: valid.results.map((result, index) =>
          index === 2 ? { ...result, exitCode: 1 } : result,
        ),
      }),
    ).toThrow('Certification command failed')
    expect(() =>
      buildCertificationReport({ ...valid, worktreeClean: false }),
    ).toThrow('clean worktree')
    expect(() =>
      buildCertificationReport({ ...valid, certifiedCommit: 'main' }),
    ).toThrow('40-character Git commit')
  })
})
