import { describe, expect, test, vi } from 'vitest'

import { createBankAccountAgreement } from './agreement'
import { createZeptoClient } from './client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Zepto Bank Account agreement creation', () => {
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

    const result = await createBankAccountAgreement(client, {
      providerUid: '018f22e2-7c00-7000-8000-000000000001',
      amountCents: 12_345,
      description: 'Shared dinner',
      creditor: {
        name: 'Requesting User',
        accountIdentifier: '123456-0012345',
      },
      debtor: {
        name: 'Paying User',
        accountIdentifier: '654321-0098765',
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
})
