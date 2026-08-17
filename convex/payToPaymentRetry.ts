import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalAction, internalMutation } from './_generated/server'
import { paymentRetryPool } from './lib/paymentRetryPool'
import { consumePaymentRetryEndpointCall } from './lib/paymentRetryRateLimiter'
import {
  emitPayToPaymentAggregateMetric,
  emitPayToPaymentCriticalSignal,
  emitPayToPaymentErrorCriticalSignal,
  warnIfPayToPaymentWorkOverdue,
} from './lib/payToPaymentTelemetry'
import { createEnvironmentZeptoClientFromEnv } from './lib/zepto/env'
import { ZeptoClientError } from './lib/zepto/error'
import { retryPayment } from './lib/zepto/payment'
import {
  allocatePayToPaymentOperationId,
  makePayToPaymentReconciliationDue,
  moneyMovingDenial,
} from './payToPayments'
import type { PayToPaymentCreateErrorCategory } from './validators/payToPayments'
import {
  payToPaymentCreateErrorCategories,
  payToPaymentCreateErrorCategoryValidator,
} from './validators/payToPayments'

const RETRY_LEASE_MS = 3 * 60_000
const MAX_RETRY_CALLS = 6
const MAX_RETRY_SUBMISSIONS = 3
const retryErrorCategories = new Set<string>(payToPaymentCreateErrorCategories)

function retryErrorCategory(error: unknown): PayToPaymentCreateErrorCategory {
  return error instanceof ZeptoClientError &&
    retryErrorCategories.has(error.kind)
    ? (error.kind as PayToPaymentCreateErrorCategory)
    : 'unclassified'
}

const retryClaimValidator = v.object({
  payToPaymentId: v.id('payToPayments'),
  providerUid: v.string(),
  environment: v.union(v.literal('sandbox'), v.literal('production')),
  operationId: v.string(),
  retryNumber: v.number(),
  leaseToken: v.string(),
  leaseExpiresAt: v.number(),
})
type RetryClaim = Infer<typeof retryClaimValidator>

function possiblyAccepted(operation: Doc<'payToPaymentOperations'>) {
  return (
    operation.operationKind === 'retry' &&
    operation.dispatchCertainty === 'possibly_dispatched' &&
    operation.outcome?.classification !== 'refused'
  )
}

async function retryAttempt(
  ctx: Pick<MutationCtx, 'db'>,
  args: { payToPaymentId: Doc<'payToPayments'>['_id']; operationId: string },
) {
  const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
  const work = await ctx.db
    .query('payToPaymentRetryWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', args.payToPaymentId),
    )
    .unique()
  const operation = await ctx.db
    .query('payToPaymentOperations')
    .withIndex('by_operationId', (q) => q.eq('operationId', args.operationId))
    .unique()
  return { payment, work, operation }
}

function retryLeaseAuthorizes(input: {
  work: Doc<'payToPaymentRetryWorkItems'> | null
  operation: Doc<'payToPaymentOperations'> | null
  leaseToken: string
  observedAt: number
}) {
  return (
    input.work !== null &&
    input.operation !== null &&
    input.work.state === 'running' &&
    input.work.operationId === input.operation.operationId &&
    input.work.leaseToken === input.leaseToken &&
    input.work.leaseExpiresAt !== undefined &&
    input.work.leaseExpiresAt >= input.observedAt &&
    input.operation.operationKind === 'retry' &&
    input.operation.leaseToken === input.leaseToken &&
    input.operation.outcome === undefined
  )
}

export const claimWork = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    leaseToken: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(retryClaimValidator, v.null()),
  handler: async (ctx, args): Promise<RetryClaim | null> => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    let work = await ctx.db
      .query('payToPaymentRetryWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', args.payToPaymentId),
      )
      .unique()
    if (
      payment &&
      work?.state === 'running' &&
      work.leaseExpiresAt !== undefined &&
      work.leaseExpiresAt <= args.nowMs
    ) {
      const expiredOperation =
        work.operationId === undefined
          ? null
          : await ctx.db
              .query('payToPaymentOperations')
              .withIndex('by_operationId', (q) =>
                q.eq('operationId', work?.operationId as string),
              )
              .unique()
      if (expiredOperation?.dispatchStartedAt !== undefined) {
        if (expiredOperation.outcome === undefined) {
          await ctx.db.patch('payToPaymentOperations', expiredOperation._id, {
            outcome: { classification: 'uncertain', observedAt: args.nowMs },
          })
        }
        await ctx.db.patch('payToPaymentRetryWorkItems', work._id, {
          state: 'locked',
          leaseToken: undefined,
          leaseExpiresAt: undefined,
        })
        await makePayToPaymentReconciliationDue(ctx, payment._id, args.nowMs)
        return null
      }
      if (expiredOperation && expiredOperation.outcome === undefined) {
        await ctx.db.patch('payToPaymentOperations', expiredOperation._id, {
          outcome: { classification: 'refused', observedAt: args.nowMs },
        })
      }
      await ctx.db.patch('payToPaymentRetryWorkItems', work._id, {
        state: 'queued',
        availableAt: args.nowMs,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        operationId: undefined,
      })
      work = (await ctx.db.get('payToPaymentRetryWorkItems', work._id)) ?? work
    }
    if (
      !payment ||
      !work ||
      work.state !== 'queued' ||
      work.availableAt > args.nowMs ||
      payment.creationState !== 'provider_established' ||
      payment.lifecycleState !== 'failed' ||
      payment.confirmedFailure?.retryable !== true ||
      payment.attention !== undefined
    ) {
      return null
    }
    const agreement = await ctx.db.get(
      'payToAgreements',
      payment.payToAgreementId,
    )
    if (
      !agreement ||
      agreement.lifecycleState !== 'active' ||
      agreement.lifecycleConfidence !== 'confirmed'
    ) {
      await ctx.db.patch('payToPaymentRetryWorkItems', work._id, {
        state: 'stopped',
      })
      return null
    }
    const gate = await ctx.db
      .query('payToPaymentRuntimeGates')
      .withIndex('by_environment', (q) =>
        q.eq('environment', payment.environment),
      )
      .unique()
    if (moneyMovingDenial(gate?.mode, payment.environment) !== undefined) {
      return null
    }
    if (work.freshGetRequestedAt === undefined) {
      await ctx.db.patch('payToPaymentRetryWorkItems', work._id, {
        freshGetRequestedAt: args.nowMs,
      })
      await makePayToPaymentReconciliationDue(ctx, payment._id, args.nowMs)
      return null
    }
    if (payment.confirmedFailure.observedAt < work.freshGetRequestedAt) {
      return null
    }
    const retryOperations = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_payToPaymentId_and_operationKind_and_authorizedAt', (q) =>
        q.eq('payToPaymentId', payment._id).eq('operationKind', 'retry'),
      )
      .order('desc')
      .take(MAX_RETRY_CALLS + 1)
    const createOperations = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_payToPaymentId_and_operationKind_and_authorizedAt', (q) =>
        q.eq('payToPaymentId', payment._id).eq('operationKind', 'create'),
      )
      .order('desc')
      .take(3)
    const reconciliationWork = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', payment._id),
      )
      .unique()
    const retryCalls = retryOperations.filter(
      (operation) => operation.dispatchStartedAt !== undefined,
    ).length
    const acceptedRetries = retryOperations.filter(possiblyAccepted).length
    const overlap = [...createOperations, ...retryOperations].some(
      (operation) => operation.outcome === undefined,
    )
    const rollingSubmissions = [...createOperations, ...retryOperations].filter(
      (operation) =>
        operation.authorizedAt >= args.nowMs - 24 * 60 * 60_000 &&
        ((operation.operationKind === 'create' &&
          operation.dispatchCertainty === 'possibly_dispatched') ||
          possiblyAccepted(operation)),
    ).length
    if (
      retryCalls >= MAX_RETRY_CALLS ||
      acceptedRetries >= MAX_RETRY_SUBMISSIONS ||
      rollingSubmissions >= 5 ||
      overlap ||
      reconciliationWork?.state !== 'stopped'
    ) {
      if (
        retryCalls >= MAX_RETRY_CALLS ||
        acceptedRetries >= MAX_RETRY_SUBMISSIONS ||
        rollingSubmissions >= 5
      ) {
        emitPayToPaymentCriticalSignal('cap_breach', {
          payToPaymentId: payment._id,
          payToAgreementId: payment.payToAgreementId,
          environment: payment.environment,
          observedAt: args.nowMs,
          reason: 'retry_capacity',
        })
      }
      await ctx.db.patch('payToPaymentRetryWorkItems', work._id, {
        state: 'stopped',
      })
      return null
    }
    const operationId = await allocatePayToPaymentOperationId(ctx, args.nowMs)
    const leaseExpiresAt = args.nowMs + RETRY_LEASE_MS
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId: payment._id,
      operationId,
      operationKind: 'retry',
      providerUid: payment.providerUid,
      apiVersion: payment.intent.apiVersion,
      dispatchCertainty: 'not_dispatched',
      intentFingerprint: payment.intent.fingerprint,
      authorizedAt: args.nowMs,
      leaseToken: args.leaseToken,
      leaseExpiresAt,
    })
    await ctx.db.patch('payToPaymentRetryWorkItems', work._id, {
      state: 'running',
      leaseToken: args.leaseToken,
      leaseExpiresAt,
      operationId,
    })
    return {
      payToPaymentId: payment._id,
      providerUid: payment.providerUid,
      environment: payment.environment,
      operationId,
      retryNumber: work.retryNumber,
      leaseToken: args.leaseToken,
      leaseExpiresAt,
    }
  },
})

export const dispatchDue = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now()
    const due = await ctx.db
      .query('payToPaymentRetryWorkItems')
      .withIndex('by_state_and_availableAt', (q) =>
        q.eq('state', 'queued').lte('availableAt', nowMs),
      )
      .take(50)
    const expired = await ctx.db
      .query('payToPaymentRetryWorkItems')
      .withIndex('by_state_and_leaseExpiresAt', (q) =>
        q.eq('state', 'running').lte('leaseExpiresAt', nowMs),
      )
      .take(Math.max(0, 50 - due.length))
    warnIfPayToPaymentWorkOverdue({
      nowMs,
      queue: 'retry',
      work: [
        ...due.map((work) => ({
          payToPaymentId: work.payToPaymentId,
          overdueAt: work.availableAt,
        })),
        ...expired.map((work) => ({
          payToPaymentId: work.payToPaymentId,
          overdueAt: work.leaseExpiresAt ?? nowMs,
        })),
      ],
    })
    for (const work of [...due, ...expired]) {
      await paymentRetryPool.enqueueAction(
        ctx,
        internal.payToPaymentRetry.retry,
        { payToPaymentId: work.payToPaymentId },
        { retry: false },
      )
    }
    return due.length + expired.length
  },
})

const retryAttemptArgs = v.object({
  payToPaymentId: v.id('payToPayments'),
  operationId: v.string(),
  leaseToken: v.string(),
  observedAt: v.number(),
})

export const markDispatchStarted = internalMutation({
  args: retryAttemptArgs.fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await retryAttempt(ctx, args)
    if (
      !attempt.payment ||
      !retryLeaseAuthorizes({
        work: attempt.work,
        operation: attempt.operation,
        leaseToken: args.leaseToken,
        observedAt: args.observedAt,
      })
    ) {
      return false
    }
    const gate = await ctx.db
      .query('payToPaymentRuntimeGates')
      .withIndex('by_environment', (q) =>
        q.eq('environment', attempt.payment!.environment),
      )
      .unique()
    if (
      moneyMovingDenial(gate?.mode, attempt.payment.environment) !== undefined
    ) {
      await ctx.db.patch('payToPaymentOperations', attempt.operation!._id, {
        outcome: { classification: 'refused', observedAt: args.observedAt },
      })
      await ctx.db.patch('payToPaymentRetryWorkItems', attempt.work!._id, {
        state: 'stopped',
      })
      return false
    }
    const callCapacity = await consumePaymentRetryEndpointCall(
      ctx,
      attempt.payment._id,
    )
    if (!callCapacity.ok) {
      emitPayToPaymentCriticalSignal('cap_breach', {
        payToPaymentId: attempt.payment._id,
        payToAgreementId: attempt.payment.payToAgreementId,
        environment: attempt.payment.environment,
        observedAt: args.observedAt,
        reason: 'retry_endpoint_rate_limit',
      })
      await ctx.db.patch('payToPaymentOperations', attempt.operation!._id, {
        outcome: { classification: 'refused', observedAt: args.observedAt },
      })
      await ctx.db.patch('payToPaymentRetryWorkItems', attempt.work!._id, {
        state: 'stopped',
      })
      return false
    }
    await ctx.db.patch('payToPaymentOperations', attempt.operation!._id, {
      dispatchCertainty: 'possibly_dispatched',
      dispatchStartedAt: args.observedAt,
    })
    return true
  },
})

export const recordAccepted = internalMutation({
  args: retryAttemptArgs.fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await retryAttempt(ctx, args)
    if (
      !attempt.payment ||
      !retryLeaseAuthorizes({
        work: attempt.work,
        operation: attempt.operation,
        leaseToken: args.leaseToken,
        observedAt: args.observedAt,
      }) ||
      attempt.operation?.dispatchStartedAt === undefined
    ) {
      return false
    }
    await ctx.db.patch('payToPaymentOperations', attempt.operation._id, {
      outcome: { classification: 'completed', observedAt: args.observedAt },
    })
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: attempt.payment._id,
      source: 'retry_response',
      intentFingerprint: attempt.payment.intent.fingerprint,
      operationId: attempt.operation.operationId,
      providerUid: attempt.payment.providerUid,
      dispatchCertainty: 'possibly_dispatched',
      classification: 'completed',
      observedAt: args.observedAt,
    })
    emitPayToPaymentAggregateMetric({
      kind: 'retry_attempt',
      payToPaymentId: attempt.payment._id,
      observedAt: args.observedAt,
      outcome: 'accepted',
    })
    await ctx.db.patch('payToPaymentRetryWorkItems', attempt.work!._id, {
      state: 'locked',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await makePayToPaymentReconciliationDue(
      ctx,
      attempt.payment._id,
      args.observedAt,
    )
    return true
  },
})

export const recordFailure = internalMutation({
  args: retryAttemptArgs.extend({
    ambiguous: v.boolean(),
    errorCategory: v.optional(payToPaymentCreateErrorCategoryValidator),
    providerCode: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await retryAttempt(ctx, args)
    if (
      !attempt.payment ||
      !retryLeaseAuthorizes({
        work: attempt.work,
        operation: attempt.operation,
        leaseToken: args.leaseToken,
        observedAt: args.observedAt,
      })
    ) {
      return false
    }
    const classification = args.ambiguous ? 'uncertain' : 'refused'
    await ctx.db.patch('payToPaymentOperations', attempt.operation!._id, {
      outcome: { classification, observedAt: args.observedAt },
    })
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: attempt.payment._id,
      source: 'retry_response',
      intentFingerprint: attempt.payment.intent.fingerprint,
      operationId: attempt.operation!.operationId,
      providerUid: attempt.payment.providerUid,
      dispatchCertainty: attempt.operation!.dispatchCertainty,
      classification,
      providerFailureCode: args.providerCode,
      errorCategory: args.errorCategory,
      observedAt: args.observedAt,
    })
    if (args.errorCategory !== undefined) {
      emitPayToPaymentErrorCriticalSignal({
        payToPaymentId: attempt.payment._id,
        payToAgreementId: attempt.payment.payToAgreementId,
        environment: attempt.payment.environment,
        category: args.errorCategory,
        observedAt: args.observedAt,
      })
    }
    emitPayToPaymentAggregateMetric({
      kind: 'retry_attempt',
      payToPaymentId: attempt.payment._id,
      observedAt: args.observedAt,
      outcome: args.ambiguous ? 'ambiguous' : 'refused',
    })
    if (args.ambiguous) {
      await ctx.db.patch('payToPaymentRetryWorkItems', attempt.work!._id, {
        state: 'locked',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      })
      await makePayToPaymentReconciliationDue(
        ctx,
        attempt.payment._id,
        args.observedAt,
      )
      return true
    }
    const cooldown =
      args.providerCode === 'ZPPRY03' &&
      args.retryAfterMs !== undefined &&
      (attempt.work!.cooldownReschedules ?? 0) < 1
    const requiresRefresh = args.providerCode === 'ZPPRY00'
    await ctx.db.patch('payToPaymentRetryWorkItems', attempt.work!._id, {
      state: cooldown || requiresRefresh ? 'queued' : 'stopped',
      availableAt: cooldown
        ? args.observedAt + Math.max(0, args.retryAfterMs ?? 0)
        : args.observedAt,
      freshGetRequestedAt: undefined,
      cooldownReschedules: cooldown
        ? (attempt.work!.cooldownReschedules ?? 0) + 1
        : attempt.work!.cooldownReschedules,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      operationId: undefined,
    })
    if (requiresRefresh) {
      await makePayToPaymentReconciliationDue(
        ctx,
        attempt.payment._id,
        args.observedAt,
      )
    }
    return true
  },
})

function retryProviderCode(error: unknown) {
  if (!(error instanceof ZeptoClientError)) return undefined
  if (typeof error.body !== 'object' || error.body === null) return undefined
  const errors = (error.body as Record<string, unknown>).errors
  if (!Array.isArray(errors)) return undefined
  const first = errors[0]
  return typeof first === 'object' &&
    first !== null &&
    typeof (first as Record<string, unknown>).code === 'string'
    ? ((first as Record<string, unknown>).code as string)
    : undefined
}

export const retry = internalAction({
  args: { payToPaymentId: v.id('payToPayments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseToken = crypto.randomUUID()
    const input: RetryClaim | null = await ctx.runMutation(
      internal.payToPaymentRetry.claimWork,
      { payToPaymentId: args.payToPaymentId, leaseToken, nowMs: Date.now() },
    )
    if (!input) return null
    let client: ReturnType<typeof createEnvironmentZeptoClientFromEnv>
    try {
      client = createEnvironmentZeptoClientFromEnv(input.environment, {
        maxRetries: 0,
      })
    } catch (error) {
      const recorded: boolean = await ctx.runMutation(
        internal.payToPaymentRetry.recordFailure,
        {
          payToPaymentId: input.payToPaymentId,
          operationId: input.operationId,
          leaseToken,
          ambiguous: false,
          errorCategory: retryErrorCategory(error),
          observedAt: Date.now(),
        },
      )
      void recorded
      return null
    }
    const dispatched: boolean = await ctx.runMutation(
      internal.payToPaymentRetry.markDispatchStarted,
      {
        payToPaymentId: input.payToPaymentId,
        operationId: input.operationId,
        leaseToken,
        observedAt: Date.now(),
      },
    )
    if (!dispatched) return null
    try {
      await retryPayment(client, { providerUid: input.providerUid })
      const recorded: boolean = await ctx.runMutation(
        internal.payToPaymentRetry.recordAccepted,
        {
          payToPaymentId: input.payToPaymentId,
          operationId: input.operationId,
          leaseToken,
          observedAt: Date.now(),
        },
      )
      void recorded
    } catch (error) {
      const providerCode = retryProviderCode(error)
      const documentedRejection =
        error instanceof ZeptoClientError &&
        error.status === 422 &&
        providerCode?.startsWith('ZPPRY') === true
      const recorded: boolean = await ctx.runMutation(
        internal.payToPaymentRetry.recordFailure,
        {
          payToPaymentId: input.payToPaymentId,
          operationId: input.operationId,
          leaseToken,
          ambiguous: !documentedRejection,
          errorCategory: retryErrorCategory(error),
          providerCode,
          retryAfterMs:
            error instanceof ZeptoClientError ? error.retryAfterMs : undefined,
          observedAt: Date.now(),
        },
      )
      void recorded
    }
    return null
  },
})
