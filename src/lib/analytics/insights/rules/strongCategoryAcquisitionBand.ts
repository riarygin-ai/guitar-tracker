// Insights Engine v1.1 — Findings Selector rule: STRONG_CATEGORY_
// ACQUISITION_BAND. Pure functions only — no I/O, no Supabase client. Finds
// the strongest balanced Category × Acquisition Value Band segment,
// comparing each candidate ONLY against other eligible bands within the
// SAME category (see same_category_peer_band_median_baseline below) — never
// against other categories. Shares every threshold, trigger, and tie-break
// atom with STRONG_BALANCED_ACQUISITION_BAND via comparisonHelpers.ts; only
// the evidence path, eligibility grouping, and baseline peer pool differ.
//
// Evidence shape consumed (Analytics v2.10, unchanged, see
// supabase/migrations/20260815000000_build_analytics_snapshot_v2_4.sql,
// CTE cx_catband_rows):
//   target_user_inventory_segmentation_evidence.category_type_performance.
//     performance_by_category_and_acquisition_band[] — one row per
//     (category_id, category_name, acquisition_value_band_order), already
//     restricted to acquisition_value_status = 'positive' (no zero/unknown/
//     negative rows), pooled across EVERY Purpose (Business, Hybrid,
//     Personal, missing_purpose, missing_policy — see cx_band_eligible's
//     source `target_items`, which reads analytics_item_lifecycle_v2's full
//     population, not the v1 Business-only view). Deliberately NOT the
//     _by_purpose sibling array — Purpose is current disposition context,
//     never an economic eligibility filter for this rule.

import type {
  CandidateEvaluation,
  CategoryAcquisitionBandCandidate,
  ConfidenceTier,
  RuleEvaluationResult,
  SameCategoryPeerBandMedianBaseline,
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

export const FINDING_CODE = 'STRONG_CATEGORY_ACQUISITION_BAND';

/**
 * Reads performance_by_category_and_acquisition_band only — never the
 * shared/pooled section, never the _by_purpose sibling, never item-level
 * OIDS rows, never open-item estimates. Never throws — malformed or missing
 * evidence simply yields no candidates.
 */
export function extractCategoryBandCandidates(
  targetUserInventorySegmentationEvidence: unknown,
): CategoryAcquisitionBandCandidate[] {
  const evidence = toRecord(targetUserInventorySegmentationEvidence);
  const categoryTypePerformance = toRecord(evidence?.category_type_performance);

  const rows = Array.isArray(categoryTypePerformance?.performance_by_category_and_acquisition_band)
    ? (categoryTypePerformance!.performance_by_category_and_acquisition_band as unknown[])
    : [];

  const candidates: CategoryAcquisitionBandCandidate[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;

    const order = toNumber(r.acquisition_value_band_order);
    const label = typeof r.acquisition_value_band_label === 'string' ? r.acquisition_value_band_label : null;
    if (order === null || label === null) continue;

    candidates.push({
      category_id: toNumber(r.category_id),
      category_name: typeof r.category_name === 'string' && r.category_name.length > 0 ? r.category_name : null,
      acquisition_value_band_order: order,
      acquisition_value_band_label: label,
      total_item_count: toNonNegativeInt(r.item_count),
      realized_item_count: toNonNegativeInt(r.realized_item_count),
      median_net_profit: toNumber(r.median_net_profit),
      median_roi: toNumber(r.median_roi),
      median_days_on_market: toNumber(r.median_days_on_market),
      dom_sample_size: toNonNegativeInt(r.dom_sample_size),
      realization_rate_percent: toNumber(r.realization_rate_percent),
      confidence: toConfidenceTier(r.confidence),
    });
  }

  return candidates;
}

// ── Row-level eligibility ─────────────────────────────────────────────────
// An ineligible segment is insufficient evidence, not a weak segment.
// Category grouping (>=3 eligible bands within the SAME category) is a
// second pass applied after this one — see evaluateStrongCategoryAcquisition
// Band below.

function evaluateRowEligibility(c: CategoryAcquisitionBandCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (c.category_id === null || c.category_name === null) reasons.push('CATEGORY_IDENTITY_MISSING');
  // performance_by_category_and_acquisition_band rows are already restricted
  // to acquisition_value_status = 'positive' at the source (cx_band_eligible),
  // so this also documents that invariant rather than relying on it silently.
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

// ── Same-category peer band median baseline ──────────────────────────────
// For each candidate: exclude the candidate, take the median of the OTHER
// eligible acquisition bands WITHIN THE SAME CATEGORY. A median of
// aggregated segment metrics, not an item-level median — do not attempt to
// reconstruct item-level medians from aggregated medians.

function computeSameCategoryPeerBandMedianBaseline(
  candidate: CategoryAcquisitionBandCandidate,
  sameCategoryEligibleCandidates: CategoryAcquisitionBandCandidate[],
): SameCategoryPeerBandMedianBaseline {
  const peers = sameCategoryEligibleCandidates.filter(
    (c) => c.acquisition_value_band_order !== candidate.acquisition_value_band_order,
  );
  return { type: 'same_category_peer_band_median_baseline', ...computePeerMedianBaselineMetrics(peers) };
}

// ── Winner selection ──────────────────────────────────────────────────────
// Deterministic tie-breakers, in order: (1) more material improvement
// triggers; (2) higher existing confidence rank; (3) larger realized item
// count; (4) higher realization rate; (5) lower median DOM; (6) ascending
// category id; (7) ascending acquisition-band order as the final
// deterministic tie-breaker.

interface ScoredCandidate {
  candidate: CategoryAcquisitionBandCandidate;
  baseline: SameCategoryPeerBandMedianBaseline;
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
    (x, y) => (x.candidate.category_id as number) - (y.candidate.category_id as number),
    (x, y) => x.candidate.acquisition_value_band_order - y.candidate.acquisition_value_band_order,
  ]);
}

function buildSegment(candidate: CategoryAcquisitionBandCandidate): Record<string, unknown> {
  return {
    category_id: candidate.category_id,
    category_name: candidate.category_name,
    acquisition_value_band_label: candidate.acquisition_value_band_label,
    acquisition_value_band_order: candidate.acquisition_value_band_order,
  };
}

function buildSummary(winner: ScoredCandidate): string {
  const c = winner.candidate;
  return [
    `${c.realized_item_count} of ${c.total_item_count} items in ${c.category_name} × ${c.acquisition_value_band_label} have realized ` +
      `(${c.realization_rate_percent}% realization rate).`,
    `Median net profit is CAD $${c.median_net_profit}, median ROI is ${c.median_roi}%, and median days on market is ` +
      `${c.median_days_on_market} across ${c.dom_sample_size} sampled items.`,
    `This segment exceeds the same-category peer-band median baseline on ${winner.improvementTriggers.length} metric(s) with no material weakness.`,
  ].join(' ');
}

function evaluationKey(categoryId: number | null, bandOrder: number): string {
  return `${categoryId ?? 'null'}:${bandOrder}`;
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface StrongCategoryAcquisitionBandEvaluation {
  result: RuleEvaluationResult;
  candidateEvaluations: CandidateEvaluation[];
}

export function evaluateStrongCategoryAcquisitionBand(
  targetUserInventorySegmentationEvidence: unknown,
): StrongCategoryAcquisitionBandEvaluation {
  const candidates = extractCategoryBandCandidates(targetUserInventorySegmentationEvidence);

  if (candidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidateEvaluations: CandidateEvaluation[] = [];
  const evalRowByKey = new Map<string, CandidateEvaluation>();
  const rowEligibleCandidates: CategoryAcquisitionBandCandidate[] = [];

  for (const candidate of candidates) {
    const { eligible, reasons } = evaluateRowEligibility(candidate);
    const evalRow: CandidateEvaluation = {
      finding_code: FINDING_CODE,
      acquisition_value_band_order: candidate.acquisition_value_band_order,
      acquisition_value_band_label: candidate.acquisition_value_band_label,
      category_id: candidate.category_id ?? undefined,
      category_name: candidate.category_name ?? undefined,
      eligible,
      eligibility_failure_reasons: reasons,
      material_improvement_triggers: [],
      material_weakness_triggers: [],
      qualifies: false,
      selected: false,
    };
    candidateEvaluations.push(evalRow);
    evalRowByKey.set(evaluationKey(candidate.category_id, candidate.acquisition_value_band_order), evalRow);
    if (eligible) rowEligibleCandidates.push(candidate);
  }

  // A category must have at least MIN_ELIGIBLE_PEER_GROUP_SIZE eligible
  // bands before any of its segments can be evaluated — this gives every
  // candidate at least two peer bands. Categories that don't clear this bar
  // are excluded (insufficient evidence), not marked weak: their rows stay
  // in candidateEvaluations with an explicit reason and empty trigger
  // arrays, never scored.
  const rowEligibleByCategory = new Map<number, CategoryAcquisitionBandCandidate[]>();
  for (const c of rowEligibleCandidates) {
    const key = c.category_id as number;
    const list = rowEligibleByCategory.get(key) ?? [];
    list.push(c);
    rowEligibleByCategory.set(key, list);
  }

  const eligibleCandidates: CategoryAcquisitionBandCandidate[] = [];
  for (const list of Array.from(rowEligibleByCategory.values())) {
    if (list.length < MIN_ELIGIBLE_PEER_GROUP_SIZE) {
      for (const c of list) {
        const evalRow = evalRowByKey.get(evaluationKey(c.category_id, c.acquisition_value_band_order))!;
        evalRow.eligible = false;
        evalRow.eligibility_failure_reasons = [...evalRow.eligibility_failure_reasons, 'CATEGORY_HAS_FEWER_THAN_THREE_ELIGIBLE_BANDS'];
      }
      continue;
    }
    eligibleCandidates.push(...list);
  }

  if (eligibleCandidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['INSUFFICIENT_ELIGIBLE_CATEGORY_BANDS'] },
      candidateEvaluations,
    };
  }

  const qualifiedScored: ScoredCandidate[] = [];

  for (const candidate of eligibleCandidates) {
    const sameCategoryPeerPool = eligibleCandidates.filter((c) => c.category_id === candidate.category_id);
    const baseline = computeSameCategoryPeerBandMedianBaseline(candidate, sameCategoryPeerPool);
    const improvementTriggers = computeImprovementTriggers(candidate, baseline);
    const weaknessTriggers = computeWeaknessTriggers(candidate, baseline);
    const qualifies = improvementTriggers.length >= MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY && weaknessTriggers.length === 0;

    const evalRow = evalRowByKey.get(evaluationKey(candidate.category_id, candidate.acquisition_value_band_order))!;
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

  const winnerEvalRow = evalRowByKey.get(evaluationKey(winner.candidate.category_id, winner.candidate.acquisition_value_band_order))!;
  winnerEvalRow.selected = true;

  const finding: SelectedFinding = {
    finding_code: FINDING_CODE,
    family: 'category_acquisition_performance',
    direction: 'strength',
    status: 'selected',
    headline: `${winner.candidate.category_name} × ${winner.candidate.acquisition_value_band_label} is a strong, balanced segment`,
    summary: buildSummary(winner),
    segment: buildSegment(winner.candidate),
    metrics: buildStandardMetrics(winner.candidate),
    baseline: winner.baseline,
    triggered_rules: [...winner.improvementTriggers, 'NO_MATERIAL_WEAKNESS'],
    confidence: winner.candidate.confidence as ConfidenceTier,
    limitations: [
      'PEER_BASELINE_USES_MEDIAN_OF_SEGMENT_METRICS',
      'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
      'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
    ],
    evidence_refs: [
      'target_user_inventory_segmentation_evidence.category_type_performance.performance_by_category_and_acquisition_band',
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
