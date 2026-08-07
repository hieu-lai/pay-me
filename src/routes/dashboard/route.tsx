import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { SidebarInset, SidebarProvider } from '#/components/ui/sidebar'
import { getAuth } from '#/server-fns/get-auth'

import { Sidebar } from './-components/sidebar'

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async () => {
    const { userId } = await getAuth()

    if (!userId) {
      throw redirect({
        to: '/',
      })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <SidebarProvider className="h-svh">
      <Sidebar className="pr-0.5 pl-0" />
      <SidebarInset className="md:peer-data-[variant=inset]:mb-0 md:peer-data-[variant=inset]:rounded-b-none md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-0">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  )
}
