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

export function marketWeekLeadsUrl(week: WeekDrillSource): string | null {
  if (week.leadsStarted <= 0) return null;
  return leadsUrl({ from: week.startDate, to: week.endDate, expected: week.leadsStarted });
}

export function marketWeekSeriousPlusUrl(week: WeekDrillSource): string | null {
  if (week.seriousPlusLeads <= 0) return null;
  return leadsUrl({ from: week.startDate, to: week.endDate, seriousPlus: true, expected: week.seriousPlusLeads });
}

export function channelAttributedLeadsUrl(period: DrillPeriod, channel: ChannelDrillSource): string | null {
  if (channel.attributedLeads <= 0) return null;
  return leadsUrl({ channel: channel.dealChannelId, from: period.startDate, to: period.endDate, attributed: true, expected: channel.attributedLeads });
}

export function channelSeriousPlusUrl(period: DrillPeriod, channel: ChannelDrillSource): string | null {
  if (channel.seriousPlusLeads <= 0) return null;
  return leadsUrl({ channel: channel.dealChannelId, from: period.startDate, to: period.endDate, attributed: true, seriousPlus: true, expected: channel.seriousPlusLeads });
}
