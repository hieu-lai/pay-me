import { v } from 'convex/values'

import { internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'
import { internalMutation } from './_generated/server'
import {
  PAY_TO_PAYMENT_WORK_RETENTION_MS,
  REJECTED_WEBHOOK_RETENTION_MS,
  paymentAuditCutoff,
  paymentAuditExpiresAt,
} from './lib/payToPaymentRetentionPolicy'
import { zeptoWebhookRejectionValidator } from './validators/zeptoWebhook'

const MAX_BATCH_SIZE = 100

async function cleanupAuditEvidence(
  ctx: MutationCtx,
  nowMs: number,
  batchSize: number,
) {
  const cutoff = paymentAuditCutoff(nowMs)
  let remaining = batchSize
  let deleted = 0

  const agreementEvidence = await ctx.db
    .query('payToAgreementEvidence')
    .withIndex('by_observedAt', (q) => q.lte('observedAt', cutoff))
    .take(remaining)
  for (const record of agreementEvidence) {
    await ctx.db.delete('payToAgreementEvidence', record._id)
  }
  deleted += agreementEvidence.length
  remaining -= agreementEvidence.length

  const deliveries = await ctx.db
    .query('zeptoWebhookDeliveries')
    .withIndex('by_receivedAt', (q) => q.lte('receivedAt', cutoff))
    .take(remaining)
  for (const record of deliveries) {
    await ctx.db.delete('zeptoWebhookDeliveries', record._id)
  }
  deleted += deliveries.length
  remaining -= deliveries.length

  const events = await ctx.db
    .query('zeptoWebhookEvents')
    .withIndex('by_observedAt', (q) => q.lte('observedAt', cutoff))
    .take(remaining)
  for (const record of events) {
    await ctx.db.delete('zeptoWebhookEvents', record._id)
  }
  deleted += events.length
  remaining -= events.length

  const operations = await ctx.db
    .query('payToPaymentOperations')
    .withIndex('by_authorizedAt', (q) => q.lte('authorizedAt', cutoff))
    .take(remaining)
  for (const record of operations) {
    await ctx.db.delete('payToPaymentOperations', record._id)
  }
  deleted += operations.length
  remaining -= operations.length

  const paymentEvidence = await ctx.db
    .query('payToPaymentEvidence')
    .withIndex('by_observedAt', (q) => q.lte('observedAt', cutoff))
    .take(remaining)
  for (const record of paymentEvidence) {
    await ctx.db.delete('payToPaymentEvidence', record._id)
  }
  deleted += paymentEvidence.length
  remaining -= paymentEvidence.length

  const operatorActions = await ctx.db
    .query('payToPaymentOperatorActions')
    .withIndex('by_requestedAt', (q) => q.lte('requestedAt', cutoff))
    .take(remaining)
  for (const record of operatorActions) {
    await ctx.db.delete('payToPaymentOperatorActions', record._id)
  }
  deleted += operatorActions.length
  remaining -= operatorActions.length

  const deduplication = await ctx.db
    .query('payToPaymentWebhookDeduplication')
    .withIndex('by_observedAt', (q) => q.lte('observedAt', cutoff))
    .take(remaining)
  for (const record of deduplication) {
    await ctx.db.delete('payToPaymentWebhookDeduplication', record._id)
  }
  deleted += deduplication.length
  remaining -= deduplication.length

  const expiredPayments = await ctx.db
    .query('payToPayments')
    .withIndex('by_auditExpiresAt', (q) =>
      q.gt('auditExpiresAt', undefined).lte('auditExpiresAt', nowMs),
    )
    .take(remaining)
  for (const record of expiredPayments) {
    const [latestEvidence, latestOperation, latestAction, latestDeduplication] =
      await Promise.all([
        ctx.db
          .query('payToPaymentEvidence')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', record._id),
          )
          .order('desc')
          .first(),
        ctx.db
          .query('payToPaymentOperations')
          .withIndex('by_payToPaymentId_and_authorizedAt', (q) =>
            q.eq('payToPaymentId', record._id),
          )
          .order('desc')
          .first(),
        ctx.db
          .query('payToPaymentOperatorActions')
          .withIndex('by_payToPaymentId_and_requestedAt', (q) =>
            q.eq('payToPaymentId', record._id),
          )
          .order('desc')
          .first(),
        ctx.db
          .query('payToPaymentWebhookDeduplication')
          .withIndex('by_payToPaymentId_and_observedAt', (q) =>
            q.eq('payToPaymentId', record._id),
          )
          .order('desc')
          .first(),
      ])
    const latestAuditAt = Math.max(
      record.establishedAt,
      record.lifecycleObservedAt ?? record.establishedAt,
      latestEvidence?.observedAt ?? record.establishedAt,
      latestOperation?.authorizedAt ?? record.establishedAt,
      latestAction?.requestedAt ?? record.establishedAt,
      latestDeduplication?.observedAt ?? record.establishedAt,
    )
    const requiredExpiry = paymentAuditExpiresAt(latestAuditAt)
    if (requiredExpiry > nowMs) {
      await ctx.db.patch('payToPayments', record._id, {
        auditExpiresAt: requiredExpiry,
      })
      continue
    }
    const retiredIdentity = await ctx.db
      .query('payToPaymentRetiredIdentities')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', record.payToAgreementId),
      )
      .unique()
    if (!retiredIdentity) {
      await ctx.db.insert('payToPaymentRetiredIdentities', {
        payToAgreementId: record.payToAgreementId,
        retiredAt: nowMs,
      })
    }
    await ctx.db.delete('payToPayments', record._id)
    deleted += 1
  }

  return {
    deleted,
    continuationRequired:
      deleted === batchSize ||
      (remaining > 0 && expiredPayments.length === remaining),
  }
}

async function cleanupCompletedWork(
  ctx: MutationCtx,
  cutoff: number,
  batchSize: number,
) {
  let remaining = batchSize
  let deleted = 0

  const creationWork = await ctx.db
    .query('payToPaymentWorkItems')
    .withIndex('by_state_and_completedAt', (q) =>
      q.eq('state', 'completed').lte('completedAt', cutoff),
    )
    .take(remaining)
  for (const record of creationWork) {
    await ctx.db.delete('payToPaymentWorkItems', record._id)
  }
  deleted += creationWork.length
  remaining -= creationWork.length

  const reconciliationWork = await ctx.db
    .query('payToPaymentReconciliationWorkItems')
    .withIndex('by_state_and_availableAt', (q) =>
      q.eq('state', 'stopped').lte('availableAt', cutoff),
    )
    .take(remaining)
  for (const record of reconciliationWork) {
    await ctx.db.delete('payToPaymentReconciliationWorkItems', record._id)
  }
  deleted += reconciliationWork.length
  remaining -= reconciliationWork.length

  const retryWork = await ctx.db
    .query('payToPaymentRetryWorkItems')
    .withIndex('by_state_and_availableAt', (q) =>
      q.eq('state', 'stopped').lte('availableAt', cutoff),
    )
    .take(remaining)
  for (const record of retryWork) {
    await ctx.db.delete('payToPaymentRetryWorkItems', record._id)
  }
  deleted += retryWork.length
  remaining -= retryWork.length

  const agreementCreationWork = await ctx.db
    .query('payToAgreementWorkItems')
    .withIndex('by_state_and_completedAt', (q) =>
      q.eq('state', 'completed').lte('completedAt', cutoff),
    )
    .take(remaining)
  for (const record of agreementCreationWork) {
    await ctx.db.delete('payToAgreementWorkItems', record._id)
  }
  deleted += agreementCreationWork.length
  remaining -= agreementCreationWork.length

  const agreementReconciliationWork = await ctx.db
    .query('payToAgreementReconciliationWorkItems')
    .withIndex('by_state_and_stoppedAt', (q) =>
      q.eq('state', 'stopped').lte('stoppedAt', cutoff),
    )
    .take(remaining)
  for (const record of agreementReconciliationWork) {
    await ctx.db.delete('payToAgreementReconciliationWorkItems', record._id)
  }
  deleted += agreementReconciliationWork.length

  const operations = await ctx.db
    .query('payToPaymentOperations')
    .withIndex('by_mechanicsRetiredAt_and_authorizedAt', (q) =>
      q.eq('mechanicsRetiredAt', undefined).lte('authorizedAt', cutoff),
    )
    .take(batchSize)
  for (const record of operations) {
    await ctx.db.patch('payToPaymentOperations', record._id, {
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      mechanicsRetiredAt: cutoff,
    })
  }

  const evidence = await ctx.db
    .query('payToPaymentEvidence')
    .withIndex('by_mechanicsRetiredAt_and_observedAt', (q) =>
      q.eq('mechanicsRetiredAt', undefined).lte('observedAt', cutoff),
    )
    .take(batchSize)
  for (const record of evidence) {
    await ctx.db.patch('payToPaymentEvidence', record._id, {
      leaseToken: undefined,
      operationLeaseExpiresAt: undefined,
      mechanicsRetiredAt: cutoff,
    })
  }

  return {
    deleted,
    mechanicsRetired: operations.length + evidence.length,
    continuationRequired:
      deleted === batchSize ||
      operations.length === batchSize ||
      evidence.length === batchSize,
  }
}

async function cleanupRejectedDeliveryMetadata(
  ctx: MutationCtx,
  cutoff: number,
  batchSize: number,
) {
  const records = await ctx.db
    .query('zeptoWebhookRejections')
    .withIndex('by_observedAt', (q) => q.lte('observedAt', cutoff))
    .take(batchSize)
  for (const record of records) {
    await ctx.db.delete('zeptoWebhookRejections', record._id)
  }
  return records.length
}

const cleanupResultValidator = v.object({
  auditEvidenceDeleted: v.number(),
  completedWorkDeleted: v.number(),
  leaseMechanicsRetired: v.number(),
  rejectedDeliveryMetadataDeleted: v.number(),
  continuationScheduled: v.boolean(),
})

export const recordRejectedDelivery = internalMutation({
  args: zeptoWebhookRejectionValidator.fields,
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('zeptoWebhookRejections', args)
    return null
  },
})

export const cleanupExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: cleanupResultValidator,
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now()
    const batchSize = Math.max(
      1,
      Math.min(MAX_BATCH_SIZE, Math.floor(args.batchSize ?? MAX_BATCH_SIZE)),
    )
    const auditCleanup = await cleanupAuditEvidence(ctx, nowMs, batchSize)
    const completedWork = await cleanupCompletedWork(
      ctx,
      nowMs - PAY_TO_PAYMENT_WORK_RETENTION_MS,
      batchSize,
    )
    const rejectedDeliveryMetadataDeleted =
      await cleanupRejectedDeliveryMetadata(
        ctx,
        nowMs - REJECTED_WEBHOOK_RETENTION_MS,
        batchSize,
      )
    const continuationScheduled =
      auditCleanup.continuationRequired ||
      completedWork.continuationRequired ||
      rejectedDeliveryMetadataDeleted === batchSize
    if (continuationScheduled) {
      await ctx.scheduler.runAfter(
        0,
        internal.payToPaymentRetention.cleanupExpired,
        { nowMs, batchSize },
      )
    }
    return {
      auditEvidenceDeleted: auditCleanup.deleted,
      completedWorkDeleted: completedWork.deleted,
      leaseMechanicsRetired: completedWork.mechanicsRetired,
      rejectedDeliveryMetadataDeleted,
      continuationScheduled,
    }
  },
})
