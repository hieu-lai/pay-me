import { describe, expect, test } from 'vitest'

import { defaultValues, formSchema } from './schema'

function messagesFor(input: unknown) {
  const result = formSchema.safeParse(input)
  expect(result.success).toBe(false)
  if (result.success) return []
  return result.error.issues.map(({ message }) => message)
}

describe('add payout method schema', () => {
  test('defaults to PayID', () => {
    expect(defaultValues.method).toBe('payid')
  })

  test('accepts a complete bank account and trims text fields', () => {
    expect(
      formSchema.parse({
        label: '  Main account  ',
        method: 'bankAccount',
        accountName: '  Ada Lovelace  ',
        bsb: '123-456',
        accountNumber: '0012 345',
      }),
    ).toEqual({
      label: 'Main account',
      method: 'bankAccount',
      accountName: 'Ada Lovelace',
      bsb: '123-456',
      accountNumber: '0012 345',
    })
  })

  test('requires every bank account field', () => {
    expect(messagesFor({ label: '', method: 'bankAccount' })).toEqual(
      expect.arrayContaining([
        'Enter a label for this payout method.',
        'Enter the name on the bank account.',
        'Enter the 6-digit BSB.',
        'Enter the bank account number.',
      ]),
    )
  })

  test('validates bank account details', () => {
    expect(
      messagesFor({
        label: 'Main',
        method: 'bankAccount',
        accountName: 'Ada Lovelace',
        bsb: '12345',
        accountNumber: '1234567890',
      }),
    ).toEqual(
      expect.arrayContaining([
        'Enter a valid 6-digit BSB.',
        'Account number must be 1 to 9 letters, numbers, spaces, or hyphens.',
      ]),
    )
  })

  test.each([
    ['email', 'person@example.com'],
    ['mobile', '0412 345 678'],
    ['abn', '51 824 753 556'],
    ['organisationIdentifier', 'Example Campaign'],
  ] as const)('accepts a valid %s PayID', (payIdType, value) => {
    expect(
      formSchema.safeParse({
        label: 'PayID',
        method: 'payid',
        payIdType,
        value,
      }).success,
    ).toBe(true)
  })

  test('requires a PayID type and value', () => {
    expect(messagesFor({ label: 'PayID', method: 'payid' })).toEqual([
      'Choose a PayID type.',
    ])

    expect(
      messagesFor({
        label: 'PayID',
        method: 'payid',
        payIdType: 'email',
      }),
    ).toEqual(['Enter the email address used for this PayID.'])
  })

  test.each([
    ['email', 'not-an-email', 'Enter a valid email address.'],
    [
      'mobile',
      '0312 345 678',
      'Enter an Australian mobile number starting with 04 or +614.',
    ],
    ['abn', '11 111 111 111', 'Enter a valid 11-digit ABN.'],
    [
      'organisationIdentifier',
      'Café',
      'Enter an organisation identifier using 1 to 256 printable characters.',
    ],
  ] as const)(
    'shows a friendly error for an invalid %s PayID',
    (payIdType, value, message) => {
      expect(
        messagesFor({
          label: 'PayID',
          method: 'payid',
          payIdType,
          value,
        }),
      ).toContain(message)
    },
  )

  test('requires the user to choose a supported method', () => {
    expect(messagesFor({ label: 'Main' })).toEqual([
      'Choose bank account or PayID.',
    ])
  })
})
