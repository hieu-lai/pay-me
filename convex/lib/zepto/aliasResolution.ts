import type { PaymentDestinationInput } from '../../validators/paymentDestinations'
import type { ZeptoClient } from './client'
import { ZeptoClientError } from './error'

type PayIdAlias = Exclude<PaymentDestinationInput, { type: 'bban' }>

export async function resolvePayIdAlias(
  client: ZeptoClient,
  input: {
    alias: PayIdAlias
    requesterId: string
    trustedIp: string
  },
): Promise<void> {
  const { data } = await client.payTo.POST('/payto/alias_resolution', {
    body: {
      type: input.alias.type,
      value: input.alias.value,
      requester: {
        id: input.requesterId,
        remote_ip: input.trustedIp,
      },
    },
  })
  if (typeof data?.data.display_name !== 'string') {
    throw new ZeptoClientError({
      kind: 'invalid_response',
      message: 'Zepto alias resolution returned an invalid success response.',
      method: 'POST',
      path: '/payto/alias_resolution',
    })
  }
}
