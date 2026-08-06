import { customCtx } from 'convex-helpers/server/customFunctions'
import {
  zCustomAction,
  zCustomMutation,
  zCustomQuery,
} from 'convex-helpers/server/zod4'

import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { action, mutation, query } from '../_generated/server'
import { requireUser } from './requireUser'

/**
 * Public query builder that validates Zod args/returns and exposes ctx.user.
 */
export const userQuery = zCustomQuery(
  query,
  customCtx(async (ctx) => ({ user: await requireUser(ctx) })),
)

/**
 * Public mutation builder that validates Zod args/returns and exposes ctx.user.
 */
export const userMutation = zCustomMutation(
  mutation,
  customCtx(async (ctx) => ({ user: await requireUser(ctx) })),
)

/**
 * Public action builder that validates Zod args/returns and exposes ctx.user.
 */
export const userAction = zCustomAction(
  action,
  customCtx(async (ctx): Promise<{ user: Doc<'users'> }> => ({
    user: await ctx.runQuery(internal.users.getCurrent, {}),
  })),
)
