import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import {
  activationProvenancePolicyValidator,
  agreementEvidenceSourceValidator,
  providerAgreementStateValidator,
  routingSnapshotValidator,
  zeptoEnvironmentValidator,
} from './validators/payToAgreements'
import {
  zeptoWebhookCausedByValidator,
  zeptoWebhookDeliveryValidator,
  zeptoWebhookEventValidator,
  zeptoWebhookEvidenceValidator,
  zeptoWebhookReasonValidator,
} from './validators/zeptoWebhook'
import { paymentDestinationTypeConvexValidator } from './validators/paymentDestinations'
import {
  moneyRequestPaymentStatusValidator,
  payerPaymentCountsValidator,
  payerPaymentStatusValidator,
} from './validators/payToPaymentProjections'
import {
  payToPaymentAttentionValidator,
  payToPaymentCreationStateValidator,
  payToPaymentEvidenceValidator,
  payToPaymentGateModeValidator,
  payToPaymentIntentValidator,
  payToPaymentOperationValidator,
  providerPayToPaymentStateValidator,
} from './validators/payToPayments'

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
    type: paymentDestinationTypeConvexValidator,
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
    creditorSnapshot: routingSnapshotValidator,
    submittedAt: v.number(),
    payerCount: v.optional(v.number()),
    paymentStatus: v.optional(moneyRequestPaymentStatusValidator),
    paymentCounts: v.optional(payerPaymentCountsValidator),
    paymentVerificationPendingPayerCount: v.optional(v.number()),
    paymentAttentionRequiredPayerCount: v.optional(v.number()),
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
    debtorSnapshot: routingSnapshotValidator,
    provider: v.literal('zepto'),
    environment: zeptoEnvironmentValidator,
    apiVersion: v.literal('20260101'),
    providerUid: v.string(),
    activationProvenancePolicy: v.optional(activationProvenancePolicyValidator),
    firstConfirmedActiveAt: v.optional(v.number()),
    paymentStatus: v.optional(payerPaymentStatusValidator),
    paymentVerificationPending: v.optional(v.boolean()),
    paymentAttentionRequired: v.optional(v.boolean()),
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
    lifecycleState: v.union(
      providerAgreementStateValidator,
      v.literal('unknown'),
    ),
    lifecycleRawState: v.optional(v.string()),
    lifecycleConfidence: v.union(
      v.literal('provisional'),
      v.literal('confirmed'),
    ),
    lifecycleObservedAt: v.number(),
    lifecycleProviderPublishedAt: v.optional(v.number()),
    lifecycleCausedBy: v.optional(zeptoWebhookCausedByValidator),
    lifecycleReason: v.optional(zeptoWebhookReasonValidator),
    trackingState: v.union(
      v.literal('verification_due'),
      v.literal('current'),
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
          v.literal('lifecycle_tracking_outage'),
          v.literal('lifecycle_unknown'),
          v.literal('lifecycle_contradiction'),
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
        source: v.optional(agreementEvidenceSourceValidator),
        providerState: providerAgreementStateValidator,
        providerCreatedAt: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_webhook_observed'),
        ...zeptoWebhookEvidenceValidator.fields,
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('reconciliation_lease_claimed'),
        replacedExpiredLease: v.boolean(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('reconciliation_lease_expired'),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_lifecycle_get_observed'),
        providerState: v.string(),
        outcome: v.union(
          v.literal('confirmed'),
          v.literal('unknown'),
          v.literal('contradiction'),
        ),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_lifecycle_get_failed'),
        category: v.string(),
        consecutiveFailures: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('reconciliation_recovered'),
        previousFailureCount: v.number(),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_history_investigated'),
        eventCount: v.number(),
        eventTypes: v.array(v.string()),
        latestProviderPublishedAt: v.optional(v.number()),
      }),
      agreementEvidenceBaseValidator.extend({
        kind: v.literal('provider_history_investigation_failed'),
        category: v.string(),
      }),
    ),
  ).index('by_payToAgreementId_and_observedAt', [
    'payToAgreementId',
    'observedAt',
  ]),

  zeptoWebhookDeliveries: defineTable(zeptoWebhookDeliveryValidator).index(
    'by_deliveryId',
    ['deliveryId'],
  ),

  zeptoWebhookEvents: defineTable(zeptoWebhookEventValidator).index(
    'by_providerEventId',
    ['providerEventId'],
  ),

  payToAgreementReconciliationWorkItems: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    providerUid: v.string(),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('stopped'),
    ),
    availableAt: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    consecutiveFailures: v.optional(v.number()),
    failureStartedAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
  })
    .index('by_payToAgreementId', ['payToAgreementId'])
    .index('by_state_and_availableAt', ['state', 'availableAt'])
    .index('by_state_and_leaseExpiresAt', ['state', 'leaseExpiresAt']),

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

  payToPaymentRuntimeGates: defineTable({
    environment: zeptoEnvironmentValidator,
    mode: payToPaymentGateModeValidator,
    activatedAt: v.optional(v.number()),
    dailyPaymentCountCap: v.optional(v.number()),
    dailyPaymentValueCapCents: v.optional(v.number()),
    budgetDate: v.optional(v.string()),
    reservedPaymentCount: v.optional(v.number()),
    reservedPaymentValueCents: v.optional(v.number()),
  }).index('by_environment', ['environment']),

  payToPayments: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    moneyRequestId: v.id('moneyRequests'),
    payerUserId: v.id('users'),
    environment: zeptoEnvironmentValidator,
    providerUid: v.string(),
    intent: payToPaymentIntentValidator,
    creationState: payToPaymentCreationStateValidator,
    establishedAt: v.number(),
    provisionalLifecycleState: v.optional(providerPayToPaymentStateValidator),
    lifecycleState: v.optional(providerPayToPaymentStateValidator),
    lifecycleObservedAt: v.optional(v.number()),
    lastReconciledAt: v.optional(v.number()),
    attention: v.optional(payToPaymentAttentionValidator),
    reconciliationAlert: v.optional(
      v.object({
        kind: v.literal('lifecycle_tracking_outage'),
        observedAt: v.number(),
      }),
    ),
  })
    .index('by_payToAgreementId', ['payToAgreementId'])
    .index('by_moneyRequestId', ['moneyRequestId'])
    .index('by_payerUserId', ['payerUserId'])
    .index('by_environment_and_providerUid', ['environment', 'providerUid']),

  payToPaymentOperations: defineTable(payToPaymentOperationValidator)
    .index('by_payToPaymentId_and_authorizedAt', [
      'payToPaymentId',
      'authorizedAt',
    ])
    .index('by_operationId', ['operationId']),

  payToPaymentWorkItems: defineTable({
    payToPaymentId: v.id('payToPayments'),
    kind: v.literal('create'),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('completed'),
      v.literal('held'),
    ),
    availableAt: v.number(),
    workId: v.optional(v.string()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    operationId: v.optional(v.string()),
    completedAt: v.optional(v.number()),
  }).index('by_payToPaymentId', ['payToPaymentId']),

  payToPaymentReconciliationWorkItems: defineTable({
    payToPaymentId: v.id('payToPayments'),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('stopped'),
    ),
    availableAt: v.number(),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    operationId: v.optional(v.string()),
    refreshRequestedAt: v.optional(v.number()),
    consecutiveFailures: v.optional(v.number()),
    failureStartedAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
  })
    .index('by_payToPaymentId', ['payToPaymentId'])
    .index('by_state_and_availableAt', ['state', 'availableAt'])
    .index('by_state_and_leaseExpiresAt', ['state', 'leaseExpiresAt']),

  payToPaymentEvidence: defineTable(payToPaymentEvidenceValidator).index(
    'by_payToPaymentId_and_observedAt',
    ['payToPaymentId', 'observedAt'],
  ),
})
