import { env } from '../../_generated/server'
import { createZeptoClient } from './client'
import type {
  CreateZeptoClientOptions,
  ZeptoClient,
  ZeptoEnvironment,
} from './client'
import { ZeptoClientError } from './error'

export function configuredZeptoEnvironment(): ZeptoEnvironment {
  if (
    env.ZEPTO_ENVIRONMENT !== 'sandbox' &&
    env.ZEPTO_ENVIRONMENT !== 'production'
  ) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message: 'ZEPTO_ENVIRONMENT must be configured.',
    })
  }
  return env.ZEPTO_ENVIRONMENT
}

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
export function createSandboxZeptoClientFromEnv(
  options: Pick<CreateZeptoClientOptions, 'onAttempt' | 'maxRetries'> = {},
): ZeptoClient {
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
    ...options,
  })
}

/** Create a PayTo Agreement client using only credentials for its durable environment. */
export function createEnvironmentZeptoClientFromEnv(
  environment: ZeptoEnvironment,
  options: Pick<CreateZeptoClientOptions, 'onAttempt' | 'maxRetries'> = {},
): ZeptoClient {
  if (configuredZeptoEnvironment() !== environment) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message:
        'PayTo Agreement environment does not match the configured Zepto environment.',
    })
  }
  if (environment === 'sandbox') {
    return createSandboxZeptoClientFromEnv(options)
  }
  if (!env.ZEPTO_PERSONAL_ACCESS_TOKEN) {
    throw new ZeptoClientError({
      kind: 'configuration',
      message:
        'ZEPTO_PERSONAL_ACCESS_TOKEN must be configured for production PayTo Agreement work.',
    })
  }
  return createZeptoClient({
    environment: 'production',
    accessToken: env.ZEPTO_PERSONAL_ACCESS_TOKEN,
    ...options,
  })
}
