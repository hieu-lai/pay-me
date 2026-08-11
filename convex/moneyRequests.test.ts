/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'
import { handleMoneyRequestSubmission } from '../src/server-fns/money-requests'

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

const otherRequesterIdentity = {
  tokenIdentifier: 'https://clerk.example.test|requester_789',
  subject: 'requester_789',
  issuer: 'https://clerk.example.test',
  email: 'other-requester@example.com',
  name: 'Other Requesting User',
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
    payerIds: Id<'users'>[]
  },
  issuedAtMs: number,
  identity = requesterIdentity,
) {
  const intentDigest = await sha256(
    JSON.stringify([
      intent.submissionKey,
      intent.amountCents,
      intent.description,
      [...intent.payerIds].sort(),
    ]),
  )
  const payload = JSON.stringify([
    1,
    issuedAtMs,
    identity.subject,
    trustedIp,
    intentDigest,
  ])
  return {
    issuedAtMs,
    clerkUserId: identity.subject,
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

async function addPayer(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
  index: number,
  withDestination = true,
) {
  const identity = {
    tokenIdentifier: `https://clerk.example.test|payer_${index}`,
    subject: `payer_${index}`,
    issuer: 'https://clerk.example.test',
    email: `payer-${index}@example.com`,
    name: `Paying User ${index}`,
  } satisfies UserIdentity
  const payerUserId = await t.mutation(internal.users.addUser, {
    tokenIdentifier: identity.tokenIdentifier,
    clerkUserId: identity.subject,
    email: identity.email,
    name: identity.name,
  })
  const payer = t.withIdentity(identity)
  if (withDestination) {
    await payer.action(api.paymentDestinations.create, {
      destination: {
        type: 'bban',
        value: `${100_000 + index}-${String(index).padStart(7, '0')}`,
      },
    })
  }
  return { identity, payer, payerUserId }
}

async function durableSubmissionState(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
) {
  return await t.run(async (ctx) => ({
    requests: await ctx.db.query('moneyRequests').take(6),
    agreements: await ctx.db.query('payToAgreements').take(6),
    evidence: await ctx.db.query('payToAgreementEvidence').take(6),
    work: await ctx.db.query('payToAgreementWorkItems').take(6),
  }))
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
    payerIds: [payerId],
    ...overrides,
  }
}

async function submit(
  requester: Awaited<ReturnType<typeof setupUsers>>['requester'],
  intent: ReturnType<typeof moneyRequestIntent>,
  issuedAtMs = Date.now(),
  options: {
    identity?: UserIdentity
    loseResponse?: boolean
  } = {},
) {
  const identity = options.identity ?? requesterIdentity
  const result = await handleMoneyRequestSubmission(intent, {
    authenticate: async () => ({
      clerkUserId: identity.subject,
      token: 'test-convex-token',
    }),
    trustedIp: () => trustedIp,
    now: () => issuedAtMs,
    attestationSecret: ingressSecret,
    submit: async ({ intent: submittedIntent, attestation: proof }) => {
      const moneyRequestId = await requester.action(api.moneyRequests.submit, {
        intent: submittedIntent,
        attestation: proof,
      })
      if (options.loseResponse) throw new Error('Simulated response loss')
      return moneyRequestId
    },
  })
  return result.moneyRequestId as Id<'moneyRequests'>
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

  test('atomically queues five independent Payer agreements and exposes every projection', async () => {
    const { t, requester, payerUserId } = await setup()
    const addedPayers = await Promise.all(
      [2, 3, 4, 5].map((index) => addPayer(t, index)),
    )
    const payerIds = [
      payerUserId,
      ...addedPayers.map((payer) => payer.payerUserId),
    ]

    const moneyRequestId = await submit(requester, {
      ...moneyRequestIntent(payerUserId),
      payerIds,
    })

    const accepted = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    if (!('agreements' in accepted)) {
      throw new Error('Expected Requester detail')
    }
    expect(accepted.agreements).toHaveLength(5)
    expect(accepted.agreements.map(({ payer }) => payer.name)).toEqual(
      expect.arrayContaining([
        payerIdentity.name,
        ...addedPayers.map(({ identity }) => identity.name),
      ]),
    )
    expect(accepted.agreements.map(({ creation }) => creation.state)).toEqual(
      Array(5).fill('queued'),
    )

    const durable = await durableSubmissionState(t)
    expect(durable.requests).toHaveLength(1)
    expect(durable.agreements).toHaveLength(5)
    expect(durable.evidence).toHaveLength(5)
    expect(durable.work).toHaveLength(5)
    expect(
      new Set(durable.agreements.map(({ providerUid }) => providerUid)).size,
    ).toBe(5)
  })

  test('shows a Payer only their agreement and the Requester safe identity', async () => {
    const { t, requester, payer, requesterUserId, payerUserId } = await setup()
    const sibling = await addPayer(t, 2)
    const moneyRequestId = await submit(requester, {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, sibling.payerUserId],
    })
    await t.run(async (ctx) => {
      await ctx.db.patch('users', requesterUserId, {
        name: 'Current Requester Name',
        username: 'requester-now',
        imageUrl: 'https://example.com/requester.png',
      })
      await ctx.db.patch('users', payerUserId, {
        username: 'payer-now',
        imageUrl: 'https://example.com/payer.png',
      })
    })

    const detail = await payer.query(api.moneyRequests.get, { moneyRequestId })

    expect(detail).toEqual({
      id: moneyRequestId,
      amountCents: 12_345,
      currency: 'AUD',
      purpose: 'other',
      description: 'Shared dinner',
      submittedAt: expect.any(Number),
      requester: {
        name: requesterIdentity.name,
        username: 'requester-now',
        imageUrl: 'https://example.com/requester.png',
      },
      agreement: {
        payer: {
          name: payerIdentity.name,
          username: 'payer-now',
          imageUrl: 'https://example.com/payer.png',
        },
        creation: { state: 'queued', updatedAt: expect.any(Number) },
        lifecycle: {
          meaning: 'waitingForPayer',
          confidence: 'provisional',
          observedAt: expect.any(Number),
        },
        tracking: { state: 'verificationDue', updatedAt: expect.any(Number) },
      },
    })
    expect(JSON.stringify(detail)).not.toContain(sibling.identity.name)
    expect(detail).not.toHaveProperty('agreements')
  })

  test('lists Money Requests requested by me newest first across cursor pages', async () => {
    const { t, requester, payerUserId } = await setup()
    const submittedIds: Id<'moneyRequests'>[] = []
    for (const [index, description] of ['First', 'Second', 'Third'].entries()) {
      submittedIds.push(
        await submit(
          requester,
          moneyRequestIntent(payerUserId, {
            submissionKey: `018f22e2-7c00-7000-8000-00000000001${index}`,
            description,
          }),
        ),
      )
    }
    await t.run(async (ctx) => {
      await ctx.db.patch('users', payerUserId, {
        username: 'payer-now',
        imageUrl: 'https://example.com/payer.png',
      })
    })

    const firstPage = await requester.query(
      api.moneyRequests.listRequestedByMe,
      { paginationOpts: { numItems: 2, cursor: null } },
    )
    const secondPage = await requester.query(
      api.moneyRequests.listRequestedByMe,
      {
        paginationOpts: {
          numItems: 2,
          cursor: firstPage.continueCursor,
        },
      },
    )

    expect([...firstPage.page, ...secondPage.page].map(({ id }) => id)).toEqual(
      [...submittedIds].reverse(),
    )
    expect(firstPage.isDone).toBe(false)
    expect(secondPage.isDone).toBe(true)
    expect(firstPage.page[0]).toMatchObject({
      id: submittedIds[2],
      description: 'Third',
      payers: [
        {
          name: payerIdentity.name,
          username: 'payer-now',
          imageUrl: 'https://example.com/payer.png',
        },
      ],
      summary: {
        creation: { queued: 1 },
        lifecycle: { waitingForPayer: 1 },
        tracking: { verificationDue: 1 },
      },
    })
    expect(JSON.stringify(firstPage)).not.toContain('providerUid')
    expect(JSON.stringify(firstPage)).not.toContain('debtorSnapshot')
  })

  test('lists only my assigned projection without sibling information', async () => {
    const { t, requester, payer, requesterUserId, payerUserId } = await setup()
    const sibling = await addPayer(t, 2)
    const firstId = await submit(requester, {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, sibling.payerUserId],
    })
    const secondId = await submit(
      requester,
      moneyRequestIntent(payerUserId, {
        submissionKey: '018f22e2-7c00-7000-8000-000000000020',
        description: 'Second request',
      }),
    )
    await t.run(async (ctx) => {
      await ctx.db.patch('users', requesterUserId, {
        username: 'requester-now',
        imageUrl: 'https://example.com/requester.png',
      })
    })

    const firstPage = await payer.query(api.moneyRequests.listAssignedToMe, {
      paginationOpts: { numItems: 1, cursor: null },
    })
    const secondPage = await payer.query(api.moneyRequests.listAssignedToMe, {
      paginationOpts: { numItems: 1, cursor: firstPage.continueCursor },
    })
    const items = [...firstPage.page, ...secondPage.page]

    expect(items.map(({ id }) => id)).toEqual([secondId, firstId])
    expect(items[0]).toMatchObject({
      requester: {
        name: requesterIdentity.name,
        username: 'requester-now',
        imageUrl: 'https://example.com/requester.png',
      },
      agreement: {
        payer: { name: payerIdentity.name },
        creation: { state: 'queued' },
        lifecycle: { meaning: 'waitingForPayer' },
        tracking: { state: 'verificationDue' },
      },
    })
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain(sibling.identity.name)
    expect(serialized).not.toContain('payers')
    expect(serialized).not.toContain('summary')
    expect(serialized).not.toContain('providerUid')
  })

  test.each([
    ['requested', api.moneyRequests.listRequestedByMe],
    ['assigned', api.moneyRequests.listAssignedToMe],
  ] as const)(
    'bounds %s history page targets from one through fifty',
    async (_kind, historyQuery) => {
      const { requester } = await setup()

      for (const numItems of [0, 1.5, 51]) {
        await expect(
          requester.query(historyQuery, {
            paginationOpts: { numItems, cursor: null },
          }),
        ).rejects.toMatchObject({
          data: expect.objectContaining({ code: 'INVALID_PAGINATION' }),
        })
      }
    },
  )

  test('requires authentication for detail and both histories', async () => {
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )

    await expect(
      t.query(api.moneyRequests.get, { moneyRequestId }),
    ).rejects.toThrow('signed in')
    await expect(
      t.query(api.moneyRequests.listRequestedByMe, {
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).rejects.toThrow('signed in')
    await expect(
      t.query(api.moneyRequests.listAssignedToMe, {
        paginationOpts: { numItems: 20, cursor: null },
      }),
    ).rejects.toThrow('signed in')
  })

  test('rejects empty, duplicate, oversized, and self-inclusive Payer groups without durable records', async () => {
    const { t, requester, requesterUserId, payerUserId } = await setup()
    const addedPayers = await Promise.all(
      [2, 3, 4, 5, 6].map((index) => addPayer(t, index, false)),
    )
    const allPayerIds = [
      payerUserId,
      ...addedPayers.map(({ payerUserId: id }) => id),
    ]
    const candidates = [
      [],
      [payerUserId, payerUserId],
      allPayerIds,
      [payerUserId, requesterUserId],
    ]

    for (const payerIds of candidates) {
      await expect(
        submit(requester, {
          ...moneyRequestIntent(payerUserId),
          payerIds,
        }),
      ).rejects.toThrow()
    }

    const durable = await durableSubmissionState(t)
    expect(durable).toEqual({
      requests: [],
      agreements: [],
      evidence: [],
      work: [],
    })
  })

  test('fails the complete group when any selected Payer destination is unavailable', async () => {
    const { t, requester, payerUserId } = await setup()
    const unavailablePayer = await addPayer(t, 2, false)

    await expect(
      submit(requester, {
        ...moneyRequestIntent(payerUserId),
        payerIds: [payerUserId, unavailablePayer.payerUserId],
      }),
    ).rejects.toThrow('selected Payer is unavailable')

    const durable = await durableSubmissionState(t)
    expect(durable).toEqual({
      requests: [],
      agreements: [],
      evidence: [],
      work: [],
    })
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

  test('recovers from response loss without repeating destination preflight or durable work', async () => {
    const { t, requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)

    await expect(
      submit(requester, candidate, Date.now(), { loseResponse: true }),
    ).rejects.toThrow('Simulated response loss')
    await t.run(async (ctx) => {
      const destinations = await ctx.db.query('paymentDestinations').take(3)
      for (const destination of destinations) {
        await ctx.db.delete('paymentDestinations', destination._id)
      }
    })

    const recoveredId = await submit(requester, candidate)

    await expect(
      requester.query(api.moneyRequests.get, { moneyRequestId: recoveredId }),
    ).resolves.toMatchObject({ id: recoveredId })
    const durable = await durableSubmissionState(t)
    expect(durable.requests).toHaveLength(1)
    expect(durable.agreements).toHaveLength(1)
    expect(durable.evidence).toHaveLength(1)
    expect(durable.work).toHaveLength(1)
  })

  test('rejects a submission key reused for changed intent', async () => {
    const { requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)

    await submit(requester, candidate)
    await expect(
      submit(requester, { ...candidate, amountCents: 12_346 }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: 'SUBMISSION_CONFLICT' }),
    })
  })

  test('treats a reordered Payer set as the same idempotent intent', async () => {
    const { t, requester, payerUserId } = await setup()
    const secondPayer = await addPayer(t, 2)
    const candidate = {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, secondPayer.payerUserId],
    }

    const firstId = await submit(requester, candidate)
    const replayedId = await submit(requester, {
      ...candidate,
      payerIds: [...candidate.payerIds].reverse(),
    })

    expect(replayedId).toBe(firstId)
    const durable = await durableSubmissionState(t)
    expect(durable.requests).toHaveLength(1)
    expect(durable.agreements).toHaveLength(2)
    expect(durable.evidence).toHaveLength(2)
    expect(durable.work).toHaveLength(2)
  })

  test('scopes the same submission key independently to each Requester', async () => {
    const { t, requester, requesterUserId, payerUserId } = await setup()
    const otherRequesterUserId = await t.mutation(internal.users.addUser, {
      tokenIdentifier: otherRequesterIdentity.tokenIdentifier,
      clerkUserId: otherRequesterIdentity.subject,
      email: otherRequesterIdentity.email,
      name: otherRequesterIdentity.name,
    })
    const otherRequester = t.withIdentity(otherRequesterIdentity)
    await otherRequester.action(api.paymentDestinations.create, {
      destination: { type: 'bban', value: '111111-0000001' },
    })
    const candidate = moneyRequestIntent(payerUserId)

    const firstId = await submit(requester, candidate)
    const secondId = await submit(otherRequester, candidate, Date.now(), {
      identity: otherRequesterIdentity,
    })

    expect(secondId).not.toBe(firstId)
    const requests = await t.run(async (ctx) =>
      ctx.db.query('moneyRequests').take(3),
    )
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.requesterUserId)).toEqual(
      expect.arrayContaining([requesterUserId, otherRequesterUserId]),
    )
  })

  test('concurrent retries converge on one durable intent', async () => {
    const { t, requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)
    const [firstId, secondId] = await Promise.all([
      submit(requester, candidate),
      submit(requester, candidate),
    ])

    expect(secondId).toBe(firstId)
    const durable = await durableSubmissionState(t)
    expect(durable.requests).toHaveLength(1)
    expect(durable.agreements).toHaveLength(1)
    expect(
      new Set(durable.agreements.map((item) => item.providerUid)).size,
    ).toBe(1)
    expect(durable.evidence).toHaveLength(1)
    expect(durable.work).toHaveLength(1)
    await expect(
      requester.query(api.moneyRequests.get, { moneyRequestId: firstId }),
    ).resolves.toMatchObject({ id: firstId })
  })

  test('a new submission key creates a distinct otherwise-identical intent', async () => {
    const { t, requester, payerUserId } = await setup()
    const candidate = moneyRequestIntent(payerUserId)

    const firstId = await submit(requester, candidate)
    const secondId = await submit(requester, {
      ...candidate,
      submissionKey: '018f22e2-7c00-7000-8000-000000000002',
    })

    expect(secondId).not.toBe(firstId)
    const [first, second] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get('moneyRequests', firstId),
        ctx.db.get('moneyRequests', secondId),
      ]),
    )
    expect(first?.submissionFingerprint).toBe(second?.submissionFingerprint)
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
          agreementAllocations: [
            {
              ...preflight.payerDestinations[0],
              providerUid: '018f22e2-7c00-7000-8000-000000000099',
            },
          ],
          submittedAt: Date.now(),
          expectedRequesterDestinationId: preflight.requesterDestinationId,
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

  test('rechecks every selected Payer destination and rolls back a later Payer race', async () => {
    const { t, requester, payerUserId } = await setup()
    const laterPayer = await addPayer(t, 2)
    const candidate = {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, laterPayer.payerUserId],
    }
    const proof = await attestation(candidate, Date.now())
    const preflight = await requester.query(internal.moneyRequests.preflight, {
      intent: candidate,
      submissionFingerprint: proof.intentDigest,
    })
    if (preflight.kind !== 'new') throw new Error('Expected new intent')

    await laterPayer.payer.action(api.paymentDestinations.create, {
      destination: { type: 'bban', value: '222222-0000002' },
      setAsDefault: true,
    })

    await expect(
      requester.mutation(internal.moneyRequests.accept, {
        intent: candidate,
        submissionFingerprint: proof.intentDigest,
        agreementAllocations: preflight.payerDestinations.map(
          (payerDestination, index) => ({
            ...payerDestination,
            providerUid: `018f22e2-7c00-7000-8000-00000000009${index}`,
          }),
        ),
        submittedAt: Date.now(),
        expectedRequesterDestinationId: preflight.requesterDestinationId,
      }),
    ).rejects.toThrow('selected Payer is unavailable')

    const durable = await durableSubmissionState(t)
    expect(durable).toEqual({
      requests: [],
      agreements: [],
      evidence: [],
      work: [],
    })
  })

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
    const secondPayer = await addPayer(t, 2)
    const candidate = {
      ...moneyRequestIntent(payerUserId, {
        submissionKey: '018f22e2-7c00-7000-8000-000000000004',
      }),
      payerIds: [payerUserId, secondPayer.payerUserId],
    }
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
        agreementAllocations: preflight.payerDestinations.map(
          (payerDestination, index) => ({
            ...payerDestination,
            providerUid:
              index === 1
                ? existingAgreement.providerUid
                : '018f22e2-7c00-7000-8000-000000000098',
          }),
        ),
        submittedAt: Date.now(),
        expectedRequesterDestinationId: preflight.requesterDestinationId,
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
    const { t, requester, payerUserId } = await setup()
    await t.mutation(internal.users.addUser, {
      tokenIdentifier: otherRequesterIdentity.tokenIdentifier,
      clerkUserId: otherRequesterIdentity.subject,
      email: otherRequesterIdentity.email,
      name: otherRequesterIdentity.name,
    })
    const unauthorized = t.withIdentity(otherRequesterIdentity)
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
      unauthorized.query(api.moneyRequests.get, { moneyRequestId }),
    ).rejects.toThrow('Money Request was not found')
    await expect(
      requester.query(api.moneyRequests.get, { moneyRequestId: missingId }),
    ).rejects.toThrow('Money Request was not found')
  })
})
