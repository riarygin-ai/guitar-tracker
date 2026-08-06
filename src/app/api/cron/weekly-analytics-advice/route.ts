import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { evaluateWeeklyTorontoWindow } from '@/lib/analytics/automation/torontoSchedule';
import { runWeeklyAutomationForUser } from '@/lib/analytics/automation/runWeeklyAutomation';

// Vercel Cron invokes this via GET. Two separate cron entries exist for
// this one route (see vercel.json) — Thursday 01:00 UTC and Thursday
// 02:00 UTC, covering EDT and EST respectively — and BOTH fire every
// week, year-round; the Toronto window guard below is what makes sure
// only the one actually inside Wednesday 21:00-21:59 America/Toronto ever
// does real work for a given week, and the DB-backed weekly claim (via
// runWeeklyAutomationForUser -> claim_weekly_automation_execution) is
// what makes that safe even if both somehow fired inside the window, or
// Vercel retries a slow/failed invocation.
//
// Server-only: this route is not reachable as a substitute for real user
// authentication — the ONLY accepted credential is the CRON_SECRET bearer
// token below; no Supabase user session/JWT is ever accepted here.
export const maxDuration = 60;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  // ── Authorize — CRON_SECRET only. Never logged, never echoed back. ────
  if (!CRON_SECRET) {
    console.error('[cron/weekly-analytics-advice] CRON_SECRET is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[cron/weekly-analytics-advice] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  // ── Toronto DST-aware window guard — outside the window is a normal,
  // successful "skipped" response, never an error. ──────────────────────
  const window = evaluateWeeklyTorontoWindow();
  if (!window.inWindow) {
    return NextResponse.json({
      status: 'skipped',
      reason: 'OUTSIDE_TORONTO_WEDNESDAY_WINDOW',
      torontoWeekday: window.torontoWeekday,
      torontoHour: window.torontoHour,
    });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Enumerate every eligible user. Every app_users row can already
  // manually trigger this exact same Analytics/Advice pipeline for
  // themselves via the existing UI — there is no separate "enabled for
  // analytics" flag anywhere in the schema — so eligibility here is
  // simply "has an app_users row", never a hardcoded id list. ───────────
  const { data: users, error: usersError } = await serviceClient.from('app_users').select('id');
  if (usersError) {
    console.error('[cron/weekly-analytics-advice] failed to enumerate eligible users:', usersError.message);
    return NextResponse.json({ error: 'Failed to enumerate eligible users' }, { status: 500 });
  }

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  // Sequential, not parallel — this app's realistic user count is small,
  // and keeping this sequential avoids firing many concurrent OpenAI
  // calls from a single invocation. One user's failure is caught here and
  // never stops the loop, matching runWeeklyAutomationForUser's own
  // never-throws contract (the catch below only guards against something
  // outside that contract).
  for (const user of users ?? []) {
    try {
      const outcome = await runWeeklyAutomationForUser({
        targetUserId: user.id as number,
        localPeriodKey: window.localPeriodKey,
        serviceClient,
      });
      if (outcome.status === 'completed') succeeded++;
      else if (outcome.status === 'skipped') skipped++;
      else failed++;
    } catch (err) {
      console.error('[cron/weekly-analytics-advice] unexpected throw for user', user.id, ':', err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  // Operational summary only — never advice content, snapshots, keys, or
  // any other per-user data.
  return NextResponse.json({
    status: 'processed',
    localPeriodKey: window.localPeriodKey,
    processed: (users ?? []).length,
    succeeded,
    skipped,
    failed,
  });
}
