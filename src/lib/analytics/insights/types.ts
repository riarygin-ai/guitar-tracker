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

// A median of peer-band metrics, not an item-level portfolio median. Do not
// attempt to reconstruct item-level medians from aggregated medians.
export interface PeerBandMedianBaseline {
  type: 'peer_band_median_baseline';
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  realization_rate_percent: number | null;
}

export type FindingFamily = 'acquisition_performance';

export interface RunnerUpContext {
  segment: Record<string, unknown>;
  metrics: Record<string, unknown>;
  triggered_rules: string[];
  reason_not_selected: string;
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
  baseline: PeerBandMedianBaseline;
  triggered_rules: string[];
  confidence: ConfidenceTier;
  limitations: string[];
  evidence_refs: string[];
  runner_up?: RunnerUpContext;
}

export interface NoFindingResult {
  status: 'no_eligible_finding';
  finding_code: string;
  reason_codes: string[];
}

export type RuleEvaluationResult = SelectedFinding | NoFindingResult;

// Per-candidate debug context — enough to see why a band was selected or
// rejected without duplicating the full Analytics snapshot.
export interface CandidateEvaluation {
  finding_code: string;
  acquisition_value_band_order: number;
  acquisition_value_band_label: string;
  eligible: boolean;
  eligibility_failure_reasons: string[];
  material_improvement_triggers: string[];
  material_weakness_triggers: string[];
  qualifies: boolean;
  selected: boolean;
}

export interface InsightsSection {
  insights_engine_version: string;
  findings_selector_version: string;
  source_analytics_version: string;
  generated_at: string;
  selected_findings: SelectedFinding[];
  rule_evaluations: CandidateEvaluation[];
}
