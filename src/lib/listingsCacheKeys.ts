// Cache keys + invalidation helpers for the Listings workspace. Pure (takes
// the cache as a parameter) so it is importable from Node tests; the
// session singleton lives in listingsCacheStore.ts.
//
// Each expensive Listings data source is cached INDEPENDENTLY, and every
// key carries the exact identity of what it holds so data for one window
// can never be served for another:
//   listing-evidence                          current snapshot (Overview, Unlisted)
//   listing-demand:<weeks>:<start>:<end>      Demand Evidence for one Trend Window
//                                             + the exact current-period dates
//   listing-item-activity:<weeks>:<from>:<to> Lead Activity by Item for one exact window

import type { SwrCache } from './swrCache';

export const LISTING_EVIDENCE_KEY = 'listing-evidence';
export const LISTING_DEMAND_PREFIX = 'listing-demand:';
export const ITEM_ACTIVITY_PREFIX = 'listing-item-activity:';

export function listingDemandKey(trendWeeks: number, startDate: string, endDate: string): string {
  return `${LISTING_DEMAND_PREFIX}${trendWeeks}:${startDate}:${endDate}`;
}

export function itemActivityKey(trendWeeks: number, from: string, to: string): string {
  return `${ITEM_ACTIVITY_PREFIX}${trendWeeks}:${from}:${to}`;
}

/**
 * Invalidation API. Invalidated entries stay renderable but are marked
 * stale, so the next visit revalidates in the background (a fetch that was
 * already in flight when the mutation landed is also stored as stale).
 */
export function createListingsInvalidators(cache: Pick<SwrCache, 'invalidate'>) {
  return {
    invalidateListingEvidenceCache: () => cache.invalidate(LISTING_EVIDENCE_KEY),
    invalidateListingDemandCache: () => cache.invalidate(LISTING_DEMAND_PREFIX),
    invalidateItemActivityCache: () => cache.invalidate(ITEM_ACTIVITY_PREFIX),
    /** Everything Listings shows (evidence + demand + item activity). */
    invalidateListingsCache: () => {
      cache.invalidate(LISTING_EVIDENCE_KEY);
      cache.invalidate(LISTING_DEMAND_PREFIX);
      cache.invalidate(ITEM_ACTIVITY_PREFIX);
    },
  };
}
