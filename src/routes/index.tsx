import { createFileRoute } from '@tanstack/react-router'

import { Header } from './-components/header'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <div className="dev min-h-screen">
      <Header />
      <div className="dev2 h-400">Stuff goes here</div>
    </div>
  )
}
