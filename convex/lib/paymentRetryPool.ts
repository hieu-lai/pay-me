import { Workpool } from '@convex-dev/workpool'

import { components } from '../_generated/api'

export const paymentRetryPool = new Workpool(components.paymentRetryWorkpool, {
  maxParallelism: 5,
  retryActionsByDefault: false,
})
