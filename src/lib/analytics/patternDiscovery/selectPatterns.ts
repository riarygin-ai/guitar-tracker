// Pattern Discovery Engine v1.0 — orchestration: evaluates every candidate
// segment, applies fixed-family overlap suppression, classifies confirmed
// patterns and emerging hypotheses, then applies the deterministic
// multiplicity guardrails (peer-group dedup, family dedup, global caps) —
// see thresholds.ts's own header for why these exist instead of formal
// statistical significance testing.

import { evaluateCandidateAtTier, historicalImportCompositionDiffPercentagePoints } from './evaluateCandidate';
import { classifyPattern } from './classifyPattern';
import { buildHeadline, buildSummary, buildConfirmationNeeded, candidatePatternCode } from './templates';
import {
  CONFIDENCE_RANK,
  FIXED_FAMILY_OWNERSHIP,
  HISTORICAL_IMPORT_COMPOSITION_DIFF_THRESHOLD_PP,
  HYPOTHESIS_MIN_METRIC_SAMPLE,
  MAX_EMERGING_HYPOTHESES,
  MAX_SELECTED_PATTERNS,
  NOVEL_FAMILIES,
} from './thresholds';
import type {
  ConfidenceTier,
  EmergingHypothesis,
  MetricEffect,
  PatternDiscoveryCandidateEvaluation,
  PatternDiscoveryCandidateSegment,
  PatternDiscoveryEvidence,
  PatternDiscoverySelectionSummary,
  PatternType,
  SelectedPattern,
} from './types';
import type { CandidateTierEvaluation } from './evaluateCandidate';
import type { Classification } from './classifyPattern';

export type TentativeStatus = 'selected' | 'hypothesis' | 'not_selected' | 'ineligible' | 'suppressed';

// Exported for direct unit testing of the ranking/redundancy-suppression
// mechanism in isolation (scripts/test-pattern-discovery-engine.ts) — with
// only 5 novel families currently defined, the family-dedup step alone
// already limits real output to <= 5, so the independent global-5 cap
// cannot be exercised through the full evidence pipeline alone and needs
// direct testing against synthetic rows.
export interface WorkingRow {
  candidate: PatternDiscoveryCandidateSegment;
  peerGroup: PatternDiscoveryCandidateSegment[];
  isFixedFamily: boolean;
  isNovelFamily: boolean;
  confirmedEval: CandidateTierEvaluation;
  hypothesisEval: CandidateTierEvaluation;
  confirmedClassification: Classification | null;
  hypothesisClassification: Classification | null;
  historicalDiffPp: number | null;
  status: TentativeStatus;
  eligibilityFailureReasons: string[];
  suppressionReasons: string[];
  usedTier: 'confirmed' | 'hypothesis' | null;
  // Set once, at initial classification, and never mutated afterward —
  // unlike `status`, which redundancy suppression later demotes to
  // 'suppressed'. Used for selection_summary counts and no_pattern_reasons
  // so a later suppression doesn't erase the fact a row DID qualify.
  originallyQualifiedTier: 'confirmed' | 'hypothesis' | null;
}

function metricEligibilityReasons(effects: MetricEffect[], minSample: number, tierLabel: string): string[] {
  const reasons: string[] = [];
  for (const e of effects) {
    if (e.available) continue;
    const shortCode = e.metric_code === 'median_net_profit' ? 'PROFIT' : e.metric_code === 'median_roi' ? 'ROI' : 'DOM';
    if (e.candidate_sample_size < minSample) {
      reasons.push(`${shortCode}_SAMPLE_BELOW_${tierLabel}_MINIMUM`);
    } else {
      reasons.push(`${shortCode}_INSUFFICIENT_PEER_SUPPORT_AT_${tierLabel}_TIER`);
    }
  }
  return reasons;
}

export function buildWorkingRow(
  candidate: PatternDiscoveryCandidateSegment,
  allByPeerGroup: Map<string, PatternDiscoveryCandidateSegment[]>,
): WorkingRow {
  const groupAll = allByPeerGroup.get(candidate.peer_group_key) ?? [];
  const peerGroup = groupAll.filter((c) => c !== candidate);

  const isFixedFamily = FIXED_FAMILY_OWNERSHIP.has(candidate.family_code);
  const isNovelFamily = NOVEL_FAMILIES.has(candidate.family_code);

  const confirmedEval = evaluateCandidateAtTier(candidate.family_code, candidate, peerGroup, 'confirmed');
  const hypothesisEval = evaluateCandidateAtTier(candidate.family_code, candidate, peerGroup, 'hypothesis');
  const confirmedClassification = classifyPattern(confirmedEval.metricEffects);
  const hypothesisClassification = classifyPattern(hypothesisEval.metricEffects);
  const historicalDiffPp = historicalImportCompositionDiffPercentagePoints(candidate, peerGroup);

  const row: WorkingRow = {
    candidate,
    peerGroup,
    isFixedFamily,
    isNovelFamily,
    confirmedEval,
    hypothesisEval,
    confirmedClassification,
    hypothesisClassification,
    historicalDiffPp,
    status: 'ineligible',
    eligibilityFailureReasons: [],
    suppressionReasons: [],
    usedTier: null,
    originallyQualifiedTier: null,
  };

  if (isFixedFamily) {
    row.status = 'suppressed';
    row.suppressionReasons = ['EXISTING_FIXED_INSIGHT_FAMILY'];
    row.usedTier = confirmedClassification ? 'confirmed' : hypothesisClassification ? 'hypothesis' : null;
    return row;
  }

  if (!isNovelFamily) {
    row.status = 'ineligible';
    row.eligibilityFailureReasons = ['FAMILY_NOT_RECOGNIZED_AS_NOVEL_OR_FIXED'];
    return row;
  }

  const confirmedQualifies =
    confirmedClassification !== null &&
    confirmedEval.triggeredSignals.length > 0 &&
    CONFIDENCE_RANK[confirmedEval.confidence] >= CONFIDENCE_RANK['moderate'];

  if (confirmedQualifies) {
    row.status = 'selected';
    row.usedTier = 'confirmed';
    row.originallyQualifiedTier = 'confirmed';
    return row;
  }

  const hypothesisQualifies =
    hypothesisClassification !== null &&
    hypothesisEval.triggeredSignals.length > 0 &&
    CONFIDENCE_RANK[hypothesisEval.confidence] >= CONFIDENCE_RANK['low'] &&
    candidate.realized_item_count >= HYPOTHESIS_MIN_METRIC_SAMPLE;

  if (hypothesisQualifies) {
    row.status = 'hypothesis';
    row.usedTier = 'hypothesis';
    row.originallyQualifiedTier = 'hypothesis';
    return row;
  }

  const anyMetricEvaluableAtHypothesisTier = hypothesisEval.metricEffects.some((e) => e.available);
  if (!anyMetricEvaluableAtHypothesisTier) {
    row.status = 'ineligible';
    row.eligibilityFailureReasons = metricEligibilityReasons(hypothesisEval.metricEffects, HYPOTHESIS_MIN_METRIC_SAMPLE, 'HYPOTHESIS');
  } else {
    row.status = 'not_selected';
    row.eligibilityFailureReasons =
      hypothesisEval.triggeredSignals.length === 0
        ? ['NO_MATERIAL_EFFECTS']
        : ['NO_QUALIFYING_PATTERN_TYPE_FOR_TRIGGERED_SIGNALS'];
  }
  return row;
}

// ── Deterministic ranking — lexicographic, no weighted score. Returns
// negative when `a` should rank ahead of `b`. ────────────────────────────

function tierEval(row: WorkingRow): CandidateTierEvaluation {
  return row.usedTier === 'hypothesis' ? row.hypothesisEval : row.confirmedEval;
}

function minTriggeredCandidateSample(row: WorkingRow): number {
  const effects = tierEval(row).metricEffects.filter((e) => e.materiality);
  if (effects.length === 0) return 0;
  return Math.min(...effects.map((e) => e.candidate_sample_size));
}

function minTriggeredPeerSample(row: WorkingRow): number {
  const effects = tierEval(row).metricEffects.filter((e) => e.materiality);
  if (effects.length === 0) return 0;
  return Math.min(...effects.map((e) => e.peer_minimum_sample_size ?? 0));
}

export function compareRank(a: WorkingRow, b: WorkingRow): number {
  const aTriggered = tierEval(a).triggeredSignals.length;
  const bTriggered = tierEval(b).triggeredSignals.length;
  if (aTriggered !== bTriggered) return bTriggered - aTriggered;

  const aConf = CONFIDENCE_RANK[tierEval(a).confidence];
  const bConf = CONFIDENCE_RANK[tierEval(b).confidence];
  if (aConf !== bConf) return bConf - aConf;

  const aMinCandidate = minTriggeredCandidateSample(a);
  const bMinCandidate = minTriggeredCandidateSample(b);
  if (aMinCandidate !== bMinCandidate) return bMinCandidate - aMinCandidate;

  const aMinPeer = minTriggeredPeerSample(a);
  const bMinPeer = minTriggeredPeerSample(b);
  if (aMinPeer !== bMinPeer) return bMinPeer - aMinPeer;

  if (a.candidate.realized_item_count !== b.candidate.realized_item_count) {
    return b.candidate.realized_item_count - a.candidate.realized_item_count;
  }

  if (a.candidate.dimension_count !== b.candidate.dimension_count) {
    return b.candidate.dimension_count - a.candidate.dimension_count;
  }

  return a.candidate.pattern_key < b.candidate.pattern_key ? -1 : a.candidate.pattern_key > b.candidate.pattern_key ? 1 : 0;
}

export function suppressRedundant(
  rows: WorkingRow[],
  keyFn: (row: WorkingRow) => string,
  reason: string,
): WorkingRow[] {
  const byKey = new Map<string, WorkingRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = byKey.get(key) ?? [];
    bucket.push(row);
    byKey.set(key, bucket);
  }

  const kept: WorkingRow[] = [];
  for (const bucket of Array.from(byKey.values())) {
    const sorted = [...bucket].sort(compareRank);
    kept.push(sorted[0]);
    for (const loser of sorted.slice(1)) {
      loser.status = 'suppressed';
      loser.suppressionReasons = [...loser.suppressionReasons, reason];
    }
  }
  return kept;
}

export function applyGlobalCap(rows: WorkingRow[], max: number, reason: string): WorkingRow[] {
  const sorted = [...rows].sort(compareRank);
  const kept = sorted.slice(0, max);
  for (const loser of sorted.slice(max)) {
    loser.status = 'suppressed';
    loser.suppressionReasons = [...loser.suppressionReasons, reason];
  }
  return kept;
}

// ── Row builders ──────────────────────────────────────────────────────

function buildSelectedPattern(row: WorkingRow): SelectedPattern {
  const classification = row.confirmedClassification!;
  const evalResult = row.confirmedEval;
  const limitations = buildRowLimitations(row, false);
  return {
    pattern_code: candidatePatternCode(classification.pattern_type, row.candidate.pattern_key),
    family_code: row.candidate.family_code,
    pattern_key: row.candidate.pattern_key,
    peer_group_key: row.candidate.peer_group_key,
    pattern_type: classification.pattern_type,
    direction: classification.direction,
    headline: buildHeadline(row.candidate.family_code, row.candidate.segment, classification.pattern_type),
    summary: buildSummary(row.candidate.family_code, row.candidate.segment, classification.pattern_type, evalResult.metricEffects, evalResult.triggeredSignals, false),
    segment: row.candidate.segment,
    population_basis: row.candidate.population_basis,
    evidence_confidence: evalResult.confidence,
    realized_item_count: row.candidate.realized_item_count,
    distinct_exit_deal_count: row.candidate.distinct_exit_deal_count,
    metric_effects: evalResult.metricEffects,
    triggered_signals: evalResult.triggeredSignals,
    limitations,
    evidence_refs: ['target_user_pattern_discovery_evidence.candidate_segments'],
  };
}

function buildEmergingHypothesis(row: WorkingRow): EmergingHypothesis {
  const classification = row.hypothesisClassification!;
  const evalResult = row.hypothesisEval;
  const limitations = buildRowLimitations(row, true);
  return {
    pattern_code: candidatePatternCode(classification.pattern_type, row.candidate.pattern_key),
    family_code: row.candidate.family_code,
    pattern_key: row.candidate.pattern_key,
    peer_group_key: row.candidate.peer_group_key,
    pattern_type: classification.pattern_type,
    direction: classification.direction,
    headline: buildHeadline(row.candidate.family_code, row.candidate.segment, classification.pattern_type),
    summary: buildSummary(row.candidate.family_code, row.candidate.segment, classification.pattern_type, evalResult.metricEffects, evalResult.triggeredSignals, true),
    segment: row.candidate.segment,
    population_basis: row.candidate.population_basis,
    evidence_confidence: evalResult.confidence,
    realized_item_count: row.candidate.realized_item_count,
    distinct_exit_deal_count: row.candidate.distinct_exit_deal_count,
    metric_effects: evalResult.metricEffects,
    triggered_signals: evalResult.triggeredSignals,
    limitations,
    evidence_refs: ['target_user_pattern_discovery_evidence.candidate_segments'],
    status: 'hypothesis',
    confirmation_needed: buildConfirmationNeeded(row.candidate),
    ineligibility_reasons: deriveHypothesisIneligibilityReasons(row),
  };
}

/**
 * Explains WHY a hypothesis-qualifying row didn't reach confirmed status —
 * the task's own "fails confirmed selection only because of low
 * confidence, confirmed peer support, or one missing supporting metric"
 * eligibility condition, made explicit and auditable.
 */
function deriveHypothesisIneligibilityReasons(row: WorkingRow): string[] {
  const reasons: string[] = [];
  if (CONFIDENCE_RANK[row.confirmedEval.confidence] < CONFIDENCE_RANK['moderate']) {
    reasons.push('CONFIRMED_CONFIDENCE_BELOW_MODERATE');
  }
  const insufficientPeerAtConfirmed = row.hypothesisEval.metricEffects.some((hypEffect) => {
    if (!hypEffect.materiality) return false;
    const confirmedEffect = row.confirmedEval.metricEffects.find((e) => e.metric_code === hypEffect.metric_code);
    return confirmedEffect ? !confirmedEffect.available && confirmedEffect.candidate_sample_size >= hypEffect.candidate_sample_size : false;
  });
  if (insufficientPeerAtConfirmed) reasons.push('CONFIRMED_PEER_SUPPORT_INSUFFICIENT');
  const missingSupportingMetricAtConfirmed = row.hypothesisEval.metricEffects.filter(
    (hypEffect) => hypEffect.materiality && !row.confirmedEval.metricEffects.find((e) => e.metric_code === hypEffect.metric_code)?.available,
  ).length;
  if (missingSupportingMetricAtConfirmed > 0) reasons.push('ONE_OR_MORE_SUPPORTING_METRICS_UNAVAILABLE_AT_CONFIRMED_TIER');
  if (row.confirmedClassification === null) reasons.push('CONFIRMED_TIER_DID_NOT_CLASSIFY');
  return reasons;
}

function buildRowLimitations(row: WorkingRow, isHypothesis: boolean): string[] {
  const limitations = new Set<string>(['REALIZED_ITEMS_ONLY', 'ASSOCIATION_NOT_CAUSATION', 'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED']);
  for (const l of row.candidate.limitations) limitations.add(l);
  if (row.historicalDiffPp !== null && row.historicalDiffPp >= HISTORICAL_IMPORT_COMPOSITION_DIFF_THRESHOLD_PP) {
    limitations.add('HISTORICAL_IMPORT_COMPOSITION_DIFFERS_FROM_PEERS');
  }
  if (isHypothesis) limitations.add('PRELIMINARY_HYPOTHESIS_NOT_YET_CONFIRMED');
  return Array.from(limitations);
}

function buildCandidateEvaluation(row: WorkingRow): PatternDiscoveryCandidateEvaluation {
  // Default to the more permissive hypothesis-tier evaluation for rows
  // that never qualified at either tier (not_selected/ineligible) — it
  // surfaces more diagnostic detail than the stricter confirmed tier for
  // rows where neither tier "won". Rows that DID qualify (selected/
  // hypothesis/fixed-suppressed) use whichever tier actually qualified
  // them, set once at creation and never mutated by later suppression.
  const usedEval = row.usedTier === 'confirmed' ? row.confirmedEval : row.hypothesisEval;
  const usedClassification = row.usedTier === 'confirmed' ? row.confirmedClassification : row.hypothesisClassification;
  const patternType: PatternType | null = usedClassification?.pattern_type ?? null;

  const limitations = new Set<string>();
  for (const l of row.candidate.limitations) limitations.add(l);
  if (row.historicalDiffPp !== null && row.historicalDiffPp >= HISTORICAL_IMPORT_COMPOSITION_DIFF_THRESHOLD_PP) {
    limitations.add('HISTORICAL_IMPORT_COMPOSITION_DIFFERS_FROM_PEERS');
  }

  return {
    family_code: row.candidate.family_code,
    pattern_key: row.candidate.pattern_key,
    peer_group_key: row.candidate.peer_group_key,
    segment: row.candidate.segment,
    status: row.status,
    pattern_type: patternType,
    evidence_confidence: usedEval.confidence as ConfidenceTier,
    metric_effects: usedEval.metricEffects,
    triggered_signals: usedEval.triggeredSignals,
    eligibility_failure_reasons: row.eligibilityFailureReasons,
    suppression_reasons: row.suppressionReasons,
    limitations: Array.from(limitations),
  };
}

// ── Top-level orchestration ──────────────────────────────────────────────

export interface SelectPatternsResult {
  selected_patterns: SelectedPattern[];
  emerging_hypotheses: EmergingHypothesis[];
  candidate_evaluations: PatternDiscoveryCandidateEvaluation[];
  selection_summary: PatternDiscoverySelectionSummary;
}

export function selectPatterns(evidence: PatternDiscoveryEvidence): SelectPatternsResult {
  const allByPeerGroup = new Map<string, PatternDiscoveryCandidateSegment[]>();
  for (const c of evidence.candidate_segments) {
    const bucket = allByPeerGroup.get(c.peer_group_key) ?? [];
    bucket.push(c);
    allByPeerGroup.set(c.peer_group_key, bucket);
  }

  const rows = evidence.candidate_segments.map((c) => buildWorkingRow(c, allByPeerGroup));

  // ── Redundancy suppression: selected candidates ─────────────────────
  let selectedRows = rows.filter((r) => r.status === 'selected');
  selectedRows = suppressRedundant(selectedRows, (r) => r.candidate.peer_group_key, 'LOWER_RANKED_WITHIN_PEER_GROUP');
  selectedRows = suppressRedundant(selectedRows, (r) => r.candidate.family_code, 'LOWER_RANKED_WITHIN_FAMILY');
  selectedRows = applyGlobalCap(selectedRows, MAX_SELECTED_PATTERNS, 'GLOBAL_PATTERN_LIMIT_REACHED');
  const peerGroupSuppressedCount = rows.filter((r) => r.suppressionReasons.includes('LOWER_RANKED_WITHIN_PEER_GROUP')).length;
  const familySuppressedCount = rows.filter(
    (r) => r.suppressionReasons.includes('LOWER_RANKED_WITHIN_FAMILY') && !r.suppressionReasons.includes('LOWER_RANKED_WITHIN_PEER_GROUP'),
  ).length;
  const globalLimitSuppressedCount = rows.filter((r) => r.suppressionReasons.includes('GLOBAL_PATTERN_LIMIT_REACHED')).length;

  // ── Redundancy suppression: emerging hypotheses (family dedup + global
  // cap only — no peer_group_key dedup, per the task's own guardrail list)
  let hypothesisRows = rows.filter((r) => r.status === 'hypothesis');
  hypothesisRows = suppressRedundant(hypothesisRows, (r) => r.candidate.family_code, 'LOWER_RANKED_WITHIN_FAMILY');
  hypothesisRows = applyGlobalCap(hypothesisRows, MAX_EMERGING_HYPOTHESES, 'GLOBAL_PATTERN_LIMIT_REACHED');

  const selectedPatterns = selectedRows.sort(compareRank).map(buildSelectedPattern);
  const emergingHypotheses = hypothesisRows.sort(compareRank).map(buildEmergingHypothesis);
  const candidateEvaluations = rows.map(buildCandidateEvaluation);

  const familyCounts: Record<string, number> = {};
  for (const c of evidence.candidate_segments) {
    familyCounts[c.family_code] = (familyCounts[c.family_code] ?? 0) + 1;
  }

  const patternTypeCounts: Record<string, number> = {};
  for (const p of [...selectedPatterns, ...emergingHypotheses]) {
    patternTypeCounts[p.pattern_type] = (patternTypeCounts[p.pattern_type] ?? 0) + 1;
  }

  const noPatternReasons = deriveNoPatternReasons(rows, selectedPatterns.length);

  const selectionSummary: PatternDiscoverySelectionSummary = {
    total_candidate_segment_count: evidence.candidate_segments.length,
    evaluated_candidate_count: rows.filter((r) => r.isNovelFamily).length,
    fixed_family_suppressed_count: rows.filter((r) => r.isFixedFamily).length,
    ineligible_count: rows.filter((r) => r.status === 'ineligible' && r.isNovelFamily).length,
    confirmed_qualifying_count: rows.filter((r) => r.originallyQualifiedTier === 'confirmed').length,
    selected_pattern_count: selectedPatterns.length,
    emerging_hypothesis_count: emergingHypotheses.length,
    peer_group_suppressed_count: peerGroupSuppressedCount,
    family_suppressed_count: familySuppressedCount,
    global_limit_suppressed_count: globalLimitSuppressedCount,
    family_counts: familyCounts,
    pattern_type_counts: patternTypeCounts,
    no_pattern_reasons: noPatternReasons,
  };

  return {
    selected_patterns: selectedPatterns,
    emerging_hypotheses: emergingHypotheses,
    candidate_evaluations: candidateEvaluations,
    selection_summary: selectionSummary,
  };
}

function deriveNoPatternReasons(rows: WorkingRow[], selectedPatternCount: number): PatternDiscoverySelectionSummary['no_pattern_reasons'] {
  if (selectedPatternCount > 0) return [];

  const novelRows = rows.filter((r) => r.isNovelFamily);
  if (novelRows.length === 0) return ['NO_NOVEL_FAMILIES_AVAILABLE'];

  const anyOriginallyQualified = novelRows.some((r) => r.originallyQualifiedTier === 'confirmed');
  if (anyOriginallyQualified) return ['ALL_QUALIFYING_PATTERNS_SUPPRESSED_AS_DUPLICATES'];

  const allIneligible = novelRows.every((r) => r.status === 'ineligible');
  if (allIneligible) return ['NO_CANDIDATES_MET_SAMPLE_REQUIREMENTS'];

  const anyPeerSupportFailure = novelRows.some((r) =>
    r.eligibilityFailureReasons.some((reason) => reason.includes('INSUFFICIENT_PEER_SUPPORT')),
  );
  if (anyPeerSupportFailure) return ['NO_CANDIDATES_MET_PEER_SUPPORT'];

  return ['NO_MATERIAL_EFFECTS'];
}
