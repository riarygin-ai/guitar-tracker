// Pattern Discovery Engine v1.0 — deterministic headline/summary templates.
// No LLM, no external API — every string is built by plain interpolation
// from already-computed evidence. Never uses: best, worst, guaranteed,
// optimal, proven, causes, "should buy", "should sell", avoid, or any
// other recommendation/action language — these are descriptive discovered
// associations, not automated business actions.

import type { MetricEffect, PatternType } from './types';
import type { ConfirmedTierMetricDiagnosis } from './evaluateCandidate';
import { CONFIRMED_MIN_METRIC_SAMPLE, CONFIRMED_MIN_PEER_SEGMENTS, BINARY_EXCEPTION_MIN_SAMPLE } from './thresholds';
import { formatCurrency, formatRoiPercent, formatDays, formatCount, formatPeerSegmentCount, joinWithAnd } from './formatting';

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

// Formats a raw metric number for display ONLY — never mutates the
// underlying metric_effects value itself (candidate_value/peer_baseline_
// median/advantage_value/relative_advantage_percent all stay full-
// precision everywhere except inside these returned strings). See
// formatting.ts for the shared rounding/trimming rules.
function formatMetricNumber(metric: MetricEffect['metric_code'], value: number): string {
  if (metric === 'median_net_profit') return formatCurrency(value);
  if (metric === 'median_roi') return formatRoiPercent(value);
  return formatDays(value);
}

function formatMetricValue(effect: MetricEffect): string {
  if (effect.candidate_value === null) return 'unavailable';
  return formatMetricNumber(effect.metric_code, effect.candidate_value);
}

function formatPeerBaseline(effect: MetricEffect): string {
  if (effect.peer_baseline_median === null) return 'unavailable';
  return formatMetricNumber(effect.metric_code, effect.peer_baseline_median);
}

function describeTriggeredEffect(effect: MetricEffect): string {
  const label = METRIC_LABEL[effect.metric_code];
  const verb = effect.direction === 'improvement' ? 'stronger than' : 'weaker than';
  return (
    `Candidate ${label} is ${formatMetricValue(effect)} (n=${formatCount(effect.candidate_sample_size)}), ` +
    `${verb} the eligible peer baseline of ${formatPeerBaseline(effect)} ` +
    `(median of ${formatPeerSegmentCount(effect.peer_eligible_segment_count)}, minimum peer sample n=${formatCount(effect.peer_minimum_sample_size ?? 0)}).`
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

const METRIC_SHORT_LABEL: Record<MetricEffect['metric_code'], string> = {
  median_net_profit: 'profit',
  median_roi: 'ROI',
  median_days_on_market: 'DOM',
};

/**
 * Builds deterministic, factually-accurate confirmation_needed messages
 * from the row's own per-metric confirmed-tier blocker diagnoses (see
 * evaluateCandidate.ts's diagnoseConfirmedTierMetricBlocker) — never a
 * generic "needs more items" message keyed off evidence_confidence,
 * realized_item_count, hypothesis status, or peer weakness alone. Fixed,
 * stable order: (1) candidate metric samples, (2) peer metric samples,
 * (3) peer segment count, (4) classification. Each category contributes
 * at most one message, so duplicates are structurally impossible.
 */
export function buildConfirmationNeeded(diagnoses: ConfirmedTierMetricDiagnosis[], confirmedTierDidNotClassify: boolean): string[] {
  const messages: string[] = [];

  const candidateBlocked = diagnoses.filter((d) => d.category === 'candidate_sample');
  const peerSampleBlocked = diagnoses.filter((d) => d.category === 'peer_sample');
  const peerCountBlocked = diagnoses.filter((d) => d.category === 'peer_count');

  // (1) Candidate metric samples — only when a material metric's OWN
  // sample is below the confirmed floor. Never fires when every material
  // candidate metric sample is already >= 6.
  if (candidateBlocked.length > 0) {
    const metricNames = candidateBlocked.map((d) => METRIC_SHORT_LABEL[d.metric_code]);
    const sampleList = candidateBlocked.map((d) => `${METRIC_SHORT_LABEL[d.metric_code]} n=${formatCount(d.candidate_sample_size)}`).join(', ');
    messages.push(
      `More completed items are needed for this segment's ${joinWithAnd(metricNames)} evidence to reach the confirmed threshold of ` +
        `n=${CONFIRMED_MIN_METRIC_SAMPLE} (current samples: ${sampleList}).`,
    );
  }

  // (2) Peer metric samples — enough distinct peer segments exist, but too
  // few individually reach the confirmed sample floor.
  if (peerSampleBlocked.length > 0) {
    const metricNames = peerSampleBlocked.map((d) => METRIC_SHORT_LABEL[d.metric_code]);
    const minSample = Math.min(...peerSampleBlocked.map((d) => d.min_eligible_peer_sample_at_hypothesis_tier ?? 0));
    const anyBinary = peerSampleBlocked.some((d) => d.is_binary_family);
    const threshold = anyBinary ? BINARY_EXCEPTION_MIN_SAMPLE : CONFIRMED_MIN_METRIC_SAMPLE;
    const binaryNote = anyBinary
      ? ` (this is a binary-comparison family — both segments must also reach confidence 'stronger')`
      : '';
    messages.push(
      `More completed items are needed in eligible peer segments for ${joinWithAnd(metricNames)} to reach the confirmed peer threshold of ` +
        `n=${threshold}${binaryNote} (current minimum peer sample n=${formatCount(minSample)}).`,
    );
  }

  // (3) Peer segment count — not enough DISTINCT peer segments exist at
  // all, even at the loosest (hypothesis) sample floor.
  if (peerCountBlocked.length > 0) {
    const minCount = Math.min(...peerCountBlocked.map((d) => d.eligible_peer_count_at_hypothesis_tier));
    const anyBinary = peerCountBlocked.some((d) => d.is_binary_family);
    const requirementNote = anyBinary
      ? `1 required with both segments reaching sample size >= ${BINARY_EXCEPTION_MIN_SAMPLE} and confidence 'stronger' (2 required otherwise)`
      : `${CONFIRMED_MIN_PEER_SEGMENTS} required`;
    messages.push(
      `More eligible peer segments are needed to establish a confirmed leave-one-out baseline (currently ${formatPeerSegmentCount(minCount)}; ${requirementNote}).`,
    );
  }

  // (4) Classification — every material metric already satisfies the
  // confirmed tier's candidate+peer requirements, but the confirmed-tier
  // signal set still doesn't map to one of the 7 supported pattern types
  // (a tighter, confirmed-only peer pool can shift a baseline enough to
  // change materiality even when every sample/count check passes). Never
  // claims more data will necessarily resolve this.
  if (candidateBlocked.length === 0 && peerSampleBlocked.length === 0 && peerCountBlocked.length === 0 && confirmedTierDidNotClassify) {
    messages.push('The current confirmed-tier metric signals do not yet form one of the supported confirmed pattern profiles.');
  }

  return messages;
}
