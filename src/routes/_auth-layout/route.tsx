import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth-layout')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Outlet />
    </div>
  )
}
