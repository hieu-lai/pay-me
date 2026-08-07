import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Collapsible, CollapsibleTrigger } from '#/components/ui/collapsible'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'
import { TurtleIcon } from 'lucide-react'

import { RequestButton } from './request-button'

export function Header() {
  const { open } = useSidebar()

  return (
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem className="group/brand flex h-8 items-center">
          <span
            className={cn(
              'px-2 text-lg font-semibold transition-[opacity,transform] duration-200 ease-out',
              !open && 'pointer-events-none scale-95 opacity-0',
            )}
          >
            PayMe
          </span>
          <TurtleIcon
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute left-1/2 size-5 -translate-x-1/2 transition-[opacity,transform] duration-150 ease-out',
              open
                ? 'scale-75 opacity-0'
                : 'scale-100 opacity-100 group-hover/brand:scale-90 group-hover/brand:opacity-0 group-has-focus-visible/brand:scale-90 group-has-[:focus-visible]/brand:opacity-0',
            )}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger
                  className={cn(
                    'absolute transition-[opacity,transform,background-color,color] duration-150 ease-out',
                    open
                      ? 'right-0 opacity-100'
                      : 'left-1/2 -translate-x-1/2 scale-90 opacity-0 group-hover/brand:scale-100 group-hover/brand:opacity-100 focus-visible:scale-100 focus-visible:opacity-100',
                  )}
                />
              }
            />
            <TooltipContent side="right">
              <p>{open ? 'Close sidebar' : 'Open sidebar'}</p>
            </TooltipContent>
          </Tooltip>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarMenu>
        <Collapsible
          key="new-chat"
          className="group/collapsible"
          render={
            <SidebarMenuItem>
              <CollapsibleTrigger render={<RequestButton />} />
            </SidebarMenuItem>
          }
        />
      </SidebarMenu>
    </SidebarHeader>
  )
}
