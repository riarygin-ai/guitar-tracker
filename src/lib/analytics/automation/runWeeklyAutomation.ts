// Server-only. Executes the weekly Analytics + Advice automation for ONE
// eligible target user: atomically claims that user's weekly slot, then runs
// the SAME shared workflow the manual Admin "Run Analytics" uses
// (runAnalyticsWorkflow: Analytics snapshot -> Business Coach -> Listing
// Advice), so scheduled and manual runs cannot drift. There is no separate
// Listing Advice schedule. Never touches OpenAI if Analytics
// fails. Deliberately does not loop over users itself — the caller (the
// cron route) enumerates eligible users and calls this once per user,
// so one user's failure/throw can never prevent the others from being
// attempted (a caught error here always becomes a 'failed' execution
// row, never an unhandled exception).

import type { SupabaseClient } from '@supabase/supabase-js';
import { AnalyticsRunError, sanitizeErrorMessage } from '@/lib/analytics/runAnalytics';
import { runAnalyticsWorkflow, type AiStageStatus } from '@/lib/analytics/runAnalyticsWorkflow';

export const WEEKLY_AUTOMATION_CODE = 'weekly_analytics_advice';

export type WeeklyAutomationOutcome =
  | { status: 'completed'; executionId: number; analyticsRunId: number; adviceRowId: number | null; listingAdviceStatus: AiStageStatus }
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

  // ── 2. Shared workflow: Analytics snapshot, then (only if it succeeded)
  // Business Coach + Listing Advice. Analytics failure prevents any OpenAI
  // call, by construction (runAnalyticsWorkflow throws before any AI stage).
  // An AI stage failure never fails this execution: the snapshot is what
  // determines completed/failed, and each stage's own persisted row records
  // its outcome. ─────────────────────────────────────────────────────────
  let workflow;
  try {
    workflow = await runAnalyticsWorkflow({ appUserId: targetUserId, serviceClient });
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
    return { status: 'failed', executionId, errorCode, errorMessage };
  }

  const run = workflow.run;
  // A completed or failed Coach revision is a real, auditable row — record it either way.
  const adviceRowId: number | null = workflow.businessCoach.rowId;

  await serviceClient
    .from('analytics_automation_executions')
    .update({
      status: 'completed',
      analytics_run_id: run.id,
      analytics_run_advice_id: adviceRowId,
      completed_at: new Date().toISOString(),
    })
    .eq('id', executionId);

  return { status: 'completed', executionId, analyticsRunId: run.id, adviceRowId, listingAdviceStatus: workflow.listingAdvice.status };
}
