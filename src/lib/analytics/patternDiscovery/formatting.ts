// Pattern Discovery Engine v1.0 — centralized, deterministic number-to-text
// formatting for user-facing template strings (headlines, summaries,
// confirmation_needed messages). Every helper here rounds/trims for
// DISPLAY ONLY — never mutate raw metric_effects/candidate_value/peer_
// baseline_median/advantage_value/relative_advantage_percent themselves;
// those stay full-precision numbers everywhere except inside a string
// literal built by one of these functions.

/** Rounds to at most 2 decimal places, correcting for binary floating-
 *  point artifacts (e.g. 26.130000000000003 -> 26.13). */
function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** "26.13" (no trailing zeros), "25" (whole number stays whole), "-48.37". */
function trimmedFixed2(value: number): string {
  return roundTo2(value).toString();
}

export function formatCurrency(value: number): string {
  const rounded = roundTo2(value);
  const isWhole = Number.isInteger(rounded);
  const formatted = rounded.toLocaleString('en-US', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `CAD $${formatted}`;
}

export function formatRoiPercent(value: number): string {
  return `${trimmedFixed2(value)}%`;
}

/** For percentage-POINT deltas (e.g. an ROI advantage_value) — a distinct
 *  unit from a raw ROI percentage, per the task's own convention. */
export function formatPercentagePoints(value: number): string {
  return `${trimmedFixed2(value)} percentage points`;
}

export function formatDays(value: number): string {
  const rounded = roundTo2(value);
  const label = Math.abs(rounded) === 1 ? 'day' : 'days';
  return `${trimmedFixed2(value)} ${label}`;
}

export function formatCount(value: number): string {
  return `${Math.round(value)}`;
}

export function formatPeerSegmentCount(value: number): string {
  const n = Math.round(value);
  return `${n} eligible peer segment${n === 1 ? '' : 's'}`;
}

export function joinWithAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
