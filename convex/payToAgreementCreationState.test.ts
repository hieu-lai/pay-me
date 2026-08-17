import { describe, expect, test } from 'vitest'

import {
  canRecordLeaseOutcome,
  claimDecision,
  creationFailureKind,
  creationStateForPostFailure,
  decideAfterNotFound,
  decideAfterVerificationFailure,
  isLegalCreationTransition,
  normalizedProviderErrorCategory,
  recoveryClassForProviderError,
} from './payToAgreementCreationState'

describe('PayTo Agreement creation state model', () => {
  test.each([
    ['verifying', 'checking', 'provider_outcome_uncertain'],
    ['verifying', 'retrying', 'provider_temporarily_unavailable'],
    ['retry_wait', undefined, 'provider_temporarily_unavailable'],
    ['manual_hold', undefined, 'operator_review_required'],
    ['failed', undefined, 'immutable_request_rejected'],
    ['created', undefined, undefined],
  ] as const)(
    'maps %s with %s tracking to safe failure %s',
    (state, trackingState, expected) => {
      expect(creationFailureKind(state, trackingState)).toBe(expected)
    },
  )

  test.each([
    ['queued', 'submitting'],
    ['submitting', 'created'],
    ['submitting', 'verifying'],
    ['submitting', 'retry_wait'],
    ['submitting', 'manual_hold'],
    ['submitting', 'failed'],
    ['verifying', 'created'],
    ['verifying', 'retry_wait'],
    ['verifying', 'manual_hold'],
    ['retry_wait', 'queued'],
    ['manual_hold', 'queued'],
    ['manual_hold', 'verifying'],
  ] as const)('permits %s to %s', (from, to) => {
    expect(isLegalCreationTransition(from, to)).toBe(true)
  })

  test.each([
    ['queued', 'created'],
    ['verifying', 'failed'],
    ['retry_wait', 'submitting'],
    ['created', 'queued'],
    ['failed', 'verifying'],
  ] as const)('rejects %s to %s', (from, to) => {
    expect(isLegalCreationTransition(from, to)).toBe(false)
  })

  test.each([
    [{ kind: 'timeout' }, 'verify'],
    [{ kind: 'network' }, 'verify'],
    [{ kind: 'invalid_response' }, 'verify'],
    [{ kind: 'http', status: 409 }, 'verify'],
    [
      { kind: 'http', status: 422, body: { errors: [{ code: 'ZPAGR00' }] } },
      'verify',
    ],
    [{ kind: 'http', status: 429 }, 'verify'],
    [{ kind: 'http', status: 503 }, 'verify'],
    [{ kind: 'configuration' }, 'hold'],
    [{ kind: 'http', status: 401 }, 'hold'],
    [{ kind: 'http', status: 403 }, 'hold'],
    [
      { kind: 'http', status: 422, body: { errors: [{ code: 'ZPAGR15' }] } },
      'retry',
    ],
    [
      { kind: 'http', status: 422, body: { errors: [{ code: 'ZPAGR01' }] } },
      'hold',
    ],
    [
      { kind: 'http', status: 422, body: { errors: [{ code: 'ZPAGR12' }] } },
      'fail',
    ],
    [{ kind: 'http', status: 422, body: { errors: [] } }, 'hold'],
  ] as const)('classifies $0 as $1', (error, expected) => {
    expect(recoveryClassForProviderError(error)).toBe(expected)
  })

  test('normalizes provider errors without retaining response detail', () => {
    expect(
      normalizedProviderErrorCategory({
        kind: 'http',
        status: 422,
        body: {
          errors: [
            {
              code: 'ZPAGR15',
              detail: 'raw provider detail must not be retained',
            },
          ],
        },
      }),
    ).toBe('http_422_ZPAGR15')
    expect(
      normalizedProviderErrorCategory({
        kind: 'http',
        status: 422,
        body: { errors: [{ code: 'account=9876543210 bearer secret' }] },
      }),
    ).toBe('http_422')
  })

  test('holds a retry-class rejection after the second POST cycle', () => {
    expect(creationStateForPostFailure('retry', 1)).toBe('retry_wait')
    expect(creationStateForPostFailure('retry', 2)).toBe('manual_hold')
  })

  test('requires two 404s and five quiet minutes before the second POST cycle', () => {
    const lastPostAt = 1_000

    expect(
      decideAfterNotFound({
        postCycle: 1,
        absenceCount: 1,
        verificationAttempt: 1,
        lastPostAt,
        nowMs: lastPostAt,
      }),
    ).toEqual({ kind: 'verify_later', delayMs: 30_000 })
    expect(
      decideAfterNotFound({
        postCycle: 1,
        absenceCount: 2,
        verificationAttempt: 2,
        lastPostAt,
        nowMs: lastPostAt + 30_000,
      }),
    ).toEqual({ kind: 'verify_later', delayMs: 90_000 })
    expect(
      decideAfterNotFound({
        postCycle: 1,
        absenceCount: 4,
        verificationAttempt: 4,
        lastPostAt,
        nowMs: lastPostAt + 5 * 60_000,
      }),
    ).toEqual({ kind: 'post_again' })
  })

  test('never permits a third automatic POST cycle and eventually holds', () => {
    const lastPostAt = 1_000
    const delays = [15, 60, 360, 1_440].map((minutes) => minutes * 60_000)

    for (const [index, delayMs] of delays.entries()) {
      expect(
        decideAfterNotFound({
          postCycle: 2,
          absenceCount: index + 1,
          verificationAttempt: index + 1,
          lastPostAt,
          nowMs:
            index === 0 ? lastPostAt : lastPostAt + (delays[index - 1] ?? 0),
        }),
      ).toEqual({
        kind: 'verify_later',
        delayMs: index === 0 ? delayMs : delayMs - (delays[index - 1] ?? 0),
      })
    }
    expect(
      decideAfterNotFound({
        postCycle: 2,
        absenceCount: 5,
        verificationAttempt: 5,
        lastPostAt,
        nowMs: lastPostAt + 24 * 60 * 60_000,
      }),
    ).toEqual({ kind: 'hold' })
  })

  test('live duplicate deliveries cannot claim or record outcomes', () => {
    expect(
      claimDecision({
        state: 'submitting',
        leaseToken: 'worker-a',
        leaseExpiresAt: 181_000,
        nowMs: 1_000,
        postCycle: 1,
      }),
    ).toEqual({ kind: 'no_op' })
    expect(
      canRecordLeaseOutcome({
        activeToken: 'worker-a',
        presentedToken: 'worker-b',
        leaseExpiresAt: 181_000,
        nowMs: 2_000,
      }),
    ).toBe(false)
  })

  test('an expired submitting lease recovers into same-UID verification', () => {
    expect(
      claimDecision({
        state: 'submitting',
        leaseToken: 'crashed-worker',
        leaseExpiresAt: 180_000,
        nowMs: 180_001,
        postCycle: 1,
      }),
    ).toEqual({ kind: 'claim_verification', recoveredExpiredLease: true })
  })

  test('caps claims at two POST cycles and six reserved HTTP attempts', () => {
    expect(
      claimDecision({ state: 'queued', nowMs: 1_000, postCycle: 1 }),
    ).toEqual({ kind: 'claim_post', postCycle: 2, reservedPostAttempts: 6 })
    expect(
      claimDecision({ state: 'queued', nowMs: 1_000, postCycle: 2 }),
    ).toEqual({ kind: 'hold_budget_exhausted' })
  })

  test('bounds non-404 verification failures instead of retrying forever', () => {
    expect(
      decideAfterVerificationFailure({
        postCycle: 1,
        verificationAttempt: 1,
        lastPostAt: 1_000,
        nowMs: 1_000,
      }),
    ).toEqual({ kind: 'verify_later', delayMs: 30_000 })
    expect(
      decideAfterVerificationFailure({
        postCycle: 1,
        verificationAttempt: 4,
        lastPostAt: 1_000,
        nowMs: 1_000,
      }),
    ).toEqual({ kind: 'hold' })
    expect(
      decideAfterVerificationFailure({
        postCycle: 2,
        verificationAttempt: 4,
        lastPostAt: 1_000,
        nowMs: 1_000 + 6 * 60 * 60_000,
      }),
    ).toEqual({ kind: 'verify_later', delayMs: 18 * 60 * 60_000 })
    expect(
      decideAfterVerificationFailure({
        postCycle: 2,
        verificationAttempt: 5,
        lastPostAt: 1_000,
        nowMs: 1_000,
      }),
    ).toEqual({ kind: 'hold' })
  })
})
