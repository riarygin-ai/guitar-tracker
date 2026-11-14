import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getWeeklyScheduleStatusContext } from '@/lib/analytics/automation/torontoSchedule';
import { WEEKLY_AUTOMATION_CODE } from '@/lib/analytics/automation/runWeeklyAutomation';
import { STALE_INFLIGHT_RUN_MS } from '@/lib/analytics/runAnalytics';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Maps a known execution error_code to a safe, generic user-facing
 *  message — the RAW error_message column is never read into any response
 *  field (every response below is built from an explicit allowlist), so
 *  nothing provider/SQL-specific can leak regardless of which branch fires. */
function safeFailureMessage(errorCode: string | null): string {
  switch (errorCode) {
    case 'ANALYTICS_RUN_FAILED':
    case 'ANALYTICS_RUN_THREW':
    case 'ANALYTICS_RUN_NOT_COMPLETED':
      return 'This week\'s automatic Analytics run did not complete successfully.';
    case 'STALE_RUNNING':
      return 'This week\'s automatic Coach refresh did not finish.';
    default:
      return 'This week\'s automatic Analytics run did not complete successfully for an unknown reason.';
  }
}

/** Safe one-line summary of which module failed in a partial refresh (never the raw error). */
function safePartialMessage(general: string | null, listings: string | null): string {
  if (general === 'failed') return 'This week\'s General Coach refresh failed; Listing Advice refreshed. Previous Coach advice is still shown.';
  if (listings === 'failed') return 'This week\'s Listing Advice refresh failed; General Coach refreshed. Previous Listing Advice is still shown.';
  return 'This week\'s Coach refresh partially failed.';
}

// Read-only status for the Analytics page's "Weekly Automation" panel.
// Reports on ONLY the calling user's own most recent weekly period —
// target_user_id is always the caller's own server-resolved app_users.id,
// never accepted from the client, and analytics_automation_executions has
// no authenticated grant/policy at all (service-role only, by design —
// see the migration) so this route is the sole mediated read path for it.
// Never returns raw error_message, SQL errors, stack traces, secrets,
// snapshots, or Advice content — only the small set of fields the panel
// actually renders.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: appUser } = await db
    .from('app_users')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser) {
    return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/analytics/automation/status] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const context = getWeeklyScheduleStatusContext();

  const { data: execution, error: execError } = await serviceClient
    .from('analytics_automation_executions')
    // '*' so the route keeps working before 20261113000000 adds general_status/listing_status.
    .select('*')
    .eq('automation_code', WEEKLY_AUTOMATION_CODE)
    .eq('target_user_id', appUser.id as number)
    .eq('local_period_key', context.currentPeriodKey)
    .maybeSingle();

  if (execError) {
    console.error('[api/analytics/automation/status] failed to load execution status:', execError.message);
    return NextResponse.json({ error: 'Failed to load weekly automation status' }, { status: 500 });
  }

  if (!execution) {
    if (context.pastGracePeriod) {
      return NextResponse.json({ state: 'did_not_run', periodKey: context.currentPeriodKey });
    }
    return NextResponse.json({ state: 'next_scheduled', periodKey: context.currentPeriodKey, nextScheduledAtUtc: context.nextScheduledAtUtc });
  }

  // Per-module results of the Weekly Coach Refresh (NULL on executions recorded before 20261113000000).
  const modules = { general: (execution.general_status as string | null) ?? null, listings: (execution.listing_status as string | null) ?? null };

  if (execution.status === 'completed') {
    return NextResponse.json({
      state: 'completed',
      periodKey: context.currentPeriodKey,
      completedAt: execution.completed_at,
      analyticsRunId: execution.analytics_run_id,
      modules,
    });
  }

  if (execution.status === 'partial') {
    return NextResponse.json({
      state: 'partial',
      periodKey: context.currentPeriodKey,
      completedAt: execution.completed_at,
      analyticsRunId: execution.analytics_run_id,
      message: safePartialMessage(modules.general, modules.listings),
      modules,
    });
  }

  if (execution.status === 'failed') {
    return NextResponse.json({
      state: 'failed',
      periodKey: context.currentPeriodKey,
      completedAt: execution.completed_at,
      message: safeFailureMessage(execution.error_code),
      // Legacy rows: a failed execution never reached Listing Advice.
      modules: { general: modules.general ?? 'failed', listings: modules.listings },
    });
  }

  if (execution.status === 'running' || execution.status === 'pending') {
    // 'running' past the function limit = killed mid-way (2026-11-05). Reported as failed at READ time only;
    // the audit row itself is never rewritten here.
    const startedMs = execution.started_at ? Date.parse(execution.started_at as string) : NaN;
    if (Number.isFinite(startedMs) && Date.now() - startedMs > STALE_INFLIGHT_RUN_MS) {
      return NextResponse.json({
        state: 'failed',
        periodKey: context.currentPeriodKey,
        completedAt: null,
        message: safeFailureMessage('STALE_RUNNING'),
        modules: { general: modules.general ?? 'failed', listings: modules.listings ?? 'failed' },
      });
    }
    return NextResponse.json({ state: 'running', periodKey: context.currentPeriodKey, startedAt: execution.started_at });
  }

  // Defensive fallback for any unrecognized status value — never crash,
  // never leak whatever that value was.
  return NextResponse.json({ state: 'did_not_run', periodKey: context.currentPeriodKey });
}
