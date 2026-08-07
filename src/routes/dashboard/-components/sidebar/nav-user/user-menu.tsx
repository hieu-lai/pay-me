import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useClerk } from '@clerk/tanstack-react-start'
import { convexQuery } from '@convex-dev/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'
import { SidebarMenuButton, useSidebar } from '#/components/ui/sidebar'
import getInitials from '#/lib/get-initials'
import { BadgeCheck, Bell, CreditCard, LogOut, Sparkles } from 'lucide-react'

import { api } from '../../../../../../convex/_generated/api'
import { ModeButton } from './mode-button'

export function UserMenu() {
  const { isMobile } = useSidebar()
  const { signOut } = useClerk()

  const { data } = useSuspenseQuery(convexQuery(api.users.me))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="default"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:p-1.5!"
          >
            <Avatar className="size-5 rounded-lg">
              <AvatarImage src={data.imageUrl} alt={data.name} />
              <AvatarFallback className="rounded-lg text-[10px]">
                {getInitials(data.name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">{data.name}</span>
            </div>
          </SidebarMenuButton>
        }
      />
      <DropdownMenuContent
        className="min-w-56 rounded-lg"
        side={isMobile ? 'bottom' : 'top'}
        align="center"
        sideOffset={4}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <Avatar className="size-5 rounded-lg">
                <AvatarImage src={data.imageUrl} alt={data.name} />
                <AvatarFallback className="rounded-lg text-[10px]">
                  {getInitials(data.name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{data.name}</span>
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <Sparkles />
            Upgrade to Pro
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <BadgeCheck />
            Account
          </DropdownMenuItem>
          <DropdownMenuItem>
            <CreditCard />
            Billing
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Bell />
            Notifications
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <ModeButton />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut({ redirectUrl: '/' })}>
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
