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

/** Create the client used by sandbox-only provider workers. */
export function createSandboxZeptoClientFromEnv(): ZeptoClient {
  if (env.ZEPTO_ENVIRONMENT !== 'sandbox') {
    throw new ZeptoClientError({
      kind: 'sandbox_only',
      message:
        'Sandbox agreement work requires sandbox-only Zepto configuration.',
    })
  }
  if (!env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message:
        'ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN must be configured for sandbox agreement work.',
    })
  }
  return createZeptoClient({
    environment: 'sandbox',
    accessToken: env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN,
  })
}
