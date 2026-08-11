import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import {
  bankAccountRoutingSnapshotValidator,
  providerAgreementStateValidator,
} from './validators/payToAgreements'

const agreementEvidenceBaseValidator = v.object({
  payToAgreementId: v.id('payToAgreements'),
  observedAt: v.number(),
})

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
      v.literal('verifying'),
      v.literal('retry_wait'),
      v.literal('manual_hold'),
      v.literal('created'),
      v.literal('failed'),
    ),
    creationUpdatedAt: v.number(),
    lifecycleState: providerAgreementStateValidator,
    lifecycleConfidence: v.union(
      v.literal('provisional'),
      v.literal('confirmed'),
    ),
    lifecycleObservedAt: v.number(),
    trackingState: v.union(
      v.literal('verification_due'),
      v.literal('checking'),
      v.literal('retrying'),
      v.literal('needs_review'),
      v.literal('stopped'),
    ),
    trackingUpdatedAt: v.number(),
    currentFailure: v.optional(
      v.object({
        kind: v.union(
          v.literal('provider_outcome_uncertain'),
          v.literal('provider_temporarily_unavailable'),
          v.literal('operator_review_required'),
          v.literal('immutable_request_rejected'),
        ),
        observedAt: v.number(),
      }),
    ),
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
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('local_accepted'),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('creation_attempt_started'),
        postCycle: v.number(),
        reservedPostAttempts: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_http_post_attempted'),
        postCycle: v.number(),
        attemptInCycle: v.number(),
        lifetimeAttempt: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_http_get_attempted'),
        postCycle: v.number(),
        attemptInRequest: v.number(),
        lifetimeAttempt: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('creation_lease_expired'),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_create_ambiguous'),
        category: v.string(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_create_temporarily_rejected'),
        category: v.string(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_verification_not_found'),
        absenceCount: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_verification_failed'),
        category: v.string(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('creation_retry_scheduled'),
        nextAttemptAt: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('creation_manual_hold'),
        reason: v.string(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('creation_failed'),
        reason: v.string(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('operator_reopened'),
        operatorIdentity: v.string(),
        reason: v.string(),
        mode: v.union(v.literal('queued'), v.literal('verifying')),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_create_succeeded'),
        providerState: providerAgreementStateValidator,
        providerCreatedAt: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_webhook_observed'),
        deliveryId: v.string(),
        providerEventId: v.string(),
        eventType: v.string(),
        providerPublishedAt: v.number(),
        outcome: v.union(
          v.literal('applied'),
          v.literal('unknown'),
          v.literal('conflict'),
        ),
      }),
    ),
  ).index('by_payToAgreementId_and_observedAt', [
    'payToAgreementId',
    'observedAt',
  ]),

  zeptoWebhookDeliveries: defineTable({
    deliveryId: v.string(),
    signatureTimestamp: v.number(),
    receivedAt: v.number(),
  }).index('by_deliveryId', ['deliveryId']),

  zeptoWebhookEvents: defineTable({
    providerEventId: v.string(),
    deliveryId: v.string(),
    eventType: v.string(),
    resourceUid: v.string(),
    providerPublishedAt: v.number(),
    observedAt: v.number(),
  }).index('by_providerEventId', ['providerEventId']),

  payToAgreementReconciliationWorkItems: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    state: v.literal('queued'),
    availableAt: v.number(),
  }).index('by_payToAgreementId', ['payToAgreementId']),

  payToAgreementWorkItems: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    kind: v.literal('create'),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('waiting'),
      v.literal('completed'),
      v.literal('held'),
      v.literal('failed'),
    ),
    availableAt: v.number(),
    workId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    postCycle: v.optional(v.number()),
    reservedPostAttempts: v.optional(v.number()),
    actualPostAttempts: v.optional(v.number()),
    actualGetAttempts: v.optional(v.number()),
    verificationAttempt: v.optional(v.number()),
    absenceCount: v.optional(v.number()),
    lastPostAt: v.optional(v.number()),
  }).index('by_payToAgreementId', ['payToAgreementId']),
})
