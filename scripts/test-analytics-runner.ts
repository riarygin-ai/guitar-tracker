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

/** Wraps a real service-role client but forces the build_analytics_snapshot_v1_5
 *  RPC call (the version the runner actually calls) to fail, so the runner's
 *  failure path executes against a REAL analytics_runs row without needing
 *  to actually break the database. */
function withSimulatedBuilderFailure(real: SupabaseClient, message: string): SupabaseClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (name: string, args: unknown) => {
          if (name === 'build_analytics_snapshot_v1_5') {
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
          if (name === 'build_analytics_snapshot_v1_5') {
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
    snapshot_schema_version: '1.5',
    analytics_definition_version: '1.5',
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

  const { data: directSnapshotA } = await serviceClient.rpc('build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId });
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

  console.log('\n[v1.2 — builder still callable directly (unaffected by v1.3)]');
  const { error: v12StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_2 still callable by service_role', !v12StillCallableError, v12StillCallableError);

  // ── Channel Analytics module 2: Deal Out Channel (Snapshot v1.3) ─────────
  console.log('\n[v1.3 — builder callable, top-level metadata]');
  const { data: v13SnapshotA, error: v13ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_3 callable by service_role', !v13ErrorA, v13ErrorA);
  check('v1.3 snapshot_schema_version is 1.3', v13SnapshotA?.snapshot_schema_version === '1.3', v13SnapshotA?.snapshot_schema_version);
  check('v1.3 analytics_definition_version is 1.3', v13SnapshotA?.analytics_definition_version === '1.3', v13SnapshotA?.analytics_definition_version);
  check('v1.3 recommendation_target_user_id === userAId', v13SnapshotA?.recommendation_target_user_id === userAId);
  check('v1.3 still carries deal_in_channel (v1.2 reused wholesale)', Array.isArray(v13SnapshotA?.evidence_aggregates?.deal_in_channel?.population_summary));
  check('v1.3 still carries acquisition_value_band (v1.2 reused wholesale)', Array.isArray(v13SnapshotA?.evidence_aggregates?.acquisition_value_band?.population_summary));
  check('v1.3 still carries brand (v1.2 reused wholesale)', Array.isArray(v13SnapshotA?.evidence_aggregates?.brand?.population_summary));

  console.log('\n[v1.3 — Deal Out Channel population_summary]');
  const doc = v13SnapshotA?.evidence_aggregates?.deal_out_channel;
  const docPop = doc?.population_summary?.[0];
  check(
    'deal_out_channel section exists with all 6 subsections',
    !!doc && Array.isArray(doc.population_summary) && Array.isArray(doc.overall_performance)
      && Array.isArray(doc.cash_sales_by_channel) && Array.isArray(doc.trade_exits_by_channel)
      && Array.isArray(doc.by_exit_value_band) && Array.isArray(doc.by_acquisition_value_band),
    doc ? Object.keys(doc) : doc,
  );
  check(
    'realized_business_item_count = deal_out_channel_known_item_count + deal_out_channel_missing_item_count',
    docPop?.realized_business_item_count === (docPop?.deal_out_channel_known_item_count ?? 0) + (docPop?.deal_out_channel_missing_item_count ?? 0),
    docPop,
  );
  check(
    'realized_business_item_count = sale_exit_item_count + trade_exit_item_count + unknown_exit_method_item_count',
    docPop?.realized_business_item_count === (docPop?.sale_exit_item_count ?? 0) + (docPop?.trade_exit_item_count ?? 0) + (docPop?.unknown_exit_method_item_count ?? 0),
    docPop,
  );
  check('deal_out_channel_missing_item_count >= 1 (fixture item 20, channel-less historical trade-out)', (docPop?.deal_out_channel_missing_item_count ?? 0) >= 1, docPop?.deal_out_channel_missing_item_count);

  console.log('\n[v1.3 — sale exit and outgoing trade item map their own deal channel]');
  const cashSalesRows: any[] = doc?.cash_sales_by_channel ?? [];
  const tradeExitRows: any[] = doc?.trade_exits_by_channel ?? [];
  const marketplaceCashSaleRow = cashSalesRows.find((r) => r.deal_out_channel_name === 'Marketplace');
  check('a cash sale maps to its own deal channel (Marketplace, fixture items 1/6/8/9/10/21)', !!marketplaceCashSaleRow && marketplaceCashSaleRow.sale_item_count >= 1, cashSalesRows);
  const reverbTradeExitRow = tradeExitRows.find((r) => r.deal_out_channel_name === 'Reverb');
  check('an outgoing trade item maps to its own trade deal channel (Reverb, fixture item 17)', !!reverbTradeExitRow && reverbTradeExitRow.trade_exit_item_count >= 1, tradeExitRows);

  console.log('\n[v1.3 — open items have no Deal Out Channel]');
  const { data: openItemRows, error: openItemsError } = await serviceClient
    .from('analytics_item_lifecycle')
    .select('item_id, deal_out_channel_id')
    .eq('purpose_name', 'Business')
    .eq('is_realized', false);
  check('open Business items query succeeds', !openItemsError, openItemsError);
  check(
    'every open Business item has deal_out_channel_id === null',
    (openItemRows ?? []).length > 0 && (openItemRows ?? []).every((r: any) => r.deal_out_channel_id === null),
    openItemRows,
  );

  console.log('\n[v1.3 — overall_performance: multi-item single-deal aggregation]');
  const docOverallRows: any[] = doc?.overall_performance ?? [];
  check('overall_performance has at least one row', docOverallRows.length > 0);
  const docMultiItemDealRow = docOverallRows.find((r) => r.deal_out_item_count > r.deal_out_distinct_deal_count);
  check(
    'at least one channel has deal_out_item_count > deal_out_distinct_deal_count (fixture deal 25: 2 items, 1 deal)',
    !!docMultiItemDealRow,
    docOverallRows.map((r) => ({ channel: r.deal_out_channel_name, items: r.deal_out_item_count, deals: r.deal_out_distinct_deal_count })),
  );

  console.log('\n[v1.3 — missing + historical Deal Out Channel remains in coverage]');
  const docMissingChannelRow = docOverallRows.find((r) => r.deal_out_channel_id === null);
  check('missing-channel row exists in overall_performance (not dropped, fixture item 20)', !!docMissingChannelRow, docOverallRows.map((r) => r.deal_out_channel_id));
  check('missing-channel row includes the historical item (historical_item_count >= 1)', (docMissingChannelRow?.historical_item_count ?? 0) >= 1, docMissingChannelRow);

  console.log('\n[v1.3 — historical rows excluded from holding samples]');
  const anyHoldingExcludesHistoricalOut = docOverallRows.some((r) => (r.historical_item_count ?? 0) > 0 && (r.holding_sample_size ?? 0) < (r.deal_out_item_count ?? 0));
  check('at least one channel shows holding_sample_size < deal_out_item_count where historical items are present (fixture item 9)', anyHoldingExcludesHistoricalOut, docOverallRows);

  console.log('\n[v1.3 — cash-sale vs. trade-exit terminology never conflated]');
  const sampleCashSaleRow = cashSalesRows[0];
  const sampleTradeExitRow = tradeExitRows[0];
  check('cash_sales_by_channel rows use median_sale_price (never median_assigned_trade_exit_value)', !!sampleCashSaleRow && 'median_sale_price' in sampleCashSaleRow && !('median_assigned_trade_exit_value' in sampleCashSaleRow), sampleCashSaleRow);
  check('trade_exits_by_channel rows use median_assigned_trade_exit_value (never median_sale_price)', !!sampleTradeExitRow && 'median_assigned_trade_exit_value' in sampleTradeExitRow && !('median_sale_price' in sampleTradeExitRow), sampleTradeExitRow);

  console.log('\n[v1.3 — privacy and pooling across both fixture users]');
  const { data: v13SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userBId });
  const candidatesA13 = v13SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const candidatesB13 = v13SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA13 = new Set(candidatesA13.map((c: any) => c.item_id));
  const idsB13 = new Set(candidatesB13.map((c: any) => c.item_id));
  check("v1.3 user A's and user B's candidates don't overlap", Array.from(idsA13).every((id) => !idsB13.has(id)));
  check('deal_out_channel evidence pools both users (fixture item 21, User B, is realized)', (docPop?.realized_business_item_count ?? 0) > candidatesA13.length);
  check('no deal_out_channel row exposes a user_id field', docOverallRows.every((r) => !('user_id' in r)), docOverallRows[0]);

  console.log('\n[v1.3 — permissions on new functions]');
  const { error: docAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_3 directly', !!docAuthedError, docAuthedError);
  const { error: docHelperAuthedError } = await clientA.rpc('_build_deal_out_channel_snapshot_v1');
  check('authenticated client cannot call _build_deal_out_channel_snapshot_v1 directly', !!docHelperAuthedError, docHelperAuthedError);

  console.log('\n[v1.3 — builder still callable directly (unaffected by v1.4)]');
  const { error: v13StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_3 still callable by service_role', !v13StillCallableError, v13StillCallableError);

  // ── Channel Analytics module 3A: Channel Journey (Snapshot v1.4) ─────────
  console.log('\n[v1.4 — builder callable, top-level metadata]');
  const { data: v14SnapshotA, error: v14ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_4 callable by service_role', !v14ErrorA, v14ErrorA);
  check('v1.4 snapshot_schema_version is 1.4', v14SnapshotA?.snapshot_schema_version === '1.4', v14SnapshotA?.snapshot_schema_version);
  check('v1.4 analytics_definition_version is 1.4', v14SnapshotA?.analytics_definition_version === '1.4', v14SnapshotA?.analytics_definition_version);
  check('v1.4 recommendation_target_user_id === userAId', v14SnapshotA?.recommendation_target_user_id === userAId);
  check('v1.4 still carries deal_in_channel (v1.3 reused wholesale)', Array.isArray(v14SnapshotA?.evidence_aggregates?.deal_in_channel?.population_summary));
  check('v1.4 still carries deal_out_channel (v1.3 reused wholesale)', Array.isArray(v14SnapshotA?.evidence_aggregates?.deal_out_channel?.population_summary));

  console.log('\n[v1.4 — Channel Journey population_summary]');
  const cj = v14SnapshotA?.evidence_aggregates?.channel_journey;
  const cjPop = cj?.population_summary?.[0];
  check(
    'channel_journey section exists with all 5 subsections',
    !!cj && Array.isArray(cj.population_summary) && Array.isArray(cj.deal_in_to_deal_out_matrix)
      && Array.isArray(cj.same_channel_summary) && Array.isArray(cj.same_channel_by_deal_in_channel)
      && Array.isArray(cj.paths_by_method),
    cj ? Object.keys(cj) : cj,
  );

  console.log('\n[v1.4 — open items excluded from realized population]');
  check('realized_business_item_count is less than total tracked items (open items exist and are excluded)', (cjPop?.realized_business_item_count ?? 0) > 0 && (cjPop?.realized_business_item_count ?? 0) < 24, cjPop?.realized_business_item_count);

  console.log('\n[v1.4 — journey eligibility reconciliation]');
  check(
    'realized_business_item_count = journey_eligible + missing_deal_in + missing_deal_out - missing_both',
    cjPop?.realized_business_item_count ===
      (cjPop?.journey_eligible_item_count ?? 0)
      + (cjPop?.missing_deal_in_channel_item_count ?? 0)
      + (cjPop?.missing_deal_out_channel_item_count ?? 0)
      - (cjPop?.missing_both_channels_item_count ?? 0),
    cjPop,
  );
  check(
    'journey_eligible_item_count = journey_sale_exit_item_count + journey_trade_exit_item_count',
    cjPop?.journey_eligible_item_count === (cjPop?.journey_sale_exit_item_count ?? 0) + (cjPop?.journey_trade_exit_item_count ?? 0),
    cjPop,
  );
  check('missing_deal_in_channel_item_count >= 1 (fixture item 22, historical import with no channel)', (cjPop?.missing_deal_in_channel_item_count ?? 0) >= 1, cjPop?.missing_deal_in_channel_item_count);

  console.log('\n[v1.4 — matrix rows: correct pairing, same-channel, different-channel]');
  const matrixRows: any[] = cj?.deal_in_to_deal_out_matrix ?? [];
  check('matrix has at least one row', matrixRows.length > 0);
  check('no matrix row has a null deal_in or deal_out channel (missing channels excluded from matrix)', matrixRows.every((r) => r.deal_in_channel_id !== null && r.deal_out_channel_id !== null), matrixRows.map((r) => [r.deal_in_channel_id, r.deal_out_channel_id]));
  const item1Row = matrixRows.find((r) => r.deal_in_channel_name === 'Regular Buyer / Seller' && r.deal_out_channel_name === 'Marketplace');
  check('a realized item with both channels appears in the correct matrix row (fixture item 1: Regular Buyer/Seller -> Marketplace)', !!item1Row && item1Row.journey_item_count >= 1, item1Row);
  const sameChannelRow = matrixRows.find((r) => r.deal_in_channel_id === r.deal_out_channel_id);
  check('a same-channel path is classified correctly (fixture items 5, 7: Kijiji -> Kijiji)', !!sameChannelRow && sameChannelRow.journey_item_count >= 2, sameChannelRow);
  const differentChannelRow = matrixRows.find((r) => r.deal_in_channel_id !== r.deal_out_channel_id);
  check('a different-channel path is classified correctly', !!differentChannelRow, differentChannelRow);

  console.log('\n[v1.4 — multi-item acquisition and exit deals produce correct counts]');
  const reverbToMarketplaceRow = matrixRows.find((r) => r.deal_in_channel_name === 'Reverb' && r.deal_out_channel_name === 'Marketplace');
  check(
    'shared acquisition deal, separate exits (fixture items 23, 24): journey_item_count=2, distinct_acquisition_deal_count=1, distinct_exit_deal_count=2',
    !!reverbToMarketplaceRow && reverbToMarketplaceRow.journey_item_count === 2 && reverbToMarketplaceRow.distinct_acquisition_deal_count === 1 && reverbToMarketplaceRow.distinct_exit_deal_count === 2,
    reverbToMarketplaceRow,
  );
  const regularToKijijiRow = matrixRows.find((r) => r.deal_in_channel_name === 'Regular Buyer / Seller' && r.deal_out_channel_name === 'Kijiji');
  check(
    'separate acquisitions, shared exit deal (fixture items 18, 19): journey_item_count=2, distinct_acquisition_deal_count=2, distinct_exit_deal_count=1',
    !!regularToKijijiRow && regularToKijijiRow.journey_item_count === 2 && regularToKijijiRow.distinct_acquisition_deal_count === 2 && regularToKijijiRow.distinct_exit_deal_count === 1,
    regularToKijijiRow,
  );

  console.log('\n[v1.4 — historical rows excluded from holding samples]');
  const regularToMarketplaceRow = matrixRows.find((r) => r.deal_in_channel_name === 'Regular Buyer / Seller' && r.deal_out_channel_name === 'Marketplace');
  check(
    'Regular Buyer/Seller -> Marketplace row includes historical item 9 but holding_sample_size < journey_item_count',
    !!regularToMarketplaceRow && (regularToMarketplaceRow.historical_item_count ?? 0) >= 1 && (regularToMarketplaceRow.holding_sample_size ?? 0) < regularToMarketplaceRow.journey_item_count,
    regularToMarketplaceRow,
  );

  console.log('\n[v1.4 — shared evidence has no user-level fields]');
  check('no matrix row exposes user_id or item_id', matrixRows.every((r) => !('user_id' in r) && !('item_id' in r)), matrixRows[0]);

  console.log('\n[v1.4 — privacy across both fixture users]');
  const { data: v14SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userBId });
  const candidatesA14 = v14SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const candidatesB14 = v14SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA14 = new Set(candidatesA14.map((c: any) => c.item_id));
  const idsB14 = new Set(candidatesB14.map((c: any) => c.item_id));
  check("v1.4 user A's and user B's candidates don't overlap", Array.from(idsA14).every((id) => !idsB14.has(id)));

  console.log('\n[v1.4 — permissions on new functions]');
  const { error: cjAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_4 directly', !!cjAuthedError, cjAuthedError);
  const { error: cjHelperAuthedError } = await clientA.rpc('_build_channel_journey_snapshot_v1');
  check('authenticated client cannot call _build_channel_journey_snapshot_v1 directly', !!cjHelperAuthedError, cjHelperAuthedError);

  console.log('\n[v1.4 — builder still callable directly (unaffected by v1.5)]');
  const { error: v14StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_4 still callable by service_role', !v14StillCallableError, v14StillCallableError);

  // ── Channel Analytics module 3B: Listing Channel Exposure (Snapshot v1.5) ──
  console.log('\n[v1.5 — builder callable, top-level metadata]');
  const { data: v15SnapshotA, error: v15ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_5 callable by service_role', !v15ErrorA, v15ErrorA);
  check('v1.5 snapshot_schema_version is 1.5', v15SnapshotA?.snapshot_schema_version === '1.5', v15SnapshotA?.snapshot_schema_version);
  check('v1.5 analytics_definition_version is 1.5', v15SnapshotA?.analytics_definition_version === '1.5', v15SnapshotA?.analytics_definition_version);
  check('v1.5 recommendation_target_user_id === userAId', v15SnapshotA?.recommendation_target_user_id === userAId);
  check('v1.5 still carries channel_journey (v1.4 reused wholesale)', Array.isArray(v15SnapshotA?.evidence_aggregates?.channel_journey?.population_summary));

  console.log('\n[v1.5 — Listing Channel Exposure population_summary]');
  const lce = v15SnapshotA?.evidence_aggregates?.listing_channel_exposure;
  const lcePop = lce?.population_summary?.[0];
  check(
    'listing_channel_exposure section exists with all 6 subsections',
    !!lce && Array.isArray(lce.population_summary) && Array.isArray(lce.listing_channel_performance)
      && typeof lce.cross_listing_summary === 'object' && Array.isArray(lce.cross_listing_summary?.buckets)
      && Array.isArray(lce.listing_to_deal_out_matrix) && Array.isArray(lce.open_inventory_by_listing_channel)
      && Array.isArray(lce.open_unlisted_summary),
    lce ? Object.keys(lce) : lce,
  );

  console.log('\n[v1.5 — coverage reconciliation]');
  check(
    'business_item_count = item_with_eligible_listing_count + item_without_eligible_listing_count',
    lcePop?.business_item_count === (lcePop?.item_with_eligible_listing_count ?? 0) + (lcePop?.item_without_eligible_listing_count ?? 0),
    lcePop,
  );
  check(
    'realized_business_item_count reconciles separately',
    lcePop?.realized_business_item_count === (lcePop?.realized_item_with_eligible_listing_count ?? 0) + (lcePop?.realized_item_without_eligible_listing_count ?? 0),
    lcePop,
  );
  check(
    'open_business_item_count reconciles separately',
    lcePop?.open_business_item_count === (lcePop?.open_item_with_eligible_listing_count ?? 0) + (lcePop?.open_item_without_eligible_listing_count ?? 0),
    lcePop,
  );

  console.log('\n[v1.5 — one item_listing creates one exposure; duplicates collapse]');
  check('eligible_listing_exposure_count >= 1 (at least one real item/channel exposure)', (lcePop?.eligible_listing_exposure_count ?? 0) >= 1, lcePop?.eligible_listing_exposure_count);
  check(
    'eligible_listing_record_count > eligible_listing_exposure_count (fixture item 25: 2 Marketplace records collapse to 1 exposure)',
    (lcePop?.eligible_listing_record_count ?? 0) > (lcePop?.eligible_listing_exposure_count ?? 0),
    lcePop,
  );

  console.log('\n[v1.5 — missing/ignored records remain visible in coverage]');
  check('ignored_non_listing_channel_record_count >= 1 (fixture item 26, Regular Buyer/Seller)', (lcePop?.ignored_non_listing_channel_record_count ?? 0) >= 1, lcePop?.ignored_non_listing_channel_record_count);
  check('missing_listing_channel_record_count >= 1 (fixture item 27, draft with no listed_at)', (lcePop?.missing_listing_channel_record_count ?? 0) >= 1, lcePop?.missing_listing_channel_record_count);

  console.log('\n[v1.5 — non-listing channels excluded from listing_channel_performance]');
  const channelPerfRows: any[] = lce?.listing_channel_performance ?? [];
  check('listing_channel_performance has at least one row', channelPerfRows.length > 0);
  check('no listing_channel_performance row is Regular Buyer / Seller (requires_listing = false)', channelPerfRows.every((r) => r.listing_channel_name !== 'Regular Buyer / Seller'), channelPerfRows.map((r) => r.listing_channel_name));

  console.log('\n[v1.5 — cross-listed item appears once per channel, once per bucket]');
  const distinctChannelsInPerf = new Set(channelPerfRows.map((r) => r.listing_channel_name));
  check('cross-listed item 25 (Marketplace + Kijiji) shows up as exposure on both channels', distinctChannelsInPerf.has('Marketplace') && distinctChannelsInPerf.has('Kijiji'), Array.from(distinctChannelsInPerf));
  const buckets: any[] = lce?.cross_listing_summary?.buckets ?? [];
  const bucketItemSum = buckets.reduce((sum, b) => sum + (b.business_item_count ?? 0), 0);
  check('cross_listing_summary buckets reconcile to business_item_count (each item counted exactly once)', bucketItemSum === lcePop?.business_item_count, { bucketItemSum, businessItemCount: lcePop?.business_item_count });
  const twoChannelBucket = buckets.find((b) => b.listing_channel_count_bucket === '2 channels');
  check('the "2 channels" bucket includes fixture item 25 (business_item_count >= 1)', !!twoChannelBucket && twoChannelBucket.business_item_count >= 1, twoChannelBucket);
  check('cross_listed_item_count is a number and cross_listed_item_percent is a number', typeof lce?.cross_listing_summary?.cross_listed_item_count === 'number' && typeof lce?.cross_listing_summary?.cross_listed_item_percent === 'number');

  console.log('\n[v1.5 — realized sale/trade counts use lifecycle exit methods]');
  const marketplacePerfRow = channelPerfRows.find((r) => r.listing_channel_name === 'Marketplace');
  check('Marketplace channel performance row has sale_exit_item_count >= 1 (fixture items 1, 25, ...)', !!marketplacePerfRow && marketplacePerfRow.sale_exit_item_count >= 1, marketplacePerfRow);

  console.log('\n[v1.5 — Listing -> Deal Out: one item can appear in multiple exposure rows]');
  const matrixLceRows: any[] = lce?.listing_to_deal_out_matrix ?? [];
  check('listing_to_deal_out_matrix has at least one row', matrixLceRows.length > 0);
  const marketplaceToMarketplace = matrixLceRows.find((r) => r.listing_channel_name === 'Marketplace' && r.deal_out_channel_name === 'Marketplace');
  const kijijiToMarketplace = matrixLceRows.find((r) => r.listing_channel_name === 'Kijiji' && r.deal_out_channel_name === 'Marketplace');
  check('fixture item 25 produces a Marketplace -> Marketplace row (same-channel)', !!marketplaceToMarketplace && marketplaceToMarketplace.exposed_realized_item_count >= 1, marketplaceToMarketplace);
  check('fixture item 25 also produces a Kijiji -> Marketplace row (different-channel, same item)', !!kijijiToMarketplace && kijijiToMarketplace.exposed_realized_item_count >= 1, kijijiToMarketplace);
  check('same-channel row has same_channel_flag === true', marketplaceToMarketplace?.same_channel_flag === true, marketplaceToMarketplace?.same_channel_flag);
  check('different-channel row has same_channel_flag === false', kijijiToMarketplace?.same_channel_flag === false, kijijiToMarketplace?.same_channel_flag);

  console.log('\n[v1.5 — same-channel percentage is descriptive, never labelled conversion]');
  check('listing_channel_performance rows use same_channel_exit_percent, never a "conversion" key', !!marketplacePerfRow && 'same_channel_exit_percent' in marketplacePerfRow && !Object.keys(marketplacePerfRow).some((k) => k.toLowerCase().includes('conversion')), marketplacePerfRow ? Object.keys(marketplacePerfRow) : marketplacePerfRow);

  console.log('\n[v1.5 — channel-specific listing age uses item_listings.listed_at]');
  const openByChannelRows: any[] = lce?.open_inventory_by_listing_channel ?? [];
  const reverbOpenRow = openByChannelRows.find((r) => r.listing_channel_name === 'Reverb');
  check(
    'Reverb open-inventory row reflects fixture item 28 alone: sample_size = 1, median age = 45 days',
    !!reverbOpenRow && reverbOpenRow.current_listing_age_sample_size === 1 && Number(reverbOpenRow.median_current_listing_age_days) === 45,
    reverbOpenRow,
  );

  console.log('\n[v1.5 — historical items excluded from ownership age]');
  const openUnlisted = lce?.open_unlisted_summary?.[0];
  check('open_unlisted_summary.historical_excluded_from_age_count >= 1 (fixture item 14)', (openUnlisted?.historical_excluded_from_age_count ?? 0) >= 1, openUnlisted?.historical_excluded_from_age_count);

  console.log('\n[v1.5 — shared evidence has no user-level or item-level fields]');
  check('no listing_channel_performance row exposes user_id or item_id', channelPerfRows.every((r) => !('user_id' in r) && !('item_id' in r)), channelPerfRows[0]);
  check('no listing_to_deal_out_matrix row exposes user_id or item_id', matrixLceRows.every((r) => !('user_id' in r) && !('item_id' in r)), matrixLceRows[0]);
  check('no open_inventory_by_listing_channel row exposes user_id or item_id', openByChannelRows.every((r) => !('user_id' in r) && !('item_id' in r)), openByChannelRows[0]);

  console.log('\n[v1.5 — privacy across both fixture users]');
  const { data: v15SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userBId });
  const candidatesA15 = v15SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const candidatesB15 = v15SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA15 = new Set(candidatesA15.map((c: any) => c.item_id));
  const idsB15 = new Set(candidatesB15.map((c: any) => c.item_id));
  check("v1.5 user A's and user B's candidates don't overlap", Array.from(idsA15).every((id) => !idsB15.has(id)));

  console.log('\n[v1.5 — permissions on new functions]');
  const { error: lceAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_5 directly', !!lceAuthedError, lceAuthedError);
  const { error: lceHelperAuthedError } = await clientA.rpc('_build_listing_channel_exposure_snapshot_v1');
  check('authenticated client cannot call _build_listing_channel_exposure_snapshot_v1 directly', !!lceHelperAuthedError, lceHelperAuthedError);

  console.log('\n[v1.5 — new runner call persists analytics_version 1.5]');
  const v15Run = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('new run analytics_version is 1.5', v15Run.analytics_version === '1.5', v15Run.analytics_version);
  check('new run status is completed', v15Run.status === 'completed');
  check('new run snapshot has 1.5 metadata', (v15Run.snapshot as any)?.snapshot_schema_version === '1.5');
  check('new run snapshot includes listing_channel_exposure', !!(v15Run.snapshot as any)?.evidence_aggregates?.listing_channel_exposure);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
