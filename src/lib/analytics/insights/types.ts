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

export type FindingFamily =
  | 'acquisition_performance'
  | 'category_acquisition_performance'
  | 'acquisition_method_performance'
  | 'channel_journey_performance'
  | 'deal_out_channel_performance';

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
  // Both current users of this shape (STRONG_BALANCED_ACQUISITION_BAND,
  // STRONG_CATEGORY_ACQUISITION_BAND) are always 'strength'. 'tradeoff'
  // exists on this union for forward compatibility; the current tradeoff
  // rule (ACQUISITION_METHOD_PERFORMANCE_PROFILE) uses a different finding
  // shape entirely — see AcquisitionMethodPerformanceProfileFinding below.
  direction: 'strength' | 'tradeoff';
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

// ── ACQUISITION_METHOD_PERFORMANCE_PROFILE (Insights Engine v1.2) ──────────
// One row per (acquisition_method, exit_method) pair, read from v2.10's
// target_user_acquisition_evidence.acquisition_to_exit_analysis.
// method_paths — pooled across every Purpose, realized items only (this
// section only ever contains realized-and-exited items to begin with). See
// extractAcquisitionMethodExitRows in
// rules/acquisitionMethodPerformanceProfile.ts.
export interface AcquisitionMethodCandidateEvaluation {
  finding_code: string;
  acquisition_method: string;
  exit_method: string;
  eligible: boolean;
  eligibility_failure_reasons: string[];
  item_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  confidence: ConfidenceTier | null;
}

// ── STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY (Insights Engine v1.3) ──────────────
// One row per (deal_in_channel_id, deal_out_channel_id) pair, read from
// v2.10's target_user_deal_channel_evidence.channel_journey.deal_in_to_
// deal_out_matrix — pooled across every Purpose, realized items only. See
// extractDealChannelJourneyCandidates in
// rules/strongDealInToDealOutJourney.ts.
export interface DealChannelJourneyCandidate {
  deal_in_channel_id: number | null;
  deal_in_channel_name: string | null;
  deal_out_channel_id: number | null;
  deal_out_channel_name: string | null;
  item_count: number;
  distinct_acquisition_deal_count: number;
  distinct_exit_deal_count: number;
  // min(distinct_acquisition_deal_count, distinct_exit_deal_count) — a
  // journey is only "repeatable" if BOTH its sourcing leg and its exit leg
  // recur across multiple distinct deals; the weaker leg is the bottleneck.
  distinct_deal_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  confidence: ConfidenceTier | null;
}

// STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY's baseline: median of the OTHER
// eligible channel journeys, pooled across the target user's whole
// portfolio. realization_rate_percent is always null here — channel-journey
// evidence is realized-exits-only and has no valid open-vs-realized
// denominator, so realization rate is never compared for this rule (kept
// as an explicit null, not omitted, so the shared PeerMedianBaseline shape
// stays uniform across every rule).
export interface PeerChannelJourneyMedianBaseline extends PeerMedianBaseline {
  type: 'peer_channel_journey_median_baseline';
  realization_rate_percent: null;
}

export interface ChannelJourneyCandidateEvaluation {
  finding_code: string;
  deal_in_channel_id: number | null;
  deal_in_channel_name: string | null;
  deal_out_channel_id: number | null;
  deal_out_channel_name: string | null;
  eligible: boolean;
  eligibility_failure_reasons: string[];
  material_improvement_triggers: string[];
  material_weakness_triggers: string[];
  qualifies: boolean;
  selected: boolean;
}

// ── STRONG_DEAL_OUT_CHANNEL (Insights Engine v1.4) ─────────────────────────
// One row per deal_out_channel_id, read from v2.10's target_user_deal_
// channel_evidence.deal_out_channel_performance.performance_by_deal_out_
// channel — pooled across every Purpose, realized items only. See
// extractDealOutChannelCandidates in rules/strongDealOutChannel.ts.
export interface DealOutChannelCandidate {
  channel_id: number | null;
  channel_name: string | null;
  item_count: number;
  distinct_deal_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  confidence: ConfidenceTier | null;
}

// STRONG_DEAL_OUT_CHANNEL's baseline: median of the OTHER eligible Deal Out
// Channels, pooled across the target user's whole portfolio.
// realization_rate_percent is always null — see PeerChannelJourneyMedianBaseline
// above for the same reasoning (realized-exits-only evidence).
export interface PeerDealOutChannelMedianBaseline extends PeerMedianBaseline {
  type: 'peer_deal_out_channel_median_baseline';
  realization_rate_percent: null;
}

export interface DealOutChannelCandidateEvaluation {
  finding_code: string;
  channel_id: number | null;
  channel_name: string | null;
  eligible: boolean;
  eligibility_failure_reasons: string[];
  material_improvement_triggers: string[];
  material_weakness_triggers: string[];
  qualifies: boolean;
  selected: boolean;
}

// rule_evaluations is a heterogeneous debug array — each row's own
// finding_code says which rule produced it.
export type RuleEvaluationRow =
  | CandidateEvaluation
  | AcquisitionMethodCandidateEvaluation
  | ChannelJourneyCandidateEvaluation
  | DealOutChannelCandidateEvaluation;

export type MethodAdvantage = 'Purchase' | 'Trade' | 'Neutral';

export interface AcquisitionMethodExitMetrics {
  item_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  confidence: ConfidenceTier;
}

// Like-for-like: Purchase and Trade rows sharing the SAME exit_method.
// Purchase -> Sale is never compared against Trade -> Trade.
export interface ExitMethodComparison {
  exit_method: 'sale' | 'trade';
  purchase: AcquisitionMethodExitMetrics;
  trade: AcquisitionMethodExitMetrics;
  deltas: {
    median_net_profit: number;
    median_roi: number;
    median_days_on_market: number;
  };
  profit_advantage: MethodAdvantage;
  roi_advantage: MethodAdvantage;
  dom_advantage: MethodAdvantage;
  triggered_rules: string[];
}

export type AcquisitionMethodProfileCode =
  | 'PURCHASE_ECONOMICS_TRADE_SPEED'
  | 'TRADE_ECONOMICS_PURCHASE_SPEED'
  | 'PURCHASE_BROAD_ADVANTAGE'
  | 'TRADE_BROAD_ADVANTAGE'
  | 'MIXED_BY_EXIT_METHOD';

// This rule's finding never fits the segment/metrics/single-baseline shape
// of SelectedFinding above — it is inherently a multi-comparison structure
// (one entry per eligible exit method), so it gets its own shape rather
// than being forced into one that doesn't semantically apply (no single
// "segment", no single peer baseline, no runner-up).
export interface AcquisitionMethodPerformanceProfileFinding {
  finding_code: string;
  family: 'acquisition_method_performance';
  // 'tradeoff' for the two economics-vs-speed profiles and MIXED_BY_
  // EXIT_METHOD; 'strength' only for a broad, uncontested advantage.
  direction: 'strength' | 'tradeoff';
  status: 'selected';
  headline: string;
  summary: string;
  profile_code: AcquisitionMethodProfileCode;
  eligible_exit_method_comparison_count: number;
  comparisons: ExitMethodComparison[];
  confidence: ConfidenceTier;
  limitations: string[];
  evidence_refs: string[];
}

export interface InsightsSection {
  insights_engine_version: string;
  findings_selector_version: string;
  source_analytics_version: string;
  generated_at: string;
  selected_findings: Array<SelectedFinding | AcquisitionMethodPerformanceProfileFinding>;
  rule_evaluations: RuleEvaluationRow[];
}
