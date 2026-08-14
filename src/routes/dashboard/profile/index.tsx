import { convexQuery } from '@convex-dev/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { api } from '../../../../convex/_generated/api'
import { Header } from './-components/header'
import { ProfileForm } from './-components/profile-form'

export const Route = createFileRoute('/dashboard/profile/')({
  loader: async ({ context: { queryClient } }) =>
    await queryClient.ensureQueryData(convexQuery(api.users.me)),
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <Header />
      <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 py-8">
        <ErrorBoundary fallback={<div>Error</div>}>
          <Suspense fallback={<div>Loading...</div>}>
            <ProfileForm />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  )
}
