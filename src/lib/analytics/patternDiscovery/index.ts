// Pattern Discovery Engine v1.0 — top-level entry point.
//
// ── Layering ──────────────────────────────────────────────────────────
// 1. Analytics SQL v2.13 (target_user_pattern_discovery_evidence) produces
//    factual aggregate evidence — 13 curated candidate-segment families,
//    no ranking, no selection, no recommendation (see supabase/migrations/
//    20260824000000_build_analytics_snapshot_v2_13.sql).
// 2. Insights Engine v1.8 (src/lib/analytics/insights/) produces fixed,
//    predefined findings from a DIFFERENT set of Analytics sections. This
//    engine never reads, alters, or depends on Insights' selected
//    findings or rule evaluations — the two run independently and their
//    outputs are merged side-by-side by runAnalytics.ts, never combined.
// 3. THIS module (Pattern Discovery Engine v1.0) searches v2.13's
//    candidate_segments for novel, deterministic, association-only
//    patterns the fixed Insights rules don't already cover.
//
// This module reads ONLY target_user_pattern_discovery_evidence. It never
// reads target_user_open_inventory_evidence, any other Analytics section,
// item-level data, open inventory, Personal holding intent, raw deals,
// raw listings, notes, photos, item names, or item IDs — v2.13's own
// evidence already excludes every one of those (see that migration's own
// privacy contract), and this module adds no additional data source.
//
// Pure function of its input evidence (aside from generated_at). Never
// throws — missing or malformed evidence yields status =
// 'evidence_unavailable' with empty selected_patterns/emerging_hypotheses
// and explicit validation reasons recorded in `limitations`, never an
// exception.

import { parseEvidence } from './parseEvidence';
import { selectPatterns } from './selectPatterns';
import { ENGINE_VERSION, GLOBAL_LIMITATIONS, SCHEMA_VERSION, SOURCE_ANALYTICS_VERSION } from './thresholds';
import type { PatternDiscoverySection, PatternDiscoverySelectionSummary } from './types';

function emptySelectionSummary(noPatternReasons: PatternDiscoverySelectionSummary['no_pattern_reasons']): PatternDiscoverySelectionSummary {
  return {
    total_candidate_segment_count: 0,
    evaluated_candidate_count: 0,
    fixed_family_suppressed_count: 0,
    ineligible_count: 0,
    confirmed_qualifying_count: 0,
    selected_pattern_count: 0,
    emerging_hypothesis_count: 0,
    peer_group_suppressed_count: 0,
    family_suppressed_count: 0,
    global_limit_suppressed_count: 0,
    family_counts: {},
    pattern_type_counts: {},
    no_pattern_reasons: noPatternReasons,
  };
}

/**
 * Runs Pattern Discovery Engine v1.0 against Analytics v2.13's
 * target_user_pattern_discovery_evidence (pass the raw, already-parsed-
 * from-JSON snapshot value — this function does its own defensive
 * validation and never assumes the caller already checked its shape).
 */
export function runPatternDiscovery(rawTargetUserPatternDiscoveryEvidence: unknown): PatternDiscoverySection {
  const generatedAt = new Date().toISOString();
  const { evidence, validationReasons } = parseEvidence(rawTargetUserPatternDiscoveryEvidence);

  if (evidence === null) {
    return {
      schema_version: SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      source_analytics_version: SOURCE_ANALYTICS_VERSION,
      generated_at: generatedAt,
      status: 'evidence_unavailable',
      selection_summary: emptySelectionSummary(['EVIDENCE_UNAVAILABLE']),
      selected_patterns: [],
      emerging_hypotheses: [],
      candidate_evaluations: [],
      limitations: [...GLOBAL_LIMITATIONS, ...validationReasons],
    };
  }

  const { selected_patterns, emerging_hypotheses, candidate_evaluations, selection_summary } = selectPatterns(evidence);

  const status: PatternDiscoverySection['status'] =
    selected_patterns.length === 0 && emerging_hypotheses.length === 0 ? 'no_eligible_patterns' : 'completed';

  return {
    schema_version: SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    source_analytics_version: SOURCE_ANALYTICS_VERSION,
    generated_at: generatedAt,
    status,
    selection_summary,
    selected_patterns,
    emerging_hypotheses,
    candidate_evaluations,
    limitations: [...GLOBAL_LIMITATIONS, ...validationReasons],
  };
}

export type {
  PatternDiscoverySection,
  SelectedPattern,
  EmergingHypothesis,
  PatternDiscoveryCandidateEvaluation,
  PatternDiscoverySelectionSummary,
  MetricEffect,
  PatternType,
  PatternDirection,
  ConfidenceTier,
} from './types';
