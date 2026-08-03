// Insights Engine — shared comparison helpers. Every Findings Selector rule
// that compares a candidate segment against a peer-median baseline (STRONG_
// BALANCED_ACQUISITION_BAND, STRONG_CATEGORY_ACQUISITION_BAND, and any
// future peer-baseline rule) MUST import its thresholds, trigger logic, and
// tie-break atoms from here rather than redefining them — this is the one
// place the material-improvement / material-weakness definition lives, so
// the two rules can never silently drift apart. Introduced in Insights
// Engine v1.1 by extracting what was originally written directly inside
// strongBalancedAcquisitionBand.ts (v1.0) — the numeric thresholds and
// trigger/tie-break behavior are unchanged by this extraction.

import type { ConfidenceTier } from './types';

// ── Material improvement / weakness thresholds ───────────────────────────
// Improvement uses OR of the absolute/relative test (whichever satisfied).
// Weakness uses AND for the paired absolute/relative tests so small values
// do not create exaggerated weakness flags. Lower DOM is always better.
export const PROFIT_ABS_THRESHOLD_CAD = 150;
export const PROFIT_PCT_THRESHOLD = 0.15;
export const ROI_IMPROVEMENT_PP = 5;
export const ROI_WEAKNESS_PP = 7;
export const DOM_ABS_DAYS = 7;
export const DOM_IMPROVEMENT_PCT_THRESHOLD = 0.2;
export const DOM_WEAKNESS_PCT_THRESHOLD = 0.25;
export const REALIZATION_IMPROVEMENT_PP = 10;
export const REALIZATION_WEAKNESS_PP = 10;

export const MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY = 2;

// ── Shared sample-size eligibility minimums ──────────────────────────────
export const MIN_TOTAL_ITEM_COUNT = 8;
export const MIN_REALIZED_ITEM_COUNT = 5;
export const MIN_DOM_SAMPLE_SIZE = 5;
// Every candidate needs at least this many eligible peers in its comparison
// pool (global pool for the broad-band rule, same-category pool for the
// category rule) so a peer-median baseline is meaningful.
export const MIN_ELIGIBLE_PEER_GROUP_SIZE = 3;

export const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  insufficient: 0,
  low: 1,
  moderate: 2,
  stronger: 3,
};

// ── Defensive JSONB parsing ───────────────────────────────────────────────

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
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

// ── Median ────────────────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Peer-median baseline (shape only — callers stamp their own literal
// `type`, e.g. 'peer_band_median_baseline' or
// 'same_category_peer_band_median_baseline') ─────────────────────────────
// A median of peer-segment metrics, not an item-level portfolio median — do
// not attempt to reconstruct item-level medians from aggregated medians.

export interface PeerMedianBaselineMetrics {
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  realization_rate_percent: number | null;
}

export function computePeerMedianBaselineMetrics<T extends PeerComparableMetrics>(
  peers: T[],
): PeerMedianBaselineMetrics {
  return {
    median_net_profit: median(peers.map((p) => p.median_net_profit).filter((v): v is number => v !== null)),
    median_roi: median(peers.map((p) => p.median_roi).filter((v): v is number => v !== null)),
    median_days_on_market: median(peers.map((p) => p.median_days_on_market).filter((v): v is number => v !== null)),
    realization_rate_percent: median(peers.map((p) => p.realization_rate_percent).filter((v): v is number => v !== null)),
  };
}

// ── Standard segment metrics block — identical field set on both
// AcquisitionBandCandidate and CategoryAcquisitionBandCandidate ─────────

export interface StandardSegmentMetrics {
  total_item_count: number;
  realized_item_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  realization_rate_percent: number | null;
}

export function buildStandardMetrics(candidate: StandardSegmentMetrics): Record<string, unknown> {
  return {
    total_item_count: candidate.total_item_count,
    realized_item_count: candidate.realized_item_count,
    median_net_profit: candidate.median_net_profit,
    median_roi: candidate.median_roi,
    median_days_on_market: candidate.median_days_on_market,
    dom_sample_size: candidate.dom_sample_size,
    realization_rate_percent: candidate.realization_rate_percent,
  };
}

// ── Material improvement / weakness triggers ─────────────────────────────
// Operates on any candidate/baseline pair exposing these four metrics —
// both AcquisitionBandCandidate and CategoryAcquisitionBandCandidate (plus
// either baseline shape) satisfy this structurally.

export interface PeerComparableMetrics {
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  realization_rate_percent: number | null;
}

export function computeImprovementTriggers(
  candidate: PeerComparableMetrics,
  baseline: PeerComparableMetrics,
): string[] {
  const triggers: string[] = [];

  if (candidate.median_net_profit !== null && baseline.median_net_profit !== null) {
    const diff = candidate.median_net_profit - baseline.median_net_profit;
    const relativeThreshold = Math.abs(baseline.median_net_profit) * PROFIT_PCT_THRESHOLD;
    if (diff >= PROFIT_ABS_THRESHOLD_CAD || diff >= relativeThreshold) {
      triggers.push('PROFIT_ABOVE_PEER_BASELINE');
    }
  }

  if (candidate.median_roi !== null && baseline.median_roi !== null) {
    if (candidate.median_roi - baseline.median_roi >= ROI_IMPROVEMENT_PP) {
      triggers.push('ROI_ABOVE_PEER_BASELINE');
    }
  }

  if (candidate.median_days_on_market !== null && baseline.median_days_on_market !== null) {
    const diff = baseline.median_days_on_market - candidate.median_days_on_market; // positive = faster
    const relativeThreshold = baseline.median_days_on_market * DOM_IMPROVEMENT_PCT_THRESHOLD;
    if (diff >= DOM_ABS_DAYS || diff >= relativeThreshold) {
      triggers.push('DOM_FASTER_THAN_PEER_BASELINE');
    }
  }

  if (candidate.realization_rate_percent !== null && baseline.realization_rate_percent !== null) {
    if (candidate.realization_rate_percent - baseline.realization_rate_percent >= REALIZATION_IMPROVEMENT_PP) {
      triggers.push('REALIZATION_ABOVE_PEER_BASELINE');
    }
  }

  return triggers;
}

export function computeWeaknessTriggers(
  candidate: PeerComparableMetrics,
  baseline: PeerComparableMetrics,
): string[] {
  const triggers: string[] = [];

  if (candidate.median_net_profit !== null && baseline.median_net_profit !== null) {
    const diff = baseline.median_net_profit - candidate.median_net_profit; // positive = below baseline
    const relativeThreshold = Math.abs(baseline.median_net_profit) * PROFIT_PCT_THRESHOLD;
    if (diff >= PROFIT_ABS_THRESHOLD_CAD && diff >= relativeThreshold) {
      triggers.push('PROFIT_BELOW_PEER_BASELINE');
    }
  }

  if (candidate.median_roi !== null && baseline.median_roi !== null) {
    if (baseline.median_roi - candidate.median_roi >= ROI_WEAKNESS_PP) {
      triggers.push('ROI_BELOW_PEER_BASELINE');
    }
  }

  if (candidate.median_days_on_market !== null && baseline.median_days_on_market !== null) {
    const diff = candidate.median_days_on_market - baseline.median_days_on_market; // positive = slower
    const relativeThreshold = baseline.median_days_on_market * DOM_WEAKNESS_PCT_THRESHOLD;
    if (diff >= DOM_ABS_DAYS && diff >= relativeThreshold) {
      triggers.push('DOM_WORSE_THAN_PEER_BASELINE');
    }
  }

  if (candidate.realization_rate_percent !== null && baseline.realization_rate_percent !== null) {
    if (baseline.realization_rate_percent - candidate.realization_rate_percent >= REALIZATION_WEAKNESS_PP) {
      triggers.push('REALIZATION_BELOW_PEER_BASELINE');
    }
  }

  return triggers;
}

// ── Deterministic tie-break atoms ────────────────────────────────────────
// Each comparator returns <0 when `a` should rank ahead of `b`. Rules chain
// these via chainCompare and append their own final, rule-specific
// tie-breaker(s) (e.g. band order alone, or category id then band order).

export interface RankableCandidate {
  confidence: ConfidenceTier | null;
  realized_item_count: number;
  realization_rate_percent: number | null;
  median_days_on_market: number | null;
}

export interface ScoredCandidateLike<C extends RankableCandidate> {
  candidate: C;
  improvementTriggers: string[];
}

export function compareByImprovementTriggerCount<C extends RankableCandidate>(
  a: ScoredCandidateLike<C>,
  b: ScoredCandidateLike<C>,
): number {
  return b.improvementTriggers.length - a.improvementTriggers.length;
}

export function compareByConfidenceRank<C extends RankableCandidate>(
  a: ScoredCandidateLike<C>,
  b: ScoredCandidateLike<C>,
): number {
  return CONFIDENCE_RANK[b.candidate.confidence as ConfidenceTier] - CONFIDENCE_RANK[a.candidate.confidence as ConfidenceTier];
}

export function compareByRealizedItemCount<C extends RankableCandidate>(
  a: ScoredCandidateLike<C>,
  b: ScoredCandidateLike<C>,
): number {
  return b.candidate.realized_item_count - a.candidate.realized_item_count;
}

export function compareByRealizationRate<C extends RankableCandidate>(
  a: ScoredCandidateLike<C>,
  b: ScoredCandidateLike<C>,
): number {
  return (b.candidate.realization_rate_percent ?? -Infinity) - (a.candidate.realization_rate_percent ?? -Infinity);
}

export function compareByMedianDaysOnMarket<C extends RankableCandidate>(
  a: ScoredCandidateLike<C>,
  b: ScoredCandidateLike<C>,
): number {
  return (a.candidate.median_days_on_market ?? Infinity) - (b.candidate.median_days_on_market ?? Infinity);
}

export function chainCompare<T>(a: T, b: T, comparators: Array<(a: T, b: T) => number>): number {
  for (const comparator of comparators) {
    const result = comparator(a, b);
    if (result !== 0) return result;
  }
  return 0;
}
