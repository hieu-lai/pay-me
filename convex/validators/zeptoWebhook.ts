import type { Infer } from 'convex/values'
import { v } from 'convex/values'

export const zeptoWebhookCausedByValidator = v.union(
  v.literal('debtor'),
  v.literal('initiator'),
  v.literal('zepto_admin'),
  v.literal('zepto_system'),
)

export const zeptoWebhookReasonValidator = v.object({
  code: v.optional(v.string()),
  title: v.optional(v.string()),
  detail: v.optional(v.string()),
})

export const zeptoWebhookItemValidator = v.object({
  providerEventId: v.string(),
  eventType: v.string(),
  resourceUid: v.string(),
  providerPublishedAt: v.number(),
  causedBy: v.optional(zeptoWebhookCausedByValidator),
  reason: v.optional(zeptoWebhookReasonValidator),
})
export type ZeptoWebhookItem = Infer<typeof zeptoWebhookItemValidator>

export const zeptoWebhookDeliveryValidator = v.object({
  deliveryId: v.string(),
  signatureTimestamp: v.number(),
  receivedAt: v.number(),
})

export const zeptoWebhookEventValidator = zeptoWebhookItemValidator.extend({
  deliveryId: v.string(),
  observedAt: v.number(),
})

export const zeptoWebhookOutcomeValidator = v.union(
  v.literal('applied'),
  v.literal('unknown'),
  v.literal('conflict'),
)

export const zeptoWebhookEvidenceValidator = zeptoWebhookItemValidator
  .pick('providerEventId', 'eventType', 'providerPublishedAt')
  .extend({
    deliveryId: v.string(),
    outcome: zeptoWebhookOutcomeValidator,
  })

export const applyZeptoWebhookDeliveryValidator =
  zeptoWebhookDeliveryValidator.extend({
    items: v.array(zeptoWebhookItemValidator),
  })
