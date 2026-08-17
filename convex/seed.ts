import { ConvexError, v } from 'convex/values'

import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalAction, internalMutation } from './_generated/server'
import { protectPaymentDestination } from './lib/paymentDestinationCrypto'
import { userSearchText } from './lib/userSearch'

const mockUsers = [
  {
    clerkUserId: 'mock_user_001',
    email: 'alex.morgan@example.test',
    displayName: 'Alex Morgan',
    username: 'alexm',
  },
  {
    clerkUserId: 'mock_user_002',
    email: 'jamie.chen@example.test',
    displayName: 'Jamie Chen',
    username: 'jamiec',
  },
  {
    clerkUserId: 'mock_user_003',
    email: 'priya.shah@example.test',
    displayName: 'Priya Shah',
    username: 'priyas',
  },
  {
    clerkUserId: 'mock_user_004',
    email: 'mateo.silva@example.test',
    displayName: 'Mateo Silva',
    username: 'mateos',
  },
  {
    clerkUserId: 'mock_user_005',
    email: 'taylor.brooks@example.test',
    displayName: 'Taylor Brooks',
    username: 'taylorb',
  },
  {
    clerkUserId: 'mock_user_006',
    email: 'aisha.khan@example.test',
    displayName: 'Aisha Khan',
    username: 'aishak',
  },
  {
    clerkUserId: 'mock_user_007',
    email: 'noah.williams@example.test',
    displayName: 'Noah Williams',
    username: 'noahw',
  },
  {
    clerkUserId: 'mock_user_008',
    email: 'sofia.rossi@example.test',
    displayName: 'Sofia Rossi',
    username: 'sofiar',
  },
  {
    clerkUserId: 'mock_user_009',
    email: 'liam.nguyen@example.test',
    displayName: 'Liam Nguyen',
    username: 'liamn',
  },
  {
    clerkUserId: 'mock_user_010',
    email: 'maya.patel@example.test',
    displayName: 'Maya Patel',
    username: 'mayap',
  },
] as const

const manualPaymentTestDailyCountCap = 1
const manualPaymentTestDailyValueCapCents = 10_000

/** Enable one sandbox PayTo Payment of up to $100 per UTC day for manual testing. */
export const payToPaymentRuntimeGate = internalMutation({
  args: {},
  returns: v.object({
    inserted: v.boolean(),
    activatedAt: v.number(),
    dailyPaymentCountCap: v.number(),
    dailyPaymentValueCapCents: v.number(),
  }),
  handler: async (ctx) => {
    const activatedAt = Date.now()
    const gate = await ctx.db
      .query('payToPaymentRuntimeGates')
      .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
      .unique()
    const configuration = {
      mode: 'enabled_for_new_confirmations' as const,
      activatedAt,
      dailyPaymentCountCap: manualPaymentTestDailyCountCap,
      dailyPaymentValueCapCents: manualPaymentTestDailyValueCapCents,
    }

    if (gate) {
      await ctx.db.patch('payToPaymentRuntimeGates', gate._id, configuration)
    } else {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        ...configuration,
      })
    }

    return {
      inserted: gate === null,
      activatedAt,
      dailyPaymentCountCap: manualPaymentTestDailyCountCap,
      dailyPaymentValueCapCents: manualPaymentTestDailyValueCapCents,
    }
  },
})

/** Add or refresh the ten fictional users used for local development. */
export const users = internalMutation({
  args: {},
  returns: v.object({
    inserted: v.number(),
    existing: v.number(),
    total: v.number(),
  }),
  handler: async (ctx) => {
    let inserted = 0
    let existing = 0

    for (const mockUser of mockUsers) {
      const user = {
        ...mockUser,
        tokenIdentifier: `https://mock.pay-me.test|${mockUser.clerkUserId}`,
        searchText: userSearchText(mockUser),
      }
      const storedUser = await ctx.db
        .query('users')
        .withIndex('by_clerkUserId', (q) =>
          q.eq('clerkUserId', mockUser.clerkUserId),
        )
        .unique()

      if (storedUser) {
        await ctx.db.patch('users', storedUser._id, user)
        existing += 1
      } else {
        await ctx.db.insert('users', user)
        inserted += 1
      }
    }

    return { inserted, existing, total: mockUsers.length }
  },
})

function mockAccountNumber(ownerUserId: Id<'users'>): string {
  let hash = 2_166_136_261
  for (const character of ownerUserId) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619) >>> 0
  }
  return String(10_000_000 + (hash % 90_000_000))
}

/** Add one encrypted, default mock bank account to each requested user. */
export const paymentDestinations = internalAction({
  args: { ownerUserIds: v.array(v.id('users')) },
  returns: v.object({
    inserted: v.number(),
    existing: v.number(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    let inserted = 0
    let existing = 0

    for (const ownerUserId of new Set(args.ownerUserIds)) {
      const protectedDestination = await protectPaymentDestination({
        type: 'bban',
        value: `123456-${mockAccountNumber(ownerUserId)}`,
      })

      try {
        await ctx.runMutation(internal.paymentDestinations.insertProtected, {
          ownerUserId,
          protectedDestination,
          label: 'Mock account',
          setAsDefault: true,
        })
        inserted += 1
      } catch (error) {
        if (
          error instanceof ConvexError &&
          typeof error.data === 'object' &&
          error.data !== null &&
          'code' in error.data &&
          error.data.code === 'PAYMENT_DESTINATION_ALREADY_EXISTS'
        ) {
          existing += 1
          continue
        }
        throw error
      }
    }

    return { inserted, existing, total: inserted + existing }
  },
})
