import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { useInfiniteScroll } from '@/hooks/use-infinite-scroll'
import { usePaginatedQuery } from 'convex-helpers/react/cache'
import { PiggyBankIcon } from 'lucide-react'

import { api } from '../../../../../../convex/_generated/api'
import { AddPayoutMethod } from '../add-method'
import { Item } from './item'
import { LoadingItem } from './loading-item'

const PAGE_SIZE = 10

export function PaymentDestinations() {
  const { isLoading, loadMore, results, status } = usePaginatedQuery(
    api.paymentDestinations.list,
    {},
    { initialNumItems: PAGE_SIZE },
  )
  const loadMoreRef = useInfiniteScroll<HTMLDivElement>({
    enabled: status === 'CanLoadMore',
    onLoadMore: () => loadMore(PAGE_SIZE),
    rootMargin: '200px',
  })
  const loadingItemCount = status === 'LoadingFirstPage' ? 3 : 1
  const isEmpty = !isLoading && results.length === 0

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-2 py-8">
      {isEmpty && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PiggyBankIcon />
            </EmptyMedia>
            <EmptyTitle>No payout methods</EmptyTitle>
            <EmptyDescription>
              Add a payout method to receive payments.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center gap-2">
            <AddPayoutMethod />
          </EmptyContent>
        </Empty>
      )}
      {results.map((item) => (
        <Item key={item.id} {...item} />
      ))}
      {status !== 'Exhausted' && (
        <div ref={loadMoreRef} className="flex w-full flex-col gap-2">
          {isLoading &&
            Array.from({ length: loadingItemCount }, (_, index) => (
              <LoadingItem key={index} />
            ))}
        </div>
      )}
    </div>
  )
}
