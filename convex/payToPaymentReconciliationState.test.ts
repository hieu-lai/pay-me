import { describe, expect, test } from 'vitest'

import {
  decidePaymentReconciliationFailure,
  decidePaymentReconciliationSuccess,
  paymentReconciliationDelay,
} from './payToPaymentReconciliationState'

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const states = [
  'created',
  'submitting',
  'pending',
  'under_investigation',
  'failed',
  'settled',
] as const
type State = (typeof states)[number]
const acceptedTransitions: ReadonlyArray<readonly [State | undefined, State]> =
  [
    ...(
      [undefined, ...states.filter((state) => state !== 'settled')] as const
    ).flatMap((current) => states.map((next) => [current, next] as const)),
    ['settled', 'settled'],
  ]

describe('PayTo Payment reconciliation state', () => {
  test.each([
    ['created', 5 * minute, minute],
    ['submitting', 15 * minute, minute],
    ['created', 15 * minute + 1, 5 * minute],
    ['submitting', hour, 5 * minute],
    ['created', hour + 1, 15 * minute],
    ['submitting', day, 15 * minute],
    ['created', day + 1, hour],
    ['pending', hour, 5 * minute],
    ['pending', hour + 1, 15 * minute],
    ['pending', day + 1, hour],
    ['under_investigation', day, hour],
    ['under_investigation', day + 1, 6 * hour],
    ['failed', hour, null],
    ['settled', hour, null],
  ] as const)(
    'schedules %s at age %d using the lifecycle cadence',
    (state, ageMs, expected) => {
      expect(paymentReconciliationDelay(state, ageMs)).toBe(expected)
    },
  )

  test.each(acceptedTransitions)(
    'accepts authoritative transition %s → %s',
    (current, next) => {
      expect(
        decidePaymentReconciliationSuccess({
          currentState: current,
          providerState: next,
          paymentAgeMs: hour,
        }),
      ).toMatchObject({ kind: 'confirmed', state: next })
    },
  )

  test.each([
    'created',
    'submitting',
    'pending',
    'under_investigation',
    'failed',
  ] as const)('keeps settled absorbing against later %s evidence', (next) => {
    expect(
      decidePaymentReconciliationSuccess({
        currentState: 'settled',
        providerState: next,
        paymentAgeMs: day,
      }),
    ).toEqual({
      kind: 'contradiction',
      preservedState: 'settled',
      observedState: next,
      delayMs: 0,
    })
  })

  test('preserves truth and continues reconciling unknown provider states', () => {
    expect(
      decidePaymentReconciliationSuccess({
        currentState: 'pending',
        providerState: 'provider_added_a_state',
        paymentAgeMs: 2 * hour,
      }),
    ).toEqual({
      kind: 'unknown',
      rawState: 'provider_added_a_state',
      delayMs: 15 * minute,
    })
  })

  test.each([
    [1, 0, 'retry'],
    [5, day - 1, 'retry'],
    [6, hour, 'alert'],
    [2, day, 'alert'],
  ] as const)(
    'classifies %d failures over %dms as %s',
    (consecutiveFailures, outageAgeMs, expectedKind) => {
      expect(
        decidePaymentReconciliationFailure({
          consecutiveFailures,
          failureStartedAt: 10_000,
          nowMs: 10_000 + outageAgeMs,
          safeDelayMs: 15 * minute,
        }),
      ).toEqual({ kind: expectedKind, delayMs: 15 * minute })
    },
  )
})
