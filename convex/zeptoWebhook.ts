import { v } from 'convex/values'

import type { Id } from './_generated/dataModel'
import { internalMutation } from './_generated/server'
import type { ProviderAgreementState } from './validators/payToAgreements'

const webhookItemValidator = v.object({
  providerEventId: v.string(),
  eventType: v.string(),
  resourceUid: v.string(),
  providerPublishedAt: v.number(),
})

const lifecycleStateByEventType: Partial<
  Record<string, ProviderAgreementState>
> = {
  'payto_agreement.activated': 'active',
  'payto_agreement.cancelled': 'cancelled',
  'payto_agreement.declined': 'declined',
  'payto_agreement.expired': 'expired',
  'payto_agreement.failed': 'failed',
  'payto_agreement.reactivated': 'active',
  'payto_agreement.suspended': 'suspended',
}

const terminalLifecycleStates = new Set([
  'cancelled',
  'declined',
  'failed',
  'expired',
])

export const applyDelivery = internalMutation({
  args: {
    deliveryId: v.string(),
    signatureTimestamp: v.number(),
    receivedAt: v.number(),
    items: v.array(webhookItemValidator),
  },
  returns: v.object({ duplicate: v.boolean(), appliedItems: v.number() }),
  handler: async (ctx, args) => {
    const existingDelivery = await ctx.db
      .query('zeptoWebhookDeliveries')
      .withIndex('by_deliveryId', (q) => q.eq('deliveryId', args.deliveryId))
      .unique()
    if (existingDelivery) return { duplicate: true, appliedItems: 0 }

    await ctx.db.insert('zeptoWebhookDeliveries', {
      deliveryId: args.deliveryId,
      signatureTimestamp: args.signatureTimestamp,
      receivedAt: args.receivedAt,
    })

    let appliedItems = 0
    const eventIdsInDelivery = new Set<string>()
    const reconciliationIds = new Set<Id<'payToAgreements'>>()
    for (const item of args.items) {
      if (eventIdsInDelivery.has(item.providerEventId)) continue
      eventIdsInDelivery.add(item.providerEventId)
      const existingEvent = await ctx.db
        .query('zeptoWebhookEvents')
        .withIndex('by_providerEventId', (q) =>
          q.eq('providerEventId', item.providerEventId),
        )
        .unique()
      if (existingEvent) continue

      await ctx.db.insert('zeptoWebhookEvents', {
        ...item,
        deliveryId: args.deliveryId,
        observedAt: args.receivedAt,
      })
      appliedItems += 1

      const agreement = await ctx.db
        .query('payToAgreements')
        .withIndex('by_environment_and_providerUid', (q) =>
          q.eq('environment', 'sandbox').eq('providerUid', item.resourceUid),
        )
        .unique()
      if (!agreement) continue

      const nextState = lifecycleStateByEventType[item.eventType]
      const conflictsWithConfirmedTerminal =
        nextState !== undefined &&
        agreement.lifecycleConfidence === 'confirmed' &&
        terminalLifecycleStates.has(agreement.lifecycleState) &&
        nextState !== agreement.lifecycleState
      const outcome =
        nextState === undefined
          ? 'unknown'
          : conflictsWithConfirmedTerminal
            ? 'conflict'
            : 'applied'
      if (
        nextState !== undefined &&
        !conflictsWithConfirmedTerminal &&
        !(
          agreement.lifecycleConfidence === 'confirmed' &&
          nextState === agreement.lifecycleState
        )
      ) {
        await ctx.db.patch('payToAgreements', agreement._id, {
          lifecycleState: nextState,
          lifecycleConfidence: 'provisional',
          lifecycleObservedAt: args.receivedAt,
          trackingState: 'verification_due',
          trackingUpdatedAt: args.receivedAt,
        })
      }
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId: agreement._id,
        kind: 'provider_webhook_observed',
        deliveryId: args.deliveryId,
        providerEventId: item.providerEventId,
        eventType: item.eventType,
        providerPublishedAt: item.providerPublishedAt,
        outcome,
        observedAt: args.receivedAt,
      })
      reconciliationIds.add(agreement._id)
    }

    for (const payToAgreementId of reconciliationIds) {
      const existing = await ctx.db
        .query('payToAgreementReconciliationWorkItems')
        .withIndex('by_payToAgreementId', (q) =>
          q.eq('payToAgreementId', payToAgreementId),
        )
        .unique()
      if (existing) {
        await ctx.db.patch(
          'payToAgreementReconciliationWorkItems',
          existing._id,
          {
            state: 'queued',
            availableAt: Math.min(existing.availableAt, args.receivedAt),
          },
        )
      } else {
        await ctx.db.insert('payToAgreementReconciliationWorkItems', {
          payToAgreementId,
          state: 'queued',
          availableAt: args.receivedAt,
        })
      }
    }

    return { duplicate: false, appliedItems }
  },
})
