// Business Coach (Auditable AI Advice) — deterministic Lead -> Deal linkage
// analytics.
//
// Built ENTIRELY from item_leads.deal_id — the one canonical linkage this
// app has (see supabase/migrations/20260925000000_item_leads_deal_id.sql /
// 20260926000000_item_leads_one_linked_lead_per_item.sql). Nothing here
// infers conversion from an unlinked lead: a lead with deal_id = NULL
// contributes to `total_leads` (and, if COMPLETED, to the coverage
// denominator) but never to `linked_leads` or any "linked deal rate".
//
// This is DELIBERATELY separate from Listing Demand's realized_deal_count /
// realized_deal_count_by_recorded_channel (listingDemandContext.ts) — that
// metric stays an unlinked, purely aggregate fact and is never reinterpreted
// here or by this module's consumers. See sharedSemantics.ts's
// LEAD_DEAL_RULES for the prompt-level rule this enforces.
//
// Historical completeness matters more than any single rate: every summary
// this module produces carries its own coverage figure
// (completed_link_coverage_pct) alongside the rate, and low coverage is
// always the more important number to read first — a low "linked deal rate"
// on a mostly-unlinked historical cohort reflects incomplete linkage, not a
// failed outcome. Rates on a still-open cohort are always "to date", never
// final.
//
// No profit/value attribution of any kind lives here — a multi-item deal's
// value cannot be split across its linked leads without double-counting;
// that is explicitly out of scope for this module.

export const LINKED_DEAL_ANALYTICS_VERSION = '1.0';

export const LINKED_DEAL_ANALYTICS_LIMITATIONS: string[] = [
  'Historical completed leads may not yet have deal_id backfilled — a low completed_link_coverage_pct means incomplete linkage, not failed conversion.',
  'Rates for a cohort that includes still-OPEN leads are "to date" only: an open lead has not necessarily reached its final outcome yet.',
  'A deal may realize more than one item; the same deal_id can appear on more than one linked lead (one per item). Profit/value is never attributed per lead here.',
  'Linkage is manual (the chat workflow writes deal_id into the Lead Log) — a mismatch between two similar-looking leads for the same item is prevented (one linked lead per item), but a genuinely wrong link is not detectable from this data alone.',
];

// ── Minimal lead shape this module needs (already-normalized) ─────────────

export interface LinkedDealLeadInput {
  status: string;
  lead_quality: string;
  offer_type: string;
  deal_id: number | null;
  deal_channel_id: number | null;
  /** YYYY-MM-DD, or null when the lead has no recorded first contact date. */
  first_contact_at: string | null;
}

const SERIOUS_PLUS_QUALITIES = new Set(['SERIOUS', 'HIGH_INTENT']);
const OFFER_TYPES_WITH_OFFER = new Set(['CASH', 'TRADE', 'MIXED']);

// ── Metrics (one shape, reused for "overall" and each channel row) ────────

export interface LinkedDealMetrics {
  total_leads: number;
  linked_leads: number;
  distinct_linked_deals: number;
  completed_leads: number;
  completed_leads_with_deal_id: number;
  /** completed_leads_with_deal_id / completed_leads * 100, 1 decimal. Null when completed_leads = 0 — never divide by zero, never fabricate. ALWAYS read this before any rate below. */
  completed_link_coverage_pct: number | null;
  /** linked_leads / total_leads * 100 ("observed linked deal rate to date"), 1 decimal. Null when total_leads = 0. */
  linked_deal_rate_to_date_pct: number | null;
  serious_plus_lead_count: number;
  serious_plus_leads_with_deal_id: number;
  /** Null when serious_plus_lead_count = 0. */
  serious_plus_linked_deal_rate_to_date_pct: number | null;
  offer_lead_count: number;
  offer_leads_with_deal_id: number;
  /** Null when offer_lead_count = 0. */
  offer_linked_deal_rate_to_date_pct: number | null;
  /** Median of (deals.deal_date - item_leads.first_contact_at) in days, over LINKED leads with a recorded first_contact_at and a resolvable deal_date. Null when no such lead exists. */
  median_days_first_contact_to_deal_date: number | null;
}

export interface LinkedDealChannelBreakdown extends LinkedDealMetrics {
  source_id: string;
  channel_id: number | null;
  channel_name: string;
}

export interface LinkedDealAnalyticsContext {
  context_version: typeof LINKED_DEAL_ANALYTICS_VERSION;
  overall: LinkedDealMetrics & { source_id: string };
  by_channel: LinkedDealChannelBreakdown[];
  limitations: string[];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function pctOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round1((numerator / denominator) * 100) : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function daysBetween(fromDate: string, toDate: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(fromDate);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(toDate);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / 86400000);
}

/**
 * Computes the metrics for exactly the leads passed in — the caller decides
 * the cohort (overall, or one channel's leads). `dealDateByDealId` resolves
 * a linked lead's own deal_id to that deal's deal_date for the median-days
 * calculation; a linked lead whose deal_id isn't in the map (shouldn't
 * happen for a validly-linked lead, but never assumed) simply doesn't
 * contribute to the median.
 */
export function computeLinkedDealMetrics(
  leads: LinkedDealLeadInput[],
  dealDateByDealId: Map<number, string>,
): LinkedDealMetrics {
  const totalLeads = leads.length;
  const linked = leads.filter((l) => l.deal_id !== null);
  const linkedLeads = linked.length;
  const distinctLinkedDeals = new Set(linked.map((l) => l.deal_id as number)).size;

  const completed = leads.filter((l) => l.status === 'COMPLETED');
  const completedLeads = completed.length;
  const completedWithDealId = completed.filter((l) => l.deal_id !== null).length;

  const seriousPlus = leads.filter((l) => SERIOUS_PLUS_QUALITIES.has(l.lead_quality));
  const seriousPlusCount = seriousPlus.length;
  const seriousPlusWithDealId = seriousPlus.filter((l) => l.deal_id !== null).length;

  const offerLeads = leads.filter((l) => OFFER_TYPES_WITH_OFFER.has(l.offer_type));
  const offerLeadCount = offerLeads.length;
  const offerLeadsWithDealId = offerLeads.filter((l) => l.deal_id !== null).length;

  const dayDiffs: number[] = [];
  for (const l of linked) {
    if (!l.first_contact_at || l.deal_id === null) continue;
    const dealDate = dealDateByDealId.get(l.deal_id);
    if (!dealDate) continue;
    const diff = daysBetween(l.first_contact_at, dealDate);
    if (diff !== null) dayDiffs.push(diff);
  }

  return {
    total_leads: totalLeads,
    linked_leads: linkedLeads,
    distinct_linked_deals: distinctLinkedDeals,
    completed_leads: completedLeads,
    completed_leads_with_deal_id: completedWithDealId,
    completed_link_coverage_pct: pctOrNull(completedWithDealId, completedLeads),
    linked_deal_rate_to_date_pct: pctOrNull(linkedLeads, totalLeads),
    serious_plus_lead_count: seriousPlusCount,
    serious_plus_leads_with_deal_id: seriousPlusWithDealId,
    serious_plus_linked_deal_rate_to_date_pct: pctOrNull(seriousPlusWithDealId, seriousPlusCount),
    offer_lead_count: offerLeadCount,
    offer_leads_with_deal_id: offerLeadsWithDealId,
    offer_linked_deal_rate_to_date_pct: pctOrNull(offerLeadsWithDealId, offerLeadCount),
    median_days_first_contact_to_deal_date: median(dayDiffs),
  };
}

/** Canonical channel name for grouping — "Other" for no normalized channel, matching this app's existing convention (leadFormat.ts's leadChannelLabel falls back the same way, though here it is bounded to canonical channels only, never raw source_channel text). */
const OTHER_CHANNEL_LABEL = 'Other / no channel';

export function buildLinkedDealAnalyticsContext(
  leads: LinkedDealLeadInput[],
  dealDateByDealId: Map<number, string>,
  channelNameById: Map<number, string>,
): LinkedDealAnalyticsContext {
  const overall = computeLinkedDealMetrics(leads, dealDateByDealId);

  const byChannelId = new Map<number | null, LinkedDealLeadInput[]>();
  for (const l of leads) {
    const key = l.deal_channel_id;
    const list = byChannelId.get(key) ?? [];
    list.push(l);
    byChannelId.set(key, list);
  }

  const byChannel: LinkedDealChannelBreakdown[] = Array.from(byChannelId.entries())
    .map(([channelId, channelLeads]) => ({
      source_id: channelId === null ? 'linked_deal:channel:other' : `linked_deal:channel:${channelId}`,
      channel_id: channelId,
      channel_name: channelId === null ? OTHER_CHANNEL_LABEL : channelNameById.get(channelId) ?? `Channel ${channelId}`,
      ...computeLinkedDealMetrics(channelLeads, dealDateByDealId),
    }))
    // Deterministic order: most total leads first, then channel name.
    .sort((a, b) => b.total_leads - a.total_leads || a.channel_name.localeCompare(b.channel_name));

  return {
    context_version: LINKED_DEAL_ANALYTICS_VERSION,
    overall: { source_id: 'linked_deal:overall', ...overall },
    by_channel: byChannel,
    limitations: [...LINKED_DEAL_ANALYTICS_LIMITATIONS],
  };
}

// ── Citable sources ────────────────────────────────────────────────────────

export interface LinkedDealAnalyticsSource {
  source_id: string;
  item_id: null;
  headline: string;
  summary: string;
  key_metrics: Record<string, unknown>;
  limitations: string[];
}

function metricsToKeyMetrics(m: LinkedDealMetrics): Record<string, unknown> {
  return { ...m };
}

export function buildLinkedDealAnalyticsSources(ctx: LinkedDealAnalyticsContext): LinkedDealAnalyticsSource[] {
  const out: LinkedDealAnalyticsSource[] = [];
  const { source_id: overallId, ...overallRest } = ctx.overall;
  out.push({
    source_id: overallId,
    item_id: null,
    headline: 'Lead -> Deal linkage — overall',
    summary: 'Deterministic linkage coverage and linked deal rates across every recorded lead, computed ONLY from item_leads.deal_id. Not conversion from unlinked leads.',
    key_metrics: metricsToKeyMetrics(overallRest),
    limitations: ctx.limitations,
  });
  for (const c of ctx.by_channel) {
    const { source_id, channel_id, channel_name, ...rest } = c;
    out.push({
      source_id,
      item_id: null,
      headline: `Lead -> Deal linkage — ${channel_name}`,
      summary: `Deterministic linkage coverage and linked deal rates for leads on ${channel_name}, computed ONLY from item_leads.deal_id.`,
      key_metrics: { channel_id, ...metricsToKeyMetrics(rest) },
      limitations: [],
    });
  }
  return out;
}

// ── Server loader ──────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Loads every one of the user's item_leads rows (no time window — historical
 * completeness matters more than any single window here), resolves the
 * canonical channel name for each deal_channel_id and the deal_date for
 * every distinct linked deal_id, and builds the deterministic context. Pure
 * pass-through of stored values; never recomputes anything Listing Demand or
 * any other module already owns.
 */
export async function loadLinkedDealAnalyticsContext(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
}): Promise<LinkedDealAnalyticsContext> {
  const { appUserId, serviceClient } = params;

  const { data: leadRows, error: leadsError } = await serviceClient
    .from('item_leads')
    .select('status, lead_quality, offer_type, deal_id, deal_channel_id, first_contact_at')
    .eq('user_id', appUserId);
  if (leadsError) throw new Error(`item_leads: ${leadsError.message}`);

  const leads: LinkedDealLeadInput[] = (leadRows ?? []).map((r) => ({
    status: r.status as string,
    lead_quality: r.lead_quality as string,
    offer_type: r.offer_type as string,
    deal_id: (r.deal_id as number | null) ?? null,
    deal_channel_id: (r.deal_channel_id as number | null) ?? null,
    first_contact_at: (r.first_contact_at as string | null) ?? null,
  }));

  const channelIds = Array.from(new Set(leads.map((l) => l.deal_channel_id).filter((v): v is number => v !== null)));
  const dealIds = Array.from(new Set(leads.map((l) => l.deal_id).filter((v): v is number => v !== null)));

  const [channelsRes, dealsRes] = await Promise.all([
    channelIds.length > 0 ? serviceClient.from('deal_channels').select('id, name').in('id', channelIds) : Promise.resolve({ data: [], error: null }),
    dealIds.length > 0 ? serviceClient.from('deals').select('id, deal_date').eq('user_id', appUserId).in('id', dealIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (channelsRes.error) throw new Error(`deal_channels: ${channelsRes.error.message}`);
  if (dealsRes.error) throw new Error(`deals: ${dealsRes.error.message}`);

  const channelNameById = new Map<number, string>((channelsRes.data ?? []).map((c: { id: number; name: string }) => [c.id, c.name]));
  const dealDateByDealId = new Map<number, string>((dealsRes.data ?? []).map((d: { id: number; deal_date: string }) => [d.id, d.deal_date]));

  return buildLinkedDealAnalyticsContext(leads, dealDateByDealId, channelNameById);
}
