import { useEffect, useRef } from 'react';

export function useInfiniteScroll(
  onLoadMore: () => void,
  {
    hasMore,
    isLoading,
    disabled = false,
  }: { hasMore: boolean; isLoading: boolean; disabled?: boolean },
) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!hasMore || isLoading || disabled) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onLoadMoreRef.current();
      },
      { rootMargin: '600px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoading, disabled]);

  return sentinelRef;
}
