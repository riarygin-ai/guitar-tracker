// Server-only module. Never import this in client components. Constructs no
// Supabase client of its own — the caller (the API route) supplies an
// already-authenticated caller's resolved app_users.id and a service-role
// client, exactly like src/lib/analytics/runAnalytics.ts does for Analytics.
//
// Listing Evidence v1.0 is evidence-only and unrelated to the analytics_runs
// persistence model: build_listing_evidence_v1_0 is a pure, on-demand
// STABLE SQL function (no writes, nothing persisted), so this wrapper is a
// thin RPC call — the SQL migration (20260904000000_build_listing_evidence_
// v1_0.sql) carries the actual evidence logic, matching this schema's own
// build_analytics_snapshot_vX convention of heavy SQL / thin TypeScript call
// site.

import type { SupabaseClient } from '@supabase/supabase-js';

export const LISTING_EVIDENCE_SCHEMA_VERSION = '1.0';
const BUILDER_RPC = 'build_listing_evidence_v1_0';

export class ListingEvidenceError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(publicMessage: string, status: number) {
    super(publicMessage);
    this.name = 'ListingEvidenceError';
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

// ── Precise nested shapes ────────────────────────────────────────────────
// Field names here are reproduced verbatim from supabase/migrations/
// 20260904000000_build_listing_evidence_v1_0.sql's jsonb_build_object
// calls — this file is the single TypeScript source of truth for that
// contract; every consumer (Listing Dashboard, Analysis Packet, Inventory
// drill-down) imports these types rather than re-declaring its own shape.

export type ListingAgeBucketCode = 'LT_14' | 'D14_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';
export type PurposeBucket = 'business' | 'hybrid' | 'personal' | 'unclassified';

export interface ListingAgeBucketDef {
  code: ListingAgeBucketCode;
  label: string;
  min_days: number;
  max_days: number | null;
}

export interface ListingAgeSemantics {
  definition: string;
  timezone_convention: string;
  buckets: ListingAgeBucketDef[];
}

export interface PurposeCount {
  purpose_bucket: PurposeBucket;
  item_count: number;
}

export interface ListingAgeCoverage {
  age_available_count: number;
  age_missing_count: number;
  age_invalid_count: number;
}

export interface PopulationSummary {
  open_item_count: number;
  distinct_listed_item_count: number;
  distinct_unlisted_open_item_count: number;
  active_channel_listing_count: number;
  cross_listed_item_count: number;
  total_active_asking_value: number | null;
  listed_cost_basis: number | null;
  listed_estimated_sold_value: number | null;
  listed_estimated_equity: number | null;
  listing_age_coverage: ListingAgeCoverage;
  stale_active_listings_excluded_count: number;
  open_item_count_by_purpose: PurposeCount[];
  listed_item_count_by_purpose: PurposeCount[];
  unlisted_item_count_by_purpose: PurposeCount[];
}

export interface CategoryBreakdownEntry {
  category_id: number | null;
  category_name: string | null;
  listed_item_count: number;
  asking_value: number | null;
  cost_basis: number | null;
  estimated_sold_value: number | null;
}

export interface TypeBreakdownEntry {
  type_id: number | null;
  type_name: string | null;
  listed_item_count: number;
  asking_value: number | null;
  cost_basis: number | null;
  estimated_sold_value: number | null;
}

export interface PurposeBreakdownEntry {
  purpose_bucket: PurposeBucket;
  listed_item_count: number;
  asking_value: number | null;
  cost_basis: number | null;
  estimated_sold_value: number | null;
}

export interface AgeBucketBreakdownEntry {
  bucket_code: ListingAgeBucketCode;
  item_count: number;
}

export interface ChannelSummaryEntry {
  channel_id: number;
  channel_name: string;
  listed_item_count: number;
  asking_value: number | null;
  cost_basis: number | null;
  estimated_sold_value: number | null;
  estimated_equity: number | null;
  listing_age_sample_size: number;
  median_current_listing_age_days: number | null;
  p75_current_listing_age_days: number | null;
  oldest_current_listing_age_days: number | null;
  category_breakdown: CategoryBreakdownEntry[];
  type_breakdown: TypeBreakdownEntry[];
  purpose_breakdown: PurposeBreakdownEntry[];
  listing_age_bucket_breakdown: AgeBucketBreakdownEntry[];
}

export interface CategoryChannelMatrixRow {
  category_id: number | null;
  category_name: string | null;
  channel_id: number;
  channel_name: string;
  listed_item_count: number;
  asking_value: number | null;
  cost_basis: number | null;
  estimated_sold_value: number | null;
}

export interface CategoryTotal {
  category_id: number | null;
  category_name: string | null;
  distinct_listed_item_count: number;
}

export interface CategoryChannelMatrix {
  rows: CategoryChannelMatrixRow[];
  category_totals: CategoryTotal[];
}

export interface CrossListingChannelCountBucket {
  active_channel_count: string; // '1' | '2' | '3_plus'
  item_count: number;
}

export interface CrossListingCombination {
  channel_ids: number[];
  channel_names: string[];
  label: string;
  item_count: number;
}

export interface CrossListingEvidence {
  by_active_channel_count: CrossListingChannelCountBucket[];
  max_active_channel_count: number;
  combinations: CrossListingCombination[];
}

export interface ActiveListingEntry {
  channel_id: number;
  channel_name: string;
  asking_price: number | null;
  currency: string;
  listed_at: string;
  current_listing_age_days: number | null;
  listing_age_bucket: ListingAgeBucketCode | 'INVALID' | null;
}

export interface PreviousListingCycleEntry {
  channel_id: number;
  channel_name: string;
  completed_cycle_count: number;
}

export interface LiquidityContext {
  comparable_evidence_available: boolean;
  comparable_median_dom: number | null;
  comparable_p75_dom: number | null;
}

// Fields common to both listed and unlisted item evidence rows.
export interface BaseItemEvidence {
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
  disposition_mode: string | null;
  acquisition_value: number | null;
  inventory_expenses: number;
  cost_basis: number | null;
  estimated_sold_value: number | null;
  estimated_net_upside: number | null;
  estimated_upside_percent: number | null;
  acquisition_method: string | null;
  is_historical_import: boolean;
  acquisition_date: string | null;
  reliable_ownership_age_days: number | null;
  liquidity_context: LiquidityContext;
}

export interface ListedItemEvidence extends BaseItemEvidence {
  active_channel_count: number;
  active_listings: ActiveListingEntry[];
  previous_listing_cycles_by_channel: PreviousListingCycleEntry[];
}

export type UnlistedItemEvidence = BaseItemEvidence;

export interface PersonalSummary {
  personal_open_item_count: number;
  personal_listed_item_count: number;
  personal_unlisted_item_count: number;
  excluded_from_listing_candidate_analysis: true;
}

export interface UnlistedOpenInventory {
  business: UnlistedItemEvidence[];
  hybrid: UnlistedItemEvidence[];
  unclassified: UnlistedItemEvidence[];
  personal_summary: PersonalSummary;
}

export interface PurposePolicyEntry {
  disposition_mode: string;
  description: string;
  realization_priority_order: number;
  active_realization_flag: boolean;
  expected_holding_policy: string;
}

export interface PurposeSemantics {
  business: PurposePolicyEntry;
  hybrid: PurposePolicyEntry;
  personal: PurposePolicyEntry;
  guardrails: string[];
}

export interface ReconciliationCheck {
  check: string;
  expected: number;
  actual: number;
  passed: boolean;
}

// Top-level contract. Nested arrays/objects are typed precisely above —
// this is the single TypeScript source of truth for the Listing Evidence
// v1.0 shape (mirrors isValidListingEvidence's own runtime checks below).
export interface ListingEvidence {
  schema_version: string;
  generated_at: string;
  evidence_scope: string;
  listing_age_semantics: ListingAgeSemantics;
  population_summary: PopulationSummary;
  channel_summary: ChannelSummaryEntry[];
  category_channel_matrix: CategoryChannelMatrix;
  cross_listing_evidence: CrossListingEvidence;
  listed_items: ListedItemEvidence[];
  unlisted_open_inventory: UnlistedOpenInventory;
  purpose_semantics: PurposeSemantics;
  reconciliation: ReconciliationCheck[];
  module_limitations: string[];
}

export function isValidListingEvidence(value: unknown): value is ListingEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schema_version === LISTING_EVIDENCE_SCHEMA_VERSION &&
    typeof v.generated_at === 'string' &&
    typeof v.evidence_scope === 'string' &&
    typeof v.population_summary === 'object' && v.population_summary !== null &&
    Array.isArray(v.channel_summary) &&
    typeof v.category_channel_matrix === 'object' && v.category_channel_matrix !== null &&
    typeof v.cross_listing_evidence === 'object' && v.cross_listing_evidence !== null &&
    Array.isArray(v.listed_items) &&
    typeof v.unlisted_open_inventory === 'object' && v.unlisted_open_inventory !== null &&
    typeof v.purpose_semantics === 'object' && v.purpose_semantics !== null &&
    Array.isArray(v.reconciliation)
  );
}

/**
 * Computes Listing Evidence v1.0 for exactly one target user — always the
 * caller's own resolved app_users.id, never a client-suppliable value. No
 * persistence: this is a pure on-demand read, unlike runAnalyticsForCurrentUser.
 */
export async function getListingEvidenceForCurrentUser(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
}): Promise<ListingEvidence> {
  const { appUserId, serviceClient } = params;

  const { data, error } = await serviceClient.rpc(BUILDER_RPC, {
    p_target_user_id: appUserId,
  });

  if (error) {
    console.error('[listingEvidence] build_listing_evidence_v1_0 failed:', error.message);
    throw new ListingEvidenceError('Failed to compute listing evidence', 500);
  }

  if (!isValidListingEvidence(data)) {
    console.error('[listingEvidence] build_listing_evidence_v1_0 returned an unexpected shape');
    throw new ListingEvidenceError('Listing evidence computation returned an unexpected shape', 500);
  }

  return data;
}
