import { describe, expect, test, vi } from 'vitest'

import { createZeptoClient } from './client'
import { resolvePayIdAlias } from './aliasResolution'

describe('Zepto PayID alias resolution', () => {
  test.each([
    ['alias_phone', '+61-411222333'],
    ['alias_email', 'payer@example.com'],
    ['alias_abn', '51824753556'],
    ['alias_organisation_identifier', 'example-campaign'],
  ] as const)(
    'preserves the exact %s kind and discards the display name',
    async (type, value) => {
      const requests: Request[] = []
      const fetch = vi.fn(async (request: Request) => {
        requests.push(request.clone())
        return new Response(
          JSON.stringify({ data: { display_name: 'Transient Zepto Name' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      })
      const client = createZeptoClient({
        environment: 'sandbox',
        accessToken: 'sandbox-token',
        fetch,
      })

      await expect(
        resolvePayIdAlias(client, {
          alias: { type, value },
          requesterId: 'payme_DeterministicPseudonym123',
          trustedIp: '203.0.113.42',
        }),
      ).resolves.toBeUndefined()

      expect(fetch).toHaveBeenCalledOnce()
      expect(requests[0]?.url).toBe(
        'https://api.sandbox.zeptopayments.com/payto/alias_resolution',
      )
      expect(await requests[0]?.json()).toEqual({
        type,
        value,
        requester: {
          id: 'payme_DeterministicPseudonym123',
          remote_ip: '203.0.113.42',
        },
      })
    },
  )

  test('rejects a success response without a display name', async () => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'sandbox-token',
      fetch: async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    })

    await expect(
      resolvePayIdAlias(client, {
        alias: { type: 'alias_email', value: 'payer@example.com' },
        requesterId: 'payme_DeterministicPseudonym123',
        trustedIp: '203.0.113.42',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})
