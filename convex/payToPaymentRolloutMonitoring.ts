import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { internalMutation } from './_generated/server'
import { assertStoredPaymentProjection } from './lib/payToPaymentProjection'
import {
  failProductionRolloutClosed,
  recordProductionRolloutCleanObservation,
} from './lib/payToPaymentRollout'
import type { PayToPaymentRolloutSafetyCause } from './validators/payToPayments'

const SCAN_PAGE_SIZE = 100

export const scan = internalMutation({
  args: {
    paginationOpts: paginationOptsValidator,
    observedAt: v.optional(v.number()),
    unsafeFound: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const observedAt = args.observedAt ?? Date.now()
    const result = await ctx.db
      .query('payToPayments')
      .withIndex('by_environment_and_providerUid', (q) =>
        q.eq('environment', 'production'),
      )
      .paginate(args.paginationOpts)
    let unsafeFound = args.unsafeFound ?? false
    const checkedMoneyRequests = new Set<Id<'moneyRequests'>>()
    for (const payment of result.page) {
      let cause: PayToPaymentRolloutSafetyCause | null = null
      if (payment.attention?.kind === 'unknown_provider_state') {
        cause = 'unknown_provider_state'
      } else if (payment.attention?.kind === 'settlement_contradiction') {
        cause = 'settlement_contradiction'
      } else if (
        payment.attention?.kind === 'retry_acknowledgement_uncertain'
      ) {
        cause = 'unresolved_retry_ambiguity'
      } else if (
        payment.attention?.kind === 'creation_recovery_required' &&
        payment.attention.reason === 'recovery_exhausted'
      ) {
        cause = 'unresolved_creation_ambiguity'
      } else if (payment.reconciliationAlert !== undefined) {
        cause = 'reconciliation_outage'
      }
      if (cause !== null) {
        unsafeFound = true
        await failProductionRolloutClosed(ctx, {
          cause,
          observedAt,
          payToPaymentId: payment._id,
        })
      }
      if (!checkedMoneyRequests.has(payment.moneyRequestId)) {
        checkedMoneyRequests.add(payment.moneyRequestId)
        try {
          await assertStoredPaymentProjection(ctx, payment.moneyRequestId)
        } catch {
          unsafeFound = true
          await failProductionRolloutClosed(ctx, {
            cause: 'projection_inconsistency',
            observedAt,
            payToPaymentId: payment._id,
          })
        }
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.payToPaymentRolloutMonitoring.scan,
        {
          paginationOpts: {
            ...args.paginationOpts,
            cursor: result.continueCursor,
          },
          observedAt,
          unsafeFound,
        },
      )
      return null
    }
    if (!unsafeFound) {
      await recordProductionRolloutCleanObservation(ctx, observedAt)
    }
    return null
  },
})

export const start = internalMutation({
  args: { observedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      0,
      internal.payToPaymentRolloutMonitoring.scan,
      {
        paginationOpts: {
          numItems: SCAN_PAGE_SIZE,
          cursor: null,
          maximumRowsRead: SCAN_PAGE_SIZE,
          maximumBytesRead: 1_000_000,
        },
        observedAt: args.observedAt,
      },
    )
    return null
  },
})
