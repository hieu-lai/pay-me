import { describe, expect, test, vi } from 'vitest'

import { csrfMiddleware } from './start'

const handleCsrfRequest = csrfMiddleware.options.server as NonNullable<
  typeof csrfMiddleware.options.server
>

function requestContext(origin: string) {
  const request = new Request('https://payme.example.test/_server', {
    method: 'POST',
    headers: { Origin: origin },
  })
  const next = vi.fn(() => ({
    request,
    pathname: '/_server',
    context: undefined,
    response: new Response('accepted'),
  }))
  const context = {
    handlerType: 'serverFn' as const,
    pathname: '/_server',
    context: undefined,
    request,
    next,
  } as unknown as Parameters<typeof handleCsrfRequest>[0]
  return { context, next }
}

function responseStatus(result: Awaited<ReturnType<typeof handleCsrfRequest>>) {
  return result instanceof Response ? result.status : result.response.status
}

describe('Money Request server-function CSRF boundary', () => {
  test('rejects a cross-origin server-function submission', async () => {
    const { context, next } = requestContext('https://forged.example.test')

    const response = await handleCsrfRequest(context)

    expect(responseStatus(response)).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  test('allows the trusted request origin to continue', async () => {
    const { context, next } = requestContext('https://payme.example.test')

    const response = await handleCsrfRequest(context)

    expect(responseStatus(response)).toBe(200)
    expect(next).toHaveBeenCalledOnce()
  })
})
