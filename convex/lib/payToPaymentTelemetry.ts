import type { Id } from '../_generated/dataModel'
import type { PayToPaymentCreateErrorCategory } from '../validators/payToPayments'

export type PayToPaymentCriticalSignalKind =
  | 'suspected_duplication'
  | 'permanent_uid_invariant_breach'
  | 'settlement_contradiction'
  | 'projection_inconsistency'
  | 'unauthorized_operation'
  | 'unknown_provider_state'
  | 'unresolved_ambiguity'
  | 'configuration_mismatch'
  | 'cap_breach'

export type PayToPaymentCriticalSignalReason =
  | 'retry_acknowledgement_uncertain'
  | 'creation_recovery_exhausted'
  | 'daily_payment_capacity'
  | 'retry_capacity'
  | 'retry_endpoint_rate_limit'
  | 'configuration'
  | 'sandbox_only'
  | 'unauthenticated_diagnostics'
  | 'insufficient_role_diagnostics'
  | 'unauthenticated'
  | 'insufficient_role'
  | 'immutable_intent_mismatch'

type PaymentSignalIdentity = {
  payToPaymentId?: Id<'payToPayments'>
  payToAgreementId?: Id<'payToAgreements'>
  environment?: 'sandbox' | 'production'
}

export function emitPayToPaymentCriticalSignal(
  kind: PayToPaymentCriticalSignalKind,
  input: PaymentSignalIdentity & {
    observedAt?: number
    reason?: PayToPaymentCriticalSignalReason
  },
) {
  console.error('PayTo Payment critical signal', { kind, ...input })
}

export function emitPayToPaymentErrorCriticalSignal(
  input: PaymentSignalIdentity & {
    category: PayToPaymentCreateErrorCategory
    observedAt: number
  },
) {
  const { category, ...identity } = input
  if (category === 'duplicate_uid') {
    emitPayToPaymentCriticalSignal('suspected_duplication', identity)
  } else if (category === 'uid_mismatch') {
    emitPayToPaymentCriticalSignal('permanent_uid_invariant_breach', identity)
  } else if (category === 'configuration' || category === 'sandbox_only') {
    emitPayToPaymentCriticalSignal('configuration_mismatch', {
      ...identity,
      reason: category,
    })
  }
}

export function emitPayToPaymentAggregateMetric(
  input:
    | {
        kind: 'settlement_latency'
        payToPaymentId: Id<'payToPayments'>
        observedAt: number
        latencyMs: number
      }
    | {
        kind: 'aged_unresolved_payment' | 'confirmed_failure'
        payToPaymentId: Id<'payToPayments'>
        observedAt: number
      }
    | {
        kind: 'retry_attempt'
        payToPaymentId: Id<'payToPayments'>
        observedAt: number
        outcome: 'accepted' | 'ambiguous' | 'refused'
      }
    | {
        kind: 'webhook_deduplication'
        payToPaymentId: Id<'payToPayments'>
        observedAt: number
        outcome: 'duplicate_delivery' | 'duplicate_event'
      }
    | { kind: 'projection_inconsistency'; observedAt?: number },
) {
  console.info('PayTo Payment aggregate metric', input)
}

export function emitPayToPaymentOperationalAlert(input: {
  payToPaymentId: Id<'payToPayments'>
  observedAt: number
  consecutiveFailures: number
}) {
  console.error('PayTo Payment operational alert', {
    kind: 'lifecycle_tracking_outage' as const,
    ...input,
  })
}

function emitPayToPaymentOverdueWarning(input: {
  observedAt: number
  queue: 'creation' | 'reconciliation' | 'retry'
  dueCount: number
  oldestAgeMs: number
  sampledPayToPaymentIds: Id<'payToPayments'>[]
  truncated: boolean
}) {
  console.warn('PayTo Payment operational warning', {
    kind: 'work_overdue' as const,
    ...input,
  })
}

export function warnIfPayToPaymentWorkOverdue(input: {
  nowMs: number
  queue: 'creation' | 'reconciliation' | 'retry'
  work: Array<{
    payToPaymentId: Id<'payToPayments'>
    overdueAt: number
  }>
}) {
  const ordered = [...input.work].sort(
    (left, right) => left.overdueAt - right.overdueAt,
  )
  const oldestOverdueAt = ordered.at(0)?.overdueAt
  if (
    oldestOverdueAt === undefined ||
    input.nowMs - oldestOverdueAt <= 5 * 60_000
  ) {
    return false
  }
  emitPayToPaymentOverdueWarning({
    observedAt: input.nowMs,
    queue: input.queue,
    dueCount: ordered.length,
    oldestAgeMs: input.nowMs - oldestOverdueAt,
    sampledPayToPaymentIds: ordered
      .slice(0, 5)
      .map(({ payToPaymentId }) => payToPaymentId),
    truncated: ordered.length > 5,
  })
  return true
}
