import type { Infer } from 'convex/values'
import { ConvexError, v } from 'convex/values'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalAction, internalMutation } from './_generated/server'
import { agreementCreationPool } from './lib/agreementCreationPool'
import { decryptPaymentDestination } from './lib/paymentDestinationCrypto'
import { createAgreement, getAgreementByUid } from './lib/zepto/agreement'
import { createSandboxZeptoClientFromEnv } from './lib/zepto/env'
import { ZeptoClientError } from './lib/zepto/error'
import {
  canRecordLeaseOutcome,
  claimDecision,
  creationFailureKind,
  creationStateForPostFailure,
  decideAfterNotFound,
  decideAfterVerificationFailure,
  isLegalCreationTransition,
  normalizedProviderErrorCategory,
  recoveryClassForProviderError,
} from './payToAgreementCreationState'
import {
  providerAgreementStateValidator,
  routingSnapshotValidator,
} from './validators/payToAgreements'

const LEASE_DURATION_MS = 3 * 60_000

type CurrentFailureKind = NonNullable<
  Doc<'payToAgreements'>['currentFailure']
>['kind']

function currentFailure(kind: CurrentFailureKind, observedAt: number) {
  return { kind, observedAt }
}

function postFailureProjection(
  state: ReturnType<typeof creationStateForPostFailure>,
  observedAt: number,
) {
  const failure = (trackingState: 'checking' | 'retrying') => {
    const kind = creationFailureKind(state, trackingState)
    if (!kind) unavailable()
    return currentFailure(kind, observedAt)
  }
  switch (state) {
    case 'verifying':
      return {
        trackingState: 'checking' as const,
        currentFailure: failure('checking'),
      }
    case 'retry_wait':
      return {
        trackingState: 'retrying' as const,
        currentFailure: failure('retrying'),
      }
    case 'manual_hold':
      return {
        trackingState: 'needs_review' as const,
        currentFailure: currentFailure(creationFailureKind(state)!, observedAt),
      }
    case 'failed':
      return {
        trackingState: 'stopped' as const,
        currentFailure: currentFailure(creationFailureKind(state)!, observedAt),
      }
  }
}

const creationInputValidator = v.object({
  kind: v.union(v.literal('post'), v.literal('verify')),
  leaseToken: v.string(),
  postCycle: v.number(),
  providerUid: v.string(),
  amountCents: v.number(),
  description: v.string(),
  creditorName: v.string(),
  creditorSnapshot: routingSnapshotValidator,
  debtorName: v.string(),
  debtorSnapshot: routingSnapshotValidator,
})
type CreationInput = Infer<typeof creationInputValidator>

function unavailable(): never {
  throw new ConvexError({
    code: 'AGREEMENT_CREATION_UNAVAILABLE',
    message: 'PayTo Agreement creation is temporarily unavailable.',
  })
}

function enforceTransition(
  from: Parameters<typeof isLegalCreationTransition>[0],
  to: Parameters<typeof isLegalCreationTransition>[1],
) {
  if (from !== to && !isLegalCreationTransition(from, to)) unavailable()
}

async function enqueueCreation(
  ctx: MutationCtx,
  payToAgreementId: Id<'payToAgreements'>,
  runAfter: number,
) {
  return await agreementCreationPool.enqueueAction(
    ctx,
    internal.payToAgreementCreation.create,
    { payToAgreementId },
    { retry: false, runAfter },
  )
}

export const claimWork = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    leaseToken: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(creationInputValidator, v.null()),
  handler: async (ctx, args): Promise<CreationInput | null> => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const moneyRequest = await ctx.db.get(
      'moneyRequests',
      agreement.moneyRequestId,
    )
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (!moneyRequest || !workItem) unavailable()

    let state = agreement.creationState
    if (state === 'retry_wait' && workItem.availableAt <= args.nowMs) {
      enforceTransition(state, 'queued')
      state = 'queued'
      await ctx.db.patch('payToAgreements', agreement._id, {
        creationState: 'queued',
        creationUpdatedAt: args.nowMs,
      })
    }
    const decision = claimDecision({
      state,
      nowMs: args.nowMs,
      postCycle: workItem.postCycle ?? 0,
      leaseToken: workItem.leaseToken,
      leaseExpiresAt: workItem.leaseExpiresAt,
    })
    if (decision.kind === 'no_op') return null
    if (decision.kind === 'hold_budget_exhausted') {
      return null
    }

    const leaseExpiresAt = args.nowMs + LEASE_DURATION_MS
    if (decision.kind === 'claim_post') {
      enforceTransition(state, 'submitting')
      await ctx.db.patch('payToAgreements', agreement._id, {
        creationState: 'submitting',
        creationUpdatedAt: args.nowMs,
        trackingState: 'checking',
        trackingUpdatedAt: args.nowMs,
        currentFailure: undefined,
      })
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'creation_attempt_started',
        postCycle: decision.postCycle,
        reservedPostAttempts: decision.reservedPostAttempts,
        observedAt: args.nowMs,
      })
      await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
        state: 'running',
        startedAt: args.nowMs,
        leaseToken: args.leaseToken,
        leaseExpiresAt,
        postCycle: decision.postCycle,
        reservedPostAttempts: decision.reservedPostAttempts,
        verificationAttempt: 0,
        absenceCount: 0,
        lastPostAt: args.nowMs,
      })
    } else {
      enforceTransition(state, 'verifying')
      await ctx.db.patch('payToAgreements', agreement._id, {
        creationState: 'verifying',
        creationUpdatedAt: args.nowMs,
        trackingState: 'checking',
        trackingUpdatedAt: args.nowMs,
        currentFailure: currentFailure(
          'provider_outcome_uncertain',
          args.nowMs,
        ),
      })
      if (decision.recoveredExpiredLease) {
        await ctx.db.insert('payToAgreementEvidence', {
          payToAgreementId: agreement._id,
          kind: 'creation_lease_expired',
          observedAt: args.nowMs,
        })
      }
      await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
        state: 'running',
        startedAt: args.nowMs,
        leaseToken: args.leaseToken,
        leaseExpiresAt,
        ...(decision.recoveredExpiredLease ? { lastPostAt: args.nowMs } : {}),
      })
    }

    await enqueueCreation(ctx, agreement._id, LEASE_DURATION_MS)
    return {
      kind: decision.kind === 'claim_post' ? 'post' : 'verify',
      leaseToken: args.leaseToken,
      postCycle:
        decision.kind === 'claim_post'
          ? decision.postCycle
          : (workItem.postCycle ?? 0),
      providerUid: agreement.providerUid,
      amountCents: moneyRequest.amountCents,
      description: moneyRequest.description,
      creditorName: moneyRequest.requesterNameSnapshot,
      creditorSnapshot: moneyRequest.creditorSnapshot,
      debtorName: agreement.payerNameSnapshot,
      debtorSnapshot: agreement.debtorSnapshot,
    }
  },
})

const createdResultValidator = v.object({
  providerState: providerAgreementStateValidator,
  providerCreatedAt: v.number(),
  providerMmsAgreementId: v.union(v.string(), v.null()),
})
const leasedOutcomeArgsValidator = v.object({
  payToAgreementId: v.id('payToAgreements'),
  leaseToken: v.string(),
  observedAt: v.number(),
})

export const recordHttpPostAttempt = internalMutation({
  args: leasedOutcomeArgsValidator.extend({
    postCycle: v.number(),
    attemptInCycle: v.number(),
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    const lifetimeAttempt = (workItem?.actualPostAttempts ?? 0) + 1
    if (
      !workItem ||
      agreement.creationState !== 'submitting' ||
      workItem.postCycle !== args.postCycle ||
      args.attemptInCycle < 1 ||
      args.attemptInCycle > 3 ||
      lifetimeAttempt > 6 ||
      !canRecordLeaseOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      actualPostAttempts: lifetimeAttempt,
      lastPostAt: args.observedAt,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_http_post_attempted',
      postCycle: args.postCycle,
      attemptInCycle: args.attemptInCycle,
      lifetimeAttempt,
      observedAt: args.observedAt,
    })
    return true
  },
})

export const recordHttpGetAttempt = internalMutation({
  args: leasedOutcomeArgsValidator.extend({
    postCycle: v.number(),
    attemptInRequest: v.number(),
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    const lifetimeAttempt = (workItem?.actualGetAttempts ?? 0) + 1
    if (
      !workItem ||
      agreement.creationState !== 'verifying' ||
      workItem.postCycle !== args.postCycle ||
      args.attemptInRequest < 1 ||
      args.attemptInRequest > 3 ||
      !canRecordLeaseOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      actualGetAttempts: lifetimeAttempt,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_http_get_attempted',
      postCycle: args.postCycle,
      attemptInRequest: args.attemptInRequest,
      lifetimeAttempt,
      observedAt: args.observedAt,
    })
    return true
  },
})

export const recordCreated = internalMutation({
  args: leasedOutcomeArgsValidator.extend({
    result: createdResultValidator,
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (
      !workItem ||
      !canRecordLeaseOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }
    if (agreement.creationState === 'created') return false
    enforceTransition(agreement.creationState, 'created')

    await ctx.db.patch('payToAgreements', agreement._id, {
      creationState: 'created',
      creationUpdatedAt: args.observedAt,
      lifecycleState: args.result.providerState,
      lifecycleConfidence: 'provisional',
      lifecycleObservedAt: args.observedAt,
      trackingState: 'verification_due',
      trackingUpdatedAt: args.observedAt,
      currentFailure: undefined,
      providerCreatedAt: args.result.providerCreatedAt,
      providerMmsAgreementId: args.result.providerMmsAgreementId,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_create_succeeded',
      providerState: args.result.providerState,
      providerCreatedAt: args.result.providerCreatedAt,
      observedAt: args.observedAt,
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'completed',
      completedAt: args.observedAt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    const reconciliationWorkItem = await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (reconciliationWorkItem) {
      await ctx.db.patch(
        'payToAgreementReconciliationWorkItems',
        reconciliationWorkItem._id,
        {
          providerUid: agreement.providerUid,
          state: 'queued',
          availableAt: args.observedAt + 30 * 60_000,
        },
      )
    } else {
      await ctx.db.insert('payToAgreementReconciliationWorkItems', {
        payToAgreementId: agreement._id,
        providerUid: agreement.providerUid,
        state: 'queued',
        availableAt: args.observedAt + 30 * 60_000,
      })
    }
    return true
  },
})

export const recordPostFailure = internalMutation({
  args: leasedOutcomeArgsValidator.extend({
    recoveryClass: v.union(
      v.literal('verify'),
      v.literal('retry'),
      v.literal('hold'),
      v.literal('fail'),
    ),
    category: v.string(),
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (
      !workItem ||
      agreement.creationState !== 'submitting' ||
      !canRecordLeaseOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }

    const nextState = creationStateForPostFailure(
      args.recoveryClass,
      workItem.postCycle ?? 1,
    )
    const nextWorkState =
      nextState === 'verifying' || nextState === 'retry_wait'
        ? 'waiting'
        : nextState === 'manual_hold'
          ? 'held'
          : 'failed'
    const projection = postFailureProjection(nextState, args.observedAt)
    enforceTransition(agreement.creationState, nextState)
    await ctx.db.patch('payToAgreements', agreement._id, {
      creationState: nextState,
      creationUpdatedAt: args.observedAt,
      trackingState: projection.trackingState,
      trackingUpdatedAt: args.observedAt,
      currentFailure: projection.currentFailure,
    })
    const runAfter =
      nextState === 'retry_wait'
        ? 30_000
        : nextState === 'verifying' && (workItem.postCycle ?? 1) >= 2
          ? 15 * 60_000
          : 0
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: nextWorkState,
      availableAt: args.observedAt + runAfter,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      lastPostAt: args.observedAt,
      ...(nextState === 'verifying' && (workItem.postCycle ?? 1) >= 2
        ? { verificationAttempt: 1 }
        : {}),
    })
    if (nextState === 'failed') {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'creation_failed',
        reason: args.category,
        observedAt: args.observedAt,
      })
    } else if (nextState === 'manual_hold') {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'creation_manual_hold',
        reason: args.category,
        observedAt: args.observedAt,
      })
    } else {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind:
          nextState === 'retry_wait'
            ? 'provider_create_temporarily_rejected'
            : 'provider_create_ambiguous',
        category: args.category,
        observedAt: args.observedAt,
      })
    }
    if (nextState === 'verifying' || nextState === 'retry_wait') {
      await enqueueCreation(ctx, agreement._id, runAfter)
    }
    return true
  },
})

export const recordVerificationAbsent = internalMutation({
  args: leasedOutcomeArgsValidator.fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (
      !workItem ||
      agreement.creationState !== 'verifying' ||
      !canRecordLeaseOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }
    const absenceCount = (workItem.absenceCount ?? 0) + 1
    const verificationAttempt = (workItem.verificationAttempt ?? 0) + 1
    const decision = decideAfterNotFound({
      postCycle: workItem.postCycle ?? 1,
      absenceCount,
      verificationAttempt,
      lastPostAt: workItem.lastPostAt ?? args.observedAt,
      nowMs: args.observedAt,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_verification_not_found',
      absenceCount,
      observedAt: args.observedAt,
    })
    if (decision.kind === 'hold') {
      enforceTransition(agreement.creationState, 'manual_hold')
      await ctx.db.patch('payToAgreements', agreement._id, {
        creationState: 'manual_hold',
        creationUpdatedAt: args.observedAt,
        trackingState: 'needs_review',
        trackingUpdatedAt: args.observedAt,
        currentFailure: currentFailure(
          'operator_review_required',
          args.observedAt,
        ),
      })
      await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
        state: 'held',
        absenceCount,
        verificationAttempt,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      })
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'creation_manual_hold',
        reason: 'verification_exhausted_absent',
        observedAt: args.observedAt,
      })
      return true
    }
    const delayMs = decision.kind === 'post_again' ? 0 : decision.delayMs
    const nextState =
      decision.kind === 'post_again' ? 'retry_wait' : 'verifying'
    const nextTrackingState =
      nextState === 'retry_wait' ? ('retrying' as const) : ('checking' as const)
    const failureKind = creationFailureKind(nextState, nextTrackingState)
    if (!failureKind) unavailable()
    enforceTransition(agreement.creationState, nextState)
    await ctx.db.patch('payToAgreements', agreement._id, {
      creationState: nextState,
      creationUpdatedAt: args.observedAt,
      trackingState: nextTrackingState,
      trackingUpdatedAt: args.observedAt,
      currentFailure: currentFailure(failureKind, args.observedAt),
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'waiting',
      availableAt: args.observedAt + delayMs,
      absenceCount,
      verificationAttempt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'creation_retry_scheduled',
      nextAttemptAt: args.observedAt + delayMs,
      observedAt: args.observedAt,
    })
    await enqueueCreation(ctx, agreement._id, delayMs)
    return true
  },
})

export const recordVerificationFailure = internalMutation({
  args: leasedOutcomeArgsValidator.extend({
    category: v.string(),
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (
      !workItem ||
      agreement.creationState !== 'verifying' ||
      !canRecordLeaseOutcome({
        activeToken: workItem.leaseToken,
        presentedToken: args.leaseToken,
        leaseExpiresAt: workItem.leaseExpiresAt,
        nowMs: args.observedAt,
      })
    ) {
      return false
    }
    const verificationAttempt = (workItem.verificationAttempt ?? 0) + 1
    const decision = decideAfterVerificationFailure({
      postCycle: workItem.postCycle ?? 1,
      verificationAttempt,
      lastPostAt: workItem.lastPostAt ?? args.observedAt,
      nowMs: args.observedAt,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_verification_failed',
      category: args.category,
      observedAt: args.observedAt,
    })
    if (decision.kind === 'hold') {
      enforceTransition(agreement.creationState, 'manual_hold')
      await ctx.db.patch('payToAgreements', agreement._id, {
        creationState: 'manual_hold',
        creationUpdatedAt: args.observedAt,
        trackingState: 'needs_review',
        trackingUpdatedAt: args.observedAt,
        currentFailure: currentFailure(
          'operator_review_required',
          args.observedAt,
        ),
      })
      await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
        state: 'held',
        verificationAttempt,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      })
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'creation_manual_hold',
        reason: 'verification_failures_exhausted',
        observedAt: args.observedAt,
      })
      return true
    }
    const delayMs = decision.delayMs
    await ctx.db.patch('payToAgreements', agreement._id, {
      creationUpdatedAt: args.observedAt,
      trackingState: 'retrying',
      trackingUpdatedAt: args.observedAt,
      currentFailure: currentFailure(
        'provider_temporarily_unavailable',
        args.observedAt,
      ),
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'waiting',
      availableAt: args.observedAt + delayMs,
      verificationAttempt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await enqueueCreation(ctx, agreement._id, delayMs)
    return true
  },
})

export const reopenManualHold = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    operatorIdentity: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operatorIdentity = args.operatorIdentity.trim()
    const reason = args.reason.trim()
    if (!operatorIdentity || !reason) unavailable()
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement || agreement.creationState !== 'manual_hold') unavailable()
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (!workItem) unavailable()

    const nowMs = Date.now()
    const absenceEstablished =
      (workItem.absenceCount ?? 0) >= 2 &&
      workItem.postCycle !== undefined &&
      workItem.postCycle < 2 &&
      workItem.lastPostAt !== undefined &&
      nowMs - workItem.lastPostAt >= 5 * 60_000
    const mode = absenceEstablished
      ? ('queued' as const)
      : ('verifying' as const)
    enforceTransition(agreement.creationState, mode)

    await ctx.db.patch('payToAgreements', agreement._id, {
      creationState: mode,
      creationUpdatedAt: nowMs,
      trackingState: mode === 'queued' ? 'retrying' : 'checking',
      trackingUpdatedAt: nowMs,
      currentFailure:
        mode === 'queued'
          ? undefined
          : currentFailure('provider_outcome_uncertain', nowMs),
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'waiting',
      availableAt: nowMs,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'operator_reopened',
      operatorIdentity,
      reason,
      mode,
      observedAt: nowMs,
    })
    await enqueueCreation(ctx, agreement._id, 0)
    return null
  },
})

function normalizedResult(created: {
  state: Infer<typeof providerAgreementStateValidator>
  createdAt: string
  mmsAgreementId: string | null
}) {
  return {
    providerState: created.state,
    providerCreatedAt: Date.parse(created.createdAt),
    providerMmsAgreementId: created.mmsAgreementId,
  }
}

export const create = internalAction({
  args: { payToAgreementId: v.id('payToAgreements') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseToken = crypto.randomUUID()
    const input: CreationInput | null = await ctx.runMutation(
      internal.payToAgreementCreation.claimWork,
      {
        payToAgreementId: args.payToAgreementId,
        leaseToken,
        nowMs: Date.now(),
      },
    )
    if (!input) return null

    if (input.kind === 'verify') {
      try {
        const client = createSandboxZeptoClientFromEnv({
          onAttempt: async ({ method, attempt }) => {
            if (method !== 'GET') return
            const recorded: boolean = await ctx.runMutation(
              internal.payToAgreementCreation.recordHttpGetAttempt,
              {
                payToAgreementId: args.payToAgreementId,
                leaseToken,
                postCycle: input.postCycle,
                attemptInRequest: attempt,
                observedAt: Date.now(),
              },
            )
            if (!recorded) unavailable()
          },
        })
        const found = await getAgreementByUid(client, input.providerUid)
        const recorded: boolean = await ctx.runMutation(
          internal.payToAgreementCreation.recordCreated,
          {
            payToAgreementId: args.payToAgreementId,
            leaseToken,
            result: normalizedResult(found),
            observedAt: Date.now(),
          },
        )
        if (!recorded) return null
      } catch (error) {
        const observedAt = Date.now()
        if (error instanceof ZeptoClientError && error.status === 404) {
          const recorded: boolean = await ctx.runMutation(
            internal.payToAgreementCreation.recordVerificationAbsent,
            { payToAgreementId: args.payToAgreementId, leaseToken, observedAt },
          )
          if (!recorded) return null
        } else {
          const recorded: boolean = await ctx.runMutation(
            internal.payToAgreementCreation.recordVerificationFailure,
            {
              payToAgreementId: args.payToAgreementId,
              leaseToken,
              category: normalizedProviderErrorCategory(
                error instanceof ZeptoClientError
                  ? error
                  : { kind: 'unclassified' },
              ),
              observedAt,
            },
          )
          if (!recorded) return null
        }
      }
      return null
    }

    try {
      const [creditor, debtor] = await Promise.all([
        decryptPaymentDestination({
          type: input.creditorSnapshot.kind,
          ciphertext: input.creditorSnapshot.ciphertext,
          nonce: input.creditorSnapshot.nonce,
          keyVersion: input.creditorSnapshot.keyVersion,
        }),
        decryptPaymentDestination({
          type: input.debtorSnapshot.kind,
          ciphertext: input.debtorSnapshot.ciphertext,
          nonce: input.debtorSnapshot.nonce,
          keyVersion: input.debtorSnapshot.keyVersion,
        }),
      ])
      const client = createSandboxZeptoClientFromEnv({
        onAttempt: async ({ method, attempt }) => {
          if (method !== 'POST') return
          const recorded: boolean = await ctx.runMutation(
            internal.payToAgreementCreation.recordHttpPostAttempt,
            {
              payToAgreementId: args.payToAgreementId,
              leaseToken,
              postCycle: input.postCycle,
              attemptInCycle: attempt,
              observedAt: Date.now(),
            },
          )
          if (!recorded) unavailable()
        },
      })
      const created = await createAgreement(client, {
        providerUid: input.providerUid,
        amountCents: input.amountCents,
        description: input.description,
        creditor: {
          name: input.creditorName,
          accountIdentifier: creditor,
        },
        debtor: {
          name: input.debtorName,
          accountIdentifier: debtor,
        },
      })
      const recorded: boolean = await ctx.runMutation(
        internal.payToAgreementCreation.recordCreated,
        {
          payToAgreementId: args.payToAgreementId,
          leaseToken,
          result: normalizedResult(created),
          observedAt: Date.now(),
        },
      )
      if (!recorded) return null
    } catch (error) {
      const providerError =
        error instanceof ZeptoClientError
          ? error
          : { kind: 'unclassified' as const }
      const recorded: boolean = await ctx.runMutation(
        internal.payToAgreementCreation.recordPostFailure,
        {
          payToAgreementId: args.payToAgreementId,
          leaseToken,
          recoveryClass: recoveryClassForProviderError(providerError),
          category: normalizedProviderErrorCategory(providerError),
          observedAt: Date.now(),
        },
      )
      if (!recorded) return null
    }
    return null
  },
})
