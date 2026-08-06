import { NoOp } from 'convex-helpers/server/customFunctions'
import { zCustomMutation, zCustomQuery, zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

import { internalMutation, internalQuery } from './_generated/server'
import { requireUser } from './lib/requireUser'
import { userQuery } from './lib/userFunctions'
import { userValidator } from './validators/users'

const zodInternalQuery = zCustomQuery(internalQuery, NoOp)
const zodInternalMutation = zCustomMutation(internalMutation, NoOp)

/** Return the current authenticated user's public profile fields. */
export const me = userQuery({
  args: {},
  returns: z.object({
    name: z.string(),
    imageUrl: z.string().optional(),
  }),
  handler: async (ctx) => ({
    name: ctx.user.name,
    ...(ctx.user.imageUrl === undefined ? {} : { imageUrl: ctx.user.imageUrl }),
  }),
})

/** Create a Clerk user once and return their Convex ID. */
export const addUser = zodInternalMutation({
  args: {
    tokenIdentifier: z.string(),
    clerkUserId: z.string(),
    email: z.string(),
    name: z.string(),
    imageUrl: z.string().optional(),
  },
  returns: zid('users'),
  handler: async (ctx, args) => {
    const existingUser = await ctx.db
      .query('users')
      .withIndex('by_clerkUserId', (q) => q.eq('clerkUserId', args.clerkUserId))
      .unique()

    if (existingUser) {
      return existingUser._id
    }

    return await ctx.db.insert('users', {
      tokenIdentifier: args.tokenIdentifier,
      clerkUserId: args.clerkUserId,
      email: args.email,
      name: args.name,
      ...(args.imageUrl === undefined ? {} : { imageUrl: args.imageUrl }),
    })
  },
})

/** Used by actions, which cannot read the database directly. */
export const getCurrent = zodInternalQuery({
  args: {},
  returns: userValidator,
  handler: async (ctx) => requireUser(ctx),
})
