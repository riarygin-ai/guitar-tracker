/**
 * test-weekly-automation.ts
 *
 * Validation for the weekly Analytics + Advice automation: the Toronto
 * DST-aware window calculation (src/lib/analytics/automation/
 * torontoSchedule.ts), the per-user orchestrator (src/lib/analytics/
 * automation/runWeeklyAutomation.ts), and the protected cron route
 * (src/app/api/cron/weekly-analytics-advice/route.ts). Same conventions
 * as the other scripts in this directory — tsx, no test framework, local
 * check(), safety-gated against a disposable local Supabase instance only.
 *
 * Section A is pure unit tests (no DB, no network) against constructed
 * UTC instants — both DST states, hour boundaries, and weekday gating.
 * Section B exercises the cron route handler directly (imported and
 * invoked as a plain function, not over real HTTP) for authorization and
 * response-shape/no-secret-leakage guarantees. Section C exercises the
 * real orchestrator against real local Supabase — real Analytics runs via
 * the existing production pipeline, real (if OPENAI_API_KEY happens to be
 * unset, which is the default in this shell — see the other scripts'
 * OPENAI_API_KEY gating) attempted Advice generation — for claim
 * idempotency, concurrency, cross-user isolation, one-failure-doesn't-
 * block-another, and NO_VALID_EVIDENCE handling. Every row Section C
 * creates is deleted and the deletion verified before the script exits.
 *
 * Usage:
 *   npx tsx scripts/test-weekly-automation.ts
 */

import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
  setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { evaluateWeeklyTorontoWindow, getWeeklyScheduleStatusContext } from '../src/lib/analytics/automation/torontoSchedule';
import { runWeeklyAutomationForUser, WEEKLY_AUTOMATION_CODE } from '../src/lib/analytics/automation/runWeeklyAutomation';
import type { WeeklyAutomationOutcome } from '../src/lib/analytics/automation/runWeeklyAutomation';
import { runAnalyticsForCurrentUser } from '../src/lib/analytics/runAnalytics';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`, detail !== undefined ? detail : '');
  }
}

function isCompleted(o: WeeklyAutomationOutcome): o is Extract<WeeklyAutomationOutcome, { status: 'completed' }> {
  return o.status === 'completed';
}
function isSkipped(o: WeeklyAutomationOutcome): o is Extract<WeeklyAutomationOutcome, { status: 'skipped' }> {
  return o.status === 'skipped';
}

// ── Date helpers (Section A) ────────────────────────────────────────────

/** First Thursday on/after the 5th of the given month — safely clear of
 *  any DST-transition-week edge case, in either direction. */
function findThursday(year: number, month1to12: number): Date {
  const d = new Date(Date.UTC(year, month1to12 - 1, 5, 12, 0, 0));
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function atUtcHour(thursdayNoon: Date, hour: number): Date {
  return new Date(Date.UTC(thursdayNoon.getUTCFullYear(), thursdayNoon.getUTCMonth(), thursdayNoon.getUTCDate(), hour, 0, 0));
}

async function main() {
  // ── Safety gate ───────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ══════════════════════════════════════════════════════════════════════
  // Section A — Toronto DST-aware weekly window (pure, no DB)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A — Toronto DST-aware weekly window]');

  const summerThursday = findThursday(2026, 7); // July -> EDT (UTC-4)
  const winterThursday = findThursday(2026, 1); // January -> EST (UTC-5)

  const summerIn = evaluateWeeklyTorontoWindow(atUtcHour(summerThursday, 1));
  check('a summer Wednesday 9pm America/Toronto is accepted at Thursday 01:xx UTC (EDT)', summerIn.inWindow && summerIn.torontoHour === 21 && summerIn.torontoWeekday === 3, summerIn);

  const summerOut = evaluateWeeklyTorontoWindow(atUtcHour(summerThursday, 2));
  check('the matching Thursday 02:xx UTC invocation is skipped in summer', !summerOut.inWindow, summerOut);

  const winterIn = evaluateWeeklyTorontoWindow(atUtcHour(winterThursday, 2));
  check('a winter Wednesday 9pm America/Toronto is accepted at Thursday 02:xx UTC (EST)', winterIn.inWindow && winterIn.torontoHour === 21 && winterIn.torontoWeekday === 3, winterIn);

  const winterOut = evaluateWeeklyTorontoWindow(atUtcHour(winterThursday, 1));
  check('the matching Thursday 01:xx UTC invocation is skipped in winter', !winterOut.inWindow, winterOut);

  const nonWednesday = new Date(summerThursday);
  nonWednesday.setUTCDate(nonWednesday.getUTCDate() - 2); // Thu -> Tue (UTC-day arithmetic; still non-Wednesday in Toronto local time)
  const nonWednesdayResult = evaluateWeeklyTorontoWindow(atUtcHour(nonWednesday, 1));
  check('any non-Wednesday Toronto local date is skipped', nonWednesdayResult.torontoWeekday !== 3 && !nonWednesdayResult.inWindow, nonWednesdayResult);

  check('local_period_key is stable/deterministic for the same instant', evaluateWeeklyTorontoWindow(atUtcHour(summerThursday, 1)).localPeriodKey === summerIn.localPeriodKey);
  check('summer and winter in-window instants produce different local_period_key values (different weeks)', summerIn.localPeriodKey !== winterIn.localPeriodKey);

  // ══════════════════════════════════════════════════════════════════════
  // Section B — cron route: authorization + response shape
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B — cron route authorization]');

  const TEST_CRON_SECRET = 'test-cron-secret-local-only-never-a-real-secret';
  // Route module reads these from process.env at module-evaluation time —
  // set them BEFORE the dynamic import below so its top-level consts
  // capture the local-only values, never .env.local (never loaded by this
  // script at all — see setup-analytics-test-fixtures.ts's own header).
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

  const { GET: cronGet } = await import('../src/app/api/cron/weekly-analytics-advice/route');
  const { NextRequest } = await import('next/server');
  const CRON_URL = 'http://localhost/api/cron/weekly-analytics-advice';

  const noAuthRes = await cronGet(new NextRequest(CRON_URL));
  check('missing Authorization header returns 401', noAuthRes.status === 401);

  const wrongAuthRes = await cronGet(new NextRequest(CRON_URL, { headers: { authorization: 'Bearer wrong-secret' } }));
  check('incorrect CRON_SECRET returns 401', wrongAuthRes.status === 401);

  const noAuthBodyText = await noAuthRes.clone().text();
  check('401 response never echoes back the configured CRON_SECRET', !noAuthBodyText.includes(TEST_CRON_SECRET));

  const validAuthRes = await cronGet(new NextRequest(CRON_URL, { headers: { authorization: `Bearer ${TEST_CRON_SECRET}` } }));
  const validAuthBodyText = await validAuthRes.clone().text();
  const validAuthBody = JSON.parse(validAuthBodyText) as { status: string };
  check('correct CRON_SECRET is accepted (200)', validAuthRes.status === 200, validAuthBody);
  check('response body never contains the CRON_SECRET value', !validAuthBodyText.includes(TEST_CRON_SECRET));
  check('response body never contains the service-role key', !validAuthBodyText.includes(SUPABASE_SERVICE_ROLE_KEY));
  check('response has a well-formed status field ("skipped" or "processed")', validAuthBody.status === 'skipped' || validAuthBody.status === 'processed', validAuthBody);

  // ══════════════════════════════════════════════════════════════════════
  // Section C — runWeeklyAutomationForUser: real Analytics + Advice
  // pipeline against real local Supabase. Every row created here is
  // tracked and deleted (+ deletion verified) before this script exits.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[C — weekly automation orchestrator: real pipeline, real DB]');

  console.log('  Ensuring shared local analytics test fixtures exist (userA/userB)...');
  const fixtures = await setupAnalyticsTestFixtures(serviceClient);
  const userAId = fixtures.userAId;
  const userBId = fixtures.userBId;

  const createdExecutionIds: number[] = [];
  const createdRunIds: number[] = [];

  // C1 — first claim for (userA, P1) actually runs.
  const P1 = 'test-weekly-automation-2026-08-05';
  const c1 = await runWeeklyAutomationForUser({ targetUserId: userAId, localPeriodKey: P1, serviceClient });
  check('C1: first claim for (userA, P1) runs Analytics and completes the execution', isCompleted(c1), c1);
  if (isCompleted(c1)) {
    createdExecutionIds.push(c1.executionId);
    createdRunIds.push(c1.analyticsRunId);
    const { data: c1Run } = await serviceClient.from('analytics_runs').select('recommendation_target_user_id, status').eq('id', c1.analyticsRunId).maybeSingle();
    check('C1: the created run is owned by userA and completed', c1Run?.recommendation_target_user_id === userAId && c1Run?.status === 'completed', c1Run);
  }

  // C2 — rerunning the same Toronto weekly period is skipped.
  const c2 = await runWeeklyAutomationForUser({ targetUserId: userAId, localPeriodKey: P1, serviceClient });
  check('C2: rerunning the same (userA, P1) weekly period is skipped, not a duplicate run', isSkipped(c2) && isCompleted(c1) && c2.executionId === c1.executionId, { c1, c2 });
  const { count: p1Count } = await serviceClient.from('analytics_automation_executions').select('id', { count: 'exact', head: true }).eq('target_user_id', userAId).eq('local_period_key', P1);
  check('C2: exactly one execution row exists for (userA, P1) after the rerun attempt', p1Count === 1, p1Count);

  // C3 — concurrent claims for a NEW period create at most one real execution.
  const P3 = 'test-weekly-automation-2026-08-12';
  const CONCURRENT_CLAIMS = 10;
  const c3results = await Promise.all(
    Array.from({ length: CONCURRENT_CLAIMS }, () => runWeeklyAutomationForUser({ targetUserId: userAId, localPeriodKey: P3, serviceClient })),
  );
  const c3completed = c3results.filter(isCompleted);
  const c3skipped = c3results.filter(isSkipped);
  check(
    `C3: ${CONCURRENT_CLAIMS} concurrent claims for the same user+period produce exactly ONE real execution`,
    c3completed.length === 1 && c3skipped.length === CONCURRENT_CLAIMS - 1,
    { completed: c3completed.length, skipped: c3skipped.length },
  );
  if (c3completed[0]) {
    createdExecutionIds.push(c3completed[0].executionId);
    createdRunIds.push(c3completed[0].analyticsRunId);
  }
  const { count: p3Count } = await serviceClient.from('analytics_automation_executions').select('id', { count: 'exact', head: true }).eq('target_user_id', userAId).eq('local_period_key', P3);
  check('C3: exactly one execution row persisted for (userA, P3) despite the concurrent claims', p3Count === 1, p3Count);

  // C4 — separate users get separate runs; no cross-contamination.
  const P4 = 'test-weekly-automation-2026-08-19';
  const c4a = await runWeeklyAutomationForUser({ targetUserId: userAId, localPeriodKey: P4, serviceClient });
  const c4b = await runWeeklyAutomationForUser({ targetUserId: userBId, localPeriodKey: P4, serviceClient });
  check('C4: userA gets their own completed execution for P4', isCompleted(c4a), c4a);
  check('C4: userB gets their own completed execution for P4', isCompleted(c4b), c4b);
  if (isCompleted(c4a)) { createdExecutionIds.push(c4a.executionId); createdRunIds.push(c4a.analyticsRunId); }
  if (isCompleted(c4b)) { createdExecutionIds.push(c4b.executionId); createdRunIds.push(c4b.analyticsRunId); }
  check(
    'C4: userA and userB received DIFFERENT analytics_run_id values for the same period',
    isCompleted(c4a) && isCompleted(c4b) && c4a.analyticsRunId !== c4b.analyticsRunId,
    { c4a, c4b },
  );
  if (isCompleted(c4a) && isCompleted(c4b)) {
    const { data: c4aRun } = await serviceClient.from('analytics_runs').select('recommendation_target_user_id').eq('id', c4a.analyticsRunId).maybeSingle();
    const { data: c4bRun } = await serviceClient.from('analytics_runs').select('recommendation_target_user_id').eq('id', c4b.analyticsRunId).maybeSingle();
    check('C4/no-cross-user-exposure: userA\'s run is owned by userA, never userB', c4aRun?.recommendation_target_user_id === userAId, c4aRun);
    check('C4/no-cross-user-exposure: userB\'s run is owned by userB, never userA', c4bRun?.recommendation_target_user_id === userBId, c4bRun);
  }

  // C5 — one user's failure/throw does not block another. A bogus target
  // user id can never occur with real production data (target_user_id is
  // always enumerated straight from app_users — see the cron route), so
  // this exercises the claim RPC's own FK guard (a throw BEFORE any
  // execution row exists to mark 'failed' against) exactly as the cron
  // route's own per-user try/catch would encounter and absorb it —
  // reproduced here the same way, rather than inside
  // runWeeklyAutomationForUser itself (which has nothing to update when
  // claiming never even succeeded).
  const P5 = 'test-weekly-automation-2026-08-26';
  const BOGUS_TARGET_USER_ID = 999999999;
  let c5Threw = false;
  try {
    await runWeeklyAutomationForUser({ targetUserId: BOGUS_TARGET_USER_ID, localPeriodKey: P5, serviceClient });
  } catch {
    c5Threw = true;
  }
  check('C5: an invalid target user throws rather than silently succeeding — exactly what the cron route\'s per-user try/catch is for', c5Threw);
  const { count: bogusExecutionCount } = await serviceClient
    .from('analytics_automation_executions')
    .select('id', { count: 'exact', head: true })
    .eq('target_user_id', BOGUS_TARGET_USER_ID);
  check('C5: no execution row was created for the invalid claim attempt (claiming itself never succeeded)', bogusExecutionCount === 0, bogusExecutionCount);

  const c5ok = await runWeeklyAutomationForUser({ targetUserId: userAId, localPeriodKey: P5, serviceClient });
  check('C5: a DIFFERENT (real) user for the SAME period still succeeds after the other one threw — one user\'s failure never blocks another', isCompleted(c5ok), c5ok);
  if (isCompleted(c5ok)) { createdExecutionIds.push(c5ok.executionId); createdRunIds.push(c5ok.analyticsRunId); }

  // "Analytics failure prevents OpenAI generation" is enforced
  // structurally in runWeeklyAutomationForUser: the catch block around
  // step 2 (Analytics) always returns a 'failed' outcome immediately —
  // there is no code path from that catch into step 3's
  // generateAdviceForRun call. Every successful case above (C1, C3, C4,
  // C5ok, C6) already exercises the "Analytics succeeded -> Advice
  // attempted" side of that same branch.

  // C6 — NO_VALID_EVIDENCE is handled without crashing: a bare user with
  // zero inventory/deals still produces a real completed Analytics run
  // (Analytics itself has no evidence requirement), but Advice generation
  // against it must terminate as a real, auditable failed/NO_VALID_
  // EVIDENCE row — never a throw.
  console.log('  Creating a bare (zero-inventory) test user for the NO_VALID_EVIDENCE case...');
  const BARE_USER_EMAIL = 'weekly-automation-bare-user@example.test';
  const { data: bareCreated, error: bareCreateError } = await serviceClient.auth.admin.createUser({
    email: BARE_USER_EMAIL,
    password: 'Weekly-Automation-Bare-User-Local-Only-1!',
    email_confirm: true,
  });
  if (bareCreateError || !bareCreated.user) throw new Error(`Failed to create bare test user: ${bareCreateError?.message}`);
  const bareAuthUserId = bareCreated.user.id;

  let bareAppUserId: number | null = null;
  for (let attempt = 0; attempt < 10 && !bareAppUserId; attempt++) {
    const { data } = await serviceClient.from('app_users').select('id').eq('auth_user_id', bareAuthUserId).maybeSingle();
    if (data) bareAppUserId = data.id as number;
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!bareAppUserId) throw new Error('bare test user app_users row never appeared (on_auth_user_created trigger may be broken)');

  const P6 = 'test-weekly-automation-2026-09-02';
  const c6 = await runWeeklyAutomationForUser({ targetUserId: bareAppUserId, localPeriodKey: P6, serviceClient });
  check('C6: a zero-inventory user still completes the EXECUTION itself (Analytics has no evidence requirement)', isCompleted(c6), c6);
  if (isCompleted(c6)) {
    createdExecutionIds.push(c6.executionId);
    createdRunIds.push(c6.analyticsRunId);
    check('C6: an advice row WAS recorded for the attempt (never silently skipped)', c6.adviceRowId !== null, c6);
    if (c6.adviceRowId !== null) {
      const { data: c6Advice } = await serviceClient.from('analytics_run_advice').select('status, error_code').eq('id', c6.adviceRowId).maybeSingle();
      check('C6: the resulting advice row is failed/NO_VALID_EVIDENCE, never a crash', c6Advice?.status === 'failed' && c6Advice?.error_code === 'NO_VALID_EVIDENCE', c6Advice);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Section D — weekly status: grace-period boundary (pure, no DB)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[D — weekly status: 60-minute grace period boundary]');

  const statusJulyWed = findThursday(2026, 7);
  statusJulyWed.setUTCDate(statusJulyWed.getUTCDate() - 1); // Thursday -> Wednesday, same week
  // EDT (UTC-4): Wednesday 21:59 Toronto = 01:59 UTC next day; 22:00 = 02:00 UTC next day.
  const before2159 = new Date(Date.UTC(statusJulyWed.getUTCFullYear(), statusJulyWed.getUTCMonth(), statusJulyWed.getUTCDate() + 1, 1, 59, 0));
  const atGraceCutoff2200 = new Date(Date.UTC(statusJulyWed.getUTCFullYear(), statusJulyWed.getUTCMonth(), statusJulyWed.getUTCDate() + 1, 2, 0, 0));
  const after2201 = new Date(Date.UTC(statusJulyWed.getUTCFullYear(), statusJulyWed.getUTCMonth(), statusJulyWed.getUTCDate() + 1, 2, 1, 0));

  const ctxBefore = getWeeklyScheduleStatusContext(before2159);
  check('no execution before the grace period (Wed 21:59 Toronto) is not marked missed', ctxBefore.pastGracePeriod === false, ctxBefore);

  const ctxAtCutoff = getWeeklyScheduleStatusContext(atGraceCutoff2200);
  check('exactly at the grace cutoff (Wed 22:00 Toronto) IS marked missed if nothing ran', ctxAtCutoff.pastGracePeriod === true, ctxAtCutoff);

  const ctxAfter = getWeeklyScheduleStatusContext(after2201);
  check('after the grace period (Wed 22:01 Toronto) is marked missed if nothing ran', ctxAfter.pastGracePeriod === true, ctxAfter);
  check('the period key is the SAME Wednesday whether before or after that Wednesday\'s own grace cutoff', ctxBefore.currentPeriodKey === ctxAfter.currentPeriodKey, { before: ctxBefore.currentPeriodKey, after: ctxAfter.currentPeriodKey });
  check('"next scheduled" before grace still points at THIS week\'s Wednesday 9pm', new Date(ctxBefore.nextScheduledAtUtc).getTime() < new Date(ctxAfter.nextScheduledAtUtc).getTime());

  // ══════════════════════════════════════════════════════════════════════
  // Section E — weekly status endpoint: real states, ownership, cross-user
  // rejection. Reuses the process.env values already set for the cron
  // route in Section B.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[E — /api/analytics/automation/status: states, ownership, cross-user rejection]');

  const { GET: statusGet } = await import('../src/app/api/analytics/automation/status/route');
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const STATUS_URL = 'http://localhost/api/analytics/automation/status';

  async function tokenFor(email: string, password: string): Promise<string> {
    const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
    return data.session.access_token;
  }

  const noAuthStatusRes = await statusGet(new NextRequest(STATUS_URL));
  check('status endpoint: missing Authorization header returns 401', noAuthStatusRes.status === 401);

  const userATokenForStatus = await tokenFor(fixtures.userAEmail, fixtures.password);
  const userBTokenForStatus = await tokenFor(fixtures.userBEmail, fixtures.password);

  const nowStatusContext = getWeeklyScheduleStatusContext();
  const statusTestPeriodKey = nowStatusContext.currentPeriodKey;

  async function insertExecutionRow(targetUserId: number, status: 'running' | 'completed' | 'failed', extra: Record<string, unknown> = {}) {
    const { data, error } = await serviceClient
      .from('analytics_automation_executions')
      .insert({
        automation_code: WEEKLY_AUTOMATION_CODE,
        target_user_id: targetUserId,
        local_period_key: statusTestPeriodKey,
        status,
        started_at: new Date().toISOString(),
        ...extra,
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`Failed to insert synthetic execution row: ${error?.message}`);
    return data.id as number;
  }

  // E1 — Running
  const runningExecId = await insertExecutionRow(userAId, 'running');
  createdExecutionIds.push(runningExecId);
  const runningRes = await statusGet(new NextRequest(STATUS_URL, { headers: { authorization: `Bearer ${userATokenForStatus}` } }));
  const runningBody = await runningRes.json();
  check('E1: a running execution reports state "running"', runningRes.status === 200 && runningBody.state === 'running', runningBody);

  // Clear it so the next case's SELECT (by period key) is unambiguous —
  // (automation_code, target_user_id, local_period_key) is unique, so a
  // second row for the same triple would itself violate the constraint;
  // delete-then-insert simulates the row's own lifecycle transitions.
  await serviceClient.from('analytics_automation_executions').delete().eq('id', runningExecId);
  createdExecutionIds.splice(createdExecutionIds.indexOf(runningExecId), 1);

  // E2 — Completed, with a related run link
  const statusTestRun = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  createdRunIds.push(statusTestRun.id);
  const completedExecId = await insertExecutionRow(userAId, 'completed', { completed_at: new Date().toISOString(), analytics_run_id: statusTestRun.id });
  createdExecutionIds.push(completedExecId);
  const completedRes = await statusGet(new NextRequest(STATUS_URL, { headers: { authorization: `Bearer ${userATokenForStatus}` } }));
  const completedBody = await completedRes.json();
  check('E2: a completed execution reports state "completed" with the related run id', completedRes.status === 200 && completedBody.state === 'completed' && completedBody.analyticsRunId === statusTestRun.id, completedBody);

  // E3 — cross-user rejection + ownership: userB has NO row for this
  // period (only userA does) — userB must never see userA's execution.
  const userBStatusRes = await statusGet(new NextRequest(STATUS_URL, { headers: { authorization: `Bearer ${userBTokenForStatus}` } }));
  const userBStatusBody = await userBStatusRes.json();
  check(
    'E3: userB never sees userA\'s execution for the same period (state is did_not_run/next_scheduled, never completed/running, and no analyticsRunId leaks through)',
    userBStatusBody.state !== 'completed' && userBStatusBody.state !== 'running' && userBStatusBody.analyticsRunId === undefined,
    userBStatusBody,
  );

  await serviceClient.from('analytics_automation_executions').delete().eq('id', completedExecId);
  createdExecutionIds.splice(createdExecutionIds.indexOf(completedExecId), 1);

  // E4 — Failed: a safe message only, never the raw error_message.
  const RAW_SECRET_LOOKING_MESSAGE = 'relation "some_internal_table" does not exist — connection string postgresql://user:pass@host/db';
  const failedExecId = await insertExecutionRow(userAId, 'failed', {
    completed_at: new Date().toISOString(),
    error_code: 'ANALYTICS_RUN_FAILED',
    error_message: RAW_SECRET_LOOKING_MESSAGE,
  });
  createdExecutionIds.push(failedExecId);
  const failedRes = await statusGet(new NextRequest(STATUS_URL, { headers: { authorization: `Bearer ${userATokenForStatus}` } }));
  const failedBodyText = await failedRes.clone().text();
  const failedBody = JSON.parse(failedBodyText);
  check('E4: a failed execution reports state "failed"', failedRes.status === 200 && failedBody.state === 'failed', failedBody);
  check('E4: the raw error_message is NEVER returned by the status endpoint', !failedBodyText.includes(RAW_SECRET_LOOKING_MESSAGE), failedBodyText);
  check('E4: a safe, generic user-facing message is returned instead', typeof failedBody.message === 'string' && failedBody.message.length > 0, failedBody);

  await serviceClient.from('analytics_automation_executions').delete().eq('id', failedExecId);
  createdExecutionIds.splice(createdExecutionIds.indexOf(failedExecId), 1);

  // E5 — Did not run / Next scheduled: no row exists for this period at
  // all (already true — the above cases each cleaned up after
  // themselves). The route must agree with getWeeklyScheduleStatusContext
  // computed at (approximately) the same real "now".
  const noRowRes = await statusGet(new NextRequest(STATUS_URL, { headers: { authorization: `Bearer ${userATokenForStatus}` } }));
  const noRowBody = await noRowRes.json();
  const expectedState = nowStatusContext.pastGracePeriod ? 'did_not_run' : 'next_scheduled';
  check(
    `E5: with no execution row, the endpoint reports "${expectedState}" — consistent with the current real Toronto grace-period state`,
    noRowRes.status === 200 && noRowBody.state === expectedState,
    { noRowBody, nowStatusContext },
  );

  // ══════════════════════════════════════════════════════════════════════
  // Section F — a manual Analytics run must never alter a failed weekly
  // execution row for the same user.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[F — manual Analytics run does not alter a failed weekly execution]');

  const independenceExecId = await insertExecutionRow(userAId, 'failed', {
    local_period_key: 'test-weekly-automation-independence-period',
    completed_at: new Date().toISOString(),
    error_code: 'ANALYTICS_RUN_FAILED',
    error_message: 'synthetic failure for the manual-run-independence test',
  });
  createdExecutionIds.push(independenceExecId);

  const { data: beforeRow } = await serviceClient.from('analytics_automation_executions').select('*').eq('id', independenceExecId).single();

  const manualRun = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  createdRunIds.push(manualRun.id);

  const { data: afterRow } = await serviceClient.from('analytics_automation_executions').select('*').eq('id', independenceExecId).single();
  check(
    'F: a manual Analytics run leaves the failed weekly execution row byte-for-byte unchanged',
    JSON.stringify(beforeRow) === JSON.stringify(afterRow),
    { beforeRow, afterRow },
  );

  // ══════════════════════════════════════════════════════════════════════
  // Cleanup + verification (required for every persistent concurrency
  // test): delete every row this section created and verify zero remain.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[cleanup] Removing weekly-automation test fixtures...');

  if (createdExecutionIds.length > 0) {
    await serviceClient.from('analytics_automation_executions').delete().in('id', createdExecutionIds);
  }
  if (createdRunIds.length > 0) {
    // Cascades each run's own analytics_run_advice rows via the hardened
    // composite FK (ON DELETE CASCADE) — no separate advice cleanup needed.
    await serviceClient.from('analytics_runs').delete().in('id', createdRunIds);
  }
  await serviceClient.auth.admin.deleteUser(bareAuthUserId);

  const { data: leftoverExecutions } = await serviceClient
    .from('analytics_automation_executions')
    .select('id')
    .in('id', createdExecutionIds.length > 0 ? createdExecutionIds : [-1]);
  const { data: leftoverRuns } = await serviceClient
    .from('analytics_runs')
    .select('id')
    .in('id', createdRunIds.length > 0 ? createdRunIds : [-1]);
  const { data: leftoverBareUser } = await serviceClient.from('app_users').select('id').eq('auth_user_id', bareAuthUserId);

  check('cleanup: every created automation_executions row was removed', (leftoverExecutions?.length ?? 0) === 0, leftoverExecutions);
  check('cleanup: every created analytics_runs row was removed (advice cascaded with it)', (leftoverRuns?.length ?? 0) === 0, leftoverRuns);
  check('cleanup: the bare test user was removed', (leftoverBareUser?.length ?? 0) === 0, leftoverBareUser);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
