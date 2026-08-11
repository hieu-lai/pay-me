import { describe, expect, test } from 'vitest'

import { formSchema } from './schema'

describe('request schema', () => {
  test('requires at least one Payer', () => {
    const result = formSchema.safeParse({
      amount: '10',
      description: 'Lunch',
      payers: [],
    })

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['payers'],
          message: 'Choose at least one Payer.',
        }),
      ]),
    )
  })
})
