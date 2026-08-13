import { describe, expect, test, vi } from 'vitest'

import { createZeptoClient } from './client'
import { createPayment, getPaymentLifecycleByUid } from './payment'

function paymentResponse(
  overrides: Partial<{
    uid: string
    agreement_uid: string
    state: string
    created_at: string
    amount: number | undefined
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

  test.each([
    [{ uid: 'another_payment' }, 'returned another Payment UID'],
    [{ agreement_uid: 'another_agreement' }, 'returned another Agreement UID'],
    [{ state: 'unknown' }, 'returned an invalid lifecycle'],
    [{ created_at: 'not-a-date' }, 'returned an invalid timestamp'],
    [{ amount: undefined }, 'omitted a required Payment field'],
  ] as const)('rejects a response that %s', async (overrides, _description) => {
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
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })

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
    [{ uid: 'another_payment' }, 'another Payment UID'],
    [{ agreement_uid: 'another_agreement' }, 'another Agreement UID'],
    [{ amount: 99_999 }, 'another amount'],
  ] as const)('rejects a GET response for %s', async (override, _case) => {
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
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})
