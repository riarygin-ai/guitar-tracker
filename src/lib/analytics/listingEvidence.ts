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

// Top-level contract check only (mirrors isValidAnalyticsSnapshot's own
// scope) — does not validate every nested array's shape in detail.
export interface ListingEvidence {
  schema_version: string;
  generated_at: string;
  evidence_scope: string;
  listing_age_semantics: Record<string, unknown>;
  population_summary: Record<string, unknown>;
  channel_summary: unknown[];
  category_channel_matrix: Record<string, unknown>;
  cross_listing_evidence: Record<string, unknown>;
  listed_items: unknown[];
  unlisted_open_inventory: Record<string, unknown>;
  purpose_semantics: Record<string, unknown>;
  reconciliation: unknown[];
  module_limitations: unknown[];
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
