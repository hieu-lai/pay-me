import { describe, expect, test, vi } from 'vitest'

import { handleSignUpCallback } from './callback'

const callbackUrl = 'http://localhost/api/auth/sign-up/callback'

describe('GET /api/auth/sign-up/callback', () => {
  test('provisions the authenticated user and redirects to the dashboard', async () => {
    const provisionCurrentUser = vi.fn(async () => undefined)
    const getToken = vi.fn(async (options?: { template?: string }) =>
      options?.template === 'convex' ? 'convex-token' : 'session-token',
    )

    const response = await handleSignUpCallback(new Request(callbackUrl), {
      getAuth: async () => ({
        userId: 'user_123',
        getToken,
      }),
      provisionCurrentUser,
    })

    expect(getToken).toHaveBeenCalledExactlyOnceWith({ template: 'convex' })
    expect(provisionCurrentUser).toHaveBeenCalledExactlyOnceWith('convex-token')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://localhost/dashboard')
  })

  test('redirects an unauthenticated request through sign-in', async () => {
    const provisionCurrentUser = vi.fn(async () => undefined)

    const response = await handleSignUpCallback(new Request(callbackUrl), {
      getAuth: async () => ({
        userId: null,
        getToken: async () => null,
      }),
      provisionCurrentUser,
    })

    expect(provisionCurrentUser).not.toHaveBeenCalled()
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'http://localhost/sign-in?redirect_url=%2Fapi%2Fauth%2Fsign-up%2Fcallback',
    )
  })

  test('returns a retryable error when Convex provisioning fails', async () => {
    const response = await handleSignUpCallback(new Request(callbackUrl), {
      getAuth: async () => ({
        userId: 'user_123',
        getToken: async () => 'clerk-token',
      }),
      provisionCurrentUser: async () => {
        throw new Error('Convex unavailable')
      },
    })

    expect(response.status).toBe(500)
    await expect(response.text()).resolves.toContain(
      'Refresh this page to retry',
    )
  })
})
