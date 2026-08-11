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
    name: 'Alex Morgan',
    username: 'alexm',
  },
  {
    clerkUserId: 'mock_user_002',
    email: 'jamie.chen@example.test',
    name: 'Jamie Chen',
    username: 'jamiec',
  },
  {
    clerkUserId: 'mock_user_003',
    email: 'priya.shah@example.test',
    name: 'Priya Shah',
    username: 'priyas',
  },
  {
    clerkUserId: 'mock_user_004',
    email: 'mateo.silva@example.test',
    name: 'Mateo Silva',
    username: 'mateos',
  },
  {
    clerkUserId: 'mock_user_005',
    email: 'taylor.brooks@example.test',
    name: 'Taylor Brooks',
    username: 'taylorb',
  },
  {
    clerkUserId: 'mock_user_006',
    email: 'aisha.khan@example.test',
    name: 'Aisha Khan',
    username: 'aishak',
  },
  {
    clerkUserId: 'mock_user_007',
    email: 'noah.williams@example.test',
    name: 'Noah Williams',
    username: 'noahw',
  },
  {
    clerkUserId: 'mock_user_008',
    email: 'sofia.rossi@example.test',
    name: 'Sofia Rossi',
    username: 'sofiar',
  },
  {
    clerkUserId: 'mock_user_009',
    email: 'liam.nguyen@example.test',
    name: 'Liam Nguyen',
    username: 'liamn',
  },
  {
    clerkUserId: 'mock_user_010',
    email: 'maya.patel@example.test',
    name: 'Maya Patel',
    username: 'mayap',
  },
] as const

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
