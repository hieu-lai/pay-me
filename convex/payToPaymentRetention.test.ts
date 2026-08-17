/// <reference types="vite/client" />

import { convexTest } from 'convex-test'
import { expect, test } from 'vitest'

import { internal } from './_generated/api'
import {
  paymentAuditCutoff,
  paymentAuditExpiresAt,
} from './lib/payToPaymentRetentionPolicy'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const DAY_MS = 24 * 60 * 60_000

test('retains leap-day audit evidence through its full calendar anniversary', () => {
  expect(paymentAuditExpiresAt(Date.UTC(2028, 1, 29))).toBe(
    Date.UTC(2035, 2, 1),
  )
  expect(paymentAuditCutoff(Date.UTC(2032, 1, 29))).toBe(Date.UTC(2025, 1, 28))
})

async function setupRetentionFixture() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|retention-requester',
      clerkUserId: 'retention-requester',
      email: 'requester@example.test',
      displayName: 'Retention Requester',
      searchText: 'Retention Requester',
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|retention-payer',
      clerkUserId: 'retention-payer',
      email: 'payer@example.test',
      displayName: 'Retention Payer',
      searchText: 'Retention Payer',
    })
    const creditorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: requesterUserId,
      type: 'bban',
      searchLabel: 'requester',
      maskedDisplay: '123456••••345',
      fingerprint: 'retention-creditor-fingerprint',
      ciphertext: 'encrypted-creditor-routing',
      nonce: 'creditor-nonce',
      keyVersion: 'v1',
    })
    const debtorDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: payerUserId,
      type: 'bban',
      searchLabel: 'payer',
      maskedDisplay: '654321••••765',
      fingerprint: 'retention-debtor-fingerprint',
      ciphertext: 'encrypted-debtor-routing',
      nonce: 'debtor-nonce',
      keyVersion: 'v1',
    })
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: 'Retention Requester',
      amountCents: 1_250,
      currency: 'AUD',
      purpose: 'other',
      description: 'Retention fixture',
      submissionKey: 'retention-submission-key',
      submissionFingerprint: 'retention-submission-fingerprint',
      sourceCreditorPaymentDestinationId: creditorDestinationId,
      creditorSnapshot: {
        kind: 'bban',
        maskedDisplay: '123456••••345',
        ciphertext: 'encrypted-creditor-routing',
        nonce: 'creditor-nonce',
        keyVersion: 'v1',
      },
      submittedAt: 1,
    })
    const payToAgreementId = await ctx.db.insert('payToAgreements', {
      moneyRequestId,
      payerUserId,
      payerNameSnapshot: 'Retention Payer',
      sourceDebtorPaymentDestinationId: debtorDestinationId,
      debtorSnapshot: {
        kind: 'bban',
        maskedDisplay: '654321••••765',
        ciphertext: 'encrypted-debtor-routing',
        nonce: 'debtor-nonce',
        keyVersion: 'v1',
      },
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: 'retention-agreement-provider-uid',
      creationState: 'created',
      creationUpdatedAt: 1,
      lifecycleState: 'active',
      lifecycleConfidence: 'confirmed',
      lifecycleObservedAt: 1,
      trackingState: 'current',
      trackingUpdatedAt: 1,
    })
    const payToPaymentId = await ctx.db.insert('payToPayments', {
      payToAgreementId,
      moneyRequestId,
      payerUserId,
      environment: 'sandbox',
      providerUid: 'retention-payment-provider-uid',
      intent: {
        agreementProviderUid: 'retention-agreement-provider-uid',
        amount: { cents: 1_250, currency: 'AUD' },
        routing: {
          sourceCreditorPaymentDestinationId: creditorDestinationId,
          sourceDebtorPaymentDestinationId: debtorDestinationId,
          creditorSnapshot: {
            kind: 'bban',
            maskedDisplay: '123456••••345',
            ciphertext: 'encrypted-creditor-routing',
            nonce: 'creditor-nonce',
            keyVersion: 'v1',
          },
          debtorSnapshot: {
            kind: 'bban',
            maskedDisplay: '654321••••765',
            ciphertext: 'encrypted-debtor-routing',
            nonce: 'debtor-nonce',
            keyVersion: 'v1',
          },
        },
        priority: 'unattended',
        apiVersion: '20260101',
        fingerprint: 'retention-intent-fingerprint',
      },
      creationState: 'provider_established',
      establishedAt: 1,
      auditExpiresAt: Date.UTC(2035, 0, 1),
      lifecycleState: 'settled',
      lifecycleObservedAt: 1,
    })
    const expiringPayment = await ctx.db.get('payToPayments', payToPaymentId)
    if (!expiringPayment) throw new Error('Expected retention Payment')
    const {
      _id: _expiredId,
      _creationTime: _expiredCreationTime,
      ...expiredPayment
    } = expiringPayment
    const expiredPayToPaymentId = await ctx.db.insert('payToPayments', {
      ...expiredPayment,
      providerUid: 'retention-expired-payment-provider-uid',
    })
    const {
      _id: _expiringId,
      _creationTime: _expiringCreationTime,
      auditExpiresAt: _auditExpiresAt,
      ...unresolvedPayment
    } = expiringPayment
    const unresolvedPayToPaymentId = await ctx.db.insert('payToPayments', {
      ...unresolvedPayment,
      providerUid: 'retention-unresolved-payment-provider-uid',
      lifecycleState: 'pending',
    })
    return {
      payToAgreementId,
      payToPaymentId,
      expiredPayToPaymentId,
      unresolvedPayToPaymentId,
    }
  })
  return { t, ...ids }
}

test('deletes only category-expired records at the seven-year, 90-day, and 30-day boundaries', async () => {
  const {
    t,
    payToAgreementId,
    payToPaymentId,
    expiredPayToPaymentId,
    unresolvedPayToPaymentId,
  } = await setupRetentionFixture()
  const nowMs = Date.UTC(2035, 0, 1)
  const auditCutoff = Date.UTC(2028, 0, 1)
  const workCutoff = nowMs - 90 * DAY_MS
  const rejectedCutoff = nowMs - 30 * DAY_MS

  await t.run(async (ctx) => {
    for (const observedAt of [auditCutoff, auditCutoff + 1]) {
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId,
        kind: 'local_accepted',
        observedAt,
      })
      await ctx.db.insert('payToPaymentEvidence', {
        payToPaymentId,
        source: 'per_uid_get',
        intentFingerprint: 'retention-intent-fingerprint',
        outcome: 'confirmed',
        observedAt,
      })
      await ctx.db.insert('payToPaymentWebhookDeduplication', {
        payToPaymentId,
        outcome: 'duplicate_delivery',
        deliveryId: `delivery-${observedAt}`,
        observedAt,
      })
      await ctx.db.insert('payToPaymentOperations', {
        payToPaymentId,
        operationId: `operation-${observedAt}`,
        operationKind: 'get',
        intentFingerprint: 'retention-intent-fingerprint',
        authorizedAt: observedAt,
      })
      await ctx.db.insert('payToPaymentOperatorActions', {
        payToPaymentId,
        authentication: 'authenticated',
        authorization: 'payment_operator',
        action: 'request_reconciliation',
        reason: 'verify_payment_outcome',
        decision: 'authorized',
        resultCode: 'scheduled',
        requestedAt: observedAt,
      })
      await ctx.db.insert('zeptoWebhookDeliveries', {
        deliveryId: `audit-delivery-${observedAt}`,
        signatureTimestamp: observedAt,
        receivedAt: observedAt,
      })
      await ctx.db.insert('zeptoWebhookEvents', {
        providerEventId: `audit-event-${observedAt}`,
        eventType: 'payto_payment.pending',
        resourceUid: 'retention-payment-provider-uid',
        providerPublishedAt: observedAt,
        deliveryId: `audit-delivery-${observedAt}`,
        observedAt,
      })
    }
    for (const availableAt of [workCutoff, workCutoff + 1]) {
      await ctx.db.insert('payToPaymentWorkItems', {
        payToPaymentId,
        kind: 'create',
        state: 'completed',
        availableAt,
        completedAt: availableAt,
      })
      await ctx.db.insert('payToPaymentReconciliationWorkItems', {
        payToPaymentId,
        state: 'stopped',
        availableAt,
      })
      await ctx.db.insert('payToPaymentRetryWorkItems', {
        payToPaymentId,
        state: 'stopped',
        retryNumber: 1,
        availableAt,
      })
      await ctx.db.insert('payToAgreementWorkItems', {
        payToAgreementId,
        kind: 'create',
        state: 'completed',
        availableAt: 1,
        completedAt: availableAt,
      })
      await ctx.db.insert('payToAgreementReconciliationWorkItems', {
        payToAgreementId,
        providerUid: 'retention-agreement-provider-uid',
        state: 'stopped',
        availableAt: 1,
        stoppedAt: availableAt,
      })
    }
    await ctx.db.insert('payToPaymentOperations', {
      payToPaymentId,
      operationId: 'mechanics-boundary-operation',
      operationKind: 'get',
      intentFingerprint: 'retention-intent-fingerprint',
      authorizedAt: workCutoff,
      leaseToken: 'sensitive-expired-operation-lease',
      leaseExpiresAt: workCutoff,
    })
    await ctx.db.insert('payToPaymentEvidence', {
      payToPaymentId,
      source: 'per_uid_get',
      intentFingerprint: 'retention-intent-fingerprint',
      observedAt: workCutoff,
      leaseToken: 'sensitive-expired-evidence-lease',
      operationLeaseExpiresAt: workCutoff,
    })
    await ctx.db.insert('payToPaymentReconciliationWorkItems', {
      payToPaymentId,
      state: 'queued',
      availableAt: workCutoff - 1,
    })
    await ctx.db.insert('payToPaymentRetryWorkItems', {
      payToPaymentId,
      state: 'locked',
      retryNumber: 1,
      availableAt: workCutoff - 1,
    })
    for (const observedAt of [rejectedCutoff, rejectedCutoff + 1]) {
      await ctx.db.insert('zeptoWebhookRejections', {
        reason: 'invalid_signature',
        deliveryId: `rejected-${observedAt}`,
        payloadHash: `hash-${observedAt}`,
        observedAt,
      })
    }
  })

  await expect(
    t.mutation(internal.payToPaymentRetention.cleanupExpired, {
      nowMs,
      batchSize: 100,
    }),
  ).resolves.toEqual({
    auditEvidenceDeleted: 8,
    completedWorkDeleted: 5,
    leaseMechanicsRetired: 4,
    rejectedDeliveryMetadataDeleted: 1,
    continuationScheduled: false,
  })

  const remaining = await t.run(async (ctx) => ({
    payment: await ctx.db.get('payToPayments', payToPaymentId),
    expiredPayment: await ctx.db.get('payToPayments', expiredPayToPaymentId),
    unresolvedPayment: await ctx.db.get(
      'payToPayments',
      unresolvedPayToPaymentId,
    ),
    agreementEvidence: await ctx.db.query('payToAgreementEvidence').take(10),
    paymentEvidence: await ctx.db.query('payToPaymentEvidence').take(10),
    deduplication: await ctx.db
      .query('payToPaymentWebhookDeduplication')
      .take(10),
    operations: await ctx.db.query('payToPaymentOperations').take(10),
    operatorActions: await ctx.db.query('payToPaymentOperatorActions').take(10),
    deliveries: await ctx.db.query('zeptoWebhookDeliveries').take(10),
    events: await ctx.db.query('zeptoWebhookEvents').take(10),
    creationWork: await ctx.db.query('payToPaymentWorkItems').take(10),
    reconciliationWork: await ctx.db
      .query('payToPaymentReconciliationWorkItems')
      .take(10),
    retryWork: await ctx.db.query('payToPaymentRetryWorkItems').take(10),
    agreementCreationWork: await ctx.db
      .query('payToAgreementWorkItems')
      .take(10),
    agreementReconciliationWork: await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .take(10),
    retiredIdentities: await ctx.db
      .query('payToPaymentRetiredIdentities')
      .take(10),
    rejections: await ctx.db.query('zeptoWebhookRejections').take(10),
  }))
  expect(remaining.payment?.auditExpiresAt).toBe(
    paymentAuditExpiresAt(workCutoff),
  )
  expect(remaining.expiredPayment).toBeNull()
  expect(remaining.unresolvedPayment).not.toBeNull()
  expect(remaining.agreementEvidence).toHaveLength(1)
  expect(remaining.paymentEvidence).toHaveLength(2)
  expect(remaining.deduplication).toHaveLength(1)
  expect(remaining.operations).toHaveLength(2)
  expect(remaining.operatorActions).toHaveLength(1)
  expect(remaining.deliveries).toHaveLength(1)
  expect(remaining.events).toHaveLength(1)
  expect(remaining.creationWork).toHaveLength(1)
  expect(remaining.reconciliationWork).toHaveLength(2)
  expect(remaining.retryWork).toHaveLength(2)
  expect(remaining.agreementCreationWork).toHaveLength(1)
  expect(remaining.agreementReconciliationWork).toHaveLength(1)
  expect(remaining.retiredIdentities).toEqual([
    expect.objectContaining({ payToAgreementId }),
  ])
  expect(remaining.rejections).toHaveLength(1)
  expect(JSON.stringify(remaining)).not.toContain(
    'sensitive-expired-operation-lease',
  )
  expect(JSON.stringify(remaining)).not.toContain(
    'sensitive-expired-evidence-lease',
  )

  await expect(
    t.mutation(internal.payToPaymentRetention.cleanupExpired, {
      nowMs,
      batchSize: 100,
    }),
  ).resolves.toMatchObject({
    auditEvidenceDeleted: 0,
    completedWorkDeleted: 0,
    leaseMechanicsRetired: 0,
    rejectedDeliveryMetadataDeleted: 0,
  })
})

test('bounds each cleanup pass and schedules resumable continuation', async () => {
  const { t } = await setupRetentionFixture()
  const nowMs = Date.UTC(2035, 0, 1)
  await t.run(async (ctx) => {
    for (let index = 0; index < 3; index += 1) {
      await ctx.db.insert('zeptoWebhookRejections', {
        reason: 'missing_headers',
        deliveryId: `bounded-rejection-${index}`,
        observedAt: nowMs - 31 * DAY_MS - index,
      })
    }
  })

  await expect(
    t.mutation(internal.payToPaymentRetention.cleanupExpired, {
      nowMs,
      batchSize: 2,
    }),
  ).resolves.toMatchObject({
    rejectedDeliveryMetadataDeleted: 2,
    continuationScheduled: true,
  })
  await expect(
    t.run(async (ctx) => ctx.db.query('zeptoWebhookRejections').take(10)),
  ).resolves.toHaveLength(1)
})

test('retired Payment identity prevents duplicate initiation after audit deletion', async () => {
  const { t, payToAgreementId } = await setupRetentionFixture()
  await t.run(async (ctx) => {
    const payments = await ctx.db
      .query('payToPayments')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', payToAgreementId),
      )
      .take(10)
    for (const payment of payments) {
      await ctx.db.delete('payToPayments', payment._id)
    }
    await ctx.db.insert('payToPaymentRetiredIdentities', {
      payToAgreementId,
      retiredAt: Date.UTC(2035, 0, 1),
    })
    await ctx.db.patch('payToAgreements', payToAgreementId, {
      activationProvenancePolicy: 'track_first_confirmation',
      firstConfirmedActiveAt: 1,
      lifecycleState: 'active',
      lifecycleConfidence: 'confirmed',
    })
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'sandbox',
      mode: 'enabled_for_new_confirmations',
      activatedAt: 0,
    })
  })

  await expect(
    t.mutation(internal.payToPayments.ensure, {
      payToAgreementId,
      observedAt: Date.UTC(2035, 0, 2),
    }),
  ).resolves.toEqual({
    kind: 'ineligible',
    reason: 'agreement_not_eligible',
  })
  await expect(
    t.run((ctx) =>
      ctx.db
        .query('payToPayments')
        .withIndex('by_payToAgreementId', (q) =>
          q.eq('payToAgreementId', payToAgreementId),
        )
        .take(10),
    ),
  ).resolves.toHaveLength(0)
})
