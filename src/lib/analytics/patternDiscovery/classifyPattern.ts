// Pattern Discovery Engine v1.0 — deterministic pattern classification.
// Pure function of three already-computed metric effects — never re-reads
// evidence, never uses a weighted score. Classifies ONLY from confirmed
// (material) metric effects; a metric that is 'neutral' or 'unavailable'
// never contributes to a classification.
//
// ── Precedence, and why ──────────────────────────────────────────────────
// Several of the task's seven pattern-type definitions structurally
// overlap when read literally (e.g. "profit improvement + ROI improvement
// + DOM neutral" satisfies BOTH ECONOMIC_ADVANTAGE's own definition AND
// BALANCED_STRENGTH's "at least two improvements, no weaknesses, profit or
// ROI among them"). This function resolves every such overlap with a
// fixed, documented precedence so classification is single-valued and
// deterministic:
//
//   1. ECONOMIC_ADVANTAGE / ECONOMIC_WEAKNESS — claims the narrow "both
//      economic metrics agree, DOM says nothing (neutral/unavailable)"
//      slice first, since these are the most specific two-metric-only
//      definitions.
//   2. BALANCED_STRENGTH / BALANCED_WEAKNESS — claims every remaining
//      case with >= 2 same-direction signals (this can now only mean DOM
//      is ALSO material alongside at least one economic metric, since the
//      pure "both economics agree, DOM neutral" case was already claimed
//      by step 1).
//   3. SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY / SLOW_WITHOUT_ECONOMIC_
//      COMPENSATION — claims the remaining "DOM alone is material,
//      economics are non-opposing" slice (the cases where an economic
//      metric was ALSO material in the same direction were already
//      claimed by step 2).
//   4. ECONOMICS_SPEED_TRADEOFF — by elimination, the only cases left
//      matching its own opposing-direction definition are genuine
//      opposing-direction cases (an economic signal and DOM disagree).
//
// Under this ordering every one of the 7 types claims a mutually exclusive
// slice of the input space — no candidate can ever satisfy two different
// types' literal definitions at once. A candidate whose material signals
// don't fit any of the 7 shapes (e.g. a single economic-only weakness with
// no ROI/DOM signal, or a "profit weak, ROI strong, DOM neutral" mixed
// case) simply returns null — the 7 types are not required to be
// exhaustive of every possible combination.

import type { MetricEffect, PatternDirection, PatternType } from './types';

export interface Classification {
  pattern_type: PatternType;
  direction: PatternDirection;
}

interface EffectsByMetric {
  profit: MetricEffect;
  roi: MetricEffect;
  dom: MetricEffect;
}

function indexEffects(effects: MetricEffect[]): EffectsByMetric {
  const profit = effects.find((e) => e.metric_code === 'median_net_profit')!;
  const roi = effects.find((e) => e.metric_code === 'median_roi')!;
  const dom = effects.find((e) => e.metric_code === 'median_days_on_market')!;
  return { profit, roi, dom };
}

function isImprovement(e: MetricEffect): boolean {
  return e.direction === 'improvement';
}

function isWeakness(e: MetricEffect): boolean {
  return e.direction === 'weakness';
}

function isNeutralOrUnavailable(e: MetricEffect): boolean {
  return e.direction === 'neutral' || e.direction === 'unavailable';
}

export function classifyPattern(metricEffects: MetricEffect[]): Classification | null {
  const { profit, roi, dom } = indexEffects(metricEffects);

  // ── 1. ECONOMIC_ADVANTAGE / ECONOMIC_WEAKNESS ───────────────────────────
  if (isImprovement(profit) && isImprovement(roi) && isNeutralOrUnavailable(dom)) {
    return { pattern_type: 'ECONOMIC_ADVANTAGE', direction: 'strength' };
  }
  if (isWeakness(profit) && isWeakness(roi) && isNeutralOrUnavailable(dom)) {
    return { pattern_type: 'ECONOMIC_WEAKNESS', direction: 'weakness' };
  }

  // ── 2. BALANCED_STRENGTH / BALANCED_WEAKNESS ────────────────────────────
  const improvementCount = [profit, roi, dom].filter(isImprovement).length;
  const weaknessCount = [profit, roi, dom].filter(isWeakness).length;

  if (improvementCount >= 2 && weaknessCount === 0 && (isImprovement(profit) || isImprovement(roi))) {
    return { pattern_type: 'BALANCED_STRENGTH', direction: 'strength' };
  }
  if (weaknessCount >= 2 && improvementCount === 0 && (isWeakness(profit) || isWeakness(roi))) {
    return { pattern_type: 'BALANCED_WEAKNESS', direction: 'weakness' };
  }

  // ── 3. SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY / SLOW_WITHOUT_ECONOMIC_
  // COMPENSATION ──────────────────────────────────────────────────────────
  const atLeastOneEconomicEligible = profit.available || roi.available;

  if (isImprovement(dom) && !isWeakness(profit) && !isWeakness(roi) && atLeastOneEconomicEligible) {
    return { pattern_type: 'SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY', direction: 'strength' };
  }
  if (isWeakness(dom) && !isImprovement(profit) && !isImprovement(roi) && atLeastOneEconomicEligible) {
    return { pattern_type: 'SLOW_WITHOUT_ECONOMIC_COMPENSATION', direction: 'weakness' };
  }

  // ── 4. ECONOMICS_SPEED_TRADEOFF ─────────────────────────────────────────
  // Requires an economic signal and DOM to disagree — by construction this
  // is always >= 2 material signals (one economic + DOM), satisfying the
  // task's "at least two material signals to qualify as a tradeoff".
  const economicImprovementVsDomWeakness = (isImprovement(profit) || isImprovement(roi)) && isWeakness(dom);
  const economicWeaknessVsDomImprovement = (isWeakness(profit) || isWeakness(roi)) && isImprovement(dom);
  if (economicImprovementVsDomWeakness || economicWeaknessVsDomImprovement) {
    return { pattern_type: 'ECONOMICS_SPEED_TRADEOFF', direction: 'tradeoff' };
  }

  return null;
}
