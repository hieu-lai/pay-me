/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { api } from './_generated/api'
import { handleZeptoWebhook } from './http'
import schema from './schema'
import type { ZeptoEnvironment } from './validators/payToAgreements'

const modules = import.meta.glob('./**/*.ts')
const webhookSecret = 'whsec_zepto_lifecycle_test_secret'
const requesterIdentity = {
  tokenIdentifier: 'https://clerk.example.test|requester_webhook',
  subject: 'requester_webhook',
  issuer: 'https://clerk.example.test',
  name: 'Webhook Requester',
} satisfies UserIdentity

function toHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function signedDelivery(
  deliveryId: string,
  payload: unknown,
  timestamp = Math.floor(Date.now() / 1_000),
) {
  const body = JSON.stringify(payload)
  const message = new TextEncoder().encode(`${timestamp}.${body}`)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, message)
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'split-request-id': deliveryId,
      'split-signature': `${timestamp}.${toHex(digest)}`,
    },
  }
}

async function setupAgreement(
  providerUid = 'agreement_webhook_1',
  environment: ZeptoEnvironment = 'sandbox',
) {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: requesterIdentity.tokenIdentifier,
      clerkUserId: requesterIdentity.subject,
      email: 'requester@example.test',
      displayName: requesterIdentity.name,
      searchText: requesterIdentity.name,
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payer_webhook',
      clerkUserId: 'payer_webhook',
      email: 'payer@example.test',
      displayName: 'Webhook Payer',
      searchText: 'Webhook Payer',
    })
    const requesterDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: requesterUserId,
      type: 'bban',
      searchLabel: 'requester',
      maskedDisplay: '123456••••345',
      fingerprint: 'requester-fingerprint',
      ciphertext: 'requester-ciphertext',
      nonce: 'requester-nonce',
      keyVersion: 'v1',
    })
    const payerDestinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: payerUserId,
      type: 'bban',
      searchLabel: 'payer',
      maskedDisplay: '654321••••765',
      fingerprint: 'payer-fingerprint',
      ciphertext: 'payer-ciphertext',
      nonce: 'payer-nonce',
      keyVersion: 'v1',
    })
    const submittedAt = Date.now() - 60_000
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: requesterIdentity.name,
      amountCents: 1250,
      currency: 'AUD',
      purpose: 'other',
      description: 'Lunch',
      submissionKey: '018f22e2-7c00-7000-8000-000000000019',
      submissionFingerprint: 'webhook-fingerprint',
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
      payerNameSnapshot: 'Webhook Payer',
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
      providerUid,
      activationProvenancePolicy: 'track_first_confirmation',
      creationState: 'created',
      creationUpdatedAt: submittedAt,
      lifecycleState: 'pending',
      lifecycleConfidence: 'provisional',
      lifecycleObservedAt: submittedAt,
      trackingState: 'verification_due',
      trackingUpdatedAt: submittedAt,
    })
    return { moneyRequestId, payToAgreementId }
  })
  return { t, requester: t.withIdentity(requesterIdentity), ...ids }
}

async function setupPayment(providerUid = 'payment_webhook_1') {
  const setup = await setupAgreement()
  const payToPaymentId = await setup.t.run(async (ctx) => {
    const agreement = await ctx.db.get(
      'payToAgreements',
      setup.payToAgreementId,
    )
    const moneyRequest = await ctx.db.get('moneyRequests', setup.moneyRequestId)
    if (!agreement || !moneyRequest) throw new Error('Expected Payment setup')

    const establishedAt = Date.now() - 60_000
    const id = await ctx.db.insert('payToPayments', {
      payToAgreementId: agreement._id,
      moneyRequestId: moneyRequest._id,
      payerUserId: agreement.payerUserId,
      environment: agreement.environment,
      providerUid,
      intent: {
        agreementProviderUid: agreement.providerUid,
        amount: { cents: moneyRequest.amountCents, currency: 'AUD' },
        routing: {
          sourceCreditorPaymentDestinationId:
            moneyRequest.sourceCreditorPaymentDestinationId,
          sourceDebtorPaymentDestinationId:
            agreement.sourceDebtorPaymentDestinationId,
          creditorSnapshot: moneyRequest.creditorSnapshot,
          debtorSnapshot: agreement.debtorSnapshot,
        },
        priority: 'unattended',
        apiVersion: '20260101',
        fingerprint: 'payment-webhook-intent-fingerprint',
      },
      creationState: 'provider_established',
      establishedAt,
      lifecycleState: 'pending',
      lifecycleObservedAt: establishedAt,
      lastReconciledAt: establishedAt,
    })
    await ctx.db.insert('payToPaymentReconciliationWorkItems', {
      payToPaymentId: id,
      state: 'queued',
      availableAt: establishedAt + 60 * 60_000,
    })
    return id
  })
  return { ...setup, payToPaymentId, paymentProviderUid: providerUid }
}

async function durableWebhookState(
  t: Awaited<ReturnType<typeof setupAgreement>>['t'],
) {
  return await t.run(async (ctx) => ({
    deliveries: await ctx.db.query('zeptoWebhookDeliveries').collect(),
    events: await ctx.db.query('zeptoWebhookEvents').collect(),
    evidence: await ctx.db.query('payToAgreementEvidence').collect(),
    reconciliation: await ctx.db
      .query('payToAgreementReconciliationWorkItems')
      .collect(),
  }))
}

beforeEach(() => {
  process.env.ZEPTO_ENVIRONMENT = 'sandbox'
  process.env.ZEPTO_WEBHOOK_SIGNING_SECRET = webhookSecret
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /zepto/webhooks', () => {
  test('durably observes mixed PayTo Agreement and PayTo Payment events and immediately reconciles both', async () => {
    const { t, payToAgreementId, payToPaymentId, paymentProviderUid } =
      await setupPayment()
    const request = await signedDelivery('delivery-agreement-and-payment', {
      data: [
        {
          id: 'event-agreement-suspended',
          type: 'payto_agreement.suspended',
          published_at: '2026-08-11T01:02:03.000Z',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
        },
        {
          id: 'event-payment-settled',
          type: 'payto_payment.settled',
          published_at: '2026-08-11T01:02:04.000Z',
          resource_uid: paymentProviderUid,
          resource_type: 'payto_payment',
        },
      ],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    const durable = await t.run(async (ctx) => ({
      agreement: await ctx.db.get('payToAgreements', payToAgreementId),
      payment: await ctx.db.get('payToPayments', payToPaymentId),
      delivery: await ctx.db
        .query('zeptoWebhookDeliveries')
        .withIndex('by_deliveryId', (q) =>
          q.eq('deliveryId', 'delivery-agreement-and-payment'),
        )
        .unique(),
      events: await ctx.db.query('zeptoWebhookEvents').collect(),
      paymentEvidence: await ctx.db.query('payToPaymentEvidence').collect(),
      agreementWork: await ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .unique(),
      paymentWork: await ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .unique(),
    }))
    expect(durable.delivery).toMatchObject({
      deliveryId: 'delivery-agreement-and-payment',
      payloadHash: expect.any(String),
    })
    expect(durable.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: 'event-agreement-suspended',
          resourceType: 'payto_agreement',
          classification: 'supported_agreement',
        }),
        expect.objectContaining({
          providerEventId: 'event-payment-settled',
          resourceType: 'payto_payment',
          classification: 'supported_payment',
        }),
      ]),
    )
    expect(durable.agreement).toMatchObject({
      lifecycleState: 'suspended',
      lifecycleConfidence: 'provisional',
    })
    expect(durable.payment).toMatchObject({ lifecycleState: 'pending' })
    expect(durable.paymentEvidence).toEqual([
      expect.objectContaining({
        source: 'webhook',
        providerState: 'settled',
      }),
    ])
    expect(durable.agreementWork).toMatchObject({
      availableAt: expect.any(Number),
      state: 'queued',
    })
    expect(durable.paymentWork).toMatchObject({
      availableAt: expect.any(Number),
      state: 'queued',
    })
    expect(durable.paymentWork?.availableAt).toBeLessThan(Date.now() + 60_000)
    expect(durable.delivery).not.toHaveProperty('body')
    expect(durable.delivery).not.toHaveProperty('rawBody')
  })

  test('classifies signed unsupported and unknown-UID events without semantic changes', async () => {
    const { t, payToPaymentId, paymentProviderUid } = await setupPayment()
    const request = await signedDelivery('delivery-unsupported-events', {
      data: [
        {
          id: 'event-payment-future-state',
          type: 'payto_payment.future_state',
          published_at: '2026-08-11T01:02:04.000Z',
          resource_uid: paymentProviderUid,
          resource_type: 'payto_payment',
          body: { detail: 'must not be retained' },
        },
        {
          id: 'event-refund-unsupported',
          type: 'payto_refund.failed',
          published_at: '2026-08-11T01:02:05.000Z',
          resource_uid: 'refund_unknown_1',
          resource_type: 'payto_refund',
        },
        {
          id: 'event-payment-unknown-uid',
          type: 'payto_payment.pending',
          published_at: '2026-08-11T01:02:06.000Z',
          resource_uid: 'payment_unknown_1',
          resource_type: 'payto_payment',
        },
      ],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    const durable = await t.run(async (ctx) => ({
      payment: await ctx.db.get('payToPayments', payToPaymentId),
      events: await ctx.db.query('zeptoWebhookEvents').collect(),
      paymentEvidence: await ctx.db.query('payToPaymentEvidence').collect(),
      paymentWork: await ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .unique(),
    }))
    expect(durable.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerEventId: 'event-payment-future-state',
          classification: 'unsupported_event',
        }),
        expect.objectContaining({
          providerEventId: 'event-refund-unsupported',
          classification: 'unsupported_resource',
        }),
        expect.objectContaining({
          providerEventId: 'event-payment-unknown-uid',
          classification: 'supported_payment',
        }),
      ]),
    )
    expect(durable.events[0]).not.toHaveProperty('body')
    expect(durable.payment).toMatchObject({ lifecycleState: 'pending' })
    expect(durable.paymentEvidence).toEqual([
      expect.objectContaining({
        providerEventId: 'event-payment-future-state',
        source: 'webhook',
      }),
    ])
    expect(durable.paymentEvidence[0]).not.toHaveProperty('providerState')
    expect(durable.paymentWork?.availableAt).toBeLessThan(Date.now() + 60_000)
  })

  test('routes a PayTo Payment event by resource type even when its UID matches a PayTo Agreement UID', async () => {
    const { t, payToPaymentId, paymentProviderUid } = await setupPayment(
      'agreement_webhook_1',
    )
    const request = await signedDelivery('delivery-shared-resource-uid', {
      data: {
        id: 'event-shared-resource-uid',
        type: 'payto_payment.pending',
        published_at: '2026-08-11T01:02:04.000Z',
        resource_uid: paymentProviderUid,
        resource_type: 'payto_payment',
      },
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    const durable = await t.run(async (ctx) => ({
      evidence: await ctx.db.query('payToPaymentEvidence').collect(),
      agreementEvidence: await ctx.db.query('payToAgreementEvidence').collect(),
      agreementWork: await ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .collect(),
      work: await ctx.db
        .query('payToPaymentReconciliationWorkItems')
        .withIndex('by_payToPaymentId', (q) =>
          q.eq('payToPaymentId', payToPaymentId),
        )
        .unique(),
    }))
    expect(durable.evidence).toHaveLength(1)
    expect(durable.agreementEvidence).toEqual([])
    expect(durable.agreementWork).toEqual([])
    expect(durable.work?.availableAt).toBeLessThan(Date.now() + 60_000)
  })

  test('atomically rejects a malformed PayTo Payment item', async () => {
    const { t, paymentProviderUid } = await setupPayment()
    const request = await signedDelivery('delivery-malformed-payment', {
      data: [
        {
          id: 'event-payment-valid',
          type: 'payto_payment.pending',
          published_at: '2026-08-11T01:02:04.000Z',
          resource_uid: paymentProviderUid,
          resource_type: 'payto_payment',
        },
        {
          id: 'event-payment-malformed',
          type: 'payto_payment.failed',
          resource_uid: paymentProviderUid,
          resource_type: 'payto_payment',
        },
      ],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(400)
    const durable = await t.run(async (ctx) => ({
      deliveries: await ctx.db.query('zeptoWebhookDeliveries').collect(),
      events: await ctx.db.query('zeptoWebhookEvents').collect(),
      evidence: await ctx.db.query('payToPaymentEvidence').collect(),
    }))
    expect(durable).toEqual({ deliveries: [], events: [], evidence: [] })
  })

  test('deduplicates replayed, reordered, and conflicting PayTo Payment events', async () => {
    const { t, payToPaymentId, paymentProviderUid } = await setupPayment()
    const settled = {
      id: 'event-payment-replayed',
      type: 'payto_payment.settled',
      published_at: '2026-08-11T01:02:04.000Z',
      resource_uid: paymentProviderUid,
      resource_type: 'payto_payment',
    }
    const first = await signedDelivery('delivery-payment-first', {
      data: [settled, settled],
    })
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...first })).status,
    ).toBe(200)
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...first })).status,
    ).toBe(200)

    const reordered = await signedDelivery('delivery-payment-reordered', {
      data: [
        settled,
        {
          ...settled,
          id: 'event-payment-older-failed',
          type: 'payto_payment.failed',
          published_at: '2026-08-11T01:02:03.000Z',
        },
      ],
    })
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...reordered }))
        .status,
    ).toBe(200)

    const durable = await t.run(async (ctx) => ({
      payment: await ctx.db.get('payToPayments', payToPaymentId),
      deliveries: await ctx.db.query('zeptoWebhookDeliveries').collect(),
      events: await ctx.db.query('zeptoWebhookEvents').collect(),
      evidence: await ctx.db.query('payToPaymentEvidence').collect(),
    }))
    expect(durable.deliveries).toHaveLength(2)
    expect(durable.events).toHaveLength(2)
    expect(durable.evidence).toHaveLength(2)
    expect(durable.payment).toMatchObject({ lifecycleState: 'pending' })
  })

  test('returns 500 when durable webhook intake fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const applyDelivery = vi.fn(async () => {
      throw new Error('storage unavailable')
    })
    const signed = await signedDelivery('delivery-storage-failure', {
      data: {
        id: 'event-storage-failure',
        type: 'payto_payment.pending',
        published_at: '2026-08-11T01:02:04.000Z',
        resource_uid: 'payment_storage_failure',
        resource_type: 'payto_payment',
      },
    })
    const response = await handleZeptoWebhook(
      new Request('https://example.convex.site/zepto/webhooks', {
        method: 'POST',
        ...signed,
      }),
      {
        signingSecret: webhookSecret,
        environment: 'sandbox',
        nowMs: Date.now,
        applyDelivery,
      },
    )

    expect(response.status).toBe(500)
    expect(applyDelivery).toHaveBeenCalledOnce()
    expect(applyDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'delivery-storage-failure',
        payloadHash: expect.any(String),
      }),
    )
  })

  test('returns bounded security telemetry for invalid authentication', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const applyDelivery = vi.fn(async () => undefined)
    const signed = await signedDelivery('delivery-invalid-auth', {
      data: {
        id: 'event-invalid-auth',
        type: 'payto_payment.pending',
        published_at: '2026-08-11T01:02:04.000Z',
        resource_uid: 'payment_invalid_auth',
        resource_type: 'payto_payment',
      },
    })
    const response = await handleZeptoWebhook(
      new Request('https://example.convex.site/zepto/webhooks', {
        method: 'POST',
        body: `${signed.body} `,
        headers: signed.headers,
      }),
      {
        signingSecret: webhookSecret,
        environment: 'sandbox',
        nowMs: Date.now,
        applyDelivery,
      },
    )

    expect(response.status).toBe(400)
    expect(applyDelivery).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('Zepto webhook verification failed', {
      reason: 'invalid_signature',
    })
  })

  test('accepts Zepto PayTo webhook deliveries with a single data object', async () => {
    const providerUid = '019ff0c0-b888-7c66-af96-63972ad43d51'
    const { t, payToAgreementId } = await setupAgreement(providerUid)
    const request = await signedDelivery('delivery-single-event', {
      data: {
        id: '019ff0c0-be3a-7565-90a9-6692c017fd33',
        body: {
          mms_agreement_id: '019ff0c0be2a1018855ca8ad15a339e8',
        },
        type: 'payto_agreement.activated',
        published_at: '2026-08-11T22:16:31.290+10:00',
        resource_uid: providerUid,
        resource_type: 'payto_agreement',
        resource_metadata: {},
      },
      links: {
        resource: `https://api.sandbox.zeptopayments.com/payto/agreements/${providerUid}`,
      },
    })

    const response = await t.fetch('/zepto/webhooks', {
      method: 'POST',
      ...request,
    })

    expect(response.status).toBe(200)
    expect(await durableWebhookState(t)).toMatchObject({
      deliveries: [
        expect.objectContaining({ deliveryId: 'delivery-single-event' }),
      ],
      events: [
        expect.objectContaining({
          providerEventId: '019ff0c0-be3a-7565-90a9-6692c017fd33',
          resourceUid: providerUid,
        }),
      ],
      evidence: [expect.objectContaining({ outcome: 'applied' })],
      reconciliation: [expect.objectContaining({ providerUid })],
    })
    await expect(
      t.run(async (ctx) => ctx.db.get('payToAgreements', payToAgreementId)),
    ).resolves.not.toHaveProperty('firstConfirmedActiveAt')
  })

  test('scopes webhook PayTo Agreement lookup to the configured production environment', async () => {
    process.env.ZEPTO_ENVIRONMENT = 'production'
    const providerUid = 'shared_environment_uid'
    const { t, payToAgreementId } = await setupAgreement(
      providerUid,
      'production',
    )
    const request = await signedDelivery('delivery-production-event', {
      data: {
        id: 'production-event',
        type: 'payto_agreement.activated',
        published_at: '2026-08-11T22:16:31.290+10:00',
        resource_uid: providerUid,
        resource_type: 'payto_agreement',
      },
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    await expect(
      t.run(async (ctx) => ctx.db.get('payToAgreements', payToAgreementId)),
    ).resolves.toMatchObject({
      environment: 'production',
      lifecycleState: 'active',
      lifecycleConfidence: 'provisional',
    })
  })

  test('persists normalized decline context on the event and agreement', async () => {
    const providerUid = '019ff0d7-eba1-744e-818f-35c9211dbb99'
    const { t, payToAgreementId } = await setupAgreement(providerUid)
    const request = await signedDelivery('delivery-declined-context', {
      data: {
        id: '019ff0d8-1d1e-7838-83f0-f2078f9a10a2',
        body: {
          reason: {
            code: 'AG01',
            title: 'Transaction Forbidden',
            detail: 'The Payer Customer Account is unable to be debited',
          },
          caused_by: 'debtor',
          mms_agreement_id: '019ff0d7f246115eb644957fb06bb925',
        },
        type: 'payto_agreement.declined',
        published_at: '2026-08-11T22:42:02.910+10:00',
        resource_uid: providerUid,
        resource_type: 'payto_agreement',
        resource_metadata: {},
      },
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    const durable = await t.run(async (ctx) => ({
      event: await ctx.db
        .query('zeptoWebhookEvents')
        .withIndex('by_providerEventId', (q) =>
          q.eq('providerEventId', '019ff0d8-1d1e-7838-83f0-f2078f9a10a2'),
        )
        .unique(),
      agreement: await ctx.db.get('payToAgreements', payToAgreementId),
    }))
    const context = {
      causedBy: 'debtor',
      reason: {
        code: 'AG01',
        title: 'Transaction Forbidden',
        detail: 'The Payer Customer Account is unable to be debited',
      },
    }
    expect(durable.event).toMatchObject(context)
    expect(durable.agreement).toMatchObject({
      lifecycleState: 'declined',
      lifecycleCausedBy: context.causedBy,
      lifecycleReason: context.reason,
    })
  })

  test('atomically applies a verified multi-item lifecycle delivery and schedules reconciliation', async () => {
    const { t, requester, moneyRequestId, payToAgreementId } =
      await setupAgreement()
    const request = await signedDelivery('delivery-1', {
      data: [
        {
          id: '018f22e2-7c00-7000-8000-000000000101',
          type: 'payto_agreement.activated',
          published_at: '2026-08-11T01:02:03.000Z',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
        },
        {
          id: '018f22e2-7c00-7000-8000-000000000102',
          type: 'payto_agreement.future_state',
          published_at: '2026-08-11T01:02:04.000Z',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
        },
      ],
    })

    const response = await t.fetch('/zepto/webhooks', {
      method: 'POST',
      ...request,
    })

    expect(response.status).toBe(200)
    const projection = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    expect(projection).toMatchObject({
      agreements: [
        {
          lifecycle: {
            meaning: 'ready',
            confidence: 'provisional',
          },
          tracking: { state: 'verificationDue' },
        },
      ],
    })
    const durable = await t.run(async (ctx) => ({
      deliveries: await ctx.db.query('zeptoWebhookDeliveries').collect(),
      events: await ctx.db.query('zeptoWebhookEvents').collect(),
      evidence: await ctx.db
        .query('payToAgreementEvidence')
        .withIndex('by_payToAgreementId_and_observedAt', (q) =>
          q.eq('payToAgreementId', payToAgreementId),
        )
        .collect(),
      reconciliation: await ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .collect(),
    }))
    expect(durable.deliveries).toHaveLength(1)
    expect(durable.events).toHaveLength(2)
    expect(durable.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'provider_webhook_observed',
          providerEventId: '018f22e2-7c00-7000-8000-000000000101',
          outcome: 'applied',
        }),
        expect.objectContaining({
          kind: 'provider_webhook_observed',
          providerEventId: '018f22e2-7c00-7000-8000-000000000102',
          outcome: 'unknown',
        }),
      ]),
    )
    expect(durable.reconciliation).toEqual([
      expect.objectContaining({
        payToAgreementId,
        providerUid: 'agreement_webhook_1',
        state: 'queued',
      }),
    ])
  })

  test.each([
    ['payto_agreement.activated', 'ready'],
    ['payto_agreement.suspended', 'temporarilyUnavailable'],
    ['payto_agreement.cancelled', 'ended'],
    ['payto_agreement.declined', 'ended'],
    ['payto_agreement.expired', 'ended'],
    ['payto_agreement.failed', 'ended'],
    ['payto_agreement.reactivated', 'ready'],
  ])('maps %s to provisional public meaning %s', async (type, meaning) => {
    const providerUid = `agreement_${type.replaceAll('.', '_')}`
    const { t, requester, moneyRequestId } = await setupAgreement(providerUid)
    const request = await signedDelivery(`delivery-${type}`, {
      data: [
        {
          id: `event-${type}`,
          type,
          published_at: '2026-08-11T01:02:03.000Z',
          resource_uid: providerUid,
          resource_type: 'payto_agreement',
        },
      ],
    })

    expect(
      (
        await t.fetch('/zepto/webhooks', {
          method: 'POST',
          ...request,
        })
      ).status,
    ).toBe(200)
    const projection = await requester.query(api.moneyRequests.get, {
      moneyRequestId,
    })
    if (!('agreements' in projection)) {
      throw new Error('Expected Requester projection')
    }
    expect(projection.agreements[0]?.lifecycle).toMatchObject({
      meaning,
      confidence: 'provisional',
    })
  })

  test('rejects forged and malformed deliveries without durable changes', async () => {
    const { t } = await setupAgreement()
    const validItem = {
      id: 'event-valid',
      type: 'payto_agreement.activated',
      published_at: '2026-08-11T01:02:03.000Z',
      resource_uid: 'agreement_webhook_1',
      resource_type: 'payto_agreement',
    }
    const forged = await signedDelivery('delivery-forged', {
      data: [validItem],
    })
    forged.body = `${forged.body} `
    const malformed = await signedDelivery('delivery-malformed', {
      data: [validItem, { ...validItem, id: 'event-malformed', type: 42 }],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...forged })).status,
    ).toBe(400)
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...malformed }))
        .status,
    ).toBe(400)
    expect(await durableWebhookState(t)).toMatchObject({
      deliveries: [],
      events: [],
      evidence: [],
      reconciliation: [],
    })
  })

  test('rejects a non-RFC3339 provider timestamp without durable changes', async () => {
    const { t } = await setupAgreement()
    const request = await signedDelivery('delivery-bad-timestamp', {
      data: [
        {
          id: 'event-bad-timestamp',
          type: 'payto_agreement.activated',
          published_at: '0',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
        },
      ],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(400)
    expect(await durableWebhookState(t)).toMatchObject({
      deliveries: [],
      events: [],
      evidence: [],
      reconciliation: [],
    })
  })

  test('makes delivery replays no-ops and commits new items beside duplicate events', async () => {
    const { t } = await setupAgreement()
    const event = {
      id: 'event-replayed',
      type: 'payto_agreement.activated',
      published_at: '2026-08-11T01:02:03.000Z',
      resource_uid: 'agreement_webhook_1',
      resource_type: 'payto_agreement',
    }
    const first = await signedDelivery('delivery-first', { data: [event] })
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...first })).status,
    ).toBe(200)
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...first })).status,
    ).toBe(200)

    const mixed = await signedDelivery('delivery-mixed', {
      data: [
        event,
        {
          ...event,
          id: 'event-new',
          type: 'payto_agreement.suspended',
        },
      ],
    })
    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...mixed })).status,
    ).toBe(200)

    const durable = await durableWebhookState(t)
    expect(durable.deliveries).toHaveLength(2)
    expect(durable.events).toHaveLength(2)
    expect(durable.evidence).toHaveLength(2)
    expect(durable.reconciliation).toHaveLength(1)
  })

  test('preserves a confirmed terminal projection when a webhook conflicts', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    await t.run(async (ctx) => {
      await ctx.db.patch('payToAgreements', payToAgreementId, {
        lifecycleState: 'cancelled',
        lifecycleConfidence: 'confirmed',
        lifecycleObservedAt: Date.now() - 30_000,
        trackingState: 'stopped',
        trackingUpdatedAt: Date.now() - 30_000,
      })
    })
    const request = await signedDelivery('delivery-conflict', {
      data: [
        {
          id: 'event-conflict',
          type: 'payto_agreement.activated',
          published_at: '2026-08-11T01:02:03.000Z',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
        },
      ],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    const durable = await t.run(async (ctx) => ({
      agreement: await ctx.db.get('payToAgreements', payToAgreementId),
      evidence: await ctx.db.query('payToAgreementEvidence').collect(),
      reconciliation: await ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .collect(),
    }))
    expect(durable.agreement).toMatchObject({
      lifecycleState: 'cancelled',
      lifecycleConfidence: 'confirmed',
    })
    expect(durable.evidence).toEqual([
      expect.objectContaining({ outcome: 'conflict' }),
    ])
    expect(durable.reconciliation).toHaveLength(1)
  })

  test('does not let an older provisional signal overwrite a newer one', async () => {
    const { t, payToAgreementId } = await setupAgreement()
    const request = await signedDelivery('delivery-out-of-order', {
      data: [
        {
          id: 'event-newer-cancelled',
          type: 'payto_agreement.cancelled',
          published_at: '2026-08-11T01:02:04.000Z',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
          body: {
            caused_by: 'debtor',
            reason: {
              code: 'MD16',
              title: 'Mandate cancelled',
              detail: 'The debtor cancelled the agreement',
            },
          },
        },
        {
          id: 'event-older-activated',
          type: 'payto_agreement.activated',
          published_at: '2026-08-11T01:02:03.000Z',
          resource_uid: 'agreement_webhook_1',
          resource_type: 'payto_agreement',
          body: {
            caused_by: 'initiator',
            reason: {
              code: 'STALE',
              title: 'Stale context',
              detail: 'This must not replace the current lifecycle context',
            },
          },
        },
      ],
    })

    expect(
      (await t.fetch('/zepto/webhooks', { method: 'POST', ...request })).status,
    ).toBe(200)
    const durable = await t.run(async (ctx) => ({
      agreement: await ctx.db.get('payToAgreements', payToAgreementId),
      events: await ctx.db.query('zeptoWebhookEvents').collect(),
      evidence: await ctx.db.query('payToAgreementEvidence').collect(),
    }))
    expect(durable.agreement).toMatchObject({
      lifecycleState: 'cancelled',
      lifecycleProviderPublishedAt: Date.parse('2026-08-11T01:02:04.000Z'),
      lifecycleCausedBy: 'debtor',
      lifecycleReason: {
        code: 'MD16',
        title: 'Mandate cancelled',
        detail: 'The debtor cancelled the agreement',
      },
    })
    expect(durable.events).toEqual([
      expect.objectContaining({
        providerEventId: 'event-newer-cancelled',
        causedBy: 'debtor',
        reason: expect.objectContaining({ code: 'MD16' }),
      }),
      expect.objectContaining({
        providerEventId: 'event-older-activated',
        causedBy: 'initiator',
        reason: expect.objectContaining({ code: 'STALE' }),
      }),
    ])
    expect(durable.evidence).toEqual([
      expect.objectContaining({
        providerEventId: 'event-newer-cancelled',
        outcome: 'applied',
      }),
      expect.objectContaining({
        providerEventId: 'event-older-activated',
        outcome: 'conflict',
      }),
    ])
  })
})
