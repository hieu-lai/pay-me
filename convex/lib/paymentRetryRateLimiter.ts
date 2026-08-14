import { RateLimiter } from '@convex-dev/rate-limiter'

import { components } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

export const paymentRetryRateLimiter = new RateLimiter(
  components.paymentRetryRateLimiter,
  {
    retryEndpointCalls: {
      kind: 'fixed window',
      rate: 6,
      capacity: 6,
      period: Number.MAX_SAFE_INTEGER,
      start: 0,
    },
  },
)

export async function consumePaymentRetryEndpointCall(
  ctx: MutationCtx,
  payToPaymentId: Id<'payToPayments'>,
) {
  return await paymentRetryRateLimiter.limit(ctx, 'retryEndpointCalls', {
    key: payToPaymentId,
  })
}
