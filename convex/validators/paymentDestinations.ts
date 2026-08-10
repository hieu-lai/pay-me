import { zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

export const payIdTypeValidator = z.enum([
  'mobile',
  'email',
  'abn',
  'organisationIdentifier',
])

export const paymentDestinationTypeValidator = z.enum([
  'bban',
  'alias_phone',
  'alias_email',
  'alias_abn',
  'alias_organisation_identifier',
])

export const encryptedValueValidator = z.object({
  ciphertext: z.string(),
  nonce: z.string(),
  keyVersion: z.string(),
})

export const paymentDestinationInputValidator = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bban'),
      value: z
        .string()
        .regex(
          /^\d{6}-[ -~]{1,28}$/,
          'BBAN must contain a 6-digit BSB and an account number separated by a hyphen.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_email'),
      value: z
        .string()
        .regex(
          /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/,
          'Email alias must be a valid lowercase email address.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_abn'),
      value: z
        .string()
        .regex(/^(?:\d{9}|\d{11})$/, 'ABN alias must contain 9 or 11 digits.'),
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_organisation_identifier'),
      value: z
        .string()
        .regex(
          /^[\x21-\x7e][\x20-\x7e]{0,254}[\x21-\x7e]$/,
          'Organisation Identifier alias must contain 2 to 256 printable ASCII characters without leading or trailing spaces.',
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_phone'),
      value: z
        .string()
        .regex(
          /^\+[0-9]{1,3}-[1-9][0-9]{1,29}$/,
          'Phone alias must use international format, such as +61-411222333.',
        ),
    })
    .strict(),
])

export const protectedPaymentDestinationValidator = z.object({
  type: paymentDestinationTypeValidator,
  maskedDisplay: z.string(),
  fingerprint: z.string(),
  ciphertext: z.string(),
  nonce: z.string(),
  keyVersion: z.string(),
})

export const maskedPaymentDestinationValidator = z.discriminatedUnion('kind', [
  z.object({
    id: zid('paymentDestinations'),
    kind: z.literal('bankAccount'),
    label: z.string().optional(),
    maskedDisplay: z.string(),
    isDefault: z.boolean(),
  }),
  z.object({
    id: zid('paymentDestinations'),
    kind: z.literal('payId'),
    payIdType: payIdTypeValidator,
    label: z.string().optional(),
    maskedDisplay: z.string(),
    isDefault: z.boolean(),
  }),
])

export const revealedPaymentDestinationValidator = z.discriminatedUnion(
  'kind',
  [
    z.object({
      id: zid('paymentDestinations'),
      kind: z.literal('bankAccount'),
      label: z.string().optional(),
      bsb: z.string(),
      accountNumber: z.string(),
      isDefault: z.boolean(),
    }),
    z.object({
      id: zid('paymentDestinations'),
      kind: z.literal('payId'),
      payIdType: payIdTypeValidator,
      label: z.string().optional(),
      value: z.string(),
      isDefault: z.boolean(),
    }),
  ],
)

export const encryptedPaymentDestinationValidator = z.object({
  id: zid('paymentDestinations'),
  type: paymentDestinationTypeValidator,
  label: z.string().optional(),
  ciphertext: z.string(),
  nonce: z.string(),
  keyVersion: z.string(),
  isDefault: z.boolean(),
})

export type PaymentDestinationInput = z.infer<
  typeof paymentDestinationInputValidator
>
export type EncryptedValue = z.infer<typeof encryptedValueValidator>
export type ProtectedPaymentDestination = z.infer<
  typeof protectedPaymentDestinationValidator
>
export type EncryptedPaymentDestination = z.infer<
  typeof encryptedPaymentDestinationValidator
>
export type RevealedPaymentDestination = z.infer<
  typeof revealedPaymentDestinationValidator
>
