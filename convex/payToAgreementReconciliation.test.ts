/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import workpoolTest from '@convex-dev/workpool/test'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { ZeptoEnvironment } from './validators/payToAgreements'

const modules = import.meta.glob('./**/*.ts')
const requesterIdentity = {
  tokenIdentifier: 'https://clerk.example.test|requester_reconciliation',
  subject: 'requester_reconciliation',
  issuer: 'https://clerk.example.test',
  name: 'Reconciliation Requester',
} satisfies UserIdentity

beforeEach(() => {
  process.env.ZEPTO_ENVIRONMENT = 'sandbox'
  process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'production-test-token'
  process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-test-token'
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function setupAgreement(environment: ZeptoEnvironment = 'sandbox') {
  const t = convexTest(schema, modules)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  const ids = await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: requesterIdentity.tokenIdentifier,
      clerkUserId: requesterIdentity.subject,
      email: 'requester-reconciliation@example.test',
      displayName: requesterIdentity.name,
      searchText: requesterIdentity.name,
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payer_reconciliation',
      clerkUserId: 'payer_reconciliation',
      email: 'payer-reconciliation@example.test',
      displayName: 'Reconciliation Payer',
      searchText: 'Reconciliation Payer',
    })
    const requesterDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: requesterUserId,
      type: 'bban',
      searchLabel: 'requester',
      maskedDisplay: '123456••••345',
      fingerprint: 'requester-reconciliation-fingerprint',
      ciphertext: 'requester-ciphertext',
      nonce: 'requester-nonce',
      keyVersion: 'v1',
    })
    const payerDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: payerUserId,
      type: 'bban',
      searchLabel: 'payer',
      maskedDisplay: '654321••••765',
      fingerprint: 'payer-reconciliation-fingerprint',
      ciphertext: 'payer-ciphertext',
      nonce: 'payer-nonce',
      keyVersion: 'v1',
    })
    const submittedAt = 1_000
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: requesterIdentity.name,
      amountCents: 1250,
      currency: 'AUD',
      purpose: 'other',
      description: 'Lifecycle reconciliation',
      submissionKey: '018f22e2-7c00-7000-8000-000000000020',
      submissionFingerprint: 'reconciliation-fingerprint',
      sourceCreditorPaymentDestinationId: requesterDestinationId,
      creditorSnapshot: {
        kind: 'bban',
        maskedDisplay: '123456••••345',
        ciphertext: 'requester-ciphertext',
        nonce: 'requester-nonce',
        keyVersion: 'v1',
      },
      submittedAt,
    })
    const payToAgreementId = await ctx.db.insert('payToAgreements', {
      moneyRequestId,
      payerUserId,
      payerNameSnapshot: 'Reconciliation Payer',
      sourceDebtorPaymentDestinationId: payerDestinationId,
      debtorSnapshot: {
        kind: 'bban',
        maskedDisplay: '654321••••765',
        ciphertext: 'payer-ciphertext',
        nonce: 'payer-nonce',
        keyVersion: 'v1',
      },
      provider: 'zepto',
      environment,
      apiVersion: '20260101',
      providerUid: 'agreement_reconciliation_1',
      activationProvenancePolicy: 'track_first_confirmation',
      creationState: 'created',
      creationUpdatedAt: submittedAt,
      lifecycleState: 'active',
      lifecycleConfidence: 'provisional',
      lifecycleObservedAt: submittedAt,
      trackingState: 'verification_due',
      trackingUpdatedAt: submittedAt,
    })
    await ctx.db.insert('payToAgreementReconciliationWorkItems', {
      payToAgreementId,
      providerUid: 'agreement_reconciliation_1',
      state: 'queued',
      availableAt: submittedAt,
    })
    return { moneyRequestId, payToAgreementId }
  })
  return { t, requester: t.withIdentity(requesterIdentity), ...ids }
}

describe('PayTo Agreement lifecycle reconciliation', () => {
  test('schedules waiting agreement polling thirty minutes after creation', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        creationState: 'verifying',
      })
      await ctx.db.insert('payToAgreementWorkItems', {
        payToAgreementId,
        kind: 'create',
        state: 'running',
        availableAt: 1_000,
        postCycle: 1,
        leaseToken: 'creation-lease',
        leaseExpiresAt: 200_000,
      })
    })

    expect(
      await t.mutation(internal.payToAgreementCreation.recordCreated, {
        payToAgreementId,
        leaseToken: 'creation-lease',
        source: 'creation_response',
        result: {
          providerState: 'pending',
          providerCreatedAt: 2_000,
          providerMmsAgreementId: null,
        },
        observedAt: 3_000,
      }),
    ).toBe(true)
    await expect(
      t.run(async (ctx) => ctx.db.get('payToAgreements', payToAgreementId)),
    ).resolves.not.toHaveProperty('firstConfirmedActiveAt')
    const work = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .withIndex('by_payToAgreementId', (q) =>
          q.eq('payToAgreementId', payToAgreementId),
        )
        .unique(),
    )
    expect(work).toMatchObject({
      state: 'queued',
      availableAt: 3_000 + 30 * 60_000,
    })
  })

  test('records an active creation-recovery GET as confirmed provenance', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        creationState: 'verifying',
      })
      await ctx.db.insert('payToAgreementWorkItems', {
        payToAgreementId,
        kind: 'create',
        state: 'running',
        availableAt: 1_000,
        postCycle: 1,
      })
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            uid: 'agreement_reconciliation_1',
            state: 'active',
            created_at: '2026-08-11T01:02:03.000Z',
            mms_agreement_id: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await t.action(internal.payToAgreementCreation.create, {
      payToAgreementId,
    })

    const durable = await t.run(async (ctx) => ({
      agreement: await ctx.db.get('payToAgreements', payToAgreementId),
      evidence: await ctx.db.query('payToAgreementEvidence').collect(),
    }))
    expect(durable.agreement).toMatchObject({
      lifecycleState: 'active',
      lifecycleConfidence: 'confirmed',
      firstConfirmedActiveAt: expect.any(Number),
    })
    expect(durable.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'provider_create_succeeded',
          source: 'per_uid_get',
        }),
      ]),
    )
  })

  test('repairs a missed terminal webhook from the provider GET boundary', async () => {
    const { t, requester, moneyRequestId, payToAgreementId } =
      await setupAgreement()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            uid: 'agreement_reconciliation_1',
            state: 'declined',
            created_at: '2026-08-11T01:02:03.000Z',
            mms_agreement_id: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await t.action(internal.payToAgreementReconciliation.reconcile, {
      payToAgreementId,
    })

    expect(
      await requester.query(api.moneyRequests.get, { moneyRequestId }),
    ).toMatchObject({
      agreements: [
        {
          lifecycle: { meaning: 'ended', confidence: 'confirmed' },
          tracking: { state: 'stopped' },
        },
      ],
    })
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  test('looks up production PayTo Agreements only with production configuration', async () => {
    process.env.ZEPTO_ENVIRONMENT = 'production'
    const { t, payToAgreementId } = await setupAgreement('production')
    const requests: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      requests.push(new Request(request).clone())
      return new Response(
        JSON.stringify({
          data: {
            uid: 'agreement_reconciliation_1',
            state: 'active',
            created_at: '2026-08-11T01:02:03.000Z',
            mms_agreement_id: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    await t.action(internal.payToAgreementReconciliation.reconcile, {
      payToAgreementId,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('https://api.zeptopayments.com/')
    expect(requests[0]?.headers.get('Authorization')).toBe(
      'Bearer production-test-token',
    )
  })

  test('turns provisional lifecycle evidence into a GET-confirmed public projection', async () => {
    const { t, requester, moneyRequestId, payToAgreementId } =
      await setupAgreement()
    const claimed = await t.mutation(
      internal.payToAgreementReconciliation.claimWork,
      {
        payToAgreementId,
        leaseToken: 'lease-confirm',
        nowMs: 2_000,
      },
    )

    expect(claimed).toEqual({
      environment: 'sandbox',
      providerUid: 'agreement_reconciliation_1',
    })
    expect(
      await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
        payToAgreementId,
        leaseToken: 'lease-confirm',
        providerState: 'active',
        observedAt: 3_000,
      }),
    ).toBe(true)

    const projection = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    expect(projection).toMatchObject({
      agreements: [
        {
          lifecycle: { meaning: 'ready', confidence: 'confirmed' },
          tracking: { state: 'current' },
        },
      ],
    })
    const durable = await t.run(async (ctx) => ({
      evidence: await ctx.db.query('payToAgreementEvidence').collect(),
      work: await ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .unique(),
    }))
    expect(durable.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'provider_lifecycle_get_observed',
          outcome: 'confirmed',
          providerState: 'active',
        }),
      ]),
    )
    expect(durable.work).toMatchObject({
      state: 'queued',
      availableAt: 3_000 + 24 * 60 * 60_000,
    })
  })

  test('records the first GET-confirmed active observation exactly once', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        activationProvenancePolicy: 'track_first_confirmation',
      })
    })
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-first-active',
      nowMs: 2_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
      payToAgreementId,
      leaseToken: 'lease-first-active',
      providerState: 'active',
      observedAt: 3_000,
    })

    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-repeated-active',
      nowMs: 3_000 + 24 * 60 * 60_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
      payToAgreementId,
      leaseToken: 'lease-repeated-active',
      providerState: 'active',
      observedAt: 4_000 + 24 * 60 * 60_000,
    })

    await expect(
      t.run(async (ctx) => ctx.db.get('payToAgreements', payToAgreementId)),
    ).resolves.toMatchObject({ firstConfirmedActiveAt: 3_000 })
  })

  test('concurrent active observations converge on one first confirmation', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        activationProvenancePolicy: 'track_first_confirmation',
      })
    })
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-concurrent-active',
      nowMs: 2_000,
    })

    const outcomes = await Promise.all([
      t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
        payToAgreementId,
        leaseToken: 'lease-concurrent-active',
        providerState: 'active',
        observedAt: 3_000,
      }),
      t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
        payToAgreementId,
        leaseToken: 'lease-concurrent-active',
        providerState: 'active',
        observedAt: 3_001,
      }),
    ])

    expect(outcomes.filter(Boolean)).toHaveLength(1)
    const agreement = await t.run(async (ctx) =>
      ctx.db.get('payToAgreements', payToAgreementId),
    )
    expect([3_000, 3_001]).toContain(agreement?.firstConfirmedActiveAt)
  })

  test('keeps unknown GET state internal and raises a safe public review projection', async () => {
    const { t, requester, moneyRequestId, payToAgreementId } =
      await setupAgreement()
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-unknown',
      nowMs: 2_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
      payToAgreementId,
      leaseToken: 'lease-unknown',
      providerState: 'paused account=9876543210 bearer secret',
      observedAt: 3_000,
    })

    const projection = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    expect(projection).toMatchObject({
      agreements: [
        {
          lifecycle: { meaning: 'unknown', confidence: 'confirmed' },
          tracking: { state: 'needsReview' },
          failure: { code: 'lifecycleUnknown' },
        },
      ],
    })
    expect(JSON.stringify(projection)).not.toContain('9876543210')
    const agreement = await t.run(async (ctx) =>
      ctx.db.get('payToAgreements', payToAgreementId),
    )
    expect(agreement).toMatchObject({
      lifecycleState: 'unknown',
      lifecycleRawState: 'unknown',
    })
  })

  test('captures normalized history evidence when GET returns an unknown state', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const path = new URL(new Request(request).url).pathname
      if (path.endsWith('/history')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'event-investigation',
                resource_uid: 'agreement_reconciliation_1',
                published_at: '2026-08-11T02:00:00.000Z',
                type: 'account=9876543210 bearer secret',
                body: { reason: 'must not be retained' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          data: {
            uid: 'agreement_reconciliation_1',
            state: 'paused_by_bank',
            created_at: '2026-08-11T01:02:03.000Z',
            mms_agreement_id: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    await t.action(internal.payToAgreementReconciliation.reconcile, {
      payToAgreementId,
    })

    const evidence = await t.run(async (ctx) =>
      ctx.db.query('payToAgreementEvidence').collect(),
    )
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'provider_history_investigated',
          eventCount: 1,
          eventTypes: ['unknown'],
        }),
      ]),
    )
    expect(JSON.stringify(evidence)).not.toContain('must not be retained')
    expect(JSON.stringify(evidence)).not.toContain('9876543210')
  })

  test('protects a confirmed terminal projection from contradictory GET truth', async () => {
    const { t, requester, moneyRequestId, payToAgreementId } =
      await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        lifecycleState: 'cancelled',
        lifecycleConfidence: 'confirmed',
        trackingState: 'verification_due',
      })
    })
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-conflict',
      nowMs: 2_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
      payToAgreementId,
      leaseToken: 'lease-conflict',
      providerState: 'active',
      observedAt: 3_000,
    })

    expect(
      await requester.query(api.moneyRequests.get, { moneyRequestId }),
    ).toMatchObject({
      agreements: [
        {
          lifecycle: { meaning: 'ended', confidence: 'confirmed' },
          tracking: { state: 'needsReview' },
          failure: { code: 'lifecycleContradiction' },
        },
      ],
    })
  })

  test('retains lifecycle truth through bounded GET outages and reviews the sixth failure', async () => {
    const { t, requester, moneyRequestId, payToAgreementId } =
      await setupAgreement()
    let nowMs = 2_000
    for (let failure = 1; failure <= 6; failure += 1) {
      const leaseToken = `lease-failure-${failure}`
      expect(
        await t.mutation(internal.payToAgreementReconciliation.claimWork, {
          payToAgreementId,
          leaseToken,
          nowMs,
        }),
      ).not.toBeNull()
      await t.mutation(internal.payToAgreementReconciliation.recordFailure, {
        payToAgreementId,
        leaseToken,
        category: 'network',
        observedAt: nowMs + 1,
      })
      const work = await t.run(async (ctx) =>
        ctx.db
          .query('payToAgreementReconciliationWorkItems')
          .withIndex('by_payToAgreementId', (q) =>
            q.eq('payToAgreementId', payToAgreementId),
          )
          .unique(),
      )
      if (!work) throw new Error('Expected reconciliation work')
      nowMs = work.availableAt
    }

    const projection = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    expect(projection).toMatchObject({
      agreements: [
        {
          lifecycle: { meaning: 'ready', confidence: 'provisional' },
          tracking: { state: 'needsReview' },
          failure: { code: 'lifecycleTrackingOutage' },
        },
      ],
    })
    const work = await t.run(async (ctx) =>
      ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .withIndex('by_payToAgreementId', (q) =>
          q.eq('payToAgreementId', payToAgreementId),
        )
        .unique(),
    )
    expect(work).toMatchObject({
      state: 'queued',
      consecutiveFailures: 6,
      availableAt: nowMs,
    })
  })

  test('records recovery evidence when a later GET repairs a tracking outage', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-outage',
      nowMs: 2_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.recordFailure, {
      payToAgreementId,
      leaseToken: 'lease-outage',
      category: 'network',
      observedAt: 3_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-recovery',
      nowMs: 33_000,
    })
    await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
      payToAgreementId,
      leaseToken: 'lease-recovery',
      providerState: 'active',
      observedAt: 34_000,
    })

    const evidence = await t.run(async (ctx) =>
      ctx.db.query('payToAgreementEvidence').collect(),
    )
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'reconciliation_recovered',
          previousFailureCount: 1,
        }),
      ]),
    )
  })

  test('makes duplicate workers no-ops and safely replaces an expired lease', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    expect(
      await t.mutation(internal.payToAgreementReconciliation.claimWork, {
        payToAgreementId,
        leaseToken: 'lease-original',
        nowMs: 2_000,
      }),
    ).not.toBeNull()
    expect(
      await t.mutation(internal.payToAgreementReconciliation.claimWork, {
        payToAgreementId,
        leaseToken: 'lease-duplicate',
        nowMs: 2_001,
      }),
    ).toBeNull()
    expect(
      await t.mutation(internal.payToAgreementReconciliation.claimWork, {
        payToAgreementId,
        leaseToken: 'lease-replacement',
        nowMs: 182_001,
      }),
    ).not.toBeNull()
    expect(
      await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
        payToAgreementId,
        leaseToken: 'lease-original',
        providerState: 'active',
        observedAt: 182_002,
      }),
    ).toBe(false)
    const evidence = await t.run(async (ctx) =>
      ctx.db.query('payToAgreementEvidence').collect(),
    )
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'reconciliation_lease_expired' }),
        expect.objectContaining({
          kind: 'reconciliation_lease_claimed',
          replacedExpiredLease: true,
        }),
      ]),
    )
  })

  test('redispatches expired running work so a crashed worker cannot strand polling', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'lease-crashed',
      nowMs: 2_000,
    })

    expect(
      await t.mutation(internal.payToAgreementReconciliation.dispatchDue, {
        nowMs: 182_001,
      }),
    ).toBe(1)
  })
})
