// Pure helpers for the Listings + Demand product dashboard
// (src/app/listings/page.tsx) — extracted so they're importable from a
// plain Node test script, same rationale as listingDashboardHelpers.ts.
//
// Every function here only RESHAPES/FORMATS fields that already exist on
// Listing Demand Evidence v1.0/v1.1 (src/lib/analytics/listingDemandEvidence.ts)
// for display — week labels, URL state, and pure row-mapping. Nothing here
// recomputes an analytical metric; every number rendered by the page comes
// straight from the evidence response.

import {
  TREND_WEEKS_OPTIONS,
  DEFAULT_TREND_WEEKS,
  isValidTrendWeeks,
  type TrendWeeks,
  type ListingDemandEvidence,
  type DemandWeeklyTrendEntry,
} from './analytics/listingDemandEvidence';

export { TREND_WEEKS_OPTIONS, DEFAULT_TREND_WEEKS };
export type { TrendWeeks };

// ── Trend Window URL state ──────────────────────────────────────────────
// The URL is the durable source of truth (no separate synced local
// state) — a page render always derives trendWeeks directly from
// searchParams via this function, so there is no stale-state-vs-URL race
// window to fall into.

export const TREND_WEEKS_URL_PARAM = 'trend_weeks';

/** Invalid/missing values safely fall back to DEFAULT_TREND_WEEKS (4) — never clamped/rounded to a neighboring valid value. */
export function parseTrendWeeksParam(value: string | null): TrendWeeks {
  if (value !== null && /^\d+$/.test(value)) {
    const n = Number(value);
    if (isValidTrendWeeks(n)) return n;
  }
  return DEFAULT_TREND_WEEKS;
}

/** The default (4) omits the query param entirely, matching this app's existing convention of never writing default-valued filters into the URL. */
export function trendWeeksUrl(trendWeeks: TrendWeeks): string {
  return trendWeeks === DEFAULT_TREND_WEEKS ? '/listings' : `/listings?${TREND_WEEKS_URL_PARAM}=${trendWeeks}`;
}

// ── Week labels ──────────────────────────────────────────────────────────
// Parsed as plain strings, never through a Date object — evidence dates
// are already timezone-free YYYY-MM-DD calendar dates, and going through
// `new Date(...)` risks a local-timezone off-by-one on the displayed day
// (the same class of bug documented for CURRENT_DATE elsewhere in this
// codebase's test scripts).

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_LABELS[m - 1]} ${d}`;
}

export function fmtWeekLabel(startDate: string, endDate: string): string {
  return `${shortDateLabel(startDate)} – ${shortDateLabel(endDate)}`;
}

/** Formats a nullable rate/average to a fixed number of decimals; null (e.g. zero-denominator) renders as an em-dash, never 0 or NaN. */
export function fmtRate(v: number | null, decimals = 1): string {
  if (v == null) return '—';
  return v.toFixed(decimals);
}

// ── Market Activity row mapping ─────────────────────────────────────────
// One row per weekly_trend entry — the exact evidence fields the task
// specifies, nothing recalculated.

export interface MarketActivityRow {
  startDate: string;
  endDate: string;
  weekLabel: string;
  avgListedItems: number | null;
  avgChannelExposure: number | null;
  leadsStarted: number;
  seriousPlusLeads: number;
  realizedDeals: number;
  leadsPer100ChannelDays: number | null;
}

export function buildMarketActivityRows(weeklyTrend: DemandWeeklyTrendEntry[]): MarketActivityRow[] {
  return weeklyTrend.map((w) => ({
    startDate: w.start_date,
    endDate: w.end_date,
    weekLabel: fmtWeekLabel(w.start_date, w.end_date),
    avgListedItems: w.avg_listed_items,
    avgChannelExposure: w.avg_channel_exposure,
    leadsStarted: w.leads_started,
    seriousPlusLeads: w.serious_plus_leads_from_cohort,
    realizedDeals: w.realized_deal_count,
    leadsPer100ChannelDays: w.leads_per_100_channel_listing_days,
  }));
}

// ── Channel Activity row mapping ────────────────────────────────────────
// One row per canonical channel — evidence.channels is already the full,
// dynamic, is_listing_platform-driven channel list (never hardcoded here);
// the weekly per-channel trend is looked up by deal_channel_id out of the
// same weekly_trend the Market Activity section already fetched, so there
// is no second Demand Evidence call.

export interface ChannelActivityWeeklyPoint {
  startDate: string;
  endDate: string;
  weekLabel: string;
  leadsPer100ChannelDays: number | null;
}

export interface ChannelActivityRow {
  dealChannelId: number;
  channelName: string;
  channelListingDays: number;
  attributedLeads: number;
  seriousPlusLeads: number;
  realizedDeals: number;
  leadsPer100ChannelDays: number | null;
  weeklyTrend: ChannelActivityWeeklyPoint[];
}

export function buildChannelActivityRows(evidence: ListingDemandEvidence): ChannelActivityRow[] {
  return evidence.channels.map((channel) => ({
    dealChannelId: channel.deal_channel_id,
    channelName: channel.channel_name,
    channelListingDays: channel.current.channel_listing_days,
    attributedLeads: channel.current.channel_attributed_leads,
    seriousPlusLeads: channel.current.serious_plus_attributed_leads_from_cohort,
    realizedDeals: channel.current.realized_deal_count_by_recorded_channel,
    leadsPer100ChannelDays: channel.current.leads_per_100_channel_listing_days,
    weeklyTrend: evidence.weekly_trend.map((w) => {
      const weekChannel = w.channels.find((c) => c.deal_channel_id === channel.deal_channel_id);
      return {
        startDate: w.start_date,
        endDate: w.end_date,
        weekLabel: fmtWeekLabel(w.start_date, w.end_date),
        leadsPer100ChannelDays: weekChannel?.leads_per_100_channel_listing_days ?? null,
      };
    }),
  }));
}
