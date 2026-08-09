/// <reference types="vite/client" />

import { convexTest } from 'convex-test'
import { expect, test } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

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
