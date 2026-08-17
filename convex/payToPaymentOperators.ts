import type { Infer } from 'convex/values'
import { ConvexError, v } from 'convex/values'

import type { Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'
import {
  requestImmediatePayToPaymentReconciliation,
  requestPayToPaymentResume,
} from './payToPayments'
import { emitPayToPaymentCriticalSignal } from './lib/payToPaymentTelemetry'
import {
  payToPaymentCreationStateValidator,
  payToPaymentEvidenceSourceValidator,
  payToPaymentGateModeValidator,
  payToPaymentOperationClassificationValidator,
  payToPaymentOperationKindValidator,
  payToPaymentOperatorActionValidator,
  payToPaymentOperatorDecisionValidator,
  payToPaymentOperatorReasonValidator,
  payToPaymentOperatorResultCodeValidator,
  providerPayToPaymentStateValidator,
} from './validators/payToPayments'
import { zeptoEnvironmentValidator } from './validators/payToAgreements'

const OVERDUE_WARNING_MS = 5 * 60_000
const DIAGNOSTIC_HISTORY_LIMIT = 20

async function paymentOperatorActor(ctx: Pick<QueryCtx, 'auth' | 'db'>) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    return {
      authentication: 'unauthenticated' as const,
      authorization: 'not_authenticated' as const,
    }
  }
  const user = await ctx.db
    .query('users')
    .withIndex('by_tokenIdentifier', (q) =>
      q.eq('tokenIdentifier', identity.tokenIdentifier),
    )
    .unique()
  if (!user?.roles?.includes('payment_operator')) {
    return {
      authentication: 'authenticated' as const,
      authorization: 'insufficient_role' as const,
      ...(user === null ? {} : { actorUserId: user._id }),
    }
  }
  return {
    authentication: 'authenticated' as const,
    authorization: 'payment_operator' as const,
    actorUserId: user._id,
  }
}

async function requirePaymentOperator(
  ctx: QueryCtx,
  payToPaymentId?: Id<'payToPayments'>,
  observedAt?: number,
) {
  const actor = await paymentOperatorActor(ctx)
  if (actor.authentication === 'unauthenticated') {
    emitPayToPaymentCriticalSignal('unauthorized_operation', {
      payToPaymentId,
      observedAt,
      reason: 'unauthenticated_diagnostics',
    })
    throw new ConvexError({
      code: 'UNAUTHENTICATED',
      message: 'You must be signed in to call this function.',
    })
  }
  if (actor.authorization !== 'payment_operator') {
    emitPayToPaymentCriticalSignal('unauthorized_operation', {
      payToPaymentId,
      observedAt,
      reason: 'insufficient_role_diagnostics',
    })
    throw new ConvexError({
      code: 'FORBIDDEN',
      message: 'The signed-in user is not a Payment operator.',
    })
  }
  return actor
}

const requestResultValidator = v.object({
  decision: payToPaymentOperatorDecisionValidator,
  code: payToPaymentOperatorResultCodeValidator,
})

const diagnosticWorkValidator = v.object({
  state: v.string(),
  availableAt: v.number(),
  retryNumber: v.optional(v.number()),
  operationId: v.optional(v.string()),
  leaseExpiresAt: v.optional(v.number()),
})

const diagnosticResultValidator = v.object({
  gate: v.union(
    v.null(),
    v.object({
      mode: payToPaymentGateModeValidator,
      activatedAt: v.optional(v.number()),
      dailyPaymentCountCap: v.optional(v.number()),
      dailyPaymentValueCapCents: v.optional(v.number()),
      budgetDate: v.optional(v.string()),
      reservedPaymentCount: v.number(),
      reservedPaymentValueCents: v.number(),
      rollout: v.object({
        cohortConfigured: v.boolean(),
        approvalReferenceCount: v.number(),
      }),
    }),
  ),
  certification: v.object({
    configured: v.boolean(),
    certifiedCommit: v.union(v.string(), v.null()),
    configurationFingerprint: v.union(v.string(), v.null()),
    apiVersion: v.literal('20260101'),
    environment: zeptoEnvironmentValidator,
  }),
  identity: v.object({
    payToPaymentId: v.id('payToPayments'),
    payToAgreementId: v.id('payToAgreements'),
    moneyRequestId: v.id('moneyRequests'),
    payerUserId: v.id('users'),
    providerUid: v.string(),
    environment: zeptoEnvironmentValidator,
  }),
  lifecycle: v.object({
    creationState: payToPaymentCreationStateValidator,
    state: v.optional(providerPayToPaymentStateValidator),
    observedAt: v.optional(v.number()),
  }),
  verification: v.object({
    pending: v.boolean(),
    lastReconciledAt: v.optional(v.number()),
    consecutiveFailures: v.number(),
    lastSuccessAt: v.optional(v.number()),
  }),
  attention: v.object({
    payment: v.union(
      v.null(),
      v.object({
        kind: v.string(),
        reason: v.optional(v.string()),
        observedAt: v.number(),
      }),
    ),
    operationalAlert: v.union(
      v.null(),
      v.object({ kind: v.string(), observedAt: v.number() }),
    ),
  }),
  work: v.object({
    creation: v.union(v.null(), diagnosticWorkValidator),
    reconciliation: v.union(v.null(), diagnosticWorkValidator),
    retry: v.union(v.null(), diagnosticWorkValidator),
  }),
  lease: v.object({ activeCount: v.number(), expiredCount: v.number() }),
  budget: v.object({
    createPostAttempts: v.number(),
    createRecoveryCycles: v.number(),
    retryEndpointCalls: v.number(),
    possiblyAcceptedRetrySubmissions: v.number(),
    rolling24HourSubmissions: v.number(),
  }),
  evidence: v.array(
    v.object({
      source: payToPaymentEvidenceSourceValidator,
      operationId: v.optional(v.string()),
      operationKind: v.optional(payToPaymentOperationKindValidator),
      classification: v.optional(payToPaymentOperationClassificationValidator),
      providerState: v.optional(v.string()),
      providerFailureCode: v.optional(v.string()),
      providerFailureRetryable: v.optional(v.boolean()),
      errorCategory: v.optional(v.string()),
      outcome: v.optional(v.string()),
      deliveryId: v.optional(v.string()),
      providerEventId: v.optional(v.string()),
      eventType: v.optional(v.string()),
      observedAt: v.number(),
    }),
  ),
  webhook: v.object({
    observedCount: v.number(),
    lastObservedAt: v.optional(v.number()),
    deduplicationOutcomes: v.array(
      v.object({
        outcome: v.union(
          v.literal('duplicate_delivery'),
          v.literal('duplicate_event'),
        ),
        deliveryId: v.string(),
        providerEventId: v.optional(v.string()),
        observedAt: v.number(),
      }),
    ),
  }),
  dueWork: v.object({
    nextDueAt: v.optional(v.number()),
    overdue: v.boolean(),
    overdueByMs: v.number(),
  }),
  operatorActions: v.array(
    v.object({
      actorUserId: v.optional(v.id('users')),
      authentication: v.union(
        v.literal('authenticated'),
        v.literal('unauthenticated'),
      ),
      authorization: v.union(
        v.literal('payment_operator'),
        v.literal('insufficient_role'),
        v.literal('not_authenticated'),
      ),
      action: payToPaymentOperatorActionValidator,
      reason: payToPaymentOperatorReasonValidator,
      decision: payToPaymentOperatorDecisionValidator,
      resultCode: payToPaymentOperatorResultCodeValidator,
      requestedAt: v.number(),
    }),
  ),
})

type OperatorReason = Infer<typeof payToPaymentOperatorReasonValidator>
type OperatorResult = Infer<typeof requestResultValidator>
type OperatorPolicy = (
  ctx: MutationCtx,
  args: { payToPaymentId: Id<'payToPayments'>; observedAt: number },
) => Promise<OperatorResult>

async function auditedOperatorRequest(
  ctx: MutationCtx,
  args: {
    payToPaymentId: Id<'payToPayments'>
    reason: OperatorReason
    action: 'request_reconciliation' | 'request_resume'
    policy: OperatorPolicy
  },
) {
  const requestedAt = Date.now()
  const actor = await paymentOperatorActor(ctx)
  const result: OperatorResult =
    actor.authorization === 'not_authenticated'
      ? { decision: 'refused', code: 'unauthenticated' }
      : actor.authorization === 'insufficient_role'
        ? { decision: 'refused', code: 'insufficient_role' }
        : await args.policy(ctx, {
            payToPaymentId: args.payToPaymentId,
            observedAt: requestedAt,
          })
  await ctx.db.insert('payToPaymentOperatorActions', {
    payToPaymentId: args.payToPaymentId,
    ...actor,
    action: args.action,
    reason: args.reason,
    decision: result.decision,
    resultCode: result.code,
    requestedAt,
  })
  if (
    result.code === 'unauthenticated' ||
    result.code === 'insufficient_role'
  ) {
    emitPayToPaymentCriticalSignal('unauthorized_operation', {
      payToPaymentId: args.payToPaymentId,
      observedAt: requestedAt,
      reason: result.code,
    })
  }
  return result
}

async function paymentWork(ctx: QueryCtx, payToPaymentId: Id<'payToPayments'>) {
  return await ctx.db
    .query('payToPaymentWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', payToPaymentId),
    )
    .unique()
}

async function reconciliationWork(
  ctx: QueryCtx,
  payToPaymentId: Id<'payToPayments'>,
) {
  return await ctx.db
    .query('payToPaymentReconciliationWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', payToPaymentId),
    )
    .unique()
}

async function retryWork(ctx: QueryCtx, payToPaymentId: Id<'payToPayments'>) {
  return await ctx.db
    .query('payToPaymentRetryWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', payToPaymentId),
    )
    .unique()
}

function workSummary(
  work:
    | Awaited<ReturnType<typeof paymentWork>>
    | Awaited<ReturnType<typeof reconciliationWork>>
    | Awaited<ReturnType<typeof retryWork>>,
) {
  if (!work) return null
  return {
    state: work.state,
    availableAt: work.availableAt,
    ...('retryNumber' in work ? { retryNumber: work.retryNumber } : {}),
    ...(work.operationId === undefined
      ? {}
      : { operationId: work.operationId }),
    ...(work.leaseExpiresAt === undefined
      ? {}
      : { leaseExpiresAt: work.leaseExpiresAt }),
  }
}

export const diagnostics = query({
  args: {
    payToPaymentId: v.id('payToPayments'),
    nowMs: v.number(),
  },
  returns: diagnosticResultValidator,
  handler: async (ctx, args) => {
    await requirePaymentOperator(ctx, args.payToPaymentId, args.nowMs)
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    if (!payment) {
      throw new ConvexError({
        code: 'NOT_FOUND',
        message: 'PayTo Payment was not found.',
      })
    }
    const [
      gate,
      createWork,
      getWork,
      retry,
      operations,
      evidence,
      operatorActions,
      createBudgetOperations,
      retryBudgetOperations,
      rollingCreateSubmissions,
      rollingRetrySubmissions,
      webhookDeduplication,
    ] = await Promise.all([
      ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) =>
          q.eq('environment', payment.environment),
        )
        .unique(),
      paymentWork(ctx, payment._id),
      reconciliationWork(ctx, payment._id),
      retryWork(ctx, payment._id),
      ctx.db
        .query('payToPaymentOperations')
        .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
          q.eq('payToPaymentId', payment._id),
        )
        .order('desc')
        .take(DIAGNOSTIC_HISTORY_LIMIT),
      ctx.db
        .query('payToPaymentEvidence')
        .withIndex('by_payToPaymentId_and_observedAt', (q) =>
          q.eq('payToPaymentId', payment._id),
        )
        .order('desc')
        .take(DIAGNOSTIC_HISTORY_LIMIT),
      ctx.db
        .query('payToPaymentOperatorActions')
        .withIndex('by_payToPaymentId_and_requestedAt', (q) =>
          q.eq('payToPaymentId', payment._id),
        )
        .order('desc')
        .take(DIAGNOSTIC_HISTORY_LIMIT),
      ctx.db
        .query('payToPaymentOperations')
        .withIndex(
          'by_payToPaymentId_and_operationKind_and_authorizedAt',
          (q) =>
            q.eq('payToPaymentId', payment._id).eq('operationKind', 'create'),
        )
        .order('desc')
        .take(4),
      ctx.db
        .query('payToPaymentOperations')
        .withIndex(
          'by_payToPaymentId_and_operationKind_and_authorizedAt',
          (q) =>
            q.eq('payToPaymentId', payment._id).eq('operationKind', 'retry'),
        )
        .order('desc')
        .take(7),
      ctx.db
        .query('payToPaymentOperations')
        .withIndex(
          'by_payToPaymentId_and_operationKind_and_authorizedAt',
          (q) =>
            q
              .eq('payToPaymentId', payment._id)
              .eq('operationKind', 'create')
              .gte('authorizedAt', args.nowMs - 24 * 60 * 60_000),
        )
        .take(4),
      ctx.db
        .query('payToPaymentOperations')
        .withIndex(
          'by_payToPaymentId_and_operationKind_and_authorizedAt',
          (q) =>
            q
              .eq('payToPaymentId', payment._id)
              .eq('operationKind', 'retry')
              .gte('authorizedAt', args.nowMs - 24 * 60 * 60_000),
        )
        .take(7),
      ctx.db
        .query('payToPaymentWebhookDeduplication')
        .withIndex('by_payToPaymentId_and_observedAt', (q) =>
          q.eq('payToPaymentId', payment._id),
        )
        .order('desc')
        .take(DIAGNOSTIC_HISTORY_LIMIT),
    ])
    const webhookEvidence = evidence.filter(
      ({ source }) => source === 'webhook',
    )
    const leaseEvidence = operations.filter(
      ({ leaseExpiresAt }) => leaseExpiresAt !== undefined,
    )
    const possiblyAcceptedRetrySubmissions = retryBudgetOperations.filter(
      (operation) =>
        operation.dispatchCertainty === 'possibly_dispatched' &&
        operation.outcome?.classification !== 'refused',
    ).length
    const rolling24HourSubmissions = [
      ...rollingCreateSubmissions,
      ...rollingRetrySubmissions,
    ].filter(
      (operation) =>
        operation.dispatchCertainty === 'possibly_dispatched' &&
        operation.outcome?.classification !== 'refused',
    ).length
    const dueTimes = [createWork, getWork, retry]
      .filter((work) => work?.state === 'queued' || work?.state === 'running')
      .map((work) => work!.availableAt)
    const nextDueAt = dueTimes.length === 0 ? undefined : Math.min(...dueTimes)
    const overdueByMs =
      nextDueAt === undefined ? 0 : Math.max(0, args.nowMs - nextDueAt)
    const attention = payment.attention

    return {
      gate:
        gate === null
          ? null
          : {
              mode: gate.mode,
              ...(gate.activatedAt === undefined
                ? {}
                : { activatedAt: gate.activatedAt }),
              ...(gate.dailyPaymentCountCap === undefined
                ? {}
                : { dailyPaymentCountCap: gate.dailyPaymentCountCap }),
              ...(gate.dailyPaymentValueCapCents === undefined
                ? {}
                : {
                    dailyPaymentValueCapCents: gate.dailyPaymentValueCapCents,
                  }),
              ...(gate.budgetDate === undefined
                ? {}
                : { budgetDate: gate.budgetDate }),
              reservedPaymentCount: gate.reservedPaymentCount ?? 0,
              reservedPaymentValueCents: gate.reservedPaymentValueCents ?? 0,
              rollout: {
                cohortConfigured: false,
                approvalReferenceCount: 0,
              },
            },
      certification: {
        configured: false,
        certifiedCommit: null,
        configurationFingerprint: null,
        apiVersion: payment.intent.apiVersion,
        environment: payment.environment,
      },
      identity: {
        payToPaymentId: payment._id,
        payToAgreementId: payment.payToAgreementId,
        moneyRequestId: payment.moneyRequestId,
        payerUserId: payment.payerUserId,
        providerUid: payment.providerUid,
        environment: payment.environment,
      },
      lifecycle: {
        creationState: payment.creationState,
        ...(payment.lifecycleState === undefined
          ? {}
          : { state: payment.lifecycleState }),
        ...(payment.lifecycleObservedAt === undefined
          ? {}
          : { observedAt: payment.lifecycleObservedAt }),
      },
      verification: {
        pending: getWork?.state === 'queued' || getWork?.state === 'running',
        ...(payment.lastReconciledAt === undefined
          ? {}
          : { lastReconciledAt: payment.lastReconciledAt }),
        consecutiveFailures: getWork?.consecutiveFailures ?? 0,
        ...(getWork?.lastSuccessAt === undefined
          ? {}
          : { lastSuccessAt: getWork.lastSuccessAt }),
      },
      attention: {
        payment:
          attention === undefined
            ? null
            : {
                kind: attention.kind,
                ...('reason' in attention ? { reason: attention.reason } : {}),
                observedAt: attention.observedAt,
              },
        operationalAlert: payment.reconciliationAlert ?? null,
      },
      work: {
        creation: workSummary(createWork),
        reconciliation: workSummary(getWork),
        retry: workSummary(retry),
      },
      lease: {
        activeCount: leaseEvidence.filter(
          ({ leaseExpiresAt }) => leaseExpiresAt! >= args.nowMs,
        ).length,
        expiredCount: leaseEvidence.filter(
          ({ leaseExpiresAt }) => leaseExpiresAt! < args.nowMs,
        ).length,
      },
      budget: {
        createPostAttempts: createBudgetOperations.filter(
          ({ dispatchStartedAt }) => dispatchStartedAt !== undefined,
        ).length,
        createRecoveryCycles: payment.creationRecovery?.recoveryCycles ?? 0,
        retryEndpointCalls: retryBudgetOperations.filter(
          ({ dispatchStartedAt }) => dispatchStartedAt !== undefined,
        ).length,
        possiblyAcceptedRetrySubmissions,
        rolling24HourSubmissions,
      },
      evidence: evidence.map((item) => ({
        source: item.source,
        ...(item.operationId === undefined
          ? {}
          : { operationId: item.operationId }),
        ...(item.operationKind === undefined
          ? {}
          : { operationKind: item.operationKind }),
        ...(item.classification === undefined
          ? {}
          : { classification: item.classification }),
        ...(item.providerState === undefined
          ? {}
          : { providerState: item.providerState }),
        ...(item.providerFailureCode === undefined
          ? {}
          : { providerFailureCode: item.providerFailureCode }),
        ...(item.providerFailureRetryable === undefined
          ? {}
          : { providerFailureRetryable: item.providerFailureRetryable }),
        ...(item.errorCategory === undefined
          ? {}
          : { errorCategory: item.errorCategory }),
        ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
        ...(item.deliveryId === undefined
          ? {}
          : { deliveryId: item.deliveryId }),
        ...(item.providerEventId === undefined
          ? {}
          : { providerEventId: item.providerEventId }),
        ...(item.eventType === undefined ? {} : { eventType: item.eventType }),
        observedAt: item.observedAt,
      })),
      webhook: {
        observedCount: webhookEvidence.length,
        ...(webhookEvidence.at(0) === undefined
          ? {}
          : { lastObservedAt: webhookEvidence[0].observedAt }),
        deduplicationOutcomes: webhookDeduplication.map((item) => ({
          outcome: item.outcome,
          deliveryId: item.deliveryId,
          ...(item.providerEventId === undefined
            ? {}
            : { providerEventId: item.providerEventId }),
          observedAt: item.observedAt,
        })),
      },
      dueWork: {
        ...(nextDueAt === undefined ? {} : { nextDueAt }),
        overdue: overdueByMs > OVERDUE_WARNING_MS,
        overdueByMs,
      },
      operatorActions: operatorActions.map((action) => ({
        ...(action.actorUserId === undefined
          ? {}
          : { actorUserId: action.actorUserId }),
        authentication: action.authentication,
        authorization: action.authorization,
        action: action.action,
        reason: action.reason,
        decision: action.decision,
        resultCode: action.resultCode,
        requestedAt: action.requestedAt,
      })),
    }
  },
})

export const requestReconciliation = mutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    reason: payToPaymentOperatorReasonValidator,
  },
  returns: requestResultValidator,
  handler: async (ctx, args) =>
    await auditedOperatorRequest(ctx, {
      ...args,
      action: 'request_reconciliation',
      policy: requestImmediatePayToPaymentReconciliation,
    }),
})

export const requestResume = mutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    reason: payToPaymentOperatorReasonValidator,
  },
  returns: requestResultValidator,
  handler: async (ctx, args) =>
    await auditedOperatorRequest(ctx, {
      ...args,
      action: 'request_resume',
      policy: requestPayToPaymentResume,
    }),
})
