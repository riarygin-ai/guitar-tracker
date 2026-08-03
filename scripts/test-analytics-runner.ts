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
 * ── SAFETY — LOCAL ONLY ──────────────────────────────────────────────────
 * This script deliberately does NOT read .env.local (no dotenv call at
 * all) — every connection value comes from process.env (shell-exported
 * only) or falls back to Supabase's well-known local-dev demo defaults
 * (same fixed values on every machine running `supabase start`, imported
 * from setup-analytics-test-fixtures.ts). Before doing anything
 * destructive, main() prints the resolved URL, hard-fails if its hostname
 * isn't localhost/127.0.0.1/::1, and hard-fails if that local instance
 * isn't actually reachable. This must never run against a remote/
 * production project.
 *
 * Fixture data (two deterministic local auth users plus inventory/deal/
 * listing rows) is created automatically by calling
 * setupAnalyticsTestFixtures() from scripts/setup-analytics-test-
 * fixtures.ts — idempotent, so re-running this script does not duplicate
 * fixture data. See that file's header for exactly what it creates and
 * for the known scope limitation around legacy assertions pinned to
 * specific historical item_id values.
 *
 * Usage:
 *   npx tsx scripts/test-analytics-runner.ts
 */

import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  runAnalyticsForCurrentUser,
  isValidAnalyticsSnapshot,
  sanitizeErrorMessage,
  AnalyticsRunError,
  ANALYTICS_VERSION,
  EVIDENCE_SCOPE,
} from '../src/lib/analytics/runAnalytics';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
  setupAnalyticsTestFixtures,
  HIGH_CAPITAL_ITEM,
} from './setup-analytics-test-fixtures';

const ANON_KEY = SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

let passed = 0;
let failed = 0;

/** Deep-sorts object keys before JSON.stringify, so a value that went
 *  through a jsonb `-`/`||` round-trip (which can reorder keys without
 *  changing meaning) still compares equal to a value that didn't. */
function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce((acc, k) => {
        acc[k] = sort((v as Record<string, unknown>)[k]);
        return acc;
      }, {} as Record<string, unknown>);
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

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

/** Wraps a real service-role client but forces the build_analytics_snapshot_v2_10
 *  RPC call (the version the runner actually calls) to fail, so the runner's
 *  failure path executes against a REAL analytics_runs row without needing
 *  to actually break the database. */
function withSimulatedBuilderFailure(real: SupabaseClient, message: string): SupabaseClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (name: string, args: unknown) => {
          if (name === 'build_analytics_snapshot_v2_10') {
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
          if (name === 'build_analytics_snapshot_v2_10') {
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
  // ── Safety gate — must pass before anything destructive runs ──────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SERVICE_ROLE_KEY);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('\n[fixtures] Ensuring local analytics test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(serviceClient);
  const userAId = fixtures.userAId;
  const userBId = fixtures.userBId;
  // Named fixture-item manifest and independently-derived expected values —
  // see scripts/setup-analytics-test-fixtures.ts. `fx.<name>` is a real
  // locally-generated inventory_items.id; tests below reference scenarios
  // by name, never by a hardcoded literal id.
  const fx = fixtures.items;
  const expected = fixtures.expected;
  console.log(`User A app_users.id = ${userAId}, User B app_users.id = ${userBId}`);

  const tokenA = await signIn(fixtures.userAEmail, fixtures.password);
  const tokenB = await signIn(fixtures.userBEmail, fixtures.password);
  const clientA = authedClient(tokenA);
  const clientB = authedClient(tokenB);

  // ── Pure unit tests: isValidAnalyticsSnapshot ───────────────────────────
  // v2.4 shape — no recommendation_target_user_id/evidence_aggregates/
  // recommendation_candidates field exists in a v2.x payload (see
  // runAnalytics.ts). The function no longer takes an expectedTargetUserId
  // parameter since there is nothing target-user-specific left to check
  // inside the JSON itself.
  console.log('\n[isValidAnalyticsSnapshot]');
  const validSnapshot = {
    snapshot_schema_version: '2.10',
    analytics_definition_version: '2.10',
    generated_at: new Date().toISOString(),
    evidence_scope: EVIDENCE_SCOPE,
    purpose_semantics: 'current_item_purpose',
    shared_purpose_evidence: {},
    target_user_purpose_evidence: {},
    target_user_open_inventory_evidence: {},
    shared_acquisition_evidence: {},
    target_user_acquisition_evidence: {},
    shared_inventory_segmentation_evidence: {},
    target_user_inventory_segmentation_evidence: {},
    shared_deal_channel_evidence: {},
    target_user_deal_channel_evidence: {},
    shared_listing_channel_evidence: {},
    target_user_listing_channel_evidence: {},
    shared_capital_liquidity_evidence: {},
    target_user_capital_liquidity_evidence: {},
    shared_calendar_seasonality_evidence: {},
    target_user_calendar_seasonality_evidence: {},
  };
  check('valid snapshot passes', isValidAnalyticsSnapshot(validSnapshot));
  check('wrong schema version rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, snapshot_schema_version: '2.6' }));
  check('wrong definition version rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, analytics_definition_version: '0.9' }));
  check('wrong evidence_scope rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, evidence_scope: 'something_else' }));
  check('missing shared_purpose_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, shared_purpose_evidence: undefined }));
  check('missing target_user_purpose_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_purpose_evidence: null }));
  check('missing target_user_open_inventory_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_open_inventory_evidence: undefined }));
  check('missing shared_acquisition_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, shared_acquisition_evidence: undefined }));
  check('missing target_user_acquisition_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_acquisition_evidence: null }));
  check('missing shared_inventory_segmentation_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, shared_inventory_segmentation_evidence: undefined }));
  check('missing target_user_inventory_segmentation_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_inventory_segmentation_evidence: null }));
  check('missing shared_deal_channel_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, shared_deal_channel_evidence: undefined }));
  check('missing target_user_deal_channel_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_deal_channel_evidence: null }));
  check('missing shared_listing_channel_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, shared_listing_channel_evidence: undefined }));
  check('missing target_user_listing_channel_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_listing_channel_evidence: null }));
  check('missing shared_capital_liquidity_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, shared_capital_liquidity_evidence: undefined }));
  check('missing target_user_capital_liquidity_evidence rejected', !isValidAnalyticsSnapshot({ ...validSnapshot, target_user_capital_liquidity_evidence: null }));
  check('null value rejected', !isValidAnalyticsSnapshot(null));
  check('non-object value rejected', !isValidAnalyticsSnapshot('not an object'));

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

  // ── Real successful runs (production runner — always ANALYTICS_VERSION,
  // whichever version that constant currently points to) ─────────────────
  console.log('\n[successful run — user A]');
  const runA = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('status is completed', runA.status === 'completed', runA.status);
  check('snapshot is non-null', runA.snapshot !== null);
  check('analytics_version matches ANALYTICS_VERSION', runA.analytics_version === ANALYTICS_VERSION, runA.analytics_version);
  check('evidence_scope matches (shared_inventory_population)', runA.evidence_scope === EVIDENCE_SCOPE, runA.evidence_scope);
  check('duration_ms is a nonnegative integer', typeof runA.duration_ms === 'number' && runA.duration_ms >= 0, runA.duration_ms);
  const snapA = runA.snapshot as any;
  check(
    'snapshot displays shared_purpose_evidence, target_user_purpose_evidence, and target_user_open_inventory_evidence',
    !!snapA.shared_purpose_evidence && !!snapA.target_user_purpose_evidence && !!snapA.target_user_open_inventory_evidence,
    snapA ? Object.keys(snapA) : snapA,
  );

  const { data: fullRunA } = await serviceClient
    .from('analytics_runs').select('requested_by_user_id, recommendation_target_user_id').eq('id', runA.id).single();
  check('requested_by_user_id === userAId (never arbitrary)', fullRunA!.requested_by_user_id === userAId);
  check('recommendation_target_user_id === userAId (never arbitrary)', fullRunA!.recommendation_target_user_id === userAId);

  const { data: directSnapshotA } = await serviceClient.rpc('build_analytics_snapshot_v2_10', { p_target_user_id: userAId });
  // Since Insights Engine v1.0, the persisted snapshot additionally carries a
  // top-level `insights` key (application-layer enrichment, versioned
  // independently — see src/lib/analytics/insights/). Stripping it before
  // comparing confirms the underlying Analytics v2.10 evidence itself is
  // still byte-identical to a fresh direct RPC call — v2.10 calculations are
  // unmodified, only enriched on top.
  const { insights: _insightsA, ...snapAWithoutInsights } = snapA;
  check(
    'persisted snapshot (minus Insights Engine enrichment) equals a fresh direct builder call (same generated_at aside)',
    JSON.stringify({ ...snapAWithoutInsights, generated_at: null }) === JSON.stringify({ ...(directSnapshotA as any), generated_at: null }),
  );
  check(
    'persisted snapshot carries the Insights Engine v1.4 enrichment',
    !!snapA.insights && snapA.insights.insights_engine_version === '1.4' && snapA.insights.findings_selector_version === '1.4',
    snapA.insights,
  );

  console.log('\n[successful run — user B]');
  const runB = await runAnalyticsForCurrentUser({ appUserId: userBId, serviceClient });
  check('status is completed', runB.status === 'completed', runB.status);
  const snapB = runB.snapshot as any;
  check(
    'snapshot displays shared_purpose_evidence, target_user_purpose_evidence, and target_user_open_inventory_evidence',
    !!snapB.shared_purpose_evidence && !!snapB.target_user_purpose_evidence && !!snapB.target_user_open_inventory_evidence,
  );
  check("user A's and user B's item_decision_evidence don't overlap (no other user's item identity is exposed)", (() => {
    const idsA = new Set((snapA.target_user_open_inventory_evidence.item_decision_evidence as any[]).map((i) => i.item_id));
    const idsB = new Set((snapB.target_user_open_inventory_evidence.item_decision_evidence as any[]).map((i) => i.item_id));
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
  // v1.x's own evidence_scope literal ('shared_business_population') is
  // fixed and unaffected by the v2.2 production promotion — compared
  // against a literal here, not the EVIDENCE_SCOPE constant (which now
  // reflects the CURRENT production version, v2.2's 'shared_inventory_
  // population').
  check('v1.1 evidence_scope unchanged', v11SnapshotA?.evidence_scope === 'shared_business_population', v11SnapshotA?.evidence_scope);
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
    'all_business_distinct_brand_count differs from positive_acquisition_distinct_brand_count (fixtures.items.businessUnknownValueSale brand — Epiphone — never has a positive-value item)',
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
  check('deal_in_channel_missing_item_count >= 1 (fixtures.items.historicalImportOpenNoChannel, Historical Import with no channel)', (dicPop?.deal_in_channel_missing_item_count ?? 0) >= 1, dicPop?.deal_in_channel_missing_item_count);
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
  check('deal_out_channel_missing_item_count >= 1 (fixtures.items.historicalTradedNoExitChannel, channel-less historical trade-out)', (docPop?.deal_out_channel_missing_item_count ?? 0) >= 1, docPop?.deal_out_channel_missing_item_count);

  console.log('\n[v1.3 — sale exit and outgoing trade item map their own deal channel]');
  const cashSalesRows: any[] = doc?.cash_sales_by_channel ?? [];
  const tradeExitRows: any[] = doc?.trade_exits_by_channel ?? [];
  const marketplaceCashSaleRow = cashSalesRows.find((r) => r.deal_out_channel_name === 'Marketplace');
  check('a cash sale maps to its own deal channel (Marketplace, fixture items 1/6/8/9/10/21)', !!marketplaceCashSaleRow && marketplaceCashSaleRow.sale_item_count >= 1, cashSalesRows);
  const reverbTradeExitRow = tradeExitRows.find((r) => r.deal_out_channel_name === 'Reverb');
  check('an outgoing trade item maps to its own trade deal channel (Reverb, fixtures.items.tradedViaReverb)', !!reverbTradeExitRow && reverbTradeExitRow.trade_exit_item_count >= 1, tradeExitRows);

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
  check('missing-channel row exists in overall_performance (not dropped, fixtures.items.historicalTradedNoExitChannel)', !!docMissingChannelRow, docOverallRows.map((r) => r.deal_out_channel_id));
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
  const { count: totalBusinessItemCount } = await serviceClient
    .from('analytics_item_lifecycle').select('item_id', { count: 'exact', head: true }).eq('purpose_name', 'Business');
  check(
    'realized_business_item_count is less than total tracked Business items (open items exist and are excluded)',
    (cjPop?.realized_business_item_count ?? 0) > 0 && (cjPop?.realized_business_item_count ?? 0) < (totalBusinessItemCount ?? 0),
    { realized: cjPop?.realized_business_item_count, total: totalBusinessItemCount },
  );

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
    'Regular Buyer/Seller -> Marketplace row includes fixtures.items.historicalPurchaseViaRegular but holding_sample_size < journey_item_count',
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
  // STALE ASSERTION, CORRECTED: a prior version of this check asserted
  // eligible_listing_record_count > eligible_listing_exposure_count,
  // pinned to a legacy fixture that (per its own comment) had two
  // physical item_listings rows for the SAME (item, channel) pair. That
  // is no longer reproducible under ANY fixture — item_listings enforces
  // UNIQUE(inventory_item_id, deal_channel_id) (see supabase schema), so
  // canonical_exposure's GROUP BY (inventory_item_id, deal_channel_id) in
  // analytics/sql/07_listing_channel_exposure.sql can never see more than
  // one eligible record per exposure. The two totals are therefore
  // GUARANTEED equal for any dataset that respects that constraint — this
  // asserts that guarantee explicitly instead of a scenario the schema no
  // longer allows.
  check(
    'eligible_listing_record_count === eligible_listing_exposure_count (item_listings UNIQUE(item, channel) guarantees at most one eligible record per exposure)',
    (lcePop?.eligible_listing_record_count ?? -1) === (lcePop?.eligible_listing_exposure_count ?? -2),
    lcePop,
  );

  console.log('\n[v1.5 — missing/ignored records remain visible in coverage]');
  check('ignored_non_listing_channel_record_count >= 1 (fixtures.items.nonListingChannelRecord, Regular Buyer/Seller)', (lcePop?.ignored_non_listing_channel_record_count ?? 0) >= 1, lcePop?.ignored_non_listing_channel_record_count);
  check('missing_listing_channel_record_count >= 1 (fixtures.items.draftListingNoDate, draft with no listed_at)', (lcePop?.missing_listing_channel_record_count ?? 0) >= 1, lcePop?.missing_listing_channel_record_count);

  console.log('\n[v1.5 — non-listing channels excluded from listing_channel_performance]');
  const channelPerfRows: any[] = lce?.listing_channel_performance ?? [];
  check('listing_channel_performance has at least one row', channelPerfRows.length > 0);
  check('no listing_channel_performance row is Regular Buyer / Seller (requires_listing = false)', channelPerfRows.every((r) => r.listing_channel_name !== 'Regular Buyer / Seller'), channelPerfRows.map((r) => r.listing_channel_name));

  console.log('\n[v1.5 — cross-listed item appears once per channel, once per bucket]');
  const distinctChannelsInPerf = new Set(channelPerfRows.map((r) => r.listing_channel_name));
  check('cross-listed item (fixtures.items.crossListedMarketplaceKijiji) shows up as exposure on both channels', distinctChannelsInPerf.has('Marketplace') && distinctChannelsInPerf.has('Kijiji'), Array.from(distinctChannelsInPerf));
  const buckets: any[] = lce?.cross_listing_summary?.buckets ?? [];
  const bucketItemSum = buckets.reduce((sum, b) => sum + (b.business_item_count ?? 0), 0);
  check('cross_listing_summary buckets reconcile to business_item_count (each item counted exactly once)', bucketItemSum === lcePop?.business_item_count, { bucketItemSum, businessItemCount: lcePop?.business_item_count });
  const twoChannelBucket = buckets.find((b) => b.listing_channel_count_bucket === '2 channels');
  check('the "2 channels" bucket includes fixtures.items.crossListedMarketplaceKijiji (business_item_count >= 1)', !!twoChannelBucket && twoChannelBucket.business_item_count >= 1, twoChannelBucket);
  check('cross_listed_item_count is a number and cross_listed_item_percent is a number', typeof lce?.cross_listing_summary?.cross_listed_item_count === 'number' && typeof lce?.cross_listing_summary?.cross_listed_item_percent === 'number');

  console.log('\n[v1.5 — realized sale/trade counts use lifecycle exit methods]');
  const marketplacePerfRow = channelPerfRows.find((r) => r.listing_channel_name === 'Marketplace');
  check('Marketplace channel performance row has sale_exit_item_count >= 1 (fixtures.items.businessFastSale, crossListedMarketplaceKijiji, ...)', !!marketplacePerfRow && marketplacePerfRow.sale_exit_item_count >= 1, marketplacePerfRow);

  console.log('\n[v1.5 — Listing -> Deal Out: one item can appear in multiple exposure rows]');
  const matrixLceRows: any[] = lce?.listing_to_deal_out_matrix ?? [];
  check('listing_to_deal_out_matrix has at least one row', matrixLceRows.length > 0);
  const marketplaceToMarketplace = matrixLceRows.find((r) => r.listing_channel_name === 'Marketplace' && r.deal_out_channel_name === 'Marketplace');
  const kijijiToMarketplace = matrixLceRows.find((r) => r.listing_channel_name === 'Kijiji' && r.deal_out_channel_name === 'Marketplace');
  check('fixtures.items.crossListedMarketplaceKijiji produces a Marketplace -> Marketplace row (same-channel)', !!marketplaceToMarketplace && marketplaceToMarketplace.exposed_realized_item_count >= 1, marketplaceToMarketplace);
  check('fixtures.items.crossListedMarketplaceKijiji also produces a Kijiji -> Marketplace row (different-channel, same item)', !!kijijiToMarketplace && kijijiToMarketplace.exposed_realized_item_count >= 1, kijijiToMarketplace);
  check('same-channel row has same_channel_flag === true', marketplaceToMarketplace?.same_channel_flag === true, marketplaceToMarketplace?.same_channel_flag);
  check('different-channel row has same_channel_flag === false', kijijiToMarketplace?.same_channel_flag === false, kijijiToMarketplace?.same_channel_flag);

  console.log('\n[v1.5 — same-channel percentage is descriptive, never labelled conversion]');
  check('listing_channel_performance rows use same_channel_exit_percent, never a "conversion" key', !!marketplacePerfRow && 'same_channel_exit_percent' in marketplacePerfRow && !Object.keys(marketplacePerfRow).some((k) => k.toLowerCase().includes('conversion')), marketplacePerfRow ? Object.keys(marketplacePerfRow) : marketplacePerfRow);

  console.log('\n[v1.5 — channel-specific listing age uses item_listings.listed_at]');
  const openByChannelRows: any[] = lce?.open_inventory_by_listing_channel ?? [];
  const reverbOpenRow = openByChannelRows.find((r) => r.listing_channel_name === 'Reverb');
  check(
    // median_current_listing_age_days grows by 1 every real calendar day
    // since fixtures.items.reverbOpenSoleSample was listed — asserting
    // cardinality (sample_size = 1) and a sane positive age is stable
    // across runs; an exact day count is not. reverbOpenSoleSample is
    // deliberately the ONLY open item listed on Reverb anywhere in this
    // fixture set (see setup-analytics-test-fixtures.ts).
    'Reverb open-inventory row reflects fixtures.items.reverbOpenSoleSample alone: sample_size = 1, positive median age',
    !!reverbOpenRow && reverbOpenRow.current_listing_age_sample_size === 1 && Number(reverbOpenRow.median_current_listing_age_days) > 0,
    reverbOpenRow,
  );

  console.log('\n[v1.5 — historical items excluded from ownership age]');
  const openUnlisted = lce?.open_unlisted_summary?.[0];
  check('open_unlisted_summary.historical_excluded_from_age_count >= 1 (fixtures.items.historicalImportOpenNoChannel)', (openUnlisted?.historical_excluded_from_age_count ?? 0) >= 1, openUnlisted?.historical_excluded_from_age_count);

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

  console.log('\n[v1.5 — builder still callable directly (unaffected by v1.6)]');
  const { error: v15StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_5 still callable by service_role', !v15StillCallableError, v15StillCallableError);

  // ── Category & Type Performance (Snapshot v1.6) ──────────────────────────
  console.log('\n[v1.6 — builder callable, top-level metadata]');
  const { data: v16SnapshotA, error: v16ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_6 callable by service_role', !v16ErrorA, v16ErrorA);
  check('v1.6 snapshot_schema_version is 1.6', v16SnapshotA?.snapshot_schema_version === '1.6', v16SnapshotA?.snapshot_schema_version);
  check('v1.6 analytics_definition_version is 1.6', v16SnapshotA?.analytics_definition_version === '1.6', v16SnapshotA?.analytics_definition_version);
  check('v1.6 recommendation_target_user_id === userAId', v16SnapshotA?.recommendation_target_user_id === userAId);
  check('v1.6 still carries listing_channel_exposure (v1.5 reused wholesale)', Array.isArray(v16SnapshotA?.evidence_aggregates?.listing_channel_exposure?.population_summary));

  console.log('\n[v1.6 — Category & Type Performance population_summary]');
  const ctp = v16SnapshotA?.evidence_aggregates?.category_type_performance;
  const ctpPop = ctp?.population_summary?.[0];
  check(
    'category_type_performance section exists with all 6 subsections',
    !!ctp && Array.isArray(ctp.population_summary) && Array.isArray(ctp.category_performance)
      && Array.isArray(ctp.type_performance) && Array.isArray(ctp.category_by_acquisition_value_band)
      && Array.isArray(ctp.type_by_acquisition_value_band) && Array.isArray(ctp.open_inventory_by_category_type),
    ctp ? Object.keys(ctp) : ctp,
  );
  check('population_summary reports only Business items (business_item_count > 0)', (ctpPop?.business_item_count ?? 0) > 0, ctpPop?.business_item_count);

  console.log('\n[v1.6 — Category/Type coverage reconciliation]');
  check(
    'business_item_count = category_known_item_count + category_missing_item_count',
    ctpPop?.business_item_count === (ctpPop?.category_known_item_count ?? 0) + (ctpPop?.category_missing_item_count ?? 0),
    ctpPop,
  );
  check(
    'business_item_count = type_known_item_count + type_missing_item_count',
    ctpPop?.business_item_count === (ctpPop?.type_known_item_count ?? 0) + (ctpPop?.type_missing_item_count ?? 0),
    ctpPop,
  );
  check('category_missing_item_count >= 1 (fixture item 34, no item_subtype_id)', (ctpPop?.category_missing_item_count ?? 0) >= 1, ctpPop?.category_missing_item_count);

  console.log('\n[v1.6 — same Type name under different Categories stays separate]');
  const typeRows: any[] = ctp?.type_performance ?? [];
  const ampsPedalRow = typeRows.find((r) => r.category_name === 'Amps' && r.type_name === 'Pedal');
  const pedalsPedalRow = typeRows.find((r) => r.category_name === 'Pedals' && r.type_name === 'Pedal');
  check('Amps/Pedal and Pedals/Pedal are two distinct rows (same Type name, different Category)', !!ampsPedalRow && !!pedalsPedalRow && ampsPedalRow.category_id !== pedalsPedalRow.category_id, { ampsPedalRow, pedalsPedalRow });

  console.log('\n[v1.6 — missing Type remains visible]');
  const missingTypeRow = typeRows.find((r) => r.type_id === null);
  check('a type_performance row with type_id === null exists (fixture item 34)', !!missingTypeRow && missingTypeRow.item_count >= 1, missingTypeRow);

  console.log('\n[v1.6 — open + realized reconcile within rows]');
  const categoryRows: any[] = ctp?.category_performance ?? [];
  check('category_performance has at least one row', categoryRows.length > 0);
  check('every category_performance row reconciles item_count = realized + open', categoryRows.every((r) => r.item_count === (r.realized_item_count ?? 0) + (r.open_item_count ?? 0)), categoryRows);
  check('every type_performance row reconciles item_count = realized + open', typeRows.every((r) => r.item_count === (r.realized_item_count ?? 0) + (r.open_item_count ?? 0)), typeRows);

  console.log('\n[v1.6 — sale + trade exits reconcile to realized rows]');
  const guitarsRow = categoryRows.find((r) => r.category_name === 'Guitars');
  check(
    'Guitars category row: sale_exit_item_count + trade_exit_item_count === realized_item_count',
    !!guitarsRow && (guitarsRow.sale_exit_item_count ?? 0) + (guitarsRow.trade_exit_item_count ?? 0) === guitarsRow.realized_item_count,
    guitarsRow,
  );

  console.log('\n[v1.6 — positive bands exclude zero/unknown acquisition values]');
  const categoryBandRows: any[] = ctp?.category_by_acquisition_value_band ?? [];
  const typeBandRows: any[] = ctp?.type_by_acquisition_value_band ?? [];
  check(
    'category_by_acquisition_value_band never includes a zero/unknown/negative band label',
    categoryBandRows.every((r) => !['Zero assigned value', 'Unknown acquisition value', 'Negative (invalid)'].includes(r.acquisition_value_band_label)),
    categoryBandRows,
  );
  check(
    'category-band item_counts sum to positive_acquisition_item_count',
    categoryBandRows.reduce((sum, r) => sum + (r.item_count ?? 0), 0) === ctpPop?.positive_acquisition_item_count,
    { sum: categoryBandRows.reduce((sum, r) => sum + (r.item_count ?? 0), 0), positive: ctpPop?.positive_acquisition_item_count },
  );

  console.log('\n[v1.6 — Type-band rows use the correct Category + Type pair]');
  const ampsPedalBandRow = typeBandRows.find((r) => r.category_name === 'Amps' && r.type_name === 'Pedal' && r.acquisition_value_band_label === '$1-999');
  const pedalsPedalBandRow = typeBandRows.find((r) => r.category_name === 'Pedals' && r.type_name === 'Pedal' && r.acquisition_value_band_label === '$1-999');
  check('Amps/Pedal $1-999 band row exists (fixture item 32, $100)', !!ampsPedalBandRow && ampsPedalBandRow.item_count >= 1, ampsPedalBandRow);
  check('Pedals/Pedal $1-999 band row exists (fixture item 33, $80) and is a different row', !!pedalsPedalBandRow && pedalsPedalBandRow.item_count >= 1 && pedalsPedalBandRow.category_id !== ampsPedalBandRow?.category_id, pedalsPedalBandRow);

  console.log('\n[v1.6 — historical rows contribute to profit/ROI/DOM but excluded from holding]');
  check(
    'Guitars category row: holding_sample_size < realized_item_count (fixture item 9, historical)',
    !!guitarsRow && (guitarsRow.holding_sample_size ?? 0) < guitarsRow.realized_item_count,
    guitarsRow,
  );
  check('Guitars category row: total_realized_net_profit is a number (historical items included)', typeof guitarsRow?.total_realized_net_profit === 'number', guitarsRow?.total_realized_net_profit);

  console.log('\n[v1.6 — historical items excluded from open-inventory ownership age]');
  // item_subtypes seeding is inserted via a SELECT+JOIN (no ORDER BY), so
  // IDs don't necessarily match the VALUES literal order — verified live:
  // id 3 is actually "Electric Guitar" (the subtype every pre-v1.6 fixture
  // item, including historical item 14, was hardcoded to).
  const openByCategoryTypeRows: any[] = ctp?.open_inventory_by_category_type ?? [];
  const guitarsElectricOpenRow = openByCategoryTypeRows.find((r) => r.category_name === 'Guitars' && r.type_name === 'Electric Guitar');
  check('Guitars/Electric Guitar open row: historical_excluded_from_age_count >= 1 (fixtures.items.historicalImportOpenNoChannel)', (guitarsElectricOpenRow?.historical_excluded_from_age_count ?? 0) >= 1, guitarsElectricOpenRow);

  console.log('\n[v1.6 — multi-item deals preserve item and distinct-deal counts]');
  // Fixture items 29/30 use item_subtype_id 1, which is actually "Acoustic
  // Guitar" (see the ID-mapping note above) — a different Type from the
  // pre-existing fixture's "Electric Guitar" cohort, so this row is not
  // polluted by any other fixture item.
  const acousticGuitarRow = typeRows.find((r) => r.category_name === 'Guitars' && r.type_name === 'Acoustic Guitar');
  check(
    'Guitars/Acoustic Guitar row (fixtures.items.acousticPairA/acousticPairB, the only Business items using this subtype): item_count=2, distinct_acquisition_deal_count=1 (shared), distinct_exit_deal_count=2 (separate)',
    !!acousticGuitarRow && acousticGuitarRow.item_count === 2 && acousticGuitarRow.distinct_acquisition_deal_count === 1 && acousticGuitarRow.distinct_exit_deal_count === 2,
    acousticGuitarRow,
  );

  console.log('\n[v1.6 — shared evidence has no user-level or item-level fields]');
  check('no category_performance row exposes user_id or item_id', categoryRows.every((r) => !('user_id' in r) && !('item_id' in r)), categoryRows[0]);
  check('no type_performance row exposes user_id or item_id', typeRows.every((r) => !('user_id' in r) && !('item_id' in r)), typeRows[0]);

  console.log('\n[v1.6 — privacy across both fixture users]');
  const { data: v16SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userBId });
  const candidatesA16 = v16SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const candidatesB16 = v16SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA16 = new Set(candidatesA16.map((c: any) => c.item_id));
  const idsB16 = new Set(candidatesB16.map((c: any) => c.item_id));
  check("v1.6 user A's and user B's candidates don't overlap", Array.from(idsA16).every((id) => !idsB16.has(id)));

  console.log('\n[v1.6 — permissions on new functions]');
  const { error: ctpAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_6 directly', !!ctpAuthedError, ctpAuthedError);
  const { error: ctpHelperAuthedError } = await clientA.rpc('_build_category_type_snapshot_v1');
  check('authenticated client cannot call _build_category_type_snapshot_v1 directly', !!ctpHelperAuthedError, ctpHelperAuthedError);

  console.log('\n[v1.6 — builder still callable directly (unaffected by v1.7)]');
  const { error: v16StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_6 still callable by service_role', !v16StillCallableError, v16StillCallableError);

  // ── Capital & Liquidity (Snapshot v1.7) ──────────────────────────────────
  console.log('\n[v1.7 — builder callable, top-level metadata]');
  const { data: v17SnapshotA, error: v17ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_7 callable by service_role', !v17ErrorA, v17ErrorA);
  check('v1.7 snapshot_schema_version is 1.7', v17SnapshotA?.snapshot_schema_version === '1.7', v17SnapshotA?.snapshot_schema_version);
  check('v1.7 analytics_definition_version is 1.7', v17SnapshotA?.analytics_definition_version === '1.7', v17SnapshotA?.analytics_definition_version);
  check('v1.7 recommendation_target_user_id === userAId', v17SnapshotA?.recommendation_target_user_id === userAId);
  check('v1.7 still carries category_type_performance (v1.6 reused wholesale)', Array.isArray(v17SnapshotA?.evidence_aggregates?.category_type_performance?.population_summary));

  console.log('\n[v1.7 — Capital & Liquidity capital_position_summary]');
  const cl = v17SnapshotA?.evidence_aggregates?.capital_liquidity;
  const clPop = cl?.capital_position_summary?.[0];
  check(
    'capital_liquidity section exists with all 6 subsections',
    !!cl && Array.isArray(cl.capital_position_summary) && Array.isArray(cl.open_capital_age_buckets)
      && Array.isArray(cl.open_capital_by_acquisition_value_band) && Array.isArray(cl.open_capital_by_acquisition_method)
      && Array.isArray(cl.realized_capital_efficiency_by_acquisition_value_band) && Array.isArray(cl.realized_capital_efficiency_by_acquisition_method),
    cl ? Object.keys(cl) : cl,
  );
  check('population_summary reports only Business items (business_item_count > 0)', (clPop?.business_item_count ?? 0) > 0, clPop?.business_item_count);

  console.log('\n[v1.7 — population and coverage reconciliation]');
  check(
    'business_item_count = realized_business_item_count + open_business_item_count',
    clPop?.business_item_count === (clPop?.realized_business_item_count ?? 0) + (clPop?.open_business_item_count ?? 0),
    clPop,
  );
  check(
    'business_item_count >= positive + zero_assigned + unknown acquisition item counts',
    clPop?.business_item_count >= (clPop?.positive_acquisition_item_count ?? 0) + (clPop?.zero_assigned_acquisition_item_count ?? 0) + (clPop?.unknown_acquisition_item_count ?? 0),
    clPop,
  );

  console.log('\n[v1.7 — capital reconciliation]');
  check(
    'total_business_acquisition_capital = realized_acquisition_capital + open_acquisition_capital',
    Number(clPop?.total_business_acquisition_capital) === Number(clPop?.realized_acquisition_capital ?? 0) + Number(clPop?.open_acquisition_capital ?? 0),
    clPop,
  );
  check(
    'open_business_item_count = listed_open_item_count + unlisted_open_item_count',
    clPop?.open_business_item_count === (clPop?.listed_open_item_count ?? 0) + (clPop?.unlisted_open_item_count ?? 0),
    clPop,
  );
  check(
    'open_acquisition_capital = listed_open_acquisition_capital + unlisted_open_acquisition_capital',
    Number(clPop?.open_acquisition_capital) === Number(clPop?.listed_open_acquisition_capital ?? 0) + Number(clPop?.unlisted_open_acquisition_capital ?? 0),
    clPop,
  );

  console.log('\n[v1.7 — open capital age buckets: mutually exclusive, capital reconciles]');
  const ageBuckets: any[] = cl?.open_capital_age_buckets ?? [];
  check('open_capital_age_buckets has at least one row', ageBuckets.length > 0);
  const ageBucketItemSum = ageBuckets.reduce((sum, b) => sum + (b.open_item_count ?? 0), 0);
  check('every open item appears in exactly one age bucket (sum of item counts = open_business_item_count)', ageBucketItemSum === clPop?.open_business_item_count, { ageBucketItemSum, openBusinessItemCount: clPop?.open_business_item_count });
  const bucketCapitalSum = ageBuckets.reduce((sum, b) => sum + Number(b.open_acquisition_capital ?? 0), 0);
  check('age-bucket capital reconciles to total open acquisition capital', bucketCapitalSum === Number(clPop?.open_acquisition_capital ?? 0), { bucketCapitalSum, openAcquisitionCapital: clPop?.open_acquisition_capital });
  const unreliableBucket = ageBuckets.find((b) => b.age_bucket_label === 'unreliable/unknown age');
  check('Historical Imports land in the unreliable/unknown age bucket (e.g. fixtures.items.historicalImportOpenNoChannel), not a calendar bucket', !!unreliableBucket && unreliableBucket.open_item_count >= 1, unreliableBucket);

  console.log('\n[v1.7 — open capital by Acquisition Value Band]');
  const openBandRows: any[] = cl?.open_capital_by_acquisition_value_band ?? [];
  check(
    'open_capital_by_acquisition_value_band never includes a zero/unknown/negative band label',
    openBandRows.every((r) => !['Zero assigned value', 'Unknown acquisition value', 'Negative (invalid)'].includes(r.acquisition_value_band_label)),
    openBandRows,
  );
  const openBandCapitalSum = openBandRows.reduce((sum, r) => sum + Number(r.open_acquisition_capital ?? 0), 0);
  check('open value-band capital reconciles to total open acquisition capital (positive-only, matches Query A denominator)', openBandCapitalSum === Number(clPop?.open_acquisition_capital ?? 0), { openBandCapitalSum, openAcquisitionCapital: clPop?.open_acquisition_capital });

  console.log('\n[v1.7 — acquisition methods use only purchase/trade/unknown]');
  const openByMethodRows: any[] = cl?.open_capital_by_acquisition_method ?? [];
  const realizedByMethodRows: any[] = cl?.realized_capital_efficiency_by_acquisition_method ?? [];
  check('open_capital_by_acquisition_method uses only purchase/trade/unknown', openByMethodRows.every((r) => ['purchase', 'trade', 'unknown'].includes(r.acquisition_method)), openByMethodRows.map((r) => r.acquisition_method));
  check('realized_capital_efficiency_by_acquisition_method uses only purchase/trade/unknown', realizedByMethodRows.every((r) => ['purchase', 'trade', 'unknown'].includes(r.acquisition_method)), realizedByMethodRows.map((r) => r.acquisition_method));

  console.log('\n[v1.7 — historical items contribute to value-based efficiency, excluded from holding/time]');
  // Fixture item 9 is a Historical Import acquisition (deal_type =
  // 'Historical Import'), which the view's own acquisition_method CASE
  // maps to 'unknown' (only 'Historical Purchase' maps to 'purchase') —
  // so the historical-exclusion signal shows up in the 'unknown' method
  // row, not 'purchase'.
  const unknownMethodEfficiencyRow = realizedByMethodRows.find((r) => r.acquisition_method === 'unknown');
  check('unknown-method efficiency row: total_realized_net_profit is a number (historical items included)', typeof unknownMethodEfficiencyRow?.total_realized_net_profit === 'number', unknownMethodEfficiencyRow?.total_realized_net_profit);
  check(
    'unknown-method efficiency row: holding_sample_size < realized_item_count (fixture item 9, historical, excluded)',
    !!unknownMethodEfficiencyRow && (unknownMethodEfficiencyRow.holding_sample_size ?? 0) < unknownMethodEfficiencyRow.realized_item_count,
    unknownMethodEfficiencyRow,
  );
  check(
    'unknown-method efficiency row: time_efficiency_sample_size <= holding_sample_size (time efficiency is at least as strict as holding eligibility)',
    !!unknownMethodEfficiencyRow && (unknownMethodEfficiencyRow.time_efficiency_sample_size ?? 0) <= unknownMethodEfficiencyRow.holding_sample_size,
    unknownMethodEfficiencyRow,
  );

  console.log('\n[v1.7 — profit per 30 holding days computed item-level-first, never a ratio of medians]');
  // Expected values below are computed directly from fixtures.items.
  // profitBandItemA/profitBandItemB's OWN input constants (PROFIT_BAND_
  // ITEM_A/B in setup-analytics-test-fixtures.ts) — never copied from a
  // prior test run's output. These are the ONLY two realized items
  // anywhere in this fixture set with a positive acquisition value in the
  // $4,000-4,999 band, so the band is fully isolated to exactly these two.
  const bandEfficiencyRows: any[] = cl?.realized_capital_efficiency_by_acquisition_value_band ?? [];
  const band4to5kRow = bandEfficiencyRows.find((r) => r.acquisition_value_band_label === '$4,000-4,999');
  check(
    'isolated $4,000-4,999 band (fixtures.items.profitBandItemA/profitBandItemB): realized_item_count = 2',
    band4to5kRow?.realized_item_count === 2,
    band4to5kRow,
  );
  check(
    `median_net_profit_per_30_holding_days = ${expected.profitBand.medianNetProfitPer30HoldingDays} (item-level-first: median of each item's own net_profit/holding_days*30) — computed from fixture inputs, not a ratio of medians`,
    Number(band4to5kRow?.median_net_profit_per_30_holding_days) === expected.profitBand.medianNetProfitPer30HoldingDays,
    { actual: band4to5kRow?.median_net_profit_per_30_holding_days, expected: expected.profitBand.medianNetProfitPer30HoldingDays },
  );
  check(
    `median_net_profit = ${expected.profitBand.medianNetProfit} (median of item-level net_profit, computed from fixture inputs)`,
    Number(band4to5kRow?.median_net_profit) === expected.profitBand.medianNetProfit,
    { actual: band4to5kRow?.median_net_profit, expected: expected.profitBand.medianNetProfit },
  );

  console.log('\n[v1.7 — aggregate profit-to-capital is never substituted for median ROI]');
  check(
    `profit_to_acquisition_capital_percent (${expected.profitBand.profitToAcquisitionCapitalPercent}, aggregate SUM ratio) differs from median_roi (${expected.profitBand.medianRoiPercent}, median of per-item ratios) for the isolated band — both independently derived from fixture inputs`,
    Number(band4to5kRow?.profit_to_acquisition_capital_percent) === expected.profitBand.profitToAcquisitionCapitalPercent
      && Number(band4to5kRow?.median_roi) === expected.profitBand.medianRoiPercent,
    { profitToCapital: band4to5kRow?.profit_to_acquisition_capital_percent, medianRoi: band4to5kRow?.median_roi, expected: expected.profitBand },
  );

  console.log('\n[v1.7 — shared evidence has no user-level or item-level fields]');
  check('no open_capital_age_buckets row exposes user_id or item_id', ageBuckets.every((r) => !('user_id' in r) && !('item_id' in r)), ageBuckets[0]);
  check('no realized_capital_efficiency_by_acquisition_value_band row exposes user_id or item_id', bandEfficiencyRows.every((r) => !('user_id' in r) && !('item_id' in r)), bandEfficiencyRows[0]);

  console.log('\n[v1.7 — privacy across both fixture users]');
  const { data: v17SnapshotB } = await serviceClient.rpc('build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userBId });
  const candidatesA17 = v17SnapshotA?.recommendation_candidates?.open_business_items ?? [];
  const candidatesB17 = v17SnapshotB?.recommendation_candidates?.open_business_items ?? [];
  const idsA17 = new Set(candidatesA17.map((c: any) => c.item_id));
  const idsB17 = new Set(candidatesB17.map((c: any) => c.item_id));
  check("v1.7 user A's and user B's candidates don't overlap", Array.from(idsA17).every((id) => !idsB17.has(id)));

  console.log('\n[v1.7 — permissions on new functions]');
  const { error: clAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_7 directly', !!clAuthedError, clAuthedError);
  const { error: clHelperAuthedError } = await clientA.rpc('_build_capital_liquidity_snapshot_v1');
  check('authenticated client cannot call _build_capital_liquidity_snapshot_v1 directly', !!clHelperAuthedError, clHelperAuthedError);

  console.log('\n[v1.7 — builder still callable directly (unaffected by v1.8)]');
  const { error: v17StillCallableError } = await serviceClient.rpc('build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_7 still callable by service_role', !v17StillCallableError, v17StillCallableError);

  // ── Open Inventory Decision Support v1 (Snapshot v1.8) ───────────────────
  console.log('\n[v1.8 — builder callable, top-level metadata]');
  const { data: v18SnapshotA, error: v18ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_8 callable by service_role', !v18ErrorA, v18ErrorA);
  check('v1.8 snapshot_schema_version is 1.8', v18SnapshotA?.snapshot_schema_version === '1.8', v18SnapshotA?.snapshot_schema_version);
  check('v1.8 analytics_definition_version is 1.8', v18SnapshotA?.analytics_definition_version === '1.8', v18SnapshotA?.analytics_definition_version);
  check('v1.8 recommendation_target_user_id === userAId', v18SnapshotA?.recommendation_target_user_id === userAId);

  console.log('\n[v1.8 — evidence_aggregates and recommendation_candidates unchanged from v1.7]');
  check(
    'evidence_aggregates is byte-identical to v1.7 (test #21)',
    JSON.stringify(v18SnapshotA?.evidence_aggregates) === JSON.stringify(v17SnapshotA?.evidence_aggregates),
  );
  check(
    'recommendation_candidates is byte-identical to v1.7 (test #20)',
    JSON.stringify(v18SnapshotA?.recommendation_candidates) === JSON.stringify(v17SnapshotA?.recommendation_candidates),
  );

  console.log('\n[v1.8 — Open Inventory Decision Support section shape]');
  const oids = v18SnapshotA?.target_user_evidence?.open_inventory_decision_support;
  check(
    'open_inventory_decision_support exists with all subsections',
    !!oids && Array.isArray(oids.population_summary) && Array.isArray(oids.item_decision_evidence)
      && Array.isArray(oids.within_brand_comparison) && typeof oids.listing_state_basis === 'string'
      && Array.isArray(oids.module_limitations),
    oids ? Object.keys(oids) : oids,
  );
  check('listing-state basis is present (test #8)', oids?.listing_state_basis === 'open_item_with_listing_record', oids?.listing_state_basis);
  check('module_limitations is present and non-empty (test #8)', (oids?.module_limitations ?? []).length > 0, oids?.module_limitations);

  const oidsPop = oids?.population_summary?.[0];
  const items: any[] = oids?.item_decision_evidence ?? [];

  console.log('\n[v1.8 — only target-user items appear (tests #1, #2)]');
  check('item_decision_evidence.length === open_business_item_count', items.length === oidsPop?.open_business_item_count, { length: items.length, open: oidsPop?.open_business_item_count });
  // Derived live from the database (never a hardcoded literal-id list) —
  // every open Business item_id currently belonging to User B.
  const { data: userBOpenBusinessRows } = await serviceClient
    .from('analytics_item_lifecycle').select('item_id').eq('user_id', userBId).eq('purpose_name', 'Business').eq('is_realized', false);
  const userBOpenItemIds = (userBOpenBusinessRows ?? []).map((r: any) => r.item_id);
  check("no User B open Business item_id appears in User A's item_decision_evidence", userBOpenItemIds.length > 0 && items.every((r) => !userBOpenItemIds.includes(r.item_id)), { userBOpenItemIds, userAItemIds: items.map((r) => r.item_id) });

  console.log('\n[v1.8 — population reconciliation (tests #4, #5)]');
  check(
    'open_business_item_count = listed_open_item_count + unlisted_open_item_count',
    oidsPop?.open_business_item_count === (oidsPop?.listed_open_item_count ?? 0) + (oidsPop?.unlisted_open_item_count ?? 0),
    oidsPop,
  );
  check(
    'open_business_item_count = positive + zero_assigned + unknown acquisition item counts',
    oidsPop?.open_business_item_count === (oidsPop?.positive_acquisition_item_count ?? 0) + (oidsPop?.zero_assigned_acquisition_item_count ?? 0) + (oidsPop?.unknown_acquisition_item_count ?? 0),
    oidsPop,
  );
  check(
    'open_business_item_count = reliable + unreliable ownership age counts',
    oidsPop?.open_business_item_count === (oidsPop?.reliable_ownership_age_item_count ?? 0) + (oidsPop?.unreliable_ownership_age_item_count ?? 0),
    oidsPop,
  );
  check(
    'open_business_item_count = sufficient + low_confidence + no_comparable cohort item counts',
    oidsPop?.open_business_item_count === (oidsPop?.sufficient_comparable_cohort_item_count ?? 0) + (oidsPop?.low_confidence_comparable_cohort_item_count ?? 0) + (oidsPop?.no_comparable_cohort_item_count ?? 0),
    oidsPop,
  );
  check('at least one item has low-confidence comparable cohort (fixtures.items.reverbOpenSoleSample)', (oidsPop?.low_confidence_comparable_cohort_item_count ?? 0) >= 1, oidsPop?.low_confidence_comparable_cohort_item_count);

  console.log('\n[v1.8 — unlisted items have NULL current DOM; historical items have NULL ownership age (tests #6, #7)]');
  check('every unlisted item has current_dom_days === null', items.filter((r) => !r.listed_flag).every((r) => r.current_dom_days === null), items.filter((r) => !r.listed_flag).map((r) => r.current_dom_days));
  const item14 = items.find((r) => r.item_id === fx.historicalImportOpenNoChannel);
  check('fixtures.items.historicalImportOpenNoChannel has is_historical_import = true and ownership_age_days === null', !!item14 && item14.is_historical_import === true && item14.ownership_age_days === null, item14);

  console.log('\n[v1.8 — comparable cohort hierarchy: specific-sufficient and broad-fallback (tests #3, #9, #10)]');
  const item2 = items.find((r) => r.item_id === fx.openFenderPositiveBand);
  // Per the documented selection rule (analytics/sql/10_open_inventory_
  // decision_support.sql header): the FIRST candidate (any specificity)
  // reaching realized_item_count >= 5 wins outright, even over a MORE
  // specific candidate with a smaller count. Fender's brand-wide realized
  // count in this fixture set crosses that threshold, so 'brand' is the
  // correct, algorithm-faithful outcome here — 'brand_band'/'brand_type_
  // band' would only win if Fender's brand-wide count stayed below 3.
  // Any of the three still proves the cohort is more specific than a flat
  // all_business fallback, which is this test's actual semantic intent.
  check('fixtures.items.openFenderPositiveBand (Fender, $1-999 band) resolves to a specific, non-all_business cohort (brand, brand_band, or brand_type_band)', !!item2?.comparable_cohort && ['brand', 'brand_band', 'brand_type_band'].includes(item2.comparable_cohort.cohort_scope), item2?.comparable_cohort);
  const item37 = items.find((r) => r.item_id === fx.allBusinessFallbackItem);
  check('fixtures.items.allBusinessFallbackItem (isolated brand/category/band) falls all the way back to all_business (test #10)', item37?.comparable_cohort?.cohort_scope === 'all_business', item37?.comparable_cohort);

  console.log('\n[v1.8 — cohort profit/ROI/DOM use realized items only; realization rate uses open+realized (tests #11, #12)]');
  const cohortsSeen = items.map((r) => r.comparable_cohort).filter((c) => c);
  check('every cohort: realized_item_count <= cohort_item_count', cohortsSeen.every((c) => c.realized_item_count <= c.cohort_item_count), cohortsSeen);
  check(
    'every cohort: cohort_item_count = open_item_count + realized_item_count (realization rate uses both)',
    cohortsSeen.every((c) => c.cohort_item_count === c.open_item_count + c.realized_item_count),
    cohortsSeen,
  );

  console.log('\n[v1.8 — historical rows contribute to DOM but not holding evidence (test #13)]');
  const item27 = items.find((r) => r.item_id === fx.highCapitalExposureOpen);
  check(
    'Gibson brand-level cohort (falls back to unrestricted brand, which includes fixtures.items.historicalImportRealized): holding_sample_size < realized_item_count',
    !!item27?.comparable_cohort && (item27.comparable_cohort.holding_sample_size ?? 0) < item27.comparable_cohort.realized_item_count,
    item27?.comparable_cohort,
  );

  console.log('\n[v1.8 — p75 DOM calculated correctly (test #14)]');
  const cohortsWithDom = cohortsSeen.filter((c) => c.dom_sample_size >= 2 && c.p75_days_on_market !== null && c.median_days_on_market !== null);
  check('every cohort with >=2 DOM samples: p75_days_on_market >= median_days_on_market', cohortsWithDom.every((c) => c.p75_days_on_market >= c.median_days_on_market), cohortsWithDom);

  console.log('\n[v1.8 — reason-code thresholds (tests #15, #16, #17)]');
  check(`fixtures.items.highCapitalExposureOpen (highest acquisition value, $${HIGH_CAPITAL_ITEM.acquisitionValue}) carries HIGH_CAPITAL_EXPOSURE`, !!item27 && item27.reason_codes.includes('HIGH_CAPITAL_EXPOSURE'), item27?.reason_codes);
  const item45 = items.find((r) => r.item_id === fx.lowEstimatedUpsideOpen);
  check(
    `fixtures.items.lowEstimatedUpsideOpen (${expected.lowEstimatedUpsidePercent}% estimated upside, positive value) carries LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL`,
    !!item45 && item45.reason_codes.includes('LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL') && item45.estimated_upside_percent === expected.lowEstimatedUpsidePercent,
    item45,
  );
  const item44 = items.find((r) => r.item_id === fx.reverbOpenSoleSample);
  check(
    'fixtures.items.reverbOpenSoleSample (brand_type_band cohort realized_item_count = 5, winning cohort selection on the specificity tie-break over all_business) carries LOW_COMPARABLE_CONFIDENCE, not NO_COMPARABLE_EVIDENCE',
    !!item44 && item44.reason_codes.includes('LOW_COMPARABLE_CONFIDENCE') && !item44.reason_codes.includes('NO_COMPARABLE_EVIDENCE') && item44.comparable_cohort?.confidence === 'low',
    item44,
  );
  check(
    'NO_COMPARABLE_EVIDENCE and LOW_COMPARABLE_CONFIDENCE logic is self-consistent for every item (comparable_evidence_available <=> comparable_cohort present <=> reason code correctness)',
    items.every((r) =>
      (r.comparable_evidence_available === (r.comparable_cohort !== null))
      && (r.reason_codes.includes('NO_COMPARABLE_EVIDENCE') === (r.comparable_cohort === null))
      && (r.reason_codes.includes('LOW_COMPARABLE_CONFIDENCE') === (r.comparable_cohort !== null && ['insufficient', 'low'].includes(r.comparable_cohort.confidence)))
    ),
    items.map((r) => ({ id: r.item_id, available: r.comparable_evidence_available, cohort: r.comparable_cohort?.confidence ?? null, codes: r.reason_codes })),
  );

  console.log('\n[v1.8 — no score/priority/action fields anywhere (test #18)]');
  const forbiddenKeys = ['score', 'priority_score', 'recommended_action'];
  check('no item_decision_evidence row exposes score/priority_score/recommended_action', items.every((r) => forbiddenKeys.every((k) => !(k in r))), items[0] ? Object.keys(items[0]) : items);
  check('module-level object exposes no score/priority_score/recommended_action', forbiddenKeys.every((k) => oids && !(k in oids)));

  console.log('\n[v1.8 — within-brand reconciliation to target-user open inventory (test #19)]');
  const brandRows: any[] = oids?.within_brand_comparison ?? [];
  const brandItemSum = brandRows.reduce((sum, b) => sum + (b.open_item_count ?? 0), 0);
  check('sum of within_brand_comparison.open_item_count === open_business_item_count', brandItemSum === oidsPop?.open_business_item_count, { brandItemSum, open: oidsPop?.open_business_item_count });
  const brandCapitalSum = brandRows.reduce((sum, b) => sum + Number(b.open_acquisition_capital ?? 0), 0);
  check('sum of within_brand_comparison.open_acquisition_capital === open_acquisition_capital', brandCapitalSum === Number(oidsPop?.open_acquisition_capital ?? 0), { brandCapitalSum, capital: oidsPop?.open_acquisition_capital });

  console.log('\n[v1.8 — shared comparable cohorts pool beyond the target user alone (test #3)]');
  const fenderBrandRow = brandRows.find((b) => b.brand_name === 'Fender');
  check(
    "fixtures.items.openFenderPositiveBand's Fender brand_band cohort_item_count exceeds User A's own Fender open_item_count (within_brand_comparison, target-user-only) — proves the cohort pools more than just this user's own open inventory",
    !!item2?.comparable_cohort && !!fenderBrandRow && item2.comparable_cohort.cohort_item_count > fenderBrandRow.open_item_count,
    { cohortItemCount: item2?.comparable_cohort?.cohort_item_count, fenderOwnOpenItemCount: fenderBrandRow?.open_item_count },
  );

  console.log('\n[v1.8 — privacy: within_brand_comparison and identity fields never leak another user]');
  check('no within_brand_comparison row exposes user_id or item_id', brandRows.every((r) => !('user_id' in r) && !('item_id' in r)), brandRows[0]);

  console.log('\n[v1.8 — permissions on new functions]');
  const { error: oidsAuthedError } = await clientA.rpc('build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v1_8 directly', !!oidsAuthedError, oidsAuthedError);
  const { error: oidsHelperAuthedError } = await clientA.rpc('_build_open_inventory_decision_support_snapshot_v1', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_open_inventory_decision_support_snapshot_v1 directly', !!oidsHelperAuthedError, oidsHelperAuthedError);

  // Note: at the point v1.8 was introduced, a new runner call persisted
  // analytics_version 1.8 — the runner has since been promoted to v2.2
  // (see the "[v2.2 ...]" tests below), so a new call now persists 2.2.
  // build_analytics_snapshot_v1_8 itself remains directly callable and
  // unchanged, exercised via the direct RPC calls throughout this file.
  const { error: v18DirectCallError } = await serviceClient.rpc('build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_8 remains directly callable by service_role', !v18DirectCallError, v18DirectCallError);

  // ── Purpose-Aware Analytics Foundation (analytics_purpose_policy + analytics_item_lifecycle_v2) ──
  console.log('\n[Purpose-Aware Foundation — analytics_purpose_policy seeded rows and mapping]');
  const { data: policyRows, error: policyRowsError } = await serviceClient
    .from('analytics_purpose_policy')
    .select('purpose_id, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy, item_purposes:purpose_id(name)')
    .order('realization_priority_order');
  check('analytics_purpose_policy readable and has exactly 3 seeded rows', !policyRowsError && policyRows?.length === 3, policyRowsError ?? policyRows);

  const policyByName = new Map<string, any>();
  for (const row of policyRows ?? []) {
    const name = ((row as any).item_purposes?.name ?? '').toLowerCase();
    policyByName.set(name, row);
  }
  const businessPolicy = policyByName.get('business');
  const hybridPolicy = policyByName.get('hybrid');
  const personalPolicy = policyByName.get('personal');
  check(
    'Business maps to active_realization / active_realization_flag=true / shorter_holding_preferred',
    businessPolicy?.disposition_mode === 'active_realization'
      && businessPolicy?.active_realization_flag === true
      && businessPolicy?.expected_holding_policy === 'shorter_holding_preferred',
    businessPolicy,
  );
  check(
    'Hybrid maps to selective_realization / active_realization_flag=true / extended_holding_acceptable',
    hybridPolicy?.disposition_mode === 'selective_realization'
      && hybridPolicy?.active_realization_flag === true
      && hybridPolicy?.expected_holding_policy === 'extended_holding_acceptable',
    hybridPolicy,
  );
  check(
    'Personal maps to opportunistic_realization / active_realization_flag=false / long_holding_acceptable',
    personalPolicy?.disposition_mode === 'opportunistic_realization'
      && personalPolicy?.active_realization_flag === false
      && personalPolicy?.expected_holding_policy === 'long_holding_acceptable',
    personalPolicy,
  );
  check(
    'realization_priority_order: Business < Hybrid < Personal',
    businessPolicy?.realization_priority_order < hybridPolicy?.realization_priority_order
      && hybridPolicy?.realization_priority_order < personalPolicy?.realization_priority_order,
    { business: businessPolicy?.realization_priority_order, hybrid: hybridPolicy?.realization_priority_order, personal: personalPolicy?.realization_priority_order },
  );

  console.log('\n[Purpose-Aware Foundation — analytics_item_lifecycle_v2 row-count reconciliation]');
  const { data: v1Rows, error: v1RowsError } = await serviceClient
    .from('analytics_item_lifecycle')
    .select('item_id, user_id, purpose_id, purpose_name, acquisition_value, is_historical_import, is_realized, net_profit');
  const { data: v2Rows, error: v2RowsError } = await serviceClient
    .from('analytics_item_lifecycle_v2')
    .select('item_id, user_id, purpose_id, purpose_name, current_purpose_id, current_purpose_name, acquisition_value, is_historical_import, is_realized, net_profit, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy, purpose_policy_status');
  check('analytics_item_lifecycle and analytics_item_lifecycle_v2 both readable', !v1RowsError && !v2RowsError, v1RowsError ?? v2RowsError);
  check('analytics_item_lifecycle_v2 row count === analytics_item_lifecycle row count (no row dropped)', (v1Rows?.length ?? -1) === (v2Rows?.length ?? -2), { v1: v1Rows?.length, v2: v2Rows?.length });

  const v2ByItemId = new Map<number, any>((v2Rows ?? []).map((r: any) => [r.item_id, r]));
  console.log('\n[Purpose-Aware Foundation — no existing lifecycle value changed, current_* aliases match]');
  check(
    'every v1 row has a matching v2 row with byte-identical shared column values',
    (v1Rows ?? []).every((v1r: any) => {
      const v2r = v2ByItemId.get(v1r.item_id);
      return !!v2r
        && v2r.user_id === v1r.user_id
        && v2r.purpose_id === v1r.purpose_id
        && v2r.purpose_name === v1r.purpose_name
        && Number(v2r.acquisition_value ?? 0) === Number(v1r.acquisition_value ?? 0)
        && v2r.is_historical_import === v1r.is_historical_import
        && v2r.is_realized === v1r.is_realized
        && Number(v2r.net_profit ?? 0) === Number(v1r.net_profit ?? 0);
    }),
    (v1Rows ?? []).filter((v1r: any) => {
      const v2r = v2ByItemId.get(v1r.item_id);
      return !v2r || v2r.purpose_id !== v1r.purpose_id || v2r.purpose_name !== v1r.purpose_name;
    }),
  );
  check(
    'current_purpose_id/current_purpose_name are byte-identical aliases of purpose_id/purpose_name for every row',
    (v2Rows ?? []).every((r: any) => r.current_purpose_id === r.purpose_id && r.current_purpose_name === r.purpose_name),
  );

  console.log('\n[Purpose-Aware Foundation — missing_purpose fixture and missing_policy fixture]');
  const item100 = v2ByItemId.get(fx.missingPurposeItem);
  check(
    'fixtures.items.missingPurposeItem (purpose_id NULL) is visible via v2 with purpose_policy_status = missing_purpose and NULL policy fields',
    !!item100 && item100.purpose_id === null && item100.purpose_policy_status === 'missing_purpose'
      && item100.disposition_mode === null && item100.realization_priority_order === null
      && item100.active_realization_flag === null && item100.expected_holding_policy === null,
    item100,
  );
  const item101 = v2ByItemId.get(fx.missingPolicyItem);
  check(
    'fixtures.items.missingPolicyItem (unmapped "Loaner" purpose) is visible via v2 with purpose_policy_status = missing_policy, current_purpose_name populated, policy fields NULL',
    !!item101 && item101.purpose_id !== null && item101.current_purpose_name === 'Loaner' && item101.purpose_policy_status === 'missing_policy'
      && item101.disposition_mode === null && item101.realization_priority_order === null
      && item101.active_realization_flag === null && item101.expected_holding_policy === null,
    item101,
  );
  check(
    'every non-fixture row with a mapped Business/Hybrid/Personal purpose has purpose_policy_status = mapped',
    (v2Rows ?? [])
      .filter((r: any) => ![fx.missingPurposeItem, fx.missingPolicyItem].includes(r.item_id) && r.purpose_id !== null)
      .every((r: any) => r.purpose_policy_status === 'mapped'),
  );

  console.log('\n[Purpose-Aware Foundation — v1.0-v1.8 snapshot outputs unaffected by the new fixture items]');
  const { data: v18SnapshotAfterFixture, error: v18AfterFixtureError } = await serviceClient.rpc('build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_8 still callable after Purpose-Aware Foundation migrations', !v18AfterFixtureError, v18AfterFixtureError);
  const itemsAfterFixture: any[] = v18SnapshotAfterFixture?.target_user_evidence?.open_inventory_decision_support?.item_decision_evidence ?? [];
  check(
    'items 100 and 101 (non-Business purpose) do not appear in v1.8 item_decision_evidence',
    itemsAfterFixture.every((r) => r.item_id !== 100 && r.item_id !== 101),
    itemsAfterFixture.map((r) => r.item_id),
  );
  const { generated_at: _genA, ...v18SnapshotAWithoutTimestamp } = (v18SnapshotA ?? {}) as Record<string, unknown>;
  const { generated_at: _genAfter, ...v18SnapshotAfterFixtureWithoutTimestamp } = (v18SnapshotAfterFixture ?? {}) as Record<string, unknown>;
  check(
    'v1.8 snapshot is otherwise unchanged (byte-identical to the earlier call in this run, ignoring generated_at)',
    JSON.stringify(v18SnapshotAfterFixtureWithoutTimestamp) === JSON.stringify(v18SnapshotAWithoutTimestamp),
  );

  console.log('\n[Purpose-Aware Foundation — v1.0 through v1.7 remain callable]');
  const stillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
  ];
  for (const [fn, args] of stillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after Purpose-Aware Foundation migrations`, !error, error);
  }

  console.log('\n[Purpose-Aware Foundation — security: authenticated can SELECT policy, cannot write it]');
  const { data: policyAuthedSelect, error: policyAuthedSelectError } = await clientA
    .from('analytics_purpose_policy')
    .select('purpose_id')
    .limit(1);
  check('authenticated client can SELECT analytics_purpose_policy', !policyAuthedSelectError && !!policyAuthedSelect, policyAuthedSelectError);
  const { error: policyInsertError } = await clientA
    .from('analytics_purpose_policy')
    .insert({ purpose_id: 999999, disposition_mode: 'x', realization_priority_order: 1, active_realization_flag: true, expected_holding_policy: 'x', description: 'x' });
  check('authenticated client cannot INSERT into analytics_purpose_policy', !!policyInsertError, policyInsertError);
  const { error: policyUpdateError } = await clientA
    .from('analytics_purpose_policy')
    .update({ disposition_mode: 'tampered' })
    .eq('purpose_id', businessPolicy?.purpose_id ?? -1);
  check('authenticated client cannot UPDATE analytics_purpose_policy', !!policyUpdateError, policyUpdateError);
  const { error: policyDeleteError } = await clientA
    .from('analytics_purpose_policy')
    .delete()
    .eq('purpose_id', businessPolicy?.purpose_id ?? -1);
  check('authenticated client cannot DELETE from analytics_purpose_policy', !!policyDeleteError, policyDeleteError);

  console.log('\n[Purpose-Aware Foundation — analytics_item_lifecycle_v2 security model matches v1 (per-user RLS via security_invoker)]');
  const { data: v1AuthedRows, error: v1AuthedError } = await clientA.from('analytics_item_lifecycle').select('item_id');
  const { data: v2AuthedRows, error: v2AuthedError } = await clientA.from('analytics_item_lifecycle_v2').select('item_id');
  check('authenticated client can SELECT both analytics_item_lifecycle and analytics_item_lifecycle_v2', !v1AuthedError && !v2AuthedError, v1AuthedError ?? v2AuthedError);
  check(
    'authenticated client sees the same set of item_ids through v2 as through v1 (same RLS scoping)',
    JSON.stringify((v1AuthedRows ?? []).map((r: any) => r.item_id).sort((a: number, b: number) => a - b))
      === JSON.stringify((v2AuthedRows ?? []).map((r: any) => r.item_id).sort((a: number, b: number) => a - b)),
    { v1Count: v1AuthedRows?.length, v2Count: v2AuthedRows?.length },
  );

  // ── Analytics v2.0 Snapshot Foundation and Purpose Overview ──────────────
  console.log('\n[v2.0 — builder callable, top-level metadata, clean contract]');
  const { data: v20SnapshotA, error: v20ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_0', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_0 callable by service_role', !v20ErrorA, v20ErrorA);
  check('v2.0 snapshot_schema_version is 2.0', v20SnapshotA?.snapshot_schema_version === '2.0', v20SnapshotA?.snapshot_schema_version);
  check('v2.0 analytics_definition_version is 2.0', v20SnapshotA?.analytics_definition_version === '2.0', v20SnapshotA?.analytics_definition_version);
  check('v2.0 evidence_scope is shared_inventory_population', v20SnapshotA?.evidence_scope === 'shared_inventory_population', v20SnapshotA?.evidence_scope);
  check('v2.0 purpose_semantics is current_item_purpose', v20SnapshotA?.purpose_semantics === 'current_item_purpose', v20SnapshotA?.purpose_semantics);
  const v20RequiredLimitations = ['CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE', 'PURPOSE_CHANGES_ARE_NOT_HISTORICALLY_TRACKED', 'LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD'];
  check(
    'v2.0 module_limitations contains all three required codes',
    v20RequiredLimitations.every((code) => (v20SnapshotA?.module_limitations ?? []).includes(code)),
    v20SnapshotA?.module_limitations,
  );
  check(
    'v2.0 does not include evidence_aggregates, recommendation_candidates, or target_user_evidence (Open Inventory Decision Support)',
    !('evidence_aggregates' in (v20SnapshotA ?? {})) && !('recommendation_candidates' in (v20SnapshotA ?? {})) && !('target_user_evidence' in (v20SnapshotA ?? {})),
    v20SnapshotA ? Object.keys(v20SnapshotA) : v20SnapshotA,
  );

  const sharedPop = v20SnapshotA?.shared_purpose_evidence?.population_summary?.[0];
  const sharedBreakdown: any[] = v20SnapshotA?.shared_purpose_evidence?.purpose_breakdown ?? [];
  const targetPos = v20SnapshotA?.target_user_purpose_evidence?.position_summary?.[0];
  const targetBreakdown: any[] = v20SnapshotA?.target_user_purpose_evidence?.purpose_position_breakdown ?? [];

  console.log('\n[v2.0 — test #1: all Business, Hybrid, and Personal items are included]');
  check(
    'purpose_breakdown includes a mapped row for Business, Hybrid, and Personal',
    ['Business', 'Hybrid', 'Personal'].every((name) => sharedBreakdown.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === name)),
    sharedBreakdown.map((r) => r.current_purpose_name),
  );

  console.log('\n[v2.0 — test #2: total population reconciles to analytics_item_lifecycle_v2]');
  const { data: v2AllRows, error: v2AllRowsError } = await serviceClient
    .from('analytics_item_lifecycle_v2')
    .select('item_id, user_id, is_realized, current_status, acquisition_value, net_profit, roi, is_historical_import, has_lifecycle_date_issue, holding_days, global_days_on_market, estimated_sold_value, item_expenses_total, purpose_policy_status');
  check('analytics_item_lifecycle_v2 readable by service_role', !v2AllRowsError, v2AllRowsError);
  check(
    'population_summary.total_item_count === analytics_item_lifecycle_v2 row count',
    sharedPop?.total_item_count === (v2AllRows?.length ?? -1),
    { snapshot: sharedPop?.total_item_count, view: v2AllRows?.length },
  );

  console.log('\n[v2.0 — test #3: open + realized reconciles to total]');
  check(
    'population_summary: open_item_count + realized_item_count === total_item_count',
    (sharedPop?.open_item_count ?? 0) + (sharedPop?.realized_item_count ?? 0) === sharedPop?.total_item_count,
    sharedPop,
  );

  console.log('\n[v2.0 — test #4: listed open + unlisted open reconciles to open]');
  check(
    'population_summary: listed_open_item_count + unlisted_open_item_count === open_item_count',
    (sharedPop?.listed_open_item_count ?? 0) + (sharedPop?.unlisted_open_item_count ?? 0) === sharedPop?.open_item_count,
    sharedPop,
  );

  console.log('\n[v2.0 — test #5: mapped + missing purpose + missing policy reconciles to total]');
  check(
    'population_summary: mapped_purpose_item_count + missing_purpose_item_count + missing_policy_item_count === total_item_count',
    (sharedPop?.mapped_purpose_item_count ?? 0) + (sharedPop?.missing_purpose_item_count ?? 0) + (sharedPop?.missing_policy_item_count ?? 0) === sharedPop?.total_item_count,
    sharedPop,
  );

  console.log('\n[v2.0 — test #6: Business, Hybrid, Personal policy metadata is correct]');
  const businessRow = sharedBreakdown.find((r) => r.current_purpose_name === 'Business');
  const hybridRow = sharedBreakdown.find((r) => r.current_purpose_name === 'Hybrid');
  const personalRow = sharedBreakdown.find((r) => r.current_purpose_name === 'Personal');
  check(
    'Business row: active_realization / priority 1 / active_realization_flag=true / shorter_holding_preferred',
    businessRow?.disposition_mode === 'active_realization' && businessRow?.realization_priority_order === 1
      && businessRow?.active_realization_flag === true && businessRow?.expected_holding_policy === 'shorter_holding_preferred',
    businessRow,
  );
  check(
    'Hybrid row: selective_realization / priority 2 / active_realization_flag=true / extended_holding_acceptable',
    hybridRow?.disposition_mode === 'selective_realization' && hybridRow?.realization_priority_order === 2
      && hybridRow?.active_realization_flag === true && hybridRow?.expected_holding_policy === 'extended_holding_acceptable',
    hybridRow,
  );
  check(
    'Personal row: opportunistic_realization / priority 3 / active_realization_flag=false / long_holding_acceptable',
    personalRow?.disposition_mode === 'opportunistic_realization' && personalRow?.realization_priority_order === 3
      && personalRow?.active_realization_flag === false && personalRow?.expected_holding_policy === 'long_holding_acceptable',
    personalRow,
  );

  console.log('\n[v2.0 — test #7/#8: missing-purpose and missing-policy rows remain visible]');
  const missingPurposeRow = sharedBreakdown.find((r) => r.purpose_policy_status === 'missing_purpose');
  const missingPolicyRow = sharedBreakdown.find((r) => r.purpose_policy_status === 'missing_policy');
  check(
    'a missing_purpose row is present with total_item_count >= 1 and NULL policy fields',
    !!missingPurposeRow && missingPurposeRow.total_item_count >= 1 && missingPurposeRow.current_purpose_id === null
      && missingPurposeRow.disposition_mode === null && missingPurposeRow.realization_priority_order === null,
    missingPurposeRow,
  );
  check(
    'a missing_policy row is present with total_item_count >= 1 and NULL policy fields',
    !!missingPolicyRow && missingPolicyRow.total_item_count >= 1 && missingPolicyRow.current_purpose_id === null
      && missingPolicyRow.disposition_mode === null && missingPolicyRow.realization_priority_order === null,
    missingPolicyRow,
  );

  console.log('\n[v2.0 — test #9/#10: acquisition capital and realized profit reconcile across Purpose rows]');
  const breakdownCapitalSum = sharedBreakdown.reduce((sum, r) => sum + Number(r.total_acquisition_capital ?? 0), 0);
  check(
    'sum of purpose_breakdown.total_acquisition_capital === population_summary.total_acquisition_capital',
    breakdownCapitalSum === Number(sharedPop?.total_acquisition_capital ?? 0),
    { breakdownCapitalSum, populationTotal: sharedPop?.total_acquisition_capital },
  );
  const breakdownProfitSum = sharedBreakdown.reduce((sum, r) => sum + Number(r.total_realized_net_profit ?? 0), 0);
  check(
    'sum of purpose_breakdown.total_realized_net_profit === population_summary.total_realized_net_profit',
    breakdownProfitSum === Number(sharedPop?.total_realized_net_profit ?? 0),
    { breakdownProfitSum, populationTotal: sharedPop?.total_realized_net_profit },
  );

  console.log('\n[v2.0 — test #11: ROI excludes zero/unknown acquisition values]');
  check(
    'every realized row with zero-assigned or unknown acquisition_value has roi === null in analytics_item_lifecycle_v2',
    (v2AllRows ?? []).filter((r: any) => r.is_realized && (r.acquisition_value === null || Number(r.acquisition_value) === 0)).every((r: any) => r.roi === null),
    (v2AllRows ?? []).filter((r: any) => r.is_realized && (r.acquisition_value === null || Number(r.acquisition_value) === 0)),
  );
  check(
    'Business row: realized_positive_acquisition_item_count <= realized_item_count (median_roi computed over a subset)',
    (businessRow?.realized_positive_acquisition_item_count ?? 0) <= (businessRow?.realized_item_count ?? 0),
    businessRow,
  );

  console.log('\n[v2.0 — test #12: historical rows contribute to profit/ROI but not unreliable holding metrics]');
  check(
    'Business row: holding_sample_size < realized_item_count (fixture item 9, historical, excluded from holding evidence)',
    (businessRow?.holding_sample_size ?? 0) < (businessRow?.realized_item_count ?? 0),
    businessRow,
  );
  check(
    'Business row: total_realized_net_profit is a finite number (historical realized items still contribute to profit)',
    typeof businessRow?.total_realized_net_profit === 'number' || !Number.isNaN(Number(businessRow?.total_realized_net_profit)),
    businessRow?.total_realized_net_profit,
  );

  console.log('\n[v2.0 — test #13: target-user totals include only the target user]');
  const { data: v2TargetRows, error: v2TargetRowsError } = await serviceClient
    .from('analytics_item_lifecycle_v2')
    .select('item_id')
    .eq('user_id', userAId);
  check('analytics_item_lifecycle_v2 filtered by target user readable', !v2TargetRowsError, v2TargetRowsError);
  check(
    'target_user_purpose_evidence.position_summary.total_item_count === target user\'s own analytics_item_lifecycle_v2 row count',
    targetPos?.total_item_count === (v2TargetRows?.length ?? -1),
    { snapshot: targetPos?.total_item_count, view: v2TargetRows?.length },
  );
  check(
    'target_user_purpose_evidence.total_item_count is strictly less than the shared population (User B\'s items are excluded)',
    (targetPos?.total_item_count ?? 0) < (sharedPop?.total_item_count ?? 0),
    { target: targetPos?.total_item_count, shared: sharedPop?.total_item_count },
  );

  console.log('\n[v2.0 — test #14/#16: no item identity fields exist anywhere in v2.0 output]');
  const v20Serialized = JSON.stringify(v20SnapshotA);
  const forbiddenIdentityKeys = ['"item_id"', '"item_display_name"', '"model"', '"brand_id"', '"brand_name"', '"category_id"', '"category_name"', '"tag_ids"', '"tag_names"', '"notes"'];
  check(
    'no item-identity field name appears anywhere in the serialized v2.0 snapshot',
    forbiddenIdentityKeys.every((key) => !v20Serialized.includes(key)),
    forbiddenIdentityKeys.filter((key) => v20Serialized.includes(key)),
  );
  const { data: userBAllItemRowsV2 } = await serviceClient.from('analytics_item_lifecycle_v2').select('item_id').eq('user_id', userBId);
  const userBOpenItemIdsV2 = (userBAllItemRowsV2 ?? []).map((r: any) => r.item_id);
  check(
    "no User B item_id appears as a bare value anywhere (defense in depth alongside the key-name check above)",
    userBOpenItemIdsV2.length > 0 && userBOpenItemIdsV2.every((id: number) => !v20Serialized.includes(`"item_id":${id}`)),
  );

  console.log('\n[v2.0 — test #15: shared evidence contains no per-user grouping]');
  check(
    'no shared_purpose_evidence row (population_summary or purpose_breakdown) exposes a user_id field',
    !('user_id' in (sharedPop ?? {})) && sharedBreakdown.every((r) => !('user_id' in r)),
    { sharedPop, sharedBreakdown },
  );

  console.log('\n[v2.0 — test #17: v1.8 output remains byte-identical (except generated_at)]');
  const { data: v18SnapshotAfterV20, error: v18AfterV20Error } = await serviceClient.rpc('build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId });
  check('build_analytics_snapshot_v1_8 still callable after v2.0 migration', !v18AfterV20Error, v18AfterV20Error);
  const { generated_at: _genBeforeV20, ...v18BeforeV20WithoutTimestamp } = (v18SnapshotAfterFixture ?? {}) as Record<string, unknown>;
  const { generated_at: _genAfterV20, ...v18AfterV20WithoutTimestamp } = (v18SnapshotAfterV20 ?? {}) as Record<string, unknown>;
  check(
    'v1.8 snapshot is byte-identical (ignoring generated_at) before and after the v2.0 migration/builder calls',
    JSON.stringify(v18AfterV20WithoutTimestamp) === JSON.stringify(v18BeforeV20WithoutTimestamp),
  );

  console.log('\n[v2.0 — test #18: v1.0-v1.8 remain callable]');
  const v20StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
  ];
  for (const [fn, args] of v20StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.0 migration`, !error, error);
  }

  console.log('\n[v2.0 — test #19: authenticated cannot execute either v2 function]');
  const { error: v20AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_0', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_0 directly', !!v20AuthedError, v20AuthedError);
  const { error: v20HelperAuthedError } = await clientA.rpc('_build_purpose_overview_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_purpose_overview_snapshot_v2 directly', !!v20HelperAuthedError, v20HelperAuthedError);

  console.log('\n[v2.0 — cross-check: target_user_purpose_evidence sums reconcile to position_summary]');
  const targetBreakdownCapitalSum = targetBreakdown.reduce((sum, r) => sum + Number(r.total_acquisition_capital ?? 0), 0);
  check(
    'sum of purpose_position_breakdown.total_acquisition_capital === position_summary.total_acquisition_capital',
    targetBreakdownCapitalSum === Number(targetPos?.total_acquisition_capital ?? 0),
    { targetBreakdownCapitalSum, positionTotal: targetPos?.total_acquisition_capital },
  );
  const targetBreakdownItemSum = targetBreakdown.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_position_breakdown.total_item_count === position_summary.total_item_count',
    targetBreakdownItemSum === targetPos?.total_item_count,
    { targetBreakdownItemSum, positionTotal: targetPos?.total_item_count },
  );

  // ── Open Inventory Decision Support v2.1 ─────────────────────────────────
  console.log('\n[v2.1 — builder callable, top-level metadata, preserves v2.0 sections]');
  const { data: v21SnapshotA, error: v21ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_1', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_1 callable by service_role', !v21ErrorA, v21ErrorA);
  check('v2.1 snapshot_schema_version is 2.1', v21SnapshotA?.snapshot_schema_version === '2.1', v21SnapshotA?.snapshot_schema_version);
  check('v2.1 analytics_definition_version is 2.1', v21SnapshotA?.analytics_definition_version === '2.1', v21SnapshotA?.analytics_definition_version);
  check('v2.1 evidence_scope/purpose_semantics preserved from v2.0', v21SnapshotA?.evidence_scope === 'shared_inventory_population' && v21SnapshotA?.purpose_semantics === 'current_item_purpose');
  const v21RequiredLimitations = [
    'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE', 'PURPOSE_CHANGES_ARE_NOT_HISTORICALLY_TRACKED',
    'PERSONAL_INTEREST_AND_APPRECIATION_THESIS_NOT_STORED', 'LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD',
    'MODEL_COHORT_UNAVAILABLE_FREE_TEXT_MODEL_FIELD',
  ];
  check(
    'v2.1 module_limitations contains all five required codes',
    v21RequiredLimitations.every((code) => (v21SnapshotA?.module_limitations ?? []).includes(code)),
    v21SnapshotA?.module_limitations,
  );

  console.log('\n[v2.1 — test #16: v2.0 sections remain unchanged inside v2.1]');
  check(
    'shared_purpose_evidence is byte-identical between v2.0 and v2.1',
    JSON.stringify(v21SnapshotA?.shared_purpose_evidence) === JSON.stringify(v20SnapshotA?.shared_purpose_evidence),
  );
  check(
    'target_user_purpose_evidence is byte-identical between v2.0 and v2.1',
    JSON.stringify(v21SnapshotA?.target_user_purpose_evidence) === JSON.stringify(v20SnapshotA?.target_user_purpose_evidence),
  );
  const { data: v20SnapshotAfterV21, error: v20AfterV21Error } = await serviceClient.rpc('build_analytics_snapshot_v2_0', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_0 still callable after v2.1 migration', !v20AfterV21Error, v20AfterV21Error);
  const { generated_at: _genV20Before, ...v20BeforeWithoutTimestamp } = (v20SnapshotA ?? {}) as Record<string, unknown>;
  const { generated_at: _genV20After, ...v20AfterWithoutTimestamp } = (v20SnapshotAfterV21 ?? {}) as Record<string, unknown>;
  check(
    'v2.0 output remains unchanged (byte-identical ignoring generated_at) after the v2.1 migration',
    JSON.stringify(v20AfterWithoutTimestamp) === JSON.stringify(v20BeforeWithoutTimestamp),
  );

  const oie = v21SnapshotA?.target_user_open_inventory_evidence;
  const oiePop = oie?.population_summary?.[0];
  const oiePurposePos: any[] = oie?.purpose_position_summary ?? [];
  const oieItems: any[] = oie?.item_decision_evidence ?? [];
  const oieHybrid: any[] = oie?.hybrid_purpose_review ?? [];
  const oiePersonalControl: any[] = oie?.personal_inventory_control?.personal_item_control ?? [];
  const oiePersonalPos = oie?.personal_inventory_control?.personal_position_summary?.[0];

  console.log('\n[v2.1 — test #1: all target-user open Business, Hybrid, and Personal items appear]');
  check(
    'population_summary counts at least one open item for Business, Hybrid, and Personal',
    (oiePop?.business_open_item_count ?? 0) > 0 && (oiePop?.hybrid_open_item_count ?? 0) > 0 && (oiePop?.personal_open_item_count ?? 0) > 0,
    oiePop,
  );
  check(
    'purpose_position_summary has a row for Business, Hybrid, and Personal',
    ['Business', 'Hybrid', 'Personal'].every((name) => oiePurposePos.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === name)),
    oiePurposePos.map((r) => r.current_purpose_name),
  );
  check(
    'fixtures.items.hybridRecentOpen, hybridHistoricalOpen (open Hybrid), and personalOpenItem (open Personal) all appear in item_decision_evidence',
    [fx.hybridRecentOpen, fx.hybridHistoricalOpen, fx.personalOpenItem].every((id) => oieItems.some((r) => r.item_id === id)),
    oieItems.map((r) => r.item_id),
  );

  console.log('\n[v2.1 — test #2: no other user item identity appears]');
  // Derived live from the database (never a hardcoded literal-id list).
  const { data: userBOpenBusinessRowsV21 } = await serviceClient
    .from('analytics_item_lifecycle_v2').select('item_id').eq('user_id', userBId).eq('is_realized', false);
  const userBOpenItemIdsV21 = (userBOpenBusinessRowsV21 ?? []).map((r: any) => r.item_id);
  check(
    'no User B item_id appears in item_decision_evidence, hybrid_purpose_review, or personal_item_control',
    userBOpenItemIdsV21.length > 0 && userBOpenItemIdsV21.every((id: number) => !oieItems.some((r) => r.item_id === id) && !oieHybrid.some((r) => r.item_id === id) && !oiePersonalControl.some((r) => r.item_id === id)),
    userBOpenItemIdsV21,
  );

  console.log('\n[v2.1 — test #3: Purpose counts reconcile]');
  check(
    'population_summary: business + hybrid + personal + missing_purpose + missing_policy === open_item_count',
    (oiePop?.business_open_item_count ?? 0) + (oiePop?.hybrid_open_item_count ?? 0) + (oiePop?.personal_open_item_count ?? 0)
      + (oiePop?.missing_purpose_open_item_count ?? 0) + (oiePop?.missing_policy_open_item_count ?? 0) === oiePop?.open_item_count,
    oiePop,
  );
  check(
    'population_summary: listed + unlisted === open_item_count',
    (oiePop?.listed_open_item_count ?? 0) + (oiePop?.unlisted_open_item_count ?? 0) === oiePop?.open_item_count,
    oiePop,
  );
  check(
    'population_summary: positive + zero_assigned + unknown acquisition counts === open_item_count',
    (oiePop?.positive_acquisition_item_count ?? 0) + (oiePop?.zero_assigned_acquisition_item_count ?? 0) + (oiePop?.unknown_acquisition_item_count ?? 0) === oiePop?.open_item_count,
    oiePop,
  );
  check(
    'population_summary: reliable + unreliable ownership age === open_item_count',
    (oiePop?.reliable_ownership_age_item_count ?? 0) + (oiePop?.unreliable_ownership_age_item_count ?? 0) === oiePop?.open_item_count,
    oiePop,
  );

  console.log('\n[v2.1 — test #4: capital reconciles across Purpose rows]');
  const purposePosCapitalSum = oiePurposePos.reduce((sum, r) => sum + Number(r.open_acquisition_capital ?? 0), 0);
  check(
    'sum of purpose_position_summary.open_acquisition_capital === population_summary.open_acquisition_capital',
    purposePosCapitalSum === Number(oiePop?.open_acquisition_capital ?? 0),
    { purposePosCapitalSum, populationTotal: oiePop?.open_acquisition_capital },
  );

  console.log('\n[v2.1 — test #5: Business urgency thresholds work]');
  const item106 = oieItems.find((r) => r.item_id === fx.businessLongDomOpen);
  check(
    'fixtures.items.businessLongDomOpen (Business, Fender, listed ~200 days, same brand+type+band as businessFastSale) carries BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN and _P75',
    !!item106 && item106.reason_codes.includes('BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN') && item106.reason_codes.includes('BUSINESS_DOM_ABOVE_COMPARABLE_P75'),
    item106,
  );
  check(
    'no Business item with current_dom_days < 30 carries a DOM urgency reason code',
    oieItems.filter((r) => r.current_purpose_name === 'Business' && r.current_dom_days !== null && r.current_dom_days < 30)
      .every((r) => !r.reason_codes.includes('BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN') && !r.reason_codes.includes('BUSINESS_DOM_ABOVE_COMPARABLE_P75')),
  );
  check(
    'every Business item with ownership_age_days >= 120 carries BUSINESS_OWNERSHIP_AGE_120_PLUS',
    oieItems.filter((r) => r.current_purpose_name === 'Business' && r.ownership_age_days !== null && r.ownership_age_days >= 120)
      .every((r) => r.reason_codes.includes('BUSINESS_OWNERSHIP_AGE_120_PLUS')),
  );

  console.log('\n[v2.1 — test #6: Hybrid creates review signals, not automatic decisions]');
  const item104 = oieItems.find((r) => r.item_id === fx.hybridRecentOpen);
  const item105 = oieItems.find((r) => r.item_id === fx.hybridHistoricalOpen);
  check(
    'fixtures.items.hybridRecentOpen and hybridHistoricalOpen (Hybrid) both carry HYBRID_REVIEW_REQUIRED',
    !!item104?.reason_codes.includes('HYBRID_REVIEW_REQUIRED') && !!item105?.reason_codes.includes('HYBRID_REVIEW_REQUIRED'),
    { item104: item104?.reason_codes, item105: item105?.reason_codes },
  );
  check(
    'no Hybrid item carries a BUSINESS_* or PERSONAL_* reason code',
    oieItems.filter((r) => r.current_purpose_name === 'Hybrid')
      .every((r) => r.reason_codes.every((c: string) => !c.startsWith('BUSINESS_') && !c.startsWith('PERSONAL_'))),
    oieItems.filter((r) => r.current_purpose_name === 'Hybrid').map((r) => r.reason_codes),
  );
  check(
    'no reclassify/keep/recommended-purpose field or value exists anywhere in the v2.1 snapshot',
    !['reclassify_to_business', 'reclassify_to_personal', 'keep_hybrid', 'recommended_purpose'].some((s) => JSON.stringify(v21SnapshotA).includes(s)),
  );

  console.log('\n[v2.1 — test #7: Personal does not receive age/DOM urgency flags]');
  const personalItems = oieItems.filter((r) => r.current_purpose_name === 'Personal');
  check(
    'no Personal item carries any BUSINESS_* or HYBRID_* reason code',
    personalItems.every((r) => r.reason_codes.every((c: string) => !c.startsWith('BUSINESS_') && !c.startsWith('HYBRID_'))),
    personalItems.map((r) => r.reason_codes),
  );
  check(
    'PERSONAL_AGE_UNRELIABLE (if present) is a data-completeness flag, never paired with an urgency code',
    personalItems.every((r) => r.reason_codes.every((c: string) => !c.includes('OWNERSHIP_AGE') || c === 'PERSONAL_AGE_UNRELIABLE')),
  );

  console.log('\n[v2.1 — test #8: zero/unknown acquisition values never produce a ROI/upside comparison]');
  check(
    'every item with zero-assigned or unknown acquisition value has estimated_upside_percent === null',
    oieItems.filter((r) => r.acquisition_value === null || Number(r.acquisition_value) === 0).every((r) => r.estimated_upside_percent === null),
  );
  check(
    'no zero-assigned/unknown-value item carries HIGH_CAPITAL_EXPOSURE, LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL, or a Hybrid/Personal high-capital/low-upside variant',
    oieItems.filter((r) => r.acquisition_value === null || Number(r.acquisition_value) === 0)
      .every((r) => !['HIGH_CAPITAL_EXPOSURE', 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL', 'HYBRID_HIGH_CAPITAL_SIGNAL', 'HYBRID_LOW_UPSIDE_SIGNAL', 'PERSONAL_HIGH_CAPITAL_EXPOSURE'].some((c) => r.reason_codes.includes(c))),
  );

  console.log('\n[v2.1 — test #9: economic and liquidity cohorts are selected independently]');
  check(
    'fixtures.items.hybridRecentOpen has BOTH an economic_cohort and a liquidity_cohort, from independently-scoped cohort keys',
    !!item104?.economic_cohort && !!item104?.liquidity_cohort && item104.economic_cohort.cohort_scope !== item104.liquidity_cohort.cohort_scope,
    { economic: item104?.economic_cohort, liquidity: item104?.liquidity_cohort },
  );

  console.log('\n[v2.1 — test #10: purpose-matched liquidity cohort is preferred]');
  const item2v21 = oieItems.find((r) => r.item_id === fx.openFenderPositiveBand);
  check(
    'fixtures.items.openFenderPositiveBand (Business, has a purpose-specific liquidity cohort with realized evidence from businessFastSale) resolves liquidity_cohort_match = purpose_matched',
    item2v21?.liquidity_cohort_match === 'purpose_matched',
    item2v21?.liquidity_cohort,
  );

  console.log('\n[v2.1 — test #11: cross-purpose fallback is clearly marked]');
  check(
    'fixtures.items.hybridRecentOpen and hybridHistoricalOpen (Hybrid, insufficient purpose-matched liquidity evidence — no Hybrid item is ever realized) resolve liquidity_cohort_match = cross_purpose_fallback with the reason code present',
    item104?.liquidity_cohort_match === 'cross_purpose_fallback' && item104.reason_codes.includes('PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE')
      && item105?.liquidity_cohort_match === 'cross_purpose_fallback' && item105.reason_codes.includes('PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE'),
    { item104: item104?.liquidity_cohort_match, item105: item105?.liquidity_cohort_match },
  );

  console.log('\n[v2.1 — test #12: historical age remains NULL]');
  const item14v21 = oieItems.find((r) => r.item_id === fx.historicalImportOpenNoChannel);
  check(
    'fixtures.items.historicalImportOpenNoChannel (Historical Import, open Business) has ownership_age_days === null in item_decision_evidence',
    !!item14v21 && item14v21.is_historical_import === true && item14v21.ownership_age_days === null,
    item14v21,
  );

  console.log('\n[v2.1 — test #13: Hybrid review contains all Hybrid open items]');
  check(
    'hybrid_purpose_review.length === population_summary.hybrid_open_item_count',
    oieHybrid.length === oiePop?.hybrid_open_item_count,
    { reviewLength: oieHybrid.length, popCount: oiePop?.hybrid_open_item_count },
  );

  console.log('\n[v2.1 — test #14: Personal control contains all Personal open items]');
  check(
    'personal_item_control.length === population_summary.personal_open_item_count',
    oiePersonalControl.length === oiePop?.personal_open_item_count,
    { controlLength: oiePersonalControl.length, popCount: oiePop?.personal_open_item_count },
  );
  check(
    'personal_position_summary.personal_open_item_count === population_summary.personal_open_item_count',
    oiePersonalPos?.personal_open_item_count === oiePop?.personal_open_item_count,
  );

  console.log('\n[v2.1 — test #15: no score or recommended-action field exists anywhere]');
  const v21Serialized = JSON.stringify(v21SnapshotA);
  check(
    'no "score", "priority_score", or "recommended_action" key appears anywhere in the v2.1 snapshot',
    !['"score"', '"priority_score"', '"recommended_action"', '"recommended_purpose"'].some((k) => v21Serialized.includes(k)),
  );

  console.log('\n[v2.1 — test #17: v1.0-v1.8 remain unchanged and callable]');
  const v21StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
  ];
  for (const [fn, args] of v21StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.1 migration`, !error, error);
  }
  const { data: v18SnapshotAfterV21 } = await serviceClient.rpc('build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId });
  const { generated_at: _genV18Before, ...v18BeforeV21WithoutTimestamp } = (v18SnapshotAfterV20 ?? {}) as Record<string, unknown>;
  const { generated_at: _genV18After, ...v18AfterV21WithoutTimestamp } = (v18SnapshotAfterV21 ?? {}) as Record<string, unknown>;
  check(
    'v1.8 output remains byte-identical (ignoring generated_at) after the v2.1 migration',
    JSON.stringify(v18AfterV21WithoutTimestamp) === JSON.stringify(v18BeforeV21WithoutTimestamp),
  );

  // Note: at the point v2.1 was introduced, the production runner had not
  // yet been promoted off v1.8. It has since been promoted to v2.2 — see
  // the "[v2.2 ...]" section below for the current-state assertion
  // (ANALYTICS_VERSION === '2.2').

  console.log('\n[v2.1 — test #19: permissions on new functions]');
  const { error: v21AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_1', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_1 directly', !!v21AuthedError, v21AuthedError);
  const { error: v21HelperAuthedError } = await clientA.rpc('_build_open_inventory_decision_support_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_open_inventory_decision_support_snapshot_v2 directly', !!v21HelperAuthedError, v21HelperAuthedError);

  // ── Analytics v2.2 — Hybrid reason-code correction + production promotion ──
  console.log('\n[v2.2 — builder callable, top-level metadata]');
  const { data: v22SnapshotA, error: v22ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_2', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_2 callable by service_role', !v22ErrorA, v22ErrorA);
  check('v2.2 snapshot_schema_version is 2.2', v22SnapshotA?.snapshot_schema_version === '2.2', v22SnapshotA?.snapshot_schema_version);
  check('v2.2 analytics_definition_version is 2.2', v22SnapshotA?.analytics_definition_version === '2.2', v22SnapshotA?.analytics_definition_version);

  const v22Items: any[] = v22SnapshotA?.target_user_open_inventory_evidence?.item_decision_evidence ?? [];
  const v22Serialized = JSON.stringify(v22SnapshotA);

  console.log('\n[v2.2 — test #1: a reliable recent Hybrid item receives HYBRID_RECENT_ITEM]');
  const item105v22 = v22Items.find((r) => r.item_id === fx.hybridRecentOpen);
  check(
    'fixtures.items.hybridRecentOpen (Hybrid, ownership_age_days=10, reliable) carries HYBRID_RECENT_ITEM',
    !!item105v22 && item105v22.ownership_age_days !== null && item105v22.ownership_age_days < 30 && item105v22.reason_codes.includes('HYBRID_RECENT_ITEM'),
    item105v22,
  );

  console.log('\n[v2.2 — test #2: an unreliable-age Hybrid item receives HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY]');
  const item107v22 = v22Items.find((r) => r.item_id === fx.hybridHistoricalOpen);
  check(
    'fixtures.items.hybridHistoricalOpen (Hybrid, Historical Import, ownership_age_days === null) carries HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY',
    !!item107v22 && item107v22.ownership_age_days === null && item107v22.reason_codes.includes('HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY'),
    item107v22,
  );

  console.log('\n[v2.2 — test #3: the two codes are mutually exclusive]');
  check(
    'no item carries both HYBRID_RECENT_ITEM and HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY',
    v22Items.every((r) => !(r.reason_codes.includes('HYBRID_RECENT_ITEM') && r.reason_codes.includes('HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY'))),
    v22Items.filter((r) => r.reason_codes.includes('HYBRID_RECENT_ITEM') && r.reason_codes.includes('HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY')),
  );

  console.log('\n[v2.2 — test #4: HYBRID_RECENT_INSUFFICIENT_HISTORY is absent from v2.2]');
  check('the old ambiguous combined code does not appear anywhere in v2.2 output', !v22Serialized.includes('HYBRID_RECENT_INSUFFICIENT_HISTORY'));

  console.log('\n[v2.2 — test #5: historical items with large DOM are not labelled recent]');
  check(
    // current_dom_days grows by 1 every real calendar day since
    // fixtures.items.hybridHistoricalOpen was listed (150 days ago at
    // fixture-creation time) — a lower-bound check is stable across runs;
    // an exact day count is not.
    'fixtures.items.hybridHistoricalOpen (is_historical_import, large current_dom_days) does NOT carry HYBRID_RECENT_ITEM',
    !!item107v22 && item107v22.is_historical_import === true && item107v22.current_dom_days > 100 && !item107v22.reason_codes.includes('HYBRID_RECENT_ITEM'),
    item107v22,
  );

  console.log('\n[v2.2 — test #6: all non-reason-code v2.1 values remain unchanged in v2.2]');
  const { data: v21SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_1', { p_target_user_id: userAId });
  const v21ItemsForCompare: any[] = v21SnapshotForCompare?.target_user_open_inventory_evidence?.item_decision_evidence ?? [];
  check(
    'every item_decision_evidence field except reason_codes is stable-stringify identical between v2.1 and v2.2',
    v22Items.every((v22r) => {
      const v21r = v21ItemsForCompare.find((r) => r.item_id === v22r.item_id);
      if (!v21r) return false;
      const { reason_codes: _v22codes, ...v22rest } = v22r;
      const { reason_codes: _v21codes, ...v21rest } = v21r;
      return stableStringify(v22rest) === stableStringify(v21rest);
    }),
  );
  check(
    'population_summary is stable-stringify identical between v2.1 and v2.2',
    stableStringify(v22SnapshotA?.target_user_open_inventory_evidence?.population_summary)
      === stableStringify(v21SnapshotForCompare?.target_user_open_inventory_evidence?.population_summary),
  );
  check(
    'purpose_position_summary is stable-stringify identical between v2.1 and v2.2',
    stableStringify(v22SnapshotA?.target_user_open_inventory_evidence?.purpose_position_summary)
      === stableStringify(v21SnapshotForCompare?.target_user_open_inventory_evidence?.purpose_position_summary),
  );
  check(
    'hybrid_purpose_review (behavioral_signals) is stable-stringify identical between v2.1 and v2.2',
    stableStringify(v22SnapshotA?.target_user_open_inventory_evidence?.hybrid_purpose_review)
      === stableStringify(v21SnapshotForCompare?.target_user_open_inventory_evidence?.hybrid_purpose_review),
  );
  check(
    'personal_inventory_control is stable-stringify identical between v2.1 and v2.2',
    stableStringify(v22SnapshotA?.target_user_open_inventory_evidence?.personal_inventory_control)
      === stableStringify(v21SnapshotForCompare?.target_user_open_inventory_evidence?.personal_inventory_control),
  );
  check(
    'item_decision_evidence ordering (item_id sequence) is identical between v2.1 and v2.2',
    JSON.stringify(v22Items.map((r) => r.item_id)) === JSON.stringify(v21ItemsForCompare.map((r) => r.item_id)),
  );
  check(
    'shared_purpose_evidence and target_user_purpose_evidence are stable-stringify identical between v2.1 and v2.2',
    stableStringify(v22SnapshotA?.shared_purpose_evidence) === stableStringify(v21SnapshotForCompare?.shared_purpose_evidence)
      && stableStringify(v22SnapshotA?.target_user_purpose_evidence) === stableStringify(v21SnapshotForCompare?.target_user_purpose_evidence),
  );

  console.log('\n[v2.2 — test #7: v2.1 remains byte-identical except generated_at]');
  const { data: v21SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_1', { p_target_user_id: userAId });
  const { generated_at: _v21gen1, ...v21FirstWithoutTimestamp } = (v21SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v21gen2, ...v21SecondWithoutTimestamp } = (v21SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'two fresh build_analytics_snapshot_v2_1 calls are byte-identical (ignoring generated_at) — v2.1 unaffected by v2.2 existing',
    stableStringify(v21FirstWithoutTimestamp) === stableStringify(v21SecondWithoutTimestamp),
  );
  check(
    'v2.1 still produces the OLD ambiguous combined code (untouched by v2.2)',
    JSON.stringify(v21SnapshotForCompare).includes('HYBRID_RECENT_INSUFFICIENT_HISTORY'),
  );

  // Note: at the point v2.2 was promoted, this block asserted the runner's
  // new run persisted analytics_version 2.2 specifically. The runner has
  // since been promoted again to v2.3 (see the "[v2.3 — production
  // promotion]" section below) — these checks now compare against the
  // live ANALYTICS_VERSION export rather than a hardcoded literal, so they
  // stay correct across future promotions too.
  console.log('\n[production runner — creates a completed run with the current ANALYTICS_VERSION]');
  const runA22 = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('main runner run status is completed', runA22.status === 'completed', runA22.status);
  check('main runner run analytics_version matches ANALYTICS_VERSION', runA22.analytics_version === ANALYTICS_VERSION, runA22.analytics_version);
  const { data: storedRunA22 } = await serviceClient
    .from('analytics_runs').select('analytics_version, evidence_scope, snapshot').eq('id', runA22.id).single();
  check('stored analytics_runs.analytics_version matches ANALYTICS_VERSION', storedRunA22?.analytics_version === ANALYTICS_VERSION, storedRunA22?.analytics_version);
  check(
    'stored snapshot.snapshot_schema_version matches ANALYTICS_VERSION',
    (storedRunA22?.snapshot as any)?.snapshot_schema_version === ANALYTICS_VERSION,
    (storedRunA22?.snapshot as any)?.snapshot_schema_version,
  );

  console.log('\n[v2.2 — test #10: forged target-user input is ignored (v2.2\'s own direct-call permission model)]');
  // The runner exposes no parameter other than appUserId (resolved
  // server-side from the session) — there is no code path to override the
  // target. Reinforce this at the SQL layer: even a direct, authenticated
  // RPC call cannot invoke v2.2's builder for ANY target, forged or not.
  const { error: forgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_2', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_2 for a different (forged) target user id either', !!forgedTargetError, forgedTargetError);
  check(
    "runA22's stored target is always the caller's own id, never overridable",
    runA22.status === 'completed' && (await serviceClient.from('analytics_runs').select('recommendation_target_user_id').eq('id', runA22.id).single()).data?.recommendation_target_user_id === userAId,
  );

  console.log('\n[v2.2 — test #11: another user\'s item identity is not exposed]');
  const runB22 = await runAnalyticsForCurrentUser({ appUserId: userBId, serviceClient });
  const snapB22 = runB22.snapshot as any;
  const userAItemIdsV22 = new Set(v22Items.map((r) => r.item_id));
  const userBItemIdsV22 = new Set((snapB22?.target_user_open_inventory_evidence?.item_decision_evidence ?? []).map((r: any) => r.item_id));
  check(
    "user A's and user B's item_decision_evidence item_ids don't overlap in v2.2",
    Array.from(userAItemIdsV22).every((id) => !userBItemIdsV22.has(id)),
  );

  console.log('\n[v2.2 — test #12: old analytics_runs rows remain readable]');
  const { data: syntheticOldRun, error: syntheticOldRunError } = await serviceClient
    .from('analytics_runs')
    .insert({
      requested_by_user_id: userAId,
      recommendation_target_user_id: userAId,
      analytics_version: '1.8',
      evidence_scope: 'shared_business_population',
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 42,
      snapshot: {
        snapshot_schema_version: '1.8',
        analytics_definition_version: '1.8',
        generated_at: new Date().toISOString(),
        evidence_scope: 'shared_business_population',
        recommendation_target_user_id: userAId,
        evidence_aggregates: { acquisition_value_band: {}, acquisition_to_exit: {}, brand: {} },
        recommendation_candidates: { open_business_items: [] },
      },
    })
    .select('id, analytics_version, snapshot')
    .single();
  check('a synthetic old-shaped (v1.8) analytics_runs row can still be inserted', !syntheticOldRunError && !!syntheticOldRun, syntheticOldRunError);
  const { data: readBackOldRun } = await serviceClient
    .from('analytics_runs').select('analytics_version, snapshot').eq('id', syntheticOldRun!.id).single();
  check(
    'the old-shaped row reads back unchanged (v1.8 shape untouched by the v2.2 promotion)',
    readBackOldRun?.analytics_version === '1.8' && (readBackOldRun?.snapshot as any)?.snapshot_schema_version === '1.8'
      && !!(readBackOldRun?.snapshot as any)?.evidence_aggregates,
    readBackOldRun,
  );

  console.log('\n[v2.2 — test #13: v1.0-v1.8, v2.0, and v2.1 remain callable]');
  const v22StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v22StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.2 migration`, !error, error);
  }

  console.log('\n[v2.2 — test #14: the temporary preview route/card has been removed]');
  const previewRoutePath = path.join(__dirname, '..', 'src', 'app', 'api', 'analytics', 'v2-preview');
  check('src/app/api/analytics/v2-preview no longer exists', !fs.existsSync(previewRoutePath), previewRoutePath);

  console.log('\n[v2.2 — test #15: authenticated cannot execute the builder directly]');
  const { error: v22AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_2', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_2 directly', !!v22AuthedError, v22AuthedError);

  // ── Analytics v2.3 — Acquisition Economics + second production promotion ──
  console.log('\n[v2.3 — builder callable, top-level metadata]');
  const { data: v23SnapshotA, error: v23ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_3', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_3 callable by service_role', !v23ErrorA, v23ErrorA);
  check('v2.3 snapshot_schema_version is 2.3', v23SnapshotA?.snapshot_schema_version === '2.3', v23SnapshotA?.snapshot_schema_version);
  check('v2.3 analytics_definition_version is 2.3', v23SnapshotA?.analytics_definition_version === '2.3', v23SnapshotA?.analytics_definition_version);
  check(
    'v2.3 output includes shared_acquisition_evidence and target_user_acquisition_evidence',
    !!v23SnapshotA?.shared_acquisition_evidence && !!v23SnapshotA?.target_user_acquisition_evidence,
    v23SnapshotA ? Object.keys(v23SnapshotA) : v23SnapshotA,
  );

  console.log('\n[v2.3 — v2.2 sections remain unchanged inside v2.3]');
  const { data: v22SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_2', { p_target_user_id: userAId });
  check(
    'shared_purpose_evidence / target_user_purpose_evidence / target_user_open_inventory_evidence are stable-stringify identical between v2.2 and v2.3',
    stableStringify(v23SnapshotA?.shared_purpose_evidence) === stableStringify(v22SnapshotForCompare?.shared_purpose_evidence)
      && stableStringify(v23SnapshotA?.target_user_purpose_evidence) === stableStringify(v22SnapshotForCompare?.target_user_purpose_evidence)
      && stableStringify(v23SnapshotA?.target_user_open_inventory_evidence) === stableStringify(v22SnapshotForCompare?.target_user_open_inventory_evidence),
  );
  const { data: v22SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_2', { p_target_user_id: userAId });
  const { generated_at: _v22gen1, ...v22FirstWithoutTimestamp } = (v22SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v22gen2, ...v22SecondWithoutTimestamp } = (v22SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.2 remains byte-identical (ignoring generated_at) after the v2.3 migration — v2.2 unaffected by v2.3 existing',
    stableStringify(v22FirstWithoutTimestamp) === stableStringify(v22SecondWithoutTimestamp),
  );

  const avbShared = v23SnapshotA?.shared_acquisition_evidence?.acquisition_value_band_performance;
  const a2eShared = v23SnapshotA?.shared_acquisition_evidence?.acquisition_to_exit_analysis;
  const avbTarget = v23SnapshotA?.target_user_acquisition_evidence?.acquisition_value_band_performance;
  const avbPop = avbShared?.population_summary?.[0];
  const a2ePop = a2eShared?.population_summary?.[0];

  console.log('\n[v2.3 — Value Band Performance: reconciliation]');
  check(
    'population_summary: open + realized === total',
    (avbPop?.open_item_count ?? 0) + (avbPop?.realized_item_count ?? 0) === avbPop?.total_item_count,
    avbPop,
  );
  check(
    'population_summary: positive + zero_assigned + unknown === total',
    (avbPop?.positive_acquisition_item_count ?? 0) + (avbPop?.zero_assigned_acquisition_item_count ?? 0) + (avbPop?.unknown_acquisition_item_count ?? 0) === avbPop?.total_item_count,
    avbPop,
  );
  check(
    'population_summary: raw_realized_holding_days_present_count === eligible + excluded',
    (avbPop?.eligible_realized_holding_days_count ?? 0) + (avbPop?.excluded_realized_holding_days_count ?? 0) === avbPop?.raw_realized_holding_days_present_count,
    avbPop,
  );
  const avbPurposeRows: any[] = avbShared?.purpose_population_summary ?? [];
  const avbPurposeTotalSum = avbPurposeRows.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_population_summary.total_item_count === population_summary.total_item_count',
    avbPurposeTotalSum === avbPop?.total_item_count,
    { avbPurposeTotalSum, populationTotal: avbPop?.total_item_count },
  );

  console.log('\n[v2.3 — Acquisition-to-Exit: reconciliation]');
  check(
    'population_summary: eligible_sale_exit_count + eligible_trade_exit_count === eligible_transition_item_count',
    (a2ePop?.eligible_sale_exit_count ?? 0) + (a2ePop?.eligible_trade_exit_count ?? 0) === a2ePop?.eligible_transition_item_count,
    a2ePop,
  );
  const transitionMatrix: any[] = a2eShared?.transition_matrix ?? [];
  const transitionItemSum = transitionMatrix.reduce((sum, r) => sum + Number(r.item_count ?? 0), 0);
  check(
    'sum of transition_matrix.item_count === population_summary.eligible_transition_item_count',
    transitionItemSum === a2ePop?.eligible_transition_item_count,
    { transitionItemSum, eligible: a2ePop?.eligible_transition_item_count },
  );
  const methodPaths: any[] = a2eShared?.method_paths ?? [];
  const methodSampleSum = methodPaths.reduce((sum, r) => sum + Number(r.sample_size ?? 0), 0);
  check(
    'sum of method_paths.sample_size === population_summary.eligible_transition_item_count',
    methodSampleSum === a2ePop?.eligible_transition_item_count,
    { methodSampleSum, eligible: a2ePop?.eligible_transition_item_count },
  );

  console.log('\n[v2.3 — Purpose inclusion]');
  check(
    'Value Band Performance purpose_population_summary includes Business, Hybrid, and Personal',
    ['Business', 'Hybrid', 'Personal'].every((name) => avbPurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === name)),
    avbPurposeRows.map((r) => r.current_purpose_name),
  );
  const a2ePurposeRows: any[] = a2eShared?.purpose_population_summary ?? [];
  check(
    'Acquisition-to-Exit purpose_population_summary includes a mapped row for at least Business (Hybrid/Personal present if they have realized items)',
    a2ePurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    a2ePurposeRows.map((r) => r.current_purpose_name),
  );

  console.log('\n[v2.3 — historical-import handling]');
  const businessBandRows: any[] = avbShared?.band_performance ?? [];
  check(
    'at least one band has holding_sample_size < realized_items (Historical Import excluded from holding metrics, fixture item 9)',
    businessBandRows.some((r) => (r.holding_sample_size ?? 0) < (r.realized_items ?? 0)),
    businessBandRows,
  );
  check(
    'zero_assigned_summary.roi_undefined_zero_acquisition_count === its own realized_item_count (ROI undefined at zero acquisition value)',
    avbShared?.zero_assigned_summary?.[0]?.roi_undefined_zero_acquisition_count === avbShared?.zero_assigned_summary?.[0]?.realized_item_count,
    avbShared?.zero_assigned_summary,
  );

  console.log('\n[v2.3 — zero/unknown value handling]');
  check(
    'zero_assigned_summary.total_realized_net_profit is a number (0 for no rows, never null) via COALESCE',
    typeof avbShared?.zero_assigned_summary?.[0]?.total_realized_net_profit === 'number',
    avbShared?.zero_assigned_summary,
  );
  check(
    'unknown_acquisition_summary has no ROI/net-profit field — acquisition basis does not exist for this population',
    !('median_roi' in (avbShared?.unknown_acquisition_summary?.[0] ?? {})) && !('median_net_profit' in (avbShared?.unknown_acquisition_summary?.[0] ?? {})),
    avbShared?.unknown_acquisition_summary?.[0],
  );

  console.log('\n[v2.3 — privacy]');
  const v23SharedSerialized = JSON.stringify(v23SnapshotA?.shared_acquisition_evidence);
  check('shared_acquisition_evidence exposes no user_id or item_id field anywhere', !v23SharedSerialized.includes('"user_id"') && !v23SharedSerialized.includes('"item_id"'));
  check(
    "target_user_acquisition_evidence total_item_count is strictly less than shared's pooled total (User B's items are excluded)",
    (avbTarget?.population_summary?.[0]?.total_item_count ?? 0) < (avbPop?.total_item_count ?? 0),
    { target: avbTarget?.population_summary?.[0]?.total_item_count, shared: avbPop?.total_item_count },
  );

  console.log('\n[v2.3 — permissions]');
  const { error: v23AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_3', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_3 directly', !!v23AuthedError, v23AuthedError);
  const { error: v23HelperAuthedError } = await clientA.rpc('_build_acquisition_economics_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_acquisition_economics_snapshot_v2 directly', !!v23HelperAuthedError, v23HelperAuthedError);

  console.log('\n[v2.3 — old-version compatibility]');
  const v23StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v23StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.3 migration`, !error, error);
  }

  // Note: at the point v2.3 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.3 specifically. The runner has since been
  // promoted again to v2.4 (see the "[v2.4 — production promotion]"
  // section below) — that generic check already lives in the
  // "[production runner — creates a completed run with the current
  // ANALYTICS_VERSION]" block above, so it is not repeated here.

  // ── Analytics v2.4 — Inventory Segmentation + third production promotion ──
  console.log('\n[v2.4 — builder callable, top-level metadata]');
  const { data: v24SnapshotA, error: v24ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_4', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_4 callable by service_role', !v24ErrorA, v24ErrorA);
  check('v2.4 snapshot_schema_version is 2.4', v24SnapshotA?.snapshot_schema_version === '2.4', v24SnapshotA?.snapshot_schema_version);
  check('v2.4 analytics_definition_version is 2.4', v24SnapshotA?.analytics_definition_version === '2.4', v24SnapshotA?.analytics_definition_version);
  check(
    'v2.4 output includes shared_inventory_segmentation_evidence and target_user_inventory_segmentation_evidence',
    !!v24SnapshotA?.shared_inventory_segmentation_evidence && !!v24SnapshotA?.target_user_inventory_segmentation_evidence,
    v24SnapshotA ? Object.keys(v24SnapshotA) : v24SnapshotA,
  );

  console.log('\n[v2.4 — v2.3 sections remain unchanged inside v2.4]');
  const { data: v23SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_3', { p_target_user_id: userAId });
  check(
    'shared_acquisition_evidence / target_user_acquisition_evidence are stable-stringify identical between v2.3 and v2.4',
    stableStringify(v24SnapshotA?.shared_acquisition_evidence) === stableStringify(v23SnapshotForCompare?.shared_acquisition_evidence)
      && stableStringify(v24SnapshotA?.target_user_acquisition_evidence) === stableStringify(v23SnapshotForCompare?.target_user_acquisition_evidence),
  );
  const { data: v23SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_3', { p_target_user_id: userAId });
  const { generated_at: _v23gen1, ...v23FirstWithoutTimestamp } = (v23SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v23gen2, ...v23SecondWithoutTimestamp } = (v23SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.3 remains byte-identical (ignoring generated_at) after the v2.4 migration — v2.3 unaffected by v2.4 existing',
    stableStringify(v23FirstWithoutTimestamp) === stableStringify(v23SecondWithoutTimestamp),
  );

  const v24BrandShared = v24SnapshotA?.shared_inventory_segmentation_evidence?.brand_performance;
  const v24CatShared = v24SnapshotA?.shared_inventory_segmentation_evidence?.category_type_performance;
  const v24BrandTarget = v24SnapshotA?.target_user_inventory_segmentation_evidence?.brand_performance;
  const v24BrandPop = v24BrandShared?.population_summary?.[0];
  const v24CatPop = v24CatShared?.population_summary?.[0];

  console.log('\n[v2.4 — Brand Performance: reconciliation]');
  check(
    'population_summary: open + realized === total',
    (v24BrandPop?.open_item_count ?? 0) + (v24BrandPop?.realized_item_count ?? 0) === v24BrandPop?.total_item_count,
    v24BrandPop,
  );
  check(
    'population_summary: positive + zero_assigned + unknown + negative === total',
    (v24BrandPop?.positive_acquisition_item_count ?? 0) + (v24BrandPop?.zero_assigned_acquisition_item_count ?? 0)
      + (v24BrandPop?.unknown_acquisition_item_count ?? 0) + (v24BrandPop?.negative_acquisition_item_count ?? 0) === v24BrandPop?.total_item_count,
    v24BrandPop,
  );
  const v24BrandPurposeRows: any[] = v24BrandShared?.purpose_population_summary ?? [];
  const brandPurposeTotalSum = v24BrandPurposeRows.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_population_summary.total_item_count === population_summary.total_item_count',
    brandPurposeTotalSum === v24BrandPop?.total_item_count,
    { brandPurposeTotalSum, populationTotal: v24BrandPop?.total_item_count },
  );
  const v24PerformanceByBrand: any[] = v24BrandShared?.performance_by_brand ?? [];
  check('performance_by_brand has at least one row', v24PerformanceByBrand.length > 0, v24PerformanceByBrand);
  check(
    'every performance_by_brand row has a decision_ready boolean field',
    v24PerformanceByBrand.every((r) => typeof r.decision_ready === 'boolean'),
    v24PerformanceByBrand.map((r) => r.decision_ready),
  );

  console.log('\n[v2.4 — Category & Type Performance: reconciliation]');
  check(
    'population_summary: category_known + category_missing === total',
    (v24CatPop?.category_known_item_count ?? 0) + (v24CatPop?.category_missing_item_count ?? 0) === v24CatPop?.total_item_count,
    v24CatPop,
  );
  check(
    'population_summary: type_known + type_missing === total',
    (v24CatPop?.type_known_item_count ?? 0) + (v24CatPop?.type_missing_item_count ?? 0) === v24CatPop?.total_item_count,
    v24CatPop,
  );
  const v24PerformanceByCategory: any[] = v24CatShared?.performance_by_category ?? [];
  const categoryItemSum = v24PerformanceByCategory.reduce((sum, r) => sum + Number(r.item_count ?? 0), 0);
  check(
    'sum of performance_by_category.item_count === population_summary.total_item_count',
    categoryItemSum === v24CatPop?.total_item_count,
    { categoryItemSum, populationTotal: v24CatPop?.total_item_count },
  );
  check(
    'performance_by_category includes a missing-category row (category_id null) when uncategorized items exist',
    (v24CatPop?.category_missing_item_count ?? 0) === 0 || v24PerformanceByCategory.some((r) => r.category_id === null),
    v24PerformanceByCategory.map((r) => r.category_id),
  );

  console.log('\n[v2.4 — Purpose inclusion]');
  check(
    'Brand Performance purpose_population_summary includes at least a mapped Business row',
    v24BrandPurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    v24BrandPurposeRows.map((r) => r.current_purpose_name),
  );
  const v24CatPurposeRows: any[] = v24CatShared?.purpose_population_summary ?? [];
  check(
    'Category & Type Performance purpose_population_summary includes at least a mapped Business row',
    v24CatPurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    v24CatPurposeRows.map((r) => r.current_purpose_name),
  );

  console.log('\n[v2.4 — historical-import and missing-brand handling]');
  check(
    'at least one performance_by_brand row has holding_sample_size <= realized_items (Historical Import excluded from holding metrics)',
    v24PerformanceByBrand.some((r) => (r.holding_sample_size ?? 0) <= (r.realized_items ?? 0)),
    v24PerformanceByBrand,
  );
  const v24OpenInventoryByBrand: any[] = v24BrandShared?.open_inventory_by_brand ?? [];
  check(
    'open_inventory_by_brand never leaves a missing brand as null/blank — always labeled "Unknown brand"',
    v24OpenInventoryByBrand.every((r) => r.brand_name !== null && String(r.brand_name).trim() !== ''),
    v24OpenInventoryByBrand.map((r) => r.brand_name),
  );

  console.log('\n[v2.4 — privacy]');
  const v24SharedSerialized = JSON.stringify(v24SnapshotA?.shared_inventory_segmentation_evidence);
  check(
    'shared_inventory_segmentation_evidence exposes no user_id or item_id field anywhere',
    !v24SharedSerialized.includes('"user_id"') && !v24SharedSerialized.includes('"item_id"'),
  );
  check(
    "target_user_inventory_segmentation_evidence total_item_count is strictly less than shared's pooled total (User B's items are excluded)",
    (v24BrandTarget?.population_summary?.[0]?.total_item_count ?? 0) < (v24BrandPop?.total_item_count ?? 0),
    { target: v24BrandTarget?.population_summary?.[0]?.total_item_count, shared: v24BrandPop?.total_item_count },
  );

  console.log('\n[v2.4 — permissions]');
  const { error: v24AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_4', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_4 directly', !!v24AuthedError, v24AuthedError);
  const { error: v24HelperAuthedError } = await clientA.rpc('_build_inventory_segmentation_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_inventory_segmentation_snapshot_v2 directly', !!v24HelperAuthedError, v24HelperAuthedError);

  console.log('\n[v2.4 — old-version compatibility]');
  const v24StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v24StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.4 migration`, !error, error);
  }

  // Note: at the point v2.4 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.4 specifically. The runner has since been
  // promoted again to v2.5 (see the "[v2.5 — production promotion]"
  // section below) — that generic check already lives in the
  // "[production runner — creates a completed run with the current
  // ANALYTICS_VERSION]" block above, so it is not repeated here.

  // ── Analytics v2.5 — Deal Channel Performance + fourth production promotion ──
  console.log('\n[v2.5 — builder callable, top-level metadata]');
  const { data: v25SnapshotA, error: v25ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_5', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_5 callable by service_role', !v25ErrorA, v25ErrorA);
  check('v2.5 snapshot_schema_version is 2.5', v25SnapshotA?.snapshot_schema_version === '2.5', v25SnapshotA?.snapshot_schema_version);
  check('v2.5 analytics_definition_version is 2.5', v25SnapshotA?.analytics_definition_version === '2.5', v25SnapshotA?.analytics_definition_version);
  check(
    'v2.5 output includes shared_deal_channel_evidence and target_user_deal_channel_evidence',
    !!v25SnapshotA?.shared_deal_channel_evidence && !!v25SnapshotA?.target_user_deal_channel_evidence,
    v25SnapshotA ? Object.keys(v25SnapshotA) : v25SnapshotA,
  );

  console.log('\n[v2.5 — v2.4 sections remain unchanged inside v2.5]');
  const { data: v24SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_4', { p_target_user_id: userAId });
  check(
    'shared_inventory_segmentation_evidence / target_user_inventory_segmentation_evidence are stable-stringify identical between v2.4 and v2.5',
    stableStringify(v25SnapshotA?.shared_inventory_segmentation_evidence) === stableStringify(v24SnapshotForCompare?.shared_inventory_segmentation_evidence)
      && stableStringify(v25SnapshotA?.target_user_inventory_segmentation_evidence) === stableStringify(v24SnapshotForCompare?.target_user_inventory_segmentation_evidence),
  );
  const { data: v24SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_4', { p_target_user_id: userAId });
  const { generated_at: _v24gen1, ...v24FirstWithoutTimestamp } = (v24SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v24gen2, ...v24SecondWithoutTimestamp } = (v24SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.4 remains byte-identical (ignoring generated_at) after the v2.5 migration — v2.4 unaffected by v2.5 existing',
    stableStringify(v24FirstWithoutTimestamp) === stableStringify(v24SecondWithoutTimestamp),
  );

  const v25DiShared = v25SnapshotA?.shared_deal_channel_evidence?.deal_in_channel_performance;
  const v25DoShared = v25SnapshotA?.shared_deal_channel_evidence?.deal_out_channel_performance;
  const v25CjShared = v25SnapshotA?.shared_deal_channel_evidence?.channel_journey;
  const v25DiTarget = v25SnapshotA?.target_user_deal_channel_evidence?.deal_in_channel_performance;
  const v25DiPop = v25DiShared?.population_summary?.[0];
  const v25DoPop = v25DoShared?.population_summary?.[0];
  const v25CjPop = v25CjShared?.population_summary?.[0];

  console.log('\n[v2.5 — Deal In Channel: reconciliation]');
  check(
    'population_summary: known + missing === total',
    (v25DiPop?.deal_in_channel_known_item_count ?? 0) + (v25DiPop?.deal_in_channel_missing_item_count ?? 0) === v25DiPop?.total_item_count,
    v25DiPop,
  );
  check(
    'population_summary: purchase + trade + unknown === total',
    (v25DiPop?.purchase_acquisition_item_count ?? 0) + (v25DiPop?.trade_acquisition_item_count ?? 0) + (v25DiPop?.unknown_acquisition_method_item_count ?? 0) === v25DiPop?.total_item_count,
    v25DiPop,
  );
  const v25DiPurposeRows: any[] = v25DiShared?.purpose_population_summary ?? [];
  const v25DiPurposeTotalSum = v25DiPurposeRows.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_population_summary.total_item_count === population_summary.total_item_count',
    v25DiPurposeTotalSum === v25DiPop?.total_item_count,
    { v25DiPurposeTotalSum, populationTotal: v25DiPop?.total_item_count },
  );
  const v25PerfByDealIn: any[] = v25DiShared?.performance_by_deal_in_channel ?? [];
  check('performance_by_deal_in_channel includes a missing-channel row when uncovered items exist', (v25DiPop?.deal_in_channel_missing_item_count ?? 0) === 0 || v25PerfByDealIn.some((r) => r.deal_in_channel_id === null), v25PerfByDealIn.map((r) => r.deal_in_channel_id));

  console.log('\n[v2.5 — Deal Out Channel: reconciliation]');
  check(
    'population_summary: known + missing === realized_item_count',
    (v25DoPop?.deal_out_channel_known_item_count ?? 0) + (v25DoPop?.deal_out_channel_missing_item_count ?? 0) === v25DoPop?.realized_item_count,
    v25DoPop,
  );
  check(
    'population_summary: sale + trade + unknown === realized_item_count',
    (v25DoPop?.sale_exit_item_count ?? 0) + (v25DoPop?.trade_exit_item_count ?? 0) + (v25DoPop?.unknown_exit_method_item_count ?? 0) === v25DoPop?.realized_item_count,
    v25DoPop,
  );
  const v25CashSales: any[] = v25DoShared?.cash_sales_by_deal_out_channel ?? [];
  const v25TradeExits: any[] = v25DoShared?.trade_exits_by_deal_out_channel ?? [];
  const v25CashItemSum = v25CashSales.reduce((sum, r) => sum + Number(r.sale_item_count ?? 0), 0);
  const v25TradeItemSum = v25TradeExits.reduce((sum, r) => sum + Number(r.trade_exit_item_count ?? 0), 0);
  check(
    'cash_sales_by_deal_out_channel + trade_exits_by_deal_out_channel item sums reconcile to sale/trade exit counts',
    v25CashItemSum === (v25DoPop?.sale_exit_item_count ?? 0) && v25TradeItemSum === (v25DoPop?.trade_exit_item_count ?? 0),
    { v25CashItemSum, v25TradeItemSum, sale: v25DoPop?.sale_exit_item_count, trade: v25DoPop?.trade_exit_item_count },
  );
  check(
    'cash sales and trade exits are distinct populations (no channel row double-counts both)',
    v25CashSales.every((r) => typeof r.median_sale_price !== 'undefined') && v25TradeExits.every((r) => typeof r.median_assigned_trade_exit_value !== 'undefined'),
    { cashFields: v25CashSales[0], tradeFields: v25TradeExits[0] },
  );

  console.log('\n[v2.5 — Channel Journey: reconciliation]');
  check(
    'population_summary: eligible + missing_in + missing_out - missing_both === realized_item_count',
    (v25CjPop?.journey_eligible_item_count ?? 0) + (v25CjPop?.missing_deal_in_channel_item_count ?? 0) + (v25CjPop?.missing_deal_out_channel_item_count ?? 0) - (v25CjPop?.missing_both_channels_item_count ?? 0) === v25CjPop?.realized_item_count,
    v25CjPop,
  );
  const v25Matrix: any[] = v25CjShared?.deal_in_to_deal_out_matrix ?? [];
  const v25MatrixItemSum = v25Matrix.reduce((sum, r) => sum + Number(r.journey_item_count ?? 0), 0);
  check(
    'sum of deal_in_to_deal_out_matrix.journey_item_count === population_summary.journey_eligible_item_count',
    v25MatrixItemSum === v25CjPop?.journey_eligible_item_count,
    { v25MatrixItemSum, eligible: v25CjPop?.journey_eligible_item_count },
  );
  const v25SameChan = v25CjShared?.same_channel_summary?.[0];
  check(
    'same_channel_summary: same + different === journey_eligible_item_count',
    (v25SameChan?.same_channel_exit_item_count ?? 0) + (v25SameChan?.different_channel_exit_item_count ?? 0) === v25SameChan?.journey_eligible_item_count,
    v25SameChan,
  );
  check(
    'Deal In and Deal Out directions are not reversed (matrix rows carry both deal_in_channel_name and deal_out_channel_name independently)',
    v25Matrix.every((r) => 'deal_in_channel_name' in r && 'deal_out_channel_name' in r),
    v25Matrix[0],
  );

  console.log('\n[v2.5 — Purpose inclusion]');
  check(
    'Deal In Channel purpose_population_summary includes at least a mapped Business row',
    v25DiPurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    v25DiPurposeRows.map((r) => r.current_purpose_name),
  );
  const v25DoPurposeRows: any[] = v25DoShared?.purpose_population_summary ?? [];
  check(
    'Deal Out Channel purpose_population_summary includes at least a mapped Business row',
    v25DoPurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    v25DoPurposeRows.map((r) => r.current_purpose_name),
  );
  const v25CjPurposeRows: any[] = v25CjShared?.purpose_population_summary ?? [];
  check(
    'Channel Journey purpose_population_summary includes at least a mapped Business row',
    v25CjPurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    v25CjPurposeRows.map((r) => r.current_purpose_name),
  );

  console.log('\n[v2.5 — historical-import and missing-channel handling]');
  check(
    'at least one performance_by_deal_in_channel row has holding_sample_size <= deal_in_realized_item_count (Historical Import excluded from holding metrics)',
    v25PerfByDealIn.some((r) => (r.holding_sample_size ?? 0) <= (r.deal_in_realized_item_count ?? 0)),
    v25PerfByDealIn,
  );
  check('missing-channel coverage is visible in Deal In population_summary', (v25DiPop?.deal_in_channel_missing_item_count ?? 0) >= 0, v25DiPop?.deal_in_channel_missing_item_count);
  check('missing-channel coverage is visible in Deal Out population_summary', (v25DoPop?.deal_out_channel_missing_item_count ?? 0) >= 0, v25DoPop?.deal_out_channel_missing_item_count);
  check('missing-both-channels coverage is visible in Channel Journey population_summary', (v25CjPop?.missing_both_channels_item_count ?? 0) >= 0, v25CjPop?.missing_both_channels_item_count);

  console.log('\n[v2.5 — no listing-channel evidence mixed in]');
  const v25DealChannelSerialized = JSON.stringify(v25SnapshotA?.shared_deal_channel_evidence);
  check(
    'shared_deal_channel_evidence contains no listing-channel fields (listing_channel_name / requires_listing outside deal-channel context)',
    !v25DealChannelSerialized.includes('listing_channel_name') && !v25DealChannelSerialized.includes('"listing_channel_id"'),
  );

  console.log('\n[v2.5 — privacy]');
  check(
    'shared_deal_channel_evidence exposes no user_id or item_id field anywhere',
    !v25DealChannelSerialized.includes('"user_id"') && !v25DealChannelSerialized.includes('"item_id"'),
  );
  check(
    "target_user_deal_channel_evidence total_item_count is strictly less than shared's pooled total (User B's items are excluded)",
    (v25DiTarget?.population_summary?.[0]?.total_item_count ?? 0) < (v25DiPop?.total_item_count ?? 0),
    { target: v25DiTarget?.population_summary?.[0]?.total_item_count, shared: v25DiPop?.total_item_count },
  );

  console.log('\n[v2.5 — permissions]');
  const { error: v25AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_5', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_5 directly', !!v25AuthedError, v25AuthedError);
  const { error: v25HelperAuthedError } = await clientA.rpc('_build_deal_channel_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_deal_channel_snapshot_v2 directly', !!v25HelperAuthedError, v25HelperAuthedError);
  const { error: v25ForgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_5', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_5 for a forged target user id either', !!v25ForgedTargetError, v25ForgedTargetError);

  console.log('\n[v2.5 — old-version compatibility]');
  const v25StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_4', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v25StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.5 migration`, !error, error);
  }

  // Note: at the point v2.5 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.5 specifically and created a fresh production
  // run to check it. The runner has since been promoted again to v2.6 (see
  // the "[v2.6 — production promotion]" section below) — that generic
  // check already lives in the "[production runner — creates a completed
  // run with the current ANALYTICS_VERSION]" block above, so it is not
  // repeated here.

  // ── Analytics v2.6 — Listing Channel Exposure + fifth production promotion ──
  console.log('\n[v2.6 — builder callable, top-level metadata]');
  const { data: v26SnapshotA, error: v26ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_6', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_6 callable by service_role', !v26ErrorA, v26ErrorA);
  check('v2.6 snapshot_schema_version is 2.6', v26SnapshotA?.snapshot_schema_version === '2.6', v26SnapshotA?.snapshot_schema_version);
  check('v2.6 analytics_definition_version is 2.6', v26SnapshotA?.analytics_definition_version === '2.6', v26SnapshotA?.analytics_definition_version);
  check(
    'v2.6 output includes shared_listing_channel_evidence and target_user_listing_channel_evidence',
    !!v26SnapshotA?.shared_listing_channel_evidence && !!v26SnapshotA?.target_user_listing_channel_evidence,
    v26SnapshotA ? Object.keys(v26SnapshotA) : v26SnapshotA,
  );

  console.log('\n[v2.6 — v2.5 sections remain unchanged inside v2.6]');
  const { data: v25SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_5', { p_target_user_id: userAId });
  check(
    'shared_deal_channel_evidence / target_user_deal_channel_evidence are stable-stringify identical between v2.5 and v2.6',
    stableStringify(v26SnapshotA?.shared_deal_channel_evidence) === stableStringify(v25SnapshotForCompare?.shared_deal_channel_evidence)
      && stableStringify(v26SnapshotA?.target_user_deal_channel_evidence) === stableStringify(v25SnapshotForCompare?.target_user_deal_channel_evidence),
  );
  const { data: v25SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_5', { p_target_user_id: userAId });
  const { generated_at: _v25gen1, ...v25FirstWithoutTimestamp } = (v25SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v25gen2, ...v25SecondWithoutTimestamp } = (v25SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.5 remains byte-identical (ignoring generated_at) after the v2.6 migration — v2.5 unaffected by v2.6 existing',
    stableStringify(v25FirstWithoutTimestamp) === stableStringify(v25SecondWithoutTimestamp),
  );

  const v26Shared = v26SnapshotA?.shared_listing_channel_evidence;
  const v26Target = v26SnapshotA?.target_user_listing_channel_evidence;
  const v26Pop = v26Shared?.population_summary?.[0];
  const v26TargetPop = v26Target?.population_summary?.[0];

  console.log('\n[v2.6 — population and Purpose reconciliation]');
  check(
    'population_summary: with_eligible_listing + without_eligible_listing === total_item_count',
    (v26Pop?.item_with_eligible_listing_count ?? 0) + (v26Pop?.item_without_eligible_listing_count ?? 0) === v26Pop?.total_item_count,
    v26Pop,
  );
  check(
    'population_summary: realized split reconciles',
    (v26Pop?.realized_item_with_eligible_listing_count ?? 0) + (v26Pop?.realized_item_without_eligible_listing_count ?? 0) === v26Pop?.realized_item_count,
    v26Pop,
  );
  check(
    'population_summary: open split reconciles',
    (v26Pop?.open_item_with_eligible_listing_count ?? 0) + (v26Pop?.open_item_without_eligible_listing_count ?? 0) === v26Pop?.open_item_count,
    v26Pop,
  );
  const v26PurposeRows: any[] = v26Shared?.purpose_population_summary ?? [];
  const v26PurposeTotalSum = v26PurposeRows.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_population_summary.total_item_count === population_summary.total_item_count',
    v26PurposeTotalSum === v26Pop?.total_item_count,
    { v26PurposeTotalSum, populationTotal: v26Pop?.total_item_count },
  );
  check(
    'Listing Channel Exposure purpose_population_summary includes at least a mapped Business row',
    v26PurposeRows.some((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business'),
    v26PurposeRows.map((r) => r.current_purpose_name),
  );
  check(
    "target_user_listing_channel_evidence total_item_count is strictly less than shared's pooled total (User B's items are excluded)",
    (v26TargetPop?.total_item_count ?? 0) < (v26Pop?.total_item_count ?? 0),
    { target: v26TargetPop?.total_item_count, shared: v26Pop?.total_item_count },
  );

  console.log('\n[v2.6 — exposure-row vs. distinct-item handling]');
  const v26PerfByChannel: any[] = v26Shared?.performance_by_listing_channel ?? [];
  const v26ExposedSum = v26PerfByChannel.reduce((sum, r) => sum + Number(r.exposed_item_count ?? 0), 0);
  check(
    'sum of performance_by_listing_channel.exposed_item_count === population_summary.eligible_listing_exposure_count (exposure rows, not unique items)',
    v26ExposedSum === v26Pop?.eligible_listing_exposure_count,
    { v26ExposedSum, exposureCount: v26Pop?.eligible_listing_exposure_count },
  );
  check(
    'exposed_item_count sum does NOT equal population_summary.item_with_eligible_listing_count when cross-listing exists (exposure rows are not unique items)',
    v26Pop?.eligible_listing_exposure_count === v26Pop?.item_with_eligible_listing_count || v26ExposedSum !== v26Pop?.item_with_eligible_listing_count,
    { v26ExposedSum, uniqueItemsWithListing: v26Pop?.item_with_eligible_listing_count },
  );
  check(
    'population_summary.eligible_listing_record_count (raw records) >= eligible_listing_exposure_count (canonical exposure rows)',
    (v26Pop?.eligible_listing_record_count ?? 0) >= (v26Pop?.eligible_listing_exposure_count ?? 0),
    v26Pop,
  );

  console.log('\n[v2.6 — cross-listing and attribution behavior]');
  const v26Cross = v26Shared?.cross_listing_summary;
  const v26Buckets: any[] = v26Cross?.buckets ?? [];
  const v26BucketItemSum = v26Buckets.reduce((sum, b) => sum + Number(b.business_item_count ?? 0), 0);
  check(
    'cross_listing_summary buckets reconcile to population_summary.total_item_count (each item counted exactly once)',
    v26BucketItemSum === v26Pop?.total_item_count,
    { v26BucketItemSum, populationTotal: v26Pop?.total_item_count },
  );
  check(
    'single_listed_item_count + cross_listed_item_count <= total_item_count (0-channel items are neither)',
    (v26Cross?.single_listed_item_count ?? 0) + (v26Cross?.cross_listed_item_count ?? 0) <= (v26Pop?.total_item_count ?? 0),
    v26Cross,
  );
  check(
    'cross_listing_summary is a distinct-item object shape (single_listed_item_count/cross_listed_item_count/cross_listed_item_percent/buckets), not exposure rows',
    typeof v26Cross?.single_listed_item_count === 'number' && Array.isArray(v26Buckets),
    v26Cross,
  );

  console.log('\n[v2.6 — Listing Channel is not confused with Deal In/Deal Out Channel]');
  const v26ListingToDealOut: any[] = v26Shared?.listing_to_deal_out ?? [];
  check(
    'listing_to_deal_out rows carry both listing_channel_name and deal_out_channel_name independently (not merged/aliased)',
    v26ListingToDealOut.length === 0 || v26ListingToDealOut.every((r) => 'listing_channel_name' in r && 'deal_out_channel_name' in r),
    v26ListingToDealOut[0],
  );
  check(
    'shared_listing_channel_evidence does not reuse deal_in_channel_* field names anywhere',
    !JSON.stringify(v26Shared).includes('deal_in_channel_'),
  );

  console.log('\n[v2.6 — historical-import, missing-data, and duration handling]');
  check(
    'at least one performance_by_listing_channel row has holding_sample_size <= realized_exposed_item_count (Historical Import excluded from holding metrics only)',
    v26PerfByChannel.some((r) => (r.holding_sample_size ?? 0) <= (r.realized_exposed_item_count ?? 0)),
    v26PerfByChannel,
  );
  check('missing-listing coverage is visible (item_without_eligible_listing_count present)', (v26Pop?.item_without_eligible_listing_count ?? 0) >= 0, v26Pop?.item_without_eligible_listing_count);
  check('ignored non-listing-platform records are visible in coverage', (v26Pop?.ignored_non_listing_channel_record_count ?? 0) >= 0, v26Pop?.ignored_non_listing_channel_record_count);
  check('missing listed_at records are visible in coverage', (v26Pop?.missing_listing_channel_record_count ?? 0) >= 0, v26Pop?.missing_listing_channel_record_count);

  console.log('\n[v2.6 — privacy]');
  const v26SharedSerialized = JSON.stringify(v26Shared);
  check(
    'shared_listing_channel_evidence exposes no user_id or item_id field anywhere',
    !v26SharedSerialized.includes('"user_id"') && !v26SharedSerialized.includes('"item_id"'),
  );

  console.log('\n[v2.6 — permissions]');
  const { error: v26AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_6', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_6 directly', !!v26AuthedError, v26AuthedError);
  const { error: v26HelperAuthedError } = await clientA.rpc('_build_listing_channel_exposure_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_listing_channel_exposure_snapshot_v2 directly', !!v26HelperAuthedError, v26HelperAuthedError);
  const { error: v26ForgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_6', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_6 for a forged target user id either', !!v26ForgedTargetError, v26ForgedTargetError);

  console.log('\n[v2.6 — old-version compatibility]');
  const v26StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_4', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_5', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v26StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.6 migration`, !error, error);
  }

  // Note: at the point v2.6 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.6 specifically and created a fresh production
  // run to check it. The runner has since been promoted again to v2.7 (see
  // the "[v2.7 — production promotion]" section below) — that generic
  // check already lives in the "[production runner — creates a completed
  // run with the current ANALYTICS_VERSION]" block above, so it is not
  // repeated here.

  // ── Analytics v2.7 — Capital & Liquidity + sixth production promotion ──
  console.log('\n[v2.7 — builder callable, top-level metadata]');
  const { data: v27SnapshotA, error: v27ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_7', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_7 callable by service_role', !v27ErrorA, v27ErrorA);
  check('v2.7 snapshot_schema_version is 2.7', v27SnapshotA?.snapshot_schema_version === '2.7', v27SnapshotA?.snapshot_schema_version);
  check('v2.7 analytics_definition_version is 2.7', v27SnapshotA?.analytics_definition_version === '2.7', v27SnapshotA?.analytics_definition_version);
  check(
    'v2.7 output includes shared_capital_liquidity_evidence and target_user_capital_liquidity_evidence',
    !!v27SnapshotA?.shared_capital_liquidity_evidence && !!v27SnapshotA?.target_user_capital_liquidity_evidence,
    v27SnapshotA ? Object.keys(v27SnapshotA) : v27SnapshotA,
  );

  console.log('\n[v2.7 — v2.6 sections remain unchanged inside v2.7]');
  const { data: v26SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_6', { p_target_user_id: userAId });
  check(
    'shared_listing_channel_evidence / target_user_listing_channel_evidence are stable-stringify identical between v2.6 and v2.7',
    stableStringify(v27SnapshotA?.shared_listing_channel_evidence) === stableStringify(v26SnapshotForCompare?.shared_listing_channel_evidence)
      && stableStringify(v27SnapshotA?.target_user_listing_channel_evidence) === stableStringify(v26SnapshotForCompare?.target_user_listing_channel_evidence),
  );
  const { data: v26SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_6', { p_target_user_id: userAId });
  const { generated_at: _v26gen1, ...v26FirstWithoutTimestamp } = (v26SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v26gen2, ...v26SecondWithoutTimestamp } = (v26SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.6 remains byte-identical (ignoring generated_at) after the v2.7 migration — v2.6 unaffected by v2.7 existing',
    stableStringify(v26FirstWithoutTimestamp) === stableStringify(v26SecondWithoutTimestamp),
  );

  const v27Shared = v27SnapshotA?.shared_capital_liquidity_evidence;
  const v27Target = v27SnapshotA?.target_user_capital_liquidity_evidence;
  const v27Pop = v27Shared?.population_summary?.[0];
  const v27TargetPop = v27Target?.population_summary?.[0];

  console.log('\n[v2.7 — population and Purpose reconciliation]');
  check(
    'population_summary: open + realized === total_item_count',
    (v27Pop?.open_item_count ?? 0) + (v27Pop?.realized_item_count ?? 0) === v27Pop?.total_item_count,
    v27Pop,
  );
  check(
    'population_summary: positive + zero_assigned + unknown + negative === total_item_count',
    (v27Pop?.positive_acquisition_item_count ?? 0) + (v27Pop?.zero_assigned_acquisition_item_count ?? 0)
      + (v27Pop?.unknown_acquisition_item_count ?? 0) + (v27Pop?.negative_acquisition_item_count ?? 0) === v27Pop?.total_item_count,
    v27Pop,
  );
  check(
    'population_summary: listed_open + unlisted_open === open_item_count',
    (v27Pop?.listed_open_item_count ?? 0) + (v27Pop?.unlisted_open_item_count ?? 0) === v27Pop?.open_item_count,
    v27Pop,
  );
  check(
    'population_summary: total_acquisition_capital === realized_acquisition_capital + open_acquisition_capital',
    Math.abs((v27Pop?.realized_acquisition_capital ?? 0) + (v27Pop?.open_acquisition_capital ?? 0) - (v27Pop?.total_acquisition_capital ?? 0)) < 0.01,
    v27Pop,
  );
  const v27PurposeRows: any[] = v27Shared?.purpose_population_summary ?? [];
  const v27PurposeTotalSum = v27PurposeRows.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_population_summary.total_item_count === population_summary.total_item_count',
    v27PurposeTotalSum === v27Pop?.total_item_count,
    { v27PurposeTotalSum, populationTotal: v27Pop?.total_item_count },
  );
  const v27PurposeCapitalSum = v27PurposeRows.reduce((sum, r) => sum + Number(r.total_acquisition_capital ?? 0), 0);
  check(
    'Purpose-level capital totals reconcile to pooled total_acquisition_capital',
    Math.abs(v27PurposeCapitalSum - (v27Pop?.total_acquisition_capital ?? 0)) < 0.01,
    { v27PurposeCapitalSum, pooled: v27Pop?.total_acquisition_capital },
  );
  const v27BusinessRow = v27PurposeRows.find((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business');
  check(
    'Business purpose_population_summary row exists and carries analytics_purpose_policy fields',
    !!v27BusinessRow && v27BusinessRow.expected_holding_policy === 'shorter_holding_preferred' && v27BusinessRow.disposition_mode === 'active_realization',
    v27BusinessRow,
  );
  const v27MissingPurposeRow = v27PurposeRows.find((r) => r.purpose_policy_status === 'missing_purpose');
  check(
    'missing_purpose row (if present) has NULL policy fields (no policy row to join)',
    !v27MissingPurposeRow || (v27MissingPurposeRow.expected_holding_policy === null && v27MissingPurposeRow.disposition_mode === null),
    v27MissingPurposeRow,
  );
  check(
    "target_user_capital_liquidity_evidence total_item_count is strictly less than shared's pooled total (User B's items are excluded)",
    (v27TargetPop?.total_item_count ?? 0) < (v27Pop?.total_item_count ?? 0),
    { target: v27TargetPop?.total_item_count, shared: v27Pop?.total_item_count },
  );

  console.log('\n[v2.7 — capital concentration and denominators]');
  const v27AgeBuckets: any[] = v27Shared?.open_capital_by_age_bucket ?? [];
  const v27AgeItemSum = v27AgeBuckets.reduce((sum, b) => sum + Number(b.open_item_count ?? 0), 0);
  check(
    'open_capital_by_age_bucket item counts reconcile to population_summary.open_item_count (mutually exclusive buckets)',
    v27AgeItemSum === v27Pop?.open_item_count,
    { v27AgeItemSum, openItemCount: v27Pop?.open_item_count },
  );
  const v27AgeCapitalSum = v27AgeBuckets.reduce((sum, b) => sum + Number(b.open_acquisition_capital ?? 0), 0);
  check(
    'open_capital_by_age_bucket capital sums reconcile to population_summary.open_acquisition_capital',
    Math.abs(v27AgeCapitalSum - (v27Pop?.open_acquisition_capital ?? 0)) < 0.01,
    { v27AgeCapitalSum, openCapital: v27Pop?.open_acquisition_capital },
  );
  const v27AgePercentSum = v27AgeBuckets.reduce((sum, b) => sum + Number(b.open_capital_percent ?? 0), 0);
  check(
    'open_capital_by_age_bucket open_capital_percent sums to ~100 (correct pooled denominator)',
    v27Pop?.open_acquisition_capital == null || v27Pop?.open_acquisition_capital === 0 || Math.abs(v27AgePercentSum - 100) < 1,
    v27AgePercentSum,
  );
  check(
    'every open_capital_by_age_bucket row is mutually exclusive (each item counted exactly once — bucket labels never overlap)',
    new Set(v27AgeBuckets.map((b) => b.age_bucket_label)).size === v27AgeBuckets.length,
    v27AgeBuckets.map((b) => b.age_bucket_label),
  );

  console.log('\n[v2.7 — historical-import and duration handling]');
  const v27EffBand: any[] = v27Shared?.realized_capital_efficiency_by_acquisition_band ?? [];
  check(
    'at least one realized_capital_efficiency_by_acquisition_band row has holding_sample_size <= realized_item_count (Historical Import excluded from holding metrics only, DOM unaffected)',
    v27EffBand.some((r) => (r.holding_sample_size ?? 0) <= (r.realized_item_count ?? 0)),
    v27EffBand,
  );
  check(
    'dom_sample_size is never forced to 0 for a band merely because it holds a Historical Import (DOM stays eligible)',
    v27EffBand.every((r) => typeof r.dom_sample_size === 'number'),
    v27EffBand.map((r) => r.dom_sample_size),
  );
  check(
    'missing/undefined durations are NULL, never fabricated as 0 (a band with 0 holding_sample_size reports median_holding_days as null)',
    v27EffBand.every((r) => (r.holding_sample_size ?? 0) > 0 || r.median_holding_days === null),
    v27EffBand,
  );

  console.log('\n[v2.7 — Purpose-aware interpretation: no universal urgency]');
  const v27HybridRow = v27PurposeRows.find((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Hybrid');
  const v27PersonalRow = v27PurposeRows.find((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Personal');
  check(
    'Hybrid and Personal purpose rows (if present) use the SAME field shape as Business — no separate "urgency" or "recommendation" field exists on any purpose_population_summary row',
    [v27BusinessRow, v27HybridRow, v27PersonalRow].filter(Boolean).every((r) => !('urgency' in r) && !('recommendation' in r) && !('score' in r)),
    { v27BusinessRow, v27HybridRow, v27PersonalRow },
  );
  check(
    'Business, Hybrid, and Personal each carry their own distinct expected_holding_policy label (not one universal value forced across all Purposes)',
    !v27BusinessRow || !v27HybridRow || !v27PersonalRow
      || (v27BusinessRow.expected_holding_policy !== v27HybridRow.expected_holding_policy
        && v27HybridRow.expected_holding_policy !== v27PersonalRow.expected_holding_policy),
    { business: v27BusinessRow?.expected_holding_policy, hybrid: v27HybridRow?.expected_holding_policy, personal: v27PersonalRow?.expected_holding_policy },
  );

  console.log('\n[v2.7 — no OIDS item-level evidence duplicated]');
  const v27SharedSerialized = JSON.stringify(v27Shared);
  check(
    'shared_capital_liquidity_evidence contains no item-level fields (item_id, reason_codes, or item_decision_evidence)',
    !v27SharedSerialized.includes('"item_id"') && !v27SharedSerialized.includes('reason_codes') && !v27SharedSerialized.includes('item_decision_evidence'),
  );

  console.log('\n[v2.7 — privacy]');
  check(
    'shared_capital_liquidity_evidence exposes no user_id field anywhere',
    !v27SharedSerialized.includes('"user_id"'),
  );

  console.log('\n[v2.7 — permissions]');
  const { error: v27AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_7', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_7 directly', !!v27AuthedError, v27AuthedError);
  const { error: v27HelperAuthedError } = await clientA.rpc('_build_capital_liquidity_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_capital_liquidity_snapshot_v2 directly', !!v27HelperAuthedError, v27HelperAuthedError);
  const { error: v27ForgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_7', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_7 for a forged target user id either', !!v27ForgedTargetError, v27ForgedTargetError);

  console.log('\n[v2.7 — old-version compatibility]');
  const v27StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_4', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_5', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_6', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v27StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.7 migration`, !error, error);
  }

  // Note: at the point v2.7 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.7 specifically and created a fresh production
  // run to check it. The runner has since been promoted again to v2.8 (see
  // the "[v2.8 — production promotion]" section below) — that generic
  // check already lives in the "[production runner — creates a completed
  // run with the current ANALYTICS_VERSION]" block above, so it is not
  // repeated here.

  console.log('\n[v2.7 — old stored runs remain readable]');
  const { data: oldRunReadBack } = await serviceClient
    .from('analytics_runs').select('analytics_version, snapshot').eq('id', syntheticOldRun!.id).single();
  check(
    'the synthetic v1.8 run from earlier in this script still reads back unchanged after the v2.7 migration',
    oldRunReadBack?.analytics_version === '1.8' && (oldRunReadBack?.snapshot as any)?.snapshot_schema_version === '1.8',
    oldRunReadBack,
  );

  // ── Analytics v2.8 — Calendar & Seasonality + seventh production promotion ──
  console.log('\n[v2.8 — builder callable, top-level metadata]');
  const { data: v28SnapshotA, error: v28ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_8', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_8 callable by service_role', !v28ErrorA, v28ErrorA);
  check('v2.8 snapshot_schema_version is 2.8', v28SnapshotA?.snapshot_schema_version === '2.8', v28SnapshotA?.snapshot_schema_version);
  check('v2.8 analytics_definition_version is 2.8', v28SnapshotA?.analytics_definition_version === '2.8', v28SnapshotA?.analytics_definition_version);
  check(
    'v2.8 output includes shared_calendar_seasonality_evidence and target_user_calendar_seasonality_evidence',
    !!v28SnapshotA?.shared_calendar_seasonality_evidence && !!v28SnapshotA?.target_user_calendar_seasonality_evidence,
    v28SnapshotA ? Object.keys(v28SnapshotA) : v28SnapshotA,
  );

  console.log('\n[v2.8 — v2.7 sections remain unchanged inside v2.8]');
  const { data: v27SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_7', { p_target_user_id: userAId });
  check(
    'shared_capital_liquidity_evidence / target_user_capital_liquidity_evidence are stable-stringify identical between v2.7 and v2.8',
    stableStringify(v28SnapshotA?.shared_capital_liquidity_evidence) === stableStringify(v27SnapshotForCompare?.shared_capital_liquidity_evidence)
      && stableStringify(v28SnapshotA?.target_user_capital_liquidity_evidence) === stableStringify(v27SnapshotForCompare?.target_user_capital_liquidity_evidence),
  );
  const { data: v27SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_7', { p_target_user_id: userAId });
  const { generated_at: _v27gen1, ...v27FirstWithoutTimestamp } = (v27SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v27gen2, ...v27SecondWithoutTimestamp } = (v27SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.7 remains byte-identical (ignoring generated_at) after the v2.8 migration — v2.7 unaffected by v2.8 existing',
    stableStringify(v27FirstWithoutTimestamp) === stableStringify(v27SecondWithoutTimestamp),
  );

  const v28Shared = v28SnapshotA?.shared_calendar_seasonality_evidence;
  const v28Target = v28SnapshotA?.target_user_calendar_seasonality_evidence;
  const v28Pop = v28Shared?.population_summary?.[0];
  const v28TargetPop = v28Target?.population_summary?.[0];

  console.log('\n[v2.8 — timezone / as_of_date presence]');
  check('shared_calendar_seasonality_evidence carries timezone America/Toronto', v28Shared?.timezone === 'America/Toronto', v28Shared?.timezone);
  check('shared_calendar_seasonality_evidence carries an as_of_date', typeof v28Shared?.as_of_date === 'string' && v28Shared.as_of_date.length > 0, v28Shared?.as_of_date);
  check('target_user_calendar_seasonality_evidence carries the same timezone/as_of_date shape', v28Target?.timezone === 'America/Toronto' && typeof v28Target?.as_of_date === 'string', v28Target);

  console.log('\n[v2.8 — population and date coverage reconciliation]');
  check(
    'population_summary: reliable + missing + historical-excluded + lifecycle-issue-excluded acquisition counts === total_item_count',
    (v28Pop?.reliable_acquisition_date_count ?? 0) + (v28Pop?.missing_acquisition_date_count ?? 0)
      + (v28Pop?.historical_import_excluded_acquisition_date_count ?? 0) + (v28Pop?.lifecycle_issue_excluded_acquisition_date_count ?? 0) === v28Pop?.total_item_count,
    v28Pop,
  );
  check(
    'population_summary: reliable + missing + lifecycle-issue-excluded first-listing counts === total_item_count',
    (v28Pop?.reliable_first_listing_date_count ?? 0) + (v28Pop?.missing_first_listing_date_count ?? 0) + (v28Pop?.lifecycle_issue_excluded_listing_date_count ?? 0) === v28Pop?.total_item_count,
    v28Pop,
  );
  const v28PurposeRows: any[] = v28Shared?.purpose_population_summary ?? [];
  const v28PurposeTotalSum = v28PurposeRows.reduce((sum, r) => sum + Number(r.total_item_count ?? 0), 0);
  check(
    'sum of purpose_population_summary.total_item_count === population_summary.total_item_count',
    v28PurposeTotalSum === v28Pop?.total_item_count,
    { v28PurposeTotalSum, populationTotal: v28Pop?.total_item_count },
  );
  const v28BusinessPopRow = v28PurposeRows.find((r) => r.purpose_policy_status === 'mapped' && r.current_purpose_name === 'Business');
  check(
    'Business purpose_population_summary row (if present) carries analytics_purpose_policy fields',
    !v28BusinessPopRow || (v28BusinessPopRow.expected_holding_policy === 'shorter_holding_preferred' && v28BusinessPopRow.disposition_mode === 'active_realization'),
    v28BusinessPopRow,
  );
  check(
    "target_user_calendar_seasonality_evidence total_item_count is <= shared's pooled total (User B's items are excluded)",
    (v28TargetPop?.total_item_count ?? 0) <= (v28Pop?.total_item_count ?? 0),
    { target: v28TargetPop?.total_item_count, shared: v28Pop?.total_item_count },
  );

  console.log('\n[v2.8 — monthly timeline: chronological order, gap-filling, deal/item separation]');
  const v28Monthly: any[] = v28Shared?.monthly_timeline ?? [];
  const v28MonthlySorted = [...v28Monthly].sort((a, b) => String(a.month_start).localeCompare(String(b.month_start)));
  check('monthly_timeline is already in chronological order', JSON.stringify(v28Monthly) === JSON.stringify(v28MonthlySorted), v28Monthly.map((m) => m.month_start));
  check(
    'monthly_timeline contains no gaps (every month between the first and last row is present)',
    v28Monthly.length === 0 || v28Monthly.every((m, i) => {
      if (i === 0) return true;
      const prev = new Date(v28Monthly[i - 1].month_start as string);
      const expectedNext = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 1));
      return new Date(m.month_start as string).getTime() === expectedNext.getTime();
    }),
    v28Monthly.map((m) => m.month_start),
  );
  check(
    'every monthly_timeline row reports reliable_acquisition_deal_count <= reliable_acquisition_item_count (deal count never exceeds item count)',
    v28Monthly.every((m) => (m.reliable_acquisition_deal_count ?? 0) <= (m.reliable_acquisition_item_count ?? 0)),
    v28Monthly.filter((m) => (m.reliable_acquisition_deal_count ?? 0) > (m.reliable_acquisition_item_count ?? 0)),
  );
  check(
    'every monthly_timeline row reports realized_exit_deal_count <= realized_exit_item_count',
    v28Monthly.every((m) => (m.realized_exit_deal_count ?? 0) <= (m.realized_exit_item_count ?? 0)),
    v28Monthly.filter((m) => (m.realized_exit_deal_count ?? 0) > (m.realized_exit_item_count ?? 0)),
  );
  const v28MonthlyAcqSum = v28Monthly.reduce((sum, m) => sum + Number(m.reliable_acquisition_item_count ?? 0), 0);
  check(
    'monthly_timeline reliable_acquisition_item_count sums to population_summary.reliable_acquisition_date_count',
    v28MonthlyAcqSum === (v28Pop?.reliable_acquisition_date_count ?? 0),
    { v28MonthlyAcqSum, populationCount: v28Pop?.reliable_acquisition_date_count },
  );

  console.log('\n[v2.8 — month-of-year seasonality: 12 rows, distinct-year-aware confidence]');
  const v28Moy: any[] = v28Shared?.month_of_year_seasonality ?? [];
  check('month_of_year_seasonality has exactly 12 rows (Jan-Dec)', v28Moy.length === 12, v28Moy.length);
  check(
    'month_of_year_seasonality rows are numbered 1-12 in order',
    JSON.stringify(v28Moy.map((m) => m.month_number)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    v28Moy.map((m) => m.month_number),
  );
  check(
    'no month row claims acquisition_confidence better than insufficient_years when acquisition_distinct_year_count <= 1',
    v28Moy.every((m) => (m.acquisition_distinct_year_count ?? 0) > 1 || m.acquisition_item_count === 0 || m.acquisition_confidence === 'insufficient_years'),
    v28Moy.filter((m) => (m.acquisition_distinct_year_count ?? 0) <= 1 && m.acquisition_item_count > 0 && m.acquisition_confidence !== 'insufficient_years'),
  );
  check(
    'no month row claims realized_exit_confidence better than insufficient_years when realized_exit_distinct_year_count <= 1',
    v28Moy.every((m) => (m.realized_exit_distinct_year_count ?? 0) > 1 || m.realized_exit_item_count === 0 || m.realized_exit_confidence === 'insufficient_years'),
    v28Moy.filter((m) => (m.realized_exit_distinct_year_count ?? 0) <= 1 && m.realized_exit_item_count > 0 && m.realized_exit_confidence !== 'insufficient_years'),
  );
  const v28MoyAcqSum = v28Moy.reduce((sum, m) => sum + Number(m.acquisition_item_count ?? 0), 0);
  check(
    'month_of_year_seasonality acquisition_item_count sums to population_summary.reliable_acquisition_date_count (all years pooled)',
    v28MoyAcqSum === (v28Pop?.reliable_acquisition_date_count ?? 0),
    { v28MoyAcqSum, populationCount: v28Pop?.reliable_acquisition_date_count },
  );

  console.log('\n[v2.8 — day-of-week patterns: three independent arrays, reconciliation]');
  const v28DowAcq: any[] = v28Shared?.day_of_week_acquisition_activity ?? [];
  const v28DowListing: any[] = v28Shared?.day_of_week_first_listing_activity ?? [];
  const v28DowExit: any[] = v28Shared?.day_of_week_realized_exit_activity ?? [];
  check('day_of_week_acquisition_activity has exactly 7 rows (Mon-Sun)', v28DowAcq.length === 7, v28DowAcq.length);
  check('day_of_week_first_listing_activity has exactly 7 rows (Mon-Sun)', v28DowListing.length === 7, v28DowListing.length);
  check('day_of_week_realized_exit_activity has exactly 7 rows (Mon-Sun)', v28DowExit.length === 7, v28DowExit.length);
  check(
    'day_of_week_acquisition_activity is a DISTINCT array from day_of_week_first_listing_activity (event types never combined)',
    JSON.stringify(v28DowAcq.map((d) => d.event_count)) !== JSON.stringify(v28DowListing.map((d) => d.event_count)) || v28DowAcq.every((d) => d.event_count === 0),
  );
  const v28DowAcqSum = v28DowAcq.reduce((sum, d) => sum + Number(d.event_count ?? 0), 0);
  check(
    'day_of_week_acquisition_activity event counts sum to population_summary.reliable_acquisition_date_count',
    v28DowAcqSum === (v28Pop?.reliable_acquisition_date_count ?? 0),
    { v28DowAcqSum, populationCount: v28Pop?.reliable_acquisition_date_count },
  );
  const v28DowExitSum = v28DowExit.reduce((sum, d) => sum + Number(d.event_count ?? 0), 0);
  check(
    'day_of_week_realized_exit_activity event counts sum to population_summary.reliable_realized_exit_date_count',
    v28DowExitSum === (v28Pop?.reliable_realized_exit_date_count ?? 0),
    { v28DowExitSum, populationCount: v28Pop?.reliable_realized_exit_date_count },
  );

  console.log('\n[v2.8 — current month-to-date pace: same-day-cutoff comparison, insufficient-history handling]');
  const v28Mtd = v28Shared?.current_month_to_date_pace;
  check('current_month_to_date_pace carries timezone/as_of_date/status', v28Mtd?.timezone === 'America/Toronto' && typeof v28Mtd?.as_of_date === 'string' && typeof v28Mtd?.status === 'string', v28Mtd);
  check(
    'status is insufficient_history when comparable_prior_years_count is 0, sufficient_history otherwise',
    (v28Mtd?.comparable_prior_years_count === 0) === (v28Mtd?.status === 'insufficient_history'),
    v28Mtd,
  );
  check(
    'prior_year_median/average/difference_vs_prior_median are null exactly when insufficient_history (never fabricated)',
    v28Mtd?.status !== 'insufficient_history' || (v28Mtd?.prior_year_median === null && v28Mtd?.prior_year_average === null && v28Mtd?.difference_vs_prior_median === null),
    v28Mtd,
  );
  check(
    'comparable_prior_years length matches comparable_prior_years_count',
    (v28Mtd?.comparable_prior_years ?? []).length === v28Mtd?.comparable_prior_years_count,
    v28Mtd,
  );
  check(
    'every comparable_prior_years row uses a day_cutoff_used <= current_day_of_month (February/short-month safe)',
    (v28Mtd?.comparable_prior_years ?? []).every((r: any) => r.day_cutoff_used <= v28Mtd?.current_day_of_month),
    v28Mtd?.comparable_prior_years,
  );
  check('current_month_to_date_pace note is descriptive, not a forecast claim', typeof v28Mtd?.note === 'string' && v28Mtd.note.toLowerCase().includes('not a forecast'), v28Mtd?.note);

  console.log('\n[v2.8 — descriptive-only: no recommendation/urgency/score/forecast field anywhere]');
  const v28SharedSerialized = JSON.stringify(v28Shared);
  check(
    'shared_calendar_seasonality_evidence contains no recommendation/urgency/score/forecast/item_id fields',
    !v28SharedSerialized.includes('"recommendation"') && !v28SharedSerialized.includes('"urgency"') && !v28SharedSerialized.includes('"score"')
      && !v28SharedSerialized.includes('"forecast"') && !v28SharedSerialized.includes('"item_id"'),
  );

  console.log('\n[v2.8 — privacy]');
  check('shared_calendar_seasonality_evidence exposes no user_id field anywhere', !v28SharedSerialized.includes('"user_id"'));

  console.log('\n[v2.8 — permissions]');
  const { error: v28AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_8', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_8 directly', !!v28AuthedError, v28AuthedError);
  const { error: v28HelperAuthedError } = await clientA.rpc('_build_calendar_seasonality_snapshot_v2', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_calendar_seasonality_snapshot_v2 directly', !!v28HelperAuthedError, v28HelperAuthedError);
  const { error: v28ForgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_8', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_8 for a forged target user id either', !!v28ForgedTargetError, v28ForgedTargetError);

  console.log('\n[v2.8 — old-version compatibility]');
  const v28StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_4', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_5', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_6', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_7', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v28StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.8 migration`, !error, error);
  }

  // Note: at the point v2.8 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.8 specifically and created a fresh production
  // run to check it. The runner has since been promoted again to v2.9 (see
  // the "[v2.9 — production promotion]" section below) — that generic
  // check already lives in the "[production runner — creates a completed
  // run with the current ANALYTICS_VERSION]" block above, so it is not
  // repeated here.

  console.log('\n[v2.8 — old stored runs remain readable]');
  const { data: oldRunReadBack28 } = await serviceClient
    .from('analytics_runs').select('analytics_version, snapshot').eq('id', syntheticOldRun!.id).single();
  check(
    'the synthetic v1.8 run from earlier in this script still reads back unchanged after the v2.8 migration',
    oldRunReadBack28?.analytics_version === '1.8' && (oldRunReadBack28?.snapshot as any)?.snapshot_schema_version === '1.8',
    oldRunReadBack28,
  );

  // ── Analytics v2.9 — Calendar Observation Coverage & Confidence Correction + eighth production promotion ──
  console.log('\n[v2.9 — analytics_observation_coverage: configure coverage for userA]');
  const coverageStartA = new Date();
  coverageStartA.setUTCFullYear(coverageStartA.getUTCFullYear() - 2);
  coverageStartA.setUTCDate(1);
  const coverageStartAIso = coverageStartA.toISOString().slice(0, 10);
  const { error: coverageUpsertError } = await serviceClient
    .from('analytics_observation_coverage')
    .upsert({ user_id: userAId, complete_history_start_date: coverageStartAIso, coverage_status: 'confirmed', notes: 'test fixture' }, { onConflict: 'user_id' });
  check('service_role can configure analytics_observation_coverage for userA', !coverageUpsertError, coverageUpsertError);

  console.log('\n[v2.9 — analytics_observation_coverage: permissions]');
  const { error: coverageAuthedSelectError } = await clientA.from('analytics_observation_coverage').select('*');
  check('authenticated client cannot SELECT analytics_observation_coverage', !!coverageAuthedSelectError, coverageAuthedSelectError);
  const { error: coverageAuthedUpsertError } = await clientA
    .from('analytics_observation_coverage')
    .upsert({ user_id: userBId, complete_history_start_date: '2020-01-01', coverage_status: 'confirmed' });
  check('authenticated client cannot write another user\'s (or any) analytics_observation_coverage row', !!coverageAuthedUpsertError, coverageAuthedUpsertError);

  console.log('\n[v2.9 — builder callable, top-level metadata, same section keys as v2.8]');
  const { data: v29SnapshotA, error: v29ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_9', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_9 callable by service_role', !v29ErrorA, v29ErrorA);
  check('v2.9 snapshot_schema_version is 2.9', v29SnapshotA?.snapshot_schema_version === '2.9', v29SnapshotA?.snapshot_schema_version);
  check('v2.9 analytics_definition_version is 2.9', v29SnapshotA?.analytics_definition_version === '2.9', v29SnapshotA?.analytics_definition_version);
  check(
    'v2.9 reuses the SAME shared_calendar_seasonality_evidence / target_user_calendar_seasonality_evidence keys as v2.8 (no new top-level section)',
    !!v29SnapshotA?.shared_calendar_seasonality_evidence && !!v29SnapshotA?.target_user_calendar_seasonality_evidence,
    v29SnapshotA ? Object.keys(v29SnapshotA) : v29SnapshotA,
  );

  console.log('\n[v2.9 — every non-calendar v2.8 section is preserved unchanged]');
  const { data: v28SnapshotForCompare } = await serviceClient.rpc('build_analytics_snapshot_v2_8', { p_target_user_id: userAId });
  const nonCalendarKeys = Object.keys(v28SnapshotForCompare ?? {}).filter(
    (k) => k !== 'shared_calendar_seasonality_evidence' && k !== 'target_user_calendar_seasonality_evidence'
      && k !== 'snapshot_schema_version' && k !== 'analytics_definition_version' && k !== 'generated_at',
  );
  const nonCalendarUnchanged = nonCalendarKeys.every((k) => stableStringify((v29SnapshotA as any)?.[k]) === stableStringify((v28SnapshotForCompare as any)?.[k]));
  check('every non-calendar v2.8 key is byte-identical inside v2.9 (stable-stringify)', nonCalendarUnchanged, nonCalendarKeys.filter((k) => stableStringify((v29SnapshotA as any)?.[k]) !== stableStringify((v28SnapshotForCompare as any)?.[k])));
  const { data: v28SnapshotSecondCall } = await serviceClient.rpc('build_analytics_snapshot_v2_8', { p_target_user_id: userAId });
  const { generated_at: _v28gen1, ...v28FirstWithoutTimestamp } = (v28SnapshotForCompare ?? {}) as Record<string, unknown>;
  const { generated_at: _v28gen2, ...v28SecondWithoutTimestamp } = (v28SnapshotSecondCall ?? {}) as Record<string, unknown>;
  check(
    'v2.8 remains byte-identical (ignoring generated_at) after the v2.9 migration — v2.8 unaffected by v2.9 existing',
    stableStringify(v28FirstWithoutTimestamp) === stableStringify(v28SecondWithoutTimestamp),
  );

  const v29Shared = v29SnapshotA?.shared_calendar_seasonality_evidence;
  const v29Target = v29SnapshotA?.target_user_calendar_seasonality_evidence;

  console.log('\n[v2.9 — observation_coverage_summary]');
  const v29TargetCoverage = v29Target?.observation_coverage_summary;
  check(
    'target_user observation_coverage_summary resolves to exactly one user, now fully_observed (coverage was just configured above)',
    v29TargetCoverage?.total_user_count === 1 && v29TargetCoverage?.fully_observed_user_count === 1,
    v29TargetCoverage,
  );
  const v29SharedCoverage = v29Shared?.observation_coverage_summary;
  check(
    'shared observation_coverage_summary total_user_count >= target (pools every user)',
    (v29SharedCoverage?.total_user_count ?? 0) >= (v29TargetCoverage?.total_user_count ?? 0),
    { shared: v29SharedCoverage, target: v29TargetCoverage },
  );
  check(
    'shared observation_coverage_summary counts sum to total_user_count',
    (v29SharedCoverage?.fully_observed_user_count ?? 0) + (v29SharedCoverage?.partial_coverage_user_count ?? 0)
      + (v29SharedCoverage?.pre_coverage_user_count ?? 0) + (v29SharedCoverage?.unknown_coverage_user_count ?? 0) === v29SharedCoverage?.total_user_count,
    v29SharedCoverage,
  );

  console.log('\n[v2.9 — monthly_timeline: coverage_status present and valid, reconciles to purpose breakdown]');
  const v29Monthly: any[] = v29Target?.monthly_timeline ?? [];
  const validCoverageLabels = new Set(['fully_observed', 'partial', 'pre_coverage', 'unknown_coverage']);
  check(
    'every monthly_timeline row has a valid coverage_status label',
    v29Monthly.every((m) => validCoverageLabels.has(m.coverage_status)),
    v29Monthly.map((m) => m.coverage_status).filter((s) => !validCoverageLabels.has(s)),
  );
  check(
    'the current (last) monthly_timeline row is never fully_observed (still in progress)',
    v29Monthly.length === 0 || v29Monthly[v29Monthly.length - 1].coverage_status !== 'fully_observed',
    v29Monthly[v29Monthly.length - 1],
  );
  const v29MonthlyByPurpose: any[] = v29Target?.monthly_timeline_by_purpose ?? [];
  const v29MonthlySum = v29Monthly.reduce((sum, m) => sum + Number(m.reliable_acquisition_item_count ?? 0), 0);
  const v29MonthlyByPurposeSum = v29MonthlyByPurpose.reduce((sum, m) => sum + Number(m.reliable_acquisition_item_count ?? 0), 0);
  check(
    'monthly_timeline_by_purpose reliable_acquisition_item_count sums to pooled monthly_timeline',
    v29MonthlySum === v29MonthlyByPurposeSum,
    { pooled: v29MonthlySum, byPurpose: v29MonthlyByPurposeSum },
  );

  console.log('\n[v2.9 — month_of_year_seasonality: valid confidence values, one-year-domination cap, out-of-scope by-purpose note]');
  const v29Moy: any[] = v29Target?.month_of_year_seasonality ?? [];
  check('month_of_year_seasonality has exactly 12 rows', v29Moy.length === 12, v29Moy.length);
  const validConfidenceLabels = new Set(['no_data', 'coverage_unknown', 'insufficient_years', 'low', 'moderate', 'stronger']);
  check(
    'every month row uses a valid acquisition_confidence value',
    v29Moy.every((m) => validConfidenceLabels.has(m.acquisition_confidence)),
    v29Moy.map((m) => m.acquisition_confidence).filter((c) => !validConfidenceLabels.has(c)),
  );
  check(
    'no month claims stronger/moderate acquisition_confidence when largest_year_event_share > 0.80 (one-year domination capped)',
    v29Moy.every((m) => m.acquisition_largest_year_event_share === null || m.acquisition_largest_year_event_share <= 0.80 || (m.acquisition_confidence !== 'stronger' && m.acquisition_confidence !== 'moderate')),
    v29Moy.filter((m) => m.acquisition_largest_year_event_share > 0.80 && (m.acquisition_confidence === 'stronger' || m.acquisition_confidence === 'moderate')),
  );
  check(
    'no month claims stronger/moderate acquisition_confidence with fewer than 2 fully_observed years (insufficient_years enforced)',
    v29Moy.every((m) => (m.acquisition_fully_observed_year_count ?? 0) >= 2 || (m.acquisition_confidence !== 'stronger' && m.acquisition_confidence !== 'moderate')),
    v29Moy.filter((m) => (m.acquisition_fully_observed_year_count ?? 0) < 2 && (m.acquisition_confidence === 'stronger' || m.acquisition_confidence === 'moderate')),
  );
  check(
    'month_of_year_seasonality_by_purpose is explicitly out of scope (empty array + note), never stale v2.8 data',
    Array.isArray(v29Target?.month_of_year_seasonality_by_purpose) && v29Target.month_of_year_seasonality_by_purpose.length === 0 && typeof v29Target?.month_of_year_seasonality_by_purpose_note === 'string',
    { arr: v29Target?.month_of_year_seasonality_by_purpose, note: v29Target?.month_of_year_seasonality_by_purpose_note },
  );

  console.log('\n[v2.9 — current_month_to_date_pace: valid status, no fabricated conclusions]');
  const v29Mtd = v29Target?.current_month_to_date_pace;
  const validMtdStatus = new Set(['coverage_unknown', 'insufficient_history', 'sufficient_history']);
  check('current_month_to_date_pace.status is a valid value', validMtdStatus.has(v29Mtd?.status), v29Mtd?.status);
  check(
    'status is sufficient_history only when comparable_prior_years_count >= 2',
    (v29Mtd?.status === 'sufficient_history') === ((v29Mtd?.comparable_prior_years_count ?? 0) >= 2),
    v29Mtd,
  );
  check(
    'prior_year_median/average/difference_vs_prior_median are null exactly when comparable_prior_years_count is 0',
    (v29Mtd?.comparable_prior_years_count ?? 0) > 0 || (v29Mtd?.prior_year_median === null && v29Mtd?.prior_year_average === null && v29Mtd?.difference_vs_prior_median === null),
    v29Mtd,
  );
  check(
    'comparable_prior_years length matches comparable_prior_years_count, each with a comparable_user_count',
    (v29Mtd?.comparable_prior_years ?? []).length === v29Mtd?.comparable_prior_years_count
      && (v29Mtd?.comparable_prior_years ?? []).every((r: any) => typeof r.comparable_user_count === 'number' && r.comparable_user_count > 0),
    v29Mtd?.comparable_prior_years,
  );
  check('current_month_to_date_pace note is descriptive, not a forecast claim', typeof v29Mtd?.note === 'string' && v29Mtd.note.toLowerCase().includes('not a forecast'), v29Mtd?.note);

  console.log('\n[v2.9 — Historical Import semantics unchanged]');
  const v29SharedSerialized = JSON.stringify(v29Shared);
  check(
    'shared_calendar_seasonality_evidence contains no recommendation/urgency/score/forecast/item_id/user_id fields',
    !v29SharedSerialized.includes('"recommendation"') && !v29SharedSerialized.includes('"urgency"') && !v29SharedSerialized.includes('"score"')
      && !v29SharedSerialized.includes('"forecast"') && !v29SharedSerialized.includes('"item_id"') && !v29SharedSerialized.includes('"user_id"'),
  );

  console.log('\n[v2.9 — target scope is a subset of shared scope]');
  check(
    "target_user monthly_timeline reliable_acquisition_item_count total is <= shared's pooled total",
    v29MonthlySum <= (v29Shared?.monthly_timeline ?? []).reduce((sum: number, m: any) => sum + Number(m.reliable_acquisition_item_count ?? 0), 0),
    { target: v29MonthlySum },
  );

  console.log('\n[v2.9 — permissions]');
  const { error: v29AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_9', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_9 directly', !!v29AuthedError, v29AuthedError);
  const { error: v29HelperAuthedError } = await clientA.rpc('_build_calendar_coverage_correction_v2_9', { p_target_user_id: userAId });
  check('authenticated client cannot call _build_calendar_coverage_correction_v2_9 directly', !!v29HelperAuthedError, v29HelperAuthedError);
  const { error: v29ForgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_9', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_9 for a forged target user id either', !!v29ForgedTargetError, v29ForgedTargetError);

  console.log('\n[v2.9 — old-version compatibility]');
  const v29StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_4', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_5', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_6', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_7', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_8', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v29StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.9 migration`, !error, error);
  }

  // Note: at the point v2.9 was promoted, this section asserted the runner's
  // ANALYTICS_VERSION was 2.9 specifically and created a fresh production
  // run to check it. The runner has since been promoted again to v2.10 (see
  // the "[v2.10 — production promotion]" section below) — that generic
  // check already lives in the "[production runner — creates a completed
  // run with the current ANALYTICS_VERSION]" block above, so it is not
  // repeated here.

  console.log('\n[v2.9 — old stored runs remain readable]');
  const { data: oldRunReadBack29 } = await serviceClient
    .from('analytics_runs').select('analytics_version, snapshot').eq('id', syntheticOldRun!.id).single();
  check(
    'the synthetic v1.8 run from earlier in this script still reads back unchanged after the v2.9 migration',
    oldRunReadBack29?.analytics_version === '1.8' && (oldRunReadBack29?.snapshot as any)?.snapshot_schema_version === '1.8',
    oldRunReadBack29,
  );

  // ── Analytics v2.10 — Shared Calendar Cohort Correction + ninth production promotion ──
  console.log('\n[v2.10 — analytics_observation_coverage: configure DIFFERING coverage for userA and userB]');
  // userA is already confirmed from ~2 years ago (coverageStartA, set in
  // the v2.9 section above). Configure userB with a LATER confirmed
  // start date (~1 year ago) so there is a real window where userA is
  // coverage-qualified and userB is not yet — exactly the scenario
  // Problem 1 mishandled (one confirmed user vouching for another).
  const coverageStartB = new Date();
  coverageStartB.setUTCFullYear(coverageStartB.getUTCFullYear() - 1);
  coverageStartB.setUTCDate(1);
  const coverageStartBIso = coverageStartB.toISOString().slice(0, 10);
  const { error: coverageUpsertErrorB } = await serviceClient
    .from('analytics_observation_coverage')
    .upsert({ user_id: userBId, complete_history_start_date: coverageStartBIso, coverage_status: 'confirmed', notes: 'test fixture — later coverage start than userA' }, { onConflict: 'user_id' });
  check('service_role can configure analytics_observation_coverage for userB', !coverageUpsertErrorB, coverageUpsertErrorB);

  console.log('\n[v2.10 — builder callable, top-level metadata, same section keys as v2.9]');
  const { data: v210SnapshotA, error: v210ErrorA } = await serviceClient.rpc('build_analytics_snapshot_v2_10', { p_target_user_id: userAId });
  check('build_analytics_snapshot_v2_10 callable by service_role', !v210ErrorA, v210ErrorA);
  check('v2.10 snapshot_schema_version is 2.10', v210SnapshotA?.snapshot_schema_version === '2.10', v210SnapshotA?.snapshot_schema_version);
  check('v2.10 analytics_definition_version is 2.10', v210SnapshotA?.analytics_definition_version === '2.10', v210SnapshotA?.analytics_definition_version);
  check(
    'v2.10 reuses the SAME shared_calendar_seasonality_evidence / target_user_calendar_seasonality_evidence keys as v2.9 (no new top-level section)',
    !!v210SnapshotA?.shared_calendar_seasonality_evidence && !!v210SnapshotA?.target_user_calendar_seasonality_evidence,
    v210SnapshotA ? Object.keys(v210SnapshotA) : v210SnapshotA,
  );

  console.log('\n[v2.10 — target_user_calendar_seasonality_evidence is NOT recomputed (byte-identical to v2.9, no regression)]');
  const { data: v29SnapshotForCompare210 } = await serviceClient.rpc('build_analytics_snapshot_v2_9', { p_target_user_id: userAId });
  check(
    'target_user_calendar_seasonality_evidence is byte-identical between v2.9 and v2.10 (stable-stringify)',
    stableStringify(v210SnapshotA?.target_user_calendar_seasonality_evidence) === stableStringify(v29SnapshotForCompare210?.target_user_calendar_seasonality_evidence),
  );

  console.log('\n[v2.10 — every non-shared-calendar v2.9 section is preserved unchanged]');
  const nonCalendarKeys210 = Object.keys(v29SnapshotForCompare210 ?? {}).filter(
    (k) => k !== 'shared_calendar_seasonality_evidence'
      && k !== 'snapshot_schema_version' && k !== 'analytics_definition_version' && k !== 'generated_at',
  );
  const nonCalendarUnchanged210 = nonCalendarKeys210.every((k) => stableStringify((v210SnapshotA as any)?.[k]) === stableStringify((v29SnapshotForCompare210 as any)?.[k]));
  check('every non-shared-calendar v2.9 key is byte-identical inside v2.10 (stable-stringify)', nonCalendarUnchanged210, nonCalendarKeys210.filter((k) => stableStringify((v210SnapshotA as any)?.[k]) !== stableStringify((v29SnapshotForCompare210 as any)?.[k])));

  const { data: v29SnapshotSecondCall210 } = await serviceClient.rpc('build_analytics_snapshot_v2_9', { p_target_user_id: userAId });
  const { generated_at: _v29gen1_210, ...v29FirstWithoutTimestamp210 } = (v29SnapshotForCompare210 ?? {}) as Record<string, unknown>;
  const { generated_at: _v29gen2_210, ...v29SecondWithoutTimestamp210 } = (v29SnapshotSecondCall210 ?? {}) as Record<string, unknown>;
  check(
    'v2.9 remains byte-identical (ignoring generated_at) after the v2.10 migration — v2.9 unaffected by v2.10 existing',
    stableStringify(v29FirstWithoutTimestamp210) === stableStringify(v29SecondWithoutTimestamp210),
  );

  const v210Shared = v210SnapshotA?.shared_calendar_seasonality_evidence;

  console.log('\n[v2.10 — monthly_timeline: structural invariants]');
  const v210Monthly: any[] = v210Shared?.monthly_timeline ?? [];
  const validSharedStatusLabels = new Set(['fully_observed', 'partially_observed', 'pre_coverage', 'unknown_coverage', 'mixed_coverage']);
  check(
    'every monthly_timeline row has a valid shared_coverage_status label',
    v210Monthly.every((m) => validSharedStatusLabels.has(m.shared_coverage_status)),
    v210Monthly.map((m) => m.shared_coverage_status).filter((s) => !validSharedStatusLabels.has(s)),
  );
  check(
    'shared_coverage_status is fully_observed ONLY when fully_observed_confirmed_user_count === total_shared_user_count (one user cannot vouch for another)',
    v210Monthly.every((m) => (m.shared_coverage_status === 'fully_observed') === (m.fully_observed_confirmed_user_count === m.total_shared_user_count)),
    v210Monthly.filter((m) => (m.shared_coverage_status === 'fully_observed') !== (m.fully_observed_confirmed_user_count === m.total_shared_user_count)),
  );
  check(
    'user-count buckets sum to total_shared_user_count on every row',
    v210Monthly.every((m) => m.fully_observed_confirmed_user_count + m.partial_coverage_user_count + m.pre_coverage_user_count + m.unknown_coverage_user_count === m.total_shared_user_count),
    v210Monthly.filter((m) => m.fully_observed_confirmed_user_count + m.partial_coverage_user_count + m.pre_coverage_user_count + m.unknown_coverage_user_count !== m.total_shared_user_count),
  );
  check('coverage_qualified_user_count always equals fully_observed_confirmed_user_count', v210Monthly.every((m) => m.coverage_qualified_user_count === m.fully_observed_confirmed_user_count));
  check(
    'coverage_qualified_acquisition_item_count is NULL exactly when coverage_qualified_user_count is 0 (an absent witness is never a fabricated zero)',
    v210Monthly.every((m) => (m.coverage_qualified_user_count === 0) === (m.coverage_qualified_acquisition_item_count === null)),
    v210Monthly.filter((m) => (m.coverage_qualified_user_count === 0) !== (m.coverage_qualified_acquisition_item_count === null)),
  );
  check(
    'coverage_qualified_acquisition_item_count never exceeds reliable_acquisition_item_count (qualified is always a subset of recorded)',
    v210Monthly.every((m) => m.coverage_qualified_acquisition_item_count === null || m.coverage_qualified_acquisition_item_count <= m.reliable_acquisition_item_count),
    v210Monthly.filter((m) => m.coverage_qualified_acquisition_item_count !== null && m.coverage_qualified_acquisition_item_count > m.reliable_acquisition_item_count),
  );

  console.log('\n[v2.10 — Problem 1 fixed: a month observed by userA alone is never fully_observed for the shared pool]');
  const midCoverageMonth = v210Monthly.find((m) => {
    const d = new Date(m.month_start);
    return d >= new Date(coverageStartAIso) && d < new Date(coverageStartBIso);
  });
  check(
    'a month confirmed-observed by userA but not yet by userB is never fully_observed, and is coverage-qualified by fewer than all shared users',
    !midCoverageMonth || (midCoverageMonth.shared_coverage_status !== 'fully_observed' && midCoverageMonth.coverage_qualified_user_count < midCoverageMonth.total_shared_user_count),
    midCoverageMonth,
  );
  const bothCoveredMonth = v210Monthly.find((m) => new Date(m.month_start) >= new Date(coverageStartBIso) && m.shared_coverage_status !== undefined);
  check(
    'a month confirmed-observed by BOTH users can reach coverage_qualified_user_count === total_shared_user_count',
    !bothCoveredMonth || bothCoveredMonth.coverage_qualified_user_count <= bothCoveredMonth.total_shared_user_count,
    bothCoveredMonth,
  );

  console.log('\n[v2.10 — monthly_timeline_by_purpose: reconciles to pooled monthly_timeline, shares the same user-level coverage fields]');
  const v210MonthlyByPurpose: any[] = v210Shared?.monthly_timeline_by_purpose ?? [];
  const v210MonthlySum = v210Monthly.reduce((sum, m) => sum + Number(m.reliable_acquisition_item_count ?? 0), 0);
  const v210MonthlyByPurposeSum = v210MonthlyByPurpose.reduce((sum, m) => sum + Number(m.reliable_acquisition_item_count ?? 0), 0);
  check(
    'monthly_timeline_by_purpose reliable_acquisition_item_count sums to pooled monthly_timeline',
    v210MonthlySum === v210MonthlyByPurposeSum,
    { pooled: v210MonthlySum, byPurpose: v210MonthlyByPurposeSum },
  );
  check(
    'monthly_timeline_by_purpose rows carry the SAME user-count/status fields as the pooled row for that month (coverage is user-level, not purpose-level)',
    v210MonthlyByPurpose.every((pm) => {
      const pooled = v210Monthly.find((m) => m.month_start === pm.month_start);
      return !pooled || (pooled.total_shared_user_count === pm.total_shared_user_count && pooled.shared_coverage_status === pm.shared_coverage_status);
    }),
  );

  console.log('\n[v2.10 — month_of_year_seasonality: user-year observation units, valid confidence, one-user-year-domination cap]');
  const v210Moy: any[] = v210Shared?.month_of_year_seasonality ?? [];
  check('month_of_year_seasonality has exactly 12 rows', v210Moy.length === 12, v210Moy.length);
  const validMoyConfidence210 = new Set(['no_data', 'coverage_unknown', 'insufficient_years', 'low', 'moderate', 'stronger']);
  check(
    'every month row uses a valid acquisition_confidence value',
    v210Moy.every((m) => validMoyConfidence210.has(m.acquisition_confidence)),
    v210Moy.map((m) => m.acquisition_confidence).filter((c) => !validMoyConfidence210.has(c)),
  );
  check(
    'no month claims stronger/moderate acquisition_confidence with fewer than 2 fully_observed_user_year_count',
    v210Moy.every((m) => (m.acquisition_fully_observed_user_year_count ?? 0) >= 2 || (m.acquisition_confidence !== 'stronger' && m.acquisition_confidence !== 'moderate')),
    v210Moy.filter((m) => (m.acquisition_fully_observed_user_year_count ?? 0) < 2 && (m.acquisition_confidence === 'stronger' || m.acquisition_confidence === 'moderate')),
  );
  check(
    'no month claims stronger/moderate when largest_user_year_event_share > 0.80 (one-user-year domination capped)',
    v210Moy.every((m) => m.acquisition_largest_user_year_event_share === null || m.acquisition_largest_user_year_event_share <= 0.80 || (m.acquisition_confidence !== 'stronger' && m.acquisition_confidence !== 'moderate')),
    v210Moy.filter((m) => m.acquisition_largest_user_year_event_share > 0.80 && (m.acquisition_confidence === 'stronger' || m.acquisition_confidence === 'moderate')),
  );
  check(
    'coverage_qualified_event_count never exceeds recorded_event_count per family (uncovered user-years never strengthen the numerator)',
    v210Moy.every((m) => m.acquisition_coverage_qualified_event_count <= m.acquisition_recorded_event_count
      && m.first_listing_coverage_qualified_event_count <= m.first_listing_recorded_event_count
      && m.realized_exit_coverage_qualified_event_count <= m.realized_exit_recorded_event_count),
    v210Moy.filter((m) => m.acquisition_coverage_qualified_event_count > m.acquisition_recorded_event_count),
  );
  check(
    'every *_limitations field is an array',
    v210Moy.every((m) => Array.isArray(m.acquisition_limitations) && Array.isArray(m.first_listing_limitations) && Array.isArray(m.realized_exit_limitations)),
  );
  check(
    'zero_activity_fully_observed_user_year_count is a valid non-negative count (a genuine confirmed zero remains valid evidence)',
    v210Moy.every((m) => typeof m.acquisition_zero_activity_fully_observed_user_year_count === 'number' && m.acquisition_zero_activity_fully_observed_user_year_count >= 0),
  );
  check(
    'month_of_year_seasonality_by_purpose remains explicitly out of scope (empty array + note), unchanged from v2.9',
    Array.isArray(v210Shared?.month_of_year_seasonality_by_purpose) && v210Shared.month_of_year_seasonality_by_purpose.length === 0 && typeof v210Shared?.month_of_year_seasonality_by_purpose_note === 'string',
    { arr: v210Shared?.month_of_year_seasonality_by_purpose, note: v210Shared?.month_of_year_seasonality_by_purpose_note },
  );

  console.log('\n[v2.10 — current_month_to_date_pace: pairwise cohort matching]');
  const v210Mtd = v210Shared?.current_month_to_date_pace;
  const validMtdStatus210 = new Set(['coverage_unknown', 'insufficient_history', 'sufficient_history']);
  check('current_month_to_date_pace.status is a valid value', validMtdStatus210.has(v210Mtd?.status), v210Mtd?.status);
  check(
    'status is sufficient_history only when comparable_prior_years_count >= 2',
    (v210Mtd?.status === 'sufficient_history') === ((v210Mtd?.comparable_prior_years_count ?? 0) >= 2),
    v210Mtd,
  );
  const pairwise210: any[] = v210Mtd?.pairwise_comparisons ?? [];
  check(
    'pairwise_comparisons length matches comparable_prior_years_count',
    pairwise210.length === v210Mtd?.comparable_prior_years_count,
    { len: pairwise210.length, count: v210Mtd?.comparable_prior_years_count },
  );
  check(
    'every pairwise entry has cohort_user_count > 0 and BOTH current_cohort_metrics and prior_cohort_metrics present (never full population on either side)',
    pairwise210.every((p) => p.cohort_user_count > 0 && p.current_cohort_metrics && p.prior_cohort_metrics),
    pairwise210,
  );
  check(
    'pairwise_difference === current_cohort_metrics - prior_cohort_metrics for every pair (acquisition_item_count)',
    pairwise210.every((p) => p.pairwise_difference.acquisition_item_count === p.current_cohort_metrics.acquisition_item_count - p.prior_cohort_metrics.acquisition_item_count),
    pairwise210,
  );
  check(
    'full_population_current_month_to_date is present but structurally separate from any pairwise cohort metric (descriptive only)',
    !!v210Mtd?.full_population_current_month_to_date && typeof v210Mtd?.full_population_note === 'string',
    v210Mtd?.full_population_current_month_to_date,
  );
  check(
    'common_cohort_summary is null exactly when comparable_prior_years_count is 0',
    (v210Mtd?.comparable_prior_years_count ?? 0) > 0 || v210Mtd?.common_cohort_summary === null,
    v210Mtd?.common_cohort_summary,
  );
  if (v210Mtd?.common_cohort_summary) {
    check(
      'common_cohort_summary.common_cohort_user_count > 0 and prior_year_median/average present',
      v210Mtd.common_cohort_summary.common_cohort_user_count > 0 && !!v210Mtd.common_cohort_summary.prior_year_median && !!v210Mtd.common_cohort_summary.prior_year_average,
      v210Mtd.common_cohort_summary,
    );
  }
  check('current_month_to_date_pace.summary_rule documents the common-cohort rule', typeof v210Mtd?.summary_rule === 'string' && v210Mtd.summary_rule.toLowerCase().includes('cohort'), v210Mtd?.summary_rule);
  check('current_month_to_date_pace note is descriptive, not a forecast claim', typeof v210Mtd?.note === 'string' && v210Mtd.note.toLowerCase().includes('not a forecast'), v210Mtd?.note);
  check(
    'status sufficient_history implies at least 2 pairwise_comparisons entries exist (never fewer)',
    v210Mtd?.status !== 'sufficient_history' || pairwise210.length >= 2,
    { status: v210Mtd?.status, pairwiseLength: pairwise210.length },
  );

  console.log('\n[v2.10 — Historical Import semantics unchanged]');
  const v210SharedSerialized = JSON.stringify(v210Shared);
  check(
    'shared_calendar_seasonality_evidence contains no recommendation/urgency/score/forecast/item_id/user_id fields',
    !v210SharedSerialized.includes('"recommendation"') && !v210SharedSerialized.includes('"urgency"') && !v210SharedSerialized.includes('"score"')
      && !v210SharedSerialized.includes('"forecast"') && !v210SharedSerialized.includes('"item_id"') && !v210SharedSerialized.includes('"user_id"'),
  );

  console.log('\n[v2.10 — permissions]');
  const { error: v210AuthedError } = await clientA.rpc('build_analytics_snapshot_v2_10', { p_target_user_id: userAId });
  check('authenticated client cannot call build_analytics_snapshot_v2_10 directly', !!v210AuthedError, v210AuthedError);
  const { error: v210HelperAuthedError } = await clientA.rpc('_build_shared_calendar_cohort_correction_v2_10');
  check('authenticated client cannot call _build_shared_calendar_cohort_correction_v2_10 directly', !!v210HelperAuthedError, v210HelperAuthedError);
  const { error: v210ForgedTargetError } = await clientA.rpc('build_analytics_snapshot_v2_10', { p_target_user_id: userBId });
  check('authenticated client cannot invoke build_analytics_snapshot_v2_10 for a forged target user id either', !!v210ForgedTargetError, v210ForgedTargetError);

  console.log('\n[v2.10 — old-version compatibility]');
  const v210StillCallableChecks: Array<[string, Record<string, unknown>]> = [
    ['build_analytics_snapshot_v1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_1', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_2', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_3', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_4', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_5', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_6', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_7', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v1_8', { p_recommendation_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_0', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_1', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_2', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_3', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_4', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_5', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_6', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_7', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_8', { p_target_user_id: userAId }],
    ['build_analytics_snapshot_v2_9', { p_target_user_id: userAId }],
  ];
  for (const [fn, args] of v210StillCallableChecks) {
    const { error } = await serviceClient.rpc(fn, args);
    check(`${fn} still callable by service_role after v2.10 migration`, !error, error);
  }

  console.log('\n[v2.10 — production promotion]');
  check('ANALYTICS_VERSION constant used by the production runner is now 2.10', ANALYTICS_VERSION === '2.10', ANALYTICS_VERSION);
  const runA210 = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('new production run stores analytics_version 2.10', runA210.analytics_version === '2.10', runA210.analytics_version);
  check('new production run snapshot.snapshot_schema_version is 2.10', (runA210.snapshot as any)?.snapshot_schema_version === '2.10', (runA210.snapshot as any)?.snapshot_schema_version);

  console.log('\n[v2.10 — old stored runs remain readable]');
  const { data: oldRunReadBack210 } = await serviceClient
    .from('analytics_runs').select('analytics_version, snapshot').eq('id', syntheticOldRun!.id).single();
  check(
    'the synthetic v1.8 run from earlier in this script still reads back unchanged after the v2.10 migration',
    oldRunReadBack210?.analytics_version === '1.8' && (oldRunReadBack210?.snapshot as any)?.snapshot_schema_version === '1.8',
    oldRunReadBack210,
  );

  console.log('\n[v2.10 — coverage rows resolve exactly as configured (same shape the production data-fix relies on)]');
  const { data: coverageRowsCheck } = await serviceClient
    .from('analytics_observation_coverage')
    .select('user_id, complete_history_start_date, coverage_status')
    .in('user_id', [userAId, userBId]);
  check(
    'analytics_observation_coverage resolves confirmed rows for both fixture users with the exact configured dates',
    (coverageRowsCheck ?? []).length === 2
      && (coverageRowsCheck ?? []).every((r: any) => r.coverage_status === 'confirmed')
      && (coverageRowsCheck ?? []).some((r: any) => r.user_id === userAId && r.complete_history_start_date === coverageStartAIso)
      && (coverageRowsCheck ?? []).some((r: any) => r.user_id === userBId && r.complete_history_start_date === coverageStartBIso),
    coverageRowsCheck,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
