import { Link, useMatchRoute } from '@tanstack/react-router'
import { SidebarMenuButton } from '#/components/ui/sidebar'
import { CircleDollarSignIcon } from 'lucide-react'

export function RequestButton() {
  'use no memo'
  const matchRoute = useMatchRoute()
  const isActive = Boolean(
    matchRoute({
      to: `/dashboard/request`,
    }),
  )

  return (
    <SidebarMenuButton
      tooltip="Request"
      isActive={isActive}
      render={
        <Link to="/dashboard/request">
          <CircleDollarSignIcon />
          <span>Request</span>
        </Link>
      }
    />
  )
}
