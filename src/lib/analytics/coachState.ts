// Pure, deterministic state model shared by the Dashboard Business Coach and
// /listings Listing Advice. One function per concern, no I/O — so every
// state the UI can show is unit-testable:
//
//   content    none_yet | no_material | all_dismissed | visible
//   freshness  generatedAt, ageDays, stale (older than the weekly cadence)
//   failure    refreshFailedAt — a failed attempt NEWER than the shown output
//   counts     generated / visible / dismissed, next resurface date
//
// These are orthogonal on purpose: "all cards dismissed", "no material
// advice" and "latest refresh failed" are different facts and must never
// collapse into one blank state. A failed refresh never removes the last
// successful output — it only adds refreshFailedAt next to it.

/** Weekly cadence + one day of grace: older output is shown as stale, never as current. */
export const COACH_STALE_AFTER_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface HiddenAdviceCard<T> {
  card: T;
  key: string;
  /** ISO instant the dismissal ends. */
  resurfaceAfter: string;
}

export type CoachContentState = 'none_yet' | 'no_material' | 'all_dismissed' | 'visible';

export interface CoachModuleView<T> {
  content: CoachContentState;
  generatedAt: string | null;
  generatedCount: number;
  visibleCount: number;
  dismissedCount: number;
  visible: T[];
  hidden: HiddenAdviceCard<T>[];
  /** Earliest resurface instant among the hidden cards. */
  nextResurfaceAt: string | null;
  ageDays: number | null;
  stale: boolean;
  /** Newest failed refresh attempt that is newer than the shown output (null = none). */
  refreshFailedAt: string | null;
}

const ms = (v: string | null | undefined) => (v ? Date.parse(v) : NaN);

/** The newest of the given failure instants that is strictly newer than `generatedAt` (any, when nothing was generated). */
export function newestFailureAfter(generatedAt: string | null, failureTimes: (string | null | undefined)[]): string | null {
  const base = ms(generatedAt);
  let best: string | null = null;
  for (const t of failureTimes) {
    const v = ms(t);
    if (!Number.isFinite(v)) continue;
    if (Number.isFinite(base) && v <= base) continue;
    if (best === null || v > ms(best)) best = t as string;
  }
  return best;
}

export function deriveCoachModuleView<T>(params: {
  /** A completed output exists (even with zero cards). */
  hasOutput: boolean;
  cards: T[];
  keyOf: (card: T) => string;
  /** Active dismissals: advice_key -> resurface_after (already filtered to the future). */
  dismissals: ReadonlyMap<string, string>;
  generatedAt: string | null;
  /** Instants of failed refresh attempts (failed runs/revisions, failed weekly modules). */
  failureTimes?: (string | null | undefined)[];
  now?: Date;
}): CoachModuleView<T> {
  const now = params.now ?? new Date();
  const visible: T[] = [];
  const hidden: HiddenAdviceCard<T>[] = [];
  for (const card of params.hasOutput ? params.cards : []) {
    const key = params.keyOf(card);
    const until = params.dismissals.get(key);
    if (until && ms(until) > now.getTime()) hidden.push({ card, key, resurfaceAfter: until });
    else visible.push(card);
  }
  hidden.sort((a, b) => ms(a.resurfaceAfter) - ms(b.resurfaceAfter));

  const generatedCount = params.hasOutput ? params.cards.length : 0;
  const content: CoachContentState = !params.hasOutput ? 'none_yet'
    : generatedCount === 0 ? 'no_material'
    : visible.length === 0 ? 'all_dismissed'
    : 'visible';

  const gen = ms(params.generatedAt);
  const ageDays = params.hasOutput && Number.isFinite(gen) ? Math.max(0, Math.floor((now.getTime() - gen) / DAY_MS)) : null;

  return {
    content,
    generatedAt: params.hasOutput ? params.generatedAt : null,
    generatedCount,
    visibleCount: visible.length,
    dismissedCount: hidden.length,
    visible,
    hidden,
    nextResurfaceAt: hidden[0]?.resurfaceAfter ?? null,
    ageDays,
    stale: ageDays !== null && ageDays >= COACH_STALE_AFTER_DAYS,
    refreshFailedAt: newestFailureAfter(params.hasOutput ? params.generatedAt : null, params.failureTimes ?? []),
  };
}

// ── Weekly refresh status (from /api/analytics/automation/status) ─────────

export interface WeeklyCoachStatusPayload {
  state: 'completed' | 'partial' | 'failed' | 'running' | 'did_not_run' | 'next_scheduled';
  periodKey?: string;
  completedAt?: string | null;
  startedAt?: string | null;
  nextScheduledAtUtc?: string;
  modules?: { general: string | null; listings: string | null };
}

/** Failure instant this week's scheduled refresh contributes to ONE module (null = that module did not fail). */
export function weeklyModuleFailureAt(status: WeeklyCoachStatusPayload | null, module: 'general' | 'listings'): string | null {
  if (!status || (status.state !== 'failed' && status.state !== 'partial')) return null;
  const moduleStatus = status.modules?.[module] ?? null;
  // Legacy failed rows only ever failed in the General snapshot.
  const failed = moduleStatus === 'failed' || (status.state === 'failed' && module === 'general' && moduleStatus === null);
  if (!failed) return null;
  // A failed weekly refresh is dated by its period's Wednesday 21:00 Toronto if no completion instant was recorded.
  return status.completedAt ?? (status.periodKey ? `${status.periodKey}T21:00:00-05:00` : null);
}
