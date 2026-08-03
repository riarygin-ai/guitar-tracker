// Insights Engine — Findings Selector rule: STRONG_BALANCED_ACQUISITION_
// BAND. Pure functions only — no I/O, no Supabase client. Reads exclusively
// from target_user_acquisition_evidence (never shared/pooled evidence) so
// the selected finding always reflects the target user's own performance.
// Unchanged in behavior since Insights Engine v1.0 — v1.1 only extracted
// its threshold/trigger/tie-break logic into comparisonHelpers.ts so
// STRONG_CATEGORY_ACQUISITION_BAND could reuse the identical definitions
// instead of duplicating them (see that module's header).
//
// Evidence shape consumed (Analytics v2.10, unchanged, see
// supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql):
//   target_user_acquisition_evidence.acquisition_value_band_performance.
//     band_performance[]      — already filtered to acquisition_value_
//                                status = 'positive' (no zero/unknown/
//                                negative rows ever appear here), one row
//                                per band, keyed by acquisition_value_
//                                band_order (1-6 ascending).
//   target_user_acquisition_evidence.acquisition_to_exit_analysis.
//     performance_by_band[]   — same band boundaries (m2_acq_band_order),
//                                a stricter subset (realized AND positive
//                                exit_value) carrying `confidence` and
//                                historical/app-tracked counts that
//                                band_performance does not.
// The two arrays are joined by band order — see
// extractAcquisitionBandCandidates below.

import type {
  AcquisitionBandCandidate,
  CandidateEvaluation,
  ConfidenceTier,
  PeerBandMedianBaseline,
  RuleEvaluationResult,
  SelectedFinding,
} from '../types';
import {
  MIN_TOTAL_ITEM_COUNT,
  MIN_REALIZED_ITEM_COUNT,
  MIN_DOM_SAMPLE_SIZE,
  MIN_ELIGIBLE_PEER_GROUP_SIZE,
  MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY,
  computeImprovementTriggers,
  computeWeaknessTriggers,
  computePeerMedianBaselineMetrics,
  buildStandardMetrics,
  compareByImprovementTriggerCount,
  compareByConfidenceRank,
  compareByRealizedItemCount,
  compareByRealizationRate,
  compareByMedianDaysOnMarket,
  chainCompare,
  toRecord,
  toNumber,
  toNonNegativeInt,
  toConfidenceTier,
} from '../comparisonHelpers';

export const FINDING_CODE = 'STRONG_BALANCED_ACQUISITION_BAND';

/**
 * Joins band_performance (primary metrics) with performance_by_band
 * (confidence, historical/app-tracked counts) by stable band order. Never
 * throws — malformed or missing evidence simply yields no candidates, which
 * the caller reports as an honest no-finding result.
 */
export function extractAcquisitionBandCandidates(
  targetUserAcquisitionEvidence: unknown,
): AcquisitionBandCandidate[] {
  const evidence = toRecord(targetUserAcquisitionEvidence);
  const bandPerformanceSection = toRecord(evidence?.acquisition_value_band_performance);
  const exitAnalysisSection = toRecord(evidence?.acquisition_to_exit_analysis);

  const bandRows = Array.isArray(bandPerformanceSection?.band_performance)
    ? (bandPerformanceSection!.band_performance as unknown[])
    : [];
  const exitBandRows = Array.isArray(exitAnalysisSection?.performance_by_band)
    ? (exitAnalysisSection!.performance_by_band as unknown[])
    : [];

  const exitRowByBandOrder = new Map<number, Record<string, unknown>>();
  for (const row of exitBandRows) {
    const r = toRecord(row);
    const order = toNumber(r?.m2_acq_band_order);
    if (r && order !== null) exitRowByBandOrder.set(order, r);
  }

  const candidates: AcquisitionBandCandidate[] = [];
  for (const row of bandRows) {
    const r = toRecord(row);
    if (!r) continue;

    const order = toNumber(r.acquisition_value_band_order);
    const label = typeof r.acquisition_value_band_label === 'string' ? r.acquisition_value_band_label : null;
    if (order === null || label === null) continue;

    const exitRow = exitRowByBandOrder.get(order) ?? null;

    candidates.push({
      acquisition_value_band_order: order,
      acquisition_value_band_label: label,
      total_item_count: toNonNegativeInt(r.sample_size),
      realized_item_count: toNonNegativeInt(r.realized_items),
      median_net_profit: toNumber(r.median_net_profit),
      median_roi: toNumber(r.median_roi),
      median_days_on_market: toNumber(r.median_days_on_market),
      dom_sample_size: toNonNegativeInt(r.dom_sample_size),
      realization_rate_percent: toNumber(r.realization_rate_percent),
      confidence: exitRow ? toConfidenceTier(exitRow.confidence) : null,
      historical_item_count: exitRow ? toNumber(exitRow.historical_item_count) : null,
      app_tracked_item_count: exitRow ? toNumber(exitRow.app_tracked_item_count) : null,
    });
  }

  return candidates;
}

// ── Eligibility ───────────────────────────────────────────────────────────
// An ineligible band is not weak. It is simply insufficient evidence.

function evaluateEligibility(c: AcquisitionBandCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // band_performance rows are already restricted to acquisition_value_
  // status = 'positive' at the source (module 1's *_eligible CTE), so this
  // also documents that invariant rather than relying on it silently.
  if (c.acquisition_value_band_order < 1 || c.acquisition_value_band_order > 6) {
    reasons.push('NOT_POSITIVE_ACQUISITION_BAND');
  }
  if (c.total_item_count < MIN_TOTAL_ITEM_COUNT) reasons.push('TOTAL_ITEM_COUNT_BELOW_MINIMUM');
  if (c.realized_item_count < MIN_REALIZED_ITEM_COUNT) reasons.push('REALIZED_ITEM_COUNT_BELOW_MINIMUM');
  if (c.dom_sample_size < MIN_DOM_SAMPLE_SIZE) reasons.push('DOM_SAMPLE_SIZE_BELOW_MINIMUM');
  if (c.median_net_profit === null) reasons.push('MEDIAN_NET_PROFIT_MISSING');
  if (c.median_roi === null) reasons.push('MEDIAN_ROI_MISSING');
  if (c.median_days_on_market === null) reasons.push('MEDIAN_DOM_MISSING');
  if (c.realization_rate_percent === null) reasons.push('REALIZATION_RATE_MISSING');
  if (c.confidence === null) reasons.push('CONFIDENCE_UNAVAILABLE');
  else if (c.confidence === 'insufficient') reasons.push('CONFIDENCE_INSUFFICIENT');

  return { eligible: reasons.length === 0, reasons };
}

// ── Peer band median baseline ────────────────────────────────────────────
// For each candidate: exclude the candidate, take the median of the
// remaining eligible bands' metrics. A median of peer-band metrics, not an
// item-level portfolio median — do not attempt to reconstruct item-level
// medians from aggregated medians.

function computePeerBandMedianBaseline(
  candidate: AcquisitionBandCandidate,
  eligibleCandidates: AcquisitionBandCandidate[],
): PeerBandMedianBaseline {
  const peers = eligibleCandidates.filter((c) => c.acquisition_value_band_order !== candidate.acquisition_value_band_order);
  return { type: 'peer_band_median_baseline', ...computePeerMedianBaselineMetrics(peers) };
}

// ── Winner selection ──────────────────────────────────────────────────────
// Deterministic tie-breakers, in order: (1) more material improvement
// triggers; (2) higher existing confidence rank; (3) larger realized item
// count; (4) higher realization rate; (5) lower median DOM; (6) stable
// acquisition-band order (ascending) as the final deterministic tie-breaker.

interface ScoredCandidate {
  candidate: AcquisitionBandCandidate;
  baseline: PeerBandMedianBaseline;
  improvementTriggers: string[];
  weaknessTriggers: string[];
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  return chainCompare(a, b, [
    compareByImprovementTriggerCount,
    compareByConfidenceRank,
    compareByRealizedItemCount,
    compareByRealizationRate,
    compareByMedianDaysOnMarket,
    (x, y) => x.candidate.acquisition_value_band_order - y.candidate.acquisition_value_band_order,
  ]);
}

function buildSegment(candidate: AcquisitionBandCandidate): Record<string, unknown> {
  return {
    acquisition_value_band_label: candidate.acquisition_value_band_label,
    acquisition_value_band_order: candidate.acquisition_value_band_order,
  };
}

function buildSummary(winner: ScoredCandidate): string {
  const c = winner.candidate;
  return [
    `${c.realized_item_count} of ${c.total_item_count} items in the ${c.acquisition_value_band_label} band have realized ` +
      `(${c.realization_rate_percent}% realization rate).`,
    `Median net profit is CAD $${c.median_net_profit}, median ROI is ${c.median_roi}%, and median days on market is ` +
      `${c.median_days_on_market} across ${c.dom_sample_size} sampled items.`,
    `This band exceeds the peer-band median baseline on ${winner.improvementTriggers.length} metric(s) with no material weakness.`,
  ].join(' ');
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface StrongBalancedAcquisitionBandEvaluation {
  result: RuleEvaluationResult;
  candidateEvaluations: CandidateEvaluation[];
}

export function evaluateStrongBalancedAcquisitionBand(
  targetUserAcquisitionEvidence: unknown,
): StrongBalancedAcquisitionBandEvaluation {
  const candidates = extractAcquisitionBandCandidates(targetUserAcquisitionEvidence);

  if (candidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidateEvaluations: CandidateEvaluation[] = [];
  const eligibleCandidates: AcquisitionBandCandidate[] = [];

  for (const candidate of candidates) {
    const { eligible, reasons } = evaluateEligibility(candidate);
    if (eligible) eligibleCandidates.push(candidate);
    candidateEvaluations.push({
      finding_code: FINDING_CODE,
      acquisition_value_band_order: candidate.acquisition_value_band_order,
      acquisition_value_band_label: candidate.acquisition_value_band_label,
      eligible,
      eligibility_failure_reasons: reasons,
      material_improvement_triggers: [],
      material_weakness_triggers: [],
      qualifies: false,
      selected: false,
    });
  }

  if (eligibleCandidates.length < MIN_ELIGIBLE_PEER_GROUP_SIZE) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['INSUFFICIENT_ELIGIBLE_BANDS'] },
      candidateEvaluations,
    };
  }

  const qualifiedScored: ScoredCandidate[] = [];

  for (const candidate of eligibleCandidates) {
    const baseline = computePeerBandMedianBaseline(candidate, eligibleCandidates);
    const improvementTriggers = computeImprovementTriggers(candidate, baseline);
    const weaknessTriggers = computeWeaknessTriggers(candidate, baseline);
    const qualifies = improvementTriggers.length >= MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY && weaknessTriggers.length === 0;

    const evalRow = candidateEvaluations.find(
      (e) => e.acquisition_value_band_order === candidate.acquisition_value_band_order,
    )!;
    evalRow.material_improvement_triggers = improvementTriggers;
    evalRow.material_weakness_triggers = weaknessTriggers;
    evalRow.qualifies = qualifies;

    if (qualifies) qualifiedScored.push({ candidate, baseline, improvementTriggers, weaknessTriggers });
  }

  if (qualifiedScored.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['NO_MATERIAL_WINNER'] },
      candidateEvaluations,
    };
  }

  const qualifiers = [...qualifiedScored].sort(compareScoredCandidates);
  const winner = qualifiers[0];
  const runnerUp = qualifiers.length > 1 ? qualifiers[1] : null;

  const winnerEvalRow = candidateEvaluations.find(
    (e) => e.acquisition_value_band_order === winner.candidate.acquisition_value_band_order,
  )!;
  winnerEvalRow.selected = true;

  const finding: SelectedFinding = {
    finding_code: FINDING_CODE,
    family: 'acquisition_performance',
    direction: 'strength',
    status: 'selected',
    headline: `${winner.candidate.acquisition_value_band_label} is a strong, balanced acquisition band`,
    summary: buildSummary(winner),
    segment: buildSegment(winner.candidate),
    metrics: buildStandardMetrics(winner.candidate),
    baseline: winner.baseline,
    triggered_rules: [...winner.improvementTriggers, 'NO_MATERIAL_WEAKNESS'],
    confidence: winner.candidate.confidence as ConfidenceTier,
    limitations: [
      'PEER_BASELINE_USES_MEDIAN_OF_BAND_METRICS',
      'CATEGORY_MIX_NOT_CONTROLLED',
      'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
    ],
    evidence_refs: [
      'target_user_acquisition_evidence.acquisition_value_band_performance',
      'target_user_acquisition_evidence.acquisition_to_exit_analysis',
    ],
  };

  if (runnerUp) {
    finding.runner_up = {
      segment: buildSegment(runnerUp.candidate),
      metrics: buildStandardMetrics(runnerUp.candidate),
      triggered_rules: runnerUp.improvementTriggers,
      reason_not_selected: 'LOWER_RANKED_BY_TIE_BREAK',
    };
  }

  return { result: finding, candidateEvaluations };
}
