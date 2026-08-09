import { useEffect, useEffectEvent, useRef } from 'react'

type UseInfiniteScrollOptions = {
  enabled?: boolean
  onLoadMore: () => void
  rootMargin?: string
}

export function useInfiniteScroll<T extends Element = HTMLDivElement>({
  enabled = true,
  onLoadMore,
  rootMargin = '0px',
}: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<T>(null)
  const handleLoadMore = useEffectEvent(onLoadMore)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !enabled) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.length === 0) return
        if (entries[0].isIntersecting) handleLoadMore()
      },
      { rootMargin },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [enabled, rootMargin])

  return sentinelRef
}
