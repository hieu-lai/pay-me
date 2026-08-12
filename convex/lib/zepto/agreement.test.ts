import { describe, expect, test, vi } from 'vitest'

import { createAgreement, getAgreementByUid } from './agreement'
import { createZeptoClient } from './client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Zepto agreement creation', () => {
  test('preserves PayID alias kinds in the agreement payload', async () => {
    let request: Request | undefined
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async (input) => {
        request = input.clone()
        return jsonResponse(
          {
            data: {
              uid: 'agreement_payid',
              state: 'pending',
              created_at: '2026-08-11T09:30:00+10:00',
              mms_agreement_id: null,
            },
          },
          201,
        )
      },
    })

    await createAgreement(client, {
      providerUid: 'agreement_payid',
      amountCents: 100,
      description: 'PayID request',
      creditor: {
        name: 'Requester',
        accountIdentifier: {
          type: 'alias_organisation_identifier',
          value: 'requester-campaign',
        },
      },
      debtor: {
        name: 'Payer',
        accountIdentifier: { type: 'alias_phone', value: '+61-411222333' },
      },
    })

    const body = (await request?.json()) as {
      creditor: { account_identifier: unknown }
      debtor: { account_identifier: unknown }
    }
    expect(body.creditor.account_identifier).toEqual({
      type: 'alias_organisation_identifier',
      value: 'requester-campaign',
    })
    expect(body.debtor.account_identifier).toEqual({
      type: 'alias_phone',
      value: '+61-411222333',
    })
  })

  test('posts the pinned one-payment sandbox contract with the preallocated UID', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request.clone())
      return jsonResponse(
        {
          data: {
            uid: '018f22e2-7c00-7000-8000-000000000001',
            state: 'pending',
            created_at: '2026-08-11T09:30:00+10:00',
            mms_agreement_id: '3de455278b21196da0c4599025cb7dfa',
          },
        },
        201,
      )
    })
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch,
    })

    const result = await createAgreement(client, {
      providerUid: '018f22e2-7c00-7000-8000-000000000001',
      amountCents: 12_345,
      description: 'Shared dinner',
      creditor: {
        name: 'Requesting User',
        accountIdentifier: { type: 'bban', value: '123456-0012345' },
      },
      debtor: {
        name: 'Paying User',
        accountIdentifier: { type: 'bban', value: '654321-0098765' },
      },
    })

    expect(fetch).toHaveBeenCalledOnce()
    expect(requests[0]?.url).toBe(
      'https://api.sandbox.zeptopayments.com/payto/agreements',
    )
    expect(requests[0]?.headers.get('Zepto-API-Version')).toBe('20260101')
    expect(await requests[0]?.json()).toEqual({
      uid: '018f22e2-7c00-7000-8000-000000000001',
      purpose: 'other',
      description: 'Shared dinner',
      payment_terms: {
        type: 'fixed',
        frequency: 'adhoc',
        amount: 12_345,
        count: 1,
      },
      creditor: {
        party_name: 'Requesting User',
        ultimate_party_name: 'Requesting User',
        account_identifier: { type: 'bban', value: '123456-0012345' },
      },
      debtor: {
        party_name: 'Paying User',
        ultimate_party_name: 'Paying User',
        account_identifier: { type: 'bban', value: '654321-0098765' },
      },
    })
    expect(result).toEqual({
      state: 'pending',
      createdAt: '2026-08-11T09:30:00+10:00',
      mmsAgreementId: '3de455278b21196da0c4599025cb7dfa',
    })
  })

  test('exhausts all three same-UID HTTP attempts on a 500 response', async () => {
    const requests: Request[] = []
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async (request) => {
        requests.push(request.clone())
        return new Response('temporary failure', {
          status: 500,
          headers: { 'Retry-After': '0' },
        })
      },
    })
    const input = {
      providerUid: 'agreement_500',
      amountCents: 12_345,
      description: 'Shared dinner',
      creditor: {
        name: 'Requesting User',
        accountIdentifier: { type: 'bban' as const, value: '123456-0012345' },
      },
      debtor: {
        name: 'Paying User',
        accountIdentifier: { type: 'bban' as const, value: '654321-0098765' },
      },
    }

    await expect(createAgreement(client, input)).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    })
    expect(requests).toHaveLength(3)
    const bodies = (await Promise.all(
      requests.map((request) => request.json()),
    )) as Array<{ uid: string }>
    expect(bodies.map(({ uid }) => uid)).toEqual([
      input.providerUid,
      input.providerUid,
      input.providerUid,
    ])
  })
})

describe('Zepto agreement verification', () => {
  test('gets and normalizes an agreement by its immutable UID', async () => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch: async () =>
        jsonResponse({
          data: {
            uid: 'agreement_123',
            state: 'pending',
            created_at: '2026-08-11T09:30:00+10:00',
            mms_agreement_id: null,
          },
        }),
    })

    await expect(getAgreementByUid(client, 'agreement_123')).resolves.toEqual({
      state: 'pending',
      createdAt: '2026-08-11T09:30:00+10:00',
      mmsAgreementId: null,
    })
  })

  test('rejects a resource returned for another UID', async () => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch: async () =>
        jsonResponse({
          data: {
            uid: 'another_uid',
            state: 'pending',
            created_at: '2026-08-11T09:30:00+10:00',
            mms_agreement_id: null,
          },
        }),
    })

    await expect(
      getAgreementByUid(client, 'agreement_123'),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})
