import { NoOp } from 'convex-helpers/server/customFunctions'
import { zCustomMutation, zCustomQuery, zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

import { internalMutation, internalQuery } from './_generated/server'
import { requireUser } from './lib/requireUser'
import { userQuery } from './lib/userFunctions'
import { userSearchText } from './lib/userSearch'
import { normalizeDisplayName, presentUser } from './lib/userProfile'
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
  handler: async (ctx) => {
    const presentation = presentUser(ctx.user)
    return {
      name: presentation.name,
      ...(presentation.imageUrl === undefined
        ? {}
        : { imageUrl: presentation.imageUrl }),
    }
  },
})

/** Find public profiles by name or PayMe Username. */
export const search = userQuery({
  args: {
    query: z.string().trim().min(1),
  },
  returns: z.array(
    z.object({
      id: zid('users'),
      name: z.string(),
      hasPaymentDestination: z.boolean(),
      username: z.string().optional(),
      imageUrl: z.string().optional(),
    }),
  ),
  handler: async (ctx, args) => {
    const users = await ctx.db
      .query('users')
      .withSearchIndex('search_by_searchText', (q) =>
        q.search('searchText', args.query),
      )
      .take(11)

    return users
      .filter((user) => user._id !== ctx.user._id)
      .slice(0, 10)
      .map((user) => {
        const presentation = presentUser(user)
        return {
          id: presentation.id,
          name: presentation.name,
          hasPaymentDestination: user.defaultPaymentDestinationId !== undefined,
          ...(user.username === undefined ? {} : { username: user.username }),
          ...(presentation.imageUrl === undefined
            ? {}
            : { imageUrl: presentation.imageUrl }),
        }
      })
  },
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

    const displayName = normalizeDisplayName(args.name)
    return await ctx.db.insert('users', {
      tokenIdentifier: args.tokenIdentifier,
      clerkUserId: args.clerkUserId,
      email: args.email,
      displayName,
      searchText: userSearchText({ displayName }),
      ...(args.imageUrl === undefined
        ? {}
        : {
            profileImageSource: {
              kind: 'legacyExternal' as const,
              url: args.imageUrl,
            },
          }),
    })
  },
})

/** Used by actions, which cannot read the database directly. */
export const getCurrent = zodInternalQuery({
  args: {},
  returns: userValidator,
  handler: async (ctx) => requireUser(ctx),
})
