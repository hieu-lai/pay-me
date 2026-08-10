import { auth } from '@clerk/tanstack-react-start/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { sleep } from '#/lib/utils'
import { z } from 'zod'

const phoneAliasValueSchema = z
  .string()
  .regex(
    /^\+[0-9]{1,3}-[1-9][0-9]{0,29}$/,
    'Enter a phone alias in international format, such as +61-411222333.',
  )

const emailAliasValueSchema = z
  .string()
  .regex(
    /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/,
    'Enter a valid lowercase email alias.',
  )

const abnAliasValueSchema = z
  .string()
  .regex(/^\d{9}(?:\d{2})?$/, 'Enter a 9 or 11 digit ABN alias.')

const organisationIdentifierAliasValueSchema = z
  .string()
  .regex(
    /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/,
    'Enter an organisation identifier using 1 to 256 printable ASCII characters without leading or trailing spaces.',
  )

export const aliasResolutionParamsSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('alias_phone'),
      value: phoneAliasValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_email'),
      value: emailAliasValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_abn'),
      value: abnAliasValueSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('alias_organisation_identifier'),
      value: organisationIdentifierAliasValueSchema,
    })
    .strict(),
])

export const aliasResolution = createServerFn({ method: 'GET' })
  .validator(aliasResolutionParamsSchema)
  .handler(async ({ data: { type, value } }) => {
    const { userId } = await auth()

    if (!userId) {
      throw new Response('Unauthorized', { status: 401 })
    }

    const remoteIp =
      getRequestHeader('x-vercel-forwarded-for') ??
      getRequestHeader('x-forwarded-for')

    if (value === '+61-412345678') {
      return true
    }

    return false
  })
