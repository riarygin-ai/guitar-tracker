// Pattern Discovery Engine v1.0 — deterministic headline/summary templates.
// No LLM, no external API — every string is built by plain interpolation
// from already-computed evidence. Never uses: best, worst, guaranteed,
// optimal, proven, causes, "should buy", "should sell", avoid, or any
// other recommendation/action language — these are descriptive discovered
// associations, not automated business actions.

import type { MetricEffect, PatternDiscoveryCandidateSegment, PatternType } from './types';

// ── Segment identity phrase — one small switch per novel family, since
// each family's `segment` object carries different label fields. Never
// reads item-level identity (segment already carries only aggregate
// category/type/brand/band/method labels, per Analytics v2.13's own
// privacy contract). ──────────────────────────────────────────────────

export function describeSegment(familyCode: string, segment: Record<string, unknown>): string {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

  switch (familyCode) {
    case 'CATEGORY':
      return `the ${str(segment.category_name) ?? 'uncategorized'} category`;
    case 'TYPE_WITHIN_CATEGORY':
      return `the ${str(segment.type_name) ?? 'unspecified'} type within the ${str(segment.category_name) ?? 'uncategorized'} category`;
    case 'BRAND_WITHIN_CATEGORY':
      return `the ${str(segment.brand_name) ?? 'unspecified'} brand within the ${str(segment.category_name) ?? 'uncategorized'} category`;
    case 'TYPE_ACQUISITION_VALUE_BAND':
      return `the ${str(segment.acquisition_value_band_label) ?? 'this'} acquisition-value band within the ${str(segment.type_name) ?? 'unspecified'} type`;
    case 'EXIT_METHOD':
      return `the ${str(segment.exit_method) ?? 'this'} exit method`;
    default:
      return 'this segment';
  }
}

const METRIC_LABEL: Record<MetricEffect['metric_code'], string> = {
  median_net_profit: 'realized net profit',
  median_roi: 'realized ROI',
  median_days_on_market: 'realized days on market',
};

function formatMetricValue(effect: MetricEffect): string {
  if (effect.candidate_value === null) return 'unavailable';
  if (effect.metric_code === 'median_net_profit') return `CAD $${effect.candidate_value}`;
  if (effect.metric_code === 'median_roi') return `${effect.candidate_value}%`;
  return `${effect.candidate_value} days`;
}

function formatPeerBaseline(effect: MetricEffect): string {
  if (effect.peer_baseline_median === null) return 'unavailable';
  if (effect.metric_code === 'median_net_profit') return `CAD $${effect.peer_baseline_median}`;
  if (effect.metric_code === 'median_roi') return `${effect.peer_baseline_median}%`;
  return `${effect.peer_baseline_median} days`;
}

function describeTriggeredEffect(effect: MetricEffect): string {
  const label = METRIC_LABEL[effect.metric_code];
  const verb = effect.direction === 'improvement' ? 'stronger than' : 'weaker than';
  return (
    `Candidate ${label} is ${formatMetricValue(effect)} (n=${effect.candidate_sample_size}), ` +
    `${verb} the eligible peer baseline of ${formatPeerBaseline(effect)} ` +
    `(median of ${effect.peer_eligible_segment_count} eligible peer segments, minimum peer sample n=${effect.peer_minimum_sample_size}).`
  );
}

const STRENGTH_SENTENCE = 'This segment shows materially stronger realized economics relative to eligible peer segments.';
const WEAKNESS_SENTENCE = 'This segment shows materially weaker realized economics relative to eligible peer segments.';
const SPEED_STRENGTH_SENTENCE =
  'This segment shows materially faster realized listing-to-exit timing without an economic penalty relative to eligible peer segments.';
const SPEED_WEAKNESS_SENTENCE =
  'This segment shows materially slower realized listing-to-exit timing without an offsetting economic gain relative to eligible peer segments.';
const CAUSATION_DISCLAIMER =
  'This reflects a descriptive statistical association, not a causal relationship — realized outcomes may be influenced by factors outside this evidence.';

function tradeoffSentence(profit: MetricEffect, roi: MetricEffect, dom: MetricEffect): string {
  const economicImproving = profit.direction === 'improvement' || roi.direction === 'improvement';
  if (economicImproving) {
    const economicLabel = roi.direction === 'improvement' ? 'ROI' : 'net profit';
    return `This segment shows stronger ${economicLabel} but slower realized listing-to-exit timing relative to eligible peer segments.`;
  }
  const economicLabel = roi.direction === 'weakness' ? 'ROI' : 'net profit';
  return `This segment shows weaker ${economicLabel} but faster realized listing-to-exit timing relative to eligible peer segments.`;
}

function headlineFor(patternType: PatternType, segmentLabel: string): string {
  switch (patternType) {
    case 'BALANCED_STRENGTH':
      return `${segmentLabel} shows a materially stronger, balanced realized-economics profile relative to eligible peer segments`;
    case 'ECONOMIC_ADVANTAGE':
      return `${segmentLabel} shows materially stronger realized profit and ROI relative to eligible peer segments`;
    case 'SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY':
      return `${segmentLabel} shows materially faster realized listing-to-exit timing relative to eligible peer segments`;
    case 'BALANCED_WEAKNESS':
      return `${segmentLabel} shows a materially weaker, balanced realized-economics profile relative to eligible peer segments`;
    case 'ECONOMIC_WEAKNESS':
      return `${segmentLabel} shows materially weaker realized profit and ROI relative to eligible peer segments`;
    case 'SLOW_WITHOUT_ECONOMIC_COMPENSATION':
      return `${segmentLabel} shows materially slower realized listing-to-exit timing relative to eligible peer segments`;
    case 'ECONOMICS_SPEED_TRADEOFF':
      return `${segmentLabel} shows a realized economics-versus-speed tradeoff relative to eligible peer segments`;
  }
}

export function buildHeadline(familyCode: string, segment: Record<string, unknown>, patternType: PatternType): string {
  return headlineFor(patternType, capitalize(describeSegment(familyCode, segment)));
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function buildSummary(
  familyCode: string,
  segment: Record<string, unknown>,
  patternType: PatternType,
  metricEffects: MetricEffect[],
  triggeredSignals: string[],
  isHypothesis: boolean,
): string {
  const segmentLabel = describeSegment(familyCode, segment);
  const triggeredEffects = metricEffects.filter((e) => e.materiality);
  const profit = metricEffects.find((e) => e.metric_code === 'median_net_profit')!;
  const roi = metricEffects.find((e) => e.metric_code === 'median_roi')!;
  const dom = metricEffects.find((e) => e.metric_code === 'median_days_on_market')!;

  const parts: string[] = [];
  parts.push(`For ${segmentLabel}, ${triggeredSignals.length} of ${metricEffects.length} evaluated metrics show a material signal.`);
  for (const effect of triggeredEffects) {
    parts.push(describeTriggeredEffect(effect));
  }

  switch (patternType) {
    case 'BALANCED_STRENGTH':
    case 'ECONOMIC_ADVANTAGE':
    case 'SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY':
      parts.push(STRENGTH_SENTENCE);
      if (patternType === 'SPEED_ADVANTAGE_WITHOUT_ECONOMIC_PENALTY') parts.push(SPEED_STRENGTH_SENTENCE);
      break;
    case 'BALANCED_WEAKNESS':
    case 'ECONOMIC_WEAKNESS':
    case 'SLOW_WITHOUT_ECONOMIC_COMPENSATION':
      parts.push(WEAKNESS_SENTENCE);
      if (patternType === 'SLOW_WITHOUT_ECONOMIC_COMPENSATION') parts.push(SPEED_WEAKNESS_SENTENCE);
      break;
    case 'ECONOMICS_SPEED_TRADEOFF':
      parts.push(tradeoffSentence(profit, roi, dom));
      break;
  }

  parts.push(CAUSATION_DISCLAIMER);

  if (isHypothesis) {
    parts.push('This is a preliminary hypothesis and requires more completed items before it should influence business decisions.');
  }

  return parts.join(' ');
}

export function candidatePatternCode(patternType: PatternType, patternKey: string): string {
  return `DISCOVERY|${patternType}|${patternKey}`;
}

export function buildConfirmationNeeded(candidate: PatternDiscoveryCandidateSegment): string[] {
  return [
    `More realized items in ${candidate.pattern_key} (currently n=${candidate.realized_item_count}) before this can reach confirmed-pattern sample thresholds.`,
    'More eligible peer segments in the same peer group before a confirmed leave-one-out peer baseline can be established.',
  ];
}
