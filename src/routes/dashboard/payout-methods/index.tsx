import { createFileRoute } from '@tanstack/react-router'

import { Header } from './-components/header'
import { PaymentDestinations } from './-components/payment-destinations'

export const Route = createFileRoute('/dashboard/payout-methods/')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="h-full overflow-auto">
      <Header />
      <PaymentDestinations />
    </div>
  )
}
