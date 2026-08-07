import { Link, useMatchRoute } from '@tanstack/react-router'
import { SidebarMenuButton } from '#/components/ui/sidebar'
import { User2Icon } from 'lucide-react'

export function ProfileButton() {
  'use no memo'
  const matchRoute = useMatchRoute()
  const isActive = Boolean(
    matchRoute({
      to: `/dashboard/profile`,
      fuzzy: true,
    }),
  )

  return (
    <SidebarMenuButton
      tooltip="Profile"
      isActive={isActive}
      render={
        <Link to="/dashboard/profile">
          <User2Icon />
          <span>Profile</span>
        </Link>
      }
    ></SidebarMenuButton>
  )
}
