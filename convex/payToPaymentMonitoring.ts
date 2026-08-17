import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { assertStoredPaymentProjection } from './lib/payToPaymentProjection'
import { emitPayToPaymentAggregateMetric } from './lib/payToPaymentTelemetry'
import { failProductionRolloutClosed } from './lib/payToPaymentRollout'

const DAY_MS = 24 * 60 * 60_000
const PAYMENT_SAMPLE_LIMIT = 200
const OPERATION_SAMPLE_LIMIT = 1_000
const DEDUPLICATION_SAMPLE_LIMIT = 1_000

const aggregateSnapshotValidator = v.object({
  observedAt: v.number(),
  sampledPaymentCount: v.number(),
  sampleTruncated: v.boolean(),
  settlement: v.object({
    settledCount: v.number(),
    averageLatencyMs: v.number(),
    maxLatencyMs: v.number(),
  }),
  agedUnresolvedPaymentCount: v.number(),
  confirmedFailureCount: v.number(),
  confirmedFailureRate: v.number(),
  retry: v.object({
    attemptCount: v.number(),
    failureCount: v.number(),
    failureRate: v.number(),
  }),
  webhookDeduplication: v.object({
    duplicateDeliveryCount: v.number(),
    duplicateEventCount: v.number(),
  }),
  projection: v.object({
    checkedCount: v.number(),
    inconsistencyCount: v.number(),
  }),
})

export const checkAgedUnresolved = internalMutation({
  args: { payToPaymentId: v.id('payToPayments') },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    if (!payment) return false
    return await signalAgedUnresolvedPayment(
      ctx,
      payment,
      payment.establishedAt + DAY_MS,
    )
  },
})

async function signalAgedUnresolvedPayment(
  ctx: Pick<MutationCtx, 'db'>,
  payment: Doc<'payToPayments'>,
  observedAt: number,
) {
  if (payment.agedUnresolvedMonitoringCompletedAt !== undefined) {
    return false
  }
  if (payment.lifecycleState === 'settled') {
    await ctx.db.patch('payToPayments', payment._id, {
      agedUnresolvedMonitoringCompletedAt: observedAt,
    })
    return false
  }
  if (observedAt - payment.establishedAt < DAY_MS) return false
  emitPayToPaymentAggregateMetric({
    kind: 'aged_unresolved_payment',
    payToPaymentId: payment._id,
    observedAt,
  })
  await ctx.db.patch('payToPayments', payment._id, {
    agedUnresolvedMonitoringCompletedAt: observedAt,
  })
  return true
}

export const sweepAgedUnresolved = internalMutation({
  args: {
    paginationOpts: paginationOptsValidator,
    nowMs: v.optional(v.number()),
  },
  returns: v.object({ emittedCount: v.number(), isDone: v.boolean() }),
  handler: async (ctx, args) => {
    if (
      args.paginationOpts.maximumRowsRead === undefined ||
      args.paginationOpts.maximumRowsRead > 100 ||
      args.paginationOpts.maximumBytesRead === undefined ||
      args.paginationOpts.maximumBytesRead > 1_000_000
    ) {
      throw new Error('Aged unresolved Payment sweep must remain bounded')
    }
    const nowMs = args.nowMs ?? Date.now()
    const result = await ctx.db
      .query('payToPayments')
      .withIndex(
        'by_agedUnresolvedMonitoringCompletedAt_and_establishedAt',
        (q) =>
          q
            .eq('agedUnresolvedMonitoringCompletedAt', undefined)
            .lte('establishedAt', nowMs - DAY_MS),
      )
      .order('asc')
      .paginate(args.paginationOpts)
    let emittedCount = 0
    for (const payment of result.page) {
      if (await signalAgedUnresolvedPayment(ctx, payment, nowMs)) {
        emittedCount += 1
      }
    }
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.payToPaymentMonitoring.sweepAgedUnresolved,
        {
          paginationOpts: {
            ...args.paginationOpts,
            cursor: result.continueCursor,
          },
          nowMs,
        },
      )
    }
    return { emittedCount, isDone: result.isDone }
  },
})

export const emitAggregateSnapshot = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  returns: aggregateSnapshotValidator,
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now()
    const [paymentSample, operationSample, deduplicationSample] =
      await Promise.all([
        ctx.db
          .query('payToPayments')
          .order('desc')
          .take(PAYMENT_SAMPLE_LIMIT + 1),
        ctx.db
          .query('payToPaymentOperations')
          .order('desc')
          .take(OPERATION_SAMPLE_LIMIT + 1),
        ctx.db
          .query('payToPaymentWebhookDeduplication')
          .order('desc')
          .take(DEDUPLICATION_SAMPLE_LIMIT + 1),
      ])
    const payments = paymentSample.slice(0, PAYMENT_SAMPLE_LIMIT)
    const operations = operationSample.slice(0, OPERATION_SAMPLE_LIMIT)
    const deduplication = deduplicationSample.slice(
      0,
      DEDUPLICATION_SAMPLE_LIMIT,
    )
    const settlementLatencies = payments.flatMap((payment) =>
      payment.lifecycleState === 'settled' &&
      payment.lifecycleObservedAt !== undefined
        ? [Math.max(0, payment.lifecycleObservedAt - payment.establishedAt)]
        : [],
    )
    const recentRetries = operations.filter(
      (operation) =>
        operation.operationKind === 'retry' &&
        operation.authorizedAt >= nowMs - DAY_MS,
    )
    const moneyRequestIds = [
      ...new Set(payments.map((payment) => payment.moneyRequestId)),
    ]
    let projectionInconsistencyCount = 0
    for (const moneyRequestId of moneyRequestIds) {
      try {
        await assertStoredPaymentProjection(ctx, moneyRequestId)
      } catch {
        projectionInconsistencyCount += 1
      }
    }
    if (projectionInconsistencyCount > 0) {
      await failProductionRolloutClosed(ctx, {
        cause: 'projection_inconsistency',
        observedAt: nowMs,
      })
    }
    const confirmedFailureCount = payments.filter(
      (payment) => payment.lifecycleState === 'failed',
    ).length
    const retryFailureCount = recentRetries.filter(
      (operation) =>
        operation.outcome !== undefined &&
        operation.outcome.classification !== 'completed',
    ).length
    const snapshot = {
      observedAt: nowMs,
      sampledPaymentCount: payments.length,
      sampleTruncated:
        paymentSample.length > PAYMENT_SAMPLE_LIMIT ||
        operationSample.length > OPERATION_SAMPLE_LIMIT ||
        deduplicationSample.length > DEDUPLICATION_SAMPLE_LIMIT,
      settlement: {
        settledCount: settlementLatencies.length,
        averageLatencyMs:
          settlementLatencies.length === 0
            ? 0
            : Math.round(
                settlementLatencies.reduce((sum, latency) => sum + latency, 0) /
                  settlementLatencies.length,
              ),
        maxLatencyMs:
          settlementLatencies.length === 0
            ? 0
            : Math.max(...settlementLatencies),
      },
      agedUnresolvedPaymentCount: payments.filter(
        (payment) =>
          payment.lifecycleState !== 'settled' &&
          nowMs - payment.establishedAt >= DAY_MS,
      ).length,
      confirmedFailureCount,
      confirmedFailureRate:
        payments.length === 0 ? 0 : confirmedFailureCount / payments.length,
      retry: {
        attemptCount: recentRetries.length,
        failureCount: retryFailureCount,
        failureRate:
          recentRetries.length === 0
            ? 0
            : retryFailureCount / recentRetries.length,
      },
      webhookDeduplication: {
        duplicateDeliveryCount: deduplication.filter(
          (item) => item.outcome === 'duplicate_delivery',
        ).length,
        duplicateEventCount: deduplication.filter(
          (item) => item.outcome === 'duplicate_event',
        ).length,
      },
      projection: {
        checkedCount: moneyRequestIds.length,
        inconsistencyCount: projectionInconsistencyCount,
      },
    }
    console.info('PayTo Payment aggregate monitoring', snapshot)
    return snapshot
  },
})
