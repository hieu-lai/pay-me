import type { components as InvestigationComponents } from './generated/investigations'
import type { components as NotificationComponents } from './generated/notifications'
import type { components as PayToComponents } from './generated/payTo'
import { ZeptoClientError } from './error'

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1_000
const encoder = new TextEncoder()

type PayToWebhookSchemaName = Exclude<
  Extract<keyof PayToComponents['schemas'], `payto.webhook.${string}`>,
  'payto.webhook.base'
>

export type PayToWebhookEvent =
  PayToComponents['schemas'][PayToWebhookSchemaName]
export type InvestigationWebhookEvent =
  | InvestigationComponents['schemas']['investigations.event']
  | InvestigationComponents['schemas']['investigations.message']
export type UnmatchedFloatCreditWebhookEvent =
  NotificationComponents['schemas']['notifications.float_accounts.unmatched_credit.event']
export type KnownZeptoWebhookEvent =
  | PayToWebhookEvent
  | InvestigationWebhookEvent
  | UnmatchedFloatCreditWebhookEvent
export type UnknownZeptoWebhookEvent = Record<string, unknown> & {
  event?: Record<string, unknown> & { type: string }
}
export type ZeptoWebhookEvent =
  KnownZeptoWebhookEvent | UnknownZeptoWebhookEvent

export type VerifyZeptoWebhookSignatureOptions = {
  rawBody: ArrayBuffer | Uint8Array
  splitSignature: string
  secret: string
  toleranceMs?: number
  nowMs?: number
}

function invalidSignature(message: string): ZeptoClientError {
  return new ZeptoClientError({
    kind: 'invalid_webhook_signature',
    message,
  })
}

function copyBytes(value: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    value instanceof Uint8Array ? value : new Uint8Array(value),
  )
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw invalidSignature('The Zepto webhook signature digest is malformed.')
  }

  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16)
  }
  return bytes
}

/** Verify Zepto's HMAC over `<unix timestamp>.<exact raw body bytes>`. */
export async function verifyZeptoWebhookSignature(
  options: VerifyZeptoWebhookSignatureOptions,
): Promise<{ timestamp: number }> {
  const secret = options.secret.trim()
  if (!secret) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: 'The Zepto webhook signing secret is empty.',
    })
  }

  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: 'The Zepto webhook timestamp tolerance must be non-negative.',
    })
  }

  const [timestampValue, digestValue] = options.splitSignature.trim().split('.')
  if (!timestampValue || !/^\d+$/.test(timestampValue) || !digestValue) {
    throw invalidSignature('The Zepto Split-Signature header is malformed.')
  }

  const timestamp = Number(timestampValue)
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidSignature('The Zepto webhook timestamp is invalid.')
  }

  const timestampMs = timestamp * 1_000
  const nowMs = options.nowMs ?? Date.now()
  if (Math.abs(nowMs - timestampMs) > toleranceMs) {
    throw invalidSignature('The Zepto webhook signature timestamp is stale.')
  }

  const rawBody = copyBytes(options.rawBody)
  const prefix = encoder.encode(`${timestampValue}.`)
  const signedBytes = new Uint8Array(prefix.byteLength + rawBody.byteLength)
  signedBytes.set(prefix)
  signedBytes.set(rawBody, prefix.byteLength)

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    decodeHex(digestValue),
    signedBytes,
  )

  if (!verified) {
    throw invalidSignature('The Zepto webhook signature is invalid.')
  }

  return { timestamp }
}
