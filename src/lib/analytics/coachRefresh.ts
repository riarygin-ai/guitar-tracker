// Server-only. THE single orchestration path for a Business Coach refresh:
//
//   Weekly Coach Refresh (also the manual "Refresh Coach" / Admin "Run Analytics")
//     ├── General Coach   Analytics snapshot -> analytics_run_advice
//     └── Listing Advice  4-week Listing Demand packet -> listing_advice_runs
//
// The two analytical engines stay separate (own packet, prompt, schema,
// persistence, dismissal namespace). This module only sequences them and
// reports one result per module. It is deliberately NOT all-or-nothing:
//
//  - The canonical Listing Demand context (the deterministic evidence BOTH
//    modules use) is loaded ONCE and shared, so the two modules can never
//    disagree about listing age / lead activity / channel demand, and the
//    database is not hit by two identical concurrent evidence builds (that
//    duplicate load ran alongside the snapshot before 2026-11-13).
//  - A failed snapshot fails only the General module. Listing Advice does
//    not need the snapshot and still runs (retrying its own evidence load
//    once if the shared load failed).
//  - A failed Listing Advice generation never touches the General result.
//  - Neither module ever replaces its last completed output on failure:
//    failed rows are history; "latest" is always the newest COMPLETED row.
//
// Heavy DB phases run one after another (evidence, then snapshot); only the
// two model calls run concurrently. Never throws. Dependencies are
// injectable so the orchestration is testable without a model.

import type { SupabaseClient } from '@supabase/supabase-js';
import { AnalyticsRunError, STALE_INFLIGHT_RUN_MS, runAnalyticsForCurrentUser, sanitizeErrorMessage } from './runAnalytics';
import { generateAdviceForRun, type GenerateAdviceOutcome } from './advice/generateAdvice';
import { getUserPreferredLanguage } from './advice/userLanguage';
import { loadListingDemandContext, type ListingDemandContext } from './advice/listingDemandContext';
import { generateListingAdvice, type GenerateListingAdviceOutcome } from './listingAdvice/generateListingAdvice';

type AnalyticsRunResult = Awaited<ReturnType<typeof runAnalyticsForCurrentUser>>;

/** Per-module outcome. 'skipped' = nothing new was attempted (e.g. already in flight). */
export type CoachModuleStatus = 'completed' | 'no_material_advice' | 'failed' | 'skipped';

export interface CoachModuleResult {
  status: CoachModuleStatus;
  /** Short machine code when not plainly completed (OPENAI_ERROR, ANALYTICS_RUN_FAILED, UNCHANGED_INPUT…). */
  code: string | null;
  /** Sanitized detail — admin/audit only, never shown to normal users. */
  message: string | null;
  /** Persisted output row (analytics_run_advice.id / listing_advice_runs.id) when one exists. */
  rowId: number | null;
  /** Cards in that output (completed / no_material_advice only). */
  cardCount: number | null;
}

export interface CoachRefreshResult {
  /** The completed Analytics run, or null when the General snapshot failed. */
  run: AnalyticsRunResult | null;
  /** Analytics run id — also set for a FAILED run (its failed row). */
  analyticsRunId: number | null;
  general: CoachModuleResult;
  listings: CoachModuleResult;
}

export interface CoachRefreshDeps {
  runAnalytics?: typeof runAnalyticsForCurrentUser;
  generateCoachAdvice?: typeof generateAdviceForRun;
  generateListingAdvice?: typeof generateListingAdvice;
  loadListingDemand?: (p: { appUserId: number; serviceClient: SupabaseClient }) => Promise<ListingDemandContext>;
}

const ok = (status: CoachModuleStatus, rowId: number | null, cardCount: number | null, code: string | null = null): CoachModuleResult =>
  ({ status, code, message: null, rowId, cardCount });
const failed = (code: string, message: string | null, rowId: number | null = null): CoachModuleResult =>
  ({ status: 'failed', code, message, rowId, cardCount: null });

export function generalResultFromOutcome(outcome: GenerateAdviceOutcome): CoachModuleResult {
  if (outcome.status === 'completed') {
    const n = outcome.row.advice?.advice_cards?.length ?? 0;
    return ok(n === 0 ? 'no_material_advice' : 'completed', outcome.row.id, n);
  }
  if (outcome.status === 'failed') return failed(outcome.row.error_code ?? 'FAILED', outcome.row.error_message ?? null, outcome.row.id);
  return { status: 'skipped', code: outcome.reason, message: null, rowId: null, cardCount: null };
}

export function listingResultFromOutcome(outcome: GenerateListingAdviceOutcome): CoachModuleResult {
  switch (outcome.status) {
    case 'completed':
    case 'unchanged': {
      const n = outcome.run.output?.cards.length ?? 0;
      return ok(n === 0 ? 'no_material_advice' : 'completed', outcome.run.id, n, outcome.status === 'unchanged' ? 'UNCHANGED_INPUT' : null);
    }
    case 'failed':
      return failed(outcome.run.error_code ?? 'FAILED', outcome.run.error_message ?? null, outcome.run.id);
    case 'already_generating':
      return { status: 'skipped', code: 'ALREADY_GENERATING', message: 'A Listing Advice generation was already in progress.', rowId: null, cardCount: null };
    case 'context_unavailable':
      return failed('CONTEXT_UNAVAILABLE', outcome.message);
    default:
      return failed('ERROR', outcome.message);
  }
}

/** Execution-level summary of two independent module results. */
export function overallRefreshStatus(general: CoachModuleResult, listings: CoachModuleResult): 'completed' | 'partial' | 'failed' {
  const g = general.status !== 'failed';
  const l = listings.status !== 'failed';
  if (g && l) return 'completed';
  if (!g && !l) return 'failed';
  return 'partial';
}

/**
 * True while a (non-abandoned) Coach refresh is already running for this user — an in-flight Analytics run or a
 * weekly execution still 'running'. Manual entry points check this first so a double-click or a click during the
 * weekly run never starts a duplicate refresh; the DB indexes (one in-flight analytics run / one generating
 * Listing Advice per user) remain the race-proof backstop.
 */
export async function isCoachRefreshInFlight(serviceClient: SupabaseClient, appUserId: number, now: Date = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - STALE_INFLIGHT_RUN_MS).toISOString();
  const [{ data: runs }, { data: executions }] = await Promise.all([
    serviceClient.from('analytics_runs').select('id').eq('requested_by_user_id', appUserId).in('status', ['pending', 'running']).gte('created_at', since).limit(1),
    serviceClient.from('analytics_automation_executions').select('id').eq('target_user_id', appUserId).in('status', ['pending', 'running']).gte('created_at', since).limit(1),
  ]);
  return (runs ?? []).length > 0 || (executions ?? []).length > 0;
}

/** Listing Advice only (the /listings "Refresh Advice" button). Same service, same dedupe, same guards. */
export async function runListingAdviceRefresh(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
  deps?: Pick<CoachRefreshDeps, 'generateListingAdvice'>;
}): Promise<CoachModuleResult> {
  const listing = params.deps?.generateListingAdvice ?? generateListingAdvice;
  try {
    return listingResultFromOutcome(await listing({ appUserId: params.appUserId, serviceClient: params.serviceClient, skipIfUnchanged: true }));
  } catch (err) {
    return failed('THREW', sanitizeErrorMessage(err));
  }
}

export async function runCoachRefresh(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
  deps?: CoachRefreshDeps;
}): Promise<CoachRefreshResult> {
  const { appUserId, serviceClient } = params;
  const runAnalytics = params.deps?.runAnalytics ?? runAnalyticsForCurrentUser;
  const coach = params.deps?.generateCoachAdvice ?? generateAdviceForRun;
  const listing = params.deps?.generateListingAdvice ?? generateListingAdvice;
  const loadDemand = params.deps?.loadListingDemand ?? ((p) => loadListingDemandContext(p));

  // ONE language resolution feeds both modules (never throws; falls back to 'en').
  const language = await getUserPreferredLanguage(serviceClient, appUserId);

  // 1. Shared deterministic evidence, loaded once.
  let demand: ListingDemandContext | null = null;
  try {
    demand = await loadDemand({ appUserId, serviceClient });
  } catch (err) {
    console.error('[coachRefresh] shared listing demand context unavailable for user', appUserId, ':', sanitizeErrorMessage(err));
  }

  // 2. General snapshot. Its failure is the General module's failure only.
  let run: AnalyticsRunResult | null = null;
  let analyticsRunId: number | null = null;
  let generalFailure: CoachModuleResult | null = null;
  try {
    run = await runAnalytics({ appUserId, serviceClient });
    analyticsRunId = run.id;
  } catch (err) {
    if (err instanceof AnalyticsRunError) {
      analyticsRunId = err.runId ?? null;
      generalFailure = err.status === 409
        ? { status: 'skipped', code: 'ALREADY_RUNNING', message: err.publicMessage, rowId: null, cardCount: null }
        : failed('ANALYTICS_RUN_FAILED', err.publicMessage);
    } else {
      generalFailure = failed('ANALYTICS_RUN_THREW', sanitizeErrorMessage(err));
    }
  }

  // 3. The two model-backed modules, concurrently and independently contained.
  const [general, listings] = await Promise.all([
    (async (): Promise<CoachModuleResult> => {
      if (generalFailure || !run) return generalFailure ?? failed('ANALYTICS_RUN_FAILED', null);
      try {
        return generalResultFromOutcome(await coach({ runId: run.id, requestingUserId: appUserId, serviceClient, mode: 'auto', language, listingDemand: demand }));
      } catch (err) {
        console.error('[coachRefresh] general coach module threw for run', run.id, ':', sanitizeErrorMessage(err));
        return failed('THREW', sanitizeErrorMessage(err));
      }
    })(),
    (async (): Promise<CoachModuleResult> => {
      try {
        // sharedContext null -> Listing Advice builds its own evidence (one retry of the same canonical loader).
        return listingResultFromOutcome(await listing({ appUserId, serviceClient, language, sharedContext: demand, skipIfUnchanged: true }));
      } catch (err) {
        console.error('[coachRefresh] listing advice module threw for user', appUserId, ':', sanitizeErrorMessage(err));
        return failed('THREW', sanitizeErrorMessage(err));
      }
    })(),
  ]);

  return { run, analyticsRunId, general, listings };
}
