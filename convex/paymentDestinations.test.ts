/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, test } from 'vitest'

import { api, internal } from './_generated/api'
import {
  paymentDestinationSearchLabelPatch,
  searchLabelFor,
} from './migrations'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const encryptionKeyV1 = btoa('0123456789abcdef0123456789abcdef')
const encryptionKeyV2 = btoa('abcdef0123456789abcdef0123456789')
const fingerprintKey = btoa('fingerprint-key-32-bytes-long!!xx')

const firstIdentity = {
  tokenIdentifier: 'https://clerk.example.test|user_destination_1',
  subject: 'user_destination_1',
  issuer: 'https://clerk.example.test',
  email: 'first@example.com',
  name: 'First User',
} satisfies UserIdentity

const secondIdentity = {
  tokenIdentifier: 'https://clerk.example.test|user_destination_2',
  subject: 'user_destination_2',
  issuer: 'https://clerk.example.test',
  email: 'second@example.com',
  name: 'Second User',
} satisfies UserIdentity

function addUserArgs(identity: typeof firstIdentity | typeof secondIdentity) {
  return {
    tokenIdentifier: identity.tokenIdentifier,
    clerkUserId: identity.subject,
    email: identity.email,
    name: identity.name,
  }
}

async function setup() {
  const t = convexTest(schema, modules)
  const firstUserId = await t.mutation(
    internal.users.addUser,
    addUserArgs(firstIdentity),
  )
  const secondUserId = await t.mutation(
    internal.users.addUser,
    addUserArgs(secondIdentity),
  )
  return {
    t,
    first: t.withIdentity(firstIdentity),
    second: t.withIdentity(secondIdentity),
    firstUserId,
    secondUserId,
  }
}

async function createBank(
  authenticated: Awaited<ReturnType<typeof setup>>['first'],
  overrides: Partial<{
    accountName: string
    bsb: string
    accountNumber: string
    label: string
    setAsDefault: boolean
  }> = {},
) {
  const {
    label,
    setAsDefault,
    accountName = 'Ada Lovelace',
    bsb = '123-456',
    accountNumber = '0012 345',
  } = overrides
  return await authenticated.action(api.paymentDestinations.create, {
    destination: { kind: 'bankAccount', accountName, bsb, accountNumber },
    ...(label === undefined ? {} : { label }),
    ...(setAsDefault === undefined ? {} : { setAsDefault }),
  })
}

async function createPayId(
  authenticated: Awaited<ReturnType<typeof setup>>['first'],
  payIdType: 'mobile' | 'email' | 'abn' | 'organisationIdentifier',
  value: string,
  setAsDefault?: boolean,
) {
  return await authenticated.action(api.paymentDestinations.create, {
    destination: { kind: 'payId', payIdType, value },
    ...(setAsDefault === undefined ? {} : { setAsDefault }),
  })
}

async function listDestinations(
  authenticated: Awaited<ReturnType<typeof setup>>['first'],
) {
  const result = await authenticated.query(api.paymentDestinations.list, {
    paginationOpts: { numItems: 50, cursor: null },
  })
  return result.page
}

async function searchDestinations(
  authenticated: Awaited<ReturnType<typeof setup>>['first'],
  search: string,
  numItems = 50,
  cursor: string | null = null,
) {
  return await authenticated.query(api.paymentDestinations.list, {
    paginationOpts: { numItems, cursor },
    search,
  })
}

beforeEach(() => {
  process.env.PAYMENT_DESTINATION_ENCRYPTION_KEYS = JSON.stringify({
    v1: encryptionKeyV1,
  })
  process.env.PAYMENT_DESTINATION_CURRENT_ENCRYPTION_KEY_VERSION = 'v1'
  process.env.PAYMENT_DESTINATION_FINGERPRINT_KEY = fingerprintKey
})

describe('payment destination storage and display', () => {
  test('encrypts normalized bank details and makes the first destination default', async () => {
    const { t, first, firstUserId } = await setup()
    const destinationId = await createBank(first, { label: '  Everyday  ' })

    const [masked] = await listDestinations(first)
    expect(masked).toEqual({
      id: destinationId,
      kind: 'bankAccount',
      label: 'Everyday',
      maskedDisplay: 'Bank account ••••2345',
      maskedAccountName: 'A** L*******',
      maskedBsb: '***-456',
      maskedAccountNumber: '••••2345',
      isDefault: true,
    })
    await expect(
      first.action(api.paymentDestinations.reveal, { destinationId }),
    ).resolves.toEqual({
      id: destinationId,
      kind: 'bankAccount',
      label: 'Everyday',
      accountName: 'Ada Lovelace',
      bsb: '123456',
      accountNumber: '0012 345',
      isDefault: true,
    })

    const stored = await t.run(async (ctx) =>
      ctx.db.get('paymentDestinations', destinationId),
    )
    expect(stored).toMatchObject({
      ownerUserId: firstUserId,
      kind: 'bankAccount',
      searchLabel: 'Everyday',
      maskedAccountName: 'A** L*******',
      maskedBsb: '***-456',
      maskedAccountNumber: '••••2345',
      accountName: {
        ciphertext: expect.any(String),
        nonce: expect.any(String),
        keyVersion: 'v1',
      },
      bsb: {
        ciphertext: expect.any(String),
        nonce: expect.any(String),
        keyVersion: 'v1',
      },
      accountNumber: {
        ciphertext: expect.any(String),
        nonce: expect.any(String),
        keyVersion: 'v1',
      },
    })
    expect(stored).not.toHaveProperty('ciphertext')
    expect(stored).not.toHaveProperty('nonce')
    expect(stored).not.toHaveProperty('keyVersion')
    if (!stored || stored.kind !== 'bankAccount') {
      throw new Error('Expected a stored Bank Account destination.')
    }
    expect(
      new Set([
        stored.accountName.nonce,
        stored.bsb.nonce,
        stored.accountNumber.nonce,
      ]).size,
    ).toBe(3)
    expect(JSON.stringify(stored)).not.toContain('Ada Lovelace')
    expect(JSON.stringify(stored)).not.toContain('123456')
    expect(
      await t.run(async (ctx) => ctx.db.get('users', firstUserId)),
    ).toMatchObject({ defaultPaymentDestinationId: destinationId })
  })

  test('never reveals an entire unusually short bank account in its mask', async () => {
    const { first } = await setup()
    await createBank(first, { accountNumber: '7' })

    const [masked] = await listDestinations(first)
    expect(masked.maskedDisplay).toBe('Bank account ••••')
    expect(masked).toMatchObject({ maskedAccountNumber: '••••' })
  })

  test.each([
    ['0412 345 678', '+61-412345678'],
    ['+61412345678', '+61-412345678'],
    ['+61-4 1234 5678', '+61-412345678'],
  ])('normalizes mobile PayID %s to %s', async (input, canonical) => {
    const { first } = await setup()
    const destinationId = await createPayId(first, 'mobile', input)

    await expect(
      first.action(api.paymentDestinations.reveal, { destinationId }),
    ).resolves.toMatchObject({
      kind: 'payId',
      payIdType: 'mobile',
      value: canonical,
    })
    const [masked] = await listDestinations(first)
    expect(masked.maskedDisplay).toBe('**** *** 678')
  })

  test.each([
    ['email', '  Jane.Doe@GMAIL.com ', 'jane.doe@gmail.com', 'j***@gmail.com'],
    ['abn', '51 824 753 556', '51824753556', '** *** *** 556'],
    [
      'organisationIdentifier',
      '  Example Campaign  ',
      'example campaign',
      'e***',
    ],
  ] as const)(
    'normalizes and masks %s PayIDs',
    async (payIdType, input, canonical, mask) => {
      const { first } = await setup()
      const destinationId = await createPayId(first, payIdType, input)

      await expect(
        first.action(api.paymentDestinations.reveal, { destinationId }),
      ).resolves.toMatchObject({ value: canonical })
      const [masked] = await listDestinations(first)
      expect(masked.maskedDisplay).toBe(mask)
    },
  )

  test('uses the stored key version when keys rotate', async () => {
    const { first } = await setup()
    const destinationId = await createBank(first)
    process.env.PAYMENT_DESTINATION_ENCRYPTION_KEYS = JSON.stringify({
      v1: encryptionKeyV1,
      v2: encryptionKeyV2,
    })
    process.env.PAYMENT_DESTINATION_CURRENT_ENCRYPTION_KEY_VERSION = 'v2'

    await expect(
      first.action(api.paymentDestinations.reveal, { destinationId }),
    ).resolves.toMatchObject({ bsb: '123456' })
    const secondDestinationId = await createPayId(
      first,
      'email',
      'rotated@example.com',
    )
    const stored = await listDestinations(first)
    expect(stored).toHaveLength(2)
    await expect(
      first.action(api.paymentDestinations.reveal, {
        destinationId: secondDestinationId,
      }),
    ).resolves.toMatchObject({ value: 'rotated@example.com' })
  })

  test('lists destinations across cursor-based pages', async () => {
    const { first } = await setup()
    const destinationIds = [
      await createPayId(first, 'email', 'one@example.com'),
      await createPayId(first, 'email', 'two@example.com'),
      await createPayId(first, 'email', 'three@example.com'),
    ]

    const firstPage = await first.query(api.paymentDestinations.list, {
      paginationOpts: { numItems: 2, cursor: null },
    })
    expect(firstPage.page.map(({ id }) => id)).toEqual(
      destinationIds.slice(0, 2),
    )
    expect(firstPage.isDone).toBe(false)

    const secondPage = await first.query(api.paymentDestinations.list, {
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    })
    expect(secondPage.page.map(({ id }) => id)).toEqual(destinationIds.slice(2))
    expect(secondPage.isDone).toBe(true)
  })

  test('lists the default destination first across cursor-based pages', async () => {
    const { first } = await setup()
    const destinationIds = [
      await createPayId(first, 'email', 'one@example.com'),
      await createPayId(first, 'email', 'two@example.com'),
      await createPayId(first, 'email', 'three@example.com'),
      await createPayId(first, 'email', 'four@example.com'),
    ]
    await first.mutation(api.paymentDestinations.setDefault, {
      destinationId: destinationIds[2],
    })

    const firstPage = await first.query(api.paymentDestinations.list, {
      paginationOpts: { numItems: 2, cursor: null },
    })
    expect(firstPage.page.map(({ id }) => id)).toEqual([
      destinationIds[2],
      ...destinationIds.slice(0, 2),
    ])

    const secondPage = await first.query(api.paymentDestinations.list, {
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    })
    expect(secondPage.page.map(({ id }) => id)).toEqual([destinationIds[3]])
    expect([
      ...firstPage.page.map(({ id }) => id),
      ...secondPage.page.map(({ id }) => id),
    ]).toEqual([
      destinationIds[2],
      destinationIds[0],
      destinationIds[1],
      destinationIds[3],
    ])
  })

  test('treats a whitespace-only search as the existing paginated list', async () => {
    const { first } = await setup()
    const destinationIds = [
      await createPayId(first, 'email', 'one@example.com'),
      await createPayId(first, 'email', 'two@example.com'),
    ]
    await first.mutation(api.paymentDestinations.setDefault, {
      destinationId: destinationIds[1],
    })

    const result = await searchDestinations(first, '   ')

    expect(result.page.map(({ id }) => id)).toEqual([
      destinationIds[1],
      destinationIds[0],
    ])
  })
})

describe('payment destination label search', () => {
  test('matches labels case-insensitively by prefix across cursor pages', async () => {
    const { first } = await setup()
    const matchingIds = [
      await createBank(first, {
        label: 'Everyday account',
        accountNumber: '1001',
      }),
      await createBank(first, {
        label: 'Everyday expenses',
        accountNumber: '1002',
      }),
    ]
    await createBank(first, {
      label: 'Emergency savings',
      accountNumber: '1003',
    })

    const firstPage = await searchDestinations(first, 'EVER', 1)
    const secondPage = await searchDestinations(
      first,
      'EVER',
      1,
      firstPage.continueCursor,
    )

    expect(firstPage.isDone).toBe(false)
    expect(secondPage.isDone).toBe(true)
    expect(
      new Set([
        ...firstPage.page.map(({ id }) => id),
        ...secondPage.page.map(({ id }) => id),
      ]),
    ).toEqual(new Set(matchingIds))
  })

  test('filters by owner inside the search index', async () => {
    const { first, second } = await setup()
    const ownedId = await createBank(first, {
      label: 'Payroll',
      accountNumber: '2001',
    })
    await createBank(second, {
      label: 'Payroll',
      accountNumber: '2002',
    })

    const result = await searchDestinations(first, 'payroll')

    expect(result.page).toEqual([expect.objectContaining({ id: ownedId })])
  })

  test('does not search masked or encrypted destination details', async () => {
    const { first } = await setup()
    await createBank(first, { label: 'Household' })

    await expect(searchDestinations(first, 'Ada')).resolves.toMatchObject({
      page: [],
      isDone: true,
    })
    await expect(searchDestinations(first, '2345')).resolves.toMatchObject({
      page: [],
      isDone: true,
    })
    await expect(searchDestinations(first, 'Bank')).resolves.toMatchObject({
      page: [],
      isDone: true,
    })
  })

  test('keeps the search label synchronized when a label changes or is removed', async () => {
    const { t, first } = await setup()
    const destinationId = await createBank(first, { label: 'Old label' })

    await first.mutation(api.paymentDestinations.updateLabel, {
      destinationId,
      label: '  New label  ',
    })
    await expect(searchDestinations(first, 'old')).resolves.toMatchObject({
      page: [],
    })
    await expect(searchDestinations(first, 'new')).resolves.toMatchObject({
      page: [
        expect.objectContaining({ id: destinationId, label: 'New label' }),
      ],
    })
    await expect(
      t.run(async (ctx) => ctx.db.get('paymentDestinations', destinationId)),
    ).resolves.toMatchObject({ searchLabel: 'New label' })

    await first.mutation(api.paymentDestinations.updateLabel, {
      destinationId,
      label: null,
    })
    await expect(searchDestinations(first, 'new')).resolves.toMatchObject({
      page: [],
    })
    await expect(
      t.run(async (ctx) => ctx.db.get('paymentDestinations', destinationId)),
    ).resolves.toMatchObject({ searchLabel: '' })
  })

  test('rejects search expressions outside Convex search limits', async () => {
    const { first } = await setup()

    await expect(
      searchDestinations(
        first,
        Array.from({ length: 17 }, (_, i) => `t${i}`).join(' '),
      ),
    ).rejects.toThrow('at most 16 terms')
    await expect(searchDestinations(first, 'x'.repeat(33))).rejects.toThrow(
      'at most 32 UTF-8 bytes',
    )
    await expect(searchDestinations(first, '---')).rejects.toThrow(
      'at least one letter or number',
    )
  })

  test('derives the migration value without exposing other destination fields', () => {
    expect(searchLabelFor('Everyday')).toBe('Everyday')
    expect(searchLabelFor(undefined)).toBe('')
    expect(paymentDestinationSearchLabelPatch({ label: 'Everyday' })).toEqual({
      searchLabel: 'Everyday',
    })
    expect(
      paymentDestinationSearchLabelPatch({
        label: 'Everyday',
        searchLabel: 'Already indexed',
      }),
    ).toBeUndefined()
  })
})

describe('payment destination validation and uniqueness', () => {
  test.each([
    [
      {
        kind: 'bankAccount',
        accountName: 'Ada',
        bsb: '12345',
        accountNumber: '1',
      },
      'BSB must contain exactly 6 digits',
    ],
    [
      {
        kind: 'bankAccount',
        accountName: 'Ada',
        bsb: '123456',
        accountNumber: '1234567890',
      },
      'Account number must be 1 to 9',
    ],
    [
      { kind: 'payId', payIdType: 'mobile', value: '0312345678' },
      'Australian 04 or +614',
    ],
    [
      { kind: 'payId', payIdType: 'email', value: 'jane@éxample.com' },
      'valid email address',
    ],
    [
      { kind: 'payId', payIdType: 'abn', value: '11111111111' },
      'valid 11-digit ABN',
    ],
    [
      {
        kind: 'payId',
        payIdType: 'organisationIdentifier',
        value: 'Café',
      },
      'printable characters',
    ],
  ] as const)(
    'rejects invalid destination %#',
    async (destination, message) => {
      const { first } = await setup()
      await expect(
        first.action(api.paymentDestinations.create, { destination }),
      ).rejects.toThrow(message)
    },
  )

  test('enforces the AP+ 256-character email ceiling', async () => {
    const { first } = await setup()
    const oversizedEmail = `${'a'.repeat(245)}@example.com`
    await expect(createPayId(first, 'email', oversizedEmail)).rejects.toThrow(
      'valid email address',
    )
  })

  test('rejects normalized duplicates for one owner but permits another owner', async () => {
    const { first, second } = await setup()
    await createPayId(first, 'mobile', '0412 345 678')

    await expect(
      createPayId(first, 'mobile', '+61-4 1234 5678'),
    ).rejects.toThrow('already saved')
    await expect(
      createPayId(second, 'mobile', '+61412345678'),
    ).resolves.toBeTypeOf('string')
  })
})

describe('payment destination authorization and lifecycle', () => {
  test('requires authentication for every public operation', async () => {
    const { t } = await setup()
    await expect(
      t.query(api.paymentDestinations.list, {
        paginationOpts: { numItems: 50, cursor: null },
      }),
    ).rejects.toThrow('signed in')
    await expect(
      t.action(api.paymentDestinations.create, {
        destination: {
          kind: 'payId',
          payIdType: 'email',
          value: 'unauthenticated@example.com',
        },
      }),
    ).rejects.toThrow('signed in')
  })

  test('does not expose or mutate another owner destination', async () => {
    const { first, second } = await setup()
    const destinationId = await createBank(first)

    await expect(
      second.action(api.paymentDestinations.reveal, { destinationId }),
    ).rejects.toThrow('does not exist or is not yours')
    await expect(
      second.mutation(api.paymentDestinations.setDefault, { destinationId }),
    ).rejects.toThrow('does not exist or is not yours')
    await expect(
      second.mutation(api.paymentDestinations.updateLabel, {
        destinationId,
        label: 'Stolen',
      }),
    ).rejects.toThrow('does not exist or is not yours')
    await expect(
      second.mutation(api.paymentDestinations.remove, { destinationId }),
    ).rejects.toThrow('does not exist or is not yours')
    await expect(listDestinations(second)).resolves.toEqual([])
  })

  test('keeps the first default unless creation explicitly replaces it', async () => {
    const { first } = await setup()
    const bankId = await createBank(first)
    const emailId = await createPayId(first, 'email', 'first@example.com')
    let destinations = await listDestinations(first)
    expect(destinations.find(({ id }) => id === bankId)?.isDefault).toBe(true)
    expect(destinations.find(({ id }) => id === emailId)?.isDefault).toBe(false)

    const mobileId = await createPayId(first, 'mobile', '0499 999 999', true)
    destinations = await listDestinations(first)
    expect(destinations.find(({ id }) => id === mobileId)?.isDefault).toBe(true)
    expect(destinations.filter(({ isDefault }) => isDefault)).toHaveLength(1)
  })

  test('blocks deleting a default with alternatives, then allows it after switching', async () => {
    const { first } = await setup()
    const bankId = await createBank(first)
    const payId = await createPayId(first, 'email', 'delete@example.com')

    await expect(
      first.mutation(api.paymentDestinations.remove, {
        destinationId: bankId,
      }),
    ).rejects.toThrow('Choose another default')
    await first.mutation(api.paymentDestinations.setDefault, {
      destinationId: payId,
    })
    await first.mutation(api.paymentDestinations.remove, {
      destinationId: bankId,
    })
    const [remaining] = await listDestinations(first)
    expect(remaining).toMatchObject({ id: payId, isDefault: true })
  })

  test('deleting the sole destination clears the default pointer', async () => {
    const { t, first, firstUserId } = await setup()
    const destinationId = await createBank(first)
    await first.mutation(api.paymentDestinations.remove, { destinationId })

    await expect(listDestinations(first)).resolves.toEqual([])
    const user = await t.run(async (ctx) => ctx.db.get('users', firstUserId))
    expect(user?.defaultPaymentDestinationId).toBeUndefined()
  })

  test('updates and removes only the optional label', async () => {
    const { first } = await setup()
    const destinationId = await createBank(first)
    await first.mutation(api.paymentDestinations.updateLabel, {
      destinationId,
      label: '  Savings  ',
    })
    await expect(listDestinations(first)).resolves.toEqual([
      expect.objectContaining({ label: 'Savings' }),
    ])

    await first.mutation(api.paymentDestinations.updateLabel, {
      destinationId,
      label: null,
    })
    const [destination] = await listDestinations(first)
    expect(destination).not.toHaveProperty('label')
  })
})
