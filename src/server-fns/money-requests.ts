import { auth } from '@clerk/tanstack-react-start/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequestIP } from '@tanstack/react-start/server'
import { ConvexHttpClient } from 'convex/browser'
import { ConvexError } from 'convex/values'
import { z } from 'zod'

import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import {
  CANONICAL_UUID_V7_PATTERN,
  MAX_MONEY_REQUEST_AMOUNT_CENTS,
  MIN_MONEY_REQUEST_AMOUNT_CENTS,
  MONEY_REQUEST_DESCRIPTION_PATTERN,
  createIngressAttestation,
  isCanonicalIpv4,
} from '../../convex/lib/moneyRequestIngress'

export const moneyRequestIntentSchema = z
  .object({
    submissionKey: z.string().regex(CANONICAL_UUID_V7_PATTERN),
    amountCents: z
      .number()
      .int()
      .min(MIN_MONEY_REQUEST_AMOUNT_CENTS)
      .max(MAX_MONEY_REQUEST_AMOUNT_CENTS),
    description: z
      .string()
      .regex(MONEY_REQUEST_DESCRIPTION_PATTERN)
      .refine(
        (value) => value === value.normalize('NFC').trim(),
        'Description must already be normalized.',
      ),
    payerId: z
      .string()
      .min(1)
      .transform((value) => value as Id<'users'>),
  })
  .strict()

type MoneyRequestIntent = z.output<typeof moneyRequestIntentSchema>

type MoneyRequestSubmissionErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'

export class MoneyRequestSubmissionError extends Error {
  constructor(
    message: string,
    readonly code: MoneyRequestSubmissionErrorCode,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'MoneyRequestSubmissionError'
  }
}

type SubmissionDependencies = {
  authenticate: () => Promise<{
    clerkUserId: string | null
    token: string | null
  }>
  trustedIp: () => string | undefined
  now: () => number
  attestationSecret: string
  submit: (args: {
    token: string
    intent: MoneyRequestIntent
    attestation: Awaited<ReturnType<typeof createIngressAttestation>>
  }) => Promise<string>
}

export async function handleMoneyRequestSubmission(
  intent: MoneyRequestIntent,
  dependencies: SubmissionDependencies,
) {
  const { clerkUserId, token } = await dependencies.authenticate()
  if (!clerkUserId || !token) {
    throw new MoneyRequestSubmissionError('Unauthorized', 'UNAUTHORIZED')
  }

  const trustedIp = dependencies.trustedIp()
  if (!trustedIp || !isCanonicalIpv4(trustedIp)) {
    throw new MoneyRequestSubmissionError(
      'A trusted IPv4 address is required to submit this request.',
      'VALIDATION_UNAVAILABLE',
      true,
    )
  }

  let attestation
  try {
    attestation = await createIngressAttestation(intent, {
      issuedAtMs: dependencies.now(),
      clerkUserId,
      trustedIp,
      secret: dependencies.attestationSecret,
    })
  } catch {
    throw new MoneyRequestSubmissionError(
      'Money Request submission is temporarily unavailable.',
      'SERVICE_UNAVAILABLE',
      true,
    )
  }

  let moneyRequestId
  try {
    moneyRequestId = await dependencies.submit({ token, intent, attestation })
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === 'object' &&
      error.data !== null &&
      'code' in error.data &&
      error.data.code === 'INGRESS_TRUST_INVALID'
    ) {
      throw new MoneyRequestSubmissionError('Forbidden', 'FORBIDDEN')
    }
    throw error
  }
  return { moneyRequestId }
}

export const submitMoneyRequest = createServerFn({ method: 'POST' })
  .validator(moneyRequestIntentSchema)
  .handler(async ({ data }) =>
    handleMoneyRequestSubmission(data, {
      authenticate: async () => {
        const { userId, getToken } = await auth()
        return { clerkUserId: userId, token: await getToken() }
      },
      trustedIp: () => getRequestIP(),
      now: () => Date.now(),
      attestationSecret:
        process.env.MONEY_REQUEST_INGRESS_ATTESTATION_SECRET ?? '',
      submit: async ({ token, intent, attestation }) => {
        const convexUrl = process.env.VITE_CONVEX_URL
        if (!convexUrl) throw new Error('Missing VITE_CONVEX_URL.')
        const client = new ConvexHttpClient(convexUrl, {
          auth: token,
          logger: false,
        })
        return await client.action(api.moneyRequests.submit, {
          intent,
          attestation,
        })
      },
    }),
  )
