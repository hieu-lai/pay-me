import { v7 as uuid } from 'uuid'
import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import { projectPayerPayment } from './lib/payToPaymentProjection'
import type { PayToPaymentGateMode } from './validators/payToPayments'
import {
  payToPaymentEvidenceSourceValidator,
  payToPaymentIntentValidator,
  payToPaymentOperationClassificationValidator,
  payToPaymentOperationKindValidator,
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

function creationStateAllowsOperation(
  creationState: Doc<'payToPayments'>['creationState'],
  operationKind: PaymentOperationKind,
) {
  if (operationKind === 'create') return creationState === 'create_pending'
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
