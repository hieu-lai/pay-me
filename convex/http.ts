import { verifyWebhook } from '@clerk/backend/webhooks'
import { httpRouter } from 'convex/server'

import { internal } from './_generated/api'
import { env, httpAction } from './_generated/server'

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

export default http
