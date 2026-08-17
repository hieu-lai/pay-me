/// <reference types="vite/client" />

import { runToCompletion } from '@convex-dev/migrations'
import migrationComponent from '@convex-dev/migrations/test'
import workpoolTest from '@convex-dev/workpool/test'
import { convexTest } from 'convex-test'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { expect, test } from 'vitest'

import { components, internal } from './_generated/api'
import { repairPaymentProjection } from './lib/payToPaymentProjection'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const encryptedValue = v.object({
  ciphertext: v.string(),
  nonce: v.string(),
  keyVersion: v.string(),
})
const legacySchema = defineSchema({
  paymentDestinations: defineTable(
    v.union(
      v.object({
        ownerUserId: v.id('users'),
        kind: v.literal('bankAccount'),
        label: v.optional(v.string()),
        searchLabel: v.optional(v.string()),
        maskedDisplay: v.string(),
        maskedAccountName: v.string(),
        maskedBsb: v.string(),
        maskedAccountNumber: v.string(),
        fingerprint: v.string(),
        accountName: encryptedValue,
        bsb: encryptedValue,
        accountNumber: encryptedValue,
      }),
      v.object({
        ownerUserId: v.id('users'),
        kind: v.literal('payId'),
        payIdType: v.union(
          v.literal('mobile'),
          v.literal('email'),
          v.literal('abn'),
          v.literal('organisationIdentifier'),
        ),
        label: v.optional(v.string()),
        searchLabel: v.optional(v.string()),
        maskedDisplay: v.string(),
        fingerprint: v.string(),
        ciphertext: v.string(),
        nonce: v.string(),
        keyVersion: v.string(),
      }),
    ),
  ),
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    username: v.optional(v.string()),
    searchText: v.string(),
    defaultPaymentDestinationId: v.optional(v.id('paymentDestinations')),
  }),
})

async function insertLegacyPayToAgreement(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|legacy-requester',
      clerkUserId: 'legacy-requester',
      email: 'legacy-requester@example.com',
      displayName: 'Legacy Requester',
      searchText: 'Legacy Requester',
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|legacy-payer',
      clerkUserId: 'legacy-payer',
      email: 'legacy-payer@example.com',
      displayName: 'Legacy Payer',
      searchText: 'Legacy Payer',
    })
    const destination = {
      type: 'bban' as const,
      searchLabel: 'Legacy',
      maskedDisplay: 'Bank account ••••1234',
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      keyVersion: 'v1',
    }
    const creditorDestinationId = await ctx.db.insert('paymentDestinations', {
      ...destination,
      ownerUserId: requesterUserId,
      fingerprint: 'legacy-requester-fingerprint',
    })
    const debtorDestinationId = await ctx.db.insert('paymentDestinations', {
      ...destination,
      ownerUserId: payerUserId,
      fingerprint: 'legacy-payer-fingerprint',
    })
    const routingSnapshot = {
      kind: 'bban' as const,
      maskedDisplay: destination.maskedDisplay,
      ciphertext: destination.ciphertext,
      nonce: destination.nonce,
      keyVersion: destination.keyVersion,
    }
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: 'Legacy Requester',
      amountCents: 1_000,
      currency: 'AUD',
      purpose: 'other',
      description: 'Legacy PayTo Agreement',
      submissionKey: 'legacy-submission',
      submissionFingerprint: 'legacy-submission-fingerprint',
      sourceCreditorPaymentDestinationId: creditorDestinationId,
      creditorSnapshot: routingSnapshot,
      submittedAt: 1_000,
    })
    const payToAgreementId = await ctx.db.insert('payToAgreements', {
      moneyRequestId,
      payerUserId,
      payerNameSnapshot: 'Legacy Payer',
      sourceDebtorPaymentDestinationId: debtorDestinationId,
      debtorSnapshot: routingSnapshot,
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: 'legacy-agreement',
      creationState: 'created',
      creationUpdatedAt: 1_000,
      lifecycleState: 'active',
      lifecycleConfidence: 'provisional',
      lifecycleObservedAt: 1_000,
      trackingState: 'verification_due',
      trackingUpdatedAt: 1_000,
    })
    await ctx.db.insert('payToAgreementReconciliationWorkItems', {
      payToAgreementId,
      providerUid: 'legacy-agreement',
      state: 'queued',
      availableAt: 1_000,
    })
    return payToAgreementId
  })
}

test('backfills missing payment destination search labels idempotently', async () => {
  const t = convexTest(legacySchema, modules)
  migrationComponent.register(t)

  const { labeledId, unlabeledId } = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|migration-user',
      clerkUserId: 'migration-user',
      email: 'migration@example.com',
      displayName: 'Migration User',
      searchText: 'Migration User',
    })
    const encrypted = {
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      keyVersion: 'v1',
    }
    const insertedLabeledId = await ctx.db.insert('paymentDestinations', {
      ownerUserId,
      kind: 'bankAccount',
      label: 'Everyday',
      maskedDisplay: 'Bank account ••••1234',
      maskedAccountName: 'M******** U***',
      maskedBsb: '***-456',
      maskedAccountNumber: '••••1234',
      fingerprint: 'labeled-fingerprint',
      accountName: encrypted,
      bsb: encrypted,
      accountNumber: encrypted,
    })
    const insertedUnlabeledId = await ctx.db.insert('paymentDestinations', {
      ownerUserId,
      kind: 'payId',
      payIdType: 'email',
      maskedDisplay: 'm***@example.com',
      fingerprint: 'unlabeled-fingerprint',
      ...encrypted,
    })
    return {
      labeledId: insertedLabeledId,
      unlabeledId: insertedUnlabeledId,
    }
  })

  await t.run(async (ctx) => {
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.backfillPaymentDestinationSearchLabel,
    )
  })

  await expect(
    t.run(async (ctx) => ({
      labeled: await ctx.db.get('paymentDestinations', labeledId),
      unlabeled: await ctx.db.get('paymentDestinations', unlabeledId),
    })),
  ).resolves.toMatchObject({
    labeled: { searchLabel: 'Everyday' },
    unlabeled: { searchLabel: '' },
  })

  await t.run(async (ctx) => {
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.backfillPaymentDestinationSearchLabel,
    )
  })
  await expect(
    t.run(async (ctx) => ctx.db.get('paymentDestinations', labeledId)),
  ).resolves.toMatchObject({ searchLabel: 'Everyday' })
})

test('permanently excludes legacy PayTo Agreements from new activation provenance', async () => {
  const t = convexTest(schema, modules)
  migrationComponent.register(t)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  const payToAgreementId = await insertLegacyPayToAgreement(t)

  for (let run = 0; run < 2; run += 1) {
    await t.run(async (ctx) => {
      await runToCompletion(
        ctx,
        components.migrations,
        internal.migrations.excludeLegacyPayToAgreements,
      )
    })
  }

  await t.run(async (ctx) => {
    await ctx.db.patch('payToAgreements', payToAgreementId, {
      creationState: 'manual_hold',
    })
    await ctx.db.insert('payToAgreementWorkItems', {
      payToAgreementId,
      kind: 'create',
      state: 'held',
      availableAt: 1_000,
    })
  })
  await t.mutation(internal.payToAgreementCreation.reopenManualHold, {
    payToAgreementId,
    operatorIdentity: 'operator@example.test',
    reason: 'Verify legacy exclusion survives recovery',
  })

  await t.mutation(internal.payToAgreementReconciliation.claimWork, {
    payToAgreementId,
    leaseToken: 'legacy-reconciliation',
    nowMs: 2_000,
  })
  await t.mutation(internal.payToAgreementReconciliation.recordSuccess, {
    payToAgreementId,
    leaseToken: 'legacy-reconciliation',
    providerState: 'active',
    observedAt: 3_000,
  })

  const agreement = await t.run(async (ctx) =>
    ctx.db.get('payToAgreements', payToAgreementId),
  )
  expect(agreement).toMatchObject({
    activationProvenancePolicy: 'legacy_excluded',
  })
  expect(agreement?.firstConfirmedActiveAt).toBeUndefined()
})

test('repairs missing Payment projections idempotently without changing legacy exclusion or creating work', async () => {
  const t = convexTest(schema, modules)
  migrationComponent.register(t)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  const payToAgreementId = await insertLegacyPayToAgreement(t)
  const agreementBefore = await t.run(async (ctx) =>
    ctx.db.get('payToAgreements', payToAgreementId),
  )
  if (!agreementBefore) throw new Error('Expected legacy PayTo Agreement')
  await t.run(async (ctx) => {
    await ctx.db.patch('moneyRequests', agreementBefore.moneyRequestId, {
      payerCount: 5,
      paymentStatus: 'paid',
      paymentCounts: {
        not_started: -1,
        initiating: 0,
        processing: 0,
        under_investigation: 0,
        failed: 0,
        paid: 6,
      },
      paymentVerificationPendingPayerCount: 5,
      paymentAttentionRequiredPayerCount: 5,
    })
  })

  for (const migration of [
    internal.migrations.excludeLegacyPayToAgreements,
    internal.migrations.repairMoneyRequestPaymentProjections,
    internal.migrations.repairMoneyRequestPaymentProjections,
  ]) {
    await t.run(async (ctx) => {
      await runToCompletion(ctx, components.migrations, migration)
    })
  }

  const repaired = await t.run(async (ctx) => ({
    request: await ctx.db.get('moneyRequests', agreementBefore.moneyRequestId),
    agreement: await ctx.db.get('payToAgreements', payToAgreementId),
    paymentWork: await ctx.db.query('payToAgreementWorkItems').collect(),
    evidence: await ctx.db.query('payToAgreementEvidence').collect(),
  }))
  expect(repaired.request).toMatchObject({
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
  expect(repaired.agreement).toMatchObject({
    activationProvenancePolicy: 'legacy_excluded',
    paymentStatus: 'not_started',
    paymentVerificationPending: false,
    paymentAttentionRequired: false,
  })
  expect(repaired.paymentWork).toEqual([])
  expect(repaired.evidence).toEqual([])
})

test('repairs exact mixed Payer counts and becomes paid only when every Payer is paid', async () => {
  const t = convexTest(schema, modules)
  migrationComponent.register(t)
  workpoolTest.register(t, 'agreementCreationWorkpool')
  const firstAgreementId = await insertLegacyPayToAgreement(t)
  const moneyRequestId = await t.run(async (ctx) => {
    const first = await ctx.db.get('payToAgreements', firstAgreementId)
    if (!first) throw new Error('Expected legacy PayTo Agreement')
    const {
      _id: _firstId,
      _creationTime: _createdAt,
      ...agreementFields
    } = first
    await ctx.db.patch('payToAgreements', firstAgreementId, {
      paymentStatus: 'paid',
      paymentVerificationPending: true,
      paymentAttentionRequired: false,
    })
    for (const [index, paymentStatus] of (
      ['failed', 'not_started'] as const
    ).entries()) {
      const payerUserId = await ctx.db.insert('users', {
        tokenIdentifier: `issuer|repair-payer-${index}`,
        clerkUserId: `repair-payer-${index}`,
        email: `repair-payer-${index}@example.com`,
        displayName: `Repair Payer ${index}`,
        searchText: `Repair Payer ${index}`,
      })
      await ctx.db.insert('payToAgreements', {
        ...agreementFields,
        payerUserId,
        payerNameSnapshot: `Repair Payer ${index}`,
        providerUid: `repair-agreement-${index}`,
        paymentStatus,
        paymentVerificationPending: false,
        paymentAttentionRequired: index === 0,
      })
    }
    return first.moneyRequestId
  })

  await t.run(async (ctx) => {
    await repairPaymentProjection(ctx, moneyRequestId)
  })
  await expect(
    t.run(async (ctx) => ctx.db.get('moneyRequests', moneyRequestId)),
  ).resolves.toMatchObject({
    payerCount: 3,
    paymentStatus: 'unpaid',
    paymentCounts: {
      not_started: 1,
      initiating: 0,
      processing: 0,
      under_investigation: 0,
      failed: 1,
      paid: 1,
    },
    paymentVerificationPendingPayerCount: 1,
    paymentAttentionRequiredPayerCount: 1,
  })

  await t.run(async (ctx) => {
    const agreements = await ctx.db
      .query('payToAgreements')
      .withIndex('by_moneyRequestId', (q) =>
        q.eq('moneyRequestId', moneyRequestId),
      )
      .take(4)
    for (const agreement of agreements) {
      await ctx.db.patch('payToAgreements', agreement._id, {
        paymentStatus: 'paid',
        paymentVerificationPending: false,
        paymentAttentionRequired: false,
      })
    }
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.repairMoneyRequestPaymentProjections,
    )
  })
  await expect(
    t.run(async (ctx) => ctx.db.get('moneyRequests', moneyRequestId)),
  ).resolves.toMatchObject({
    payerCount: 3,
    paymentStatus: 'paid',
    paymentCounts: { paid: 3 },
    paymentVerificationPendingPayerCount: 0,
    paymentAttentionRequiredPayerCount: 0,
  })
})

test('deletes all money request and PayTo agreement data', async () => {
  const t = convexTest(schema, modules)
  migrationComponent.register(t)

  await t.run(async (ctx) => {
    const requesterUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|cleanup-requester',
      clerkUserId: 'cleanup-requester',
      email: 'requester@example.com',
      displayName: 'Cleanup Requester',
      searchText: 'Cleanup Requester',
    })
    const payerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|cleanup-payer',
      clerkUserId: 'cleanup-payer',
      email: 'payer@example.com',
      displayName: 'Cleanup Payer',
      searchText: 'Cleanup Payer',
    })
    const routingDestination = {
      ownerUserId: requesterUserId,
      type: 'bban' as const,
      searchLabel: 'Everyday',
      maskedDisplay: 'Bank account •••1234',
      fingerprint: 'cleanup-fingerprint',
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      keyVersion: 'v1',
    }
    const creditorDestinationId = await ctx.db.insert(
      'paymentDestinations',
      routingDestination,
    )
    const debtorDestinationId = await ctx.db.insert('paymentDestinations', {
      ...routingDestination,
      ownerUserId: payerUserId,
      fingerprint: 'cleanup-payer-fingerprint',
    })
    const routingSnapshot = {
      kind: 'bban' as const,
      maskedDisplay: 'Bank account •••1234',
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      keyVersion: 'v1',
    }
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId,
      requesterNameSnapshot: 'Cleanup Requester',
      amountCents: 1000,
      currency: 'AUD',
      purpose: 'other',
      description: 'Cleanup test',
      submissionKey: 'cleanup-key',
      submissionFingerprint: 'cleanup-submission-fingerprint',
      sourceCreditorPaymentDestinationId: creditorDestinationId,
      creditorSnapshot: routingSnapshot,
      submittedAt: 1,
    })
    const payToAgreementId = await ctx.db.insert('payToAgreements', {
      moneyRequestId,
      payerUserId,
      payerNameSnapshot: 'Cleanup Payer',
      sourceDebtorPaymentDestinationId: debtorDestinationId,
      debtorSnapshot: routingSnapshot,
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: 'cleanup-provider-uid',
      creationState: 'queued',
      creationUpdatedAt: 1,
      lifecycleState: 'pending',
      lifecycleConfidence: 'provisional',
      lifecycleObservedAt: 1,
      trackingState: 'verification_due',
      trackingUpdatedAt: 1,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId,
      kind: 'local_accepted',
      observedAt: 1,
    })
    await ctx.db.insert('payToAgreementWorkItems', {
      payToAgreementId,
      kind: 'create',
      state: 'queued',
      availableAt: 1,
    })
  })

  for (const migration of [
    internal.migrations.deleteAllPayToAgreementEvidence,
    internal.migrations.deleteAllPayToAgreementWorkItems,
    internal.migrations.deleteAllPayToAgreements,
    internal.migrations.deleteAllMoneyRequests,
  ]) {
    await t.run(async (ctx) => {
      await runToCompletion(ctx, components.migrations, migration)
    })
  }

  await expect(
    t.run(async (ctx) => ({
      moneyRequests: await ctx.db.query('moneyRequests').take(1),
      agreements: await ctx.db.query('payToAgreements').take(1),
      evidence: await ctx.db.query('payToAgreementEvidence').take(1),
      workItems: await ctx.db.query('payToAgreementWorkItems').take(1),
      users: await ctx.db.query('users').take(3),
      paymentDestinations: await ctx.db.query('paymentDestinations').take(3),
    })),
  ).resolves.toMatchObject({
    moneyRequests: [],
    agreements: [],
    evidence: [],
    workItems: [],
    users: [{}, {}],
    paymentDestinations: [{}, {}],
  })
})
