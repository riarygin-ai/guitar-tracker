// Pure calendar-period math for the MCP get_lead_activity tool. No I/O,
// no Date-in-local-time arithmetic: every date is a YYYY-MM-DD string and
// all arithmetic runs on UTC midnights, so the result never depends on the
// server's timezone. "Today" is always supplied by the caller (the service
// passes the America/Toronto calendar date).
//
// Semantics (documented in the tool description and locked by
// scripts/test-lead-activity-periods.ts):
//   week  = calendar week, Monday -> Sunday
//   month = calendar month, 1st -> last day
//
// Rolling mode (no from_date/to_date): the calendar period containing
// `today` (the CURRENT period, ending today — partial unless today is the
// period's last day) plus `periods` COMPLETE calendar periods before it.
//
// Explicit mode (from_date given; to_date defaults to today): every
// calendar period intersecting [from_date, min(to_date, today)], each
// clipped to that range. A clipped bucket — at either edge, or because it
// is still in progress — is marked is_partial. `periods` is rejected in
// this mode rather than silently ignored.

export type LeadActivityBucket = 'week' | 'month';

export const DEFAULT_LEAD_ACTIVITY_PERIODS = 4;
export const MAX_LEAD_ACTIVITY_PERIODS = 52;
/** Upper bound on buckets an explicit from_date/to_date range may produce. */
export const MAX_LEAD_ACTIVITY_BUCKETS = 60;

export class LeadActivityPeriodError extends Error {}

export interface CalendarPeriod {
  /** First date covered by this bucket (inclusive). Equals the calendar period's start unless clipped by from_date. */
  start_date: string;
  /** Last date covered by this bucket (inclusive). Equals the calendar period's end unless clipped by to_date/today. */
  end_date: string;
  /** True when the bucket covers less than its whole calendar week/month (in progress, or clipped by an explicit range). */
  is_partial: boolean;
}

export interface ResolvedPeriods {
  mode: 'rolling' | 'explicit';
  bucket: LeadActivityBucket;
  start_date: string;
  end_date: string;
  /** Oldest -> newest. The last entry is the detail (current) period. */
  periods: CalendarPeriod[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function isValidDateOnly(date: string): boolean {
  return DATE_RE.test(date) && fmt(parse(date)) === date;
}

export function addDays(date: string, days: number): string {
  return fmt(parse(date) + days * 86400000);
}

/** The calendar week (Mon-Sun) or month containing `date`. */
export function calendarPeriodOf(date: string, bucket: LeadActivityBucket): { start: string; end: string } {
  if (bucket === 'week') {
    const dow = new Date(parse(date)).getUTCDay(); // 0 = Sunday
    const start = addDays(date, -((dow + 6) % 7));
    return { start, end: addDays(start, 6) };
  }
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1;
  return { start: fmt(Date.UTC(y, m, 1)), end: fmt(Date.UTC(y, m + 1, 0)) };
}

function bucketsBetween(from: string, to: string, bucket: LeadActivityBucket): CalendarPeriod[] {
  const out: CalendarPeriod[] = [];
  let cursor = from;
  while (cursor <= to) {
    const cal = calendarPeriodOf(cursor, bucket);
    const start = cursor > cal.start ? cursor : cal.start;
    const end = to < cal.end ? to : cal.end;
    out.push({ start_date: start, end_date: end, is_partial: start !== cal.start || end !== cal.end });
    cursor = addDays(cal.end, 1);
  }
  return out;
}

export interface PeriodRequest {
  bucket?: LeadActivityBucket;
  periods?: number;
  from_date?: string;
  to_date?: string;
}

/** Deterministically resolves the reporting buckets. Throws LeadActivityPeriodError on invalid/ambiguous input. */
export function resolveLeadActivityPeriods(req: PeriodRequest, today: string): ResolvedPeriods {
  const bucket: LeadActivityBucket = req.bucket ?? 'week';
  if (bucket !== 'week' && bucket !== 'month') throw new LeadActivityPeriodError('bucket must be "week" or "month"');
  if (!isValidDateOnly(today)) throw new LeadActivityPeriodError('internal: invalid today');

  const explicit = req.from_date !== undefined || req.to_date !== undefined;

  if (!explicit) {
    const periods = req.periods ?? DEFAULT_LEAD_ACTIVITY_PERIODS;
    if (!Number.isInteger(periods) || periods < 0 || periods > MAX_LEAD_ACTIVITY_PERIODS) {
      throw new LeadActivityPeriodError(`periods must be an integer between 0 and ${MAX_LEAD_ACTIVITY_PERIODS}`);
    }
    // Step back `periods` whole calendar periods from the current one.
    let firstStart = calendarPeriodOf(today, bucket).start;
    for (let i = 0; i < periods; i++) firstStart = calendarPeriodOf(addDays(firstStart, -1), bucket).start;
    return { mode: 'rolling', bucket, start_date: firstStart, end_date: today, periods: bucketsBetween(firstStart, today, bucket) };
  }

  if (req.periods !== undefined) {
    throw new LeadActivityPeriodError('periods cannot be combined with from_date/to_date — an explicit range already defines the reporting window');
  }
  if (req.from_date === undefined) throw new LeadActivityPeriodError('from_date is required when to_date is provided');
  if (!isValidDateOnly(req.from_date)) throw new LeadActivityPeriodError('from_date must be a valid YYYY-MM-DD date');
  if (req.to_date !== undefined && !isValidDateOnly(req.to_date)) throw new LeadActivityPeriodError('to_date must be a valid YYYY-MM-DD date');

  // Leads cannot exist after today; a later to_date is capped (reported back as end_date).
  const requestedEnd = req.to_date ?? today;
  const end = requestedEnd > today ? today : requestedEnd;
  if (req.from_date > end) throw new LeadActivityPeriodError('from_date must be on or before to_date (and not after today)');

  const periods = bucketsBetween(req.from_date, end, bucket);
  if (periods.length > MAX_LEAD_ACTIVITY_BUCKETS) {
    throw new LeadActivityPeriodError(`range produces ${periods.length} ${bucket} buckets; at most ${MAX_LEAD_ACTIVITY_BUCKETS} allowed — use bucket="month" or a shorter range`);
  }
  return { mode: 'explicit', bucket, start_date: req.from_date, end_date: end, periods };
}
