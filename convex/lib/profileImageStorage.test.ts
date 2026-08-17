import { describe, expect, test } from 'vitest'

import {
  profileImageUrl,
  validateProfileImageCdnOrigin,
  validateProfileImageObjectKey,
  validateProfileImageStorageConfiguration,
} from './profileImageStorage'

const configuration = {
  bucket: 'pay-me-preview',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
  cdnOrigin: 'https://images.example.com',
  deliveryMode: 'public_custom_domain' as const,
}

describe('Profile Image storage configuration', () => {
  test('accepts a canonical public custom-domain configuration', () => {
    expect(validateProfileImageStorageConfiguration(configuration)).toEqual(
      configuration,
    )
  })

  test.each([
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com/#fragment',
  ])('rejects a CDN value that is not an origin: %s', (origin) => {
    expect(() => validateProfileImageCdnOrigin(origin, 'development')).toThrow()
  })

  test.each([
    'http://images.example.com',
    'https://bucket.r2.dev',
    'https://bucket.r2.dev.',
  ])('rejects an unsafe public custom-domain origin: %s', (origin) => {
    expect(() =>
      validateProfileImageCdnOrigin(origin, 'public_custom_domain'),
    ).toThrow()
  })

  test('allows an r2.dev origin only in development', () => {
    expect(
      validateProfileImageCdnOrigin('https://bucket.r2.dev', 'development'),
    ).toBe('https://bucket.r2.dev')
  })
})

describe('Profile Image presentation', () => {
  test.each([
    'profile-images/assets/',
    'profile-images/assets/.',
    'profile-images/assets/..',
    'profile-images/assets/a%20b',
    'profile-images/assets/a?b',
    'profile-images/assets/a\\b',
    'profile-images/assets/café',
    'profile-images/staging/asset',
  ])('rejects a non-canonical asset key: %s', (key) => {
    expect(() => validateProfileImageObjectKey(key, 'asset')).toThrow()
  })

  test('returns legacy URLs unchanged and omits an absent source', () => {
    expect(
      profileImageUrl({
        kind: 'legacyExternal',
        url: ' https://clerk.example/avatar ',
      }),
    ).toBe(' https://clerk.example/avatar ')
    expect(profileImageUrl(undefined)).toBeUndefined()
  })

  test('constructs an owned image URL without exposing configuration fields', () => {
    expect(
      profileImageUrl(
        {
          kind: 'ownedR2',
          objectKey: 'profile-images/assets/abc_123-def',
        },
        { origin: configuration.cdnOrigin, mode: configuration.deliveryMode },
      ),
    ).toBe('https://images.example.com/profile-images/assets/abc_123-def')
  })
})
