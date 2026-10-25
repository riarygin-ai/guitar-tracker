// Server-only. /listings "Lead Activity by Item": lifetime lead activity for
// OPEN inventory items that actually have leads, listed or not.
//
// Replaces the Trend-Window, currently-listed, listing-exposure-attributed
// view (listing_demand_item_activity_v1_0), which dropped an item the moment
// its listing cycles ended and only counted leads whose FIRST contact fell
// during tracked exposure — so an unlisted item with an ongoing negotiation
// vanished. That RPC stays for Listing Demand Evidence / MCP.
//
// Sources (no new attribution logic, no new SQL):
//   - Items: build_listing_evidence_v1_0_for_current_user — the same open-
//     inventory set get_inventory_analysis / get_lead_activity use (listed
//     items + unlisted business / hybrid / unclassified; personal unlisted
//     items are excluded there as not-for-sale).
//   - Leads: item_leads by inventory_item_id through the caller's RLS client
//     (leadActivityService.loadLeadsForItems — chunked, never per item).
//   - Channel Days: analytics_item_lifecycle.total_listed_days — real listed
//     days summed over every cycle on every channel (lifetime, matching the
//     lifetime lead counts); one chunked query.
// Vocabulary: Negotiating+ = isNegotiatingPlus (peak_stage NEGOTIATING /
// HIGH_INTENT / CONVERTED; legacy quality only while a row has no peak
// stage); offer = offer_type <> 'NONE'.
// Last Activity = the latest real contact on any of the item's leads: max of
// last_contact_at, the Toronto calendar dates of last_inbound_at /
// last_outbound_at (maintained from MESSAGE / OFFER events by the lead write
// layer), and first_contact_at as the floor. System events (auto-close,
// audit notes, deal links) are not contact and never move it.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidListingEvidence } from './listingEvidence';
import { isNegotiatingPlus, loadLeadsForItems, type LoadedLead } from './leadActivityService';
import { calendarDateIn } from '../dateUtils';

export interface ItemLeadActivityRow {
  item_id: number;
  item_display_name: string;
  brand_name: string | null;
  /** Currently listed on at least one channel. */
  is_listed: boolean;
  active_channel_names: string[];
  lead_count: number;
  negotiating_plus_count: number;
  offer_count: number;
  open_lead_count: number;
  agreed_lead_count: number;
  /** Lifetime real listed days across every channel and cycle (null when the item was never listed). */
  channel_days: number | null;
  /** YYYY-MM-DD — latest real contact on any lead of the item. */
  last_activity_date: string | null;
  /** YYYY-MM-DD — newest first contact (newest lead). */
  last_new_lead_date: string | null;
}

export class ItemLeadActivityError extends Error {}

const ID_CHUNK = 150;

/** Latest real contact date of one lead (Toronto calendar dates; never a system event). */
export function leadLastActivityDate(l: Pick<LoadedLead, 'last_contact_at' | 'first_contact_at' | 'last_inbound_at' | 'last_outbound_at'>): string | null {
  const dates = [
    l.last_contact_at,
    l.first_contact_at,
    l.last_inbound_at ? calendarDateIn(new Date(l.last_inbound_at)) : null,
    l.last_outbound_at ? calendarDateIn(new Date(l.last_outbound_at)) : null,
  ].filter((d): d is string => !!d).map((d) => d.slice(0, 10));
  return dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
}

interface OpenItem { item_id: number; item_display_name: string; brand_name: string | null; is_listed: boolean; active_channel_names: string[] }

/** Pure aggregation: one row per item with at least one lead (zero-lead items are dropped). */
export function aggregateItemLeadActivity(items: OpenItem[], leads: LoadedLead[], channelDays: Map<number, number | null>): ItemLeadActivityRow[] {
  const byItem = new Map<number, LoadedLead[]>();
  for (const l of leads) (byItem.get(l.inventory_item_id) ?? byItem.set(l.inventory_item_id, []).get(l.inventory_item_id)!).push(l);
  const rows: ItemLeadActivityRow[] = [];
  for (const it of items) {
    const ls = byItem.get(it.item_id) ?? [];
    if (ls.length === 0) continue;
    let last: string | null = null;
    let newest: string | null = null;
    for (const l of ls) {
      const a = leadLastActivityDate(l);
      if (a && (last == null || a > last)) last = a;
      if (l.first_contact_at && (newest == null || l.first_contact_at > newest)) newest = l.first_contact_at;
    }
    rows.push({
      ...it,
      lead_count: ls.length,
      negotiating_plus_count: ls.filter(isNegotiatingPlus).length,
      offer_count: ls.filter((l) => l.offer_type !== 'NONE').length,
      open_lead_count: ls.filter((l) => l.status === 'OPEN').length,
      agreed_lead_count: ls.filter((l) => l.status === 'AGREED').length,
      channel_days: channelDays.get(it.item_id) ?? null,
      last_activity_date: last,
      last_new_lead_date: newest,
    });
  }
  return rows;
}

async function loadOpenItems(client: SupabaseClient): Promise<OpenItem[]> {
  const { data, error } = await client.rpc('build_listing_evidence_v1_0_for_current_user');
  if (error) throw new ItemLeadActivityError(`listing evidence: ${error.message}`);
  if (!isValidListingEvidence(data)) throw new ItemLeadActivityError('listing evidence: unexpected shape');
  const seen = new Map<number, OpenItem>();
  for (const i of data.listed_items) {
    seen.set(i.item_id, { item_id: i.item_id, item_display_name: i.item_display_name, brand_name: i.brand_name, is_listed: true, active_channel_names: Array.from(new Set(i.active_listings.map((a) => a.channel_name))) });
  }
  const u = data.unlisted_open_inventory;
  for (const i of [...u.business, ...u.hybrid, ...u.unclassified]) {
    if (!seen.has(i.item_id)) seen.set(i.item_id, { item_id: i.item_id, item_display_name: i.item_display_name, brand_name: i.brand_name, is_listed: false, active_channel_names: [] });
  }
  return Array.from(seen.values());
}

async function loadChannelDays(client: SupabaseClient, itemIds: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const { data, error } = await client.from('analytics_item_lifecycle').select('item_id, total_listed_days').in('item_id', itemIds.slice(i, i + ID_CHUNK));
    if (error) throw new ItemLeadActivityError(`analytics_item_lifecycle: ${error.message}`);
    for (const r of data ?? []) out.set(Number(r.item_id), r.total_listed_days == null ? null : Number(r.total_listed_days));
  }
  return out;
}

/** Every open item with >= 1 lead, for the caller (RLS client). Unsorted; the UI sorts / searches. */
export async function getItemLeadActivityForUser(client: SupabaseClient): Promise<ItemLeadActivityRow[]> {
  const items = await loadOpenItems(client);
  if (items.length === 0) return [];
  let leads: LoadedLead[];
  try {
    leads = await loadLeadsForItems(client, items.map((i) => i.item_id));
  } catch (e) {
    throw new ItemLeadActivityError(e instanceof Error ? e.message : String(e));
  }
  const withLeads = Array.from(new Set(leads.map((l) => l.inventory_item_id)));
  const channelDays = withLeads.length ? await loadChannelDays(client, withLeads) : new Map<number, number | null>();
  return aggregateItemLeadActivity(items, leads, channelDays);
}
