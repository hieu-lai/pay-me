import { NoOp } from 'convex-helpers/server/customFunctions'
import { zCustomMutation, zCustomQuery, zid } from 'convex-helpers/server/zod4'

import { internalQuery, mutation } from './_generated/server'
import { requireIdentity, requireUser } from './lib/requireUser'
import { userValidator } from './validators/users'

const zodInternalQuery = zCustomQuery(internalQuery, NoOp)
const zodMutation = zCustomMutation(mutation, NoOp)

/** Create the current authenticated user once and return their Convex ID. */
export const add = zodMutation({
  args: {},
  returns: zid('users'),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx)
    const existingUser = await ctx.db
      .query('users')
      .withIndex('by_tokenIdentifier', (q) =>
        q.eq('tokenIdentifier', identity.tokenIdentifier),
      )
      .unique()

    if (existingUser) {
      return existingUser._id
    }

    return await ctx.db.insert('users', {
      tokenIdentifier: identity.tokenIdentifier,
      clerkUserId: identity.subject,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.name === undefined ? {} : { name: identity.name }),
      ...(identity.pictureUrl === undefined
        ? {}
        : { imageUrl: identity.pictureUrl }),
    })
  },
})

/** Used by actions, which cannot read the database directly. */
export const getCurrent = zodInternalQuery({
  args: {},
  returns: userValidator,
  handler: async (ctx) => requireUser(ctx),
})
