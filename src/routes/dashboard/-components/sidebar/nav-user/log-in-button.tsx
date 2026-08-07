import { useSidebar } from '@/components/ui/sidebar'
import { Link } from '@tanstack/react-router'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { LogIn } from 'lucide-react'

export function LogInButton() {
  const { open } = useSidebar()

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/sign-in/$"
            className="group-data-[collapsible=icon]:p-1.5!"
          >
            <LogIn />
            <p>Log in</p>
          </Link>
        }
      />
      <TooltipContent side="right" hidden={open}>
        <p>Log in</p>
      </TooltipContent>
    </Tooltip>
  )
}
