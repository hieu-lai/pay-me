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

type Payer = FormValues['payers'][number]

type SearchPayersProps = Pick<
  ComponentProps<'input'>,
  'aria-invalid' | 'id' | 'name' | 'onBlur'
> & {
  value: Array<Payer>
  onValueChange: (value: Array<Payer>) => void
}

export function SearchPayers({
  value,
  onValueChange,
  ...inputProps
}: SearchPayersProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery] = useDebounceValue(query, 300)
  const searchTerm = debouncedQuery.trim()
  const {
    data: payers = [],
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
      ? 'Start typing to search for a Payer.'
      : isError
        ? 'Unable to search for Payers.'
        : 'No Payers found.'

  return (
    <AsyncInputCombobox<Payer, true>
      multiple
      items={payers}
      value={value}
      onValueChange={onValueChange}
      inputValue={query}
      onInputValueChange={setQuery}
      isLoading={isLoading}
      isFetching={isFetching}
      itemToStringLabel={(payer) => payer.name}
      itemToStringValue={(payer) => payer.id}
      isItemEqualToValue={(payer, selectedValue) =>
        payer.id === selectedValue.id
      }
      loader={<LoadingItems />}
      emptyPlaceholder={emptyPlaceholder}
      placeholder="Search name or username"

      {...inputProps}
    >
      {payers.map((payer, index) => (
        <ComboboxItem
          key={payer.id}
          value={payer}
          index={index}
          disabled={!payer.hasPaymentDestination}
        >
          <Avatar size="sm">
            {payer.imageUrl && (
              <AvatarImage src={payer.imageUrl} alt={payer.name} />
            )}
            <AvatarFallback>{getInitials(payer.name)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate">{payer.name}</span>
            {payer.username && (
              <span className="text-muted-foreground truncate text-xs">
                @{payer.username}
              </span>
            )}
          </div>
        </ComboboxItem>
      ))}
    </AsyncInputCombobox>
  )
}
