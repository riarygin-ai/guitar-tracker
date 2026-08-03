// Insights Engine v1.3 — Findings Selector rule: STRONG_DEAL_IN_TO_DEAL_OUT_
// JOURNEY. Pure functions only — no I/O, no Supabase client. Identifies one
// repeatable Deal In Channel -> Deal Out Channel journey with a strong
// balanced combination of profit, ROI, and DOM relative to the target
// user's OTHER eligible journeys — descriptive, never causal (see
// buildSummary below).
//
// Channel semantics (see Analytics v2.5's own header, ported unchanged
// through v2.10): Deal In Channel is the contact/counterparty source
// through which the item ENTERED inventory; Deal Out Channel is the
// contact/counterparty source through which it EXITED. Neither is a
// payment location — a Reverb contact completed outside Reverb is still
// Reverb because Reverb generated the counterparty. A same-channel journey
// (deal_in_channel_id === deal_out_channel_id) is a descriptive fact, not
// evidence that using the same channel caused the result.
//
// Evidence shape consumed (Analytics v2.10, unchanged, see
// supabase/migrations/20260816000000_build_analytics_snapshot_v2_5.sql,
// CTE cjt_matrix_rows):
//   target_user_deal_channel_evidence.channel_journey.
//     deal_in_to_deal_out_matrix[] — one row per (deal_in_channel_id,
//     deal_in_channel_name, deal_out_channel_id, deal_out_channel_name)
//     pair, already restricted to realized items with both channel ids
//     present (cjt_eligible filters deal_in_channel_id IS NOT NULL AND
//     deal_out_channel_id IS NOT NULL), pooled across every Purpose
//     (Business, Hybrid, Personal — cjt_eligible descends from cjt_realized
//     -> target_items -> analytics_item_lifecycle_v2's full population, no
//     purpose_name filter). Deliberately NOT the _by_purpose sibling array,
//     NOT deal_in_channel_performance / deal_out_channel_performance
//     (listing-platform-exposure-adjacent evidence), and NOT paths_by_
//     acquisition_and_exit_method.

import type {
  ChannelJourneyCandidateEvaluation,
  ConfidenceTier,
  DealChannelJourneyCandidate,
  PeerChannelJourneyMedianBaseline,
  RuleEvaluationResult,
  SelectedFinding,
} from '../types';
import {
  MIN_DOM_SAMPLE_SIZE,
  MIN_ELIGIBLE_PEER_GROUP_SIZE,
  MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY,
  computeImprovementTriggers,
  computeWeaknessTriggers,
  computePeerMedianBaselineMetrics,
  CONFIDENCE_RANK,
  chainCompare,
  toRecord,
  toNumber,
  toNonNegativeInt,
  toConfidenceTier,
} from '../comparisonHelpers';

export const FINDING_CODE = 'STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY';

// This rule's own minimums — deliberately not comparisonHelpers'
// MIN_TOTAL_ITEM_COUNT (8), which is specific to the acquisition-band
// rules. MIN_DOM_SAMPLE_SIZE (5) and MIN_ELIGIBLE_PEER_GROUP_SIZE (3) are
// the same values other rules use, so those ARE reused.
const MIN_ITEM_COUNT = 5;
const MIN_DISTINCT_DEAL_COUNT = 4;

/**
 * Reads deal_in_to_deal_out_matrix only — never shared/pooled evidence,
 * never the _by_purpose sibling, never deal_in_channel_performance /
 * deal_out_channel_performance (listing-exposure-adjacent), never item-level
 * rows. Never throws — malformed or missing evidence simply yields no
 * candidates.
 */
export function extractDealChannelJourneyCandidates(
  targetUserDealChannelEvidence: unknown,
): DealChannelJourneyCandidate[] {
  const evidence = toRecord(targetUserDealChannelEvidence);
  const channelJourneySection = toRecord(evidence?.channel_journey);

  const rows = Array.isArray(channelJourneySection?.deal_in_to_deal_out_matrix)
    ? (channelJourneySection!.deal_in_to_deal_out_matrix as unknown[])
    : [];

  const candidates: DealChannelJourneyCandidate[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;

    const dealInChannelId = toNumber(r.deal_in_channel_id);
    const dealInChannelName = typeof r.deal_in_channel_name === 'string' && r.deal_in_channel_name.length > 0 ? r.deal_in_channel_name : null;
    const dealOutChannelId = toNumber(r.deal_out_channel_id);
    const dealOutChannelName = typeof r.deal_out_channel_name === 'string' && r.deal_out_channel_name.length > 0 ? r.deal_out_channel_name : null;

    // A journey row with no recognizable band-order-equivalent key (here,
    // no numeric identity at all on either side) can't be tracked through
    // eligibility/tie-break — skip rather than fabricate an identity.
    if (dealInChannelId === null && dealInChannelName === null && dealOutChannelId === null && dealOutChannelName === null) continue;

    const distinctAcquisitionDealCount = toNonNegativeInt(r.distinct_acquisition_deal_count);
    const distinctExitDealCount = toNonNegativeInt(r.distinct_exit_deal_count);

    candidates.push({
      deal_in_channel_id: dealInChannelId,
      deal_in_channel_name: dealInChannelName,
      deal_out_channel_id: dealOutChannelId,
      deal_out_channel_name: dealOutChannelName,
      item_count: toNonNegativeInt(r.journey_item_count),
      distinct_acquisition_deal_count: distinctAcquisitionDealCount,
      distinct_exit_deal_count: distinctExitDealCount,
      distinct_deal_count: Math.min(distinctAcquisitionDealCount, distinctExitDealCount),
      median_net_profit: toNumber(r.median_net_profit),
      median_roi: toNumber(r.median_roi),
      median_days_on_market: toNumber(r.median_days_on_market),
      dom_sample_size: toNonNegativeInt(r.dom_sample_size),
      confidence: toConfidenceTier(r.confidence),
    });
  }

  return candidates;
}

// ── Eligibility ───────────────────────────────────────────────────────────
// An ineligible journey is insufficient evidence, not weak performance.

function evaluateEligibility(c: DealChannelJourneyCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // deal_in_to_deal_out_matrix rows are already restricted to non-null
  // channel ids at the source (cjt_eligible), so this also documents that
  // invariant rather than relying on it silently.
  if (c.deal_in_channel_id === null || c.deal_in_channel_name === null) reasons.push('DEAL_IN_CHANNEL_IDENTITY_MISSING');
  if (c.deal_out_channel_id === null || c.deal_out_channel_name === null) reasons.push('DEAL_OUT_CHANNEL_IDENTITY_MISSING');
  if (c.item_count < MIN_ITEM_COUNT) reasons.push('ITEM_COUNT_BELOW_MINIMUM');
  if (c.distinct_deal_count < MIN_DISTINCT_DEAL_COUNT) reasons.push('DISTINCT_DEAL_COUNT_BELOW_MINIMUM');
  if (c.dom_sample_size < MIN_DOM_SAMPLE_SIZE) reasons.push('DOM_SAMPLE_SIZE_BELOW_MINIMUM');
  if (c.median_net_profit === null) reasons.push('MEDIAN_NET_PROFIT_MISSING');
  if (c.median_roi === null) reasons.push('MEDIAN_ROI_MISSING');
  if (c.median_days_on_market === null) reasons.push('MEDIAN_DOM_MISSING');
  if (c.confidence === null) reasons.push('CONFIDENCE_UNAVAILABLE');
  else if (c.confidence === 'insufficient') reasons.push('CONFIDENCE_INSUFFICIENT');

  return { eligible: reasons.length === 0, reasons };
}

// ── Peer channel journey median baseline ─────────────────────────────────
// For each candidate: exclude the candidate, take the median of the
// remaining eligible journeys' metrics. A median of aggregated journey
// metrics, not an item-level median — do not attempt to reconstruct
// item-level medians from aggregated medians. Realization rate is never
// used here (channel-journey rows are realized-exits-only — no valid
// open-vs-realized denominator), so it is always null.

function isSameJourney(a: DealChannelJourneyCandidate, b: DealChannelJourneyCandidate): boolean {
  return a.deal_in_channel_id === b.deal_in_channel_id && a.deal_out_channel_id === b.deal_out_channel_id;
}

function computePeerChannelJourneyMedianBaseline(
  candidate: DealChannelJourneyCandidate,
  eligibleCandidates: DealChannelJourneyCandidate[],
): PeerChannelJourneyMedianBaseline {
  const peers = eligibleCandidates.filter((c) => !isSameJourney(c, candidate));
  const metrics = computePeerMedianBaselineMetrics(
    peers.map((p) => ({
      median_net_profit: p.median_net_profit,
      median_roi: p.median_roi,
      median_days_on_market: p.median_days_on_market,
      realization_rate_percent: null,
    })),
  );
  return {
    type: 'peer_channel_journey_median_baseline',
    median_net_profit: metrics.median_net_profit,
    median_roi: metrics.median_roi,
    median_days_on_market: metrics.median_days_on_market,
    realization_rate_percent: null,
  };
}

// ── Winner selection ──────────────────────────────────────────────────────
// Deterministic tie-breakers, in order: (1) more material improvement
// triggers; (2) higher confidence; (3) larger distinct deal count; (4)
// larger item count; (5) higher median net profit; (6) higher median ROI;
// (7) lower median DOM; (8) ascending Deal In channel id; (9) ascending
// Deal Out channel id.

interface ScoredCandidate {
  candidate: DealChannelJourneyCandidate;
  baseline: PeerChannelJourneyMedianBaseline;
  improvementTriggers: string[];
  weaknessTriggers: string[];
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  return chainCompare(a, b, [
    (x, y) => y.improvementTriggers.length - x.improvementTriggers.length,
    (x, y) => CONFIDENCE_RANK[y.candidate.confidence as ConfidenceTier] - CONFIDENCE_RANK[x.candidate.confidence as ConfidenceTier],
    (x, y) => y.candidate.distinct_deal_count - x.candidate.distinct_deal_count,
    (x, y) => y.candidate.item_count - x.candidate.item_count,
    (x, y) => (y.candidate.median_net_profit as number) - (x.candidate.median_net_profit as number),
    (x, y) => (y.candidate.median_roi as number) - (x.candidate.median_roi as number),
    (x, y) => (x.candidate.median_days_on_market as number) - (y.candidate.median_days_on_market as number),
    (x, y) => (x.candidate.deal_in_channel_id as number) - (y.candidate.deal_in_channel_id as number),
    (x, y) => (x.candidate.deal_out_channel_id as number) - (y.candidate.deal_out_channel_id as number),
  ]);
}

function buildSegment(candidate: DealChannelJourneyCandidate): Record<string, unknown> {
  return {
    deal_in_channel_id: candidate.deal_in_channel_id,
    deal_in_channel_name: candidate.deal_in_channel_name,
    deal_out_channel_id: candidate.deal_out_channel_id,
    deal_out_channel_name: candidate.deal_out_channel_name,
    same_channel: candidate.deal_in_channel_id === candidate.deal_out_channel_id,
  };
}

function buildMetrics(candidate: DealChannelJourneyCandidate): Record<string, unknown> {
  return {
    item_count: candidate.item_count,
    distinct_deal_count: candidate.distinct_deal_count,
    distinct_acquisition_deal_count: candidate.distinct_acquisition_deal_count,
    distinct_exit_deal_count: candidate.distinct_exit_deal_count,
    median_net_profit: candidate.median_net_profit,
    median_roi: candidate.median_roi,
    median_days_on_market: candidate.median_days_on_market,
    dom_sample_size: candidate.dom_sample_size,
  };
}

function buildSummary(winner: ScoredCandidate): string {
  const c = winner.candidate;
  const metricWords: string[] = [];
  if (winner.improvementTriggers.includes('PROFIT_ABOVE_PEER_BASELINE')) metricWords.push('profit');
  if (winner.improvementTriggers.includes('ROI_ABOVE_PEER_BASELINE')) metricWords.push('ROI');
  if (winner.improvementTriggers.includes('DOM_FASTER_THAN_PEER_BASELINE')) metricWords.push('faster DOM');
  const metricsList = metricWords.length > 0 ? metricWords.join(', ') : 'the tracked metrics';

  return (
    `Items sourced through ${c.deal_in_channel_name} and later exited through ${c.deal_out_channel_name} showed a ` +
    `repeatable combination of ${metricsList} relative to other eligible channel journeys (${c.item_count} items, ` +
    `${c.distinct_deal_count} distinct deals, ${c.confidence} confidence). This is descriptive, not proof that using ` +
    `this channel journey caused the result — it does not guarantee future deals routed the same way will perform ` +
    `the same.`
  );
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface StrongDealInToDealOutJourneyEvaluation {
  result: RuleEvaluationResult;
  candidateEvaluations: ChannelJourneyCandidateEvaluation[];
}

export function evaluateStrongDealInToDealOutJourney(
  targetUserDealChannelEvidence: unknown,
): StrongDealInToDealOutJourneyEvaluation {
  const candidates = extractDealChannelJourneyCandidates(targetUserDealChannelEvidence);

  if (candidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidateEvaluations: ChannelJourneyCandidateEvaluation[] = [];
  const eligibleCandidates: DealChannelJourneyCandidate[] = [];

  for (const candidate of candidates) {
    const { eligible, reasons } = evaluateEligibility(candidate);
    if (eligible) eligibleCandidates.push(candidate);
    candidateEvaluations.push({
      finding_code: FINDING_CODE,
      deal_in_channel_id: candidate.deal_in_channel_id,
      deal_in_channel_name: candidate.deal_in_channel_name,
      deal_out_channel_id: candidate.deal_out_channel_id,
      deal_out_channel_name: candidate.deal_out_channel_name,
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
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['INSUFFICIENT_ELIGIBLE_JOURNEYS'] },
      candidateEvaluations,
    };
  }

  const qualifiedScored: ScoredCandidate[] = [];

  for (const candidate of eligibleCandidates) {
    const baseline = computePeerChannelJourneyMedianBaseline(candidate, eligibleCandidates);
    const candidatePeerMetrics = {
      median_net_profit: candidate.median_net_profit,
      median_roi: candidate.median_roi,
      median_days_on_market: candidate.median_days_on_market,
      realization_rate_percent: null,
    };
    const improvementTriggers = computeImprovementTriggers(candidatePeerMetrics, baseline);
    const weaknessTriggers = computeWeaknessTriggers(candidatePeerMetrics, baseline);
    const qualifies = improvementTriggers.length >= MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY && weaknessTriggers.length === 0;

    const evalRow = candidateEvaluations.find(
      (e) => e.deal_in_channel_id === candidate.deal_in_channel_id && e.deal_out_channel_id === candidate.deal_out_channel_id,
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
    (e) => e.deal_in_channel_id === winner.candidate.deal_in_channel_id && e.deal_out_channel_id === winner.candidate.deal_out_channel_id,
  )!;
  winnerEvalRow.selected = true;

  const finding: SelectedFinding = {
    finding_code: FINDING_CODE,
    family: 'channel_journey_performance',
    direction: 'strength',
    status: 'selected',
    headline: `${winner.candidate.deal_in_channel_name} → ${winner.candidate.deal_out_channel_name} is a strong, balanced channel journey`,
    summary: buildSummary(winner),
    segment: buildSegment(winner.candidate),
    metrics: buildMetrics(winner.candidate),
    baseline: winner.baseline,
    triggered_rules: [...winner.improvementTriggers, 'NO_MATERIAL_WEAKNESS'],
    confidence: winner.candidate.confidence as ConfidenceTier,
    limitations: [
      'PEER_BASELINE_USES_MEDIAN_OF_JOURNEY_METRICS',
      'CHANNEL_ASSOCIATION_NOT_CAUSATION',
      'ACQUISITION_AND_EXIT_METHOD_MIX_NOT_CONTROLLED',
      'CATEGORY_AND_VALUE_BAND_MIX_NOT_CONTROLLED',
      'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
      'DEAL_CHANNEL_IS_CONTACT_SOURCE_NOT_PAYMENT_LOCATION',
    ],
    evidence_refs: ['target_user_deal_channel_evidence.channel_journey.deal_in_to_deal_out_matrix'],
  };

  if (runnerUp) {
    finding.runner_up = {
      segment: buildSegment(runnerUp.candidate),
      metrics: buildMetrics(runnerUp.candidate),
      triggered_rules: runnerUp.improvementTriggers,
      reason_not_selected: 'LOWER_RANKED_BY_TIE_BREAK',
    };
  }

  return { result: finding, candidateEvaluations };
}
