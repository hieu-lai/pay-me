import { describe, expect, test } from 'vitest'

import {
  payIdCapabilityStatus,
  pseudonymousPayIdRequesterId,
} from './payIdCapability'

const certified = {
  enabled: true,
  trustedIpv4: true,
  payToAliasesScope: true,
  liveAliasResolution: true,
  privacyAssertions: true,
  aliasKinds: [
    'alias_phone',
    'alias_email',
    'alias_abn',
    'alias_organisation_identifier',
  ],
  fraudLimits: { account: 100, remoteIp: 20, requester: 20 },
  certificationCommit: 'a'.repeat(40),
}
const releaseCommit = certified.certificationCommit

describe('PayID Money Request capability', () => {
  test('is disabled by default', () => {
    expect(payIdCapabilityStatus(undefined, releaseCommit)).toEqual({
      kind: 'disabled',
    })
  })

  test.each([
    ['trusted IPv4', { trustedIpv4: false }],
    ['pay_to_aliases scope', { payToAliasesScope: false }],
    ['live alias resolution', { liveAliasResolution: false }],
    ['privacy assertions', { privacyAssertions: false }],
    ['all alias kinds', { aliasKinds: ['alias_email'] }],
    [
      'fraud limits',
      { fraudLimits: { account: 0, remoteIp: 20, requester: 20 } },
    ],
    ['commit evidence', { certificationCommit: 'main' }],
  ])('blocks incomplete %s certification', (_name, override) => {
    expect(
      payIdCapabilityStatus(
        JSON.stringify({ ...certified, ...override }),
        releaseCommit,
      ),
    ).toEqual({ kind: 'misconfigured' })
  })

  test('enables only a complete independent certification', () => {
    expect(
      payIdCapabilityStatus(JSON.stringify(certified), releaseCommit),
    ).toEqual({
      kind: 'enabled',
    })
  })

  test('blocks certification evidence from another release commit', () => {
    expect(
      payIdCapabilityStatus(JSON.stringify(certified), 'b'.repeat(40)),
    ).toEqual({ kind: 'misconfigured' })
  })

  test('creates a stable PayMe-owned pseudonym without exposing identity', async () => {
    const first = await pseudonymousPayIdRequesterId(
      'https://clerk.example|user_123',
      'payid-pseudonym-secret-at-least-32-bytes',
    )
    const again = await pseudonymousPayIdRequesterId(
      'https://clerk.example|user_123',
      'payid-pseudonym-secret-at-least-32-bytes',
    )
    const other = await pseudonymousPayIdRequesterId(
      'https://clerk.example|user_456',
      'payid-pseudonym-secret-at-least-32-bytes',
    )

    expect(first).toBe(again)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^payme_[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain('user_123')
  })
})
