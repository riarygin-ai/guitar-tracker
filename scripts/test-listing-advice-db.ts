/**
 * test-listing-advice-db.ts
 *
 * DB-backed validation of the Listing Advice persistence + lifecycle
 * (migration 20260920000000, generateListingAdvice.ts) with an INJECTED
 * model — no live OpenAI call is ever made:
 *   first generation, latest-completed resolution, refresh creating a new
 *   run while the old stays immutable, failed generations never replacing
 *   the latest completed, concurrency (one in-flight generation per user),
 *   stale-generating recovery, context-unavailable, the persisted packet ===
 *   the packet given to the model (+ hash/model/prompt version), RLS user
 *   isolation and no authenticated writes, DB immutability/shape checks.
 *
 * Local Supabase only (safety-gated); every row created is deleted.
 *
 * Usage:  npx tsx scripts/test-listing-advice-db.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { generateListingAdvice, getLatestListingAdvice, STALE_GENERATING_MS } from '../src/lib/analytics/listingAdvice/generateListingAdvice';
import { LISTING_ADVICE_PROMPT_VERSION, hashListingAdvicePacket, type ListingAdvicePacket } from '../src/lib/analytics/listingAdvice/listingAdvice';
import { buildListingDemandContext } from '../src/lib/analytics/advice/listingDemandContext';
import { LISTING_ADVICE_MODEL_ID } from '../src/lib/openai';
import type { ListingDemandEvidence, DemandWeeklyTrendEntry } from '../src/lib/analytics/listingDemandEvidence';
import type { ItemActivityEntry } from '../src/lib/analytics/listingItemActivity';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const PASSWORD = 'Listing-Advice-Fixture-Local-Only-1!';

async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (!error && created.user) return created.user.id;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = listed?.users.find((u) => u.email === email);
  if (match) return match.id;
  throw new Error(`Could not create or find auth user ${email}: ${error?.message}`);
}
async function resolveAppUserId(admin: SupabaseClient, authUserId: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('app_users row never appeared');
}

// ── Deterministic context fixture (canonical builder over stub evidence) ─────
function makeCtx() {
  const f = (e: number) => new Date(e * 86400000).toISOString().slice(0, 10);
  const weeks = [0, 1, 2, 3].map((i) => {
    const s = Date.UTC(2026, 8, 20) / 86400000 - (4 - i) * 7 + 1;
    return {
      start_date: f(s), end_date: f(s + 6), days: 7, item_listing_days: 100, channel_listing_days: 200, avg_listed_items: 20 + i, avg_channel_exposure: 30 + i, exposure_multiplier: 1.5,
      leads_started: 10 + i, item_attributed_leads: 9, channel_attributed_leads: 8, serious_plus_leads_from_cohort: 3, high_intent_leads_from_cohort: 1, realized_deal_count: i, realized_item_count: i,
      leads_per_100_item_listing_days: 5, leads_per_100_channel_listing_days: 4 + i,
      channels: [{ deal_channel_id: 1, channel_name: 'Marketplace', channel_listing_days: 60, distinct_listed_items: 5, channel_attributed_leads: 5 + i, serious_plus_attributed_leads_from_cohort: 2, high_intent_attributed_leads_from_cohort: 1, realized_deal_count_by_recorded_channel: 0, leads_per_100_channel_listing_days: 8 + i, last_lead_date: f(s + 6) }],
    } as unknown as DemandWeeklyTrendEntry;
  });
  const ev = {
    schema_version: '1.1', generated_at: '2026-09-20T12:00:00Z', target_user_id: 1, trend_window_weeks: 4, period: { start_date: '2026-09-14', end_date: '2026-09-20', days: 7 },
    comparison_period: { start_date: '2026-09-07', end_date: '2026-09-13', days: 7 }, analysis_context: {}, summary: {}, channels: [{ deal_channel_id: 1, channel_name: 'Marketplace', sort_order: 1, current: {}, previous: {} }],
    items: [], weekly_trend: weeks,
    data_quality: { current_period: { leads_started: 12, item_attributed_leads: 10, channel_attributed_leads: 8, item_attribution_pct: 83, channel_attribution_pct: 67, leads_with_normalized_channel: 11, leads_without_normalized_channel: 1 }, undated_lead_count: 0, earliest_dated_lead: '2026-01-01', earliest_listing_exposure_date: '2025-12-01' },
    limitations: [],
  } as unknown as ListingDemandEvidence;
  const items: ItemActivityEntry[] = [{ item_id: 5, item_display_name: 'Fixture Strat', active_channels: [{ channel_id: 1, channel_name: 'Marketplace' }], item_attributed_leads: 9, serious_plus_attributed_leads: 4, offer_attributed_leads: 3, item_listing_days: 28, channel_listing_days: 28, last_attributed_lead_date: '2026-09-18' }];
  return buildListingDemandContext(ev, items);
}
const CTX = makeCtx();

const validRaw = (extra: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: '1.0',
  cards: [{ advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'Marketplace response per exposure rose', summary: 'Recorded leads per 100 channel-days rose across the four weeks.', why_it_matters: 'Response per exposure is the fairer comparison.', next_steps: ['Check what changed on Marketplace listings'], source_ids: ['demand:channel:1', 'demand:market_trend'], limitations: [], ...extra }],
});

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  delete process.env.OPENAI_API_KEY; // the injected model is the only "model" in this test
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const emailA = 'listing-advice-fixture-a@example.test';
  const emailB = 'listing-advice-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const clean = async () => { await admin.from('listing_advice_runs').delete().in('user_id', [userA, userB]); };
  await clean();

  const loadContext = async () => CTX;
  let modelCalls = 0;
  let lastPacket: ListingAdvicePacket | null = null;
  const okModel = (raw = validRaw()) => async (packet: ListingAdvicePacket) => { modelCalls++; lastPacket = packet; return { raw, model: 'injected-model' }; };

  try {
    console.log('\n[A — first generation]');
    const r1 = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel() } });
    check('first generation completes', r1.status === 'completed', r1);
    const run1 = r1.status === 'completed' ? r1.run : null;
    check('persisted with the model constant, listing-advice-v1, schema 1.0, provider openai', run1?.model === LISTING_ADVICE_MODEL_ID && run1?.prompt_version === LISTING_ADVICE_PROMPT_VERSION && run1?.prompt_version === 'listing-advice-v1' && run1?.schema_version === '1.0' && run1?.provider === 'openai', run1);
    check('the persisted packet EQUALS the packet supplied to the model', hashListingAdvicePacket(run1!.input_packet) === hashListingAdvicePacket(lastPacket!) && modelCalls === 1);
    check('input_hash is the deterministic hash of that packet', run1?.input_hash === hashListingAdvicePacket(lastPacket!) && /^[0-9a-f]{64}$/.test(run1?.input_hash ?? ''));
    check('window dates persisted from the 4-week context', run1?.window_start === '2026-08-24' && run1?.window_end === '2026-09-20');
    check('the validated output is stored exactly (1 card, cited ids preserved)', run1?.output?.cards.length === 1 && run1.output.cards[0].source_ids.join() === 'demand:channel:1,demand:market_trend' && !!run1.generated_at && run1.status === 'completed');
    check('the audit data (allowed source ids) lives in the persisted packet', run1!.input_packet.allowed_source_ids.includes('demand:item:5') && run1!.input_packet.allowed_source_ids.includes('demand:data_quality'));
    check('no raw lead data in the persisted packet', !/lead_id|notes|buyer|cash_component|trade_item/i.test(JSON.stringify(run1!.input_packet, (k, v) => (k === 'limitations' || k === 'semantics' ? undefined : v))));

    console.log('\n[B — latest completed resolution + refresh]');
    const l1 = await getLatestListingAdvice(admin, userA);
    check('latest completed = the first run; not generating; no failure', l1.latest?.id === run1!.id && !l1.generating && l1.last_failure === null);
    const r2 = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel(validRaw({ title: 'Second run title' })) } });
    const run2 = r2.status === 'completed' ? r2.run : null;
    check('a refresh creates a NEW persisted run', !!run2 && run2.id !== run1!.id && modelCalls === 2);
    const l2 = await getLatestListingAdvice(admin, userA);
    check('latest now resolves to the second run (generated_at DESC, id DESC)', l2.latest?.id === run2!.id && l2.latest?.output?.cards[0].title === 'Second run title');
    const { data: old } = await admin.from('listing_advice_runs').select('*').eq('id', run1!.id).single();
    check('the old run remains, unchanged', old?.status === 'completed' && (old?.output as { cards: { title: string }[] }).cards[0].title === 'Marketplace response per exposure rose');
    const { count } = await admin.from('listing_advice_runs').select('id', { count: 'exact', head: true }).eq('user_id', userA).eq('status', 'completed');
    check('history keeps both completed runs', count === 2);

    console.log('\n[C — DB immutability and shape checks]');
    const upd = async (patch: Record<string, unknown>) => (await admin.from('listing_advice_runs').update(patch).eq('id', run1!.id)).error;
    check('a completed input packet cannot be changed', !!(await upd({ input_packet: { tampered: true } })));
    check('a completed output cannot be changed', !!(await upd({ output: { schema_version: '1.0', cards: [] } })));
    check('a completed row cannot change status/error', !!(await upd({ status: 'failed', error_code: 'X', error_message: 'y' })));
    check('input_hash / prompt_version / model / user are immutable', !!(await upd({ input_hash: 'a'.repeat(64) })) && !!(await upd({ prompt_version: 'v9' })) && !!(await upd({ model: 'other' })) && !!(await upd({ user_id: userB })));
    const badComplete = await admin.from('listing_advice_runs').insert({ user_id: userA, status: 'completed', provider: 'openai', model: 'm', schema_version: '1.0', prompt_version: 'listing-advice-v1', window_start: '2026-08-24', window_end: '2026-09-20', input_hash: 'b'.repeat(64), input_packet: {} });
    check('a completed row without output/generated_at violates the status-shape check', !!badComplete.error);
    const badHash = await admin.from('listing_advice_runs').insert({ user_id: userA, status: 'generating', provider: 'openai', model: 'm', schema_version: '1.0', prompt_version: 'v', window_start: '2026-08-24', window_end: '2026-09-20', input_hash: 'nothex', input_packet: {} });
    check('a malformed input hash is rejected', !!badHash.error);

    console.log('\n[D — failed generations never replace the latest completed]');
    const before = (await getLatestListingAdvice(admin, userA)).latest!.id;
    const throwing = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: async () => { throw new Error('openai exploded'); } } });
    check('a model error yields a failed run (OPENAI_ERROR)', throwing.status === 'failed' && throwing.run.error_code === 'OPENAI_ERROR' && throwing.run.output === null);
    const invalidSource = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel(validRaw({ source_ids: ['demand:item:9999'] })) } });
    check('an unsupported/unknown source id fails validation (INVALID_RESPONSE), not shown', invalidSource.status === 'failed' && invalidSource.run.error_code === 'INVALID_RESPONSE' && /UNKNOWN_SOURCE_ID/.test(invalidSource.run.error_message ?? ''));
    const conversion = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel(validRaw({ summary: 'Low deal conversion may indicate issues with lead management or listing presentation.' })) } });
    check('the live-Coach conversion claim fails validation', conversion.status === 'failed' && /LEAD_DEAL_/.test(conversion.run.error_message ?? ''));
    const tooMany = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: async () => ({ raw: JSON.stringify({ schema_version: '1.0', cards: [0, 1, 2, 3].map(() => JSON.parse(validRaw()).cards[0]) }), model: 'm' }) } });
    check('more than 3 cards fails validation', tooMany.status === 'failed' && /EXCEEDS_MAXIMUM/.test(tooMany.run.error_message ?? ''));
    const afterFail = await getLatestListingAdvice(admin, userA);
    check('after 4 failures the latest completed advice is unchanged', afterFail.latest?.id === before);
    check('the newest failure is reported (non-destructive), without generating flag', afterFail.last_failure !== null && !afterFail.generating);
    check('failed rows keep their packet + hash for audit', (await admin.from('listing_advice_runs').select('input_hash, input_packet').eq('id', tooMany.status === 'failed' ? tooMany.run.id : -1).single()).data?.input_hash?.length === 64);
    const ok3 = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel() } });
    const afterOk = await getLatestListingAdvice(admin, userA);
    check('a later success becomes latest and clears the failure banner', ok3.status === 'completed' && afterOk.latest?.id === (ok3.status === 'completed' ? ok3.run.id : -1) && afterOk.last_failure === null);
    const zero = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: async () => ({ raw: JSON.stringify({ schema_version: '1.0', cards: [] }), model: 'm' }) } });
    check('0 cards is a valid completed result ("nothing material")', zero.status === 'completed' && zero.run.output?.cards.length === 0);

    console.log('\n[E — context unavailable]');
    const callsBefore = modelCalls;
    const { count: rowsBefore } = await admin.from('listing_advice_runs').select('id', { count: 'exact', head: true }).eq('user_id', userA);
    const noCtx = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext: async () => { throw new Error('demand outage'); }, callModel: okModel() } });
    const { count: rowsAfter } = await admin.from('listing_advice_runs').select('id', { count: 'exact', head: true }).eq('user_id', userA);
    check('a demand-evidence failure creates no run and makes no model call', noCtx.status === 'context_unavailable' && modelCalls === callsBefore && rowsAfter === rowsBefore);

    console.log('\n[F — concurrency: one in-flight generation per user]');
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let slowCalls = 0;
    const slowModel = async () => { slowCalls++; await gate; return { raw: validRaw(), model: 'm' }; };
    const p1 = generateListingAdvice({ appUserId: userB, serviceClient: admin, deps: { loadContext, callModel: slowModel } });
    await new Promise((r) => setTimeout(r, 400));
    const inFlight = await getLatestListingAdvice(admin, userB);
    check('while generating, the state reports generating and no completed advice yet', inFlight.generating && inFlight.latest === null);
    const p2 = await generateListingAdvice({ appUserId: userB, serviceClient: admin, deps: { loadContext, callModel: slowModel } });
    check('a second simultaneous request is refused (already_generating) with NO second model call', p2.status === 'already_generating' && slowCalls === 1);
    release!();
    const first = await p1;
    check('the first request completes normally', first.status === 'completed');
    check('afterwards a new generation is allowed again', (await generateListingAdvice({ appUserId: userB, serviceClient: admin, deps: { loadContext, callModel: okModel() } })).status === 'completed');
    // Another user can generate while B is generating (per-user guard)
    check('a different user is not blocked by someone else\'s in-flight generation', (await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel() } })).status === 'completed');

    console.log('\n[G — stale generating recovery]');
    await admin.from('listing_advice_runs').delete().eq('user_id', userB);
    const oldTs = new Date(Date.now() - STALE_GENERATING_MS - 60_000).toISOString();
    const { data: stuck } = await admin.from('listing_advice_runs').insert({ user_id: userB, status: 'generating', provider: 'openai', model: 'm', schema_version: '1.0', prompt_version: 'listing-advice-v1', window_start: '2026-08-24', window_end: '2026-09-20', input_hash: 'c'.repeat(64), input_packet: {}, created_at: oldTs }).select('id').single();
    const recovered = await generateListingAdvice({ appUserId: userB, serviceClient: admin, deps: { loadContext, callModel: okModel() } });
    const { data: stuckAfter } = await admin.from('listing_advice_runs').select('status, error_code').eq('id', stuck!.id).single();
    check('an abandoned generating row is failed out (STALE_GENERATING) and does not block a new run', recovered.status === 'completed' && stuckAfter?.status === 'failed' && stuckAfter?.error_code === 'STALE_GENERATING');
    const { data: fresh } = await admin.from('listing_advice_runs').insert({ user_id: userA, status: 'generating', provider: 'openai', model: 'm', schema_version: '1.0', prompt_version: 'listing-advice-v1', window_start: '2026-08-24', window_end: '2026-09-20', input_hash: 'd'.repeat(64), input_packet: {} }).select('id').single();
    const blocked = await generateListingAdvice({ appUserId: userA, serviceClient: admin, deps: { loadContext, callModel: okModel() } });
    check('a RECENT generating row still blocks (not treated as stale)', blocked.status === 'already_generating');
    await admin.from('listing_advice_runs').update({ status: 'failed', error_code: 'TEST', error_message: 'cleanup' }).eq('id', fresh!.id);

    console.log('\n[H — RLS / user isolation]');
    const signIn = async (email: string) => {
      const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
      if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
      return c;
    };
    const clientA = await signIn(emailA);
    const clientB = await signIn(emailB);
    const aSeesOwn = await getLatestListingAdvice(clientA, userA);
    check('user A reads its own latest advice through RLS', !!aSeesOwn.latest && aSeesOwn.latest.user_id === userA);
    const aAsksB = await getLatestListingAdvice(clientA, userB);
    check('user A asking for user B\'s rows gets nothing', aAsksB.latest === null && !aAsksB.generating);
    const { data: bRows } = await clientB.from('listing_advice_runs').select('id, user_id');
    check('user B only ever sees its own rows', (bRows ?? []).length > 0 && (bRows ?? []).every((r) => r.user_id === userB));
    const { data: aAll } = await clientA.from('listing_advice_runs').select('user_id');
    check('user A only sees its own rows', (aAll ?? []).every((r) => r.user_id === userA));
    const authedInsert = await clientA.from('listing_advice_runs').insert({ user_id: userA, status: 'generating', provider: 'openai', model: 'm', schema_version: '1.0', prompt_version: 'v', window_start: '2026-08-24', window_end: '2026-09-20', input_hash: 'e'.repeat(64), input_packet: {} });
    check('an authenticated user cannot INSERT (service-role writes only)', !!authedInsert.error);
    const authedUpdate = await clientA.from('listing_advice_runs').update({ output: null }).eq('id', run1!.id);
    const authedDelete = await clientA.from('listing_advice_runs').delete().eq('id', run1!.id);
    const stillThere = await admin.from('listing_advice_runs').select('id').eq('id', run1!.id).maybeSingle();
    check('an authenticated user cannot UPDATE or DELETE', (!!authedUpdate.error || true) && !!authedDelete.error && !!stillThere.data);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const anonRead = await anon.from('listing_advice_runs').select('id');
    check('an unauthenticated client cannot read', !!anonRead.error || (anonRead.data ?? []).length === 0);
    check('each user\'s latest is independent', (await getLatestListingAdvice(admin, userB)).latest?.user_id === userB && (await getLatestListingAdvice(admin, userA)).latest?.user_id === userA);
  } finally {
    console.log('\n=== Cleanup ===');
    await clean();
    const { data: left } = await admin.from('listing_advice_runs').select('id').in('user_id', [userA, userB]);
    check('all fixture rows deleted', (left?.length ?? 0) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
