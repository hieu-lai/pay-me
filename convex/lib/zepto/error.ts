export type ZeptoClientErrorKind =
  | 'aborted'
  | 'configuration'
  | 'http'
  | 'invalid_response'
  | 'invalid_webhook_signature'
  | 'network'
  | 'sandbox_only'
  | 'timeout'

type ZeptoClientErrorOptions = {
  kind: ZeptoClientErrorKind
  message: string
  status?: number
  headers?: Headers
  body?: unknown
  rawBody?: string
  method?: string
  path?: string
  retryAfterMs?: number
  cause?: unknown
}

/** A redaction-safe error raised by the Zepto transport and webhook helpers. */
export class ZeptoClientError extends Error {
  readonly kind: ZeptoClientErrorKind
  readonly status: number | undefined
  readonly headers: Headers | undefined
  readonly body: unknown
  readonly rawBody: string | undefined
  readonly method: string | undefined
  readonly path: string | undefined
  readonly retryAfterMs: number | undefined

  constructor(options: ZeptoClientErrorOptions) {
    super(
      options.message,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = 'ZeptoClientError'
    this.kind = options.kind
    this.status = options.status
    this.headers = options.headers ? new Headers(options.headers) : undefined
    this.body = options.body
    this.rawBody = options.rawBody
    this.method = options.method
    this.path = options.path
    this.retryAfterMs = options.retryAfterMs
  }
}
