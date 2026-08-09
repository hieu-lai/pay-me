import createClient from 'openapi-fetch'
import type { Client, Middleware } from 'openapi-fetch'

import type { paths as ClientPaths } from './generated/clients'
import type { paths as ConfirmationOfPayeePaths } from './generated/confirmationOfPayee'
import type { paths as CorePaths } from './generated/core'
import type { paths as InvestigationPaths } from './generated/investigations'
import type { paths as MerchantReportPaths } from './generated/merchantReports'
import type { paths as PayToPaths } from './generated/payTo'
import { ZeptoClientError } from './error'

export const ZEPTO_API_VERSION = '20260101'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RETRIES = 2
const MAX_RETRY_AFTER_MS = 30_000
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
const CORE_IDEMPOTENT_PATHS = new Set([
  '/payments',
  '/payment_requests',
  '/transfers',
])
const PAY_TO_UID_PATHS = new Set([
  '/payto/agreements',
  '/payto/payments',
  '/payto/refunds',
])
const CLIENT_REQUEST_METHODS = new Set([
  'request',
  'GET',
  'PUT',
  'POST',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'PATCH',
  'TRACE',
])

export type ZeptoEnvironment = 'sandbox' | 'production'
export type ZeptoFetch = (request: Request) => Promise<Response>

export type CreateZeptoClientOptions = {
  environment: ZeptoEnvironment
  accessToken: string
  fetch?: ZeptoFetch
  timeoutMs?: number
  maxRetries?: number
}

export type ZeptoClient = {
  core: Client<CorePaths>
  payTo: Client<PayToPaths>
  clients: Client<ClientPaths>
  merchantReports: Client<MerchantReportPaths>
  investigations: Client<InvestigationPaths>
  confirmationOfPayee: Client<ConfirmationOfPayeePaths>
}

const baseUrls: Record<ZeptoEnvironment, string> = {
  sandbox: 'https://api.sandbox.zeptopayments.com',
  production: 'https://api.zeptopayments.com',
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname
}

function isSandboxOnlyPath(path: string): boolean {
  return (
    path.startsWith('/simulate/') ||
    path === '/investigations/simulate_incoming_message' ||
    /^\/payto\/agreements\/[^/]+\/simulate_debtor_action$/.test(path)
  )
}

function isCoreIdempotentPath(path: string): boolean {
  return (
    CORE_IDEMPOTENT_PATHS.has(path) || /^\/credits\/[^/]+\/refunds$/.test(path)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function hasPayToUid(request: Request): Promise<boolean> {
  try {
    const body: unknown = JSON.parse(await request.clone().text())
    return isRecord(body) && typeof body.uid === 'string' && body.uid.length > 0
  } catch {
    return false
  }
}

async function canRetry(request: Request): Promise<boolean> {
  if (request.method === 'GET') return true
  if (request.method !== 'POST') return false

  const path = requestPath(request)
  if (isCoreIdempotentPath(path)) {
    return Boolean(request.headers.get('Idempotency-Key')?.trim())
  }
  return PAY_TO_UID_PATHS.has(path) && (await hasPayToUid(request))
}

function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000

  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

function parseBody(rawBody: string): unknown {
  if (!rawBody) return undefined
  try {
    return JSON.parse(rawBody) as unknown
  } catch {
    return rawBody
  }
}

async function httpError(
  request: Request,
  response: Response,
): Promise<ZeptoClientError> {
  const rawBody = await response.clone().text()
  return new ZeptoClientError({
    kind: 'http',
    message: `Zepto ${request.method} ${requestPath(request)} failed with HTTP ${response.status}.`,
    status: response.status,
    headers: response.headers,
    body: parseBody(rawBody),
    rawBody,
    method: request.method,
    path: requestPath(request),
    retryAfterMs: parseRetryAfter(
      response.headers.get('Retry-After'),
      Date.now(),
    ),
  })
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (isRecord(error) && error.name === 'AbortError')
  )
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function fetchAttempt(
  baseFetch: ZeptoFetch,
  request: Request,
  timeoutMs: number,
): Promise<Response> {
  if (request.signal.aborted) {
    throw new ZeptoClientError({
      kind: 'aborted',
      message: `Zepto ${request.method} ${requestPath(request)} was aborted by the caller.`,
      method: request.method,
      path: requestPath(request),
    })
  }

  const controller = new AbortController()
  const timeoutReason = new DOMException('Timed out', 'TimeoutError')
  const abortFromCaller = () => controller.abort(request.signal.reason)
  const callerAborted = () => request.signal.aborted
  const attemptTimedOut = () => controller.signal.reason === timeoutReason

  request.signal.addEventListener('abort', abortFromCaller, { once: true })

  const timeout = setTimeout(() => {
    controller.abort(timeoutReason)
  }, timeoutMs)

  try {
    return await baseFetch(
      new Request(request.clone(), { signal: controller.signal }),
    )
  } catch (error) {
    if (callerAborted()) {
      throw new ZeptoClientError({
        kind: 'aborted',
        message: `Zepto ${request.method} ${requestPath(request)} was aborted by the caller.`,
        method: request.method,
        path: requestPath(request),
        cause: error,
      })
    }
    if (attemptTimedOut() || isAbortError(error)) {
      throw new ZeptoClientError({
        kind: 'timeout',
        message: `Zepto ${request.method} ${requestPath(request)} timed out.`,
        method: request.method,
        path: requestPath(request),
        cause: error,
      })
    }
    if (error instanceof ZeptoClientError) throw error
    throw new ZeptoClientError({
      kind: 'network',
      message: `Zepto ${request.method} ${requestPath(request)} failed before receiving a response.`,
      method: request.method,
      path: requestPath(request),
      cause: error,
    })
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', abortFromCaller)
  }
}

function createZeptoFetch(options: {
  environment: ZeptoEnvironment
  baseUrl: string
  accessToken: string
  fetch: ZeptoFetch
  timeoutMs: number
  maxRetries: number
}): ZeptoFetch {
  return async (inputRequest) => {
    if (new URL(inputRequest.url).origin !== options.baseUrl) {
      throw new ZeptoClientError({
        kind: 'configuration',
        message: 'Zepto requests must use the configured environment URL.',
        method: inputRequest.method,
        path: requestPath(inputRequest),
      })
    }

    const headers = new Headers(inputRequest.headers)
    headers.set('Accept', 'application/json')
    headers.set('Authorization', `Bearer ${options.accessToken}`)
    headers.set('Zepto-API-Version', ZEPTO_API_VERSION)
    const request = new Request(inputRequest, { headers })
    const path = requestPath(request)
    if (options.environment === 'production' && isSandboxOnlyPath(path)) {
      throw new ZeptoClientError({
        kind: 'sandbox_only',
        message: `Zepto sandbox-only endpoint cannot be called in production: ${request.method} ${path}.`,
        method: request.method,
        path,
      })
    }

    const retryableRequest = await canRetry(request)

    for (let retry = 0; ; retry += 1) {
      let response: Response
      try {
        response = await fetchAttempt(options.fetch, request, options.timeoutMs)
      } catch (error) {
        if (
          !(error instanceof ZeptoClientError) ||
          !retryableRequest ||
          retry >= options.maxRetries ||
          error.kind === 'aborted'
        ) {
          throw error
        }
        await wait(250 * 2 ** retry)
        continue
      }

      if (response.ok) return response

      const retryAfterMs = parseRetryAfter(
        response.headers.get('Retry-After'),
        Date.now(),
      )
      const shouldRetry =
        retryableRequest &&
        retry < options.maxRetries &&
        RETRYABLE_STATUSES.has(response.status) &&
        (retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS)

      if (!shouldRetry) throw await httpError(request, response)

      await wait(retryAfterMs ?? 250 * 2 ** retry)
    }
  }
}

function validatePositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: `${name} must be a positive number.`,
    })
  }
}

function validateRetryCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: 'maxRetries must be a non-negative integer.',
    })
  }
}

function createApiClient<TPaths extends object>(options: {
  baseUrl: string
  fetch: ZeptoFetch
  middleware: Middleware
}): Client<TPaths> {
  const client = createClient<TPaths>({
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    querySerializer: {
      array: { style: 'form', explode: false },
    },
  })
  client.use(options.middleware)

  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (
        typeof property !== 'string' ||
        !CLIENT_REQUEST_METHODS.has(property) ||
        typeof value !== 'function'
      ) {
        return value
      }

      return (...args: unknown[]) => {
        const initIndex = property === 'request' ? 2 : 1
        const init = isRecord(args[initIndex]) ? args[initIndex] : {}
        args[initIndex] = { ...init, fetch: options.fetch }
        return Reflect.apply(value, target, args)
      }
    },
  })
}

/** Create typed clients for every outbound Zepto 20260101 API family. */
export function createZeptoClient(
  options: CreateZeptoClientOptions,
): ZeptoClient {
  const accessToken = options.accessToken.trim()
  if (!accessToken) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: 'The Zepto personal access token is empty.',
    })
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  validatePositiveNumber(timeoutMs, 'timeoutMs')
  validateRetryCount(maxRetries)

  const baseUrl = baseUrls[options.environment]
  if (!baseUrl) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: 'The Zepto environment must be sandbox or production.',
    })
  }

  const zeptoFetch = createZeptoFetch({
    environment: options.environment,
    baseUrl,
    accessToken,
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
    timeoutMs,
    maxRetries,
  })
  const middleware: Middleware = {
    onRequest({ request }) {
      const headers = new Headers(request.headers)
      headers.set('Accept', 'application/json')
      headers.set('Authorization', `Bearer ${accessToken}`)
      headers.set('Zepto-API-Version', ZEPTO_API_VERSION)
      return new Request(request, { headers })
    },
    async onResponse({ request, response }) {
      if (
        response.status === 204 ||
        response.status === 205 ||
        request.method === 'HEAD'
      ) {
        return
      }

      const rawBody = await response.clone().text()
      try {
        if (!rawBody) throw new Error('Empty response body')
        JSON.parse(rawBody)
      } catch (error) {
        throw new ZeptoClientError({
          kind: 'invalid_response',
          message: `Zepto ${request.method} ${requestPath(request)} returned an invalid JSON success response.`,
          status: response.status,
          headers: response.headers,
          rawBody,
          method: request.method,
          path: requestPath(request),
          cause: error,
        })
      }
    },
  }

  const clientOptions = { baseUrl, fetch: zeptoFetch, middleware }
  return {
    core: createApiClient<CorePaths>(clientOptions),
    payTo: createApiClient<PayToPaths>(clientOptions),
    clients: createApiClient<ClientPaths>(clientOptions),
    merchantReports: createApiClient<MerchantReportPaths>(clientOptions),
    investigations: createApiClient<InvestigationPaths>(clientOptions),
    confirmationOfPayee:
      createApiClient<ConfirmationOfPayeePaths>(clientOptions),
  }
}
