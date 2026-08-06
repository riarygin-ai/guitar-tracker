// Auditable AI Advice v1.0 — centralized, safe presentation helpers for the
// advice UI (History advice column, Run Detail AI Advice / Deterministic
// Sources Used sections, Dashboard). Numeric formatting (currency/percent/
// percentage-points/days/counts) is REUSED from the Pattern Discovery
// module rather than reimplemented — same rounding/trimming rules, one
// source of truth. Rules everywhere in this file:
//   - null/undefined means unavailable — never rendered as 0 or "—0".
//   - a real numeric 0 is always shown as 0, never treated as "empty".
//   - unknown enum/reason codes fall back to a readable, non-crashing
//     humanization instead of throwing or rendering "undefined".
//   - never mutates the value it was given — every function here returns a
//     new string, the source object/number is untouched.

import { formatCurrency, formatRoiPercent, formatPercentagePoints, formatDays, formatCount } from '@/lib/analytics/patternDiscovery/formatting';
import type { AdviceCardType, AdvicePriority, AdviceStatus } from './types';

export { formatCurrency, formatRoiPercent, formatPercentagePoints, formatDays, formatCount };

const UNAVAILABLE = '—';

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return UNAVAILABLE;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return UNAVAILABLE;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return UNAVAILABLE;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return UNAVAILABLE;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Enum / status humanizers — every one has an explicit fallback so an
// unrecognized value never crashes rendering, it just shows the raw code. ─

const ADVICE_STATUS_LABELS: Record<AdviceStatus, string> = {
  pending: 'Pending',
  generating: 'Generating',
  completed: 'Completed',
  failed: 'Failed',
};

export function formatAdviceStatus(status: string | null | undefined): string {
  if (!status) return 'No advice';
  return (ADVICE_STATUS_LABELS as Record<string, string>)[status] ?? humanizeCode(status);
}

const PRIORITY_LABELS: Record<AdvicePriority, string> = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
};

export function formatPriority(priority: string | null | undefined): string {
  if (!priority) return UNAVAILABLE;
  return (PRIORITY_LABELS as Record<string, string>)[priority] ?? humanizeCode(priority);
}

const ADVICE_TYPE_LABELS: Record<AdviceCardType, string> = {
  action: 'Action',
  observation: 'Observation',
  watch: 'Watch',
  review: 'Review',
};

export function formatAdviceType(type: string | null | undefined): string {
  if (!type) return UNAVAILABLE;
  return (ADVICE_TYPE_LABELS as Record<string, string>)[type] ?? humanizeCode(type);
}

const CONFIDENCE_LABELS: Record<string, string> = {
  stronger: 'Stronger',
  moderate: 'Moderate',
  low: 'Low',
  preliminary: 'Preliminary',
  insufficient: 'Insufficient',
};

/** null explicitly means "no peer-compared confidence tier exists for
 *  this source" (e.g. a single-item Business/Hybrid priority finding) —
 *  distinct from an unrecognized string, which still gets a readable
 *  fallback rather than crashing. */
export function formatConfidence(confidence: string | null | undefined): string {
  if (confidence === null || confidence === undefined) return 'Not applicable';
  return CONFIDENCE_LABELS[confidence] ?? humanizeCode(confidence);
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  deterministic_insight: 'Deterministic Insight',
  confirmed_pattern: 'Confirmed Pattern',
  preliminary_hypothesis: 'Preliminary Hypothesis',
};

export function formatSourceType(sourceType: string | null | undefined): string {
  if (!sourceType) return UNAVAILABLE;
  return SOURCE_TYPE_LABELS[sourceType] ?? humanizeCode(sourceType);
}

/** Generic fallback for any UPPER_SNAKE_CASE or lower_snake_case reason/
 *  error code this feature surfaces (error_code, ineligibility_reasons,
 *  limitations, etc.) — "NO_VALID_EVIDENCE" -> "No valid evidence". Never
 *  throws on an empty/odd string; worst case returns it unchanged. */
export function humanizeCode(code: string | null | undefined): string {
  if (!code) return UNAVAILABLE;
  const spaced = code.replace(/_/g, ' ').trim();
  if (spaced.length === 0) return code;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// ── Key-metrics rendering ────────────────────────────────────────────────
// The compact `key_metrics` object stored per source (see buildInputPacket
// .ts) uses a handful of recurring field-name patterns across both
// Insights findings and Pattern Discovery metric_effects. This renders any
// of them into a readable {label, value} list without needing a bespoke
// renderer per source shape, and safely falls back to a plain label/JSON
// value pair for anything it doesn't recognize — it never throws and never
// drops a field silently.

export interface FormattedMetric {
  label: string;
  value: string;
}

function formatMetricValueByKey(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return UNAVAILABLE;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null; // not a plain number — let the caller decide

  const k = key.toLowerCase();
  if (k.includes('profit')) return formatCurrency(value);
  if (k.includes('roi') || k.includes('rate_percent') || k === 'historical_import_percent') return formatRoiPercent(value);
  if (k.includes('day') || k.includes('dom')) return formatDays(value);
  if (k.includes('count') || k.includes('sample') || k.includes('n_')) return formatCount(value);
  return null;
}

/** Formats one already-extracted metric_effects-style entry
 *  ({metric_code, candidate_value, peer_baseline_median, advantage_value,
 *  direction}) — used for Pattern Discovery sources' key_metrics.metrics
 *  array specifically, since its numeric meaning depends on metric_code,
 *  not the surrounding field name. */
export function formatPatternMetricEntry(entry: Record<string, unknown>): FormattedMetric[] {
  const code = typeof entry.metric_code === 'string' ? entry.metric_code : 'metric';
  const label = humanizeCode(code.replace(/^median_/, ''));
  const formatter =
    code === 'median_net_profit' ? formatCurrency :
    code === 'median_roi' ? formatRoiPercent :
    code === 'median_days_on_market' ? formatDays :
    null;

  const results: FormattedMetric[] = [];
  const candidateValue = entry.candidate_value;
  results.push({
    label: `${label} (this segment)`,
    value: typeof candidateValue === 'number' && formatter ? formatter(candidateValue) : candidateValue === null || candidateValue === undefined ? UNAVAILABLE : String(candidateValue),
  });
  const peerBaseline = entry.peer_baseline_median;
  results.push({
    label: `${label} (peer baseline)`,
    value: typeof peerBaseline === 'number' && formatter ? formatter(peerBaseline) : peerBaseline === null || peerBaseline === undefined ? UNAVAILABLE : String(peerBaseline),
  });
  return results;
}

/** Formats a generic flat key_metrics record (Insights findings' own
 *  `metrics` object) into a readable list — heuristic field-name matching,
 *  safe fallback to a raw (but never mutated) value for anything
 *  unrecognized. Skips nested arrays/objects (e.g. Pattern Discovery's
 *  `metrics` array is handled separately by formatPatternMetricEntry). */
export function formatKeyMetrics(record: Record<string, unknown>): FormattedMetric[] {
  const results: FormattedMetric[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) continue;
    const formatted = formatMetricValueByKey(key, value);
    results.push({
      label: humanizeCode(key),
      value: formatted ?? (value === null || value === undefined ? UNAVAILABLE : String(value)),
    });
  }
  return results;
}
