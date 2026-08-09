import { describe, expect, test } from 'vitest'

import { formSchema } from './schema'

describe('request schema', () => {
  test('requires at least one recipient', () => {
    const result = formSchema.safeParse({
      amount: '10',
      description: 'Lunch',
      recipients: [],
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['recipients'],
          message: 'Choose at least one recipient.',
        }),
      ]),
    )
  })
})
