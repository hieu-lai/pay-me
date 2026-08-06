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
  test('creates a Clerk user and returns its ID', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(internal.users.addUser, addUserArgs)

    const user = await t.run(async (ctx) => ctx.db.get('users', userId))

    expect(user).toMatchObject({
      ...addUserArgs,
    })
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
      ...addUserArgs,
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
})
