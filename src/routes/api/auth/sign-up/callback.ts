import { auth } from '@clerk/tanstack-react-start/server'
import { createFileRoute } from '@tanstack/react-router'
import { ConvexHttpClient } from 'convex/browser'

import { api } from '../../../../../convex/_generated/api'

const callbackPath = '/api/auth/sign-up/callback'

type CallbackDependencies = {
  getAuth: () => Promise<{
    userId: string | null | undefined
    getToken: (options?: { template?: string }) => Promise<string | null>
  }>
  provisionCurrentUser: (token: string) => Promise<void>
}

const defaultDependencies: CallbackDependencies = {
  getAuth: async () => {
    const { userId, getToken } = await auth()

    return {
      userId,
      getToken,
    }
  },
  provisionCurrentUser: async (token) => {
    const convexUrl = import.meta.env.VITE_CONVEX_URL

    if (!convexUrl) {
      throw new Error('Missing VITE_CONVEX_URL environment variable')
    }

    const convexClient = new ConvexHttpClient(convexUrl)
    convexClient.setAuth(token)
    await convexClient.mutation(api.users.add, {})
  },
}

function redirectToSignIn(request: Request) {
  const signInUrl = new URL('/sign-in', request.url)
  signInUrl.searchParams.set('redirect_url', callbackPath)

  return Response.redirect(signInUrl, 302)
}

export async function handleSignUpCallback(
  request: Request,
  dependencies: CallbackDependencies = defaultDependencies,
) {
  try {
    const { userId, getToken } = await dependencies.getAuth()

    if (!userId) {
      return redirectToSignIn(request)
    }

    const token = await getToken({ template: 'convex' })

    if (!token) {
      return redirectToSignIn(request)
    }

    await dependencies.provisionCurrentUser(token)

    return Response.redirect(new URL('/dashboard', request.url), 302)
  } catch (error) {
    console.error('Failed to provision the signed-up user in Convex.', error)

    return new Response(
      'Unable to finish sign-up. Refresh this page to retry.',
      {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
    )
  }
}

export const Route = createFileRoute('/api/auth/sign-up/callback')({
  server: {
    handlers: {
      GET: ({ request }) => handleSignUpCallback(request),
    },
  },
})
