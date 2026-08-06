import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { getAuth } from '#/server-fns/get-auth'

export const Route = createFileRoute('/_auth-layout')({
  beforeLoad: async () => {
    const { userId } = await getAuth()

    if (userId) {
      throw redirect({
        to: '/dashboard',
      })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Outlet />
    </div>
  )
}
