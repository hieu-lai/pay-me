import type { Infer } from 'convex/values'
import { v } from 'convex/values'

import { zeptoEnvironmentValidator } from './payToAgreements'

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

export const zeptoWebhookClassificationValidator = v.union(
  v.literal('supported_agreement'),
  v.literal('supported_payment'),
  v.literal('unsupported_event'),
  v.literal('unsupported_resource'),
)

export const zeptoWebhookItemValidator = v.object({
  providerEventId: v.string(),
  eventType: v.string(),
  resourceUid: v.string(),
  resourceType: v.string(),
  classification: zeptoWebhookClassificationValidator,
  providerPublishedAt: v.number(),
  causedBy: v.optional(zeptoWebhookCausedByValidator),
  reason: v.optional(zeptoWebhookReasonValidator),
})
export type ZeptoWebhookItem = Infer<typeof zeptoWebhookItemValidator>

const zeptoWebhookDeliveryBaseValidator = v.object({
  deliveryId: v.string(),
  signatureTimestamp: v.number(),
  receivedAt: v.number(),
})

export const zeptoWebhookDeliveryValidator =
  zeptoWebhookDeliveryBaseValidator.extend({
    environment: v.optional(zeptoEnvironmentValidator),
    payloadHash: v.optional(v.string()),
  })

export const zeptoWebhookEventValidator = zeptoWebhookItemValidator
  .omit('resourceType', 'classification')
  .extend({
    resourceType: v.optional(v.string()),
    classification: v.optional(zeptoWebhookClassificationValidator),
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

export const applyZeptoWebhookDeliveryValidator = v.object({
  ...zeptoWebhookDeliveryBaseValidator.fields,
  environment: zeptoEnvironmentValidator,
  payloadHash: v.string(),
  items: v.array(zeptoWebhookItemValidator),
})
