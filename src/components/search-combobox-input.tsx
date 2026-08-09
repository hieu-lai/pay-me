import { cn } from '@/lib/utils'
import { Combobox as ComboboxPrimitive } from '@base-ui/react'
import { SearchIcon } from 'lucide-react'

import { ComboboxTrigger } from './ui/combobox'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from './ui/input-group'
import { Spinner } from './ui/spinner'

export default function SearchComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  isFetching = false,
  ...props
}: ComboboxPrimitive.Input.Props & {
  showTrigger?: boolean
  showClear?: boolean
  isFetching?: boolean
}) {
  return (
    <InputGroup className={cn('w-auto', className)}>
      <ComboboxPrimitive.Input
        render={<InputGroupInput disabled={disabled} />}
        {...props}
      />
      <InputGroupAddon align="inline-start">
        <SearchIcon className="text-muted-foreground" />
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        {isFetching ? (
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            disabled={disabled}
            className="pointer-events-none"
          >
            <Spinner />
          </InputGroupButton>
        ) : showTrigger ? (
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            data-slot="input-group-button"
            className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
            disabled={disabled}
            render={<ComboboxTrigger />}
          />
        ) : null}
      </InputGroupAddon>
      {children}
    </InputGroup>
  )
}
