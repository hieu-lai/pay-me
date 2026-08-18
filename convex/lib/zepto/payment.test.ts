import { describe, expect, test, vi } from 'vitest'

import { createZeptoClient } from './client'
import {
  createPayment,
  getPaymentLifecycleByUid,
  retryPayment,
} from './payment'

function paymentResponse(
  overrides: Partial<{
    uid: string
    agreement_uid: string
    state: string
    created_at: string
    amount: number | undefined
    failure: {
      title: string
      detail: string
      code: string
      retryable: boolean
    }
  }> = {},
  status = 201,
) {
  return new Response(
    JSON.stringify({
      data: {
        uid: 'payment_36',
        agreement_uid: 'agreement_36',
        source_payto_refund_uid: null,
        state: 'pending',
        reference: null,
        description: null,
        priority: 'unattended',
        creditor: {
          party_name: 'Requester',
          ultimate_party_name: 'Requester',
          account_identifier: { type: 'bban', value: '123456-0012345' },
        },
        creditor_reference: null,
        debtor: {
          party_name: 'Payer',
          ultimate_party_name: 'Payer',
          account_identifier: { type: 'bban', value: '654321-0098765' },
        },
        amount: 12_500,
        last_payment: null,
        failure: null,
        created_at: '2026-08-13T10:00:00+10:00',
        links: {
          self: 'https://api.sandbox.zeptopayments.com/payto/payments/payment_36',
          agreement:
            'https://api.sandbox.zeptopayments.com/payto/agreements/agreement_36',
          source_refund: null,
        },
        ...overrides,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('Zepto PayTo Payment creation', () => {
  test('posts the pinned unattended request once and returns allowlisted evidence', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request.clone())
      return paymentResponse()
    })
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch,
      maxRetries: 0,
    })

    await expect(
      createPayment(client, {
        providerUid: 'payment_36',
        agreementProviderUid: 'agreement_36',
        amountCents: 12_500,
        priority: 'unattended',
      }),
    ).resolves.toEqual({
      providerUid: 'payment_36',
      agreementProviderUid: 'agreement_36',
      state: 'pending',
      createdAt: '2026-08-13T10:00:00+10:00',
    })

    expect(fetch).toHaveBeenCalledOnce()
    expect(requests[0]?.headers.get('Zepto-API-Version')).toBe('20260101')
    expect(await requests[0]?.json()).toEqual({
      uid: 'payment_36',
      agreement_uid: 'agreement_36',
      amount: 12_500,
      priority: 'unattended',
    })
  })

  test('passes an explicit Payment outcome simulation only through the sandbox contract', async () => {
    const requests: Request[] = []
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async (request) => {
        requests.push(request.clone())
        return paymentResponse()
      },
      maxRetries: 0,
    })

    await createPayment(client, {
      providerUid: 'payment_36',
      agreementProviderUid: 'agreement_36',
      amountCents: 12_500,
      priority: 'unattended',
      sandboxSimulation: {
        simulate: 'requires_investigation',
        delaySeconds: 30,
      },
    })

    expect(await requests[0]?.json()).toMatchObject({
      sandbox: { simulate: 'requires_investigation', delay: 30 },
    })
  })

  test('refuses a sandbox Payment outcome simulation before production transport', async () => {
    const fetch = vi.fn(async () => paymentResponse())
    const client = createZeptoClient({
      environment: 'production',
      accessToken: 'production-token',
      fetch,
      maxRetries: 0,
    })

    await expect(
      createPayment(client, {
        providerUid: 'payment_36',
        agreementProviderUid: 'agreement_36',
        amountCents: 12_500,
        priority: 'unattended',
        sandboxSimulation: { simulate: 'auto_settle' },
      }),
    ).rejects.toMatchObject({ kind: 'sandbox_only' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    [
      { uid: 'another_payment' },
      'returned another Payment UID',
      'uid_mismatch',
    ],
    [
      { agreement_uid: 'another_agreement' },
      'returned another Agreement UID',
      'uid_mismatch',
    ],
    [{ state: 'unknown' }, 'returned an invalid lifecycle', 'invalid_response'],
    [
      { created_at: 'not-a-date' },
      'returned an invalid timestamp',
      'invalid_response',
    ],
    [
      { amount: undefined },
      'omitted a required Payment field',
      'invalid_response',
    ],
  ] as const)(
    'rejects a response that %s',
    async (overrides, _description, kind) => {
      const client = createZeptoClient({
        environment: 'sandbox',
        accessToken: 'sandbox-token',
        fetch: async () => paymentResponse(overrides),
        maxRetries: 0,
      })

      await expect(
        createPayment(client, {
          providerUid: 'payment_36',
          agreementProviderUid: 'agreement_36',
          amountCents: 12_500,
          priority: 'unattended',
        }),
      ).rejects.toMatchObject({ kind })
    },
  )

  test('rejects an invalid request before transport', async () => {
    const fetch = vi.fn(async () => paymentResponse())
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch,
      maxRetries: 0,
    })

    await expect(
      createPayment(client, {
        providerUid: '',
        agreementProviderUid: 'agreement_36',
        amountCents: 0,
        priority: 'unattended',
      }),
    ).rejects.toMatchObject({ kind: 'configuration' })
    expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    ['bad uid', 'agreement_36'],
    ['payment_36', 'bad/agreement'],
  ])(
    'rejects non-RFC3986 UIDs before transport',
    async (providerUid, agreementProviderUid) => {
      const fetch = vi.fn(async () => paymentResponse())
      const client = createZeptoClient({
        environment: 'sandbox',
        accessToken: 'sandbox-token',
        fetch,
        maxRetries: 0,
      })

      await expect(
        createPayment(client, {
          providerUid,
          agreementProviderUid,
          amountCents: 12_500,
          priority: 'unattended',
        }),
      ).rejects.toMatchObject({ kind: 'configuration' })
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})

describe('Zepto PayTo Payment reconciliation', () => {
  test('validates a same-UID GET while preserving an unknown lifecycle value', async () => {
    const requests: Request[] = []
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async (request) => {
        requests.push(request.clone())
        return paymentResponse({ state: 'provider_added_a_state' }, 200)
      },
      maxRetries: 0,
    })

    await expect(
      getPaymentLifecycleByUid(client, {
        providerUid: 'payment_36',
        agreementProviderUid: 'agreement_36',
        amountCents: 12_500,
        priority: 'unattended',
      }),
    ).resolves.toEqual({ providerState: 'provider_added_a_state' })
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0].url).pathname).toBe('/payto/payments/payment_36')
    expect(requests[0]?.headers.get('Zepto-API-Version')).toBe('20260101')
  })

  test.each([
    [{ uid: 'another_payment' }, 'another Payment UID', 'uid_mismatch'],
    [
      { agreement_uid: 'another_agreement' },
      'another Agreement UID',
      'uid_mismatch',
    ],
    [{ amount: 99_999 }, 'another amount', 'invalid_response'],
  ] as const)(
    'rejects a GET response for %s',
    async (override, _case, kind) => {
      const client = createZeptoClient({
        environment: 'sandbox',
        accessToken: 'sandbox-token',
        fetch: async () => paymentResponse(override, 200),
        maxRetries: 0,
      })

      await expect(
        getPaymentLifecycleByUid(client, {
          providerUid: 'payment_36',
          agreementProviderUid: 'agreement_36',
          amountCents: 12_500,
          priority: 'unattended',
        }),
      ).rejects.toMatchObject({ kind })
    },
  )

  test('returns only the retry evidence from a failed Payment', async () => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async () =>
        paymentResponse(
          {
            state: 'failed',
            failure: {
              title: 'Insufficient funds',
              detail: 'sensitive provider detail',
              code: 'AB01',
              retryable: true,
            },
          },
          200,
        ),
      maxRetries: 0,
    })

    await expect(
      getPaymentLifecycleByUid(client, {
        providerUid: 'payment_36',
        agreementProviderUid: 'agreement_36',
        amountCents: 12_500,
        priority: 'unattended',
      }),
    ).resolves.toEqual({
      providerState: 'failed',
      failure: { code: 'AB01', retryable: true },
    })
  })
})

describe('Zepto PayTo Payment retry', () => {
  test('posts once to the permanent Payment retry resource', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request.clone())
      return new Response(null, { status: 202 })
    })
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch,
      maxRetries: 0,
    })

    await expect(
      retryPayment(client, { providerUid: 'payment_36' }),
    ).resolves.toEqual({ accepted: true })
    expect(fetch).toHaveBeenCalledOnce()
    expect(new URL(requests[0].url).pathname).toBe(
      '/payto/payments/payment_36/retry',
    )
    expect(requests[0]?.headers.get('Zepto-API-Version')).toBe('20260101')
  })

  test('passes an explicit retry outcome simulation through the sandbox contract', async () => {
    const requests: Request[] = []
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async (request) => {
        requests.push(request.clone())
        return new Response(null, { status: 202 })
      },
      maxRetries: 0,
    })

    await retryPayment(client, {
      providerUid: 'payment_36',
      sandboxSimulation: { simulate: 'auto_settle' },
    })

    expect(await requests[0]?.json()).toEqual({
      sandbox: { simulate: 'auto_settle' },
    })
  })
})
