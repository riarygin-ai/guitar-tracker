/**
 * test-coach-refresh-timeout.ts
 *
 * Regression coverage for the 2026-11-12 weekly failure: both users' Analytics
 * runs (#59/#60) failed with "Snapshot builder error: canceling statement due
 * to statement timeout" (SQLSTATE 57014) after ~9-10 s.
 *
 * Root cause (investigated 2026-11-13): build_analytics_snapshot_v2_13 is ONE
 * PostgREST statement composed of 14 nested builder layers. It normally takes
 * 2-4 s in production but inherited the authenticator role's interactive 8 s
 * statement_timeout, and identical read-only calls in production varied
 * 1.0 s -> 8.6 s within minutes. Before the fix, the weekly run also built
 * the same Listing Demand evidence twice concurrently (Coach + Listing Advice)
 * around the snapshot. No single query regressed (248 items).
 *
 * Covers:
 *   A. the fix is attached to the function the runner actually calls, and
 *      is batch-scoped (service-role only), not a global timeout change
 *   B. performance budget: the builder on the local fixture stays fast
 *      (a regression that multiplies its cost shows up here first)
 *   C. one in-flight Analytics run per user (no accidental duplicate runs),
 *      and an abandoned in-flight row never blocks the user
 *   D. the refresh builds the shared Listing Demand evidence ONCE
 *
 * Local Supabase only (safety-gated); every created row is deleted.
 * Usage:  npx tsx scripts/test-coach-refresh-timeout.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, assertLocalSupabaseUrl, assertLocalSupabaseIsRunning, setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { AnalyticsRunError, STALE_INFLIGHT_RUN_MS, runAnalyticsForCurrentUser } from '../src/lib/analytics/runAnalytics';
import { runCoachRefresh } from '../src/lib/analytics/coachRefresh';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}
const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

async function main() {
  console.log('\n[A — the timeout fix targets the builder the runner calls, batch-scoped]');
  {
    const mig = read('supabase', 'migrations', '20261113000000_weekly_coach_refresh.sql');
    const runner = read('src', 'lib', 'analytics', 'runAnalytics.ts');
    const rpc = /const SNAPSHOT_BUILDER_RPC = '([a-z0-9_]+)'/.exec(runner)?.[1];
    check('the runner calls build_analytics_snapshot_v2_13', rpc === 'build_analytics_snapshot_v2_13', rpc);
    check('the migration sets a function-level statement_timeout on exactly that builder (PostgREST applies it per call)', new RegExp(`ALTER FUNCTION public\\.${rpc}\\(int\\) SET statement_timeout = '25s';`).test(mig));
    check('no role-wide / database-wide timeout change (interactive endpoints keep 8 s)', !/ALTER (ROLE|DATABASE)[\s\S]*statement_timeout/i.test(mig));
    const grants = fs.readdirSync(path.join(root, 'supabase', 'migrations')).filter((f) => f.includes('build_analytics_snapshot_v2_13')).map((f) => read('supabase', 'migrations', f)).join('\n');
    check('the builder is executable by service_role only (anon/authenticated revoked)', /REVOKE ALL ON FUNCTION public\.build_analytics_snapshot_v2_13\(int\) FROM authenticated;/.test(grants) && /GRANT EXECUTE ON FUNCTION public\.build_analytics_snapshot_v2_13\(int\) TO service_role;/.test(grants));
    check('route budgets fit snapshot + two model calls (weekly cron 300 s, manual refresh 300 s)', /maxDuration = 300;/.test(read('src', 'app', 'api', 'cron', 'weekly-analytics-advice', 'route.ts')) && /maxDuration = 300;/.test(read('src', 'app', 'api', 'analytics', 'runs', 'route.ts')));
  }

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const fixtures = await setupAnalyticsTestFixtures(admin);
  const userId = fixtures.userAId;
  const createdRunIds: number[] = [];

  try {
    console.log('\n[B — performance budget on the local fixture]');
    {
      const times: number[] = [];
      let lastError: string | null = null;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const { error } = await admin.rpc('build_analytics_snapshot_v2_13', { p_target_user_id: userId });
        times.push(Date.now() - t0);
        if (error) lastError = error.message;
      }
      times.sort((a, b) => a - b);
      check('the builder succeeds through PostgREST as service_role', lastError === null, lastError);
      // Local baseline 2026-11-13: ~0.2-0.35 s. Generous ceiling; a multiplied cost (N+1, repeated view evaluation) trips it.
      check(`median builder time stays well under budget (median ${times[1]} ms < 3000 ms)`, times[1] < 3000, times);
    }

    console.log('\n[C — one in-flight Analytics run per user]');
    {
      const [a, b] = await Promise.allSettled([
        runAnalyticsForCurrentUser({ appUserId: userId, serviceClient: admin }),
        runAnalyticsForCurrentUser({ appUserId: userId, serviceClient: admin }),
      ]);
      for (const r of [a, b]) if (r.status === 'fulfilled') createdRunIds.push(r.value.id);
      const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      check('two simultaneous runs for one user: exactly one runs, the other is refused with 409', createdRunIds.length === 1 && rejected.length === 1 && rejected[0].reason instanceof AnalyticsRunError && rejected[0].reason.status === 409, { createdRunIds, rejected: rejected.map((r) => String(r.reason)) });
      const { count } = await admin.from('analytics_runs').select('id', { count: 'exact', head: true }).eq('requested_by_user_id', userId).in('status', ['pending', 'running']);
      check('nothing is left in flight afterwards', count === 0, count);

      // An abandoned in-flight row (function killed mid-run) must never block the user.
      const staleAt = new Date(Date.now() - STALE_INFLIGHT_RUN_MS - 60_000).toISOString();
      const { data: stale } = await admin.from('analytics_runs').insert({ requested_by_user_id: userId, recommendation_target_user_id: userId, analytics_version: '2.13', evidence_scope: 'shared_inventory_population', status: 'running', started_at: staleAt, created_at: staleAt }).select('id').single();
      if (stale) createdRunIds.push(stale.id as number);
      const fresh = await runAnalyticsForCurrentUser({ appUserId: userId, serviceClient: admin });
      createdRunIds.push(fresh.id);
      const { data: staleAfter } = await admin.from('analytics_runs').select('status, error_message').eq('id', stale?.id ?? -1).single();
      check('an abandoned run older than the stale threshold is failed out and the new run proceeds', fresh.status === 'completed' && staleAfter?.status === 'failed' && /abandoned/.test(staleAfter?.error_message ?? ''), staleAfter);
    }

    console.log('\n[D — shared Listing Demand evidence is built ONCE per refresh]');
    {
      let loads = 0;
      const r = await runCoachRefresh({ appUserId: userId, serviceClient: admin, deps: {
        loadListingDemand: async () => { loads++; throw new Error('stub'); },
        generateCoachAdvice: async (p) => ({ status: 'skipped', reason: p.listingDemand === null ? 'NO_SHARED_DEMAND' : 'X' }),
        generateListingAdvice: async () => ({ status: 'already_generating' }),
      } });
      if (r.analyticsRunId) createdRunIds.push(r.analyticsRunId);
      check('one evidence load per refresh; the Coach is handed the shared result (not a second build)', loads === 1 && r.general.code === 'NO_SHARED_DEMAND', { loads, general: r.general });
    }
  } finally {
    if (createdRunIds.length) await admin.from('analytics_runs').delete().in('id', createdRunIds);
    const { data: left } = await admin.from('analytics_runs').select('id').in('id', createdRunIds.length ? createdRunIds : [-1]);
    check('cleanup: every created run removed', (left?.length ?? 0) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
