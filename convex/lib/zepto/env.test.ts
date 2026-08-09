import { afterEach, describe, expect, test } from 'vitest'

import { createZeptoClientFromEnv } from './env'

const originalEnvironment = process.env.ZEPTO_ENVIRONMENT
const originalToken = process.env.ZEPTO_PERSONAL_ACCESS_TOKEN

afterEach(() => {
  if (originalEnvironment === undefined) delete process.env.ZEPTO_ENVIRONMENT
  else process.env.ZEPTO_ENVIRONMENT = originalEnvironment

  if (originalToken === undefined)
    delete process.env.ZEPTO_PERSONAL_ACCESS_TOKEN
  else process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = originalToken
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
})
