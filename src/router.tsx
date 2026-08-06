import { ConvexQueryClient } from '@convex-dev/react-query'
import { QueryClient } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { ConvexProvider, ConvexReactClient } from 'convex/react'

import { routeTree } from './routeTree.gen'

export function getRouter() {
  const convexUrl = import.meta.env.VITE_CONVEX_URL

  if (!convexUrl) {
    throw new Error('Missing VITE_CONVEX_URL environment variable')
  }

  const convexClient = new ConvexReactClient(convexUrl, {
    unsavedChangesWarning: false,
  })
  const convexQueryClient = new ConvexQueryClient(convexClient)
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  })

  convexQueryClient.connect(queryClient)

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient, convexClient, convexQueryClient },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: () => <div>Not found</div>,
    Wrap: ({ children }) => (
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    ),
  })

  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
