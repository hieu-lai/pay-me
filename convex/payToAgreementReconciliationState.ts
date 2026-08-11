import type { ProviderAgreementState } from './validators/payToAgreements'
import { providerAgreementStates } from './validators/payToAgreements'

export type LifecycleState = ProviderAgreementState | 'unknown'

const HALF_HOUR_MS = 30 * 60_000
const DAY_MS = 24 * 60 * 60_000
const retryDelaysMs = [
  30_000,
  2 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const
const knownProviderStates = new Set<string>(providerAgreementStates)
const terminalStates = new Set<LifecycleState>([
  'cancelled',
  'declined',
  'failed',
  'expired',
])

export function reconciliationScheduleForState(
  state: LifecycleState,
): number | null {
  if (state === 'pending' || state === 'created') return HALF_HOUR_MS
  if (state === 'active' || state === 'suspended' || state === 'unknown') {
    return DAY_MS
  }
  return null
}

export type ReconciliationSuccessDecision =
  | {
      kind: 'confirmed'
      state: ProviderAgreementState
      delayMs: number | null
    }
  | {
      kind: 'unknown'
      rawState: string
      delayMs: number
    }
  | {
      kind: 'contradiction'
      preservedState: ProviderAgreementState
      observedState: ProviderAgreementState
      delayMs: number
    }

export function decideReconciliationSuccess(input: {
  currentState: LifecycleState
  currentConfidence: 'provisional' | 'confirmed'
  providerState: string
}): ReconciliationSuccessDecision {
  if (!knownProviderStates.has(input.providerState)) {
    return { kind: 'unknown', rawState: input.providerState, delayMs: DAY_MS }
  }
  const providerState = input.providerState as ProviderAgreementState
  if (
    input.currentConfidence === 'confirmed' &&
    terminalStates.has(input.currentState) &&
    providerState !== input.currentState
  ) {
    return {
      kind: 'contradiction',
      preservedState: input.currentState as ProviderAgreementState,
      observedState: providerState,
      delayMs: DAY_MS,
    }
  }
  return {
    kind: 'confirmed',
    state: providerState,
    delayMs: reconciliationScheduleForState(providerState),
  }
}

export function decideReconciliationFailure(input: {
  consecutiveFailures: number
  failureStartedAt: number
  nowMs: number
}): { kind: 'retry' | 'review'; delayMs: number } {
  if (
    input.consecutiveFailures >= 6 ||
    input.nowMs - input.failureStartedAt >= DAY_MS
  ) {
    return { kind: 'review', delayMs: DAY_MS }
  }
  return {
    kind: 'retry',
    delayMs: retryDelaysMs[input.consecutiveFailures - 1] ?? DAY_MS,
  }
}

export function canRecordReconciliationOutcome(input: {
  activeToken?: string
  presentedToken: string
  leaseExpiresAt?: number
  nowMs: number
}): boolean {
  return (
    input.activeToken === input.presentedToken &&
    input.leaseExpiresAt !== undefined &&
    input.leaseExpiresAt >= input.nowMs
  )
}
