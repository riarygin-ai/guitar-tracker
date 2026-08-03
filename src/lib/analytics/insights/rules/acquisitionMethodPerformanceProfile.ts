// Insights Engine v1.2 — Findings Selector rule: ACQUISITION_METHOD_
// PERFORMANCE_PROFILE. Pure functions only — no I/O, no Supabase client.
// Compares Purchase-acquired and Trade-acquired items like-for-like BY EXIT
// METHOD (Purchase -> Sale vs. Trade -> Sale; Purchase -> Trade vs.
// Trade -> Trade) and classifies the result as a tradeoff or a broad
// advantage — never a blanket "X is better" claim. See classifyProfile
// below for the exact deterministic rules.
//
// Evidence shape consumed (Analytics v2.10, unchanged, see
// supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql,
// CTE m2t_method_rows):
//   target_user_acquisition_evidence.acquisition_to_exit_analysis.
//     method_paths[] — one row per (acquisition_method, exit_method) pair,
//     already restricted to realized items with a positive acquisition
//     value AND a positive exit value (m2t_eligible), pooled across every
//     Purpose (Business, Hybrid, Personal — m2t_eligible descends from
//     target_items -> all_items -> analytics_item_lifecycle_v2's full
//     population, no purpose_name filter). acquisition_method is exactly
//     one of 'purchase' | 'trade' | 'unknown'; exit_method (aliased from
//     exit_type) is exactly one of 'sale' | 'trade'. Deliberately NOT the
//     _by_purpose sibling array.
//
// Medians are never combined across exit methods here — each comparison
// uses only its own two rows' own medians; nothing is averaged or
// re-aggregated into a synthetic "overall" median.

import type {
  AcquisitionMethodCandidateEvaluation,
  AcquisitionMethodExitMetrics,
  AcquisitionMethodPerformanceProfileFinding,
  AcquisitionMethodProfileCode,
  ConfidenceTier,
  ExitMethodComparison,
  MethodAdvantage,
  NoFindingResult,
} from '../types';
import {
  PROFIT_ABS_THRESHOLD_CAD,
  PROFIT_PCT_THRESHOLD,
  ROI_IMPROVEMENT_PP,
  DOM_ABS_DAYS,
  DOM_IMPROVEMENT_PCT_THRESHOLD,
  CONFIDENCE_RANK,
  toRecord,
  toNumber,
  toNonNegativeInt,
  toConfidenceTier,
} from '../comparisonHelpers';

export const FINDING_CODE = 'ACQUISITION_METHOD_PERFORMANCE_PROFILE';

const MIN_ITEM_COUNT = 5;
const MIN_DOM_SAMPLE_SIZE = 5;
const MIN_ELIGIBLE_EXIT_METHOD_COMPARISONS = 2;
// This rule has no separate ROI-difference threshold of its own — it
// reuses ROI_IMPROVEMENT_PP (5 percentage points) as a flat, direction-
// agnostic "materially different" bar, per the task's own thresholds.
const ROI_MATERIAL_DIFFERENCE_PP = ROI_IMPROVEMENT_PP;

interface MethodExitRow {
  acquisition_method: string;
  exit_method: string;
  item_count: number;
  median_net_profit: number | null;
  median_roi: number | null;
  median_days_on_market: number | null;
  dom_sample_size: number;
  confidence: ConfidenceTier | null;
}

/**
 * Reads method_paths only — never shared/pooled evidence, never the
 * _by_purpose sibling, never item-level rows. Never throws — malformed or
 * missing evidence simply yields no rows.
 */
export function extractAcquisitionMethodExitRows(targetUserAcquisitionEvidence: unknown): MethodExitRow[] {
  const evidence = toRecord(targetUserAcquisitionEvidence);
  const exitAnalysisSection = toRecord(evidence?.acquisition_to_exit_analysis);

  const rows = Array.isArray(exitAnalysisSection?.method_paths)
    ? (exitAnalysisSection!.method_paths as unknown[])
    : [];

  const result: MethodExitRow[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;

    const acquisitionMethod = typeof r.acquisition_method === 'string' ? r.acquisition_method : null;
    const exitMethod = typeof r.exit_method === 'string' ? r.exit_method : null;
    if (acquisitionMethod === null || exitMethod === null) continue;

    result.push({
      acquisition_method: acquisitionMethod,
      exit_method: exitMethod,
      item_count: toNonNegativeInt(r.sample_size),
      median_net_profit: toNumber(r.median_net_profit),
      median_roi: toNumber(r.median_roi),
      median_days_on_market: toNumber(r.median_days_on_market),
      dom_sample_size: toNonNegativeInt(r.dom_sample_size),
      confidence: toConfidenceTier(r.confidence),
    });
  }

  return result;
}

// ── Row-level eligibility ─────────────────────────────────────────────────
// Ineligible rows are insufficient evidence, not weak performance.

function evaluateRowEligibility(row: MethodExitRow): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (row.acquisition_method !== 'purchase' && row.acquisition_method !== 'trade') {
    reasons.push('ACQUISITION_METHOD_NOT_PURCHASE_OR_TRADE');
  }
  if (row.exit_method !== 'sale' && row.exit_method !== 'trade') {
    reasons.push('EXIT_METHOD_NOT_SALE_OR_TRADE');
  }
  if (row.item_count < MIN_ITEM_COUNT) reasons.push('ITEM_COUNT_BELOW_MINIMUM');
  if (row.dom_sample_size < MIN_DOM_SAMPLE_SIZE) reasons.push('DOM_SAMPLE_SIZE_BELOW_MINIMUM');
  if (row.median_net_profit === null) reasons.push('MEDIAN_NET_PROFIT_MISSING');
  if (row.median_roi === null) reasons.push('MEDIAN_ROI_MISSING');
  if (row.median_days_on_market === null) reasons.push('MEDIAN_DOM_MISSING');
  if (row.confidence === null) reasons.push('CONFIDENCE_UNAVAILABLE');
  else if (row.confidence === 'insufficient') reasons.push('CONFIDENCE_INSUFFICIENT');

  return { eligible: reasons.length === 0, reasons };
}

// ── Material difference (symmetric — there is no "baseline" side here,
// just two peer methods being compared like-for-like) ───────────────────
// Reuses the shared abs/percent threshold CONSTANTS from
// comparisonHelpers.ts (profit >= $150 or 15%, DOM >= 7 days or 20%, ROI
// >= 5pp flat) but not its baseline-vs-candidate trigger functions, which
// assume an asymmetric "candidate vs. typical" shape that doesn't apply to
// a symmetric peer-vs-peer comparison. The percent leg is evaluated
// against whichever side has the smaller magnitude, so a real difference
// is never masked by pairing it with a large, unrelated denominator.

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isMaterialAbsOrPercentDifference(a: number, b: number, absThreshold: number, pctThreshold: number): boolean {
  const diff = Math.abs(a - b);
  const relativeThreshold = Math.min(Math.abs(a), Math.abs(b)) * pctThreshold;
  return diff >= absThreshold || diff >= relativeThreshold;
}

/** a = purchase value, b = trade value. Higher wins. */
function higherValueWins(a: number, b: number, materiallyDifferent: boolean): MethodAdvantage {
  if (!materiallyDifferent) return 'Neutral';
  return a > b ? 'Purchase' : 'Trade';
}

/** a = purchase value, b = trade value. Lower wins (DOM: faster is better). */
function lowerValueWins(a: number, b: number, materiallyDifferent: boolean): MethodAdvantage {
  if (!materiallyDifferent) return 'Neutral';
  return a < b ? 'Purchase' : 'Trade';
}

function toMetricsBlock(row: MethodExitRow): AcquisitionMethodExitMetrics {
  return {
    item_count: row.item_count,
    median_net_profit: row.median_net_profit,
    median_roi: row.median_roi,
    median_days_on_market: row.median_days_on_market,
    dom_sample_size: row.dom_sample_size,
    confidence: row.confidence as ConfidenceTier,
  };
}

function buildComparison(exitMethod: 'sale' | 'trade', purchaseRow: MethodExitRow, tradeRow: MethodExitRow): ExitMethodComparison {
  // Eligibility already guarantees these are non-null on both rows.
  const purchaseProfit = purchaseRow.median_net_profit as number;
  const tradeProfit = tradeRow.median_net_profit as number;
  const purchaseRoi = purchaseRow.median_roi as number;
  const tradeRoi = tradeRow.median_roi as number;
  const purchaseDom = purchaseRow.median_days_on_market as number;
  const tradeDom = tradeRow.median_days_on_market as number;

  const profitMaterial = isMaterialAbsOrPercentDifference(purchaseProfit, tradeProfit, PROFIT_ABS_THRESHOLD_CAD, PROFIT_PCT_THRESHOLD);
  const roiMaterial = Math.abs(purchaseRoi - tradeRoi) >= ROI_MATERIAL_DIFFERENCE_PP;
  const domMaterial = isMaterialAbsOrPercentDifference(purchaseDom, tradeDom, DOM_ABS_DAYS, DOM_IMPROVEMENT_PCT_THRESHOLD);

  const profitAdvantage = higherValueWins(purchaseProfit, tradeProfit, profitMaterial);
  const roiAdvantage = higherValueWins(purchaseRoi, tradeRoi, roiMaterial);
  const domAdvantage = lowerValueWins(purchaseDom, tradeDom, domMaterial);

  const triggeredRules: string[] = [];
  if (profitAdvantage !== 'Neutral') triggeredRules.push(profitAdvantage === 'Purchase' ? 'PROFIT_FAVORS_PURCHASE' : 'PROFIT_FAVORS_TRADE');
  if (roiAdvantage !== 'Neutral') triggeredRules.push(roiAdvantage === 'Purchase' ? 'ROI_FAVORS_PURCHASE' : 'ROI_FAVORS_TRADE');
  if (domAdvantage !== 'Neutral') triggeredRules.push(domAdvantage === 'Purchase' ? 'DOM_FAVORS_PURCHASE' : 'DOM_FAVORS_TRADE');
  if (triggeredRules.length === 0) triggeredRules.push('NO_MATERIAL_DIFFERENCE_FOR_THIS_EXIT_METHOD');

  return {
    exit_method: exitMethod,
    purchase: toMetricsBlock(purchaseRow),
    trade: toMetricsBlock(tradeRow),
    deltas: {
      median_net_profit: round2(purchaseProfit - tradeProfit),
      median_roi: round2(purchaseRoi - tradeRoi),
      median_days_on_market: round2(purchaseDom - tradeDom),
    },
    profit_advantage: profitAdvantage,
    roi_advantage: roiAdvantage,
    dom_advantage: domAdvantage,
    triggered_rules: triggeredRules,
  };
}

// ── Profile classification ────────────────────────────────────────────────
// Deterministic — no weighted score. Evaluated in this fixed order because
// the economics/speed and broad-advantage patterns are mutually exclusive
// by construction (economics/speed requires the OTHER method to win DOM in
// BOTH comparisons, which broad-advantage explicitly forbids), so order
// only controls which label is reported, not whether one applies.

function countWins(comparisons: ExitMethodComparison[], method: 'Purchase' | 'Trade'): number {
  let count = 0;
  for (const c of comparisons) {
    if (c.profit_advantage === method) count++;
    if (c.roi_advantage === method) count++;
    if (c.dom_advantage === method) count++;
  }
  return count;
}

function classifyProfile(comparisons: ExitMethodComparison[]): AcquisitionMethodProfileCode | 'NO_MATERIAL_DIFFERENCE' {
  const purchaseEconEverywhere = comparisons.every((c) => c.profit_advantage === 'Purchase' || c.roi_advantage === 'Purchase');
  const noTradeEconAnywhere = comparisons.every((c) => c.profit_advantage !== 'Trade' && c.roi_advantage !== 'Trade');
  const tradeDomEverywhere = comparisons.every((c) => c.dom_advantage === 'Trade');
  if (purchaseEconEverywhere && noTradeEconAnywhere && tradeDomEverywhere) return 'PURCHASE_ECONOMICS_TRADE_SPEED';

  const tradeEconEverywhere = comparisons.every((c) => c.profit_advantage === 'Trade' || c.roi_advantage === 'Trade');
  const noPurchaseEconAnywhere = comparisons.every((c) => c.profit_advantage !== 'Purchase' && c.roi_advantage !== 'Purchase');
  const purchaseDomEverywhere = comparisons.every((c) => c.dom_advantage === 'Purchase');
  if (tradeEconEverywhere && noPurchaseEconAnywhere && purchaseDomEverywhere) return 'TRADE_ECONOMICS_PURCHASE_SPEED';

  const purchaseWins = countWins(comparisons, 'Purchase');
  const tradeWins = countWins(comparisons, 'Trade');

  if (purchaseWins >= 2 && tradeWins === 0) return 'PURCHASE_BROAD_ADVANTAGE';
  if (tradeWins >= 2 && purchaseWins === 0) return 'TRADE_BROAD_ADVANTAGE';
  if (purchaseWins === 0 && tradeWins === 0) return 'NO_MATERIAL_DIFFERENCE';
  return 'MIXED_BY_EXIT_METHOD';
}

function buildHeadline(profile: AcquisitionMethodProfileCode): string {
  switch (profile) {
    case 'PURCHASE_ECONOMICS_TRADE_SPEED':
      return 'Purchase acquisitions show stronger realized economics; Trade acquisitions exit faster';
    case 'TRADE_ECONOMICS_PURCHASE_SPEED':
      return 'Trade acquisitions show stronger realized economics; Purchase acquisitions exit faster';
    case 'PURCHASE_BROAD_ADVANTAGE':
      return 'Purchase acquisitions show a broad performance advantage over Trade';
    case 'TRADE_BROAD_ADVANTAGE':
      return 'Trade acquisitions show a broad performance advantage over Purchase';
    case 'MIXED_BY_EXIT_METHOD':
      return 'Purchase vs. Trade performance is mixed and depends on exit method';
  }
}

function buildSummary(profile: AcquisitionMethodProfileCode, comparisons: ExitMethodComparison[]): string {
  const parts: string[] = [];

  for (const c of comparisons) {
    const exitLabel = c.exit_method === 'sale' ? 'Sale' : 'Trade';
    parts.push(
      `For ${exitLabel} exits, Purchase-acquired items had median net profit CAD $${c.purchase.median_net_profit}, ` +
        `ROI ${c.purchase.median_roi}%, and ${c.purchase.median_days_on_market} median days on market (n=${c.purchase.item_count}), ` +
        `versus Trade-acquired items at CAD $${c.trade.median_net_profit}, ${c.trade.median_roi}% ROI, and ` +
        `${c.trade.median_days_on_market} median days on market (n=${c.trade.item_count}).`,
    );
  }

  switch (profile) {
    case 'PURCHASE_ECONOMICS_TRADE_SPEED':
      parts.push(
        'Purchase acquisitions produced materially stronger realized profit and/or ROI across both comparable exit ' +
          'methods, while Trade acquisitions returned to an exit materially faster in both. This is a tradeoff ' +
          'between economics and speed, not a recommendation to stop trading.',
      );
      break;
    case 'TRADE_ECONOMICS_PURCHASE_SPEED':
      parts.push(
        'Trade acquisitions produced materially stronger realized profit and/or ROI across both comparable exit ' +
          'methods, while Purchase acquisitions returned to an exit materially faster in both. This is a tradeoff ' +
          'between economics and speed, not a recommendation to stop purchasing.',
      );
      break;
    case 'PURCHASE_BROAD_ADVANTAGE':
      parts.push(
        'Purchase acquisitions show a material advantage on at least two metrics across these comparisons, with no ' +
          'material advantage for Trade anywhere in this evidence.',
      );
      break;
    case 'TRADE_BROAD_ADVANTAGE':
      parts.push(
        'Trade acquisitions show a material advantage on at least two metrics across these comparisons, with no ' +
          'material advantage for Purchase anywhere in this evidence.',
      );
      break;
    case 'MIXED_BY_EXIT_METHOD':
      parts.push(
        'Material differences exist, but which method has the advantage changes depending on exit method — this ' +
          'evidence does not support a single directional conclusion.',
      );
      break;
  }

  return parts.join(' ');
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface AcquisitionMethodPerformanceProfileEvaluation {
  result: AcquisitionMethodPerformanceProfileFinding | NoFindingResult;
  candidateEvaluations: AcquisitionMethodCandidateEvaluation[];
}

export function evaluateAcquisitionMethodPerformanceProfile(
  targetUserAcquisitionEvidence: unknown,
): AcquisitionMethodPerformanceProfileEvaluation {
  const rows = extractAcquisitionMethodExitRows(targetUserAcquisitionEvidence);

  if (rows.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidateEvaluations: AcquisitionMethodCandidateEvaluation[] = [];
  const eligibleByKey = new Map<string, MethodExitRow>();

  for (const row of rows) {
    const { eligible, reasons } = evaluateRowEligibility(row);
    candidateEvaluations.push({
      finding_code: FINDING_CODE,
      acquisition_method: row.acquisition_method,
      exit_method: row.exit_method,
      eligible,
      eligibility_failure_reasons: reasons,
      item_count: row.item_count,
      median_net_profit: row.median_net_profit,
      median_roi: row.median_roi,
      median_days_on_market: row.median_days_on_market,
      dom_sample_size: row.dom_sample_size,
      confidence: row.confidence,
    });
    if (eligible) eligibleByKey.set(`${row.acquisition_method}:${row.exit_method}`, row);
  }

  // Like-for-like only: Purchase -> Sale paired with Trade -> Sale;
  // Purchase -> Trade paired with Trade -> Trade. Never cross-paired.
  const comparisons: ExitMethodComparison[] = [];
  const rowsUsed: MethodExitRow[] = [];
  for (const exitMethod of ['sale', 'trade'] as const) {
    const purchaseRow = eligibleByKey.get(`purchase:${exitMethod}`);
    const tradeRow = eligibleByKey.get(`trade:${exitMethod}`);
    if (purchaseRow && tradeRow) {
      comparisons.push(buildComparison(exitMethod, purchaseRow, tradeRow));
      rowsUsed.push(purchaseRow, tradeRow);
    }
  }

  if (comparisons.length < MIN_ELIGIBLE_EXIT_METHOD_COMPARISONS) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['INSUFFICIENT_COMPARABLE_EXIT_METHODS'] },
      candidateEvaluations,
    };
  }

  const profile = classifyProfile(comparisons);

  if (profile === 'NO_MATERIAL_DIFFERENCE') {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['NO_MATERIAL_DIFFERENCE'] },
      candidateEvaluations,
    };
  }

  // Confidence is capped at the weakest evidence row actually used — never
  // higher than the lowest confidence among the rows behind this finding.
  const confidence = rowsUsed.reduce<ConfidenceTier>((min, r) => {
    const rowConfidence = r.confidence as ConfidenceTier; // eligibility guarantees non-null
    return CONFIDENCE_RANK[rowConfidence] < CONFIDENCE_RANK[min] ? rowConfidence : min;
  }, rowsUsed[0].confidence as ConfidenceTier);

  const direction: 'strength' | 'tradeoff' =
    profile === 'PURCHASE_BROAD_ADVANTAGE' || profile === 'TRADE_BROAD_ADVANTAGE' ? 'strength' : 'tradeoff';

  const finding: AcquisitionMethodPerformanceProfileFinding = {
    finding_code: FINDING_CODE,
    family: 'acquisition_method_performance',
    direction,
    status: 'selected',
    headline: buildHeadline(profile),
    summary: buildSummary(profile, comparisons),
    profile_code: profile,
    eligible_exit_method_comparison_count: comparisons.length,
    comparisons,
    confidence,
    limitations: [
      'REALIZED_ITEMS_ONLY',
      'CATEGORY_AND_VALUE_BAND_MIX_NOT_CONTROLLED',
      'ACQUISITION_METHOD_ASSOCIATION_NOT_CAUSATION',
      'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
      'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
    ],
    evidence_refs: ['target_user_acquisition_evidence.acquisition_to_exit_analysis.method_paths'],
  };

  return { result: finding, candidateEvaluations };
}
