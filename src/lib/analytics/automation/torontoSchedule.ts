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

// ── Weekly-status display support ───────────────────────────────────────
// Additive, read-only helpers for the Analytics page's "Weekly Automation"
// status panel. These never feed the cron route's own window decision
// (evaluateWeeklyTorontoWindow above is untouched and remains the sole
// authority for "should this invocation actually run automation right
// now") — they only answer "what week are we reporting status for, and
// has its 60-minute grace period passed" for DISPLAY purposes.

/** Resolves the precise UTC instant for "21:00 America/Toronto" on the
 *  given Toronto-local calendar date, by trying both fixed UTC offsets
 *  Toronto ever uses (EDT -4, EST -5) and returning whichever one
 *  actually round-trips back to that exact local date/hour. Toronto's
 *  offset is always a whole number of hours, so exactly one of the two
 *  candidates is ever correct for a real calendar date — the same
 *  dual-candidate approach vercel.json's two cron entries rely on, just
 *  inverted (local -> UTC instead of UTC -> local). */
function resolveTorontoWednesday9pmUtc(year: number, month: number, day: number): Date {
  for (const utcOffsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, 21 + utcOffsetHours, 0, 0));
    const wall = getTorontoWallClock(candidate);
    if (wall.year === year && wall.month === month && wall.day === day && wall.hour === 21) {
      return candidate;
    }
  }
  // Unreachable for any real Toronto calendar date (both DST states are
  // always tried) — falls back to the EDT guess rather than throwing,
  // since this only ever feeds a "next scheduled" display value.
  return new Date(Date.UTC(year, month - 1, day, 25, 0, 0));
}

export interface WeeklyScheduleStatusContext {
  /** Toronto-local date (YYYY-MM-DD) of the most recent Wednesday on or
   *  before "now" — the weekly period the status panel reports on. Same
   *  format/value space as WeeklyWindowResult.localPeriodKey and
   *  analytics_automation_executions.local_period_key. */
  currentPeriodKey: string;
  /** True once "now" is at or past the 60-minute grace cutoff (22:00
   *  America/Toronto) for currentPeriodKey's Wednesday — i.e. the
   *  automation should already have run for this period by now if it was
   *  going to. Before this point, a missing execution row is NOT yet a
   *  "did not run" condition. */
  pastGracePeriod: boolean;
  /** UTC ISO instant of the next Wednesday 21:00 America/Toronto —
   *  THIS week's if `pastGracePeriod` is still false (i.e. it hasn't
   *  happened yet or we're still inside its grace period), otherwise
   *  next week's. */
  nextScheduledAtUtc: string;
}

/**
 * Computes the weekly automation status-panel context for `now` (defaults
 * to the current instant). Pure and fully testable against an arbitrary
 * UTC Date, exactly like evaluateWeeklyTorontoWindow above.
 */
export function getWeeklyScheduleStatusContext(now: Date = new Date()): WeeklyScheduleStatusContext {
  const wall = getTorontoWallClock(now);

  // Days since the most recent Wednesday (0 if today IS Wednesday).
  const daysSinceWednesday = ((wall.weekday - 3) + 7) % 7;
  const currentWednesdayUtcMidnight = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  currentWednesdayUtcMidnight.setUTCDate(currentWednesdayUtcMidnight.getUTCDate() - daysSinceWednesday);
  const currentPeriodKey =
    `${currentWednesdayUtcMidnight.getUTCFullYear()}-${pad2(currentWednesdayUtcMidnight.getUTCMonth() + 1)}-${pad2(currentWednesdayUtcMidnight.getUTCDate())}`;

  const pastGracePeriod = daysSinceWednesday > 0 || (daysSinceWednesday === 0 && wall.hour >= 22);

  const nextWednesdayUtcMidnight = new Date(currentWednesdayUtcMidnight);
  if (pastGracePeriod) {
    nextWednesdayUtcMidnight.setUTCDate(nextWednesdayUtcMidnight.getUTCDate() + 7);
  }
  const nextScheduledAtUtc = resolveTorontoWednesday9pmUtc(
    nextWednesdayUtcMidnight.getUTCFullYear(),
    nextWednesdayUtcMidnight.getUTCMonth() + 1,
    nextWednesdayUtcMidnight.getUTCDate(),
  ).toISOString();

  return { currentPeriodKey, pastGracePeriod, nextScheduledAtUtc };
}
