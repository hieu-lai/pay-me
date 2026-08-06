import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { getAuth } from '#/server-fns/get-auth'

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    const { userId } = await getAuth()

    if (!userId) {
      throw redirect({
        to: '/',
      })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div>
      Dashboard Layout
      <Outlet />
    </div>
  )
}
