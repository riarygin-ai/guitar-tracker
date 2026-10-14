// Server-callable lead activity by item — the read-only MCP
// `get_lead_activity` tool's data source. Reuses the EXACT dataset the
// /listings "Lead Activity by Item" section and its /leads drill-down
// already use: listing_demand_item_activity_v1_0 (migration
// 20260919000000) — compact per-item buyer activity for the caller's
// CURRENTLY LISTED items over a period. This module does not recompute
// attribution, lead quality, or offer logic itself; it only calls the
// self-scoped RPC wrapper and applies optional, non-mutating filtering on
// the rows it returns (the same discipline as inventoryAnalysisService.ts).
//
// Scope note (existing semantics, preserved — not invented here): item
// attribution REQUIRES listing exposure on the lead's contact date, so an
// unlisted item can never have attributed leads by construction — this
// dataset has only ever covered currently-listed items, on /listings and
// here alike.
//
// Identity: listing_demand_item_activity_v1_0_for_current_user (migration
// 20261013000000) resolves the caller entirely from auth.uid()/
// get_app_user_id() — no user id parameter exists to misuse.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ListingItemActivityError, type ItemActivityEntry } from './listingItemActivity';

export class LeadActivityServiceError extends Error {}

/** Same default cadence the app itself already uses for "the current period" (Listing Demand Evidence's own DEFAULT_TREND_WEEKS). Not a new convention. */
const DEFAULT_WINDOW_DAYS = 28;
const MAX_WINDOW_DAYS = 400; // same cap /api/listing-item-activity already enforces

export interface LeadActivityFilters {
  /** Restrict to these inventory item ids. */
  item_ids?: number[];
  /** Exact, case-insensitive match against a channel the item is currently listed on (active_channels[].channel_name). */
  channel?: string[];
  /** YYYY-MM-DD, inclusive. Defaults to 28 days before to_date (the app's own current-period default). */
  from_date?: string;
  /** YYYY-MM-DD, inclusive. Defaults to today (local calendar date). */
  to_date?: string;
}

export interface LeadActivityResult {
  generated_at: string;
  start_date: string;
  end_date: string;
  filters_applied: LeadActivityFilters;
  item_count: number;
  items: ItemActivityEntry[];
}

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolves the requested/default [start_date, end_date], same validation as /api/listing-item-activity. */
function resolveWindow(filters: LeadActivityFilters): { startDate: string; endDate: string } {
  const today = new Date();
  const endDate = filters.to_date ?? toDateOnly(today);
  if (!DATE_RE.test(endDate)) throw new LeadActivityServiceError('to_date must be YYYY-MM-DD');

  let startDate: string;
  if (filters.from_date) {
    startDate = filters.from_date;
    if (!DATE_RE.test(startDate)) throw new LeadActivityServiceError('from_date must be YYYY-MM-DD');
  } else {
    const end = new Date(`${endDate}T00:00:00`);
    const start = new Date(end);
    start.setDate(start.getDate() - (DEFAULT_WINDOW_DAYS - 1));
    startDate = toDateOnly(start);
  }

  if (startDate > endDate) throw new LeadActivityServiceError('from_date must be on or before to_date');
  const spanDays = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
  if (spanDays > MAX_WINDOW_DAYS) throw new LeadActivityServiceError(`window must be at most ${MAX_WINDOW_DAYS} days`);

  return { startDate, endDate };
}

function norm(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean));
}

/** Pure, non-mutating filter over an already-fetched canonical rows array. */
export function applyLeadActivityFilters(items: ItemActivityEntry[], filters: LeadActivityFilters): ItemActivityEntry[] {
  const itemIds = filters.item_ids && filters.item_ids.length > 0 ? new Set(filters.item_ids) : null;
  const channels = norm(filters.channel);

  return items.filter((item) =>
    (itemIds === null || itemIds.has(item.item_id)) &&
    (channels === null || item.active_channels.some((c) => channels.has(c.channel_name.toLowerCase()))),
  );
}

/** Loads the canonical rows through the caller's own authenticated/RLS-scoped client — never service_role. */
async function loadCanonicalItemActivity(client: SupabaseClient, startDate: string, endDate: string): Promise<ItemActivityEntry[]> {
  const { data, error } = await client.rpc('listing_demand_item_activity_v1_0_for_current_user', {
    p_period_start: startDate,
    p_period_end: endDate,
  });
  if (error) throw new LeadActivityServiceError(`item activity: ${error.message}`);

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    item_id: Number(r.item_id),
    item_display_name: String(r.item_display_name ?? ''),
    active_channels: Array.isArray(r.active_channels) ? (r.active_channels as ItemActivityEntry['active_channels']) : [],
    item_attributed_leads: Number(r.item_attributed_leads),
    serious_plus_attributed_leads: Number(r.serious_plus_attributed_leads),
    offer_attributed_leads: Number(r.offer_attributed_leads),
    item_listing_days: Number(r.item_listing_days),
    channel_listing_days: Number(r.channel_listing_days),
    last_attributed_lead_date: (r.last_attributed_lead_date as string | null) ?? null,
  }));
}

/** Full get_lead_activity tool implementation: resolve window, load canonical rows, filter, wrap with metadata. */
export async function getLeadActivityForUser(client: SupabaseClient, filters: LeadActivityFilters): Promise<LeadActivityResult> {
  const { startDate, endDate } = resolveWindow(filters);
  const canonical = await loadCanonicalItemActivity(client, startDate, endDate);
  const items = applyLeadActivityFilters(canonical, filters);
  return {
    generated_at: new Date().toISOString(),
    start_date: startDate,
    end_date: endDate,
    filters_applied: filters,
    item_count: items.length,
    items,
  };
}

export { ListingItemActivityError };
export type { ItemActivityEntry };
