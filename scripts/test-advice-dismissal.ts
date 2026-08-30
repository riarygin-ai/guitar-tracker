/**
 * scripts/test-advice-dismissal.ts
 *
 * Focused validation for Advice Dismissal / Resurface v1
 * (src/lib/analytics/advice/adviceKey.ts,
 * src/app/api/analytics/advice/dismiss/route.ts,
 * supabase/migrations/20260906000000_analytics_advice_dismissals.sql, and
 * the getActiveAdviceDismissalKeysForCurrentUser + Dashboard filtering
 * logic in src/lib/supabase.ts / src/app/page.tsx). Same conventions as
 * scripts/test-analytics-advice.ts and scripts/test-weekly-automation.ts —
 * tsx, no test framework, local `check()`, safety-gated against a
 * disposable local Supabase instance only.
 *
 * Every completed analytics_run_advice row used here is inserted DIRECTLY
 * (service role) with a hand-built `advice` JSON — never a real OpenAI
 * call — so this script costs nothing to run and never depends on
 * OPENAI_API_KEY. The route under test (POST /api/analytics/advice/
 * dismiss) is exercised by dynamically importing its POST handler and
 * constructing real NextRequest objects, exactly like
 * scripts/test-weekly-automation.ts already does for the cron/status
 * routes — never an actual HTTP server.
 *
 * Usage:
 *   npx tsx scripts/test-advice-dismissal.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
  setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { computeAdviceKey } from '../src/lib/analytics/advice/adviceKey';
import type { AdviceCard, StructuredAdviceResponse } from '../src/lib/analytics/advice/types';

const ANON_KEY = SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

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

// ── Fixture builder: a dedicated completed analytics_run_advice revision,
// with a caller-supplied advice_cards array, inserted directly (no OpenAI,
// no validateAdviceResponse — the route under test never re-validates the
// stored advice shape, only looks up a card by advice_code within it). ────
async function createCompletedAdviceRow(
  serviceClient: SupabaseClient,
  ownerId: number,
  cards: AdviceCard[],
): Promise<{ runId: number; adviceRowId: number }> {
  const { data: run, error: runError } = await serviceClient
    .from('analytics_runs')
    .insert({
      requested_by_user_id: ownerId,
      recommendation_target_user_id: ownerId,
      analytics_version: '1.8',
      evidence_scope: 'shared_business_population',
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      snapshot: { snapshot_schema_version: '1.8', analytics_definition_version: '1.8', generated_at: new Date().toISOString(), evidence_scope: 'shared_business_population' },
    })
    .select('id')
    .single();
  if (runError || !run) throw new Error(`Failed to create dedicated run fixture: ${runError?.message}`);

  const advice: StructuredAdviceResponse = {
    schema_version: '1.0',
    run_summary: { headline: 'Test run summary', summary: 'Synthetic fixture summary.', source_ids: [] },
    advice_cards: cards,
    limitations: [],
  };

  const { data: adviceRow, error: adviceError } = await serviceClient
    .from('analytics_run_advice')
    .insert({
      analytics_run_id: run.id,
      user_id: ownerId,
      revision_number: 1,
      status: 'completed',
      provider: 'openai',
      model: 'test-fixture-model',
      advice_schema_version: '1.0',
      prompt_template_version: 'analytics-advice-v1',
      canonical_input_hash: 'a'.repeat(64),
      input_packet: { packet_version: '1.0', marker: 'fixture' },
      advice,
      source_refs: [],
      generated_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (adviceError || !adviceRow) throw new Error(`Failed to create completed advice fixture row: ${adviceError?.message}`);

  return { runId: run.id as number, adviceRowId: adviceRow.id as number };
}

function card(overrides: Partial<AdviceCard>): AdviceCard {
  return {
    advice_code: 'C1',
    advice_type: 'review',
    priority: 'medium',
    headline: 'Heritage review',
    advice: 'Consider reviewing the Heritage listing.',
    why_it_matters: 'It has been open a while.',
    confidence_label: 'moderate',
    source_ids: ['insight:SOME_FINDING:item:42'],
    limitations: [],
    item_id: 42,
    ...overrides,
  };
}

/** Mirrors the Dashboard's own visibleAdviceCards filter exactly (src/app/
 *  page.tsx) — pure logic, no React, so the same rule is exercised here. */
function filterVisible(cards: AdviceCard[], dismissedKeys: Set<string>): AdviceCard[] {
  return cards.filter((c) => !dismissedKeys.has(computeAdviceKey(c)));
}

async function main() {
  // ── Safety gate ───────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SERVICE_ROLE_KEY);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('\n[fixtures] Ensuring local analytics test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(serviceClient);
  const userAId = fixtures.userAId;
  const userBId = fixtures.userBId;
  const tokenA = await signIn(fixtures.userAEmail, fixtures.password);
  const tokenB = await signIn(fixtures.userBEmail, fixtures.password);

  const clientA = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${tokenA}` } }, auth: { persistSession: false } });
  const clientB = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${tokenB}` } }, auth: { persistSession: false } });

  // The route module reads these at import time — never sourced from
  // .env.local, only the same local-dev demo values setup-analytics-
  // test-fixtures.ts itself defaults to (see its own header comment).
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = SUPABASE_ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

  const { POST: dismissPost } = await import('../src/app/api/analytics/advice/dismiss/route');
  const { NextRequest } = await import('next/server');
  const DISMISS_URL = 'http://localhost/api/analytics/advice/dismiss';

  function postDismiss(token: string | null, body: unknown) {
    return dismissPost(new NextRequest(DISMISS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }));
  }

  const createdRunIds: number[] = [];
  async function cleanupRun(runId: number) {
    await serviceClient.from('analytics_runs').delete().eq('id', runId);
  }
  async function cleanupDismissal(userId: number, adviceKey: string) {
    await serviceClient.from('analytics_advice_dismissals').delete().eq('user_id', userId).eq('advice_key', adviceKey);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Section A — computeAdviceKey (pure, no DB)
  //
  // v2 regression coverage (post-ship audit of commit 6a24a73's v1
  // algorithm found two fragility bugs, both fixed here — see
  // src/lib/analytics/advice/adviceKey.ts's own header for the full
  // rationale):
  //   1. advice_type is LLM-chosen, not deterministic -> must never affect
  //      the key.
  //   2. the full source_ids set is not guaranteed stable across runs (the
  //      model may add/drop a non-primary supporting source while the core
  //      condition is unchanged) -> only a single mechanically-selected
  //      PRIMARY source may affect the key.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A — computeAdviceKey identity rules]');

  const heritageV1 = card({ advice_code: 'C1', headline: 'Heritage review', advice: 'Please review Heritage.', source_ids: ['insight:LONG_DOM:item:42'], item_id: 42 });
  const heritageV2Reworded = card({ advice_code: 'C7', headline: 'Consider Heritage', advice: 'Totally different wording this week.', why_it_matters: 'New phrasing.', confidence_label: 'stronger', priority: 'high', source_ids: ['insight:LONG_DOM:item:42'], item_id: 42 });
  check('same item_id/primary source -> identical advice_key even when advice_code/headline/advice/why_it_matters/confidence_label/priority all differ (wording changes never affect identity)', computeAdviceKey(heritageV1) === computeAdviceKey(heritageV2Reworded));

  const differentItem = card({ item_id: 99, source_ids: ['insight:LONG_DOM:item:99'] });
  check('a different item_id produces a different advice_key', computeAdviceKey(heritageV1) !== computeAdviceKey(differentItem));

  const differentItemJustifyingFinding = card({ source_ids: ['insight:OTHER_FINDING:item:42'] });
  check('a genuinely different item-justifying finding_code (same item) produces a different advice_key', computeAdviceKey(heritageV1) !== computeAdviceKey(differentItemJustifyingFinding));

  // ── Regression: advice_type must NEVER affect identity (audit finding 1) ──
  for (const type of ['action', 'observation', 'watch', 'review'] as const) {
    check(`advice_type "${type}" alone never changes the advice_key (LLM-chosen, excluded from identity)`, computeAdviceKey(card({ advice_type: type, source_ids: heritageV1.source_ids, item_id: heritageV1.item_id })) === computeAdviceKey(heritageV1));
  }

  // ── Regression: priority/confidence_label alone must never affect identity ──
  check('priority alone never changes the advice_key', computeAdviceKey(card({ priority: 'low', source_ids: heritageV1.source_ids, item_id: heritageV1.item_id })) === computeAdviceKey(heritageV1));
  check('confidence_label alone never changes the advice_key', computeAdviceKey(card({ confidence_label: 'preliminary', source_ids: heritageV1.source_ids, item_id: heritageV1.item_id })) === computeAdviceKey(heritageV1));

  const sameSourcesDifferentOrder = card({ source_ids: ['insight:B:item:42', 'insight:A:item:42'] });
  const sameSourcesOriginalOrder = card({ source_ids: ['insight:A:item:42', 'insight:B:item:42'] });
  check('source_ids order never affects advice_key (sorted before keying)', computeAdviceKey(sameSourcesDifferentOrder) === computeAdviceKey(sameSourcesOriginalOrder));

  // ── Regression: an item-level card gaining or losing a NON-primary
  // supporting source (the model citing an extra corroborating pattern
  // one week, or not, while the item's own justifying finding is
  // unchanged) must never affect the key (audit finding 2). ───────────────
  const itemCardWithOnlyItsOwnSource = card({ item_id: 42, source_ids: ['insight:LONG_DOM:item:42'] });
  const itemCardWithExtraSupportingPattern = card({ item_id: 42, source_ids: ['insight:LONG_DOM:item:42', 'pattern:DISCOVERY|CATEGORY|category_id=9'] });
  check('an item-level card citing an EXTRA non-primary supporting pattern still keys identically to the same card without it', computeAdviceKey(itemCardWithOnlyItsOwnSource) === computeAdviceKey(itemCardWithExtraSupportingPattern));
  const itemCardWithExtraHypothesis = card({ item_id: 42, source_ids: ['insight:LONG_DOM:item:42', 'hypothesis:CATEGORY|category_id=9'] });
  check('an item-level card citing an extra supporting HYPOTHESIS also keys identically (still anchored on the item-justifying source)', computeAdviceKey(itemCardWithOnlyItsOwnSource) === computeAdviceKey(itemCardWithExtraHypothesis));

  const portfolioLevel = card({ item_id: null, source_ids: ['pattern:DISCOVERY|CATEGORY|category_id=1'] });
  const portfolioLevelSameSources = card({ item_id: null, source_ids: ['pattern:DISCOVERY|CATEGORY|category_id=1'], headline: 'Reworded portfolio advice' });
  check('portfolio-level advice (item_id null) is stable across wording changes too', computeAdviceKey(portfolioLevel) === computeAdviceKey(portfolioLevelSameSources));
  check('portfolio-level advice_key differs from an item-specific one citing the same source', computeAdviceKey(portfolioLevel) !== computeAdviceKey(card({ item_id: 5, source_ids: portfolioLevel.source_ids })));

  // ── Regression: a portfolio-level card gaining a NON-primary supporting
  // hypothesis alongside its already-cited confirmed pattern must not
  // change the key (pattern outranks hypothesis in the fixed priority). ──
  const portfolioWithExtraHypothesis = card({ item_id: null, source_ids: ['pattern:DISCOVERY|CATEGORY|category_id=1', 'hypothesis:CHANNEL|channel_id=7'] });
  check('a portfolio-level card citing an extra supporting hypothesis alongside its confirmed pattern keys identically to the pattern alone', computeAdviceKey(portfolioLevel) === computeAdviceKey(portfolioWithExtraHypothesis));

  // ── Regression: swapping which pattern is actually cited (a genuinely
  // different confirmed pattern, not an added extra) DOES change the key —
  // "genuinely different deterministic conditions still produce a
  // different key" must keep holding under the new algorithm too. ────────
  const portfolioDifferentPattern = card({ item_id: null, source_ids: ['pattern:DISCOVERY|CHANNEL|channel_id=3'] });
  check('a genuinely different confirmed pattern (not an addition) produces a different advice_key', computeAdviceKey(portfolioLevel) !== computeAdviceKey(portfolioDifferentPattern));

  // ══════════════════════════════════════════════════════════════════════
  // Section B — cross-run resurface simulation (pure filter logic, mirrors
  // src/app/page.tsx's visibleAdviceCards exactly)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B — Dashboard filter simulation across "runs"]');

  const run1Cards = [heritageV1, card({ advice_code: 'C2', advice_type: 'watch', item_id: null, source_ids: ['pattern:DISCOVERY|CHANNEL|channel_id=3'], headline: 'Category watch' })];
  const dismissedAfterRun1 = new Set([computeAdviceKey(heritageV1)]);
  const visibleRun1 = filterVisible(run1Cards, dismissedAfterRun1);
  check('dismissing one card hides only that card, not the other card in the same revision', visibleRun1.length === 1 && visibleRun1[0].advice_code === 'C2');

  const run2CardsSameHeritageReworded = [heritageV2Reworded, card({ advice_code: 'C9', advice_type: 'watch', item_id: null, source_ids: ['pattern:DISCOVERY|CHANNEL|channel_id=3'], headline: 'Category watch (reworded)' })];
  const visibleRun2WhileStillDismissed = filterVisible(run2CardsSameHeritageReworded, dismissedAfterRun1);
  check('the same semantic advice reappearing in a LATER run (reworded) remains hidden while still within the dismissal window', visibleRun2WhileStillDismissed.length === 1 && visibleRun2WhileStillDismissed[0].advice_code === 'C9');

  const visibleRun2AfterExpiry = filterVisible(run2CardsSameHeritageReworded, new Set());
  check('once the dismissal is no longer active, the same card is shown again if the latest run still contains it', visibleRun2AfterExpiry.length === 2);

  const run3WithoutHeritageAtAll = [card({ advice_code: 'C3', advice_type: 'watch', item_id: null, source_ids: ['pattern:DISCOVERY|CHANNEL|channel_id=9'], headline: 'A genuinely different watch' })];
  const visibleRun3 = filterVisible(run3WithoutHeritageAtAll, dismissedAfterRun1);
  check('30 days passing never force-creates advice: an unrelated dismissal never hides genuinely different advice', visibleRun3.length === 1);

  // ══════════════════════════════════════════════════════════════════════
  // Section C — dismiss API route: auth, ownership, identity recompute
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[C — POST /api/analytics/advice/dismiss]');

  const cardX = card({ advice_code: 'CX', advice_type: 'review', item_id: 42, source_ids: ['insight:LONG_DOM:item:42'], headline: 'Heritage review' });
  const cardY = card({ advice_code: 'CY', advice_type: 'watch', item_id: null, source_ids: ['pattern:DISCOVERY|CHANNEL|channel_id=3'], headline: 'Category watch' });
  const { runId: runIdA, adviceRowId: adviceRowIdA } = await createCompletedAdviceRow(serviceClient, userAId, [cardX, cardY]);
  createdRunIds.push(runIdA);

  const noAuthRes = await postDismiss(null, { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'CX' });
  check('missing Authorization header returns 401', noAuthRes.status === 401);

  const badTokenRes = await postDismiss('not-a-real-token', { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'CX' });
  check('an invalid/garbage bearer token is handled safely (401, not a throw/500)', badTokenRes.status === 401);

  const badBodyRes = await dismissPost(new NextRequest(DISMISS_URL, { method: 'POST', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, body: '{not json' }));
  check('malformed JSON body returns 400, not a throw', badBodyRes.status === 400);

  const invalidIdRes = await postDismiss(tokenA, { analyticsRunAdviceId: -5, adviceCode: 'CX' });
  check('a non-positive analyticsRunAdviceId returns 400', invalidIdRes.status === 400);

  const missingCodeRes = await postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdA, adviceCode: '' });
  check('an empty adviceCode returns 400', missingCodeRes.status === 400);

  const unknownCodeRes = await postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'DOES_NOT_EXIST' });
  check('an adviceCode that does not exist on the revision returns 404', unknownCodeRes.status === 404);

  const crossUserRes = await postDismiss(tokenB, { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'CX' });
  check('another user cannot dismiss a card on a revision they do not own (404, same as not-found — never reveals it exists)', crossUserRes.status === 404);
  const { count: crossUserLeftover } = await serviceClient.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userBId).eq('advice_key', computeAdviceKey(cardX));
  check('the rejected cross-user attempt created no dismissal row for user B', (crossUserLeftover ?? 0) === 0);

  // No user_id can be spoofed from client input — inject a bogus user_id
  // (pointed at user B) into the body alongside a legitimate request; the
  // resulting row must belong to the AUTHENTICATED caller (user A), never
  // the injected value.
  const spoofAttemptRes = await postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'CX', user_id: userBId });
  check('a request succeeds even when a bogus user_id is present in the body (200)', spoofAttemptRes.status === 200);
  const spoofKey = computeAdviceKey(cardX);
  const { data: spoofRow } = await serviceClient.from('analytics_advice_dismissals').select('user_id').eq('user_id', userAId).eq('advice_key', spoofKey).maybeSingle();
  check('the created row is owned by the AUTHENTICATED caller (user A), never a user_id injected in the request body', !!spoofRow && spoofRow.user_id === userAId, spoofRow);
  const { count: noSpoofForB } = await serviceClient.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userBId).eq('advice_key', spoofKey);
  check('no row was ever created for the injected/spoofed user_id', (noSpoofForB ?? 0) === 0);

  const firstDismissBody = await spoofAttemptRes.json();
  check('response reports dismissed: true', firstDismissBody.dismissed === true, firstDismissBody);
  const firstResurfaceAfter = new Date(firstDismissBody.resurface_after as string);
  const { data: firstRow } = await serviceClient.from('analytics_advice_dismissals').select('advice_key, dismissed_at, resurface_after').eq('user_id', userAId).eq('advice_key', spoofKey).single();
  check('the persisted advice_key matches computeAdviceKey() for the dismissed card — server recompute agrees with the client-side algorithm', firstRow?.advice_key === computeAdviceKey(cardX), firstRow);
  const deltaMs = firstResurfaceAfter.getTime() - new Date(firstRow!.dismissed_at as string).getTime();
  check('resurface_after is exactly dismissed_at + 30 days', Math.abs(deltaMs - 30 * 24 * 60 * 60 * 1000) < 2000, { deltaMs });

  // ── Row wasn't stored with any advice text ────────────────────────────
  const { data: allColsRow } = await serviceClient.from('analytics_advice_dismissals').select('*').eq('user_id', userAId).eq('advice_key', spoofKey).single();
  const rowJson = JSON.stringify(allColsRow);
  check('the dismissal row never stores the advice headline/advice text', !rowJson.includes('Heritage review') && !rowJson.includes('Consider reviewing'), allColsRow);

  // ── Cross-user isolation: read access ──────────────────────────────────
  const { data: aOwnRead } = await clientA.from('analytics_advice_dismissals').select('id').eq('advice_key', spoofKey);
  check('user A can read their own dismissal row via RLS', (aOwnRead?.length ?? 0) === 1, aOwnRead);
  const { data: bCannotRead } = await clientB.from('analytics_advice_dismissals').select('id').eq('advice_key', spoofKey);
  check('user B cannot read user A\'s dismissal row via RLS (isolated)', (bCannotRead?.length ?? 0) === 0, bCannotRead);

  // ── A DIFFERENT card on the same revision is unaffected ────────────────
  const { count: cardYDismissedCount } = await serviceClient.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userAId).eq('advice_key', computeAdviceKey(cardY));
  check('dismissing card X never suppresses the unrelated card Y from the same revision', (cardYDismissedCount ?? 0) === 0);

  // ── UNIQUE (user_id, advice_key) is a real DB constraint, not just an
  // application convention — insert a duplicate directly, bypassing the
  // route/upsert entirely. ────────────────────────────────────────────────
  const { error: directDuplicateError } = await serviceClient.from('analytics_advice_dismissals').insert({
    user_id: userAId, advice_key: spoofKey, dismissed_at: new Date().toISOString(), resurface_after: new Date(Date.now() + 1000).toISOString(),
  });
  check('UNIQUE (user_id, advice_key) is enforced at the DB level — a raw duplicate insert is rejected', directDuplicateError !== null, directDuplicateError);

  // ── Double-click: two concurrent dismiss requests for the SAME card
  // never create two rows. ────────────────────────────────────────────────
  const cardZ = card({ advice_code: 'CZ', advice_type: 'observation', item_id: 7, source_ids: ['insight:DOUBLE_CLICK:item:7'], headline: 'Double-click target' });
  const { runId: runIdDbl, adviceRowId: adviceRowIdDbl } = await createCompletedAdviceRow(serviceClient, userAId, [cardZ]);
  createdRunIds.push(runIdDbl);
  const [concurrent1, concurrent2] = await Promise.all([
    postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdDbl, adviceCode: 'CZ' }),
    postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdDbl, adviceCode: 'CZ' }),
  ]);
  check('two concurrent dismiss requests for the same card both succeed', concurrent1.status === 200 && concurrent2.status === 200);
  const { count: concurrentRowCount } = await serviceClient.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userAId).eq('advice_key', computeAdviceKey(cardZ));
  check('double-click / concurrent dismiss never creates duplicate rows (exactly one row)', concurrentRowCount === 1, concurrentRowCount);
  await cleanupDismissal(userAId, computeAdviceKey(cardZ));

  // ── Re-dismissing a resurfaced card starts a FRESH 30-day period ───────
  // Simulate "already resurfaced": backdate resurface_after into the past.
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await serviceClient.from('analytics_advice_dismissals').update({ resurface_after: pastDate }).eq('user_id', userAId).eq('advice_key', spoofKey);
  const redismissRes = await postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'CX' });
  check('re-dismissing a card whose dismissal already resurfaced succeeds (200)', redismissRes.status === 200);
  const { data: refreshedRow } = await serviceClient.from('analytics_advice_dismissals').select('resurface_after').eq('user_id', userAId).eq('advice_key', spoofKey).single();
  check('re-dismissing refreshes resurface_after to a fresh ~30-day window, not the stale backdated value', new Date(refreshedRow!.resurface_after as string).getTime() > Date.now() + 29 * 24 * 60 * 60 * 1000, refreshedRow);
  const { count: stillOneRowAfterRedismiss } = await serviceClient.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userAId).eq('advice_key', spoofKey);
  check('re-dismissing updates the existing row rather than inserting a second one', stillOneRowAfterRedismiss === 1, stillOneRowAfterRedismiss);

  // ══════════════════════════════════════════════════════════════════════
  // Section D — 30-day boundary + Dashboard "active dismissals" query
  // (mirrors getActiveAdviceDismissalKeysForCurrentUser's own .gt() filter
  // exactly: resurface_after > now() -> hidden; resurface_after <= now()
  // -> eligible/not hidden).
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[D — 30-day boundary]');

  const boundaryKey = computeAdviceKey(card({ advice_code: 'BOUNDARY', item_id: 555, source_ids: ['insight:BOUNDARY:item:555'] }));
  const nowIso = new Date().toISOString();

  await serviceClient.from('analytics_advice_dismissals').insert({ user_id: userAId, advice_key: boundaryKey, dismissed_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), resurface_after: new Date(Date.now() - 1000).toISOString() });
  {
    const { data: activeCheck } = await serviceClient.from('analytics_advice_dismissals').select('advice_key').eq('user_id', userAId).eq('advice_key', boundaryKey).gt('resurface_after', nowIso);
    check('resurface_after 1s in the PAST is excluded from the active set (eligible to reappear)', (activeCheck?.length ?? 0) === 0);
  }
  await cleanupDismissal(userAId, boundaryKey);

  await serviceClient.from('analytics_advice_dismissals').insert({ user_id: userAId, advice_key: boundaryKey, dismissed_at: new Date().toISOString(), resurface_after: new Date(Date.now() + 1000).toISOString() });
  {
    const { data: activeCheck } = await serviceClient.from('analytics_advice_dismissals').select('advice_key').eq('user_id', userAId).eq('advice_key', boundaryKey).gt('resurface_after', nowIso);
    check('resurface_after 1s in the FUTURE is included in the active set (still hidden)', (activeCheck?.length ?? 0) === 1);
  }
  await cleanupDismissal(userAId, boundaryKey);

  // Exact-equality boundary (resurface_after === now): `.gt()` is a strict
  // greater-than, so a row exactly at "now" is never counted as active —
  // matches the task's own "resurface_after <= now() -> eligible" rule
  // (equal counts as eligible, not hidden). Verified directly with a
  // literal timestamp used both to insert and to filter, so there is no
  // reliance on this script's clock matching the database's.
  const exactNow = new Date().toISOString();
  await serviceClient.from('analytics_advice_dismissals').insert({ user_id: userAId, advice_key: boundaryKey, dismissed_at: new Date(Date.now() - 60_000).toISOString(), resurface_after: exactNow });
  {
    const { data: exactBoundaryCheck } = await serviceClient.from('analytics_advice_dismissals').select('advice_key').eq('user_id', userAId).eq('advice_key', boundaryKey).gt('resurface_after', exactNow);
    check('resurface_after exactly equal to "now" is excluded from the active set (<=  now -> eligible, per spec)', (exactBoundaryCheck?.length ?? 0) === 0);
  }
  await cleanupDismissal(userAId, boundaryKey);

  // ══════════════════════════════════════════════════════════════════════
  // Section E — schema-level guarantees
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[E — schema constraints]');

  const { error: resurfaceBeforeDismissError } = await serviceClient.from('analytics_advice_dismissals').insert({
    user_id: userAId, advice_key: 'schema-check-key', dismissed_at: new Date().toISOString(), resurface_after: new Date(Date.now() - 60_000).toISOString(),
  });
  check('resurface_after must be strictly after dismissed_at (CHECK constraint rejects resurface_after in the past relative to dismissed_at)', resurfaceBeforeDismissError !== null, resurfaceBeforeDismissError);

  const { error: emptyKeyError } = await serviceClient.from('analytics_advice_dismissals').insert({
    user_id: userAId, advice_key: '   ', dismissed_at: new Date().toISOString(), resurface_after: new Date(Date.now() + 60_000).toISOString(),
  });
  check('a blank advice_key is rejected (CHECK constraint)', emptyKeyError !== null, emptyKeyError);

  // ══════════════════════════════════════════════════════════════════════
  // Section F — Run Detail integrity: dismissal never touches
  // analytics_run_advice at all.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[F — Run Detail / analytics_run_advice untouched by dismissal]');

  const { data: adviceRowBefore } = await serviceClient.from('analytics_run_advice').select('advice, updated_at').eq('id', adviceRowIdA).single();
  await postDismiss(tokenA, { analyticsRunAdviceId: adviceRowIdA, adviceCode: 'CY' });
  const { data: adviceRowAfter } = await serviceClient.from('analytics_run_advice').select('advice, updated_at').eq('id', adviceRowIdA).single();
  check(
    'dismissing a card never mutates the analytics_run_advice row it came from — Run Detail always shows the complete, original Advice',
    JSON.stringify(adviceRowBefore?.advice) === JSON.stringify(adviceRowAfter?.advice) && adviceRowBefore?.updated_at === adviceRowAfter?.updated_at,
    { adviceRowBefore, adviceRowAfter },
  );
  const cardsAfterDismissStillPresent = (adviceRowAfter?.advice as StructuredAdviceResponse).advice_cards;
  check('both CX and CY are still present in the stored revision after CX was dismissed (dismissal is presentation-only)', cardsAfterDismissStillPresent.some((c) => c.advice_code === 'CX') && cardsAfterDismissStillPresent.some((c) => c.advice_code === 'CY'));
  await cleanupDismissal(userAId, computeAdviceKey(cardY));

  // ── Cleanup ──────────────────────────────────────────────────────────
  await cleanupDismissal(userAId, spoofKey);
  for (const runId of createdRunIds) await cleanupRun(runId);
  const { count: leftoverDismissalRows } = await serviceClient.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userAId);
  check('cleanup: no leftover analytics_advice_dismissals rows for user A after this script', (leftoverDismissalRows ?? 0) === 0, leftoverDismissalRows);
  const { count: leftoverRunRows } = await serviceClient.from('analytics_runs').select('id', { count: 'exact', head: true }).in('id', createdRunIds);
  check('cleanup: all fixture runs (and their cascaded advice rows) deleted', (leftoverRunRows ?? 0) === 0, leftoverRunRows);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
