import { z } from 'zod'

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024

const nameSchema = z
  .string({ error: 'Enter your name.' })
  .trim()
  .min(1, 'Enter your name.')
  .max(80, 'Name must be 80 characters or fewer.')

const bioSchema = z
  .string({ error: 'Enter your bio.' })
  .trim()
  .max(160, 'Bio must be 160 characters or fewer.')

const imageMetadataSchema = z.object({
  name: z
    .string({ error: 'Enter the image file name.' })
    .trim()
    .min(1, 'Enter the image file name.'),
  type: z.enum(['image/png', 'image/jpeg', 'image/webp'], {
    error: 'Image must be a PNG, JPEG, or WebP file.',
  }),
  size: z
    .number({ error: 'Enter the image file size.' })
    .int('Image file size must be a whole number.')
    .positive('Image file size must be greater than zero.')
    .max(MAX_IMAGE_SIZE, 'Image must be 5 MB or smaller.'),
  preview: z.string(),
})

const imageUploadSchema = z.object({
  file: z.instanceof(File, { error: 'Choose an image file.' }),
  metadata: imageMetadataSchema,
})

const imageSchema = z.union([
  z
    .string({ error: 'Enter an existing image.' })
    .trim()
    .min(1, 'Enter an existing image.'),
  imageUploadSchema,
])

export const formSchema = z.object({
  name: nameSchema,
  bio: bioSchema,
  image: imageSchema.nullable(),
})

export type FormValues = z.input<typeof formSchema>
export type FormSubmitValues = z.output<typeof formSchema>
export type FormDefaultValues = FormValues

export const defaultValues: FormDefaultValues = {
  name: '',
  bio: '',
  image: null,
}
