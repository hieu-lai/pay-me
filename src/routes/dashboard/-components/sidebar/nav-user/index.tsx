import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Skeleton } from '#/components/ui/skeleton'
import { AuthLoading, Authenticated } from 'convex/react'
import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import { UserMenu } from './user-menu'

export function NavUser() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <AuthLoading>
          <SidebarMenuButton className="pointer-events-none">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </SidebarMenuButton>
        </AuthLoading>
        <Authenticated>
          <ErrorBoundary fallback={<div>Error</div>}>
            <Suspense
              fallback={
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="size-5 rounded-full" />
                  <Skeleton className="h-4 w-24" />
                </div>
              }
            >
              <UserMenu />
            </Suspense>
          </ErrorBoundary>
        </Authenticated>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
