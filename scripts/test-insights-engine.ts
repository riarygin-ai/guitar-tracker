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
import {
  evaluateStrongDealOutChannel,
  FINDING_CODE as DEAL_OUT_CHANNEL_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongDealOutChannel';
import {
  evaluateStrongDealInChannel,
  FINDING_CODE as DEAL_IN_CHANNEL_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongDealInChannel';
import {
  evaluateStrongListingPlatform,
  extractListingPlatformCandidates,
  FINDING_CODE as LISTING_PLATFORM_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongListingPlatform';
import {
  evaluateBusinessOpenInventoryPriority,
  extractBusinessOpenInventoryCandidates,
  FINDING_CODE as BUSINESS_OPEN_INVENTORY_PRIORITY_FINDING_CODE,
} from '../src/lib/analytics/insights/rules/businessOpenInventoryPriority';
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

// ── Deal Out Channel fixture builder ─────────────────────────────────────
// Mirrors target_user_deal_channel_evidence.deal_out_channel_performance.
// performance_by_deal_out_channel (dot_perf_rows) — one row per
// deal_out_channel_id, pooled across every Purpose.

interface DealOutChannelFixture {
  channelId: number | null;
  channelName: string | null;
  itemCount: number;
  distinctDealCount: number;
  domSample: number;
  profit: number | null;
  roi: number | null;
  dom: number | null;
  confidence: ConfidenceTier | null;
}

function makeDealOutChannelEvidence(channels: DealOutChannelFixture[], options?: { includeByPurposeDecoy?: boolean }): unknown {
  const dealOutChannelPerformance: Record<string, unknown> = {
    performance_by_deal_out_channel: channels.map((c) => ({
      deal_out_channel_id: c.channelId,
      deal_out_channel_name: c.channelName,
      deal_out_channel_requires_listing: false,
      deal_out_item_count: c.itemCount,
      deal_out_distinct_deal_count: c.distinctDealCount,
      sale_exit_item_count: c.itemCount,
      trade_exit_item_count: 0,
      historical_item_count: 0,
      app_tracked_item_count: c.itemCount,
      total_exit_value: null,
      total_acquisition_capital: null,
      total_realized_net_profit: null,
      median_exit_value: null,
      median_net_profit: c.profit,
      median_roi: c.roi,
      dom_sample_size: c.domSample,
      median_days_on_market: c.dom,
      holding_sample_size: c.itemCount,
      median_holding_days: c.dom,
      confidence: c.confidence,
    })),
  };

  if (options?.includeByPurposeDecoy) {
    // Deliberately worse, tiny-sample decoy under a DIFFERENT key
    // (performance_by_deal_out_channel_by_purpose) — the rule must never
    // read this key.
    dealOutChannelPerformance.performance_by_deal_out_channel_by_purpose = channels.map((c) => ({
      current_purpose_id: 1,
      current_purpose_name: 'Business',
      deal_out_channel_id: c.channelId,
      deal_out_channel_name: c.channelName,
      deal_out_item_count: 1,
      deal_out_distinct_deal_count: 1,
      median_net_profit: -99999,
      median_roi: -99999,
      dom_sample_size: 0,
      median_days_on_market: 9999,
      confidence: 'insufficient',
    }));
  }

  return { deal_out_channel_performance: dealOutChannelPerformance };
}

function dealOutChannelEvalFor(
  channelId: number | null,
  evaluations: ReturnType<typeof evaluateStrongDealOutChannel>['candidateEvaluations'],
) {
  return evaluations.find((e) => e.channel_id === channelId);
}

// ── Deal In Channel fixture builder ──────────────────────────────────────
// Mirrors target_user_deal_channel_evidence.deal_in_channel_performance.
// performance_by_deal_in_channel (dit_perf_rows) — one row per
// deal_in_channel_id, pooled across every Purpose, ALL acquired items
// (open + realized).

interface DealInChannelFixture {
  channelId: number | null;
  channelName: string | null;
  itemCount: number;
  distinctDealCount: number;
  realizedItemCount: number;
  domSample: number;
  realizationRate: number | null;
  profit: number | null;
  roi: number | null;
  dom: number | null;
  confidence: ConfidenceTier | null;
}

function makeDealInChannelEvidence(channels: DealInChannelFixture[], options?: { includeByPurposeDecoy?: boolean }): unknown {
  const dealInChannelPerformance: Record<string, unknown> = {
    performance_by_deal_in_channel: channels.map((c) => ({
      deal_in_channel_id: c.channelId,
      deal_in_channel_name: c.channelName,
      deal_in_channel_requires_listing: false,
      deal_in_item_count: c.itemCount,
      deal_in_distinct_deal_count: c.distinctDealCount,
      deal_in_realized_item_count: c.realizedItemCount,
      deal_in_open_item_count: Math.max(0, c.itemCount - c.realizedItemCount),
      deal_in_realization_rate_percent: c.realizationRate,
      purchase_acquisition_item_count: c.itemCount,
      trade_acquisition_item_count: 0,
      historical_item_count: 0,
      app_tracked_item_count: c.itemCount,
      total_acquisition_capital: null,
      realized_acquisition_capital: null,
      total_realized_net_profit: null,
      median_net_profit: c.profit,
      median_roi: c.roi,
      dom_sample_size: c.domSample,
      median_days_on_market: c.dom,
      holding_sample_size: c.realizedItemCount,
      median_holding_days: c.dom,
      confidence: c.confidence,
    })),
  };

  if (options?.includeByPurposeDecoy) {
    // Deliberately worse, tiny-sample decoy under a DIFFERENT key
    // (performance_by_deal_in_channel_by_purpose) — the rule must never
    // read this key.
    dealInChannelPerformance.performance_by_deal_in_channel_by_purpose = channels.map((c) => ({
      current_purpose_id: 1,
      current_purpose_name: 'Business',
      deal_in_channel_id: c.channelId,
      deal_in_channel_name: c.channelName,
      deal_in_item_count: 1,
      deal_in_distinct_deal_count: 1,
      deal_in_realized_item_count: 0,
      deal_in_realization_rate_percent: 0,
      median_net_profit: -99999,
      median_roi: -99999,
      dom_sample_size: 0,
      median_days_on_market: 9999,
      confidence: 'insufficient',
    }));
  }

  return { deal_in_channel_performance: dealInChannelPerformance };
}

function dealInChannelEvalFor(
  channelId: number | null,
  evaluations: ReturnType<typeof evaluateStrongDealInChannel>['candidateEvaluations'],
) {
  return evaluations.find((e) => e.channel_id === channelId);
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
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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
    check('a v2.11 snapshot with no insights key still validates', isValidAnalyticsSnapshot(baseSnapshot));
    const withInsights = {
      ...baseSnapshot,
      insights: selectFindings({
        targetUserAcquisitionEvidence: baseSnapshot.target_user_acquisition_evidence,
        targetUserInventorySegmentationEvidence: baseSnapshot.target_user_inventory_segmentation_evidence,
        targetUserDealChannelEvidence: baseSnapshot.target_user_deal_channel_evidence,
        targetUserListingChannelEvidence: baseSnapshot.target_user_listing_channel_evidence,
        targetUserOpenInventoryEvidence: baseSnapshot.target_user_open_inventory_evidence,
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
      targetUserListingChannelEvidence: {},
      targetUserOpenInventoryEvidence: {},
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
      targetUserListingChannelEvidence: {},
      targetUserOpenInventoryEvidence: {},
    });
    const viaOrchestrator = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);

    check('insights_engine_version is 1.7', insights.insights_engine_version === '1.7', insights.insights_engine_version);
    check('findings_selector_version is 1.7', insights.findings_selector_version === '1.7', insights.findings_selector_version);
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
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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
    check('a stored v2.11 snapshot carrying an Insights Engine v1.0-shaped insights section still validates', isValidAnalyticsSnapshot(fullSnapshot));
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
      targetUserListingChannelEvidence: {},
      targetUserOpenInventoryEvidence: {},
    });

    check('all three rule families are present in one insights payload', insights.selected_findings.length === 3, insights.selected_findings.map((f) => f.finding_code));
    const broadFinding = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE) as SelectedFindingForTest | undefined;
    const categoryFinding = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE) as SelectedFindingForTest | undefined;
    const methodFinding = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE) as AcquisitionMethodPerformanceProfileFinding | undefined;

    check('the broad finding is numerically unchanged (median_net_profit 750)', broadFinding?.metrics.median_net_profit === 750, broadFinding?.metrics);
    check('the category finding is numerically unchanged (Guitars x $2,000-2,999)', categoryFinding?.segment.category_name === 'Guitars' && categoryFinding?.segment.acquisition_value_band_label === '$2,000-2,999', categoryFinding?.segment);
    check('the acquisition-method finding is also present (PURCHASE_ECONOMICS_TRADE_SPEED)', methodFinding?.profile_code === 'PURCHASE_ECONOMICS_TRADE_SPEED', methodFinding);
    check('insights_engine_version is 1.7', insights.insights_engine_version === '1.7', insights.insights_engine_version);
    check('findings_selector_version is 1.7', insights.findings_selector_version === '1.7', insights.findings_selector_version);
  }

  // ── M20: old Insights Engine 1.0 and 1.1 snapshots remain readable ──────
  console.log('\n[M20 — old Insights Engine v1.0 and v1.1 snapshots remain readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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

    check('a stored v2.11 snapshot carrying an Insights Engine v1.0-shaped insights section still validates', isValidAnalyticsSnapshot(v10Snapshot));
    check('a stored v2.11 snapshot carrying an Insights Engine v1.1-shaped insights section (no acquisition-method finding) still validates', isValidAnalyticsSnapshot(v11Snapshot));
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
      targetUserListingChannelEvidence: {},
      targetUserOpenInventoryEvidence: {},
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
    check('insights_engine_version is 1.7', insights.insights_engine_version === '1.7', insights.insights_engine_version);
    check('findings_selector_version is 1.7', insights.findings_selector_version === '1.7', insights.findings_selector_version);
  }

  // ── J21: old Insights Engine snapshots (1.0, 1.1, 1.2) remain readable ──
  console.log('\n[J21 — old Insights Engine v1.0/v1.1/v1.2 snapshots (no channel-journey finding) remain readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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

    check('a stored v2.11 snapshot carrying an Insights Engine v1.2-shaped insights section still validates', isValidAnalyticsSnapshot(v12Snapshot));
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

  // ═══════════════════════════════════════════════════════════════════════
  // STRONG_DEAL_OUT_CHANNEL (Insights Engine v1.4)
  // ═══════════════════════════════════════════════════════════════════════

  // Reused across several fixtures below — representative numbers close to
  // the task's acceptance expectation (Marketplace wins; Kijiji has similar
  // profit but slower DOM; Reverb has competitive ROI but materially lower
  // profit — both disqualified by their own weakness, not selected).
  const DEAL_OUT_CHANNEL_FIXTURES: DealOutChannelFixture[] = [
    { channelId: 1, channelName: 'Marketplace', itemCount: 20, distinctDealCount: 18, domSample: 20, profit: 700, roi: 33, dom: 14, confidence: 'stronger' },
    { channelId: 2, channelName: 'Kijiji', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 690, roi: 30, dom: 25, confidence: 'stronger' },
    { channelId: 3, channelName: 'Reverb', itemCount: 8, distinctDealCount: 6, domSample: 8, profit: 300, roi: 32, dom: 16, confidence: 'moderate' },
  ];

  // ── D1: representative evidence selects Marketplace ─────────────────────
  console.log('\n[D1 — acceptance check: Marketplace can be selected]');
  {
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES));
    check('result status is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('winner channel is Marketplace', result.segment.channel_name === 'Marketplace', result.segment);
      check('metrics.item_count is 20', result.metrics.item_count === 20, result.metrics);
      check('metrics.median_net_profit is 700', result.metrics.median_net_profit === 700, result.metrics);
      check('metrics.median_roi is 33', result.metrics.median_roi === 33, result.metrics);
      check('metrics.median_days_on_market is 14', result.metrics.median_days_on_market === 14, result.metrics);
      check('confidence is stronger', result.confidence === 'stronger', result.confidence);
      check('Kijiji (similar profit, slower DOM) does not appear as a qualifying runner-up here', result.runner_up === undefined, result.runner_up);
    }
  }

  // ── D2: the winner is not hardcoded ──────────────────────────────────────
  console.log('\n[D2 — winner is not hardcoded]');
  {
    const channels: DealOutChannelFixture[] = [
      { channelId: 40, channelName: 'P', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 30, confidence: 'stronger' },
      { channelId: 41, channelName: 'Q', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 320, roi: 18, dom: 28, confidence: 'stronger' },
      { channelId: 42, channelName: 'R', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 900, roi: 50, dom: 8, confidence: 'stronger' },
      { channelId: 43, channelName: 'S', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 310, roi: 16, dom: 29, confidence: 'stronger' },
    ];
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    check(
      'a different fixture selects R, not Marketplace',
      result.status === 'selected' && result.segment.channel_name === 'R',
      result,
    );
  }

  // ── D3/D4/D5: correct pooled evidence used; shared/purpose ignored;
  // Hybrid/Personal remain included ────────────────────────────────────────
  console.log('\n[D3/D4/D5 — pooled all-purpose evidence used; shared/_by_purpose evidence ignored]');
  {
    const evidence = makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES, { includeByPurposeDecoy: true });
    const { result } = evaluateStrongDealOutChannel(evidence);
    check(
      'the Business-only-shaped _by_purpose decoy is ignored — result is unaffected',
      result.status === 'selected' && result.segment.channel_name === 'Marketplace',
      result,
    );
    if (result.status === 'selected') {
      check('pooled metrics (n=20, not the decoy\'s n=1) drive the result', result.metrics.item_count === 20, result.metrics);
    }
    const selectFindingsSource = fs.readFileSync(
      path.join(__dirname, '../src/lib/analytics/insights/selectFindings.ts'),
      'utf8',
    );
    check(
      'selectFindings.ts wires target_user_deal_channel_evidence into the deal-out-channel rule',
      selectFindingsSource.includes('evaluateStrongDealOutChannel(input.targetUserDealChannelEvidence)'),
    );
  }

  // ── D6: null and unknown channels are excluded ───────────────────────────
  console.log('\n[D6 — null and unknown channels are excluded]');
  {
    const channels: DealOutChannelFixture[] = [
      ...DEAL_OUT_CHANNEL_FIXTURES,
      { channelId: null, channelName: null, itemCount: 25, distinctDealCount: 20, domSample: 25, profit: 2000, roi: 80, dom: 3, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    const unknownRow = dealOutChannelEvalFor(null, candidateEvaluations);
    check('the null-channel row is ineligible', unknownRow?.eligible === false, unknownRow);
    check('the null-channel row reason is CHANNEL_IDENTITY_MISSING', !!unknownRow?.eligibility_failure_reasons.includes('CHANNEL_IDENTITY_MISSING'), unknownRow);
    check(
      'the null-channel row is never selected despite its attractive (fabricated) metrics',
      !(result.status === 'selected' && result.metrics.median_net_profit === 2000),
      result,
    );
  }

  // ── D7: distinct deal count is required independently from item count ───
  console.log('\n[D7 — distinct deal count is required independently from item count]');
  {
    const channels: DealOutChannelFixture[] = [
      ...DEAL_OUT_CHANNEL_FIXTURES,
      { channelId: 5, channelName: 'BulkLot', itemCount: 20, distinctDealCount: 2, domSample: 20, profit: 1000, roi: 50, dom: 5, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    const bulkLot = dealOutChannelEvalFor(5, candidateEvaluations);
    check('a 20-item channel backed by only 2 distinct exit deals is ineligible', bulkLot?.eligible === false, bulkLot);
    check('the reason is DISTINCT_DEAL_COUNT_BELOW_MINIMUM', !!bulkLot?.eligibility_failure_reasons.includes('DISTINCT_DEAL_COUNT_BELOW_MINIMUM'), bulkLot);
  }

  // ── D8: fewer than three eligible channels returns no finding ────────────
  console.log('\n[D8 — fewer than three eligible channels returns no finding]');
  {
    const channels: DealOutChannelFixture[] = [
      { channelId: 1, channelName: 'Marketplace', itemCount: 20, distinctDealCount: 18, domSample: 20, profit: 700, roi: 33, dom: 14, confidence: 'stronger' },
      { channelId: 2, channelName: 'Kijiji', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 690, roi: 30, dom: 25, confidence: 'stronger' },
    ];
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    check(
      'result is no_eligible_finding with INSUFFICIENT_ELIGIBLE_DEAL_OUT_CHANNELS',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_DEAL_OUT_CHANNELS'),
      result,
    );
  }

  // ── D9: ineligible channels are not marked weak ──────────────────────────
  console.log('\n[D9 — ineligible channels are not marked weak]');
  {
    const channels: DealOutChannelFixture[] = [
      ...DEAL_OUT_CHANNEL_FIXTURES,
      { channelId: 6, channelName: 'Thin', itemCount: 3, distinctDealCount: 3, domSample: 3, profit: 500, roi: 25, dom: 15, confidence: 'low' },
    ];
    const { candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    const thin = dealOutChannelEvalFor(6, candidateEvaluations);
    check('the thin channel is ineligible', thin?.eligible === false, thin);
    check('the thin channel reason is ITEM_COUNT_BELOW_MINIMUM', !!thin?.eligibility_failure_reasons.includes('ITEM_COUNT_BELOW_MINIMUM'), thin);
    check('the thin channel carries no improvement or weakness trigger (never evaluated)', thin?.material_improvement_triggers.length === 0 && thin?.material_weakness_triggers.length === 0, thin);
  }

  // ── D10: highest ROI alone does not win ──────────────────────────────────
  console.log('\n[D10 — highest ROI alone does not win]');
  {
    const channels: DealOutChannelFixture[] = [
      { channelId: 50, channelName: 'W', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 280, roi: 17, dom: 27, confidence: 'stronger' },
      { channelId: 51, channelName: 'X-high-roi', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 200, roi: 80, dom: 40, confidence: 'stronger' },
      { channelId: 52, channelName: 'Y-balanced', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 500, roi: 22, dom: 15, confidence: 'stronger' },
      { channelId: 53, channelName: 'Z', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 300, roi: 18, dom: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    check('the highest-ROI channel does not qualify', dealOutChannelEvalFor(51, candidateEvaluations)?.qualifies === false);
    check('the balanced channel is selected instead', result.status === 'selected' && result.segment.channel_name === 'Y-balanced', result);
  }

  // ── D11: highest profit alone does not win ───────────────────────────────
  console.log('\n[D11 — highest profit alone does not win]');
  {
    const channels: DealOutChannelFixture[] = [
      { channelId: 54, channelName: 'W2', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 280, roi: 17, dom: 27, confidence: 'stronger' },
      { channelId: 55, channelName: 'X2-high-profit', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 2000, roi: 15, dom: 45, confidence: 'stronger' },
      { channelId: 56, channelName: 'Y2-balanced', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 500, roi: 30, dom: 12, confidence: 'stronger' },
      { channelId: 57, channelName: 'Z2', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 300, roi: 18, dom: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    check('the highest-profit channel does not qualify', dealOutChannelEvalFor(55, candidateEvaluations)?.qualifies === false);
    check('the balanced channel is selected instead', result.status === 'selected' && result.segment.channel_name === 'Y2-balanced', result);
  }

  // ── D12: material DOM weakness prevents qualification ────────────────────
  console.log('\n[D12 — material DOM weakness prevents qualification]');
  {
    const channels: DealOutChannelFixture[] = [
      { channelId: 58, channelName: 'G1', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 500, roi: 20, dom: 20, confidence: 'stronger' },
      { channelId: 59, channelName: 'G2-profitable-slow', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 900, roi: 30, dom: 60, confidence: 'stronger' },
      { channelId: 60, channelName: 'G3', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 480, roi: 18, dom: 18, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    const g2 = dealOutChannelEvalFor(59, candidateEvaluations);
    check('the profitable channel has at least 2 improvement triggers', (g2?.material_improvement_triggers.length ?? 0) >= 2, g2);
    check('the profitable channel also carries a DOM weakness trigger', !!g2?.material_weakness_triggers.includes('DOM_WORSE_THAN_PEER_BASELINE'), g2);
    check('the profitable channel does not qualify', g2?.qualifies === false, g2);
  }

  // ── D13: fast but materially unprofitable channel does not qualify ──────
  console.log('\n[D13 — fast but materially unprofitable channel does not qualify]');
  {
    const channels: DealOutChannelFixture[] = [
      { channelId: 61, channelName: 'F1', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 500, roi: 20, dom: 25, confidence: 'stronger' },
      { channelId: 62, channelName: 'F2-fast-poor-profit', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 100, roi: 35, dom: 8, confidence: 'stronger' },
      { channelId: 63, channelName: 'F3', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 520, roi: 19, dom: 27, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    const f2 = dealOutChannelEvalFor(62, candidateEvaluations);
    check('the fast channel has at least 2 improvement triggers', (f2?.material_improvement_triggers.length ?? 0) >= 2, f2);
    check('the fast channel also carries a profit weakness trigger', !!f2?.material_weakness_triggers.includes('PROFIT_BELOW_PEER_BASELINE'), f2);
    check('the fast channel does not qualify', f2?.qualifies === false, f2);
  }

  // ── D14: baseline excludes the candidate ─────────────────────────────────
  console.log('\n[D14 — baseline excludes the candidate itself]');
  {
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES));
    check(
      'baseline.median_net_profit is the median of Kijiji+Reverb only (495), not pulled in by Marketplace\'s own 700',
      result.status === 'selected' && result.baseline.median_net_profit === 495,
      result.status === 'selected' ? result.baseline : result,
    );
  }

  // ── D15: baseline uses only eligible channels ────────────────────────────
  console.log('\n[D15 — baseline uses only eligible channels]');
  {
    const channels: DealOutChannelFixture[] = [
      ...DEAL_OUT_CHANNEL_FIXTURES,
      { channelId: 7, channelName: 'Outlier', itemCount: 3, distinctDealCount: 3, domSample: 3, profit: 999999, roi: 999, dom: 1, confidence: 'low' },
    ];
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(channels));
    check(
      'an ineligible outlier (item_count 3, absurd metrics) never pollutes the baseline — still 495',
      result.status === 'selected' && result.baseline.median_net_profit === 495,
      result.status === 'selected' ? result.baseline : result,
    );
  }

  // ── D16: tie-breakers are deterministic ──────────────────────────────────
  console.log('\n[D16 — deterministic tie-breakers]');
  {
    // 16a: identical metrics, differing confidence — higher confidence wins.
    const confidenceChannels: DealOutChannelFixture[] = [
      { channelId: 70, channelName: 'T1-stronger', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'stronger' },
      { channelId: 71, channelName: 'T2-low', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'low' },
      { channelId: 72, channelName: 'T3-filler', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: confResult } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(confidenceChannels));
    check(
      'equal trigger counts break on confidence — T1 (stronger) beats T2 (low)',
      confResult.status === 'selected' && confResult.segment.channel_name === 'T1-stronger',
      confResult,
    );
    check(
      'the loser of the confidence tie-break appears as runner-up',
      confResult.status === 'selected' && confResult.runner_up?.segment.channel_name === 'T2-low',
      confResult,
    );

    // 16b: fully tied candidates (including confidence) — falls through to
    // ascending channel id.
    const idTieChannels: DealOutChannelFixture[] = [
      { channelId: 80, channelName: 'U1-lower-id', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { channelId: 85, channelName: 'U2-higher-id', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { channelId: 82, channelName: 'U3-filler', itemCount: 10, distinctDealCount: 8, domSample: 10, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: idResult } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(idTieChannels));
    check(
      'fully tied candidates break on ascending channel id — U1 (80) beats U2 (85)',
      idResult.status === 'selected' && idResult.segment.channel_id === 80,
      idResult,
    );
  }

  // ── D17: Deal Out Channel is not confused with listing platform ─────────
  console.log('\n[D17 — Deal Out Channel is not confused with listing platform]');
  {
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES));
    check('result is present', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('headline does not describe the channel as a listing platform', !result.headline.toLowerCase().includes('listing platform'), result.headline);
      check('summary does not describe the channel as a listing platform', !result.summary.toLowerCase().includes('listing platform'), result.summary);
      check('limitations include DEAL_CHANNEL_IS_CONTACT_SOURCE_NOT_PAYMENT_LOCATION', result.limitations.includes('DEAL_CHANNEL_IS_CONTACT_SOURCE_NOT_PAYMENT_LOCATION'), result.limitations);
      check('evidence_refs point at deal_out_channel_performance, not listing_channel_evidence', result.evidence_refs.every((ref) => !ref.includes('listing_channel')), result.evidence_refs);
    }
  }

  // ── D18: existing four rules remain unchanged ────────────────────────────
  console.log('\n[D18 — existing four rules (broad, category, acquisition-method, channel-journey) remain unchanged]');
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
    const journeyEvidence = makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES) as Record<string, unknown>;
    const dealOutEvidence = makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES) as Record<string, unknown>;
    const combinedDealChannelEvidence = {
      ...journeyEvidence,
      ...dealOutEvidence,
    };

    const { result: directBroad } = evaluateStrongBalancedAcquisitionBand(combinedAcquisitionEvidence);
    const { result: directCategory } = evaluateStrongCategoryAcquisitionBand(categoryEvidence);
    const { result: directMethod } = evaluateAcquisitionMethodPerformanceProfile(combinedAcquisitionEvidence);
    const { result: directJourney } = evaluateStrongDealInToDealOutJourney(combinedDealChannelEvidence);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: combinedAcquisitionEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: combinedDealChannelEvidence,
      targetUserListingChannelEvidence: {},
      targetUserOpenInventoryEvidence: {},
    });

    check('all five rule families are present in one insights payload', insights.selected_findings.length === 5, insights.selected_findings.map((f) => f.finding_code));
    const viaOrchestratorBroad = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);
    const viaOrchestratorCategory = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE);
    const viaOrchestratorMethod = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE);
    const viaOrchestratorJourney = insights.selected_findings.find((f) => f.finding_code === JOURNEY_FINDING_CODE);
    const viaOrchestratorDealOut = insights.selected_findings.find((f) => f.finding_code === DEAL_OUT_CHANNEL_FINDING_CODE);

    const categoryWithoutRelationship = viaOrchestratorCategory
      ? { ...(viaOrchestratorCategory as SelectedFindingForTest), relationship: undefined, summary: (directCategory as SelectedFindingForTest).summary }
      : viaOrchestratorCategory;

    check('the broad finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorBroad) === JSON.stringify(directBroad), { viaOrchestratorBroad, directBroad });
    check('the category finding (minus orchestrator relationship linking) is byte-identical to calling the rule directly', JSON.stringify(categoryWithoutRelationship) === JSON.stringify(directCategory), { categoryWithoutRelationship, directCategory });
    check('the acquisition-method finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorMethod) === JSON.stringify(directMethod), { viaOrchestratorMethod, directMethod });
    check('the channel-journey finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorJourney) === JSON.stringify(directJourney), { viaOrchestratorJourney, directJourney });
    check('the deal-out-channel finding is also present (Marketplace)', (viaOrchestratorDealOut as SelectedFindingForTest | undefined)?.segment.channel_name === 'Marketplace', viaOrchestratorDealOut);
    check('insights_engine_version is 1.7', insights.insights_engine_version === '1.7', insights.insights_engine_version);
    check('findings_selector_version is 1.7', insights.findings_selector_version === '1.7', insights.findings_selector_version);
  }

  // ── D19: old Insights Engine snapshots remain readable ───────────────────
  console.log('\n[D19 — old Insights Engine v1.3-shaped snapshot (channel-journey finding, no deal-out-channel finding) remains readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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

    const v13ShapedInsights = {
      insights_engine_version: '1.3',
      findings_selector_version: '1.3',
      source_analytics_version: '2.10',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: JOURNEY_FINDING_CODE,
          family: 'channel_journey_performance',
          direction: 'strength',
          status: 'selected',
          headline: 'Marketplace → Marketplace is a strong, balanced channel journey',
          summary: 'placeholder v1.3-shaped summary',
          segment: { deal_in_channel_id: 1, deal_in_channel_name: 'Marketplace', deal_out_channel_id: 1, deal_out_channel_name: 'Marketplace', same_channel: true },
          metrics: { item_count: 16, distinct_deal_count: 16, distinct_acquisition_deal_count: 16, distinct_exit_deal_count: 16, median_net_profit: 625, median_roi: 28, median_days_on_market: 11, dom_sample_size: 16 },
          baseline: { type: 'peer_channel_journey_median_baseline', median_net_profit: 437.5, median_roi: 12.5, median_days_on_market: 27, realization_rate_percent: null },
          triggered_rules: ['PROFIT_ABOVE_PEER_BASELINE', 'ROI_ABOVE_PEER_BASELINE', 'DOM_FASTER_THAN_PEER_BASELINE', 'NO_MATERIAL_WEAKNESS'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_JOURNEY_METRICS'],
          evidence_refs: ['target_user_deal_channel_evidence.channel_journey.deal_in_to_deal_out_matrix'],
          // No deal-out-channel finding at all — this is the v1.3 shape.
        },
      ],
      rule_evaluations: [],
    };
    const v13Snapshot = { ...baseSnapshot, insights: v13ShapedInsights };

    check('a stored v2.11 snapshot carrying an Insights Engine v1.3-shaped insights section still validates', isValidAnalyticsSnapshot(v13Snapshot));
  }

  // ── D20: findings contain no user IDs, item IDs, item names, models,
  // notes, emails, or counterparty information ─────────────────────────────
  console.log('\n[D20 — deal-out-channel findings carry no user IDs, item IDs, names, models, notes, emails, or counterparty information]');
  {
    const { result } = evaluateStrongDealOutChannel(makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES));
    if (result.status !== 'selected') {
      check('D20 setup produced a selected finding', false, result);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'baseline', 'triggered_rules', 'confidence', 'limitations', 'evidence_refs', 'runner_up'],
        segment: ['channel_id', 'channel_name'],
        metrics: ['item_count', 'distinct_deal_count', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size'],
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

      check('no unexpected keys (no item/user identity or counterparty fields) appear anywhere in the deal-out-channel finding', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(result);
      const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i, /"counterparty/i, /"contact/i, /"deal_id"/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('serialized deal-out-channel finding contains no PII- or counterparty-shaped field names', matched.length === 0, matched);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STRONG_DEAL_IN_CHANNEL (Insights Engine v1.5)
  // ═══════════════════════════════════════════════════════════════════════

  // Reused across several fixtures below — representative numbers close to
  // the task's acceptance framing (Marketplace can qualify on profit + DOM;
  // Kijiji has similar profit but slower DOM — disqualified; Reverb has
  // competitive ROI but materially lower profit — disqualified).
  const DEAL_IN_CHANNEL_FIXTURES: DealInChannelFixture[] = [
    { channelId: 1, channelName: 'Marketplace', itemCount: 20, distinctDealCount: 18, realizedItemCount: 16, domSample: 16, realizationRate: 80, profit: 700, roi: 33, dom: 14, confidence: 'stronger' },
    { channelId: 2, channelName: 'Kijiji', itemCount: 12, distinctDealCount: 8, realizedItemCount: 10, domSample: 10, realizationRate: 83, profit: 690, roi: 30, dom: 25, confidence: 'stronger' },
    { channelId: 3, channelName: 'Reverb', itemCount: 10, distinctDealCount: 6, realizedItemCount: 8, domSample: 8, realizationRate: 80, profit: 300, roi: 32, dom: 16, confidence: 'stronger' },
  ];

  // ── N1: representative evidence can select Marketplace ──────────────────
  console.log('\n[N1 — acceptance check: Marketplace can be selected]');
  {
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES));
    check('result status is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('winner channel is Marketplace', result.segment.channel_name === 'Marketplace', result.segment);
      check('metrics.item_count is 20', result.metrics.item_count === 20, result.metrics);
      check('metrics.distinct_deal_count is 18', result.metrics.distinct_deal_count === 18, result.metrics);
      check('metrics.realized_item_count is 16', result.metrics.realized_item_count === 16, result.metrics);
      check('metrics.realization_rate_percent is 80', result.metrics.realization_rate_percent === 80, result.metrics);
      check('metrics.median_net_profit is 700', result.metrics.median_net_profit === 700, result.metrics);
      check('metrics.median_roi is 33', result.metrics.median_roi === 33, result.metrics);
      check('metrics.median_days_on_market is 14', result.metrics.median_days_on_market === 14, result.metrics);
      check('confidence is stronger', result.confidence === 'stronger', result.confidence);
    }
  }

  // ── N2: the winner is not hardcoded ──────────────────────────────────────
  console.log('\n[N2 — winner is not hardcoded]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 40, channelName: 'P', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 70, profit: 300, roi: 15, dom: 30, confidence: 'stronger' },
      { channelId: 41, channelName: 'Q', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 70, profit: 320, roi: 18, dom: 28, confidence: 'stronger' },
      { channelId: 42, channelName: 'R', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 70, profit: 900, roi: 50, dom: 8, confidence: 'stronger' },
      { channelId: 43, channelName: 'S', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 70, profit: 310, roi: 16, dom: 29, confidence: 'stronger' },
    ];
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    check(
      'a different fixture selects R, not Marketplace',
      result.status === 'selected' && result.segment.channel_name === 'R',
      result,
    );
  }

  // ── N3/N4/N5: correct pooled evidence used; shared/purpose ignored;
  // Hybrid/Personal remain included ────────────────────────────────────────
  console.log('\n[N3/N4/N5 — pooled all-purpose evidence used; shared/_by_purpose evidence ignored]');
  {
    const evidence = makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES, { includeByPurposeDecoy: true });
    const { result } = evaluateStrongDealInChannel(evidence);
    check(
      'the Business-only-shaped _by_purpose decoy is ignored — result is unaffected',
      result.status === 'selected' && result.segment.channel_name === 'Marketplace',
      result,
    );
    if (result.status === 'selected') {
      check('pooled metrics (n=20, not the decoy\'s n=1) drive the result', result.metrics.item_count === 20, result.metrics);
    }
    const selectFindingsSource = fs.readFileSync(
      path.join(__dirname, '../src/lib/analytics/insights/selectFindings.ts'),
      'utf8',
    );
    check(
      'selectFindings.ts wires target_user_deal_channel_evidence into the deal-in-channel rule',
      selectFindingsSource.includes('evaluateStrongDealInChannel(input.targetUserDealChannelEvidence)'),
    );
  }

  // ── N6: null and unknown channels are excluded ───────────────────────────
  console.log('\n[N6 — null and unknown channels are excluded]');
  {
    const channels: DealInChannelFixture[] = [
      ...DEAL_IN_CHANNEL_FIXTURES,
      { channelId: null, channelName: null, itemCount: 25, distinctDealCount: 20, realizedItemCount: 20, domSample: 20, realizationRate: 90, profit: 2000, roi: 80, dom: 3, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const unknownRow = dealInChannelEvalFor(null, candidateEvaluations);
    check('the null-channel row is ineligible', unknownRow?.eligible === false, unknownRow);
    check('the null-channel row reason is CHANNEL_IDENTITY_MISSING', !!unknownRow?.eligibility_failure_reasons.includes('CHANNEL_IDENTITY_MISSING'), unknownRow);
    check(
      'the null-channel row is never selected despite its attractive (fabricated) metrics',
      !(result.status === 'selected' && result.metrics.median_net_profit === 2000),
      result,
    );
  }

  // ── N7: item count and distinct acquisition-deal count are checked
  // independently ─────────────────────────────────────────────────────────
  console.log('\n[N7 — item count and distinct acquisition-deal count are checked independently]');
  {
    const channels: DealInChannelFixture[] = [
      ...DEAL_IN_CHANNEL_FIXTURES,
      { channelId: 5, channelName: 'BulkLot', itemCount: 20, distinctDealCount: 2, realizedItemCount: 15, domSample: 15, realizationRate: 75, profit: 1000, roi: 50, dom: 5, confidence: 'stronger' },
      { channelId: 8, channelName: 'ThinItems', itemCount: 5, distinctDealCount: 10, realizedItemCount: 5, domSample: 5, realizationRate: 75, profit: 1000, roi: 50, dom: 5, confidence: 'moderate' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const bulkLot = dealInChannelEvalFor(5, candidateEvaluations);
    const thinItems = dealInChannelEvalFor(8, candidateEvaluations);
    check('a 20-item channel backed by only 2 distinct acquisition deals is ineligible', bulkLot?.eligible === false, bulkLot);
    check('the BulkLot reason is DISTINCT_DEAL_COUNT_BELOW_MINIMUM', !!bulkLot?.eligibility_failure_reasons.includes('DISTINCT_DEAL_COUNT_BELOW_MINIMUM'), bulkLot);
    check('a channel with only 5 acquired items (below the 8 minimum) is ineligible despite 10 distinct deals', thinItems?.eligible === false, thinItems);
    check('the ThinItems reason is ITEM_COUNT_BELOW_MINIMUM', !!thinItems?.eligibility_failure_reasons.includes('ITEM_COUNT_BELOW_MINIMUM'), thinItems);
  }

  // ── N8: realized-item and DOM samples are required ──────────────────────
  console.log('\n[N8 — realized-item and DOM samples are required]');
  {
    const channels: DealInChannelFixture[] = [
      ...DEAL_IN_CHANNEL_FIXTURES,
      { channelId: 9, channelName: 'LowRealized', itemCount: 20, distinctDealCount: 10, realizedItemCount: 3, domSample: 3, realizationRate: 15, profit: 1000, roi: 50, dom: 5, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const lowRealized = dealInChannelEvalFor(9, candidateEvaluations);
    check('a channel with only 3 realized items is ineligible', lowRealized?.eligible === false, lowRealized);
    check('the reason includes REALIZED_ITEM_COUNT_BELOW_MINIMUM', !!lowRealized?.eligibility_failure_reasons.includes('REALIZED_ITEM_COUNT_BELOW_MINIMUM'), lowRealized);
    check('the reason also includes DOM_SAMPLE_SIZE_BELOW_MINIMUM', !!lowRealized?.eligibility_failure_reasons.includes('DOM_SAMPLE_SIZE_BELOW_MINIMUM'), lowRealized);
  }

  // ── N9: fewer than three eligible channels returns no finding ────────────
  console.log('\n[N9 — fewer than three eligible channels returns no finding]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 1, channelName: 'Marketplace', itemCount: 20, distinctDealCount: 18, realizedItemCount: 16, domSample: 16, realizationRate: 80, profit: 700, roi: 33, dom: 14, confidence: 'stronger' },
      { channelId: 2, channelName: 'Kijiji', itemCount: 12, distinctDealCount: 8, realizedItemCount: 10, domSample: 10, realizationRate: 83, profit: 690, roi: 30, dom: 25, confidence: 'stronger' },
    ];
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    check(
      'result is no_eligible_finding with INSUFFICIENT_ELIGIBLE_DEAL_IN_CHANNELS',
      result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_DEAL_IN_CHANNELS'),
      result,
    );
  }

  // ── N10: ineligible channels are not marked weak ─────────────────────────
  console.log('\n[N10 — ineligible channels are not marked weak]');
  {
    const channels: DealInChannelFixture[] = [
      ...DEAL_IN_CHANNEL_FIXTURES,
      { channelId: 6, channelName: 'Thin', itemCount: 3, distinctDealCount: 3, realizedItemCount: 3, domSample: 3, realizationRate: 50, profit: 500, roi: 25, dom: 15, confidence: 'low' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const thin = dealInChannelEvalFor(6, candidateEvaluations);
    check('the thin channel is ineligible', thin?.eligible === false, thin);
    check('the thin channel reason is ITEM_COUNT_BELOW_MINIMUM', !!thin?.eligibility_failure_reasons.includes('ITEM_COUNT_BELOW_MINIMUM'), thin);
    check('the thin channel carries no improvement or weakness trigger (never evaluated)', thin?.material_improvement_triggers.length === 0 && thin?.material_weakness_triggers.length === 0, thin);
  }

  // ── N11: highest ROI alone does not win ──────────────────────────────────
  console.log('\n[N11 — highest ROI alone does not win]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 50, channelName: 'W', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 280, roi: 17, dom: 27, confidence: 'stronger' },
      { channelId: 51, channelName: 'X-high-roi', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 200, roi: 80, dom: 40, confidence: 'stronger' },
      { channelId: 52, channelName: 'Y-balanced', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 500, roi: 22, dom: 15, confidence: 'stronger' },
      { channelId: 53, channelName: 'Z', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 300, roi: 18, dom: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    check('the highest-ROI channel does not qualify', dealInChannelEvalFor(51, candidateEvaluations)?.qualifies === false);
    check('the balanced channel is selected instead', result.status === 'selected' && result.segment.channel_name === 'Y-balanced', result);
  }

  // ── N12: highest profit alone does not win ───────────────────────────────
  console.log('\n[N12 — highest profit alone does not win]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 54, channelName: 'W2', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 280, roi: 17, dom: 27, confidence: 'stronger' },
      { channelId: 55, channelName: 'X2-high-profit', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 2000, roi: 15, dom: 45, confidence: 'stronger' },
      { channelId: 56, channelName: 'Y2-balanced', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 500, roi: 30, dom: 12, confidence: 'stronger' },
      { channelId: 57, channelName: 'Z2', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 300, roi: 18, dom: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    check('the highest-profit channel does not qualify', dealInChannelEvalFor(55, candidateEvaluations)?.qualifies === false);
    check('the balanced channel is selected instead', result.status === 'selected' && result.segment.channel_name === 'Y2-balanced', result);
  }

  // ── N13: material DOM weakness prevents qualification ────────────────────
  console.log('\n[N13 — material DOM weakness prevents qualification]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 58, channelName: 'G1', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 500, roi: 20, dom: 20, confidence: 'stronger' },
      { channelId: 59, channelName: 'G2-profitable-slow', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 900, roi: 30, dom: 60, confidence: 'stronger' },
      { channelId: 60, channelName: 'G3', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 480, roi: 18, dom: 18, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const g2 = dealInChannelEvalFor(59, candidateEvaluations);
    check('the profitable channel has at least 2 improvement triggers', (g2?.material_improvement_triggers.length ?? 0) >= 2, g2);
    check('the profitable channel also carries a DOM weakness trigger', !!g2?.material_weakness_triggers.includes('DOM_WORSE_THAN_PEER_BASELINE'), g2);
    check('the profitable channel does not qualify', g2?.qualifies === false, g2);
  }

  // ── N14: material realization weakness prevents qualification ───────────
  console.log('\n[N14 — material realization weakness prevents qualification]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 64, channelName: 'H1', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 70, profit: 500, roi: 20, dom: 20, confidence: 'stronger' },
      { channelId: 65, channelName: 'H2-profitable-low-realization', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 40, profit: 900, roi: 35, dom: 18, confidence: 'stronger' },
      { channelId: 66, channelName: 'H3', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 68, profit: 480, roi: 18, dom: 22, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const h2 = dealInChannelEvalFor(65, candidateEvaluations);
    check('the profitable channel has at least 2 improvement triggers (profit, ROI)', (h2?.material_improvement_triggers.length ?? 0) >= 2, h2);
    check('the profitable channel also carries a realization weakness trigger', !!h2?.material_weakness_triggers.includes('REALIZATION_BELOW_PEER_BASELINE'), h2);
    check('the profitable channel does not qualify', h2?.qualifies === false, h2);
  }

  // ── N15: a fast but materially unprofitable channel does not qualify ────
  console.log('\n[N15 — a fast but materially unprofitable channel does not qualify]');
  {
    const channels: DealInChannelFixture[] = [
      { channelId: 61, channelName: 'F1', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 500, roi: 20, dom: 25, confidence: 'stronger' },
      { channelId: 62, channelName: 'F2-fast-poor-profit', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 100, roi: 35, dom: 8, confidence: 'stronger' },
      { channelId: 63, channelName: 'F3', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 520, roi: 19, dom: 27, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    const f2 = dealInChannelEvalFor(62, candidateEvaluations);
    check('the fast channel has at least 2 improvement triggers', (f2?.material_improvement_triggers.length ?? 0) >= 2, f2);
    check('the fast channel also carries a profit weakness trigger', !!f2?.material_weakness_triggers.includes('PROFIT_BELOW_PEER_BASELINE'), f2);
    check('the fast channel does not qualify', f2?.qualifies === false, f2);
  }

  // ── N16: baseline excludes the candidate ─────────────────────────────────
  console.log('\n[N16 — baseline excludes the candidate itself]');
  {
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES));
    check(
      'baseline.median_net_profit is the median of Kijiji+Reverb only (495), not pulled in by Marketplace\'s own 700',
      result.status === 'selected' && result.baseline.median_net_profit === 495,
      result.status === 'selected' ? result.baseline : result,
    );
    check(
      'baseline.realization_rate_percent is the median of Kijiji+Reverb only (81.5), not pulled in by Marketplace\'s own 80',
      result.status === 'selected' && result.baseline.realization_rate_percent === 81.5,
      result.status === 'selected' ? result.baseline : result,
    );
  }

  // ── N17: baseline uses only eligible channels ────────────────────────────
  console.log('\n[N17 — baseline uses only eligible channels]');
  {
    const channels: DealInChannelFixture[] = [
      ...DEAL_IN_CHANNEL_FIXTURES,
      { channelId: 7, channelName: 'Outlier', itemCount: 3, distinctDealCount: 3, realizedItemCount: 3, domSample: 3, realizationRate: 5, profit: 999999, roi: 999, dom: 1, confidence: 'low' },
    ];
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(channels));
    check(
      'an ineligible outlier (item_count 3, absurd metrics) never pollutes the baseline — profit still 495',
      result.status === 'selected' && result.baseline.median_net_profit === 495,
      result.status === 'selected' ? result.baseline : result,
    );
    check(
      'the ineligible outlier never pollutes the baseline — realization still 81.5',
      result.status === 'selected' && result.baseline.realization_rate_percent === 81.5,
      result.status === 'selected' ? result.baseline : result,
    );
  }

  // ── N18: tie-breakers are deterministic ──────────────────────────────────
  console.log('\n[N18 — deterministic tie-breakers]');
  {
    // 18a: identical metrics, differing confidence — higher confidence wins.
    const confidenceChannels: DealInChannelFixture[] = [
      { channelId: 70, channelName: 'T1-stronger', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 600, roi: 30, dom: 15, confidence: 'stronger' },
      { channelId: 71, channelName: 'T2-low', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 600, roi: 30, dom: 15, confidence: 'low' },
      { channelId: 72, channelName: 'T3-filler', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: confResult } = evaluateStrongDealInChannel(makeDealInChannelEvidence(confidenceChannels));
    check(
      'equal trigger counts break on confidence — T1 (stronger) beats T2 (low)',
      confResult.status === 'selected' && confResult.segment.channel_name === 'T1-stronger',
      confResult,
    );
    check(
      'the loser of the confidence tie-break appears as runner-up',
      confResult.status === 'selected' && confResult.runner_up?.segment.channel_name === 'T2-low',
      confResult,
    );

    // 18b: fully tied candidates (including confidence) — falls through to
    // ascending channel id.
    const idTieChannels: DealInChannelFixture[] = [
      { channelId: 80, channelName: 'U1-lower-id', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { channelId: 85, channelName: 'U2-higher-id', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 600, roi: 30, dom: 15, confidence: 'moderate' },
      { channelId: 82, channelName: 'U3-filler', itemCount: 10, distinctDealCount: 8, realizedItemCount: 8, domSample: 10, realizationRate: 60, profit: 300, roi: 15, dom: 25, confidence: 'moderate' },
    ];
    const { result: idResult } = evaluateStrongDealInChannel(makeDealInChannelEvidence(idTieChannels));
    check(
      'fully tied candidates break on ascending channel id — U1 (80) beats U2 (85)',
      idResult.status === 'selected' && idResult.segment.channel_id === 80,
      idResult,
    );
  }

  // ── N19: Deal In is not confused with Deal Out or listing-platform
  // evidence ───────────────────────────────────────────────────────────────
  console.log('\n[N19 — Deal In is not confused with Deal Out or listing-platform evidence]');
  {
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES));
    check('result is present', result.status === 'selected', result);
    if (result.status === 'selected') {
      check('headline does not describe the channel as a listing platform', !result.headline.toLowerCase().includes('listing platform'), result.headline);
      check('summary does not describe the channel as a listing platform', !result.summary.toLowerCase().includes('listing platform'), result.summary);
      check('summary describes sourcing (Deal In), not exiting (Deal Out)', result.summary.toLowerCase().includes('sourced through'), result.summary);
      check('limitations include DEAL_CHANNEL_IS_CONTACT_SOURCE_NOT_PAYMENT_LOCATION', result.limitations.includes('DEAL_CHANNEL_IS_CONTACT_SOURCE_NOT_PAYMENT_LOCATION'), result.limitations);
      check(
        'evidence_refs point at deal_in_channel_performance, never deal_out_channel_performance/listing_channel_evidence/channel_journey',
        result.evidence_refs.every((ref) => ref.includes('deal_in_channel_performance') && !ref.includes('deal_out_channel_performance') && !ref.includes('listing_channel') && !ref.includes('channel_journey')),
        result.evidence_refs,
      );
    }
  }

  // ── N20: existing five rules remain unchanged ────────────────────────────
  console.log('\n[N20 — existing five rules remain unchanged; Deal In and Deal Out are never suppressed against each other]');
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
    const journeyEvidence = makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES) as Record<string, unknown>;
    // Deal Out fixtures use Marketplace as channel_id 1, same as this
    // rule's Deal In fixtures — deliberately overlapping, to prove the two
    // rules are never deduplicated/suppressed against each other even when
    // they select the same channel_id.
    const dealOutEvidence = makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES) as Record<string, unknown>;
    const dealInEvidence = makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES) as Record<string, unknown>;
    const combinedDealChannelEvidence = {
      ...journeyEvidence,
      ...dealOutEvidence,
      ...dealInEvidence,
    };

    const { result: directBroad } = evaluateStrongBalancedAcquisitionBand(combinedAcquisitionEvidence);
    const { result: directCategory } = evaluateStrongCategoryAcquisitionBand(categoryEvidence);
    const { result: directMethod } = evaluateAcquisitionMethodPerformanceProfile(combinedAcquisitionEvidence);
    const { result: directJourney } = evaluateStrongDealInToDealOutJourney(combinedDealChannelEvidence);
    const { result: directDealOut } = evaluateStrongDealOutChannel(combinedDealChannelEvidence);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: combinedAcquisitionEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: combinedDealChannelEvidence,
      targetUserListingChannelEvidence: {},
      targetUserOpenInventoryEvidence: {},
    });

    check('all six rule families are present in one insights payload', insights.selected_findings.length === 6, insights.selected_findings.map((f) => f.finding_code));
    const viaOrchestratorBroad = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);
    const viaOrchestratorCategory = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE);
    const viaOrchestratorMethod = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE);
    const viaOrchestratorJourney = insights.selected_findings.find((f) => f.finding_code === JOURNEY_FINDING_CODE);
    const viaOrchestratorDealOut = insights.selected_findings.find((f) => f.finding_code === DEAL_OUT_CHANNEL_FINDING_CODE);
    const viaOrchestratorDealIn = insights.selected_findings.find((f) => f.finding_code === DEAL_IN_CHANNEL_FINDING_CODE);

    const categoryWithoutRelationship = viaOrchestratorCategory
      ? { ...(viaOrchestratorCategory as SelectedFindingForTest), relationship: undefined, summary: (directCategory as SelectedFindingForTest).summary }
      : viaOrchestratorCategory;

    check('the broad finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorBroad) === JSON.stringify(directBroad), { viaOrchestratorBroad, directBroad });
    check('the category finding (minus orchestrator relationship linking) is byte-identical to calling the rule directly', JSON.stringify(categoryWithoutRelationship) === JSON.stringify(directCategory), { categoryWithoutRelationship, directCategory });
    check('the acquisition-method finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorMethod) === JSON.stringify(directMethod), { viaOrchestratorMethod, directMethod });
    check('the channel-journey finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorJourney) === JSON.stringify(directJourney), { viaOrchestratorJourney, directJourney });
    check('the deal-out-channel finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorDealOut) === JSON.stringify(directDealOut), { viaOrchestratorDealOut, directDealOut });
    check(
      'the deal-in-channel finding is ALSO present, selecting the SAME channel_id (1) as deal-out — neither is suppressed',
      (viaOrchestratorDealIn as SelectedFindingForTest | undefined)?.segment.channel_name === 'Marketplace'
        && (viaOrchestratorDealOut as SelectedFindingForTest | undefined)?.segment.channel_name === 'Marketplace'
        && (viaOrchestratorDealIn as SelectedFindingForTest | undefined)?.segment.channel_id === (viaOrchestratorDealOut as SelectedFindingForTest | undefined)?.segment.channel_id,
      { viaOrchestratorDealIn, viaOrchestratorDealOut },
    );
    check('insights_engine_version is 1.7', insights.insights_engine_version === '1.7', insights.insights_engine_version);
    check('findings_selector_version is 1.7', insights.findings_selector_version === '1.7', insights.findings_selector_version);
  }

  // ── N21: previous Insights Engine snapshots remain readable ──────────────
  console.log('\n[N21 — previous Insights Engine v1.4-shaped snapshot (deal-out-channel finding, no deal-in-channel finding) remains readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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

    const v14ShapedInsights = {
      insights_engine_version: '1.4',
      findings_selector_version: '1.4',
      source_analytics_version: '2.10',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: DEAL_OUT_CHANNEL_FINDING_CODE,
          family: 'deal_out_channel_performance',
          direction: 'strength',
          status: 'selected',
          headline: 'Marketplace is a strong, balanced Deal Out Channel',
          summary: 'placeholder v1.4-shaped summary',
          segment: { channel_id: 1, channel_name: 'Marketplace' },
          metrics: { item_count: 20, distinct_deal_count: 18, median_net_profit: 700, median_roi: 33, median_days_on_market: 14, dom_sample_size: 20 },
          baseline: { type: 'peer_deal_out_channel_median_baseline', median_net_profit: 495, median_roi: 31, median_days_on_market: 20.5, realization_rate_percent: null },
          triggered_rules: ['PROFIT_ABOVE_PEER_BASELINE', 'DOM_FASTER_THAN_PEER_BASELINE', 'NO_MATERIAL_WEAKNESS'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_CHANNEL_METRICS'],
          evidence_refs: ['target_user_deal_channel_evidence.deal_out_channel_performance.performance_by_deal_out_channel'],
          // No deal-in-channel finding at all — this is the v1.4 shape.
        },
      ],
      rule_evaluations: [],
    };
    const v14Snapshot = { ...baseSnapshot, insights: v14ShapedInsights };

    check('a stored v2.11 snapshot carrying an Insights Engine v1.4-shaped insights section still validates', isValidAnalyticsSnapshot(v14Snapshot));
  }

  // ── N22: findings contain no user IDs, item IDs, item names, models,
  // notes, emails, or counterparty information ─────────────────────────────
  console.log('\n[N22 — deal-in-channel findings carry no user IDs, item IDs, names, models, notes, emails, or counterparty information]');
  {
    const { result } = evaluateStrongDealInChannel(makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES));
    if (result.status !== 'selected') {
      check('N22 setup produced a selected finding', false, result);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'baseline', 'triggered_rules', 'confidence', 'limitations', 'evidence_refs', 'runner_up'],
        segment: ['channel_id', 'channel_name'],
        metrics: ['item_count', 'distinct_deal_count', 'realized_item_count', 'realization_rate_percent', 'median_net_profit', 'median_roi', 'median_days_on_market', 'dom_sample_size'],
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

      check('no unexpected keys (no item/user identity or counterparty fields) appear anywhere in the deal-in-channel finding', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(result);
      const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i, /"counterparty/i, /"contact/i, /"deal_id"/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('serialized deal-in-channel finding contains no PII- or counterparty-shaped field names', matched.length === 0, matched);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // STRONG_LISTING_PLATFORM (Insights Engine v1.6)
  // ══════════════════════════════════════════════════════════════════════
  // Reads Analytics v2.11's target_user_listing_channel_evidence.
  // performance_by_listing_channel[] — the SAME array v2.6 already exposed
  // (v2.11 only added fields to each existing row). Listing Platform means
  // where an item was ADVERTISED — never where the buyer was found, never
  // which Deal Out channel completed the exit.

  // ── Listing Platform fixture builder ─────────────────────────────────────

  interface ListingPlatformFixture {
    channelId: number | null;
    channelName: string | null;
    exposedItemCount: number;
    realizedExposedItemCount: number;
    timingSampleSize: number;
    medianTimingDays: number | null;
    timingCoveragePercent: number | null;
    invalidTimingCount: number;
    missingTimingCount: number;
    profit: number | null;
    roi: number | null;
    confidence: ConfidenceTier | null;
  }

  function makeListingPlatformEvidence(
    platforms: ListingPlatformFixture[],
    options?: { includeByPurposeDecoy?: boolean },
  ): unknown {
    const evidence: Record<string, unknown> = {
      performance_by_listing_channel: platforms.map((p) => ({
        listing_channel_id: p.channelId,
        listing_channel_name: p.channelName,
        exposed_item_count: p.exposedItemCount,
        listing_record_count: p.exposedItemCount,
        realized_exposed_item_count: p.realizedExposedItemCount,
        open_exposed_item_count: Math.max(0, p.exposedItemCount - p.realizedExposedItemCount),
        sale_exit_item_count: p.realizedExposedItemCount,
        trade_exit_item_count: 0,
        realized_exposed_item_with_known_deal_out_count: p.realizedExposedItemCount,
        same_channel_exit_item_count: p.realizedExposedItemCount,
        different_channel_exit_item_count: 0,
        same_channel_exit_percent: p.realizedExposedItemCount > 0 ? 100 : null,
        total_acquisition_capital: null,
        realized_acquisition_capital: null,
        total_realized_net_profit: null,
        median_net_profit: p.profit,
        median_roi: p.roi,
        // Deliberately absurd GLOBAL DOM decoy values, unrelated to the
        // platform-specific timing fields below — proves the rule never
        // reads these (see L8).
        dom_sample_size: 9999,
        median_days_on_market: 9999,
        holding_sample_size: 0,
        median_holding_days: null,
        channel_listing_to_exit_sample_size: p.timingSampleSize,
        median_channel_listing_to_exit_days: p.medianTimingDays,
        channel_listing_to_exit_coverage_percent: p.timingCoveragePercent,
        invalid_channel_listing_after_exit_count: p.invalidTimingCount,
        missing_channel_listing_to_exit_count: p.missingTimingCount,
        confidence: p.confidence,
      })),
    };

    if (options?.includeByPurposeDecoy) {
      // Deliberately worse, tiny-sample decoy under a DIFFERENT key
      // (performance_by_listing_channel_by_purpose) — the rule must never
      // read this key (see L3).
      evidence.performance_by_listing_channel_by_purpose = platforms.map((p) => ({
        current_purpose_id: 1,
        current_purpose_name: 'Business',
        purpose_policy_status: 'mapped',
        listing_channel_id: p.channelId,
        listing_channel_name: p.channelName,
        exposed_item_count: 1,
        realized_exposed_item_count: 1,
        median_net_profit: -99999,
        median_roi: -99999,
        dom_sample_size: 1,
        median_days_on_market: 9999,
        channel_listing_to_exit_sample_size: 1,
        median_channel_listing_to_exit_days: 9999,
        channel_listing_to_exit_coverage_percent: 100,
        invalid_channel_listing_after_exit_count: 0,
        missing_channel_listing_to_exit_count: 0,
        confidence: 'insufficient',
      }));
    }

    return evidence;
  }

  function listingPlatformEvalFor(
    channelId: number | null,
    evaluations: ReturnType<typeof evaluateStrongListingPlatform>['candidateEvaluations'],
  ) {
    return evaluations.find((e) => e.listing_channel_id === channelId);
  }

  // Representative fixture: three eligible platforms, Marketplace clearly
  // best on all four metrics (profit, ROI, timing, realization) against a
  // Kijiji/Reverb baseline — used by L15/L16/L23/L24/L25/L26/L28/L29.
  const LISTING_PLATFORM_FIXTURES: ListingPlatformFixture[] = [
    { channelId: 1, channelName: 'Marketplace', exposedItemCount: 20, realizedExposedItemCount: 16, timingSampleSize: 16, medianTimingDays: 10, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
    { channelId: 2, channelName: 'Kijiji', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    { channelId: 3, channelName: 'Reverb', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
  ];

  // ── L1/L2: correct evidence path is used; shared evidence is ignored ────
  console.log('\n[L1/L2 — correct Analytics v2.11 target evidence path is used; shared evidence is ignored]');
  {
    const selectFindingsSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/insights/selectFindings.ts'), 'utf8');
    check(
      'selectFindings.ts wires targetUserListingChannelEvidence into evaluateStrongListingPlatform',
      selectFindingsSource.includes('evaluateStrongListingPlatform(input.targetUserListingChannelEvidence)'),
    );
    const runnerSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/runAnalytics.ts'), 'utf8');
    check(
      'runAnalytics.ts wires target_user_listing_channel_evidence into selectFindings',
      runnerSource.includes('targetUserListingChannelEvidence: snapshot.target_user_listing_channel_evidence'),
    );
    check(
      'runAnalytics.ts does not feed shared_listing_channel_evidence into selectFindings',
      !/targetUserListingChannelEvidence:\s*snapshot\.shared_listing_channel_evidence/.test(runnerSource),
    );
    const ruleSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/insights/rules/strongListingPlatform.ts'), 'utf8');
    check(
      'strongListingPlatform.ts reads performance_by_listing_channel and never accesses .shared_listing_channel_evidence in code (only mentions it in a comment explaining what it deliberately does not read)',
      ruleSource.includes('evidence?.performance_by_listing_channel') && !ruleSource.includes('.shared_listing_channel_evidence'),
    );
  }

  // ── L3/L4: the _by_purpose array is ignored; Business/Hybrid/Personal
  // remain pooled in one array ──────────────────────────────────────────
  console.log('\n[L3/L4 — the _by_purpose array is ignored; Business/Hybrid/Personal remain pooled]');
  {
    const pooled: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'Marketplace', exposedItemCount: 20, realizedExposedItemCount: 16, timingSampleSize: 16, medianTimingDays: 10, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
    ];
    const candidatesWithoutDecoy = extractListingPlatformCandidates(makeListingPlatformEvidence(pooled));
    const candidatesWithDecoy = extractListingPlatformCandidates(makeListingPlatformEvidence(pooled, { includeByPurposeDecoy: true }));
    check('extraction reads exactly one candidate row regardless of the (deliberately worse) _by_purpose decoy', candidatesWithDecoy.length === 1, candidatesWithDecoy);
    check("the candidate's own values are unaffected by the _by_purpose decoy", candidatesWithDecoy[0]?.median_net_profit === 700 && candidatesWithDecoy[0]?.median_roi === 30, candidatesWithDecoy);
    check('with or without the decoy, extraction produces identical candidates (the decoy key is never read)', JSON.stringify(candidatesWithoutDecoy) === JSON.stringify(candidatesWithDecoy), { candidatesWithoutDecoy, candidatesWithDecoy });

    // The main array is already pooled across every Purpose at the source
    // (no purpose_name filter) — confirm a stray purpose-shaped field on a
    // pooled row changes nothing (the extractor never reads it).
    const rowsWithStrayPurposeField = (makeListingPlatformEvidence(pooled) as any).performance_by_listing_channel
      .map((r: any) => ({ ...r, current_purpose_id: 1, current_purpose_name: 'Hybrid', purpose_policy_status: 'mapped' }));
    const candidatesWithStrayField = extractListingPlatformCandidates({ performance_by_listing_channel: rowsWithStrayPurposeField });
    check('a stray purpose-shaped field on the pooled row does not change extraction', JSON.stringify(candidatesWithStrayField) === JSON.stringify(candidatesWithoutDecoy), candidatesWithStrayField);
  }

  // ── L5/L6: realization rate is computed correctly; zero exposed is null ──
  console.log('\n[L5/L6 — realization rate is calculated correctly from realized/exposed counts; zero exposed count yields null safely]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'Marketplace', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
      { channelId: 2, channelName: 'ZeroExposure', exposedItemCount: 0, realizedExposedItemCount: 0, timingSampleSize: 0, medianTimingDays: null, timingCoveragePercent: null, invalidTimingCount: 0, missingTimingCount: 0, profit: null, roi: null, confidence: null },
    ];
    const candidates = extractListingPlatformCandidates(makeListingPlatformEvidence(rows));
    const marketplace = candidates.find((c) => c.listing_channel_id === 1);
    const zero = candidates.find((c) => c.listing_channel_id === 2);
    check('realization_rate_percent is 15/20*100 = 75', marketplace?.realization_rate_percent === 75, marketplace);
    check('zero exposed_item_count yields a null realization rate, never a division error or a fabricated 0', zero?.realization_rate_percent === null, zero);
  }

  // ── L7/L8: platform-specific timing is used; global DOM is never read ───
  console.log('\n[L7/L8 — platform-specific median_channel_listing_to_exit_days is used; global median_days_on_market is never read]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'Marketplace', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
    ];
    const candidates = extractListingPlatformCandidates(makeListingPlatformEvidence(rows));
    const marketplace = candidates.find((c) => c.listing_channel_id === 1) as unknown as Record<string, unknown>;
    check('median_channel_listing_to_exit_days is the platform-specific 12, not the decoy global 9999', marketplace?.median_channel_listing_to_exit_days === 12, marketplace);
    check('the extracted candidate never carries a dom_sample_size or median_days_on_market key', !('dom_sample_size' in (marketplace ?? {})) && !('median_days_on_market' in (marketplace ?? {})), marketplace);
    const ruleSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/insights/rules/strongListingPlatform.ts'), 'utf8');
    check('strongListingPlatform.ts never reads r.dom_sample_size or r.median_days_on_market from the evidence row', !ruleSource.includes('r.dom_sample_size') && !ruleSource.includes('r.median_days_on_market'));
  }

  // ── L9: exposed, realized, and timing sample minimums are checked
  // independently ─────────────────────────────────────────────────────────
  console.log('\n[L9 — exposed, realized, and timing sample minimums are checked independently]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'ThinExposure', exposedItemCount: 7, realizedExposedItemCount: 6, timingSampleSize: 6, medianTimingDays: 15, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
      { channelId: 2, channelName: 'ThinRealized', exposedItemCount: 10, realizedExposedItemCount: 4, timingSampleSize: 5, medianTimingDays: 15, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
      { channelId: 3, channelName: 'ThinTiming', exposedItemCount: 10, realizedExposedItemCount: 6, timingSampleSize: 4, medianTimingDays: 15, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { candidateEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(rows));
    const thinExposure = listingPlatformEvalFor(1, candidateEvaluations);
    const thinRealized = listingPlatformEvalFor(2, candidateEvaluations);
    const thinTiming = listingPlatformEvalFor(3, candidateEvaluations);
    check(
      'ThinExposure fails only on EXPOSED_ITEM_COUNT_BELOW_MINIMUM',
      !!thinExposure?.eligibility_failure_reasons.includes('EXPOSED_ITEM_COUNT_BELOW_MINIMUM')
        && !thinExposure?.eligibility_failure_reasons.includes('REALIZED_EXPOSED_ITEM_COUNT_BELOW_MINIMUM')
        && !thinExposure?.eligibility_failure_reasons.includes('CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE_BELOW_MINIMUM'),
      thinExposure,
    );
    check(
      'ThinRealized fails only on REALIZED_EXPOSED_ITEM_COUNT_BELOW_MINIMUM',
      !!thinRealized?.eligibility_failure_reasons.includes('REALIZED_EXPOSED_ITEM_COUNT_BELOW_MINIMUM')
        && !thinRealized?.eligibility_failure_reasons.includes('EXPOSED_ITEM_COUNT_BELOW_MINIMUM')
        && !thinRealized?.eligibility_failure_reasons.includes('CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE_BELOW_MINIMUM'),
      thinRealized,
    );
    check(
      'ThinTiming fails only on CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE_BELOW_MINIMUM',
      !!thinTiming?.eligibility_failure_reasons.includes('CHANNEL_LISTING_TO_EXIT_SAMPLE_SIZE_BELOW_MINIMUM')
        && !thinTiming?.eligibility_failure_reasons.includes('EXPOSED_ITEM_COUNT_BELOW_MINIMUM')
        && !thinTiming?.eligibility_failure_reasons.includes('REALIZED_EXPOSED_ITEM_COUNT_BELOW_MINIMUM'),
      thinTiming,
    );
  }

  // ── L10: null platform identity is excluded ──────────────────────────────
  console.log('\n[L10 — null platform identity is excluded]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: null, channelName: null, exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
    ];
    const { candidateEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(rows));
    const nullIdentity = listingPlatformEvalFor(null, candidateEvaluations);
    check('a null channel identity row is ineligible', nullIdentity?.eligible === false, nullIdentity);
    check('reason is LISTING_CHANNEL_IDENTITY_MISSING', !!nullIdentity?.eligibility_failure_reasons.includes('LISTING_CHANNEL_IDENTITY_MISSING'), nullIdentity);
  }

  // ── L11/L12: null metrics and insufficient confidence are handled
  // honestly, never crash, never fabricate a value ─────────────────────────
  console.log('\n[L11/L12 — null profit, ROI, timing, realization, or confidence is handled honestly; insufficient confidence is ineligible]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'NullProfit', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: null, roi: 30, confidence: 'stronger' },
      { channelId: 2, channelName: 'NullRoi', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: null, confidence: 'stronger' },
      { channelId: 3, channelName: 'NullTiming', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: null, timingCoveragePercent: null, invalidTimingCount: 0, missingTimingCount: 15, profit: 700, roi: 30, confidence: 'stronger' },
      { channelId: 4, channelName: 'NullConfidence', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: null },
      { channelId: 5, channelName: 'InsufficientConfidence', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'insufficient' },
    ];
    const { candidateEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(rows));
    check('NullProfit reason is MEDIAN_NET_PROFIT_MISSING', !!listingPlatformEvalFor(1, candidateEvaluations)?.eligibility_failure_reasons.includes('MEDIAN_NET_PROFIT_MISSING'));
    check('NullRoi reason is MEDIAN_ROI_MISSING', !!listingPlatformEvalFor(2, candidateEvaluations)?.eligibility_failure_reasons.includes('MEDIAN_ROI_MISSING'));
    check('NullTiming reason is MEDIAN_CHANNEL_LISTING_TO_EXIT_DAYS_MISSING', !!listingPlatformEvalFor(3, candidateEvaluations)?.eligibility_failure_reasons.includes('MEDIAN_CHANNEL_LISTING_TO_EXIT_DAYS_MISSING'));
    check('NullConfidence reason is CONFIDENCE_UNAVAILABLE', !!listingPlatformEvalFor(4, candidateEvaluations)?.eligibility_failure_reasons.includes('CONFIDENCE_UNAVAILABLE'));
    const insufficientRow = listingPlatformEvalFor(5, candidateEvaluations);
    check('InsufficientConfidence is ineligible', insufficientRow?.eligible === false, insufficientRow);
    check('InsufficientConfidence reason is CONFIDENCE_INSUFFICIENT', !!insufficientRow?.eligibility_failure_reasons.includes('CONFIDENCE_INSUFFICIENT'), insufficientRow);

    const zeroExposureRow: ListingPlatformFixture = { channelId: 6, channelName: 'ZeroExposure', exposedItemCount: 0, realizedExposedItemCount: 0, timingSampleSize: 0, medianTimingDays: null, timingCoveragePercent: null, invalidTimingCount: 0, missingTimingCount: 0, profit: null, roi: null, confidence: null };
    const { candidateEvaluations: zeroEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence([zeroExposureRow]));
    check('a zero-exposure row reason includes REALIZATION_RATE_MISSING', !!listingPlatformEvalFor(6, zeroEvaluations)?.eligibility_failure_reasons.includes('REALIZATION_RATE_MISSING'));
  }

  // ── L13/L14: fewer than three eligible platforms produces no finding;
  // diagnostics still distinguish eligible from insufficient ──────────────
  console.log('\n[L13/L14 — fewer than three eligible platforms produces no finding; diagnostics still distinguish eligible from insufficient peers]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'Eligible', exposedItemCount: 20, realizedExposedItemCount: 15, timingSampleSize: 15, medianTimingDays: 12, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
      { channelId: 2, channelName: 'Insufficient', exposedItemCount: 3, realizedExposedItemCount: 1, timingSampleSize: 1, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 100, roi: 5, confidence: 'insufficient' },
    ];
    const { result, candidateEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(rows));
    check('result is no_eligible_finding', result.status === 'no_eligible_finding', result);
    check('reason_codes includes INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS', result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS'), result);
    const eligibleRow = listingPlatformEvalFor(1, candidateEvaluations);
    const insufficientRow = listingPlatformEvalFor(2, candidateEvaluations);
    check('the eligible platform is still marked eligible in diagnostics, even though no finding is selected', eligibleRow?.eligible === true && eligibleRow?.eligibility_failure_reasons.length === 0, eligibleRow);
    check('the insufficient platform is distinguishably marked ineligible with reasons', insufficientRow?.eligible === false && insufficientRow?.eligibility_failure_reasons.length > 0, insufficientRow);
  }

  // ── L15/L16: baseline excludes the candidate; baseline uses only
  // eligible peer platforms ────────────────────────────────────────────────
  console.log('\n[L15/L16 — baseline excludes the candidate itself; baseline uses only eligible peer platforms]');
  {
    const { result } = evaluateStrongListingPlatform(makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES));
    check('winner is Marketplace', result.status === 'selected' && result.segment.listing_channel_name === 'Marketplace', result);
    if (result.status === 'selected') {
      check('baseline.median_net_profit is the Kijiji/Reverb-only peer median (500), not pulled toward Marketplace\'s own 700', result.baseline.median_net_profit === 500, result.baseline);
      check('baseline.median_roi is the peer median (20)', result.baseline.median_roi === 20, result.baseline);
      check('baseline.median_channel_listing_to_exit_days is the peer median (20)', result.baseline.median_channel_listing_to_exit_days === 20, result.baseline);
      check('baseline.realization_rate_percent is the peer median (60)', result.baseline.realization_rate_percent === 60, result.baseline);
    }

    const withIneligibleOutlier = [
      ...LISTING_PLATFORM_FIXTURES,
      { channelId: 9, channelName: 'TinyOutlier', exposedItemCount: 3, realizedExposedItemCount: 1, timingSampleSize: 1, medianTimingDays: 1, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 999999, roi: 999999, confidence: 'insufficient' } as ListingPlatformFixture,
    ];
    const { result: resultWithOutlier } = evaluateStrongListingPlatform(makeListingPlatformEvidence(withIneligibleOutlier));
    check(
      'an ineligible outlier (absurd metrics, insufficient confidence) never pollutes the baseline',
      resultWithOutlier.status === 'selected'
        && resultWithOutlier.baseline.median_net_profit === 500
        && resultWithOutlier.baseline.median_roi === 20
        && resultWithOutlier.baseline.median_channel_listing_to_exit_days === 20
        && resultWithOutlier.baseline.realization_rate_percent === 60,
      resultWithOutlier,
    );
  }

  // ── L17/L18/L19: a single strong metric alone never qualifies — at
  // least two material improvements are required ──────────────────────────
  console.log('\n[L17/L18/L19 — highest ROI or profit alone does not qualify; at least two material improvements are required]');
  {
    const highRoiOnly: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'HighRoiOnly', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 80, confidence: 'moderate' },
      { channelId: 2, channelName: 'Peer2', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
      { channelId: 3, channelName: 'Peer3', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { candidateEvaluations: roiEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(highRoiOnly));
    const roiRow = listingPlatformEvalFor(1, roiEvaluations);
    check('HighRoiOnly gets exactly one improvement trigger (ROI)', roiRow?.material_improvement_triggers.length === 1 && roiRow?.material_improvement_triggers[0] === 'ROI_ABOVE_PEER_BASELINE', roiRow);
    check('HighRoiOnly does not qualify despite the highest ROI', roiRow?.qualifies === false, roiRow);

    const highProfitOnly: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'HighProfitOnly', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 5000, roi: 20, confidence: 'moderate' },
      { channelId: 2, channelName: 'Peer2', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
      { channelId: 3, channelName: 'Peer3', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { candidateEvaluations: profitEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(highProfitOnly));
    const profitRow = listingPlatformEvalFor(1, profitEvaluations);
    check('HighProfitOnly gets exactly one improvement trigger (profit)', profitRow?.material_improvement_triggers.length === 1 && profitRow?.material_improvement_triggers[0] === 'PROFIT_ABOVE_PEER_BASELINE', profitRow);
    check('HighProfitOnly does not qualify despite the highest profit', profitRow?.qualifies === false, profitRow);

    const exactlyTwoTriggers: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'TwoTriggers', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 25, confidence: 'moderate' },
      { channelId: 2, channelName: 'Peer2', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
      { channelId: 3, channelName: 'Peer3', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { candidateEvaluations: twoTriggerEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(exactlyTwoTriggers));
    const twoTriggerRow = listingPlatformEvalFor(1, twoTriggerEvaluations);
    check('exactly two improvement triggers (profit + ROI) is sufficient to qualify', twoTriggerRow?.material_improvement_triggers.length === 2 && twoTriggerRow?.qualifies === true, twoTriggerRow);
  }

  // ── L20/L21: any material weakness prevents qualification; faster
  // platform timing is interpreted as better (slower is a weakness) ───────
  console.log('\n[L20/L21 — a material weakness prevents qualification even with two improvements; faster listing-to-exit timing is better, slower is a weakness]');
  {
    const rows: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'WeaknessDespiteImprovements', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 40, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 25, confidence: 'moderate' },
      { channelId: 2, channelName: 'Peer2', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
      { channelId: 3, channelName: 'Peer3', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { candidateEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(rows));
    const row = listingPlatformEvalFor(1, candidateEvaluations);
    check('the slower-timing candidate has 2 improvement triggers (profit, ROI)', row?.material_improvement_triggers.length === 2, row);
    check('the slower-timing candidate also carries a timing weakness trigger', !!row?.material_weakness_triggers.includes('LISTING_TO_EXIT_SLOWER_THAN_PEER_BASELINE'), row);
    check('the timing weakness trigger is never named with "DOM"', !row?.material_weakness_triggers.some((t) => t.includes('DOM')), row);
    check('the candidate does not qualify despite 2 improvements, because of the material weakness', row?.qualifies === false, row);

    // Marketplace (from the representative fixture) is faster than its
    // peers and gets the improvement trigger, never the weakness one.
    const { candidateEvaluations: representativeEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES));
    const marketplaceRow = listingPlatformEvalFor(1, representativeEvaluations);
    check('faster platform timing triggers LISTING_TO_EXIT_FASTER_THAN_PEER_BASELINE, not a DOM-named code', !!marketplaceRow?.material_improvement_triggers.includes('LISTING_TO_EXIT_FASTER_THAN_PEER_BASELINE') && !marketplaceRow?.material_improvement_triggers.some((t) => t.includes('DOM')), marketplaceRow);
  }

  // ── L22: deterministic tie-breakers ──────────────────────────────────────
  console.log('\n[L22 — deterministic tie-breakers]');
  {
    const confidenceTieRows: ListingPlatformFixture[] = [
      { channelId: 10, channelName: 'TieStrong', exposedItemCount: 20, realizedExposedItemCount: 16, timingSampleSize: 16, medianTimingDays: 10, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
      { channelId: 11, channelName: 'TieModerate', exposedItemCount: 20, realizedExposedItemCount: 16, timingSampleSize: 16, medianTimingDays: 10, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'moderate' },
      { channelId: 12, channelName: 'TieFiller', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { result: confResult } = evaluateStrongListingPlatform(makeListingPlatformEvidence(confidenceTieRows));
    check('equal trigger counts break on confidence — TieStrong beats TieModerate', confResult.status === 'selected' && confResult.segment.listing_channel_id === 10, confResult);
    check('the loser of the confidence tie-break appears as runner-up', confResult.status === 'selected' && confResult.runner_up?.segment.listing_channel_id === 11, confResult.status === 'selected' ? confResult.runner_up : confResult);

    const idTieRows: ListingPlatformFixture[] = [
      { channelId: 20, channelName: 'TieIdLow', exposedItemCount: 20, realizedExposedItemCount: 16, timingSampleSize: 16, medianTimingDays: 10, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
      { channelId: 21, channelName: 'TieIdHigh', exposedItemCount: 20, realizedExposedItemCount: 16, timingSampleSize: 16, medianTimingDays: 10, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 700, roi: 30, confidence: 'stronger' },
      { channelId: 22, channelName: 'TieFiller', exposedItemCount: 20, realizedExposedItemCount: 12, timingSampleSize: 12, medianTimingDays: 20, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 500, roi: 20, confidence: 'moderate' },
    ];
    const { result: idResult } = evaluateStrongListingPlatform(makeListingPlatformEvidence(idTieRows));
    check('fully tied candidates break on ascending listing_channel_id — TieIdLow (20) beats TieIdHigh (21)', idResult.status === 'selected' && idResult.segment.listing_channel_id === 20, idResult);
  }

  // ── L23/L24: required limitations are always present; incomplete
  // timing coverage adds the dynamic limitation ────────────────────────────
  console.log('\n[L23/L24 — required limitations are always present; incomplete timing coverage adds the dynamic limitation]');
  {
    const { result } = evaluateStrongListingPlatform(makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES));
    const requiredLimitations = [
      'PEER_BASELINE_USES_MEDIAN_OF_PLATFORM_METRICS',
      'LISTING_EXPOSURE_ASSOCIATION_NOT_CAUSATION',
      'CROSS_LISTED_ITEM_COHORTS_OVERLAP',
      'EXIT_CHANNEL_NOT_ATTRIBUTABLE_TO_LISTING_PLATFORM',
      'CATEGORY_AND_VALUE_BAND_MIX_NOT_CONTROLLED',
      'HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED',
      'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
    ];
    check(
      'all seven required limitations are present (full timing coverage)',
      result.status === 'selected' && requiredLimitations.every((l) => result.limitations.includes(l)),
      result.status === 'selected' ? result.limitations : result,
    );
    check(
      'CHANNEL_LISTING_TO_EXIT_COVERAGE_INCOMPLETE is absent at 100% coverage',
      result.status === 'selected' && !result.limitations.includes('CHANNEL_LISTING_TO_EXIT_COVERAGE_INCOMPLETE'),
      result.status === 'selected' ? result.limitations : result,
    );

    const incompleteCoverageFixtures = LISTING_PLATFORM_FIXTURES.map((f) =>
      f.channelId === 1 ? { ...f, timingCoveragePercent: 90 } : f,
    );
    const { result: incompleteResult } = evaluateStrongListingPlatform(makeListingPlatformEvidence(incompleteCoverageFixtures));
    check(
      'CHANNEL_LISTING_TO_EXIT_COVERAGE_INCOMPLETE is present when coverage is below 100%',
      incompleteResult.status === 'selected' && incompleteResult.limitations.includes('CHANNEL_LISTING_TO_EXIT_COVERAGE_INCOMPLETE'),
      incompleteResult.status === 'selected' ? incompleteResult.limitations : incompleteResult,
    );
  }

  // ── L26/L28: representative fixture selects the correct, non-hardcoded
  // winner ─────────────────────────────────────────────────────────────────
  console.log('\n[L26/L28 — representative fixture with three eligible platforms selects the correct winner; the winner is not hardcoded]');
  {
    const { result } = evaluateStrongListingPlatform(makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES));
    check('Marketplace wins (best on profit, ROI, timing, and realization)', result.status === 'selected' && result.segment.listing_channel_name === 'Marketplace', result);
    check('Marketplace is explicitly NOT named "Reverb" — proving the winner is not hardcoded', result.status === 'selected' && result.segment.listing_channel_name !== 'Reverb', result);
    if (result.status === 'selected') {
      check('metrics.median_net_profit is 700', result.metrics.median_net_profit === 700, result.metrics);
      check('metrics.median_roi is 30', result.metrics.median_roi === 30, result.metrics);
      check('metrics.median_channel_listing_to_exit_days is 10', result.metrics.median_channel_listing_to_exit_days === 10, result.metrics);
      check('metrics.realization_rate_percent is 80', result.metrics.realization_rate_percent === 80, result.metrics);
      check('confidence is stronger', result.confidence === 'stronger', result.confidence);
      check('no runner-up appears (Kijiji and Reverb both carry a material weakness, so neither qualifies)', result.runner_up === undefined, result.runner_up);
    }

    // Swap the winning numbers onto a DIFFERENT channel id/name (Reverb) —
    // the winner must follow, proving selection is driven by comparative
    // metrics, never a fixed platform name.
    const swapped = LISTING_PLATFORM_FIXTURES.map((f) => {
      if (f.channelId === 1) return { ...f, channelId: 3, channelName: 'Reverb' };
      if (f.channelId === 3) return { ...f, channelId: 1, channelName: 'Marketplace' };
      return f;
    });
    const { result: swappedResult } = evaluateStrongListingPlatform(makeListingPlatformEvidence(swapped));
    check('when the winning metrics are relabeled onto Reverb, Reverb wins instead', swappedResult.status === 'selected' && swappedResult.segment.listing_channel_name === 'Reverb', swappedResult);
  }

  // ── L27: current-production-shaped fixture returns
  // INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS ────────────────────────────────
  console.log('\n[L27 — current-production-shaped fixture (Reverb eligible; Marketplace/Kijiji not) returns INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS]');
  {
    // Shaped after the real current production numbers (not hardcoded as a
    // rule behavior — this is a fixture value, exercised through the same
    // generic eligibility/comparison logic every other test uses): Reverb
    // 79 exposed / 55 realized / 55 timing samples / 17-day median / 100%
    // coverage / stronger confidence; Marketplace and Kijiji 4 exposed / 0
    // realized each.
    const productionShaped: ListingPlatformFixture[] = [
      { channelId: 1, channelName: 'Marketplace', exposedItemCount: 4, realizedExposedItemCount: 0, timingSampleSize: 0, medianTimingDays: null, timingCoveragePercent: null, invalidTimingCount: 0, missingTimingCount: 0, profit: null, roi: null, confidence: 'low' },
      { channelId: 2, channelName: 'Kijiji', exposedItemCount: 4, realizedExposedItemCount: 0, timingSampleSize: 0, medianTimingDays: null, timingCoveragePercent: null, invalidTimingCount: 0, missingTimingCount: 0, profit: null, roi: null, confidence: 'low' },
      { channelId: 3, channelName: 'Reverb', exposedItemCount: 79, realizedExposedItemCount: 55, timingSampleSize: 55, medianTimingDays: 17, timingCoveragePercent: 100, invalidTimingCount: 0, missingTimingCount: 0, profit: 600, roi: 25, confidence: 'stronger' },
    ];
    const { result, candidateEvaluations } = evaluateStrongListingPlatform(makeListingPlatformEvidence(productionShaped));
    check('result is no_eligible_finding (STRONG_LISTING_PLATFORM is not selected)', result.status === 'no_eligible_finding', result);
    check('reason_codes includes INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS', result.status === 'no_eligible_finding' && result.reason_codes.includes('INSUFFICIENT_ELIGIBLE_LISTING_PLATFORMS'), result);
    check('Reverb is individually eligible', listingPlatformEvalFor(3, candidateEvaluations)?.eligible === true, listingPlatformEvalFor(3, candidateEvaluations));
    check('Marketplace is not individually eligible (insufficient realized exposures)', listingPlatformEvalFor(1, candidateEvaluations)?.eligible === false, listingPlatformEvalFor(1, candidateEvaluations));
    check('Kijiji is not individually eligible (insufficient realized exposures)', listingPlatformEvalFor(2, candidateEvaluations)?.eligible === false, listingPlatformEvalFor(2, candidateEvaluations));
  }

  // ── L25/L29: Listing Platform coexists with Deal Out; the previous six
  // rules remain byte-identical after filtering the seventh back out ──────
  console.log('\n[L25/L29 — Listing Platform coexists with Deal Out (same channel identity, neither suppressed); previous six rules stay byte-identical when the seventh also fires]');
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
    const journeyEvidence = makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES) as Record<string, unknown>;
    const dealOutEvidence = makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES) as Record<string, unknown>;
    const dealInEvidence = makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES) as Record<string, unknown>;
    const combinedDealChannelEvidence = {
      ...journeyEvidence,
      ...dealOutEvidence,
      ...dealInEvidence,
    };
    // Deal Out's own fixtures already use channel_id 1 = 'Marketplace' —
    // the representative Listing Platform fixture also selects channel_id
    // 1 = 'Marketplace', deliberately overlapping so this scenario proves
    // the two rules are never deduplicated or suppressed against each
    // other, even though they reference the exact same channel.
    const listingPlatformEvidence = makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES);

    const { result: directBroad } = evaluateStrongBalancedAcquisitionBand(combinedAcquisitionEvidence);
    const { result: directCategory } = evaluateStrongCategoryAcquisitionBand(categoryEvidence);
    const { result: directMethod } = evaluateAcquisitionMethodPerformanceProfile(combinedAcquisitionEvidence);
    const { result: directJourney } = evaluateStrongDealInToDealOutJourney(combinedDealChannelEvidence);
    const { result: directDealOut } = evaluateStrongDealOutChannel(combinedDealChannelEvidence);
    const { result: directDealIn } = evaluateStrongDealInChannel(combinedDealChannelEvidence);
    const { result: directListingPlatform } = evaluateStrongListingPlatform(listingPlatformEvidence);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: combinedAcquisitionEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: combinedDealChannelEvidence,
      targetUserListingChannelEvidence: listingPlatformEvidence,
      targetUserOpenInventoryEvidence: {},
    });

    check('all seven rule families are present in one insights payload', insights.selected_findings.length === 7, insights.selected_findings.map((f) => f.finding_code));

    const viaOrchestratorBroad = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);
    const viaOrchestratorCategory = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE);
    const viaOrchestratorMethod = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE);
    const viaOrchestratorJourney = insights.selected_findings.find((f) => f.finding_code === JOURNEY_FINDING_CODE);
    const viaOrchestratorDealOut = insights.selected_findings.find((f) => f.finding_code === DEAL_OUT_CHANNEL_FINDING_CODE);
    const viaOrchestratorDealIn = insights.selected_findings.find((f) => f.finding_code === DEAL_IN_CHANNEL_FINDING_CODE);
    const viaOrchestratorListingPlatform = insights.selected_findings.find((f) => f.finding_code === LISTING_PLATFORM_FINDING_CODE);

    const categoryWithoutRelationship = viaOrchestratorCategory
      ? { ...(viaOrchestratorCategory as SelectedFindingForTest), relationship: undefined, summary: (directCategory as SelectedFindingForTest).summary }
      : viaOrchestratorCategory;

    check('the broad finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorBroad) === JSON.stringify(directBroad), { viaOrchestratorBroad, directBroad });
    check('the category finding (minus orchestrator relationship linking) is byte-identical to calling the rule directly', JSON.stringify(categoryWithoutRelationship) === JSON.stringify(directCategory), { categoryWithoutRelationship, directCategory });
    check('the acquisition-method finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorMethod) === JSON.stringify(directMethod), { viaOrchestratorMethod, directMethod });
    check('the channel-journey finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorJourney) === JSON.stringify(directJourney), { viaOrchestratorJourney, directJourney });
    check('the deal-out-channel finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorDealOut) === JSON.stringify(directDealOut), { viaOrchestratorDealOut, directDealOut });
    check('the deal-in-channel finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorDealIn) === JSON.stringify(directDealIn), { viaOrchestratorDealIn, directDealIn });
    check('the listing-platform finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorListingPlatform) === JSON.stringify(directListingPlatform), { viaOrchestratorListingPlatform, directListingPlatform });

    check(
      'Listing Platform and Deal Out both select Marketplace / channel_id 1 — neither is suppressed or deduplicated',
      (viaOrchestratorListingPlatform as SelectedFindingForTest | undefined)?.segment.listing_channel_name === 'Marketplace'
        && (viaOrchestratorDealOut as SelectedFindingForTest | undefined)?.segment.channel_name === 'Marketplace'
        && (viaOrchestratorListingPlatform as SelectedFindingForTest | undefined)?.segment.listing_channel_id === (viaOrchestratorDealOut as SelectedFindingForTest | undefined)?.segment.channel_id,
      { viaOrchestratorListingPlatform, viaOrchestratorDealOut },
    );

    const sixCodesWithoutTheSeventh = insights.selected_findings
      .filter((f) => f.finding_code !== LISTING_PLATFORM_FINDING_CODE)
      .map((f) => f.finding_code)
      .sort();
    const expectedSixCodes = [BROAD_FINDING_CODE, CATEGORY_FINDING_CODE, METHOD_PROFILE_FINDING_CODE, JOURNEY_FINDING_CODE, DEAL_OUT_CHANNEL_FINDING_CODE, DEAL_IN_CHANNEL_FINDING_CODE].sort();
    check(
      'filtering STRONG_LISTING_PLATFORM back out reproduces exactly the previous six finding_codes',
      JSON.stringify(sixCodesWithoutTheSeventh) === JSON.stringify(expectedSixCodes),
      sixCodesWithoutTheSeventh,
    );
  }

  // ── L30: previous Insights Engine snapshots (no listing-platform rule)
  // remain readable ────────────────────────────────────────────────────────
  console.log('\n[L30 — previous Insights Engine v1.5-shaped snapshot (no listing-platform finding) remains readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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

    const v15ShapedInsights = {
      insights_engine_version: '1.5',
      findings_selector_version: '1.5',
      source_analytics_version: '2.11',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: DEAL_IN_CHANNEL_FINDING_CODE,
          family: 'deal_in_channel_performance',
          direction: 'strength',
          status: 'selected',
          headline: 'Marketplace is a strong, balanced Deal In Channel',
          summary: 'placeholder v1.5-shaped summary',
          segment: { channel_id: 1, channel_name: 'Marketplace' },
          metrics: { item_count: 20, distinct_deal_count: 18, realized_item_count: 16, realization_rate_percent: 80, median_net_profit: 700, median_roi: 30, median_days_on_market: 10, dom_sample_size: 16 },
          baseline: { type: 'peer_deal_in_channel_median_baseline', median_net_profit: 500, median_roi: 20, median_days_on_market: 20, realization_rate_percent: 60 },
          triggered_rules: ['PROFIT_ABOVE_PEER_BASELINE', 'ROI_ABOVE_PEER_BASELINE', 'DOM_FASTER_THAN_PEER_BASELINE', 'REALIZATION_ABOVE_PEER_BASELINE', 'NO_MATERIAL_WEAKNESS'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_CHANNEL_METRICS'],
          evidence_refs: ['target_user_deal_channel_evidence.deal_in_channel_performance.performance_by_deal_in_channel'],
          // No listing-platform finding at all — this is the v1.5 shape.
        },
      ],
      rule_evaluations: [],
    };
    const v15Snapshot = { ...baseSnapshot, insights: v15ShapedInsights };

    check('a stored v2.11 snapshot carrying an Insights Engine v1.5-shaped insights section still validates', isValidAnalyticsSnapshot(v15Snapshot));
  }

  // ── L31: findings carry no user IDs, item IDs, item names, models,
  // notes, emails, listing text, or counterparty information ──────────────
  console.log('\n[L31 — listing-platform findings carry no user IDs, item IDs, names, models, notes, emails, listing text, or counterparties]');
  {
    const { result } = evaluateStrongListingPlatform(makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES));
    if (result.status !== 'selected') {
      check('L31 setup produced a selected finding', false, result);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'baseline', 'triggered_rules', 'confidence', 'limitations', 'evidence_refs', 'runner_up'],
        segment: ['listing_channel_id', 'listing_channel_name'],
        metrics: [
          'exposed_item_count', 'realized_exposed_item_count', 'realization_rate_percent', 'median_net_profit', 'median_roi',
          'channel_listing_to_exit_sample_size', 'median_channel_listing_to_exit_days', 'channel_listing_to_exit_coverage_percent',
          'invalid_channel_listing_after_exit_count', 'missing_channel_listing_to_exit_count',
          'listing_record_count', 'sale_exit_item_count', 'trade_exit_item_count', 'same_channel_exit_item_count', 'different_channel_exit_item_count',
        ],
        baseline: ['type', 'median_net_profit', 'median_roi', 'median_channel_listing_to_exit_days', 'realization_rate_percent'],
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

      check('no unexpected keys (no item/user identity or counterparty fields) appear anywhere in the listing-platform finding', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(result);
      const forbiddenPatterns = [/"user_id"/i, /"item_id"/i, /"email"/i, /"model"/i, /"notes"/i, /"listing_text"/i, /"item_name"/i, /"counterparty/i, /"contact/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('serialized listing-platform finding contains no PII- or counterparty-shaped field names', matched.length === 0, matched);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUSINESS_OPEN_INVENTORY_PRIORITY (Insights Engine v1.7)
  // ══════════════════════════════════════════════════════════════════════
  // Reads Analytics v2.1's (unchanged through v2.11) target_user_open_
  // inventory_evidence.item_decision_evidence[] — the first Insights rule
  // scoped to a single Purpose (Business only) and the first to select an
  // item-level finding. reason_codes on this evidence are real, partially
  // BUSINESS_-prefixed SQL-generated strings — see rules/
  // businessOpenInventoryPriority.ts's own header for the full mapping.

  // ── Fixture builder ───────────────────────────────────────────────────
  // Fixtures set reason_codes directly (the rule treats them as controlled
  // evidence, never re-derives them from thresholds) — this mirrors
  // exactly how the rule itself consumes this evidence.

  interface BusinessOpenItemFixture {
    itemId: number;
    itemDisplayName?: string | null;
    currentPurposeName: string | null;
    dispositionMode?: string | null;
    activeRealizationFlag?: boolean | null;
    purposePolicyStatus?: string | null;
    listedFlag: boolean;
    currentDomDays?: number | null;
    ownershipAgeDays?: number | null;
    acquisitionValue?: number | null;
    estimatedSoldValue?: number | null;
    estimatedNetUpside?: number | null;
    estimatedUpsidePercent?: number | null;
    openCapitalSharePercent?: number | null;
    purposeOpenCapitalSharePercent?: number | null;
    listingChannelNames?: string[];
    isHistoricalImport?: boolean;
    liquidityCohortMatch?: string | null;
    reasonCodes: string[];
  }

  function purposeDefaults(purposeName: string | null): { dispositionMode: string | null; activeRealizationFlag: boolean | null } {
    if (purposeName === 'Business') return { dispositionMode: 'active_realization', activeRealizationFlag: true };
    if (purposeName === 'Hybrid') return { dispositionMode: 'selective_realization', activeRealizationFlag: true };
    if (purposeName === 'Personal') return { dispositionMode: 'opportunistic_realization', activeRealizationFlag: false };
    return { dispositionMode: null, activeRealizationFlag: null };
  }

  function makeItemDecisionEvidence(items: BusinessOpenItemFixture[]): unknown {
    return {
      item_decision_evidence: items.map((it) => {
        const defaults = purposeDefaults(it.currentPurposeName);
        return {
          item_id: it.itemId,
          item_display_name: it.itemDisplayName ?? `Test Item ${it.itemId}`,
          brand_id: 1,
          brand_name: 'TestBrand',
          category_id: 1,
          category_name: 'TestCategory',
          type_id: 1,
          type_name: 'TestType',
          model: 'should-never-appear-in-any-finding',
          current_purpose_id: it.currentPurposeName === 'Business' ? 1 : it.currentPurposeName === 'Hybrid' ? 2 : it.currentPurposeName === 'Personal' ? 3 : null,
          current_purpose_name: it.currentPurposeName,
          purpose_policy_status: it.purposePolicyStatus ?? (it.currentPurposeName ? 'mapped' : 'missing_purpose'),
          disposition_mode: it.dispositionMode !== undefined ? it.dispositionMode : defaults.dispositionMode,
          realization_priority_order: it.currentPurposeName === 'Business' ? 1 : it.currentPurposeName === 'Hybrid' ? 2 : it.currentPurposeName === 'Personal' ? 3 : null,
          active_realization_flag: it.activeRealizationFlag !== undefined ? it.activeRealizationFlag : defaults.activeRealizationFlag,
          expected_holding_policy: 'shorter_holding_preferred',
          acquisition_method: 'purchase',
          acquisition_value: it.acquisitionValue ?? null,
          acquisition_value_band_order: 4,
          acquisition_value_band_label: '$1,000-1,999',
          estimated_sold_value: it.estimatedSoldValue ?? null,
          estimated_net_upside: it.estimatedNetUpside ?? null,
          estimated_upside_percent: it.estimatedUpsidePercent ?? null,
          is_historical_import: it.isHistoricalImport ?? false,
          ownership_age_days: it.ownershipAgeDays ?? null,
          listed_flag: it.listedFlag,
          listing_state_basis: 'open_item_with_listing_record',
          listing_channel_count: (it.listingChannelNames ?? []).length,
          listing_channel_names: it.listingChannelNames ?? [],
          first_listed_at: it.listedFlag ? '2026-01-01T00:00:00Z' : null,
          current_dom_days: it.currentDomDays ?? null,
          open_capital_share_percent: it.openCapitalSharePercent ?? null,
          purpose_open_capital_share_percent: it.purposeOpenCapitalSharePercent ?? null,
          economic_cohort: null,
          liquidity_cohort: null,
          liquidity_cohort_match: it.liquidityCohortMatch ?? 'purpose_matched',
          comparable_evidence_available: false,
          reason_codes: it.reasonCodes,
        };
      }),
    };
  }

  function businessEvalFor(
    itemId: number,
    evaluations: ReturnType<typeof evaluateBusinessOpenInventoryPriority>['candidateEvaluations'],
  ) {
    return evaluations.find((e) => e.item_id === itemId);
  }

  // ── B1/B2: correct evidence path is used; there is no shared OIDS
  // evidence section to accidentally read ─────────────────────────────────
  console.log('\n[B1/B2 — correct target-user OIDS evidence path is used; there is no shared OIDS evidence to ignore]');
  {
    const selectFindingsSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/insights/selectFindings.ts'), 'utf8');
    check(
      'selectFindings.ts wires targetUserOpenInventoryEvidence into evaluateBusinessOpenInventoryPriority',
      selectFindingsSource.includes('evaluateBusinessOpenInventoryPriority(input.targetUserOpenInventoryEvidence)'),
    );
    const runnerSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/runAnalytics.ts'), 'utf8');
    check(
      'runAnalytics.ts wires target_user_open_inventory_evidence into selectFindings',
      runnerSource.includes('targetUserOpenInventoryEvidence: snapshot.target_user_open_inventory_evidence'),
    );
    // OIDS has no shared/pooled counterpart anywhere in the Analytics
    // snapshot (confirmed by inspecting every v2.x migration) — the rule
    // source never references any such key.
    const ruleSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/insights/rules/businessOpenInventoryPriority.ts'), 'utf8');
    check(
      'businessOpenInventoryPriority.ts reads item_decision_evidence and never accesses .shared_open_inventory_evidence in code (only mentions it in a comment explaining what does not exist)',
      ruleSource.includes('evidence?.item_decision_evidence') && !ruleSource.toLowerCase().includes('.shared_open_inventory'),
    );
    check(
      'runAnalytics.ts never wires a shared_open_inventory_evidence key (no such section exists in Analytics)',
      !runnerSource.includes('shared_open_inventory_evidence'),
    );
  }

  // ── B3/B30: another user's items are never considered — two separate
  // evaluate() calls (mirroring how runAnalytics scopes evidence per
  // target user) never mix item identities ────────────────────────────────
  console.log('\n[B3/B30 — another user\'s items are never considered; two-user fixture proves no cross-user item leakage]');
  {
    const userAItems: BusinessOpenItemFixture[] = [
      { itemId: 101, itemDisplayName: 'User A Item', currentPurposeName: 'Business', listedFlag: true, acquisitionValue: 2000, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] },
    ];
    const userBItems: BusinessOpenItemFixture[] = [
      { itemId: 202, itemDisplayName: 'User B Item', currentPurposeName: 'Business', listedFlag: true, acquisitionValue: 2500, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] },
    ];
    const { result: resultA } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence(userAItems));
    const { result: resultB } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence(userBItems));
    check('user A\'s result selects only user A\'s own item', resultA.status === 'selected' && resultA.segment.item_id === 101, resultA);
    check('user B\'s result selects only user B\'s own item', resultB.status === 'selected' && resultB.segment.item_id === 202, resultB);
    check(
      'user A\'s result never contains user B\'s item_id anywhere in its serialized form',
      !JSON.stringify(resultA).includes('202'),
      resultA,
    );
    check(
      'user B\'s result never contains user A\'s item_id anywhere in its serialized form',
      !JSON.stringify(resultB).includes('101'),
      resultB,
    );
  }

  // ── B4/B5/B6/B7: only Business active_realization items are eligible;
  // Hybrid and Personal are excluded entirely; missing/unmapped Purpose
  // is ineligible (but still evaluated, since it is text-labeled Business) ─
  console.log('\n[B4/B5/B6/B7 — only Business active_realization items are eligible; Hybrid/Personal excluded; unmapped purpose policy is ineligible]');
  {
    const items: BusinessOpenItemFixture[] = [
      { itemId: 1, currentPurposeName: 'Business', listedFlag: true, reasonCodes: [] },
      { itemId: 2, currentPurposeName: 'Hybrid', listedFlag: true, reasonCodes: [] },
      { itemId: 3, currentPurposeName: 'Personal', listedFlag: false, reasonCodes: [] },
      { itemId: 4, currentPurposeName: 'Business', purposePolicyStatus: 'missing_policy', listedFlag: true, reasonCodes: [] },
    ];
    const { candidateEvaluations } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence(items));
    check('the Business item (1) is eligible', businessEvalFor(1, candidateEvaluations)?.eligible === true, businessEvalFor(1, candidateEvaluations));
    check('the Hybrid item (2) receives no evaluation row at all — never a candidate for this rule', businessEvalFor(2, candidateEvaluations) === undefined, candidateEvaluations);
    check('the Personal item (3) receives no evaluation row at all — never a candidate for this rule', businessEvalFor(3, candidateEvaluations) === undefined, candidateEvaluations);
    const unmapped = businessEvalFor(4, candidateEvaluations);
    check('the Business item with an unmapped purpose policy (4) still receives an evaluation row (it is a Business candidate)', unmapped !== undefined, unmapped);
    check('item 4 is ineligible', unmapped?.eligible === false, unmapped);
    check('item 4 reason includes PURPOSE_POLICY_STATUS_NOT_MAPPED', !!unmapped?.eligibility_failure_reasons.includes('PURPOSE_POLICY_STATUS_NOT_MAPPED'), unmapped);
    check('exactly 2 evaluation rows exist (items 1 and 4 only — Hybrid/Personal never considered)', candidateEvaluations.length === 2, candidateEvaluations);
  }

  // ── B8/B23: each priority profile is recognized correctly, with the
  // correct recommended action code ────────────────────────────────────────
  console.log('\n[B8/B23 — each of the seven priority profiles is recognized correctly, with the correct recommended action code]');
  {
    const profileFixtures: Array<{ item: BusinessOpenItemFixture; expectedProfile: string; expectedAction: string }> = [
      {
        item: { itemId: 1, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
        expectedProfile: 'STALE_HIGH_CAPITAL_LOW_UPSIDE',
        expectedAction: 'REVIEW_PRICE_LISTING_AND_EXIT_PLAN',
      },
      {
        item: { itemId: 2, currentPurposeName: 'Business', listedFlag: false, reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
        expectedProfile: 'UNLISTED_HIGH_CAPITAL_LOW_UPSIDE',
        expectedAction: 'LIST_OR_RECLASSIFY',
      },
      {
        item: { itemId: 3, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE'] },
        expectedProfile: 'STALE_HIGH_CAPITAL',
        expectedAction: 'REFRESH_LISTING_AND_REVIEW_EXIT_PLAN',
      },
      {
        item: { itemId: 4, currentPurposeName: 'Business', listedFlag: false, reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM', 'HIGH_CAPITAL_EXPOSURE'] },
        expectedProfile: 'UNLISTED_HIGH_CAPITAL_OR_AGED',
        expectedAction: 'LIST_OR_RECLASSIFY',
      },
      {
        item: { itemId: 5, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
        expectedProfile: 'STALE_LOW_UPSIDE',
        expectedAction: 'REVIEW_PRICE_AND_EXIT_PLAN',
      },
      {
        item: { itemId: 6, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] },
        expectedProfile: 'STALE_LISTING',
        expectedAction: 'REFRESH_LISTING',
      },
      {
        item: { itemId: 7, currentPurposeName: 'Business', listedFlag: true, ownershipAgeDays: 150, reasonCodes: ['BUSINESS_OWNERSHIP_AGE_120_PLUS'] },
        expectedProfile: 'AGED_BUSINESS_HOLD',
        expectedAction: 'REVIEW_HOLD_OR_EXIT_DECISION',
      },
    ];
    for (const { item, expectedProfile, expectedAction } of profileFixtures) {
      const { candidateEvaluations } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([item]));
      const evalRow = businessEvalFor(item.itemId, candidateEvaluations);
      check(`item ${item.itemId} is assigned profile ${expectedProfile}`, evalRow?.priority_profile === expectedProfile, evalRow);
      check(`item ${item.itemId} maps to action code ${expectedAction}`, evalRow?.recommended_action_code === expectedAction, evalRow);
      check(`item ${item.itemId} is actionable and selected (sole candidate)`, evalRow?.actionable === true && evalRow?.selected === true, evalRow);
    }
  }

  // ── B9: highest matching profile is assigned when multiple profiles
  // match (profile order wins, not the last or a random match) ────────────
  console.log('\n[B9 — the highest (first-in-order) matching profile is assigned when an item matches more than one]');
  {
    // Unlisted + reliable 120+ day age matches BOTH profile 4 (UNLISTED_
    // HIGH_CAPITAL_OR_AGED, via the age branch) and profile 7 (AGED_
    // BUSINESS_HOLD) — profile 4 is checked first and must win.
    const item: BusinessOpenItemFixture = {
      itemId: 1, currentPurposeName: 'Business', listedFlag: false, ownershipAgeDays: 150,
      reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM', 'BUSINESS_OWNERSHIP_AGE_120_PLUS'],
    };
    const { candidateEvaluations } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([item]));
    const evalRow = businessEvalFor(1, candidateEvaluations);
    check('the item matches profile 4 (UNLISTED_HIGH_CAPITAL_OR_AGED), not profile 7', evalRow?.priority_profile === 'UNLISTED_HIGH_CAPITAL_OR_AGED', evalRow);
  }

  // ── B10: no weighted score exists anywhere in the rule ───────────────────
  console.log('\n[B10 — no weighted score exists]');
  {
    const ruleSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/insights/rules/businessOpenInventoryPriority.ts'), 'utf8');
    // Scan CODE lines only (strip full-line comments) — the header/inline
    // comments legitimately say "never a weighted score" in prose; what
    // must never exist is an actual scoring variable or multiplicative
    // accumulation in code.
    const codeOnly = ruleSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const weightedScorePatterns = [/\bscore\s*[:=+]/i, /\bweight(ed)?\s*[:=]/i, /\*\s*0\.\d/, /\+=.*\*/];
    const matched = weightedScorePatterns.filter((p) => p.test(codeOnly)).map((p) => p.source);
    check('no scoring variable or multiplicative accumulation pattern appears in the rule\'s actual code (comments aside)', matched.length === 0, matched);
  }

  // ── B11/B12/B13/B14: single actionable signals alone are correctly
  // insufficient (or, for P75, correctly sufficient) ──────────────────────
  console.log('\n[B11/B12/B13/B14 — UNLISTED_OPEN_ITEM/LOW_ESTIMATED_UPSIDE/DOM_ABOVE_MEDIAN alone never qualify; DOM_ABOVE_P75 alone can qualify a listed item]');
  {
    const unlistedAlone: BusinessOpenItemFixture = { itemId: 1, currentPurposeName: 'Business', listedFlag: false, reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM'] };
    const lowUpsideAlone: BusinessOpenItemFixture = { itemId: 2, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] };
    const domMedianAlone: BusinessOpenItemFixture = { itemId: 3, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN'] };
    const domP75Alone: BusinessOpenItemFixture = { itemId: 4, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };

    const { candidateEvaluations } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([unlistedAlone, lowUpsideAlone, domMedianAlone, domP75Alone]));
    check('UNLISTED_OPEN_ITEM alone does not qualify (newly acquired Business inventory may legitimately be unlisted)', businessEvalFor(1, candidateEvaluations)?.actionable === false, businessEvalFor(1, candidateEvaluations));
    check('LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL alone does not qualify', businessEvalFor(2, candidateEvaluations)?.actionable === false, businessEvalFor(2, candidateEvaluations));
    check('DOM_ABOVE_COMPARABLE_MEDIAN alone does not qualify (supporting evidence only, never independently actionable)', businessEvalFor(3, candidateEvaluations)?.actionable === false, businessEvalFor(3, candidateEvaluations));
    check('DOM_ABOVE_COMPARABLE_P75 alone CAN qualify a listed item (STALE_LISTING)', businessEvalFor(4, candidateEvaluations)?.actionable === true && businessEvalFor(4, candidateEvaluations)?.priority_profile === 'STALE_LISTING', businessEvalFor(4, candidateEvaluations));
  }

  // ── B15/B16/B17: historical listing DOM may be used; historical or
  // null ownership age is never used ───────────────────────────────────────
  console.log('\n[B15/B16/B17 — historical listing DOM may be used; historical and null ownership age are never used for AGED_BUSINESS_HOLD]');
  {
    const historicalStale: BusinessOpenItemFixture = {
      itemId: 1, currentPurposeName: 'Business', listedFlag: true, isHistoricalImport: true,
      reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'],
    };
    // Synthetic edge case: reason_codes erroneously carries the age code
    // despite is_historical_import — the rule must not trust it blindly.
    const historicalAged: BusinessOpenItemFixture = {
      itemId: 2, currentPurposeName: 'Business', listedFlag: true, isHistoricalImport: true, ownershipAgeDays: 150,
      reasonCodes: ['BUSINESS_OWNERSHIP_AGE_120_PLUS'],
    };
    // Synthetic edge case: reason_codes erroneously carries the age code
    // despite a null ownership_age_days.
    const nullAgeAged: BusinessOpenItemFixture = {
      itemId: 3, currentPurposeName: 'Business', listedFlag: true, ownershipAgeDays: null,
      reasonCodes: ['BUSINESS_OWNERSHIP_AGE_120_PLUS'],
    };
    const { candidateEvaluations } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([historicalStale, historicalAged, nullAgeAged]));
    check('a Historical Import listed item with stale DOM still qualifies for STALE_LISTING', businessEvalFor(1, candidateEvaluations)?.actionable === true && businessEvalFor(1, candidateEvaluations)?.priority_profile === 'STALE_LISTING', businessEvalFor(1, candidateEvaluations));
    check('a Historical Import item never qualifies for AGED_BUSINESS_HOLD, even with a present age reason code', businessEvalFor(2, candidateEvaluations)?.actionable === false, businessEvalFor(2, candidateEvaluations));
    check('a null-ownership-age item never qualifies for AGED_BUSINESS_HOLD, even with a present age reason code', businessEvalFor(3, candidateEvaluations)?.actionable === false, businessEvalFor(3, candidateEvaluations));
  }

  // ── B18: a high-capital stale low-upside candidate outranks weaker
  // profiles regardless of secondary metrics ───────────────────────────────
  console.log('\n[B18 — a STALE_HIGH_CAPITAL_LOW_UPSIDE candidate outranks a STALE_LISTING candidate even when the latter has stronger secondary metrics]');
  {
    const strongProfileWeakSecondary: BusinessOpenItemFixture = {
      itemId: 1, currentPurposeName: 'Business', listedFlag: true,
      openCapitalSharePercent: 5, purposeOpenCapitalSharePercent: 5, acquisitionValue: 100,
      reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'],
    };
    const weakProfileStrongSecondary: BusinessOpenItemFixture = {
      itemId: 2, currentPurposeName: 'Business', listedFlag: true,
      openCapitalSharePercent: 90, purposeOpenCapitalSharePercent: 90, acquisitionValue: 999999,
      reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'],
    };
    const { result } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([strongProfileWeakSecondary, weakProfileStrongSecondary]));
    check('item 1 (STALE_HIGH_CAPITAL_LOW_UPSIDE) wins despite far weaker secondary metrics', result.status === 'selected' && result.segment.item_id === 1, result);
  }

  // ── B19/B20: deterministic tie-breakers, including null-last handling ───
  console.log('\n[B19/B20 — deterministic tie-breakers, including null numeric values sorting last]');
  {
    const higherCapitalShare: BusinessOpenItemFixture = { itemId: 1, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 30, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const lowerCapitalShare: BusinessOpenItemFixture = { itemId: 2, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 10, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result: capitalShareResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([lowerCapitalShare, higherCapitalShare]));
    check('the item with the larger open_capital_share_percent wins (30 beats 10)', capitalShareResult.status === 'selected' && capitalShareResult.segment.item_id === 1, capitalShareResult);

    const nullCapitalShare: BusinessOpenItemFixture = { itemId: 3, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: null, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const smallRealCapitalShare: BusinessOpenItemFixture = { itemId: 4, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 1, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result: nullLastResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([nullCapitalShare, smallRealCapitalShare]));
    check('a null open_capital_share_percent sorts after even a small real value (null last, never treated as highest)', nullLastResult.status === 'selected' && nullLastResult.segment.item_id === 4, nullLastResult);

    const fullyTiedA: BusinessOpenItemFixture = { itemId: 20, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 15, purposeOpenCapitalSharePercent: 15, currentDomDays: 40, acquisitionValue: 700, estimatedUpsidePercent: 5, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const fullyTiedB: BusinessOpenItemFixture = { itemId: 21, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 15, purposeOpenCapitalSharePercent: 15, currentDomDays: 40, acquisitionValue: 700, estimatedUpsidePercent: 5, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result: idTieResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([fullyTiedB, fullyTiedA]));
    check('fully tied candidates break on ascending item_id — item 20 beats item 21', idTieResult.status === 'selected' && idTieResult.segment.item_id === 20, idTieResult);
  }

  // ── B21: the winner is not hardcoded ──────────────────────────────────────
  console.log('\n[B21 — the winner is not hardcoded — relabeling the winning signals onto a different item changes the winner]');
  {
    const itemA: BusinessOpenItemFixture = { itemId: 1, itemDisplayName: 'Strong Item', currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 30, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] };
    const itemB: BusinessOpenItemFixture = { itemId: 2, itemDisplayName: 'Weak Item', currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 5, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result: originalResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([itemA, itemB]));
    check('item 1 (the strong signals) wins originally', originalResult.status === 'selected' && originalResult.segment.item_id === 1, originalResult);

    const swappedA: BusinessOpenItemFixture = { ...itemA, itemId: 2, itemDisplayName: 'Now Strong' };
    const swappedB: BusinessOpenItemFixture = { ...itemB, itemId: 1, itemDisplayName: 'Now Weak' };
    const { result: swappedResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([swappedA, swappedB]));
    check('when the strong signals move to item 2, item 2 wins instead — proving no hardcoded winner', swappedResult.status === 'selected' && swappedResult.segment.item_id === 2, swappedResult);
  }

  // ── B22: a runner-up is emitted only when another ACTIONABLE candidate
  // exists (an eligible-but-non-actionable peer never becomes a runner-up) ─
  console.log('\n[B22 — a runner-up is emitted only when another actionable Business candidate exists]');
  {
    const soleActionable: BusinessOpenItemFixture = { itemId: 1, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const eligibleNotActionable: BusinessOpenItemFixture = { itemId: 2, currentPurposeName: 'Business', listedFlag: true, reasonCodes: [] };
    const { result: soleResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([soleActionable, eligibleNotActionable]));
    check('no runner-up appears when only one actionable candidate exists, even alongside an eligible-but-non-actionable peer', soleResult.status === 'selected' && soleResult.runner_up === undefined, soleResult.status === 'selected' ? soleResult.runner_up : soleResult);

    // item 3's real (if small) open_capital_share_percent outranks item
    // 1's null (null sorts last) — item 3 wins, item 1 is the runner-up.
    const secondActionable: BusinessOpenItemFixture = { itemId: 3, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 1, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result: twoActionableResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([soleActionable, secondActionable]));
    check('a runner-up appears when a second actionable candidate exists', twoActionableResult.status === 'selected' && twoActionableResult.runner_up !== undefined, twoActionableResult.status === 'selected' ? twoActionableResult.runner_up : twoActionableResult);
    check(
      'the runner-up carries item_id, item_display_name, priority_profile, recommended_action_code, triggered_reason_codes, and reason_not_selected',
      twoActionableResult.status === 'selected' && twoActionableResult.runner_up?.item_id === 1
        && twoActionableResult.runner_up?.reason_not_selected === 'LOWER_RANKED_BY_DETERMINISTIC_PRIORITY',
      twoActionableResult.status === 'selected' ? twoActionableResult.runner_up : twoActionableResult,
    );
  }

  // ── B24: no exact price recommendation or overreaching claim is ever
  // generated — every profile's summary text is scanned for forbidden
  // phrasing ─────────────────────────────────────────────────────────────
  console.log('\n[B24 — no exact price recommendation, overpriced claim, sale guarantee, or Personal-item mention is ever generated]');
  {
    const allProfileItems: BusinessOpenItemFixture[] = [
      { itemId: 1, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
      { itemId: 2, currentPurposeName: 'Business', listedFlag: false, reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
      { itemId: 3, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE'] },
      { itemId: 4, currentPurposeName: 'Business', listedFlag: false, reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM', 'HIGH_CAPITAL_EXPOSURE'] },
      { itemId: 5, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
      { itemId: 6, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] },
      { itemId: 7, currentPurposeName: 'Business', listedFlag: true, ownershipAgeDays: 150, reasonCodes: ['BUSINESS_OWNERSHIP_AGE_120_PLUS'] },
    ];
    const forbidden = [/\$\d/, /lower the price/i, /overpriced/i, /will sell/i, /market does not want/i, /personal item/i];
    for (const item of allProfileItems) {
      const { result } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([item]));
      if (result.status !== 'selected') {
        check(`item ${item.itemId} produced a selected finding to check its summary`, false, result);
        continue;
      }
      const matched = forbidden.filter((p) => p.test(result.summary)).map((p) => p.source);
      check(`item ${item.itemId}'s summary (profile ${result.priority_profile}) contains no forbidden phrasing`, matched.length === 0, { summary: result.summary, matched });
    }
  }

  // ── B25/B26: existing evidence limitations are preserved and translated;
  // required rule limitations are always present ───────────────────────────
  console.log('\n[B25/B26 — existing evidence limitations are preserved and translated; required rule limitations are always present]');
  {
    const richLimitationsItem: BusinessOpenItemFixture = {
      itemId: 1, currentPurposeName: 'Business', listedFlag: true, isHistoricalImport: true,
      liquidityCohortMatch: 'cross_purpose_fallback',
      reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'LOW_COMPARABLE_CONFIDENCE', 'PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE', 'ZERO_ASSIGNED_ACQUISITION_VALUE'],
    };
    const { result } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([richLimitationsItem]));
    check('result is selected', result.status === 'selected', result);
    if (result.status === 'selected') {
      const requiredAlways = [
        'TARGET_USER_ITEM_LEVEL_EVIDENCE',
        'OPEN_INVENTORY_PRIORITY_IS_DECISION_SUPPORT_NOT_AUTOMATION',
        'ESTIMATED_VALUE_IS_USER_ESTIMATE',
        'LISTING_ACTIVE_STATE_INFERRED',
        'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
        'ITEM_SELECTION_ASSOCIATION_NOT_CAUSATION',
      ];
      check('all six always-required limitations are present', requiredAlways.every((l) => result.limitations.includes(l)), result.limitations);
      check('HISTORICAL_ACQUISITION_DATE_UNRELIABLE is added for a Historical Import', result.limitations.includes('HISTORICAL_ACQUISITION_DATE_UNRELIABLE'), result.limitations);
      check('LOW_COMPARABLE_CONFIDENCE is preserved from evidence', result.limitations.includes('LOW_COMPARABLE_CONFIDENCE'), result.limitations);
      check('PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE is preserved from evidence', result.limitations.includes('PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE'), result.limitations);
      check('ZERO_ASSIGNED_ACQUISITION_VALUE_LIMITS_ECONOMIC_INTERPRETATION is translated from evidence', result.limitations.includes('ZERO_ASSIGNED_ACQUISITION_VALUE_LIMITS_ECONOMIC_INTERPRETATION'), result.limitations);
    }

    const plainItem: BusinessOpenItemFixture = { itemId: 2, currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result: plainResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([plainItem]));
    check(
      'a plain item (no data-quality signals) still carries exactly the six required limitations, nothing conditional',
      plainResult.status === 'selected' && plainResult.limitations.length === 6,
      plainResult.status === 'selected' ? plainResult.limitations : plainResult,
    );
  }

  // ── B27/B28: no-finding behavior — NO_ACTIONABLE_BUSINESS_OPEN_ITEM and
  // EVIDENCE_UNAVAILABLE ───────────────────────────────────────────────────
  console.log('\n[B27/B28 — no actionable candidate yields NO_ACTIONABLE_BUSINESS_OPEN_ITEM; missing evidence yields EVIDENCE_UNAVAILABLE]');
  {
    const noSignalItem: BusinessOpenItemFixture = { itemId: 1, currentPurposeName: 'Business', listedFlag: true, reasonCodes: [] };
    const { result: noActionableResult } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([noSignalItem]));
    check('result is no_eligible_finding', noActionableResult.status === 'no_eligible_finding', noActionableResult);
    check('reason_codes includes NO_ACTIONABLE_BUSINESS_OPEN_ITEM', noActionableResult.status === 'no_eligible_finding' && noActionableResult.reason_codes.includes('NO_ACTIONABLE_BUSINESS_OPEN_ITEM'), noActionableResult);

    const { result: missingEvidenceResult } = evaluateBusinessOpenInventoryPriority({});
    check('missing item_decision_evidence yields EVIDENCE_UNAVAILABLE', missingEvidenceResult.status === 'no_eligible_finding' && missingEvidenceResult.reason_codes.includes('EVIDENCE_UNAVAILABLE'), missingEvidenceResult);
    const { result: undefinedEvidenceResult } = evaluateBusinessOpenInventoryPriority(undefined);
    check('undefined evidence yields EVIDENCE_UNAVAILABLE', undefinedEvidenceResult.status === 'no_eligible_finding' && undefinedEvidenceResult.reason_codes.includes('EVIDENCE_UNAVAILABLE'), undefinedEvidenceResult);
  }

  // ── B29: a representative, production-shaped fixture (multiple Business
  // items with realistic combinations, plus Hybrid/Personal noise) selects
  // exactly one Business item ──────────────────────────────────────────────
  console.log('\n[B29 — representative production-shaped fixture (multiple Business items, varied signal combinations, Hybrid/Personal noise) selects one Business item]');
  {
    const productionShaped: BusinessOpenItemFixture[] = [
      // Stale, high-capital, low-upside — should be the strongest candidate.
      { itemId: 501, itemDisplayName: 'Gibson Custom Murphy Lab', currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 27.3, purposeOpenCapitalSharePercent: 33.55, currentDomDays: 60, acquisitionValue: 5200, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
      // Unlisted, high capital, no upside signal — weaker profile (4).
      { itemId: 502, itemDisplayName: 'Fender Custom Shop', currentPurposeName: 'Business', listedFlag: false, openCapitalSharePercent: 15, purposeOpenCapitalSharePercent: 18, acquisitionValue: 3000, reasonCodes: ['BUSINESS_UNLISTED_OPEN_ITEM', 'HIGH_CAPITAL_EXPOSURE'] },
      // Reliably aged hold, nothing else.
      { itemId: 503, itemDisplayName: 'Vintage Amp', currentPurposeName: 'Business', listedFlag: true, ownershipAgeDays: 200, acquisitionValue: 900, reasonCodes: ['BUSINESS_OWNERSHIP_AGE_120_PLUS'] },
      // Eligible but not actionable (no signals at all).
      { itemId: 504, itemDisplayName: 'New Pedal', currentPurposeName: 'Business', listedFlag: false, acquisitionValue: 200, reasonCodes: [] },
      // Ineligible — unmapped purpose policy.
      { itemId: 505, itemDisplayName: 'Odd Item', currentPurposeName: 'Business', purposePolicyStatus: 'missing_policy', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
      // Noise — Hybrid and Personal items, never candidates for this rule.
      { itemId: 601, itemDisplayName: 'Hybrid Guitar', currentPurposeName: 'Hybrid', listedFlag: false, reasonCodes: ['HYBRID_REVIEW_REQUIRED'] },
      { itemId: 701, itemDisplayName: 'Personal Guitar', currentPurposeName: 'Personal', listedFlag: true, reasonCodes: ['PERSONAL_LISTED_FOR_OPPORTUNISTIC_EXIT'] },
    ];
    const { result, candidateEvaluations } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence(productionShaped));
    check('exactly one finding is selected', result.status === 'selected', result);
    check('the winner is item 501 (STALE_HIGH_CAPITAL_LOW_UPSIDE — the highest-priority profile present)', result.status === 'selected' && result.segment.item_id === 501, result);
    check('the runner-up is item 502 (the next-highest profile among the remaining actionable items)', result.status === 'selected' && result.runner_up?.item_id === 502, result.status === 'selected' ? result.runner_up : result);
    check('exactly 5 evaluation rows exist (Business items only — items 601/701 never considered)', candidateEvaluations.length === 5, candidateEvaluations.map((e) => e.item_id));
    check('item 504 (eligible, no signals) is eligible but not actionable', businessEvalFor(504, candidateEvaluations)?.eligible === true && businessEvalFor(504, candidateEvaluations)?.actionable === false, businessEvalFor(504, candidateEvaluations));
    check('item 505 (unmapped policy) is ineligible', businessEvalFor(505, candidateEvaluations)?.eligible === false, businessEvalFor(505, candidateEvaluations));
  }

  // ── B31/B33: the previous seven aggregate rule families remain
  // identifier-free and byte-identical when the eighth (item-level) rule
  // also fires ──────────────────────────────────────────────────────────
  console.log('\n[B31/B33 — the previous seven rule families remain identifier-free and byte-identical when BUSINESS_OPEN_INVENTORY_PRIORITY also fires]');
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
    const journeyEvidence = makeJourneyEvidence(MARKETPLACE_JOURNEY_FIXTURES) as Record<string, unknown>;
    const dealOutEvidence = makeDealOutChannelEvidence(DEAL_OUT_CHANNEL_FIXTURES) as Record<string, unknown>;
    const dealInEvidence = makeDealInChannelEvidence(DEAL_IN_CHANNEL_FIXTURES) as Record<string, unknown>;
    const combinedDealChannelEvidence = {
      ...journeyEvidence,
      ...dealOutEvidence,
      ...dealInEvidence,
    };
    const listingPlatformEvidence = makeListingPlatformEvidence(LISTING_PLATFORM_FIXTURES);
    const businessOpenInventoryEvidence = makeItemDecisionEvidence([
      { itemId: 901, itemDisplayName: 'Priority Item', currentPurposeName: 'Business', listedFlag: true, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'] },
    ]);

    const { result: directBroad } = evaluateStrongBalancedAcquisitionBand(combinedAcquisitionEvidence);
    const { result: directCategory } = evaluateStrongCategoryAcquisitionBand(categoryEvidence);
    const { result: directMethod } = evaluateAcquisitionMethodPerformanceProfile(combinedAcquisitionEvidence);
    const { result: directJourney } = evaluateStrongDealInToDealOutJourney(combinedDealChannelEvidence);
    const { result: directDealOut } = evaluateStrongDealOutChannel(combinedDealChannelEvidence);
    const { result: directDealIn } = evaluateStrongDealInChannel(combinedDealChannelEvidence);
    const { result: directListingPlatform } = evaluateStrongListingPlatform(listingPlatformEvidence);
    const { result: directBusinessOpenInventory } = evaluateBusinessOpenInventoryPriority(businessOpenInventoryEvidence);

    const insights = selectFindings({
      targetUserAcquisitionEvidence: combinedAcquisitionEvidence,
      targetUserInventorySegmentationEvidence: categoryEvidence,
      targetUserDealChannelEvidence: combinedDealChannelEvidence,
      targetUserListingChannelEvidence: listingPlatformEvidence,
      targetUserOpenInventoryEvidence: businessOpenInventoryEvidence,
    });

    check('all eight rule families are present in one insights payload', insights.selected_findings.length === 8, insights.selected_findings.map((f) => f.finding_code));

    const viaOrchestratorBroad = insights.selected_findings.find((f) => f.finding_code === BROAD_FINDING_CODE);
    const viaOrchestratorCategory = insights.selected_findings.find((f) => f.finding_code === CATEGORY_FINDING_CODE);
    const viaOrchestratorMethod = insights.selected_findings.find((f) => f.finding_code === METHOD_PROFILE_FINDING_CODE);
    const viaOrchestratorJourney = insights.selected_findings.find((f) => f.finding_code === JOURNEY_FINDING_CODE);
    const viaOrchestratorDealOut = insights.selected_findings.find((f) => f.finding_code === DEAL_OUT_CHANNEL_FINDING_CODE);
    const viaOrchestratorDealIn = insights.selected_findings.find((f) => f.finding_code === DEAL_IN_CHANNEL_FINDING_CODE);
    const viaOrchestratorListingPlatform = insights.selected_findings.find((f) => f.finding_code === LISTING_PLATFORM_FINDING_CODE);
    const viaOrchestratorBusinessOpenInventory = insights.selected_findings.find((f) => f.finding_code === BUSINESS_OPEN_INVENTORY_PRIORITY_FINDING_CODE);

    const categoryWithoutRelationship = viaOrchestratorCategory
      ? { ...(viaOrchestratorCategory as SelectedFindingForTest), relationship: undefined, summary: (directCategory as SelectedFindingForTest).summary }
      : viaOrchestratorCategory;

    check('the broad finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorBroad) === JSON.stringify(directBroad), { viaOrchestratorBroad, directBroad });
    check('the category finding (minus orchestrator relationship linking) is byte-identical to calling the rule directly', JSON.stringify(categoryWithoutRelationship) === JSON.stringify(directCategory), { categoryWithoutRelationship, directCategory });
    check('the acquisition-method finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorMethod) === JSON.stringify(directMethod), { viaOrchestratorMethod, directMethod });
    check('the channel-journey finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorJourney) === JSON.stringify(directJourney), { viaOrchestratorJourney, directJourney });
    check('the deal-out-channel finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorDealOut) === JSON.stringify(directDealOut), { viaOrchestratorDealOut, directDealOut });
    check('the deal-in-channel finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorDealIn) === JSON.stringify(directDealIn), { viaOrchestratorDealIn, directDealIn });
    check('the listing-platform finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorListingPlatform) === JSON.stringify(directListingPlatform), { viaOrchestratorListingPlatform, directListingPlatform });
    check('the business-open-inventory-priority finding is byte-identical to calling the rule directly', JSON.stringify(viaOrchestratorBusinessOpenInventory) === JSON.stringify(directBusinessOpenInventory), { viaOrchestratorBusinessOpenInventory, directBusinessOpenInventory });

    const sevenAggregateFindings = [viaOrchestratorBroad, viaOrchestratorCategory, viaOrchestratorMethod, viaOrchestratorJourney, viaOrchestratorDealOut, viaOrchestratorDealIn, viaOrchestratorListingPlatform];
    const aggregateSerialized = JSON.stringify(sevenAggregateFindings);
    check(
      'none of the previous seven (aggregate) findings contain an item_id field anywhere',
      !/"item_id"/i.test(aggregateSerialized),
      sevenAggregateFindings,
    );

    const sevenCodesWithoutTheEighth = insights.selected_findings
      .filter((f) => f.finding_code !== BUSINESS_OPEN_INVENTORY_PRIORITY_FINDING_CODE)
      .map((f) => f.finding_code)
      .sort();
    const expectedSevenCodes = [BROAD_FINDING_CODE, CATEGORY_FINDING_CODE, METHOD_PROFILE_FINDING_CODE, JOURNEY_FINDING_CODE, DEAL_OUT_CHANNEL_FINDING_CODE, DEAL_IN_CHANNEL_FINDING_CODE, LISTING_PLATFORM_FINDING_CODE].sort();
    check(
      'filtering BUSINESS_OPEN_INVENTORY_PRIORITY back out reproduces exactly the previous seven finding_codes',
      JSON.stringify(sevenCodesWithoutTheEighth) === JSON.stringify(expectedSevenCodes),
      sevenCodesWithoutTheEighth,
    );
  }

  // ── B32: the new item-level finding contains only the allowed
  // target-item identity — nothing else ─────────────────────────────────
  console.log('\n[B32 — the business-open-inventory-priority finding contains only the allowed target-item identity fields]');
  {
    const item: BusinessOpenItemFixture = {
      itemId: 1, currentPurposeName: 'Business', listedFlag: true,
      listingChannelNames: ['Marketplace'],
      reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75', 'HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL'],
    };
    const secondItem: BusinessOpenItemFixture = { itemId: 2, currentPurposeName: 'Business', listedFlag: true, openCapitalSharePercent: 1, reasonCodes: ['BUSINESS_DOM_ABOVE_COMPARABLE_P75'] };
    const { result } = evaluateBusinessOpenInventoryPriority(makeItemDecisionEvidence([item, secondItem]));
    if (result.status !== 'selected') {
      check('B32 setup produced a selected finding', false, result);
    } else {
      const allowedKeysByPath: Record<string, string[]> = {
        root: ['finding_code', 'family', 'direction', 'status', 'headline', 'summary', 'segment', 'metrics', 'priority_profile', 'recommended_action_code', 'triggered_reason_codes', 'limitations', 'evidence_refs', 'runner_up'],
        segment: ['item_id', 'item_display_name', 'brand_name', 'category_name', 'type_name', 'current_purpose_name', 'disposition_mode'],
        metrics: [
          'listed_flag', 'listing_channel_names', 'acquisition_value', 'estimated_sold_value', 'estimated_net_upside',
          'estimated_upside_percent', 'current_dom_days', 'reliable_ownership_age_days', 'open_capital_share_percent', 'purpose_open_capital_share_percent',
        ],
        runner_up: ['item_id', 'item_display_name', 'priority_profile', 'recommended_action_code', 'triggered_reason_codes', 'reason_not_selected'],
      };

      const unexpectedKeys: string[] = [];
      const walk = (value: unknown, pathKey: string): void => {
        if (Array.isArray(value)) return;
        if (typeof value !== 'object' || value === null) return;
        const allowed = allowedKeysByPath[pathKey];
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (allowed && !allowed.includes(key)) unexpectedKeys.push(`${pathKey}.${key}`);
          const nextPathKey = key === 'segment' ? 'segment' : key === 'metrics' ? 'metrics' : key === 'runner_up' ? 'runner_up' : key;
          walk((value as Record<string, unknown>)[key], nextPathKey);
        }
      };
      walk(result, 'root');

      check('no unexpected keys appear anywhere in the finding (only the explicitly allowed target-item identity fields)', unexpectedKeys.length === 0, unexpectedKeys);

      const serialized = JSON.stringify(result);
      const forbiddenPatterns = [/"user_id"/i, /"email"/i, /"notes"/i, /"model"/i, /"serial/i, /"counterparty/i, /"contact/i, /"listing_text"/i, /"photo/i, /"storage_path/i, /"brand_id"/i, /"category_id"/i, /"type_id"/i];
      const matched = forbiddenPatterns.filter((p) => p.test(serialized)).map((p) => p.source);
      check('the finding contains no user_id, email, notes, model, serial number, counterparty, listing text, photo/storage path, or classification IDs', matched.length === 0, matched);
      check('item_id and item_display_name ARE present (the deliberate exception for this item-level rule)', typeof result.segment.item_id === 'number' && typeof result.segment.item_display_name === 'string', result.segment);
    }
  }

  // ── B34: previous Insights Engine snapshots (no business-open-inventory
  // rule) remain readable ──────────────────────────────────────────────────
  console.log('\n[B34 — previous Insights Engine v1.6-shaped snapshot (no business-open-inventory-priority finding) remains readable]');
  {
    const baseSnapshot: Record<string, unknown> = {
      snapshot_schema_version: '2.11',
      analytics_definition_version: '2.11',
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

    const v16ShapedInsights = {
      insights_engine_version: '1.6',
      findings_selector_version: '1.6',
      source_analytics_version: '2.11',
      generated_at: new Date().toISOString(),
      selected_findings: [
        {
          finding_code: LISTING_PLATFORM_FINDING_CODE,
          family: 'listing_platform_performance',
          direction: 'strength',
          status: 'selected',
          headline: 'Marketplace is a strong, balanced listing platform',
          summary: 'placeholder v1.6-shaped summary',
          segment: { listing_channel_id: 1, listing_channel_name: 'Marketplace' },
          metrics: {
            exposed_item_count: 20, realized_exposed_item_count: 16, realization_rate_percent: 80,
            median_net_profit: 700, median_roi: 30, channel_listing_to_exit_sample_size: 16,
            median_channel_listing_to_exit_days: 10, channel_listing_to_exit_coverage_percent: 100,
            invalid_channel_listing_after_exit_count: 0, missing_channel_listing_to_exit_count: 0,
          },
          baseline: { type: 'peer_listing_platform_median_baseline', median_net_profit: 500, median_roi: 20, median_channel_listing_to_exit_days: 20, realization_rate_percent: 60 },
          triggered_rules: ['PROFIT_ABOVE_PEER_BASELINE', 'ROI_ABOVE_PEER_BASELINE', 'LISTING_TO_EXIT_FASTER_THAN_PEER_BASELINE', 'REALIZATION_ABOVE_PEER_BASELINE', 'NO_MATERIAL_WEAKNESS'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_PLATFORM_METRICS'],
          evidence_refs: ['target_user_listing_channel_evidence.performance_by_listing_channel'],
          // No business-open-inventory-priority finding at all — this is
          // the v1.6 shape.
        },
      ],
      rule_evaluations: [],
    };
    const v16Snapshot = { ...baseSnapshot, insights: v16ShapedInsights };

    check('a stored v2.11 snapshot carrying an Insights Engine v1.6-shaped insights section still validates', isValidAnalyticsSnapshot(v16Snapshot));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
