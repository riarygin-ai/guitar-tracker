// Pattern Discovery Engine v1.0 — reusable types. This layer reads
// Analytics v2.13's target_user_pattern_discovery_evidence as read-only
// evidence and never recomputes or overrides any v2.13 value. Deliberately
// self-contained — does NOT import from src/lib/analytics/insights/ — so
// Pattern Discovery stays independently testable and never structurally
// couples to the fixed Insights rule set (see index.ts header for the full
// layering rationale).

export type ConfidenceTier = 'insufficient' | 'low' | 'moderate' | 'stronger';

// ── Candidate segment — one row of target_user_pattern_discovery_evidence.
// candidate_segments, exactly as Analytics v2.13 shapes it (see
// supabase/migrations/20260824000000_build_analytics_snapshot_v2_13.sql).
// Pattern Discovery treats this as read-only aggregate evidence — it never
// re-derives any of these fields from raw items/deals/listings. ─────────

export interface PatternDiscoveryCandidateSegment {
  family_code: string;
  pattern_key: string;
  peer_group_key: string;
  comparison_scope: Record<string, unknown>;
  dimension_count: number;
  population_basis: string;
  segment: Record<string, unknown>;
  realized_item_count: number;
  distinct_exit_deal_count: number;
  profit_sample_size: number;
  roi_sample_size: number;
  dom_sample_size: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  invalid_dom_count: number;
  missing_dom_count: number;
  historical_import_item_count: number;
  app_tracked_item_count: number;
  historical_import_percent: number | null;
  confidence: ConfidenceTier | null;
  limitations: string[];
}

export interface PatternDiscoveryEvidence {
  schema_version: string;
  population_summary: Record<string, unknown>;
  candidate_segments: PatternDiscoveryCandidateSegment[];
  family_summary: Record<string, unknown>[];
  coverage_summary: Record<string, unknown>;
  module_limitations: string[];
}

// ── Metric effects ──────────────────────────────────────────────────────
// Evaluated INDEPENDENTLY per metric — never a combined/weighted score.

export type MetricCode = 'median_net_profit' | 'median_roi' | 'median_days_on_market';

export type MetricDirection = 'improvement' | 'weakness' | 'neutral' | 'unavailable';

export interface MetricEffectThresholdsApplied {
  dimension_tier: 1 | 2;
  minimum_metric_sample_size: number;
  minimum_peer_segments: number;
  absolute_threshold: number | null;
  relative_threshold_percent: number | null;
}

export interface MetricEffect {
  metric_code: MetricCode;
  available: boolean;
  candidate_value: number | null;
  candidate_sample_size: number;
  peer_eligible_segment_count: number;
  peer_baseline_median: number | null;
  peer_minimum_sample_size: number | null;
  advantage_value: number | null;
  relative_advantage_percent: number | null;
  materiality: boolean;
  direction: MetricDirection;
  thresholds_applied: MetricEffectThresholdsApplied;
}

// ── Pattern classification ──────────────────────────────────────────────

export type PatternType =
  | 'BALANCED_STRENGTH'
  | 'ECONOMIC_ADVANTAGE'
  | 'SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY'
  | 'BALANCED_WEAKNESS'
  | 'ECONOMIC_WEAKNESS'
  | 'SLOW_WITHOUT_ECONOMIC_COMPENSATION'
  | 'ECONOMICS_SPEED_TRADEOFF';

export type PatternDirection = 'strength' | 'weakness' | 'tradeoff';

// ── Shared "core shape" — a selected pattern and an emerging hypothesis
// carry the identical set of these fields (the task's own "same core
// shape" requirement); EmergingHypothesis adds status/confirmation_needed/
// ineligibility_reasons on top. ──────────────────────────────────────────

export interface PatternDiscoveryCoreRow {
  pattern_code: string;
  family_code: string;
  pattern_key: string;
  peer_group_key: string;
  pattern_type: PatternType;
  direction: PatternDirection;
  headline: string;
  summary: string;
  segment: Record<string, unknown>;
  population_basis: string;
  evidence_confidence: ConfidenceTier;
  realized_item_count: number;
  distinct_exit_deal_count: number;
  metric_effects: MetricEffect[];
  triggered_signals: string[];
  limitations: string[];
  evidence_refs: string[];
}

export interface SelectedPattern extends PatternDiscoveryCoreRow {}

export interface EmergingHypothesis extends PatternDiscoveryCoreRow {
  status: 'hypothesis';
  confirmation_needed: string[];
  ineligibility_reasons: string[];
}

// ── Candidate evaluation — one row per candidate segment, always present
// (unlike selected_patterns/emerging_hypotheses, this array is exhaustive —
// every candidate_segments row gets exactly one evaluation row). ────────

export type CandidateEvaluationStatus = 'selected' | 'hypothesis' | 'not_selected' | 'ineligible' | 'suppressed';

export interface PatternDiscoveryCandidateEvaluation {
  family_code: string;
  pattern_key: string;
  peer_group_key: string;
  segment: Record<string, unknown>;
  status: CandidateEvaluationStatus;
  pattern_type: PatternType | null;
  evidence_confidence: ConfidenceTier | null;
  metric_effects: MetricEffect[];
  triggered_signals: string[];
  eligibility_failure_reasons: string[];
  suppression_reasons: string[];
  limitations: string[];
}

// ── Selection summary ────────────────────────────────────────────────────

export type NoPatternReason =
  | 'EVIDENCE_UNAVAILABLE'
  | 'NO_NOVEL_FAMILIES_AVAILABLE'
  | 'NO_CANDIDATES_MET_SAMPLE_REQUIREMENTS'
  | 'NO_CANDIDATES_MET_PEER_SUPPORT'
  | 'NO_MATERIAL_EFFECTS'
  | 'ALL_QUALIFYING_PATTERNS_SUPPRESSED_AS_DUPLICATES';

export interface PatternDiscoverySelectionSummary {
  total_candidate_segment_count: number;
  evaluated_candidate_count: number;
  fixed_family_suppressed_count: number;
  ineligible_count: number;
  confirmed_qualifying_count: number;
  selected_pattern_count: number;
  emerging_hypothesis_count: number;
  peer_group_suppressed_count: number;
  family_suppressed_count: number;
  global_limit_suppressed_count: number;
  family_counts: Record<string, number>;
  pattern_type_counts: Record<string, number>;
  no_pattern_reasons: NoPatternReason[];
}

// ── Top-level output ─────────────────────────────────────────────────────

export type PatternDiscoveryStatus = 'completed' | 'evidence_unavailable' | 'no_eligible_patterns';

export interface PatternDiscoverySection {
  schema_version: string;
  engine_version: string;
  source_analytics_version: string;
  generated_at: string;
  status: PatternDiscoveryStatus;
  selection_summary: PatternDiscoverySelectionSummary;
  selected_patterns: SelectedPattern[];
  emerging_hypotheses: EmergingHypothesis[];
  candidate_evaluations: PatternDiscoveryCandidateEvaluation[];
  limitations: string[];
}
