import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

import { AccountButton } from './account-button'
import { PayoutMethodsButton } from './payout-methods-button'
import { ProfileButton } from './profile-button'

export function NavMain() {
  return (
    <SidebarGroup>
      <SidebarMenu className="gap-1">
        <Collapsible
          className="group/collapsible"
          render={
            <SidebarMenuItem>
              <CollapsibleTrigger render={<ProfileButton />} />
            </SidebarMenuItem>
          }
        />
        <Collapsible
          className="group/collapsible"
          render={
            <SidebarMenuItem>
              <CollapsibleTrigger render={<AccountButton />} />
            </SidebarMenuItem>
          }
        />
        <Collapsible
          className="group/collapsible"
          render={
            <SidebarMenuItem>
              <CollapsibleTrigger render={<PayoutMethodsButton />} />
            </SidebarMenuItem>
          }
        />
      </SidebarMenu>
    </SidebarGroup>
  )
}
