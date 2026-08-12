import type { ProviderAgreementState } from '../../validators/payToAgreements'
import type { PaymentDestinationInput } from '../../validators/paymentDestinations'
import { providerAgreementStates } from '../../validators/payToAgreements'
import type { ZeptoClient } from './client'
import { ZeptoClientError } from './error'

const agreementStates = new Set<ProviderAgreementState>(providerAgreementStates)

type AgreementParty = {
  name: string
  accountIdentifier: PaymentDestinationInput
}

type CreateAgreementInput = {
  providerUid: string
  amountCents: number
  description: string
  creditor: AgreementParty
  debtor: AgreementParty
}

export type CreatedAgreement = {
  state: ProviderAgreementState
  createdAt: string
  mmsAgreementId: string | null
}

function invalidCreateResponse(): never {
  throw new ZeptoClientError({
    kind: 'invalid_response',
    message: 'Zepto agreement creation returned an invalid success response.',
    method: 'POST',
    path: '/payto/agreements',
  })
}

function normalizeAgreement(
  agreement:
    | {
        uid?: unknown
        state?: unknown
        created_at?: unknown
        mms_agreement_id?: unknown
      }
    | null
    | undefined,
  expectedUid: string,
): CreatedAgreement {
  if (
    agreement?.uid !== expectedUid ||
    !agreementStates.has(agreement.state as ProviderAgreementState) ||
    typeof agreement.created_at !== 'string' ||
    Number.isNaN(Date.parse(agreement.created_at)) ||
    (agreement.mms_agreement_id !== null &&
      typeof agreement.mms_agreement_id !== 'string')
  ) {
    invalidCreateResponse()
  }

  return {
    state: agreement.state as ProviderAgreementState,
    createdAt: agreement.created_at,
    mmsAgreementId: agreement.mms_agreement_id,
  }
}

export async function createAgreement(
  client: ZeptoClient,
  input: CreateAgreementInput,
): Promise<CreatedAgreement> {
  const { data } = await client.payTo.POST('/payto/agreements', {
    body: {
      uid: input.providerUid,
      purpose: 'other',
      description: input.description,
      payment_terms: {
        type: 'fixed',
        frequency: 'adhoc',
        amount: input.amountCents,
        count: 1,
      },
      creditor: {
        party_name: input.creditor.name,
        ultimate_party_name: input.creditor.name,
        account_identifier: input.creditor.accountIdentifier,
      },
      debtor: {
        party_name: input.debtor.name,
        ultimate_party_name: input.debtor.name,
        account_identifier: input.debtor.accountIdentifier,
      },
    },
  })

  return normalizeAgreement(data?.data, input.providerUid)
}

export async function getAgreementByUid(
  client: ZeptoClient,
  providerUid: string,
): Promise<CreatedAgreement> {
  const { data } = await client.payTo.GET('/payto/agreements/{agreement_uid}', {
    params: { path: { agreement_uid: providerUid } },
  })
  return normalizeAgreement(data?.data, providerUid)
}
