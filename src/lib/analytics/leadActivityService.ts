// Server-callable lead activity by item — the read-only MCP
// `get_lead_activity` tool's data source.
//
// Three layers per item (2026-10-14 redesign — the previous version only
// exposed a 28-day exposure-attributed aggregate for CURRENTLY LISTED
// items, so an item that was historically strong but currently quiet, or
// currently unlisted, looked weak or vanished entirely):
//   1. current_period   — individual lead records for the newest bucket
//   2. periods          — calendar week/month aggregates (trend)
//   3. lifetime         — all-history summary, independent of the window
//
// Data sources (no new attribution logic, no new SQL):
//   - Item set: build_listing_evidence_v1_0_for_current_user — the SAME
//     open-inventory set get_inventory_analysis returns (listed items +
//     itemized unlisted business/hybrid/unclassified items), with the same
//     item_display_name, so the two tools join 1:1 on item_id.
//   - Leads: item_leads rows read directly through the caller's RLS-scoped
//     client ("item_leads: select own"), keyed by their own
//     inventory_item_id foreign key — the same per-item lead link
//     get_item_context and the /leads screen use. This is deliberately NOT
//     the listing-exposure attribution (_lead_item_attributed_v1_0) behind
//     /listings' "Lead Activity by Item": that rule only counts leads whose
//     first contact fell on a day with tracked listing exposure, which is a
//     listing-performance metric, not an item's demand history.
//   - Vocabulary: Serious+ = SERIOUS_PLUS_QUALITIES (leadTypes.ts, same set
//     Listing Demand Evidence uses); offer = offer_type <> 'NONE' (same
//     rule as listing_demand_item_activity_v1_0 and itemContext.ts);
//     channel label = leadChannelLabel (/leads' own rule); offer_summary =
//     formatOfferSummary (/leads' own deterministic formatter).
//
// Identity: no user id anywhere. Every read goes through the caller's own
// authenticated client; RLS is the isolation boundary.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidListingEvidence } from './listingEvidence';
import { torontoLocalDate } from './automation/torontoSchedule';
import {
  resolveLeadActivityPeriods,
  LeadActivityPeriodError,
  type CalendarPeriod,
  type LeadActivityBucket,
  type ResolvedPeriods,
} from './leadActivityPeriods';
import { LEAD_COLUMNS } from '../leads/leadsServer';
import { leadChannelLabel, formatOfferSummary } from '../leads/leadFormat';
import { SERIOUS_PLUS_QUALITIES, type LeadRow, type LeadQuality } from '../leads/leadTypes';
import { HIGH_INTENT_PLUS_STAGES, LEAD_STAGES, NEGOTIATING_PLUS_STAGES, type LeadStage } from '../leads/semantics';

export class LeadActivityServiceError extends Error {}

export interface LeadActivityFilters {
  /** "week" (Mon-Sun, default) or "month" (calendar month). */
  bucket?: LeadActivityBucket;
  /** Rolling mode only: COMPLETE calendar periods before the current one. Default 4. */
  periods?: number;
  /** YYYY-MM-DD. Switches to explicit-range mode. */
  from_date?: string;
  /** YYYY-MM-DD, defaults to today in explicit mode; requires from_date. */
  to_date?: string;
  /** Restrict to these inventory item ids (within the open-inventory set). */
  item_ids?: number[];
  /** Lead-level: only count leads whose channel (canonical deal channel, else raw source channel) matches, case-insensitive. */
  channel?: string[];
}

/** One stored item_leads row as exposed to the AI. Every field is stored data or a deterministic formatting of it. */
export interface LeadActivityLeadDetail {
  lead_id: number;
  first_contact_at: string | null;
  last_contact_at: string | null;
  channel: string;
  contact_name: string | null;
  channel_detail: string | null;
  /** Highest observable stage reached (INQUIRY..CONVERTED); null only for a not-yet-backfilled legacy row. */
  peak_stage: LeadStage | null;
  peak_stage_source: string | null;
  negotiation_rounds: number;
  waiting_on: LeadRow['waiting_on'];
  unanswered_followups: number;
  reopen_count: number;
  offer_assessment: string | null;
  latest_cash_offer: number | null;
  /** LEGACY Lead Log quality (null for direct-write leads). Kept for one release. */
  quality: LeadQuality | null;
  status: LeadRow['status'];
  outcome_reason: string | null;
  offer_type: LeadRow['offer_type'];
  offer_summary: string;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  cash_component: number | null;
  trade_item: string | null;
  trade_est_value: number | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  notes: string | null;
  deal_id: number | null;
}

export interface LeadCounts {
  lead_count: number;
  offer_count: number;
  /** Peak-stage counts (UNSET = legacy row not yet backfilled). */
  stage_counts: Record<LeadStage | 'UNSET', number>;
  /** NEGOTIATING + HIGH_INTENT + CONVERTED — the replacement for legacy serious_plus. */
  negotiating_plus_count: number;
  /** HIGH_INTENT + CONVERTED. */
  high_intent_plus_count: number;
  /** LEGACY (one release) from here: counts by legacy lead_quality. */
  serious_plus_count: number;
  high_intent_count: number;
  serious_count: number;
  engaged_count: number;
  low_count: number;
  by_channel: Record<string, number>;
}

export type LeadPeriodBucket = CalendarPeriod & LeadCounts;

export interface LeadLifetimeSummary extends LeadCounts {
  first_lead_date: string | null;
  last_lead_date: string | null;
  last_serious_plus_lead_date: string | null;
  last_negotiating_plus_lead_date: string | null;
  /** Leads with no first_contact_at: counted in lifetime totals, absent from every period bucket. */
  undated_lead_count: number;
  by_status: Record<string, number>;
}

export interface LeadActivityItem {
  item_id: number;
  item_display_name: string;
  current_period: {
    /** Leads whose first contact falls inside the current (newest) period. */
    new_leads: LeadActivityLeadDetail[];
    /** Leads first contacted BEFORE the current period whose last contact falls inside it (ongoing conversations). */
    continuing_leads: LeadActivityLeadDetail[];
  };
  /** Aligned 1:1 with the top-level `periods` array (oldest -> newest). */
  periods: LeadPeriodBucket[];
  lifetime: LeadLifetimeSummary;
}

export interface LeadActivityResult {
  generated_at: string;
  today: string;
  bucket: LeadActivityBucket;
  mode: 'rolling' | 'explicit';
  start_date: string;
  end_date: string;
  /** Oldest -> newest; the last one is current_period. */
  periods: CalendarPeriod[];
  current_period: CalendarPeriod;
  filters_applied: LeadActivityFilters;
  semantics: string[];
  totals: { periods: LeadPeriodBucket[]; lifetime: LeadLifetimeSummary };
  item_count: number;
  items: LeadActivityItem[];
  /** In-scope open items with zero (matching) leads ever — listed so absence of demand is explicit, not ambiguous. */
  items_without_leads: { item_id: number; item_display_name: string }[];
}

export interface OpenItemRef {
  item_id: number;
  item_display_name: string;
}

/** Lead row as loaded: stored columns plus the resolved canonical channel name. */
export type LoadedLead = Omit<LeadRow, 'item_name'>;

const SEMANTICS: string[] = [
  'Leads are grouped into periods by first_contact_at. Undated leads appear only in lifetime totals.',
  'week = Monday-Sunday calendar week; month = calendar month. is_partial=true means the bucket covers fewer days than its full calendar period (in progress or clipped) — do not compare it to complete periods as equivalent.',
  'lifetime ignores the reporting window: it is the item\'s full stored lead history (a channel filter, if given, still applies).',
  'peak_stage = highest observable stage reached: INQUIRY < ENGAGED < NEGOTIATING < HIGH_INTENT < CONVERTED (definitions: record_lead_interaction). negotiating_plus = NEGOTIATING + HIGH_INTENT + CONVERTED (replaces legacy Serious+); high_intent_plus = HIGH_INTENT + CONVERTED. stage_counts.UNSET = legacy rows not yet backfilled.',
  'LEGACY (kept for one release): quality / serious_plus_count / high_intent_count / serious_count / engaged_count / low_count / last_serious_plus_lead_date count the subjective Lead Log lead_quality, which direct-write leads do not have. Prefer the stage fields.',
  'offer = offer_type other than NONE (offer fields = the latest BUYER position). Channel = canonical deal channel name, else the raw source channel, else "Unknown". waiting_on: US = we owe a reply, BUYER = waiting for them, NONE = nothing pending, null = unknown (legacy).',
  'Listing state, price history and exposure come from get_inventory_analysis (join on item_id). For one item\'s full lead notes and event history use get_item_context.',
];

const PAGE = 1000;
const ID_CHUNK = 150;

/** Same rule as public.lead_is_negotiating_plus: peak_stage, legacy quality only while unset. */
export function isNegotiatingPlus(l: Pick<LoadedLead, 'peak_stage' | 'lead_quality'>): boolean {
  return l.peak_stage != null ? NEGOTIATING_PLUS_STAGES.includes(l.peak_stage) : l.lead_quality != null && SERIOUS_PLUS_QUALITIES.includes(l.lead_quality);
}
export function isHighIntentPlus(l: Pick<LoadedLead, 'peak_stage' | 'lead_quality'>): boolean {
  return l.peak_stage != null ? HIGH_INTENT_PLUS_STAGES.includes(l.peak_stage) : l.lead_quality === 'HIGH_INTENT';
}

function emptyCounts(): LeadCounts {
  const stage_counts = Object.fromEntries([...LEAD_STAGES, 'UNSET'].map((k) => [k, 0])) as LeadCounts['stage_counts'];
  return { lead_count: 0, offer_count: 0, stage_counts, negotiating_plus_count: 0, high_intent_plus_count: 0, serious_plus_count: 0, high_intent_count: 0, serious_count: 0, engaged_count: 0, low_count: 0, by_channel: {} };
}

function addLead(c: LeadCounts, lead: LoadedLead): void {
  c.lead_count++;
  if (lead.offer_type !== 'NONE') c.offer_count++;
  c.stage_counts[lead.peak_stage ?? 'UNSET']++;
  if (isNegotiatingPlus(lead)) c.negotiating_plus_count++;
  if (isHighIntentPlus(lead)) c.high_intent_plus_count++;
  if (lead.lead_quality != null && SERIOUS_PLUS_QUALITIES.includes(lead.lead_quality)) c.serious_plus_count++;
  if (lead.lead_quality === 'HIGH_INTENT') c.high_intent_count++;
  else if (lead.lead_quality === 'SERIOUS') c.serious_count++;
  else if (lead.lead_quality === 'ENGAGED') c.engaged_count++;
  else if (lead.lead_quality === 'LOW') c.low_count++;
  const ch = leadChannelLabel(lead);
  c.by_channel[ch] = (c.by_channel[ch] ?? 0) + 1;
}

function emptyLifetime(): LeadLifetimeSummary {
  return { ...emptyCounts(), first_lead_date: null, last_lead_date: null, last_serious_plus_lead_date: null, last_negotiating_plus_lead_date: null, undated_lead_count: 0, by_status: {} };
}

function addLifetime(s: LeadLifetimeSummary, lead: LoadedLead): void {
  addLead(s, lead);
  s.by_status[lead.status] = (s.by_status[lead.status] ?? 0) + 1;
  const d = lead.first_contact_at;
  if (d == null) { s.undated_lead_count++; return; }
  if (s.first_lead_date == null || d < s.first_lead_date) s.first_lead_date = d;
  if (s.last_lead_date == null || d > s.last_lead_date) s.last_lead_date = d;
  if (lead.lead_quality != null && SERIOUS_PLUS_QUALITIES.includes(lead.lead_quality) && (s.last_serious_plus_lead_date == null || d > s.last_serious_plus_lead_date)) {
    s.last_serious_plus_lead_date = d;
  }
  if (isNegotiatingPlus(lead) && (s.last_negotiating_plus_lead_date == null || d > s.last_negotiating_plus_lead_date)) {
    s.last_negotiating_plus_lead_date = d;
  }
}

function emptyBuckets(periods: CalendarPeriod[]): LeadPeriodBucket[] {
  return periods.map((p) => ({ ...p, ...emptyCounts() }));
}

function bucketIndex(periods: CalendarPeriod[], date: string | null): number {
  if (date == null) return -1;
  return periods.findIndex((p) => date >= p.start_date && date <= p.end_date);
}

function toDetail(lead: LoadedLead): LeadActivityLeadDetail {
  return {
    lead_id: lead.id,
    first_contact_at: lead.first_contact_at,
    last_contact_at: lead.last_contact_at,
    channel: leadChannelLabel(lead),
    contact_name: lead.contact_name,
    channel_detail: lead.channel_detail ?? null,
    peak_stage: lead.peak_stage ?? null,
    peak_stage_source: lead.peak_stage_source ?? null,
    negotiation_rounds: lead.negotiation_rounds ?? 0,
    waiting_on: lead.waiting_on ?? null,
    unanswered_followups: lead.unanswered_followups ?? 0,
    reopen_count: lead.reopen_count ?? 0,
    offer_assessment: lead.offer_assessment ?? null,
    latest_cash_offer: lead.latest_cash_offer ?? null,
    quality: lead.lead_quality,
    status: lead.status,
    outcome_reason: lead.outcome_reason,
    offer_type: lead.offer_type,
    offer_summary: formatOfferSummary(lead),
    initial_cash_offer: lead.initial_cash_offer,
    best_cash_offer: lead.best_cash_offer,
    cash_component: lead.cash_component,
    trade_item: lead.trade_item,
    trade_est_value: lead.trade_est_value,
    buyer_message_count: lead.buyer_message_count,
    our_message_count: lead.our_message_count,
    notes: lead.notes,
    deal_id: lead.deal_id,
  };
}

const byContact = (a: LoadedLead, b: LoadedLead) =>
  (a.first_contact_at ?? '').localeCompare(b.first_contact_at ?? '') || a.id - b.id;

/** Applies item_ids to the open-item set. Pure, non-mutating. */
export function scopeItems(items: OpenItemRef[], filters: LeadActivityFilters): OpenItemRef[] {
  const ids = filters.item_ids && filters.item_ids.length > 0 ? new Set(filters.item_ids) : null;
  return items.filter((i) => ids === null || ids.has(i.item_id));
}

/** Lead-level channel filter. Pure, non-mutating. */
export function filterLeadsByChannel(leads: LoadedLead[], channel: string[] | undefined): LoadedLead[] {
  const wanted = channel && channel.length > 0 ? new Set(channel.map((c) => c.trim().toLowerCase()).filter(Boolean)) : null;
  if (wanted === null) return leads;
  return leads.filter((l) => wanted.has(leadChannelLabel(l).toLowerCase()));
}

/**
 * Pure builder: canonical item set + that set's stored leads -> the three-
 * layer response. Never reads anything else and never mutates its inputs.
 */
export function buildLeadActivity(params: {
  items: OpenItemRef[];
  leads: LoadedLead[];
  resolved: ResolvedPeriods;
  filters: LeadActivityFilters;
  today: string;
  generatedAt?: string;
}): LeadActivityResult {
  const { resolved, filters, today } = params;
  const scoped = scopeItems(params.items, filters);
  const scopedIds = new Set(scoped.map((i) => i.item_id));
  const leads = filterLeadsByChannel(params.leads, filters.channel).filter((l) => scopedIds.has(l.inventory_item_id));

  const byItem = new Map<number, LoadedLead[]>();
  for (const l of leads) {
    const arr = byItem.get(l.inventory_item_id);
    if (arr) arr.push(l); else byItem.set(l.inventory_item_id, [l]);
  }

  const current = resolved.periods[resolved.periods.length - 1];
  const totals = { periods: emptyBuckets(resolved.periods), lifetime: emptyLifetime() };
  const items: LeadActivityItem[] = [];
  const itemsWithoutLeads: OpenItemRef[] = [];

  for (const ref of [...scoped].sort((a, b) => a.item_id - b.item_id)) {
    const itemLeads = (byItem.get(ref.item_id) ?? []).slice().sort(byContact);
    if (itemLeads.length === 0) { itemsWithoutLeads.push({ item_id: ref.item_id, item_display_name: ref.item_display_name }); continue; }

    const buckets = emptyBuckets(resolved.periods);
    const lifetime = emptyLifetime();
    const newLeads: LeadActivityLeadDetail[] = [];
    const continuing: LeadActivityLeadDetail[] = [];

    for (const lead of itemLeads) {
      addLifetime(lifetime, lead);
      addLifetime(totals.lifetime, lead);
      const idx = bucketIndex(resolved.periods, lead.first_contact_at);
      if (idx >= 0) { addLead(buckets[idx], lead); addLead(totals.periods[idx], lead); }
      const first = lead.first_contact_at;
      if (first != null && first >= current.start_date && first <= current.end_date) {
        newLeads.push(toDetail(lead));
      } else if (
        first != null && first < current.start_date &&
        lead.last_contact_at != null && lead.last_contact_at >= current.start_date && lead.last_contact_at <= current.end_date
      ) {
        continuing.push(toDetail(lead));
      }
    }

    items.push({
      item_id: ref.item_id,
      item_display_name: ref.item_display_name,
      current_period: { new_leads: newLeads, continuing_leads: continuing },
      periods: buckets,
      lifetime,
    });
  }

  return {
    generated_at: params.generatedAt ?? new Date().toISOString(),
    today,
    bucket: resolved.bucket,
    mode: resolved.mode,
    start_date: resolved.start_date,
    end_date: resolved.end_date,
    periods: resolved.periods,
    current_period: current,
    filters_applied: filters,
    semantics: SEMANTICS,
    totals,
    item_count: items.length,
    items,
    items_without_leads: itemsWithoutLeads,
  };
}

/** The open-inventory item set exactly as get_inventory_analysis itemizes it (same RPC, same names). */
async function loadOpenItems(client: SupabaseClient): Promise<OpenItemRef[]> {
  const { data, error } = await client.rpc('build_listing_evidence_v1_0_for_current_user');
  if (error) throw new LeadActivityServiceError(`listing evidence: ${error.message}`);
  if (!isValidListingEvidence(data)) throw new LeadActivityServiceError('listing evidence: unexpected shape');
  const u = data.unlisted_open_inventory;
  const seen = new Map<number, OpenItemRef>();
  for (const i of [...data.listed_items, ...u.business, ...u.hybrid, ...u.unclassified]) {
    if (!seen.has(i.item_id)) seen.set(i.item_id, { item_id: i.item_id, item_display_name: i.item_display_name });
  }
  return Array.from(seen.values());
}

/** Stored item_leads for the given items, through the caller's RLS-scoped client, with canonical channel names resolved. */
async function loadLeadsForItems(client: SupabaseClient, itemIds: number[]): Promise<LoadedLead[]> {
  const raw: Record<string, unknown>[] = [];
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await client
        .from('item_leads')
        .select(LEAD_COLUMNS)
        .in('inventory_item_id', chunk)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new LeadActivityServiceError(`item_leads: ${error.message}`);
      const page = (data ?? []) as unknown as Record<string, unknown>[];
      raw.push(...page);
      if (page.length < PAGE) break;
    }
  }
  if (raw.length === 0) return [];

  const { data: channelRows, error: channelError } = await client.from('deal_channels').select('id, name');
  if (channelError) throw new LeadActivityServiceError(`deal_channels: ${channelError.message}`);
  const channelNames = new Map<number, string>((channelRows ?? []).map((c) => [c.id as number, c.name as string]));

  const num = (v: unknown) => (v == null ? null : Number(v));
  return raw.map((r) => {
    const lead = r as unknown as LoadedLead;
    return {
      ...lead,
      initial_cash_offer: num(r.initial_cash_offer),
      best_cash_offer: num(r.best_cash_offer),
      cash_component: num(r.cash_component),
      trade_est_value: num(r.trade_est_value),
      latest_cash_offer: num(r.latest_cash_offer),
      channel_name: lead.deal_channel_id != null ? channelNames.get(lead.deal_channel_id) ?? null : null,
    };
  });
}

/** Full get_lead_activity tool implementation. `now` is injectable for tests. */
export async function getLeadActivityForUser(
  client: SupabaseClient,
  filters: LeadActivityFilters,
  now: Date = new Date(),
): Promise<LeadActivityResult> {
  const today = torontoLocalDate(now);
  let resolved: ResolvedPeriods;
  try {
    resolved = resolveLeadActivityPeriods(filters, today);
  } catch (err) {
    if (err instanceof LeadActivityPeriodError) throw new LeadActivityServiceError(err.message);
    throw err;
  }

  const items = scopeItems(await loadOpenItems(client), filters);
  const leads = await loadLeadsForItems(client, items.map((i) => i.item_id));
  return buildLeadActivity({ items, leads, resolved, filters, today, generatedAt: now.toISOString() });
}
