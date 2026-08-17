import { Migrations } from '@convex-dev/migrations'

import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import {
  boundedEvidenceCode,
  fingerprintSensitiveIdentifier,
  safeWebhookReason,
} from './lib/evidenceRedaction'
import { paymentAuditExpiresAt } from './lib/payToPaymentRetentionPolicy'
import { repairPaymentProjection } from './lib/payToPaymentProjection'

export const migrations = new Migrations<DataModel>(components.migrations)

export function searchLabelFor(label: string | undefined): string {
  return label ?? ''
}

export function paymentDestinationSearchLabelPatch(destination: {
  label?: string
  searchLabel?: string
}): { searchLabel: string } | undefined {
  if (destination.searchLabel !== undefined) return
  return { searchLabel: searchLabelFor(destination.label) }
}

export const backfillPaymentDestinationSearchLabel = migrations.define({
  table: 'paymentDestinations',
  migrateOne: async (_ctx, destination) =>
    paymentDestinationSearchLabelPatch(destination),
})

export const runBackfillPaymentDestinationSearchLabel = migrations.runner(
  internal.migrations.backfillPaymentDestinationSearchLabel,
)

export const excludeLegacyPayToAgreements = migrations.define({
  table: 'payToAgreements',
  migrateOne: async (_ctx, agreement) => {
    if (agreement.activationProvenancePolicy !== undefined) return
    return {
      activationProvenancePolicy:
        agreement.firstConfirmedActiveAt === undefined
          ? ('legacy_excluded' as const)
          : ('track_first_confirmation' as const),
    }
  },
})

export const runExcludeLegacyPayToAgreements = migrations.runner(
  internal.migrations.excludeLegacyPayToAgreements,
)

export const repairMoneyRequestPaymentProjections = migrations.define({
  table: 'moneyRequests',
  migrateOne: async (ctx, moneyRequest) => {
    await repairPaymentProjection(ctx, moneyRequest._id)
  },
})

export const runRepairMoneyRequestPaymentProjections = migrations.runner(
  internal.migrations.repairMoneyRequestPaymentProjections,
)

export const backfillPaymentAuditExpiry = migrations.define({
  table: 'payToPayments',
  migrateOne: async (_ctx, payment) => {
    if (payment.auditExpiresAt !== undefined) return
    return {
      auditExpiresAt: paymentAuditExpiresAt(
        payment.lifecycleObservedAt ?? payment.establishedAt,
      ),
    }
  },
})

export const runBackfillPaymentAuditExpiry = migrations.runner(
  internal.migrations.backfillPaymentAuditExpiry,
)

export const redactLegacyOperatorAgreementEvidence = migrations.define({
  table: 'payToAgreementEvidence',
  migrateOne: async (ctx, evidence) => {
    if (
      evidence.kind !== 'operator_reopened' ||
      !('operatorIdentity' in evidence)
    ) {
      return
    }
    const {
      _id: _evidenceId,
      _creationTime: _evidenceCreationTime,
      operatorIdentity,
      reason: _freeFormReason,
      ...safeEvidence
    } = evidence
    await ctx.db.replace('payToAgreementEvidence', evidence._id, {
      ...safeEvidence,
      operatorFingerprint:
        await fingerprintSensitiveIdentifier(operatorIdentity),
      reason: 'operator_requested_recovery',
    })
  },
})

export const runRedactLegacyOperatorAgreementEvidence = migrations.runner(
  internal.migrations.redactLegacyOperatorAgreementEvidence,
)

export const redactLegacyAgreementWebhookContext = migrations.define({
  table: 'payToAgreements',
  migrateOne: async (_ctx, agreement) => {
    const safeReason = safeWebhookReason(agreement.lifecycleReason)
    const safeRawState = boundedEvidenceCode(agreement.lifecycleRawState)
    if (
      agreement.lifecycleReason?.title === undefined &&
      agreement.lifecycleReason?.detail === undefined &&
      safeReason?.code === agreement.lifecycleReason?.code &&
      safeRawState === agreement.lifecycleRawState
    ) {
      return
    }
    return {
      lifecycleReason: safeReason,
      lifecycleRawState: safeRawState,
    }
  },
})

export const redactLegacyAgreementEvidenceDetails = migrations.define({
  table: 'payToAgreementEvidence',
  migrateOne: async (ctx, evidence) => {
    switch (evidence.kind) {
      case 'provider_create_ambiguous':
      case 'provider_create_temporarily_rejected':
      case 'provider_verification_failed':
      case 'provider_lifecycle_get_failed':
      case 'provider_history_investigation_failed':
        if (boundedEvidenceCode(evidence.category) === undefined) {
          await ctx.db.patch('payToAgreementEvidence', evidence._id, {
            category: 'redacted',
          })
        }
        return
      case 'creation_manual_hold':
      case 'creation_failed':
        if (boundedEvidenceCode(evidence.reason) === undefined) {
          await ctx.db.patch('payToAgreementEvidence', evidence._id, {
            reason: 'redacted',
          })
        }
        return
      case 'provider_lifecycle_get_observed':
        if (boundedEvidenceCode(evidence.providerState) === undefined) {
          await ctx.db.patch('payToAgreementEvidence', evidence._id, {
            providerState: 'unknown',
          })
        }
        return
      case 'provider_history_investigated': {
        const eventTypes = [
          ...new Set(
            evidence.eventTypes.map(
              (eventType) => boundedEvidenceCode(eventType) ?? 'unknown',
            ),
          ),
        ].sort()
        if (
          JSON.stringify(eventTypes) !== JSON.stringify(evidence.eventTypes)
        ) {
          await ctx.db.patch('payToAgreementEvidence', evidence._id, {
            eventTypes,
          })
        }
        return
      }
      default:
        return
    }
  },
})

export const redactLegacyWebhookEventContext = migrations.define({
  table: 'zeptoWebhookEvents',
  migrateOne: async (_ctx, event) => {
    if (event.reason === undefined) return
    const safeReason = safeWebhookReason(event.reason)
    if (
      event.reason.title === undefined &&
      event.reason.detail === undefined &&
      safeReason?.code === event.reason.code
    ) {
      return
    }
    return { reason: safeReason }
  },
})

export const redactLegacyPaymentEvidenceCodes = migrations.define({
  table: 'payToPaymentEvidence',
  migrateOne: async (_ctx, evidence) => {
    const providerFailureCode = boundedEvidenceCode(
      evidence.providerFailureCode,
    )
    const providerState =
      evidence.providerState === undefined
        ? undefined
        : (boundedEvidenceCode(evidence.providerState) ?? 'unknown')
    if (
      providerFailureCode === evidence.providerFailureCode &&
      providerState === evidence.providerState
    ) {
      return
    }
    return { providerFailureCode, providerState }
  },
})

export const redactLegacyPaymentFailureCodes = migrations.define({
  table: 'payToPayments',
  migrateOne: async (_ctx, payment) => {
    if (
      payment.confirmedFailure === undefined ||
      boundedEvidenceCode(payment.confirmedFailure.code) !== undefined
    ) {
      return
    }
    return { confirmedFailure: undefined }
  },
})

export const backfillAgreementReconciliationStoppedAt = migrations.define({
  table: 'payToAgreementReconciliationWorkItems',
  migrateOne: async (_ctx, work) => {
    if (work.state !== 'stopped' || work.stoppedAt !== undefined) return
    return { stoppedAt: work.availableAt }
  },
})

export const runRedactLegacySensitiveEvidence = migrations.runner([
  internal.migrations.redactLegacyOperatorAgreementEvidence,
  internal.migrations.redactLegacyAgreementWebhookContext,
  internal.migrations.redactLegacyAgreementEvidenceDetails,
  internal.migrations.redactLegacyWebhookEventContext,
  internal.migrations.redactLegacyPaymentEvidenceCodes,
  internal.migrations.redactLegacyPaymentFailureCodes,
  internal.migrations.backfillAgreementReconciliationStoppedAt,
])

export const deleteAllPayToAgreementEvidence = migrations.define({
  table: 'payToAgreementEvidence',
  migrateOne: async (ctx, evidence) => {
    await ctx.db.delete('payToAgreementEvidence', evidence._id)
  },
})

export const deleteAllPayToAgreementWorkItems = migrations.define({
  table: 'payToAgreementWorkItems',
  migrateOne: async (ctx, workItem) => {
    await ctx.db.delete('payToAgreementWorkItems', workItem._id)
  },
})

export const deleteAllPayToAgreements = migrations.define({
  table: 'payToAgreements',
  migrateOne: async (ctx, agreement) => {
    await ctx.db.delete('payToAgreements', agreement._id)
  },
})

export const deleteAllMoneyRequests = migrations.define({
  table: 'moneyRequests',
  migrateOne: async (ctx, moneyRequest) => {
    await ctx.db.delete('moneyRequests', moneyRequest._id)
  },
})

export const runDeleteAllMoneyRequestData = migrations.runner([
  internal.migrations.deleteAllPayToAgreementEvidence,
  internal.migrations.deleteAllPayToAgreementWorkItems,
  internal.migrations.deleteAllPayToAgreements,
  internal.migrations.deleteAllMoneyRequests,
])
