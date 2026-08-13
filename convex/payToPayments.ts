import { v7 as uuid } from 'uuid'
import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { paymentCreationPool } from './lib/paymentCreationPool'
import { projectPayerPayment } from './lib/payToPaymentProjection'
import type { PayToPaymentGateMode } from './validators/payToPayments'
import {
  payToPaymentCreateErrorCategoryValidator,
  payToPaymentEvidenceSourceValidator,
  payToPaymentIntentValidator,
  payToPaymentOperationClassificationValidator,
  payToPaymentOperationKindValidator,
  providerPayToPaymentStateValidator,
} from './validators/payToPayments'

const ensureResultValidator = v.union(
  v.object({
    kind: v.literal('created'),
    payToPaymentId: v.id('payToPayments'),
  }),
  v.object({
    kind: v.literal('matched'),
    payToPaymentId: v.id('payToPayments'),
  }),
  v.object({
    kind: v.literal('mismatch'),
    payToPaymentId: v.id('payToPayments'),
  }),
  v.object({
    kind: v.literal('ineligible'),
    reason: v.union(
      v.literal('agreement_not_eligible'),
      v.literal('gate_disabled'),
      v.literal('gate_reconcile_only'),
      v.literal('production_not_enabled'),
    ),
  }),
)

const CREATE_LEASE_DURATION_MS = 3 * 60_000

type PaymentOperationKind = Infer<typeof payToPaymentOperationKindValidator>

const intentReferenceResultValidator = v.union(
  v.object({ kind: v.literal('accepted') }),
  v.object({ kind: v.literal('mismatch') }),
  v.object({ kind: v.literal('not_found') }),
)

const authorizeOperationResultValidator = v.union(
  v.object({
    kind: v.literal('authorized'),
    operationKind: payToPaymentOperationKindValidator,
    operationId: v.string(),
    payToPaymentId: v.id('payToPayments'),
    providerUid: v.string(),
    intent: payToPaymentIntentValidator,
  }),
  v.object({ kind: v.literal('mismatch') }),
  v.object({
    kind: v.literal('denied'),
    reason: v.union(
      v.literal('payment_not_found'),
      v.literal('attention_required'),
      v.literal('gate_disabled'),
      v.literal('gate_reconcile_only'),
      v.literal('production_not_enabled'),
      v.literal('operation_not_allowed'),
    ),
  }),
)

type PaymentIntent = Infer<typeof payToPaymentIntentValidator>

function moneyMovingDenial(
  mode: PayToPaymentGateMode | undefined,
  environment: Doc<'payToAgreements'>['environment'],
) {
  if (mode === undefined || mode === 'disabled') {
    return 'gate_disabled' as const
  }
  if (mode === 'reconcile_only') return 'gate_reconcile_only' as const
  if (environment !== 'sandbox') return 'production_not_enabled' as const
}

function bytesToBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function routingSnapshotSource(
  snapshot:
    | Doc<'moneyRequests'>['creditorSnapshot']
    | Doc<'payToAgreements'>['debtorSnapshot'],
) {
  return [
    snapshot.kind,
    snapshot.maskedDisplay,
    snapshot.ciphertext,
    snapshot.nonce,
    snapshot.keyVersion,
  ]
}

async function fingerprintIntent(
  agreement: Doc<'payToAgreements'>,
  moneyRequest: Doc<'moneyRequests'>,
) {
  const source = JSON.stringify([
    1,
    agreement._id,
    agreement.moneyRequestId,
    agreement.payerUserId,
    agreement.environment,
    agreement.providerUid,
    moneyRequest.amountCents,
    moneyRequest.currency,
    'unattended',
    agreement.apiVersion,
    moneyRequest.sourceCreditorPaymentDestinationId,
    agreement.sourceDebtorPaymentDestinationId,
    routingSnapshotSource(moneyRequest.creditorSnapshot),
    routingSnapshotSource(agreement.debtorSnapshot),
  ])
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return bytesToBase64Url(new Uint8Array(digest))
}

async function fingerprintCreateRequest(input: {
  providerUid: string
  agreementProviderUid: string
  amountCents: number
  priority: 'unattended'
}) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        1,
        input.providerUid,
        input.agreementProviderUid,
        input.amountCents,
        input.priority,
      ]),
    ),
  )
  return bytesToBase64Url(new Uint8Array(digest))
}

async function intentFor(
  agreement: Doc<'payToAgreements'>,
  moneyRequest: Doc<'moneyRequests'>,
): Promise<PaymentIntent> {
  return {
    agreementProviderUid: agreement.providerUid,
    amount: { cents: moneyRequest.amountCents, currency: 'AUD' },
    routing: {
      sourceCreditorPaymentDestinationId:
        moneyRequest.sourceCreditorPaymentDestinationId,
      sourceDebtorPaymentDestinationId:
        agreement.sourceDebtorPaymentDestinationId,
      creditorSnapshot: moneyRequest.creditorSnapshot,
      debtorSnapshot: agreement.debtorSnapshot,
    },
    priority: 'unattended',
    apiVersion: agreement.apiVersion,
    fingerprint: await fingerprintIntent(agreement, moneyRequest),
  }
}

async function allocateProviderUid(
  ctx: Pick<MutationCtx, 'db'>,
  environment: Doc<'payToAgreements'>['environment'],
  establishedAt: number,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const providerUid = uuid({ msecs: establishedAt })
    const collision = await ctx.db
      .query('payToPayments')
      .withIndex('by_environment_and_providerUid', (q) =>
        q.eq('environment', environment).eq('providerUid', providerUid),
      )
      .unique()
    if (!collision) return providerUid
  }
  throw new Error('Could not allocate a unique PayTo Payment UID')
}

async function allocateOperationId(
  ctx: Pick<MutationCtx, 'db'>,
  observedAt: number,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const operationId = uuid({ msecs: observedAt })
    const collision = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_operationId', (q) => q.eq('operationId', operationId))
      .unique()
    if (!collision) return operationId
  }
  throw new Error('Could not allocate a unique PayTo Payment operation ID')
}

async function recordIntentMismatch(
  ctx: MutationCtx,
  payment: Doc<'payToPayments'>,
  agreement: Doc<'payToAgreements'>,
  observedFingerprint: string,
  observedAt: number,
) {
  if (
    agreement.paymentStatus === undefined ||
    agreement.paymentVerificationPending === undefined
  ) {
    throw new Error('PayTo Payment projection invariant failed')
  }
  await ctx.db.patch('payToPayments', payment._id, {
    creationState: 'creation_attention_required',
    attention: {
      kind: 'intent_fingerprint_mismatch',
      expectedFingerprint: payment.intent.fingerprint,
      observedFingerprint,
      observedAt,
    },
  })
  await projectPayerPayment(ctx, agreement, {
    paymentStatus: agreement.paymentStatus,
    paymentVerificationPending: agreement.paymentVerificationPending,
    paymentAttentionRequired: true,
  })
  console.error('PayTo Payment immutable intent mismatch', {
    payToAgreementId: agreement._id,
    payToPaymentId: payment._id,
  })
}

export async function ensurePayToPayment(
  ctx: MutationCtx,
  args: {
    payToAgreementId: Id<'payToAgreements'>
    observedAt: number
  },
) {
  const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
  if (!agreement) {
    return {
      kind: 'ineligible' as const,
      reason: 'agreement_not_eligible' as const,
    }
  }
  const moneyRequest = await ctx.db.get(
    'moneyRequests',
    agreement.moneyRequestId,
  )
  if (!moneyRequest) throw new Error('PayTo Payment invariant failed')
  const intent = await intentFor(agreement, moneyRequest)
  const existing = await ctx.db
    .query('payToPayments')
    .withIndex('by_payToAgreementId', (q) =>
      q.eq('payToAgreementId', agreement._id),
    )
    .unique()

  if (existing) {
    if (existing.intent.fingerprint === intent.fingerprint) {
      return { kind: 'matched' as const, payToPaymentId: existing._id }
    }
    await recordIntentMismatch(
      ctx,
      existing,
      agreement,
      intent.fingerprint,
      args.observedAt,
    )
    return { kind: 'mismatch' as const, payToPaymentId: existing._id }
  }

  if (
    agreement.activationProvenancePolicy !== 'track_first_confirmation' ||
    agreement.firstConfirmedActiveAt === undefined ||
    agreement.lifecycleState !== 'active' ||
    agreement.lifecycleConfidence !== 'confirmed'
  ) {
    return {
      kind: 'ineligible' as const,
      reason: 'agreement_not_eligible' as const,
    }
  }
  const gate = await ctx.db
    .query('payToPaymentRuntimeGates')
    .withIndex('by_environment', (q) =>
      q.eq('environment', agreement.environment),
    )
    .unique()
  const denial = moneyMovingDenial(gate?.mode, agreement.environment)
  if (denial !== undefined) {
    return {
      kind: 'ineligible' as const,
      reason: denial,
    }
  }
  const activatedAt = gate?.activatedAt
  if (
    activatedAt === undefined ||
    agreement.firstConfirmedActiveAt < activatedAt
  ) {
    return {
      kind: 'ineligible' as const,
      reason: 'agreement_not_eligible' as const,
    }
  }

  const providerUid = await allocateProviderUid(
    ctx,
    agreement.environment,
    agreement.firstConfirmedActiveAt,
  )
  const payToPaymentId = await ctx.db.insert('payToPayments', {
    payToAgreementId: agreement._id,
    moneyRequestId: agreement.moneyRequestId,
    payerUserId: agreement.payerUserId,
    environment: agreement.environment,
    providerUid,
    intent,
    creationState: 'create_pending',
    establishedAt: agreement.firstConfirmedActiveAt,
  })
  const workItemId = await ctx.db.insert('payToPaymentWorkItems', {
    payToPaymentId,
    kind: 'create',
    state: 'queued',
    availableAt: args.observedAt,
  })
  const workId = await paymentCreationPool.enqueueAction(
    ctx,
    internal.payToPaymentCreation.create,
    { payToPaymentId },
    { retry: false },
  )
  await ctx.db.patch('payToPaymentWorkItems', workItemId, { workId })
  await projectPayerPayment(ctx, agreement, {
    paymentStatus: 'initiating',
    paymentVerificationPending: false,
    paymentAttentionRequired: false,
  })
  return { kind: 'created' as const, payToPaymentId }
}

export const ensure = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    observedAt: v.number(),
  },
  returns: ensureResultValidator,
  handler: ensurePayToPayment,
})

const createWorkValidator = v.object({
  kind: v.literal('create'),
  operationId: v.string(),
  payToPaymentId: v.id('payToPayments'),
  providerUid: v.string(),
  agreementProviderUid: v.string(),
  amountCents: v.number(),
  priority: v.literal('unattended'),
  intentFingerprint: v.string(),
  requestFingerprint: v.string(),
  environment: v.union(v.literal('sandbox'), v.literal('production')),
  leaseToken: v.string(),
  leaseExpiresAt: v.number(),
})
type CreateWork = Infer<typeof createWorkValidator>

async function createWorkItem(
  ctx: MutationCtx,
  payToPaymentId: Id<'payToPayments'>,
) {
  return await ctx.db
    .query('payToPaymentWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', payToPaymentId),
    )
    .unique()
}

function leaseAuthorizes(
  workItem: Doc<'payToPaymentWorkItems'>,
  leaseToken: string,
  observedAt: number,
) {
  return (
    workItem.state === 'running' &&
    workItem.leaseToken === leaseToken &&
    workItem.leaseExpiresAt !== undefined &&
    workItem.leaseExpiresAt >= observedAt
  )
}

function utcBudgetDate(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export const claimCreateWork = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    leaseToken: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(createWorkValidator, v.null()),
  handler: async (ctx, args): Promise<CreateWork | null> => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    if (!payment || payment.creationState !== 'create_pending') return null
    const workItem = await createWorkItem(ctx, payment._id)
    if (
      !workItem ||
      workItem.state !== 'queued' ||
      workItem.availableAt > args.nowMs
    ) {
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
    if (!gate) return null

    const budgetDate = utcBudgetDate(args.nowMs)
    const existingCount =
      gate.budgetDate === budgetDate ? (gate.reservedPaymentCount ?? 0) : 0
    const existingValue =
      gate.budgetDate === budgetDate ? (gate.reservedPaymentValueCents ?? 0) : 0
    const reservedPaymentCount = existingCount + 1
    const reservedPaymentValueCents =
      existingValue + payment.intent.amount.cents
    if (
      (gate.dailyPaymentCountCap !== undefined &&
        reservedPaymentCount > gate.dailyPaymentCountCap) ||
      (gate.dailyPaymentValueCapCents !== undefined &&
        reservedPaymentValueCents > gate.dailyPaymentValueCapCents)
    ) {
      return null
    }

    const operationId = await allocateOperationId(ctx, args.nowMs)
    const request = {
      providerUid: payment.providerUid,
      agreementProviderUid: payment.intent.agreementProviderUid,
      amountCents: payment.intent.amount.cents,
      priority: payment.intent.priority,
    }
    const requestFingerprint = await fingerprintCreateRequest(request)
    const leaseExpiresAt = args.nowMs + CREATE_LEASE_DURATION_MS
    await ctx.db.patch('payToPaymentRuntimeGates', gate._id, {
      budgetDate,
      reservedPaymentCount,
      reservedPaymentValueCents,
    })
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId: payment._id,
      operationId,
      operationKind: 'create',
      intentFingerprint: payment.intent.fingerprint,
      requestFingerprint,
      authorizedAt: args.nowMs,
      leaseToken: args.leaseToken,
      leaseExpiresAt,
    })
    await ctx.db.patch('payToPayments', payment._id, {
      creationState: 'creation_uncertain',
    })
    await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
      state: 'running',
      leaseToken: args.leaseToken,
      leaseExpiresAt,
      operationId,
    })
    return {
      kind: 'create',
      operationId,
      payToPaymentId: payment._id,
      ...request,
      intentFingerprint: payment.intent.fingerprint,
      requestFingerprint,
      environment: payment.environment,
      leaseToken: args.leaseToken,
      leaseExpiresAt,
    }
  },
})

const createAttemptArgsValidator = v.object({
  payToPaymentId: v.id('payToPayments'),
  operationId: v.string(),
  leaseToken: v.string(),
  observedAt: v.number(),
})

export const markCreateDispatchStarted = internalMutation({
  args: createAttemptArgsValidator.fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    const workItem = await createWorkItem(ctx, args.payToPaymentId)
    const operation = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_operationId', (q) => q.eq('operationId', args.operationId))
      .unique()
    if (
      !payment ||
      !workItem ||
      !operation ||
      operation.payToPaymentId !== payment._id ||
      workItem.operationId !== operation.operationId ||
      operation.leaseToken !== args.leaseToken ||
      operation.leaseExpiresAt === undefined ||
      operation.leaseExpiresAt < args.observedAt ||
      operation.dispatchStartedAt !== undefined ||
      !leaseAuthorizes(workItem, args.leaseToken, args.observedAt)
    ) {
      return false
    }
    const gate = await ctx.db
      .query('payToPaymentRuntimeGates')
      .withIndex('by_environment', (q) =>
        q.eq('environment', payment.environment),
      )
      .unique()
    if (moneyMovingDenial(gate?.mode, payment.environment) !== undefined) {
      await ctx.db.patch('payToPaymentOperations', operation._id, {
        outcome: { classification: 'refused', observedAt: args.observedAt },
      })
      await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
        state: 'held',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      })
      return false
    }
    await ctx.db.patch('payToPaymentOperations', operation._id, {
      dispatchStartedAt: args.observedAt,
    })
    return true
  },
})

async function createAttemptContext(
  ctx: MutationCtx,
  args: {
    payToPaymentId: Id<'payToPayments'>
    operationId: string
  },
) {
  const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
  if (!payment) return null
  const workItem = await createWorkItem(ctx, payment._id)
  const operation = await ctx.db
    .query('payToPaymentOperations')
    .withIndex('by_operationId', (q) => q.eq('operationId', args.operationId))
    .unique()
  if (!operation || operation.payToPaymentId !== payment._id) return null
  return { payment, workItem, operation }
}

function isCurrentDispatchedCreateAttempt(
  attempt: NonNullable<Awaited<ReturnType<typeof createAttemptContext>>>,
  leaseToken: string,
  observedAt: number,
) {
  return (
    attempt.workItem !== null &&
    attempt.workItem.operationId === attempt.operation.operationId &&
    attempt.operation.leaseToken === leaseToken &&
    attempt.operation.dispatchStartedAt !== undefined &&
    leaseAuthorizes(attempt.workItem, leaseToken, observedAt)
  )
}

export const recordCreateResult = internalMutation({
  args: createAttemptArgsValidator.extend({
    providerState: providerPayToPaymentStateValidator,
    providerCreatedAt: v.number(),
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await createAttemptContext(ctx, args)
    if (!attempt || attempt.operation.leaseToken !== args.leaseToken) {
      return false
    }
    const { operation, payment, workItem } = attempt
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: payment._id,
      source: 'create_response',
      intentFingerprint: payment.intent.fingerprint,
      operationId: args.operationId,
      classification: 'completed',
      providerState: args.providerState,
      providerCreatedAt: args.providerCreatedAt,
      observedAt: args.observedAt,
    })
    if (
      !isCurrentDispatchedCreateAttempt(
        attempt,
        args.leaseToken,
        args.observedAt,
      )
    ) {
      return false
    }
    if (!workItem) return false
    const agreement = await ctx.db.get(
      'payToAgreements',
      payment.payToAgreementId,
    )
    if (!agreement) throw new Error('PayTo Payment invariant failed')
    await ctx.db.patch('payToPaymentOperations', operation._id, {
      outcome: { classification: 'completed', observedAt: args.observedAt },
    })
    await ctx.db.patch('payToPayments', payment._id, {
      creationState: 'provider_established',
    })
    await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
      state: 'completed',
      completedAt: args.observedAt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await projectPayerPayment(ctx, agreement, {
      paymentStatus: 'processing',
      paymentVerificationPending: true,
      paymentAttentionRequired: false,
    })
    return true
  },
})

export const recordCreateFailure = internalMutation({
  args: createAttemptArgsValidator.extend({
    errorCategory: payToPaymentCreateErrorCategoryValidator,
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await createAttemptContext(ctx, args)
    if (!attempt || attempt.operation.leaseToken !== args.leaseToken) {
      return false
    }
    const { operation, payment, workItem } = attempt
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: payment._id,
      source: 'create_response',
      intentFingerprint: payment.intent.fingerprint,
      operationId: args.operationId,
      classification: 'uncertain',
      errorCategory: args.errorCategory,
      observedAt: args.observedAt,
    })
    if (
      !isCurrentDispatchedCreateAttempt(
        attempt,
        args.leaseToken,
        args.observedAt,
      )
    ) {
      return false
    }
    if (!workItem) return false
    await ctx.db.patch('payToPaymentOperations', operation._id, {
      outcome: { classification: 'uncertain', observedAt: args.observedAt },
    })
    await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
      state: 'held',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    return true
  },
})

function creationStateAllowsOperation(
  creationState: Doc<'payToPayments'>['creationState'],
  operationKind: PaymentOperationKind,
) {
  if (operationKind === 'create') return false
  if (operationKind === 'retry') {
    return creationState === 'provider_established'
  }
  return (
    creationState === 'creation_uncertain' ||
    creationState === 'provider_established'
  )
}

export const authorizeOperation = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    operationKind: payToPaymentOperationKindValidator,
    observedAt: v.number(),
  },
  returns: authorizeOperationResultValidator,
  handler: async (ctx, args) => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    if (!payment) {
      return { kind: 'denied' as const, reason: 'payment_not_found' as const }
    }
    const intentCheck = await ensurePayToPayment(ctx, {
      payToAgreementId: payment.payToAgreementId,
      observedAt: args.observedAt,
    })
    if (intentCheck.kind === 'mismatch') return { kind: 'mismatch' as const }
    const current = await ctx.db.get('payToPayments', payment._id)
    if (!current) {
      return { kind: 'denied' as const, reason: 'payment_not_found' as const }
    }
    if (current.attention !== undefined) {
      return { kind: 'denied' as const, reason: 'attention_required' as const }
    }
    if (
      !creationStateAllowsOperation(current.creationState, args.operationKind)
    ) {
      return {
        kind: 'denied' as const,
        reason: 'operation_not_allowed' as const,
      }
    }
    if (args.operationKind !== 'get') {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) =>
          q.eq('environment', current.environment),
        )
        .unique()
      const denial = moneyMovingDenial(gate?.mode, current.environment)
      if (denial !== undefined) {
        return { kind: 'denied' as const, reason: denial }
      }
    }
    const operationId = await allocateOperationId(ctx, args.observedAt)
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId: current._id,
      operationId,
      operationKind: args.operationKind,
      intentFingerprint: current.intent.fingerprint,
      authorizedAt: args.observedAt,
    })
    return {
      kind: 'authorized' as const,
      operationKind: args.operationKind,
      operationId,
      payToPaymentId: current._id,
      providerUid: current.providerUid,
      intent: current.intent,
    }
  },
})

async function acceptIntentReference(
  ctx: MutationCtx,
  args: {
    payToPaymentId: Id<'payToPayments'>
    intentFingerprint: string
    observedAt: number
  },
) {
  const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
  if (!payment) return { kind: 'not_found' as const }
  const agreement = await ctx.db.get(
    'payToAgreements',
    payment.payToAgreementId,
  )
  if (!agreement) throw new Error('PayTo Payment invariant failed')
  const intentCheck = await ensurePayToPayment(ctx, {
    payToAgreementId: agreement._id,
    observedAt: args.observedAt,
  })
  if (
    intentCheck.kind === 'mismatch' ||
    payment.intent.fingerprint !== args.intentFingerprint
  ) {
    if (intentCheck.kind !== 'mismatch') {
      await recordIntentMismatch(
        ctx,
        payment,
        agreement,
        args.intentFingerprint,
        args.observedAt,
      )
    }
    return { kind: 'mismatch' as const }
  }
  return { kind: 'accepted' as const }
}

export const recordOutcome = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    operationId: v.string(),
    leaseToken: v.optional(v.string()),
    classification: payToPaymentOperationClassificationValidator,
    observedAt: v.number(),
  },
  returns: intentReferenceResultValidator,
  handler: async (ctx, args) => {
    const operation = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_operationId', (q) => q.eq('operationId', args.operationId))
      .unique()
    if (!operation || operation.payToPaymentId !== args.payToPaymentId) {
      return { kind: 'not_found' as const }
    }
    if (operation.operationKind === 'create') {
      const attempt = await createAttemptContext(ctx, args)
      if (
        !attempt ||
        args.leaseToken === undefined ||
        !isCurrentDispatchedCreateAttempt(
          attempt,
          args.leaseToken,
          args.observedAt,
        )
      ) {
        return { kind: 'not_found' as const }
      }
    }
    const accepted = await acceptIntentReference(ctx, {
      payToPaymentId: args.payToPaymentId,
      intentFingerprint: operation.intentFingerprint,
      observedAt: args.observedAt,
    })
    if (accepted.kind !== 'accepted') return accepted
    if (operation.outcome === undefined) {
      await ctx.db.patch('payToPaymentOperations', operation._id, {
        outcome: {
          classification: args.classification,
          observedAt: args.observedAt,
        },
      })
    }
    return accepted
  },
})

export const applyEvidence = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    evidence: v.object({
      source: payToPaymentEvidenceSourceValidator,
      intentFingerprint: v.string(),
    }),
    observedAt: v.number(),
  },
  returns: intentReferenceResultValidator,
  handler: async (ctx, args) => {
    const accepted = await acceptIntentReference(ctx, {
      payToPaymentId: args.payToPaymentId,
      intentFingerprint: args.evidence.intentFingerprint,
      observedAt: args.observedAt,
    })
    if (accepted.kind !== 'accepted') return accepted
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: args.payToPaymentId,
      source: args.evidence.source,
      intentFingerprint: args.evidence.intentFingerprint,
      observedAt: args.observedAt,
    })
    return accepted
  },
})
