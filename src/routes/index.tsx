import { createFileRoute } from '@tanstack/react-router'

import { Header } from './-components/header'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="min-h-screen">
      <Header />
      <div className="h-400">Stuff goes here</div>
    </div>
  )
}
