import { afterEach, describe, expect, test, vi } from 'vitest'

import { createZeptoClient } from './client'
import type { ZeptoFetch } from './client'
import { ZeptoClientError } from './error'
import { getNextLink } from './pagination'

function jsonResponse(
  body: unknown,
  init: Omit<ResponseInit, 'headers'> & { headers?: HeadersInit } = {},
) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
}

function errorOfKind(kind: ZeptoClientError['kind']) {
  return expect.objectContaining({ name: 'ZeptoClientError', kind })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Zepto client transport', () => {
  test('uses the sandbox URL, serializes queries, and forces protected headers', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request.clone())
      return jsonResponse(
        { links: {}, data: [] },
        {
          headers: {
            Link: '<https://api.sandbox.zeptopayments.com/payto/payments?starting_after=next>; rel="next"',
            'Per-Page': '2',
          },
        },
      )
    })
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'secret-token',
      fetch,
    })
    const bypassFetch = vi.fn(async (_request: Request) =>
      jsonResponse({ links: {}, data: [] }),
    )

    const result = await client.payTo.GET('/payto/payments', {
      params: { query: { state: ['pending', 'settled'], per_page: 2 } },
      fetch: bypassFetch,
      headers: {
        Accept: 'text/plain',
        Authorization: 'Bearer caller-value',
        'Zepto-API-Version': '20250101',
      },
      middleware: [
        {
          onRequest({ request }) {
            const headers = new Headers(request.headers)
            headers.set('Authorization', 'Bearer middleware-value')
            headers.set('Zepto-API-Version', '19990101')
            return new Request(request, { headers })
          },
        },
      ],
    })

    expect(fetch).toHaveBeenCalledOnce()
    expect(bypassFetch).not.toHaveBeenCalled()
    expect(requests[0]?.url).toBe(
      'https://api.sandbox.zeptopayments.com/payto/payments?state=pending,settled&per_page=2',
    )
    expect(requests[0]?.headers.get('Accept')).toBe('application/json')
    expect(requests[0]?.headers.get('Authorization')).toBe(
      'Bearer secret-token',
    )
    expect(requests[0]?.headers.get('Zepto-API-Version')).toBe('20260101')
    expect(result.response.headers.get('Per-Page')).toBe('2')
    expect(getNextLink(result.response.headers.get('Link'))).toBe(
      'https://api.sandbox.zeptopayments.com/payto/payments?starting_after=next',
    )
  })

  test('uses the production URL', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      jsonResponse({ ping: 'pong' }),
    )
    const client = createZeptoClient({
      environment: 'production',
      accessToken: 'token',
      fetch,
    })

    await client.core.GET('/ping')

    expect(fetch.mock.calls[0]?.[0].url).toBe(
      'https://api.zeptopayments.com/ping',
    )
  })

  test('rejects per-request base URL overrides before sending the token', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      jsonResponse({ ping: 'pong' }),
    )
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    await expect(
      client.core.GET('/ping', { baseUrl: 'https://attacker.example.test' }),
    ).rejects.toMatchObject(errorOfKind('configuration'))
    expect(fetch).not.toHaveBeenCalled()
  })

  test('preserves 204 responses', async () => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch: async () => new Response(null, { status: 204 }),
    })

    const result = await client.core.DELETE('/agreements/{agreement_ref}', {
      params: { path: { agreement_ref: 'A.2' } },
    })

    expect(result.data).toBeUndefined()
    expect(result.response.status).toBe(204)
  })

  test('passes multipart bodies through without forcing a content type', async () => {
    const fetch = vi.fn(async (request: Request) => {
      const form = await request.formData()
      const file = form.get('file')
      expect(file).toBeInstanceOf(File)
      expect((file as File).name).toBe('evidence.pdf')
      expect(request.headers.get('Content-Type')).toMatch(
        /^multipart\/form-data; boundary=/,
      )
      return jsonResponse({ jsonapi: { version: '1.0' }, data: {} })
    })
    const form = new FormData()
    form.append(
      'file',
      new Blob(['pdf'], { type: 'application/pdf' }),
      'evidence.pdf',
    )
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    await client.investigations.POST(
      '/investigations/action_requests/{action_request_id}/upload',
      {
        params: { path: { action_request_id: crypto.randomUUID() } },
        body: 'evidence.pdf',
        bodySerializer: () => form,
      },
    )

    expect(fetch).toHaveBeenCalledOnce()
  })

  test.each([
    [
      'structured JSON',
      jsonResponse(
        { errors: [{ title: 'Nope', detail: 'Invalid request' }] },
        { status: 422 },
      ),
      { errors: [{ title: 'Nope', detail: 'Invalid request' }] },
    ],
    [
      'legacy string JSON',
      jsonResponse({ errors: 'Invalid request' }, { status: 400 }),
      { errors: 'Invalid request' },
    ],
    [
      'plain text',
      new Response('upstream unavailable', { status: 503 }),
      'upstream unavailable',
    ],
    ['empty', new Response(null, { status: 500 }), undefined],
  ])('retains %s error responses', async (_label, response, body) => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      maxRetries: 0,
      fetch: async () => response,
    })

    const error = await client.core
      .GET('/ping')
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ZeptoClientError)
    expect(error).toMatchObject({
      kind: 'http',
      status: response.status,
      method: 'GET',
      path: '/ping',
      body,
    })
  })

  test.each([
    ['empty', ''],
    ['malformed', '{not json'],
  ])('rejects an %s successful JSON response', async (_label, rawBody) => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch: async () => new Response(rawBody, { status: 200 }),
    })

    await expect(client.core.GET('/ping')).rejects.toMatchObject(
      errorOfKind('invalid_response'),
    )
  })

  test('reports timeouts', async () => {
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      timeoutMs: 5,
      maxRetries: 0,
      fetch: async (request) =>
        await new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    })

    await expect(client.core.GET('/ping')).rejects.toMatchObject(
      errorOfKind('timeout'),
    )
  })

  test('preserves caller aborts without retrying', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(
      async (request: Request) =>
        await new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    const promise = client.core.GET('/ping', { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toMatchObject(errorOfKind('aborted'))
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Zepto retry policy', () => {
  test('retries GET requests and honors Retry-After', async () => {
    const fetch = vi
      .fn<ZeptoFetch>()
      .mockResolvedValueOnce(
        new Response('busy', {
          status: 503,
          headers: { 'Retry-After': '0' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ping: 'pong' }))
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    const result = await client.core.GET('/ping')

    expect(result.data).toEqual({ ping: 'pong' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('retries core POSTs with the same caller idempotency key and body', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (request: Request) => {
      requests.push(request.clone())
      return requests.length === 1
        ? new Response('busy', {
            status: 503,
            headers: { 'Retry-After': '0' },
          })
        : jsonResponse({ data: {} }, { status: 201 })
    })
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })
    const body = {
      authoriser_contact_id: crypto.randomUUID(),
      description: 'Invoice 42',
      matures_at: '2026-08-10T00:00:00Z',
      amount: 4_200,
    }

    await client.core.POST('/payment_requests', {
      params: {
        header: {
          'Idempotency-Key': '0198-example-idempotency-key',
        },
      },
      body,
    })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(
      requests.map((request) => request.headers.get('Idempotency-Key')),
    ).toEqual(['0198-example-idempotency-key', '0198-example-idempotency-key'])
    expect(await requests[0]?.text()).toBe(await requests[1]?.text())
  })

  test('retries PayTo creates only when the body carries its caller UID', async () => {
    const fetch = vi
      .fn<ZeptoFetch>()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(jsonResponse({ data: {} }, { status: 201 }))
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    await client.payTo.POST('/payto/payments', {
      body: {
        uid: 'payment_000123',
        agreement_uid: 'agreement_000123',
        amount: 500,
        priority: 'attended',
      },
    })

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('does not retry non-idempotent POSTs', async () => {
    const fetch = vi.fn(async () => new Response('busy', { status: 503 }))
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    await expect(
      client.core.POST('/contacts/anyone', {
        body: {
          name: 'Ada',
          email: 'ada@example.com',
          branch_code: '123456',
          account_number: '12345678',
        },
      }),
    ).rejects.toMatchObject(errorOfKind('http'))
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('does not retry duplicate-key conflicts', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ meta: { resource_ref: 'PR.1' } }, { status: 409 }),
    )
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    await expect(
      client.core.POST('/payment_requests', {
        params: { header: { 'Idempotency-Key': 'same-key' } },
        body: {
          authoriser_contact_id: crypto.randomUUID(),
          description: 'Invoice',
          matures_at: '2026-08-10T00:00:00Z',
          amount: 100,
        },
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 409 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('stops after the configured retry count', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('busy', {
          status: 503,
          headers: { 'Retry-After': '0' },
        }),
    )
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      maxRetries: 2,
      fetch,
    })

    await expect(client.core.GET('/ping')).rejects.toMatchObject({
      kind: 'http',
      status: 503,
      retryAfterMs: 0,
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  test('does not retry before a Retry-After longer than 30 seconds', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('busy', {
          status: 503,
          headers: { 'Retry-After': '31' },
        }),
    )
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken: 'token',
      fetch,
    })

    await expect(client.core.GET('/ping')).rejects.toMatchObject({
      kind: 'http',
      retryAfterMs: 31_000,
    })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('production sandbox guards', () => {
  test('rejects every explicit sandbox-only route before fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: {} }))
    const client = createZeptoClient({
      environment: 'production',
      accessToken: 'token',
      fetch,
    })
    const calls: Array<() => Promise<unknown>> = [
      () =>
        client.core.POST('/simulate/incoming_npp_payid_payment', {
          body: {} as never,
        }),
      () =>
        client.core.POST('/simulate/incoming_npp_bban_payment', {
          body: {} as never,
        }),
      () =>
        client.core.POST('/simulate/incoming_de_payment', {
          body: {} as never,
        }),
      () =>
        client.payTo.POST(
          '/payto/agreements/{agreement_uid}/simulate_debtor_action',
          {
            params: { path: { agreement_uid: 'agreement-1' } },
            body: {} as never,
          },
        ),
      () =>
        client.investigations.POST(
          '/investigations/simulate_incoming_message',
          { body: {} as never },
        ),
    ]

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject(errorOfKind('sandbox_only'))
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects sandbox simulation fields in production request bodies', async () => {
    const fetch = vi.fn(async () => jsonResponse({ data: {} }, { status: 201 }))
    const client = createZeptoClient({
      environment: 'production',
      accessToken: 'token',
      fetch,
    })

    await expect(
      client.payTo.POST('/payto/agreements', {
        body: {
          uid: 'agreement-1',
          purpose: 'other',
          description: 'Test agreement',
          debtor: {
            party_name: 'Paying User',
            account_identifier: { type: 'bban', value: '123456-1234567' },
          },
          payment_terms: {
            type: 'fixed',
            frequency: 'adhoc',
            amount: 100,
            count: 1,
          },
          sandbox: { simulate: 'debtor_accept' },
        },
      }),
    ).rejects.toMatchObject(errorOfKind('sandbox_only'))
    expect(fetch).not.toHaveBeenCalled()
  })
})
