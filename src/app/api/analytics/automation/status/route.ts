import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getWeeklyScheduleStatusContext } from '@/lib/analytics/automation/torontoSchedule';
import { WEEKLY_AUTOMATION_CODE } from '@/lib/analytics/automation/runWeeklyAutomation';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** Maps a known execution error_code to a safe, generic user-facing
 *  message — the RAW error_message column is never selected by this
 *  route at all, let alone returned, so there is nothing provider/SQL-
 *  specific to accidentally leak here regardless of which branch fires. */
function safeFailureMessage(errorCode: string | null): string {
  switch (errorCode) {
    case 'ANALYTICS_RUN_FAILED':
    case 'ANALYTICS_RUN_THREW':
    case 'ANALYTICS_RUN_NOT_COMPLETED':
      return 'This week\'s automatic Analytics run did not complete successfully.';
    default:
      return 'This week\'s automatic Analytics run did not complete successfully for an unknown reason.';
  }
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
    .select('status, started_at, completed_at, analytics_run_id, error_code')
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

  if (execution.status === 'completed') {
    return NextResponse.json({
      state: 'completed',
      periodKey: context.currentPeriodKey,
      completedAt: execution.completed_at,
      analyticsRunId: execution.analytics_run_id,
    });
  }

  if (execution.status === 'failed') {
    return NextResponse.json({
      state: 'failed',
      periodKey: context.currentPeriodKey,
      completedAt: execution.completed_at,
      message: safeFailureMessage(execution.error_code),
    });
  }

  if (execution.status === 'running' || execution.status === 'pending') {
    return NextResponse.json({ state: 'running', periodKey: context.currentPeriodKey, startedAt: execution.started_at });
  }

  // Defensive fallback for any unrecognized status value — never crash,
  // never leak whatever that value was.
  return NextResponse.json({ state: 'did_not_run', periodKey: context.currentPeriodKey });
}
