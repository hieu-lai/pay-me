/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const encryptionKey = btoa('0123456789abcdef0123456789abcdef')
const fingerprintKey = btoa('fingerprint-key-32-bytes-long!!xx')
const ingressSecret = 'test-ingress-attestation-secret-32-bytes'
const submissionKey = '018f22e2-7c00-7000-8000-000000000001'
const trustedIp = '203.0.113.42'

const requesterIdentity = {
  tokenIdentifier: 'https://clerk.example.test|requester_123',
  subject: 'requester_123',
  issuer: 'https://clerk.example.test',
  email: 'requester@example.com',
  name: 'Requesting User',
} satisfies UserIdentity

const payerIdentity = {
  tokenIdentifier: 'https://clerk.example.test|payer_456',
  subject: 'payer_456',
  issuer: 'https://clerk.example.test',
  email: 'payer@example.com',
  name: 'Paying User',
} satisfies UserIdentity

function bytesToBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return bytesToBase64Url(new Uint8Array(digest))
}

async function sign(value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(ingressSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
    ),
  )
}

async function attestation(
  intent: {
    submissionKey: string
    amountCents: number
    description: string
    payerId: string
  },
  issuedAtMs: number,
) {
  const intentDigest = await sha256(
    JSON.stringify([
      intent.submissionKey,
      intent.amountCents,
      intent.description,
      intent.payerId,
    ]),
  )
  const payload = JSON.stringify([
    1,
    issuedAtMs,
    requesterIdentity.subject,
    trustedIp,
    intentDigest,
  ])
  return {
    issuedAtMs,
    clerkUserId: requesterIdentity.subject,
    trustedIp,
    intentDigest,
    signature: await sign(payload),
  }
}

async function setup() {
  const users = await setupUsers()
  await users.requester.action(api.paymentDestinations.create, {
    destination: { type: 'bban', value: '123456-0012345' },
  })
  await users.payer.action(api.paymentDestinations.create, {
    destination: { type: 'bban', value: '654321-0098765' },
  })
  return users
}

async function setupUsers() {
  const t = convexTest(schema, modules)
  const requesterUserId = await t.mutation(internal.users.addUser, {
    tokenIdentifier: requesterIdentity.tokenIdentifier,
    clerkUserId: requesterIdentity.subject,
    email: requesterIdentity.email,
    name: requesterIdentity.name,
  })
  const payerUserId = await t.mutation(internal.users.addUser, {
    tokenIdentifier: payerIdentity.tokenIdentifier,
    clerkUserId: payerIdentity.subject,
    email: payerIdentity.email,
    name: payerIdentity.name,
  })
  const requester = t.withIdentity(requesterIdentity)
  const payer = t.withIdentity(payerIdentity)
  return { t, requester, payer, requesterUserId, payerUserId }
}

function moneyRequestIntent(
  payerId: Id<'users'>,
  overrides: Partial<{
    submissionKey: string
    amountCents: number
    description: string
  }> = {},
) {
  return {
    submissionKey,
    amountCents: 12_345,
    description: 'Shared dinner',
    payerId,
    ...overrides,
  }
}

async function submit(
  requester: Awaited<ReturnType<typeof setupUsers>>['requester'],
  intent: ReturnType<typeof moneyRequestIntent>,
  issuedAtMs = Date.now(),
) {
  return await requester.action(api.moneyRequests.submit, {
    intent,
    attestation: await attestation(intent, issuedAtMs),
  })
}

beforeEach(() => {
  process.env.PAYMENT_DESTINATION_ENCRYPTION_KEYS = JSON.stringify({
    v1: encryptionKey,
  })
  process.env.PAYMENT_DESTINATION_CURRENT_ENCRYPTION_KEY_VERSION = 'v1'
  process.env.PAYMENT_DESTINATION_FINGERPRINT_KEY = fingerprintKey
  process.env.MONEY_REQUEST_INGRESS_ATTESTATION_SECRET = ingressSecret
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Money Request submission and requester read', () => {
  test('durably accepts one Bank Account Payer before provider work begins', async () => {
    const { t, requester, payerUserId } = await setup()
    const intent = moneyRequestIntent(payerUserId)
    const issuedAtMs = Date.now()

    const moneyRequestId = await requester.action(api.moneyRequests.submit, {
      intent,
      attestation: await attestation(intent, issuedAtMs),
    })

    const accepted = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })

    expect(accepted).toEqual({
      id: moneyRequestId,
      amountCents: 12_345,
      currency: 'AUD',
      purpose: 'other',
      description: 'Shared dinner',
      submittedAt: expect.any(Number),
      agreements: [
        {
          payer: { name: payerIdentity.name },
          creation: { state: 'queued', updatedAt: expect.any(Number) },
          lifecycle: {
            meaning: 'waitingForPayer',
            confidence: 'provisional',
            observedAt: expect.any(Number),
          },
          tracking: { state: 'verificationDue', updatedAt: expect.any(Number) },
        },
      ],
    })

    const durable = await t.run(async (ctx) => ({
      request: await ctx.db.get('moneyRequests', moneyRequestId),
      agreements: await ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .take(2),
      evidence: await ctx.db.query('payToAgreementEvidence').take(2),
      work: await ctx.db.query('payToAgreementWorkItems').take(2),
    }))
    expect(durable.agreements).toHaveLength(1)
    expect(durable.evidence).toHaveLength(1)
    expect(durable.work).toHaveLength(1)
    expect(JSON.stringify(durable)).not.toContain('123456-0012345')
    expect(JSON.stringify(durable)).not.toContain('654321-0098765')
    expect(JSON.stringify(durable)).not.toContain(trustedIp)
    expect(JSON.stringify(durable)).not.toContain(
      (await attestation(intent, issuedAtMs)).signature,
    )
  })

  test('rejects unauthenticated submission without creating durable records', async () => {
    const { t, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)
    const issuedAtMs = Date.now()

    await expect(
      t.action(api.moneyRequests.submit, {
        intent: candidate,
        attestation: await attestation(candidate, issuedAtMs),
      }),
    ).rejects.toThrow('You must be signed in')

    const counts = await t.run(async (ctx) => ({
      requests: (await ctx.db.query('moneyRequests').take(1)).length,
      agreements: (await ctx.db.query('payToAgreements').take(1)).length,
      evidence: (await ctx.db.query('payToAgreementEvidence').take(1)).length,
      work: (await ctx.db.query('payToAgreementWorkItems').take(1)).length,
    }))
    expect(counts).toEqual({ requests: 0, agreements: 0, evidence: 0, work: 0 })
  })

  test.each(['tampered', 'expired', 'mismatched'] as const)(
    'rejects %s ingress trust before unavailable destination reads',
    async (kind) => {
      const { t, requester, payerUserId } = await setupUsers()
      const candidate = moneyRequestIntent(payerUserId)
      const issuedAtMs = kind === 'expired' ? Date.now() - 60_001 : Date.now()
      const proof = await attestation(candidate, issuedAtMs)
      if (kind === 'tampered') proof.signature = `${proof.signature}x`
      if (kind === 'mismatched') proof.intentDigest = 'another-intent'

      await expect(
        requester.action(api.moneyRequests.submit, {
          intent: candidate,
          attestation: proof,
        }),
      ).rejects.toThrow('trusted server ingress')

      await expect(
        t.run(async (ctx) => ctx.db.query('moneyRequests').take(1)),
      ).resolves.toEqual([])
    },
  )

  test.each([
    { submissionKey: '018f22e2-7c00-4000-8000-000000000001' },
    { amountCents: 0 },
    { amountCents: 1.5 },
    { amountCents: 1_000_000_001 },
    { description: ' leading space' },
    { description: 'line\nbreak' },
  ])('rejects invalid canonical intent %#', async (overrides) => {
    const { requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId, overrides)

    await expect(submit(requester, candidate)).rejects.toThrow(
      'canonical submission key',
    )
  })

  test('fails atomically when the Payer has no current Bank Account', async () => {
    const { t, requester, payerUserId } = await setupUsers()
    await requester.action(api.paymentDestinations.create, {
      destination: { type: 'bban', value: '123456-0012345' },
    })

    await expect(
      submit(requester, moneyRequestIntent(payerUserId)),
    ).rejects.toThrow('selected Payer is unavailable')

    const durable = await t.run(async (ctx) => ({
      requests: await ctx.db.query('moneyRequests').take(2),
      agreements: await ctx.db.query('payToAgreements').take(2),
      evidence: await ctx.db.query('payToAgreementEvidence').take(2),
      work: await ctx.db.query('payToAgreementWorkItems').take(2),
    }))
    expect(durable).toEqual({
      requests: [],
      agreements: [],
      evidence: [],
      work: [],
    })
  })

  test.each(['requester', 'payer'] as const)(
    'keeps PayID disabled for the %s destination baseline',
    async (payIdOwner) => {
      const { t, requester, payer, payerUserId } = await setupUsers()
      await requester.action(api.paymentDestinations.create, {
        destination:
          payIdOwner === 'requester'
            ? { type: 'alias_email', value: 'requester@example.com' }
            : { type: 'bban', value: '123456-0012345' },
      })
      await payer.action(api.paymentDestinations.create, {
        destination:
          payIdOwner === 'payer'
            ? { type: 'alias_email', value: 'payer@example.com' }
            : { type: 'bban', value: '654321-0098765' },
      })

      await expect(
        submit(requester, moneyRequestIntent(payerUserId)),
      ).rejects.toThrow(
        payIdOwner === 'requester'
          ? 'Default Destination'
          : 'selected Payer is unavailable',
      )
      await expect(
        t.run(async (ctx) => ctx.db.query('moneyRequests').take(1)),
      ).resolves.toEqual([])
    },
  )

  test('returns the same request for a replay and rejects a changed intent', async () => {
    const { t, requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)

    const firstId = await submit(requester, candidate)
    await expect(submit(requester, candidate)).resolves.toBe(firstId)
    await expect(
      submit(requester, { ...candidate, amountCents: 12_346 }),
    ).rejects.toThrow('already bound to another intent')

    const durable = await t.run(async (ctx) => ({
      requests: await ctx.db.query('moneyRequests').take(3),
      agreements: await ctx.db.query('payToAgreements').take(3),
      evidence: await ctx.db.query('payToAgreementEvidence').take(3),
      work: await ctx.db.query('payToAgreementWorkItems').take(3),
    }))
    expect(durable.requests).toHaveLength(1)
    expect(durable.agreements).toHaveLength(1)
    expect(durable.evidence).toHaveLength(1)
    expect(durable.work).toHaveLength(1)
  })

  test('concurrent retries converge on one durable intent', async () => {
    const { t, requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)
    const proof = await attestation(candidate, Date.now())

    const [firstId, secondId] = await Promise.all([
      requester.action(api.moneyRequests.submit, {
        intent: candidate,
        attestation: proof,
      }),
      requester.action(api.moneyRequests.submit, {
        intent: candidate,
        attestation: proof,
      }),
    ])

    expect(secondId).toBe(firstId)
    const requests = await t.run(async (ctx) =>
      ctx.db.query('moneyRequests').take(2),
    )
    expect(requests).toHaveLength(1)
  })

  test('a new submission key creates a distinct otherwise-identical intent', async () => {
    const { requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)

    const firstId = await submit(requester, candidate)
    const secondId = await submit(requester, {
      ...candidate,
      submissionKey: '018f22e2-7c00-7000-8000-000000000002',
    })

    expect(secondId).not.toBe(firstId)
  })

  test('retains immutable encrypted routing snapshots after destination deletion', async () => {
    const { t, requester, payer, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const before = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique(),
    )
    if (!before) throw new Error('Expected PayTo Agreement')

    await payer.mutation(api.paymentDestinations.remove, {
      destinationId: before.sourceDebtorPaymentDestinationId,
    })

    const after = await t.run(async (ctx) =>
      ctx.db.get('payToAgreements', before._id),
    )
    expect(after?.debtorSnapshot).toEqual(before.debtorSnapshot)
    await expect(
      requester.query(api.moneyRequests.get, { moneyRequestId }),
    ).resolves.toMatchObject({ id: moneyRequestId })
  })

  test.each(['Requester', 'Payer'] as const)(
    'rechecks the %s Default Destination and rolls back a raced allocation',
    async (racedParty) => {
      const { t, requester, payer, payerUserId } = await setup()
      const candidate = moneyRequestIntent(payerUserId)
      const proof = await attestation(candidate, Date.now())
      const preflight = await requester.query(
        internal.moneyRequests.preflight,
        {
          intent: candidate,
          submissionFingerprint: proof.intentDigest,
        },
      )
      expect(preflight.kind).toBe('new')
      if (preflight.kind !== 'new') return

      await (racedParty === 'Requester' ? requester : payer).action(
        api.paymentDestinations.create,
        {
          destination: {
            type: 'bban',
            value:
              racedParty === 'Requester' ? '111111-0000001' : '222222-0000002',
          },
          setAsDefault: true,
        },
      )
      await expect(
        requester.mutation(internal.moneyRequests.accept, {
          intent: candidate,
          submissionFingerprint: proof.intentDigest,
          providerUid: '018f22e2-7c00-7000-8000-000000000099',
          submittedAt: Date.now(),
          expectedRequesterDestinationId: preflight.requesterDestinationId,
          expectedPayerDestinationId: preflight.payerDestinationId,
        }),
      ).rejects.toThrow(
        racedParty === 'Requester'
          ? 'Default Destination'
          : 'selected Payer is unavailable',
      )

      await expect(
        t.run(async (ctx) => ctx.db.query('moneyRequests').take(1)),
      ).resolves.toEqual([])
    },
  )

  test('rolls back the root when a later provider UID allocation fails', async () => {
    const { t, requester, payerUserId } = await setup()
    const firstId = await submit(requester, moneyRequestIntent(payerUserId))
    const existingAgreement = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) => q.eq('moneyRequestId', firstId))
        .unique(),
    )
    if (!existingAgreement) throw new Error('Expected PayTo Agreement')
    const candidate = moneyRequestIntent(payerUserId, {
      submissionKey: '018f22e2-7c00-7000-8000-000000000004',
    })
    const proof = await attestation(candidate, Date.now())
    const preflight = await requester.query(internal.moneyRequests.preflight, {
      intent: candidate,
      submissionFingerprint: proof.intentDigest,
    })
    if (preflight.kind !== 'new') throw new Error('Expected new intent')

    await expect(
      requester.mutation(internal.moneyRequests.accept, {
        intent: candidate,
        submissionFingerprint: proof.intentDigest,
        providerUid: existingAgreement.providerUid,
        submittedAt: Date.now(),
        expectedRequesterDestinationId: preflight.requesterDestinationId,
        expectedPayerDestinationId: preflight.payerDestinationId,
      }),
    ).rejects.toThrow('temporarily unavailable')

    const durable = await t.run(async (ctx) => ({
      requests: await ctx.db.query('moneyRequests').take(3),
      agreements: await ctx.db.query('payToAgreements').take(3),
      evidence: await ctx.db.query('payToAgreementEvidence').take(3),
      work: await ctx.db.query('payToAgreementWorkItems').take(3),
    }))
    expect(durable.requests).toHaveLength(1)
    expect(durable.agreements).toHaveLength(1)
    expect(durable.evidence).toHaveLength(1)
    expect(durable.work).toHaveLength(1)
  })

  test('does not log routing values, trusted IP, or attestation material', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)
    const proof = await attestation(candidate, Date.now())

    await requester.action(api.moneyRequests.submit, {
      intent: candidate,
      attestation: proof,
    })

    const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls])
    expect(logged).not.toContain('123456-0012345')
    expect(logged).not.toContain('654321-0098765')
    expect(logged).not.toContain(trustedIp)
    expect(logged).not.toContain(proof.signature)
  })

  test('makes missing and unauthorized requester reads indistinguishable', async () => {
    const { t, requester, payer, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const missingId = await t.run(async (ctx) => {
      const destination = await ctx.db
        .query('paymentDestinations')
        .withIndex('by_ownerUserId', (q) => q.eq('ownerUserId', payerUserId))
        .first()
      if (!destination) throw new Error('Expected Payer destination')
      const id = await ctx.db.insert('moneyRequests', {
        requesterUserId: payerUserId,
        requesterNameSnapshot: 'Temporary',
        amountCents: 1,
        currency: 'AUD',
        purpose: 'other',
        description: 'Temporary',
        submissionKey: '018f22e2-7c00-7000-8000-000000000003',
        submissionFingerprint: 'temporary',
        sourceCreditorPaymentDestinationId: destination._id,
        creditorSnapshot: {
          kind: 'bban',
          maskedDisplay: 'hidden',
          ciphertext: 'hidden',
          nonce: 'hidden',
          keyVersion: 'v1',
        },
        submittedAt: Date.now(),
      })
      await ctx.db.delete('moneyRequests', id)
      return id
    })

    await expect(
      payer.query(api.moneyRequests.get, { moneyRequestId }),
    ).rejects.toThrow('Money Request was not found')
    await expect(
      requester.query(api.moneyRequests.get, { moneyRequestId: missingId }),
    ).rejects.toThrow('Money Request was not found')
  })
})
