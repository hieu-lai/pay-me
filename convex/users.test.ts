/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const identity = {
  tokenIdentifier: 'https://clerk.example.test|user_123',
  subject: 'user_123',
  issuer: 'https://clerk.example.test',
  email: 'first@example.com',
  name: 'First User',
  pictureUrl: 'https://example.com/first.png',
} satisfies UserIdentity

const addUserArgs = {
  tokenIdentifier: identity.tokenIdentifier,
  clerkUserId: identity.subject,
  email: identity.email,
  name: identity.name,
  imageUrl: identity.pictureUrl,
}

describe('users.addUser', () => {
  test('normalizes the Clerk Display Name and omits an empty image', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(internal.users.addUser, {
      ...addUserArgs,
      name: '  A\u030Ada\u00a0  Lovelace  ',
      imageUrl: undefined,
    })

    await expect(
      t.run(async (ctx) => ctx.db.get('users', userId)),
    ).resolves.toMatchObject({
      displayName: 'Åda Lovelace',
      searchText: 'Åda Lovelace',
    })
  })

  test('creates a Clerk user and returns its ID', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(internal.users.addUser, addUserArgs)

    const user = await t.run(async (ctx) => ctx.db.get('users', userId))

    expect(user).toMatchObject({
      tokenIdentifier: addUserArgs.tokenIdentifier,
      clerkUserId: addUserArgs.clerkUserId,
      email: addUserArgs.email,
      displayName: 'First User',
      searchText: 'First User',
      profileImageSource: {
        kind: 'legacyExternal',
        url: addUserArgs.imageUrl,
      },
    })
    expect(user).not.toHaveProperty('name')
    expect(user).not.toHaveProperty('imageUrl')
  })

  test('returns the existing ID without updating profile fields', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(internal.users.addUser, addUserArgs)
    const repeatedUserId = await t.mutation(internal.users.addUser, {
      ...addUserArgs,
      tokenIdentifier: 'https://clerk.example.test|changed_token',
      email: 'changed@example.com',
      name: 'Changed User',
      imageUrl: 'https://example.com/changed.png',
    })

    const user = await t.run(async (ctx) => ctx.db.get('users', userId))

    expect(repeatedUserId).toBe(userId)
    expect(user).toMatchObject({
      tokenIdentifier: addUserArgs.tokenIdentifier,
      clerkUserId: addUserArgs.clerkUserId,
      email: addUserArgs.email,
      displayName: addUserArgs.name,
      searchText: addUserArgs.name,
      profileImageSource: {
        kind: 'legacyExternal',
        url: addUserArgs.imageUrl,
      },
    })
  })

  test('concurrent calls converge on one user record', async () => {
    const t = convexTest(schema, modules)
    const [firstUserId, secondUserId] = await Promise.all([
      t.mutation(internal.users.addUser, addUserArgs),
      t.mutation(internal.users.addUser, addUserArgs),
    ])

    const users = await t.run(async (ctx) => ctx.db.query('users').collect())

    expect(secondUserId).toBe(firstUserId)
    expect(users).toHaveLength(1)
  })
})

describe('users.me', () => {
  test('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)

    await expect(t.query(api.users.me, {})).rejects.toThrow(
      'You must be signed in to call this function.',
    )
  })

  test('returns the authenticated user name and image URL', async () => {
    const t = convexTest(schema, modules)
    const authenticated = t.withIdentity(identity)
    await t.mutation(internal.users.addUser, addUserArgs)

    await expect(authenticated.query(api.users.me, {})).resolves.toEqual({
      name: identity.name,
      imageUrl: identity.pictureUrl,
    })
  })

  test('resolves an owned image through the configured CDN without leaking its key', async () => {
    process.env.R2_BUCKET = 'test-bucket'
    process.env.R2_ENDPOINT = 'https://account.r2.cloudflarestorage.com'
    process.env.R2_ACCESS_KEY_ID = 'test-access-key'
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key'
    process.env.PROFILE_IMAGE_CDN_ORIGIN = 'https://images.example.com'
    process.env.PROFILE_IMAGE_DELIVERY_MODE = 'public_custom_domain'
    const t = convexTest(schema, modules)
    const authenticated = t.withIdentity(identity)
    const userId = await t.mutation(internal.users.addUser, addUserArgs)
    await t.run(async (ctx) =>
      ctx.db.patch('users', userId, {
        profileImageSource: {
          kind: 'ownedR2',
          objectKey: 'profile-images/assets/owned_123',
        },
      }),
    )

    const result = await authenticated.query(api.users.me, {})

    expect(result).toEqual({
      name: identity.name,
      imageUrl: 'https://images.example.com/profile-images/assets/owned_123',
    })
    expect(JSON.stringify(result)).not.toContain('objectKey')
  })
})

describe('users.search', () => {
  test('returns another user whose name matches the search term', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.users.addUser, addUserArgs)
    const recipientId = await t.mutation(internal.users.addUser, {
      tokenIdentifier: 'https://clerk.example.test|user_456',
      clerkUserId: 'user_456',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      imageUrl: 'https://example.com/ada.png',
    })
    const authenticated = t.withIdentity(identity)

    await expect(
      authenticated.query(api.users.search, { query: ' Love ' }),
    ).resolves.toEqual([
      {
        id: recipientId,
        name: 'Ada Lovelace',
        hasPaymentDestination: false,
        imageUrl: 'https://example.com/ada.png',
      },
    ])
  })

  test('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)

    await expect(t.query(api.users.search, { query: 'Ada' })).rejects.toThrow(
      'You must be signed in to call this function.',
    )
  })

  test.each(['', ' '])(
    'rejects the empty search term %j after trimming',
    async (query) => {
      const t = convexTest(schema, modules)
      await t.mutation(internal.users.addUser, addUserArgs)
      const authenticated = t.withIdentity(identity)

      await expect(
        authenticated.query(api.users.search, { query }),
      ).rejects.toThrow()
    },
  )

  test('accepts a one-character search term', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.users.addUser, addUserArgs)
    const recipientId = await t.mutation(internal.users.addUser, {
      tokenIdentifier: 'https://clerk.example.test|user_456',
      clerkUserId: 'user_456',
      email: 'q@example.com',
      name: 'Q',
    })
    const authenticated = t.withIdentity(identity)

    await expect(
      authenticated.query(api.users.search, { query: ' Q ' }),
    ).resolves.toEqual([
      {
        id: recipientId,
        name: 'Q',
        hasPaymentDestination: false,
      },
    ])
  })

  test('matches an optional PayMe Username', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.users.addUser, addUserArgs)
    const recipientId = await t.run(async (ctx) =>
      ctx.db.insert('users', {
        tokenIdentifier: 'https://clerk.example.test|user_789',
        clerkUserId: 'user_789',
        email: 'rear.admiral@example.com',
        displayName: 'Rear Admiral',
        username: 'gracehopper',
        searchText: 'Rear Admiral gracehopper',
      }),
    )
    const authenticated = t.withIdentity(identity)

    await expect(
      authenticated.query(api.users.search, { query: 'graceh' }),
    ).resolves.toEqual([
      {
        id: recipientId,
        name: 'Rear Admiral',
        hasPaymentDestination: false,
        username: 'gracehopper',
      },
    ])
  })

  test('flags a user with a default payment destination', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.users.addUser, addUserArgs)
    const recipientId = await t.mutation(internal.users.addUser, {
      tokenIdentifier: 'https://clerk.example.test|user_456',
      clerkUserId: 'user_456',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    })
    await t.run(async (ctx) => {
      const destinationId = await ctx.db.insert('paymentDestinations', {
        ownerUserId: recipientId,
        type: 'alias_email',
        searchLabel: 'ada@example.com',
        maskedDisplay: 'a**@example.com',
        fingerprint: 'fingerprint',
        ciphertext: 'ciphertext',
        nonce: 'nonce',
        keyVersion: 'v1',
      })
      await ctx.db.patch('users', recipientId, {
        defaultPaymentDestinationId: destinationId,
      })
    })
    const authenticated = t.withIdentity(identity)

    await expect(
      authenticated.query(api.users.search, { query: 'Ada' }),
    ).resolves.toEqual([
      {
        id: recipientId,
        name: 'Ada Lovelace',
        hasPaymentDestination: true,
      },
    ])
  })

  test('does not return the authenticated user', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.users.addUser, addUserArgs)
    const authenticated = t.withIdentity(identity)

    await expect(
      authenticated.query(api.users.search, { query: 'First' }),
    ).resolves.toEqual([])
  })

  test('returns at most ten users', async () => {
    const t = convexTest(schema, modules)
    await t.mutation(internal.users.addUser, addUserArgs)
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        t.mutation(internal.users.addUser, {
          tokenIdentifier: `https://clerk.example.test|recipient_${index}`,
          clerkUserId: `recipient_${index}`,
          email: `recipient-${index}@example.com`,
          name: `Recipient ${index}`,
        }),
      ),
    )
    const authenticated = t.withIdentity(identity)

    const results = await authenticated.query(api.users.search, {
      query: 'Recipient',
    })

    expect(results).toHaveLength(10)
  })
})

describe('Profile Image operational schema', () => {
  test('supports every bounded candidate and cleanup queue index', async () => {
    const t = convexTest(schema, modules)
    const ownerUserId = await t.mutation(internal.users.addUser, addUserArgs)

    await t.run(async (ctx) => {
      await ctx.db.insert('profileImageUploads', {
        ownerUserId,
        state: 'validating',
        stagingObjectKey: 'profile-images/staging/staging_1',
        assetObjectKey: 'profile-images/assets/asset_1',
        declaredSizeBytes: 1_024,
        declaredMediaType: 'image/png',
        detectedSizeBytes: 1_024,
        detectedMediaType: 'image/png',
        detectedWidth: 32,
        detectedHeight: 32,
        validatedSha256: 'digest',
        createdAt: 1_000,
        expiresAt: 2_000,
        validationAttemptCount: 1,
        nextAttemptAt: 1_100,
      })
      await ctx.db.insert('profileImageCleanupObligations', {
        objectKind: 'staging',
        objectKey: 'profile-images/staging/staging_1',
        state: 'retry',
        nextAttemptAt: 1_200,
        attemptCount: 2,
        createdAt: 1_000,
        updatedAt: 1_100,
        lastFailure: 'temporarily_unavailable',
      })

      expect(
        await ctx.db
          .query('profileImageUploads')
          .withIndex('by_ownerUserId_and_state', (q) =>
            q.eq('ownerUserId', ownerUserId).eq('state', 'validating'),
          )
          .collect(),
      ).toHaveLength(1)
      expect(
        await ctx.db
          .query('profileImageUploads')
          .withIndex('by_ownerUserId_and_createdAt', (q) =>
            q.eq('ownerUserId', ownerUserId).gte('createdAt', 0),
          )
          .collect(),
      ).toHaveLength(1)
      expect(
        await ctx.db
          .query('profileImageUploads')
          .withIndex('by_state_and_expiresAt', (q) =>
            q.eq('state', 'validating').lte('expiresAt', 2_000),
          )
          .collect(),
      ).toHaveLength(1)
      expect(
        await ctx.db
          .query('profileImageUploads')
          .withIndex('by_state_and_nextAttemptAt', (q) =>
            q.eq('state', 'validating').lte('nextAttemptAt', 1_100),
          )
          .collect(),
      ).toHaveLength(1)
      expect(
        await ctx.db
          .query('profileImageUploads')
          .withIndex('by_terminalAt')
          .collect(),
      ).toHaveLength(1)
      expect(
        await ctx.db
          .query('profileImageCleanupObligations')
          .withIndex('by_objectKey', (q) =>
            q.eq('objectKey', 'profile-images/staging/staging_1'),
          )
          .collect(),
      ).toHaveLength(1)
      expect(
        await ctx.db
          .query('profileImageCleanupObligations')
          .withIndex('by_state_and_nextAttemptAt', (q) =>
            q.eq('state', 'retry').lte('nextAttemptAt', 1_200),
          )
          .collect(),
      ).toHaveLength(1)
    })
  })
})
