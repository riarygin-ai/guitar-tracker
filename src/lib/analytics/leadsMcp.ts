// Server-only. MCP `get_leads` — the caller's raw lead rows across their
// COMPLETE history (owned / listed / sold / traded items alike), filtered and
// paginated, with a summary of the whole filtered set.
//
// Every row uses the same snapshot serializer as get_item_context
// (itemContextMcp.leadSnapshotView): stage, status, offers, responsiveness,
// needs_resolution are never re-derived here. Plus compact item identity, the
// contact-name provenance, last_activity_date, and — only with
// include_notes — the COMPLETE legacy notes. No lead_events (use
// get_item_context with lead_id + full_history).
//
// Ordering (deterministic): last_activity_date DESC (the latest real contact
// on the lead — itemLeadActivity.leadLastActivityDate: last contact, Toronto
// dates of last inbound/outbound, first contact as floor; system/backfill
// events never move it), undated last, then lead id DESC.
//
// Queries (fixed, never per lead): item_leads (paged at 1000), deal_channels,
// inventory_items_search (chunked ids), item_subtypes -> categories, and the
// page's notes when requested. Identity: caller's RLS client only; a foreign
// item id simply matches nothing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { leadSnapshotView, type LeadSnapshotView } from './itemContextMcp';
import { leadLastActivityDate } from './itemLeadActivity';
import { LEAD_SNAPSHOT_COLUMNS, type LeadSnapshotRow } from '../leads/leadWriteService';
import type { LeadStage, LeadStatusValue } from '../leads/semantics';

export const GET_LEADS_DEFAULT_LIMIT = 200;
export const GET_LEADS_MAX_LIMIT = 500;
export const GET_LEADS_MAX_ITEM_IDS = 500;
const PAGE = 1000;
const ID_CHUNK = 150;

export interface GetLeadsArgs {
  item_ids?: number[];
  status?: LeadStatusValue[];
  peak_stage?: LeadStage[];
  channel?: string[];
  contact_name?: 'all' | 'present' | 'missing';
  origin?: ('SHEET' | 'DIRECT')[];
  include_notes?: boolean;
  limit?: number;
  offset?: number;
}

export interface GetLeadsItem {
  item_id: number;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  status: string | null;
  category: string | null;
  type: string | null;
  purpose: string | null;
}

export type GetLeadsRow = LeadSnapshotView & {
  contact_name_source: string | null;
  last_activity_date: string | null;
  item: GetLeadsItem;
  legacy_notes?: string | null;
};

export interface GetLeadsResult {
  summary: {
    total_matches: number;
    returned: number;
    offset: number;
    limit: number;
    has_more: boolean;
    next_offset: number | null;
    missing_contact_names: number;
    by_status: Record<string, number>;
    by_peak_stage: Record<string, number>;
    by_channel: Record<string, number>;
  };
  filters_applied: GetLeadsArgs;
  ordering: string;
  leads: GetLeadsRow[];
}

export class GetLeadsError extends Error {}

// Every snapshot column except the (potentially long) notes, which are loaded only for the returned page.
const ROW_COLUMNS = LEAD_SNAPSHOT_COLUMNS.split(',').map((c) => c.trim()).filter((c) => c && c !== 'notes').join(', ') + ', contact_name_source';

type Row = LeadSnapshotRow & { contact_name_source: string | null };

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** Deterministic order: latest real contact first (undated last), then lead id DESC. */
export function compareLeadsForListing(a: { id: number; last_activity_date: string | null }, b: { id: number; last_activity_date: string | null }): number {
  if (a.last_activity_date !== b.last_activity_date) {
    if (a.last_activity_date == null) return 1;
    if (b.last_activity_date == null) return -1;
    return a.last_activity_date < b.last_activity_date ? 1 : -1;
  }
  return b.id - a.id;
}

export async function getLeadsForUser(client: SupabaseClient, args: GetLeadsArgs = {}, now: Date = new Date()): Promise<GetLeadsResult> {
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? GET_LEADS_DEFAULT_LIMIT), 1), GET_LEADS_MAX_LIMIT);
  const offset = Math.max(Math.trunc(args.offset ?? 0), 0);
  const contactFilter = args.contact_name ?? 'all';

  // 1. Matching leads (simple filters in SQL; channel after label resolution below).
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = client.from('item_leads').select(ROW_COLUMNS).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (args.item_ids?.length) q = q.in('inventory_item_id', args.item_ids);
    if (args.status?.length) q = q.in('status', args.status);
    if (args.peak_stage?.length) q = q.in('peak_stage', args.peak_stage);
    if (args.origin?.length) q = q.in('origin', args.origin);
    if (contactFilter === 'missing') q = q.is('contact_name', null);
    if (contactFilter === 'present') q = q.not('contact_name', 'is', null);
    const { data, error } = await q;
    if (error) throw new GetLeadsError(`item_leads: ${error.message}`);
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  // 2. Channel names (same label rule as get_item_context).
  const { data: channelRows, error: chErr } = await client.from('deal_channels').select('id, name');
  if (chErr) throw new GetLeadsError(`deal_channels: ${chErr.message}`);
  const channelNames = new Map<number, string>((channelRows ?? []).map((c) => [c.id as number, c.name as string]));
  const channelOf = (r: Row) => (r.deal_channel_id != null ? channelNames.get(r.deal_channel_id) : null) ?? r.source_channel ?? 'Unknown';
  const wanted = args.channel?.length ? new Set(args.channel.map((c) => c.trim().toLowerCase())) : null;
  const matched = wanted ? rows.filter((r) => wanted.has(channelOf(r).toLowerCase())) : rows;

  // 3. Item identity for every matched lead's item (status also drives needs_resolution).
  const itemIds = Array.from(new Set(matched.map((r) => r.inventory_item_id)));
  const items = new Map<number, { brand_name: string | null; model: string | null; year: number | null; color: string | null; status: string | null; item_subtype_id: number | null; item_subtype_name: string | null; purpose_name: string | null }>();
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const { data, error } = await client.from('inventory_items_search')
      .select('id, brand_name, model, year, color, status, item_subtype_id, item_subtype_name, purpose_name').in('id', itemIds.slice(i, i + ID_CHUNK));
    if (error) throw new GetLeadsError(`inventory_items_search: ${error.message}`);
    for (const it of data ?? []) items.set(Number(it.id), it as never);
  }
  // 4. Categories for those items' types (one bounded lookup).
  const subtypeIds = Array.from(new Set(Array.from(items.values()).map((i) => i.item_subtype_id).filter((v): v is number => v != null)));
  const categoryBySubtype = new Map<number, string>();
  if (subtypeIds.length) {
    const { data, error } = await client.from('item_subtypes').select('id, item_categories(name)').in('id', subtypeIds);
    if (error) throw new GetLeadsError(`item_subtypes: ${error.message}`);
    for (const s of (data ?? []) as unknown as { id: number; item_categories: { name: string } | { name: string }[] | null }[]) {
      const cat = Array.isArray(s.item_categories) ? s.item_categories[0] : s.item_categories;
      if (cat?.name) categoryBySubtype.set(s.id, cat.name);
    }
  }

  // Summary over the FULL filtered set; then order + page.
  const summary = { by_status: {} as Record<string, number>, by_peak_stage: {} as Record<string, number>, by_channel: {} as Record<string, number>, missing: 0 };
  const ordered = matched.map((r) => ({ r, id: r.id, last_activity_date: leadLastActivityDate(r) }));
  for (const { r } of ordered) {
    bump(summary.by_status, r.status);
    bump(summary.by_peak_stage, r.peak_stage ?? 'UNSET');
    bump(summary.by_channel, channelOf(r));
    if (r.contact_name == null) summary.missing++;
  }
  ordered.sort(compareLeadsForListing);
  const page = ordered.slice(offset, offset + limit);

  // 5. Complete notes for the returned page only.
  const notes = new Map<number, string | null>();
  if (args.include_notes && page.length) {
    const ids = page.map((p) => p.id);
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await client.from('item_leads').select('id, notes').in('id', ids.slice(i, i + ID_CHUNK));
      if (error) throw new GetLeadsError(`item_leads (notes): ${error.message}`);
      for (const n of data ?? []) notes.set(Number(n.id), (n.notes as string | null) ?? null);
    }
  }

  const leads: GetLeadsRow[] = page.map(({ r, last_activity_date }) => {
    const it = items.get(r.inventory_item_id);
    const itemStatus = it?.status ?? null;
    return {
      ...leadSnapshotView(r, { channelNames, itemUnavailable: itemStatus === 'sold' || itemStatus === 'traded', now }),
      contact_name_source: r.contact_name_source,
      last_activity_date,
      item: {
        item_id: r.inventory_item_id, brand: it?.brand_name ?? null, model: it?.model ?? null, year: it?.year ?? null, color: it?.color ?? null,
        status: itemStatus, category: it?.item_subtype_id != null ? categoryBySubtype.get(it.item_subtype_id) ?? null : null,
        type: it?.item_subtype_name ?? null, purpose: it?.purpose_name ?? null,
      },
      ...(args.include_notes ? { legacy_notes: notes.get(r.id) ?? null } : {}),
    };
  });

  const hasMore = offset + leads.length < ordered.length;
  return {
    summary: {
      total_matches: ordered.length, returned: leads.length, offset, limit, has_more: hasMore, next_offset: hasMore ? offset + leads.length : null,
      missing_contact_names: summary.missing, by_status: summary.by_status, by_peak_stage: summary.by_peak_stage, by_channel: summary.by_channel,
    },
    filters_applied: { ...args, contact_name: contactFilter, include_notes: args.include_notes === true, limit, offset },
    ordering: 'last_activity_date DESC (latest real contact; undated last), then lead_id DESC',
    leads,
  };
}
