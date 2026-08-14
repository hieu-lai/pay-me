import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import { internalAction, internalMutation } from './_generated/server'
import { createEnvironmentZeptoClientFromEnv } from './lib/zepto/env'
import { ZeptoClientError } from './lib/zepto/error'
import { getPaymentLifecycleByUid } from './lib/zepto/payment'
import {
  CREATE_RECOVERY_WINDOW_MS,
  allocatePayToPaymentOperationId,
  payToPaymentOperationEvidenceProvenance,
  reconciliationLeaseAuthorizes,
  requireCreationRecoveryAttention,
} from './payToPayments'
import {
  decidePaymentReconciliationFailure,
  paymentReconciliationDelay,
} from './payToPaymentReconciliationState'
import { zeptoEnvironmentValidator } from './validators/payToAgreements'
import type { PayToPaymentCreateErrorCategory } from './validators/payToPayments'
import {
  payToPaymentCreateErrorCategories,
  payToPaymentCreateErrorCategoryValidator,
} from './validators/payToPayments'

const LEASE_DURATION_MS = 3 * 60_000
const CREATION_RECONCILIATION_TARGETS_MS = [
  30_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
] as const
const errorCategories = new Set<string>(payToPaymentCreateErrorCategories)

function paymentErrorCategory(error: unknown): PayToPaymentCreateErrorCategory {
  if (error instanceof ZeptoClientError && errorCategories.has(error.kind)) {
    return error.kind as PayToPaymentCreateErrorCategory
  }
  return 'unclassified'
}

async function fingerprintGetRequest(providerUid: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([1, '20260101', providerUid])),
  )
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const claimResultValidator = v.object({
  environment: zeptoEnvironmentValidator,
  providerUid: v.string(),
  agreementProviderUid: v.string(),
  amountCents: v.number(),
  priority: v.literal('unattended'),
  operationId: v.string(),
  intentFingerprint: v.string(),
})
type ClaimResult = Infer<typeof claimResultValidator>

function reconciliationFailureProgress(
  payment: {
    establishedAt: number
    lifecycleState?:
      | 'created'
      | 'submitting'
      | 'pending'
      | 'under_investigation'
      | 'failed'
      | 'settled'
    provisionalLifecycleState?:
      | 'created'
      | 'submitting'
      | 'pending'
      | 'under_investigation'
      | 'failed'
      | 'settled'
  },
  workItem: {
    consecutiveFailures?: number
    failureStartedAt?: number
    lastSuccessAt?: number
  },
  observedAt: number,
) {
  const consecutiveFailures = (workItem.consecutiveFailures ?? 0) + 1
  const failureStartedAt =
    workItem.failureStartedAt ?? workItem.lastSuccessAt ?? payment.establishedAt
  const safeState =
    payment.lifecycleState ?? payment.provisionalLifecycleState ?? 'created'
  const safeDelayMs =
    paymentReconciliationDelay(
      safeState,
      Math.max(0, observedAt - payment.establishedAt),
    ) ?? 60 * 60_000
  return {
    consecutiveFailures,
    failureStartedAt,
    decision: decidePaymentReconciliationFailure({
      consecutiveFailures,
      failureStartedAt,
      nowMs: observedAt,
      safeDelayMs,
    }),
  }
}

export const claimWork = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    leaseToken: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(claimResultValidator, v.null()),
  handler: async (ctx, args) => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    const workItem = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', args.payToPaymentId),
      )
      .unique()
    if (
      !payment ||
      !workItem ||
      workItem.state === 'stopped' ||
      workItem.availableAt > args.nowMs ||
      (payment.creationState !== 'creation_uncertain' &&
        payment.creationState !== 'provider_established')
    ) {
      return null
    }
    if (
      payment.creationState === 'creation_uncertain' &&
      payment.creationRecovery !== undefined &&
      args.nowMs >=
        payment.creationRecovery.startedAt + CREATE_RECOVERY_WINDOW_MS
    ) {
      await requireCreationRecoveryAttention(
        ctx,
        payment,
        'recovery_exhausted',
        args.nowMs,
      )
      return null
    }
    if (
      workItem.state === 'running' &&
      workItem.leaseExpiresAt !== undefined &&
      workItem.leaseExpiresAt > args.nowMs
    ) {
      return null
    }
    const replacedExpiredLease =
      workItem.state === 'running' &&
      workItem.leaseExpiresAt !== undefined &&
      workItem.leaseExpiresAt <= args.nowMs
    const expiredProgress = replacedExpiredLease
      ? reconciliationFailureProgress(payment, workItem, args.nowMs)
      : null
    if (expiredProgress && workItem.operationId !== undefined) {
      const expiredOperation = await ctx.db
        .query('payToPaymentOperations')
        .withIndex('by_operationId', (q) =>
          q.eq('operationId', workItem.operationId as string),
        )
        .unique()
      if (expiredOperation && expiredOperation.outcome === undefined) {
        await ctx.db.patch('payToPaymentOperations', expiredOperation._id, {
          outcome: { classification: 'uncertain', observedAt: args.nowMs },
        })
      }
      await ctx.db.insert('payToPaymentEvidence', {
        payToPaymentId: payment._id,
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        operationId: workItem.operationId,
        ...(expiredOperation
          ? payToPaymentOperationEvidenceProvenance(payment, expiredOperation)
          : { providerUid: payment.providerUid }),
        classification: 'uncertain',
        errorCategory: 'unclassified',
        outcome: 'failure',
        consecutiveFailures: expiredProgress.consecutiveFailures,
        observedAt: args.nowMs,
      })
      if (expiredProgress.decision.kind === 'alert') {
        await ctx.db.patch('payToPayments', payment._id, {
          reconciliationAlert: {
            kind: 'lifecycle_tracking_outage',
            observedAt: args.nowMs,
          },
        })
      }
    }
    const operationId = await allocatePayToPaymentOperationId(ctx, args.nowMs)
    const requestFingerprint = await fingerprintGetRequest(payment.providerUid)
    const leaseExpiresAt = args.nowMs + LEASE_DURATION_MS
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId: payment._id,
      operationId,
      operationKind: 'get',
      providerUid: payment.providerUid,
      apiVersion: payment.intent.apiVersion,
      dispatchCertainty: 'possibly_dispatched',
      intentFingerprint: payment.intent.fingerprint,
      requestFingerprint,
      authorizedAt: args.nowMs,
      leaseToken: args.leaseToken,
      leaseExpiresAt,
      dispatchStartedAt: args.nowMs,
    })
    await ctx.db.patch('payToPaymentReconciliationWorkItems', workItem._id, {
      state: 'running',
      leaseToken: args.leaseToken,
      leaseExpiresAt,
      operationId,
      refreshRequestedAt: undefined,
      ...(expiredProgress
        ? {
            consecutiveFailures: expiredProgress.consecutiveFailures,
            failureStartedAt: expiredProgress.failureStartedAt,
          }
        : {}),
    })
    return {
      environment: payment.environment,
      providerUid: payment.providerUid,
      agreementProviderUid: payment.intent.agreementProviderUid,
      amountCents: payment.intent.amount.cents,
      priority: payment.intent.priority,
      operationId,
      intentFingerprint: payment.intent.fingerprint,
    }
  },
})

export const dispatchDue = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now()
    const due = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_state_and_availableAt', (q) =>
        q.eq('state', 'queued').lte('availableAt', nowMs),
      )
      .take(50)
    const expired = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_state_and_leaseExpiresAt', (q) =>
        q.eq('state', 'running').lte('leaseExpiresAt', nowMs),
      )
      .take(Math.max(0, 50 - due.length))
    const oldestAvailableAt = due.at(0)?.availableAt
    if (
      oldestAvailableAt !== undefined &&
      nowMs - oldestAvailableAt >= 5 * 60_000
    ) {
      console.warn('PayTo Payment reconciliation queue is stale', {
        dueCount: due.length,
        oldestAgeMs: nowMs - oldestAvailableAt,
      })
    }
    for (const workItem of [...due, ...expired]) {
      await ctx.scheduler.runAfter(
        0,
        internal.payToPaymentReconciliation.reconcile,
        { payToPaymentId: workItem.payToPaymentId },
      )
    }
    return due.length + expired.length
  },
})

export const recordFailure = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    operationId: v.string(),
    leaseToken: v.string(),
    category: payToPaymentCreateErrorCategoryValidator,
    observedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    const workItem = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', args.payToPaymentId),
      )
      .unique()
    const operation = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_operationId', (q) => q.eq('operationId', args.operationId))
      .unique()
    if (!payment || !operation) return false
    const currentLease =
      workItem !== null &&
      reconciliationLeaseAuthorizes({
        workItem,
        operation,
        payToPaymentId: args.payToPaymentId,
        operationId: args.operationId,
        leaseToken: args.leaseToken,
        observedAt: args.observedAt,
      })
    if (!currentLease) {
      if (
        operation.payToPaymentId === payment._id &&
        operation.operationKind === 'get' &&
        operation.leaseToken === args.leaseToken
      ) {
        await ctx.db.insert('payToPaymentEvidence', {
          payToPaymentId: payment._id,
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          operationId: operation.operationId,
          ...payToPaymentOperationEvidenceProvenance(payment, operation),
          classification: 'uncertain',
          errorCategory: args.category,
          outcome: 'failure',
          observedAt: args.observedAt,
        })
      }
      return false
    }
    if (
      payment.creationState === 'creation_uncertain' &&
      payment.creationRecovery !== undefined
    ) {
      const recovery = payment.creationRecovery
      const getAttempts = recovery.getAttempts + 1
      await ctx.db.insert('payToPaymentEvidence', {
        payToPaymentId: payment._id,
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        operationId: operation.operationId,
        ...payToPaymentOperationEvidenceProvenance(payment, operation),
        classification: 'uncertain',
        errorCategory: args.category,
        outcome: 'failure',
        consecutiveFailures: getAttempts,
        observedAt: args.observedAt,
      })
      await ctx.db.patch('payToPaymentOperations', operation._id, {
        outcome: { classification: 'uncertain', observedAt: args.observedAt },
      })
      await ctx.db.patch('payToPayments', payment._id, {
        creationRecovery: { ...recovery, getAttempts },
      })
      if (args.observedAt >= recovery.startedAt + CREATE_RECOVERY_WINDOW_MS) {
        await requireCreationRecoveryAttention(
          ctx,
          payment,
          'recovery_exhausted',
          args.observedAt,
        )
        return true
      }
      const targetIndex = Math.min(
        getAttempts - 1,
        CREATION_RECONCILIATION_TARGETS_MS.length - 1,
      )
      const uncertainSince = recovery.uncertainSince ?? recovery.startedAt
      const nextTarget = Math.min(
        uncertainSince + CREATION_RECONCILIATION_TARGETS_MS[targetIndex],
        recovery.startedAt + CREATE_RECOVERY_WINDOW_MS,
      )
      const availableAt =
        workItem.refreshRequestedAt === undefined
          ? Math.max(args.observedAt, nextTarget)
          : args.observedAt
      await ctx.db.patch('payToPaymentReconciliationWorkItems', workItem._id, {
        state: 'queued',
        availableAt,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        operationId: undefined,
        refreshRequestedAt: undefined,
        consecutiveFailures: getAttempts,
        failureStartedAt: recovery.uncertainSince ?? recovery.startedAt,
      })
      await ctx.scheduler.runAfter(
        Math.max(0, availableAt - args.observedAt),
        internal.payToPaymentReconciliation.reconcile,
        { payToPaymentId: payment._id },
      )
      return true
    }
    const { consecutiveFailures, failureStartedAt, decision } =
      reconciliationFailureProgress(payment, workItem, args.observedAt)
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: payment._id,
      source: 'per_uid_get',
      intentFingerprint: payment.intent.fingerprint,
      operationId: operation.operationId,
      ...payToPaymentOperationEvidenceProvenance(payment, operation),
      classification: 'uncertain',
      errorCategory: args.category,
      outcome: 'failure',
      consecutiveFailures,
      observedAt: args.observedAt,
    })
    await ctx.db.patch('payToPaymentOperations', operation._id, {
      outcome: { classification: 'uncertain', observedAt: args.observedAt },
    })
    await ctx.db.patch('payToPayments', payment._id, {
      ...(decision.kind === 'alert'
        ? {
            reconciliationAlert: {
              kind: 'lifecycle_tracking_outage' as const,
              observedAt: args.observedAt,
            },
          }
        : {}),
    })
    await ctx.db.patch('payToPaymentReconciliationWorkItems', workItem._id, {
      state: 'queued',
      availableAt:
        workItem.refreshRequestedAt === undefined
          ? args.observedAt + decision.delayMs
          : args.observedAt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      operationId: undefined,
      refreshRequestedAt: undefined,
      consecutiveFailures,
      failureStartedAt,
    })
    if (decision.kind === 'alert') {
      console.error('PayTo Payment lifecycle tracking outage', {
        payToPaymentId: payment._id,
        consecutiveFailures,
      })
    }
    return true
  },
})

export const reconcile = internalAction({
  args: { payToPaymentId: v.id('payToPayments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseToken = crypto.randomUUID()
    const input: ClaimResult | null = await ctx.runMutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: args.payToPaymentId,
        leaseToken,
        nowMs: Date.now(),
      },
    )
    if (!input) return null
    try {
      const client = createEnvironmentZeptoClientFromEnv(input.environment, {
        maxRetries: 0,
      })
      const result = await getPaymentLifecycleByUid(client, {
        providerUid: input.providerUid,
        agreementProviderUid: input.agreementProviderUid,
        amountCents: input.amountCents,
        priority: input.priority,
      })
      await ctx.runMutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: args.payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: input.intentFingerprint,
          providerState: result.providerState,
          operationId: input.operationId,
          leaseToken,
        },
        observedAt: Date.now(),
      })
    } catch (error) {
      if (error instanceof ZeptoClientError && error.status === 404) {
        await ctx.runMutation(internal.payToPayments.applyEvidence, {
          payToPaymentId: args.payToPaymentId,
          evidence: {
            source: 'per_uid_get',
            intentFingerprint: input.intentFingerprint,
            providerAbsent: true,
            operationId: input.operationId,
            leaseToken,
          },
          observedAt: Date.now(),
        })
        return null
      }
      const recorded: boolean = await ctx.runMutation(
        internal.payToPaymentReconciliation.recordFailure,
        {
          payToPaymentId: args.payToPaymentId,
          operationId: input.operationId,
          leaseToken,
          category: paymentErrorCategory(error),
          observedAt: Date.now(),
        },
      )
      if (!recorded) return null
    }
    return null
  },
})
