// Insights Engine v1.4 — Findings Selector rule: STRONG_DEAL_OUT_CHANNEL.
// Pure functions only — no I/O, no Supabase client. Identifies one Deal Out
// Channel with a strong balanced combination of profit, ROI, and DOM
// relative to the target user's OTHER eligible Deal Out Channels —
// descriptive, never causal (see buildSummary below).
//
// Channel semantics (see Analytics v2.5's own header, ported unchanged
// through v2.10): Deal Out Channel is the contact/counterparty source
// through which the item EXITED inventory — not a listing platform, and
// not necessarily the payment location.
//
// Evidence shape consumed (Analytics v2.10, unchanged, see
// supabase/migrations/20260816000000_build_analytics_snapshot_v2_5.sql,
// CTE dot_perf_rows):
//   target_user_deal_channel_evidence.deal_out_channel_performance.
//     performance_by_deal_out_channel[] — one row per (deal_out_channel_id,
//     deal_out_channel_name) pair, built from dot_realized (target_items
//     WHERE is_realized — pooled across every Purpose: Business, Hybrid,
//     Personal, no purpose_name filter). Unlike the channel-journey
//     matrix, this GROUP BY does NOT filter out a null channel — a missing
//     Deal Out Channel can appear as its own row here (same "never
//     dropped" convention as category_id) — so null/unknown exclusion is
//     enforced by this rule's own eligibility check, not by the source
//     query. Deliberately NOT deal_in_channel_performance, NOT
//     channel_journey, NOT cash_sales_by_deal_out_channel /
//     trade_exits_by_deal_out_channel / performance_by_deal_out_channel_
//     and_exit_band / performance_by_deal_out_channel_and_acquisition_band,
//     and NOT the _by_purpose sibling array.

import type {
  ConfidenceTier,
  DealOutChannelCandidate,
  DealOutChannelCandidateEvaluation,
  PeerDealOutChannelMedianBaseline,
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

export const FINDING_CODE = 'STRONG_DEAL_OUT_CHANNEL';

// This rule's own minimums — deliberately not comparisonHelpers'
// MIN_TOTAL_ITEM_COUNT (8), which is specific to the acquisition-band
// rules. MIN_DOM_SAMPLE_SIZE (5) and MIN_ELIGIBLE_PEER_GROUP_SIZE (3) are
// the same values other rules use, so those ARE reused.
const MIN_ITEM_COUNT = 5;
const MIN_DISTINCT_DEAL_COUNT = 4;

/**
 * Reads performance_by_deal_out_channel only — never shared/pooled
 * evidence, never Deal In evidence, never channel-journey evidence, never
 * the _by_purpose sibling, never item-level rows. Never throws — malformed
 * or missing evidence simply yields no candidates.
 */
export function extractDealOutChannelCandidates(
  targetUserDealChannelEvidence: unknown,
): DealOutChannelCandidate[] {
  const evidence = toRecord(targetUserDealChannelEvidence);
  const dealOutChannelPerformance = toRecord(evidence?.deal_out_channel_performance);

  const rows = Array.isArray(dealOutChannelPerformance?.performance_by_deal_out_channel)
    ? (dealOutChannelPerformance!.performance_by_deal_out_channel as unknown[])
    : [];

  const candidates: DealOutChannelCandidate[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;

    const channelId = toNumber(r.deal_out_channel_id);
    const channelName = typeof r.deal_out_channel_name === 'string' && r.deal_out_channel_name.length > 0 ? r.deal_out_channel_name : null;

    candidates.push({
      channel_id: channelId,
      channel_name: channelName,
      item_count: toNonNegativeInt(r.deal_out_item_count),
      distinct_deal_count: toNonNegativeInt(r.deal_out_distinct_deal_count),
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
// An ineligible channel is insufficient evidence, not weak performance.

function evaluateEligibility(c: DealOutChannelCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (c.channel_id === null || c.channel_name === null) reasons.push('CHANNEL_IDENTITY_MISSING');
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

// ── Peer Deal Out Channel median baseline ────────────────────────────────
// For each candidate: exclude the candidate, take the median of the
// remaining eligible channels' metrics. A median of aggregated channel
// metrics, not an item-level median — do not attempt to reconstruct
// item-level medians from aggregated medians. Realization rate is never
// used here (this evidence is realized-exits-only — no valid
// open-vs-realized denominator), so it is always null.

function computePeerDealOutChannelMedianBaseline(
  candidate: DealOutChannelCandidate,
  eligibleCandidates: DealOutChannelCandidate[],
): PeerDealOutChannelMedianBaseline {
  const peers = eligibleCandidates.filter((c) => c.channel_id !== candidate.channel_id);
  const metrics = computePeerMedianBaselineMetrics(
    peers.map((p) => ({
      median_net_profit: p.median_net_profit,
      median_roi: p.median_roi,
      median_days_on_market: p.median_days_on_market,
      realization_rate_percent: null,
    })),
  );
  return {
    type: 'peer_deal_out_channel_median_baseline',
    median_net_profit: metrics.median_net_profit,
    median_roi: metrics.median_roi,
    median_days_on_market: metrics.median_days_on_market,
    realization_rate_percent: null,
  };
}

// ── Winner selection ──────────────────────────────────────────────────────
// Deterministic tie-breakers, in order: (1) more material improvement
// triggers; (2) higher confidence; (3) larger distinct exit-deal count; (4)
// larger realized-item count; (5) higher median net profit; (6) higher
// median ROI; (7) lower median DOM; (8) ascending channel id.

interface ScoredCandidate {
  candidate: DealOutChannelCandidate;
  baseline: PeerDealOutChannelMedianBaseline;
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
    (x, y) => (x.candidate.channel_id as number) - (y.candidate.channel_id as number),
  ]);
}

function buildSegment(candidate: DealOutChannelCandidate): Record<string, unknown> {
  return {
    channel_id: candidate.channel_id,
    channel_name: candidate.channel_name,
  };
}

function buildMetrics(candidate: DealOutChannelCandidate): Record<string, unknown> {
  return {
    item_count: candidate.item_count,
    distinct_deal_count: candidate.distinct_deal_count,
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
    `Items exited through ${c.channel_name} showed a repeatable combination of ${metricsList} relative to other ` +
    `eligible Deal Out Channels (${c.item_count} realized items, ${c.distinct_deal_count} distinct exit deals, ` +
    `${c.confidence} confidence). This is descriptive, not proof that using this channel caused the result — it ` +
    `does not guarantee future exits through this channel will perform the same.`
  );
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface StrongDealOutChannelEvaluation {
  result: RuleEvaluationResult;
  candidateEvaluations: DealOutChannelCandidateEvaluation[];
}

export function evaluateStrongDealOutChannel(
  targetUserDealChannelEvidence: unknown,
): StrongDealOutChannelEvaluation {
  const candidates = extractDealOutChannelCandidates(targetUserDealChannelEvidence);

  if (candidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidateEvaluations: DealOutChannelCandidateEvaluation[] = [];
  const eligibleCandidates: DealOutChannelCandidate[] = [];

  for (const candidate of candidates) {
    const { eligible, reasons } = evaluateEligibility(candidate);
    if (eligible) eligibleCandidates.push(candidate);
    candidateEvaluations.push({
      finding_code: FINDING_CODE,
      channel_id: candidate.channel_id,
      channel_name: candidate.channel_name,
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
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['INSUFFICIENT_ELIGIBLE_DEAL_OUT_CHANNELS'] },
      candidateEvaluations,
    };
  }

  const qualifiedScored: ScoredCandidate[] = [];

  for (const candidate of eligibleCandidates) {
    const baseline = computePeerDealOutChannelMedianBaseline(candidate, eligibleCandidates);
    const candidatePeerMetrics = {
      median_net_profit: candidate.median_net_profit,
      median_roi: candidate.median_roi,
      median_days_on_market: candidate.median_days_on_market,
      realization_rate_percent: null,
    };
    const improvementTriggers = computeImprovementTriggers(candidatePeerMetrics, baseline);
    const weaknessTriggers = computeWeaknessTriggers(candidatePeerMetrics, baseline);
    const qualifies = improvementTriggers.length >= MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY && weaknessTriggers.length === 0;

    const evalRow = candidateEvaluations.find((e) => e.channel_id === candidate.channel_id)!;
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

  const winnerEvalRow = candidateEvaluations.find((e) => e.channel_id === winner.candidate.channel_id)!;
  winnerEvalRow.selected = true;

  const finding: SelectedFinding = {
    finding_code: FINDING_CODE,
    family: 'deal_out_channel_performance',
    direction: 'strength',
    status: 'selected',
    headline: `${winner.candidate.channel_name} is a strong, balanced Deal Out Channel`,
    summary: buildSummary(winner),
    segment: buildSegment(winner.candidate),
    metrics: buildMetrics(winner.candidate),
    baseline: winner.baseline,
    triggered_rules: [...winner.improvementTriggers, 'NO_MATERIAL_WEAKNESS'],
    confidence: winner.candidate.confidence as ConfidenceTier,
    limitations: [
      'PEER_BASELINE_USES_MEDIAN_OF_CHANNEL_METRICS',
      'CHANNEL_ASSOCIATION_NOT_CAUSATION',
      'ACQUISITION_METHOD_AND_EXIT_METHOD_MIX_NOT_CONTROLLED',
      'CATEGORY_AND_VALUE_BAND_MIX_NOT_CONTROLLED',
      'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
      'DEAL_CHANNEL_IS_CONTACT_SOURCE_NOT_PAYMENT_LOCATION',
    ],
    evidence_refs: ['target_user_deal_channel_evidence.deal_out_channel_performance.performance_by_deal_out_channel'],
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
