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
    error.status === 422 &&
    duplicateUidCode(error.body)
  ) {
    return 'duplicate_uid'
  }
  if (
    error instanceof ZeptoClientError &&
    createErrorCategories.has(error.kind)
  ) {
    return error.kind as PayToPaymentCreateErrorCategory
  }
  return 'unclassified'
}

function duplicateUidCode(body: unknown) {
  if (typeof body !== 'object' || body === null) return false
  const record = body as Record<string, unknown>
  if (record.code === 'ZPPAY00') return true
  if (typeof record.error === 'object' && record.error !== null) {
    if ((record.error as Record<string, unknown>).code === 'ZPPAY00') {
      return true
    }
  }
  return (
    Array.isArray(record.errors) &&
    record.errors.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).code === 'ZPPAY00',
    )
  )
}

function deterministicCreateFailure(error: unknown) {
  return (
    error instanceof ZeptoClientError &&
    error.kind === 'http' &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    errorCategory(error) !== 'duplicate_uid'
  )
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

    let client: ReturnType<typeof createEnvironmentZeptoClientFromEnv>
    try {
      client = createEnvironmentZeptoClientFromEnv(input.environment, {
        maxRetries: 0,
      })
    } catch (error) {
      await ctx.runMutation(
        internal.payToPayments.recordCreatePreDispatchFailure,
        {
          payToPaymentId: input.payToPaymentId,
          operationId: input.operationId,
          leaseToken,
          errorCategory: errorCategory(error),
          observedAt: Date.now(),
        },
      )
      return null
    }

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
        failureDisposition: deterministicCreateFailure(error)
          ? 'deterministic'
          : 'ambiguous',
        observedAt: Date.now(),
      })
    }
    return null
  },
})
