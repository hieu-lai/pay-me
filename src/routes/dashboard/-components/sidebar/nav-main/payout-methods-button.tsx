import { Link, useMatchRoute } from '@tanstack/react-router'
import { SidebarMenuButton } from '#/components/ui/sidebar'
import { PiggyBankIcon } from 'lucide-react'

export function PayoutMethodsButton() {
  'use no memo'
  const matchRoute = useMatchRoute()
  const isActive = Boolean(
    matchRoute({
      to: `/dashboard/payout-methods`,
      fuzzy: true,
    }),
  )

  return (
    <SidebarMenuButton
      isActive={isActive}
      tooltip="Payout methods"
      render={
        <Link to="/dashboard/payout-methods">
          <PiggyBankIcon />
          <span>Payout methods</span>
        </Link>
      }
    />
  )
}
