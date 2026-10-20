// Server-callable contact history — the data behind the read-only MCP
// find_contact_history tool: "has this person contacted me before, on this
// item or any other, and what happened?"
//
// Source: item_leads.contact_name (migration 20261019000000, optional Lead
// Log column T), read through the caller's RLS-scoped client ("item_leads:
// select own"). No time window. Leads on sold/traded/closed items are
// included — item_leads rows are never removed when an item leaves
// inventory. Matching rules live in src/lib/leads/contactName.ts; channel
// labels and offer summaries reuse the /leads formatters.
//
// Identity: no user id anywhere. item_id is CONTEXT only (marks same-item
// rows); it never narrows the search and is never looked up, so a foreign
// item id simply marks nothing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_COLUMNS } from '../leads/leadsServer';
import { leadChannelLabel, formatOfferSummary, QUALITY_LABEL, STATUS_LABEL } from '../leads/leadFormat';
import { LEAD_QUALITIES, type LeadRow } from '../leads/leadTypes';
import { normalizeContactName, possibleNameMatch, type PossibleMatchReason } from '../leads/contactName';

export class ContactHistoryServiceError extends Error {}

export interface ContactHistoryQuery {
  contact_name: string;
  channel?: string;
  item_id?: number;
  include_possible_matches?: boolean;
}

export interface ContactLeadItem {
  item_id: number;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  status: string | null;
}

export interface ContactLeadRecord {
  lead_id: number;
  item: ContactLeadItem;
  same_item: boolean;
  channel: string;
  contact_name: string;
  first_contact_at: string | null;
  last_contact_at: string | null;
  quality: string;
  status: string;
  outcome_reason: string | null;
  offer_type: string;
  offer_summary: string;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  cash_component: number | null;
  trade_item: string | null;
  trade_est_value: number | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  notes: string | null;
  linked_deal_id: number | null;
}

export interface ContactHistoryResult {
  query: {
    contact_name: string;
    normalized_contact_name: string;
    channel: string | null;
    item_id: number | null;
    include_possible_matches: boolean;
  };
  summary: {
    exact_match_count: number;
    historical_lead_count: number;
    possible_match_count: number;
    other_channel_match_count: number;
    linked_deal_count: number;
    linked_deal_ids: number[];
    same_item_match_count: number;
    distinct_item_count: number;
    first_contact: string | null;
    last_contact: string | null;
    highest_quality: string | null;
    by_status: Record<string, number>;
  };
  coverage: {
    /** Leads with a recorded contact_name (searchable). */
    leads_with_contact_name: number;
    /** Leads without one (imported before the column existed, or left blank) — invisible to this search. */
    leads_without_contact_name: number;
  };
  semantics: string[];
  /** Same normalized name (and, when channel was given, same channel). Ordered newest first. */
  exact_matches: ContactLeadRecord[];
  /** channel was given: same normalized name on a DIFFERENT channel — not assumed to be the same person. */
  other_channel_matches: ContactLeadRecord[];
  /** Conservative name-pattern matches, never counted as confirmed history. */
  possible_matches: (ContactLeadRecord & { match_reason: PossibleMatchReason; match_score: number; same_channel: boolean | null })[];
}

const SEMANTICS = [
  'Names are compared after normalization: case, repeated whitespace, periods/commas, apostrophe variants and accents are ignored. Nothing else.',
  'A name is not an identity. exact_matches share the normalized name (and the channel, when one was given); summary counts use exact_matches only.',
  'other_channel_matches share the name but were recorded on another channel and are NOT assumed to be the same person.',
  'possible_matches follow a few explicit patterns (last-name initial, first-name prefix, extra middle name/suffix, first-name-only query) and carry match_reason/match_score; treat them as leads to verify, not history.',
  'No time window: full history, including leads on sold/traded items. Leads without a recorded contact_name cannot be found (see coverage).',
  'linked_deal_id is the completed Sell/Trade this lead was linked to; use get_operation_context(deal_id) for details.',
];

const PAGE = 1000;
const ID_CHUNK = 150;
const QUALITY_RANK = Object.fromEntries(LEAD_QUALITIES.map((q, i) => [q, i])) as Record<string, number>;

type LoadedLead = Omit<LeadRow, 'item_name' | 'contact_name'> & { contact_name: string };

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

async function loadNamedLeads(client: SupabaseClient): Promise<{ leads: LoadedLead[]; withoutName: number }> {
  const raw: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.from('item_leads').select(LEAD_COLUMNS)
      .not('contact_name', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new ContactHistoryServiceError(`item_leads: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    raw.push(...page);
    if (page.length < PAGE) break;
  }
  const { count, error: countError } = await client.from('item_leads').select('id', { count: 'exact', head: true }).is('contact_name', null);
  if (countError) throw new ContactHistoryServiceError(`item_leads count: ${countError.message}`);

  const { data: channelRows, error: chErr } = await client.from('deal_channels').select('id, name');
  if (chErr) throw new ContactHistoryServiceError(`deal_channels: ${chErr.message}`);
  const channelNames = new Map<number, string>((channelRows ?? []).map((c) => [c.id as number, c.name as string]));

  return {
    leads: raw.map((r) => ({
      ...(r as unknown as LoadedLead),
      initial_cash_offer: num(r.initial_cash_offer),
      best_cash_offer: num(r.best_cash_offer),
      cash_component: num(r.cash_component),
      trade_est_value: num(r.trade_est_value),
      channel_name: r.deal_channel_id != null ? channelNames.get(r.deal_channel_id as number) ?? null : null,
    })),
    withoutName: count ?? 0,
  };
}

async function loadItems(client: SupabaseClient, itemIds: number[]): Promise<Map<number, ContactLeadItem>> {
  const out = new Map<number, ContactLeadItem>();
  if (itemIds.length === 0) return out;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const { data, error } = await client.from('inventory_items').select('id, brand_id, model, year, color, status').in('id', itemIds.slice(i, i + ID_CHUNK));
    if (error) throw new ContactHistoryServiceError(`inventory_items: ${error.message}`);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  const { data: brands, error: bErr } = await client.from('brands').select('id, name');
  if (bErr) throw new ContactHistoryServiceError(`brands: ${bErr.message}`);
  const brandNames = new Map<number, string>((brands ?? []).map((b) => [b.id as number, b.name as string]));
  for (const r of rows) {
    out.set(Number(r.id), {
      item_id: Number(r.id),
      brand: r.brand_id != null ? brandNames.get(Number(r.brand_id)) ?? null : null,
      model: (r.model as string | null) ?? null,
      year: num(r.year),
      color: (r.color as string | null) ?? null,
      status: (r.status as string | null) ?? null,
    });
  }
  return out;
}

const newestFirst = (a: ContactLeadRecord, b: ContactLeadRecord) =>
  (b.last_contact_at ?? b.first_contact_at ?? '').localeCompare(a.last_contact_at ?? a.first_contact_at ?? '') || b.lead_id - a.lead_id;

/** Pure classification over already-loaded leads (exported for tests). */
export function classifyContactLeads(
  leads: LoadedLead[],
  query: ContactHistoryQuery,
): { exact: LoadedLead[]; otherChannel: LoadedLead[]; possible: { lead: LoadedLead; reason: PossibleMatchReason; score: number; sameChannel: boolean | null }[] } {
  const wanted = normalizeContactName(query.contact_name);
  const channel = query.channel?.trim().toLowerCase() || null;
  const includePossible = query.include_possible_matches !== false;
  const exact: LoadedLead[] = [];
  const otherChannel: LoadedLead[] = [];
  const possible: { lead: LoadedLead; reason: PossibleMatchReason; score: number; sameChannel: boolean | null }[] = [];
  for (const lead of leads) {
    const stored = normalizeContactName(lead.contact_name);
    const sameChannel = channel === null ? null : leadChannelLabel(lead).toLowerCase() === channel;
    if (stored === wanted) {
      if (sameChannel === false) otherChannel.push(lead); else exact.push(lead);
    } else if (includePossible) {
      const m = possibleNameMatch(wanted, stored);
      if (m) possible.push({ lead, reason: m.reason, score: m.score, sameChannel });
    }
  }
  return { exact, otherChannel, possible };
}

export async function findContactHistoryForUser(client: SupabaseClient, query: ContactHistoryQuery): Promise<ContactHistoryResult> {
  const normalized = normalizeContactName(query.contact_name ?? '');
  if (!normalized) throw new ContactHistoryServiceError('contact_name must contain at least one letter or digit');

  const { leads, withoutName } = await loadNamedLeads(client);
  const { exact, otherChannel, possible } = classifyContactLeads(leads, query);

  const allMatched = [...exact, ...otherChannel, ...possible.map((p) => p.lead)];
  const items = await loadItems(client, Array.from(new Set(allMatched.map((l) => l.inventory_item_id))));

  const toRecord = (l: LoadedLead): ContactLeadRecord => ({
    lead_id: l.id,
    item: items.get(l.inventory_item_id) ?? { item_id: l.inventory_item_id, brand: null, model: null, year: null, color: null, status: null },
    same_item: query.item_id != null && l.inventory_item_id === query.item_id,
    channel: leadChannelLabel(l),
    contact_name: l.contact_name,
    first_contact_at: l.first_contact_at,
    last_contact_at: l.last_contact_at,
    quality: QUALITY_LABEL[l.lead_quality] ?? l.lead_quality,
    status: STATUS_LABEL[l.status] ?? l.status,
    outcome_reason: l.outcome_reason,
    offer_type: l.offer_type,
    offer_summary: formatOfferSummary(l),
    initial_cash_offer: l.initial_cash_offer,
    best_cash_offer: l.best_cash_offer,
    cash_component: l.cash_component,
    trade_item: l.trade_item,
    trade_est_value: l.trade_est_value,
    buyer_message_count: l.buyer_message_count,
    our_message_count: l.our_message_count,
    notes: l.notes,
    linked_deal_id: l.deal_id,
  });

  const exactRecords = exact.map(toRecord).sort(newestFirst);
  const dates = exact.flatMap((l) => [l.first_contact_at, l.last_contact_at]).filter((d): d is string => !!d).sort();
  const top = exact.reduce<string | null>((best, l) => (best === null || QUALITY_RANK[l.lead_quality] > QUALITY_RANK[best] ? l.lead_quality : best), null);
  const dealIds = Array.from(new Set(exact.map((l) => l.deal_id).filter((v): v is number => v != null))).sort((a, b) => a - b);
  const byStatus: Record<string, number> = {};
  for (const r of exactRecords) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  return {
    query: {
      contact_name: query.contact_name,
      normalized_contact_name: normalized,
      channel: query.channel?.trim() || null,
      item_id: query.item_id ?? null,
      include_possible_matches: query.include_possible_matches !== false,
    },
    summary: {
      exact_match_count: exactRecords.length,
      historical_lead_count: exactRecords.length,
      possible_match_count: possible.length,
      other_channel_match_count: otherChannel.length,
      linked_deal_count: dealIds.length,
      linked_deal_ids: dealIds,
      same_item_match_count: exactRecords.filter((r) => r.same_item).length,
      distinct_item_count: new Set(exact.map((l) => l.inventory_item_id)).size,
      first_contact: dates[0] ?? null,
      last_contact: dates[dates.length - 1] ?? null,
      highest_quality: top ? QUALITY_LABEL[top as keyof typeof QUALITY_LABEL] : null,
      by_status: byStatus,
    },
    coverage: { leads_with_contact_name: leads.length, leads_without_contact_name: withoutName },
    semantics: SEMANTICS,
    exact_matches: exactRecords,
    other_channel_matches: otherChannel.map(toRecord).sort(newestFirst),
    possible_matches: possible
      .map((p) => ({ ...toRecord(p.lead), match_reason: p.reason, match_score: p.score, same_channel: p.sameChannel }))
      .sort((a, b) => b.match_score - a.match_score || newestFirst(a, b)),
  };
}
