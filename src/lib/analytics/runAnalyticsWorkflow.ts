// Server-only. THE single orchestration path for "run analytics":
//
//   deterministic Analytics snapshot
//     -> General Business Coach advice   (analytics_run_advice)
//     -> Listing Advice                  (listing_advice_runs)
//
// Both the manual Admin "Run Analytics" (POST /api/analytics/runs) and the
// scheduled weekly automation (runWeeklyAutomationForUser) call this ONE
// function, so the two entry points cannot drift. The two AI stages remain
// independently persisted, each with its own lifecycle/audit rows; this
// module only sequences them.
//
// Failure isolation (deliberately NOT all-or-nothing):
//  - If the Analytics snapshot fails, AnalyticsRunError propagates and NO AI
//    stage runs (nothing to interpret).
//  - Once the snapshot succeeded, it stays successful whatever happens next.
//    Each AI stage runs independently (concurrently — they share no state and
//    both are bounded by the model timeout), never throws, and reports its own
//    outcome. A failed Listing Advice generation leaves the previous
//    completed Listing Advice untouched (see generateListingAdvice.ts) and
//    its failed row is kept for audit.
//
// Dependencies are injectable so the orchestration is testable without a
// model; production callers pass nothing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAnalyticsForCurrentUser, sanitizeErrorMessage } from './runAnalytics';
import { generateAdviceForRun, type GenerateAdviceOutcome } from './advice/generateAdvice';
import { getUserPreferredLanguage } from './advice/userLanguage';
import { generateListingAdvice, type GenerateListingAdviceOutcome } from './listingAdvice/generateListingAdvice';

// Same run shape runAnalyticsForCurrentUser returns.
type AnalyticsRunResult = Awaited<ReturnType<typeof runAnalyticsForCurrentUser>>;

export type AiStageStatus = 'completed' | 'failed' | 'skipped';

export interface AiStageResult {
  status: AiStageStatus;
  /** Short machine code when not completed (e.g. OPENAI_ERROR, ALREADY_GENERATING). */
  code: string | null;
  /** Sanitized human-readable detail when not completed. */
  message: string | null;
  /** The persisted advice row id (analytics_run_advice.id / listing_advice_runs.id) when one exists. */
  rowId: number | null;
}

export interface AnalyticsWorkflowResult {
  run: AnalyticsRunResult;
  businessCoach: AiStageResult;
  listingAdvice: AiStageResult;
}

export interface AnalyticsWorkflowDeps {
  runAnalytics?: typeof runAnalyticsForCurrentUser;
  generateCoachAdvice?: typeof generateAdviceForRun;
  generateListingAdvice?: typeof generateListingAdvice;
}

export function coachStageFromOutcome(outcome: GenerateAdviceOutcome): AiStageResult {
  if (outcome.status === 'completed') return { status: 'completed', code: null, message: null, rowId: outcome.row.id };
  if (outcome.status === 'failed') return { status: 'failed', code: outcome.row.error_code ?? 'FAILED', message: outcome.row.error_message ?? null, rowId: outcome.row.id };
  return { status: 'skipped', code: outcome.reason, message: null, rowId: null };
}

export function listingAdviceStageFromOutcome(outcome: GenerateListingAdviceOutcome): AiStageResult {
  switch (outcome.status) {
    case 'completed':
      return { status: 'completed', code: null, message: null, rowId: outcome.run.id };
    case 'failed':
      return { status: 'failed', code: outcome.run.error_code ?? 'FAILED', message: outcome.run.error_message ?? null, rowId: outcome.run.id };
    case 'already_generating':
      return { status: 'skipped', code: 'ALREADY_GENERATING', message: 'A Listing Advice generation was already in progress.', rowId: null };
    case 'context_unavailable':
      return { status: 'failed', code: 'CONTEXT_UNAVAILABLE', message: outcome.message, rowId: null };
    default:
      return { status: 'failed', code: 'ERROR', message: outcome.message, rowId: null };
  }
}

/**
 * Runs the two AI stages for an already-completed Analytics run. Never
 * throws: each stage is wrapped so one stage's failure cannot affect the
 * other or the (already successful) snapshot.
 */
export async function runAiStagesForRun(params: {
  runId: number;
  appUserId: number;
  serviceClient: SupabaseClient;
  deps?: AnalyticsWorkflowDeps;
}): Promise<{ businessCoach: AiStageResult; listingAdvice: AiStageResult }> {
  const { runId, appUserId, serviceClient } = params;
  const coach = params.deps?.generateCoachAdvice ?? generateAdviceForRun;
  const listing = params.deps?.generateListingAdvice ?? generateListingAdvice;

  // ONE language resolution (server-side, from the authenticated user's own app_users row) feeds BOTH
  // AI stages, so manual Run Analytics and the weekly automation cannot drift. Never throws (falls back to 'en').
  const language = await getUserPreferredLanguage(serviceClient, appUserId);

  const [businessCoach, listingAdvice] = await Promise.all([
    (async (): Promise<AiStageResult> => {
      try {
        return coachStageFromOutcome(await coach({ runId, requestingUserId: appUserId, serviceClient, mode: 'auto', language }));
      } catch (err) {
        console.error('[runAnalyticsWorkflow] business coach stage threw for run', runId, ':', sanitizeErrorMessage(err));
        return { status: 'failed', code: 'THREW', message: sanitizeErrorMessage(err), rowId: null };
      }
    })(),
    (async (): Promise<AiStageResult> => {
      try {
        return listingAdviceStageFromOutcome(await listing({ appUserId, serviceClient, language }));
      } catch (err) {
        console.error('[runAnalyticsWorkflow] listing advice stage threw for run', runId, ':', sanitizeErrorMessage(err));
        return { status: 'failed', code: 'THREW', message: sanitizeErrorMessage(err), rowId: null };
      }
    })(),
  ]);

  return { businessCoach, listingAdvice };
}

/**
 * The full workflow. Throws AnalyticsRunError exactly as
 * runAnalyticsForCurrentUser does when the snapshot itself fails (no AI stage
 * is attempted then); otherwise always resolves with per-stage results.
 */
export async function runAnalyticsWorkflow(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
  deps?: AnalyticsWorkflowDeps;
}): Promise<AnalyticsWorkflowResult> {
  const { appUserId, serviceClient } = params;
  const runAnalytics = params.deps?.runAnalytics ?? runAnalyticsForCurrentUser;

  const run = await runAnalytics({ appUserId, serviceClient });
  const stages = await runAiStagesForRun({ runId: run.id, appUserId, serviceClient, deps: params.deps });
  return { run, ...stages };
}
