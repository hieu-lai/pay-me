/// <reference types="vite/client" />

import { convexTest } from 'convex-test'
import { beforeEach, expect, test } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const encryptionKey = btoa('0123456789abcdef0123456789abcdef')
const fingerprintKey = btoa('fingerprint-key-32-bytes-long!!xx')

beforeEach(() => {
  process.env.PAYMENT_DESTINATION_ENCRYPTION_KEYS = JSON.stringify({
    v1: encryptionKey,
  })
  process.env.PAYMENT_DESTINATION_CURRENT_ENCRYPTION_KEY_VERSION = 'v1'
  process.env.PAYMENT_DESTINATION_FINGERPRINT_KEY = fingerprintKey
})

test('seeds one capped sandbox PayTo Payment runtime gate and is safe to rerun', async () => {
  const t = convexTest(schema, modules)

  await expect(
    t.mutation(internal.seed.payToPaymentRuntimeGate, {}),
  ).resolves.toMatchObject({
    inserted: true,
    activatedAt: expect.any(Number),
    dailyPaymentCountCap: 1,
    dailyPaymentValueCapCents: 10_000,
  })
  const gate = await t.run(async (ctx) =>
    ctx.db
      .query('payToPaymentRuntimeGates')
      .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
      .unique(),
  )
  if (!gate) throw new Error('Expected sandbox PayTo Payment runtime gate')
  await t.run((ctx) =>
    ctx.db.patch('payToPaymentRuntimeGates', gate._id, {
      budgetDate: '2026-08-13',
      reservedPaymentCount: 1,
      reservedPaymentValueCents: 5_000,
    }),
  )

  await expect(
    t.mutation(internal.seed.payToPaymentRuntimeGate, {}),
  ).resolves.toMatchObject({
    inserted: false,
    activatedAt: expect.any(Number),
    dailyPaymentCountCap: 1,
    dailyPaymentValueCapCents: 10_000,
  })

  const gates = await t.run(async (ctx) =>
    ctx.db.query('payToPaymentRuntimeGates').take(2),
  )
  expect(gates).toHaveLength(1)
  expect(gates[0]).toMatchObject({
    environment: 'sandbox',
    mode: 'enabled_for_new_confirmations',
    activatedAt: expect.any(Number),
    dailyPaymentCountCap: 1,
    dailyPaymentValueCapCents: 10_000,
    budgetDate: '2026-08-13',
    reservedPaymentCount: 1,
    reservedPaymentValueCents: 5_000,
  })
})

test('seeds exactly ten users and is safe to rerun', async () => {
  const t = convexTest(schema, modules)

  await expect(t.mutation(internal.seed.users, {})).resolves.toEqual({
    inserted: 10,
    existing: 0,
    total: 10,
  })
  await expect(t.mutation(internal.seed.users, {})).resolves.toEqual({
    inserted: 0,
    existing: 10,
    total: 10,
  })

  const users = await t.run(async (ctx) => ctx.db.query('users').collect())

  expect(users).toHaveLength(10)
  expect(users.map((user) => user.clerkUserId)).toEqual([
    'mock_user_001',
    'mock_user_002',
    'mock_user_003',
    'mock_user_004',
    'mock_user_005',
    'mock_user_006',
    'mock_user_007',
    'mock_user_008',
    'mock_user_009',
    'mock_user_010',
  ])
})

test('seeds one encrypted default payment destination per requested user', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(internal.seed.users, {})
  const users = await t.run(async (ctx) => ctx.db.query('users').take(6))
  const ownerUserIds = users.map((user) => user._id)

  await expect(
    t.action(internal.seed.paymentDestinations, { ownerUserIds }),
  ).resolves.toEqual({ inserted: 6, existing: 0, total: 6 })
  await expect(
    t.action(internal.seed.paymentDestinations, { ownerUserIds }),
  ).resolves.toEqual({ inserted: 0, existing: 6, total: 6 })

  const destinations = await t.run(async (ctx) =>
    ctx.db.query('paymentDestinations').take(7),
  )
  expect(destinations).toHaveLength(6)
  expect(destinations).toEqual(
    expect.arrayContaining(
      ownerUserIds.map((ownerUserId) =>
        expect.objectContaining({
          ownerUserId,
          label: 'Mock account',
          type: 'bban',
          keyVersion: 'v1',
        }),
      ),
    ),
  )
  for (const user of users) {
    const storedUser = await t.run(async (ctx) => ctx.db.get('users', user._id))
    expect(storedUser?.defaultPaymentDestinationId).toBeDefined()
    expect(
      destinations.some(
        (destination) =>
          destination._id === storedUser?.defaultPaymentDestinationId &&
          destination.ownerUserId === user._id,
      ),
    ).toBe(true)
  }
})
