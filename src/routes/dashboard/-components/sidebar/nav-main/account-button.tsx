import { Link, useMatchRoute } from '@tanstack/react-router'
import { SidebarMenuButton } from '#/components/ui/sidebar'
import { Settings2Icon } from 'lucide-react'

export function AccountButton() {
  'use no memo'
  const matchRoute = useMatchRoute()
  const isActive = Boolean(
    matchRoute({
      to: `/dashboard/account`,
      fuzzy: true,
    }),
  )

  return (
    <SidebarMenuButton
      isActive={isActive}
      tooltip="Account"
      render={
        <Link to="/dashboard/account">
          <Settings2Icon />
          <span>Account</span>
        </Link>
      }
    />
  )
}
