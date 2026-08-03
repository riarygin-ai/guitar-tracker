// Insights Engine v1.6 — Findings Selector rule: STRONG_LISTING_PLATFORM.
// Pure functions only — no I/O, no Supabase client. Identifies at most one
// listing platform with a strong, balanced combination of profit, ROI,
// platform-specific listing-to-exit timing, and realization rate relative
// to the target user's OTHER eligible listing platforms — descriptive,
// never causal (see buildSummary below).
//
// Listing Platform semantics: where an item was ADVERTISED — never where
// the buyer was found and never which Deal Out channel completed the exit
// (see EXIT_CHANNEL_NOT_ATTRIBUTABLE_TO_LISTING_PLATFORM below). This rule
// answers a different question than STRONG_DEAL_OUT_CHANNEL and the two
// are never deduplicated or suppressed against each other, even when they
// happen to reference the same channel name.
//
// Evidence shape consumed (Analytics v2.11, unchanged by this task — see
// supabase/migrations/20260817000000_build_analytics_snapshot_v2_6.sql
// Query B for the original fields and 20260822000000_build_analytics_
// snapshot_v2_11.sql for the added per-platform timing fields):
//   target_user_listing_channel_evidence.performance_by_listing_channel[]
//     — one row per (listing_channel_id, listing_channel_name) pair, pooled
//     across every Purpose (Business, Hybrid, Personal — no purpose_name
//     filter) and across Historical Imports and app-tracked items alike
//     (platform-specific listing-to-exit timing does not depend on
//     acquisition date, so Historical Imports are never excluded here).
//     Deliberately NOT shared_listing_channel_evidence, NOT
//     performance_by_listing_channel_by_purpose, NOT listing_to_deal_out(_
//     by_purpose), NOT open_inventory_by_listing_channel, NOT
//     cross_listing_summary, NOT Deal In/Deal Out channel evidence, and
//     NOT dom_sample_size/median_days_on_market (those remain the GLOBAL
//     lifecycle DOM fields — an item's own first listing across ALL its
//     channels, not this specific platform's exposure).
//
// realization_rate_percent has no direct source field — this section
// carries exposed_item_count and realized_exposed_item_count only, so it
// is computed here in TypeScript (see computeRealizationRatePercent).
//
// Cross-listing: a cross-listed item contributes to every platform it was
// exposed on — platform cohorts are not mutually exclusive, and this rule
// never infers which listing generated the buyer. Cross-listing
// EFFECTIVENESS (comparing cross-listed vs. single-listed outcomes) is
// explicitly out of scope for this rule.

import type {
  ConfidenceTier,
  ListingPlatformCandidate,
  ListingPlatformCandidateEvaluation,
  ListingPlatformFinding,
  ListingPlatformRuleEvaluationResult,
  PeerListingPlatformMedianBaseline,
} from '../types';
import {
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
  type PeerComparableMetrics,
} from '../comparisonHelpers';

export const FINDING_CODE = 'STRONG_LISTING_PLATFORM';

// This rule's own minimums — deliberately not comparisonHelpers' shared
// MIN_TOTAL_ITEM_COUNT/MIN_REALIZED_ITEM_COUNT/MIN_DOM_SAMPLE_SIZE (kept
// local since these are this rule's own requirements over its own fields,
// not borrowed meaning — MIN_DOM_SAMPLE_SIZE in particular names a GLOBAL
// DOM concept this rule never touches). MIN_ELIGIBLE_PEER_GROUP_SIZE (3)
// and MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY (2) ARE reused — those are the
// same cross-rule invariants every peer-baseline rule shares.
const MIN_EXPOSED_ITEM_COUNT = 8;
const MIN_REALIZED_EXPOSED_ITEM_COUNT = 5;
const MIN_CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE = 5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Evidence carries exposed_item_count and realized_exposed_item_count but
// no direct ratio field — this is the one metric this rule computes
// itself rather than reading verbatim from Analytics.
function computeRealizationRatePercent(realizedExposedItemCount: number, exposedItemCount: number): number | null {
  if (exposedItemCount === 0) return null;
  return round2((realizedExposedItemCount / exposedItemCount) * 100);
}

/**
 * Reads target_user_listing_channel_evidence.performance_by_listing_
 * channel only — never shared/pooled evidence, never the _by_purpose
 * sibling, never listing_to_deal_out/open_inventory/cross_listing_summary,
 * never Deal In/Deal Out channel evidence, never item-level rows. Never
 * throws — malformed or missing evidence simply yields no candidates.
 */
export function extractListingPlatformCandidates(
  targetUserListingChannelEvidence: unknown,
): ListingPlatformCandidate[] {
  const evidence = toRecord(targetUserListingChannelEvidence);
  const rows = Array.isArray(evidence?.performance_by_listing_channel)
    ? (evidence!.performance_by_listing_channel as unknown[])
    : [];

  const candidates: ListingPlatformCandidate[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;

    const listingChannelId = toNumber(r.listing_channel_id);
    const listingChannelName =
      typeof r.listing_channel_name === 'string' && r.listing_channel_name.length > 0 ? r.listing_channel_name : null;
    const exposedItemCount = toNonNegativeInt(r.exposed_item_count);
    const realizedExposedItemCount = toNonNegativeInt(r.realized_exposed_item_count);

    candidates.push({
      listing_channel_id: listingChannelId,
      listing_channel_name: listingChannelName,
      exposed_item_count: exposedItemCount,
      realized_exposed_item_count: realizedExposedItemCount,
      realization_rate_percent: computeRealizationRatePercent(realizedExposedItemCount, exposedItemCount),
      median_net_profit: toNumber(r.median_net_profit),
      median_roi: toNumber(r.median_roi),
      channel_listing_to_exit_sample_size: toNonNegativeInt(r.channel_listing_to_exit_sample_size),
      median_channel_listing_to_exit_days: toNumber(r.median_channel_listing_to_exit_days),
      channel_listing_to_exit_coverage_percent: toNumber(r.channel_listing_to_exit_coverage_percent),
      invalid_channel_listing_after_exit_count: toNonNegativeInt(r.invalid_channel_listing_after_exit_count),
      missing_channel_listing_to_exit_count: toNonNegativeInt(r.missing_channel_listing_to_exit_count),
      confidence: toConfidenceTier(r.confidence),
      listing_record_count: toNumber(r.listing_record_count),
      sale_exit_item_count: toNumber(r.sale_exit_item_count),
      trade_exit_item_count: toNumber(r.trade_exit_item_count),
      same_channel_exit_item_count: toNumber(r.same_channel_exit_item_count),
      different_channel_exit_item_count: toNumber(r.different_channel_exit_item_count),
    });
  }

  return candidates;
}

// ── Eligibility ───────────────────────────────────────────────────────────
// An ineligible platform lacks sufficient evidence — it is insufficient,
// not weak performance. Every condition is checked independently (no
// short-circuiting) so eligibility_failure_reasons reports every reason a
// platform failed, not just the first.

function evaluateEligibility(c: ListingPlatformCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (c.listing_channel_id === null || c.listing_channel_name === null) reasons.push('LISTING_CHANNEL_IDENTITY_MISSING');
  if (c.exposed_item_count < MIN_EXPOSED_ITEM_COUNT) reasons.push('EXPOSED_ITEM_COUNT_BELOW_MINIMUM');
  if (c.realized_exposed_item_count < MIN_REALIZED_EXPOSED_ITEM_COUNT) reasons.push('REALIZED_EXPOSED_ITEM_COUNT_BELOW_MINIMUM');
  if (c.channel_listing_to_exit_sample_size < MIN_CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE) reasons.push('CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE_BELOW_MINIMUM');
  if (c.median_net_profit === null) reasons.push('MEDIAN_NET_PROFIT_MISSING');
  if (c.median_roi === null) reasons.push('MEDIAN_ROI_MISSING');
  if (c.median_channel_listing_to_exit_days === null) reasons.push('MEDIAN_CHANNEL_LISTING_TO_EXIT_DAYS_MISSING');
  if (c.realization_rate_percent === null) reasons.push('REALIZATION_RATE_MISSING');
  if (c.confidence === null) reasons.push('CONFIDENCE_UNAVAILABLE');
  else if (c.confidence === 'insufficient') reasons.push('CONFIDENCE_INSUFFICIENT');

  return { eligible: reasons.length === 0, reasons };
}

// ── Peer listing-platform median baseline ────────────────────────────────
// For each candidate: exclude the candidate, take the median of the
// remaining eligible platforms' metrics. A median of aggregated platform
// metrics, not an item-level median — do not attempt to reconstruct
// item-level medians from aggregated medians.
//
// computeImprovementTriggers/computeWeaknessTriggers/
// computePeerMedianBaselineMetrics are reused verbatim from
// comparisonHelpers (same thresholds: profit >=$150 or 15%, ROI >=5pp
// improvement / >=7pp weakness, "DOM" >=7 days or 20% faster / >=7 days
// and 25% slower, realization >=10pp either direction) via a structural
// mapping onto their generic `median_days_on_market` key — this rule's
// own median_channel_listing_to_exit_days value is passed positionally,
// never the GLOBAL DOM field. renamePlatformTimingTriggers immediately
// relabels the returned DOM_*_PEER_BASELINE trigger codes so nothing in
// this rule's own output ever says "DOM".

function toPeerComparableMetrics(c: ListingPlatformCandidate): PeerComparableMetrics {
  return {
    median_net_profit: c.median_net_profit,
    median_roi: c.median_roi,
    median_days_on_market: c.median_channel_listing_to_exit_days,
    realization_rate_percent: c.realization_rate_percent,
  };
}

function baselineToPeerComparableMetrics(b: PeerListingPlatformMedianBaseline): PeerComparableMetrics {
  return {
    median_net_profit: b.median_net_profit,
    median_roi: b.median_roi,
    median_days_on_market: b.median_channel_listing_to_exit_days,
    realization_rate_percent: b.realization_rate_percent,
  };
}

const PLATFORM_TIMING_TRIGGER_RENAME: Record<string, string> = {
  DOM_FASTER_THAN_PEER_BASELINE: 'LISTING_TO_EXIT_FASTER_THAN_PEER_BASELINE',
  DOM_WORSE_THAN_PEER_BASELINE: 'LISTING_TO_EXIT_SLOWER_THAN_PEER_BASELINE',
};

function renamePlatformTimingTriggers(triggers: string[]): string[] {
  return triggers.map((t) => PLATFORM_TIMING_TRIGGER_RENAME[t] ?? t);
}

function computePeerListingPlatformMedianBaseline(
  candidate: ListingPlatformCandidate,
  eligibleCandidates: ListingPlatformCandidate[],
): PeerListingPlatformMedianBaseline {
  const peers = eligibleCandidates.filter((c) => c.listing_channel_id !== candidate.listing_channel_id);
  const metrics = computePeerMedianBaselineMetrics(peers.map(toPeerComparableMetrics));
  return {
    type: 'peer_listing_platform_median_baseline',
    median_net_profit: metrics.median_net_profit,
    median_roi: metrics.median_roi,
    median_channel_listing_to_exit_days: metrics.median_days_on_market,
    realization_rate_percent: metrics.realization_rate_percent,
  };
}

// ── Winner selection ──────────────────────────────────────────────────────
// Deterministic tie-breakers, in order: (1) more material improvement
// triggers; (2) higher confidence; (3) larger realized_exposed_item_count;
// (4) larger exposed_item_count; (5) higher realization_rate_percent;
// (6) higher median_net_profit; (7) higher median_roi; (8) lower
// median_channel_listing_to_exit_days; (9) ascending listing_channel_id.

interface ScoredCandidate {
  candidate: ListingPlatformCandidate;
  baseline: PeerListingPlatformMedianBaseline;
  improvementTriggers: string[];
  weaknessTriggers: string[];
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  return chainCompare(a, b, [
    (x, y) => y.improvementTriggers.length - x.improvementTriggers.length,
    (x, y) => CONFIDENCE_RANK[y.candidate.confidence as ConfidenceTier] - CONFIDENCE_RANK[x.candidate.confidence as ConfidenceTier],
    (x, y) => y.candidate.realized_exposed_item_count - x.candidate.realized_exposed_item_count,
    (x, y) => y.candidate.exposed_item_count - x.candidate.exposed_item_count,
    (x, y) => (y.candidate.realization_rate_percent as number) - (x.candidate.realization_rate_percent as number),
    (x, y) => (y.candidate.median_net_profit as number) - (x.candidate.median_net_profit as number),
    (x, y) => (y.candidate.median_roi as number) - (x.candidate.median_roi as number),
    (x, y) => (x.candidate.median_channel_listing_to_exit_days as number) - (y.candidate.median_channel_listing_to_exit_days as number),
    (x, y) => (x.candidate.listing_channel_id as number) - (y.candidate.listing_channel_id as number),
  ]);
}

function buildSegment(candidate: ListingPlatformCandidate): Record<string, unknown> {
  return {
    listing_channel_id: candidate.listing_channel_id,
    listing_channel_name: candidate.listing_channel_name,
  };
}

function buildMetrics(candidate: ListingPlatformCandidate): Record<string, unknown> {
  return {
    exposed_item_count: candidate.exposed_item_count,
    realized_exposed_item_count: candidate.realized_exposed_item_count,
    realization_rate_percent: candidate.realization_rate_percent,
    median_net_profit: candidate.median_net_profit,
    median_roi: candidate.median_roi,
    channel_listing_to_exit_sample_size: candidate.channel_listing_to_exit_sample_size,
    median_channel_listing_to_exit_days: candidate.median_channel_listing_to_exit_days,
    channel_listing_to_exit_coverage_percent: candidate.channel_listing_to_exit_coverage_percent,
    invalid_channel_listing_after_exit_count: candidate.invalid_channel_listing_after_exit_count,
    missing_channel_listing_to_exit_count: candidate.missing_channel_listing_to_exit_count,
    listing_record_count: candidate.listing_record_count,
    sale_exit_item_count: candidate.sale_exit_item_count,
    trade_exit_item_count: candidate.trade_exit_item_count,
    same_channel_exit_item_count: candidate.same_channel_exit_item_count,
    different_channel_exit_item_count: candidate.different_channel_exit_item_count,
  };
}

function buildSummary(winner: ScoredCandidate): string {
  const c = winner.candidate;
  const metricWords: string[] = [];
  if (winner.improvementTriggers.includes('PROFIT_ABOVE_PEER_BASELINE')) metricWords.push('profit');
  if (winner.improvementTriggers.includes('ROI_ABOVE_PEER_BASELINE')) metricWords.push('ROI');
  if (winner.improvementTriggers.includes('LISTING_TO_EXIT_FASTER_THAN_PEER_BASELINE')) metricWords.push('faster listing-to-exit timing');
  if (winner.improvementTriggers.includes('REALIZATION_ABOVE_PEER_BASELINE')) metricWords.push('realization rate');
  const metricsList = metricWords.length > 0 ? metricWords.join(', ') : 'the tracked metrics';

  return (
    `Items listed on ${c.listing_channel_name} showed a repeatable combination of ${metricsList} relative to other ` +
    `eligible listing platforms (${c.exposed_item_count} exposed items, ${c.realized_exposed_item_count} realized, ` +
    `${c.confidence} confidence). Listing Platform means where an item was advertised — this does not identify where ` +
    `the buyer was found or which Deal Out channel completed the exit, and it is descriptive, not proof that listing ` +
    `on this platform caused the result.`
  );
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface StrongListingPlatformEvaluation {
  result: ListingPlatformRuleEvaluationResult;
  candidateEvaluations: ListingPlatformCandidateEvaluation[];
}

export function evaluateStrongListingPlatform(
  targetUserListingChannelEvidence: unknown,
): StrongListingPlatformEvaluation {
  const candidates = extractListingPlatformCandidates(targetUserListingChannelEvidence);

  if (candidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidateEvaluations: ListingPlatformCandidateEvaluation[] = [];
  const eligibleCandidates: ListingPlatformCandidate[] = [];

  for (const candidate of candidates) {
    const { eligible, reasons } = evaluateEligibility(candidate);
    if (eligible) eligibleCandidates.push(candidate);
    candidateEvaluations.push({
      finding_code: FINDING_CODE,
      listing_channel_id: candidate.listing_channel_id,
      listing_channel_name: candidate.listing_channel_name,
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
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS'] },
      candidateEvaluations,
    };
  }

  const qualifiedScored: ScoredCandidate[] = [];

  for (const candidate of eligibleCandidates) {
    const baseline = computePeerListingPlatformMedianBaseline(candidate, eligibleCandidates);
    const improvementTriggers = renamePlatformTimingTriggers(
      computeImprovementTriggers(toPeerComparableMetrics(candidate), baselineToPeerComparableMetrics(baseline)),
    );
    const weaknessTriggers = renamePlatformTimingTriggers(
      computeWeaknessTriggers(toPeerComparableMetrics(candidate), baselineToPeerComparableMetrics(baseline)),
    );
    const qualifies = improvementTriggers.length >= MIN_MATERIAL_IMPROVEMENTS_TO_QUALIFY && weaknessTriggers.length === 0;

    const evalRow = candidateEvaluations.find((e) => e.listing_channel_id === candidate.listing_channel_id)!;
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

  const winnerEvalRow = candidateEvaluations.find((e) => e.listing_channel_id === winner.candidate.listing_channel_id)!;
  winnerEvalRow.selected = true;

  const limitations = [
    'PEER_BASELINE_USES_MEDIAN_OF_PLATFORM_METRICS',
    'LISTING_EXPOSURE_ASSOCIATION_NOT_CAUSATION',
    'CROSS_LISTED_ITEM_COHORTS_OVERLAP',
    'EXIT_CHANNEL_NOT_ATTRIBUTABLE_TO_LISTING_PLATFORM',
    'CATEGORY_AND_VALUE_BAND_MIX_NOT_CONTROLLED',
    'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
    'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
  ];
  if (winner.candidate.channel_listing_to_exit_coverage_percent === null || winner.candidate.channel_listing_to_exit_coverage_percent < 100) {
    limitations.push('CHANNEL_LISTING_TO_EXIT_COVERAGE_INCOMPLETE');
  }

  const finding: ListingPlatformFinding = {
    finding_code: FINDING_CODE,
    family: 'listing_platform_performance',
    direction: 'strength',
    status: 'selected',
    headline: `${winner.candidate.listing_channel_name} is a strong, balanced listing platform`,
    summary: buildSummary(winner),
    segment: buildSegment(winner.candidate),
    metrics: buildMetrics(winner.candidate),
    baseline: winner.baseline,
    triggered_rules: [...winner.improvementTriggers, 'NO_MATERIAL_WEAKNESS'],
    confidence: winner.candidate.confidence as ConfidenceTier,
    limitations,
    evidence_refs: ['target_user_listing_channel_evidence.performance_by_listing_channel'],
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
