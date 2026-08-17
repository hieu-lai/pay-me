import { z } from 'zod'

import type { ProviderPayToPaymentState } from '../../validators/payToPayments'
import { providerPayToPaymentStates } from '../../validators/payToPayments'
import { paymentDestinationInputValidator } from '../../validators/paymentDestinations'
import type { ZeptoClient } from './client'
import { ZeptoClientError } from './error'

const unreservedUid = /^[A-Za-z0-9._~-]+$/

const paymentResponseValidator = z
  .object({
    uid: z.string(),
    agreement_uid: z.string(),
    source_payto_refund_uid: z.string().nullable(),
    state: z.string().min(1).max(100),
    reference: z.string().nullable(),
    description: z.string().nullable(),
    priority: z.enum(['unattended', 'attended']),
    creditor: z.object({
      party_name: z.string(),
      ultimate_party_name: z.string().nullable(),
      account_identifier: paymentDestinationInputValidator,
    }),
    creditor_reference: z.string().nullable(),
    debtor: z.object({
      party_name: z.string(),
      ultimate_party_name: z.string(),
      account_identifier: paymentDestinationInputValidator,
    }),
    amount: z.number(),
    last_payment: z.boolean().nullable(),
    metadata: z.unknown().optional(),
    failure: z
      .object({
        title: z.string().max(512),
        detail: z.string(),
        code: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
        retryable: z.boolean(),
      })
      .nullable(),
    created_at: z.string(),
    links: z.object({
      self: z.string(),
      agreement: z.string(),
      source_refund: z.string().nullable(),
    }),
  })
  .strict()

export type CreatePaymentInput = {
  providerUid: string
  agreementProviderUid: string
  amountCents: number
  priority: 'unattended'
}

export type CreatedPayment = {
  providerUid: string
  agreementProviderUid: string
  state: ProviderPayToPaymentState
  createdAt: string
}

const knownProviderStates = new Set<string>(providerPayToPaymentStates)

function invalidRequest(): never {
  throw new ZeptoClientError({
    kind: 'configuration',
    message: 'Zepto Payment creation received an invalid request.',
    method: 'POST',
    path: '/payto/payments',
  })
}

function invalidResponse(): never {
  throw new ZeptoClientError({
    kind: 'invalid_response',
    message: 'Zepto Payment creation returned an invalid success response.',
    method: 'POST',
    path: '/payto/payments',
  })
}

function uidMismatch(): never {
  throw new ZeptoClientError({
    kind: 'uid_mismatch',
    message: 'Zepto Payment response violated its permanent UID binding.',
    path: '/payto/payments/{payment_uid}',
  })
}

function validateInput(input: unknown): asserts input is CreatePaymentInput {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('providerUid' in input) ||
    typeof input.providerUid !== 'string' ||
    !input.providerUid ||
    input.providerUid.length > 64 ||
    !unreservedUid.test(input.providerUid) ||
    !('agreementProviderUid' in input) ||
    typeof input.agreementProviderUid !== 'string' ||
    !input.agreementProviderUid ||
    input.agreementProviderUid.length > 64 ||
    !unreservedUid.test(input.agreementProviderUid) ||
    !('amountCents' in input) ||
    typeof input.amountCents !== 'number' ||
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    !('priority' in input) ||
    input.priority !== 'unattended'
  ) {
    invalidRequest()
  }
}

export async function createPayment(
  client: ZeptoClient,
  input: CreatePaymentInput,
): Promise<CreatedPayment> {
  validateInput(input)
  const { data, response } = await client.payTo.POST('/payto/payments', {
    body: {
      uid: input.providerUid,
      agreement_uid: input.agreementProviderUid,
      amount: input.amountCents,
      priority: input.priority,
    },
  })
  let payment: z.infer<typeof paymentResponseValidator>
  try {
    payment = paymentResponseValidator.parse(data?.data)
  } catch {
    invalidResponse()
  }
  if (
    payment.uid !== input.providerUid ||
    payment.agreement_uid !== input.agreementProviderUid
  ) {
    uidMismatch()
  }
  if (
    response.status !== 201 ||
    payment.priority !== input.priority ||
    payment.amount !== input.amountCents ||
    !knownProviderStates.has(payment.state) ||
    Number.isNaN(Date.parse(payment.created_at))
  ) {
    invalidResponse()
  }

  return {
    providerUid: payment.uid,
    agreementProviderUid: payment.agreement_uid,
    state: payment.state as ProviderPayToPaymentState,
    createdAt: payment.created_at,
  }
}

export async function getPaymentLifecycleByUid(
  client: ZeptoClient,
  input: CreatePaymentInput,
): Promise<{
  providerState: string
  failure?: { code: string; retryable: boolean }
}> {
  if (
    !input.providerUid ||
    input.providerUid.length > 64 ||
    !unreservedUid.test(input.providerUid)
  ) {
    invalidRequest()
  }
  const { data } = await client.payTo.GET('/payto/payments/{payment_uid}', {
    params: { path: { payment_uid: input.providerUid } },
  })
  let payment: z.infer<typeof paymentResponseValidator>
  try {
    payment = paymentResponseValidator.parse(data?.data)
  } catch {
    invalidResponse()
  }
  if (
    payment.uid !== input.providerUid ||
    payment.agreement_uid !== input.agreementProviderUid
  ) {
    uidMismatch()
  }
  if (
    payment.amount !== input.amountCents ||
    payment.priority !== input.priority ||
    Number.isNaN(Date.parse(payment.created_at))
  ) {
    invalidResponse()
  }
  return {
    providerState: payment.state,
    ...(payment.failure === null
      ? {}
      : {
          failure: {
            code: payment.failure.code,
            retryable: payment.failure.retryable,
          },
        }),
  }
}

export async function retryPayment(
  client: ZeptoClient,
  input: { providerUid: string },
): Promise<{ accepted: true }> {
  if (
    !input.providerUid ||
    input.providerUid.length > 64 ||
    !unreservedUid.test(input.providerUid)
  ) {
    invalidRequest()
  }
  const { response } = await client.payTo.POST(
    '/payto/payments/{payment_uid}/retry',
    {
      params: { path: { payment_uid: input.providerUid } },
      body: {},
    },
  )
  if (response.status !== 202) invalidResponse()
  return { accepted: true }
}
