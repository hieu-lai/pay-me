import { convexQuery } from '@convex-dev/react-query'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import AsyncInputCombobox from '#/components/async-input-combobox'
import { Avatar, AvatarFallback, AvatarImage } from '#/components/ui/avatar'
import { ComboboxItem } from '#/components/ui/combobox'
import getInitials from '#/lib/get-initials'
import { useState } from 'react'
import type { ComponentProps } from 'react'
import { useDebounceValue } from 'usehooks-ts'

import { api } from '../../../../../../../convex/_generated/api'
import type { FormValues } from '../schema'
import { LoadingItems } from './loading-items'

type Recipient = FormValues['recipients'][number]

type SearchRecipientsProps = Pick<
  ComponentProps<'input'>,
  'aria-invalid' | 'id' | 'name' | 'onBlur'
> & {
  value: Array<Recipient>
  onValueChange: (value: Array<Recipient>) => void
}

export function SearchRecipients({
  value,
  onValueChange,
  ...inputProps
}: SearchRecipientsProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebounceValue(query, 300)
  const searchTerm = debouncedQuery.trim()
  const {
    data: recipients = [],
    isError,
    isFetching,
    isLoading,
  } = useQuery({
    ...convexQuery(
      api.users.search,
      searchTerm.length === 0 ? 'skip' : { query: searchTerm },
    ),
    placeholderData: keepPreviousData,
  })

  const emptyPlaceholder =
    searchTerm.length === 0
      ? 'Start typing to search for a recipient.'
      : isError
        ? 'Unable to search for recipients.'
        : 'No recipients found.'

  return (
    <AsyncInputCombobox<Recipient, true>
      multiple
      items={recipients}
      value={value}
      onValueChange={onValueChange}
      inputValue={query}
      onInputValueChange={setQuery}
      isLoading={isLoading}
      isFetching={isFetching}
      itemToStringLabel={(recipient) => recipient.name}
      itemToStringValue={(recipient) => recipient.id}
      isItemEqualToValue={(recipient, selectedValue) =>
        recipient.id === selectedValue.id
      }
      loader={<LoadingItems />}
      emptyPlaceholder={emptyPlaceholder}
      placeholder="Search name or username"

      {...inputProps}
    >
      {recipients.map((recipient, index) => (
        <ComboboxItem
          key={recipient.id}
          value={recipient}
          index={index}
          disabled={!recipient.hasPaymentDestination}
        >
          <Avatar size="sm">
            {recipient.imageUrl && (
              <AvatarImage src={recipient.imageUrl} alt={recipient.name} />
            )}
            <AvatarFallback>{getInitials(recipient.name)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{recipient.name}</span>
            {recipient.username && (
              <span className="text-muted-foreground truncate text-xs">
                @{recipient.username}
              </span>
            )}
          </div>
        </ComboboxItem>
      ))}
    </AsyncInputCombobox>
  )
}
