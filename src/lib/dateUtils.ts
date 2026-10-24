// Calendar-date helpers. Operation dates (deals.deal_date, cash_flow.transaction_date,
// inventory_expenses.expense_date, inventory_items.sold_date) are PostgreSQL `date`
// columns: plain YYYY-MM-DD calendar dates, never timestamps. Keep them as strings
// end to end — `new Date('2026-10-24')` parses as UTC midnight, which renders as
// 2026-10-23 anywhere west of UTC (America/Toronto).

/** The business timezone: "today" for an operation is the calendar date here. */
export const BUSINESS_TIME_ZONE = 'America/Toronto';

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The YYYY-MM-DD calendar date of `at` in `timeZone` (default: the business timezone). */
export function calendarDateIn(at: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Today's calendar date in America/Toronto, regardless of the browser/server timezone. */
export function todayLocalDate(now: Date = new Date()): string {
  return calendarDateIn(now);
}

/**
 * Formats a YYYY-MM-DD calendar date for display without shifting the day:
 * the date is anchored at UTC midnight and formatted in UTC. Non-matching
 * input is returned unchanged.
 */
export function formatCalendarDate(ymd: string | null | undefined, options?: Intl.DateTimeFormatOptions, locale?: string): string {
  if (!ymd) return '';
  const m = YMD.exec(ymd);
  if (!m) return ymd;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return at.toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
}
