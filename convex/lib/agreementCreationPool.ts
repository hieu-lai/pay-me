import { Workpool } from '@convex-dev/workpool'

import { components } from '../_generated/api'

export const agreementCreationPool = new Workpool(
  components.agreementCreationWorkpool,
  {
    maxParallelism: 5,
    retryActionsByDefault: false,
  },
)
