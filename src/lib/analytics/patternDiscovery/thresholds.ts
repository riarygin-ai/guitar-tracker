// Pattern Discovery Engine v1.0 — thresholds, family ownership maps, and
// deterministic multiplicity guardrails. Every numeric constant a rule
// needs lives here so evaluateCandidate.ts / classifyPattern.ts /
// selectPatterns.ts never redefine (and risk drifting) the same number
// twice. Stricter than the fixed Insights rules' comparisonHelpers.ts on
// purpose — Pattern Discovery evaluates MANY candidate segments across 13
// families, so its bar for "material" is deliberately higher (see the
// task's own "Use stricter discovery thresholds... because Pattern
// Discovery evaluates many candidate segments" instruction).

import type { ConfidenceTier } from './types';

// ── Confidence scale — the SAME scale/thresholds every Analytics v2.x and
// Insights v1.x module already uses (0-2 insufficient, 3-5 low, 6-9
// moderate, 10+ stronger), reused verbatim, never a new scale. ──────────

export function confidenceFromSampleSize(n: number): ConfidenceTier {
  if (n <= 2) return 'insufficient';
  if (n <= 5) return 'low';
  if (n <= 9) return 'moderate';
  return 'stronger';
}

export const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  insufficient: 0,
  low: 1,
  moderate: 2,
  stronger: 3,
};

export function minConfidenceTier(tiers: ConfidenceTier[]): ConfidenceTier {
  return tiers.reduce((min, t) => (CONFIDENCE_RANK[t] < CONFIDENCE_RANK[min] ? t : min), 'stronger' as ConfidenceTier);
}

// ── Metric-specific sample thresholds ────────────────────────────────────
// profit_sample_size / roi_sample_size / dom_sample_size — never the
// candidate row's generic `confidence` field, which is tiered from
// realized_item_count, not from any one metric's own sample.

export const CONFIRMED_MIN_METRIC_SAMPLE = 6;
export const HYPOTHESIS_MIN_METRIC_SAMPLE = 3;

// ── Peer support ──────────────────────────────────────────────────────
// Confirmed patterns need >=2 eligible peer segments for the metric,
// except the two explicitly binary families (EXIT_METHOD, ACQUISITION_
// METHOD), which may use exactly one peer when BOTH candidate and that
// single peer have metric sample size >= this floor AND confidence =
// stronger. Hypotheses only ever need >=1 eligible peer, no binary
// exception (the exception exists to let a genuinely two-valued family
// reach CONFIRMED status without an artificial second/third peer that
// cannot exist — hypotheses' bar is already low enough not to need it).

export const CONFIRMED_MIN_PEER_SEGMENTS = 2;
export const HYPOTHESIS_MIN_PEER_SEGMENTS = 1;
export const BINARY_EXCEPTION_MIN_SAMPLE = 10;
export const BINARY_EXCEPTION_MIN_CONFIDENCE: ConfidenceTier = 'stronger';

export const BINARY_FAMILIES: ReadonlySet<string> = new Set(['EXIT_METHOD', 'ACQUISITION_METHOD']);

// ── Fixed-Insights-owned families — already covered by one of the nine
// existing Insights v1.8 rules; Pattern Discovery evaluates these rows for
// auditability only (candidate_evaluations still carries them) but they
// can never enter selected_patterns/emerging_hypotheses (see
// selectPatterns.ts). This prevents duplicate findings such as the
// existing strong acquisition-band finding, the purchase-economics-vs-
// trade-speed profile, the Deal In/Deal Out/journey findings, and the
// listing-platform finding. ──────────────────────────────────────────────

export const FIXED_FAMILY_OWNERSHIP: ReadonlySet<string> = new Set([
  'ACQUISITION_VALUE_BAND',
  'CATEGORY_ACQUISITION_VALUE_BAND',
  'ACQUISITION_METHOD',
  'ACQUISITION_METHOD_WITHIN_EXIT_METHOD',
  'DEAL_IN_CHANNEL',
  'DEAL_OUT_CHANNEL',
  'DEAL_IN_TO_DEAL_OUT_JOURNEY',
  'LISTING_PLATFORM',
]);

// ── Novel families eligible for Pattern Discovery v1.0. Do not expand
// this list in this task — see the task's own explicit instruction. ────

export const NOVEL_FAMILIES: ReadonlySet<string> = new Set([
  'CATEGORY',
  'TYPE_WITHIN_CATEGORY',
  'BRAND_WITHIN_CATEGORY',
  'TYPE_ACQUISITION_VALUE_BAND',
  'EXIT_METHOD',
]);

// Families whose sparse peer groups must not produce a confirmed pattern
// unless the metric has at least two eligible peer segments (the default
// CONFIRMED_MIN_PEER_SEGMENTS already enforces this for every family —
// this set exists purely to document that these four specifically must
// NEVER use the binary exception, which they cannot anyway since they are
// not in BINARY_FAMILIES; kept as an explicit, self-documenting constant
// rather than relying on the absence of a binary-family membership check).
export const SPARSE_PEER_GROUP_FAMILIES: ReadonlySet<string> = new Set([
  'CATEGORY',
  'TYPE_WITHIN_CATEGORY',
  'BRAND_WITHIN_CATEGORY',
  'TYPE_ACQUISITION_VALUE_BAND',
]);

// ── Materiality thresholds ────────────────────────────────────────────
// dimension_count === 1 uses the "tier 1" thresholds; dimension_count >= 2
// uses the stricter "tier 2" thresholds (a more specific segment needs a
// stronger signal before Pattern Discovery calls it material — reduces
// false positives from evaluating many narrow candidate segments).

export type DimensionTier = 1 | 2;

export function dimensionTierOf(dimensionCount: number): DimensionTier {
  return dimensionCount >= 2 ? 2 : 1;
}

// Profit — safe relative denominator: max(abs(peer_baseline_median), 250).
// Both the absolute CAD floor AND the relative-percent floor must be met
// (a large relative swing around a near-zero baseline is never material on
// its own) — this mirrors the task's explicit "do not treat a large
// relative change around a near-zero profit baseline as material unless
// the absolute CAD threshold is also met" instruction.
export const PROFIT_SAFE_DENOMINATOR_FLOOR_CAD = 250;
export const PROFIT_ABS_THRESHOLD_CAD = 250;
export const PROFIT_REL_THRESHOLD_PERCENT: Record<DimensionTier, number> = { 1: 20, 2: 25 };

// ROI — percentage points only; relative_advantage_percent is always null
// for ROI (percentage-point change is the primary measure, per the task).
export const ROI_ABS_THRESHOLD_PP = 10;

// DOM — relative denominator: abs(advantage_value) / max(abs(peer_baseline_
// median), 1) * 100 (always non-negative; direction/sign comes from
// advantage_value alone, this magnitude is purely a materiality gate).
export const DOM_SAFE_DENOMINATOR_FLOOR_DAYS = 1;
export const DOM_IMPROVEMENT_ABS_THRESHOLD_DAYS: Record<DimensionTier, number> = { 1: 7, 2: 8 };
export const DOM_IMPROVEMENT_REL_THRESHOLD_PERCENT: Record<DimensionTier, number> = { 1: 20, 2: 25 };
export const DOM_WEAKNESS_ABS_THRESHOLD_DAYS: Record<DimensionTier, number> = { 1: 7, 2: 8 };
export const DOM_WEAKNESS_REL_THRESHOLD_PERCENT: Record<DimensionTier, number> = { 1: 25, 2: 30 };

// ── Historical Import composition ────────────────────────────────────────
export const HISTORICAL_IMPORT_COMPOSITION_DIFF_THRESHOLD_PP = 25;

// ── Multiplicity guardrail caps ──────────────────────────────────────────
export const MAX_SELECTED_PATTERNS = 5;
export const MAX_EMERGING_HYPOTHESES = 5;

// ── Global, always-present module limitations ────────────────────────────
export const GLOBAL_LIMITATIONS: readonly string[] = [
  'REALIZED_ITEMS_ONLY',
  'ASSOCIATION_NOT_CAUSATION',
  'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
  'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
  'CATEGORY_TYPE_AND_BRAND_ARE_CURRENT_ITEM_ATTRIBUTES',
  'AGGREGATE_SEGMENT_MEDIANS_NOT_RAW_DISTRIBUTIONS',
  'LEAVE_ONE_OUT_PEER_BASELINES',
  'MULTIPLE_HYPOTHESIS_GUARDRAILS_ARE_HEURISTIC_NOT_STATISTICAL',
  'OPEN_INVENTORY_NOT_ANALYZED',
  'PERSONAL_HOLDING_INTENT_NOT_ANALYZED',
  'NO_AUTOMATED_BUSINESS_ACTION',
];

export const SCHEMA_VERSION = '1.0';
export const ENGINE_VERSION = '1.0';
export const SOURCE_ANALYTICS_VERSION = '2.13';
