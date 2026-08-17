/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { expect, test } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

const operatorIdentity = {
  tokenIdentifier: 'https://clerk.example.test|payment_operator',
  subject: 'payment_operator',
  issuer: 'https://clerk.example.test',
  email: 'operator@example.test',
  name: 'Payment Operator',
} satisfies UserIdentity

async function setupPayment(operatorRole = true) {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const operatorUserId = await ctx.db.insert('users', {
      tokenIdentifier: operatorIdentity.tokenIdentifier,
      clerkUserId: operatorIdentity.subject,
      email: operatorIdentity.email,
      name: operatorIdentity.name,
      ...(operatorRole ? { roles: ['payment_operator'] as const } : {}),
    })
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|operator_requester',
      clerkUserId: 'operator_requester',
      email: 'requester@example.test',
      name: 'Requester',
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|operator_payer',
      clerkUserId: 'operator_payer',
      email: 'payer@example.test',
      name: 'Payer',
    })
    const creditorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: requesterUserId,
      type: 'bban',
      searchLabel: 'requester',
      maskedDisplay: '123456••••345',
      fingerprint: 'creditor-fingerprint-sensitive',
      ciphertext: 'creditor-ciphertext-sensitive',
      nonce: 'creditor-nonce-sensitive',
      keyVersion: 'v1',
    })
    const debtorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: payerUserId,
      type: 'bban',
      searchLabel: 'payer',
      maskedDisplay: '654321••••765',
      fingerprint: 'debtor-fingerprint-sensitive',
      ciphertext: 'debtor-ciphertext-sensitive',
      nonce: 'debtor-nonce-sensitive',
      keyVersion: 'v1',
    })
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: 'Requester',
      amountCents: 12_500,
      currency: 'AUD',
      purpose: 'other',
      description: 'Operator diagnostics',
      submissionKey: 'operator-submission-key-sensitive',
      submissionFingerprint: 'operator-submission-fingerprint-sensitive',
      sourceCreditorPaymentDestinationId: creditorDestinationId,
      creditorSnapshot: {
        kind: 'bban',
        maskedDisplay: '123456••••345',
        ciphertext: 'creditor-ciphertext-sensitive',
        nonce: 'creditor-nonce-sensitive',
        keyVersion: 'v1',
      },
      submittedAt: 1_000,
      payerCount: 1,
      paymentStatus: 'unpaid',
      paymentCounts: {
        not_started: 0,
        initiating: 0,
        processing: 1,
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
      payerNameSnapshot: 'Payer',
      sourceDebtorPaymentDestinationId: debtorDestinationId,
      debtorSnapshot: {
        kind: 'bban',
        maskedDisplay: '654321••••765',
        ciphertext: 'debtor-ciphertext-sensitive',
        nonce: 'debtor-nonce-sensitive',
        keyVersion: 'v1',
      },
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: 'agreement-operator-diagnostics',
      activationProvenancePolicy: 'track_first_confirmation',
      firstConfirmedActiveAt: 2_000,
      paymentStatus: 'processing',
      paymentVerificationPending: false,
      paymentAttentionRequired: false,
      creationState: 'created',
      creationUpdatedAt: 2_000,
      lifecycleState: 'active',
      lifecycleConfidence: 'confirmed',
      lifecycleObservedAt: 2_000,
      trackingState: 'current',
      trackingUpdatedAt: 2_000,
    })
    const payToPaymentId = await ctx.db.insert('payToPayments', {
      payToAgreementId,
      moneyRequestId,
      payerUserId,
      environment: 'sandbox',
      providerUid: 'payment-operator-diagnostics',
      intent: {
        agreementProviderUid: 'agreement-operator-diagnostics',
        amount: { cents: 12_500, currency: 'AUD' },
        routing: {
          sourceCreditorPaymentDestinationId: creditorDestinationId,
          sourceDebtorPaymentDestinationId: debtorDestinationId,
          creditorSnapshot: {
            kind: 'bban',
            maskedDisplay: '123456••••345',
            ciphertext: 'creditor-ciphertext-sensitive',
            nonce: 'creditor-nonce-sensitive',
            keyVersion: 'v1',
          },
          debtorSnapshot: {
            kind: 'bban',
            maskedDisplay: '654321••••765',
            ciphertext: 'debtor-ciphertext-sensitive',
            nonce: 'debtor-nonce-sensitive',
            keyVersion: 'v1',
          },
        },
        priority: 'unattended',
        apiVersion: '20260101',
        fingerprint: 'payment-intent-fingerprint',
      },
      creationState: 'provider_established',
      establishedAt: 2_000,
      lifecycleState: 'pending',
      lifecycleObservedAt: 3_000,
      lastReconciledAt: 3_000,
    })
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'sandbox',
      mode: 'reconcile_only',
      activatedAt: 1_500,
      dailyPaymentCountCap: 10,
      dailyPaymentValueCapCents: 100_000,
      budgetDate: '1970-01-01',
      reservedPaymentCount: 2,
      reservedPaymentValueCents: 25_000,
    })
    await ctx.db.insert('payToPaymentWorkItems', {
      payToPaymentId,
      kind: 'create',
      state: 'completed',
      availableAt: 2_000,
      completedAt: 2_500,
    })
    await ctx.db.insert('payToPaymentReconciliationWorkItems', {
      payToPaymentId,
      state: 'queued',
      availableAt: 4_000,
      consecutiveFailures: 1,
      lastSuccessAt: 3_000,
    })
    await ctx.db.insert('payToPaymentRetryWorkItems', {
      payToPaymentId,
      state: 'stopped',
      retryNumber: 1,
      availableAt: 5_000,
    })
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId,
      operationId: 'operator-get-operation',
      operationKind: 'get',
      providerUid: 'payment-operator-diagnostics',
      apiVersion: '20260101',
      dispatchCertainty: 'possibly_dispatched',
      intentFingerprint: 'payment-intent-fingerprint',
      requestFingerprint: 'safe-request-fingerprint',
      authorizedAt: 2_900,
      leaseToken: 'lease-token-sensitive',
      leaseExpiresAt: 3_100,
      dispatchStartedAt: 2_950,
      outcome: { classification: 'completed', observedAt: 3_000 },
    })
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId,
      operationId: 'operator-create-operation',
      operationKind: 'create',
      providerUid: 'payment-operator-diagnostics',
      apiVersion: '20260101',
      dispatchCertainty: 'possibly_dispatched',
      intentFingerprint: 'payment-intent-fingerprint',
      authorizedAt: 2_000,
      dispatchStartedAt: 2_001,
      outcome: { classification: 'completed', observedAt: 2_100 },
    })
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId,
      operationId: 'operator-retry-operation',
      operationKind: 'retry',
      providerUid: 'payment-operator-diagnostics',
      apiVersion: '20260101',
      dispatchCertainty: 'possibly_dispatched',
      intentFingerprint: 'payment-intent-fingerprint',
      authorizedAt: 2_200,
      dispatchStartedAt: 2_201,
      outcome: { classification: 'completed', observedAt: 2_300 },
    })
    for (let index = 0; index < 25; index += 1) {
      await ctx.db.insert('payToPaymentOperations', {
        payToPaymentId,
        operationId: `operator-later-get-${index}`,
        operationKind: 'get',
        providerUid: 'payment-operator-diagnostics',
        apiVersion: '20260101',
        dispatchCertainty: 'possibly_dispatched',
        intentFingerprint: 'payment-intent-fingerprint',
        authorizedAt: 3_500 + index,
        outcome: { classification: 'completed', observedAt: 3_600 + index },
      })
    }
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId,
      source: 'per_uid_get',
      intentFingerprint: 'payment-intent-fingerprint',
      operationId: 'operator-get-operation',
      operationKind: 'get',
      providerUid: 'payment-operator-diagnostics',
      apiVersion: '20260101',
      providerState: 'pending',
      outcome: 'confirmed',
      observedAt: 3_000,
    })
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId,
      source: 'webhook',
      intentFingerprint: 'payment-intent-fingerprint',
      providerState: 'pending',
      deliveryId: 'delivery-safe-id',
      providerEventId: 'event-safe-id',
      eventType: 'payto.payment.pending',
      providerPublishedAt: 3_100,
      observedAt: 3_200,
    })
    await ctx.db.insert('payToPaymentWebhookDeduplication', {
      payToPaymentId,
      outcome: 'duplicate_delivery',
      deliveryId: 'delivery-safe-id',
      observedAt: 3_300,
    })
    await ctx.db.insert('payToPaymentWebhookDeduplication', {
      payToPaymentId,
      outcome: 'duplicate_event',
      deliveryId: 'delivery-safe-id-two',
      providerEventId: 'event-safe-id',
      observedAt: 3_400,
    })
    return { operatorUserId, payToPaymentId }
  })
  return { t, ...ids }
}

test('refuses unauthenticated access to Payment diagnostics', async () => {
  const { t, payToPaymentId } = await setupPayment()

  await expect(
    t.query(api.payToPaymentOperators.diagnostics, {
      payToPaymentId,
      nowMs: 10_000,
    }),
  ).rejects.toThrow('signed in')
})

test('refuses diagnostics when the authenticated user lacks the Payment operator role', async () => {
  const { t, payToPaymentId } = await setupPayment(false)
  const signedIn = t.withIdentity(operatorIdentity)

  await expect(
    signedIn.query(api.payToPaymentOperators.diagnostics, {
      payToPaymentId,
      nowMs: 10_000,
    }),
  ).rejects.toThrow('not a Payment operator')
})

test('returns bounded operational summaries without routing, auth, or lease secrets', async () => {
  const { t, payToPaymentId } = await setupPayment()

  const diagnostics = await t
    .withIdentity(operatorIdentity)
    .query(api.payToPaymentOperators.diagnostics, {
      payToPaymentId,
      nowMs: 10 * 60_000,
    })

  expect(diagnostics).toMatchObject({
    gate: {
      mode: 'reconcile_only',
      dailyPaymentCountCap: 10,
      rollout: {
        cohortConfigured: false,
        approvalReferenceCount: 0,
      },
    },
    certification: {
      configured: false,
      certifiedCommit: null,
      configurationFingerprint: null,
      apiVersion: '20260101',
      environment: 'sandbox',
    },
    identity: {
      payToPaymentId,
      providerUid: 'payment-operator-diagnostics',
    },
    lifecycle: {
      creationState: 'provider_established',
      state: 'pending',
    },
    verification: { lastReconciledAt: 3_000 },
    attention: { payment: null, operationalAlert: null },
    work: {
      creation: { state: 'completed' },
      reconciliation: { state: 'queued', availableAt: 4_000 },
      retry: { state: 'stopped', retryNumber: 1 },
    },
    lease: { activeCount: 0, expiredCount: 0 },
    budget: {
      createPostAttempts: 1,
      retryEndpointCalls: 1,
      possiblyAcceptedRetrySubmissions: 1,
      rolling24HourSubmissions: 2,
    },
    webhook: {
      observedCount: 1,
      lastObservedAt: 3_200,
      deduplicationOutcomes: [
        expect.objectContaining({ outcome: 'duplicate_event' }),
        expect.objectContaining({ outcome: 'duplicate_delivery' }),
      ],
    },
    dueWork: {
      nextDueAt: 4_000,
      overdue: true,
    },
    operatorActions: [],
  })
  expect(diagnostics.evidence).toHaveLength(2)
  const serialized = JSON.stringify(diagnostics)
  for (const secret of [
    operatorIdentity.tokenIdentifier,
    'creditor-ciphertext-sensitive',
    'debtor-ciphertext-sensitive',
    'creditor-nonce-sensitive',
    'debtor-nonce-sensitive',
    'lease-token-sensitive',
    'operator-submission-key-sensitive',
  ]) {
    expect(serialized).not.toContain(secret)
  }
})

test('lets a Payment operator request immediate GET reconciliation and audits the server-derived actor', async () => {
  const { t, operatorUserId, payToPaymentId } = await setupPayment()
  await t.run(async (ctx) => {
    const work = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', payToPaymentId),
      )
      .unique()
    if (!work) throw new Error('Expected reconciliation work')
    await ctx.db.patch('payToPaymentReconciliationWorkItems', work._id, {
      state: 'stopped',
    })
  })

  const requestedAt = Date.now()
  const result = await t
    .withIdentity(operatorIdentity)
    .mutation(api.payToPaymentOperators.requestReconciliation, {
      payToPaymentId,
      reason: 'verify_payment_outcome',
    })

  expect(result).toEqual({ decision: 'authorized', code: 'scheduled' })
  const state = await t.run(async (ctx) => ({
    work: await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', payToPaymentId),
      )
      .unique(),
    actions: await ctx.db
      .query('payToPaymentOperatorActions')
      .withIndex('by_payToPaymentId_and_requestedAt', (q) =>
        q.eq('payToPaymentId', payToPaymentId),
      )
      .take(10),
  }))
  expect(state.work).toMatchObject({ state: 'queued' })
  expect(state.work!.availableAt).toBeLessThanOrEqual(requestedAt)
  expect(state.actions).toEqual([
    expect.objectContaining({
      actorUserId: operatorUserId,
      authentication: 'authenticated',
      authorization: 'payment_operator',
      action: 'request_reconciliation',
      reason: 'verify_payment_outcome',
      decision: 'authorized',
      resultCode: 'scheduled',
    }),
  ])
})

test('audits unauthenticated, insufficient-role, and already-due reconciliation requests', async () => {
  const unauthenticated = await setupPayment()
  await expect(
    unauthenticated.t.mutation(
      api.payToPaymentOperators.requestReconciliation,
      {
        payToPaymentId: unauthenticated.payToPaymentId,
        reason: 'respond_to_alert',
      },
    ),
  ).resolves.toEqual({ decision: 'refused', code: 'unauthenticated' })

  const insufficient = await setupPayment(false)
  await expect(
    insufficient.t
      .withIdentity(operatorIdentity)
      .mutation(api.payToPaymentOperators.requestReconciliation, {
        payToPaymentId: insufficient.payToPaymentId,
        reason: 'recover_stalled_work',
      }),
  ).resolves.toEqual({ decision: 'refused', code: 'insufficient_role' })

  const alreadyDue = await setupPayment()
  await expect(
    alreadyDue.t
      .withIdentity(operatorIdentity)
      .mutation(api.payToPaymentOperators.requestReconciliation, {
        payToPaymentId: alreadyDue.payToPaymentId,
        reason: 'investigate_provider_state',
      }),
  ).resolves.toEqual({ decision: 'no_op', code: 'already_due' })

  const decisions = await Promise.all(
    [unauthenticated, insufficient, alreadyDue].map(({ t, payToPaymentId }) =>
      t.run(async (ctx) => {
        const action = await ctx.db
          .query('payToPaymentOperatorActions')
          .withIndex('by_payToPaymentId_and_requestedAt', (q) =>
            q.eq('payToPaymentId', payToPaymentId),
          )
          .unique()
        return action?.decision
      }),
    ),
  )
  expect(decisions).toEqual(['refused', 'refused', 'no_op'])
})

test('rejects impersonation, lifecycle forcing, and unbounded reasons at the public boundary', async () => {
  const { t, payToPaymentId } = await setupPayment()
  const operator = t.withIdentity(operatorIdentity)

  await expect(
    operator.mutation(api.payToPaymentOperators.requestReconciliation, {
      payToPaymentId,
      reason: 'verify_payment_outcome',
      operatorIdentity: 'https://attacker.example|impersonated_operator',
    } as never),
  ).rejects.toThrow()
  await expect(
    operator.mutation(api.payToPaymentOperators.requestReconciliation, {
      payToPaymentId,
      reason: 'verify_payment_outcome',
      lifecycleState: 'settled',
    } as never),
  ).rejects.toThrow()
  await expect(
    operator.mutation(api.payToPaymentOperators.requestReconciliation, {
      payToPaymentId,
      reason: 'include arbitrary provider detail here',
    } as never),
  ).rejects.toThrow()
})

test('routes resume through Payment policy without clearing attention or changing lifecycle truth', async () => {
  const { t, payToPaymentId } = await setupPayment()
  const before = await t.run(async (ctx) => {
    await ctx.db.patch('payToPayments', payToPaymentId, {
      creationState: 'creation_attention_required',
      attention: {
        kind: 'creation_recovery_required',
        reason: 'recovery_exhausted',
        observedAt: 8_000,
      },
    })
    return await ctx.db.get('payToPayments', payToPaymentId)
  })

  const result = await t
    .withIdentity(operatorIdentity)
    .mutation(api.payToPaymentOperators.requestResume, {
      payToPaymentId,
      reason: 'recover_stalled_work',
    })

  expect(result).toEqual({
    decision: 'refused',
    code: 'attention_required',
  })
  const after = await t.run(async (ctx) => ({
    payment: await ctx.db.get('payToPayments', payToPaymentId),
    action: await ctx.db
      .query('payToPaymentOperatorActions')
      .withIndex('by_payToPaymentId_and_requestedAt', (q) =>
        q.eq('payToPaymentId', payToPaymentId),
      )
      .unique(),
  }))
  expect(after.payment).toEqual(before)
  expect(after.action).toMatchObject({
    action: 'request_resume',
    decision: 'refused',
    resultCode: 'attention_required',
  })
})

test('allows a safe resume to restart only GET tracking', async () => {
  const { t, payToPaymentId } = await setupPayment()
  const before = await t.run(async (ctx) => {
    const work = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', payToPaymentId),
      )
      .unique()
    if (!work) throw new Error('Expected reconciliation work')
    await ctx.db.patch('payToPaymentReconciliationWorkItems', work._id, {
      state: 'stopped',
    })
    const payment = await ctx.db.get('payToPayments', payToPaymentId)
    const retryOperations = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_payToPaymentId_and_operationKind_and_authorizedAt', (q) =>
        q.eq('payToPaymentId', payToPaymentId).eq('operationKind', 'retry'),
      )
      .take(10)
    return {
      immutable: {
        providerUid: payment?.providerUid,
        intent: payment?.intent,
        lifecycleState: payment?.lifecycleState,
        confirmedFailure: payment?.confirmedFailure,
        creationRecovery: payment?.creationRecovery,
      },
      retryOperationCount: retryOperations.length,
    }
  })

  await expect(
    t
      .withIdentity(operatorIdentity)
      .mutation(api.payToPaymentOperators.requestResume, {
        payToPaymentId,
        reason: 'recover_stalled_work',
      }),
  ).resolves.toEqual({ decision: 'authorized', code: 'scheduled' })

  const after = await t.run(async (ctx) => {
    const payment = await ctx.db.get('payToPayments', payToPaymentId)
    const work = await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .withIndex('by_payToPaymentId', (q) =>
        q.eq('payToPaymentId', payToPaymentId),
      )
      .unique()
    const retryOperations = await ctx.db
      .query('payToPaymentOperations')
      .withIndex('by_payToPaymentId_and_operationKind_and_authorizedAt', (q) =>
        q.eq('payToPaymentId', payToPaymentId).eq('operationKind', 'retry'),
      )
      .take(10)
    return {
      immutable: {
        providerUid: payment?.providerUid,
        intent: payment?.intent,
        lifecycleState: payment?.lifecycleState,
        confirmedFailure: payment?.confirmedFailure,
        creationRecovery: payment?.creationRecovery,
      },
      work,
      retryOperations,
    }
  })
  expect(after.immutable).toEqual(before.immutable)
  expect(after.work).toMatchObject({ state: 'queued' })
  expect(after.retryOperations).toHaveLength(before.retryOperationCount)
})
