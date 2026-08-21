// Listing-oriented drill-down filter logic for the Inventory page
// (src/app/inventory/page.tsx). Extracted into its own module so it is
// importable from a plain Node test script (the page file itself is
// 'use client' and imports next/navigation, which doesn't load outside
// the Next.js runtime) and so the Dashboard-to-Inventory drill-down
// contract has one place to read instead of being buried in a page
// component. Every fact here is sourced from an already-fetched Listing
// Evidence v1.0 object — nothing here recalculates listing state.

import type { ListingEvidence, ListingAgeBucketCode } from './analytics/listingEvidence';

export type ListingFilterValue = 'listed' | 'unlisted';
export const LISTING_FILTER_VALUES: ListingFilterValue[] = ['listed', 'unlisted'];
export const AGE_BUCKET_VALUES: ListingAgeBucketCode[] = ['LT_14', 'D14_30', 'D31_60', 'D61_90', 'D90_PLUS'];

export const AGE_BUCKET_LABELS: Record<ListingAgeBucketCode, string> = {
  LT_14: '< 14 days',
  D14_30: '14-30 days',
  D31_60: '31-60 days',
  D61_90: '61-90 days',
  D90_PLUS: '90+ days',
};

export interface ItemListingLookup {
  listedItemIds: Set<number>;
  unlistedItemIds: Set<number>;
  activeListingsByItemId: Map<number, { channel_id: number; channel_name: string; listing_age_bucket: string | null }[]>;
  activeChannelCountByItemId: Map<number, number>;
  channelNameById: Map<number, string>;
}

/**
 * Builds per-item listing lookup maps from Listing Evidence v1.0. Personal
 * items are deliberately excluded from unlistedItemIds — Listing Evidence
 * itself never enumerates unlisted Personal items individually (only an
 * aggregate count), because Personal inventory is not a listing candidate.
 * A filter combining listing=unlisted with a Personal purpose therefore
 * correctly returns zero rows rather than guessing.
 */
export function buildListingLookups(evidence: ListingEvidence): ItemListingLookup {
  const listedItemIds = new Set<number>();
  const unlistedItemIds = new Set<number>();
  const activeListingsByItemId = new Map<number, { channel_id: number; channel_name: string; listing_age_bucket: string | null }[]>();
  const activeChannelCountByItemId = new Map<number, number>();
  const channelNameById = new Map<number, string>();

  for (const c of evidence.channel_summary) channelNameById.set(c.channel_id, c.channel_name);

  for (const item of evidence.listed_items) {
    listedItemIds.add(item.item_id);
    activeListingsByItemId.set(
      item.item_id,
      item.active_listings.map((l) => ({ channel_id: l.channel_id, channel_name: l.channel_name, listing_age_bucket: l.listing_age_bucket })),
    );
    activeChannelCountByItemId.set(item.item_id, item.active_channel_count);
  }
  for (const item of [
    ...evidence.unlisted_open_inventory.business,
    ...evidence.unlisted_open_inventory.hybrid,
    ...evidence.unlisted_open_inventory.unclassified,
  ]) {
    unlistedItemIds.add(item.item_id);
  }

  return { listedItemIds, unlistedItemIds, activeListingsByItemId, activeChannelCountByItemId, channelNameById };
}

export interface ListingFilterSelection {
  listingFilter: ListingFilterValue | null;
  channelIds: number[];
  ageBuckets: ListingAgeBucketCode[];
  channelCounts: string[];
}

export function hasAnyListingFilter(sel: ListingFilterSelection): boolean {
  return sel.listingFilter !== null || sel.channelIds.length > 0 || sel.ageBuckets.length > 0 || sel.channelCounts.length > 0;
}

/**
 * True if `itemId` matches every active listing-oriented filter in `sel`.
 * channelIds/ageBuckets are matched together against the SAME listing (an
 * item cross-listed on Reverb (90+) and Marketplace (10d) matches
 * channel_id=Reverb&age_bucket=D90_PLUS but not channel_id=Marketplace&
 * age_bucket=D90_PLUS) — never independently against any listing.
 */
export function matchesListingFilters(itemId: number, lookup: ItemListingLookup, sel: ListingFilterSelection): boolean {
  if (sel.listingFilter === 'listed' && !lookup.listedItemIds.has(itemId)) return false;
  if (sel.listingFilter === 'unlisted' && !lookup.unlistedItemIds.has(itemId)) return false;

  if (sel.channelIds.length > 0 || sel.ageBuckets.length > 0) {
    const listings = lookup.activeListingsByItemId.get(itemId) ?? [];
    const matchesAny = listings.some(
      (l) =>
        (sel.channelIds.length === 0 || sel.channelIds.includes(l.channel_id)) &&
        (sel.ageBuckets.length === 0 || (l.listing_age_bucket != null && sel.ageBuckets.includes(l.listing_age_bucket as ListingAgeBucketCode))),
    );
    if (!matchesAny) return false;
  }

  if (sel.channelCounts.length > 0) {
    const count = lookup.activeChannelCountByItemId.get(itemId) ?? 0;
    const bucket = count >= 3 ? '3_plus' : String(count);
    if (!sel.channelCounts.includes(bucket)) return false;
  }

  return true;
}
