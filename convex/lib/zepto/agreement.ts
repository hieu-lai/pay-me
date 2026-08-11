import type { ProviderAgreementState } from '../../validators/payToAgreements'
import { providerAgreementStates } from '../../validators/payToAgreements'
import type { ZeptoClient } from './client'
import { ZeptoClientError } from './error'

const agreementStates = new Set<ProviderAgreementState>(providerAgreementStates)

type BankAccountParty = {
  name: string
  accountIdentifier: string
}

type CreateBankAccountAgreementInput = {
  providerUid: string
  amountCents: number
  description: string
  creditor: BankAccountParty
  debtor: BankAccountParty
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

export async function createBankAccountAgreement(
  client: ZeptoClient,
  input: CreateBankAccountAgreementInput,
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
        account_identifier: {
          type: 'bban',
          value: input.creditor.accountIdentifier,
        },
      },
      debtor: {
        party_name: input.debtor.name,
        ultimate_party_name: input.debtor.name,
        account_identifier: {
          type: 'bban',
          value: input.debtor.accountIdentifier,
        },
      },
    },
  })

  const agreement = data?.data
  if (
    agreement?.uid !== input.providerUid ||
    !agreementStates.has(agreement.state) ||
    typeof agreement.created_at !== 'string' ||
    Number.isNaN(Date.parse(agreement.created_at)) ||
    (agreement.mms_agreement_id !== null &&
      typeof agreement.mms_agreement_id !== 'string')
  ) {
    invalidCreateResponse()
  }

  return {
    state: agreement.state,
    createdAt: agreement.created_at,
    mmsAgreementId: agreement.mms_agreement_id,
  }
}
