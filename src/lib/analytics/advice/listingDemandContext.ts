// Business Coach (Auditable AI Advice) — compact Listing Demand context.
//
// Turns the CANONICAL server-side evidence — Listing Demand Evidence
// (build_listing_demand_evidence_v1_1, trend_weeks = 4) and Item Activity
// (listing_demand_item_activity_v1_0) — into a small, deterministic block
// the Coach receives inside its Advice Input Packet. Nothing here is
// recomputed: every number is an evidence/Item-Activity field passed
// through; this module only SELECTS (which items) and RESHAPES (drops
// fields the Coach does not need). Deliberately never included: any
// item_leads row, lead ids/UUIDs, lead notes or messages, buyer names,
// cash components, individual offer amounts, per-lead timestamps, the full
// evidence JSON, or presentation-only fields. There is intentionally no
// conversion-rate field of any kind — no canonical lead -> deal link
// exists.
//
// The window is fixed and independent of /listings UI state: 4 consecutive
// weekly buckets ending on "today" (Toronto-local calendar date — the same
// end-date convention the /listings page uses for its current 7-day
// period), never the client-side 5-minute Listings cache.
//
// Pure builders (buildListingDemandContext/selectCoachItems/
// buildListingDemandSources) are importable from plain Node tests; the
// server loader at the bottom only calls the existing canonical helpers.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getListingDemandEvidence, type ListingDemandEvidence } from '../listingDemandEvidence';
import { getListingItemActivity, type ItemActivityEntry } from '../listingItemActivity';
import { itemActivityWindow, sortItemActivity } from '../../listingItemActivityHelpers';
import { evaluateWeeklyTorontoWindow } from '../automation/torontoSchedule';

export const LISTING_DEMAND_CONTEXT_VERSION = '1.0';
export const COACH_DEMAND_WEEKS = 4;
export const MAX_HIGHEST_ACTIVITY_ITEMS = 10;
export const MAX_ZERO_ACTIVITY_ITEMS = 5;
export const MAX_COACH_ITEMS = 15;

// ── Types ────────────────────────────────────────────────────────────────

export interface CoachMarketWeek {
  start_date: string;
  end_date: string;
  avg_listed_items: number | null;
  avg_channel_exposure: number | null;
  leads_started: number;
  serious_plus_leads_from_cohort: number;
  realized_deal_count: number;
  leads_per_100_channel_listing_days: number | null;
}

export interface CoachChannelWeek {
  start_date: string;
  channel_listing_days: number;
  channel_attributed_leads: number;
  serious_plus_attributed_leads_from_cohort: number;
  realized_deal_count_by_recorded_channel: number;
  leads_per_100_channel_listing_days: number | null;
}

export interface CoachChannel {
  source_id: string;
  channel_id: number;
  channel_name: string;
  weeks: CoachChannelWeek[];
}

export interface CoachItem {
  source_id: string;
  item_id: number;
  item_display_name: string;
  current_active_channels: string[];
  item_attributed_leads: number;
  serious_plus_attributed_leads: number;
  offer_attributed_leads: number;
  channel_listing_days: number;
  item_listing_days: number;
  last_attributed_lead_date: string | null;
}

export interface CoachDataQuality {
  source_id: string;
  most_recent_7_day_period: {
    start_date: string;
    end_date: string;
    item_attribution_pct: number | null;
    channel_attribution_pct: number | null;
    leads_started: number;
    leads_without_normalized_channel: number;
  };
  undated_lead_count: number;
  earliest_dated_lead: string | null;
  earliest_listing_exposure_date: string | null;
  limitations: string[];
}

export interface ListingDemandContext {
  context_version: typeof LISTING_DEMAND_CONTEXT_VERSION;
  window_weeks: number;
  start_date: string;
  end_date: string;
  market_trend: { source_id: string; weeks: CoachMarketWeek[] };
  channels: CoachChannel[];
  items: {
    currently_listed_count: number;
    with_attributed_leads_count: number;
    without_attributed_leads_count: number;
    highest_activity: CoachItem[];
    zero_activity_high_exposure: CoachItem[];
  };
  data_quality: CoachDataQuality;
}

// ── Fixed, compact limitation text (instead of the verbose limitations[]) ──

export const COACH_DEMAND_LIMITATIONS: string[] = [
  'Lead Log historical completeness varies by source and time period; a low lead count may reflect incomplete logging, not low buyer interest.',
  'lead_quality is the highest intent level a lead has ever reached, not its quality at first contact; Serious+ counts leads that reached SERIOUS or HIGH_INTENT.',
  'No canonical lead-to-deal link exists: realized deals are factual Sell/Trade activity in a period and must not be treated as lead conversions.',
  'Item-attributed leads need listing exposure for the item on first contact; channel-attributed additionally needs matching item/channel exposure; a lead without a normalized channel can still be item-attributed.',
];

// ── Selection ────────────────────────────────────────────────────────────

/**
 * Deterministic compact item selection (never a score/label):
 *  A. up to 10 items WITH attributed leads, in the existing Item Activity
 *     order (leads DESC, Serious+ DESC, Offers DESC, last lead DESC, name ASC);
 *  B. up to 5 items with ZERO attributed leads but exposure, by
 *     channel_listing_days DESC (then item_listing_days DESC, name ASC, id).
 * Disjoint by construction (A needs leads > 0, B needs leads = 0) and capped
 * at 15 in total.
 */
export function selectCoachItems(items: ItemActivityEntry[]): { highest: ItemActivityEntry[]; zeroActivity: ItemActivityEntry[] } {
  const highest = sortItemActivity(items)
    .filter((i) => i.item_attributed_leads > 0)
    .slice(0, MAX_HIGHEST_ACTIVITY_ITEMS);

  const zeroActivity = items
    .filter((i) => i.item_attributed_leads === 0 && i.channel_listing_days > 0)
    .sort((a, b) =>
      b.channel_listing_days - a.channel_listing_days
      || b.item_listing_days - a.item_listing_days
      || a.item_display_name.localeCompare(b.item_display_name)
      || a.item_id - b.item_id)
    .slice(0, Math.min(MAX_ZERO_ACTIVITY_ITEMS, MAX_COACH_ITEMS - highest.length));

  return { highest, zeroActivity };
}

function toCoachItem(i: ItemActivityEntry): CoachItem {
  const seen = new Set<string>();
  const channels: string[] = [];
  for (const c of i.active_channels) {
    if (!seen.has(c.channel_name)) { seen.add(c.channel_name); channels.push(c.channel_name); }
  }
  return {
    source_id: `demand:item:${i.item_id}`,
    item_id: i.item_id,
    item_display_name: i.item_display_name,
    current_active_channels: channels,
    item_attributed_leads: i.item_attributed_leads,
    serious_plus_attributed_leads: i.serious_plus_attributed_leads,
    offer_attributed_leads: i.offer_attributed_leads,
    channel_listing_days: i.channel_listing_days,
    item_listing_days: i.item_listing_days,
    last_attributed_lead_date: i.last_attributed_lead_date,
  };
}

// ── Pure builder ─────────────────────────────────────────────────────────

/**
 * Builds the Coach's compact context from ALREADY-COMPUTED canonical
 * evidence (trend_weeks 4) and the Item Activity rows for the SAME window.
 * Throws if the evidence does not carry exactly the expected 4 weekly
 * buckets or the item window does not match — the caller treats any throw as
 * "enrichment unavailable" and omits the block rather than guessing.
 */
export function buildListingDemandContext(evidence: ListingDemandEvidence, itemActivity: ItemActivityEntry[]): ListingDemandContext {
  const trend = evidence.weekly_trend;
  if (!Array.isArray(trend) || trend.length !== COACH_DEMAND_WEEKS) {
    throw new Error(`listing demand evidence must carry exactly ${COACH_DEMAND_WEEKS} weekly buckets`);
  }
  const win = itemActivityWindow(evidence)!;

  const weeks: CoachMarketWeek[] = trend.map((w) => ({
    start_date: w.start_date,
    end_date: w.end_date,
    avg_listed_items: w.avg_listed_items,
    avg_channel_exposure: w.avg_channel_exposure,
    leads_started: w.leads_started,
    serious_plus_leads_from_cohort: w.serious_plus_leads_from_cohort,
    realized_deal_count: w.realized_deal_count,
    leads_per_100_channel_listing_days: w.leads_per_100_channel_listing_days,
  }));

  // Every canonical channel Evidence returns — dynamic, never a hardcoded set.
  const channels: CoachChannel[] = evidence.channels.map((c) => ({
    source_id: `demand:channel:${c.deal_channel_id}`,
    channel_id: c.deal_channel_id,
    channel_name: c.channel_name,
    weeks: trend.map((w) => {
      const wc = w.channels.find((x) => x.deal_channel_id === c.deal_channel_id);
      return {
        start_date: w.start_date,
        channel_listing_days: wc?.channel_listing_days ?? 0,
        channel_attributed_leads: wc?.channel_attributed_leads ?? 0,
        serious_plus_attributed_leads_from_cohort: wc?.serious_plus_attributed_leads_from_cohort ?? 0,
        realized_deal_count_by_recorded_channel: wc?.realized_deal_count_by_recorded_channel ?? 0,
        leads_per_100_channel_listing_days: wc?.leads_per_100_channel_listing_days ?? null,
      };
    }),
  }));

  const { highest, zeroActivity } = selectCoachItems(itemActivity);
  const withLeads = itemActivity.filter((i) => i.item_attributed_leads > 0).length;

  const cp = evidence.data_quality.current_period;
  return {
    context_version: LISTING_DEMAND_CONTEXT_VERSION,
    window_weeks: COACH_DEMAND_WEEKS,
    start_date: win.from,
    end_date: win.to,
    market_trend: { source_id: 'demand:market_trend', weeks },
    channels,
    items: {
      currently_listed_count: itemActivity.length,
      with_attributed_leads_count: withLeads,
      without_attributed_leads_count: itemActivity.length - withLeads,
      highest_activity: highest.map(toCoachItem),
      zero_activity_high_exposure: zeroActivity.map(toCoachItem),
    },
    data_quality: {
      source_id: 'demand:data_quality',
      most_recent_7_day_period: {
        start_date: evidence.period.start_date,
        end_date: evidence.period.end_date,
        item_attribution_pct: cp.item_attribution_pct,
        channel_attribution_pct: cp.channel_attribution_pct,
        leads_started: cp.leads_started,
        leads_without_normalized_channel: cp.leads_without_normalized_channel,
      },
      undated_lead_count: evidence.data_quality.undated_lead_count,
      earliest_dated_lead: evidence.data_quality.earliest_dated_lead,
      earliest_listing_exposure_date: evidence.data_quality.earliest_listing_exposure_date,
      limitations: [...COACH_DEMAND_LIMITATIONS],
    },
  };
}

// ── Citable sources ──────────────────────────────────────────────────────
// One registry entry per citable unit so an advice card can cite exactly
// the part of the evidence it relies on (validateAdviceResponse requires
// every cited id to exist, and a non-null item_id to be justified by a
// cited source carrying that item_id — demand:item:<id> entries do).

export interface ListingDemandSource {
  source_id: string;
  item_id: number | null;
  headline: string;
  summary: string;
  key_metrics: Record<string, unknown>;
  limitations: string[];
}

export function buildListingDemandSources(ctx: ListingDemandContext): ListingDemandSource[] {
  const range = `${ctx.start_date} to ${ctx.end_date}`;
  const out: ListingDemandSource[] = [];

  const { source_id: marketId, ...marketRest } = ctx.market_trend;
  out.push({
    source_id: marketId,
    item_id: null,
    headline: `Listing demand — market trend over the last ${ctx.window_weeks} weeks`,
    summary: `Weekly listing exposure, leads started, Serious+ leads, realized deals and leads per 100 channel-listing-days for ${ctx.window_weeks} consecutive weeks (${range}). Factual activity evidence, not a conversion funnel.`,
    key_metrics: marketRest,
    limitations: [],
  });

  for (const c of ctx.channels) {
    const { source_id, ...rest } = c;
    out.push({
      source_id,
      item_id: null,
      headline: `Listing demand — ${c.channel_name} channel activity`,
      summary: `Weekly channel-listing-days, channel-attributed leads, Serious+ attributed leads, realized deals by recorded channel and leads per 100 channel-listing-days for ${c.channel_name} (${range}).`,
      key_metrics: rest,
      limitations: [],
    });
  }

  for (const item of [...ctx.items.highest_activity, ...ctx.items.zero_activity_high_exposure]) {
    const { source_id, ...rest } = item;
    out.push({
      source_id,
      item_id: item.item_id,
      headline: `Listing demand — ${item.item_display_name}`,
      summary: `Item-attributed lead activity and listing exposure for this currently listed item over ${range}.`,
      key_metrics: rest,
      limitations: [],
    });
  }

  const { source_id: dqId, limitations, ...dqRest } = ctx.data_quality;
  out.push({
    source_id: dqId,
    item_id: null,
    headline: 'Listing demand — data quality and limitations',
    summary: 'Attribution coverage for the most recent 7 days, undated leads, earliest dated lead, and the limits of the lead evidence.',
    key_metrics: dqRest,
    limitations,
  });

  return out;
}

// ── Server loader ────────────────────────────────────────────────────────

/** Toronto-local calendar date for "today" — the automation's own convention. */
export function coachDemandEndDate(now: Date = new Date()): string {
  return evaluateWeeklyTorontoWindow(now).localPeriodKey;
}

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Loads the canonical evidence for the authenticated user's own id and
 * builds the Coach context. Evidence and Item Activity are fetched
 * CONCURRENTLY: the item window is derived from the documented weekly
 * bucket rule (4 weeks ending today) and then VERIFIED against the window
 * Evidence actually reports — if they ever disagree, Item Activity is
 * re-fetched for Evidence's exact window (never trusting the derivation).
 * Throws on any failure; the caller (generateAdviceForRun) catches it and
 * simply omits the Listing Demand block.
 */
export async function loadListingDemandContext(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
  now?: Date;
  timeoutMs?: number;
}): Promise<ListingDemandContext> {
  const { appUserId, serviceClient } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endDate = coachDemandEndDate(params.now);
  // Current 7-day period ends today; the 4 weekly buckets end on the same day.
  const periodStart = addDays(endDate, -6);
  const expectedWindow = { from: addDays(endDate, -(COACH_DEMAND_WEEKS * 7 - 1)), to: endDate };

  const run = async (): Promise<ListingDemandContext> => {
    const [evidence, speculativeItems] = await Promise.all([
      getListingDemandEvidence({ appUserId, serviceClient, startDate: periodStart, endDate, trendWeeks: COACH_DEMAND_WEEKS }),
      getListingItemActivity({ appUserId, serviceClient, startDate: expectedWindow.from, endDate: expectedWindow.to }),
    ]);
    const actual = itemActivityWindow(evidence);
    if (!actual) throw new Error('listing demand evidence has no weekly buckets');
    const items = actual.from === expectedWindow.from && actual.to === expectedWindow.to
      ? speculativeItems
      : await getListingItemActivity({ appUserId, serviceClient, startDate: actual.from, endDate: actual.to });
    return buildListingDemandContext(evidence, items);
  };

  return withTimeout(run(), timeoutMs, 'listing demand context');
}
