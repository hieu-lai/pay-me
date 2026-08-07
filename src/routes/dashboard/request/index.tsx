import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard/request/')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/dashboard/request/"!</div>
}
