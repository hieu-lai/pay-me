import { Workpool } from '@convex-dev/workpool'

import { components } from '../_generated/api'

export const paymentCreationPool = new Workpool(
  components.paymentCreationWorkpool,
  {
    maxParallelism: 5,
    retryActionsByDefault: false,
  },
)
