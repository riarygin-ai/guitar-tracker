// Pattern Discovery Engine v1.0 — per-candidate metric effect evaluation.
// Pure functions only — no I/O. Computes profit/ROI/DOM effects
// INDEPENDENTLY (never a combined score) against a leave-one-out median
// peer baseline (aggregate segment medians, never raw items — never a
// mean, never a weighted average, never an inferred causal control
// group). See thresholds.ts for every numeric constant used here.

import { median } from './parseEvidence';
import {
  BINARY_EXCEPTION_MIN_CONFIDENCE,
  BINARY_EXCEPTION_MIN_SAMPLE,
  BINARY_FAMILIES,
  CONFIRMED_MIN_METRIC_SAMPLE,
  CONFIRMED_MIN_PEER_SEGMENTS,
  DOM_IMPROVEMENT_ABS_THRESHOLD_DAYS,
  DOM_IMPROVEMENT_REL_THRESHOLD_PERCENT,
  DOM_SAFE_DENOMINATOR_FLOOR_DAYS,
  DOM_WEAKNESS_ABS_THRESHOLD_DAYS,
  DOM_WEAKNESS_REL_THRESHOLD_PERCENT,
  HYPOTHESIS_MIN_METRIC_SAMPLE,
  HYPOTHESIS_MIN_PEER_SEGMENTS,
  PROFIT_ABS_THRESHOLD_CAD,
  PROFIT_REL_THRESHOLD_PERCENT,
  PROFIT_SAFE_DENOMINATOR_FLOOR_CAD,
  ROI_ABS_THRESHOLD_PP,
  confidenceFromSampleSize,
  dimensionTierOf,
  minConfidenceTier,
} from './thresholds';
import type {
  ConfidenceTier,
  MetricCode,
  MetricEffect,
  MetricDirection,
  PatternDiscoveryCandidateSegment,
} from './types';

export type EvaluationTier = 'confirmed' | 'hypothesis';

function minMetricSampleFor(tier: EvaluationTier): number {
  return tier === 'confirmed' ? CONFIRMED_MIN_METRIC_SAMPLE : HYPOTHESIS_MIN_METRIC_SAMPLE;
}

function minPeerSegmentsFor(tier: EvaluationTier): number {
  return tier === 'confirmed' ? CONFIRMED_MIN_PEER_SEGMENTS : HYPOTHESIS_MIN_PEER_SEGMENTS;
}

const SAMPLE_FIELD_BY_METRIC: Record<MetricCode, keyof PatternDiscoveryCandidateSegment> = {
  median_net_profit: 'profit_sample_size',
  median_roi: 'roi_sample_size',
  median_days_on_market: 'dom_sample_size',
};

function sampleSizeOf(segment: PatternDiscoveryCandidateSegment, metric: MetricCode): number {
  return segment[SAMPLE_FIELD_BY_METRIC[metric]] as number;
}

function valueOf(segment: PatternDiscoveryCandidateSegment, metric: MetricCode): number | null {
  return segment[metric];
}

/**
 * Confirmed patterns require >= CONFIRMED_MIN_PEER_SEGMENTS eligible peers
 * for the metric, EXCEPT the two explicitly binary families, which may use
 * exactly one peer when both candidate and that single peer have metric
 * sample size >= BINARY_EXCEPTION_MIN_SAMPLE AND confidence = 'stronger'.
 * Hypotheses never use the binary exception — their bar (>=1 eligible
 * peer) is already at the floor.
 */
export function hasSufficientPeerSupport(
  tier: EvaluationTier,
  familyCode: string,
  candidate: PatternDiscoveryCandidateSegment,
  metric: MetricCode,
  eligiblePeers: PatternDiscoveryCandidateSegment[],
): boolean {
  const minPeers = minPeerSegmentsFor(tier);
  if (eligiblePeers.length >= minPeers) return true;

  if (tier !== 'confirmed') return false;
  if (!BINARY_FAMILIES.has(familyCode)) return false;
  if (eligiblePeers.length !== 1) return false;

  const peer = eligiblePeers[0];
  const candidateSample = sampleSizeOf(candidate, metric);
  const peerSample = sampleSizeOf(peer, metric);
  return (
    candidateSample >= BINARY_EXCEPTION_MIN_SAMPLE &&
    peerSample >= BINARY_EXCEPTION_MIN_SAMPLE &&
    candidate.confidence === BINARY_EXCEPTION_MIN_CONFIDENCE &&
    peer.confidence === BINARY_EXCEPTION_MIN_CONFIDENCE
  );
}

// ── Sign convention ────────────────────────────────────────────────────
// Positive advantage_value ALWAYS means better performance: profit/ROI use
// candidate - peer baseline directly; DOM reverses the subtraction (peer
// baseline - candidate) so a positive DOM advantage means faster.

function advantageValueOf(metric: MetricCode, candidateValue: number, peerBaselineMedian: number): number {
  if (metric === 'median_days_on_market') return peerBaselineMedian - candidateValue;
  return candidateValue - peerBaselineMedian;
}

function evaluateProfitMateriality(
  advantageValue: number,
  relativeAdvantagePercent: number,
  dimensionCount: number,
): MetricDirection {
  const tier = dimensionTierOf(dimensionCount);
  const relThreshold = PROFIT_REL_THRESHOLD_PERCENT[tier];
  if (advantageValue >= PROFIT_ABS_THRESHOLD_CAD && relativeAdvantagePercent >= relThreshold) return 'improvement';
  if (advantageValue <= -PROFIT_ABS_THRESHOLD_CAD && relativeAdvantagePercent <= -relThreshold) return 'weakness';
  return 'neutral';
}

function evaluateRoiMateriality(advantageValue: number): MetricDirection {
  if (advantageValue >= ROI_ABS_THRESHOLD_PP) return 'improvement';
  if (advantageValue <= -ROI_ABS_THRESHOLD_PP) return 'weakness';
  return 'neutral';
}

function evaluateDomMateriality(advantageValue: number, relativeMagnitudePercent: number, dimensionCount: number): MetricDirection {
  const tier = dimensionTierOf(dimensionCount);
  const improvementAbs = DOM_IMPROVEMENT_ABS_THRESHOLD_DAYS[tier];
  const improvementRel = DOM_IMPROVEMENT_REL_THRESHOLD_PERCENT[tier];
  const weaknessAbs = DOM_WEAKNESS_ABS_THRESHOLD_DAYS[tier];
  const weaknessRel = DOM_WEAKNESS_REL_THRESHOLD_PERCENT[tier];
  if (advantageValue >= improvementAbs && relativeMagnitudePercent >= improvementRel) return 'improvement';
  if (advantageValue <= -weaknessAbs && relativeMagnitudePercent >= weaknessRel) return 'weakness';
  return 'neutral';
}

/**
 * Computes ONE metric's effect for one candidate at one evaluation tier
 * (confirmed or hypothesis). Peer group must already be every OTHER
 * candidate sharing the same peer_group_key (the candidate itself already
 * excluded by the caller — leave-one-out starts one level up, at group
 * formation, not here).
 */
export function computeMetricEffect(
  metric: MetricCode,
  familyCode: string,
  candidate: PatternDiscoveryCandidateSegment,
  peerGroupExcludingSelf: PatternDiscoveryCandidateSegment[],
  tier: EvaluationTier,
): MetricEffect {
  const minSample = minMetricSampleFor(tier);
  const dimensionTier = dimensionTierOf(candidate.dimension_count);

  const candidateValue = valueOf(candidate, metric);
  const candidateSampleSize = sampleSizeOf(candidate, metric);
  const candidateHasSample = candidateValue !== null && candidateSampleSize >= minSample;

  const eligiblePeers = peerGroupExcludingSelf.filter((peer) => {
    const v = valueOf(peer, metric);
    return v !== null && sampleSizeOf(peer, metric) >= minSample;
  });

  const absoluteThreshold =
    metric === 'median_net_profit' ? PROFIT_ABS_THRESHOLD_CAD : metric === 'median_roi' ? ROI_ABS_THRESHOLD_PP : DOM_IMPROVEMENT_ABS_THRESHOLD_DAYS[dimensionTier];
  const relativeThreshold =
    metric === 'median_net_profit'
      ? PROFIT_REL_THRESHOLD_PERCENT[dimensionTier]
      : metric === 'median_roi'
        ? null
        : DOM_IMPROVEMENT_REL_THRESHOLD_PERCENT[dimensionTier];

  const thresholdsApplied = {
    dimension_tier: dimensionTier,
    minimum_metric_sample_size: minSample,
    minimum_peer_segments: minPeerSegmentsFor(tier),
    absolute_threshold: absoluteThreshold,
    relative_threshold_percent: relativeThreshold,
  };

  const peerSupportOk = candidateHasSample && hasSufficientPeerSupport(tier, familyCode, candidate, metric, eligiblePeers);

  if (!candidateHasSample || !peerSupportOk) {
    return {
      metric_code: metric,
      available: false,
      candidate_value: candidateValue,
      candidate_sample_size: candidateSampleSize,
      peer_eligible_segment_count: eligiblePeers.length,
      peer_baseline_median: null,
      peer_minimum_sample_size: null,
      advantage_value: null,
      relative_advantage_percent: null,
      materiality: false,
      direction: 'unavailable',
      thresholds_applied: thresholdsApplied,
    };
  }

  const peerBaselineMedian = median(eligiblePeers.map((p) => valueOf(p, metric) as number))!;
  const peerMinimumSampleSize = Math.min(...eligiblePeers.map((p) => sampleSizeOf(p, metric)));
  const advantageValue = advantageValueOf(metric, candidateValue as number, peerBaselineMedian);

  let relativeAdvantagePercent: number | null;
  let direction: MetricDirection;

  if (metric === 'median_net_profit') {
    const denominator = Math.max(Math.abs(peerBaselineMedian), PROFIT_SAFE_DENOMINATOR_FLOOR_CAD);
    relativeAdvantagePercent = (advantageValue / denominator) * 100;
    direction = evaluateProfitMateriality(advantageValue, relativeAdvantagePercent, candidate.dimension_count);
  } else if (metric === 'median_roi') {
    // Percentage-point change is the primary measure for ROI —
    // relative_advantage_percent is always null (per the task's own
    // instruction, not merely "unavailable").
    relativeAdvantagePercent = null;
    direction = evaluateRoiMateriality(advantageValue);
  } else {
    const denominator = Math.max(Math.abs(peerBaselineMedian), DOM_SAFE_DENOMINATOR_FLOOR_DAYS);
    const relativeMagnitudePercent = (Math.abs(advantageValue) / denominator) * 100;
    relativeAdvantagePercent = relativeMagnitudePercent;
    direction = evaluateDomMateriality(advantageValue, relativeMagnitudePercent, candidate.dimension_count);
  }

  return {
    metric_code: metric,
    available: true,
    candidate_value: candidateValue,
    candidate_sample_size: candidateSampleSize,
    peer_eligible_segment_count: eligiblePeers.length,
    peer_baseline_median: peerBaselineMedian,
    peer_minimum_sample_size: peerMinimumSampleSize,
    advantage_value: advantageValue,
    relative_advantage_percent: relativeAdvantagePercent,
    materiality: direction === 'improvement' || direction === 'weakness',
    direction,
    thresholds_applied: thresholdsApplied,
  };
}

export const METRIC_CODES: MetricCode[] = ['median_net_profit', 'median_roi', 'median_days_on_market'];

export interface CandidateTierEvaluation {
  metricEffects: MetricEffect[];
  triggeredSignals: string[];
  confidence: ConfidenceTier;
}

/**
 * Evaluates all three metrics for one candidate at one tier and derives
 * the pattern-level confidence — the minimum tier across: the candidate's
 * own realized_item_count, every candidate metric sample used in a
 * TRIGGERED (material) signal, and the minimum peer metric sample used by
 * every triggered signal. Metrics that never triggered (neutral or
 * unavailable) do not pull confidence down — an untriggered metric is not
 * part of the pattern's evidentiary claim.
 */
export function evaluateCandidateAtTier(
  familyCode: string,
  candidate: PatternDiscoveryCandidateSegment,
  peerGroupExcludingSelf: PatternDiscoveryCandidateSegment[],
  tier: EvaluationTier,
): CandidateTierEvaluation {
  const metricEffects = METRIC_CODES.map((metric) => computeMetricEffect(metric, familyCode, candidate, peerGroupExcludingSelf, tier));

  const triggeredEffects = metricEffects.filter((e) => e.materiality);
  const triggeredSignals = triggeredEffects.map((e) => {
    const shortCode = e.metric_code === 'median_net_profit' ? 'PROFIT' : e.metric_code === 'median_roi' ? 'ROI' : 'DOM';
    return `${shortCode}_${e.direction === 'improvement' ? 'IMPROVEMENT' : 'WEAKNESS'}`;
  });

  const tiers: ConfidenceTier[] = [confidenceFromSampleSize(candidate.realized_item_count)];
  for (const effect of triggeredEffects) {
    tiers.push(confidenceFromSampleSize(effect.candidate_sample_size));
    tiers.push(confidenceFromSampleSize(effect.peer_minimum_sample_size ?? 0));
  }

  return {
    metricEffects,
    triggeredSignals,
    confidence: minConfidenceTier(tiers),
  };
}

// ── Confirmed-tier blocker diagnosis ────────────────────────────────────
// Explains, per metric, EXACTLY why a metric that is material at the
// hypothesis tier fails to reach the confirmed tier — used only to build
// accurate hypothesis confirmation_needed/ineligibility_reasons text
// (never used to gate eligibility/classification/ranking, which remain
// driven entirely by computeMetricEffect/evaluateCandidateAtTier above).
//
// 'candidate_sample'  — the candidate's OWN sample for this metric is
//                        below the confirmed floor (6) — peers are
//                        irrelevant until this is fixed.
// 'peer_sample'        — the candidate sample is fine, and enough DISTINCT
//                        peer segments exist (at the loosest, hypothesis-
//                        tier sample floor of 3), but too few of them
//                        individually reach the confirmed sample floor
//                        (6, or the binary-family exception's 10).
// 'peer_count'          — the candidate sample is fine, but not enough
//                        DISTINCT peer segments exist at all, even at the
//                        loosest tier — no amount of peer sample growth on
//                        the existing peers alone would fix this.
// 'none'                — this metric already fully satisfies the
//                        confirmed tier's candidate+peer requirements; if
//                        the row still isn't confirmed, the reason lies in
//                        classification (a different, smaller/tighter
//                        confirmed-tier peer pool can shift a metric's
//                        baseline enough to fall out of materiality even
//                        though every sample/count requirement passed).

export type ConfirmedTierBlockerCategory = 'candidate_sample' | 'peer_sample' | 'peer_count' | 'none';

export interface ConfirmedTierMetricDiagnosis {
  metric_code: MetricCode;
  category: ConfirmedTierBlockerCategory;
  candidate_sample_size: number;
  eligible_peer_count_at_hypothesis_tier: number;
  min_eligible_peer_sample_at_hypothesis_tier: number | null;
  is_binary_family: boolean;
}

export function diagnoseConfirmedTierMetricBlocker(
  metric: MetricCode,
  familyCode: string,
  candidate: PatternDiscoveryCandidateSegment,
  peerGroupExcludingSelf: PatternDiscoveryCandidateSegment[],
): ConfirmedTierMetricDiagnosis {
  const isBinary = BINARY_FAMILIES.has(familyCode);
  const candidateValue = valueOf(candidate, metric);
  const candidateSampleSize = sampleSizeOf(candidate, metric);

  const eligibleAtHypothesis = peerGroupExcludingSelf.filter((peer) => {
    const v = valueOf(peer, metric);
    return v !== null && sampleSizeOf(peer, metric) >= HYPOTHESIS_MIN_METRIC_SAMPLE;
  });
  const minEligiblePeerSampleAtHypothesis =
    eligibleAtHypothesis.length > 0 ? Math.min(...eligibleAtHypothesis.map((p) => sampleSizeOf(p, metric))) : null;

  const base = {
    metric_code: metric,
    candidate_sample_size: candidateSampleSize,
    eligible_peer_count_at_hypothesis_tier: eligibleAtHypothesis.length,
    min_eligible_peer_sample_at_hypothesis_tier: minEligiblePeerSampleAtHypothesis,
    is_binary_family: isBinary,
  };

  if (candidateValue === null || candidateSampleSize < CONFIRMED_MIN_METRIC_SAMPLE) {
    return { ...base, category: 'candidate_sample' };
  }

  const eligibleAtConfirmed = peerGroupExcludingSelf.filter((peer) => {
    const v = valueOf(peer, metric);
    return v !== null && sampleSizeOf(peer, metric) >= CONFIRMED_MIN_METRIC_SAMPLE;
  });

  if (hasSufficientPeerSupport('confirmed', familyCode, candidate, metric, eligibleAtConfirmed)) {
    return { ...base, category: 'none' };
  }

  // Binary families structurally have at most one peer value (the other
  // side of the binary pair) — 1 distinct peer segment is the maximum
  // achievable, not a deficiency, so their peer-count floor is 1, not the
  // ordinary 2.
  const requiredSegmentsForCount = isBinary ? 1 : CONFIRMED_MIN_PEER_SEGMENTS;
  if (eligibleAtHypothesis.length < requiredSegmentsForCount) {
    return { ...base, category: 'peer_count' };
  }
  return { ...base, category: 'peer_sample' };
}

/**
 * Leave-one-out median peer historical_import_percent, used only to decide
 * whether HISTORICAL_IMPORT_COMPOSITION_DIFFERS_FROM_PEERS applies — never
 * to gate eligibility (Historical Imports are always valid economic
 * evidence, per the task's own instruction).
 */
export function historicalImportCompositionDiffPercentagePoints(
  candidate: PatternDiscoveryCandidateSegment,
  peerGroupExcludingSelf: PatternDiscoveryCandidateSegment[],
): number | null {
  if (candidate.historical_import_percent === null) return null;
  const peerValues = peerGroupExcludingSelf
    .map((p) => p.historical_import_percent)
    .filter((v): v is number => v !== null);
  const peerMedian = median(peerValues);
  if (peerMedian === null) return null;
  return Math.abs(candidate.historical_import_percent - peerMedian);
}
