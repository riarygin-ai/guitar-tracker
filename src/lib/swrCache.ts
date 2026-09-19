// Small, typed, framework-free stale-while-revalidate cache for the active
// browser session. No SWR / React Query is installed in this project, so
// this is the one shared client cache (kept deliberately tiny): it caches
// FACTUAL API RESULTS by key — never HTML, React elements or page state.
//
//  • fresh  (age < ttl)  -> served as-is; load() issues no request
//  • stale  (age >= ttl) -> still served immediately; load() revalidates
//  • none                -> load() fetches (callers show a blocking state)
//
// Guarantees (each covered by scripts/test-swr-cache.ts):
//  • concurrent load() calls for one key share ONE in-flight request
//  • a failed/rejected fetch clears its in-flight slot, keeps any previous
//    data, and NEVER refreshes fetchedAt
//  • invalidate() marks entries stale (still renderable, revalidated on the
//    next load); a fetch that STARTED before an invalidate lands as stale,
//    so it can't pose as fresh post-mutation data
//  • clear() drops everything (user/session change) and a fetch that
//    started before it is discarded — user A's response can never be
//    stored for user B
//  • time is injected (`now`), so tests need no sleeping
//
// Module-level, in-memory only: no IndexedDB, no service worker, no
// persistence, and nothing shared server-side.

export const DEFAULT_FRESH_TTL_MS = 5 * 60 * 1000;

export interface CacheEntry<T> {
  data: T;
  /** ms epoch of the last SUCCESSFUL fetch; 0 once invalidated. */
  fetchedAt: number;
}

export type CacheStatus = 'none' | 'fresh' | 'stale';

export class CacheClearedError extends Error {
  constructor() {
    super('cache cleared while request was in flight');
    this.name = 'CacheClearedError';
  }
}

export interface SwrCache {
  peek<T>(key: string): CacheEntry<T> | undefined;
  status(key: string): CacheStatus;
  isInFlight(key: string): boolean;
  /** Returns the cached entry when fresh (no request); otherwise fetches (deduped) and resolves with the new entry. Rejects on fetch failure (cached data is kept). */
  load<T>(key: string, fetcher: () => Promise<T>, opts?: { force?: boolean }): Promise<CacheEntry<T>>;
  /** Notified after a SUCCESSFUL fetch stores new data for the key. */
  subscribe(key: string, listener: () => void): () => void;
  /** Mark entries whose key starts with `prefix` stale (kept renderable). No prefix = all. */
  invalidate(prefix?: string): void;
  /** Drop every entry and discard in-flight results (user/session change). */
  clear(): void;
}

export function createSwrCache(options: { ttlMs?: number; now?: () => number } = {}): SwrCache {
  const ttlMs = options.ttlMs ?? DEFAULT_FRESH_TTL_MS;
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, CacheEntry<unknown>>();
  const inflight = new Map<string, Promise<CacheEntry<unknown>>>();
  const listeners = new Map<string, Set<() => void>>();
  let generation = 0;          // bumped by clear()
  let seq = 0;                 // bumped by invalidate()
  let invalidations: { seq: number; prefix: string }[] = [];

  const notify = (key: string) => {
    listeners.get(key)?.forEach((l) => l());
  };

  const status = (key: string): CacheStatus => {
    const e = entries.get(key);
    if (!e) return 'none';
    return now() - e.fetchedAt < ttlMs && e.fetchedAt > 0 ? 'fresh' : 'stale';
  };

  return {
    peek<T>(key: string) {
      return entries.get(key) as CacheEntry<T> | undefined;
    },
    status,
    isInFlight: (key) => inflight.has(key),

    load<T>(key: string, fetcher: () => Promise<T>, opts?: { force?: boolean }): Promise<CacheEntry<T>> {
      if (!opts?.force && status(key) === 'fresh') {
        return Promise.resolve(entries.get(key) as CacheEntry<T>);
      }
      const existing = inflight.get(key);
      if (existing) return existing as Promise<CacheEntry<T>>;

      const startedGeneration = generation;
      const startedSeq = seq;

      // `Promise.resolve().then(fetcher)` guarantees the fetcher (even a
      // synchronously-throwing one) runs after the in-flight slot is set.
      const run: Promise<CacheEntry<unknown>> = Promise.resolve().then(fetcher).then(
        (data) => {
          if (startedGeneration !== generation) throw new CacheClearedError();
          const invalidatedMeanwhile = invalidations.some((i) => i.seq > startedSeq && key.startsWith(i.prefix));
          const entry: CacheEntry<T> = { data, fetchedAt: invalidatedMeanwhile ? 0 : now() };
          entries.set(key, entry);
          if (inflight.get(key) === run) inflight.delete(key);
          notify(key);
          return entry as CacheEntry<unknown>;
        },
        (err) => {
          // Failure: release the slot, keep previous data, never touch fetchedAt.
          if (inflight.get(key) === run) inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, run);
      return run as Promise<CacheEntry<T>>;
    },

    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) { set = new Set(); listeners.set(key, set); }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) listeners.delete(key);
      };
    },

    invalidate(prefix = '') {
      seq += 1;
      invalidations = [...invalidations.slice(-199), { seq, prefix }];
      entries.forEach((entry, key) => {
        if (key.startsWith(prefix)) entries.set(key, { data: entry.data, fetchedAt: 0 });
      });
    },

    clear() {
      generation += 1;
      entries.clear();
      inflight.clear();
      invalidations = [];
      // Listeners stay: mounted components simply see an empty cache.
      for (const key of Array.from(listeners.keys())) notify(key);
    },
  };
}

// ── Auth scoping ─────────────────────────────────────────────────────────
// Cached responses are user-specific. This guard clears the cache whenever
// the signed-in user changes (or signs out) so a second user in the same
// tab can never see a first user's data. TOKEN_REFRESHED / USER_UPDATED for
// the SAME user keep the cache.

export function createUserScopeGuard(cache: Pick<SwrCache, 'clear'>) {
  let currentUserId: string | null | undefined; // undefined = not yet seen
  return function onAuthEvent(event: string, userId: string | null): void {
    if (event === 'SIGNED_OUT') {
      currentUserId = null;
      cache.clear();
      return;
    }
    if (currentUserId === undefined) {
      currentUserId = userId; // first sighting: nothing cached under another user
      return;
    }
    if (userId !== currentUserId) {
      currentUserId = userId;
      cache.clear();
    }
  };
}
