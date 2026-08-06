import { ConvexError } from 'convex/values'

import type { QueryCtx } from '../_generated/server'

type UserReaderCtx = Pick<QueryCtx, 'auth' | 'db'>
type UserIdentityCtx = Pick<QueryCtx, 'auth'>

export async function requireIdentity(ctx: UserIdentityCtx) {
  const identity = await ctx.auth.getUserIdentity()

  if (!identity) {
    throw new ConvexError({
      code: 'UNAUTHENTICATED',
      message: 'You must be signed in to call this function.',
    })
  }

  return identity
}

/**
 * Return the database user for the current authenticated identity.
 *
 * Authentication and the user lookup stay server-side so callers cannot
 * impersonate another user by supplying an ID in function arguments.
 */
export async function requireUser(ctx: UserReaderCtx) {
  const identity = await requireIdentity(ctx)

  const user = await ctx.db
    .query('users')
    .withIndex('by_tokenIdentifier', (q) =>
      q.eq('tokenIdentifier', identity.tokenIdentifier),
    )
    .unique()

  if (!user) {
    throw new ConvexError({
      code: 'USER_NOT_FOUND',
      message: 'No user record exists for the signed-in identity.',
    })
  }

  return user
}
