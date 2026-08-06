/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const identity: UserIdentity = {
  tokenIdentifier: 'https://clerk.example.test|user_123',
  subject: 'user_123',
  issuer: 'https://clerk.example.test',
  email: 'first@example.com',
  name: 'First User',
  pictureUrl: 'https://example.com/first.png',
}

describe('users.add', () => {
  test('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)

    await expect(t.mutation(api.users.add, {})).rejects.toThrow(
      'You must be signed in to call this function.',
    )
  })

  test('creates the authenticated user and returns its ID', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.withIdentity(identity).mutation(api.users.add, {})

    const user = await t.run(async (ctx) => ctx.db.get('users', userId))

    expect(user).toMatchObject({
      tokenIdentifier: identity.tokenIdentifier,
      clerkUserId: identity.subject,
      email: identity.email,
      name: identity.name,
      imageUrl: identity.pictureUrl,
    })
  })

  test('returns the existing ID without updating profile fields', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.withIdentity(identity).mutation(api.users.add, {})
    const repeatedUserId = await t
      .withIdentity({
        ...identity,
        email: 'changed@example.com',
        name: 'Changed User',
        pictureUrl: 'https://example.com/changed.png',
      })
      .mutation(api.users.add, {})

    const user = await t.run(async (ctx) => ctx.db.get('users', userId))

    expect(repeatedUserId).toBe(userId)
    expect(user).toMatchObject({
      email: identity.email,
      name: identity.name,
      imageUrl: identity.pictureUrl,
    })
  })

  test('concurrent calls converge on one user record', async () => {
    const t = convexTest(schema, modules)
    const authenticated = t.withIdentity(identity)
    const [firstUserId, secondUserId] = await Promise.all([
      authenticated.mutation(api.users.add, {}),
      authenticated.mutation(api.users.add, {}),
    ])

    const users = await t.run(async (ctx) => ctx.db.query('users').collect())

    expect(secondUserId).toBe(firstUserId)
    expect(users).toHaveLength(1)
  })
})
