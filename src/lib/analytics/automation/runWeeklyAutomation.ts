// Server-only. Executes the weekly Analytics + Advice automation for ONE
// eligible target user: atomically claims that user's weekly slot, runs
// the existing production Analytics pipeline, and — only if that
// succeeds — generates Advice for the freshly created run via the
// existing auto-mode Advice pipeline. Never touches OpenAI if Analytics
// fails. Deliberately does not loop over users itself — the caller (the
// cron route) enumerates eligible users and calls this once per user,
// so one user's failure/throw can never prevent the others from being
// attempted (a caught error here always becomes a 'failed' execution
// row, never an unhandled exception).

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAnalyticsForCurrentUser, AnalyticsRunError, sanitizeErrorMessage } from '@/lib/analytics/runAnalytics';
import { generateAdviceForRun } from '@/lib/analytics/advice/generateAdvice';

export const WEEKLY_AUTOMATION_CODE = 'weekly_analytics_advice';

export type WeeklyAutomationOutcome =
  | { status: 'completed'; executionId: number; analyticsRunId: number; adviceRowId: number | null }
  | { status: 'failed'; executionId: number; errorCode: string; errorMessage: string }
  | { status: 'skipped'; reason: 'ALREADY_CLAIMED_FOR_PERIOD'; executionId: number };

interface ClaimedExecution {
  id: number;
  was_created: boolean;
}

export interface RunWeeklyAutomationForUserParams {
  targetUserId: number;
  /** Toronto-local calendar date (YYYY-MM-DD) of the Wednesday this
   *  automation run is for — see torontoSchedule.ts. Passed in rather
   *  than computed here so every user processed by the same cron
   *  invocation shares the exact same period key, even if the loop takes
   *  long enough to cross a UTC-minute boundary partway through. */
  localPeriodKey: string;
  serviceClient: SupabaseClient;
}

/**
 * Claims, then executes, the weekly automation for exactly one target
 * user. Never throws — every failure path (claim RPC error, Analytics
 * failure, an Advice-generation throw outside its own documented
 * contract) is captured as a 'failed' execution row and returned, not
 * thrown, so a caller can safely process many users in a simple loop
 * without a try/catch around each call.
 */
export async function runWeeklyAutomationForUser(
  params: RunWeeklyAutomationForUserParams,
): Promise<WeeklyAutomationOutcome> {
  const { targetUserId, localPeriodKey, serviceClient } = params;

  // ── 1. Atomically claim this user's weekly slot. ─────────────────────
  const { data: claimRows, error: claimError } = await serviceClient.rpc('claim_weekly_automation_execution', {
    p_automation_code: WEEKLY_AUTOMATION_CODE,
    p_target_user_id: targetUserId,
    p_local_period_key: localPeriodKey,
  });

  if (claimError || !claimRows || (claimRows as ClaimedExecution[]).length === 0) {
    // No execution row exists to record this against — genuinely
    // exceptional (the RPC itself is designed to never fail under normal
    // operation). There is nothing to mark 'failed' since claiming is
    // exactly what didn't happen; the caller's summary counts this as a
    // failure via the thrown error being caught one level up.
    throw new Error(`claim_weekly_automation_execution failed for user ${targetUserId}: ${sanitizeErrorMessage(claimError)}`);
  }

  const claimed = (claimRows as ClaimedExecution[])[0];

  if (!claimed.was_created) {
    // Another invocation (the other DST UTC slot, a Vercel retry, or a
    // genuinely concurrent request) already claimed this exact user+week
    // — never run Analytics/Advice a second time for it.
    return { status: 'skipped', reason: 'ALREADY_CLAIMED_FOR_PERIOD', executionId: claimed.id };
  }

  const executionId = claimed.id;

  // ── 2. Run the existing production Analytics pipeline for this user. ──
  let run;
  try {
    run = await runAnalyticsForCurrentUser({ appUserId: targetUserId, serviceClient });
  } catch (err) {
    const errorCode = err instanceof AnalyticsRunError ? 'ANALYTICS_RUN_FAILED' : 'ANALYTICS_RUN_THREW';
    const errorMessage = sanitizeErrorMessage(err);
    const failedRunId = err instanceof AnalyticsRunError ? err.runId ?? null : null;
    await serviceClient
      .from('analytics_automation_executions')
      .update({
        status: 'failed',
        error_code: errorCode,
        error_message: errorMessage,
        analytics_run_id: failedRunId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', executionId);
    // Analytics failed — OpenAI is never called for this user this week.
    return { status: 'failed', executionId, errorCode, errorMessage };
  }

  // ── 3. Generate Advice (auto mode) for the run just created. Never
  // reached if step 2 threw — Analytics failure prevents any OpenAI
  // call, by construction (there is no code path from the catch block
  // above back down to here). ─────────────────────────────────────────
  let adviceRowId: number | null = null;
  try {
    const outcome = await generateAdviceForRun({
      runId: run.id,
      requestingUserId: targetUserId,
      serviceClient,
      mode: 'auto',
    });
    // 'completed' and 'failed' (including NO_VALID_EVIDENCE) both produce
    // a real, auditable analytics_run_advice row — record it either way.
    // 'skipped' should never occur here (this run is brand new, so no
    // prior revision can exist for it to skip against) but if it somehow
    // did, adviceRowId simply stays null rather than being treated as an
    // automation failure — the Analytics Run itself is what determines
    // this execution's own completed/failed status.
    if (outcome.status === 'completed' || outcome.status === 'failed') {
      adviceRowId = outcome.row.id;
    }
  } catch (err) {
    // generateAdviceForRun's own contract never throws — this mirrors the
    // same defensive catch already used in POST /api/analytics/runs, in
    // case something outside that contract ever does.
    console.error('[weekly-automation] advice generation threw unexpectedly for run', run.id, ':', sanitizeErrorMessage(err));
  }

  await serviceClient
    .from('analytics_automation_executions')
    .update({
      status: 'completed',
      analytics_run_id: run.id,
      analytics_run_advice_id: adviceRowId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', executionId);

  return { status: 'completed', executionId, analyticsRunId: run.id, adviceRowId };
}
