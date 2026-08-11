import type { ZeptoClient } from './client'
import { ZeptoClientError } from './error'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(path: string): never {
  throw new ZeptoClientError({
    kind: 'invalid_response',
    message: 'Zepto lifecycle reconciliation returned an invalid response.',
    method: 'GET',
    path,
  })
}

export async function getAgreementLifecycleByUid(
  client: ZeptoClient,
  providerUid: string,
): Promise<{ providerState: string }> {
  const path = `/payto/agreements/${providerUid}`
  const { data } = await client.payTo.GET('/payto/agreements/{agreement_uid}', {
    params: { path: { agreement_uid: providerUid } },
  })
  const agreement: unknown = data?.data
  if (
    !isRecord(agreement) ||
    agreement.uid !== providerUid ||
    typeof agreement.state !== 'string' ||
    agreement.state.length === 0 ||
    agreement.state.length > 100 ||
    typeof agreement.created_at !== 'string' ||
    Number.isNaN(Date.parse(agreement.created_at)) ||
    (agreement.mms_agreement_id !== null &&
      typeof agreement.mms_agreement_id !== 'string')
  ) {
    invalidResponse(path)
  }
  return { providerState: agreement.state }
}

export type AgreementHistoryEvidence = {
  eventCount: number
  eventTypes: string[]
  latestProviderPublishedAt?: number
}

export async function getAgreementHistoryEvidence(
  client: ZeptoClient,
  providerUid: string,
): Promise<AgreementHistoryEvidence> {
  const path = `/payto/agreements/${providerUid}/history`
  const { data } = await client.payTo.GET(
    '/payto/agreements/{agreement_uid}/history',
    {
      params: {
        path: { agreement_uid: providerUid },
        query: { per_page: 100 },
      },
    },
  )
  const events: unknown = data?.data
  if (!Array.isArray(events) || events.length > 100) invalidResponse(path)

  const eventTypes = new Set<string>()
  let latestProviderPublishedAt: number | undefined
  for (const event of events) {
    if (
      !isRecord(event) ||
      event.resource_uid !== providerUid ||
      typeof event.type !== 'string' ||
      typeof event.published_at !== 'string'
    ) {
      invalidResponse(path)
    }
    const publishedAt = Date.parse(event.published_at)
    if (Number.isNaN(publishedAt)) invalidResponse(path)
    eventTypes.add(event.type)
    latestProviderPublishedAt = Math.max(
      latestProviderPublishedAt ?? publishedAt,
      publishedAt,
    )
  }
  return {
    eventCount: events.length,
    eventTypes: [...eventTypes].sort(),
    ...(latestProviderPublishedAt === undefined
      ? {}
      : { latestProviderPublishedAt }),
  }
}
