import { describe, expect, test } from 'vitest'

import { formSchema } from './schema'

describe('request schema', () => {
  test('accepts amounts with up to two decimal places', () => {
    const result = formSchema.safeParse({
      amount: '1234.56',
      description: 'Lunch',
      payers: [
        {
          id: 'payer-id',
          name: 'Payer',
          hasPaymentDestination: true,
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test('rejects amounts smaller than one cent precision', () => {
    const result = formSchema.safeParse({
      amount: '1.001',
      description: 'Lunch',
      payers: [
        {
          id: 'payer-id',
          name: 'Payer',
          hasPaymentDestination: true,
        },
      ],
    })

    expect(result.success).toBe(false)
  })

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
