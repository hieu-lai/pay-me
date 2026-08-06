/// <reference types="vite/client" />

import { convexTest } from 'convex-test'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { handleClerkWebhook } from './http'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const signingKey = 'test-clerk-webhook-secret'
const signingSecret = `whsec_${btoa(signingKey)}`
const clerkFrontendApiUrl = 'https://clerk.example.test'

type ClerkUserPayload = {
  id: string
  first_name: string | null
  last_name: string | null
  image_url: string
  primary_email_address_id: string | null
  email_addresses: Array<{
    id: string
    email_address: string
  }>
}

function userCreatedPayload(overrides: Partial<ClerkUserPayload> = {}) {
  return {
    type: 'user.created',
    data: {
      id: 'user_123',
      first_name: 'Ada',
      last_name: 'Lovelace',
      image_url: 'https://example.com/ada.png',
      primary_email_address_id: 'email_123',
      email_addresses: [
        {
          id: 'email_123',
          email_address: 'ada@example.com',
        },
      ],
      ...overrides,
    },
  }
}

async function signedRequestParts(payload: unknown) {
  const body = JSON.stringify(payload)
  const messageId = 'msg_123'
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const message = `${messageId}.${timestamp}.${body}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  )
  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  )

  return {
    body,
    headers: {
      'content-type': 'application/json',
      'svix-id': messageId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${encodedSignature}`,
    },
  }
}

async function signedRequest(payload: unknown) {
  const { body, headers } = await signedRequestParts(payload)

  return new Request('https://example.convex.site/clerk', {
    method: 'POST',
    body,
    headers,
  })
}

function webhookDependencies(addUser = vi.fn(async () => undefined)) {
  return {
    signingSecret,
    clerkFrontendApiUrl,
    addUser,
    randomFourDigitNumber: () => 4321,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /clerk', () => {
  test('verifies a user.created webhook and provisions the user', async () => {
    process.env.CLERK_WEBHOOK_SIGNING_SECRET = signingSecret
    process.env.CLERK_FRONTEND_API_URL = clerkFrontendApiUrl

    const t = convexTest(schema, modules)
    const { body, headers } = await signedRequestParts(userCreatedPayload())
    const response = await t.fetch('/clerk', {
      method: 'POST',
      body,
      headers,
    })

    expect(response.status).toBe(200)

    const user = await t.run(async (ctx) =>
      ctx.db
        .query('users')
        .withIndex('by_clerkUserId', (q) => q.eq('clerkUserId', 'user_123'))
        .unique(),
    )

    expect(user).toMatchObject({
      tokenIdentifier: 'https://clerk.example.test|user_123',
      clerkUserId: 'user_123',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      imageUrl: 'https://example.com/ada.png',
    })
  })

  test.each([
    ['Ada', null, 'Ada'],
    [null, 'Lovelace', 'Lovelace'],
    [null, null, 'User #4321'],
  ])(
    'maps first name %s and last name %s to %s',
    async (firstName, lastName, expectedName) => {
      const addUser = vi.fn(async () => undefined)
      const response = await handleClerkWebhook(
        await signedRequest(
          userCreatedPayload({
            first_name: firstName,
            last_name: lastName,
          }),
        ),
        webhookDependencies(addUser),
      )

      expect(response.status).toBe(200)
      expect(addUser).toHaveBeenCalledWith(
        expect.objectContaining({ name: expectedName }),
      )
    },
  )

  test('rejects a user without the matching primary email', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const addUser = vi.fn(async () => undefined)
    const response = await handleClerkWebhook(
      await signedRequest(
        userCreatedPayload({ primary_email_address_id: 'email_missing' }),
      ),
      webhookDependencies(addUser),
    )

    expect(response.status).toBe(422)
    expect(addUser).not.toHaveBeenCalled()
  })

  test('returns 400 for an invalid webhook signature', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const addUser = vi.fn(async () => undefined)
    const response = await handleClerkWebhook(
      new Request('https://example.convex.site/clerk', {
        method: 'POST',
        body: JSON.stringify(userCreatedPayload()),
      }),
      webhookDependencies(addUser),
    )

    expect(response.status).toBe(400)
    expect(addUser).not.toHaveBeenCalled()
  })

  test('ignores webhook events other than user.created', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const addUser = vi.fn(async () => undefined)
    const response = await handleClerkWebhook(
      await signedRequest({ type: 'session.created', data: {} }),
      webhookDependencies(addUser),
    )

    expect(response.status).toBe(200)
    expect(addUser).not.toHaveBeenCalled()
  })

  test('returns 500 when user provisioning fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await handleClerkWebhook(
      await signedRequest(userCreatedPayload()),
      webhookDependencies(
        vi.fn(async () => {
          throw new Error('Convex unavailable')
        }),
      ),
    )

    expect(response.status).toBe(500)
  })
})
