import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '#/lib/utils'
import type { ComponentProps } from 'react'

import { Header } from './header'
import { NavMain } from './nav-main'
import { NavUser } from './nav-user'

export function Sidebar({ ...props }: ComponentProps<typeof ShadcnSidebar>) {
  const { open } = useSidebar()

  return (
    <ShadcnSidebar variant="inset" collapsible="icon" {...props}>
      <Header />
      <SidebarContent>
        <NavMain />
      </SidebarContent>
      <SidebarFooter
        className={cn('-mb-2 border-t', open ? '-mx-0.75' : 'mx-0')}
      >
        <NavUser />
      </SidebarFooter>
    </ShadcnSidebar>
  )
}
