import { createFileRoute } from '@tanstack/react-router'

import { Header } from './-components/header'
import { Requester } from './-components/requester'

export const Route = createFileRoute('/dashboard/request/')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="h-full overflow-auto">
      <Header />
      <div className="mx-auto flex w-full max-w-3xl items-center justify-center pt-8">
        <Requester />
      </div>
    </div>
  )
}
