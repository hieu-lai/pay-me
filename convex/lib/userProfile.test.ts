import { describe, expect, test } from 'vitest'

import { normalizeDisplayName } from './userProfile'

describe('normalizeDisplayName', () => {
  test('normalizes Unicode and whitespace for Clerk provisioning', () => {
    expect(normalizeDisplayName('  A\u030Ada\u00a0  Lovelace  ')).toBe(
      'Åda Lovelace',
    )
  })

  test.each([
    '',
    '   ',
    'Ada\nLovelace',
    'Ada\u2028Lovelace',
    'Ada\u0000Lovelace',
  ])('rejects an unusable Display Name: %j', (value) =>
    expect(() => normalizeDisplayName(value)).toThrow(),
  )

  test('counts Unicode grapheme clusters rather than code units', () => {
    expect(normalizeDisplayName('👩🏽‍💻'.repeat(80))).toBe('👩🏽‍💻'.repeat(80))
    expect(() => normalizeDisplayName('👩🏽‍💻'.repeat(81))).toThrow()
  })
})
