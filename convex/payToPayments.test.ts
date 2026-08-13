/// <reference types="vite/client" />

import workpoolTest from '@convex-dev/workpool/test'
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'

import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function setupAgreement() {
  const t = convexTest(schema, modules)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  const ids = await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payment_requester',
      clerkUserId: 'payment_requester',
      email: 'payment-requester@example.test',
      name: 'Payment Requester',
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payment_payer',
      clerkUserId: 'payment_payer',
      email: 'payment-payer@example.test',
      name: 'Payment Payer',
    })
    const creditorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: requesterUserId,
      type: 'bban',
      searchLabel: 'requester',
      maskedDisplay: '123456••••345',
      fingerprint: 'payment-requester-destination',
      ciphertext: 'requester-ciphertext',
      nonce: 'requester-nonce',
      keyVersion: 'v1',
    })
    const debtorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: payerUserId,
      type: 'bban',
      searchLabel: 'payer',
      maskedDisplay: '654321••••765',
      fingerprint: 'payment-payer-destination',
      ciphertext: 'payer-ciphertext',
      nonce: 'payer-nonce',
      keyVersion: 'v1',
    })
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: 'Payment Requester',
      amountCents: 12_500,
      currency: 'AUD',
      purpose: 'other',
      description: 'Immutable Payment intent',
      submissionKey: '018f22e2-7c00-7000-8000-000000000035',
      submissionFingerprint: 'payment-submission-fingerprint',
      sourceCreditorPaymentDestinationId: creditorDestinationId,
      creditorSnapshot: {
        kind: 'bban',
        maskedDisplay: '123456••••345',
        ciphertext: 'requester-ciphertext',
        nonce: 'requester-nonce',
        keyVersion: 'v1',
      },
      submittedAt: 1_000,
      payerCount: 1,
      paymentStatus: 'unpaid',
      paymentCounts: {
        not_started: 1,
        initiating: 0,
        processing: 0,
        under_investigation: 0,
        failed: 0,
        paid: 0,
      },
      paymentVerificationPendingPayerCount: 0,
      paymentAttentionRequiredPayerCount: 0,
    })
    const payToAgreementId = await ctx.db.insert('payToAgreements', {
      moneyRequestId,
      payerUserId,
      payerNameSnapshot: 'Payment Payer',
      sourceDebtorPaymentDestinationId: debtorDestinationId,
      debtorSnapshot: {
        kind: 'bban',
        maskedDisplay: '654321••••765',
        ciphertext: 'payer-ciphertext',
        nonce: 'payer-nonce',
        keyVersion: 'v1',
      },
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: 'agreement_payment_35',
      activationProvenancePolicy: 'track_first_confirmation',
      firstConfirmedActiveAt: 3_000,
      paymentStatus: 'not_started',
      paymentVerificationPending: false,
      paymentAttentionRequired: false,
      creationState: 'created',
      creationUpdatedAt: 2_000,
      lifecycleState: 'active',
      lifecycleConfidence: 'confirmed',
      lifecycleObservedAt: 3_000,
      trackingState: 'current',
      trackingUpdatedAt: 3_000,
    })
    return { moneyRequestId, payToAgreementId, payerUserId }
  })
  return { t, ...ids }
}

async function paymentState(
  t: Awaited<ReturnType<typeof setupAgreement>>['t'],
  payToAgreementId: Id<'payToAgreements'>,
) {
  return await t.run(async (ctx) => {
    const agreement = await ctx.db.get('payToAgreements', payToAgreementId)
    if (!agreement) throw new Error('Expected PayTo Agreement')
    return {
      agreement,
      moneyRequest: await ctx.db.get('moneyRequests', agreement.moneyRequestId),
      payments: await ctx.db
        .query('payToPayments')
        .withIndex('by_payToAgreementId', (q) =>
          q.eq('payToAgreementId', payToAgreementId),
        )
        .take(2),
    }
  })
}

describe('PayTo Payment immutable intent', () => {
  test('defaults the runtime gate to disabled without establishing an intent', async () => {
    const { t, payToAgreementId } = await setupAgreement()

    await expect(
      t.mutation(internal.payToPayments.ensure, {
        payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toEqual({ kind: 'ineligible', reason: 'gate_disabled' })

    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: { paymentStatus: 'not_started' },
      moneyRequest: {
        paymentCounts: { not_started: 1, initiating: 0 },
      },
      payments: [],
    })
  })

  test('establishes one immutable sandbox PayTo Payment intent when the gate admits its first confirmation', async () => {
    const { t, payToAgreementId, moneyRequestId, payerUserId } =
      await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })

    await expect(
      t.mutation(internal.payToPayments.ensure, {
        payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toMatchObject({ kind: 'created' })

    const durable = await paymentState(t, payToAgreementId)
    expect(durable.agreement).toMatchObject({
      paymentStatus: 'initiating',
      paymentVerificationPending: false,
      paymentAttentionRequired: false,
    })
    expect(durable.moneyRequest).toMatchObject({
      paymentStatus: 'unpaid',
      paymentCounts: { not_started: 0, initiating: 1 },
      paymentVerificationPendingPayerCount: 0,
      paymentAttentionRequiredPayerCount: 0,
    })
    expect(durable.payments).toHaveLength(1)
    expect(durable.payments[0]).toMatchObject({
      payToAgreementId,
      moneyRequestId,
      payerUserId,
      environment: 'sandbox',
      providerUid: expect.any(String),
      creationState: 'create_pending',
      intent: {
        agreementProviderUid: 'agreement_payment_35',
        amount: { cents: 12_500, currency: 'AUD' },
        priority: 'unattended',
        apiVersion: '20260101',
        fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
      establishedAt: 3_000,
    })
    const payToPayment = durable.payments[0]
    const authorization = await t.mutation(
      internal.payToPayments.authorizeOperation,
      {
        payToPaymentId: payToPayment._id,
        operationKind: 'create',
        observedAt: 3_001,
      },
    )
    expect(authorization).toMatchObject({
      kind: 'authorized',
      operationKind: 'create',
      operationId: expect.any(String),
      payToPaymentId: payToPayment._id,
      providerUid: payToPayment.providerUid,
      intent: { fingerprint: payToPayment.intent.fingerprint },
    })
    if (authorization.kind !== 'authorized') {
      throw new Error('Expected authorized PayTo Payment operation')
    }
    await expect(
      t.mutation(internal.payToPayments.recordOutcome, {
        payToPaymentId: payToPayment._id,
        operationId: authorization.operationId,
        classification: 'completed',
        observedAt: 3_002,
      }),
    ).resolves.toEqual({ kind: 'accepted' })
    await expect(
      t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: payToPayment._id,
        evidence: {
          source: 'create_response',
          intentFingerprint: payToPayment.intent.fingerprint,
        },
        observedAt: 3_003,
      }),
    ).resolves.toEqual({ kind: 'accepted' })
    await expect(
      t.run(async (ctx) => ({
        operation: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', authorization.operationId),
          )
          .unique(),
        evidence: await ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', payToPayment._id),
          )
          .take(2),
      })),
    ).resolves.toMatchObject({
      operation: {
        operationId: authorization.operationId,
        outcome: { classification: 'completed', observedAt: 3_002 },
      },
      evidence: [{ source: 'create_response', observedAt: 3_003 }],
    })
  })

  test.each([
    ['reconcile_only', 2_500, 'gate_reconcile_only'],
    ['enabled_for_new_confirmations', 3_001, 'agreement_not_eligible'],
  ] as const)(
    'does not establish an intent in %s mode with activation at %s',
    async (mode, activatedAt, reason) => {
      const { t, payToAgreementId } = await setupAgreement()
      await t.run(async (ctx) => {
        await ctx.db.insert('payToPaymentRuntimeGates', {
          environment: 'sandbox',
          mode,
          activatedAt,
        })
      })

      await expect(
        t.mutation(internal.payToPayments.ensure, {
          payToAgreementId,
          observedAt: 4_000,
        }),
      ).resolves.toEqual({ kind: 'ineligible', reason })
      await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
        agreement: { paymentStatus: 'not_started' },
        payments: [],
      })
    },
  )

  test('keeps legacy and production PayTo Agreements ineligible in this rollout slice', async () => {
    const legacy = await setupAgreement()
    await legacy.t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', legacy.payToAgreementId, {
        activationProvenancePolicy: 'legacy_excluded',
      })
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })
    await expect(
      legacy.t.mutation(internal.payToPayments.ensure, {
        payToAgreementId: legacy.payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toEqual({
      kind: 'ineligible',
      reason: 'agreement_not_eligible',
    })

    const production = await setupAgreement()
    await production.t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', production.payToAgreementId, {
        environment: 'production',
      })
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'production',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })
    await expect(
      production.t.mutation(internal.payToPayments.ensure, {
        payToAgreementId: production.payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toEqual({
      kind: 'ineligible',
      reason: 'production_not_enabled',
    })
  })

  test('all PayTo Payment boundaries refuse caller-supplied lifecycle, projection, attention, and UID fields', async () => {
    const { t, payToAgreementId } = await setupAgreement()

    await expect(
      t.mutation(internal.payToPayments.ensure, {
        payToAgreementId,
        observedAt: 3_000,
        providerUid: 'replacement-uid',
      } as never),
    ).rejects.toThrow()
    await expect(
      t.mutation(internal.payToPayments.authorizeOperation, {
        payToPaymentId: 'replacement-uid',
        operationKind: 'create',
        observedAt: 3_000,
        creationState: 'provider_established',
      } as never),
    ).rejects.toThrow()
    await expect(
      t.mutation(internal.payToPayments.recordOutcome, {
        payToPaymentId: 'replacement-uid',
        operationId: 'operation',
        classification: 'completed',
        observedAt: 3_000,
        paymentStatus: 'paid',
      } as never),
    ).rejects.toThrow()
    await expect(
      t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: 'replacement-uid',
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: 'fingerprint',
        },
        observedAt: 3_000,
        paymentAttentionRequired: false,
      } as never),
    ).rejects.toThrow()
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: { paymentStatus: 'not_started' },
      payments: [],
    })
  })

  test('replayed and concurrent confirmation converges on the original PayTo Payment identity', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })

    const outcomes = await Promise.all([
      t.mutation(internal.payToPayments.ensure, {
        payToAgreementId,
        observedAt: 3_000,
      }),
      t.mutation(internal.payToPayments.ensure, {
        payToAgreementId,
        observedAt: 3_001,
      }),
    ])
    const replay = await t.mutation(internal.payToPayments.ensure, {
      payToAgreementId,
      observedAt: 4_000,
    })

    const ids = [...outcomes, replay]
      .filter((outcome) => outcome.kind !== 'ineligible')
      .map((outcome) => outcome.payToPaymentId)
    expect(new Set(ids)).toHaveLength(1)
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      'created',
      'matched',
    ])
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      payments: [{ providerUid: expect.any(String) }],
    })
  })

  test('preserves the original intent and records attention when its fingerprint no longer matches', async () => {
    const { t, payToAgreementId, moneyRequestId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })
    await t.mutation(internal.payToPayments.ensure, {
      payToAgreementId,
      observedAt: 3_000,
    })
    const before = await paymentState(t, payToAgreementId)
    await t.run(async (ctx) => {
      await ctx.db.patch('moneyRequests', moneyRequestId, {
        amountCents: 99_999,
      })
    })

    await expect(
      t.mutation(internal.payToPayments.ensure, {
        payToAgreementId,
        observedAt: 4_000,
      }),
    ).resolves.toMatchObject({ kind: 'mismatch' })

    const after = await paymentState(t, payToAgreementId)
    expect(after.payments[0]).toMatchObject({
      providerUid: before.payments[0]?.providerUid,
      creationState: 'creation_attention_required',
      intent: {
        amount: { cents: 12_500, currency: 'AUD' },
        fingerprint: before.payments[0]?.intent.fingerprint,
      },
      attention: {
        kind: 'intent_fingerprint_mismatch',
        expectedFingerprint: before.payments[0]?.intent.fingerprint,
        observedFingerprint: expect.not.stringMatching(
          before.payments[0]?.intent.fingerprint ?? '',
        ),
        observedAt: 4_000,
      },
    })
    expect(after.agreement).toMatchObject({
      paymentStatus: 'initiating',
      paymentAttentionRequired: true,
    })
    expect(after.moneyRequest).toMatchObject({
      paymentCounts: { initiating: 1 },
      paymentAttentionRequiredPayerCount: 1,
    })
  })

  test('mismatched normalized evidence fails closed before another operation', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })
    await t.mutation(internal.payToPayments.ensure, {
      payToAgreementId,
      observedAt: 3_000,
    })
    const durable = await paymentState(t, payToAgreementId)
    const payToPayment = durable.payments[0]

    await expect(
      t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: payToPayment._id,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: 'different-fingerprint',
        },
        observedAt: 4_000,
      }),
    ).resolves.toEqual({ kind: 'mismatch' })
    await expect(
      t.mutation(internal.payToPayments.authorizeOperation, {
        payToPaymentId: payToPayment._id,
        operationKind: 'create',
        observedAt: 4_001,
      }),
    ).resolves.toEqual({
      kind: 'denied',
      reason: 'attention_required',
    })
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: { paymentAttentionRequired: true },
      payments: [
        {
          providerUid: payToPayment.providerUid,
          intent: { fingerprint: payToPayment.intent.fingerprint },
          creationState: 'creation_attention_required',
        },
      ],
    })
  })

  test('PayTo Agreement reconciliation establishes the intent in the first-confirmation transaction', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        firstConfirmedActiveAt: undefined,
        lifecycleState: 'pending',
        lifecycleObservedAt: 2_000,
      })
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
      await ctx.db.insert('payToAgreementReconciliationWorkItems', {
        payToAgreementId,
        providerUid: 'agreement_payment_35',
        state: 'queued',
        availableAt: 2_000,
      })
    })
    await t.mutation(internal.payToAgreementReconciliation.claimWork, {
      payToAgreementId,
      leaseToken: 'payment-establishment-lease',
      nowMs: 2_000,
    })

    await expect(
      t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
        payToAgreementId,
        leaseToken: 'payment-establishment-lease',
        providerState: 'active',
        observedAt: 3_000,
      }),
    ).resolves.toBe(true)
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        firstConfirmedActiveAt: 3_000,
        paymentStatus: 'initiating',
      },
      payments: [
        {
          payToAgreementId,
          establishedAt: 3_000,
          creationState: 'create_pending',
        },
      ],
    })
  })

  test('PayTo Agreement creation recovery establishes the intent when its GET first confirms active', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        creationState: 'verifying',
        firstConfirmedActiveAt: undefined,
        lifecycleState: 'pending',
        lifecycleObservedAt: 2_000,
      })
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
      await ctx.db.insert('payToAgreementWorkItems', {
        payToAgreementId,
        kind: 'create',
        state: 'running',
        availableAt: 2_000,
        leaseToken: 'creation-recovery-lease',
        leaseExpiresAt: 4_000,
        postCycle: 1,
      })
    })

    await expect(
      t.mutation(internal.payToAgreementCreation.recordCreated, {
        payToAgreementId,
        leaseToken: 'creation-recovery-lease',
        source: 'per_uid_get',
        result: {
          providerState: 'active',
          providerCreatedAt: 2_500,
          providerMmsAgreementId: null,
        },
        observedAt: 3_000,
      }),
    ).resolves.toBe(true)
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        firstConfirmedActiveAt: 3_000,
        paymentStatus: 'initiating',
      },
      payments: [
        {
          payToAgreementId,
          establishedAt: 3_000,
          creationState: 'create_pending',
        },
      ],
    })
  })
})
