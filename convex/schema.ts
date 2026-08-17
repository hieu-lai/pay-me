import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

import { paymentDestinationTypeConvexValidator } from './validators/paymentDestinations'
import {
  activationProvenancePolicyValidator,
  agreementEvidenceSourceValidator,
  providerAgreementStateValidator,
  routingSnapshotValidator,
  zeptoEnvironmentValidator,
} from './validators/payToAgreements'
import {
  moneyRequestPaymentStatusValidator,
  payerPaymentCountsValidator,
  payerPaymentStatusValidator,
} from './validators/payToPaymentProjections'
import {
  payToPaymentActivationCohortValidator,
  payToPaymentApprovalReferencesValidator,
  payToPaymentAttentionValidator,
  payToPaymentCapacityLimitsValidator,
  payToPaymentCreationStateValidator,
  payToPaymentEvidenceValidator,
  payToPaymentGateModeValidator,
  payToPaymentIntentValidator,
  payToPaymentOperationValidator,
  payToPaymentOperatorActionValidator,
  payToPaymentOperatorDecisionValidator,
  payToPaymentOperatorReasonValidator,
  payToPaymentOperatorResultCodeValidator,
  payToPaymentProductionCapacityReservationValidator,
  payToPaymentRolloutActionValidator,
  payToPaymentRolloutReasonValidator,
  payToPaymentRolloutResultCodeValidator,
  payToPaymentRolloutSafetyCauseValidator,
  payToPaymentRolloutStageValidator,
  providerPayToPaymentStateValidator,
} from './validators/payToPayments'
import {
  profileImageCleanupObjectKindValidator,
  profileImageCleanupStateValidator,
  profileImageMediaTypeValidator,
  profileImageRejectionReasonValidator,
  profileImageSourceValidator,
  profileImageUploadStateValidator,
} from './validators/profileImages'
import {
  zeptoWebhookCausedByValidator,
  zeptoWebhookDeliveryValidator,
  zeptoWebhookEventValidator,
  zeptoWebhookEvidenceValidator,
  zeptoWebhookReasonValidator,
  zeptoWebhookRejectionValidator,
} from './validators/zeptoWebhook'

const agreementEvidenceBaseValidator = v.object({
  payToAgreementId: v.id('payToAgreements'),
  observedAt: v.number(),
})

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.string(),
    email: v.string(),
    displayName: v.string(),
    bio: v.optional(v.string()),
    username: v.optional(v.string()),
    searchText: v.string(),
    profileImageSource: v.optional(profileImageSourceValidator),
    defaultPaymentDestinationId: v.optional(v.id('paymentDestinations')),
    roles: v.optional(v.array(v.literal('payment_operator'))),
    paymentRolloutCohort: v.optional(v.literal('internal_test')),
  })
    .index('by_tokenIdentifier', ['tokenIdentifier'])
    .index('by_clerkUserId', ['clerkUserId'])
    .searchIndex('search_by_searchText', {
      searchField: 'searchText',
    }),

  profileImageUploads: defineTable({
    ownerUserId: v.id('users'),
    state: profileImageUploadStateValidator,
    stagingObjectKey: v.string(),
    assetObjectKey: v.string(),
    declaredSizeBytes: v.number(),
    declaredMediaType: profileImageMediaTypeValidator,
    detectedSizeBytes: v.optional(v.number()),
    detectedMediaType: v.optional(profileImageMediaTypeValidator),
    detectedWidth: v.optional(v.number()),
    detectedHeight: v.optional(v.number()),
    validatedSha256: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    validationAttemptCount: v.number(),
    nextAttemptAt: v.optional(v.number()),
    rejectionReason: v.optional(profileImageRejectionReasonValidator),
    terminalAt: v.optional(v.number()),
  })
    .index('by_ownerUserId_and_state', ['ownerUserId', 'state'])
    .index('by_ownerUserId_and_createdAt', ['ownerUserId', 'createdAt'])
    .index('by_state_and_expiresAt', ['state', 'expiresAt'])
    .index('by_state_and_nextAttemptAt', ['state', 'nextAttemptAt'])
    .index('by_terminalAt', ['terminalAt']),

  profileImageCleanupObligations: defineTable({
    objectKind: profileImageCleanupObjectKindValidator,
    objectKey: v.string(),
    state: profileImageCleanupStateValidator,
    nextAttemptAt: v.number(),
    attemptCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastFailure: v.optional(v.string()),
  })
    .index('by_objectKey', ['objectKey'])
    .index('by_state_and_nextAttemptAt', ['state', 'nextAttemptAt']),

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
        operatorFingerprint: v.string(),
        reason: v.literal('operator_requested_recovery'),
        mode: v.union(v.literal('queued'), v.literal('verifying')),
      }),
      // Kept temporarily so legacy rows can be redacted by migration before a
      // later schema tightening deploy.
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
  )
    .index('by_payToAgreementId_and_observedAt', [
      'payToAgreementId',
      'observedAt',
    ])
    .index('by_observedAt', ['observedAt']),

  zeptoWebhookDeliveries: defineTable(zeptoWebhookDeliveryValidator)
    .index('by_deliveryId', ['deliveryId'])
    .index('by_receivedAt', ['receivedAt']),

  zeptoWebhookEvents: defineTable(zeptoWebhookEventValidator)
    .index('by_providerEventId', ['providerEventId'])
    .index('by_observedAt', ['observedAt']),

  zeptoWebhookRejections: defineTable(zeptoWebhookRejectionValidator).index(
    'by_observedAt',
    ['observedAt'],
  ),

  payToPaymentWebhookSafetyEvents: defineTable({
    observedAt: v.number(),
  }).index('by_observedAt', ['observedAt']),

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
    stoppedAt: v.optional(v.number()),
  })
    .index('by_payToAgreementId', ['payToAgreementId'])
    .index('by_state_and_availableAt', ['state', 'availableAt'])
    .index('by_state_and_stoppedAt', ['state', 'stoppedAt'])
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
  })
    .index('by_payToAgreementId', ['payToAgreementId'])
    .index('by_state_and_completedAt', ['state', 'completedAt']),

  payToPaymentRuntimeGates: defineTable({
    environment: zeptoEnvironmentValidator,
    mode: payToPaymentGateModeValidator,
    activeActivationId: v.optional(v.id('payToPaymentActivations')),
    activatedAt: v.optional(v.number()),
    dailyPaymentCountCap: v.optional(v.number()),
    dailyPaymentValueCapCents: v.optional(v.number()),
    budgetDate: v.optional(v.string()),
    reservedPaymentCount: v.optional(v.number()),
    reservedPaymentValueCents: v.optional(v.number()),
    rolloutStage: v.optional(payToPaymentRolloutStageValidator),
    stageChangedAt: v.optional(v.number()),
    cleanSince: v.optional(v.number()),
    lastSafetyCause: v.optional(payToPaymentRolloutSafetyCauseValidator),
  }).index('by_environment', ['environment']),

  payToPaymentRolloutActions: defineTable({
    environment: v.literal('production'),
    actorUserId: v.optional(v.id('users')),
    authentication: v.union(
      v.literal('authenticated'),
      v.literal('unauthenticated'),
      v.literal('system'),
    ),
    authorization: v.union(
      v.literal('payment_operator'),
      v.literal('insufficient_role'),
      v.literal('not_authenticated'),
      v.literal('automatic_safety_policy'),
    ),
    action: payToPaymentRolloutActionValidator,
    reason: v.optional(payToPaymentRolloutReasonValidator),
    safetyCause: v.optional(payToPaymentRolloutSafetyCauseValidator),
    payToPaymentId: v.optional(v.id('payToPayments')),
    decision: payToPaymentOperatorDecisionValidator,
    resultCode: payToPaymentRolloutResultCodeValidator,
    requestedAt: v.number(),
    previousMode: v.optional(payToPaymentGateModeValidator),
    nextMode: payToPaymentGateModeValidator,
    activationId: v.optional(v.id('payToPaymentActivations')),
  }).index('by_environment_and_requestedAt', ['environment', 'requestedAt']),

  payToPaymentRolloutCleanObservations: defineTable({
    environment: v.literal('production'),
    cleanSince: v.number(),
    cleanDay: v.number(),
    observedAt: v.number(),
  }).index('by_environment_and_cleanSince_and_cleanDay', [
    'environment',
    'cleanSince',
    'cleanDay',
  ]),

  payToPaymentActivations: defineTable({
    environment: v.literal('production'),
    activatedAt: v.number(),
    certifiedCommit: v.string(),
    apiVersion: v.literal('20260101'),
    credentialFingerprint: v.string(),
    configurationFingerprint: v.string(),
    certificationFingerprint: v.string(),
    certificationReference: v.string(),
    cohort: payToPaymentActivationCohortValidator,
    capacityLimits: payToPaymentCapacityLimitsValidator,
    approvalReferences: payToPaymentApprovalReferencesValidator,
    activationFingerprint: v.string(),
  }).index('by_activatedAt', ['activatedAt']),

  payToPaymentActivationAllowlist: defineTable({
    activationId: v.id('payToPaymentActivations'),
    payerUserId: v.id('users'),
  }).index('by_activationId_and_payerUserId', ['activationId', 'payerUserId']),

  payToPaymentActivationBudgets: defineTable({
    environment: v.literal('production'),
    budgetDate: v.string(),
    reservedPaymentCount: v.number(),
    reservedPaymentValueCents: v.number(),
  }).index('by_environment_and_budgetDate', ['environment', 'budgetDate']),

  payToPayments: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    moneyRequestId: v.id('moneyRequests'),
    payerUserId: v.id('users'),
    environment: zeptoEnvironmentValidator,
    providerUid: v.string(),
    intent: payToPaymentIntentValidator,
    creationState: payToPaymentCreationStateValidator,
    establishedAt: v.number(),
    productionActivationId: v.optional(v.id('payToPaymentActivations')),
    productionCapacityReservation: v.optional(
      payToPaymentProductionCapacityReservationValidator,
    ),
    auditExpiresAt: v.optional(v.number()),
    creationRecovery: v.optional(
      v.object({
        startedAt: v.number(),
        postAttempts: v.number(),
        recoveryCycles: v.number(),
        getAttempts: v.number(),
        uncertainSince: v.optional(v.number()),
      }),
    ),
    provisionalLifecycleState: v.optional(providerPayToPaymentStateValidator),
    lifecycleState: v.optional(providerPayToPaymentStateValidator),
    lifecycleObservedAt: v.optional(v.number()),
    confirmedFailure: v.optional(
      v.object({
        code: v.string(),
        retryable: v.boolean(),
        observedAt: v.number(),
      }),
    ),
    lastReconciledAt: v.optional(v.number()),
    agedUnresolvedMonitoringCompletedAt: v.optional(v.number()),
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
    .index('by_agedUnresolvedMonitoringCompletedAt_and_establishedAt', [
      'agedUnresolvedMonitoringCompletedAt',
      'establishedAt',
    ])
    .index('by_auditExpiresAt', ['auditExpiresAt'])
    .index('by_environment_and_providerUid', ['environment', 'providerUid']),

  payToPaymentRetiredIdentities: defineTable({
    payToAgreementId: v.id('payToAgreements'),
    retiredAt: v.number(),
  }).index('by_payToAgreementId', ['payToAgreementId']),

  payToPaymentOperations: defineTable(payToPaymentOperationValidator)
    .index('by_payToPaymentId_and_authorizedAt', [
      'payToPaymentId',
      'authorizedAt',
    ])
    .index('by_payToPaymentId_and_operationKind_and_authorizedAt', [
      'payToPaymentId',
      'operationKind',
      'authorizedAt',
    ])
    .index('by_operationId', ['operationId'])
    .index('by_authorizedAt', ['authorizedAt'])
    .index('by_mechanicsRetiredAt_and_authorizedAt', [
      'mechanicsRetiredAt',
      'authorizedAt',
    ]),

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
  })
    .index('by_payToPaymentId', ['payToPaymentId'])
    .index('by_state_and_availableAt', ['state', 'availableAt'])
    .index('by_state_and_completedAt', ['state', 'completedAt'])
    .index('by_state_and_leaseExpiresAt', ['state', 'leaseExpiresAt']),

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

  payToPaymentRetryWorkItems: defineTable({
    payToPaymentId: v.id('payToPayments'),
    state: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('locked'),
      v.literal('stopped'),
    ),
    retryNumber: v.number(),
    availableAt: v.number(),
    freshGetRequestedAt: v.optional(v.number()),
    cooldownReschedules: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    operationId: v.optional(v.string()),
  })
    .index('by_payToPaymentId', ['payToPaymentId'])
    .index('by_state_and_availableAt', ['state', 'availableAt'])
    .index('by_state_and_leaseExpiresAt', ['state', 'leaseExpiresAt']),

  payToPaymentEvidence: defineTable(payToPaymentEvidenceValidator)
    .index('by_payToPaymentId_and_observedAt', ['payToPaymentId', 'observedAt'])
    .index('by_observedAt', ['observedAt'])
    .index('by_mechanicsRetiredAt_and_observedAt', [
      'mechanicsRetiredAt',
      'observedAt',
    ]),

  payToPaymentOperatorActions: defineTable({
    payToPaymentId: v.id('payToPayments'),
    actorUserId: v.optional(v.id('users')),
    authentication: v.union(
      v.literal('authenticated'),
      v.literal('unauthenticated'),
    ),
    authorization: v.union(
      v.literal('payment_operator'),
      v.literal('insufficient_role'),
      v.literal('not_authenticated'),
    ),
    action: payToPaymentOperatorActionValidator,
    reason: payToPaymentOperatorReasonValidator,
    decision: payToPaymentOperatorDecisionValidator,
    resultCode: payToPaymentOperatorResultCodeValidator,
    requestedAt: v.number(),
  })
    .index('by_payToPaymentId_and_requestedAt', [
      'payToPaymentId',
      'requestedAt',
    ])
    .index('by_requestedAt', ['requestedAt']),

  payToPaymentWebhookDeduplication: defineTable({
    payToPaymentId: v.id('payToPayments'),
    outcome: v.union(
      v.literal('duplicate_delivery'),
      v.literal('duplicate_event'),
    ),
    deliveryId: v.string(),
    providerEventId: v.optional(v.string()),
    observedAt: v.number(),
  })
    .index('by_payToPaymentId_and_observedAt', ['payToPaymentId', 'observedAt'])
    .index('by_observedAt', ['observedAt']),
})
