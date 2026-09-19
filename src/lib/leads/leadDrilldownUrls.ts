// /listings -> /leads drill-down URL builders. Every date and count comes
// straight from Listing Demand Evidence rows (weekly_trend entries and
// evidence.period) — nothing here computes its own date boundary.
//
// Semantics (must stay in step with the evidence):
//  • Market Activity weekly Leads     = leads_started: ALL leads whose
//    first_contact_at is in [week start, week end]; no channel attribution.
//  • Market Activity weekly Serious+  = the same window, lead_quality in
//    (SERIOUS, HIGH_INTENT).
//  • Channel Attributed Leads         = CHANNEL-ATTRIBUTED cohort: that
//    normalized channel, first_contact_at in the current evidence period,
//    AND listing exposure for that item+channel on first_contact_at
//    (`attributed=1`, resolved server-side by
//    lead_drilldown_channel_attributed_ids_v1_0).
//  • Channel Serious+                 = the same attributed cohort,
//    serious_plus=1.
// A zero count returns null: no link to an empty list.

import { leadsUrl } from './leadFilters';

export interface WeekDrillSource {
  startDate: string;
  endDate: string;
  leadsStarted: number;
  seriousPlusLeads: number;
}

export interface ChannelDrillSource {
  dealChannelId: number;
  attributedLeads: number;
  seriousPlusLeads: number;
}

export interface DrillPeriod {
  startDate: string;
  endDate: string;
}

export function marketWeekLeadsUrl(week: WeekDrillSource, returnTo?: string | null): string | null {
  if (week.leadsStarted <= 0) return null;
  return leadsUrl({ from: week.startDate, to: week.endDate, expected: week.leadsStarted, returnTo: returnTo ?? null });
}

export function marketWeekSeriousPlusUrl(week: WeekDrillSource, returnTo?: string | null): string | null {
  if (week.seriousPlusLeads <= 0) return null;
  return leadsUrl({ from: week.startDate, to: week.endDate, seriousPlus: true, expected: week.seriousPlusLeads, returnTo: returnTo ?? null });
}

export function channelAttributedLeadsUrl(period: DrillPeriod, channel: ChannelDrillSource, returnTo?: string | null): string | null {
  if (channel.attributedLeads <= 0) return null;
  return leadsUrl({ channel: channel.dealChannelId, from: period.startDate, to: period.endDate, attributed: true, expected: channel.attributedLeads, returnTo: returnTo ?? null });
}

export function channelSeriousPlusUrl(period: DrillPeriod, channel: ChannelDrillSource, returnTo?: string | null): string | null {
  if (channel.seriousPlusLeads <= 0) return null;
  return leadsUrl({ channel: channel.dealChannelId, from: period.startDate, to: period.endDate, attributed: true, seriousPlus: true, expected: channel.seriousPlusLeads, returnTo: returnTo ?? null });
}

// ── Item drill-downs (Lead Activity by Item) ─────────────────────────────
// ITEM-attributed cohort (`item_attributed=1`): that inventory item,
// first_contact_at in the exact Trend Window, AND listing exposure for the
// item (any channel) on first_contact_at — resolved server-side by
// lead_drilldown_item_attributed_ids_v1_0. No normalized channel needed.

export interface ItemDrillSource {
  itemId: number;
  leads: number;
  seriousPlus: number;
  offers: number;
}

export function itemAttributedLeadsUrl(window: { from: string; to: string }, item: ItemDrillSource, returnTo?: string | null): string | null {
  if (item.leads <= 0) return null;
  return leadsUrl({ itemId: item.itemId, from: window.from, to: window.to, itemAttributed: true, expected: item.leads, returnTo: returnTo ?? null });
}

export function itemSeriousPlusUrl(window: { from: string; to: string }, item: ItemDrillSource, returnTo?: string | null): string | null {
  if (item.seriousPlus <= 0) return null;
  return leadsUrl({ itemId: item.itemId, from: window.from, to: window.to, itemAttributed: true, seriousPlus: true, expected: item.seriousPlus, returnTo: returnTo ?? null });
}

export function itemOffersUrl(window: { from: string; to: string }, item: ItemDrillSource, returnTo?: string | null): string | null {
  if (item.offers <= 0) return null;
  return leadsUrl({ itemId: item.itemId, from: window.from, to: window.to, itemAttributed: true, offers: true, expected: item.offers, returnTo: returnTo ?? null });
}
