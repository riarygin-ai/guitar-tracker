// Server-only. Executes the Weekly Coach Refresh for ONE eligible target
// user: atomically claims that user's weekly slot, then runs the SAME
// orchestration the manual "Refresh Coach" / Admin "Run Analytics" use
// (runCoachRefresh: General Coach + Listing Advice), so scheduled and manual
// refreshes cannot drift. There is no separate Listing Advice schedule —
// Listing Advice is a module of this one weekly refresh.
//
// The two modules are recorded independently on the execution row
// (general_status / listing_status): a failed General snapshot no longer
// stops Listing Advice, and a failed Listing Advice never fails a
// successful General run. status = completed | partial | failed summarizes
// them (see overallRefreshStatus).
//
// Deliberately does not loop over users itself — the cron route enumerates
// eligible users and calls this once per user, so one user's failure/throw
// can never prevent the others from being attempted.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeErrorMessage } from '@/lib/analytics/runAnalytics';
import { overallRefreshStatus, runCoachRefresh, type CoachModuleResult, type CoachRefreshDeps } from '@/lib/analytics/coachRefresh';

export const WEEKLY_AUTOMATION_CODE = 'weekly_analytics_advice';

export type WeeklyAutomationOutcome =
  | { status: 'completed' | 'partial' | 'failed'; executionId: number; analyticsRunId: number | null; adviceRowId: number | null;
      general: CoachModuleResult; listings: CoachModuleResult; errorCode: string | null }
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
   *  invocation shares the exact same period key. */
  localPeriodKey: string;
  serviceClient: SupabaseClient;
  /** Test seam only. */
  deps?: CoachRefreshDeps;
}

/**
 * Claims, then executes, the weekly refresh for exactly one target user.
 * Never throws after a successful claim — every module failure is recorded
 * on the execution row and returned.
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
    // No execution row exists to record this against; the cron route's
    // per-user try/catch counts it as a failure.
    throw new Error(`claim_weekly_automation_execution failed for user ${targetUserId}: ${sanitizeErrorMessage(claimError)}`);
  }

  const claimed = (claimRows as ClaimedExecution[])[0];
  if (!claimed.was_created) {
    // The other DST UTC slot, a Vercel retry, or a concurrent request
    // already claimed this exact user+week — never refresh twice.
    return { status: 'skipped', reason: 'ALREADY_CLAIMED_FOR_PERIOD', executionId: claimed.id };
  }
  const executionId = claimed.id;

  // ── 2. One Coach refresh, two independent modules (never throws). ────
  let result;
  try {
    result = await runCoachRefresh({ appUserId: targetUserId, serviceClient, deps: params.deps });
  } catch (err) {
    // Outside runCoachRefresh's never-throws contract — record, don't propagate.
    const message = sanitizeErrorMessage(err);
    const threw: CoachModuleResult = { status: 'failed', code: 'REFRESH_THREW', message, rowId: null, cardCount: null };
    result = { run: null, analyticsRunId: null, general: threw, listings: threw };
  }

  const { general, listings, analyticsRunId } = result;
  const status = overallRefreshStatus(general, listings);
  const failing = ([['general', general], ['listings', listings]] as const).filter(([, m]) => m.status === 'failed');
  const errorCode = failing[0]?.[1].code ?? null;
  const errorMessage = failing.length > 0 ? failing.map(([name, m]) => `${name}: ${m.message ?? m.code}`).join(' | ') : null;
  const adviceRowId = general.rowId;

  const { error: updateError } = await serviceClient
    .from('analytics_automation_executions')
    .update({
      status,
      // completed requires a run id (existing CHECK); a failed snapshot's own failed run row is still recorded.
      analytics_run_id: analyticsRunId,
      analytics_run_advice_id: adviceRowId,
      general_status: general.status,
      general_error_code: general.status === 'failed' || general.status === 'skipped' ? general.code : null,
      listing_status: listings.status,
      listing_error_code: listings.status === 'failed' || listings.status === 'skipped' ? listings.code : null,
      listing_advice_run_id: listings.rowId,
      error_code: errorCode,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq('id', executionId);
  if (updateError) {
    console.error('[runWeeklyAutomation] could not record execution', executionId, ':', sanitizeErrorMessage(updateError));
    // Schema before 20261113000000 (no module columns / no 'partial'): record the legacy shape so the row never
    // stays 'running'. The module results are still in their own advice tables.
    const legacyStatus = general.status === 'failed' || analyticsRunId === null ? 'failed' : 'completed';
    await serviceClient
      .from('analytics_automation_executions')
      .update({
        status: legacyStatus,
        analytics_run_id: analyticsRunId,
        analytics_run_advice_id: adviceRowId,
        error_code: legacyStatus === 'failed' ? general.code ?? errorCode ?? 'REFRESH_FAILED' : null,
        error_message: legacyStatus === 'failed' ? errorMessage ?? 'Refresh failed' : null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', executionId);
  }

  return { status, executionId, analyticsRunId, adviceRowId, general, listings, errorCode };
}
