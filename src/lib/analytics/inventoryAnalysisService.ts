// Server-callable inventory/listing analysis — the read-only MCP
// `get_inventory_analysis` tool's data source. Reuses the EXACT dataset
// builder behind "Copy Analysis Data" / "Download Analysis Data" (see
// src/app/api/listing-analysis-export/route.ts): `buildAnalysisExportData`
// (src/lib/analytics/listingAnalysisPacket.ts) — completely unmodified,
// pure, no I/O. This module's only job is fetching that function's three
// inputs through the authenticated, request-scoped client (never
// service_role), then applying OPTIONAL, non-mutating filtering on top of
// the untouched canonical dataset.
//
// Identity: the Listing Evidence snapshot comes from
// build_listing_evidence_v1_0_for_current_user() (migration
// 20261013000000) — a self-scoped wrapper that resolves the caller
// entirely from auth.uid()/get_app_user_id(), never a parameter. item_
// listings / item_listing_price_history are read directly — both tables'
// own RLS ("select own" policies, user_id = get_app_user_id()) already
// scope them to the caller with no explicit filter needed. No user id of
// any kind is ever accepted, read from the request, or passed anywhere in
// this file.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ItemListing, ItemListingPriceHistory } from '@/types';
import { isValidListingEvidence, ListingEvidenceError, type ListingEvidence } from './listingEvidence';
import {
  buildAnalysisExportData,
  type AnalysisExportData,
  type ExportListedItemEvidence,
  type ExportUnlistedItemEvidence,
} from './listingAnalysisPacket';

export class InventoryAnalysisServiceError extends Error {}

export interface InventoryAnalysisFilters {
  /** Restrict to these inventory item ids (any that don't exist/aren't open are simply absent from the result — never an error). */
  item_ids?: number[];
  /** 'listed' = currently active on at least one channel; 'unlisted' = open but not currently listed anywhere. */
  status?: ('listed' | 'unlisted')[];
  /** Exact, case-insensitive match against the item's assigned Purpose name (e.g. "Business", "Hybrid", or a custom purpose). */
  purpose?: string[];
  /** Exact, case-insensitive match against brand name. */
  brand?: string[];
  /** Exact, case-insensitive match against item category name. */
  category?: string[];
  /** Exact, case-insensitive match against item type (subtype) name. */
  type?: string[];
  /** Only items whose current listing age (the longest-running active listing, in days) is >= this. Excludes unlisted items when set. */
  min_days_listed?: number;
  /** Only items whose current listing age (the longest-running active listing, in days) is <= this. Excludes unlisted items when set. */
  max_days_listed?: number;
  /** Default true. Set false to omit each item's listing_history (price-change detail) and shrink the response for broad queries that don't need it. */
  include_listing_history?: boolean;
}

export interface InventoryAnalysisResult {
  generated_at: string;
  filters_applied: InventoryAnalysisFilters;
  item_count: number;
  data: AnalysisExportData;
}

/** Longest current listing age (days) among an item's active listings; null when not currently listed or age is unknown. */
function currentListingAgeDays(item: ExportListedItemEvidence): number | null {
  const ages = item.active_listings.map((l) => l.current_listing_age_days).filter((d): d is number => d != null);
  return ages.length > 0 ? Math.max(...ages) : null;
}

function norm(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean));
}

function matchesCatalog(value: string | null, allowed: Set<string> | null): boolean {
  if (!allowed) return true;
  return value != null && allowed.has(value.toLowerCase());
}

function filterBase<T extends ExportUnlistedItemEvidence>(
  items: T[],
  itemIds: Set<number> | null,
  purpose: Set<string> | null,
  brand: Set<string> | null,
  category: Set<string> | null,
  type: Set<string> | null,
): T[] {
  return items.filter((item) =>
    (itemIds === null || itemIds.has(item.item_id)) &&
    matchesCatalog(item.purpose_name, purpose) &&
    matchesCatalog(item.brand_name, brand) &&
    matchesCatalog(item.category_name, category) &&
    matchesCatalog(item.type_name, type),
  );
}

/**
 * Applies the tool's optional filters on top of an already-built,
 * untouched canonical dataset. Pure and non-mutating — every array
 * produced is a new filtered copy; `data` itself (and anything nested
 * inside it) is never written to, so calling this twice with different
 * filters against the same `data` object can never let one call's
 * filtering leak into another's.
 */
export function applyInventoryAnalysisFilters(data: AnalysisExportData, filters: InventoryAnalysisFilters): AnalysisExportData {
  const itemIds = filters.item_ids && filters.item_ids.length > 0 ? new Set(filters.item_ids) : null;
  const purpose = norm(filters.purpose);
  const brand = norm(filters.brand);
  const category = norm(filters.category);
  const type = norm(filters.type);
  const statuses = filters.status && filters.status.length > 0 ? new Set(filters.status) : null;
  const wantListed = statuses === null || statuses.has('listed');
  const wantUnlisted = statuses === null || statuses.has('unlisted');
  const hasAgeFilter = filters.min_days_listed != null || filters.max_days_listed != null;

  let listedItems = wantListed ? filterBase(data.listed_items, itemIds, purpose, brand, category, type) : [];
  if (hasAgeFilter) {
    listedItems = listedItems.filter((item) => {
      const age = currentListingAgeDays(item);
      if (age == null) return false; // age unknown -> cannot satisfy a numeric bound
      if (filters.min_days_listed != null && age < filters.min_days_listed) return false;
      if (filters.max_days_listed != null && age > filters.max_days_listed) return false;
      return true;
    });
  }

  // Unlisted items have no listing age at all — a min/max_days_listed
  // filter (a question specifically about current listing duration) never
  // matches them, same as the existing dataset's own "age available/
  // missing" distinction (listing_age_semantics) elsewhere in Listing
  // Evidence: an inapplicable field is excluded, never coerced to 0.
  const includeUnlisted = wantUnlisted && !hasAgeFilter;
  const unlistedBusiness = includeUnlisted ? filterBase(data.unlisted_business_items, itemIds, purpose, brand, category, type) : [];
  const unlistedHybrid = includeUnlisted ? filterBase(data.unlisted_hybrid_items, itemIds, purpose, brand, category, type) : [];
  const unlistedUnclassified = includeUnlisted ? filterBase(data.unlisted_unclassified_items, itemIds, purpose, brand, category, type) : [];

  const stripHistory = filters.include_listing_history === false;
  const maybeStrip = <T extends { listing_history: unknown }>(items: T[]): T[] =>
    stripHistory ? items.map((item) => ({ ...item, listing_history: [] })) : items;

  return {
    ...data,
    listed_items: maybeStrip(listedItems),
    unlisted_business_items: maybeStrip(unlistedBusiness),
    unlisted_hybrid_items: maybeStrip(unlistedHybrid),
    unlisted_unclassified_items: maybeStrip(unlistedUnclassified),
  };
}

/**
 * Loads the three inputs buildAnalysisExportData needs, through the
 * caller's own authenticated/RLS-scoped client — never service_role.
 * Returns the UNFILTERED canonical dataset (identical in content to what
 * Copy/Download Analysis Data produces); callers apply filtering with
 * applyInventoryAnalysisFilters.
 */
export async function getCanonicalInventoryAnalysis(client: SupabaseClient): Promise<AnalysisExportData> {
  const [evidenceRes, listingsRes, priceHistoryRes] = await Promise.all([
    client.rpc('build_listing_evidence_v1_0_for_current_user'),
    client.from('item_listings').select('*'),
    client.from('item_listing_price_history').select('*'),
  ]);

  if (evidenceRes.error) throw new InventoryAnalysisServiceError(`listing evidence: ${evidenceRes.error.message}`);
  if (!isValidListingEvidence(evidenceRes.data)) throw new InventoryAnalysisServiceError('listing evidence: unexpected shape');
  if (listingsRes.error) throw new InventoryAnalysisServiceError(`item_listings: ${listingsRes.error.message}`);
  if (priceHistoryRes.error) throw new InventoryAnalysisServiceError(`item_listing_price_history: ${priceHistoryRes.error.message}`);

  const evidence: ListingEvidence = evidenceRes.data;
  return buildAnalysisExportData({
    evidence,
    itemListings: (listingsRes.data ?? []) as ItemListing[],
    priceHistory: (priceHistoryRes.data ?? []) as ItemListingPriceHistory[],
  });
}

function countItems(data: AnalysisExportData): number {
  return data.listed_items.length + data.unlisted_business_items.length + data.unlisted_hybrid_items.length + data.unlisted_unclassified_items.length;
}

/** Full get_inventory_analysis tool implementation: load the canonical dataset, filter, wrap with metadata. */
export async function getInventoryAnalysisForUser(client: SupabaseClient, filters: InventoryAnalysisFilters): Promise<InventoryAnalysisResult> {
  const canonical = await getCanonicalInventoryAnalysis(client);
  const data = applyInventoryAnalysisFilters(canonical, filters);
  return {
    generated_at: canonical.generated_at,
    filters_applied: filters,
    item_count: countItems(data),
    data,
  };
}

export { ListingEvidenceError };
