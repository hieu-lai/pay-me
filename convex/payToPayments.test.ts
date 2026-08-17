/// <reference types="vite/client" />

import workpoolTest from '@convex-dev/workpool/test'
import rateLimiterTest from '@convex-dev/rate-limiter/test'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { internal } from './_generated/api'
import type { Id } from './_generated/dataModel'
import { consumePaymentRetryEndpointCall } from './lib/paymentRetryRateLimiter'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const productionEnvironmentKeys = [
  'PAYME_RELEASE_COMMIT',
  'PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT',
  'PAYTO_PAYMENT_CERTIFICATION_FINGERPRINT',
  'ZEPTO_PERSONAL_ACCESS_TOKEN',
] as const
const originalProductionEnvironment = Object.fromEntries(
  productionEnvironmentKeys.map((key) => [key, process.env[key]]),
)

afterEach(() => {
  for (const key of productionEnvironmentKeys) {
    const original = originalProductionEnvironment[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  process.env.ZEPTO_ENVIRONMENT = 'sandbox'
})

function configureProductionRuntime() {
  process.env.PAYME_RELEASE_COMMIT = 'a'.repeat(40)
  process.env.PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT = 'configuration-v1'
  process.env.PAYTO_PAYMENT_CERTIFICATION_FINGERPRINT = 'certification-v1'
  process.env.ZEPTO_ENVIRONMENT = 'production'
  process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'production-payment-token'
}

async function activateProduction(
  setup: Awaited<ReturnType<typeof setupAgreement>>,
  overrides: {
    dailyPaymentCountCap?: number
    dailyPaymentValueCapCents?: number
    nowMs?: number
    payerUserIds?: Id<'users'>[]
  } = {},
) {
  configureProductionRuntime()
  await setup.t.run(async (ctx) => {
    await ctx.db.patch('payToAgreements', setup.payToAgreementId, {
      environment: 'production',
    })
  })
  return await setup.t.mutation(
    internal.payToPayments.recordProductionActivation,
    {
      nowMs: overrides.nowMs ?? 2_500,
      allowlistedPayerUserIds: overrides.payerUserIds ?? [setup.payerUserId],
      capacityLimits: {
        dailyPaymentCount: overrides.dailyPaymentCountCap ?? 1,
        dailyPaymentValueCents: overrides.dailyPaymentValueCapCents ?? 12_500,
      },
      certificationReference: 'certification://payment-release-1',
      approvalReferences: {
        engineering: 'approval://engineering/1',
        operations: 'approval://operations/1',
        security: 'approval://security/1',
        legalCompliance: 'approval://legal/1',
        zepto: 'approval://zepto/1',
      },
    },
  )
}

async function setupAgreement() {
  const t = convexTest(schema, modules)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  workpoolTest.register(t, 'paymentCreationWorkpool')
  workpoolTest.register(t, 'paymentRetryWorkpool')
  rateLimiterTest.register(t, 'paymentRetryRateLimiter')
  const ids = await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payment_requester',
      clerkUserId: 'payment_requester',
      email: 'payment-requester@example.test',
      displayName: 'Payment Requester',
      searchText: 'Payment Requester',
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payment_payer',
      clerkUserId: 'payment_payer',
      email: 'payment-payer@example.test',
      displayName: 'Payment Payer',
      searchText: 'Payment Payer',
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

async function addSecondAgreement(
  setup: Awaited<ReturnType<typeof setupAgreement>>,
) {
  return await setup.t.run(async (ctx) => {
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payment_payer_two',
      clerkUserId: 'payment_payer_two',
      email: 'payment-payer-two@example.test',
      displayName: 'Payment Payer Two',
      searchText: 'Payment Payer Two',
    })
    const debtorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: payerUserId,
      type: 'bban',
      searchLabel: 'payer two',
      maskedDisplay: '111222••••444',
      fingerprint: 'payment-payer-two-destination',
      ciphertext: 'payer-two-ciphertext',
      nonce: 'payer-two-nonce',
      keyVersion: 'v1',
    })
    await ctx.db.patch('moneyRequests', setup.moneyRequestId, {
      payerCount: 2,
      paymentCounts: {
        not_started: 2,
        initiating: 0,
        processing: 0,
        under_investigation: 0,
        failed: 0,
        paid: 0,
      },
    })
    return await ctx.db.insert('payToAgreements', {
      moneyRequestId: setup.moneyRequestId,
      payerUserId,
      payerNameSnapshot: 'Payment Payer Two',
      sourceDebtorPaymentDestinationId: debtorDestinationId,
      debtorSnapshot: {
        kind: 'bban',
        maskedDisplay: '111222••••444',
        ciphertext: 'payer-two-ciphertext',
        nonce: 'payer-two-nonce',
        keyVersion: 'v1',
      },
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: 'agreement_payment_37_two',
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
  })
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

async function establishProviderPayment() {
  const setup = await establishPayment()
  const claimed = await setup.t.mutation(
    internal.payToPayments.claimCreateWork,
    {
      payToPaymentId: setup.payToPaymentId,
      leaseToken: 'provider-establishment-worker',
      nowMs: 4_000,
    },
  )
  if (!claimed) throw new Error('Expected claimed create work')
  await setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
    payToPaymentId: setup.payToPaymentId,
    operationId: claimed.operationId,
    leaseToken: 'provider-establishment-worker',
    observedAt: 4_001,
  })
  await setup.t.mutation(internal.payToPayments.recordCreateResult, {
    payToPaymentId: setup.payToPaymentId,
    operationId: claimed.operationId,
    leaseToken: 'provider-establishment-worker',
    providerState: 'pending',
    providerCreatedAt: 3_500,
    observedAt: 4_002,
  })
  return setup
}

async function insertUnscheduledPaymentCopy(
  setup: Awaited<ReturnType<typeof establishProviderPayment>>,
) {
  return await setup.t.run(async (ctx) => {
    const payment = await ctx.db.get('payToPayments', setup.payToPaymentId)
    if (!payment) throw new Error('Expected PayTo Payment')
    await ctx.db.patch('payToPayments', payment._id, {
      agedUnresolvedMonitoringCompletedAt:
        payment.establishedAt + 24 * 60 * 60_000,
    })
    const { _id, _creationTime, ...values } = payment
    void _id
    void _creationTime
    return await ctx.db.insert('payToPayments', {
      ...values,
      providerUid: `${payment.providerUid}-unscheduled`,
      agedUnresolvedMonitoringCompletedAt: undefined,
    })
  })
}

async function prepareFirstRetry(
  setup: Awaited<ReturnType<typeof establishProviderPayment>>,
  leaseToken: string,
) {
  const payment = await setup.t.run((ctx) =>
    ctx.db.get('payToPayments', setup.payToPaymentId),
  )
  if (!payment) throw new Error('Expected PayTo Payment')
  const firstGet = await setup.t.mutation(
    internal.payToPaymentReconciliation.claimWork,
    {
      payToPaymentId: setup.payToPaymentId,
      leaseToken: `${leaseToken}-first-get`,
      nowMs: 4_002,
    },
  )
  if (!firstGet) throw new Error('Expected first failed GET')
  await setup.t.mutation(internal.payToPayments.applyEvidence, {
    payToPaymentId: setup.payToPaymentId,
    evidence: {
      source: 'per_uid_get',
      intentFingerprint: payment.intent.fingerprint,
      providerState: 'failed',
      providerFailureCode: 'AB01',
      providerFailureRetryable: true,
      operationId: firstGet.operationId,
      leaseToken: `${leaseToken}-first-get`,
    },
    observedAt: 5_000,
  })
  const dueAt = 5_000 + 15 * 60_000
  await setup.t.mutation(internal.payToPaymentRetry.claimWork, {
    payToPaymentId: setup.payToPaymentId,
    leaseToken: `${leaseToken}-refresh`,
    nowMs: dueAt,
  })
  const freshGet = await setup.t.mutation(
    internal.payToPaymentReconciliation.claimWork,
    {
      payToPaymentId: setup.payToPaymentId,
      leaseToken: `${leaseToken}-fresh-get`,
      nowMs: dueAt,
    },
  )
  if (!freshGet) throw new Error('Expected fresh failed GET')
  await setup.t.mutation(internal.payToPayments.applyEvidence, {
    payToPaymentId: setup.payToPaymentId,
    evidence: {
      source: 'per_uid_get',
      intentFingerprint: payment.intent.fingerprint,
      providerState: 'failed',
      providerFailureCode: 'AB01',
      providerFailureRetryable: true,
      operationId: freshGet.operationId,
      leaseToken: `${leaseToken}-fresh-get`,
    },
    observedAt: dueAt + 1,
  })
  return { payment, dueAt }
}

async function claimFirstRetry(
  setup: Awaited<ReturnType<typeof establishProviderPayment>>,
  leaseToken: string,
) {
  const { payment, dueAt } = await prepareFirstRetry(setup, leaseToken)
  const retry = await setup.t.mutation(internal.payToPaymentRetry.claimWork, {
    payToPaymentId: setup.payToPaymentId,
    leaseToken,
    nowMs: dueAt + 1,
  })
  if (!retry) throw new Error('Expected retry claim')
  return { payment, retry, dueAt }
}

async function establishExistingProviderPayment(
  t: Awaited<ReturnType<typeof setupAgreement>>['t'],
  payToPaymentId: Id<'payToPayments'>,
  leaseToken: string,
) {
  const claimed = await t.mutation(internal.payToPayments.claimCreateWork, {
    payToPaymentId,
    leaseToken,
    nowMs: 4_000,
  })
  if (!claimed) throw new Error('Expected claimed create work')
  await t.mutation(internal.payToPayments.markCreateDispatchStarted, {
    payToPaymentId,
    operationId: claimed.operationId,
    leaseToken,
    observedAt: 4_001,
  })
  await t.mutation(internal.payToPayments.recordCreateResult, {
    payToPaymentId,
    operationId: claimed.operationId,
    leaseToken,
    providerState: 'pending',
    providerCreatedAt: 3_500,
    observedAt: 4_002,
  })
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

  test('records a fully pinned production activation and admits only its allowlisted post-cutoff confirmation', async () => {
    const setup = await setupAgreement()
    const recorded = await activateProduction(setup)

    await expect(
      setup.t.run(async (ctx) => ({
        activation: await ctx.db.get(
          'payToPaymentActivations',
          recorded.activationId,
        ),
        gate: await ctx.db
          .query('payToPaymentRuntimeGates')
          .withIndex('by_environment', (q) => q.eq('environment', 'production'))
          .unique(),
        allowlist: await ctx.db
          .query('payToPaymentActivationAllowlist')
          .withIndex('by_activationId_and_payerUserId', (q) =>
            q.eq('activationId', recorded.activationId),
          )
          .take(2),
      })),
    ).resolves.toMatchObject({
      activation: {
        environment: 'production',
        activatedAt: 2_500,
        certifiedCommit: 'a'.repeat(40),
        apiVersion: '20260101',
        credentialFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        configurationFingerprint: 'configuration-v1',
        certificationFingerprint: 'certification-v1',
        certificationReference: 'certification://payment-release-1',
        cohort: {
          kind: 'payer_allowlist',
        },
        capacityLimits: {
          dailyPaymentCount: 1,
          dailyPaymentValueCents: 12_500,
        },
        approvalReferences: {
          engineering: 'approval://engineering/1',
          operations: 'approval://operations/1',
          security: 'approval://security/1',
          legalCompliance: 'approval://legal/1',
          zepto: 'approval://zepto/1',
        },
        activationFingerprint: recorded.activationFingerprint,
      },
      gate: {
        mode: 'enabled_for_new_confirmations',
        activeActivationId: recorded.activationId,
      },
      allowlist: [{ payerUserId: setup.payerUserId }],
    })

    await expect(
      setup.t.mutation(internal.payToPayments.ensure, {
        payToAgreementId: setup.payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toMatchObject({ kind: 'created' })
    await expect(
      paymentState(setup.t, setup.payToAgreementId),
    ).resolves.toMatchObject({
      payments: [
        {
          productionActivationId: recorded.activationId,
          productionCapacityReservation: {
            budgetDate: '1970-01-01',
            paymentCount: 1,
            paymentValueCents: 12_500,
          },
        },
      ],
    })
  })

  test('permanently refuses production confirmations outside the activation cutoff or allowlist', async () => {
    const beforeCutoff = await setupAgreement()
    await beforeCutoff.t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', beforeCutoff.payToAgreementId, {
        firstConfirmedActiveAt: 2_499,
      })
    })
    await activateProduction(beforeCutoff)

    await expect(
      beforeCutoff.t.mutation(internal.payToPayments.ensure, {
        payToAgreementId: beforeCutoff.payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toEqual({
      kind: 'ineligible',
      reason: 'agreement_not_eligible',
    })

    const outsideAllowlist = await setupAgreement()
    await activateProduction(outsideAllowlist, { payerUserIds: [] })
    await expect(
      outsideAllowlist.t.mutation(internal.payToPayments.ensure, {
        payToAgreementId: outsideAllowlist.payToAgreementId,
        observedAt: 3_000,
      }),
    ).resolves.toEqual({
      kind: 'ineligible',
      reason: 'production_not_enabled',
    })
  })

  test.each([
    [
      'commit',
      (): void => {
        process.env.PAYME_RELEASE_COMMIT = 'b'.repeat(40)
      },
    ],
    [
      'credential',
      (): void => {
        process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'rotated-token'
      },
    ],
    [
      'configuration',
      (): void => {
        process.env.PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT = 'configuration-v2'
      },
    ],
    [
      'certification',
      (): void => {
        process.env.PAYTO_PAYMENT_CERTIFICATION_FINGERPRINT = 'certification-v2'
      },
    ],
  ] as const)(
    'fails closed before production establishment on %s mismatch',
    async (_kind, mismatch) => {
      const setup = await setupAgreement()
      await activateProduction(setup)
      mismatch()

      await expect(
        setup.t.mutation(internal.payToPayments.ensure, {
          payToAgreementId: setup.payToAgreementId,
          observedAt: 3_000,
        }),
      ).resolves.toEqual({
        kind: 'ineligible',
        reason: 'production_not_enabled',
      })
      await expect(
        paymentState(setup.t, setup.payToAgreementId),
      ).resolves.toMatchObject({ payments: [] })
    },
  )

  test('reserves production count and value exposure transactionally under concurrent establishment', async () => {
    const setup = await setupAgreement()
    const secondAgreementId = await addSecondAgreement(setup)
    const secondPayerUserId = await setup.t.run(async (ctx) => {
      const secondAgreement = await ctx.db.get(
        'payToAgreements',
        secondAgreementId,
      )
      if (!secondAgreement) throw new Error('Expected second Agreement')
      await ctx.db.patch('payToAgreements', secondAgreementId, {
        environment: 'production',
      })
      return secondAgreement.payerUserId
    })
    await activateProduction(setup, {
      payerUserIds: [setup.payerUserId, secondPayerUserId],
      dailyPaymentCountCap: 1,
      dailyPaymentValueCapCents: 12_500,
    })

    const results = await Promise.all(
      [setup.payToAgreementId, secondAgreementId].map((payToAgreementId) =>
        setup.t.mutation(internal.payToPayments.ensure, {
          payToAgreementId,
          observedAt: 3_000,
        }),
      ),
    )

    expect(results.filter((result) => result.kind === 'created')).toHaveLength(
      1,
    )
    expect(results.filter((result) => result.kind === 'ineligible')).toEqual([
      { kind: 'ineligible', reason: 'production_not_enabled' },
    ])
    await expect(
      setup.t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentActivationBudgets')
          .withIndex('by_environment_and_budgetDate', (q) =>
            q.eq('environment', 'production').eq('budgetDate', '1970-01-01'),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({
      reservedPaymentCount: 1,
      reservedPaymentValueCents: 12_500,
    })
  })

  test('enforces the production total-value cap independently under concurrent establishment', async () => {
    const setup = await setupAgreement()
    const secondAgreementId = await addSecondAgreement(setup)
    const secondPayerUserId = await setup.t.run(async (ctx) => {
      const agreement = await ctx.db.get('payToAgreements', secondAgreementId)
      if (!agreement) throw new Error('Expected second Agreement')
      await ctx.db.patch('payToAgreements', secondAgreementId, {
        environment: 'production',
      })
      return agreement.payerUserId
    })
    await activateProduction(setup, {
      payerUserIds: [setup.payerUserId, secondPayerUserId],
      dailyPaymentCountCap: 2,
      dailyPaymentValueCapCents: 12_500,
    })

    const results = await Promise.all(
      [setup.payToAgreementId, secondAgreementId].map((payToAgreementId) =>
        setup.t.mutation(internal.payToPayments.ensure, {
          payToAgreementId,
          observedAt: 3_000,
        }),
      ),
    )

    expect(results.filter((result) => result.kind === 'created')).toHaveLength(
      1,
    )
    expect(
      results.filter((result) => result.kind === 'ineligible'),
    ).toHaveLength(1)
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
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
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
    expect(critical).toHaveBeenCalledWith(
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'configuration_mismatch',
        reason: 'immutable_intent_mismatch',
        observedAt: 4_000,
      }),
    )

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
          source: 'webhook',
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

  test('revalidates every pinned production prerequisite immediately before dispatch', async () => {
    const setup = await setupAgreement()
    const activation = await activateProduction(setup)
    const established = await setup.t.mutation(internal.payToPayments.ensure, {
      payToAgreementId: setup.payToAgreementId,
      observedAt: 3_000,
    })
    if (established.kind !== 'created') {
      throw new Error('Expected production PayTo Payment establishment')
    }
    const claimed = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: established.payToPaymentId,
        leaseToken: 'production-create-worker',
        nowMs: 4_000,
      },
    )
    if (!claimed) throw new Error('Expected production create authorization')
    process.env.PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT = 'configuration-v2'

    await expect(
      setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId: established.payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'production-create-worker',
        observedAt: 4_001,
      }),
    ).resolves.toBe(false)
    await expect(
      setup.t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', claimed.operationId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({
      productionActivationId: activation.activationId,
      outcome: { classification: 'refused', observedAt: 4_001 },
    })
  })

  test('fails closed before production dispatch when rollout caps drift from the activation', async () => {
    const setup = await setupAgreement()
    await activateProduction(setup)
    const established = await setup.t.mutation(internal.payToPayments.ensure, {
      payToAgreementId: setup.payToAgreementId,
      observedAt: 3_000,
    })
    if (established.kind !== 'created') {
      throw new Error('Expected production PayTo Payment establishment')
    }
    const claimed = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: established.payToPaymentId,
        leaseToken: 'production-cap-worker',
        nowMs: 4_000,
      },
    )
    if (!claimed) throw new Error('Expected production create authorization')
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique()
      if (!gate) throw new Error('Expected production gate')
      await ctx.db.patch('payToPaymentRuntimeGates', gate._id, {
        dailyPaymentCountCap: 2,
      })
    })

    await expect(
      setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId: established.payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'production-cap-worker',
        observedAt: 4_001,
      }),
    ).resolves.toBe(false)
  })

  test('keeps an admitted production create eligible across a UTC date boundary', async () => {
    const setup = await setupAgreement()
    const firstConfirmedActiveAt = 86_399_000
    await setup.t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', setup.payToAgreementId, {
        firstConfirmedActiveAt,
        lifecycleObservedAt: firstConfirmedActiveAt,
      })
    })
    await activateProduction(setup, { nowMs: 86_398_000 })
    const established = await setup.t.mutation(internal.payToPayments.ensure, {
      payToAgreementId: setup.payToAgreementId,
      observedAt: firstConfirmedActiveAt,
    })
    if (established.kind !== 'created') {
      throw new Error('Expected production PayTo Payment establishment')
    }

    await expect(
      setup.t.mutation(internal.payToPayments.claimCreateWork, {
        payToPaymentId: established.payToPaymentId,
        leaseToken: 'cross-day-worker',
        nowMs: 86_400_001,
      }),
    ).resolves.toMatchObject({ kind: 'create' })
  })

  test('refuses production dispatch when the reserved value no longer matches immutable intent', async () => {
    const setup = await setupAgreement()
    await activateProduction(setup)
    const established = await setup.t.mutation(internal.payToPayments.ensure, {
      payToAgreementId: setup.payToAgreementId,
      observedAt: 3_000,
    })
    if (established.kind !== 'created') {
      throw new Error('Expected production PayTo Payment establishment')
    }
    const claimed = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: established.payToPaymentId,
        leaseToken: 'reservation-mismatch-worker',
        nowMs: 4_000,
      },
    )
    if (!claimed) throw new Error('Expected production create authorization')
    await setup.t.run(async (ctx) => {
      await ctx.db.patch('payToPayments', established.payToPaymentId, {
        productionCapacityReservation: {
          budgetDate: '1970-01-01',
          paymentCount: 1,
          paymentValueCents: 1,
        },
      })
    })

    await expect(
      setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId: established.payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'reservation-mismatch-worker',
        observedAt: 4_001,
      }),
    ).resolves.toBe(false)
  })

  test('refuses production dispatch when Agreement environment drifts from the Payment', async () => {
    const setup = await setupAgreement()
    await activateProduction(setup)
    const established = await setup.t.mutation(internal.payToPayments.ensure, {
      payToAgreementId: setup.payToAgreementId,
      observedAt: 3_000,
    })
    if (established.kind !== 'created') {
      throw new Error('Expected production PayTo Payment establishment')
    }
    const claimed = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: established.payToPaymentId,
        leaseToken: 'environment-mismatch-worker',
        nowMs: 4_000,
      },
    )
    if (!claimed) throw new Error('Expected production create authorization')
    await setup.t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', setup.payToAgreementId, {
        environment: 'sandbox',
      })
    })

    await expect(
      setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
        payToPaymentId: established.payToPaymentId,
        operationId: claimed.operationId,
        leaseToken: 'environment-mismatch-worker',
        observedAt: 4_001,
      }),
    ).resolves.toBe(false)
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

  test('recovers an expired pre-dispatch lease with the same permanent UID', async () => {
    const { t, payToPaymentId } = await establishPayment()
    const first = await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'crashed-before-dispatch',
      nowMs: 4_000,
    })
    if (!first) throw new Error('Expected first create operation')

    const recovered = await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'safe-recovery-worker',
      nowMs: first.leaseExpiresAt,
    })

    expect(recovered).toMatchObject({
      providerUid: first.providerUid,
      agreementProviderUid: first.agreementProviderUid,
      leaseToken: 'safe-recovery-worker',
    })
    expect(recovered?.operationId).not.toBe(first.operationId)
    await expect(
      t.run(async (ctx) => ({
        payment: await ctx.db.get('payToPayments', payToPaymentId),
        operations: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(4),
      })),
    ).resolves.toMatchObject({
      payment: {
        creationRecovery: {
          postAttempts: 2,
          recoveryCycles: 1,
        },
      },
      operations: [
        { outcome: { classification: 'refused' } },
        { operationKind: 'create', apiVersion: '20260101' },
      ],
    })
  })

  test('starts GET recovery when a worker crashes after provider acceptance but before outcome commit', async () => {
    const { t, payToPaymentId } = await establishPayment()
    const first = await t.mutation(internal.payToPayments.claimCreateWork, {
      payToPaymentId,
      leaseToken: 'crashed-after-dispatch',
      nowMs: 4_000,
    })
    if (!first) throw new Error('Expected create operation')
    await t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId,
      operationId: first.operationId,
      leaseToken: 'crashed-after-dispatch',
      observedAt: 4_001,
    })

    await expect(
      t.mutation(internal.payToPayments.expireUncommittedCreateOutcome, {
        payToPaymentId,
        operationId: first.operationId,
        observedAt: 14_000,
      }),
    ).resolves.toBe(false)
    await expect(
      t.mutation(internal.payToPayments.expireUncommittedCreateOutcome, {
        payToPaymentId,
        operationId: first.operationId,
        observedAt: 14_001,
      }),
    ).resolves.toBe(true)
    await expect(
      t.run(async (ctx) => ({
        operation: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', first.operationId),
          )
          .unique(),
        reconciliation: await ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      operation: { outcome: { classification: 'uncertain' } },
      reconciliation: { state: 'queued', availableAt: 14_001 },
    })
  })

  test('retains accepted provider evidence when the worker vanishes before commit', async () => {
    const setup = await establishPayment()
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected runtime gate')
      await ctx.db.patch(gate._id, { mode: 'reconcile_only' })
    })
    await setup.t.finishAllScheduledFunctions(() => {})
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected runtime gate')
      await ctx.db.patch(gate._id, { mode: 'enabled_for_new_confirmations' })
    })

    let providerAccepted!: () => void
    const accepted = new Promise<void>((resolve) => {
      providerAccepted = resolve
    })
    let releaseResponse!: () => void
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const body = (await new Request(request).json()) as {
        uid: string
        agreement_uid: string
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseResponse = () => {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ data: createdPaymentResponseBody(body) }),
              ),
            )
            controller.close()
          }
        },
      })
      providerAccepted()
      return new Response(stream, {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const worker = setup.t.action(internal.payToPaymentCreation.create, {
      payToPaymentId: setup.payToPaymentId,
    })
    await accepted
    const operation = await setup.t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentOperations')
        .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .order('desc')
        .first(),
    )
    if (!operation?.dispatchStartedAt) {
      throw new Error('Expected dispatched create operation')
    }
    await expect(
      setup.t.mutation(internal.payToPayments.expireUncommittedCreateOutcome, {
        payToPaymentId: setup.payToPaymentId,
        operationId: operation.operationId,
        observedAt: operation.dispatchStartedAt + 9_999,
      }),
    ).resolves.toBe(false)
    await expect(
      setup.t.mutation(internal.payToPayments.expireUncommittedCreateOutcome, {
        payToPaymentId: setup.payToPaymentId,
        operationId: operation.operationId,
        observedAt: operation.dispatchStartedAt + 10_000,
      }),
    ).resolves.toBe(true)
    releaseResponse()
    await worker

    await expect(
      setup.t.run(async (ctx) => ({
        payment: await ctx.db.get('payToPayments', setup.payToPaymentId),
        evidence: await ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .take(4),
      })),
    ).resolves.toMatchObject({
      payment: { creationState: 'creation_uncertain' },
      evidence: expect.arrayContaining([
        expect.objectContaining({
          operationId: operation.operationId,
          providerUid: expect.any(String),
          dispatchCertainty: 'possibly_dispatched',
          classification: 'completed',
          providerState: 'pending',
        }),
      ]),
    })
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
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await expect(
      t.mutation(internal.payToPayments.claimCreateWork, {
        payToPaymentId,
        leaseToken: 'capacity-worker',
        nowMs: 4_000,
      }),
    ).resolves.toBeNull()
    expect(critical).toHaveBeenCalledWith(
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'cap_breach',
        payToPaymentId,
        observedAt: 4_000,
      }),
    )
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

  test('reconciles when the provider accepts but its response is lost before outcome commit', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('response disconnected'))
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const { t, payToPaymentId } = await establishPayment()

    await t.finishAllScheduledFunctions(() => {})

    expect(fetch).toHaveBeenCalledOnce()
    await expect(
      t.run(async (ctx) => ({
        payment: await ctx.db.get('payToPayments', payToPaymentId),
        operation: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .first(),
        reconciliation: await ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      payment: { creationState: 'creation_uncertain' },
      operation: {
        dispatchStartedAt: expect.any(Number),
        outcome: { classification: 'uncertain' },
      },
      reconciliation: { state: 'queued' },
    })
  })

  test('classifies duplicate UID as ambiguity and schedules same-UID GET', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: 'ZPPAY00' }] }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const { t, payToPaymentId } = await establishPayment()

    await t.finishAllScheduledFunctions(() => {})

    expect(fetch).toHaveBeenCalledOnce()
    expect(critical).toHaveBeenCalledWith(
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'suspected_duplication',
        payToPaymentId,
      }),
    )
    await expect(
      t.run(async (ctx) => ({
        evidence: await ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .take(2),
        reconciliation: await ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      evidence: [
        {
          classification: 'uncertain',
          errorCategory: 'duplicate_uid',
        },
      ],
      reconciliation: { state: 'queued' },
    })
  })

  test('requires attention after a deterministic dispatched rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: 'invalid_terms' }] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { t, payToAgreementId } = await establishPayment()

    await t.finishAllScheduledFunctions(() => {})

    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: { paymentAttentionRequired: true },
      payments: [
        {
          creationState: 'creation_attention_required',
          attention: {
            kind: 'creation_recovery_required',
            reason: 'deterministic_failure',
          },
        },
      ],
    })
  })

  test.each([
    ['a mismatched UID', { uid: 'another-payment' }],
    ['a malformed success body', { created_at: 'not-a-date' }],
  ] as const)(
    'holds creation uncertainty after %s',
    async (caseName, override) => {
      const critical = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
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
      if (caseName === 'a mismatched UID') {
        expect(critical).toHaveBeenCalledWith(
          'PayTo Payment critical signal',
          expect.objectContaining({
            kind: 'permanent_uid_invariant_breach',
            payToPaymentId,
          }),
        )
      }
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

describe('PayTo Payment authoritative lifecycle reconciliation', () => {
  test.each([
    [0, 15 * 60_000, 1],
    [1, 4 * 60 * 60_000, 2],
    [2, 24 * 60 * 60_000, 3],
  ] as const)(
    'uses the fixed retry delay after %i accepted retries',
    async (acceptedRetries, delayMs, retryNumber) => {
      const setup = await establishProviderPayment()
      const payment = await setup.t.run((ctx) =>
        ctx.db.get('payToPayments', setup.payToPaymentId),
      )
      if (!payment) throw new Error('Expected PayTo Payment')
      await setup.t.run(async (ctx) => {
        for (let index = 0; index < acceptedRetries; index += 1) {
          await ctx.db.insert('payToPaymentOperations', {
            payToPaymentId: setup.payToPaymentId,
            operationId: `accepted-retry-${index}`,
            operationKind: 'retry',
            providerUid: payment.providerUid,
            apiVersion: '20260101',
            dispatchCertainty: 'possibly_dispatched',
            intentFingerprint: payment.intent.fingerprint,
            authorizedAt: 4_100 + index,
            dispatchStartedAt: 4_101 + index,
            outcome: { classification: 'completed', observedAt: 4_102 + index },
          })
        }
      })
      const get = await setup.t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId: setup.payToPaymentId,
          leaseToken: `timing-get-${acceptedRetries}`,
          nowMs: 4_002,
        },
      )
      if (!get) throw new Error('Expected failed GET')
      await setup.t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: setup.payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          providerState: 'failed',
          providerFailureCode: 'AB01',
          providerFailureRetryable: true,
          operationId: get.operationId,
          leaseToken: `timing-get-${acceptedRetries}`,
        },
        observedAt: 5_000,
      })

      await expect(
        setup.t.run((ctx) =>
          ctx.db
            .query('payToPaymentRetryWorkItems')
            .withIndex('by_payToPaymentId', (q) =>
              q.eq('payToPaymentId', setup.payToPaymentId),
            )
            .unique(),
        ),
      ).resolves.toMatchObject({
        retryNumber,
        availableAt: 5_000 + delayMs,
      })
    },
  )

  test('allocates only one retry operation under concurrent claims', async () => {
    const setup = await establishProviderPayment()
    await prepareFirstRetry(setup, 'concurrent-retry')
    const results = await Promise.all([
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'concurrent-a',
        nowMs: 5_000 + 15 * 60_000 + 1,
      }),
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'concurrent-b',
        nowMs: 5_000 + 15 * 60_000 + 1,
      }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('locks a stale retry worker after dispatch instead of replaying it', async () => {
    const setup = await establishProviderPayment()
    const { retry, dueAt } = await claimFirstRetry(setup, 'stale-retry')
    await setup.t.mutation(internal.payToPaymentRetry.markDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: retry.operationId,
      leaseToken: 'stale-retry',
      observedAt: dueAt + 2,
    })

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'replacement-retry',
        nowMs: retry.leaseExpiresAt,
      }),
    ).resolves.toBeNull()
    await expect(
      setup.t.run(async (ctx) => ({
        operation: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', retry.operationId),
          )
          .unique(),
        work: await ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      operation: { outcome: { classification: 'uncertain' } },
      work: { state: 'locked' },
    })
  })

  test('stops before a seventh retry-endpoint call', async () => {
    const setup = await establishProviderPayment()
    const { payment, dueAt } = await prepareFirstRetry(setup, 'call-budget')
    await setup.t.run(async (ctx) => {
      for (let index = 0; index < 6; index += 1) {
        await ctx.db.insert('payToPaymentOperations', {
          payToPaymentId: setup.payToPaymentId,
          operationId: `refused-retry-${index}`,
          operationKind: 'retry',
          providerUid: payment.providerUid,
          apiVersion: '20260101',
          dispatchCertainty: 'possibly_dispatched',
          intentFingerprint: payment.intent.fingerprint,
          authorizedAt: dueAt - 100 + index,
          dispatchStartedAt: dueAt - 99 + index,
          outcome: {
            classification: 'refused',
            observedAt: dueAt - 98 + index,
          },
        })
      }
      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert('payToPaymentOperations', {
          payToPaymentId: setup.payToPaymentId,
          operationId: `later-get-${index}`,
          operationKind: 'get',
          providerUid: payment.providerUid,
          apiVersion: '20260101',
          dispatchCertainty: 'possibly_dispatched',
          intentFingerprint: payment.intent.fingerprint,
          authorizedAt: dueAt + index,
          dispatchStartedAt: dueAt + index,
          outcome: {
            classification: 'completed',
            observedAt: dueAt + index,
          },
        })
      }
    })

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'seventh-call',
        nowMs: dueAt + 1,
      }),
    ).resolves.toBeNull()
  })

  test('waits when newer reconciliation work overlaps a ready retry', async () => {
    const setup = await establishProviderPayment()
    const { dueAt } = await prepareFirstRetry(setup, 'overlapping-get')
    await setup.t.run(async (ctx) => {
      const work = await ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .unique()
      if (!work) throw new Error('Expected reconciliation work')
      await ctx.db.patch('payToPaymentReconciliationWorkItems', work._id, {
        state: 'queued',
        availableAt: dueAt + 1,
      })
    })

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'overlapping-retry',
        nowMs: dueAt + 1,
      }),
    ).resolves.toBeNull()
  })

  test('stops after three accepted-or-possibly-accepted retry submissions', async () => {
    const setup = await establishProviderPayment()
    const { payment, dueAt } = await prepareFirstRetry(
      setup,
      'submission-budget',
    )
    await setup.t.run(async (ctx) => {
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert('payToPaymentOperations', {
          payToPaymentId: setup.payToPaymentId,
          operationId: `possibly-accepted-retry-${index}`,
          operationKind: 'retry',
          providerUid: payment.providerUid,
          apiVersion: '20260101',
          dispatchCertainty: 'possibly_dispatched',
          intentFingerprint: payment.intent.fingerprint,
          authorizedAt: dueAt - 100 + index,
          dispatchStartedAt: dueAt - 99 + index,
          outcome: {
            classification: 'uncertain',
            observedAt: dueAt - 98 + index,
          },
        })
      }
    })

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'fourth-submission',
        nowMs: dueAt + 1,
      }),
    ).resolves.toBeNull()
  })

  test('stops when the conservative rolling ledger already contains five submissions', async () => {
    const setup = await establishProviderPayment()
    const { payment, dueAt } = await prepareFirstRetry(
      setup,
      'rolling-submission-budget',
    )
    await setup.t.run(async (ctx) => {
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.insert('payToPaymentOperations', {
          payToPaymentId: setup.payToPaymentId,
          operationId: `worst-case-original-${index}`,
          operationKind: 'create',
          providerUid: payment.providerUid,
          apiVersion: '20260101',
          dispatchCertainty: 'possibly_dispatched',
          intentFingerprint: payment.intent.fingerprint,
          authorizedAt: dueAt - 1_000 + index,
          dispatchStartedAt: dueAt - 999 + index,
          outcome: {
            classification: 'completed',
            observedAt: dueAt - 998 + index,
          },
        })
      }
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.insert('payToPaymentOperations', {
          payToPaymentId: setup.payToPaymentId,
          operationId: `worst-case-retry-${index}`,
          operationKind: 'retry',
          providerUid: payment.providerUid,
          apiVersion: '20260101',
          dispatchCertainty: 'possibly_dispatched',
          intentFingerprint: payment.intent.fingerprint,
          authorizedAt: dueAt - 500 + index,
          dispatchStartedAt: dueAt - 499 + index,
          outcome: {
            classification: 'completed',
            observedAt: dueAt - 498 + index,
          },
        })
      }
    })

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'rolling-capacity-exhausted',
        nowMs: dueAt + 1,
      }),
    ).resolves.toBeNull()
  })

  test('transactionally denies a seventh lifetime retry endpoint call', async () => {
    const setup = await establishProviderPayment()
    await expect(
      setup.t.run(async (ctx) => {
        const outcomes = []
        for (let index = 0; index < 7; index += 1) {
          outcomes.push(
            await consumePaymentRetryEndpointCall(ctx, setup.payToPaymentId),
          )
        }
        return outcomes.map(({ ok }) => ok)
      }),
    ).resolves.toEqual([true, true, true, true, true, true, false])
  })

  test('honors one provider cooldown without consuming a submission slot', async () => {
    const setup = await establishProviderPayment()
    const { retry, dueAt } = await claimFirstRetry(setup, 'cooldown-retry')
    await setup.t.mutation(internal.payToPaymentRetry.markDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: retry.operationId,
      leaseToken: 'cooldown-retry',
      observedAt: dueAt + 2,
    })
    await setup.t.mutation(internal.payToPaymentRetry.recordFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: retry.operationId,
      leaseToken: 'cooldown-retry',
      ambiguous: false,
      providerCode: 'ZPPRY03',
      retryAfterMs: 60_000,
      observedAt: dueAt + 3,
    })

    await expect(
      setup.t.run(async (ctx) => ({
        operation: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', retry.operationId),
          )
          .unique(),
        work: await ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      operation: { outcome: { classification: 'refused' } },
      work: {
        state: 'queued',
        availableAt: dueAt + 3 + 60_000,
        cooldownReschedules: 1,
      },
    })
  })

  test('stops retry recovery when the Agreement is no longer valid', async () => {
    const setup = await establishProviderPayment()
    const { dueAt } = await prepareFirstRetry(setup, 'expired-agreement')
    await setup.t.run((ctx) =>
      ctx.db.patch('payToAgreements', setup.payToAgreementId, {
        lifecycleState: 'expired',
      }),
    )

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'expired-retry',
        nowMs: dueAt + 1,
      }),
    ).resolves.toBeNull()
    await expect(
      setup.t.run((ctx) =>
        ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ state: 'stopped' })
  })

  test('keeps retry work isolated from a sibling Payer Payment', async () => {
    const setup = await establishProviderPayment()
    const secondAgreementId = await addSecondAgreement(setup)
    const second = await setup.t.mutation(internal.payToPayments.ensure, {
      payToAgreementId: secondAgreementId,
      observedAt: 3_000,
    })
    if (second.kind !== 'created') throw new Error('Expected sibling Payment')
    await establishExistingProviderPayment(
      setup.t,
      second.payToPaymentId,
      'sibling-create',
    )

    await prepareFirstRetry(setup, 'isolated-retry')

    await expect(
      setup.t.run(async (ctx) => ({
        sibling: await ctx.db.get('payToPayments', second.payToPaymentId),
        siblingRetry: await ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', second.payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      sibling: { creationState: 'provider_established' },
      siblingRetry: null,
    })
  })

  test('dispatches one provider POST for one authorized retry operation', async () => {
    vi.restoreAllMocks()
    process.env.ZEPTO_ENVIRONMENT = 'sandbox'
    process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-test-token'
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }))
    const setup = await establishProviderPayment()
    await prepareFirstRetry(setup, 'action-retry')

    await setup.t.action(internal.payToPaymentRetry.retry, {
      payToPaymentId: setup.payToPaymentId,
    })

    const retryRequests = fetch.mock.calls
      .map(([request]) =>
        request instanceof Request ? request : new Request(request),
      )
      .filter(
        (request) =>
          request.method === 'POST' &&
          new URL(request.url).pathname.endsWith('/retry'),
      )
    expect(retryRequests).toHaveLength(1)
    await expect(
      setup.t.run(async (ctx) => {
        const operations = await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .order('desc')
          .take(8)
        return operations.find(
          (operation) => operation.operationKind === 'retry',
        )
      }),
    ).resolves.toMatchObject({
      dispatchCertainty: 'possibly_dispatched',
      outcome: { classification: 'completed' },
    })
  })

  test('locks an ambiguously acknowledged retry and requires attention when GET still sees failed', async () => {
    const setup = await establishProviderPayment()
    const { payment, retry, dueAt } = await claimFirstRetry(
      setup,
      'ambiguous-retry',
    )
    await expect(
      setup.t.mutation(internal.payToPaymentRetry.markDispatchStarted, {
        payToPaymentId: setup.payToPaymentId,
        operationId: retry.operationId,
        leaseToken: 'ambiguous-retry',
        observedAt: dueAt + 2,
      }),
    ).resolves.toBe(true)
    await expect(
      setup.t.mutation(internal.payToPaymentRetry.recordFailure, {
        payToPaymentId: setup.payToPaymentId,
        operationId: retry.operationId,
        leaseToken: 'ambiguous-retry',
        ambiguous: true,
        observedAt: dueAt + 3,
      }),
    ).resolves.toBe(true)
    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'ambiguous-retry-get',
        nowMs: dueAt + 3,
      },
    )
    if (!get) throw new Error('Expected ambiguity GET')
    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        providerFailureCode: 'AB01',
        providerFailureRetryable: true,
        operationId: get.operationId,
        leaseToken: 'ambiguous-retry-get',
      },
      observedAt: dueAt + 4,
    })

    await expect(
      setup.t.run(async (ctx) => ({
        payment: await ctx.db.get('payToPayments', setup.payToPaymentId),
        agreement: await ctx.db.get('payToAgreements', setup.payToAgreementId),
        operation: await ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_operationId', (q) =>
            q.eq('operationId', retry.operationId),
          )
          .unique(),
        work: await ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      })),
    ).resolves.toMatchObject({
      payment: { attention: { kind: 'retry_acknowledgement_uncertain' } },
      agreement: { paymentAttentionRequired: true },
      operation: { outcome: { classification: 'uncertain' } },
      work: { state: 'stopped', retryNumber: 1 },
    })
  })

  test('does not schedule retry work for a GET-confirmed non-retryable failure', async () => {
    const setup = await establishProviderPayment()
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'non-retryable-get',
        nowMs: 4_002,
      },
    )
    if (!get) throw new Error('Expected reconciliation GET')
    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        providerFailureCode: 'AC02',
        providerFailureRetryable: false,
        operationId: get.operationId,
        leaseToken: 'non-retryable-get',
      },
      observedAt: 5_000,
    })

    await expect(
      setup.t.run((ctx) =>
        ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      ),
    ).resolves.toBeNull()
  })

  test('drops free-form provider failure codes at the Payment evidence seam', async () => {
    const setup = await establishProviderPayment()
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'sensitive-provider-code-get',
        nowMs: 4_002,
      },
    )
    if (!get) throw new Error('Expected reconciliation GET')

    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        providerFailureCode: 'SECRET account=9876543210 token=bearer-value',
        providerFailureRetryable: false,
        operationId: get.operationId,
        leaseToken: 'sensitive-provider-code-get',
      },
      observedAt: 5_000,
    })

    const durable = await setup.t.run(async (ctx) => ({
      payment: await ctx.db.get('payToPayments', setup.payToPaymentId),
      evidence: await ctx.db
        .query('payToPaymentEvidence')
        .withIndex('by_payToPaymentId_and_observedAt', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .take(20),
    }))
    expect(durable.payment?.confirmedFailure).toBeUndefined()
    expect(JSON.stringify(durable)).not.toContain('9876543210')
    expect(JSON.stringify(durable)).not.toContain('bearer-value')
  })

  test('classifies free-form provider states before durable evidence', async () => {
    const setup = await establishProviderPayment()
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')

    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'sensitive-provider-state-get',
        nowMs: 4_002,
      },
    )
    if (!get) throw new Error('Expected reconciliation GET')

    await expect(
      setup.t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: setup.payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          providerState: 'paused account=9876543210 bearer secret',
          operationId: get.operationId,
          leaseToken: 'sensitive-provider-state-get',
        },
        observedAt: 5_000,
      }),
    ).resolves.toEqual({ kind: 'accepted' })

    const evidence = await setup.t.run((ctx) =>
      ctx.db
        .query('payToPaymentEvidence')
        .withIndex('by_payToPaymentId_and_observedAt', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .order('desc')
        .first(),
    )
    expect(evidence?.providerState).toBe('unknown')
    expect(JSON.stringify(evidence)).not.toContain('9876543210')
  })

  test('drops free-form provider failure codes at the retry evidence seam', async () => {
    const setup = await establishProviderPayment()
    const { retry, dueAt } = await claimFirstRetry(
      setup,
      'sensitive-retry-provider-code',
    )
    await setup.t.mutation(internal.payToPaymentRetry.markDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: retry.operationId,
      leaseToken: 'sensitive-retry-provider-code',
      observedAt: dueAt + 2,
    })
    await setup.t.mutation(internal.payToPaymentRetry.recordFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: retry.operationId,
      leaseToken: 'sensitive-retry-provider-code',
      ambiguous: false,
      providerCode: 'SECRET account=9876543210 token=retry-bearer-value',
      observedAt: dueAt + 3,
    })

    const evidence = await setup.t.run((ctx) =>
      ctx.db
        .query('payToPaymentEvidence')
        .withIndex('by_payToPaymentId_and_observedAt', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .take(20),
    )
    expect(JSON.stringify(evidence)).not.toContain('9876543210')
    expect(JSON.stringify(evidence)).not.toContain('retry-bearer-value')
  })

  test('stops queued retry work when fresh GET changes retryability to false', async () => {
    const setup = await establishProviderPayment()
    const { payment, dueAt } = await prepareFirstRetry(
      setup,
      'retryability-changed',
    )
    await setup.t.run(async (ctx) => {
      const work = await ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .unique()
      if (!work) throw new Error('Expected reconciliation work')
      await ctx.db.patch('payToPaymentReconciliationWorkItems', work._id, {
        state: 'queued',
        availableAt: dueAt + 2,
      })
    })
    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'non-retryable-refresh',
        nowMs: dueAt + 2,
      },
    )
    if (!get) throw new Error('Expected refreshed GET')
    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        providerFailureCode: 'AC02',
        providerFailureRetryable: false,
        operationId: get.operationId,
        leaseToken: 'non-retryable-refresh',
      },
      observedAt: dueAt + 3,
    })

    await expect(
      setup.t.run((ctx) =>
        ctx.db
          .query('payToPaymentRetryWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ state: 'stopped' })
  })

  test('refuses the generic operation interface as an arbitrary retry override', async () => {
    const setup = await establishProviderPayment()

    await expect(
      setup.t.mutation(internal.payToPayments.authorizeOperation, {
        payToPaymentId: setup.payToPaymentId,
        operationKind: 'retry',
        observedAt: 5_000,
      }),
    ).resolves.toEqual({ kind: 'denied', reason: 'operation_not_allowed' })
  })

  test.each([
    ['provider UID replacement', { providerUid: 'replacement-uid' }],
    ['intent replacement', { intentFingerprint: 'replacement-intent' }],
    ['retryability override', { retryable: true }],
    ['budget reset', { resetRetryBudget: true }],
    ['manufactured settlement', { lifecycleState: 'settled' }],
  ] as const)('rejects a caller-supplied %s', async (_override, extraArgs) => {
    const setup = await establishProviderPayment()
    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'override-attempt',
        nowMs: 5_000,
        ...extraArgs,
      }),
    ).rejects.toThrow('Unexpected field')
  })

  test('schedules the first retry fifteen minutes after a fresh retryable failure', async () => {
    const setup = await establishProviderPayment()
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'failed-get-worker',
        nowMs: 4_002,
      },
    )
    if (!get) throw new Error('Expected reconciliation GET')

    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        providerFailureCode: 'AB01',
        providerFailureRetryable: true,
        operationId: get.operationId,
        leaseToken: 'failed-get-worker',
      },
      observedAt: 5_000,
    })

    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'too-early-retry',
        nowMs: 5_000 + 15 * 60_000 - 1,
      }),
    ).resolves.toBeNull()
    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'request-fresh-get',
        nowMs: 5_000 + 15 * 60_000,
      }),
    ).resolves.toBeNull()
    const freshGet = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'fresh-failed-get-worker',
        nowMs: 5_000 + 15 * 60_000,
      },
    )
    if (!freshGet) throw new Error('Expected fresh pre-retry GET')
    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        providerFailureCode: 'AB01',
        providerFailureRetryable: true,
        operationId: freshGet.operationId,
        leaseToken: 'fresh-failed-get-worker',
      },
      observedAt: 5_000 + 15 * 60_000 + 1,
    })
    await expect(
      setup.t.mutation(internal.payToPaymentRetry.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'first-retry',
        nowMs: 5_000 + 15 * 60_000 + 1,
      }),
    ).resolves.toMatchObject({
      providerUid: payment.providerUid,
      retryNumber: 1,
    })
  })

  test('recovers an ambiguous create outcome through authoritative same-UID GET', async () => {
    const setup = await establishPayment()
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const createWork = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'ambiguous-create-worker',
        nowMs: 4_000,
      },
    )
    if (!createWork) throw new Error('Expected create work')
    await setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: createWork.operationId,
      leaseToken: 'ambiguous-create-worker',
      observedAt: 4_001,
    })
    await setup.t.mutation(internal.payToPayments.recordCreateFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: createWork.operationId,
      leaseToken: 'ambiguous-create-worker',
      errorCategory: 'timeout',
      observedAt: 4_002,
    })
    const getWork = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'ambiguity-get-worker',
        nowMs: 4_002,
      },
    )
    if (!getWork) throw new Error('Expected ambiguity GET work')
    await setup.t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId: setup.payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'pending',
        operationId: getWork.operationId,
        leaseToken: 'ambiguity-get-worker',
      },
      observedAt: 4_003,
    })

    await expect(
      paymentState(setup.t, setup.payToAgreementId),
    ).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'processing',
        paymentVerificationPending: false,
      },
      payments: [
        {
          providerUid: payment.providerUid,
          creationState: 'provider_established',
          lifecycleState: 'pending',
        },
      ],
    })
  })

  test('authoritative absence unlocks only two same-UID recovery POSTs', async () => {
    const setup = await establishPayment()
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected runtime gate')
      await ctx.db.patch(gate._id, { mode: 'reconcile_only' })
    })
    await setup.t.finishAllScheduledFunctions(() => {})
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected runtime gate')
      await ctx.db.patch(gate._id, { mode: 'enabled_for_new_confirmations' })
    })
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')

    let nowMs = 4_000
    const expectedUid = payment.providerUid
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const create = await setup.t.mutation(
        internal.payToPayments.claimCreateWork,
        {
          payToPaymentId: setup.payToPaymentId,
          leaseToken: `create-${cycle}`,
          nowMs,
        },
      )
      if (!create) throw new Error(`Expected create cycle ${cycle}`)
      expect(create.providerUid).toBe(expectedUid)
      await expect(
        setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
          payToPaymentId: setup.payToPaymentId,
          operationId: create.operationId,
          leaseToken: `create-${cycle}`,
          observedAt: nowMs + 1,
        }),
      ).resolves.toBe(true)
      await expect(
        setup.t.mutation(internal.payToPayments.recordCreateFailure, {
          payToPaymentId: setup.payToPaymentId,
          operationId: create.operationId,
          leaseToken: `create-${cycle}`,
          errorCategory: cycle === 0 ? 'duplicate_uid' : 'timeout',
          observedAt: nowMs + 2,
        }),
      ).resolves.toBe(true)
      const get = await setup.t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId: setup.payToPaymentId,
          leaseToken: `get-${cycle}`,
          nowMs: nowMs + 2,
        },
      )
      if (!get) throw new Error(`Expected GET cycle ${cycle}`)
      await setup.t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: setup.payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          providerAbsent: true,
          operationId: get.operationId,
          leaseToken: `get-${cycle}`,
        },
        observedAt: nowMs + 3,
      })
      nowMs += 1_000
    }

    await expect(
      paymentState(setup.t, setup.payToAgreementId),
    ).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'initiating',
        paymentAttentionRequired: true,
      },
      payments: [
        {
          providerUid: expectedUid,
          creationState: 'creation_attention_required',
          creationRecovery: { postAttempts: 3, recoveryCycles: 2 },
          attention: {
            kind: 'creation_recovery_required',
            reason: 'recovery_exhausted',
          },
        },
      ],
    })
  })

  test('ends unresolved creation recovery at fifteen minutes', async () => {
    const setup = await establishPayment()
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const create = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'uncertain-create',
        nowMs: 4_000,
      },
    )
    if (!create) throw new Error('Expected create work')
    await setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: create.operationId,
      leaseToken: 'uncertain-create',
      observedAt: 4_001,
    })
    await setup.t.mutation(internal.payToPayments.recordCreateFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: create.operationId,
      leaseToken: 'uncertain-create',
      errorCategory: 'timeout',
      observedAt: 4_002,
    })

    await expect(
      setup.t.mutation(internal.payToPaymentReconciliation.claimWork, {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'too-late-get',
        nowMs: 4_000 + 15 * 60_000,
      }),
    ).resolves.toBeNull()
    await expect(
      paymentState(setup.t, setup.payToAgreementId),
    ).resolves.toMatchObject({
      agreement: { paymentAttentionRequired: true },
      payments: [
        {
          creationState: 'creation_attention_required',
          attention: {
            kind: 'creation_recovery_required',
            reason: 'recovery_exhausted',
          },
        },
      ],
    })
    expect(critical).toHaveBeenCalledWith(
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'unresolved_ambiguity',
        payToPaymentId: setup.payToPaymentId,
        reason: 'creation_recovery_exhausted',
      }),
    )
  })

  test('uses the 30-second then 2-minute uncertainty cadence', async () => {
    const setup = await establishPayment()
    const create = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'cadence-create',
        nowMs: 4_000,
      },
    )
    if (!create) throw new Error('Expected create work')
    await setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: create.operationId,
      leaseToken: 'cadence-create',
      observedAt: 4_001,
    })
    await setup.t.mutation(internal.payToPayments.recordCreateFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: create.operationId,
      leaseToken: 'cadence-create',
      errorCategory: 'timeout',
      observedAt: 4_002,
    })

    for (const [attempt, nowMs, expectedNextAt] of [
      [1, 4_002, 34_001],
      [2, 34_001, 124_001],
      [3, 124_001, 304_001],
      [4, 304_001, 604_001],
    ] as const) {
      const get = await setup.t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId: setup.payToPaymentId,
          leaseToken: `cadence-get-${attempt}`,
          nowMs,
        },
      )
      if (!get) throw new Error(`Expected cadence GET ${attempt}`)
      await setup.t.mutation(
        internal.payToPaymentReconciliation.recordFailure,
        {
          payToPaymentId: setup.payToPaymentId,
          operationId: get.operationId,
          leaseToken: `cadence-get-${attempt}`,
          category: 'network',
          observedAt: nowMs + 1,
        },
      )
      await expect(
        setup.t.run(async (ctx) =>
          ctx.db
            .query('payToPaymentReconciliationWorkItems')
            .withIndex('by_payToPaymentId', (q) =>
              q.eq('payToPaymentId', setup.payToPaymentId),
            )
            .unique(),
        ),
      ).resolves.toMatchObject({
        state: 'queued',
        availableAt: expectedNextAt,
      })
    }
  })

  test('retains a stale GET failure without changing recovery state', async () => {
    const setup = await establishProviderPayment()
    const due = await setup.t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .unique(),
    )
    if (!due) throw new Error('Expected reconciliation work')
    const get = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'stale-get',
        nowMs: due.availableAt,
      },
    )
    if (!get) throw new Error('Expected GET work')

    await expect(
      setup.t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: setup.payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: 'stale-mismatched-fingerprint',
          providerState: 'pending',
          operationId: get.operationId,
          leaseToken: 'stale-get',
        },
        observedAt: due.availableAt + 3 * 60_000 + 1,
      }),
    ).resolves.toEqual({ kind: 'not_found' })
    const paymentAfterStaleEvidence = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    expect(paymentAfterStaleEvidence).toMatchObject({
      creationState: 'provider_established',
    })
    expect(paymentAfterStaleEvidence?.attention).toBeUndefined()

    await expect(
      setup.t.mutation(internal.payToPaymentReconciliation.recordFailure, {
        payToPaymentId: setup.payToPaymentId,
        operationId: get.operationId,
        leaseToken: 'stale-get',
        category: 'timeout',
        observedAt: due.availableAt + 3 * 60_000 + 1,
      }),
    ).resolves.toBe(false)
    await expect(
      setup.t.run(async (ctx) => ({
        work: await ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
        evidence: await ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .order('desc')
          .first(),
      })),
    ).resolves.toMatchObject({
      work: { state: 'running', operationId: get.operationId },
      evidence: {
        operationId: get.operationId,
        classification: 'uncertain',
        errorCategory: 'timeout',
      },
    })
  })

  test('turns a same-UID 404 GET into safe create recovery', async () => {
    const setup = await establishPayment()
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected runtime gate')
      await ctx.db.patch(gate._id, { mode: 'reconcile_only' })
    })
    await setup.t.finishAllScheduledFunctions(() => {})
    await setup.t.run(async (ctx) => {
      const gate = await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'sandbox'))
        .unique()
      if (!gate) throw new Error('Expected runtime gate')
      await ctx.db.patch(gate._id, { mode: 'enabled_for_new_confirmations' })
    })
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const nowMs = 10_000
    vi.spyOn(Date, 'now').mockReturnValue(nowMs + 3)
    const create = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: '404-create',
        nowMs,
      },
    )
    if (!create) throw new Error('Expected create work')
    await setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: create.operationId,
      leaseToken: '404-create',
      observedAt: nowMs + 1,
    })
    await setup.t.mutation(internal.payToPayments.recordCreateFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: create.operationId,
      leaseToken: '404-create',
      errorCategory: 'timeout',
      observedAt: nowMs + 2,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: 'not_found' }] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await setup.t.action(internal.payToPaymentReconciliation.reconcile, {
      payToPaymentId: setup.payToPaymentId,
    })

    await expect(
      paymentState(setup.t, setup.payToAgreementId),
    ).resolves.toMatchObject({
      payments: [
        {
          providerUid: payment.providerUid,
          creationState: 'create_pending',
          creationRecovery: { postAttempts: 1, recoveryCycles: 0 },
        },
      ],
    })
  })

  test('keeps create-response lifecycle provisional while mapping safe Payer state', async () => {
    const setup = await establishPayment()
    const claimed = await setup.t.mutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'investigation-create-worker',
        nowMs: 4_000,
      },
    )
    if (!claimed) throw new Error('Expected claimed create work')
    await setup.t.mutation(internal.payToPayments.markCreateDispatchStarted, {
      payToPaymentId: setup.payToPaymentId,
      operationId: claimed.operationId,
      leaseToken: 'investigation-create-worker',
      observedAt: 4_001,
    })
    await setup.t.mutation(internal.payToPayments.recordCreateResult, {
      payToPaymentId: setup.payToPaymentId,
      operationId: claimed.operationId,
      leaseToken: 'investigation-create-worker',
      providerState: 'under_investigation',
      providerCreatedAt: 3_500,
      observedAt: 4_002,
    })

    await expect(
      paymentState(setup.t, setup.payToAgreementId),
    ).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'under_investigation',
        paymentVerificationPending: true,
      },
      moneyRequest: {
        paymentCounts: { processing: 0, under_investigation: 1 },
        paymentVerificationPendingPayerCount: 1,
      },
      payments: [
        {
          provisionalLifecycleState: 'under_investigation',
        },
      ],
    })
  })

  test('projects paid only when a per-UID GET confirms settlement', async () => {
    const { t, payToAgreementId, payToPaymentId } =
      await establishProviderPayment()
    const payment = await t.run((ctx) =>
      ctx.db.get('payToPayments', payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')

    const work = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'settlement-get-worker',
        nowMs: 4_002,
      },
    )
    expect(work).toMatchObject({
      operationId: expect.any(String),
      providerUid: payment.providerUid,
      environment: 'sandbox',
    })
    if (!work) throw new Error('Expected GET reconciliation work')

    await expect(
      t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          providerState: 'settled',
          operationId: work.operationId,
          leaseToken: 'settlement-get-worker',
        },
        observedAt: 4_003,
      }),
    ).resolves.toEqual({ kind: 'accepted' })

    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'paid',
        paymentVerificationPending: false,
        paymentAttentionRequired: false,
      },
      moneyRequest: {
        paymentStatus: 'paid',
        paymentCounts: { processing: 0, paid: 1 },
        paymentVerificationPendingPayerCount: 0,
        paymentAttentionRequiredPayerCount: 0,
      },
      payments: [
        {
          lifecycleState: 'settled',
          lifecycleObservedAt: 4_003,
        },
      ],
    })
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ state: 'stopped' })
  })

  test('settles from scheduled GET even when no webhook is delivered', async () => {
    process.env.ZEPTO_ENVIRONMENT = 'sandbox'
    process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-test-token'
    const requests: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      const copy = new Request(request)
      requests.push(copy.clone())
      return new Response(
        JSON.stringify({
          data: createdPaymentResponseBody(
            {
              uid: new URL(copy.url).pathname.split('/').at(-1) ?? '',
              agreement_uid: 'agreement_payment_35',
            },
            { state: 'settled' },
          ),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    const { t, payToAgreementId, payToPaymentId } =
      await establishProviderPayment()

    await t.action(internal.payToPaymentReconciliation.reconcile, {
      payToPaymentId,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('GET')
    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: { paymentStatus: 'paid' },
      moneyRequest: { paymentStatus: 'paid' },
      payments: [{ lifecycleState: 'settled' }],
    })
  })

  test('preserves the last confirmed lifecycle when GET returns an unknown state', async () => {
    const { t, payToAgreementId, payToPaymentId } =
      await establishProviderPayment()
    const payment = await t.run((ctx) =>
      ctx.db.get('payToPayments', payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const firstWork = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'pending-get-worker',
        nowMs: 4_002,
      },
    )
    if (!firstWork) throw new Error('Expected initial GET work')
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'pending',
        operationId: firstWork.operationId,
        leaseToken: 'pending-get-worker',
      },
      observedAt: 4_003,
    })
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'webhook',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'provider_added_a_state',
      },
      observedAt: 5_000,
    })
    const unknownWork = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'unknown-get-worker',
        nowMs: 5_000,
      },
    )
    if (!unknownWork) throw new Error('Expected immediate GET work')
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'provider_added_a_state',
        operationId: unknownWork.operationId,
        leaseToken: 'unknown-get-worker',
      },
      observedAt: 5_001,
    })

    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'processing',
        paymentVerificationPending: true,
        paymentAttentionRequired: true,
      },
      moneyRequest: {
        paymentCounts: { processing: 1, paid: 0 },
        paymentVerificationPendingPayerCount: 1,
        paymentAttentionRequiredPayerCount: 1,
      },
      payments: [
        {
          lifecycleState: 'pending',
          lifecycleObservedAt: 4_003,
          lastReconciledAt: 5_001,
          attention: { kind: 'unknown_provider_state' },
        },
      ],
    })
  })

  test('runs an immediate follow-up when evidence arrives during a GET lease', async () => {
    const { t, payToPaymentId } = await establishProviderPayment()
    const payment = await t.run((ctx) =>
      ctx.db.get('payToPayments', payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const work = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'in-flight-get-worker',
        nowMs: 4_002,
      },
    )
    if (!work) throw new Error('Expected in-flight GET work')
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'webhook',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'under_investigation',
      },
      observedAt: 4_003,
    })
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'pending',
        operationId: work.operationId,
        leaseToken: 'in-flight-get-worker',
      },
      observedAt: 4_004,
    })

    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ state: 'queued', availableAt: 4_004 })
  })

  test('retains paid counts and raises critical attention after a settlement contradiction', async () => {
    const { t, payToAgreementId, payToPaymentId } =
      await establishProviderPayment()
    const payment = await t.run((ctx) =>
      ctx.db.get('payToPayments', payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const settlementWork = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'first-settlement-worker',
        nowMs: 4_002,
      },
    )
    if (!settlementWork) throw new Error('Expected settlement GET work')
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'settled',
        operationId: settlementWork.operationId,
        leaseToken: 'first-settlement-worker',
      },
      observedAt: 4_003,
    })
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'webhook',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
      },
      observedAt: 5_000,
    })
    const contradictionWork = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'contradiction-get-worker',
        nowMs: 5_000,
      },
    )
    if (!contradictionWork) throw new Error('Expected contradiction GET work')
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'failed',
        operationId: contradictionWork.operationId,
        leaseToken: 'contradiction-get-worker',
      },
      observedAt: 5_001,
    })
    expect(critical).toHaveBeenCalledWith(
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'settlement_contradiction',
        payToPaymentId,
        observedAt: 5_001,
      }),
    )

    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'paid',
        paymentVerificationPending: true,
        paymentAttentionRequired: true,
      },
      moneyRequest: {
        paymentStatus: 'paid',
        paymentCounts: { failed: 0, paid: 1 },
        paymentAttentionRequiredPayerCount: 1,
      },
      payments: [
        {
          lifecycleState: 'settled',
          lifecycleObservedAt: 4_003,
          attention: {
            kind: 'settlement_contradiction',
            observedState: 'failed',
            observedAt: 5_001,
          },
        },
      ],
    })
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      ),
    ).resolves.toMatchObject({ state: 'queued', availableAt: 5_001 })
  })

  test('preserves confirmed truth through a GET outage and clears the alert on recovery', async () => {
    const { t, payToAgreementId, payToPaymentId } =
      await establishProviderPayment()
    const payment = await t.run((ctx) =>
      ctx.db.get('payToPayments', payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const initialWork = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'initial-confirmation-worker',
        nowMs: 4_002,
      },
    )
    if (!initialWork) throw new Error('Expected initial GET work')
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'pending',
        operationId: initialWork.operationId,
        leaseToken: 'initial-confirmation-worker',
      },
      observedAt: 4_003,
    })
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'webhook',
        intentFingerprint: payment.intent.fingerprint,
      },
      observedAt: 5_000,
    })

    for (let failure = 1; failure <= 6; failure += 1) {
      const work = await t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique(),
      )
      if (!work) throw new Error('Expected reconciliation work')
      const leaseToken = `outage-worker-${failure}`
      const claimed = await t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId,
          leaseToken,
          nowMs: work.availableAt,
        },
      )
      if (!claimed) throw new Error('Expected claimed outage GET')
      await expect(
        t.mutation(internal.payToPaymentReconciliation.recordFailure, {
          payToPaymentId,
          operationId: claimed.operationId,
          leaseToken,
          category: 'network',
          observedAt: work.availableAt + 1,
        }),
      ).resolves.toBe(true)
    }

    await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
      agreement: {
        paymentStatus: 'processing',
        paymentVerificationPending: false,
        paymentAttentionRequired: false,
      },
      moneyRequest: {
        paymentCounts: { processing: 1 },
        paymentAttentionRequiredPayerCount: 0,
      },
      payments: [
        {
          lifecycleState: 'pending',
          lifecycleObservedAt: 4_003,
          reconciliationAlert: { kind: 'lifecycle_tracking_outage' },
        },
      ],
    })

    const recoveryWork = await t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', payToPaymentId),
        )
        .unique(),
    )
    if (!recoveryWork) throw new Error('Expected recovery work')
    const recovery = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'recovery-worker',
        nowMs: recoveryWork.availableAt,
      },
    )
    if (!recovery) throw new Error('Expected recovery GET')
    await t.mutation(internal.payToPayments.applyEvidence, {
      payToPaymentId,
      evidence: {
        source: 'per_uid_get',
        intentFingerprint: payment.intent.fingerprint,
        providerState: 'pending',
        operationId: recovery.operationId,
        leaseToken: 'recovery-worker',
      },
      observedAt: recoveryWork.availableAt + 1,
    })
    const recovered = await paymentState(t, payToAgreementId)
    expect(recovered.payments[0]).not.toHaveProperty('reconciliationAlert')
  })

  test('alerts after 24 hours without any successful GET reconciliation', async () => {
    const { t, payToPaymentId } = await establishProviderPayment()
    const alert = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dayLater = 3_000 + 24 * 60 * 60_000
    const work = await t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId,
        leaseToken: 'aged-outage-worker',
        nowMs: dayLater,
      },
    )
    if (!work) throw new Error('Expected aged GET work')
    await t.mutation(internal.payToPaymentReconciliation.recordFailure, {
      payToPaymentId,
      operationId: work.operationId,
      leaseToken: 'aged-outage-worker',
      category: 'network',
      observedAt: dayLater,
    })

    await expect(
      t.run((ctx) => ctx.db.get('payToPayments', payToPaymentId)),
    ).resolves.toMatchObject({
      reconciliationAlert: {
        kind: 'lifecycle_tracking_outage',
        observedAt: dayLater,
      },
    })
    expect(alert).toHaveBeenCalledWith(
      'PayTo Payment operational alert',
      expect.objectContaining({
        payToPaymentId,
        observedAt: dayLater,
      }),
    )
  })

  test('counts expired GET leases toward the outage threshold', async () => {
    const { t, payToPaymentId } = await establishProviderPayment()
    let nowMs = 4_002
    for (let crash = 1; crash <= 6; crash += 1) {
      const claimed = await t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId,
          leaseToken: `crashed-get-worker-${crash}`,
          nowMs,
        },
      )
      if (!claimed) throw new Error('Expected crash-prone GET work')
      nowMs += 3 * 60_000 + 1
    }
    await t.mutation(internal.payToPaymentReconciliation.claimWork, {
      payToPaymentId,
      leaseToken: 'post-threshold-get-worker',
      nowMs,
    })

    await expect(
      t.run((ctx) => ctx.db.get('payToPayments', payToPaymentId)),
    ).resolves.toMatchObject({
      reconciliationAlert: {
        kind: 'lifecycle_tracking_outage',
        observedAt: nowMs,
      },
    })
  })

  test.each([
    ['created', 'processing'],
    ['submitting', 'processing'],
    ['pending', 'processing'],
    ['under_investigation', 'under_investigation'],
    ['failed', 'failed'],
    ['settled', 'paid'],
  ] as const)(
    'persists GET-confirmed %s through the Payment module boundary',
    async (providerState, paymentStatus) => {
      const { t, payToAgreementId, payToPaymentId } =
        await establishProviderPayment()
      const payment = await t.run((ctx) =>
        ctx.db.get('payToPayments', payToPaymentId),
      )
      if (!payment) throw new Error('Expected PayTo Payment')
      const work = await t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId,
          leaseToken: `transition-${providerState}`,
          nowMs: 4_002,
        },
      )
      if (!work) throw new Error('Expected transition GET work')
      await t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          providerState,
          operationId: work.operationId,
          leaseToken: `transition-${providerState}`,
        },
        observedAt: 4_003,
      })

      await expect(paymentState(t, payToAgreementId)).resolves.toMatchObject({
        agreement: {
          paymentStatus,
          paymentVerificationPending: false,
          paymentAttentionRequired: false,
        },
        payments: [{ lifecycleState: providerState }],
      })
    },
  )

  test('keeps exact mixed-Payer counts and converges simultaneous settlements atomically', async () => {
    const setup = await setupAgreement()
    const secondAgreementId = await addSecondAgreement(setup)
    await setup.t.run(async (ctx) => {
      await ctx.db.insert('payToPaymentRuntimeGates', {
        environment: 'sandbox',
        mode: 'enabled_for_new_confirmations',
        activatedAt: 2_500,
      })
    })
    const established = await Promise.all(
      [setup.payToAgreementId, secondAgreementId].map((payToAgreementId) =>
        setup.t.mutation(internal.payToPayments.ensure, {
          payToAgreementId,
          observedAt: 3_000,
        }),
      ),
    )
    const paymentIds = established.map((result) => {
      if (result.kind === 'ineligible') {
        throw new Error('Expected established PayTo Payment')
      }
      return result.payToPaymentId
    })
    await Promise.all([
      establishExistingProviderPayment(
        setup.t,
        paymentIds[0],
        'first-provider-worker',
      ),
      establishExistingProviderPayment(
        setup.t,
        paymentIds[1],
        'second-provider-worker',
      ),
    ])
    const payments = await setup.t.run(async (ctx) =>
      Promise.all(paymentIds.map((paymentId) => ctx.db.get(paymentId))),
    )
    if (!payments[0] || !payments[1]) {
      throw new Error('Expected both PayTo Payments')
    }
    const mixedWork = await Promise.all(
      paymentIds.map((payToPaymentId, index) =>
        setup.t.mutation(internal.payToPaymentReconciliation.claimWork, {
          payToPaymentId,
          leaseToken: `mixed-get-worker-${index}`,
          nowMs: 4_002,
        }),
      ),
    )
    if (!mixedWork[0] || !mixedWork[1]) {
      throw new Error('Expected both mixed-outcome GETs')
    }
    await Promise.all(
      paymentIds.map((payToPaymentId, index) =>
        setup.t.mutation(internal.payToPayments.applyEvidence, {
          payToPaymentId,
          evidence: {
            source: 'per_uid_get',
            intentFingerprint: payments[index]!.intent.fingerprint,
            providerState: index === 0 ? 'settled' : 'failed',
            operationId: mixedWork[index]!.operationId,
            leaseToken: `mixed-get-worker-${index}`,
          },
          observedAt: 4_003,
        }),
      ),
    )

    await expect(
      setup.t.run((ctx) => ctx.db.get('moneyRequests', setup.moneyRequestId)),
    ).resolves.toMatchObject({
      paymentStatus: 'unpaid',
      paymentCounts: { failed: 1, paid: 1 },
      paymentVerificationPendingPayerCount: 0,
      paymentAttentionRequiredPayerCount: 0,
    })

    await Promise.all(
      paymentIds.map((payToPaymentId, index) =>
        setup.t.mutation(internal.payToPayments.applyEvidence, {
          payToPaymentId,
          evidence: {
            source: 'webhook',
            intentFingerprint: payments[index]!.intent.fingerprint,
            providerState: 'settled',
          },
          observedAt: 5_000,
        }),
      ),
    )
    const settlementWork = await Promise.all(
      paymentIds.map((payToPaymentId, index) =>
        setup.t.mutation(internal.payToPaymentReconciliation.claimWork, {
          payToPaymentId,
          leaseToken: `simultaneous-settlement-${index}`,
          nowMs: 5_000,
        }),
      ),
    )
    if (!settlementWork[0] || !settlementWork[1]) {
      throw new Error('Expected simultaneous settlement GETs')
    }
    await Promise.all(
      paymentIds.map((payToPaymentId, index) =>
        setup.t.mutation(internal.payToPayments.applyEvidence, {
          payToPaymentId,
          evidence: {
            source: 'per_uid_get',
            intentFingerprint: payments[index]!.intent.fingerprint,
            providerState: 'settled',
            operationId: settlementWork[index]!.operationId,
            leaseToken: `simultaneous-settlement-${index}`,
          },
          observedAt: 5_001,
        }),
      ),
    )

    await expect(
      setup.t.run((ctx) => ctx.db.get('moneyRequests', setup.moneyRequestId)),
    ).resolves.toMatchObject({
      paymentStatus: 'paid',
      payerCount: 2,
      paymentCounts: {
        not_started: 0,
        initiating: 0,
        processing: 0,
        under_investigation: 0,
        failed: 0,
        paid: 2,
      },
      paymentVerificationPendingPayerCount: 0,
      paymentAttentionRequiredPayerCount: 0,
    })
  })
})

describe('PayTo Payment operational monitoring', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('warns once work is more than five minutes overdue with bounded safe queue context', async () => {
    const setup = await establishProviderPayment()
    await setup.t.run(async (ctx) => {
      const work = await ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .unique()
      if (!work) throw new Error('Expected reconciliation work')
      await ctx.db.patch(work._id, { state: 'queued', availableAt: 10_000 })
    })
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    await setup.t.mutation(internal.payToPaymentReconciliation.dispatchDue, {
      nowMs: 10_000 + 5 * 60_000 + 1,
    })

    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith('PayTo Payment operational warning', {
      kind: 'work_overdue',
      observedAt: 10_000 + 5 * 60_000 + 1,
      queue: 'reconciliation',
      dueCount: 1,
      oldestAgeMs: 5 * 60_000 + 1,
      sampledPayToPaymentIds: [setup.payToPaymentId],
      truncated: false,
    })
    expect(JSON.stringify(warning.mock.calls)).not.toContain('ciphertext')
    expect(JSON.stringify(warning.mock.calls)).not.toContain('123456')
  })

  test('warns for overdue creation and retry work but not at exactly five minutes', async () => {
    const setup = await establishProviderPayment()
    await setup.t.run(async (ctx) => {
      const creation = await ctx.db
        .query('payToPaymentWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', setup.payToPaymentId),
        )
        .unique()
      if (!creation) throw new Error('Expected creation work')
      await ctx.db.patch(creation._id, {
        state: 'queued',
        availableAt: 20_000,
      })
      await ctx.db.insert('payToPaymentRetryWorkItems', {
        payToPaymentId: setup.payToPaymentId,
        state: 'queued',
        retryNumber: 1,
        availableAt: 30_000,
      })
    })
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)

    await setup.t.mutation(internal.payToPayments.dispatchCreationRecoveryDue, {
      nowMs: 20_000 + 5 * 60_000,
    })
    await setup.t.mutation(internal.payToPaymentRetry.dispatchDue, {
      nowMs: 30_000 + 5 * 60_000 + 1,
    })
    await setup.t.mutation(internal.payToPayments.dispatchCreationRecoveryDue, {
      nowMs: 20_000 + 5 * 60_000 + 1,
    })

    const queues = warning.mock.calls
      .filter(([message]) => message === 'PayTo Payment operational warning')
      .map(([, context]) => (context as { queue: string }).queue)
    expect(queues).toEqual(['retry', 'creation'])
  })

  test('emits one operational alert at the GET outage threshold and recovers without changing Payment truth', async () => {
    const setup = await establishProviderPayment()
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')
    const alert = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    for (let failure = 1; failure <= 7; failure += 1) {
      const work = await setup.t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      )
      if (!work) throw new Error('Expected reconciliation work')
      const leaseToken = `monitoring-outage-${failure}`
      const claimed = await setup.t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId: setup.payToPaymentId,
          leaseToken,
          nowMs: work.availableAt,
        },
      )
      if (!claimed) throw new Error('Expected claimed GET')
      await setup.t.mutation(
        internal.payToPaymentReconciliation.recordFailure,
        {
          payToPaymentId: setup.payToPaymentId,
          operationId: claimed.operationId,
          leaseToken,
          category: 'network',
          observedAt: work.availableAt + 1,
        },
      )
    }

    const operationalAlerts = alert.mock.calls.filter(([message, context]) => {
      const observedAt = (context as { observedAt?: number }).observedAt
      return (
        message === 'PayTo Payment operational alert' &&
        observedAt !== undefined &&
        observedAt < 1_000_000_000
      )
    })
    expect(operationalAlerts).toHaveLength(1)
    expect(operationalAlerts[0]).toEqual([
      'PayTo Payment operational alert',
      expect.objectContaining({
        kind: 'lifecycle_tracking_outage',
        payToPaymentId: setup.payToPaymentId,
        consecutiveFailures: 6,
      }),
    ])
    await expect(
      setup.t.run((ctx) => ctx.db.get('payToPayments', setup.payToPaymentId)),
    ).resolves.toMatchObject({
      provisionalLifecycleState: 'pending',
      reconciliationAlert: { kind: 'lifecycle_tracking_outage' },
    })
  })

  test('emits deduplicated critical signals for unknown provider truth', async () => {
    const setup = await establishProviderPayment()
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const payment = await setup.t.run((ctx) =>
      ctx.db.get('payToPayments', setup.payToPaymentId),
    )
    if (!payment) throw new Error('Expected PayTo Payment')

    for (let observation = 0; observation < 2; observation += 1) {
      const work = await setup.t.run(async (ctx) =>
        ctx.db
          .query('payToPaymentReconciliationWorkItems')
          .withIndex('by_payToPaymentId', (q) =>
            q.eq('payToPaymentId', setup.payToPaymentId),
          )
          .unique(),
      )
      if (!work) throw new Error('Expected reconciliation work')
      const leaseToken = `unknown-state-monitor-${observation}`
      const claimed = await setup.t.mutation(
        internal.payToPaymentReconciliation.claimWork,
        {
          payToPaymentId: setup.payToPaymentId,
          leaseToken,
          nowMs: work.availableAt,
        },
      )
      if (!claimed) throw new Error('Expected claimed GET')
      await setup.t.mutation(internal.payToPayments.applyEvidence, {
        payToPaymentId: setup.payToPaymentId,
        evidence: {
          source: 'per_uid_get',
          intentFingerprint: payment.intent.fingerprint,
          providerState: 'provider_added_state',
          operationId: claimed.operationId,
          leaseToken,
        },
        observedAt: work.availableAt + 1,
      })
    }

    const unknownStateSignals = critical.mock.calls.filter(
      ([message, context]) =>
        message === 'PayTo Payment critical signal' &&
        (context as { kind?: string }).kind === 'unknown_provider_state',
    )
    expect(unknownStateSignals).toHaveLength(1)
    expect(unknownStateSignals[0]).toEqual([
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'unknown_provider_state',
        payToPaymentId: setup.payToPaymentId,
      }),
    ])
    expect(JSON.stringify(unknownStateSignals)).not.toContain(
      'provider_added_state',
    )
  })

  test('immediately signals GET configuration mismatches without Payment attention', async () => {
    const setup = await establishProviderPayment()
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const claimed = await setup.t.mutation(
      internal.payToPaymentReconciliation.claimWork,
      {
        payToPaymentId: setup.payToPaymentId,
        leaseToken: 'configuration-get-worker',
        nowMs: 4_002,
      },
    )
    if (!claimed) throw new Error('Expected claimed GET')

    await setup.t.mutation(internal.payToPaymentReconciliation.recordFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: claimed.operationId,
      leaseToken: 'configuration-get-worker',
      category: 'configuration',
      observedAt: 4_003,
    })

    expect(critical).toHaveBeenCalledWith(
      'PayTo Payment critical signal',
      expect.objectContaining({
        kind: 'configuration_mismatch',
        payToPaymentId: setup.payToPaymentId,
        observedAt: 4_003,
      }),
    )
    await expect(
      setup.t.run((ctx) => ctx.db.get('payToPayments', setup.payToPaymentId)),
    ).resolves.not.toHaveProperty('attention')
  })

  test('immediately signals retry configuration mismatches without exposing provider detail', async () => {
    const setup = await establishProviderPayment()
    const { retry, dueAt } = await claimFirstRetry(
      setup,
      'configuration-retry-worker',
    )
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await setup.t.mutation(internal.payToPaymentRetry.recordFailure, {
      payToPaymentId: setup.payToPaymentId,
      operationId: retry.operationId,
      leaseToken: 'configuration-retry-worker',
      ambiguous: false,
      errorCategory: 'configuration',
      observedAt: dueAt + 2,
    })

    const signals = critical.mock.calls.filter(
      ([message, context]) =>
        message === 'PayTo Payment critical signal' &&
        (context as { kind?: string }).kind === 'configuration_mismatch',
    )
    expect(signals).toEqual([
      [
        'PayTo Payment critical signal',
        expect.objectContaining({
          payToPaymentId: setup.payToPaymentId,
          observedAt: dueAt + 2,
          reason: 'configuration',
        }),
      ],
    ])
    expect(JSON.stringify(signals)).not.toContain('providerFailureCode')
  })

  test('emits a bounded aggregate snapshot for Payment health', async () => {
    const setup = await establishProviderPayment()
    await setup.t.run(async (ctx) => {
      await ctx.db.insert('payToPaymentWebhookDeduplication', {
        payToPaymentId: setup.payToPaymentId,
        outcome: 'duplicate_delivery',
        deliveryId: 'safe-delivery-id',
        observedAt: 4_500,
      })
    })
    const telemetry = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined)

    const snapshot = await setup.t.mutation(
      internal.payToPaymentMonitoring.emitAggregateSnapshot,
      { nowMs: 24 * 60 * 60_000 + 4_003 },
    )

    expect(snapshot).toEqual({
      observedAt: 24 * 60 * 60_000 + 4_003,
      sampledPaymentCount: 1,
      sampleTruncated: false,
      settlement: { settledCount: 0, averageLatencyMs: 0, maxLatencyMs: 0 },
      agedUnresolvedPaymentCount: 1,
      confirmedFailureCount: 0,
      confirmedFailureRate: 0,
      retry: { attemptCount: 0, failureCount: 0, failureRate: 0 },
      webhookDeduplication: {
        duplicateDeliveryCount: 1,
        duplicateEventCount: 0,
      },
      projection: { checkedCount: 1, inconsistencyCount: 0 },
    })
    expect(telemetry).toHaveBeenCalledWith(
      'PayTo Payment aggregate monitoring',
      snapshot,
    )
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain(
      'safe-delivery-id',
    )
  })

  test('emits a per-Payment aggregate metric when unresolved work reaches 24 hours', async () => {
    const setup = await establishProviderPayment()
    const unscheduledPaymentId = await insertUnscheduledPaymentCopy(setup)
    const telemetry = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined)

    await expect(
      setup.t.mutation(internal.payToPaymentMonitoring.checkAgedUnresolved, {
        payToPaymentId: unscheduledPaymentId,
      }),
    ).resolves.toBe(true)

    expect(telemetry).toHaveBeenCalledWith('PayTo Payment aggregate metric', {
      kind: 'aged_unresolved_payment',
      payToPaymentId: unscheduledPaymentId,
      observedAt: 3_000 + 24 * 60 * 60_000,
    })
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('ciphertext')
    await expect(
      setup.t.mutation(internal.payToPaymentMonitoring.checkAgedUnresolved, {
        payToPaymentId: unscheduledPaymentId,
      }),
    ).resolves.toBe(false)
  })

  test('backfills the aged unresolved milestone for pre-existing Payments in bounded pages', async () => {
    const setup = await establishProviderPayment()
    const unscheduledPaymentId = await insertUnscheduledPaymentCopy(setup)
    const telemetry = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined)
    const nowMs = 3_000 + 25 * 60 * 60_000

    await expect(
      setup.t.mutation(internal.payToPaymentMonitoring.sweepAgedUnresolved, {
        paginationOpts: {
          numItems: 100,
          cursor: null,
          maximumRowsRead: 100,
          maximumBytesRead: 1_000_000,
        },
        nowMs,
      }),
    ).resolves.toEqual({ emittedCount: 1, isDone: true })

    expect(telemetry).toHaveBeenCalledWith('PayTo Payment aggregate metric', {
      kind: 'aged_unresolved_payment',
      payToPaymentId: unscheduledPaymentId,
      observedAt: nowMs,
    })
    await expect(
      setup.t.mutation(internal.payToPaymentMonitoring.sweepAgedUnresolved, {
        paginationOpts: {
          numItems: 100,
          cursor: null,
          maximumRowsRead: 100,
          maximumBytesRead: 1_000_000,
        },
        nowMs: nowMs + 60 * 60_000,
      }),
    ).resolves.toEqual({ emittedCount: 0, isDone: true })
  })

  test('signals projection inconsistencies through critical and aggregate telemetry', async () => {
    const setup = await establishProviderPayment()
    await setup.t.run(async (ctx) => {
      await ctx.db.patch('moneyRequests', setup.moneyRequestId, {
        paymentCounts: {
          not_started: 1,
          initiating: 0,
          processing: 0,
          under_investigation: 0,
          failed: 0,
          paid: 0,
        },
      })
    })
    const critical = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const telemetry = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined)

    const snapshot = await setup.t.mutation(
      internal.payToPaymentMonitoring.emitAggregateSnapshot,
      { nowMs: 5_000 },
    )

    expect(snapshot.projection).toEqual({
      checkedCount: 1,
      inconsistencyCount: 1,
    })
    expect(critical).toHaveBeenCalledWith('PayTo Payment critical signal', {
      kind: 'projection_inconsistency',
    })
    expect(telemetry).toHaveBeenCalledWith('PayTo Payment aggregate metric', {
      kind: 'projection_inconsistency',
    })
  })
})
