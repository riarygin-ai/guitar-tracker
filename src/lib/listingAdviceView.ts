// Pure, client-safe view helpers for the /listings "Listing Advice" section
// and its detail drawer. Everything here works ONLY from the PERSISTED
// packet/output of the advice run being shown — evidence is resolved from
// the exact packet the model saw (never re-queried), and navigation actions
// are built from cited source metadata via the existing lead drill-down URL
// helpers (never from model-written URLs).

import type { ListingAdviceCard, ListingAdvicePacket, ListingAdviceType } from './analytics/listingAdvice/listingAdvice';
import type { CoachChannel, CoachItem, CoachMarketWeek, ListingDemandContext } from './analytics/advice/listingDemandContext';
import {
  channelAttributedLeadsUrl, itemAttributedLeadsUrl, marketWeekLeadsUrl,
} from './leads/leadDrilldownUrls';
import { fmtRate, fmtWeekLabel } from './listingDemandDashboardHelpers';
import { fmtLeadDate } from './leads/leadFormat';
import { safeReturnTo } from './listingsReturn';

export const ADVICE_TYPE_LABEL: Record<ListingAdviceType, string> = {
  action: 'Action',
  observation: 'Observation',
  watch: 'Watch',
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  stronger: 'Stronger evidence',
  moderate: 'Moderate evidence',
  low: 'Low confidence',
  preliminary: 'Preliminary',
};

export function formatWindowLabel(start: string, end: string): string {
  return fmtWeekLabel(start, end);
}

export function formatGeneratedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// ── Evidence resolved from the persisted packet ─────────────────────────────

export interface EvidenceBlock {
  sourceId: string;
  kind: 'market' | 'channel' | 'item' | 'data_quality' | 'insight' | 'pattern' | 'hypothesis';
  title: string;
  /** Optional small label above the title (e.g. "Deterministic insight"). */
  badge?: string;
  /** Optional persisted prose (headline summary) for non-demand sources. */
  text?: string;
  /** Short headline facts (label -> value). */
  facts: { label: string; value: string }[];
  /** Per-week factual lines (market / channel). */
  weeks: string[];
}

const n = (v: number | null | undefined): string => (v == null ? '—' : String(v));

function marketWeekLine(w: CoachMarketWeek): string {
  return `${fmtWeekLabel(w.start_date, w.end_date)} · ${w.leads_started} leads · ${w.serious_plus_leads_from_cohort} Serious+ · exposure ${fmtRate(w.avg_channel_exposure)} avg · ${fmtRate(w.leads_per_100_channel_listing_days)} leads/100 channel-days · ${w.realized_deal_count} realized deals`;
}

function channelWeekLine(w: CoachChannel['weeks'][number]): string {
  return `Week of ${fmtLeadDate(w.start_date)} · ${w.channel_listing_days} channel-days · ${w.channel_attributed_leads} leads · ${w.serious_plus_attributed_leads_from_cohort} Serious+ · ${fmtRate(w.leads_per_100_channel_listing_days)} leads/100 channel-days · ${w.realized_deal_count_by_recorded_channel} realized deals (recorded channel)`;
}

/** Minimal shape the demand resolvers need — satisfied by both the Listing Advice packet and the Coach packet. */
export interface DemandPacketLike { listing_demand: ListingDemandContext }

function findItem(packet: DemandPacketLike, id: string): CoachItem | undefined {
  const { highest_activity, zero_activity_high_exposure } = packet.listing_demand.items;
  return [...highest_activity, ...zero_activity_high_exposure].find((i) => i.source_id === id);
}

/** Resolves one cited source id to concise deterministic facts, from the persisted packet only. */
export function resolveEvidence(packet: DemandPacketLike, sourceId: string): EvidenceBlock | null {
  const ld = packet.listing_demand;
  if (sourceId === ld.market_trend.source_id) {
    return { sourceId, kind: 'market', title: `Market trend — ${fmtWeekLabel(ld.start_date, ld.end_date)}`, facts: [], weeks: ld.market_trend.weeks.map(marketWeekLine) };
  }
  const channel = ld.channels.find((c) => c.source_id === sourceId);
  if (channel) {
    return { sourceId, kind: 'channel', title: `${channel.channel_name} — channel activity`, facts: [], weeks: channel.weeks.map(channelWeekLine) };
  }
  const item = findItem(packet, sourceId);
  if (item) {
    return {
      sourceId, kind: 'item', title: item.item_display_name,
      facts: [
        { label: 'Attributed leads', value: n(item.item_attributed_leads) },
        { label: 'Serious+', value: n(item.serious_plus_attributed_leads) },
        { label: 'Offers', value: n(item.offer_attributed_leads) },
        { label: 'Channel-days', value: n(item.channel_listing_days) },
        { label: 'Item-days', value: n(item.item_listing_days) },
        { label: 'Last lead', value: item.last_attributed_lead_date ? fmtLeadDate(item.last_attributed_lead_date) : '—' },
        { label: 'Active channels', value: item.current_active_channels.join(' · ') || '—' },
      ],
      weeks: [],
    };
  }
  if (sourceId === ld.data_quality.source_id) {
    const dq = ld.data_quality;
    return {
      sourceId, kind: 'data_quality', title: 'Data quality',
      facts: [
        { label: `Item attribution (${fmtLeadDate(dq.most_recent_7_day_period.start_date)}–${fmtLeadDate(dq.most_recent_7_day_period.end_date)})`, value: dq.most_recent_7_day_period.item_attribution_pct == null ? '—' : `${dq.most_recent_7_day_period.item_attribution_pct}%` },
        { label: 'Channel attribution', value: dq.most_recent_7_day_period.channel_attribution_pct == null ? '—' : `${dq.most_recent_7_day_period.channel_attribution_pct}%` },
        { label: 'Undated leads', value: String(dq.undated_lead_count) },
        { label: 'Earliest dated lead', value: dq.earliest_dated_lead ? fmtLeadDate(dq.earliest_dated_lead) : '—' },
      ],
      weeks: [],
    };
  }
  return null;
}

export function resolveCardEvidence(card: ListingAdviceCard, packet: ListingAdvicePacket): EvidenceBlock[] {
  return card.source_ids.map((id) => resolveEvidence(packet, id)).filter((b): b is EvidenceBlock => b !== null);
}

/** The card's own limitations, plus the standing data-quality limitations when it cites data quality. */
export function relevantLimitations(card: ListingAdviceCard, packet: ListingAdvicePacket): string[] {
  const out = [...card.limitations];
  if (card.source_ids.includes(packet.listing_demand.data_quality.source_id)) {
    for (const l of packet.listing_demand.data_quality.limitations) if (!out.includes(l)) out.push(l);
  }
  return out;
}

// ── Deterministic navigation actions (from cited source metadata) ──────────

export interface AdviceAction {
  label: string;
  href: string;
  kind: 'open_item' | 'view_leads';
  /** What the action is about (item / channel name) — for accessible names. */
  subject: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Open Item / View Leads actions for the sources a card cites. Lead links use
 * the PERSISTED 4-week window from the packet (so they match what the model
 * saw) plus the exact cohort flags: item -> item_id + item_attributed=1,
 * channel -> channel_id + attributed=1, market -> the whole window. Zero-count
 * sources yield no link. There is deliberately no Deals action (no lead->deal
 * linkage exists).
 */
export function adviceActions(card: { source_ids: string[] }, packet: DemandPacketLike, callerReturnTo: string | null): AdviceAction[] {
  // The CALLER supplies where /leads should return to (Listings, Dashboard, ...);
  // it is re-validated here with the shared allowlist so an unsafe value can
  // never be embedded in a drill-down URL (it is dropped instead).
  const returnTo = safeReturnTo(callerReturnTo);
  const ld = packet.listing_demand;
  const window = { from: ld.start_date, to: ld.end_date };
  const period = { startDate: ld.start_date, endDate: ld.end_date };
  const out: AdviceAction[] = [];
  const seen = new Set<string>();
  const push = (a: AdviceAction) => { if (!seen.has(a.href)) { seen.add(a.href); out.push(a); } };

  for (const id of card.source_ids) {
    const item = findItem(packet, id);
    if (item) {
      push({ label: 'Open Item', href: `/inventory/${item.item_id}`, kind: 'open_item', subject: item.item_display_name });
      const url = itemAttributedLeadsUrl(window, { itemId: item.item_id, leads: item.item_attributed_leads, seriousPlus: item.serious_plus_attributed_leads, offers: item.offer_attributed_leads }, returnTo);
      if (url) push({ label: 'View Leads', href: url, kind: 'view_leads', subject: item.item_display_name });
      continue;
    }
    const channel = ld.channels.find((c) => c.source_id === id);
    if (channel) {
      const url = channelAttributedLeadsUrl(period, {
        dealChannelId: channel.channel_id,
        attributedLeads: sum(channel.weeks.map((w) => w.channel_attributed_leads)),
        seriousPlusLeads: sum(channel.weeks.map((w) => w.serious_plus_attributed_leads_from_cohort)),
      }, returnTo);
      if (url) push({ label: 'View Leads', href: url, kind: 'view_leads', subject: channel.channel_name });
      continue;
    }
    if (id === ld.market_trend.source_id) {
      const weeks = ld.market_trend.weeks;
      const url = marketWeekLeadsUrl({
        startDate: ld.start_date, endDate: ld.end_date,
        leadsStarted: sum(weeks.map((w) => w.leads_started)),
        seriousPlusLeads: sum(weeks.map((w) => w.serious_plus_leads_from_cohort)),
      }, returnTo);
      if (url) push({ label: 'View Leads', href: url, kind: 'view_leads', subject: 'all leads in the 4-week window' });
    }
  }
  return out;
}
