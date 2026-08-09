import { describe, expect, test } from 'vitest'

import { verifyZeptoWebhookSignature } from './webhook'

const encoder = new TextEncoder()
const secret = 'whsec_zepto_test_secret'
const timestamp = 1_786_233_600
const nowMs = timestamp * 1_000
const rawBody = encoder.encode('{"event":{"type":"payment.settled"}}')

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function signature(body = rawBody): Promise<string> {
  const prefix = encoder.encode(`${timestamp}.`)
  const message = new Uint8Array(prefix.byteLength + body.byteLength)
  message.set(prefix)
  message.set(body, prefix.byteLength)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return `${timestamp}.${toHex(await crypto.subtle.sign('HMAC', key, message))}`
}

describe('verifyZeptoWebhookSignature', () => {
  test('verifies the exact raw body bytes', async () => {
    await expect(
      verifyZeptoWebhookSignature({
        rawBody,
        splitSignature: await signature(),
        secret,
        nowMs,
      }),
    ).resolves.toEqual({ timestamp })
  })

  test('allows future dot-separated signature fields', async () => {
    await expect(
      verifyZeptoWebhookSignature({
        rawBody,
        splitSignature: `${await signature()}.future-field`,
        secret,
        nowMs,
      }),
    ).resolves.toEqual({ timestamp })
  })

  test('rejects a signature for different raw bytes', async () => {
    await expect(
      verifyZeptoWebhookSignature({
        rawBody: encoder.encode('{"event": {"type":"payment.settled"}}'),
        splitSignature: await signature(),
        secret,
        nowMs,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_webhook_signature' })
  })

  test.each([
    '',
    'not-a-timestamp.digest',
    `${timestamp}.not-hex`,
    `${timestamp}.${'00'.repeat(31)}`,
  ])('rejects malformed signature %s', async (splitSignature) => {
    await expect(
      verifyZeptoWebhookSignature({
        rawBody,
        splitSignature,
        secret,
        nowMs,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_webhook_signature' })
  })

  test.each([-300_001, 300_001])(
    'rejects timestamps outside the tolerance by %i milliseconds',
    async (offsetMs) => {
      await expect(
        verifyZeptoWebhookSignature({
          rawBody,
          splitSignature: await signature(),
          secret,
          nowMs: nowMs + offsetMs,
        }),
      ).rejects.toMatchObject({ kind: 'invalid_webhook_signature' })
    },
  )

  test('accepts a caller-provided tolerance', async () => {
    await expect(
      verifyZeptoWebhookSignature({
        rawBody,
        splitSignature: await signature(),
        secret,
        nowMs: nowMs + 600_000,
        toleranceMs: 600_000,
      }),
    ).resolves.toEqual({ timestamp })
  })
})
