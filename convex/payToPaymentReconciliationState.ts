import type { ProviderPayToPaymentState } from './validators/payToPayments'
import { providerPayToPaymentStates } from './validators/payToPayments'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const knownProviderStates = new Set<string>(providerPayToPaymentStates)

export function paymentReconciliationDelay(
  state: ProviderPayToPaymentState,
  paymentAgeMs: number,
): number | null {
  if (state === 'settled' || state === 'failed') return null
  if (state === 'created' || state === 'submitting') {
    if (paymentAgeMs <= 15 * MINUTE_MS) return MINUTE_MS
    if (paymentAgeMs <= HOUR_MS) return 5 * MINUTE_MS
    if (paymentAgeMs <= DAY_MS) return 15 * MINUTE_MS
    return HOUR_MS
  }
  if (state === 'pending') {
    if (paymentAgeMs <= HOUR_MS) return 5 * MINUTE_MS
    if (paymentAgeMs <= DAY_MS) return 15 * MINUTE_MS
    return HOUR_MS
  }
  return paymentAgeMs <= DAY_MS ? HOUR_MS : 6 * HOUR_MS
}

export type PaymentReconciliationSuccessDecision =
  | {
      kind: 'confirmed'
      state: ProviderPayToPaymentState
      delayMs: number | null
    }
  | { kind: 'unknown'; rawState: string; delayMs: number }
  | {
      kind: 'contradiction'
      preservedState: 'settled'
      observedState: ProviderPayToPaymentState
      delayMs: 0
    }

export function decidePaymentReconciliationSuccess(input: {
  currentState: ProviderPayToPaymentState | undefined
  providerState: string
  paymentAgeMs: number
}): PaymentReconciliationSuccessDecision {
  if (!knownProviderStates.has(input.providerState)) {
    const safeState = input.currentState ?? 'created'
    return {
      kind: 'unknown',
      rawState: input.providerState,
      delayMs:
        paymentReconciliationDelay(safeState, input.paymentAgeMs) ?? HOUR_MS,
    }
  }
  const providerState = input.providerState as ProviderPayToPaymentState
  if (input.currentState === 'settled' && providerState !== 'settled') {
    return {
      kind: 'contradiction',
      preservedState: 'settled',
      observedState: providerState,
      delayMs: 0,
    }
  }
  return {
    kind: 'confirmed',
    state: providerState,
    delayMs: paymentReconciliationDelay(providerState, input.paymentAgeMs),
  }
}

export function decidePaymentReconciliationFailure(input: {
  consecutiveFailures: number
  failureStartedAt: number
  nowMs: number
  safeDelayMs: number
}): { kind: 'retry' | 'alert'; delayMs: number } {
  return {
    kind:
      input.consecutiveFailures >= 6 ||
      input.nowMs - input.failureStartedAt >= DAY_MS
        ? 'alert'
        : 'retry',
    delayMs: input.safeDelayMs,
  }
}
