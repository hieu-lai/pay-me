import { env } from '../../_generated/server'
import { createZeptoClient } from './client'
import type { ZeptoClient } from './client'
import { ZeptoClientError } from './error'

/** Create the client from optional typed Convex environment variables. */
export function createZeptoClientFromEnv(): ZeptoClient {
  if (!env.ZEPTO_ENVIRONMENT || !env.ZEPTO_PERSONAL_ACCESS_TOKEN) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message:
        'ZEPTO_ENVIRONMENT and ZEPTO_PERSONAL_ACCESS_TOKEN must both be configured.',
    })
  }

  return createZeptoClient({
    environment: env.ZEPTO_ENVIRONMENT,
    accessToken: env.ZEPTO_PERSONAL_ACCESS_TOKEN,
  })
}
