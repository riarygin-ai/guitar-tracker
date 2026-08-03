/**
 * test-insights-engine.ts
 *
 * Focused, framework-free tests for Insights Engine v1.0's first Findings
 * Selector rule (STRONG_BALANCED_ACQUISITION_BAND) — same "tsx script, no
 * jest/vitest" convention as scripts/test-analytics-runner.ts, but this one
 * needs no Supabase instance at all: every rule under test is a pure
 * function of hand-built evidence fixtures shaped exactly like Analytics
 * v2.10's target_user_acquisition_evidence (see
 * supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql,
 * CTEs m1t_band_rows / m2t_band_rows). No production data, no database
 * connection, nothing destructive.
 *
 * Usage:
 *   npx tsx scripts/test-insights-engine.ts
 */

import fs from 'fs';
import path from 'path';
import {
  evaluateStrongBalancedAcquisitionBand,
  FINDING_CODE,
} from '../src/lib/analytics/insights/rules/strongBalancedAcquisitionBand';
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
    const withInsights = { ...baseSnapshot, insights: selectFindings(baseSnapshot.target_user_acquisition_evidence) };
    check('the same snapshot plus the new optional insights section still validates', isValidAnalyticsSnapshot(withInsights));
  }

  // ── Test 13: target-user evidence is used, never shared evidence ────────
  console.log('\n[Test 13 — runner wires target-user evidence into the engine, not shared]');
  {
    const runnerSource = fs.readFileSync(path.join(__dirname, '../src/lib/analytics/runAnalytics.ts'), 'utf8');
    check(
      'runAnalytics.ts calls selectFindings with target_user_acquisition_evidence',
      runnerSource.includes('selectFindings(snapshot.target_user_acquisition_evidence)'),
    );
    check(
      'runAnalytics.ts does not feed shared_acquisition_evidence into selectFindings',
      !/selectFindings\(\s*snapshot\.shared_acquisition_evidence/.test(runnerSource),
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
