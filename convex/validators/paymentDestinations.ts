import { zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

export const payIdTypeValidator = z.enum([
  'mobile',
  'email',
  'abn',
  'organisationIdentifier',
])

export const encryptedValueValidator = z.object({
  ciphertext: z.string(),
  nonce: z.string(),
  keyVersion: z.string(),
})

export const paymentDestinationInputValidator = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bankAccount'),
    accountName: z.string(),
    bsb: z.string(),
    accountNumber: z.string(),
  }),
  z.object({
    kind: z.literal('payId'),
    payIdType: payIdTypeValidator,
    value: z.string(),
  }),
])

export const protectedPaymentDestinationValidator = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('bankAccount'),
      maskedDisplay: z.string(),
      maskedAccountName: z.string(),
      maskedBsb: z.string(),
      maskedAccountNumber: z.string(),
      fingerprint: z.string(),
      accountName: encryptedValueValidator,
      bsb: encryptedValueValidator,
      accountNumber: encryptedValueValidator,
    }),
    z.object({
      kind: z.literal('payId'),
      payIdType: payIdTypeValidator,
      maskedDisplay: z.string(),
      fingerprint: z.string(),
      ciphertext: z.string(),
      nonce: z.string(),
      keyVersion: z.string(),
    }),
  ],
)

export const maskedPaymentDestinationValidator = z.discriminatedUnion('kind', [
  z.object({
    id: zid('paymentDestinations'),
    kind: z.literal('bankAccount'),
    label: z.string().optional(),
    maskedDisplay: z.string(),
    maskedAccountName: z.string(),
    maskedBsb: z.string(),
    maskedAccountNumber: z.string(),
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
      accountName: z.string(),
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

export const encryptedPaymentDestinationValidator = z.discriminatedUnion(
  'kind',
  [
    z.object({
      id: zid('paymentDestinations'),
      kind: z.literal('bankAccount'),
      label: z.string().optional(),
      accountName: encryptedValueValidator,
      bsb: encryptedValueValidator,
      accountNumber: encryptedValueValidator,
      isDefault: z.boolean(),
    }),
    z.object({
      id: zid('paymentDestinations'),
      kind: z.literal('payId'),
      payIdType: payIdTypeValidator,
      label: z.string().optional(),
      ciphertext: z.string(),
      nonce: z.string(),
      keyVersion: z.string(),
      isDefault: z.boolean(),
    }),
  ],
)

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
