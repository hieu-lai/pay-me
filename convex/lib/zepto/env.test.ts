import { afterEach, describe, expect, test } from 'vitest'

import {
  createSandboxZeptoClientFromEnv,
  createZeptoClientFromEnv,
} from './env'

const originalEnvironment = process.env.ZEPTO_ENVIRONMENT
const originalToken = process.env.ZEPTO_PERSONAL_ACCESS_TOKEN
const originalSandboxToken = process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.ZEPTO_ENVIRONMENT
  else process.env.ZEPTO_ENVIRONMENT = originalEnvironment

  if (originalToken === undefined)
    delete process.env.ZEPTO_PERSONAL_ACCESS_TOKEN
  else process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = originalToken

  if (originalSandboxToken === undefined)
    delete process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN
  else process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = originalSandboxToken
})

describe('createZeptoClientFromEnv', () => {
  test('requires both optional Convex environment variables', () => {
    delete process.env.ZEPTO_ENVIRONMENT
    delete process.env.ZEPTO_PERSONAL_ACCESS_TOKEN

    expect(() => createZeptoClientFromEnv()).toThrow(
      'ZEPTO_ENVIRONMENT and ZEPTO_PERSONAL_ACCESS_TOKEN must both be configured.',
    )
  })

  test('creates all namespaces from configured values', () => {
    process.env.ZEPTO_ENVIRONMENT = 'sandbox'
    process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'test-token'

    expect(createZeptoClientFromEnv()).toEqual(
      expect.objectContaining({
        core: expect.any(Object),
        payTo: expect.any(Object),
        clients: expect.any(Object),
        merchantReports: expect.any(Object),
        investigations: expect.any(Object),
        confirmationOfPayee: expect.any(Object),
      }),
    )
  })

  test('denies production credentials to sandbox-only agreement work', () => {
    process.env.ZEPTO_ENVIRONMENT = 'sandbox'
    process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'production-token'
    delete process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN

    expect(() => createSandboxZeptoClientFromEnv()).toThrow(
      'ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN must be configured',
    )
  })

  test('creates sandbox agreement clients only from sandbox credentials', () => {
    process.env.ZEPTO_ENVIRONMENT = 'sandbox'
    process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'production-token'
    process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-token'

    expect(createSandboxZeptoClientFromEnv()).toEqual(
      expect.objectContaining({ payTo: expect.any(Object) }),
    )
  })

  test('denies sandbox credentials when the configured origin is production', () => {
    process.env.ZEPTO_ENVIRONMENT = 'production'
    process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN = 'sandbox-token'

    expect(() => createSandboxZeptoClientFromEnv()).toThrow(
      'Sandbox agreement work requires sandbox-only Zepto configuration.',
    )
  })
})
