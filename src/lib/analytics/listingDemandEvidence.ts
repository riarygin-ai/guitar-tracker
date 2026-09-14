// Server-only module. Never import this in client components. Constructs no
// Supabase client of its own — the caller (the API route) supplies an
// already-authenticated caller's resolved app_users.id and a service-role
// client, exactly like src/lib/analytics/listingEvidence.ts does.
//
// Listing Demand Evidence v1.0 is a pure, on-demand STABLE SQL function
// (no writes, nothing persisted, no scheduled jobs, no materialized
// aggregates) — this wrapper is a thin RPC call. The SQL migration
// (20260914000000_build_listing_demand_evidence_v1_0.sql) carries the
// actual evidence logic; this file is the single TypeScript source of
// truth for its JSON contract.

import type { SupabaseClient } from '@supabase/supabase-js';

export const LISTING_DEMAND_EVIDENCE_SCHEMA_VERSION = '1.0';
const BUILDER_RPC = 'build_listing_demand_evidence_v1_0';

export class ListingDemandEvidenceError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(publicMessage: string, status: number) {
    super(publicMessage);
    this.name = 'ListingDemandEvidenceError';
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

// ── Shapes — reproduced verbatim from build_listing_demand_evidence_v1_0's
// own jsonb_build_object calls (20260914000000). ───────────────────────────

export interface DemandPeriod {
  start_date: string;
  end_date: string;
  days: number;
}

export interface DemandAnalysisContext {
  primary_purposes: ['Business', 'Hybrid'];
  personal_policy: string;
  lead_quality_semantics: string;
  deal_linkage_semantics: string;
}

// Every field here is Business+Hybrid-scoped — see analysis_context and
// the module's own limitations array.
export interface DemandPeriodMetrics {
  item_listing_days: number;
  channel_listing_days: number;
  distinct_listed_item_count: number;
  avg_listed_items: number | null;
  avg_channel_exposure: number | null;
  exposure_multiplier: number | null;
  leads_started: number;
  item_attributed_leads: number;
  channel_attributed_leads: number;
  leads_with_normalized_channel: number;
  leads_without_normalized_channel: number;
  // "_from_cohort" — leads whose first_contact_at fell in this period;
  // quality/status/message fields describe the CURRENT/lifetime state of
  // that cohort, never a historical snapshot at first_contact_at.
  serious_plus_leads_from_cohort: number;
  high_intent_leads_from_cohort: number;
  completed_leads_from_cohort: number;
  cash_offer_leads_from_cohort: number;
  trade_offer_leads_from_cohort: number;
  mixed_offer_leads_from_cohort: number;
  buyer_messages_from_cohort: number;
  our_messages_from_cohort: number;
  leads_per_100_item_listing_days: number | null;
  leads_per_100_channel_listing_days: number | null;
  realized_deal_count: number;
  realized_item_count: number;
}

export interface DemandMetricChange {
  current: number | null;
  previous: number | null;
  absolute_change: number | null;
  percent_change: number | null;
}

export interface DemandSummaryChange {
  item_listing_days: DemandMetricChange;
  channel_listing_days: DemandMetricChange;
  avg_listed_items: DemandMetricChange;
  avg_channel_exposure: DemandMetricChange;
  leads_started: DemandMetricChange;
  item_attributed_leads: DemandMetricChange;
  channel_attributed_leads: DemandMetricChange;
  serious_plus_leads_from_cohort: DemandMetricChange;
  realized_deal_count: DemandMetricChange;
  realized_item_count: DemandMetricChange;
  leads_per_100_item_listing_days: DemandMetricChange;
  leads_per_100_channel_listing_days: DemandMetricChange;
}

export interface DemandSummary {
  current: DemandPeriodMetrics;
  previous: DemandPeriodMetrics;
  change: DemandSummaryChange;
}

export interface DemandChannelPeriodSlice {
  channel_listing_days: number;
  distinct_listed_items: number;
  channel_attributed_leads: number;
  serious_plus_attributed_leads_from_cohort: number;
  high_intent_attributed_leads_from_cohort: number;
  completed_leads_from_cohort: number;
  buyer_messages_from_attributed_lead_cohort: number;
  our_messages_from_attributed_lead_cohort: number;
  leads_per_100_channel_listing_days: number | null;
  // Lifetime fact (MAX over every dated lead for this channel), not
  // bounded to the period.
  last_lead_date: string | null;
  // Grouped by deals.deal_channel_id (a factual recorded field) —
  // deliberately NOT lead-attributed; see limitations.
  realized_deal_count_by_recorded_channel: number;
}

export interface DemandChannelEntry {
  deal_channel_id: number;
  channel_name: string;
  current: DemandChannelPeriodSlice;
  previous: DemandChannelPeriodSlice;
}

export interface DemandActiveChannelEntry {
  channel_id: number;
  channel_name: string;
  listed_at: string;
}

export interface DemandItemEntry {
  item_id: number;
  item_display_name: string;
  brand_id: number | null;
  brand_name: string | null;
  category_id: number | null;
  category_name: string | null;
  type_id: number | null;
  type_name: string | null;
  purpose_id: number | null;
  purpose_name: string | null;
  // Live/current fact — not period-scoped.
  current_active_channels: DemandActiveChannelEntry[];
  item_listing_days_in_period: number;
  channel_listing_days_in_period: number;
  leads_started_in_period: number;
  item_attributed_leads_in_period: number;
  channel_attributed_leads_in_period: number;
  serious_plus_leads_from_cohort: number;
  high_intent_leads_from_cohort: number;
  completed_leads_from_cohort: number;
  buyer_messages_from_cohort: number;
  our_messages_from_cohort: number;
  cash_offer_lead_count: number;
  trade_offer_lead_count: number;
  mixed_offer_lead_count: number;
  best_cash_offer_in_cohort: number | null;
  // Lifetime fact — not period-scoped.
  last_lead_date: string | null;
  // Leads attributable to the item's CURRENT active cycle(s) specifically
  // (from listed_at through today) — independent of the requested period.
  current_listing_cycle_leads: number;
}

export interface DemandPersonalSummary {
  listed_item_count: number;
  item_listing_days: number;
  channel_listing_days: number;
  leads_started: number;
}

export interface DemandDataQualityCurrentPeriod {
  leads_started: number;
  item_attributed_leads: number;
  channel_attributed_leads: number;
  item_attribution_pct: number | null;
  channel_attribution_pct: number | null;
  leads_with_normalized_channel: number;
  leads_without_normalized_channel: number;
}

export interface DemandDataQuality {
  current_period: DemandDataQualityCurrentPeriod;
  // Global/informational — not period-scoped.
  undated_lead_count: number;
  earliest_dated_lead: string | null;
  earliest_listing_exposure_date: string | null;
}

// Top-level contract — the single TypeScript source of truth for the
// Listing Demand Evidence v1.0 shape (mirrors isValidListingDemandEvidence's
// own runtime checks below).
export interface ListingDemandEvidence {
  schema_version: string;
  generated_at: string;
  target_user_id: number;
  period: DemandPeriod;
  comparison_period: DemandPeriod;
  analysis_context: DemandAnalysisContext;
  summary: DemandSummary;
  channels: DemandChannelEntry[];
  items: DemandItemEntry[];
  personal_summary: DemandPersonalSummary;
  data_quality: DemandDataQuality;
  limitations: string[];
}

export function isValidListingDemandEvidence(value: unknown): value is ListingDemandEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema_version === LISTING_DEMAND_EVIDENCE_SCHEMA_VERSION &&
    typeof v.generated_at === 'string' &&
    typeof v.target_user_id === 'number' &&
    typeof v.period === 'object' && v.period !== null &&
    typeof v.comparison_period === 'object' && v.comparison_period !== null &&
    typeof v.analysis_context === 'object' && v.analysis_context !== null &&
    typeof v.summary === 'object' && v.summary !== null &&
    Array.isArray(v.channels) &&
    Array.isArray(v.items) &&
    typeof v.personal_summary === 'object' && v.personal_summary !== null &&
    typeof v.data_quality === 'object' && v.data_quality !== null &&
    Array.isArray(v.limitations)
  );
}

export interface GetListingDemandEvidenceParams {
  appUserId: number;
  serviceClient: SupabaseClient;
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string;   // YYYY-MM-DD, inclusive
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Computes Listing Demand Evidence v1.0 for exactly one target user —
 * always the caller's own resolved app_users.id, never a client-suppliable
 * value. No persistence: this is a pure on-demand read, same convention as
 * getListingEvidenceForCurrentUser.
 */
export async function getListingDemandEvidence(params: GetListingDemandEvidenceParams): Promise<ListingDemandEvidence> {
  const { appUserId, serviceClient, startDate, endDate } = params;

  if (!DATE_ONLY_RE.test(startDate) || !DATE_ONLY_RE.test(endDate)) {
    throw new ListingDemandEvidenceError('start_date and end_date must be YYYY-MM-DD', 400);
  }
  if (startDate > endDate) {
    throw new ListingDemandEvidenceError('start_date must be on or before end_date', 400);
  }

  const { data, error } = await serviceClient.rpc(BUILDER_RPC, {
    p_target_user_id: appUserId,
    p_start_date: startDate,
    p_end_date: endDate,
  });

  if (error) {
    console.error('[listingDemandEvidence] build_listing_demand_evidence_v1_0 failed:', error.message);
    throw new ListingDemandEvidenceError('Failed to compute listing demand evidence', 500);
  }

  if (!isValidListingDemandEvidence(data)) {
    console.error('[listingDemandEvidence] build_listing_demand_evidence_v1_0 returned an unexpected shape');
    throw new ListingDemandEvidenceError('Listing demand evidence computation returned an unexpected shape', 500);
  }

  return data;
}
