/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, test } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'

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

async function setupAgreement(providerUid = 'agreement_webhook_1') {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: requesterIdentity.tokenIdentifier,
      clerkUserId: requesterIdentity.subject,
      email: 'requester@example.test',
      name: requesterIdentity.name,
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|payer_webhook',
      clerkUserId: 'payer_webhook',
      email: 'payer@example.test',
      name: 'Webhook Payer',
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
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid,
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
  process.env.ZEPTO_WEBHOOK_SIGNING_SECRET = webhookSecret
})

describe('POST /zepto/webhooks', () => {
  test('accepts Zepto PayTo webhook deliveries with a single data object', async () => {
    const providerUid = '019ff0c0-b888-7c66-af96-63972ad43d51'
    const { t } = await setupAgreement(providerUid)
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
