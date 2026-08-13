import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { internalAction, internalMutation } from './_generated/server'
import { firstConfirmedActivePatch } from './lib/payToAgreementActivation'
import { createEnvironmentZeptoClientFromEnv } from './lib/zepto/env'
import { ZeptoClientError } from './lib/zepto/error'
import {
  getAgreementHistoryEvidence,
  getAgreementLifecycleByUid,
} from './lib/zepto/reconciliation'
import { normalizedProviderErrorCategory } from './payToAgreementCreationState'
import { ensurePayToPayment } from './payToPayments'
import {
  canRecordReconciliationOutcome,
  decideReconciliationFailure,
  decideReconciliationSuccess,
} from './payToAgreementReconciliationState'
import type { ZeptoEnvironment } from './validators/payToAgreements'
import {
  providerAgreementStates,
  zeptoEnvironmentValidator,
} from './validators/payToAgreements'

const LEASE_DURATION_MS = 3 * 60_000

const claimResultValidator = v.object({
  environment: zeptoEnvironmentValidator,
  providerUid: v.string(),
  confirmedTerminalState: v.optional(v.string()),
})
type ClaimResult = {
  environment: ZeptoEnvironment
  providerUid: string
  confirmedTerminalState?: string
}
const knownProviderStates = new Set<string>(providerAgreementStates)

function isConfirmedTerminal(agreement: Doc<'payToAgreements'>) {
  return (
    agreement.lifecycleConfidence === 'confirmed' &&
    (agreement.lifecycleState === 'cancelled' ||
      agreement.lifecycleState === 'declined' ||
      agreement.lifecycleState === 'failed' ||
      agreement.lifecycleState === 'expired')
  )
}

export const claimWork = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    leaseToken: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(claimResultValidator, v.null()),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    const workItem = await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', args.payToAgreementId),
      )
      .unique()
    if (!agreement || !workItem || workItem.state === 'stopped') return null
    if (
      isConfirmedTerminal(agreement) &&
      agreement.trackingState !== 'verification_due' &&
      agreement.trackingState !== 'needs_review'
    ) {
      await ctx.db.patch(
        'payToAgreementReconciliationWorkItems',
        workItem._id,
        {
          state: 'stopped',
          leaseToken: undefined,
          leaseExpiresAt: undefined,
        },
      )
      return null
    }
    if (workItem.availableAt > args.nowMs) return null
    if (
      workItem.leaseToken !== undefined &&
      workItem.leaseExpiresAt !== undefined &&
      workItem.leaseExpiresAt > args.nowMs
    ) {
      return null
    }

    const replacedExpiredLease =
      workItem.leaseToken !== undefined &&
      workItem.leaseExpiresAt !== undefined &&
      workItem.leaseExpiresAt <= args.nowMs
    if (replacedExpiredLease) {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'reconciliation_lease_expired',
        observedAt: args.nowMs,
      })
      console.warn('PayTo lifecycle reconciliation lease expired', {
        payToAgreementId: agreement._id,
      })
    }
    await ctx.db.patch('payToAgreementReconciliationWorkItems', workItem._id, {
      state: 'running',
      leaseToken: args.leaseToken,
      leaseExpiresAt: args.nowMs + LEASE_DURATION_MS,
    })
    await ctx.db.patch('payToAgreements', agreement._id, {
      trackingState: 'checking',
      trackingUpdatedAt: args.nowMs,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'reconciliation_lease_claimed',
      replacedExpiredLease,
      observedAt: args.nowMs,
    })
    return {
      environment: agreement.environment,
      providerUid: workItem.providerUid,
      ...(isConfirmedTerminal(agreement)
        ? { confirmedTerminalState: agreement.lifecycleState }
        : {}),
    }
  },
})

export const recordSuccess = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    leaseToken: v.string(),
    providerState: v.string(),
    observedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    const workItem = await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', args.payToAgreementId),
      )
      .unique()
    if (
      !agreement ||
      !workItem ||
      !canRecordReconciliationOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }

    const decision = decideReconciliationSuccess({
      currentState: agreement.lifecycleState,
      currentConfidence: agreement.lifecycleConfidence,
      providerState: args.providerState,
    })
    const previousFailureCount = workItem.consecutiveFailures ?? 0
    if (previousFailureCount > 0) {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'reconciliation_recovered',
        previousFailureCount,
        observedAt: args.observedAt,
      })
      console.info('PayTo lifecycle reconciliation recovered', {
        payToAgreementId: agreement._id,
        previousFailureCount,
      })
    }

    if (decision.kind === 'confirmed') {
      const stopped = decision.delayMs === null
      await ctx.db.patch('payToAgreements', agreement._id, {
        ...firstConfirmedActivePatch({
          activationProvenancePolicy: agreement.activationProvenancePolicy,
          confirmationSource: 'per_uid_get',
          existingFirstConfirmedActiveAt: agreement.firstConfirmedActiveAt,
          observedAt: args.observedAt,
          providerState: decision.state,
        }),
        lifecycleState: decision.state,
        lifecycleRawState: undefined,
        lifecycleConfidence: 'confirmed',
        lifecycleObservedAt: args.observedAt,
        lifecycleProviderPublishedAt: undefined,
        trackingState: stopped ? 'stopped' : 'current',
        trackingUpdatedAt: args.observedAt,
        currentFailure: undefined,
      })
      await ctx.db.patch(
        'payToAgreementReconciliationWorkItems',
        workItem._id,
        {
          state: stopped ? 'stopped' : 'queued',
          availableAt: args.observedAt + (decision.delayMs ?? 0),
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          consecutiveFailures: 0,
          failureStartedAt: undefined,
          lastSuccessAt: args.observedAt,
        },
      )
      if (decision.state === 'active') {
        const paymentIntent = await ensurePayToPayment(ctx, {
          payToAgreementId: agreement._id,
          observedAt: args.observedAt,
        })
        if (paymentIntent.kind === 'mismatch') return false
      }
    } else if (decision.kind === 'unknown') {
      await ctx.db.patch('payToAgreements', agreement._id, {
        lifecycleState: 'unknown',
        lifecycleRawState: decision.rawState,
        lifecycleConfidence: 'confirmed',
        lifecycleObservedAt: args.observedAt,
        lifecycleProviderPublishedAt: undefined,
        trackingState: 'needs_review',
        trackingUpdatedAt: args.observedAt,
        currentFailure: {
          kind: 'lifecycle_unknown',
          observedAt: args.observedAt,
        },
      })
      await ctx.db.patch(
        'payToAgreementReconciliationWorkItems',
        workItem._id,
        {
          state: 'queued',
          availableAt: args.observedAt + decision.delayMs,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          consecutiveFailures: 0,
          failureStartedAt: undefined,
          lastSuccessAt: args.observedAt,
        },
      )
      console.warn('PayTo lifecycle reconciliation observed unknown state', {
        payToAgreementId: agreement._id,
      })
    } else {
      await ctx.db.patch('payToAgreements', agreement._id, {
        trackingState: 'needs_review',
        trackingUpdatedAt: args.observedAt,
        currentFailure: {
          kind: 'lifecycle_contradiction',
          observedAt: args.observedAt,
        },
      })
      await ctx.db.patch(
        'payToAgreementReconciliationWorkItems',
        workItem._id,
        {
          state: 'queued',
          availableAt: args.observedAt + decision.delayMs,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          consecutiveFailures: 0,
          failureStartedAt: undefined,
          lastSuccessAt: args.observedAt,
        },
      )
      console.warn('PayTo lifecycle reconciliation found a contradiction', {
        payToAgreementId: agreement._id,
      })
    }
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_lifecycle_get_observed',
      providerState: args.providerState,
      outcome: decision.kind,
      observedAt: args.observedAt,
    })
    return true
  },
})

export const recordFailure = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    leaseToken: v.string(),
    category: v.string(),
    observedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    const workItem = await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', args.payToAgreementId),
      )
      .unique()
    if (
      !agreement ||
      !workItem ||
      !canRecordReconciliationOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }
    const consecutiveFailures = (workItem.consecutiveFailures ?? 0) + 1
    const failureStartedAt = workItem.failureStartedAt ?? args.observedAt
    const decision = decideReconciliationFailure({
      consecutiveFailures,
      failureStartedAt,
      nowMs: args.observedAt,
    })
    await ctx.db.patch('payToAgreements', agreement._id, {
      trackingState: decision.kind === 'review' ? 'needs_review' : 'retrying',
      trackingUpdatedAt: args.observedAt,
      currentFailure: {
        kind: 'lifecycle_tracking_outage',
        observedAt: args.observedAt,
      },
    })
    await ctx.db.patch('payToAgreementReconciliationWorkItems', workItem._id, {
      state: 'queued',
      availableAt: args.observedAt + decision.delayMs,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      consecutiveFailures,
      failureStartedAt,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_lifecycle_get_failed',
      category: args.category,
      consecutiveFailures,
      observedAt: args.observedAt,
    })
    console.warn('PayTo lifecycle reconciliation GET failed', {
      payToAgreementId: agreement._id,
      category: args.category,
      consecutiveFailures,
      nextAttemptAt: args.observedAt + decision.delayMs,
      reviewRequired: decision.kind === 'review',
    })
    if (decision.kind === 'review') {
      console.error('PayTo lifecycle tracking needs review', {
        payToAgreementId: agreement._id,
        category: args.category,
        consecutiveFailures,
      })
    }
    return true
  },
})

export const recordHistory = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    observedAt: v.number(),
    result: v.union(
      v.object({
        kind: v.literal('success'),
        eventCount: v.number(),
        eventTypes: v.array(v.string()),
        latestProviderPublishedAt: v.optional(v.number()),
      }),
      v.object({
        kind: v.literal('failure'),
        category: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) return null
    if (args.result.kind === 'success') {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'provider_history_investigated',
        eventCount: args.result.eventCount,
        eventTypes: args.result.eventTypes,
        latestProviderPublishedAt: args.result.latestProviderPublishedAt,
        observedAt: args.observedAt,
      })
    } else {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'provider_history_investigation_failed',
        category: args.result.category,
        observedAt: args.observedAt,
      })
      console.warn('PayTo lifecycle history investigation failed', {
        payToAgreementId: agreement._id,
        category: args.result.category,
      })
    }
    return null
  },
})

export const dispatchDue = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now()
    const due = await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .withIndex('by_state_and_availableAt', (q) =>
        q.eq('state', 'queued').lte('availableAt', nowMs),
      )
      .take(50)
    const expired = await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .withIndex('by_state_and_leaseExpiresAt', (q) =>
        q.eq('state', 'running').lte('leaseExpiresAt', nowMs),
      )
      .take(Math.max(0, 50 - due.length))
    const oldestAvailableAt = due.at(0)?.availableAt
    if (
      oldestAvailableAt !== undefined &&
      nowMs - oldestAvailableAt >= 5 * 60_000
    ) {
      console.warn('PayTo lifecycle reconciliation queue is stale', {
        dueCount: due.length,
        oldestAgeMs: nowMs - oldestAvailableAt,
      })
    }
    for (const workItem of [...due, ...expired]) {
      await ctx.scheduler.runAfter(
        0,
        internal.payToAgreementReconciliation.reconcile,
        { payToAgreementId: workItem.payToAgreementId },
      )
    }
    return due.length + expired.length
  },
})

async function investigateHistory(
  ctx: ActionCtx,
  payToAgreementId: Doc<'payToAgreements'>['_id'],
  providerUid: string,
  client: ReturnType<typeof createEnvironmentZeptoClientFromEnv>,
) {
  try {
    const history = await getAgreementHistoryEvidence(client, providerUid)
    await ctx.runMutation(internal.payToAgreementReconciliation.recordHistory, {
      payToAgreementId,
      observedAt: Date.now(),
      result: { kind: 'success', ...history },
    })
  } catch (error) {
    const providerError =
      error instanceof ZeptoClientError
        ? error
        : { kind: 'unclassified' as const }
    await ctx.runMutation(internal.payToAgreementReconciliation.recordHistory, {
      payToAgreementId,
      observedAt: Date.now(),
      result: {
        kind: 'failure',
        category: normalizedProviderErrorCategory(providerError),
      },
    })
  }
}

export const reconcile = internalAction({
  args: { payToAgreementId: v.id('payToAgreements') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseToken = crypto.randomUUID()
    const input: ClaimResult | null = await ctx.runMutation(
      internal.payToAgreementReconciliation.claimWork,
      {
        payToAgreementId: args.payToAgreementId,
        leaseToken,
        nowMs: Date.now(),
      },
    )
    if (!input) return null

    try {
      const client = createEnvironmentZeptoClientFromEnv(input.environment)
      const { providerState } = await getAgreementLifecycleByUid(
        client,
        input.providerUid,
      )
      const recorded: boolean = await ctx.runMutation(
        internal.payToAgreementReconciliation.recordSuccess,
        {
          payToAgreementId: args.payToAgreementId,
          leaseToken,
          providerState,
          observedAt: Date.now(),
        },
      )
      const investigate =
        !knownProviderStates.has(providerState) ||
        (input.confirmedTerminalState !== undefined &&
          input.confirmedTerminalState !== providerState)
      if (recorded && investigate) {
        await investigateHistory(
          ctx,
          args.payToAgreementId,
          input.providerUid,
          client,
        )
      }
    } catch (error) {
      const providerError =
        error instanceof ZeptoClientError
          ? error
          : { kind: 'unclassified' as const }
      const recorded: boolean = await ctx.runMutation(
        internal.payToAgreementReconciliation.recordFailure,
        {
          payToAgreementId: args.payToAgreementId,
          leaseToken,
          category: normalizedProviderErrorCategory(providerError),
          observedAt: Date.now(),
        },
      )
      if (!recorded) return null
    }
    return null
  },
})
