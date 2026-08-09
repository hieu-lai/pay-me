import { v } from 'convex/values'

import { internalMutation } from './_generated/server'
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
