// Insights Engine v1.0 — reusable types shared by the Findings Selector and
// its rules. This layer consumes Analytics v2.10's SQL snapshot as
// read-only evidence and never recomputes or overrides any v2.10 value —
// see analytics/SEMANTIC_CONTRACT.md and the Insights Engine's own
// versioning (insights_engine_version / findings_selector_version) kept
// entirely separate from snapshot_schema_version / analytics_definition_
// version.

export type ConfidenceTier = 'insufficient' | 'low' | 'moderate' | 'stronger';

// ── Joined per-band evidence (Findings Selector input) ──────────────────────
// One row per positive acquisition-value band, joined from v2.10's
// target_user_acquisition_evidence.acquisition_value_band_performance.
// band_performance (primary metrics) and .acquisition_to_exit_analysis.
// performance_by_band (confidence + historical/app-tracked counts), matched
// by the stable acquisition_value_band_order / m2_acq_band_order key. See
// extractAcquisitionBandCandidates in rules/strongBalancedAcquisitionBand.ts.
export interface AcquisitionBandCandidate {
  acquisition_value_band_order: number;
  acquisition_value_band_label: string;
  total_item_count: number;
  realized_item_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  realization_rate_percent: number | null;
  confidence: ConfidenceTier | null;
  historical_item_count: number | null;
  app_tracked_item_count: number | null;
}

// A median of peer metrics, not an item-level portfolio median. Do not
// attempt to reconstruct item-level medians from aggregated medians. Shared
// shape — each rule stamps its own literal `type` (see PeerBandMedianBaseline
// / SameCategoryPeerBandMedianBaseline below); SelectedFinding.baseline is
// typed against this loose base so either subtype satisfies it.
export interface PeerMedianBaseline {
  type: string;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  realization_rate_percent: number | null;
}

// STRONG_BALANCED_ACQUISITION_BAND's baseline: median of the OTHER eligible
// acquisition bands, pooled across the target user's whole portfolio.
export interface PeerBandMedianBaseline extends PeerMedianBaseline {
  type: 'peer_band_median_baseline';
}

// STRONG_CATEGORY_ACQUISITION_BAND's baseline: median of the OTHER eligible
// acquisition bands within the SAME category only — see
// rules/strongCategoryAcquisitionBand.ts.
export interface SameCategoryPeerBandMedianBaseline extends PeerMedianBaseline {
  type: 'same_category_peer_band_median_baseline';
}

export type FindingFamily = 'acquisition_performance' | 'category_acquisition_performance';

export interface RunnerUpContext {
  segment: Record<string, unknown>;
  metrics: Record<string, unknown>;
  triggered_rules: string[];
  reason_not_selected: string;
}

// Cross-rule relationship metadata — added only when two findings from
// different rules point at the same underlying segment (currently: a
// category finding that refines a broad-band finding selecting the same
// acquisition band). Deliberately minimal — not a general dedupe framework.
export interface FindingRelationship {
  relationship: 'refines';
  related_finding_code: string;
  dedupe_group: string;
}

export interface SelectedFinding {
  finding_code: string;
  family: FindingFamily;
  direction: 'strength';
  status: 'selected';
  headline: string;
  summary: string;
  segment: Record<string, unknown>;
  metrics: Record<string, unknown>;
  baseline: PeerMedianBaseline;
  triggered_rules: string[];
  confidence: ConfidenceTier;
  limitations: string[];
  evidence_refs: string[];
  runner_up?: RunnerUpContext;
  relationship?: FindingRelationship;
}

export interface NoFindingResult {
  status: 'no_eligible_finding';
  finding_code: string;
  reason_codes: string[];
}

export type RuleEvaluationResult = SelectedFinding | NoFindingResult;

// Per-candidate debug context — enough to see why a band was selected or
// rejected without duplicating the full Analytics snapshot. category_id/
// category_name are present only for STRONG_CATEGORY_ACQUISITION_BAND rows
// (undefined, so absent from the stored JSON, for STRONG_BALANCED_
// ACQUISITION_BAND rows).
export interface CandidateEvaluation {
  finding_code: string;
  acquisition_value_band_order: number;
  acquisition_value_band_label: string;
  category_id?: number;
  category_name?: string;
  eligible: boolean;
  eligibility_failure_reasons: string[];
  material_improvement_triggers: string[];
  material_weakness_triggers: string[];
  qualifies: boolean;
  selected: boolean;
}

// One row per (category, positive acquisition-value band), read from v2.10's
// target_user_inventory_segmentation_evidence.category_type_performance.
// performance_by_category_and_acquisition_band — pooled across every
// Purpose (Business, Hybrid, Personal). category_id/category_name are
// nullable because items with no assigned category collapse into a NULL
// group at the source (never dropped) — such rows are always ineligible
// (CATEGORY_IDENTITY_MISSING), never silently discarded. See
// extractCategoryBandCandidates in rules/strongCategoryAcquisitionBand.ts.
export interface CategoryAcquisitionBandCandidate {
  category_id: number | null;
  category_name: string | null;
  acquisition_value_band_order: number;
  acquisition_value_band_label: string;
  total_item_count: number;
  realized_item_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  realization_rate_percent: number | null;
  confidence: ConfidenceTier | null;
}

export interface InsightsSection {
  insights_engine_version: string;
  findings_selector_version: string;
  source_analytics_version: string;
  generated_at: string;
  selected_findings: SelectedFinding[];
  rule_evaluations: CandidateEvaluation[];
}
