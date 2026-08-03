/**
 * test-insights-engine.ts
 *
 * Focused, framework-free tests for Insights Engine's Findings Selector
 * rules — STRONG_BALANCED_ACQUISITION_BAND (v1.0), STRONG_CATEGORY_
 * ACQUISITION_BAND (v1.1), ACQUISITION_METHOD_PERFORMANCE_PROFILE (v1.2),
 * and STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY (new in v1.3) — same "tsx script,
 * no jest/vitest" convention as scripts/test-analytics-runner.ts, but this
 * one needs no Supabase instance at all: every rule under test is a pure
 * function of hand-built evidence fixtures shaped exactly like Analytics
 * v2.10's target_user_acquisition_evidence (see
 * supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql,
 * CTEs m1t_band_rows / m2t_band_rows / m2t_method_rows), target_user_
 * inventory_segmentation_evidence (see
 * supabase/migrations/20260815000000_build_analytics_snapshot_v2_4.sql,
 * CTE cx_catband_rows), and target_user_deal_channel_evidence (see
 * supabase/migrations/20260816000000_build_analytics_snapshot_v2_5.sql,
 * CTE cjt_matrix_rows). No production data, no database connection,
 * nothing destructive.
 *
 * Usage:
 *   npx tsx scripts/test-insights-engine.ts
 */

import fs from 'fs';
import path from 'path';
import {
  evaluateStrongBalancedAcquisitionBand,
  FINDING_CODE as BROAD_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongBalancedAcquisitionBand';
import {
  evaluateStrongCategoryAcquisitionBand,
  FINDING_CODE as CATEGORY_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongCategoryAcquisitionBand';
import {
  evaluateAcquisitionMethodPerformanceProfile,
  FINDING_CODE as METHOD_PROFILE_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/acquisitionMethodPerformanceProfile';
import {
  evaluateStrongDealInToDealOutJourney,
  FINDING_CODE as JOURNEY_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongDealInToDealOutJourney';
import { selectFindings } from '../src/lib/analytics/insights/selectFindings';
import { isValidAnalyticsSnapshot } from '../src/lib/analytics/runAnalytics';
import type {
  AcquisitionMethodPerformanceProfileFinding,
  ConfidenceTier,
  SelectedFinding as SelectedFindingForTest,
} from '../src/lib/analytics/insights/types';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

// ── Fixture builder ──────────────────────────────────────────────────────
// Mirrors the exact join Insights Engine v1.0 performs: module 1's
// band_performance (primary metrics) + module 2's performance_by_band
// (confidence, historical/app-tracked counts), matched by band order.

interface BandFixture {
  order: number;
  label: string;
  total: number;
  realized: number;
  domSample: number;
  realizationRate: number | null;
  profit: number | null;
  roi: number | null;
  dom: number | null;
  confidence: ConfidenceTier | null;
  historical?: number;
  appTracked?: number;
  omitFromExitAnalysis?: boolean;
}

function makeEvidence(bands: BandFixture[]): unknown {
  return {
    acquisition_value_band_performance: {
      band_performance: bands.map((b) => ({
        acquisition_value_band_order: b.order,
        acquisition_value_band_label: b.label,
        sample_size: b.total,
        realized_items: b.realized,
        realization_rate_percent: b.realizationRate,
        sale_count: b.realized,
        trade_count: 0,
        median_net_profit: b.profit,
        median_roi: b.roi,
        dom_sample_size: b.domSample,
        median_days_on_market: b.dom,
        holding_sample_size: b.realized,
        median_holding_days: b.dom,
      })),
    },
    acquisition_to_exit_analysis: {
      performance_by_band: bands
        .filter((b) => !b.omitFromExitAnalysis)
        .map((b) => ({
          m2_acq_band_order: b.order,
          m2_acq_band_label: b.label,
          sample_size: b.realized,
          sale_exit_count: b.realized,
          trade_exit_count: 0,
          historical_item_count: b.historical ?? 0,
          app_tracked_item_count: b.appTracked ?? b.realized,
          median_acquisition_value: null,
          median_exit_value: null,
          median_value_increase: null,
          median_net_profit: b.profit,
          median_roi: b.roi,
          dom_sample_size: b.domSample,
          median_days_on_market: b.dom,
          confidence: b.confidence,
        })),
    },
  };
}

function evalFor(order: number, evaluations: ReturnType<typeof evaluateStrongBalancedAcquisitionBand>['candidateEvaluations']) {
  return evaluations.find((e) => e.acquisition_value_band_order === order);
}

// ── Category fixture builder ─────────────────────────────────────────────
// Mirrors target_user_inventory_segmentation_evidence.category_type_
// performance.performance_by_category_and_acquisition_band (cx_catband_rows)
// — one row per (category_id, category_name, acquisition_value_band_order),
// pooled across every Purpose.

interface CategoryBandFixture {
  categoryId: number | null;
  categoryName: string | null;
  order: number;
  label: string;
  total: number;
  realized: number;
  domSample: number;
  realizationRate: number | null;
  profit: number | null;
  roi: number | null;
  dom: number | null;
  confidence: ConfidenceTier | null;
}

function makeCategoryEvidence(bands: CategoryBandFixture[], options?: { includeByPurposeDecoy?: boolean }): unknown {
  const pooledRows = bands.map((b) => ({
    category_id: b.categoryId,
    category_name: b.categoryName,
    acquisition_value_band_order: b.order,
    acquisition_value_band_label: b.label,
    item_count: b.total,
    realized_item_count: b.realized,
    open_item_count: Math.max(0, b.total - b.realized),
    realization_rate_percent: b.realizationRate,
    median_net_profit: b.profit,
    median_roi: b.roi,
    dom_sample_size: b.domSample,
    median_days_on_market: b.dom,
    confidence: b.confidence,
  }));

  const categoryTypePerformance: Record<string, unknown> = {
    performance_by_category_and_acquisition_band: pooledRows,
  };

  if (options?.includeByPurposeDecoy) {
    // Deliberately worse, Business-only-shaped numbers under a DIFFERENT
    // key (performance_by_category_and_acquisition_band_by_purpose) — the
    // rule must never read this key. If it did, these numbers (and this
    // key's tiny item counts) would leak into the result instead of the
    // pooled numbers above.
    categoryTypePerformance.performance_by_category_and_acquisition_band_by_purpose = bands.map((b) => ({
      current_purpose_id: 1,
      current_purpose_name: 'Business',
      purpose_policy_status: 'mapped',
      category_id: b.categoryId,
      category_name: b.categoryName,
      acquisition_value_band_order: b.order,
      acquisition_value_band_label: b.label,
      item_count: 1,
      realized_item_count: 0,
      realization_rate_percent: 0,
      median_net_profit: -99999,
      median_roi: -99999,
      dom_sample_size: 0,
      median_days_on_market: 9999,
      confidence: 'insufficient',
    }));
  }

  return { category_type_performance: categoryTypePerformance };
}

function categoryEvalFor(
  categoryId: number | null,
  order: number,
  evaluations: ReturnType<typeof evaluateStrongCategoryAcquisitionBand>['candidateEvaluations'],
) {
  return evaluations.find((e) => e.category_id === (categoryId ?? undefined) && e.acquisition_value_band_order === order);
}

// ── Acquisition-method fixture builder ───────────────────────────────────
// Mirrors target_user_acquisition_evidence.acquisition_to_exit_analysis.
// method_paths (m2t_method_rows) — one row per (acquisition_method,
// exit_method) pair, pooled across every Purpose.

interface MethodRowFixture {
  acquisitionMethod: string;
  exitMethod: string;
  itemCount: number;
  domSample: number;
  profit: number | null;
  roi: number | null;
  dom: number | null;
  confidence: ConfidenceTier | null;
}

function makeMethodExitEvidence(rows: MethodRowFixture[], options?: { includeByPurposeDecoy?: boolean }): unknown {
  const acquisitionToExitAnalysis: Record<string, unknown> = {
    method_paths: rows.map((r) => ({
      acquisition_method: r.acquisitionMethod,
      exit_method: r.exitMethod,
      sample_size: r.itemCount,
      median_acquisition_value: null,
      median_exit_value: null,
      median_value_increase: null,
      median_net_profit: r.profit,
      median_roi: r.roi,
      dom_sample_size: r.domSample,
      median_days_on_market: r.dom,
      historical_item_count: 0,
      app_tracked_item_count: r.itemCount,
      confidence: r.confidence,
    })),
  };

  if (options?.includeByPurposeDecoy) {
    // Deliberately worse, tiny-sample decoy under a DIFFERENT key
    // (method_paths_by_purpose) — the rule must never read this key.
    acquisitionToExitAnalysis.method_paths_by_purpose = rows.map((r) => ({
      current_purpose_id: 1,
      current_purpose_name: 'Business',
      acquisition_method: r.acquisitionMethod,
      exit_method: r.exitMethod,
      sample_size: 1,
      median_net_profit: -99999,
      median_roi: -99999,
      dom_sample_size: 0,
      median_days_on_market: 9999,
      confidence: 'insufficient',
    }));
  }

  return { acquisition_to_exit_analysis: acquisitionToExitAnalysis };
}

function methodEvalFor(
  acquisitionMethod: string,
  exitMethod: string,
  evaluations: ReturnType<typeof evaluateAcquisitionMethodPerformanceProfile>['candidateEvaluations'],
) {
  return evaluations.find((e) => e.acquisition_method === acquisitionMethod && e.exit_method === exitMethod);
}

function comparisonFor(
  exitMethod: 'sale' | 'trade',
  finding: AcquisitionMethodPerformanceProfileFinding,
) {
  return finding.comparisons.find((c) => c.exit_method === exitMethod);
}

// ── Channel-journey fixture builder ──────────────────────────────────────
// Mirrors target_user_deal_channel_evidence.channel_journey.deal_in_to_
// deal_out_matrix (cjt_matrix_rows) — one row per (deal_in_channel_id,
// deal_in_channel_name, deal_out_channel_id, deal_out_channel_name) pair,
// pooled across every Purpose.

interface JourneyFixture {
  dealInChannelId: number | null;
  dealInChannelName: string | null;
  dealOutChannelId: number | null;
  dealOutChannelName: string | null;
  itemCount: number;
  distinctAcquisitionDealCount: number;
  distinctExitDealCount: number;
  domSample: number;
  profit: number | null;
  roi: number | null;
  dom: number | null;
  confidence: ConfidenceTier | null;
}

function makeJourneyEvidence(journeys: JourneyFixture[], options?: { includeByPurposeDecoy?: boolean }): unknown {
  const channelJourney: Record<string, unknown> = {
    deal_in_to_deal_out_matrix: journeys.map((j) => ({
      deal_in_channel_id: j.dealInChannelId,
      deal_in_channel_name: j.dealInChannelName,
      deal_out_channel_id: j.dealOutChannelId,
      deal_out_channel_name: j.dealOutChannelName,
      journey_item_count: j.itemCount,
      distinct_acquisition_deal_count: j.distinctAcquisitionDealCount,
      distinct_exit_deal_count: j.distinctExitDealCount,
      sale_exit_item_count: j.itemCount,
      trade_exit_item_count: 0,
      historical_item_count: 0,
      app_tracked_item_count: j.itemCount,
      total_acquisition_capital: null,
      total_exit_value: null,
      total_realized_net_profit: null,
      median_net_profit: j.profit,
      median_roi: j.roi,
      dom_sample_size: j.domSample,
      median_days_on_market: j.dom,
      holding_sample_size: j.itemCount,
      median_holding_days: j.dom,
      confidence: j.confidence,
    })),
  };

  if (options?.includeByPurposeDecoy) {
    // Deliberately worse, tiny-sample decoy under a DIFFERENT key
    // (deal_in_to_deal_out_matrix_by_purpose) — the rule must never read
    // this key.
    channelJourney.deal_in_to_deal_out_matrix_by_purpose = journeys.map((j) => ({
      current_purpose_id: 1,
      current_purpose_name: 'Business',
      deal_in_channel_id: j.dealInChannelId,
      deal_in_channel_name: j.dealInChannelName,
      deal_out_channel_id: j.dealOutChannelId,
      deal_out_channel_name: j.dealOutChannelName,
      journey_item_count: 1,
      distinct_acquisition_deal_count: 1,
      distinct_exit_deal_count: 1,
      median_net_profit: -99999,
      median_roi: -99999,
      dom_sample_size: 0,
      median_days_on_market: 9999,
      confidence: 'insufficient',
    }));
  }

  return { channel_journey: channelJourney };
}

function journeyEvalFor(
  dealInChannelId: number | null,
  dealOutChannelId: number | null,
  evaluations: ReturnType<typeof evaluateStrongDealInToDealOutJourney>['candidateEvaluations'],
) {
  return evaluations.find((e) => e.deal_in_channel_id === dealInChannelId && e.deal_out_channel_id === dealOutChannelId);
}

function main() {
  // ── Test 1: acceptance check against current representative metrics ────
  // Mirrors current production target-user evidence: $2,000-2,999 with 28
  // total items, 19 realized, median net profit ~$750, median ROI ~33.33%,
  // median DOM ~10.5 days, realization rate ~67.86%. This is an acceptance
  // check against representative evidence shape, not fixture-independent
  // business logic — the thresholds under test live entirely in
  // strongBalancedAcquisitionBand.ts.
  console.log('\n[Test 1 — acceptance check: representative metrics select $2,000-2,999]');
  {
    const evidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
      { order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
      { order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
    ]);

    const { result } = evaluateStrongBalancedAcquisitionBand(evidence);
    check('result status is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('winner is $2,000-2,999', result.segment.acquisition_value_band_label === '$2,000-2,999', result.segment);
      check('metrics.total_item_count is 28', result.metrics.total_item_count === 28, result.metrics);
      check('metrics.realized_item_count is 19', result.metrics.realized_item_count === 19, result.metrics);
      check('metrics.median_net_profit is 750', result.metrics.median_net_profit === 750, result.metrics);
      check('metrics.median_roi is 33.33', result.metrics.median_roi === 33.33, result.metrics);
      check('metrics.median_days_on_market is 10.5', result.metrics.median_days_on_market === 10.5, result.metrics);
      check('metrics.realization_rate_percent is 67.86', result.metrics.realization_rate_percent === 67.86, result.metrics);
      check('runner-up is $1,000-1,999 (higher ROI, weaker balance)', result.runner_up?.segment.acquisition_value_band_label === '$1,000-1,999', result.runner_up);
      check('baseline is named peer_band_median_baseline', result.baseline.type === 'peer_band_median_baseline', result.baseline);
    }
  }

  // ── Test 2: winner is not hardcoded — a different dataset picks a
  // different band ─────────────────────────────────────────────────────
  console.log('\n[Test 2 — winner is not hardcoded]');
  {
    const evidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 10, realized: 5, domSample: 5, realizationRate: 40, profit: 300, roi: 15, dom: 30, confidence: 'low' },
      { order: 3, label: '$2,000-2,999', total: 10, realized: 5, domSample: 5, realizationRate: 42, profit: 320, roi: 18, dom: 28, confidence: 'low' },
      { order: 4, label: '$3,000-3,999', total: 10, realized: 6, domSample: 6, realizationRate: 70, profit: 900, roi: 50, dom: 8, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 41, profit: 310, roi: 16, dom: 29, confidence: 'low' },
    ]);
    const { result } = evaluateStrongBalancedAcquisitionBand(evidence);
    check(
      'a different fixture selects $3,000-3,999, not $2,000-2,999',
      result.status === 'selected' && result.segment.acquisition_value_band_label === '$3,000-3,999',
      result,
    );
  }

  // ── Test 3: highest ROI alone does not automatically win ────────────────
  console.log('\n[Test 3 — highest ROI alone does not win]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'W', total: 10, realized: 6, domSample: 6, realizationRate: 38, profit: 280, roi: 17, dom: 27, confidence: 'moderate' },
      { order: 3, label: 'X-high-roi', total: 10, realized: 6, domSample: 6, realizationRate: 35, profit: 200, roi: 80, dom: 40, confidence: 'moderate' },
      { order: 4, label: 'Y-balanced', total: 10, realized: 6, domSample: 6, realizationRate: 55, profit: 500, roi: 22, dom: 15, confidence: 'moderate' },
      { order: 5, label: 'Z', total: 10, realized: 6, domSample: 6, realizationRate: 40, profit: 300, roi: 18, dom: 25, confidence: 'moderate' },
    ]);
    const { result, candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(evidence);
    check('the highest-ROI band (X) does not qualify', evalFor(3, candidateEvaluations)?.qualifies === false, evalFor(3, candidateEvaluations));
    check('the balanced band (Y) is selected instead', result.status === 'selected' && result.segment.acquisition_value_band_label === 'Y-balanced', result);
  }

  // ── Test 4: highest profit alone does not automatically win ─────────────
  console.log('\n[Test 4 — highest profit alone does not win]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'W2', total: 10, realized: 6, domSample: 6, realizationRate: 38, profit: 280, roi: 17, dom: 27, confidence: 'moderate' },
      { order: 3, label: 'X2-high-profit', total: 10, realized: 6, domSample: 6, realizationRate: 30, profit: 2000, roi: 15, dom: 45, confidence: 'moderate' },
      { order: 4, label: 'Y2-balanced', total: 10, realized: 6, domSample: 6, realizationRate: 60, profit: 500, roi: 30, dom: 12, confidence: 'moderate' },
      { order: 5, label: 'Z2', total: 10, realized: 6, domSample: 6, realizationRate: 40, profit: 300, roi: 18, dom: 25, confidence: 'moderate' },
    ]);
    const { result, candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(evidence);
    check('the highest-profit band (X2) does not qualify', evalFor(3, candidateEvaluations)?.qualifies === false, evalFor(3, candidateEvaluations));
    check('the balanced band (Y2) is selected instead', result.status === 'selected' && result.segment.acquisition_value_band_label === 'Y2-balanced', result);
  }

  // ── Test 5: fewer than three eligible bands returns no finding ──────────
  console.log('\n[Test 5 — fewer than three eligible bands]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'Only A', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 3, label: 'Only B', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ]);
    const { result } = evaluateStrongBalancedAcquisitionBand(evidence);
    check(
      'result is no_eligible_finding with INSUFFICIENT_ELIGIBLE_BANDS',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_BANDS'),
      result,
    );
  }

  // ── Test 6: insufficient sample excluded, not labelled weak ─────────────
  console.log('\n[Test 6 — insufficient sample is excluded, not weak]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'Thin sample', total: 5, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 3, label: 'Eligible A', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 4, label: 'Eligible B', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 5, label: 'Eligible C', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ]);
    const { candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(evidence);
    const thin = evalFor(2, candidateEvaluations);
    check('thin-sample band is ineligible', thin?.eligible === false, thin);
    check('thin-sample band reason is TOTAL_ITEM_COUNT_BELOW_MINIMUM', !!thin?.eligibility_failure_reasons.includes('TOTAL_ITEM_COUNT_BELOW_MINIMUM'), thin);
    check('thin-sample band carries no weakness triggers (never evaluated)', thin?.material_weakness_triggers.length === 0, thin);
    check('thin-sample band carries no improvement triggers (never evaluated)', thin?.material_improvement_triggers.length === 0, thin);
  }

  // ── Test 7: a fast band with materially poor profit is not balanced ─────
  console.log('\n[Test 7 — fast but materially unprofitable band is not balanced]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'F1', total: 10, realized: 6, domSample: 6, realizationRate: 45, profit: 500, roi: 20, dom: 25, confidence: 'moderate' },
      { order: 3, label: 'F2-fast-poor-profit', total: 10, realized: 6, domSample: 6, realizationRate: 70, profit: 100, roi: 22, dom: 8, confidence: 'moderate' },
      { order: 4, label: 'F3', total: 10, realized: 6, domSample: 6, realizationRate: 42, profit: 520, roi: 19, dom: 27, confidence: 'moderate' },
    ]);
    const { candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(evidence);
    const f2 = evalFor(3, candidateEvaluations);
    check('the fast band has at least 2 improvement triggers', (f2?.material_improvement_triggers.length ?? 0) >= 2, f2);
    check('the fast band also carries a profit weakness trigger', !!f2?.material_weakness_triggers.includes('PROFIT_BELOW_PEER_BASELINE'), f2);
    check('the fast band does not qualify', f2?.qualifies === false, f2);
  }

  // ── Test 8: a profitable band with materially poor DOM is not balanced ──
  console.log('\n[Test 8 — profitable but materially slow band is not balanced]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'G1', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 3, label: 'G2-profitable-slow', total: 10, realized: 6, domSample: 6, realizationRate: 48, profit: 900, roi: 30, dom: 60, confidence: 'moderate' },
      { order: 4, label: 'G3', total: 10, realized: 6, domSample: 6, realizationRate: 52, profit: 480, roi: 18, dom: 18, confidence: 'moderate' },
    ]);
    const { candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(evidence);
    const g2 = evalFor(3, candidateEvaluations);
    check('the profitable band has at least 2 improvement triggers', (g2?.material_improvement_triggers.length ?? 0) >= 2, g2);
    check('the profitable band also carries a DOM weakness trigger', !!g2?.material_weakness_triggers.includes('DOM_WORSE_THAN_PEER_BASELINE'), g2);
    check('the profitable band does not qualify', g2?.qualifies === false, g2);
  }

  // ── Test 9: tie-breakers are deterministic ───────────────────────────────
  console.log('\n[Test 9 — deterministic tie-breakers]');
  {
    // 9a: identical metrics, differing confidence — higher confidence wins.
    const evidenceConfidence = makeEvidence([
      { order: 2, label: 'T1-stronger', total: 10, realized: 6, domSample: 6, realizationRate: 55, profit: 600, roi: 30, dom: 15, confidence: 'stronger' },
      { order: 4, label: 'T2-low', total: 10, realized: 6, domSample: 6, realizationRate: 55, profit: 600, roi: 30, dom: 15, confidence: 'low' },
      { order: 5, label: 'T3-filler', total: 10, realized: 6, domSample: 6, realizationRate: 35, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ]);
    const { result: confResult } = evaluateStrongBalancedAcquisitionBand(evidenceConfidence);
    check(
      'equal trigger counts break on confidence — T1 (stronger) beats T2 (low)',
      confResult.status === 'selected' && confResult.segment.acquisition_value_band_label === 'T1-stronger',
      confResult,
    );
    check(
      'the loser of the confidence tie-break appears as runner-up',
      confResult.status === 'selected' && confResult.runner_up?.segment.acquisition_value_band_label === 'T2-low',
      confResult,
    );

    // 9b: identical metrics AND confidence — falls through to band order.
    const evidenceOrder = makeEvidence([
      { order: 2, label: 'U1-lower-order', total: 10, realized: 6, domSample: 6, realizationRate: 55, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { order: 5, label: 'U2-higher-order', total: 10, realized: 6, domSample: 6, realizationRate: 55, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { order: 4, label: 'U3-filler', total: 10, realized: 6, domSample: 6, realizationRate: 35, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ]);
    const { result: orderResult } = evaluateStrongBalancedAcquisitionBand(evidenceOrder);
    check(
      'fully tied candidates break on ascending band order — U1 (order 2) beats U2 (order 5)',
      orderResult.status === 'selected' && orderResult.segment.acquisition_value_band_order === 2,
      orderResult,
    );
  }

  // ── Test 10: null metrics are handled safely ─────────────────────────────
  console.log('\n[Test 10 — null metrics handled safely, no throw]');
  {
    const evidence = makeEvidence([
      { order: 2, label: 'Null profit', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: null, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 3, label: 'Valid A', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 4, label: 'Valid B', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 5, label: 'Valid C', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ]);
    let threw = false;
    let candidateEvaluations: ReturnType<typeof evaluateStrongBalancedAcquisitionBand>['candidateEvaluations'] = [];
    try {
      candidateEvaluations = evaluateStrongBalancedAcquisitionBand(evidence).candidateEvaluations;
    } catch {
      threw = true;
    }
    check('evaluating a null-profit band does not throw', !threw);
    const nullBand = evalFor(2, candidateEvaluations);
    check('the null-profit band is ineligible with the correct reason', nullBand?.eligible === false && nullBand.eligibility_failure_reasons.includes('MEDIAN_NET_PROFIT_MISSING'), nullBand);
    check('exactly three other bands remain eligible', candidateEvaluations.filter((e) => e.eligible).length === 3, candidateEvaluations);
  }

  // ── Test 11: zero/unknown acquisition groups are excluded ───────────────
  console.log('\n[Test 11 — zero/unknown acquisition groups excluded]');
  {
    const evidence = makeEvidence([
      { order: 0, label: 'Zero assigned value', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 8, label: 'Unknown acquisition value', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 2, label: 'Valid A', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 3, label: 'Valid B', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { order: 4, label: 'Valid C', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ]);
    const { result, candidateEvaluations } = evaluateStrongBalancedAcquisitionBand(evidence);
    const zero = evalFor(0, candidateEvaluations);
    const unknown = evalFor(8, candidateEvaluations);
    check('zero-assigned band is ineligible as NOT_POSITIVE_ACQUISITION_BAND', zero?.eligible === false && !!zero.eligibility_failure_reasons.includes('NOT_POSITIVE_ACQUISITION_BAND'), zero);
    check('unknown-acquisition band is ineligible as NOT_POSITIVE_ACQUISITION_BAND', unknown?.eligible === false && !!unknown.eligibility_failure_reasons.includes('NOT_POSITIVE_ACQUISITION_BAND'), unknown);
    check(
      'neither the zero-assigned nor unknown band is ever selected',
      !(result.status === 'selected' && (result.segment.acquisition_value_band_order === 0 || result.segment.acquisition_value_band_order === 8)),
      result,
    );
  }

  // ── Test 12: old snapshots without insights still validate ──────────────
  console.log('\n[Test 12 — old snapshots without insights still validate; new optional section accepted]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.10',
      analytics_definition_version: '2.10',
      generated_at: new Date().toISOString(),
      evidence_scope: 'shared_inventory_population',
      purpose_semantics: 'v2',
      shared_purpose_evidence: {},
      target_user_purpose_evidence: {},
      target_user_open_inventory_evidence: {},
      shared_acquisition_evidence: {},
      target_user_acquisition_evidence: {},
      shared_inventory_segmentation_evidence: {},
      target_user_inventory_segmentation_evidence: {},
      shared_deal_channel_evidence: {},
      target_user_deal_channel_evidence: {},
      shared_listing_channel_evidence: {},
      target_user_listing_channel_evidence: {},
      shared_capital_liquidity_evidence: {},
      target_user_capital_liquidity_evidence: {},
      shared_calendar_seasonality_evidence: {},
      target_user_calendar_seasonality_evidence: {},
    };
    check('a v2.10 snapshot with no insights key still validates', isValidAnalyticsSnapshot(baseSnapshot));
    const withInsights = {
      ...baseSnapshot,
      insights: selectFindings({
        targetUserAcquisitionEvidence: baseSnapshot.target_user_acquisition_evidence,
        targetUserInventorySegmentationEvidence: baseSnapshot.target_user_inventory_segmentation_evidence,
        targetUserDealChannelEvidence: baseSnapshot.target_user_deal_channel_evidence,
      }),
    };
    check('the same snapshot plus the new optional insights section still validates', isValidAnalyticsSnapshot(withInsights));
  }

  // ── Test 13: target-user evidence is used, never shared evidence ────────
  console.log('\n[Test 13 — runner wires target-user evidence into the engine, not shared]');
  {
    const runnerSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/runAnalytics.ts'), 'utf8');
    check(
      'runAnalytics.ts wires target_user_acquisition_evidence into selectFindings',
      runnerSource.includes('targetUserAcquisitionEvidence: snapshot.target_user_acquisition_evidence'),
    );
    check(
      'runAnalytics.ts wires target_user_inventory_segmentation_evidence into selectFindings',
      runnerSource.includes('targetUserInventorySegmentationEvidence: snapshot.target_user_inventory_segmentation_evidence'),
    );
    check(
      'runAnalytics.ts does not feed shared_acquisition_evidence into selectFindings',
      !/targetUserAcquisitionEvidence:\s*snapshot\.shared_acquisition_evidence/.test(runnerSource),
    );
    check(
      'runAnalytics.ts does not feed shared_inventory_segmentation_evidence into selectFindings',
      !/targetUserInventorySegmentationEvidence:\s*snapshot\.shared_inventory_segmentation_evidence/.test(runnerSource),
    );
  }

  // ── Test 14: no user/item identity ever appears in a finding ────────────
  console.log('\n[Test 14 — findings carry no user IDs, item IDs, names, models, notes, or emails]');
  {
    const evidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
      { order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
      { order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
    ]);
    const { result } = evaluateStrongBalancedAcquisitionBand(evidence);

    const allowedKeysByPath: Record<string, string[]> = {
      root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'baseline', 'triggered_rules', 'confidence', 'limitations', 'evidence_refs', 'runner_up'],
      segment: ['acquisition_value_band_label', 'acquisition_value_band_order'],
      metrics: ['total_item_count', 'realized_item_count', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size', 'realization_rate_percent'],
      baseline: ['type', 'median_net_profit', 'median_roi', 'median_days_on_market', 'realization_rate_percent'],
      runner_up: ['segment', 'metrics', 'triggered_rules', 'reason_not_selected'],
    };

    const unexpectedKeys: string[] = [];
    const walk = (value: unknown, pathKey: string): void => {
      if (Array.isArray(value)) return;
      if (typeof value !== 'object' || value === null) return;
      const allowed = allowedKeysByPath[pathKey];
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (allowed && !allowed.includes(key)) unexpectedKeys.push(`${pathKey}.${key}`);
        const nextPathKey = key === 'segment' ? 'segment' : key === 'metrics' ? 'metrics' : key === 'baseline' ? 'baseline' : key === 'runner_up' ? 'runner_up' : key;
        walk((value as Record<string, unknown>)[key], nextPathKey);
      }
    };
    if (result.status === 'selected') walk(result, 'root');

    check('no unexpected keys (no item/user identity fields) appear anywhere in the finding', unexpectedKeys.length === 0, unexpectedKeys);

    const serialized = JSON.stringify(result);
    const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i, /"name"\s*:/i];
    const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
    check('serialized finding contains no PII-shaped field names', matched.length === 0, matched);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRONG_CATEGORY_ACQUISITION_BAND (Insights Engine v1.1)
  // ═══════════════════════════════════════════════════════════════════════

  // Reused across several fixtures below — the exact Guitars segment
  // metrics from broad-rule Test 1, now scoped to a single category.
  const GUITARS_BANDS: CategoryBandFixture[] = [
    { categoryId: 1, categoryName: 'Guitars', order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
    { categoryId: 1, categoryName: 'Guitars', order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
    { categoryId: 1, categoryName: 'Guitars', order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
    { categoryId: 1, categoryName: 'Guitars', order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
  ];
  // A category where every band is nearly identical to its peers — nobody
  // ever accumulates 2 material improvement triggers, so nothing qualifies.
  const PEDALS_NO_QUALIFIER_BANDS: CategoryBandFixture[] = [
    { categoryId: 2, categoryName: 'Pedals', order: 2, label: '$1,000-1,999', total: 10, realized: 6, domSample: 6, realizationRate: 45, profit: 400, roi: 20, dom: 20, confidence: 'moderate' },
    { categoryId: 2, categoryName: 'Pedals', order: 3, label: '$2,000-2,999', total: 10, realized: 6, domSample: 6, realizationRate: 46, profit: 410, roi: 21, dom: 19, confidence: 'moderate' },
    { categoryId: 2, categoryName: 'Pedals', order: 4, label: '$3,000-3,999', total: 10, realized: 6, domSample: 6, realizationRate: 44, profit: 390, roi: 19, dom: 21, confidence: 'moderate' },
  ];

  // ── C1: representative data selects Guitars × $2,000-2,999 ──────────────
  console.log('\n[C1 — acceptance check: Guitars × $2,000-2,999 wins]');
  {
    const evidence = makeCategoryEvidence([...GUITARS_BANDS, ...PEDALS_NO_QUALIFIER_BANDS]);
    const { result } = evaluateStrongCategoryAcquisitionBand(evidence);
    check('result status is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('winner category is Guitars', result.segment.category_name === 'Guitars', result.segment);
      check('winner band is $2,000-2,999', result.segment.acquisition_value_band_label === '$2,000-2,999', result.segment);
      check('metrics.total_item_count is 28', result.metrics.total_item_count === 28, result.metrics);
      check('metrics.realized_item_count is 19', result.metrics.realized_item_count === 19, result.metrics);
      check('metrics.median_net_profit is 750', result.metrics.median_net_profit === 750, result.metrics);
      check('baseline is same_category_peer_band_median_baseline', result.baseline.type === 'same_category_peer_band_median_baseline', result.baseline);
      check(
        'runner-up is also within Guitars ($1,000-1,999), never a different category',
        result.runner_up?.segment.category_name === 'Guitars' && result.runner_up?.segment.acquisition_value_band_label === '$1,000-1,999',
        result.runner_up,
      );
    }
  }

  // ── C2: winner is not hardcoded ──────────────────────────────────────────
  console.log('\n[C2 — winner is not hardcoded]');
  {
    const bands: CategoryBandFixture[] = [
      { categoryId: 5, categoryName: 'Basses', order: 2, label: '$1,000-1,999', total: 10, realized: 5, domSample: 5, realizationRate: 40, profit: 300, roi: 15, dom: 30, confidence: 'low' },
      { categoryId: 5, categoryName: 'Basses', order: 3, label: '$2,000-2,999', total: 10, realized: 5, domSample: 5, realizationRate: 42, profit: 320, roi: 18, dom: 28, confidence: 'low' },
      { categoryId: 5, categoryName: 'Basses', order: 4, label: '$3,000-3,999', total: 10, realized: 6, domSample: 6, realizationRate: 70, profit: 900, roi: 50, dom: 8, confidence: 'moderate' },
      { categoryId: 5, categoryName: 'Basses', order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 41, profit: 310, roi: 16, dom: 29, confidence: 'low' },
    ];
    const { result } = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(bands));
    check(
      'a different fixture selects Basses × $3,000-3,999, not Guitars × $2,000-2,999',
      result.status === 'selected' && result.segment.category_name === 'Basses' && result.segment.acquisition_value_band_label === '$3,000-3,999',
      result,
    );
  }

  // ── C3/C4/C5: pooled all-purpose evidence used; business-only/_by_purpose
  // evidence ignored; Hybrid and Personal items remain included ───────────
  console.log('\n[C3-C5 — pooled all-purpose evidence used; business-only/_by_purpose evidence ignored]');
  {
    const evidence = makeCategoryEvidence([...GUITARS_BANDS, ...PEDALS_NO_QUALIFIER_BANDS], { includeByPurposeDecoy: true });
    const { result } = evaluateStrongCategoryAcquisitionBand(evidence);
    check(
      'C3: pooled evidence is used — winner is still Guitars × $2,000-2,999',
      result.status === 'selected' && result.segment.category_name === 'Guitars' && result.segment.acquisition_value_band_label === '$2,000-2,999',
      result,
    );
    check(
      'C4: the Business-only-shaped _by_purpose decoy (tiny counts, insufficient confidence) is ignored',
      result.status === 'selected' && result.metrics.total_item_count === 28,
      result,
    );
    check(
      'C5: pooled metrics (which include Hybrid/Personal items, unlike the 1-item-per-band Business-only decoy) drive the result',
      result.status === 'selected' && result.metrics.realized_item_count === 19,
      result,
    );
  }

  // ── C6: baseline uses other bands inside the SAME category only ─────────
  console.log('\n[C6 — baseline uses same-category peers only, never cross-category]');
  {
    const ampsBands: CategoryBandFixture[] = [
      { categoryId: 6, categoryName: 'Amps', order: 2, label: '$1,000-1,999', total: 10, realized: 6, domSample: 6, realizationRate: 30, profit: 5000, roi: 10, dom: 40, confidence: 'moderate' },
      { categoryId: 6, categoryName: 'Amps', order: 3, label: '$2,000-2,999', total: 10, realized: 6, domSample: 6, realizationRate: 31, profit: 5100, roi: 11, dom: 39, confidence: 'moderate' },
      { categoryId: 6, categoryName: 'Amps', order: 4, label: '$3,000-3,999', total: 10, realized: 6, domSample: 6, realizationRate: 42, profit: 5300, roi: 18, dom: 30, confidence: 'moderate' },
    ];
    // Combined with the (much lower absolute profit) Guitars fixture — if
    // the baseline were ever computed across ALL eligible bands instead of
    // just this candidate's own category, it would be dragged toward
    // Guitars' ~$550-750 scale instead of Amps' ~$5000 scale.
    const evidence = makeCategoryEvidence([...ampsBands, ...GUITARS_BANDS]);
    const { result } = evaluateStrongCategoryAcquisitionBand(evidence);
    check('the Amps $3,000-3,999 band wins (4 triggers beats Guitars $2,000-2,999 at 3)', result.status === 'selected' && result.segment.category_name === 'Amps', result);
    if (result.status === 'selected') {
      check('baseline.median_net_profit is the Amps-only peer median (5050), not a cross-category blend', result.baseline.median_net_profit === 5050, result.baseline);
      check('baseline.median_roi is the Amps-only peer median (10.5)', result.baseline.median_roi === 10.5, result.baseline);
      check('baseline.median_days_on_market is the Amps-only peer median (39.5)', result.baseline.median_days_on_market === 39.5, result.baseline);
      check('baseline.realization_rate_percent is the Amps-only peer median (30.5)', result.baseline.realization_rate_percent === 30.5, result.baseline);
    }
  }

  // ── C7: a globally strong but category-weak segment does not qualify ────
  console.log('\n[C7 — globally strong but category-weak segment does not qualify]');
  {
    // Basses2's own peers are far stronger than the candidate — the
    // candidate's absolute numbers look strong next to Pedals (~$400
    // profit) but are a material weakness against its OWN category peers
    // (~$1,200+ profit).
    const basses2Bands: CategoryBandFixture[] = [
      { categoryId: 7, categoryName: 'Basses2', order: 2, label: '$1,000-1,999', total: 10, realized: 6, domSample: 6, realizationRate: 70, profit: 1200, roi: 40, dom: 8, confidence: 'moderate' },
      { categoryId: 7, categoryName: 'Basses2', order: 3, label: '$2,000-2,999', total: 10, realized: 6, domSample: 6, realizationRate: 72, profit: 1250, roi: 42, dom: 7, confidence: 'moderate' },
      { categoryId: 7, categoryName: 'Basses2', order: 4, label: '$3,000-3,999', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 900, roi: 25, dom: 15, confidence: 'moderate' },
    ];
    const evidence = makeCategoryEvidence([...basses2Bands, ...PEDALS_NO_QUALIFIER_BANDS]);
    const { candidateEvaluations } = evaluateStrongCategoryAcquisitionBand(evidence);
    const candidate = categoryEvalFor(7, 4, candidateEvaluations);
    check('the candidate (profit 900, far above Pedals ~$400) is still ineligible-to-qualify', candidate?.qualifies === false, candidate);
    check('the candidate carries material weakness against its OWN category peers', (candidate?.material_weakness_triggers.length ?? 0) > 0, candidate);
  }

  // ── C8: fewer than three eligible category bands prevents evaluation ────
  console.log('\n[C8 — fewer than three eligible category bands prevents evaluation]');
  {
    const ukulelesBands: CategoryBandFixture[] = [
      { categoryId: 8, categoryName: 'Ukuleles', order: 2, label: '$1,000-1,999', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 8, categoryName: 'Ukuleles', order: 3, label: '$2,000-2,999', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ];
    const { result } = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(ukulelesBands));
    check(
      'result is no_eligible_finding with INSUFFICIENT_ELIGIBLE_CATEGORY_BANDS',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_CATEGORY_BANDS'),
      result,
    );
  }

  // ── C9: insufficient categories are excluded, not marked weak ───────────
  console.log('\n[C9 — insufficient categories are excluded, not marked weak]');
  {
    const ukulelesBands: CategoryBandFixture[] = [
      { categoryId: 8, categoryName: 'Ukuleles', order: 2, label: '$1,000-1,999', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 8, categoryName: 'Ukuleles', order: 3, label: '$2,000-2,999', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ];
    const evidence = makeCategoryEvidence([...GUITARS_BANDS, ...PEDALS_NO_QUALIFIER_BANDS, ...ukulelesBands]);
    const { candidateEvaluations } = evaluateStrongCategoryAcquisitionBand(evidence);
    const uke2 = categoryEvalFor(8, 2, candidateEvaluations);
    const uke3 = categoryEvalFor(8, 3, candidateEvaluations);
    check('Ukuleles $1,000-1,999 is excluded as CATEGORY_HAS_FEWER_THAN_THREE_ELIGIBLE_BANDS', uke2?.eligible === false && !!uke2.eligibility_failure_reasons.includes('CATEGORY_HAS_FEWER_THAN_THREE_ELIGIBLE_BANDS'), uke2);
    check('Ukuleles $2,000-2,999 is excluded the same way', uke3?.eligible === false && !!uke3.eligibility_failure_reasons.includes('CATEGORY_HAS_FEWER_THAN_THREE_ELIGIBLE_BANDS'), uke3);
    check('neither Ukuleles row carries any improvement or weakness trigger (never evaluated)', uke2?.material_improvement_triggers.length === 0 && uke2?.material_weakness_triggers.length === 0 && uke3?.material_improvement_triggers.length === 0 && uke3?.material_weakness_triggers.length === 0, { uke2, uke3 });
  }

  // ── C10: highest ROI alone does not win ──────────────────────────────────
  console.log('\n[C10 — highest ROI alone does not win]');
  {
    const bands: CategoryBandFixture[] = [
      { categoryId: 10, categoryName: 'Category10', order: 2, label: 'W', total: 10, realized: 6, domSample: 6, realizationRate: 38, profit: 280, roi: 17, dom: 27, confidence: 'moderate' },
      { categoryId: 10, categoryName: 'Category10', order: 3, label: 'X-high-roi', total: 10, realized: 6, domSample: 6, realizationRate: 35, profit: 200, roi: 80, dom: 40, confidence: 'moderate' },
      { categoryId: 10, categoryName: 'Category10', order: 4, label: 'Y-balanced', total: 10, realized: 6, domSample: 6, realizationRate: 55, profit: 500, roi: 22, dom: 15, confidence: 'moderate' },
      { categoryId: 10, categoryName: 'Category10', order: 5, label: 'Z', total: 10, realized: 6, domSample: 6, realizationRate: 40, profit: 300, roi: 18, dom: 25, confidence: 'moderate' },
    ];
    const { result, candidateEvaluations } = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(bands));
    check('the highest-ROI band does not qualify', categoryEvalFor(10, 3, candidateEvaluations)?.qualifies === false);
    check('the balanced band is selected instead', result.status === 'selected' && result.segment.acquisition_value_band_label === 'Y-balanced', result);
  }

  // ── C11: highest profit alone does not win ───────────────────────────────
  console.log('\n[C11 — highest profit alone does not win]');
  {
    const bands: CategoryBandFixture[] = [
      { categoryId: 11, categoryName: 'Category11', order: 2, label: 'W2', total: 10, realized: 6, domSample: 6, realizationRate: 38, profit: 280, roi: 17, dom: 27, confidence: 'moderate' },
      { categoryId: 11, categoryName: 'Category11', order: 3, label: 'X2-high-profit', total: 10, realized: 6, domSample: 6, realizationRate: 30, profit: 2000, roi: 15, dom: 45, confidence: 'moderate' },
      { categoryId: 11, categoryName: 'Category11', order: 4, label: 'Y2-balanced', total: 10, realized: 6, domSample: 6, realizationRate: 60, profit: 500, roi: 30, dom: 12, confidence: 'moderate' },
      { categoryId: 11, categoryName: 'Category11', order: 5, label: 'Z2', total: 10, realized: 6, domSample: 6, realizationRate: 40, profit: 300, roi: 18, dom: 25, confidence: 'moderate' },
    ];
    const { result, candidateEvaluations } = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(bands));
    check('the highest-profit band does not qualify', categoryEvalFor(11, 3, candidateEvaluations)?.qualifies === false);
    check('the balanced band is selected instead', result.status === 'selected' && result.segment.acquisition_value_band_label === 'Y2-balanced', result);
  }

  // ── C12: material DOM weakness prevents qualification ───────────────────
  console.log('\n[C12 — material DOM weakness prevents qualification]');
  {
    const bands: CategoryBandFixture[] = [
      { categoryId: 12, categoryName: 'Category12', order: 2, label: 'G1', total: 10, realized: 6, domSample: 6, realizationRate: 50, profit: 500, roi: 20, dom: 20, confidence: 'moderate' },
      { categoryId: 12, categoryName: 'Category12', order: 3, label: 'G2-profitable-slow', total: 10, realized: 6, domSample: 6, realizationRate: 48, profit: 900, roi: 30, dom: 60, confidence: 'moderate' },
      { categoryId: 12, categoryName: 'Category12', order: 4, label: 'G3', total: 10, realized: 6, domSample: 6, realizationRate: 52, profit: 480, roi: 18, dom: 18, confidence: 'moderate' },
    ];
    const { candidateEvaluations } = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(bands));
    const g2 = categoryEvalFor(12, 3, candidateEvaluations);
    check('the profitable band has at least 2 improvement triggers', (g2?.material_improvement_triggers.length ?? 0) >= 2, g2);
    check('the profitable band also carries a DOM weakness trigger', !!g2?.material_weakness_triggers.includes('DOM_WORSE_THAN_PEER_BASELINE'), g2);
    check('the profitable band does not qualify', g2?.qualifies === false, g2);
  }

  // ── C13: null metrics are handled safely ─────────────────────────────────
  console.log('\n[C13 — null metrics handled safely, no throw]');
  {
    const bands: CategoryBandFixture[] = [
      { categoryId: 13, categoryName: 'Category13', order: 2, label: 'Null profit', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: null, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 13, categoryName: 'Category13', order: 3, label: 'Valid A', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 13, categoryName: 'Category13', order: 4, label: 'Valid B', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 13, categoryName: 'Category13', order: 5, label: 'Valid C', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ];
    let threw = false;
    let candidateEvaluations: ReturnType<typeof evaluateStrongCategoryAcquisitionBand>['candidateEvaluations'] = [];
    try {
      candidateEvaluations = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(bands)).candidateEvaluations;
    } catch {
      threw = true;
    }
    check('evaluating a null-profit segment does not throw', !threw);
    const nullBand = categoryEvalFor(13, 2, candidateEvaluations);
    check('the null-profit segment is ineligible with the correct reason', nullBand?.eligible === false && nullBand.eligibility_failure_reasons.includes('MEDIAN_NET_PROFIT_MISSING'), nullBand);
    check('exactly three other segments remain eligible', candidateEvaluations.filter((e) => e.eligible).length === 3, candidateEvaluations);
  }

  // ── C14: zero and unknown acquisition groups are excluded ───────────────
  console.log('\n[C14 — zero/unknown acquisition groups excluded]');
  {
    const bands: CategoryBandFixture[] = [
      { categoryId: 14, categoryName: 'Category14', order: 0, label: 'Zero assigned value', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 14, categoryName: 'Category14', order: 8, label: 'Unknown acquisition value', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 14, categoryName: 'Category14', order: 2, label: 'Valid A', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 14, categoryName: 'Category14', order: 3, label: 'Valid B', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
      { categoryId: 14, categoryName: 'Category14', order: 4, label: 'Valid C', total: 20, realized: 10, domSample: 10, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'moderate' },
    ];
    const { result, candidateEvaluations } = evaluateStrongCategoryAcquisitionBand(makeCategoryEvidence(bands));
    const zero = categoryEvalFor(14, 0, candidateEvaluations);
    const unknown = categoryEvalFor(14, 8, candidateEvaluations);
    check('zero-assigned segment is ineligible as NOT_POSITIVE_ACQUISITION_BAND', zero?.eligible === false && !!zero.eligibility_failure_reasons.includes('NOT_POSITIVE_ACQUISITION_BAND'), zero);
    check('unknown-acquisition segment is ineligible as NOT_POSITIVE_ACQUISITION_BAND', unknown?.eligible === false && !!unknown.eligibility_failure_reasons.includes('NOT_POSITIVE_ACQUISITION_BAND'), unknown);
    check(
      'neither the zero-assigned nor unknown segment is ever selected',
      !(result.status === 'selected' && (result.segment.acquisition_value_band_order === 0 || result.segment.acquisition_value_band_order === 8)),
      result,
    );
  }

  // ── C15: relationship metadata is added when both rules select the same
  // band ────────────────────────────────────────────────────────────────
  console.log('\n[C15 — relationship metadata added when both rules select the same band]');
  let c15CategoryFinding: SelectedFindingForTest | null = null;
  {
    const broadEvidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
      { order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
      { order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
    ]);
    const categoryEvidence = makeCategoryEvidence([...GUITARS_BANDS, ...PEDALS_NO_QUALIFIER_BANDS]);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: broadEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: {},
    });

    check('both rules produced a selected finding', insights.selected_findings.length === 2, insights.selected_findings);
    // Both are known (by finding_code) to be SelectedFinding, not
    // AcquisitionMethodPerformanceProfileFinding — cast to access
    // .relationship, which only the former has.
    const broadFinding = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE) as SelectedFindingForTest | undefined;
    const categoryFinding = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE) as SelectedFindingForTest | undefined;
    c15CategoryFinding = categoryFinding ?? null;

    check('the category finding carries relationship metadata', categoryFinding?.relationship?.relationship === 'refines', categoryFinding?.relationship);
    check('related_finding_code points at the broad-band rule', categoryFinding?.relationship?.related_finding_code === BROAD_FINDING_CODE, categoryFinding?.relationship);
    check('dedupe_group is a non-empty string', typeof categoryFinding?.relationship?.dedupe_group === 'string' && (categoryFinding?.relationship?.dedupe_group.length ?? 0) > 0, categoryFinding?.relationship);
    check('the category finding summary explains it refines the broader finding', !!categoryFinding?.summary.toLowerCase().includes('refines'), categoryFinding?.summary);
    check('the broad-band finding itself carries NO relationship field', broadFinding?.relationship === undefined, broadFinding);
  }

  // ── C16: the existing broad-band rule output remains unchanged ──────────
  console.log('\n[C16 — existing broad-band rule output remains unchanged]');
  {
    const broadEvidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
      { order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
      { order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
    ]);
    // Empty category evidence — the category rule finds nothing at all, so
    // no relationship metadata can apply here, isolating this check to
    // "is the broad finding itself untouched by the orchestrator/v1.1".
    const { result: directResult } = evaluateStrongBalancedAcquisitionBand(broadEvidence);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: broadEvidence,
      targetUserInventorySegmentationEvidence: makeCategoryEvidence([]),
      targetUserDealChannelEvidence: {},
    });
    const viaOrchestrator = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);

    check('insights_engine_version is 1.3', insights.insights_engine_version === '1.3', insights.insights_engine_version);
    check('findings_selector_version is 1.3', insights.findings_selector_version === '1.3', insights.findings_selector_version);
    check(
      'the broad finding produced via selectFindings is identical to calling the rule directly (aside from generated_at, which the broad rule does not even set)',
      JSON.stringify(viaOrchestrator) === JSON.stringify(directResult),
      { viaOrchestrator, directResult },
    );
  }

  // ── C17: old Insights Engine 1.0 snapshots remain readable ───────────────
  console.log('\n[C17 — old Insights Engine v1.0 snapshots (no category rule, no relationship field) remain readable]');
  {
    const v10ShapedInsights = {
      insights_engine_version: '1.0',
      findings_selector_version: '1.0',
      source_analytics_version: '2.10',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: BROAD_FINDING_CODE,
          family: 'acquisition_performance',
          direction: 'strength',
          status: 'selected',
          headline: '$2,000-2,999 is a strong, balanced acquisition band',
          summary: 'placeholder v1.0-shaped summary',
          segment: { acquisition_value_band_label: '$2,000-2,999', acquisition_value_band_order: 3 },
          metrics: { total_item_count: 28, realized_item_count: 19, median_net_profit: 750, median_roi: 33.33, median_days_on_market: 10.5, dom_sample_size: 19, realization_rate_percent: 67.86 },
          baseline: { type: 'peer_band_median_baseline', median_net_profit: 600, median_roi: 25, median_days_on_market: 20, realization_rate_percent: 58 },
          triggered_rules: ['PROFIT_ABOVE_PEER_BASELINE', 'NO_MATERIAL_WEAKNESS'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_BAND_METRICS'],
          evidence_refs: ['target_user_acquisition_evidence.acquisition_value_band_performance'],
          // No `relationship` field at all — this is the v1.0 shape.
        },
      ],
      // No category_id/category_name on this row — this is the v1.0 shape.
      rule_evaluations: [
        { finding_code: BROAD_FINDING_CODE, acquisition_value_band_order: 3, acquisition_value_band_label: '$2,000-2,999', eligible: true, eligibility_failure_reasons: [], material_improvement_triggers: ['PROFIT_ABOVE_PEER_BASELINE'], material_weakness_triggers: [], qualifies: true, selected: true },
      ],
    };
    const fullSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.10',
      analytics_definition_version: '2.10',
      generated_at: new Date().toISOString(),
      evidence_scope: 'shared_inventory_population',
      purpose_semantics: 'v2',
      shared_purpose_evidence: {},
      target_user_purpose_evidence: {},
      target_user_open_inventory_evidence: {},
      shared_acquisition_evidence: {},
      target_user_acquisition_evidence: {},
      shared_inventory_segmentation_evidence: {},
      target_user_inventory_segmentation_evidence: {},
      shared_deal_channel_evidence: {},
      target_user_deal_channel_evidence: {},
      shared_listing_channel_evidence: {},
      target_user_listing_channel_evidence: {},
      shared_capital_liquidity_evidence: {},
      target_user_capital_liquidity_evidence: {},
      shared_calendar_seasonality_evidence: {},
      target_user_calendar_seasonality_evidence: {},
      insights: v10ShapedInsights,
    };
    check('a stored v2.10 snapshot carrying an Insights Engine v1.0-shaped insights section still validates', isValidAnalyticsSnapshot(fullSnapshot));
  }

  // ── C18: findings carry no user IDs, item IDs, names, models, notes, or
  // emails ─────────────────────────────────────────────────────────────────
  console.log('\n[C18 — category findings carry no user IDs, item IDs, names, models, notes, or emails]');
  {
    if (!c15CategoryFinding) {
      check('C15 produced a category finding to check for PII', false);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'baseline', 'triggered_rules', 'confidence', 'limitations', 'evidence_refs', 'runner_up', 'relationship'],
        segment: ['category_id', 'category_name', 'acquisition_value_band_label', 'acquisition_value_band_order'],
        metrics: ['total_item_count', 'realized_item_count', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size', 'realization_rate_percent'],
        baseline: ['type', 'median_net_profit', 'median_roi', 'median_days_on_market', 'realization_rate_percent'],
        runner_up: ['segment', 'metrics', 'triggered_rules', 'reason_not_selected'],
        relationship: ['relationship', 'related_finding_code', 'dedupe_group'],
      };

      const unexpectedKeys: string[] = [];
      const walk = (value: unknown, pathKey: string): void => {
        if (Array.isArray(value)) return;
        if (typeof value !== 'object' || value === null) return;
        const allowed = allowedKeysByPath[pathKey];
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (allowed && !allowed.includes(key)) unexpectedKeys.push(`${pathKey}.${key}`);
          const nextPathKey = ['segment', 'metrics', 'baseline', 'runner_up', 'relationship'].includes(key) ? key : key;
          walk((value as Record<string, unknown>)[key], nextPathKey);
        }
      };
      walk(c15CategoryFinding, 'root');

      check('no unexpected keys (no item/user identity fields) appear anywhere in the category finding', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(c15CategoryFinding);
      const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('serialized category finding contains no PII-shaped field names', matched.length === 0, matched);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ACQUISITION_METHOD_PERFORMANCE_PROFILE (Insights Engine v1.2)
  // ═══════════════════════════════════════════════════════════════════════

  // Reused across several fixtures below — the exact representative
  // acceptance numbers from the task (Purchase produces stronger realized
  // economics; Trade exits faster).
  const ACCEPTANCE_METHOD_ROWS: MethodRowFixture[] = [
    { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 9, domSample: 9, profit: 1800, roi: 115, dom: 47, confidence: 'moderate' },
    { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 14, domSample: 14, profit: 0, roi: 0, dom: 15.5, confidence: 'stronger' },
    { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 9, domSample: 9, profit: 1700, roi: 75, dom: 25, confidence: 'moderate' },
    { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 23, domSample: 23, profit: 500, roi: 25, dom: 16.5, confidence: 'stronger' },
  ];

  // ── M1: representative evidence returns PURCHASE_ECONOMICS_TRADE_SPEED ──
  console.log('\n[M1 — acceptance check: representative evidence returns PURCHASE_ECONOMICS_TRADE_SPEED]');
  {
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS));
    check('result status is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('profile_code is PURCHASE_ECONOMICS_TRADE_SPEED', result.profile_code === 'PURCHASE_ECONOMICS_TRADE_SPEED', result.profile_code);
      check('direction is tradeoff', result.direction === 'tradeoff', result.direction);
      check('eligible_exit_method_comparison_count is 2', result.eligible_exit_method_comparison_count === 2, result);
      const sale = comparisonFor('sale', result);
      const trade = comparisonFor('trade', result);
      check('Sale comparison: Purchase has the profit advantage', sale?.profit_advantage === 'Purchase', sale);
      check('Sale comparison: Purchase has the ROI advantage', sale?.roi_advantage === 'Purchase', sale);
      check('Sale comparison: Trade has the DOM (speed) advantage', sale?.dom_advantage === 'Trade', sale);
      check('Trade comparison: Purchase has the profit advantage', trade?.profit_advantage === 'Purchase', trade);
      check('Trade comparison: Purchase has the ROI advantage', trade?.roi_advantage === 'Purchase', trade);
      check('Trade comparison: Trade has the DOM (speed) advantage', trade?.dom_advantage === 'Trade', trade);
      check('summary explains stronger Purchase economics and faster Trade exits', result.summary.toLowerCase().includes('economics') || result.summary.toLowerCase().includes('profit'), result.summary);
    }
  }

  // ── M2: the result is not hardcoded ──────────────────────────────────────
  console.log('\n[M2 — result is not hardcoded]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 60, dom: 10, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 200, roi: 20, dom: 30, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 900, roi: 55, dom: 12, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 250, roi: 22, dom: 28, confidence: 'moderate' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'a different fixture (Purchase wins profit+ROI+DOM everywhere) returns PURCHASE_BROAD_ADVANTAGE, not PURCHASE_ECONOMICS_TRADE_SPEED',
      result.status === 'selected' && result.profile_code === 'PURCHASE_BROAD_ADVANTAGE',
      result,
    );
  }

  // ── M3: Purchase and Trade are compared within the same exit method ─────
  console.log('\n[M3 — Purchase and Trade are compared within the same exit method]');
  {
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS));
    if (result.status === 'selected') {
      const sale = comparisonFor('sale', result);
      check('Sale comparison pairs Purchase->Sale (profit 1800) with Trade->Sale (profit 0)', sale?.purchase.median_net_profit === 1800 && sale?.trade.median_net_profit === 0, sale);
    } else {
      check('M3 setup produced a selected finding', false, result);
    }
  }

  // ── M4: Purchase -> Sale is never directly compared with Trade -> Trade ──
  console.log('\n[M4 — Purchase -> Sale is never compared with Trade -> Trade]');
  {
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS));
    if (result.status === 'selected') {
      const sale = comparisonFor('sale', result);
      const trade = comparisonFor('trade', result);
      check('Sale comparison\'s Trade side is Trade->Sale (n=14), not Trade->Trade (n=23)', sale?.trade.item_count === 14, sale);
      check('Trade comparison\'s Purchase side is Purchase->Trade (profit 1700), not Purchase->Sale (profit 1800)', trade?.purchase.median_net_profit === 1700, trade);
    } else {
      check('M4 setup produced a selected finding', false, result);
    }
  }

  // ── M5: medians from multiple exit methods are not combined ─────────────
  console.log('\n[M5 — medians are not combined into a synthetic overall median]');
  {
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS));
    if (result.status === 'selected') {
      const sale = comparisonFor('sale', result);
      const trade = comparisonFor('trade', result);
      check('Sale comparison retains its own raw Purchase profit (1800), not an average with Purchase->Trade (1700)', sale?.purchase.median_net_profit === 1800, sale);
      check('Trade comparison retains its own raw Purchase profit (1700), not an average with Purchase->Sale (1800)', trade?.purchase.median_net_profit === 1700, trade);
      check('no top-level combined median field exists on the finding itself', !('median_net_profit' in result) && !('median_roi' in result) && !('median_days_on_market' in result), Object.keys(result));
    } else {
      check('M5 setup produced a selected finding', false, result);
    }
  }

  // ── M6/M8: pooled all-purpose evidence used; Hybrid/Personal included ───
  console.log('\n[M6/M8 — pooled all-purpose evidence used (Hybrid/Personal remain included)]');
  {
    const evidence = makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS, { includeByPurposeDecoy: true });
    const { result } = evaluateAcquisitionMethodPerformanceProfile(evidence);
    check(
      'the Business-only-shaped method_paths_by_purpose decoy is ignored — result is unaffected',
      result.status === 'selected' && result.profile_code === 'PURCHASE_ECONOMICS_TRADE_SPEED',
      result,
    );
    if (result.status === 'selected') {
      const sale = comparisonFor('sale', result);
      check('pooled metrics (n=9, not the decoy\'s n=1) drive the result', sale?.purchase.item_count === 9, sale);
    }
  }

  // ── M7: shared and Purpose-specific evidence are ignored ─────────────────
  console.log('\n[M7 — shared and Purpose-specific evidence are ignored (wiring check)]');
  {
    const selectFindingsSource = fs.readFileSync(
      path.join(__dirname, '../src/lib/analytics/insights/selectFindings.ts'),
      'utf8',
    );
    check(
      'selectFindings.ts wires target_user_acquisition_evidence into the acquisition-method rule',
      selectFindingsSource.includes('evaluateAcquisitionMethodPerformanceProfile(input.targetUserAcquisitionEvidence)'),
    );
  }

  // ── M9: fewer than two eligible exit-method comparisons returns no finding
  console.log('\n[M9 — fewer than two eligible exit-method comparisons returns no finding]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 9, domSample: 9, profit: 1800, roi: 115, dom: 47, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 14, domSample: 14, profit: 0, roi: 0, dom: 15.5, confidence: 'stronger' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'result is no_eligible_finding with INSUFFICIENT_COMPARABLE_EXIT_METHODS',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_COMPARABLE_EXIT_METHODS'),
      result,
    );
  }

  // ── M10: insufficient rows are excluded, not labelled weak ──────────────
  console.log('\n[M10 — insufficient rows are excluded, not labelled weak]');
  {
    const rows: MethodRowFixture[] = ACCEPTANCE_METHOD_ROWS.map((r) =>
      r.acquisitionMethod === 'purchase' && r.exitMethod === 'sale' ? { ...r, itemCount: 3 } : r,
    );
    const { candidateEvaluations } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    const thin = methodEvalFor('purchase', 'sale', candidateEvaluations);
    check('the thin-sample row is ineligible', thin?.eligible === false, thin);
    check('the thin-sample row reason is ITEM_COUNT_BELOW_MINIMUM', !!thin?.eligibility_failure_reasons.includes('ITEM_COUNT_BELOW_MINIMUM'), thin);
  }

  // ── M11: profit difference alone does not create the full tradeoff profile
  console.log('\n[M11 — profit difference alone does not create the full economics/speed tradeoff profile]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 50, dom: 20, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 700, roi: 50, dom: 20, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 950, roi: 48, dom: 19, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 680, roi: 48, dom: 19, confidence: 'moderate' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'profit-only advantage (ROI and DOM neutral) produces PURCHASE_BROAD_ADVANTAGE, not PURCHASE_ECONOMICS_TRADE_SPEED',
      result.status === 'selected' && result.profile_code === 'PURCHASE_BROAD_ADVANTAGE',
      result,
    );
  }

  // ── M12: ROI and DOM thresholds are applied correctly ────────────────────
  console.log('\n[M12 — ROI and DOM thresholds applied at their exact boundaries]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 55, dom: 107, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 50, dom: 100, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 1000, roi: 54.9, dom: 24, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 1000, roi: 50, dom: 20, confidence: 'moderate' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    if (result.status === 'selected') {
      const sale = comparisonFor('sale', result);
      const trade = comparisonFor('trade', result);
      check('ROI diff of exactly 5pp triggers ROI_FAVORS_PURCHASE', sale?.roi_advantage === 'Purchase', sale);
      check('DOM diff of exactly 7 days (but <20%) still triggers via the absolute leg', sale?.dom_advantage === 'Trade', sale);
      check('ROI diff of 4.9pp (just under 5pp) does not trigger', trade?.roi_advantage === 'Neutral', trade);
      check('DOM diff of exactly 20% (but <7 days) still triggers via the relative leg', trade?.dom_advantage === 'Trade', trade);
    } else {
      check('M12 setup produced a selected finding', false, result);
    }
  }

  // ── M13: reverse data can produce TRADE_ECONOMICS_PURCHASE_SPEED ────────
  console.log('\n[M13 — reverse data produces TRADE_ECONOMICS_PURCHASE_SPEED]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 9, domSample: 9, profit: 1800, roi: 115, dom: 47, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 14, domSample: 14, profit: 0, roi: 0, dom: 15.5, confidence: 'stronger' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 9, domSample: 9, profit: 1700, roi: 75, dom: 25, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 23, domSample: 23, profit: 500, roi: 25, dom: 16.5, confidence: 'stronger' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'profile_code is TRADE_ECONOMICS_PURCHASE_SPEED',
      result.status === 'selected' && result.profile_code === 'TRADE_ECONOMICS_PURCHASE_SPEED',
      result,
    );
  }

  // ── M14: a consistent one-method advantage can produce a broad-advantage
  // profile ────────────────────────────────────────────────────────────────
  console.log('\n[M14 — a consistent one-method advantage produces a broad-advantage profile]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 200, roi: 20, dom: 30, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 60, dom: 10, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 250, roi: 22, dom: 28, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 900, roi: 55, dom: 12, confidence: 'moderate' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'Trade winning profit+ROI+DOM in both comparisons produces TRADE_BROAD_ADVANTAGE with direction strength',
      result.status === 'selected' && result.profile_code === 'TRADE_BROAD_ADVANTAGE' && result.direction === 'strength',
      result,
    );
  }

  // ── M15: conflicting directions produce MIXED_BY_EXIT_METHOD ────────────
  console.log('\n[M15 — conflicting directions produce MIXED_BY_EXIT_METHOD]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 60, dom: 10, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 200, roi: 20, dom: 30, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 250, roi: 22, dom: 28, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 900, roi: 55, dom: 12, confidence: 'moderate' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'Purchase winning Sale broadly and Trade winning Trade broadly produces MIXED_BY_EXIT_METHOD',
      result.status === 'selected' && result.profile_code === 'MIXED_BY_EXIT_METHOD',
      result,
    );
  }

  // ── M16: small differences produce NO_MATERIAL_DIFFERENCE ───────────────
  console.log('\n[M16 — small differences produce NO_MATERIAL_DIFFERENCE]');
  {
    const rows: MethodRowFixture[] = [
      { acquisitionMethod: 'purchase', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1000, roi: 50, dom: 20, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'sale', itemCount: 10, domSample: 10, profit: 1010, roi: 50.5, dom: 19.5, confidence: 'moderate' },
      { acquisitionMethod: 'purchase', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 990, roi: 49, dom: 20.5, confidence: 'moderate' },
      { acquisitionMethod: 'trade', exitMethod: 'trade', itemCount: 10, domSample: 10, profit: 1000, roi: 49.5, dom: 20, confidence: 'moderate' },
    ];
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows));
    check(
      'result is no_eligible_finding with NO_MATERIAL_DIFFERENCE',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('NO_MATERIAL_DIFFERENCE'),
      result,
    );
  }

  // ── M17: null metrics are handled safely ─────────────────────────────────
  console.log('\n[M17 — null metrics handled safely, no throw]');
  {
    const rows: MethodRowFixture[] = ACCEPTANCE_METHOD_ROWS.map((r) =>
      r.acquisitionMethod === 'purchase' && r.exitMethod === 'sale' ? { ...r, profit: null } : r,
    );
    let threw = false;
    let candidateEvaluations: ReturnType<typeof evaluateAcquisitionMethodPerformanceProfile>['candidateEvaluations'] = [];
    try {
      candidateEvaluations = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(rows)).candidateEvaluations;
    } catch {
      threw = true;
    }
    check('evaluating a null-profit row does not throw', !threw);
    const nullRow = methodEvalFor('purchase', 'sale', candidateEvaluations);
    check('the null-profit row is ineligible with the correct reason', nullRow?.eligible === false && nullRow.eligibility_failure_reasons.includes('MEDIAN_NET_PROFIT_MISSING'), nullRow);
  }

  // ── M18: confidence is capped at the weakest evidence row used ──────────
  console.log('\n[M18 — confidence is capped at the weakest evidence row used]');
  {
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS));
    check(
      'confidence is moderate (the weaker of the two moderate/stronger rows used), not stronger',
      result.status === 'selected' && result.confidence === 'moderate',
      result,
    );
  }

  // ── M19: existing two findings remain unchanged ──────────────────────────
  console.log('\n[M19 — existing STRONG_BALANCED_ACQUISITION_BAND / STRONG_CATEGORY_ACQUISITION_BAND findings remain unchanged]');
  {
    const broadEvidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
      { order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
      { order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
    ]) as Record<string, unknown>;
    const methodEvidence = makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS) as Record<string, unknown>;
    const combinedAcquisitionEvidence = {
      ...broadEvidence,
      acquisition_to_exit_analysis: {
        ...(broadEvidence.acquisition_to_exit_analysis as Record<string, unknown>),
        ...(methodEvidence.acquisition_to_exit_analysis as Record<string, unknown>),
      },
    };
    const categoryEvidence = makeCategoryEvidence([...GUITARS_BANDS, ...PEDALS_NO_QUALIFIER_BANDS]);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: combinedAcquisitionEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: {},
    });

    check('all three rule families are present in one insights payload', insights.selected_findings.length === 3, insights.selected_findings.map((f) => f.finding_code));
    const broadFinding = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE) as SelectedFindingForTest | undefined;
    const categoryFinding = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE) as SelectedFindingForTest | undefined;
    const methodFinding = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE) as AcquisitionMethodPerformanceProfileFinding | undefined;

    check('the broad finding is numerically unchanged (median_net_profit 750)', broadFinding?.metrics.median_net_profit === 750, broadFinding?.metrics);
    check('the category finding is numerically unchanged (Guitars x $2,000-2,999)', categoryFinding?.segment.category_name === 'Guitars' && categoryFinding?.segment.acquisition_value_band_label === '$2,000-2,999', categoryFinding?.segment);
    check('the acquisition-method finding is also present (PURCHASE_ECONOMICS_TRADE_SPEED)', methodFinding?.profile_code === 'PURCHASE_ECONOMICS_TRADE_SPEED', methodFinding);
    check('insights_engine_version is 1.3', insights.insights_engine_version === '1.3', insights.insights_engine_version);
    check('findings_selector_version is 1.3', insights.findings_selector_version === '1.3', insights.findings_selector_version);
  }

  // ── M20: old Insights Engine 1.0 and 1.1 snapshots remain readable ──────
  console.log('\n[M20 — old Insights Engine v1.0 and v1.1 snapshots remain readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.10',
      analytics_definition_version: '2.10',
      generated_at: new Date().toISOString(),
      evidence_scope: 'shared_inventory_population',
      purpose_semantics: 'v2',
      shared_purpose_evidence: {},
      target_user_purpose_evidence: {},
      target_user_open_inventory_evidence: {},
      shared_acquisition_evidence: {},
      target_user_acquisition_evidence: {},
      shared_inventory_segmentation_evidence: {},
      target_user_inventory_segmentation_evidence: {},
      shared_deal_channel_evidence: {},
      target_user_deal_channel_evidence: {},
      shared_listing_channel_evidence: {},
      target_user_listing_channel_evidence: {},
      shared_capital_liquidity_evidence: {},
      target_user_capital_liquidity_evidence: {},
      shared_calendar_seasonality_evidence: {},
      target_user_calendar_seasonality_evidence: {},
    };

    const v11ShapedInsights = {
      insights_engine_version: '1.1',
      findings_selector_version: '1.1',
      source_analytics_version: '2.10',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: CATEGORY_FINDING_CODE,
          family: 'category_acquisition_performance',
          direction: 'strength',
          status: 'selected',
          headline: 'Guitars × $2,000-2,999 is a strong, balanced segment',
          summary: 'placeholder v1.1-shaped summary',
          segment: { category_id: 1, category_name: 'Guitars', acquisition_value_band_label: '$2,000-2,999', acquisition_value_band_order: 3 },
          metrics: { total_item_count: 25, realized_item_count: 17, median_net_profit: 800, median_roi: 35.71, median_days_on_market: 9, dom_sample_size: 17, realization_rate_percent: 68 },
          baseline: { type: 'same_category_peer_band_median_baseline', median_net_profit: 742.5, median_roi: 31.44, median_days_on_market: 18.25, realization_rate_percent: 57.43 },
          triggered_rules: ['DOM_FASTER_THAN_PEER_BASELINE', 'REALIZATION_ABOVE_PEER_BASELINE', 'NO_MATERIAL_WEAKNESS'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_SEGMENT_METRICS'],
          evidence_refs: ['target_user_inventory_segmentation_evidence.category_type_performance.performance_by_category_and_acquisition_band'],
          relationship: { relationship: 'refines', related_finding_code: BROAD_FINDING_CODE, dedupe_group: 'ACQUISITION_BAND_3' },
        },
      ],
      rule_evaluations: [
        { finding_code: CATEGORY_FINDING_CODE, category_id: 1, category_name: 'Guitars', acquisition_value_band_order: 3, acquisition_value_band_label: '$2,000-2,999', eligible: true, eligibility_failure_reasons: [], material_improvement_triggers: ['DOM_FASTER_THAN_PEER_BASELINE', 'REALIZATION_ABOVE_PEER_BASELINE'], material_weakness_triggers: [], qualifies: true, selected: true },
      ],
    };

    const v10Snapshot = { ...baseSnapshot, insights: {
      insights_engine_version: '1.0',
      findings_selector_version: '1.0',
      source_analytics_version: '2.10',
      generated_at: new Date().toISOString(),
      selected_findings: [],
      rule_evaluations: [],
    } };
    const v11Snapshot = { ...baseSnapshot, insights: v11ShapedInsights };

    check('a stored v2.10 snapshot carrying an Insights Engine v1.0-shaped insights section still validates', isValidAnalyticsSnapshot(v10Snapshot));
    check('a stored v2.10 snapshot carrying an Insights Engine v1.1-shaped insights section (no acquisition-method finding) still validates', isValidAnalyticsSnapshot(v11Snapshot));
  }

  // ── M21: findings carry no user IDs, item IDs, names, models, notes, or
  // emails ─────────────────────────────────────────────────────────────────
  console.log('\n[M21 — acquisition-method findings carry no user IDs, item IDs, names, models, notes, or emails]');
  {
    const { result } = evaluateAcquisitionMethodPerformanceProfile(makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS));
    if (result.status !== 'selected') {
      check('M21 setup produced a selected finding', false, result);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'profile_code', 'eligible_exit_method_comparison_count', 'comparisons', 'confidence', 'limitations', 'evidence_refs'],
        comparisons: ['exit_method', 'purchase', 'trade', 'deltas', 'profit_advantage', 'roi_advantage', 'dom_advantage', 'triggered_rules'],
        purchase: ['item_count', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size', 'confidence'],
        trade: ['item_count', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size', 'confidence'],
        deltas: ['median_net_profit', 'median_roi', 'median_days_on_market'],
      };

      const unexpectedKeys: string[] = [];
      const walk = (value: unknown, pathKey: string): void => {
        if (Array.isArray(value)) {
          for (const item of value) walk(item, pathKey === 'comparisons' ? 'comparisons-entry' : pathKey);
          return;
        }
        if (typeof value !== 'object' || value === null) return;
        const effectivePathKey = pathKey === 'comparisons-entry' ? 'comparisons' : pathKey;
        const allowed = allowedKeysByPath[effectivePathKey];
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (allowed && !allowed.includes(key)) unexpectedKeys.push(`${effectivePathKey}.${key}`);
          const nextPathKey = ['purchase', 'trade', 'deltas', 'comparisons'].includes(key) ? key : key;
          walk((value as Record<string, unknown>)[key], nextPathKey);
        }
      };
      walk(result, 'root');

      check('no unexpected keys (no item/user identity fields) appear anywhere in the acquisition-method finding', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(result);
      const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i, /"name"\s*:/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('serialized acquisition-method finding contains no PII-shaped field names', matched.length === 0, matched);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRONG_DEAL_IN_TO_DEAL_OUT_JOURNEY (Insights Engine v1.3)
  // ═══════════════════════════════════════════════════════════════════════

  // Reused across several fixtures below — representative numbers close to
  // the task's acceptance expectation (Marketplace -> Marketplace wins;
  // Marketplace -> Kijiji is a plausible, also-qualifying runner-up).
  const MARKETPLACE_JOURNEY_FIXTURES: JourneyFixture[] = [
    { dealInChannelId: 1, dealInChannelName: 'Marketplace', dealOutChannelId: 1, dealOutChannelName: 'Marketplace', itemCount: 16, distinctAcquisitionDealCount: 16, distinctExitDealCount: 16, domSample: 16, profit: 625, roi: 28, dom: 11, confidence: 'stronger' },
    { dealInChannelId: 1, dealInChannelName: 'Marketplace', dealOutChannelId: 2, dealOutChannelName: 'Kijiji', itemCount: 6, distinctAcquisitionDealCount: 6, distinctExitDealCount: 6, domSample: 6, profit: 575, roi: 23, dom: 22.5, confidence: 'moderate' },
    { dealInChannelId: 3, dealInChannelName: 'Reverb', dealOutChannelId: 3, dealOutChannelName: 'Reverb', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 5, dom: 30, confidence: 'stronger' },
  ];

  // ── J1: representative evidence can select Marketplace -> Marketplace ───
  console.log('\n[J1 — acceptance check: Marketplace -> Marketplace can be selected]');
  {
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES));
    check('result status is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('winner Deal In channel is Marketplace', result.segment.deal_in_channel_name === 'Marketplace', result.segment);
      check('winner Deal Out channel is Marketplace', result.segment.deal_out_channel_name === 'Marketplace', result.segment);
      check('winner same_channel is true', result.segment.same_channel === true, result.segment);
      check('metrics.item_count is 16', result.metrics.item_count === 16, result.metrics);
      check('metrics.median_net_profit is 625', result.metrics.median_net_profit === 625, result.metrics);
      check('metrics.median_roi is 28', result.metrics.median_roi === 28, result.metrics);
      check('metrics.median_days_on_market is 11', result.metrics.median_days_on_market === 11, result.metrics);
      check('confidence is stronger', result.confidence === 'stronger', result.confidence);
      check(
        'runner-up is Marketplace -> Kijiji',
        result.runner_up?.segment.deal_in_channel_name === 'Marketplace' && result.runner_up?.segment.deal_out_channel_name === 'Kijiji',
        result.runner_up,
      );
      check('runner-up same_channel is false', result.runner_up?.segment.same_channel === false, result.runner_up?.segment);
      check('runner-up metrics.item_count is 6', result.runner_up?.metrics.item_count === 6, result.runner_up?.metrics);
      check('summary uses descriptive "sourced through / exited through" wording', result.summary.includes('sourced through Marketplace and later exited through Marketplace'), result.summary);
    }
  }

  // ── J2: the winner is not hardcoded ──────────────────────────────────────
  console.log('\n[J2 — winner is not hardcoded]');
  {
    const journeys: JourneyFixture[] = [
      { dealInChannelId: 10, dealInChannelName: 'A', dealOutChannelId: 10, dealOutChannelName: 'A', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 30, confidence: 'stronger' },
      { dealInChannelId: 10, dealInChannelName: 'A', dealOutChannelId: 11, dealOutChannelName: 'B', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 320, roi: 18, dom: 28, confidence: 'stronger' },
      { dealInChannelId: 12, dealInChannelName: 'C', dealOutChannelId: 13, dealOutChannelName: 'D', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 900, roi: 50, dom: 8, confidence: 'stronger' },
      { dealInChannelId: 11, dealInChannelName: 'B', dealOutChannelId: 10, dealOutChannelName: 'A', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 310, roi: 16, dom: 29, confidence: 'stronger' },
    ];
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    check(
      'a different fixture selects C -> D, not Marketplace -> Marketplace',
      result.status === 'selected' && result.segment.deal_in_channel_name === 'C' && result.segment.deal_out_channel_name === 'D',
      result,
    );
  }

  // ── J3: Deal In and Deal Out channels are read from the correct fields ───
  console.log('\n[J3 — Deal In and Deal Out channels are read from the correct fields, never swapped]');
  {
    const { candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES));
    const kijiji = journeyEvalFor(1, 2, candidateEvaluations);
    check('the Marketplace -> Kijiji row keeps deal_in as Marketplace and deal_out as Kijiji', kijiji?.deal_in_channel_name === 'Marketplace' && kijiji?.deal_out_channel_name === 'Kijiji', kijiji);
  }

  // ── J4/J6: pooled all-purpose evidence used (Hybrid/Personal included) ──
  console.log('\n[J4/J6 — pooled all-purpose evidence used (Hybrid/Personal remain included)]');
  {
    const evidence = makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES, { includeByPurposeDecoy: true });
    const { result } = evaluateStrongDealInToDealOutJourney(evidence);
    check(
      'the Business-only-shaped _by_purpose decoy is ignored — result is unaffected',
      result.status === 'selected' && result.segment.deal_in_channel_name === 'Marketplace' && result.segment.deal_out_channel_name === 'Marketplace',
      result,
    );
    if (result.status === 'selected') {
      check('pooled metrics (n=16, not the decoy\'s n=1) drive the result', result.metrics.item_count === 16, result.metrics);
    }
  }

  // ── J5: shared and Purpose-specific evidence are ignored (wiring check) ──
  console.log('\n[J5 — shared and Purpose-specific evidence are ignored (wiring check)]');
  {
    const selectFindingsSource = fs.readFileSync(
      path.join(__dirname, '../src/lib/analytics/insights/selectFindings.ts'),
      'utf8',
    );
    const runnerSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/runAnalytics.ts'), 'utf8');
    check(
      'selectFindings.ts wires target_user_deal_channel_evidence into the journey rule',
      selectFindingsSource.includes('evaluateStrongDealInToDealOutJourney(input.targetUserDealChannelEvidence)'),
    );
    check(
      'runAnalytics.ts wires target_user_deal_channel_evidence (not shared) into selectFindings',
      runnerSource.includes('targetUserDealChannelEvidence: snapshot.target_user_deal_channel_evidence'),
    );
    check(
      'runAnalytics.ts does not feed shared_deal_channel_evidence into selectFindings',
      !/targetUserDealChannelEvidence:\s*snapshot\.shared_deal_channel_evidence/.test(runnerSource),
    );
  }

  // ── J7: null and unknown channels are excluded ───────────────────────────
  console.log('\n[J7 — null and unknown channels are excluded]');
  {
    const journeys: JourneyFixture[] = [
      ...MARKETPLACE_JOURNEY_FIXTURES,
      { dealInChannelId: null, dealInChannelName: null, dealOutChannelId: 4, dealOutChannelName: 'Etsy', itemCount: 20, distinctAcquisitionDealCount: 15, distinctExitDealCount: 15, domSample: 20, profit: 1000, roi: 50, dom: 5, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    const unknownRow = journeyEvalFor(null, 4, candidateEvaluations);
    check('the null-Deal-In-channel row is ineligible', unknownRow?.eligible === false, unknownRow);
    check('the null-Deal-In-channel row reason is DEAL_IN_CHANNEL_IDENTITY_MISSING', !!unknownRow?.eligibility_failure_reasons.includes('DEAL_IN_CHANNEL_IDENTITY_MISSING'), unknownRow);
    check(
      'the null-channel row is never selected despite its attractive (fabricated) metrics',
      !(result.status === 'selected' && result.segment.deal_out_channel_name === 'Etsy'),
      result,
    );
  }

  // ── J8: item count alone is insufficient when distinct deal count is too
  // small ──────────────────────────────────────────────────────────────────
  console.log('\n[J8 — item count alone is insufficient when distinct deal count is too small]');
  {
    const journeys: JourneyFixture[] = [
      ...MARKETPLACE_JOURNEY_FIXTURES,
      { dealInChannelId: 5, dealInChannelName: 'BulkLot', dealOutChannelId: 5, dealOutChannelName: 'BulkLot', itemCount: 20, distinctAcquisitionDealCount: 2, distinctExitDealCount: 20, domSample: 20, profit: 1000, roi: 50, dom: 5, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    const bulkLot = journeyEvalFor(5, 5, candidateEvaluations);
    check('a 20-item journey backed by only 2 distinct acquisition deals is ineligible', bulkLot?.eligible === false, bulkLot);
    check('the reason is DISTINCT_DEAL_COUNT_BELOW_MINIMUM', !!bulkLot?.eligibility_failure_reasons.includes('DISTINCT_DEAL_COUNT_BELOW_MINIMUM'), bulkLot);
  }

  // ── J9: fewer than three eligible journeys returns no finding ────────────
  console.log('\n[J9 — fewer than three eligible journeys returns no finding]');
  {
    const journeys: JourneyFixture[] = [
      { dealInChannelId: 1, dealInChannelName: 'Marketplace', dealOutChannelId: 1, dealOutChannelName: 'Marketplace', itemCount: 16, distinctAcquisitionDealCount: 16, distinctExitDealCount: 16, domSample: 16, profit: 625, roi: 28, dom: 11, confidence: 'stronger' },
      { dealInChannelId: 1, dealInChannelName: 'Marketplace', dealOutChannelId: 2, dealOutChannelName: 'Kijiji', itemCount: 6, distinctAcquisitionDealCount: 6, distinctExitDealCount: 6, domSample: 6, profit: 575, roi: 23, dom: 22.5, confidence: 'moderate' },
    ];
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    check(
      'result is no_eligible_finding with INSUFFICIENT_ELIGIBLE_JOURNEYS',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_JOURNEYS'),
      result,
    );
  }

  // ── J10: insufficient journeys are excluded, not marked weak ────────────
  console.log('\n[J10 — insufficient journeys are excluded, not marked weak]');
  {
    const journeys: JourneyFixture[] = [
      ...MARKETPLACE_JOURNEY_FIXTURES,
      { dealInChannelId: 6, dealInChannelName: 'Thin', dealOutChannelId: 6, dealOutChannelName: 'Thin', itemCount: 3, distinctAcquisitionDealCount: 3, distinctExitDealCount: 3, domSample: 3, profit: 500, roi: 25, dom: 15, confidence: 'low' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    const thin = journeyEvalFor(6, 6, candidateEvaluations);
    check('the thin journey is ineligible', thin?.eligible === false, thin);
    check('the thin journey reason is ITEM_COUNT_BELOW_MINIMUM', !!thin?.eligibility_failure_reasons.includes('ITEM_COUNT_BELOW_MINIMUM'), thin);
    check('the thin journey carries no improvement or weakness trigger (never evaluated)', thin?.material_improvement_triggers.length === 0 && thin?.material_weakness_triggers.length === 0, thin);
  }

  // ── J11: highest ROI alone does not automatically win ───────────────────
  console.log('\n[J11 — highest ROI alone does not automatically win]');
  {
    const journeys: JourneyFixture[] = [
      { dealInChannelId: 20, dealInChannelName: 'W', dealOutChannelId: 20, dealOutChannelName: 'W', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 280, roi: 17, dom: 27, confidence: 'stronger' },
      { dealInChannelId: 21, dealInChannelName: 'X-high-roi', dealOutChannelId: 21, dealOutChannelName: 'X-high-roi', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 200, roi: 80, dom: 40, confidence: 'stronger' },
      { dealInChannelId: 22, dealInChannelName: 'Y-balanced', dealOutChannelId: 22, dealOutChannelName: 'Y-balanced', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 500, roi: 22, dom: 15, confidence: 'stronger' },
      { dealInChannelId: 23, dealInChannelName: 'Z', dealOutChannelId: 23, dealOutChannelName: 'Z', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 18, dom: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    check('the highest-ROI journey does not qualify', journeyEvalFor(21, 21, candidateEvaluations)?.qualifies === false);
    check('the balanced journey is selected instead', result.status === 'selected' && result.segment.deal_in_channel_name === 'Y-balanced', result);
  }

  // ── J12: highest profit alone does not automatically win ────────────────
  console.log('\n[J12 — highest profit alone does not automatically win]');
  {
    const journeys: JourneyFixture[] = [
      { dealInChannelId: 24, dealInChannelName: 'W2', dealOutChannelId: 24, dealOutChannelName: 'W2', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 280, roi: 17, dom: 27, confidence: 'stronger' },
      { dealInChannelId: 25, dealInChannelName: 'X2-high-profit', dealOutChannelId: 25, dealOutChannelName: 'X2-high-profit', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 2000, roi: 15, dom: 45, confidence: 'stronger' },
      { dealInChannelId: 26, dealInChannelName: 'Y2-balanced', dealOutChannelId: 26, dealOutChannelName: 'Y2-balanced', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 500, roi: 30, dom: 12, confidence: 'stronger' },
      { dealInChannelId: 27, dealInChannelName: 'Z2', dealOutChannelId: 27, dealOutChannelName: 'Z2', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 18, dom: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    check('the highest-profit journey does not qualify', journeyEvalFor(25, 25, candidateEvaluations)?.qualifies === false);
    check('the balanced journey is selected instead', result.status === 'selected' && result.segment.deal_in_channel_name === 'Y2-balanced', result);
  }

  // ── J13: material DOM weakness prevents qualification ────────────────────
  console.log('\n[J13 — material DOM weakness prevents qualification]');
  {
    const journeys: JourneyFixture[] = [
      { dealInChannelId: 28, dealInChannelName: 'G1', dealOutChannelId: 28, dealOutChannelName: 'G1', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 500, roi: 20, dom: 20, confidence: 'stronger' },
      { dealInChannelId: 29, dealInChannelName: 'G2-profitable-slow', dealOutChannelId: 29, dealOutChannelName: 'G2-profitable-slow', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 900, roi: 30, dom: 60, confidence: 'stronger' },
      { dealInChannelId: 30, dealInChannelName: 'G3', dealOutChannelId: 30, dealOutChannelName: 'G3', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 480, roi: 18, dom: 18, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    const g2 = journeyEvalFor(29, 29, candidateEvaluations);
    check('the profitable journey has at least 2 improvement triggers', (g2?.material_improvement_triggers.length ?? 0) >= 2, g2);
    check('the profitable journey also carries a DOM weakness trigger', !!g2?.material_weakness_triggers.includes('DOM_WORSE_THAN_PEER_BASELINE'), g2);
    check('the profitable journey does not qualify', g2?.qualifies === false, g2);
  }

  // ── J14: a fast but materially unprofitable journey does not qualify ────
  console.log('\n[J14 — a fast but materially unprofitable journey does not qualify]');
  {
    const journeys: JourneyFixture[] = [
      { dealInChannelId: 31, dealInChannelName: 'F1', dealOutChannelId: 31, dealOutChannelName: 'F1', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 500, roi: 20, dom: 25, confidence: 'stronger' },
      { dealInChannelId: 32, dealInChannelName: 'F2-fast-poor-profit', dealOutChannelId: 32, dealOutChannelName: 'F2-fast-poor-profit', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 100, roi: 35, dom: 8, confidence: 'stronger' },
      { dealInChannelId: 33, dealInChannelName: 'F3', dealOutChannelId: 33, dealOutChannelName: 'F3', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 520, roi: 19, dom: 27, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    const f2 = journeyEvalFor(32, 32, candidateEvaluations);
    check('the fast journey has at least 2 improvement triggers', (f2?.material_improvement_triggers.length ?? 0) >= 2, f2);
    check('the fast journey also carries a profit weakness trigger', !!f2?.material_weakness_triggers.includes('PROFIT_BELOW_PEER_BASELINE'), f2);
    check('the fast journey does not qualify', f2?.qualifies === false, f2);
  }

  // ── J15: baseline excludes the candidate itself ──────────────────────────
  console.log('\n[J15 — baseline excludes the candidate itself]');
  {
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES));
    check(
      'baseline.median_net_profit is the median of Kijiji+Reverb only (437.5), not pulled in by Marketplace->Marketplace\'s own 625',
      result.status === 'selected' && result.baseline.median_net_profit === 437.5,
      result.status === 'selected' ? result.baseline : result,
    );
  }

  // ── J16: peer baseline uses only eligible journeys ───────────────────────
  console.log('\n[J16 — peer baseline uses only eligible journeys]');
  {
    const journeys: JourneyFixture[] = [
      ...MARKETPLACE_JOURNEY_FIXTURES,
      { dealInChannelId: 7, dealInChannelName: 'Outlier', dealOutChannelId: 7, dealOutChannelName: 'Outlier', itemCount: 3, distinctAcquisitionDealCount: 3, distinctExitDealCount: 3, domSample: 3, profit: 999999, roi: 999, dom: 1, confidence: 'low' },
    ];
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(journeys));
    check(
      'an ineligible outlier (item_count 3, absurd metrics) never pollutes the baseline — still 437.5',
      result.status === 'selected' && result.baseline.median_net_profit === 437.5,
      result.status === 'selected' ? result.baseline : result,
    );
  }

  // ── J17: same-channel and cross-channel journeys are treated distinctly ──
  console.log('\n[J17 — same-channel and cross-channel journeys are treated distinctly]');
  {
    const { result, candidateEvaluations } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES));
    check('the winner (same-channel) has same_channel true', result.status === 'selected' && result.segment.same_channel === true, result);
    check('the runner-up (cross-channel) has same_channel false', result.status === 'selected' && result.runner_up?.segment.same_channel === false, result);
    const reverb = journeyEvalFor(3, 3, candidateEvaluations);
    check('a same-channel journey (Reverb -> Reverb) can still fail to qualify — same_channel is not a free pass', reverb?.qualifies === false, reverb);
  }

  // ── J18: same-channel wording remains descriptive and non-causal ────────
  console.log('\n[J18 — same-channel wording remains descriptive and non-causal]');
  {
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES));
    check('summary is present', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('summary explicitly frames the result as descriptive, not causal', result.summary.includes('not proof that using this channel journey caused the result'), result.summary);
      check('summary does not promise future performance', result.summary.toLowerCase().includes('does not guarantee'), result.summary);
    }
  }

  // ── J19: tie-breakers are deterministic ──────────────────────────────────
  console.log('\n[J19 — deterministic tie-breakers]');
  {
    // 19a: identical metrics, differing confidence — higher confidence wins.
    const confidenceJourneys: JourneyFixture[] = [
      { dealInChannelId: 60, dealInChannelName: 'T1a', dealOutChannelId: 61, dealOutChannelName: 'T1b', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'stronger' },
      { dealInChannelId: 62, dealInChannelName: 'T2a', dealOutChannelId: 63, dealOutChannelName: 'T2b', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'low' },
      { dealInChannelId: 64, dealInChannelName: 'T3a', dealOutChannelId: 65, dealOutChannelName: 'T3b', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: confResult } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(confidenceJourneys));
    check(
      'equal trigger counts break on confidence — T1 (stronger) beats T2 (low)',
      confResult.status === 'selected' && confResult.segment.deal_in_channel_name === 'T1a',
      confResult,
    );
    check(
      'the loser of the confidence tie-break appears as runner-up',
      confResult.status === 'selected' && confResult.runner_up?.segment.deal_in_channel_name === 'T2a',
      confResult,
    );

    // 19b: identical metrics AND confidence, differing ONLY in Deal In
    // channel id — falls through to ascending Deal In channel id.
    const dealInTieJourneys: JourneyFixture[] = [
      { dealInChannelId: 70, dealInChannelName: 'U1-lower-in', dealOutChannelId: 80, dealOutChannelName: 'U1-out', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { dealInChannelId: 75, dealInChannelName: 'U2-higher-in', dealOutChannelId: 81, dealOutChannelName: 'U2-out', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { dealInChannelId: 72, dealInChannelName: 'U3-filler', dealOutChannelId: 82, dealOutChannelName: 'U3-out', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: dealInResult } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(dealInTieJourneys));
    check(
      'fully tied candidates break on ascending Deal In channel id — U1 (70) beats U2 (75)',
      dealInResult.status === 'selected' && dealInResult.segment.deal_in_channel_id === 70,
      dealInResult,
    );

    // 19c: identical metrics, confidence, AND Deal In channel id, differing
    // ONLY in Deal Out channel id — falls through to ascending Deal Out
    // channel id specifically.
    const dealOutTieJourneys: JourneyFixture[] = [
      { dealInChannelId: 90, dealInChannelName: 'V-shared-in', dealOutChannelId: 91, dealOutChannelName: 'V1-lower-out', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { dealInChannelId: 90, dealInChannelName: 'V-shared-in', dealOutChannelId: 95, dealOutChannelName: 'V2-higher-out', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { dealInChannelId: 92, dealInChannelName: 'V3-filler', dealOutChannelId: 93, dealOutChannelName: 'V3-out', itemCount: 10, distinctAcquisitionDealCount: 8, distinctExitDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: dealOutResult } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(dealOutTieJourneys));
    check(
      'candidates tied on everything including Deal In id break on ascending Deal Out channel id — V1 (91) beats V2 (95)',
      dealOutResult.status === 'selected' && dealOutResult.segment.deal_out_channel_id === 91,
      dealOutResult,
    );
  }

  // ── J20: existing three findings remain byte-identical ──────────────────
  console.log('\n[J20 — existing three findings (broad, category, acquisition-method) remain byte-identical]');
  {
    const broadEvidence = makeEvidence([
      { order: 2, label: '$1,000-1,999', total: 15, realized: 8, domSample: 8, realizationRate: 55, profit: 550, roi: 45, dom: 15, confidence: 'moderate' },
      { order: 3, label: '$2,000-2,999', total: 28, realized: 19, domSample: 19, realizationRate: 67.86, profit: 750, roi: 33.33, dom: 10.5, confidence: 'stronger' },
      { order: 4, label: '$3,000-3,999', total: 12, realized: 6, domSample: 6, realizationRate: 60, profit: 600, roi: 20, dom: 20, confidence: 'moderate' },
      { order: 5, label: '$4,000-4,999', total: 10, realized: 5, domSample: 5, realizationRate: 58, profit: 650, roi: 25, dom: 25, confidence: 'low' },
    ]) as Record<string, unknown>;
    const methodEvidence = makeMethodExitEvidence(ACCEPTANCE_METHOD_ROWS) as Record<string, unknown>;
    const combinedAcquisitionEvidence = {
      ...broadEvidence,
      acquisition_to_exit_analysis: {
        ...(broadEvidence.acquisition_to_exit_analysis as Record<string, unknown>),
        ...(methodEvidence.acquisition_to_exit_analysis as Record<string, unknown>),
      },
    };
    const categoryEvidence = makeCategoryEvidence([...GUITARS_BANDS, ...PEDALS_NO_QUALIFIER_BANDS]);
    const journeyEvidence = makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES);

    const { result: directBroad } = evaluateStrongBalancedAcquisitionBand(combinedAcquisitionEvidence);
    const { result: directCategory } = evaluateStrongCategoryAcquisitionBand(categoryEvidence);
    const { result: directMethod } = evaluateAcquisitionMethodPerformanceProfile(combinedAcquisitionEvidence);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: combinedAcquisitionEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: journeyEvidence,
    });

    check('all four rule families are present in one insights payload', insights.selected_findings.length === 4, insights.selected_findings.map((f) => f.finding_code));
    const viaOrchestratorBroad = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);
    const viaOrchestratorCategory = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE);
    const viaOrchestratorMethod = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE);
    const viaOrchestratorJourney = insights.selected_findings.find((f) => f.finding_code === JOURNEY_FINDING_CODE);

    // The category finding gains relationship metadata + one summary
    // sentence from the orchestrator's cross-rule linking when it shares a
    // band with the broad finding — strip that back off before comparing,
    // since that linking is expected orchestrator behavior, not a change to
    // the category RULE's own output.
    const categoryWithoutRelationship = viaOrchestratorCategory
      ? { ...(viaOrchestratorCategory as SelectedFindingForTest), relationship: undefined, summary: (directCategory as SelectedFindingForTest).summary }
      : viaOrchestratorCategory;

    check('the broad finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorBroad) === JSON.stringify(directBroad), { viaOrchestratorBroad, directBroad });
    check('the category finding (minus orchestrator relationship linking) is byte-identical to calling the rule directly', JSON.stringify(categoryWithoutRelationship) === JSON.stringify(directCategory), { categoryWithoutRelationship, directCategory });
    check('the acquisition-method finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorMethod) === JSON.stringify(directMethod), { viaOrchestratorMethod, directMethod });
    check('the journey finding is also present (Marketplace -> Marketplace)', (viaOrchestratorJourney as SelectedFindingForTest | undefined)?.segment.deal_in_channel_name === 'Marketplace', viaOrchestratorJourney);
    check('insights_engine_version is 1.3', insights.insights_engine_version === '1.3', insights.insights_engine_version);
    check('findings_selector_version is 1.3', insights.findings_selector_version === '1.3', insights.findings_selector_version);
  }

  // ── J21: old Insights Engine snapshots (1.0, 1.1, 1.2) remain readable ──
  console.log('\n[J21 — old Insights Engine v1.0/v1.1/v1.2 snapshots (no channel-journey finding) remain readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.10',
      analytics_definition_version: '2.10',
      generated_at: new Date().toISOString(),
      evidence_scope: 'shared_inventory_population',
      purpose_semantics: 'v2',
      shared_purpose_evidence: {},
      target_user_purpose_evidence: {},
      target_user_open_inventory_evidence: {},
      shared_acquisition_evidence: {},
      target_user_acquisition_evidence: {},
      shared_inventory_segmentation_evidence: {},
      target_user_inventory_segmentation_evidence: {},
      shared_deal_channel_evidence: {},
      target_user_deal_channel_evidence: {},
      shared_listing_channel_evidence: {},
      target_user_listing_channel_evidence: {},
      shared_capital_liquidity_evidence: {},
      target_user_capital_liquidity_evidence: {},
      shared_calendar_seasonality_evidence: {},
      target_user_calendar_seasonality_evidence: {},
    };

    const v12ShapedInsights = {
      insights_engine_version: '1.2',
      findings_selector_version: '1.2',
      source_analytics_version: '2.10',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: METHOD_PROFILE_FINDING_CODE,
          family: 'acquisition_method_performance',
          direction: 'tradeoff',
          status: 'selected',
          headline: 'Purchase acquisitions show stronger realized economics; Trade acquisitions exit faster',
          summary: 'placeholder v1.2-shaped summary',
          profile_code: 'PURCHASE_ECONOMICS_TRADE_SPEED',
          eligible_exit_method_comparison_count: 2,
          comparisons: [],
          confidence: 'moderate',
          limitations: ['REALIZED_ITEMS_ONLY'],
          evidence_refs: ['target_user_acquisition_evidence.acquisition_to_exit_analysis.method_paths'],
          // No channel-journey finding, no `relationship` field — v1.2 shape.
        },
      ],
      rule_evaluations: [],
    };
    const v12Snapshot = { ...baseSnapshot, insights: v12ShapedInsights };

    check('a stored v2.10 snapshot carrying an Insights Engine v1.2-shaped insights section still validates', isValidAnalyticsSnapshot(v12Snapshot));
  }

  // ── J22: findings contain no user IDs, item IDs, item names, models,
  // notes, emails, or counterparty details ─────────────────────────────────
  console.log('\n[J22 — journey findings carry no user IDs, item IDs, names, models, notes, emails, or counterparty details]');
  {
    const { result } = evaluateStrongDealInToDealOutJourney(makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES));
    if (result.status !== 'selected') {
      check('J22 setup produced a selected finding', false, result);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'baseline', 'triggered_rules', 'confidence', 'limitations', 'evidence_refs', 'runner_up'],
        segment: ['deal_in_channel_id', 'deal_in_channel_name', 'deal_out_channel_id', 'deal_out_channel_name', 'same_channel'],
        metrics: ['item_count', 'distinct_deal_count', 'distinct_acquisition_deal_count', 'distinct_exit_deal_count', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size'],
        baseline: ['type', 'median_net_profit', 'median_roi', 'median_days_on_market', 'realization_rate_percent'],
        runner_up: ['segment', 'metrics', 'triggered_rules', 'reason_not_selected'],
      };

      const unexpectedKeys: string[] = [];
      const walk = (value: unknown, pathKey: string): void => {
        if (Array.isArray(value)) return;
        if (typeof value !== 'object' || value === null) return;
        const allowed = allowedKeysByPath[pathKey];
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (allowed && !allowed.includes(key)) unexpectedKeys.push(`${pathKey}.${key}`);
          const nextPathKey = key === 'segment' ? 'segment' : key === 'metrics' ? 'metrics' : key === 'baseline' ? 'baseline' : key === 'runner_up' ? 'runner_up' : key;
          walk((value as Record<string, unknown>)[key], nextPathKey);
        }
      };
      walk(result, 'root');

      check('no unexpected keys (no item/user identity or counterparty fields) appear anywhere in the journey finding', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(result);
      const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i, /"counterparty/i, /"contact/i, /"deal_id"/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('serialized journey finding contains no PII- or counterparty-shaped field names', matched.length === 0, matched);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
