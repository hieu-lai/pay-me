import { v7 as uuid } from 'uuid'
import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { env, internalMutation } from './_generated/server'
import { boundedEvidenceCode } from './lib/evidenceRedaction'
import { paymentCreationPool } from './lib/paymentCreationPool'
import { paymentAuditExpiresAt } from './lib/payToPaymentRetentionPolicy'
import { projectPayerPayment } from './lib/payToPaymentProjection'
import {
  emitPayToPaymentAggregateMetric,
  emitPayToPaymentCriticalSignal,
  emitPayToPaymentErrorCriticalSignal,
  warnIfPayToPaymentWorkOverdue,
} from './lib/payToPaymentTelemetry'
import { decidePaymentReconciliationSuccess } from './payToPaymentReconciliationState'
import type {
  PayToPaymentGateMode,
  ProviderPayToPaymentState,
} from './validators/payToPayments'
import {
  payToPaymentApprovalReferencesValidator,
  payToPaymentCapacityLimitsValidator,
  payToPaymentCreateErrorCategoryValidator,
  payToPaymentEvidenceValidator,
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
const CREATE_OUTCOME_DEADLINE_MS = 10_000
const IMMEDIATE_RECONCILIATION_DELAY_MS = 1_000
export const CREATE_RECOVERY_WINDOW_MS = 15 * 60_000
const MAX_CREATE_POST_ATTEMPTS = 3
const MAX_CREATE_RECOVERY_CYCLES = 2
const MAX_PRODUCTION_ALLOWLIST_SIZE = 100
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

export function moneyMovingDenial(mode: PayToPaymentGateMode | undefined) {
  if (mode === undefined || mode === 'disabled') {
    return 'gate_disabled' as const
  }
  if (mode === 'reconcile_only') return 'gate_reconcile_only' as const
}

function bytesToBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

async function sha256Fingerprint(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return bytesToBase64Url(new Uint8Array(digest))
}

function boundedActivationReference(value: string, field: string) {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error(`${field} must be a bounded non-empty reference`)
  }
  return normalized
}

async function currentProductionPrerequisites() {
  const certifiedCommit = env.PAYME_RELEASE_COMMIT
  const credential = env.ZEPTO_PERSONAL_ACCESS_TOKEN
  const configurationFingerprint = env.PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT
  const certificationFingerprint = env.PAYTO_PAYMENT_CERTIFICATION_FINGERPRINT
  if (
    env.ZEPTO_ENVIRONMENT !== 'production' ||
    !certifiedCommit ||
    !/^[0-9a-f]{40}$/.test(certifiedCommit) ||
    !credential ||
    !configurationFingerprint ||
    !certificationFingerprint
  ) {
    return null
  }
  return {
    certifiedCommit,
    credentialFingerprint: await sha256Fingerprint(credential),
    configurationFingerprint,
    certificationFingerprint,
  }
}

type ProductionActivationRecord = Omit<
  Doc<'payToPaymentActivations'>,
  '_id' | '_creationTime' | 'activationFingerprint'
>

async function productionActivationFingerprint(
  activation: ProductionActivationRecord,
  allowlistedPayerUserIds: Id<'users'>[],
) {
  return await sha256Fingerprint(
    JSON.stringify([
      1,
      activation.environment,
      activation.activatedAt,
      activation.certifiedCommit,
      activation.apiVersion,
      activation.credentialFingerprint,
      activation.configurationFingerprint,
      activation.certificationFingerprint,
      activation.certificationReference,
      activation.cohort.kind,
      [...allowlistedPayerUserIds].sort(),
      activation.capacityLimits.dailyPaymentCount,
      activation.capacityLimits.dailyPaymentValueCents,
      activation.approvalReferences.engineering,
      activation.approvalReferences.operations,
      activation.approvalReferences.security,
      activation.approvalReferences.legalCompliance,
      activation.approvalReferences.zepto,
    ]),
  )
}

async function productionActivationMatches(
  ctx: Pick<MutationCtx, 'db'>,
  activation: Doc<'payToPaymentActivations'>,
  payerUserId: Id<'users'>,
) {
  const runtime = await currentProductionPrerequisites()
  if (!runtime) return false
  const allowlist = await ctx.db
    .query('payToPaymentActivationAllowlist')
    .withIndex('by_activationId_and_payerUserId', (q) =>
      q.eq('activationId', activation._id),
    )
    .take(MAX_PRODUCTION_ALLOWLIST_SIZE + 1)
  if (allowlist.length > MAX_PRODUCTION_ALLOWLIST_SIZE) return false
  const allowlistedPayerUserIds = allowlist.map((entry) => entry.payerUserId)
  const { _id, _creationTime, activationFingerprint, ...record } = activation
  void _id
  void _creationTime
  return (
    activation.certifiedCommit === runtime.certifiedCommit &&
    activation.credentialFingerprint === runtime.credentialFingerprint &&
    activation.configurationFingerprint === runtime.configurationFingerprint &&
    activation.certificationFingerprint === runtime.certificationFingerprint &&
    allowlistedPayerUserIds.includes(payerUserId) &&
    Number.isSafeInteger(activation.capacityLimits.dailyPaymentCount) &&
    activation.capacityLimits.dailyPaymentCount > 0 &&
    Number.isSafeInteger(activation.capacityLimits.dailyPaymentValueCents) &&
    activation.capacityLimits.dailyPaymentValueCents > 0 &&
    (await productionActivationFingerprint(record, allowlistedPayerUserIds)) ===
      activationFingerprint
  )
}

const productionActivationArgsValidator = v.object({
  nowMs: v.number(),
  allowlistedPayerUserIds: v.array(v.id('users')),
  capacityLimits: payToPaymentCapacityLimitsValidator,
  certificationReference: v.string(),
  approvalReferences: payToPaymentApprovalReferencesValidator,
})

export const recordProductionActivation = internalMutation({
  args: productionActivationArgsValidator.fields,
  returns: v.object({
    activationId: v.id('payToPaymentActivations'),
    activationFingerprint: v.string(),
  }),
  handler: async (ctx, args) => {
    const runtime = await currentProductionPrerequisites()
    if (!runtime)
      throw new Error('Production PayTo Payment prerequisites are missing')
    if (
      !Number.isSafeInteger(args.nowMs) ||
      args.nowMs < 0 ||
      !Number.isSafeInteger(args.capacityLimits.dailyPaymentCount) ||
      args.capacityLimits.dailyPaymentCount <= 0 ||
      !Number.isSafeInteger(args.capacityLimits.dailyPaymentValueCents) ||
      args.capacityLimits.dailyPaymentValueCents <= 0
    ) {
      throw new Error('Production PayTo Payment activation values are invalid')
    }
    const latestActivation = await ctx.db
      .query('payToPaymentActivations')
      .withIndex('by_activatedAt')
      .order('desc')
      .first()
    if (latestActivation && args.nowMs <= latestActivation.activatedAt) {
      throw new Error(
        'Production PayTo Payment activation cutoffs must advance',
      )
    }
    const payerUserIds = [...new Set(args.allowlistedPayerUserIds)].sort()
    if (payerUserIds.length > MAX_PRODUCTION_ALLOWLIST_SIZE) {
      throw new Error('Production PayTo Payment allowlist is too large')
    }
    const approvalReferences = {
      engineering: boundedActivationReference(
        args.approvalReferences.engineering,
        'Engineering approval',
      ),
      operations: boundedActivationReference(
        args.approvalReferences.operations,
        'Operations approval',
      ),
      security: boundedActivationReference(
        args.approvalReferences.security,
        'Security approval',
      ),
      legalCompliance: boundedActivationReference(
        args.approvalReferences.legalCompliance,
        'Legal/compliance approval',
      ),
      zepto: boundedActivationReference(
        args.approvalReferences.zepto,
        'Zepto approval',
      ),
    }
    const record: ProductionActivationRecord = {
      environment: 'production',
      activatedAt: args.nowMs,
      certifiedCommit: runtime.certifiedCommit,
      apiVersion: '20260101',
      credentialFingerprint: runtime.credentialFingerprint,
      configurationFingerprint: runtime.configurationFingerprint,
      certificationFingerprint: runtime.certificationFingerprint,
      certificationReference: boundedActivationReference(
        args.certificationReference,
        'Certification',
      ),
      cohort: { kind: 'payer_allowlist' },
      capacityLimits: args.capacityLimits,
      approvalReferences,
    }
    const activationFingerprint = await productionActivationFingerprint(
      record,
      payerUserIds,
    )
    const activationId = await ctx.db.insert('payToPaymentActivations', {
      ...record,
      activationFingerprint,
    })
    for (const payerUserId of payerUserIds) {
      await ctx.db.insert('payToPaymentActivationAllowlist', {
        activationId,
        payerUserId,
      })
    }
    const gate = await ctx.db
      .query('payToPaymentRuntimeGates')
      .withIndex('by_environment', (q) => q.eq('environment', 'production'))
      .unique()
    const gatePatch = {
      mode: 'enabled_for_new_confirmations' as const,
      activeActivationId: activationId,
      activatedAt: args.nowMs,
      dailyPaymentCountCap: args.capacityLimits.dailyPaymentCount,
      dailyPaymentValueCapCents: args.capacityLimits.dailyPaymentValueCents,
    }
    if (gate)
      await ctx.db.patch('payToPaymentRuntimeGates', gate._id, gatePatch)
    else {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'production',
        ...gatePatch,
      })
    }
    return { activationId, activationFingerprint }
  },
})

async function reserveProductionActivationCapacity(
  ctx: MutationCtx,
  activation: Doc<'payToPaymentActivations'>,
  amountCents: number,
  observedAt: number,
) {
  const budgetDate = utcBudgetDate(observedAt)
  const budget = await ctx.db
    .query('payToPaymentActivationBudgets')
    .withIndex('by_environment_and_budgetDate', (q) =>
      q.eq('environment', 'production').eq('budgetDate', budgetDate),
    )
    .unique()
  const reservedPaymentCount = (budget?.reservedPaymentCount ?? 0) + 1
  const reservedPaymentValueCents =
    (budget?.reservedPaymentValueCents ?? 0) + amountCents
  if (
    reservedPaymentCount > activation.capacityLimits.dailyPaymentCount ||
    reservedPaymentValueCents > activation.capacityLimits.dailyPaymentValueCents
  ) {
    return null
  }
  if (budget) {
    await ctx.db.patch('payToPaymentActivationBudgets', budget._id, {
      reservedPaymentCount,
      reservedPaymentValueCents,
    })
  } else {
    await ctx.db.insert('payToPaymentActivationBudgets', {
      environment: 'production',
      budgetDate,
      reservedPaymentCount,
      reservedPaymentValueCents,
    })
  }
  return {
    budgetDate,
    paymentCount: 1 as const,
    paymentValueCents: amountCents,
  }
}

async function productionEstablishmentAdmission(
  ctx: MutationCtx,
  gate: Doc<'payToPaymentRuntimeGates'>,
  agreement: Doc<'payToAgreements'>,
  amountCents: number,
  observedAt: number,
) {
  if (!gate.activeActivationId) return { kind: 'denied' as const }
  const activation = await ctx.db.get(
    'payToPaymentActivations',
    gate.activeActivationId,
  )
  if (
    !activation ||
    !(await productionActivationMatches(
      ctx,
      activation,
      agreement.payerUserId,
    )) ||
    gate.dailyPaymentCountCap !== activation.capacityLimits.dailyPaymentCount ||
    gate.dailyPaymentValueCapCents !==
      activation.capacityLimits.dailyPaymentValueCents
  ) {
    return { kind: 'denied' as const }
  }
  if (
    agreement.firstConfirmedActiveAt === undefined ||
    agreement.firstConfirmedActiveAt < activation.activatedAt
  ) {
    return { kind: 'before_cutoff' as const }
  }
  const reservation = await reserveProductionActivationCapacity(
    ctx,
    activation,
    amountCents,
    observedAt,
  )
  if (!reservation) return { kind: 'denied' as const }
  return { kind: 'admitted' as const, activation, reservation }
}

export async function productionPaymentDispatchAuthorized(
  ctx: MutationCtx,
  payment: Doc<'payToPayments'>,
) {
  if (payment.environment !== 'production') {
    return (
      payment.productionActivationId === undefined &&
      payment.productionCapacityReservation === undefined
    )
  }
  if (
    !payment.productionActivationId ||
    !payment.productionCapacityReservation
  ) {
    return false
  }
  const gate = await ctx.db
    .query('payToPaymentRuntimeGates')
    .withIndex('by_environment', (q) => q.eq('environment', 'production'))
    .unique()
  if (
    gate?.mode !== 'enabled_for_new_confirmations' ||
    gate.activeActivationId !== payment.productionActivationId
  ) {
    return false
  }
  const activationId = payment.productionActivationId
  const reservation = payment.productionCapacityReservation
  const [activation, agreement, budget] = await Promise.all([
    ctx.db.get('payToPaymentActivations', activationId),
    ctx.db.get('payToAgreements', payment.payToAgreementId),
    ctx.db
      .query('payToPaymentActivationBudgets')
      .withIndex('by_environment_and_budgetDate', (q) =>
        q
          .eq('environment', 'production')
          .eq('budgetDate', reservation.budgetDate),
      )
      .unique(),
  ])
  return Boolean(
    activation &&
    agreement &&
    agreement.environment === payment.environment &&
    agreement.payerUserId === payment.payerUserId &&
    agreement.moneyRequestId === payment.moneyRequestId &&
    agreement.activationProvenancePolicy === 'track_first_confirmation' &&
    agreement.firstConfirmedActiveAt !== undefined &&
    agreement.firstConfirmedActiveAt >= activation.activatedAt &&
    agreement.lifecycleState === 'active' &&
    agreement.lifecycleConfidence === 'confirmed' &&
    reservation.paymentValueCents === payment.intent.amount.cents &&
    (await productionActivationMatches(
      ctx,
      activation,
      agreement.payerUserId,
    )) &&
    gate.dailyPaymentCountCap === activation.capacityLimits.dailyPaymentCount &&
    gate.dailyPaymentValueCapCents ===
      activation.capacityLimits.dailyPaymentValueCents &&
    budget &&
    budget.reservedPaymentCount >= reservation.paymentCount &&
    budget.reservedPaymentValueCents >= reservation.paymentValueCents &&
    budget.reservedPaymentCount <=
      activation.capacityLimits.dailyPaymentCount &&
    budget.reservedPaymentValueCents <=
      activation.capacityLimits.dailyPaymentValueCents,
  )
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

export async function allocatePayToPaymentOperationId(
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

export function payToPaymentOperationEvidenceProvenance(
  payment: Doc<'payToPayments'>,
  operation: Doc<'payToPaymentOperations'>,
) {
  return {
    operationKind: operation.operationKind,
    providerUid: operation.providerUid ?? payment.providerUid,
    apiVersion: operation.apiVersion ?? payment.intent.apiVersion,
    dispatchCertainty: operation.dispatchCertainty,
    operationAuthorizedAt: operation.authorizedAt,
    operationLeaseExpiresAt: operation.leaseExpiresAt,
    operationDispatchStartedAt: operation.dispatchStartedAt,
    leaseToken: operation.leaseToken,
    requestFingerprint: operation.requestFingerprint,
  }
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
  if (payment.attention?.kind !== 'intent_fingerprint_mismatch') {
    emitPayToPaymentCriticalSignal('configuration_mismatch', {
      payToAgreementId: agreement._id,
      payToPaymentId: payment._id,
      environment: payment.environment,
      observedAt,
      reason: 'immutable_intent_mismatch',
    })
  }
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

  const retiredIdentity = await ctx.db
    .query('payToPaymentRetiredIdentities')
    .withIndex('by_payToAgreementId', (q) =>
      q.eq('payToAgreementId', agreement._id),
    )
    .unique()
  if (retiredIdentity) {
    return {
      kind: 'ineligible' as const,
      reason: 'agreement_not_eligible' as const,
    }
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
  const denial = moneyMovingDenial(gate?.mode)
  if (denial !== undefined) {
    return {
      kind: 'ineligible' as const,
      reason: denial,
    }
  }
  if (!gate) {
    return { kind: 'ineligible' as const, reason: 'gate_disabled' as const }
  }
  let productionAdmission:
    Awaited<ReturnType<typeof productionEstablishmentAdmission>> | undefined
  if (agreement.environment === 'production') {
    productionAdmission = await productionEstablishmentAdmission(
      ctx,
      gate,
      agreement,
      intent.amount.cents,
      args.observedAt,
    )
    if (productionAdmission.kind !== 'admitted') {
      return {
        kind: 'ineligible' as const,
        reason:
          productionAdmission.kind === 'before_cutoff'
            ? ('agreement_not_eligible' as const)
            : ('production_not_enabled' as const),
      }
    }
  } else {
    const activatedAt = gate.activatedAt
    if (
      activatedAt === undefined ||
      agreement.firstConfirmedActiveAt < activatedAt
    ) {
      return {
        kind: 'ineligible' as const,
        reason: 'agreement_not_eligible' as const,
      }
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
    ...(productionAdmission?.kind === 'admitted'
      ? {
          productionActivationId: productionAdmission.activation._id,
          productionCapacityReservation: productionAdmission.reservation,
        }
      : {}),
    auditExpiresAt: paymentAuditExpiresAt(args.observedAt),
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
  await ctx.scheduler.runAt(
    agreement.firstConfirmedActiveAt + 24 * 60 * 60_000,
    internal.payToPaymentMonitoring.checkAgedUnresolved,
    { payToPaymentId },
  )
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

async function reconciliationWorkItem(
  ctx: Pick<MutationCtx, 'db'>,
  payToPaymentId: Id<'payToPayments'>,
) {
  return await ctx.db
    .query('payToPaymentReconciliationWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', payToPaymentId),
    )
    .unique()
}

async function retryWorkItem(
  ctx: Pick<MutationCtx, 'db'>,
  payToPaymentId: Id<'payToPayments'>,
) {
  return await ctx.db
    .query('payToPaymentRetryWorkItems')
    .withIndex('by_payToPaymentId', (q) =>
      q.eq('payToPaymentId', payToPaymentId),
    )
    .unique()
}

const RETRY_DELAYS_MS = [15 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000]

async function scheduleRetryAfterConfirmedFailure(
  ctx: MutationCtx,
  payment: Doc<'payToPayments'>,
  observedAt: number,
) {
  const retryOperations = await ctx.db
    .query('payToPaymentOperations')
    .withIndex('by_payToPaymentId_and_operationKind_and_authorizedAt', (q) =>
      q.eq('payToPaymentId', payment._id).eq('operationKind', 'retry'),
    )
    .order('desc')
    .take(4)
  const possiblyAcceptedRetries = retryOperations.filter(
    (operation) =>
      operation.dispatchCertainty === 'possibly_dispatched' &&
      operation.outcome?.classification !== 'refused',
  ).length
  const retryNumber = possiblyAcceptedRetries + 1
  const existing = await retryWorkItem(ctx, payment._id)
  if (existing?.state === 'locked' && existing.operationId !== undefined) {
    const lockedOperation = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_operationId', (q) =>
        q.eq('operationId', existing.operationId as string),
      )
      .unique()
    if (lockedOperation?.outcome?.classification === 'uncertain') {
      const agreement = await ctx.db.get(
        'payToAgreements',
        payment.payToAgreementId,
      )
      if (!agreement) throw new Error('PayTo Payment invariant failed')
      await ctx.db.patch('payToPayments', payment._id, {
        attention: {
          kind: 'retry_acknowledgement_uncertain',
          observedAt,
        },
      })
      await ctx.db.patch('payToPaymentRetryWorkItems', existing._id, {
        state: 'stopped',
        availableAt: observedAt,
      })
      await projectPayerPayment(ctx, agreement, {
        paymentStatus: agreement.paymentStatus ?? 'failed',
        paymentVerificationPending: false,
        paymentAttentionRequired: true,
      })
      emitPayToPaymentCriticalSignal('unresolved_ambiguity', {
        payToPaymentId: payment._id,
        payToAgreementId: payment.payToAgreementId,
        environment: payment.environment,
        observedAt,
        reason: 'retry_acknowledgement_uncertain',
      })
      return
    }
  }
  if (retryNumber > RETRY_DELAYS_MS.length) {
    if (existing) {
      await ctx.db.patch('payToPaymentRetryWorkItems', existing._id, {
        state: 'stopped',
        availableAt: observedAt,
      })
    }
    return
  }
  if (
    existing?.freshGetRequestedAt !== undefined &&
    observedAt >= existing.freshGetRequestedAt &&
    existing.retryNumber === retryNumber
  ) {
    await ctx.db.patch('payToPaymentRetryWorkItems', existing._id, {
      state: 'queued',
      availableAt: observedAt,
    })
    return
  }
  const availableAt = observedAt + RETRY_DELAYS_MS[retryNumber - 1]
  if (existing) {
    await ctx.db.patch('payToPaymentRetryWorkItems', existing._id, {
      state: 'queued',
      retryNumber,
      availableAt,
      freshGetRequestedAt: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      operationId: undefined,
    })
  } else {
    await ctx.db.insert('payToPaymentRetryWorkItems', {
      payToPaymentId: payment._id,
      state: 'queued',
      retryNumber,
      availableAt,
    })
  }
}

function creationRecoveryFor(payment: Doc<'payToPayments'>, nowMs: number) {
  return (
    payment.creationRecovery ?? {
      startedAt: nowMs,
      postAttempts: 0,
      recoveryCycles: 0,
      getAttempts: 0,
    }
  )
}

export async function requireCreationRecoveryAttention(
  ctx: MutationCtx,
  payment: Doc<'payToPayments'>,
  reason: 'recovery_exhausted' | 'deterministic_failure' | 'agreement_invalid',
  observedAt: number,
) {
  const agreement = await ctx.db.get(
    'payToAgreements',
    payment.payToAgreementId,
  )
  if (!agreement) throw new Error('PayTo Payment invariant failed')
  const createWork = await createWorkItem(ctx, payment._id)
  const getWork = await reconciliationWorkItem(ctx, payment._id)
  await ctx.db.patch('payToPayments', payment._id, {
    creationState: 'creation_attention_required',
    attention: {
      kind: 'creation_recovery_required',
      reason,
      observedAt,
    },
  })
  if (createWork) {
    await ctx.db.patch('payToPaymentWorkItems', createWork._id, {
      state: 'held',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      operationId: undefined,
    })
  }
  if (getWork) {
    await ctx.db.patch('payToPaymentReconciliationWorkItems', getWork._id, {
      state: 'stopped',
      availableAt: observedAt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      operationId: undefined,
      refreshRequestedAt: undefined,
    })
  }
  await projectPayerPayment(ctx, agreement, {
    paymentStatus: agreement.paymentStatus ?? 'initiating',
    paymentVerificationPending: true,
    paymentAttentionRequired: true,
  })
  if (
    reason === 'recovery_exhausted' &&
    payment.attention?.kind !== 'creation_recovery_required'
  ) {
    emitPayToPaymentCriticalSignal('unresolved_ambiguity', {
      payToPaymentId: payment._id,
      payToAgreementId: payment.payToAgreementId,
      environment: payment.environment,
      observedAt,
      reason: 'creation_recovery_exhausted',
    })
  }
}

export function reconciliationLeaseAuthorizes(input: {
  workItem: Doc<'payToPaymentReconciliationWorkItems'> | null
  operation: Doc<'payToPaymentOperations'> | null
  payToPaymentId: Id<'payToPayments'>
  operationId: string | undefined
  leaseToken: string | undefined
  observedAt: number
}) {
  return (
    input.workItem !== null &&
    input.operation !== null &&
    input.workItem.state === 'running' &&
    input.workItem.operationId === input.operation.operationId &&
    input.workItem.operationId === input.operationId &&
    input.workItem.leaseToken === input.leaseToken &&
    input.workItem.leaseExpiresAt !== undefined &&
    input.workItem.leaseExpiresAt >= input.observedAt &&
    input.operation.payToPaymentId === input.payToPaymentId &&
    input.operation.operationKind === 'get' &&
    input.operation.leaseToken === input.leaseToken
  )
}

export async function makePayToPaymentReconciliationDue(
  ctx: MutationCtx,
  payToPaymentId: Id<'payToPayments'>,
  observedAt: number,
) {
  await ctx.scheduler.runAfter(
    IMMEDIATE_RECONCILIATION_DELAY_MS,
    internal.payToPaymentReconciliation.reconcile,
    { payToPaymentId },
  )
  const existing = await reconciliationWorkItem(ctx, payToPaymentId)
  if (!existing) {
    await ctx.db.insert('payToPaymentReconciliationWorkItems', {
      payToPaymentId,
      state: 'queued',
      availableAt: observedAt,
    })
    return
  }
  if (existing.state === 'running' && existing.leaseExpiresAt !== undefined) {
    await ctx.db.patch('payToPaymentReconciliationWorkItems', existing._id, {
      refreshRequestedAt: Math.min(
        existing.refreshRequestedAt ?? observedAt,
        observedAt,
      ),
    })
    return
  }
  await ctx.db.patch('payToPaymentReconciliationWorkItems', existing._id, {
    state: 'queued',
    availableAt: Math.min(existing.availableAt, observedAt),
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    operationId: undefined,
    refreshRequestedAt: undefined,
  })
}

export async function requestImmediatePayToPaymentReconciliation(
  ctx: MutationCtx,
  args: {
    payToPaymentId: Id<'payToPayments'>
    observedAt: number
  },
) {
  const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
  if (!payment) {
    return { decision: 'refused' as const, code: 'payment_not_found' as const }
  }
  if (
    payment.creationState !== 'creation_uncertain' &&
    payment.creationState !== 'provider_established'
  ) {
    return {
      decision: 'refused' as const,
      code:
        payment.attention === undefined
          ? ('operation_not_allowed' as const)
          : ('attention_required' as const),
    }
  }
  return await scheduleRequestedPaymentReconciliation(
    ctx,
    payment,
    args.observedAt,
  )
}

async function scheduleRequestedPaymentReconciliation(
  ctx: MutationCtx,
  payment: Doc<'payToPayments'>,
  observedAt: number,
) {
  const work = await reconciliationWorkItem(ctx, payment._id)
  if (work?.state === 'queued' && work.availableAt <= observedAt) {
    return { decision: 'no_op' as const, code: 'already_due' as const }
  }
  await makePayToPaymentReconciliationDue(ctx, payment._id, observedAt)
  return { decision: 'authorized' as const, code: 'scheduled' as const }
}

export async function requestPayToPaymentResume(
  ctx: MutationCtx,
  args: {
    payToPaymentId: Id<'payToPayments'>
    observedAt: number
  },
) {
  const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
  if (!payment) {
    return { decision: 'refused' as const, code: 'payment_not_found' as const }
  }
  if (
    payment.creationState !== 'creation_uncertain' &&
    payment.creationState !== 'provider_established'
  ) {
    return {
      decision: 'refused' as const,
      code:
        payment.attention === undefined
          ? ('operation_not_allowed' as const)
          : ('attention_required' as const),
    }
  }
  if (payment.lifecycleState === 'settled') {
    return {
      decision: 'refused' as const,
      code: 'operation_not_allowed' as const,
    }
  }
  if (payment.creationState === 'creation_uncertain') {
    const agreement = await ctx.db.get(
      'payToAgreements',
      payment.payToAgreementId,
    )
    if (
      !agreement ||
      agreement.lifecycleState !== 'active' ||
      agreement.lifecycleConfidence !== 'confirmed'
    ) {
      return {
        decision: 'refused' as const,
        code: 'operation_not_allowed' as const,
      }
    }
  }
  return await scheduleRequestedPaymentReconciliation(
    ctx,
    payment,
    args.observedAt,
  )
}

export async function observePayToPaymentWebhook(
  ctx: MutationCtx,
  args: {
    payToPaymentId: Id<'payToPayments'>
    deliveryId: string
    providerEventId: string
    eventType: string
    providerPublishedAt: number
    providerState?: ProviderPayToPaymentState
    observedAt: number
  },
) {
  const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
  if (!payment) return false
  await ctx.db.insert('payToPaymentEvidence', {
    payToPaymentId: payment._id,
    source: 'webhook',
    intentFingerprint: payment.intent.fingerprint,
    deliveryId: args.deliveryId,
    providerEventId: args.providerEventId,
    eventType: args.eventType,
    providerPublishedAt: args.providerPublishedAt,
    providerState: args.providerState,
    observedAt: args.observedAt,
  })
  await makePayToPaymentReconciliationDue(ctx, payment._id, args.observedAt)
  return true
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
    let payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    if (!payment) return null
    let workItem = await createWorkItem(ctx, payment._id)
    if (
      workItem?.state === 'running' &&
      workItem.leaseExpiresAt !== undefined &&
      workItem.leaseExpiresAt <= args.nowMs
    ) {
      const expiredOperation =
        workItem.operationId === undefined
          ? null
          : await ctx.db
              .query('payToPaymentOperations')
              .withIndex('by_operationId', (q) =>
                q.eq('operationId', workItem?.operationId as string),
              )
              .unique()
      if (expiredOperation?.dispatchStartedAt !== undefined) {
        if (expiredOperation.outcome === undefined) {
          await ctx.db.patch('payToPaymentOperations', expiredOperation._id, {
            outcome: { classification: 'uncertain', observedAt: args.nowMs },
          })
        }
        await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
          state: 'held',
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
      await ctx.db.patch('payToPayments', payment._id, {
        creationState: 'create_pending',
      })
      await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
        state: 'queued',
        availableAt: args.nowMs,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        operationId: undefined,
      })
      payment = (await ctx.db.get('payToPayments', payment._id)) ?? payment
      workItem = (await createWorkItem(ctx, payment._id)) ?? workItem
    }
    if (payment.creationState !== 'create_pending') return null
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
    if (moneyMovingDenial(gate?.mode) !== undefined) {
      return null
    }
    if (!gate) return null
    if (
      payment.environment === 'production' &&
      !(await productionPaymentDispatchAuthorized(ctx, payment))
    ) {
      return null
    }

    const recovery = creationRecoveryFor(payment, args.nowMs)
    if (
      args.nowMs >= recovery.startedAt + CREATE_RECOVERY_WINDOW_MS ||
      recovery.postAttempts >= MAX_CREATE_POST_ATTEMPTS ||
      recovery.recoveryCycles >= MAX_CREATE_RECOVERY_CYCLES
    ) {
      await requireCreationRecoveryAttention(
        ctx,
        payment,
        'recovery_exhausted',
        args.nowMs,
      )
      return null
    }

    let sandboxReservation:
      | {
          budgetDate: string
          reservedPaymentCount: number
          reservedPaymentValueCents: number
        }
      | undefined
    if (payment.environment === 'sandbox') {
      const budgetDate = utcBudgetDate(args.nowMs)
      const existingCount =
        gate.budgetDate === budgetDate ? (gate.reservedPaymentCount ?? 0) : 0
      const existingValue =
        gate.budgetDate === budgetDate
          ? (gate.reservedPaymentValueCents ?? 0)
          : 0
      const reservesPaymentCapacity = recovery.postAttempts === 0
      const reservedPaymentCount =
        existingCount + (reservesPaymentCapacity ? 1 : 0)
      const reservedPaymentValueCents =
        existingValue +
        (reservesPaymentCapacity ? payment.intent.amount.cents : 0)
      if (
        (gate.dailyPaymentCountCap !== undefined &&
          reservedPaymentCount > gate.dailyPaymentCountCap) ||
        (gate.dailyPaymentValueCapCents !== undefined &&
          reservedPaymentValueCents > gate.dailyPaymentValueCapCents)
      ) {
        emitPayToPaymentCriticalSignal('cap_breach', {
          payToPaymentId: payment._id,
          payToAgreementId: payment.payToAgreementId,
          environment: payment.environment,
          observedAt: args.nowMs,
          reason: 'daily_payment_capacity',
        })
        return null
      }
      sandboxReservation = {
        budgetDate,
        reservedPaymentCount,
        reservedPaymentValueCents,
      }
    }

    const operationId = await allocatePayToPaymentOperationId(ctx, args.nowMs)
    const request = {
      providerUid: payment.providerUid,
      agreementProviderUid: payment.intent.agreementProviderUid,
      amountCents: payment.intent.amount.cents,
      priority: payment.intent.priority,
    }
    const requestFingerprint = await fingerprintCreateRequest(request)
    const leaseExpiresAt = args.nowMs + CREATE_LEASE_DURATION_MS
    if (sandboxReservation) {
      await ctx.db.patch(
        'payToPaymentRuntimeGates',
        gate._id,
        sandboxReservation,
      )
    }
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId: payment._id,
      operationId,
      operationKind: 'create',
      providerUid: payment.providerUid,
      apiVersion: payment.intent.apiVersion,
      productionActivationId: payment.productionActivationId,
      dispatchCertainty: 'not_dispatched',
      intentFingerprint: payment.intent.fingerprint,
      requestFingerprint,
      authorizedAt: args.nowMs,
      leaseToken: args.leaseToken,
      leaseExpiresAt,
    })
    await ctx.db.patch('payToPayments', payment._id, {
      creationState: 'creation_uncertain',
      creationRecovery: {
        ...recovery,
        postAttempts: recovery.postAttempts + 1,
        recoveryCycles:
          recovery.recoveryCycles + (recovery.postAttempts === 0 ? 0 : 1),
        getAttempts: 0,
        uncertainSince: undefined,
      },
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
    if (
      moneyMovingDenial(gate?.mode) !== undefined ||
      !(await productionPaymentDispatchAuthorized(ctx, payment)) ||
      operation.productionActivationId !== payment.productionActivationId
    ) {
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
      dispatchCertainty: 'possibly_dispatched',
    })
    const recovery = creationRecoveryFor(payment, args.observedAt)
    await ctx.db.patch('payToPayments', payment._id, {
      creationRecovery: {
        ...recovery,
        getAttempts: 0,
        uncertainSince: args.observedAt,
      },
    })
    await ctx.scheduler.runAfter(
      CREATE_OUTCOME_DEADLINE_MS,
      internal.payToPayments.expireUncommittedCreateOutcome,
      {
        payToPaymentId: payment._id,
        operationId: operation.operationId,
      },
    )
    return true
  },
})

export const expireUncommittedCreateOutcome = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    operationId: v.string(),
    observedAt: v.optional(v.number()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const observedAt = args.observedAt ?? Date.now()
    const attempt = await createAttemptContext(ctx, args)
    if (
      !attempt ||
      !attempt.workItem ||
      attempt.workItem.operationId !== attempt.operation.operationId ||
      attempt.operation.dispatchStartedAt === undefined ||
      attempt.operation.outcome !== undefined ||
      observedAt <
        attempt.operation.dispatchStartedAt + CREATE_OUTCOME_DEADLINE_MS
    ) {
      return false
    }
    await ctx.db.patch('payToPaymentOperations', attempt.operation._id, {
      outcome: { classification: 'uncertain', observedAt },
    })
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: attempt.payment._id,
      source: 'create_response',
      intentFingerprint: attempt.payment.intent.fingerprint,
      operationId: attempt.operation.operationId,
      ...payToPaymentOperationEvidenceProvenance(
        attempt.payment,
        attempt.operation,
      ),
      classification: 'uncertain',
      errorCategory: 'unclassified',
      observedAt,
    })
    await ctx.db.patch('payToPaymentWorkItems', attempt.workItem._id, {
      state: 'held',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await makePayToPaymentReconciliationDue(
      ctx,
      attempt.payment._id,
      observedAt,
    )
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
      ...payToPaymentOperationEvidenceProvenance(payment, operation),
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
      provisionalLifecycleState: args.providerState,
    })
    await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
      state: 'completed',
      availableAt: args.observedAt,
      completedAt: args.observedAt,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await projectPayerPayment(ctx, agreement, {
      paymentStatus: payerStatusForProvisionalLifecycle(args.providerState),
      paymentVerificationPending: true,
      paymentAttentionRequired: false,
    })
    await makePayToPaymentReconciliationDue(ctx, payment._id, args.observedAt)
    return true
  },
})

export const recordCreateFailure = internalMutation({
  args: createAttemptArgsValidator.extend({
    errorCategory: payToPaymentCreateErrorCategoryValidator,
    failureDisposition: v.optional(
      v.union(v.literal('ambiguous'), v.literal('deterministic')),
    ),
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
      ...payToPaymentOperationEvidenceProvenance(payment, operation),
      classification:
        args.failureDisposition === 'deterministic' ? 'refused' : 'uncertain',
      errorCategory: args.errorCategory,
      observedAt: args.observedAt,
    })
    emitPayToPaymentErrorCriticalSignal({
      payToPaymentId: payment._id,
      payToAgreementId: payment.payToAgreementId,
      environment: payment.environment,
      category: args.errorCategory,
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
    if (args.failureDisposition === 'deterministic') {
      await ctx.db.patch('payToPaymentOperations', operation._id, {
        outcome: { classification: 'refused', observedAt: args.observedAt },
      })
      await requireCreationRecoveryAttention(
        ctx,
        payment,
        'deterministic_failure',
        args.observedAt,
      )
      return true
    }
    await ctx.db.patch('payToPaymentOperations', operation._id, {
      outcome: { classification: 'uncertain', observedAt: args.observedAt },
    })
    await ctx.db.patch('payToPaymentWorkItems', workItem._id, {
      state: 'held',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    })
    await makePayToPaymentReconciliationDue(ctx, payment._id, args.observedAt)
    return true
  },
})

export const recordCreatePreDispatchFailure = internalMutation({
  args: createAttemptArgsValidator.extend({
    errorCategory: payToPaymentCreateErrorCategoryValidator,
  }).fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const attempt = await createAttemptContext(ctx, args)
    if (
      !attempt ||
      attempt.operation.leaseToken !== args.leaseToken ||
      attempt.operation.dispatchStartedAt !== undefined
    ) {
      return false
    }
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: attempt.payment._id,
      source: 'create_response',
      intentFingerprint: attempt.payment.intent.fingerprint,
      operationId: args.operationId,
      ...payToPaymentOperationEvidenceProvenance(
        attempt.payment,
        attempt.operation,
      ),
      classification: 'refused',
      errorCategory: args.errorCategory,
      observedAt: args.observedAt,
    })
    emitPayToPaymentErrorCriticalSignal({
      payToPaymentId: attempt.payment._id,
      payToAgreementId: attempt.payment.payToAgreementId,
      environment: attempt.payment.environment,
      category: args.errorCategory,
      observedAt: args.observedAt,
    })
    if (
      !attempt.workItem ||
      !leaseAuthorizes(attempt.workItem, args.leaseToken, args.observedAt)
    ) {
      return false
    }
    await ctx.db.patch('payToPaymentOperations', attempt.operation._id, {
      outcome: { classification: 'refused', observedAt: args.observedAt },
    })
    await requireCreationRecoveryAttention(
      ctx,
      attempt.payment,
      'deterministic_failure',
      args.observedAt,
    )
    return true
  },
})

function creationStateAllowsOperation(
  creationState: Doc<'payToPayments'>['creationState'],
  operationKind: PaymentOperationKind,
) {
  if (operationKind === 'create') return false
  if (operationKind === 'retry') return false
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
      const denial = moneyMovingDenial(gate?.mode)
      if (denial !== undefined) {
        return { kind: 'denied' as const, reason: denial }
      }
    }
    const operationId = await allocatePayToPaymentOperationId(
      ctx,
      args.observedAt,
    )
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId: current._id,
      operationId,
      operationKind: args.operationKind,
      providerUid: current.providerUid,
      apiVersion: current.intent.apiVersion,
      dispatchCertainty: 'not_dispatched',
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

const applyEvidenceInputValidator = payToPaymentEvidenceValidator.pick(
  'source',
  'intentFingerprint',
  'providerState',
  'providerFailureCode',
  'providerFailureRetryable',
  'providerAbsent',
  'operationId',
  'leaseToken',
)

export const applyEvidence = internalMutation({
  args: {
    payToPaymentId: v.id('payToPayments'),
    evidence: applyEvidenceInputValidator,
    observedAt: v.number(),
  },
  returns: intentReferenceResultValidator,
  handler: async (ctx, args) => {
    const payment = await ctx.db.get('payToPayments', args.payToPaymentId)
    if (!payment) return { kind: 'not_found' as const }
    const durableProviderState =
      args.evidence.providerState === undefined
        ? undefined
        : (boundedEvidenceCode(args.evidence.providerState) ?? 'unknown')

    if (args.evidence.source !== 'per_uid_get') {
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
        providerState: durableProviderState,
        observedAt: args.observedAt,
      })
      await makePayToPaymentReconciliationDue(ctx, payment._id, args.observedAt)
      return accepted
    }

    const workItem = await reconciliationWorkItem(ctx, payment._id)
    const operation =
      args.evidence.operationId === undefined
        ? null
        : await ctx.db
            .query('payToPaymentOperations')
            .withIndex('by_operationId', (q) =>
              q.eq('operationId', args.evidence.operationId as string),
            )
            .unique()
    const providerState = args.evidence.providerState
    const providerAbsent = args.evidence.providerAbsent === true
    const providerFailureCode = boundedEvidenceCode(
      args.evidence.providerFailureCode,
    )
    const currentLease =
      (providerState !== undefined || providerAbsent) &&
      reconciliationLeaseAuthorizes({
        workItem,
        operation,
        payToPaymentId: payment._id,
        operationId: args.evidence.operationId,
        leaseToken: args.evidence.leaseToken,
        observedAt: args.observedAt,
      })
    if (!currentLease || !workItem || !operation) {
      if (providerState !== undefined || providerAbsent) {
        await ctx.db.insert('payToPaymentEvidence', {
          payToPaymentId: payment._id,
          source: 'per_uid_get',
          intentFingerprint: args.evidence.intentFingerprint,
          operationId: args.evidence.operationId,
          ...(operation
            ? payToPaymentOperationEvidenceProvenance(payment, operation)
            : { providerUid: payment.providerUid }),
          providerState: durableProviderState,
          providerAbsent: providerAbsent || undefined,
          observedAt: args.observedAt,
        })
      }
      return { kind: 'not_found' as const }
    }

    const accepted = await acceptIntentReference(ctx, {
      payToPaymentId: args.payToPaymentId,
      intentFingerprint: args.evidence.intentFingerprint,
      observedAt: args.observedAt,
    })
    if (accepted.kind !== 'accepted') return accepted
    const agreement = await ctx.db.get(
      'payToAgreements',
      payment.payToAgreementId,
    )
    if (!agreement) throw new Error('PayTo Payment invariant failed')

    if (providerAbsent) {
      await ctx.db.insert('payToPaymentEvidence', {
        payToPaymentId: payment._id,
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        operationId: operation.operationId,
        ...payToPaymentOperationEvidenceProvenance(payment, operation),
        classification: 'completed',
        providerAbsent: true,
        outcome: 'absence',
        observedAt: args.observedAt,
      })
      await ctx.db.patch('payToPaymentOperations', operation._id, {
        outcome: { classification: 'completed', observedAt: args.observedAt },
      })
      const recovery = creationRecoveryFor(payment, args.observedAt)
      const agreementStillValid =
        agreement.lifecycleState === 'active' &&
        agreement.lifecycleConfidence === 'confirmed'
      const recoveryAvailable =
        args.observedAt < recovery.startedAt + CREATE_RECOVERY_WINDOW_MS &&
        recovery.postAttempts < MAX_CREATE_POST_ATTEMPTS &&
        recovery.recoveryCycles < MAX_CREATE_RECOVERY_CYCLES
      if (
        payment.creationState === 'creation_uncertain' &&
        agreementStillValid &&
        recoveryAvailable
      ) {
        const createWork = await createWorkItem(ctx, payment._id)
        if (!createWork) throw new Error('PayTo Payment create work missing')
        await ctx.db.patch('payToPayments', payment._id, {
          creationState: 'create_pending',
        })
        await ctx.db.patch(
          'payToPaymentReconciliationWorkItems',
          workItem._id,
          {
            state: 'stopped',
            availableAt: args.observedAt,
            leaseToken: undefined,
            leaseExpiresAt: undefined,
            operationId: undefined,
            refreshRequestedAt: undefined,
            consecutiveFailures: 0,
            failureStartedAt: undefined,
            lastSuccessAt: args.observedAt,
          },
        )
        await ctx.db.patch('payToPaymentWorkItems', createWork._id, {
          state: 'queued',
          availableAt: args.observedAt,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          operationId: undefined,
        })
        await projectPayerPayment(ctx, agreement, {
          paymentStatus: 'initiating',
          paymentVerificationPending: false,
          paymentAttentionRequired: false,
        })
        return accepted
      }
      await requireCreationRecoveryAttention(
        ctx,
        payment,
        agreementStillValid ? 'recovery_exhausted' : 'agreement_invalid',
        args.observedAt,
      )
      return accepted
    }
    if (providerState === undefined) return { kind: 'not_found' as const }

    const decision = decidePaymentReconciliationSuccess({
      currentState: payment.lifecycleState,
      providerState,
      paymentAgeMs: Math.max(0, args.observedAt - payment.establishedAt),
    })
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId: args.payToPaymentId,
      source: 'per_uid_get',
      intentFingerprint: args.evidence.intentFingerprint,
      operationId: operation.operationId,
      ...payToPaymentOperationEvidenceProvenance(payment, operation),
      providerState: durableProviderState,
      providerFailureCode,
      providerFailureRetryable: args.evidence.providerFailureRetryable,
      outcome: decision.kind,
      observedAt: args.observedAt,
    })
    await ctx.db.patch('payToPaymentOperations', operation._id, {
      outcome: { classification: 'completed', observedAt: args.observedAt },
    })
    const immediateFollowUp = workItem.refreshRequestedAt !== undefined
    const nextAvailableAt = (delayMs: number) =>
      immediateFollowUp ? args.observedAt : args.observedAt + delayMs
    const completedWorkPatch = {
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      operationId: undefined,
      refreshRequestedAt: undefined,
      consecutiveFailures: 0,
      failureStartedAt: undefined,
      lastSuccessAt: args.observedAt,
    }

    if (decision.kind === 'confirmed') {
      const paymentStatus = payerStatusForConfirmedLifecycle(decision.state)
      if (
        decision.state === 'settled' &&
        payment.lifecycleState !== 'settled'
      ) {
        emitPayToPaymentAggregateMetric({
          kind: 'settlement_latency',
          payToPaymentId: payment._id,
          observedAt: args.observedAt,
          latencyMs: Math.max(0, args.observedAt - payment.establishedAt),
        })
      } else if (
        decision.state === 'failed' &&
        payment.lifecycleState !== 'failed'
      ) {
        emitPayToPaymentAggregateMetric({
          kind: 'confirmed_failure',
          payToPaymentId: payment._id,
          observedAt: args.observedAt,
        })
      }
      await ctx.db.patch('payToPayments', payment._id, {
        creationState: 'provider_established',
        lifecycleState: decision.state,
        lifecycleObservedAt: args.observedAt,
        ...(decision.state === 'settled'
          ? { agedUnresolvedMonitoringCompletedAt: args.observedAt }
          : {}),
        lastReconciledAt: args.observedAt,
        provisionalLifecycleState: undefined,
        reconciliationAlert: undefined,
        confirmedFailure:
          decision.state === 'failed' &&
          providerFailureCode !== undefined &&
          args.evidence.providerFailureRetryable !== undefined
            ? {
                code: providerFailureCode,
                retryable: args.evidence.providerFailureRetryable,
                observedAt: args.observedAt,
              }
            : undefined,
        auditExpiresAt: paymentAuditExpiresAt(args.observedAt),
        ...(payment.attention?.kind === 'unknown_provider_state'
          ? { attention: undefined }
          : {}),
      })
      if (
        decision.state === 'failed' &&
        args.evidence.providerFailureRetryable === true &&
        providerFailureCode !== undefined
      ) {
        await scheduleRetryAfterConfirmedFailure(ctx, payment, args.observedAt)
      } else {
        const retryWork = await retryWorkItem(ctx, payment._id)
        if (retryWork) {
          await ctx.db.patch('payToPaymentRetryWorkItems', retryWork._id, {
            state: 'stopped',
            availableAt: args.observedAt,
            freshGetRequestedAt: undefined,
            leaseToken: undefined,
            leaseExpiresAt: undefined,
          })
        }
      }
      const paymentAfterRetryPolicy =
        (await ctx.db.get('payToPayments', payment._id)) ?? payment
      await projectPayerPayment(ctx, agreement, {
        paymentStatus,
        paymentVerificationPending: false,
        paymentAttentionRequired:
          paymentAfterRetryPolicy.attention !== undefined &&
          paymentAfterRetryPolicy.attention.kind !== 'unknown_provider_state',
      })
      await ctx.db.patch('payToPaymentReconciliationWorkItems', workItem._id, {
        state: decision.delayMs === null ? 'stopped' : 'queued',
        availableAt: nextAvailableAt(decision.delayMs ?? 0),
        ...completedWorkPatch,
      })
    } else if (decision.kind === 'unknown') {
      const newlyUnknown = payment.attention?.kind !== 'unknown_provider_state'
      await ctx.db.patch('payToPayments', payment._id, {
        creationState: 'provider_established',
        lastReconciledAt: args.observedAt,
        attention: {
          kind: 'unknown_provider_state',
          observedAt: args.observedAt,
        },
        reconciliationAlert: undefined,
      })
      await projectPayerPayment(ctx, agreement, {
        paymentStatus: agreement.paymentStatus ?? 'initiating',
        paymentVerificationPending: true,
        paymentAttentionRequired: true,
      })
      await ctx.db.patch('payToPaymentReconciliationWorkItems', workItem._id, {
        state: 'queued',
        availableAt: nextAvailableAt(decision.delayMs),
        ...completedWorkPatch,
      })
      if (newlyUnknown) {
        emitPayToPaymentCriticalSignal('unknown_provider_state', {
          payToPaymentId: payment._id,
          payToAgreementId: payment.payToAgreementId,
          environment: payment.environment,
          observedAt: args.observedAt,
        })
      }
    } else {
      const newlyContradictory =
        payment.attention?.kind !== 'settlement_contradiction'
      await ctx.db.patch('payToPayments', payment._id, {
        creationState: 'provider_established',
        lastReconciledAt: args.observedAt,
        attention: {
          kind: 'settlement_contradiction',
          observedState: decision.observedState,
          observedAt: args.observedAt,
        },
        reconciliationAlert: undefined,
      })
      await projectPayerPayment(ctx, agreement, {
        paymentStatus: 'paid',
        paymentVerificationPending: true,
        paymentAttentionRequired: true,
      })
      await ctx.db.patch('payToPaymentReconciliationWorkItems', workItem._id, {
        state: 'queued',
        availableAt: args.observedAt,
        ...completedWorkPatch,
      })
      if (newlyContradictory) {
        emitPayToPaymentCriticalSignal('settlement_contradiction', {
          payToPaymentId: payment._id,
          payToAgreementId: payment.payToAgreementId,
          environment: payment.environment,
          observedAt: args.observedAt,
        })
      }
    }
    if (immediateFollowUp) {
      await ctx.scheduler.runAfter(
        IMMEDIATE_RECONCILIATION_DELAY_MS,
        internal.payToPaymentReconciliation.reconcile,
        { payToPaymentId: payment._id },
      )
    }
    return accepted
  },
})

export const dispatchCreationRecoveryDue = internalMutation({
  args: { nowMs: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now()
    const queued = await ctx.db
      .query('payToPaymentWorkItems')
      .withIndex('by_state_and_availableAt', (q) =>
        q.eq('state', 'queued').lte('availableAt', nowMs),
      )
      .take(50)
    const expired = await ctx.db
      .query('payToPaymentWorkItems')
      .withIndex('by_state_and_leaseExpiresAt', (q) =>
        q.eq('state', 'running').lte('leaseExpiresAt', nowMs),
      )
      .take(Math.max(0, 50 - queued.length))
    warnIfPayToPaymentWorkOverdue({
      nowMs,
      queue: 'creation',
      work: [
        ...queued.map((work) => ({
          payToPaymentId: work.payToPaymentId,
          overdueAt: work.availableAt,
        })),
        ...expired.map((work) => ({
          payToPaymentId: work.payToPaymentId,
          overdueAt: work.leaseExpiresAt ?? nowMs,
        })),
      ],
    })
    for (const workItem of [...queued, ...expired]) {
      await ctx.scheduler.runAfter(0, internal.payToPaymentCreation.create, {
        payToPaymentId: workItem.payToPaymentId,
      })
    }
    return queued.length + expired.length
  },
})

function payerStatusForConfirmedLifecycle(
  state: ProviderPayToPaymentState,
): 'processing' | 'under_investigation' | 'failed' | 'paid' {
  if (state === 'settled') return 'paid'
  return payerStatusForUnsettledLifecycle(state)
}

function payerStatusForProvisionalLifecycle(
  state: ProviderPayToPaymentState,
): 'processing' | 'under_investigation' | 'failed' {
  return payerStatusForUnsettledLifecycle(state)
}

function payerStatusForUnsettledLifecycle(
  state: ProviderPayToPaymentState,
): 'processing' | 'under_investigation' | 'failed' {
  if (state === 'under_investigation') return 'under_investigation'
  if (state === 'failed') return 'failed'
  return 'processing'
}
