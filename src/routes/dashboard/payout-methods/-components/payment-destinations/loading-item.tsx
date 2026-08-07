import {
  ItemActions,
  ItemContent,
  ItemFooter,
  ItemMedia,
  ItemTitle,
  Item as ShadcnItem,
} from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'

export function LoadingItem() {
  return (
    <ShadcnItem variant="outline" aria-hidden="true">
      <ItemMedia variant="icon">
        <Skeleton className="size-4" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <Skeleton className="h-4 w-32" />
        </ItemTitle>
      </ItemContent>
      <ItemActions>
        <Skeleton className="size-7" />
      </ItemActions>
      <ItemFooter>
        <Skeleton className="h-4 w-40" />
      </ItemFooter>
    </ShadcnItem>
  )
}
