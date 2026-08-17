import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  emitPayToPaymentAggregateMetric,
  emitPayToPaymentCriticalSignal,
} from './payToPaymentTelemetry'

export const PAYER_PAYMENT_STATUSES = [
  'not_started',
  'initiating',
  'processing',
  'under_investigation',
  'failed',
  'paid',
] as const

export type PayerPaymentStatus = (typeof PAYER_PAYMENT_STATUSES)[number]
export type PayerPaymentCounts = Record<PayerPaymentStatus, number>

export type PayerProjection = {
  paymentStatus: PayerPaymentStatus
  paymentVerificationPending: boolean
  paymentAttentionRequired: boolean
}

type MoneyRequestProjection = {
  payerCount: number
  paymentStatus: 'unpaid' | 'paid'
  paymentCounts: PayerPaymentCounts
  paymentVerificationPendingPayerCount: number
  paymentAttentionRequiredPayerCount: number
}

function projectionInvariantError(): never {
  emitPayToPaymentCriticalSignal('projection_inconsistency', {})
  emitPayToPaymentAggregateMetric({ kind: 'projection_inconsistency' })
  throw new Error('PayTo Payment projection invariant failed')
}

export function emptyPayerPaymentCounts(): PayerPaymentCounts {
  return {
    not_started: 0,
    initiating: 0,
    processing: 0,
    under_investigation: 0,
    failed: 0,
    paid: 0,
  }
}

export function initialPayerPaymentProjection(): PayerProjection {
  return {
    paymentStatus: 'not_started',
    paymentVerificationPending: false,
    paymentAttentionRequired: false,
  }
}

export function initialMoneyRequestPaymentProjection(
  payerCount: number,
): MoneyRequestProjection {
  const projection = {
    payerCount,
    paymentStatus: 'unpaid' as const,
    paymentCounts: { ...emptyPayerPaymentCounts(), not_started: payerCount },
    paymentVerificationPendingPayerCount: 0,
    paymentAttentionRequiredPayerCount: 0,
  }
  assertPaymentProjectionValues(
    projection,
    Array.from({ length: payerCount }, initialPayerPaymentProjection),
  )
  return projection
}

function assertBoundedPayerCount(payerCount: number) {
  if (!Number.isInteger(payerCount) || payerCount < 1 || payerCount > 5) {
    projectionInvariantError()
  }
}

export function moneyRequestProjectionFromPayers(
  payers: PayerProjection[],
): MoneyRequestProjection {
  assertBoundedPayerCount(payers.length)
  const paymentCounts = emptyPayerPaymentCounts()
  let paymentVerificationPendingPayerCount = 0
  let paymentAttentionRequiredPayerCount = 0
  for (const payer of payers) {
    paymentCounts[payer.paymentStatus] += 1
    if (payer.paymentVerificationPending) {
      paymentVerificationPendingPayerCount += 1
    }
    if (payer.paymentAttentionRequired) paymentAttentionRequiredPayerCount += 1
  }
  return {
    payerCount: payers.length,
    paymentStatus: paymentCounts.paid === payers.length ? 'paid' : 'unpaid',
    paymentCounts,
    paymentVerificationPendingPayerCount,
    paymentAttentionRequiredPayerCount,
  }
}

export function assertPaymentProjectionValues(
  moneyRequest: MoneyRequestProjection,
  payers: PayerProjection[],
) {
  assertBoundedPayerCount(moneyRequest.payerCount)
  if (payers.length !== moneyRequest.payerCount) projectionInvariantError()
  const expected = moneyRequestProjectionFromPayers(payers)
  let countSum = 0
  for (const status of PAYER_PAYMENT_STATUSES) {
    const count = moneyRequest.paymentCounts[status]
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count !== expected.paymentCounts[status]
    ) {
      projectionInvariantError()
    }
    countSum += count
  }
  if (
    countSum !== moneyRequest.payerCount ||
    moneyRequest.paymentVerificationPendingPayerCount !==
      expected.paymentVerificationPendingPayerCount ||
    moneyRequest.paymentAttentionRequiredPayerCount !==
      expected.paymentAttentionRequiredPayerCount
  ) {
    projectionInvariantError()
  }
  if (moneyRequest.paymentStatus !== expected.paymentStatus) {
    projectionInvariantError()
  }
}

function payerProjectionWithLegacyDefaults(
  agreement: Doc<'payToAgreements'>,
): PayerProjection {
  return {
    paymentStatus: agreement.paymentStatus ?? 'not_started',
    paymentVerificationPending: agreement.paymentVerificationPending ?? false,
    paymentAttentionRequired: agreement.paymentAttentionRequired ?? false,
  }
}

export async function assertStoredPaymentProjection(
  ctx: Pick<QueryCtx, 'db'>,
  moneyRequestId: Id<'moneyRequests'>,
) {
  const moneyRequest = await ctx.db.get('moneyRequests', moneyRequestId)
  if (
    !moneyRequest ||
    moneyRequest.payerCount === undefined ||
    moneyRequest.paymentStatus === undefined ||
    moneyRequest.paymentCounts === undefined ||
    moneyRequest.paymentVerificationPendingPayerCount === undefined ||
    moneyRequest.paymentAttentionRequiredPayerCount === undefined
  ) {
    projectionInvariantError()
  }
  const agreements = await ctx.db
    .query('payToAgreements')
    .withIndex('by_moneyRequestId', (q) =>
      q.eq('moneyRequestId', moneyRequestId),
    )
    .take(6)
  if (
    agreements.some(
      (agreement) =>
        agreement.paymentStatus === undefined ||
        agreement.paymentVerificationPending === undefined ||
        agreement.paymentAttentionRequired === undefined,
    )
  ) {
    projectionInvariantError()
  }
  assertPaymentProjectionValues(
    {
      payerCount: moneyRequest.payerCount,
      paymentStatus: moneyRequest.paymentStatus,
      paymentCounts: moneyRequest.paymentCounts,
      paymentVerificationPendingPayerCount:
        moneyRequest.paymentVerificationPendingPayerCount,
      paymentAttentionRequiredPayerCount:
        moneyRequest.paymentAttentionRequiredPayerCount,
    },
    agreements.map(payerProjectionWithLegacyDefaults),
  )
}

export async function repairPaymentProjection(
  ctx: Pick<MutationCtx, 'db'>,
  moneyRequestId: Id<'moneyRequests'>,
) {
  const moneyRequest = await ctx.db.get('moneyRequests', moneyRequestId)
  if (!moneyRequest) projectionInvariantError()
  const agreements = await ctx.db
    .query('payToAgreements')
    .withIndex('by_moneyRequestId', (q) =>
      q.eq('moneyRequestId', moneyRequestId),
    )
    .take(6)
  assertBoundedPayerCount(agreements.length)
  const payerProjections = agreements.map(payerProjectionWithLegacyDefaults)
  for (const [index, agreement] of agreements.entries()) {
    const projection = payerProjections[index]
    if (
      agreement.paymentStatus === undefined ||
      agreement.paymentVerificationPending === undefined ||
      agreement.paymentAttentionRequired === undefined
    ) {
      await ctx.db.patch('payToAgreements', agreement._id, projection)
    }
  }
  const repaired = moneyRequestProjectionFromPayers(payerProjections)
  assertPaymentProjectionValues(repaired, payerProjections)
  await ctx.db.patch('moneyRequests', moneyRequestId, repaired)
  await assertStoredPaymentProjection(ctx, moneyRequestId)
}

export async function projectPayerPayment(
  ctx: Pick<MutationCtx, 'db'>,
  agreement: Doc<'payToAgreements'>,
  projection: PayerProjection,
) {
  const moneyRequest = await ctx.db.get(
    'moneyRequests',
    agreement.moneyRequestId,
  )
  if (!moneyRequest) projectionInvariantError()
  const agreements = await ctx.db
    .query('payToAgreements')
    .withIndex('by_moneyRequestId', (q) =>
      q.eq('moneyRequestId', agreement.moneyRequestId),
    )
    .take(6)
  const payerProjections = agreements.map((item) => {
    if (item._id === agreement._id) return projection
    if (
      item.paymentStatus === undefined ||
      item.paymentVerificationPending === undefined ||
      item.paymentAttentionRequired === undefined
    ) {
      projectionInvariantError()
    }
    return {
      paymentStatus: item.paymentStatus,
      paymentVerificationPending: item.paymentVerificationPending,
      paymentAttentionRequired: item.paymentAttentionRequired,
    }
  })
  const moneyRequestProjection =
    moneyRequestProjectionFromPayers(payerProjections)
  assertPaymentProjectionValues(moneyRequestProjection, payerProjections)
  await ctx.db.patch('payToAgreements', agreement._id, projection)
  await ctx.db.patch(
    'moneyRequests',
    agreement.moneyRequestId,
    moneyRequestProjection,
  )
}
