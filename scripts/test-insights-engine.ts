/**
 * test-insights-engine.ts
 *
 * Focused, framework-free tests for Insights Engine's Findings Selector
 * rules — STRONG_BALANCED_ACQUISITION_BAND (v1.0) and STRONG_CATEGORY_
 * ACQUISITION_BAND (new in v1.1) — same "tsx script, no jest/vitest"
 * convention as scripts/test-analytics-runner.ts, but this one needs no
 * Supabase instance at all: every rule under test is a pure function of
 * hand-built evidence fixtures shaped exactly like Analytics v2.10's
 * target_user_acquisition_evidence (see
 * supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql,
 * CTEs m1t_band_rows / m2t_band_rows) and target_user_inventory_
 * segmentation_evidence (see
 * supabase/migrations/20260815000000_build_analytics_snapshot_v2_4.sql,
 * CTE cx_catband_rows). No production data, no database connection,
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
import { selectFindings } from '../src/lib/analytics/insights/selectFindings';
import { isValidAnalyticsSnapshot } from '../src/lib/analytics/runAnalytics';
import type { ConfidenceTier } from '../src/lib/analytics/insights/types';

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
  let c15CategoryFinding: ReturnType<typeof selectFindings>['selected_findings'][number] | null = null;
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
    });

    check('both rules produced a selected finding', insights.selected_findings.length === 2, insights.selected_findings);
    const broadFinding = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);
    const categoryFinding = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE);
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
    });
    const viaOrchestrator = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);

    check('insights_engine_version is 1.1', insights.insights_engine_version === '1.1', insights.insights_engine_version);
    check('findings_selector_version is 1.1', insights.findings_selector_version === '1.1', insights.findings_selector_version);
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
