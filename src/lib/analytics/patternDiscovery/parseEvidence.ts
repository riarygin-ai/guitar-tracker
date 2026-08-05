// Pattern Discovery Engine v1.0 — defensive parsing of raw target_user_
// pattern_discovery_evidence into typed candidate segments. Never throws:
// missing or malformed evidence yields an empty candidate list plus
// explicit, human-readable validation reasons — the caller (index.ts) is
// responsible for turning that into status = 'evidence_unavailable'.

import type { ConfidenceTier, PatternDiscoveryCandidateSegment, PatternDiscoveryEvidence } from './types';

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toNonNegativeInt(value: unknown): number {
  const n = toNumber(value);
  return n !== null && n >= 0 ? Math.round(n) : 0;
}

export function toConfidenceTier(value: unknown): ConfidenceTier | null {
  return value === 'insufficient' || value === 'low' || value === 'moderate' || value === 'stronger' ? value : null;
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// ── Median — of aggregate segment metrics, never raw items. A median of
// peer-segment medians, not an item-level portfolio median. ─────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseCandidateSegment(raw: unknown): PatternDiscoveryCandidateSegment | null {
  const r = toRecord(raw);
  if (!r) return null;

  const familyCode = typeof r.family_code === 'string' ? r.family_code : null;
  const patternKey = typeof r.pattern_key === 'string' ? r.pattern_key : null;
  const peerGroupKey = typeof r.peer_group_key === 'string' ? r.peer_group_key : null;
  const populationBasis = typeof r.population_basis === 'string' ? r.population_basis : null;
  const segment = toRecord(r.segment);
  const comparisonScope = toRecord(r.comparison_scope);
  if (familyCode === null || patternKey === null || peerGroupKey === null || populationBasis === null || segment === null) {
    return null;
  }

  return {
    family_code: familyCode,
    pattern_key: patternKey,
    peer_group_key: peerGroupKey,
    comparison_scope: comparisonScope ?? {},
    dimension_count: toNonNegativeInt(r.dimension_count) || 1,
    population_basis: populationBasis,
    segment,
    realized_item_count: toNonNegativeInt(r.realized_item_count),
    distinct_exit_deal_count: toNonNegativeInt(r.distinct_exit_deal_count),
    profit_sample_size: toNonNegativeInt(r.profit_sample_size),
    roi_sample_size: toNonNegativeInt(r.roi_sample_size),
    dom_sample_size: toNonNegativeInt(r.dom_sample_size),
    median_net_profit: toNumber(r.median_net_profit),
    median_roi: toNumber(r.median_roi),
    median_days_on_market: toNumber(r.median_days_on_market),
    invalid_dom_count: toNonNegativeInt(r.invalid_dom_count),
    missing_dom_count: toNonNegativeInt(r.missing_dom_count),
    historical_import_item_count: toNonNegativeInt(r.historical_import_item_count),
    app_tracked_item_count: toNonNegativeInt(r.app_tracked_item_count),
    historical_import_percent: toNumber(r.historical_import_percent),
    confidence: toConfidenceTier(r.confidence),
    limitations: toStringArray(r.limitations),
  };
}

export interface ParsedEvidenceResult {
  evidence: PatternDiscoveryEvidence | null;
  validationReasons: string[];
}

/**
 * Never throws. Missing/malformed evidence (wrong shape, no candidate_
 * segments array, etc.) yields evidence: null plus explicit validation
 * reasons — the caller reports status = 'evidence_unavailable' rather than
 * crashing or silently fabricating an empty-but-"valid" evidence object.
 */
export function parseEvidence(raw: unknown): ParsedEvidenceResult {
  const reasons: string[] = [];
  const r = toRecord(raw);
  if (!r) {
    return { evidence: null, validationReasons: ['TARGET_USER_PATTERN_DISCOVERY_EVIDENCE_MISSING_OR_NOT_AN_OBJECT'] };
  }

  const schemaVersion = typeof r.schema_version === 'string' ? r.schema_version : null;
  if (schemaVersion === null) reasons.push('SCHEMA_VERSION_MISSING');

  const rawSegments = Array.isArray(r.candidate_segments) ? r.candidate_segments : null;
  if (rawSegments === null) reasons.push('CANDIDATE_SEGMENTS_MISSING_OR_NOT_AN_ARRAY');

  const populationSummary = toRecord(r.population_summary);
  if (populationSummary === null) reasons.push('POPULATION_SUMMARY_MISSING_OR_NOT_AN_OBJECT');

  const coverageSummary = toRecord(r.coverage_summary);
  if (coverageSummary === null) reasons.push('COVERAGE_SUMMARY_MISSING_OR_NOT_AN_OBJECT');

  const familySummary = Array.isArray(r.family_summary) ? (r.family_summary as Record<string, unknown>[]) : null;
  if (familySummary === null) reasons.push('FAMILY_SUMMARY_MISSING_OR_NOT_AN_ARRAY');

  if (reasons.length > 0) {
    return { evidence: null, validationReasons: reasons };
  }

  const candidateSegments: PatternDiscoveryCandidateSegment[] = [];
  let malformedRowCount = 0;
  for (const row of rawSegments!) {
    const parsed = parseCandidateSegment(row);
    if (parsed) candidateSegments.push(parsed);
    else malformedRowCount++;
  }

  if (candidateSegments.length === 0) {
    return {
      evidence: null,
      validationReasons: malformedRowCount > 0 ? ['ALL_CANDIDATE_SEGMENT_ROWS_MALFORMED'] : ['CANDIDATE_SEGMENTS_EMPTY'],
    };
  }

  return {
    evidence: {
      schema_version: schemaVersion as string,
      population_summary: populationSummary as Record<string, unknown>,
      candidate_segments: candidateSegments,
      family_summary: familySummary as Record<string, unknown>[],
      coverage_summary: coverageSummary as Record<string, unknown>,
      module_limitations: toStringArray(r.module_limitations),
    },
    validationReasons: malformedRowCount > 0 ? [`${malformedRowCount}_CANDIDATE_SEGMENT_ROWS_MALFORMED_AND_SKIPPED`] : [],
  };
}
