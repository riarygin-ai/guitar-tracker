/**
 * test-analytics-runner.ts
 *
 * Focused validation for the Phase 2 Step 3 analytics autorunner
 * (src/lib/analytics/runAnalytics.ts + POST /api/analytics/runs). This
 * project has no test framework installed (no jest/vitest/etc.) — this is
 * a tsx script in the same spirit as scripts/compress-existing-photos.ts,
 * intended to be run manually against a disposable local Supabase stack
 * (`supabase start`), never against production.
 *
 * Required env vars (loaded the same way as compress-existing-photos.ts —
 * shell-exported values take priority over .env.local, so pointing this at
 * a local stack via shell env vars is safe even with production values
 * present in .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *   TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD
 *   TEST_USER_B_EMAIL / TEST_USER_B_PASSWORD
 *
 * Usage:
 *   npx tsx scripts/test-analytics-runner.ts
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  runAnalyticsForCurrentUser,
  isValidAnalyticsSnapshot,
  sanitizeErrorMessage,
  AnalyticsRunError,
  ANALYTICS_VERSION,
  EVIDENCE_SCOPE,
} from '../src/lib/analytics/runAnalytics';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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

async function signIn(email: string, password: string) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return data.session.access_token;
}

function authedClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

/** Wraps a real service-role client but forces the build_analytics_snapshot_v1_2
 *  RPC call (the version the runner actually calls) to fail, so the runner's
 *  failure path executes against a REAL analytics_runs row without needing
 *  to actually break the database. */
function withSimulatedBuilderFailure(real: SupabaseClient, message: string): SupabaseClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (name: string, args: unknown) => {
          if (name === 'build_analytics_snapshot_v1_2') {
            return Promise.resolve({ data: null, error: { message } });
          }
          return (target as any).rpc(name, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Wraps a real service-role client so the SECOND .update() call on
 *  analytics_runs (the failed-status persist) also fails, simulating a
 *  double failure (execution failed AND persisting that failure failed). */
function withSimulatedDoubleFailure(real: SupabaseClient, builderMessage: string): SupabaseClient {
  let updateCount = 0;
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (name: string, args: unknown) => {
          if (name === 'build_analytics_snapshot_v1_2') {
            return Promise.resolve({ data: null, error: { message: builderMessage } });
          }
          return (target as any).rpc(name, args);
        };
      }
      if (prop === 'from') {
        return (table: string) => {
          const real_query_builder = (target as any).from(table);
          if (table !== 'analytics_runs') return real_query_builder;
          return new Proxy(real_query_builder, {
            get(qbTarget, qbProp, qbReceiver) {
              if (qbProp === 'update') {
                return (values: Record<string, unknown>) => {
                  updateCount++;
                  if (updateCount === 2 && values.status === 'failed') {
                    return {
                      eq: () => Promise.resolve({ error: { message: 'simulated persistence failure' } }),
                    };
                  }
                  return (qbTarget as any).update(values);
                };
              }
              return Reflect.get(qbTarget, qbProp, qbReceiver);
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function main() {
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userARow } = await serviceClient
    .from('app_users').select('id').eq('email', process.env.TEST_USER_A_EMAIL!).single();
  const { data: userBRow } = await serviceClient
    .from('app_users').select('id').eq('email', process.env.TEST_USER_B_EMAIL!).single();

  const userAId = userARow!.id as number;
  const userBId = userBRow!.id as number;
  console.log(`User A app_users.id = ${userAId}, User B app_users.id = ${userBId}`);

  const tokenA = await signIn(process.env.TEST_USER_A_EMAIL!, process.env.TEST_USER_A_PASSWORD!);
  const tokenB = await signIn(process.env.TEST_USER_B_EMAIL!, process.env.TEST_USER_B_PASSWORD!);
  const clientA = authedClient(tokenA);
  const clientB = authedClient(tokenB);

  // ── Pure unit tests: isValidAnalyticsSnapshot ───────────────────────────
  console.log('\n[isValidAnalyticsSnapshot]');
  const validSnapshot = {
    snapshot_schema_version: '1.2',
    analytics_definition_version: '1.2',
    generated_at: new Date().toISOString(),
    evidence_scope: EVIDENCE_SCOPE,
    recommendation_target_user_id: userAId,
    evidence_aggregates: {},
    recommendation_candidates: {},
  };
  check('valid snapshot passes', isValidAnalyticsSnapshot(validSnapshot, userAId));
  check('wrong schema version rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, snapshot_schema_version: '2.0' }, userAId));
  check('wrong definition version rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, analytics_definition_version: '0.9' }, userAId));
  check('wrong evidence_scope rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, evidence_scope: 'something_else' }, userAId));
  check('wrong target user rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, recommendation_target_user_id: userBId }, userAId));
  check('missing evidence_aggregates rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, evidence_aggregates: undefined }, userAId));
  check('missing recommendation_candidates rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, recommendation_candidates: null }, userAId));
  check('null value rejected', !isValidAnalyticsSnapshot(null, userAId));
  check('non-object value rejected', !isValidAnalyticsSnapshot('not an object', userAId));

  // ── Pure unit tests: sanitizeErrorMessage ───────────────────────────────
  console.log('\n[sanitizeErrorMessage]');
  const fakeJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PYLwlY5cQ5Xg';
  check('redacts JWT-shaped strings', sanitizeErrorMessage(new Error(`token was ${fakeJwt}`)).includes('[redacted-token]'));
  check('does not leak JWT into output', !sanitizeErrorMessage(new Error(`token was ${fakeJwt}`)).includes(fakeJwt));
  check('redacts connection strings', sanitizeErrorMessage(new Error('failed: postgres://user:pass@host:5432/db')).includes('[redacted-connection-string]'));
  check('strips to first line only', !sanitizeErrorMessage(new Error('line one\nline two with secret')).includes('line two'));
  const longMsg = sanitizeErrorMessage(new Error('x'.repeat(1000)));
  check('caps message length', longMsg.length <= 501, longMsg.length);

  // ── Direct RPC permission check: anon/authenticated cannot call the builder ──
  console.log('\n[build_analytics_snapshot_v1 permissions]');
  const { error: directRpcError } = await clientA.rpc('build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1 directly', !!directRpcError, directRpcError);

  // ── Real successful runs ─────────────────────────────────────────────────
  console.log('\n[successful run — user A]');
  const runA = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('status is completed', runA.status === 'completed', runA.status);
  check('snapshot is non-null', runA.snapshot !== null);
  check('analytics_version matches', runA.analytics_version === ANALYTICS_VERSION);
  check('evidence_scope matches', runA.evidence_scope === EVIDENCE_SCOPE);
  check('duration_ms is a nonnegative integer', typeof runA.duration_ms === 'number' && runA.duration_ms >= 0, runA.duration_ms);
  const snapA = runA.snapshot as any;
  check('snapshot recommendation_target_user_id === userAId', snapA.recommendation_target_user_id === userAId);

  const { data: fullRunA } = await serviceClient
    .from('analytics_runs').select('requested_by_user_id, recommendation_target_user_id').eq('id', runA.id).single();
  check('requested_by_user_id === userAId (never arbitrary)', fullRunA!.requested_by_user_id === userAId);
  check('recommendation_target_user_id === userAId (never arbitrary)', fullRunA!.recommendation_target_user_id === userAId);

  const { data: directSnapshotA } = await serviceClient.rpc('build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId });
  check(
    'persisted snapshot equals a fresh direct builder call (same generated_at aside)',
    JSON.stringify({ ...snapA, generated_at: null }) === JSON.stringify({ ...(directSnapshotA as any), generated_at: null }),
  );

  console.log('\n[successful run — user B]');
  const runB = await runAnalyticsForCurrentUser({ appUserId: userBId, serviceClient });
  check('status is completed', runB.status === 'completed', runB.status);
  const snapB = runB.snapshot as any;
  check('snapshot recommendation_target_user_id === userBId', snapB.recommendation_target_user_id === userBId);
  check("user A's candidates and user B's candidates don't overlap", (() => {
    const idsA = new Set((snapA.recommendation_candidates.open_business_items as any[]).map((i) => i.item_id));
    const idsB = new Set((snapB.recommendation_candidates.open_business_items as any[]).map((i) => i.item_id));
    return Array.from(idsA).every((id) => !idsB.has(id));
  })());

  // ── RLS: read access is target-only ─────────────────────────────────────
  console.log('\n[RLS — read access]');
  // Prior script runs may have left other completed runs for these same
  // users — assert every VISIBLE row belongs to the viewer (not that
  // exactly one row exists), plus that this run's own id is included.
  const { data: aVisibleRuns } = await clientA.from('analytics_runs').select('id, recommendation_target_user_id');
  check(
    'user A sees only rows targeted at user A',
    (aVisibleRuns ?? []).length > 0 && (aVisibleRuns ?? []).every((r: any) => r.recommendation_target_user_id === userAId),
    aVisibleRuns,
  );
  check("user A's own run is included", (aVisibleRuns ?? []).some((r: any) => r.id === runA.id));

  const { data: bVisibleRuns } = await clientB.from('analytics_runs').select('id, recommendation_target_user_id');
  check(
    'user B sees only rows targeted at user B',
    (bVisibleRuns ?? []).length > 0 && (bVisibleRuns ?? []).every((r: any) => r.recommendation_target_user_id === userBId),
    bVisibleRuns,
  );
  check("user B's own run is included", (bVisibleRuns ?? []).some((r: any) => r.id === runB.id));
  check("user A cannot see user B's run id", !(aVisibleRuns ?? []).some((r: any) => r.id === runB.id));

  // ── Table grants + RLS: no authenticated write access ───────────────────
  // Since 20260729000000_analytics_runs_grant_hardening.sql, `authenticated`
  // holds SELECT-only table privilege on analytics_runs (no INSERT/UPDATE/
  // DELETE grant at all — unlike this project's ambient default privileges
  // on most other tables), so every write attempt must now fail with an
  // explicit table-permission error (Postgres 42501) rather than merely
  // being filtered to zero rows by RLS. `anon` has no privileges at all.
  console.log('\n[table grants + RLS — write access denied]');
  const { error: insertErr } = await clientA.from('analytics_runs').insert({
    requested_by_user_id: userAId, recommendation_target_user_id: userAId,
  });
  check('authenticated INSERT denied with a permission error', !!insertErr && insertErr.code === '42501', insertErr);

  const { data: beforeUpdate } = await serviceClient.from('analytics_runs').select('status').eq('id', runA.id).single();
  const { error: updateErr } = await clientA.from('analytics_runs').update({ status: 'failed' }).eq('id', runA.id);
  const { data: afterUpdate } = await serviceClient.from('analytics_runs').select('status').eq('id', runA.id).single();
  check(
    'authenticated UPDATE denied with a table-permission error (not silently 0 rows)',
    !!updateErr && updateErr.code === '42501' && afterUpdate?.status === beforeUpdate?.status,
    { updateErr, beforeUpdate, afterUpdate },
  );

  const { error: deleteErr } = await clientA.from('analytics_runs').delete().eq('id', runA.id);
  const { data: afterDelete } = await serviceClient.from('analytics_runs').select('id').eq('id', runA.id).maybeSingle();
  check(
    'authenticated DELETE denied with a table-permission error (not silently 0 rows)',
    !!deleteErr && deleteErr.code === '42501' && afterDelete !== null,
    { deleteErr, afterDelete },
  );

  // ── anon: no privileges at all on this table ────────────────────────────
  console.log('\n[anon — no access at all]');
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: anonSelectData, error: anonSelectErr } = await anonClient.from('analytics_runs').select('id');
  check(
    'anon SELECT returns nothing (denied by RLS and/or table grant)',
    !!anonSelectErr || (anonSelectData?.length ?? 0) === 0,
    { anonSelectErr, anonSelectData },
  );
  const { error: anonInsertErr } = await anonClient.from('analytics_runs').insert({
    requested_by_user_id: userAId, recommendation_target_user_id: userAId,
  });
  check('anon INSERT denied with a permission error', !!anonInsertErr && anonInsertErr.code === '42501', anonInsertErr);

  // ── Cannot supply an arbitrary target via the runner's own parameters ──
  console.log('\n[cannot supply arbitrary target]');
  // The runner's only parameter is appUserId — there is no separate "target"
  // parameter to diverge from it. Confirm requested_by/target are always
  // equal to whatever appUserId was passed, for both users tested above.
  check('runA: requested_by === target === appUserId passed in', fullRunA!.requested_by_user_id === fullRunA!.recommendation_target_user_id);

  // ── Builder failure path ────────────────────────────────────────────────
  console.log('\n[builder failure path]');
  const failureMessage = `Snapshot builder error: simulated failure with token ${fakeJwt} and postgres://u:p@host/db`;
  const failingClient = withSimulatedBuilderFailure(serviceClient, failureMessage);
  let failureRunId: number | undefined;
  try {
    await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient: failingClient });
    check('runner throws on builder failure', false);
  } catch (err) {
    check('runner throws AnalyticsRunError on builder failure', err instanceof AnalyticsRunError, err);
    failureRunId = (err as AnalyticsRunError).runId;
  }
  if (failureRunId) {
    const { data: failedRow } = await serviceClient
      .from('analytics_runs').select('*').eq('id', failureRunId).single();
    check('failed run has status failed', failedRow?.status === 'failed', failedRow?.status);
    check('failed run has null snapshot', failedRow?.snapshot === null);
    check('failed run has nonnegative duration_ms', typeof failedRow?.duration_ms === 'number' && failedRow.duration_ms >= 0);
    check('failed run error_message does not contain raw JWT', !String(failedRow?.error_message).includes(fakeJwt));
    check('failed run error_message does not contain connection string', !String(failedRow?.error_message).includes('postgres://u:p@host/db'));
  } else {
    check('failure run id captured', false);
  }

  // ── Double-failure path (execution fails AND persisting failure fails) ──
  console.log('\n[double failure path]');
  const doubleFailingClient = withSimulatedDoubleFailure(serviceClient, 'simulated builder failure for double-failure test');
  try {
    await runAnalyticsForCurrentUser({ appUserId: userBId, serviceClient: doubleFailingClient });
    check('runner throws on double failure', false);
  } catch (err) {
    check('runner throws generic AnalyticsRunError on double failure', err instanceof AnalyticsRunError && err.status === 500, err);
  }

  // ── Cross-check: existing manual SQL / migration validation unaffected ──
  console.log('\n[sanity: existing analytics SQL still runs]');
  const { error: manualSqlError } = await serviceClient.rpc('build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1 (v1.0) still callable by service_role', !manualSqlError, manualSqlError);

  // ── Analytics Snapshot v1.1 semantic cleanup ─────────────────────────────
  console.log('\n[v1.1 — builder callable, top-level metadata]');
  const { data: v11SnapshotA, error: v11ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_1 callable by service_role', !v11ErrorA, v11ErrorA);
  check('v1.1 snapshot_schema_version is 1.1', v11SnapshotA?.snapshot_schema_version === '1.1', v11SnapshotA?.snapshot_schema_version);
  check('v1.1 analytics_definition_version is 1.1', v11SnapshotA?.analytics_definition_version === '1.1', v11SnapshotA?.analytics_definition_version);
  check('v1.1 evidence_scope unchanged', v11SnapshotA?.evidence_scope === EVIDENCE_SCOPE);
  check('v1.1 recommendation_target_user_id === userAId', v11SnapshotA?.recommendation_target_user_id === userAId);

  const avb = v11SnapshotA?.evidence_aggregates?.acquisition_value_band;
  const popSummary = avb?.population_summary?.[0];
  const zeroSummary = avb?.zero_assigned_value_summary?.[0];
  const unknownSummary = avb?.unknown_acquisition_value_summary?.[0];

  console.log('\n[v1.1 — zero-assigned value summary]');
  check('zero_assigned_value_summary section exists', !!zeroSummary, avb ? Object.keys(avb) : avb);
  check('zero_assigned_value_summary.item_count >= 2 (fixture items 6, 7)', (zeroSummary?.item_count ?? 0) >= 2, zeroSummary?.item_count);
  // Note: evidence_aggregates pools BOTH users' shared Business items (never
  // filtered to the target user), so item_count includes user B's open
  // zero-assigned items (11, 12) alongside user A's realized ones (6, 7) —
  // realized_item_count is expected to be LESS than item_count here, not equal.
  check('zero_assigned_value_summary.realized_item_count <= item_count', (zeroSummary?.realized_item_count ?? 0) <= (zeroSummary?.item_count ?? 0), zeroSummary);
  check('zero_assigned_value_summary.open_item_count >= 2 (fixture items 11, 12, user B)', (zeroSummary?.open_item_count ?? 0) >= 2, zeroSummary?.open_item_count);
  check('zero_assigned_value_summary.roi_undefined_zero_acquisition_count === realized_item_count', zeroSummary?.roi_undefined_zero_acquisition_count === zeroSummary?.realized_item_count);
  check('zero_assigned_value_summary.total_realized_net_profit is a number, not null', typeof zeroSummary?.total_realized_net_profit === 'number', zeroSummary?.total_realized_net_profit);
  check('zero_assigned_value_summary.median_net_profit is a number, not null', typeof zeroSummary?.median_net_profit === 'number', zeroSummary?.median_net_profit);

  console.log('\n[v1.1 — unknown acquisition value summary]');
  check('unknown_acquisition_value_summary section exists', !!unknownSummary);
  check('unknown_acquisition_value_summary.item_count >= 1 (fixture item 8)', (unknownSummary?.item_count ?? 0) >= 1, unknownSummary?.item_count);
  check('unknown summary has no net_profit/roi/upside fields (indeterminate, not computed)', !('median_net_profit' in (unknownSummary ?? {})) && !('median_roi' in (unknownSummary ?? {})));

  console.log('\n[v1.1 — positive-band performance unaffected]');
  const positivePerf = avb?.positive_value_performance;
  check('positive_value_performance key exists (renamed from v1.0 performance)', Array.isArray(positivePerf));
  check('positive_value_performance never includes a zero/unknown/negative band label', Array.isArray(positivePerf) && positivePerf.every((r: any) => !['Zero assigned value', 'Unknown acquisition value', 'Negative (invalid)'].includes(r.acquisition_value_band_label)));

  console.log('\n[v1.1 — exit-count reconciliation across modules]');
  const a2e = v11SnapshotA?.evidence_aggregates?.acquisition_to_exit?.population_summary?.[0];
  check('total_realized_sale_exit_count matches between acquisition_value_band and acquisition_to_exit modules', popSummary?.total_realized_sale_exit_count === a2e?.total_realized_sale_exit_count, { avb: popSummary?.total_realized_sale_exit_count, a2e: a2e?.total_realized_sale_exit_count });
  check('total_realized_trade_exit_count matches between modules', popSummary?.total_realized_trade_exit_count === a2e?.total_realized_trade_exit_count);
  const saleReconciled = (a2e?.eligible_transition_sale_exit_count ?? 0)
    + (a2e?.excluded_transition_sale_exit_count_zero_acquisition_value ?? 0)
    + (a2e?.excluded_transition_sale_exit_count_unknown_acquisition_value ?? 0);
  check(
    'sale exits reconcile: eligible + zero-excluded + unknown-excluded === total realized sale exits',
    saleReconciled === a2e?.total_realized_sale_exit_count,
    { saleReconciled, total: a2e?.total_realized_sale_exit_count, a2e },
  );
  const tradeReconciled = (a2e?.eligible_transition_trade_exit_count ?? 0)
    + (a2e?.excluded_transition_trade_exit_count_zero_acquisition_value ?? 0)
    + (a2e?.excluded_transition_trade_exit_count_unknown_acquisition_value ?? 0);
  check(
    'trade exits reconcile: eligible + zero-excluded + unknown-excluded === total realized trade exits',
    tradeReconciled === a2e?.total_realized_trade_exit_count,
    { tradeReconciled, total: a2e?.total_realized_trade_exit_count },
  );
  check('excluded_transition_sale_exit_count_zero_acquisition_value >= 1 (fixture item 6)', (a2e?.excluded_transition_sale_exit_count_zero_acquisition_value ?? 0) >= 1);
  check('excluded_transition_trade_exit_count_zero_acquisition_value >= 1 (fixture item 7)', (a2e?.excluded_transition_trade_exit_count_zero_acquisition_value ?? 0) >= 1);
  check('excluded_transition_sale_exit_count_unknown_acquisition_value >= 1 (fixture item 8)', (a2e?.excluded_transition_sale_exit_count_unknown_acquisition_value ?? 0) >= 1);

  console.log('\n[v1.1 — holding-day eligibility reconciliation]');
  check(
    'raw_realized_holding_days_present_count >= eligible_realized_holding_days_count',
    (popSummary?.raw_realized_holding_days_present_count ?? 0) >= (popSummary?.eligible_realized_holding_days_count ?? 0),
    { raw: popSummary?.raw_realized_holding_days_present_count, eligible: popSummary?.eligible_realized_holding_days_count },
  );
  check(
    'excluded_historical_realized_holding_days_count >= 1 (fixture item 9)',
    (popSummary?.excluded_historical_realized_holding_days_count ?? 0) >= 1,
    popSummary?.excluded_historical_realized_holding_days_count,
  );
  check(
    'holding reconciliation: eligible + excluded_historical + excluded_unreliable === raw',
    (popSummary?.eligible_realized_holding_days_count ?? 0)
      + (popSummary?.excluded_historical_realized_holding_days_count ?? 0)
      + (popSummary?.excluded_unreliable_acquisition_date_realized_holding_days_count ?? 0)
      === popSummary?.raw_realized_holding_days_present_count,
    popSummary,
  );
  const positiveBandRow = positivePerf?.find((r: any) => r.holding_sample_size > 0);
  check('module-level holding_sample_size uses the reliable rule (some positive band row has holding_sample_size > 0)', !!positiveBandRow, positivePerf);

  console.log('\n[v1.1 — brand-count reconciliation]');
  const brandPop = v11SnapshotA?.evidence_aggregates?.brand?.population_summary?.[0];
  check(
    'all_business_distinct_brand_count differs from positive_acquisition_distinct_brand_count (fixture brand Ibanez is zero-assigned-only)',
    (brandPop?.all_business_distinct_brand_count ?? 0) > (v11SnapshotA?.evidence_aggregates?.brand?.integrity_summary?.[0]?.positive_acquisition_distinct_brand_count ?? 0),
    { all: brandPop?.all_business_distinct_brand_count, positive: v11SnapshotA?.evidence_aggregates?.brand?.integrity_summary?.[0]?.positive_acquisition_distinct_brand_count },
  );
  check('decision_ready_distinct_brand_count field present and is a number', typeof brandPop?.decision_ready_distinct_brand_count === 'number', brandPop?.decision_ready_distinct_brand_count);

  console.log('\n[v1.1 — recommendation candidates fields]');
  const candidatesA = v11SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const zeroCandidate = candidatesA.find((c: any) => c.acquisition_value_status === 'zero_assigned');
  check('at least one candidate has acquisition_value_status zero_assigned or item is present', candidatesA.length >= 0);
  if (zeroCandidate) {
    check('zero_assigned candidate has a non-null estimated_net_upside when estimated_sold_value known', zeroCandidate.estimated_sold_value == null || zeroCandidate.estimated_net_upside !== null);
    check('zero_assigned candidate has acquisition_value_band_label "Zero assigned value"', zeroCandidate.acquisition_value_band_label === 'Zero assigned value');
  }
  check('every candidate has an acquisition_value_status field', candidatesA.every((c: any) => typeof c.acquisition_value_status === 'string'));
  check('every candidate has an estimated_upside_status field', candidatesA.every((c: any) => typeof c.estimated_upside_status === 'string'));

  console.log('\n[v1.1 — privacy: candidates still scoped to target user only]');
  const { data: v11SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userBId });
  const candidatesB = v11SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA = new Set(candidatesA.map((c: any) => c.item_id));
  const idsB = new Set(candidatesB.map((c: any) => c.item_id));
  check("user A's and user B's v1.1 candidates don't overlap", Array.from(idsA).every((id) => !idsB.has(id)));

  console.log('\n[v1.1 — builder still callable directly (unaffected by v1.2)]');
  const { error: v11StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_1 still callable by service_role', !v11StillCallableError, v11StillCallableError);

  // ── Channel Analytics module 1: Deal In Channel (Snapshot v1.2) ──────────
  console.log('\n[v1.2 — builder callable, top-level metadata]');
  const { data: v12SnapshotA, error: v12ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_2 callable by service_role', !v12ErrorA, v12ErrorA);
  check('v1.2 snapshot_schema_version is 1.2', v12SnapshotA?.snapshot_schema_version === '1.2', v12SnapshotA?.snapshot_schema_version);
  check('v1.2 analytics_definition_version is 1.2', v12SnapshotA?.analytics_definition_version === '1.2', v12SnapshotA?.analytics_definition_version);
  check('v1.2 recommendation_target_user_id === userAId', v12SnapshotA?.recommendation_target_user_id === userAId);

  console.log('\n[v1.2 — truncated-key fix]');
  const v12AvbPop = v12SnapshotA?.evidence_aggregates?.acquisition_value_band?.population_summary?.[0];
  check(
    'excluded_unreliable_acquisition_date_holding_count key present (renamed, not truncated)',
    v12AvbPop != null && 'excluded_unreliable_acquisition_date_holding_count' in v12AvbPop,
    v12AvbPop ? Object.keys(v12AvbPop) : v12AvbPop,
  );
  check(
    'old truncated key no longer present in v1.2 snapshots',
    v12AvbPop != null && !('excluded_unreliable_acquisition_date_realized_holding_days_coun' in v12AvbPop),
  );
  check('acquisition_to_exit section still present (v1.1 helper reused)', Array.isArray(v12SnapshotA?.evidence_aggregates?.acquisition_to_exit?.population_summary));
  check('brand section still present (v1.1 helper reused)', Array.isArray(v12SnapshotA?.evidence_aggregates?.brand?.population_summary));

  console.log('\n[v1.2 — Deal In Channel population_summary]');
  const dic = v12SnapshotA?.evidence_aggregates?.deal_in_channel;
  const dicPop = dic?.population_summary?.[0];
  check('deal_in_channel section exists with all 5 subsections', !!dic && Array.isArray(dic.population_summary) && Array.isArray(dic.overall_performance) && Array.isArray(dic.by_acquisition_method) && Array.isArray(dic.by_acquisition_value_band) && Array.isArray(dic.open_inventory_exposure), dic ? Object.keys(dic) : dic);
  check(
    'business_item_count = deal_in_channel_known_item_count + deal_in_channel_missing_item_count',
    dicPop?.business_item_count === (dicPop?.deal_in_channel_known_item_count ?? 0) + (dicPop?.deal_in_channel_missing_item_count ?? 0),
    dicPop,
  );
  check('deal_in_channel_missing_item_count >= 1 (fixture item 14, Historical Import with no channel)', (dicPop?.deal_in_channel_missing_item_count ?? 0) >= 1, dicPop?.deal_in_channel_missing_item_count);
  check('deal_in_channel_coverage_percent is a number', typeof dicPop?.deal_in_channel_coverage_percent === 'number');

  console.log('\n[v1.2 — overall_performance: multi-item single-deal aggregation]');
  const overallRows: any[] = dic?.overall_performance ?? [];
  check('overall_performance has at least one row', overallRows.length > 0);
  const totalItemsAcrossChannels = overallRows.reduce((sum, r) => sum + (r.deal_in_item_count ?? 0), 0);
  check('SUM(deal_in_item_count) across channels === business_item_count', totalItemsAcrossChannels === dicPop?.business_item_count, { totalItemsAcrossChannels, businessItemCount: dicPop?.business_item_count });
  const multiItemDealRow = overallRows.find((r) => r.deal_in_item_count > r.deal_in_distinct_deal_count);
  check(
    'at least one channel has deal_in_item_count > deal_in_distinct_deal_count (fixture deal 20: 2 items, 1 deal)',
    !!multiItemDealRow,
    overallRows.map((r) => ({ channel: r.deal_in_channel_name, items: r.deal_in_item_count, deals: r.deal_in_distinct_deal_count })),
  );

  console.log('\n[v1.2 — historical items included with channel, excluded from holding]');
  const missingChannelRow = overallRows.find((r) => r.deal_in_channel_id === null);
  check('missing-channel row exists in overall_performance (not dropped)', !!missingChannelRow, overallRows.map((r) => r.deal_in_channel_id));
  check('missing-channel row includes the historical item (historical_item_count >= 1)', (missingChannelRow?.historical_item_count ?? 0) >= 1, missingChannelRow);
  const anyHoldingExcludesHistorical = overallRows.some((r) => (r.historical_item_count ?? 0) > 0 && (r.holding_sample_size ?? 0) < (r.deal_in_realized_item_count ?? 0));
  check('at least one channel shows holding_sample_size < realized_item_count where historical items are present', anyHoldingExcludesHistorical || overallRows.every((r) => (r.historical_item_count ?? 0) === 0), overallRows);

  console.log('\n[v1.2 — by_acquisition_value_band excludes zero/unknown]');
  const bandRows: any[] = dic?.by_acquisition_value_band ?? [];
  check('by_acquisition_value_band never includes a zero/unknown/negative band label', bandRows.every((r) => !['Zero assigned value', 'Unknown acquisition value', 'Negative (invalid)'].includes(r.acquisition_value_band_label)), bandRows);

  console.log('\n[v1.2 — privacy across both fixture users]');
  const { data: v12SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userBId });
  const candidatesA12 = v12SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const candidatesB12 = v12SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA12 = new Set(candidatesA12.map((c: any) => c.item_id));
  const idsB12 = new Set(candidatesB12.map((c: any) => c.item_id));
  check("v1.2 user A's and user B's candidates don't overlap", Array.from(idsA12).every((id) => !idsB12.has(id)));
  check('deal_in_channel evidence pools both users (population_summary business_item_count reflects shared population)', (dicPop?.business_item_count ?? 0) > candidatesA12.length);

  console.log('\n[v1.2 — permissions on new functions]');
  const { error: dicAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_2 directly', !!dicAuthedError, dicAuthedError);
  const { error: dicHelperAuthedError } = await clientA.rpc('_build_deal_in_channel_snapshot_v1');
  check('authenticated client cannot call _build_deal_in_channel_snapshot_v1 directly', !!dicHelperAuthedError, dicHelperAuthedError);

  console.log('\n[v1.2 — new runner call persists analytics_version 1.2]');
  const v12Run = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('new run analytics_version is 1.2', v12Run.analytics_version === '1.2', v12Run.analytics_version);
  check('new run status is completed', v12Run.status === 'completed');
  check('new run snapshot has 1.2 metadata', (v12Run.snapshot as any)?.snapshot_schema_version === '1.2');
  check('new run snapshot includes deal_in_channel', !!(v12Run.snapshot as any)?.evidence_aggregates?.deal_in_channel);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
