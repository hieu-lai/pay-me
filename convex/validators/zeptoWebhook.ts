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
  // Legacy documents may contain free-form fields. New ingress uses the safe
  // validator below; migration removes these before a later schema tightening.
  title: v.optional(v.string()),
  detail: v.optional(v.string()),
})

const safeZeptoWebhookReasonValidator = v.object({
  code: v.optional(v.string()),
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
  reason: v.optional(safeZeptoWebhookReasonValidator),
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
  .omit('resourceType', 'classification', 'reason')
  .extend({
    resourceType: v.optional(v.string()),
    classification: v.optional(zeptoWebhookClassificationValidator),
    deliveryId: v.string(),
    observedAt: v.number(),
    reason: v.optional(zeptoWebhookReasonValidator),
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

export const zeptoWebhookRejectionValidator = v.object({
  environment: v.optional(zeptoEnvironmentValidator),
  reason: v.union(v.literal('missing_headers'), v.literal('invalid_signature')),
  deliveryId: v.optional(v.string()),
  payloadHash: v.optional(v.string()),
  observedAt: v.number(),
})
