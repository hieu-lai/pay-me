import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import {
  bankAccountRoutingSnapshotValidator,
  providerAgreementStateValidator,
} from './validators/payToAgreements'

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.string(),
    email: v.string(),
    name: v.string(),
    username: v.optional(v.string()),
    searchText: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    defaultPaymentDestinationId: v.optional(v.id('paymentDestinations')),
  })
    .index('by_tokenIdentifier', ['tokenIdentifier'])
    .index('by_clerkUserId', ['clerkUserId'])
    .searchIndex('search_by_searchText', {
      searchField: 'searchText',
    }),

  paymentDestinations: defineTable({
    ownerUserId: v.id('users'),
    type: v.union(
      v.literal('bban'),
      v.literal('alias_phone'),
      v.literal('alias_email'),
      v.literal('alias_abn'),
      v.literal('alias_organisation_identifier'),
    ),
    label: v.optional(v.string()),
    searchLabel: v.string(),
    maskedDisplay: v.string(),
    fingerprint: v.string(),
    ciphertext: v.string(),
    nonce: v.string(),
    keyVersion: v.string(),
  })
    .index('by_ownerUserId', ['ownerUserId'])
    .index('by_ownerUserId_and_fingerprint', ['ownerUserId', 'fingerprint'])
    .searchIndex('search_by_searchLabel_and_ownerUserId', {
      searchField: 'searchLabel',
      filterFields: ['ownerUserId'],
    }),

  moneyRequests: defineTable({
    requesterUserId: v.id('users'),
    requesterNameSnapshot: v.string(),
    amountCents: v.number(),
    currency: v.literal('AUD'),
    purpose: v.literal('other'),
    description: v.string(),
    submissionKey: v.string(),
    submissionFingerprint: v.string(),
    sourceCreditorPaymentDestinationId: v.id('paymentDestinations'),
    creditorSnapshot: bankAccountRoutingSnapshotValidator,
    submittedAt: v.number(),
  })
    .index('by_requesterUserId', ['requesterUserId'])
    .index('by_requesterUserId_and_submissionKey', [
      'requesterUserId',
      'submissionKey',
    ]),

  payToAgreements: defineTable({
    moneyRequestId: v.id('moneyRequests'),
    payerUserId: v.id('users'),
    payerNameSnapshot: v.string(),
    sourceDebtorPaymentDestinationId: v.id('paymentDestinations'),
    debtorSnapshot: bankAccountRoutingSnapshotValidator,
    provider: v.literal('zepto'),
    environment: v.literal('sandbox'),
    apiVersion: v.literal('20260101'),
    providerUid: v.string(),
    creationState: v.union(
      v.literal('queued'),
      v.literal('submitting'),
      v.literal('created'),
    ),
    creationUpdatedAt: v.number(),
    lifecycleState: providerAgreementStateValidator,
    lifecycleConfidence: v.literal('provisional'),
    lifecycleObservedAt: v.number(),
    trackingState: v.literal('verification_due'),
    trackingUpdatedAt: v.number(),
    providerCreatedAt: v.optional(v.number()),
    providerMmsAgreementId: v.optional(v.union(v.string(), v.null())),
  })
    .index('by_moneyRequestId', ['moneyRequestId'])
    .index('by_payerUserId', ['payerUserId'])
    .index('by_moneyRequestId_and_payerUserId', [
      'moneyRequestId',
      'payerUserId',
    ])
    .index('by_environment_and_providerUid', ['environment', 'providerUid']),

  payToAgreementEvidence: defineTable(
    v.union(
      v.object({
        payToAgreementId: v.id('payToAgreements'),
        kind: v.literal('local_accepted'),
        observedAt: v.number(),
      }),
      v.object({
        payToAgreementId: v.id('payToAgreements'),
        kind: v.literal('provider_create_succeeded'),
        providerState: providerAgreementStateValidator,
        providerCreatedAt: v.number(),
        observedAt: v.number(),
      }),
    ),
  ).index('by_payToAgreementId_and_observedAt', [
    'payToAgreementId',
    'observedAt',
  ]),

  payToAgreementWorkItems: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    kind: v.literal('create'),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('completed'),
    ),
    availableAt: v.number(),
    workId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  }).index('by_payToAgreementId', ['payToAgreementId']),
})
