// Toronto (America/Toronto) DST-aware weekly window calculation for the
// weekly Analytics + Advice automation. Pure, dependency-free (uses only
// the built-in Intl API's IANA-timezone-aware formatting — Node ships with
// the full tz database, so no external library is needed), and fully
// testable against an arbitrary UTC Date so both EDT and EST behavior can
// be exercised deterministically without waiting for a real DST
// transition.
//
// Vercel Cron schedules are UTC-only. Wednesday 9pm Toronto is Thursday
// 01:00 UTC during EDT (UTC-4) and Thursday 02:00 UTC during EST (UTC-5).
// Two separate cron entries exist for these (see vercel.json) and BOTH
// physically fire every single week, year-round; this module is what
// decides which one (if either) actually falls inside the real
// Toronto-local 21:00-21:59 Wednesday window for the current DST state —
// exactly one of the two ever passes the check for a given week.

const TORONTO_TIME_ZONE = 'America/Toronto';

interface TorontoWallClock {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0 = Sunday ... 3 = Wednesday ... 6 = Saturday
  hour: number; // 0-23
}

function getTorontoWallClock(utcDate: Date): TorontoWallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TORONTO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(utcDate);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  // hour12: false with the 'en-US' locale can format midnight as "24" in
  // some ICU versions — normalize to 0.
  const rawHour = Number(get('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: weekdayMap[get('weekday')] ?? -1,
    hour,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export interface WeeklyWindowResult {
  /** True only when the given instant falls inside the Wednesday
   *  21:00-21:59 America/Toronto local window. */
  inWindow: boolean;
  /** The Toronto-local calendar date (YYYY-MM-DD) this instant falls on —
   *  used verbatim as analytics_automation_executions.local_period_key.
   *  Always computed, even when inWindow is false, so callers/tests can
   *  inspect it (e.g. to confirm two DST-slot invocations for the same
   *  logical week would share the same key). */
  localPeriodKey: string;
  /** Toronto-local hour (0-23) and weekday (0=Sun..6=Sat), for
   *  diagnostics/logging and direct test assertions. */
  torontoHour: number;
  torontoWeekday: number;
}

/**
 * Determines whether `utcDate` (defaults to now) falls inside the weekly
 * automation's Toronto-local Wednesday 21:00-21:59 window, and the stable
 * period key identifying the week it belongs to. Every non-Wednesday date,
 * and every Wednesday hour outside 21:00-21:59, returns inWindow: false —
 * callers must treat that as a normal, successful "skipped" outcome, not
 * an error.
 */
export function evaluateWeeklyTorontoWindow(utcDate: Date = new Date()): WeeklyWindowResult {
  const wall = getTorontoWallClock(utcDate);
  const localPeriodKey = `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
  const inWindow = wall.weekday === 3 && wall.hour === 21;
  return { inWindow, localPeriodKey, torontoHour: wall.hour, torontoWeekday: wall.weekday };
}
