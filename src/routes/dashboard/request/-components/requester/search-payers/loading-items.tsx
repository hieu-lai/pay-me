import { ComboboxItem } from '#/components/ui/combobox'
import { Skeleton } from '#/components/ui/skeleton'
import { range } from '#/lib/utils'

export function LoadingItems() {
  return range(3).map((v) => (
    <ComboboxItem key={v} disabled className="h-11">
      <Skeleton className="size-6 rounded-full" />
      <div className="space-y-1">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-16" />
      </div>
    </ComboboxItem>
  ))
}
