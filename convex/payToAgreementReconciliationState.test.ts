import { describe, expect, test } from 'vitest'

import {
  canRecordReconciliationOutcome,
  decideReconciliationFailure,
  decideReconciliationSuccess,
  reconciliationScheduleForState,
} from './payToAgreementReconciliationState'

const minute = 60_000
const day = 24 * 60 * minute

describe('PayTo Agreement lifecycle reconciliation state', () => {
  test.each([
    ['pending', 30 * minute],
    ['created', 30 * minute],
    ['active', day],
    ['suspended', day],
    ['unknown', day],
    ['cancelled', null],
    ['declined', null],
    ['failed', null],
    ['expired', null],
  ] as const)(
    'schedules %s lifecycle polling at the required cadence',
    (state, expected) => {
      expect(reconciliationScheduleForState(state)).toBe(expected)
    },
  )

  test('confirms a successful known GET and stops confirmed terminal polling', () => {
    expect(
      decideReconciliationSuccess({
        currentState: 'active',
        currentConfidence: 'provisional',
        providerState: 'cancelled',
      }),
    ).toEqual({ kind: 'confirmed', state: 'cancelled', delayMs: null })
  })

  test('preserves a confirmed terminal projection when GET contradicts it', () => {
    expect(
      decideReconciliationSuccess({
        currentState: 'cancelled',
        currentConfidence: 'confirmed',
        providerState: 'active',
      }),
    ).toEqual({
      kind: 'contradiction',
      preservedState: 'cancelled',
      observedState: 'active',
      delayMs: day,
    })
  })

  test('retains an unknown raw GET state for review without coercing it', () => {
    expect(
      decideReconciliationSuccess({
        currentState: 'pending',
        currentConfidence: 'confirmed',
        providerState: 'paused_by_bank',
      }),
    ).toEqual({
      kind: 'unknown',
      rawState: 'paused_by_bank',
      delayMs: day,
    })
  })

  test.each([
    [1, 30_000],
    [2, 2 * minute],
    [3, 15 * minute],
    [4, 60 * minute],
    [5, 6 * 60 * minute],
  ])(
    'retries temporary GET failure %s after the bounded delay',
    (failureCount, delayMs) => {
      expect(
        decideReconciliationFailure({
          consecutiveFailures: failureCount,
          failureStartedAt: 1_000,
          nowMs: 2_000,
        }),
      ).toEqual({ kind: 'retry', delayMs })
    },
  )

  test('raises review on the sixth GET failure while continuing daily repair', () => {
    expect(
      decideReconciliationFailure({
        consecutiveFailures: 6,
        failureStartedAt: 1_000,
        nowMs: 2_000,
      }),
    ).toEqual({ kind: 'review', delayMs: day })
  })

  test('raises review after 24 hours even before six failures', () => {
    expect(
      decideReconciliationFailure({
        consecutiveFailures: 3,
        failureStartedAt: 1_000,
        nowMs: 1_000 + day,
      }),
    ).toEqual({ kind: 'review', delayMs: day })
  })

  test('only the live matching lease may record provider outcomes', () => {
    expect(
      canRecordReconciliationOutcome({
        activeToken: 'lease-a',
        presentedToken: 'lease-a',
        leaseExpiresAt: 181_000,
        nowMs: 181_000,
      }),
    ).toBe(true)
    expect(
      canRecordReconciliationOutcome({
        activeToken: 'lease-a',
        presentedToken: 'lease-b',
        leaseExpiresAt: 181_000,
        nowMs: 180_000,
      }),
    ).toBe(false)
    expect(
      canRecordReconciliationOutcome({
        activeToken: 'lease-a',
        presentedToken: 'lease-a',
        leaseExpiresAt: 181_000,
        nowMs: 181_001,
      }),
    ).toBe(false)
  })
})
