import { v } from 'convex/values'

import { internal } from './_generated/api'
import { internalAction } from './_generated/server'
import { createEnvironmentZeptoClientFromEnv } from './lib/zepto/env'
import { ZeptoClientError } from './lib/zepto/error'
import { createPayment } from './lib/zepto/payment'
import type { PayToPaymentCreateErrorCategory } from './validators/payToPayments'
import { payToPaymentCreateErrorCategories } from './validators/payToPayments'

const createErrorCategories = new Set<string>(payToPaymentCreateErrorCategories)

function errorCategory(error: unknown): PayToPaymentCreateErrorCategory {
  if (
    error instanceof ZeptoClientError &&
    createErrorCategories.has(error.kind)
  ) {
    return error.kind as PayToPaymentCreateErrorCategory
  }
  return 'unclassified'
}

export const create = internalAction({
  args: { payToPaymentId: v.id('payToPayments') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leaseToken = crypto.randomUUID()
    const input = await ctx.runMutation(
      internal.payToPayments.claimCreateWork,
      {
        payToPaymentId: args.payToPaymentId,
        leaseToken,
        nowMs: Date.now(),
      },
    )
    if (!input) return null

    const dispatchAuthorized: boolean = await ctx.runMutation(
      internal.payToPayments.markCreateDispatchStarted,
      {
        payToPaymentId: input.payToPaymentId,
        operationId: input.operationId,
        leaseToken,
        observedAt: Date.now(),
      },
    )
    if (!dispatchAuthorized) return null

    try {
      const client = createEnvironmentZeptoClientFromEnv(input.environment, {
        maxRetries: 0,
      })
      const created = await createPayment(client, {
        providerUid: input.providerUid,
        agreementProviderUid: input.agreementProviderUid,
        amountCents: input.amountCents,
        priority: input.priority,
      })
      await ctx.runMutation(internal.payToPayments.recordCreateResult, {
        payToPaymentId: input.payToPaymentId,
        operationId: input.operationId,
        leaseToken,
        providerState: created.state,
        providerCreatedAt: Date.parse(created.createdAt),
        observedAt: Date.now(),
      })
    } catch (error) {
      await ctx.runMutation(internal.payToPayments.recordCreateFailure, {
        payToPaymentId: input.payToPaymentId,
        operationId: input.operationId,
        leaseToken,
        errorCategory: errorCategory(error),
        observedAt: Date.now(),
      })
    }
    return null
  },
})
