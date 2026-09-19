'use client';

// React binding for the SWR cache (swrCache.ts).
//
// Render rules (priority: fresh response -> cached response -> loading/error only when no usable data):
//  • data comes from cache.peek(key) SYNCHRONOUSLY during render, so a
//    remount / return navigation with cached data renders it on the first
//    paint — no blocking loading state, no flash.
//  • the entry is looked up by the CURRENT key, so data cached for another
//    key (another Trend Window / date window) is never returned.
//  • fresh -> no request; stale/none -> load() (deduped across all callers
//    for the key); stale data stays on screen while it revalidates.
//  • a failed revalidation keeps the stale data (surfaced only as
//    `refreshError`); `error` is only set when there is nothing to show.
//  • the fetch keeps running after unmount and still lands in the cache;
//    component state is never set after unmount.

import { useEffect, useReducer, useRef, useState } from 'react';
import { CacheClearedError, type SwrCache } from './swrCache';

export interface SwrResource<T> {
  data: T | undefined;
  fetchedAt: number | undefined;
  /** No usable data yet and a request is (about to be) running. */
  isLoading: boolean;
  /** Showing cached data while a background revalidation runs. */
  isRefreshing: boolean;
  /** Only when there is no data to show. */
  error: string | null;
  /** A failed background refresh while cached data is still shown. */
  refreshError: string | null;
}

interface FetchState {
  key: string | null;
  fetching: boolean;
  error: string | null;
}

export function useSwrResource<T>(cache: SwrCache, key: string | null, fetcher: () => Promise<T>): SwrResource<T> {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<FetchState>({ key: null, fetching: false, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;

    const start = () => {
      setState({ key, fetching: true, error: null });
      cache.load<T>(key, () => fetcherRef.current()).then(
        () => { if (!cancelled) setState({ key, fetching: false, error: null }); },
        (err: unknown) => {
          if (cancelled || err instanceof CacheClearedError) return;
          setState({ key, fetching: false, error: err instanceof Error ? err.message : 'Request failed' });
        },
      );
    };

    const unsubscribe = cache.subscribe(key, () => {
      if (cancelled) return;
      bump();
      // The cache was cleared under us (user/session change): fetch again.
      if (!cache.peek(key) && !cache.isInFlight(key)) start();
    });

    if (cache.status(key) !== 'fresh') start();

    return () => { cancelled = true; unsubscribe(); };
  }, [cache, key]);

  const entry = key !== null ? cache.peek<T>(key) : undefined;
  const mine = state.key === key ? state : null;
  const fetching = mine ? mine.fetching : key !== null && cache.status(key) !== 'fresh';

  return {
    data: entry?.data,
    fetchedAt: entry?.fetchedAt,
    isLoading: key !== null && !entry && !(mine && mine.error),
    isRefreshing: !!entry && fetching,
    error: !entry && mine ? mine.error : null,
    refreshError: entry && mine ? mine.error : null,
  };
}
