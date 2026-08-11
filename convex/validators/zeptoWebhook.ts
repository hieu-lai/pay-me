import type { Infer } from 'convex/values'
import { v } from 'convex/values'

export const zeptoWebhookItemValidator = v.object({
  providerEventId: v.string(),
  eventType: v.string(),
  resourceUid: v.string(),
  providerPublishedAt: v.number(),
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
