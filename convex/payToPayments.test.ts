/// <reference types="vite/client" />

import workpoolTest from '@convex-dev/workpool/test'
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

async function setupAgreement() {
  const t = convexTest(schema, modules)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  workpoolTest.register(t, 'paymentCreationWorkpool')
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

async function establishPayment() {
  const setup = await setupAgreement()
  await setup.t.run(async (ctx) => {
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'sandbox',
      mode: 'enabled_for_new_confirmations',
      activatedAt: 2_500,
    })
  })
  const result = await setup.t.mutation(internal.payToPayments.ensure, {
    payToAgreementId: setup.payToAgreementId,
    observedAt: 3_000,
  })
  if (result.kind !== 'created') throw new Error('Expected Payment intent')
  return { ...setup, payToPaymentId: result.payToPaymentId }
}

function createdPaymentResponseBody(
  input: { uid: string; agreement_uid: string },
  override: Record<string, unknown> = {},
) {
  return {
    uid: input.uid,
    agreement_uid: input.agreement_uid,
    source_payto_refund_uid: null,
    state: 'pending',
    reference: null,
    description: null,
    priority: 'unattended',
    creditor: {
      party_name: 'Payment Requester',
      ultimate_party_name: 'Payment Requester',
      account_identifier: { type: 'bban', value: '123456-0012345' },
    },
    creditor_reference: null,
    debtor: {
      party_name: 'Payment Payer',
      ultimate_party_name: 'Payment Payer',
      account_identifier: { type: 'bban', value: '654321-0098765' },
    },
    amount: 12_500,
    last_payment: null,
    failure: null,
    created_at: '2026-08-13T10:00:00+10:00',
    links: {
      self: `https://api.sandbox.zeptopayments.com/payto/payments/${input.uid}`,
      agreement: `https://api.sandbox.zeptopayments.com/payto/agreements/${input.agreement_uid}`,
      source_refund: null,
    },
    ...override,
  }
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
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: payToPayment._id,
        leaseToken: 'intent-boundary-worker',
        nowMs: 3_001,
      },
    )
    expect(authorization).toMatchObject({
      kind: 'create',
      operationId: expect.any(String),
      payToPaymentId: payToPayment._id,
      providerUid: payToPayment.providerUid,
      intentFingerprint: payToPayment.intent.fingerprint,
    })
    if (!authorization) {
      throw new Error('Expected authorized PayTo Payment operation')
    }
    await expect(
      t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId: payToPayment._id,
        operationId: authorization.operationId,
        leaseToken: 'intent-boundary-worker',
        observedAt: 3_002,
      }),
    ).resolves.toBe(true)
    await expect(
      t.mutation(internal.payToPayments.recordOutcome, {
        payToPaymentId: payToPayment._id,
        operationId: authorization.operationId,
        leaseToken: 'intent-boundary-worker',
        classification: 'completed',
        observedAt: 3_003,
      }),
    ).resolves.toEqual({ kind: 'accepted' })
    await expect(
      t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: payToPayment._id,
        evidence: {
          source: 'create_response',
          intentFingerprint: payToPayment.intent.fingerprint,
        },
        observedAt: 3_004,
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
        outcome: { classification: 'completed', observedAt: 3_003 },
      },
      evidence: [{ source: 'create_response', observedAt: 3_004 }],
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

describe('PayTo Payment create operation', () => {
  beforeEach(() => {
    process.env.ZEPTO_ENVIRONMENT = 'sandbox'
    process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-test-token'
    vi.restoreAllMocks()
  })

  test('allocates typed create work and immutable fingerprints before dispatch', async () => {
    const { t, payToPaymentId } = await establishPayment()

    const claimed = await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'worker-36',
      nowMs: 4_000,
    })

    expect(claimed).toMatchObject({
      kind: 'create',
      operationId: expect.any(String),
      payToPaymentId,
      providerUid: expect.any(String),
      agreementProviderUid: 'agreement_payment_35',
      amountCents: 12_500,
      priority: 'unattended',
      intentFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      requestFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      leaseToken: 'worker-36',
      leaseExpiresAt: 184_000,
    })
    await expect(
      t.run(async (ctx) => ({
        payment: await ctx.db.get('payToPayments', payToPaymentId),
        work: await ctx.db
          .query('payToPaymentWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
        operations: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(2),
        gate: await ctx.db
          .query('payToPaymentRuntimeGates')
          .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
          .unique(),
      })),
    ).resolves.toMatchObject({
      payment: { creationState: 'creation_uncertain' },
      work: {
        state: 'running',
        leaseToken: 'worker-36',
        leaseExpiresAt: 184_000,
      },
      operations: [
        {
          operationKind: 'create',
          intentFingerprint: expect.any(String),
          requestFingerprint: expect.any(String),
        },
      ],
      gate: {
        budgetDate: '1970-01-01',
        reservedPaymentCount: 1,
        reservedPaymentValueCents: 12_500,
      },
    })
    const [operation] = await t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentOperations')
        .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
          q.eq('payToPaymentId', payToPaymentId),
        )
        .take(1),
    )
    expect(operation).not.toHaveProperty('dispatchStartedAt')
  })

  test('keeps a pre-dispatch crash auditable without implying a POST', async () => {
    const { t, payToPaymentId } = await establishPayment()
    await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'crashed-worker',
      nowMs: 4_000,
    })

    const durable = await t.run(async (ctx) => {
      const [operation] = await ctx.db
        .query('payToPaymentOperations')
        .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
          q.eq('payToPaymentId', payToPaymentId),
        )
        .take(1)
      return operation
    })
    expect(durable).toMatchObject({ authorizedAt: 4_000 })
    expect(durable).not.toHaveProperty('dispatchStartedAt')
    expect(durable).not.toHaveProperty('outcome')
  })

  test('refuses create authorization when leased capacity cannot be reserved', async () => {
    const { t, payToPaymentId } = await establishPayment()
    await t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected gate')
      await ctx.db.patch(gate._id, {
        dailyPaymentCountCap: 0,
        dailyPaymentValueCapCents: 0,
      })
    })

    await expect(
      t.mutation(internal.payToPayments.claimCreateWork, {
        payToPaymentId,
        leaseToken: 'capacity-worker',
        nowMs: 4_000,
      }),
    ).resolves.toBeNull()
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(1),
      ),
    ).resolves.toEqual([])
  })

  test('refuses stale workers and a last-moment reconcile-only gate before dispatch', async () => {
    const { t, payToPaymentId } = await establishPayment()
    const claimed = await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'worker-36',
      nowMs: 4_000,
    })
    if (!claimed) throw new Error('Expected claimed create work')

    await expect(
      t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'worker-36',
        observedAt: 184_001,
      }),
    ).resolves.toBe(false)

    await t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected gate')
      await ctx.db.patch(gate._id, { mode: 'reconcile_only' })
    })
    await expect(
      t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'worker-36',
        observedAt: 4_001,
      }),
    ).resolves.toBe(false)
    await expect(
      t.mutation(internal.payToPayments.recordOutcome, {
        payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'worker-36',
        classification: 'completed',
        observedAt: 4_002,
      }),
    ).resolves.toEqual({ kind: 'not_found' })
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', claimed.operationId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ outcome: { classification: 'refused' } })
  })

  test('allows a stale worker to append evidence without applying its result', async () => {
    const { t, payToPaymentId } = await establishPayment()
    const claimed = await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'stale-worker',
      nowMs: 4_000,
    })
    if (!claimed) throw new Error('Expected claimed create work')
    await t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId,
      operationId: claimed.operationId,
      leaseToken: 'stale-worker',
      observedAt: 4_001,
    })

    await expect(
      t.mutation(internal.payToPayments.recordCreateResult, {
        payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'wrong-worker',
        providerState: 'pending',
        providerCreatedAt: 4_002,
        observedAt: 4_002,
      }),
    ).resolves.toBe(false)
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(1),
      ),
    ).resolves.toEqual([])

    await expect(
      t.mutation(internal.payToPayments.recordCreateResult, {
        payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'stale-worker',
        providerState: 'pending',
        providerCreatedAt: 4_002,
        observedAt: 184_001,
      }),
    ).resolves.toBe(false)
    await expect(
      t.run(async (ctx) => ({
        payment: await ctx.db.get('payToPayments', payToPaymentId),
        evidence: await ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(2),
      })),
    ).resolves.toMatchObject({
      payment: { creationState: 'creation_uncertain' },
      evidence: [
        {
          operationId: claimed.operationId,
          classification: 'completed',
          providerState: 'pending',
        },
      ],
    })
  })

  test('projects processing with verification pending after one validated 201', async () => {
    const requests: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const copy = new Request(request)
      requests.push(copy.clone())
      const body = (await copy.json()) as {
        uid: string
        agreement_uid: string
      }
      return new Response(
        JSON.stringify({
          data: createdPaymentResponseBody(body),
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const { t, payToAgreementId, payToPaymentId } = await establishPayment()
    const payment = await t.run((ctx) =>
      ctx.db.get('payToPayments', payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')

    await t.finishAllScheduledFunctions(() => {})

    const bodies = (await Promise.all(
      requests.map((request) => request.json()),
    )) as Array<{ uid: string }>
    const matchingBodies = bodies.filter(
      ({ uid }) => uid === payment.providerUid,
    )
    expect(matchingBodies).toHaveLength(1)
    expect(matchingBodies[0]).toMatchObject({
      agreement_uid: 'agreement_payment_35',
      amount: 12_500,
      priority: 'unattended',
    })
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'processing',
        paymentVerificationPending: true,
        paymentAttentionRequired: false,
      },
      moneyRequest: {
        paymentStatus: 'unpaid',
        paymentCounts: { processing: 1, paid: 0 },
        paymentVerificationPendingPayerCount: 1,
      },
      payments: [{ creationState: 'provider_established' }],
    })
  })

  test('does not hide another POST when Zepto returns 500', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('failure', { status: 500 }))
    const { t, payToPaymentId } = await establishPayment()

    await t.finishAllScheduledFunctions(() => {})

    expect(fetch).toHaveBeenCalledOnce()
    await expect(
      t.run(async (ctx) => {
        const [operation] = await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(1)
        return operation
      }),
    ).resolves.toMatchObject({
      dispatchStartedAt: expect.any(Number),
      outcome: { classification: 'uncertain' },
    })
  })

  test.each([
    ['a mismatched UID', { uid: 'another-payment' }],
    ['a malformed success body', { created_at: 'not-a-date' }],
  ] as const)(
    'holds creation uncertainty after %s',
    async (_case, override) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (request) => {
          const body = (await new Request(request).json()) as {
            uid: string
            agreement_uid: string
          }
          return new Response(
            JSON.stringify({
              data: createdPaymentResponseBody(body, override),
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } },
          )
        })
      const { t, payToPaymentId } = await establishPayment()

      await t.finishAllScheduledFunctions(() => {})

      expect(fetch).toHaveBeenCalledOnce()
      await expect(
        t.run(async (ctx) => ({
          payment: await ctx.db.get('payToPayments', payToPaymentId),
          operations: await ctx.db
            .query('payToPaymentOperations')
            .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
              q.eq('payToPaymentId', payToPaymentId),
            )
            .take(2),
        })),
      ).resolves.toMatchObject({
        payment: { creationState: 'creation_uncertain' },
        operations: [{ outcome: { classification: 'uncertain' } }],
      })
    },
  )
})
