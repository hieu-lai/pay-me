import { describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'

import {
  handleMoneyRequestSubmission,
  MoneyRequestSubmissionError,
  moneyRequestIntentSchema,
} from './money-requests'

const intent = moneyRequestIntentSchema.parse({
  submissionKey: '018f22e2-7c00-7000-8000-000000000001',
  amountCents: 12_345,
  description: 'Shared dinner',
  payerIds: ['payer-id'],
})

function dependencies(
  overrides: Partial<Parameters<typeof handleMoneyRequestSubmission>[1]> = {},
) {
  return {
    authenticate: async () => ({ clerkUserId: 'requester_123', token: 'jwt' }),
    trustedIp: () => '203.0.113.42',
    now: () => 1_720_000_000_000,
    attestationSecret: 'test-ingress-attestation-secret-32-bytes',
    submit: vi.fn(async () => 'money-request-id'),
    ...overrides,
  }
}

describe('submitMoneyRequest trusted server ingress', () => {
  test('binds authenticated identity, trusted IP, and exact intent before submission', async () => {
    const deps = dependencies()

    await expect(handleMoneyRequestSubmission(intent, deps)).resolves.toEqual({
      moneyRequestId: 'money-request-id',
    })
    expect(deps.submit).toHaveBeenCalledOnce()
    expect(deps.submit).toHaveBeenCalledWith({
      token: 'jwt',
      intent,
      attestation: expect.objectContaining({
        issuedAtMs: 1_720_000_000_000,
        clerkUserId: 'requester_123',
        trustedIp: '203.0.113.42',
        intentDigest: expect.any(String),
        signature: expect.any(String),
      }),
    })
  })

  test('rejects unauthenticated requests before calling Convex', async () => {
    const deps = dependencies({
      authenticate: async () => ({ clerkUserId: null, token: null }),
    })

    await expect(handleMoneyRequestSubmission(intent, deps)).rejects.toEqual(
      new MoneyRequestSubmissionError('Unauthorized', 'UNAUTHORIZED'),
    )
    expect(deps.submit).not.toHaveBeenCalled()
  })

  test.each(['', 'unknown', '2001:db8::1', '203.0.113.042', '256.1.1.1'])(
    'rejects unavailable or non-canonical IPv4 %j before calling Convex',
    async (ip) => {
      const deps = dependencies({ trustedIp: () => ip })

      await expect(
        handleMoneyRequestSubmission(intent, deps),
      ).rejects.toMatchObject({
        code: 'VALIDATION_UNAVAILABLE',
        retryable: true,
      })
      expect(deps.submit).not.toHaveBeenCalled()
    },
  )

  test('fails closed when the attestation secret is unavailable', async () => {
    const deps = dependencies({ attestationSecret: '' })

    await expect(
      handleMoneyRequestSubmission(intent, deps),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    })
    expect(deps.submit).not.toHaveBeenCalled()
  })

  test('maps rejected ingress trust to a forbidden response', async () => {
    const deps = dependencies({
      submit: async () => {
        throw new ConvexError({
          code: 'INGRESS_TRUST_INVALID',
          message: 'Rejected',
        })
      },
    })

    await expect(handleMoneyRequestSubmission(intent, deps)).rejects.toEqual(
      new MoneyRequestSubmissionError('Forbidden', 'FORBIDDEN'),
    )
  })

  test.each([
    { ...intent, submissionKey: '018f22e2-7c00-4000-8000-000000000001' },
    { ...intent, amountCents: 1.5 },
    { ...intent, amountCents: 0 },
    { ...intent, amountCents: 1_000_000_001 },
    { ...intent, description: ' leading space' },
    { ...intent, description: 'line\nbreak' },
    { ...intent, payerIds: [] },
    { ...intent, payerIds: ['payer-id', 'payer-id'] },
    {
      ...intent,
      payerIds: [
        'payer-1',
        'payer-2',
        'payer-3',
        'payer-4',
        'payer-5',
        'payer-6',
      ],
    },
  ])('rejects a non-canonical intent %#', (candidate) => {
    expect(moneyRequestIntentSchema.safeParse(candidate).success).toBe(false)
  })
})
