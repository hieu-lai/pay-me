import { v } from 'convex/values'

export const payerPaymentStatusValidator = v.union(
  v.literal('not_started'),
  v.literal('initiating'),
  v.literal('processing'),
  v.literal('under_investigation'),
  v.literal('failed'),
  v.literal('paid'),
)

export const payerPaymentCountsValidator = v.object({
  not_started: v.number(),
  initiating: v.number(),
  processing: v.number(),
  under_investigation: v.number(),
  failed: v.number(),
  paid: v.number(),
})

export const moneyRequestPaymentStatusValidator = v.union(
  v.literal('unpaid'),
  v.literal('paid'),
)
