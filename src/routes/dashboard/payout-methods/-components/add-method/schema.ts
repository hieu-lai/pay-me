import { z } from 'zod'

const labelSchema = z
  .string({ error: 'Enter a label for this payout method.' })
  .trim()
  .min(1, 'Enter a label for this payout method.')
  .max(80, 'Label must be 80 characters or fewer.')

const bsbSchema = z
  .string({ error: 'Enter the 6-digit BSB.' })
  .trim()
  .regex(/^(?:\d[\s-]*){6}$/, 'Enter a valid 6-digit BSB.')

const accountNumberSchema = z
  .string({ error: 'Enter the bank account number.' })
  .trim()
  .regex(
    /^[A-Za-z0-9 -]{1,9}$/,
    'Account number must be 1 to 9 letters, numbers, spaces, or hyphens.',
  )

const mobilePayIdSchema = z
  .string({ error: 'Enter the mobile number used for this PayID.' })
  .trim()
  .refine((value) => {
    const compact = value.replace(/[\s()-]/g, '')
    return /^04\d{8}$/.test(compact) || /^\+614\d{8}$/.test(compact)
  }, 'Enter an Australian mobile number starting with 04 or +614.')

const emailPayIdSchema = z
  .string({ error: 'Enter the email address used for this PayID.' })
  .trim()
  .refine(
    (value) =>
      value.length <= 256 &&
      /^[\x21-\x7e]+$/.test(value) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    'Enter a valid email address.',
  )

function isValidAbn(value: string): boolean {
  const normalized = value.replace(/\s/g, '')
  if (!/^\d{11}$/.test(normalized)) return false

  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
  const digits = [...normalized].map(Number)
  digits[0] -= 1

  return (
    digits.reduce((total, digit, index) => total + digit * weights[index], 0) %
      89 ===
    0
  )
}

const abnPayIdSchema = z
  .string({ error: 'Enter the ABN used for this PayID.' })
  .trim()
  .refine(isValidAbn, 'Enter a valid 11-digit ABN.')

const organisationIdentifierPayIdSchema = z
  .string({ error: 'Enter the organisation identifier used for this PayID.' })
  .trim()
  .refine(
    (value) =>
      value.length >= 1 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value),
    'Enter an organisation identifier using 1 to 256 printable characters.',
  )

const commonSchema = z.object({
  label: labelSchema,
})

const payIdSchema = z.discriminatedUnion(
  'payIdType',
  [
    commonSchema.extend({
      method: z.literal('payid'),
      payIdType: z.literal('alias_email'),
      value: emailPayIdSchema,
    }),
    commonSchema.extend({
      method: z.literal('payid'),
      payIdType: z.literal('alias_phone'),
      value: mobilePayIdSchema,
    }),
    commonSchema.extend({
      method: z.literal('payid'),
      payIdType: z.literal('alias_abn'),
      value: abnPayIdSchema,
    }),
    commonSchema.extend({
      method: z.literal('payid'),
      payIdType: z.literal('alias_organisation_identifier'),
      value: organisationIdentifierPayIdSchema,
    }),
  ],
  { error: 'Choose a PayID type.' },
)

export const formSchema = z.discriminatedUnion(
  'method',
  [
    commonSchema.extend({
      method: z.literal('bankAccount'),
      bsb: bsbSchema,
      accountNumber: accountNumberSchema,
    }),
    payIdSchema,
  ],
  { error: 'Choose bank account or PayID.' },
)

export type FormValues = z.input<typeof formSchema>
export type FormSubmitValues = z.output<typeof formSchema>
export type FormDefaultValues = FormValues & {
  payIdType?: z.input<typeof payIdSchema>['payIdType']
  value?: string
  bsb?: string
  accountNumber?: string
}

export const defaultValues: FormDefaultValues = {
  label: '',
  method: 'bankAccount',
  payIdType: 'alias_phone',
  value: '',
  bsb: '',
  accountNumber: '',
}
