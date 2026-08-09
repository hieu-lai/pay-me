import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { cn } from '@/lib/utils'
import type { Combobox as ComboboxPrimitive } from '@base-ui/react'
import type { PropsWithChildren, ReactNode } from 'react'

import SearchComboboxInput from './search-combobox-input'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxList,
} from './ui/combobox'

type ComboboxValue<
  T,
  TMultiple extends boolean | undefined,
> = TMultiple extends true ? Array<T> : T

type Props<T extends object, TMultiple extends boolean | undefined = false> = {
  multiple?: TMultiple
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
  placeholder?: string
  modal?: boolean
  className?: string
  items?: Array<T>
  inputValue?: string
  onInputValueChange?: (value: string) => void
  next?: () => void
  hasMore?: boolean
  loader: ReactNode
  isLoading?: boolean
  isFetching?: boolean
  emptyPlaceholder?: ReactNode
  value?: ComboboxValue<T, TMultiple> | null
  onValueChange?: (
    data: ComboboxValue<T, TMultiple> | (TMultiple extends true ? never : null),
  ) => void
  itemToStringLabel?: (item: T) => string
  itemToStringValue?: (item: T) => string
  isItemEqualToValue?: (item: T, value: T) => boolean
} & PropsWithChildren &
  Omit<
    ComboboxPrimitive.Input.Props,
    | 'className'
    | 'defaultValue'
    | 'multiple'
    | 'onChange'
    | 'placeholder'
    | 'value'
  >

export default function AsyncInputCombobox<
  T extends object,
  TMultiple extends boolean | undefined = false,
>({
  children,
  multiple,
  items = [],
  inputValue,
  onInputValueChange,
  next = () => {},
  hasMore = false,
  loader,
  placeholder = 'Search...',
  isLoading,
  isFetching,
  emptyPlaceholder = 'No items found.',
  value,
  onValueChange,
  itemToStringLabel,
  itemToStringValue,
  isItemEqualToValue,
  isOpen,
  onOpenChange,
  modal,
  className,
  ...inputProps
}: Props<T, TMultiple>) {
  const loadMoreRef = useInfiniteScroll<HTMLDivElement>({
    enabled: hasMore && !isLoading,
    onLoadMore: next,
  })

  return (
    <Combobox
      multiple={multiple}
      filteredItems={items}
      inputValue={inputValue}
      onInputValueChange={onInputValueChange}
      value={value}
      onValueChange={onValueChange}
      itemToStringLabel={itemToStringLabel}
      itemToStringValue={itemToStringValue}
      isItemEqualToValue={isItemEqualToValue}
      open={isOpen}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      <SearchComboboxInput
        placeholder={placeholder}
        className={cn('w-full', className)}
        isFetching={isFetching}
        {...inputProps}
      />
      <ComboboxContent
        className="left-0 w-[calc(var(--anchor-width)+(--spacing(12.9)))]"
        alignOffset={-24}
      >
        {!isLoading && <ComboboxEmpty>{emptyPlaceholder}</ComboboxEmpty>}
        <ComboboxList>
          {children}
          {(hasMore || isLoading) && (
            <div ref={loadMoreRef}>{isLoading && loader}</div>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
