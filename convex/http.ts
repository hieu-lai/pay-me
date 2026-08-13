import { verifyWebhook } from '@clerk/backend/webhooks'
import { httpRouter } from 'convex/server'

import { internal } from './_generated/api'
import { env, httpAction } from './_generated/server'
import { verifyZeptoWebhookSignature } from './lib/zepto/webhook'
import { classifyZeptoWebhookEvent } from './lib/zepto/webhookEvents'
import type { ZeptoWebhookItem } from './validators/zeptoWebhook'
import type { ZeptoEnvironment } from './validators/payToAgreements'

type AddUserArgs = {
  tokenIdentifier: string
  clerkUserId: string
  email: string
  name: string
  imageUrl?: string
}

type ClerkWebhookDependencies = {
  signingSecret: string
  clerkFrontendApiUrl: string
  addUser: (args: AddUserArgs) => Promise<void>
  randomFourDigitNumber: () => number
}

function randomFourDigitNumber() {
  const randomValue = new Uint16Array(1)
  crypto.getRandomValues(randomValue)

  return 1000 + (randomValue[0] % 9000)
}

export async function handleClerkWebhook(
  request: Request,
  dependencies: ClerkWebhookDependencies,
) {
  let event

  try {
    event = await verifyWebhook(request, {
      signingSecret: dependencies.signingSecret,
    })
  } catch (error) {
    console.error('Clerk webhook verification failed', error)
    return new Response('Invalid Clerk webhook', { status: 400 })
  }

  if (event.type !== 'user.created') {
    console.log('Ignored Clerk webhook event', event.type)
    return new Response(null, { status: 200 })
  }

  const primaryEmail = event.data.email_addresses.find(
    ({ id }) => id === event.data.primary_email_address_id,
  )?.email_address

  if (!primaryEmail?.trim()) {
    console.error('Clerk user has no primary email address', event.data.id)
    return new Response('Clerk user has no primary email address', {
      status: 422,
    })
  }

  const name = [event.data.first_name, event.data.last_name]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ')
  const imageUrl = event.data.image_url.trim()

  try {
    await dependencies.addUser({
      tokenIdentifier: `${dependencies.clerkFrontendApiUrl}|${event.data.id}`,
      clerkUserId: event.data.id,
      email: primaryEmail.trim(),
      name: name || `User #${dependencies.randomFourDigitNumber().toString()}`,
      ...(imageUrl ? { imageUrl } : {}),
    })
  } catch (error) {
    console.error('Failed to provision Clerk user', error)
    return new Response('Unable to provision Clerk user', { status: 500 })
  }

  return new Response(null, { status: 200 })
}

type ZeptoWebhookDependencies = {
  signingSecret: string | undefined
  environment: ZeptoEnvironment | undefined
  nowMs: () => number
  applyDelivery: (args: {
    deliveryId: string
    environment: ZeptoEnvironment
    payloadHash: string
    signatureTimestamp: number
    receivedAt: number
    items: ZeptoWebhookItem[]
  }) => Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRfc3339DateTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    )
  if (!match) return null
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
  ] = match
  const year = Number(yearValue)
  const month = Number(monthValue)
  const day = Number(dayValue)
  const hour = Number(hourValue)
  const minute = Number(minuteValue)
  const second = Number(secondValue)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  if (month < 1 || month > 12) return null
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1]
  if (day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

type ZeptoWebhookCause = NonNullable<ZeptoWebhookItem['causedBy']>

const zeptoWebhookCauses = new Set<ZeptoWebhookCause>([
  'debtor',
  'initiator',
  'zepto_admin',
  'zepto_system',
])

function isZeptoWebhookCause(value: unknown): value is ZeptoWebhookCause {
  return (
    typeof value === 'string' &&
    zeptoWebhookCauses.has(value as ZeptoWebhookCause)
  )
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.length <= maxLength
    ? value
    : undefined
}

function safeIdentifier(value: unknown, maxLength: number) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._~-]+$/.test(value)
    ? value
    : null
}

async function sha256Base64Url(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function parseZeptoWebhookContext(value: Record<string, unknown>) {
  if (!isRecord(value.body)) return {}

  const causedBy = isZeptoWebhookCause(value.body.caused_by)
    ? value.body.caused_by
    : undefined
  const providerReason = isRecord(value.body.reason)
    ? value.body.reason
    : undefined
  const code = boundedString(providerReason?.code, 128)
  const title = boundedString(providerReason?.title, 512)
  const detail = boundedString(providerReason?.detail, 4_096)
  const reason = {
    ...(code === undefined ? {} : { code }),
    ...(title === undefined ? {} : { title }),
    ...(detail === undefined ? {} : { detail }),
  }

  return {
    ...(causedBy === undefined ? {} : { causedBy }),
    ...(Object.keys(reason).length === 0 ? {} : { reason }),
  }
}

function parseZeptoWebhookPayload(value: unknown): ZeptoWebhookItem[] | null {
  if (!isRecord(value)) return null
  const data = Array.isArray(value.data) ? value.data : [value.data]
  if (data.length < 1) return null

  const items: ZeptoWebhookItem[] = []
  for (const valueItem of data) {
    if (!isRecord(valueItem)) return null
    const { id, type, published_at, resource_uid, resource_type } = valueItem
    const publishedAt = parseRfc3339DateTime(published_at)
    const providerEventId = safeIdentifier(id, 128)
    const eventType = safeIdentifier(type, 128)
    const resourceUid = safeIdentifier(resource_uid, 64)
    const resourceType = safeIdentifier(resource_type, 64)
    if (
      providerEventId === null ||
      eventType === null ||
      resourceUid === null ||
      resourceType === null ||
      publishedAt === null
    ) {
      return null
    }
    items.push({
      providerEventId,
      eventType,
      resourceUid,
      resourceType,
      classification: classifyZeptoWebhookEvent(resourceType, eventType),
      providerPublishedAt: publishedAt,
      ...parseZeptoWebhookContext(valueItem),
    })
  }
  return items
}

export async function handleZeptoWebhook(
  request: Request,
  dependencies: ZeptoWebhookDependencies,
) {
  if (!dependencies.environment) {
    return new Response('Zepto webhook is not configured', { status: 500 })
  }
  const deliveryId = safeIdentifier(
    request.headers.get('split-request-id')?.trim(),
    128,
  )
  const splitSignature = request.headers.get('split-signature')?.trim()

  if (deliveryId === null || !splitSignature) {
    console.error('Zepto webhook verification failed', {
      reason: 'missing_headers',
    })
    return new Response('Invalid Zepto webhook', { status: 400 })
  }

  const rawBody = await request.arrayBuffer()
  let signatureTimestamp: number
  try {
    ;({ timestamp: signatureTimestamp } = await verifyZeptoWebhookSignature({
      rawBody,
      splitSignature,
      secret: dependencies.signingSecret ?? '',
      nowMs: dependencies.nowMs(),
    }))
  } catch {
    console.error('Zepto webhook verification failed', {
      reason: 'invalid_signature',
    })
    return new Response('Invalid Zepto webhook', { status: 400 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
    ) as unknown
  } catch {
    return new Response('Malformed Zepto webhook', { status: 400 })
  }

  const items = parseZeptoWebhookPayload(parsed)
  if (!items) return new Response('Malformed Zepto webhook', { status: 400 })

  try {
    await dependencies.applyDelivery({
      deliveryId,
      environment: dependencies.environment,
      payloadHash: await sha256Base64Url(rawBody),
      signatureTimestamp,
      receivedAt: dependencies.nowMs(),
      items,
    })
  } catch (error) {
    console.error('Failed to commit Zepto webhook', error)
    return new Response('Unable to commit Zepto webhook', { status: 500 })
  }
  return new Response(null, { status: 200 })
}

const http = httpRouter()

http.route({
  path: '/clerk',
  method: 'POST',
  handler: httpAction((ctx, request) =>
    handleClerkWebhook(request, {
      signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET,
      clerkFrontendApiUrl: env.CLERK_FRONTEND_API_URL,
      addUser: async (args) => {
        await ctx.runMutation(internal.users.addUser, args)
      },
      randomFourDigitNumber,
    }),
  ),
})

http.route({
  path: '/zepto/webhooks',
  method: 'POST',
  handler: httpAction((ctx, request) =>
    handleZeptoWebhook(request, {
      signingSecret: env.ZEPTO_WEBHOOK_SIGNING_SECRET,
      environment: env.ZEPTO_ENVIRONMENT,
      nowMs: Date.now,
      applyDelivery: async (args) => {
        await ctx.runMutation(internal.zeptoWebhook.applyDelivery, args)
      },
    }),
  ),
})

export default http
