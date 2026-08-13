/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import workpoolTest from '@convex-dev/workpool/test'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api, internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { protectPaymentDestination } from './lib/paymentDestinationCrypto'
import schema from './schema'
import type { PaymentDestinationInput } from './validators/paymentDestinations'
import { handleMoneyRequestSubmission } from '../src/server-fns/money-requests'

const modules = import.meta.glob('./**/*.ts')
const encryptionKey = btoa('0123456789abcdef0123456789abcdef')
const fingerprintKey = btoa('fingerprint-key-32-bytes-long!!xx')
const ingressSecret = 'test-ingress-attestation-secret-32-bytes'
const submissionKey = '018f22e2-7c00-7000-8000-000000000001'
const trustedIp = '203.0.113.42'
const certifiedPayIdCapability = JSON.stringify({
  enabled: true,
  trustedIpv4: true,
  payToAliasesScope: true,
  liveAliasResolution: true,
  privacyAssertions: true,
  aliasKinds: [
    'alias_phone',
    'alias_email',
    'alias_abn',
    'alias_organisation_identifier',
  ],
  fraudLimits: { account: 100, remoteIp: 20, requester: 20 },
  certificationCommit: 'a'.repeat(40),
})

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

const operatorIdentity = {
  tokenIdentifier: 'https://clerk.example.test|operator_101',
  subject: 'operator_101',
  issuer: 'https://clerk.example.test',
  email: 'operator@example.test',
  name: 'Operations User',
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
  workpoolTest.register(t, 'agreementCreationWorkpool')
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

type PayIdDestinationInput = Exclude<PaymentDestinationInput, { type: 'bban' }>

async function seedPayId(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
  ownerUserId: Id<'users'>,
  destination: PayIdDestinationInput,
  setAsDefault = true,
) {
  const protectedDestination = await protectPaymentDestination(destination)
  return await t.mutation(internal.paymentDestinations.insertProtected, {
    ownerUserId,
    protectedDestination,
    setAsDefault,
  })
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

async function removeQueuedMoneyRequestState(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
) {
  await t.run(async (ctx) => {
    for (const table of [
      'payToAgreementEvidence',
      'payToAgreementWorkItems',
      'payToAgreements',
      'moneyRequests',
    ] as const) {
      for (const document of await ctx.db.query(table).collect()) {
        await ctx.db.delete(table, document._id)
      }
    }
  })
}

async function agreementForMoneyRequest(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
  moneyRequestId: Id<'moneyRequests'>,
) {
  const agreement = await t.run(async (ctx) =>
    ctx.db
      .query('payToAgreements')
      .withIndex('by_moneyRequestId', (q) =>
        q.eq('moneyRequestId', moneyRequestId),
      )
      .unique(),
  )
  if (!agreement) throw new Error('Expected PayTo Agreement')
  return agreement
}

async function placeAgreementOnManualHold(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
  payToAgreementId: Id<'payToAgreements'>,
  workOverrides: Partial<{
    absenceCount: number
    lastPostAt: number
    postCycle: number
  }> = {},
) {
  await t.run(async (ctx) => {
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', payToAgreementId),
      )
      .unique()
    if (!workItem) throw new Error('Expected creation work item')
    await ctx.db.patch('payToAgreements', payToAgreementId, {
      creationState: 'manual_hold',
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'held',
      ...workOverrides,
    })
  })
}

async function recoveryStateForAgreement(
  t: Awaited<ReturnType<typeof setupUsers>>['t'],
  payToAgreementId: Id<'payToAgreements'>,
) {
  return await t.run(async (ctx) => ({
    agreement: await ctx.db.get('payToAgreements', payToAgreementId),
    evidence: await ctx.db
      .query('payToAgreementEvidence')
      .withIndex('by_payToAgreementId_and_observedAt', (q) =>
        q.eq('payToAgreementId', payToAgreementId),
      )
      .take(10),
  }))
}

function publicAgreementsByPayerName<
  TAgreement extends { payer: { name: string } },
>(agreements: TAgreement[]) {
  return new Map(
    agreements.map((agreement) => [agreement.payer.name, agreement]),
  )
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
  process.env.ZEPTO_ENVIRONMENT = 'sandbox'
  process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-test-token'
  delete process.env.ZEPTO_PAYID_CAPABILITY
  process.env.PAYME_RELEASE_COMMIT = 'a'.repeat(40)
  delete process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Money Request submission and requester read', () => {
  test('rejects a PayID before commit while its independent capability is disabled', async () => {
    const { t, requester, payerUserId } = await setup()
    await seedPayId(t, payerUserId, {
      type: 'alias_email',
      value: 'payer@example.com',
    })
    const fetch = vi.spyOn(globalThis, 'fetch')

    await expect(
      submit(requester, moneyRequestIntent(payerUserId)),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: 'PAYER_UNAVAILABLE' }),
    })
    expect(fetch).not.toHaveBeenCalled()
    await expect(durableSubmissionState(t)).resolves.toMatchObject({
      requests: [],
      agreements: [],
      evidence: [],
      work: [],
    })
  })

  test.each([
    ['alias_phone', '+61-411222333'],
    ['alias_email', 'payer@example.com'],
    ['alias_abn', '51824753556'],
    ['alias_organisation_identifier', 'example-campaign'],
  ] as const)(
    'validates and snapshots an enabled %s without retaining its display name',
    async (type, value) => {
      process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
      process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
        'payid-pseudonym-secret-at-least-32-bytes'
      const requests: Request[] = []
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
        requests.push(new Request(request).clone())
        return new Response(
          JSON.stringify({ data: { display_name: 'Never Persist This Name' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      })
      const { t, requester, payerUserId } = await setup()
      await seedPayId(t, payerUserId, { type, value })

      const moneyRequestId = await submit(
        requester,
        moneyRequestIntent(payerUserId),
      )

      expect(requests).toHaveLength(1)
      const lookup = (await requests[0]?.json()) as {
        type: string
        value: string
        requester: { id: string; remote_ip: string }
      }
      expect(lookup).toMatchObject({
        type,
        value,
        requester: { remote_ip: trustedIp },
      })
      expect(lookup.requester.id).toMatch(/^payme_[A-Za-z0-9_-]{43}$/)
      expect(lookup.requester.id).not.toContain(requesterIdentity.subject)
      const durable = await t.run(async (ctx) => ({
        request: await ctx.db.get('moneyRequests', moneyRequestId),
        agreement: await ctx.db
          .query('payToAgreements')
          .withIndex('by_moneyRequestId', (q) =>
            q.eq('moneyRequestId', moneyRequestId),
          )
          .unique(),
        evidence: await ctx.db.query('payToAgreementEvidence').take(10),
      }))
      expect(durable.agreement?.debtorSnapshot.kind).toBe(type)
      expect(JSON.stringify(durable)).not.toContain('Never Persist This Name')
      expect(JSON.stringify(durable)).not.toContain(value)
      expect(JSON.stringify(durable)).not.toContain(trustedIp)
      await removeQueuedMoneyRequestState(t)
    },
  )

  test('does not synchronously revalidate the Bank Account baseline in a mixed PayID submission', async () => {
    process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
    process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
      'payid-pseudonym-secret-at-least-32-bytes'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { display_name: 'Transient' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { t, requester, requesterUserId, payerUserId } = await setup()
    const requesterDestination = await t.run(async (ctx) =>
      ctx.db
        .query('paymentDestinations')
        .withIndex('by_ownerUserId', (q) =>
          q.eq('ownerUserId', requesterUserId),
        )
        .unique(),
    )
    if (!requesterDestination) throw new Error('Expected Requester destination')
    await t.run(async (ctx) =>
      ctx.db.patch('paymentDestinations', requesterDestination._id, {
        ciphertext: btoa('legacy-invalid-ciphertext'),
      }),
    )
    await seedPayId(t, payerUserId, {
      type: 'alias_email',
      value: 'payer@example.com',
    })

    await expect(
      submit(requester, moneyRequestIntent(payerUserId)),
    ).resolves.toBeTruthy()
    await removeQueuedMoneyRequestState(t)
  })

  test('maps missing PayID provider configuration to a safe pre-commit failure', async () => {
    process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
    process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
      'payid-pseudonym-secret-at-least-32-bytes'
    delete process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN
    const { t, requester, payerUserId } = await setup()
    await seedPayId(t, payerUserId, {
      type: 'alias_email',
      value: 'payer@example.com',
    })

    await expect(
      submit(requester, moneyRequestIntent(payerUserId)),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: 'SERVICE_UNAVAILABLE',
        retryable: true,
      }),
    })
    await expect(durableSubmissionState(t)).resolves.toMatchObject({
      requests: [],
      agreements: [],
      work: [],
    })
  })

  test.each([
    [
      'corrupt ciphertext',
      { ciphertext: btoa('corrupt') },
      'PAYER_UNAVAILABLE',
    ],
    [
      'missing encryption key',
      { keyVersion: 'missing' },
      'SERVICE_UNAVAILABLE',
    ],
  ] as const)(
    'classifies PayID %s safely before commit',
    async (_case, patch, expectedCode) => {
      process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
      process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
        'payid-pseudonym-secret-at-least-32-bytes'
      const { t, requester, payerUserId } = await setup()
      const destinationId = await seedPayId(t, payerUserId, {
        type: 'alias_email',
        value: 'payer@example.com',
      })
      await t.run(async (ctx) =>
        ctx.db.patch('paymentDestinations', destinationId, patch),
      )

      await expect(
        submit(requester, moneyRequestIntent(payerUserId)),
      ).rejects.toMatchObject({
        data: expect.objectContaining({ code: expectedCode }),
      })
      await expect(durableSubmissionState(t)).resolves.toMatchObject({
        requests: [],
        agreements: [],
        work: [],
      })
    },
  )

  test('resolves one Creditor PayID once and reuses it across the bounded Payer set', async () => {
    process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
    process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
      'payid-pseudonym-secret-at-least-32-bytes'
    const lookups: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      lookups.push(new Request(request).clone())
      return new Response(
        JSON.stringify({ data: { display_name: 'Transient' } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    })
    const users = await setup()
    const second = await addPayer(users.t, 100)
    await seedPayId(users.t, users.requesterUserId, {
      type: 'alias_email',
      value: 'requester@example.com',
    })
    await submit(users.requester, {
      ...moneyRequestIntent(users.payerUserId),
      payerIds: [users.payerUserId, second.payerUserId],
    })
    expect(lookups).toHaveLength(1)
    expect((await lookups[0].json()).type).toBe('alias_email')
    await removeQueuedMoneyRequestState(users.t)
  })

  test('resolves each distinct Debtor once, skips lookup on replay, and keeps no cross-submission cache', async () => {
    process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
    process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
      'payid-pseudonym-secret-at-least-32-bytes'
    const lookups: Array<{ type: string; value: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const providerRequest = new Request(request)
      const body = (await providerRequest.clone().json()) as {
        type: string
        value: string
        uid?: string
      }
      if (providerRequest.url.endsWith('/payto/alias_resolution')) {
        lookups.push({ type: body.type, value: body.value })
        return new Response(
          JSON.stringify({ data: { display_name: 'Transient' } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
      return new Response(
        JSON.stringify({
          data: {
            uid: body.uid,
            state: 'pending',
            created_at: '2026-08-11T09:30:00+10:00',
            mms_agreement_id: null,
          },
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    })
    const users = await setup()
    await seedPayId(users.t, users.payerUserId, {
      type: 'alias_email',
      value: 'payer@example.com',
    })
    const second = await addPayer(users.t, 101, false)
    await seedPayId(users.t, second.payerUserId, {
      type: 'alias_phone',
      value: '+61-411222333',
    })
    const firstIntent = {
      ...moneyRequestIntent(users.payerUserId),
      payerIds: [users.payerUserId, second.payerUserId],
    }

    await submit(users.requester, firstIntent)
    await submit(users.requester, firstIntent)
    expect(lookups).toEqual([
      { type: 'alias_email', value: 'payer@example.com' },
      { type: 'alias_phone', value: '+61-411222333' },
    ])

    await submit(users.requester, {
      ...firstIntent,
      submissionKey: '018f22e2-7c00-7000-8000-000000000077',
    })
    expect(lookups).toHaveLength(4)
    expect(lookups.slice(2)).toEqual(lookups.slice(0, 2))
    await removeQueuedMoneyRequestState(users.t)
  })

  test.each([
    [503, 'ZPADD98', 'VALIDATION_UNAVAILABLE', true],
    [401, undefined, 'SERVICE_UNAVAILABLE', true],
    [403, undefined, 'SERVICE_UNAVAILABLE', true],
    [422, 'ZPUNP09', 'SERVICE_UNAVAILABLE', true],
    [422, 'ZPADD01', 'PAYER_UNAVAILABLE', false],
  ] as const)(
    'classifies PayID lookup HTTP %i safely before commit',
    async (status, providerCode, expectedCode, retryable) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      const errorLog = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
      process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
        'payid-pseudonym-secret-at-least-32-bytes'
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                title: 'Sensitive provider detail',
                detail: 'Never expose this alias detail',
                ...(providerCode === undefined ? {} : { code: providerCode }),
              },
            ],
          }),
          { status, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      const { t, requester, payerUserId } = await setup()
      await seedPayId(t, payerUserId, {
        type: 'alias_email',
        value: 'payer@example.com',
      })

      const submissionError = await submit(
        requester,
        moneyRequestIntent(payerUserId),
      ).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(submissionError).toMatchObject({
        data: expect.objectContaining({ code: expectedCode, retryable }),
      })
      const durable = await durableSubmissionState(t)
      expect(durable).toMatchObject({ requests: [], agreements: [], work: [] })
      expect(JSON.stringify(durable)).not.toContain('Sensitive provider detail')
      expect(JSON.stringify(submissionError)).not.toContain(
        'Sensitive provider detail',
      )
      expect(JSON.stringify(submissionError)).not.toContain(
        'Never expose this alias detail',
      )
      expect(
        JSON.stringify([...log.mock.calls, ...errorLog.mock.calls]),
      ).not.toContain('Sensitive provider detail')
    },
  )

  test('rechecks a PayID Default Destination after lookup and rolls back a race', async () => {
    process.env.ZEPTO_PAYID_CAPABILITY = certifiedPayIdCapability
    process.env.MONEY_REQUEST_PAYID_REQUESTER_ID_SECRET =
      'payid-pseudonym-secret-at-least-32-bytes'
    const { t, requester, payer, payerUserId } = await setup()
    await seedPayId(t, payerUserId, {
      type: 'alias_email',
      value: 'payer@example.com',
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await payer.action(api.paymentDestinations.create, {
        destination: { type: 'bban', value: '111222-0033333' },
        setAsDefault: true,
      })
      return new Response(
        JSON.stringify({ data: { display_name: 'Transient' } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    })

    await expect(
      submit(requester, moneyRequestIntent(payerUserId)),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: 'PAYER_UNAVAILABLE' }),
    })
    await expect(durableSubmissionState(t)).resolves.toMatchObject({
      requests: [],
      agreements: [],
      work: [],
    })
  })
  test(
    'reactively exposes a created sandbox agreement after bounded provider work completes',
    createdAgreementTest,
  )

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

  async function createdAgreementTest() {
    const postedProviderUids: string[] = []
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (request) => {
        const body = (await new Request(request).json()) as { uid: string }
        postedProviderUids.push(body.uid)
        return new Response(
          JSON.stringify({
            data: {
              uid: body.uid,
              state: 'pending',
              created_at: '2026-08-11T09:30:00+10:00',
              mms_agreement_id: '3de455278b21196da0c4599025cb7dfa',
              links: { self: 'https://provider.example/raw-provider-marker' },
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        )
      })
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const agreement = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique(),
    )
    if (!agreement) throw new Error('Expected PayTo Agreement')
    vi.useFakeTimers()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()

    const created = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    expect(created).toMatchObject({
      agreements: [
        {
          creation: { state: 'created' },
          lifecycle: {
            meaning: 'waitingForPayer',
            confidence: 'provisional',
          },
          tracking: { state: 'verificationDue' },
        },
      ],
    })
    const zeptoRequests = fetch.mock.calls
      .map(([request]) =>
        request instanceof Request ? request.url : request.toString(),
      )
      .filter((url) => url.includes('api.sandbox.zeptopayments.com'))
    expect(zeptoRequests.length).toBeGreaterThan(0)
    expect(postedProviderUids).toHaveLength(zeptoRequests.length)
    expect(new Set(postedProviderUids)).toEqual(
      new Set([agreement.providerUid]),
    )
    const durable = await t.run(async (ctx) => ({
      agreement: await ctx.db.get('payToAgreements', agreement._id),
      evidence: await ctx.db
        .query('payToAgreementEvidence')
        .withIndex('by_payToAgreementId_and_observedAt', (q) =>
          q.eq('payToAgreementId', agreement._id),
        )
        .take(4),
      work: await ctx.db
        .query('payToAgreementWorkItems')
        .withIndex('by_payToAgreementId', (q) =>
          q.eq('payToAgreementId', agreement._id),
        )
        .unique(),
    }))
    expect(durable.agreement).toMatchObject({
      providerUid: agreement.providerUid,
      providerMmsAgreementId: '3de455278b21196da0c4599025cb7dfa',
      creationState: 'created',
      lifecycleState: 'pending',
      lifecycleConfidence: 'provisional',
      trackingState: 'verification_due',
    })
    expect(durable.evidence.map(({ kind }) => kind)).toEqual([
      'local_accepted',
      'creation_attempt_started',
      'provider_http_post_attempted',
      'provider_create_succeeded',
    ])
    expect(durable.work?.state).toBe('completed')
    expect(JSON.stringify(created)).not.toContain(agreement.providerUid)
    expect(JSON.stringify(created)).not.toContain('providerUid')
    expect(JSON.stringify(created)).not.toContain(
      '3de455278b21196da0c4599025cb7dfa',
    )
    expect(JSON.stringify(created)).not.toContain('providerMmsAgreementId')
    expect(JSON.stringify(durable)).not.toContain('raw-provider-marker')
    expect(JSON.stringify(durable)).not.toContain('123456-0012345')
    expect(JSON.stringify(durable)).not.toContain('654321-0098765')
  }

  test('recovers an invalid success response through same-UID GET without a second POST cycle', async () => {
    const providerRequests: Array<{ method: string; uid: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const providerRequest = new Request(request)
      if (providerRequest.method === 'POST') {
        const body = (await providerRequest.json()) as { uid: string }
        providerRequests.push({ method: 'POST', uid: body.uid })
        return new Response(JSON.stringify({ data: { uid: body.uid } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const uid = decodeURIComponent(providerRequest.url.split('/').at(-1)!)
      providerRequests.push({ method: 'GET', uid })
      return new Response(
        JSON.stringify({
          data: {
            uid,
            state: 'pending',
            created_at: '2026-08-11T09:30:00+10:00',
            mms_agreement_id: null,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const expectedUid = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique()
        .then((agreement) => agreement?.providerUid),
    )
    vi.useFakeTimers()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    vi.useRealTimers()

    const durable = await t.run(async (ctx) => ({
      agreement: await ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique(),
      evidence: await ctx.db.query('payToAgreementEvidence').take(10),
    }))
    const methods = providerRequests
      .filter(({ uid }) => uid === expectedUid)
      .map(({ method }) => method)
    expect(methods.at(-1)).toBe('GET')
    expect(
      methods.filter((method) => method === 'POST').length,
    ).toBeLessThanOrEqual(3)
    expect(durable.agreement?.providerUid).toBe(expectedUid)
    expect(durable.agreement?.creationState).toBe('created')
    expect(durable.evidence.map(({ kind }) => kind)).toEqual([
      'local_accepted',
      'creation_attempt_started',
      'provider_http_post_attempted',
      'provider_create_ambiguous',
      'provider_http_get_attempted',
      'provider_create_succeeded',
    ])
  })

  test('uses six same-UID POST attempts across two cycles and never starts a third', async () => {
    const providerRequests: Array<{ method: string; uid: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const providerRequest = new Request(request)
      if (providerRequest.method === 'POST') {
        const body = (await providerRequest.json()) as { uid: string }
        providerRequests.push({ method: 'POST', uid: body.uid })
        return new Response('temporarily unavailable', {
          status: 503,
          headers: { 'Retry-After': '0' },
        })
      }
      const uid = decodeURIComponent(providerRequest.url.split('/').at(-1)!)
      providerRequests.push({ method: 'GET', uid })
      return new Response(null, { status: 404 })
    })
    vi.useFakeTimers()
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const expectedUid = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique()
        .then((agreement) => agreement?.providerUid),
    )
    await t.finishAllScheduledFunctions(vi.advanceTimersToNextTimer)
    vi.useRealTimers()

    const state = await t.run(async (ctx) => ({
      agreement: await ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique(),
      evidence: await ctx.db.query('payToAgreementEvidence').take(50),
    }))
    const requests = providerRequests.filter(({ uid }) => uid === expectedUid)
    expect(requests.filter(({ method }) => method === 'POST')).toHaveLength(6)
    expect(new Set(requests.map(({ uid }) => uid))).toEqual(
      new Set([expectedUid]),
    )
    expect(state.agreement?.creationState).toBe('manual_hold')
    expect(
      state.evidence.filter(
        ({ kind }) => kind === 'provider_http_post_attempted',
      ),
    ).toHaveLength(6)
    expect(
      state.evidence.filter(({ kind }) => kind === 'creation_attempt_started'),
    ).toHaveLength(2)
  })

  test('rejects duplicate and stale worker outcomes and verifies after lease expiry', async () => {
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const agreement = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .unique(),
    )
    if (!agreement) throw new Error('Expected PayTo Agreement')
    const nowMs = 1_000
    const firstClaim = await t.mutation(
      internal.payToAgreementCreation.claimWork,
      { payToAgreementId: agreement._id, leaseToken: 'worker-a', nowMs },
    )
    expect(firstClaim?.kind).toBe('post')
    await expect(
      t.mutation(internal.payToAgreementCreation.claimWork, {
        payToAgreementId: agreement._id,
        leaseToken: 'worker-b',
        nowMs: nowMs + 1,
      }),
    ).resolves.toBeNull()
    await expect(
      t.mutation(internal.payToAgreementCreation.recordCreated, {
        payToAgreementId: agreement._id,
        leaseToken: 'worker-b',
        source: 'creation_response',
        result: {
          providerState: 'pending',
          providerCreatedAt: nowMs,
          providerMmsAgreementId: null,
        },
        observedAt: nowMs + 2,
      }),
    ).resolves.toBe(false)

    const recovered = await t.mutation(
      internal.payToAgreementCreation.claimWork,
      {
        payToAgreementId: agreement._id,
        leaseToken: 'worker-c',
        nowMs: nowMs + 3 * 60_000 + 1,
      },
    )
    expect(recovered?.kind).toBe('verify')
    await expect(
      t.mutation(internal.payToAgreementCreation.recordCreated, {
        payToAgreementId: agreement._id,
        leaseToken: 'worker-a',
        source: 'creation_response',
        result: {
          providerState: 'pending',
          providerCreatedAt: nowMs,
          providerMmsAgreementId: null,
        },
        observedAt: nowMs + 3 * 60_000 + 2,
      }),
    ).resolves.toBe(false)
    const state = await t.run(async (ctx) => ({
      agreement: await ctx.db.get('payToAgreements', agreement._id),
      evidence: await ctx.db.query('payToAgreementEvidence').take(10),
    }))
    expect(state.agreement?.creationState).toBe('verifying')
    expect(state.evidence.map(({ kind }) => kind)).toContain(
      'creation_lease_expired',
    )
  })

  test('reopens only one manually held agreement through an audited operator action', async () => {
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const agreement = await agreementForMoneyRequest(t, moneyRequestId)
    await placeAgreementOnManualHold(t, agreement._id, { postCycle: 2 })

    await t.mutation(internal.payToAgreementCreation.reopenManualHold, {
      payToAgreementId: agreement._id,
      operatorIdentity: `  ${operatorIdentity.tokenIdentifier}  `,
      reason: '  Investigate ambiguous sandbox response  ',
    })

    const state = await recoveryStateForAgreement(t, agreement._id)
    expect(state.agreement?.creationState).toBe('verifying')
    expect(state.evidence.at(-1)).toMatchObject({
      kind: 'operator_reopened',
      operatorIdentity: operatorIdentity.tokenIdentifier,
      reason: 'Investigate ambiguous sandbox response',
      mode: 'verifying',
    })
  })

  test('requires an authenticated operator and a non-empty recovery reason', async () => {
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const agreement = await agreementForMoneyRequest(t, moneyRequestId)
    await placeAgreementOnManualHold(t, agreement._id)

    await expect(
      t.mutation(internal.payToAgreementCreation.reopenManualHold, {
        payToAgreementId: agreement._id,
        operatorIdentity: '   ',
        reason: 'Investigate provider response',
      }),
    ).rejects.toThrow('PayTo Agreement creation is temporarily unavailable')
    await expect(
      t.mutation(internal.payToAgreementCreation.reopenManualHold, {
        payToAgreementId: agreement._id,
        operatorIdentity: operatorIdentity.tokenIdentifier,
        reason: '   ',
      }),
    ).rejects.toThrow('PayTo Agreement creation is temporarily unavailable')

    const state = await recoveryStateForAgreement(t, agreement._id)
    expect(state.agreement?.creationState).toBe('manual_hold')
    expect(state.evidence.map(({ kind }) => kind)).not.toContain(
      'operator_reopened',
    )
  })

  test('queues a manually held agreement only after absence is established', async () => {
    const { t, requester, payerUserId } = await setup()
    const moneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId),
    )
    const agreement = await agreementForMoneyRequest(t, moneyRequestId)
    await placeAgreementOnManualHold(t, agreement._id, {
      absenceCount: 2,
      postCycle: 1,
      lastPostAt: 0,
    })

    await t.mutation(internal.payToAgreementCreation.reopenManualHold, {
      payToAgreementId: agreement._id,
      operatorIdentity: operatorIdentity.tokenIdentifier,
      reason: 'Provider lookup established absence',
    })

    const state = await recoveryStateForAgreement(t, agreement._id)
    expect(state.agreement).toMatchObject({
      creationState: 'queued',
      trackingState: 'retrying',
      providerUid: agreement.providerUid,
    })
    expect(state.evidence.at(-1)).toMatchObject({
      kind: 'operator_reopened',
      mode: 'queued',
      operatorIdentity: operatorIdentity.tokenIdentifier,
      reason: 'Provider lookup established absence',
    })
  })

  test.each(['created', 'failed'] as const)(
    'refuses to recover a terminal %s agreement',
    async (terminalState) => {
      const { t, requester, payerUserId } = await setup()
      const moneyRequestId = await submit(
        requester,
        moneyRequestIntent(payerUserId),
      )
      const agreement = await agreementForMoneyRequest(t, moneyRequestId)
      await t.run(async (ctx) => {
        await ctx.db.patch('payToAgreements', agreement._id, {
          creationState: terminalState,
        })
      })

      await expect(
        t.mutation(internal.payToAgreementCreation.reopenManualHold, {
          payToAgreementId: agreement._id,
          operatorIdentity: operatorIdentity.tokenIdentifier,
          reason: 'Retry terminal agreement',
        }),
      ).rejects.toThrow('PayTo Agreement creation is temporarily unavailable')
      expect(
        await t.run(async (ctx) =>
          ctx.db.get('payToAgreements', agreement._id),
        ),
      ).toMatchObject({
        creationState: terminalState,
        providerUid: agreement.providerUid,
      })
    },
  )

  test('preserves evidence and the provider UID without mutating sibling agreements', async () => {
    const { t, requester, payerUserId } = await setup()
    const siblingPayer = await addPayer(t, 2)
    const moneyRequestId = await submit(requester, {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, siblingPayer.payerUserId],
    })
    const agreements = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .take(2),
    )
    const target = agreements.find(({ payerUserId: id }) => id === payerUserId)
    const sibling = agreements.find(
      ({ payerUserId: id }) => id === siblingPayer.payerUserId,
    )
    if (!target || !sibling) throw new Error('Expected sibling agreements')
    await placeAgreementOnManualHold(t, target._id)
    const before = await t.run(async (ctx) => {
      return {
        sibling: await ctx.db.get('payToAgreements', sibling._id),
        evidence: await ctx.db
          .query('payToAgreementEvidence')
          .withIndex('by_payToAgreementId_and_observedAt', (q) =>
            q.eq('payToAgreementId', target._id),
          )
          .take(10),
      }
    })

    await t.mutation(internal.payToAgreementCreation.reopenManualHold, {
      payToAgreementId: target._id,
      operatorIdentity: operatorIdentity.tokenIdentifier,
      reason: 'Resume target only',
    })

    const [after, siblingAfter] = await Promise.all([
      recoveryStateForAgreement(t, target._id),
      t.run(async (ctx) => ctx.db.get('payToAgreements', sibling._id)),
    ])
    expect(after.agreement).toMatchObject({
      creationState: 'verifying',
      providerUid: target.providerUid,
    })
    expect(siblingAfter).toEqual(before.sibling)
    expect(after.evidence.slice(0, before.evidence.length)).toEqual(
      before.evidence,
    )
    expect(after.evidence.at(-1)).toMatchObject({ kind: 'operator_reopened' })
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

  test('durably backpressures accepted work beyond the provider concurrency bound', async () => {
    const releases: Array<() => void> = []
    const trackedProviderUids = new Set<string>()
    let activeProviderRequests = 0
    let maximumActiveProviderRequests = 0
    let providerRequestCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const providerRequest = new Request(request)
      if (providerRequest.method !== 'POST') {
        throw new Error('Expected only agreement creation requests')
      }
      const body = (await providerRequest.json()) as { uid: string }
      const successResponse = () =>
        new Response(
          JSON.stringify({
            data: {
              uid: body.uid,
              state: 'pending',
              created_at: '2026-08-11T09:30:00+10:00',
              mms_agreement_id: null,
            },
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      if (!trackedProviderUids.has(body.uid)) return successResponse()
      providerRequestCount += 1
      activeProviderRequests += 1
      maximumActiveProviderRequests = Math.max(
        maximumActiveProviderRequests,
        activeProviderRequests,
      )
      return await new Promise<Response>((resolve) => {
        releases.push(() => {
          activeProviderRequests -= 1
          resolve(successResponse())
        })
      })
    })
    const { t, requester, payerUserId } = await setup()
    const addedPayers = await Promise.all(
      [2, 3, 4, 5].map((index) => addPayer(t, index)),
    )
    const saturatedMoneyRequestId = await submit(requester, {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, ...addedPayers.map((payer) => payer.payerUserId)],
    })
    const saturatedAgreements = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', saturatedMoneyRequestId),
        )
        .take(5),
    )
    for (const agreement of saturatedAgreements) {
      trackedProviderUids.add(agreement.providerUid)
    }
    const waitForProviderRequestCount = async (expected: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (providerRequestCount === expected) return
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      expect(providerRequestCount).toBe(expected)
    }
    const drain = t.finishAllScheduledFunctions(() => {})
    await waitForProviderRequestCount(5)

    const backpressuredMoneyRequestId = await submit(
      requester,
      moneyRequestIntent(payerUserId, {
        submissionKey: '018f22e2-7c00-7000-8000-000000000002',
      }),
    )
    const acceptedBackpressure = await t.run(async (ctx) => {
      const agreement = await ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', backpressuredMoneyRequestId),
        )
        .unique()
      if (!agreement) throw new Error('Expected backpressured agreement')
      trackedProviderUids.add(agreement.providerUid)
      return {
        agreement,
        workItem: await ctx.db
          .query('payToAgreementWorkItems')
          .withIndex('by_payToAgreementId', (q) =>
            q.eq('payToAgreementId', agreement._id),
          )
          .unique(),
      }
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(providerRequestCount).toBe(5)
    expect(maximumActiveProviderRequests).toBe(5)
    expect(acceptedBackpressure.agreement.creationState).toBe('queued')
    expect(acceptedBackpressure.workItem?.state).toBe('queued')

    for (let completed = 0; completed < 5; completed += 1) {
      releases.shift()?.()
    }
    await t.finishInProgressScheduledFunctions()
    const backlogDrains: Array<Promise<void>> = []
    for (
      let attempt = 0;
      attempt < 10 && providerRequestCount < 6;
      attempt += 1
    ) {
      backlogDrains.push(t.finishAllScheduledFunctions(() => {}))
      for (let turn = 0; turn < 20 && providerRequestCount < 6; turn += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
    expect(providerRequestCount).toBe(6)
    expect(maximumActiveProviderRequests).toBe(5)
    while (releases.length > 0) releases.shift()?.()
    await t.finishInProgressScheduledFunctions()
    await Promise.all([drain, ...backlogDrains])

    const drained = await requester.query(api.moneyRequests.get, {
      moneyRequestId: backpressuredMoneyRequestId,
    })
    expect(drained).toMatchObject({
      agreements: [{ creation: { state: 'created' } }],
    })
  })

  test('preserves five independent mixed outcomes through delay and targeted recovery', async () => {
    const { t, requester, payerUserId } = await setup()
    const addedPayers = await Promise.all(
      [2, 3, 4, 5].map((index) => addPayer(t, index)),
    )
    const moneyRequestId = await submit(requester, {
      ...moneyRequestIntent(payerUserId),
      payerIds: [payerUserId, ...addedPayers.map((payer) => payer.payerUserId)],
    })
    const agreements = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreements')
        .withIndex('by_moneyRequestId', (q) =>
          q.eq('moneyRequestId', moneyRequestId),
        )
        .take(5),
    )
    const byPayerName = new Map(
      agreements.map((agreement) => [agreement.payerNameSnapshot, agreement]),
    )
    const createdAgreement = byPayerName.get(payerIdentity.name)
    const failedAgreement = byPayerName.get(addedPayers[0].identity.name)
    const ambiguousAgreement = byPayerName.get(addedPayers[1].identity.name)
    const delayedAgreement = byPayerName.get(addedPayers[2].identity.name)
    if (
      !createdAgreement ||
      !failedAgreement ||
      !ambiguousAgreement ||
      !delayedAgreement
    ) {
      throw new Error('Expected every mixed-outcome agreement')
    }

    const nowMs = Date.now()
    const claim = async (
      agreement: (typeof agreements)[number],
      leaseToken: string,
    ) => {
      const result = await t.mutation(
        internal.payToAgreementCreation.claimWork,
        { payToAgreementId: agreement._id, leaseToken, nowMs },
      )
      expect(result?.kind).toBe('post')
    }
    await claim(createdAgreement, 'created-worker')
    await t.mutation(internal.payToAgreementCreation.recordCreated, {
      payToAgreementId: createdAgreement._id,
      leaseToken: 'created-worker',
      source: 'creation_response',
      result: {
        providerState: 'pending',
        providerCreatedAt: nowMs,
        providerMmsAgreementId: null,
      },
      observedAt: nowMs,
    })
    await claim(failedAgreement, 'failed-worker')
    await t.mutation(internal.payToAgreementCreation.recordPostFailure, {
      payToAgreementId: failedAgreement._id,
      leaseToken: 'failed-worker',
      recoveryClass: 'fail',
      category: 'http_422_raw-provider-detail',
      observedAt: nowMs,
    })
    await t.run(async (ctx) => {
      await ctx.db.patch(failedAgreement._id, { currentFailure: undefined })
    })
    await claim(ambiguousAgreement, 'ambiguous-worker')
    await t.mutation(internal.payToAgreementCreation.recordPostFailure, {
      payToAgreementId: ambiguousAgreement._id,
      leaseToken: 'ambiguous-worker',
      recoveryClass: 'verify',
      category: 'network_raw-provider-detail',
      observedAt: nowMs,
    })
    await claim(delayedAgreement, 'delayed-worker')
    await t.mutation(internal.payToAgreementCreation.recordPostFailure, {
      payToAgreementId: delayedAgreement._id,
      leaseToken: 'delayed-worker',
      recoveryClass: 'retry',
      category: 'http_422_raw-provider-detail',
      observedAt: nowMs,
    })

    const mixed = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    if (!('agreements' in mixed)) throw new Error('Expected Requester detail')
    const mixedByPayerName = publicAgreementsByPayerName(mixed.agreements)
    expect(mixedByPayerName.get(payerIdentity.name)).toMatchObject({
      creation: { state: 'created' },
    })
    expect(mixedByPayerName.get(addedPayers[0].identity.name)).toMatchObject({
      creation: { state: 'failed' },
      tracking: { state: 'stopped' },
      failure: {
        code: 'requestRejected',
        message:
          'This PayTo Agreement could not be created. Submit a new Money Request after checking the Payer details.',
        retryable: false,
      },
    })
    expect(mixedByPayerName.get(addedPayers[1].identity.name)).toMatchObject({
      creation: { state: 'verifying' },
      tracking: { state: 'checking' },
      failure: {
        code: 'providerOutcomeUncertain',
        message: 'The provider outcome is being verified safely.',
        retryable: true,
      },
    })
    expect(mixedByPayerName.get(addedPayers[2].identity.name)).toMatchObject({
      creation: { state: 'retrying' },
      tracking: { state: 'retrying' },
      failure: {
        code: 'providerTemporarilyUnavailable',
        message:
          'PayTo Agreement creation is delayed and will retry automatically.',
        retryable: true,
      },
    })
    expect(mixedByPayerName.get(addedPayers[3].identity.name)).toMatchObject({
      creation: { state: 'queued' },
      tracking: { state: 'verificationDue' },
    })
    expect(JSON.stringify(mixed)).not.toContain('raw-provider-detail')

    const verificationRetryClaim = await t.mutation(
      internal.payToAgreementCreation.claimWork,
      {
        payToAgreementId: ambiguousAgreement._id,
        leaseToken: 'verification-retry-worker',
        nowMs,
      },
    )
    expect(verificationRetryClaim?.kind).toBe('verify')
    await t.mutation(
      internal.payToAgreementCreation.recordVerificationFailure,
      {
        payToAgreementId: ambiguousAgreement._id,
        leaseToken: 'verification-retry-worker',
        category: 'network_raw-provider-detail',
        observedAt: nowMs,
      },
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(ambiguousAgreement._id, {
        currentFailure: undefined,
      })
    })
    const verificationRetry = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    if (!('agreements' in verificationRetry)) {
      throw new Error('Expected Requester detail')
    }
    const verificationRetryByPayerName = publicAgreementsByPayerName(
      verificationRetry.agreements,
    )
    expect(
      verificationRetryByPayerName.get(addedPayers[1].identity.name),
    ).toMatchObject({
      creation: { state: 'verifying' },
      tracking: { state: 'retrying' },
      failure: {
        code: 'providerTemporarilyUnavailable',
        message:
          'PayTo Agreement creation is delayed and will retry automatically.',
        retryable: true,
      },
    })
    expect(JSON.stringify(verificationRetry)).not.toContain(
      'raw-provider-detail',
    )

    const heldAgreement = byPayerName.get(addedPayers[3].identity.name)
    if (!heldAgreement) throw new Error('Expected held agreement')
    await claim(heldAgreement, 'held-worker')
    await t.mutation(internal.payToAgreementCreation.recordPostFailure, {
      payToAgreementId: heldAgreement._id,
      leaseToken: 'held-worker',
      recoveryClass: 'hold',
      category: 'configuration_raw-provider-detail',
      observedAt: nowMs,
    })
    const held = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    if (!('agreements' in held)) throw new Error('Expected Requester detail')
    const heldByPayerName = publicAgreementsByPayerName(held.agreements)
    expect(heldByPayerName.get(addedPayers[3].identity.name)).toMatchObject({
      creation: { state: 'needsReview' },
      tracking: { state: 'needsReview' },
      failure: {
        code: 'operatorReviewRequired',
        message:
          'PayTo Agreement creation needs review before it can continue.',
        retryable: false,
      },
    })
    expect(heldByPayerName.get(payerIdentity.name)).toMatchObject({
      creation: { state: 'created' },
    })
    expect(JSON.stringify(held)).not.toContain('raw-provider-detail')

    const recoveryClaim = await t.mutation(
      internal.payToAgreementCreation.claimWork,
      {
        payToAgreementId: ambiguousAgreement._id,
        leaseToken: 'recovery-worker',
        nowMs,
      },
    )
    expect(recoveryClaim?.kind).toBe('verify')
    await t.mutation(internal.payToAgreementCreation.recordCreated, {
      payToAgreementId: ambiguousAgreement._id,
      leaseToken: 'recovery-worker',
      source: 'per_uid_get',
      result: {
        providerState: 'pending',
        providerCreatedAt: nowMs,
        providerMmsAgreementId: null,
      },
      observedAt: nowMs,
    })

    const recovered = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    if (!('agreements' in recovered)) {
      throw new Error('Expected Requester detail')
    }
    const recoveredByPayerName = publicAgreementsByPayerName(
      recovered.agreements,
    )
    expect(recoveredByPayerName.get(payerIdentity.name)).toMatchObject({
      creation: { state: 'created' },
    })
    expect(
      recoveredByPayerName.get(addedPayers[1].identity.name),
    ).toMatchObject({ creation: { state: 'created' } })
    expect(
      recoveredByPayerName.get(addedPayers[1].identity.name),
    ).not.toHaveProperty('failure')
    expect(
      recoveredByPayerName.get(addedPayers[0].identity.name),
    ).toMatchObject({ creation: { state: 'failed' } })
    expect(
      recoveredByPayerName.get(addedPayers[2].identity.name),
    ).toMatchObject({ creation: { state: 'retrying' } })
    expect(
      recoveredByPayerName.get(addedPayers[3].identity.name),
    ).toMatchObject({ creation: { state: 'needsReview' } })
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
      const { t, requester, payer, requesterUserId, payerUserId } =
        await setupUsers()
      if (payIdOwner === 'requester') {
        await seedPayId(t, requesterUserId, {
          type: 'alias_email',
          value: 'requester@example.com',
        })
      } else {
        await requester.action(api.paymentDestinations.create, {
          destination: { type: 'bban', value: '123456-0012345' },
        })
      }
      if (payIdOwner === 'payer') {
        await seedPayId(t, payerUserId, {
          type: 'alias_email',
          value: 'payer@example.com',
        })
      } else {
        await payer.action(api.paymentDestinations.create, {
          destination: { type: 'bban', value: '654321-0098765' },
        })
      }

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
    expect(durable.evidence.map(({ kind }) => kind)).toContain('local_accepted')
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
    expect(
      durable.evidence.filter(({ kind }) => kind === 'local_accepted'),
    ).toHaveLength(2)
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
    expect(durable.evidence.map(({ kind }) => kind)).toContain('local_accepted')
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
              payerId: preflight.payerDestinations[0].payerId,
              destinationId: preflight.payerDestinations[0].destinationId,
              providerUid: '018f22e2-7c00-7000-8000-000000000099',
            },
          ],
          submittedAt: Date.now(),
          expectedRequesterDestinationId: preflight.requesterDestinationId,
          environment: 'sandbox',
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
          ({ payerId, destinationId }, index) => ({
            payerId,
            destinationId,
            providerUid: `018f22e2-7c00-7000-8000-00000000009${index}`,
          }),
        ),
        submittedAt: Date.now(),
        expectedRequesterDestinationId: preflight.requesterDestinationId,
        environment: 'sandbox',
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
          ({ payerId, destinationId }, index) => ({
            payerId,
            destinationId,
            providerUid:
              index === 1
                ? existingAgreement.providerUid
                : '018f22e2-7c00-7000-8000-000000000098',
          }),
        ),
        submittedAt: Date.now(),
        expectedRequesterDestinationId: preflight.requesterDestinationId,
        environment: 'sandbox',
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
    expect(durable.evidence.map(({ kind }) => kind)).toContain('local_accepted')
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
