import { z } from 'zod'

export const MAX_PAYERS = 5

const amountSchema = z
  .string({ error: 'Enter an amount.' })
  .trim()
  .regex(/^\d+(?:\.\d+)?$/, 'Enter a valid amount.')
  .refine((value) => Number(value) >= 1, 'Amount must be at least 1.')
  .refine(
    (value) => Number(value) <= 1_000_000_000,
    'Amount must be 1,000,000,000 or less.',
  )

const descriptionSchema = z
  .string({ error: 'Enter a description.' })
  .trim()
  .min(1, 'Enter a description.')
  .max(140, 'Description must be 140 characters or fewer.')
  .regex(
    /^[\x20-\x7e]+$/,
    'Description must contain only ASCII-printable characters.',
  )

export const formSchema = z.object({
  amount: amountSchema,
  description: descriptionSchema,
  payers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        hasPaymentDestination: z.boolean(),
        username: z.string().optional(),
        imageUrl: z.string().optional(),
      }),
    )
    .min(1, 'Choose at least one Payer.')
    .max(MAX_PAYERS, `You can add up to ${MAX_PAYERS} Payers.`),
})

export type FormValues = z.input<typeof formSchema>
export type FormSubmitValues = z.output<typeof formSchema>
export type FormDefaultValues = FormValues

export const defaultValues: FormDefaultValues = {
  amount: '',
  description: '',
  payers: [],
}
