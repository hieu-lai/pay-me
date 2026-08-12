import { describe, expect, test } from 'vitest'

import { aliasResolutionParamsSchema } from './alias-resolution'

describe('alias resolution params', () => {
  test.each([
    ['alias_phone', '+61-411222333'],
    ['alias_email', 'person@example.com'],
    ['alias_abn', '123456789'],
    ['alias_abn', '12345678901'],
    ['alias_organisation_identifier', 'Zepto Pty Ltd, Byron Bay NSW'],
  ] as const)('accepts a valid %s value', (type, value) => {
    expect(aliasResolutionParamsSchema.safeParse({ type, value }).success).toBe(
      true,
    )
  })

  test.each([
    ['alias_phone', '0411222333'],
    ['alias_email', 'Person@example.com'],
    ['alias_abn', '12 345 678 901'],
    ['alias_organisation_identifier', ' trailing-space '],
  ] as const)('rejects an invalid %s value', (type, value) => {
    expect(aliasResolutionParamsSchema.safeParse({ type, value }).success).toBe(
      false,
    )
  })

  test('rejects unsupported aliases and extra parameters', () => {
    expect(
      aliasResolutionParamsSchema.safeParse({ type: 'bban', value: '123' })
        .success,
    ).toBe(false)
    expect(
      aliasResolutionParamsSchema.safeParse({
        type: 'alias_phone',
        value: '+61-411222333',
        requester: { id: 'spoofed' },
      }).success,
    ).toBe(false)
  })
})
