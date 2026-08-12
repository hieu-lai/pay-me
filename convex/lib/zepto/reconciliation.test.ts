import { describe, expect, test } from 'vitest'

import { createZeptoClient } from './client'
import {
  getAgreementHistoryEvidence,
  getAgreementLifecycleByUid,
} from './reconciliation'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(response: Response) {
  return createZeptoClient({
    environment: 'sandbox',
    accessToken: 'sandbox-token',
    maxRetries: 0,
    fetch: async () => response,
  })
}

describe('Zepto agreement lifecycle reconciliation transport', () => {
  test('accepts an unknown raw state from a successful per-UID GET boundary', async () => {
    const result = await getAgreementLifecycleByUid(
      clientWith(
        jsonResponse({
          data: {
            uid: 'agreement-1',
            state: 'paused_by_bank',
            created_at: '2026-08-11T01:02:03.000Z',
            mms_agreement_id: null,
          },
        }),
      ),
      'agreement-1',
    )

    expect(result).toEqual({ providerState: 'paused_by_bank' })
  })

  test('rejects a successful GET body for another UID', async () => {
    await expect(
      getAgreementLifecycleByUid(
        clientWith(
          jsonResponse({
            data: {
              uid: 'agreement-other',
              state: 'active',
              created_at: '2026-08-11T01:02:03.000Z',
              mms_agreement_id: null,
            },
          }),
        ),
        'agreement-1',
      ),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })

  test('normalizes bounded history evidence without retaining provider bodies', async () => {
    const result = await getAgreementHistoryEvidence(
      clientWith(
        jsonResponse({
          data: [
            {
              id: 'event-2',
              resource_uid: 'agreement-1',
              published_at: '2026-08-11T02:00:00.000Z',
              type: 'payto_agreement.suspended',
              body: { failure: { detail: 'sensitive provider detail' } },
            },
            {
              id: 'event-1',
              resource_uid: 'agreement-1',
              published_at: '2026-08-11T01:00:00.000Z',
              type: 'payto_agreement.activated',
            },
          ],
        }),
      ),
      'agreement-1',
    )

    expect(result).toEqual({
      eventCount: 2,
      eventTypes: ['payto_agreement.activated', 'payto_agreement.suspended'],
      latestProviderPublishedAt: Date.parse('2026-08-11T02:00:00.000Z'),
    })
    expect(JSON.stringify(result)).not.toContain('sensitive provider detail')
  })
})
