/**
 * test-listing-advice-orchestration.ts
 *
 * Weekly Coach Refresh orchestration (2026-11-13): one refresh, two
 * independent modules (General Coach + Listing Advice).
 *   - /listings keeps a listing-only "Refresh Advice"; freshness, failure and
 *     hidden/resurface states are explicit; dismissal stays independent
 *   - runCoachRefresh: shared evidence loaded ONCE, heavy DB phases in
 *     sequence, model modules concurrent, failure isolation in BOTH
 *     directions (a failed snapshot no longer stops Listing Advice)
 *   - entry points: weekly + manual "Refresh Coach" + Admin "Run Analytics"
 *     use the one orchestration; listing-only refresh uses the same service
 *   - REAL DB: Listing Advice generated through the refresh, identical-input
 *     dedupe, a failed generation preserves the previous completed advice,
 *     one-in-flight protection, dismissal + resurface semantics
 * The model is always injected — no live OpenAI call is ever made.
 * Local Supabase only (safety-gated); everything created is deleted.
 *
 * Usage:  npx tsx scripts/test-listing-advice-orchestration.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { adviceLabels } from '../src/lib/analytics/advice/adviceLabels';
import {
  runCoachRefresh, runListingAdviceRefresh, listingResultFromOutcome, generalResultFromOutcome, overallRefreshStatus,
  type CoachRefreshDeps,
} from '../src/lib/analytics/coachRefresh';
import { AnalyticsRunError } from '../src/lib/analytics/runAnalytics';
import { generateListingAdvice, getLatestListingAdvice, type GenerateListingAdviceOutcome } from '../src/lib/analytics/listingAdvice/generateListingAdvice';
import { dismissListingAdviceCard, getActiveListingDismissalKeys, getActiveListingDismissals, resurfaceAdvice } from '../src/lib/analytics/listingAdvice/listingAdviceDismissal';
import { listingAdviceKey, pickListingPrimarySource } from '../src/lib/listingAdviceKey';
import { computeAdviceKey } from '../src/lib/analytics/advice/adviceKey';
import { buildListingDemandContext, type ListingDemandContext } from '../src/lib/analytics/advice/listingDemandContext';
import type { ListingAdvicePacket } from '../src/lib/analytics/listingAdvice/listingAdvice';
import type { ListingDemandEvidence, DemandWeeklyTrendEntry } from '../src/lib/analytics/listingDemandEvidence';
import type { ItemActivityEntry } from '../src/lib/analytics/listingItemActivity';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const PASSWORD = 'Listing-Advice-Orch-Fixture-Local-1!';

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

/** Deterministic 4-week context; `leads` varies the evidence (and therefore the packet hash). */
function makeCtx(leads = 9): ListingDemandContext {
  const f = (e: number) => new Date(e * 86400000).toISOString().slice(0, 10);
  const weeks = [0, 1, 2, 3].map((i) => {
    const s = Date.UTC(2026, 8, 20) / 86400000 - (4 - i) * 7 + 1;
    return {
      start_date: f(s), end_date: f(s + 6), days: 7, item_listing_days: 100, channel_listing_days: 200, avg_listed_items: 20, avg_channel_exposure: 30, exposure_multiplier: 1.5, leads_started: 10, item_attributed_leads: 9, channel_attributed_leads: 8,
      serious_plus_leads_from_cohort: 3, high_intent_leads_from_cohort: 1, realized_deal_count: 0, realized_item_count: 0, leads_per_100_item_listing_days: 5, leads_per_100_channel_listing_days: 4,
      channels: [{ deal_channel_id: 1, channel_name: 'Marketplace', channel_listing_days: 60, distinct_listed_items: 5, channel_attributed_leads: 5, serious_plus_attributed_leads_from_cohort: 2, high_intent_attributed_leads_from_cohort: 1, realized_deal_count_by_recorded_channel: 0, leads_per_100_channel_listing_days: 8, last_lead_date: f(s + 6) }],
    } as unknown as DemandWeeklyTrendEntry;
  });
  const ev = { schema_version: '1.1', generated_at: 'x', target_user_id: 1, trend_window_weeks: 4, period: { start_date: '2026-09-14', end_date: '2026-09-20', days: 7 }, comparison_period: { start_date: '2026-09-07', end_date: '2026-09-13', days: 7 }, analysis_context: {}, summary: {}, channels: [{ deal_channel_id: 1, channel_name: 'Marketplace', sort_order: 1, current: {}, previous: {} }], items: [], weekly_trend: weeks, data_quality: { current_period: { leads_started: 12, item_attributed_leads: 10, channel_attributed_leads: 8, item_attribution_pct: 83, channel_attribution_pct: 67, leads_with_normalized_channel: 11, leads_without_normalized_channel: 1 }, undated_lead_count: 0, earliest_dated_lead: '2026-01-01', earliest_listing_exposure_date: '2025-12-01' }, limitations: [] } as unknown as ListingDemandEvidence;
  const items: ItemActivityEntry[] = [{ item_id: 5, item_display_name: 'Fixture Strat', active_channels: [{ channel_id: 1, channel_name: 'Marketplace' }], item_attributed_leads: leads, serious_plus_attributed_leads: 4, offer_attributed_leads: 3, item_listing_days: 28, channel_listing_days: 28, last_attributed_lead_date: '2026-09-18' }];
  return buildListingDemandContext(ev, items);
}
const CTX = makeCtx();
const card = (over: Record<string, unknown> = {}) => ({ advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'Marketplace response per exposure rose', summary: 'Recorded leads per 100 channel-days rose across the four weeks.', why_it_matters: 'Response per exposure is the fairer comparison.', next_steps: [], source_ids: ['demand:channel:1'], limitations: [], ...over });
const raw = (...cards: Record<string, unknown>[]) => JSON.stringify({ schema_version: '1.0', cards });

const fakeRun = { id: 4242 } as unknown as Awaited<ReturnType<typeof import('../src/lib/analytics/runAnalytics').runAnalyticsForCurrentUser>>;
// getUserPreferredLanguage never throws (falls back to 'en'), so a bare object is a safe service client stub.
const svc = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) } as unknown as SupabaseClient;

async function main() {
  console.log('\n[A — /listings: listing-only Refresh Advice, freshness, hidden/resurface, dismissal]');
  {
    const sec = strip(read('src', 'components', 'listings', 'ListingAdviceSection.tsx'));
    const drawer = strip(read('src', 'components', 'listings', 'ListingAdviceDrawer.tsx'));
    const page = strip(read('src', 'app', 'listings', 'page.tsx'));
    const client = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdviceClient.ts'));
    check('NO "Generate Listing Advice" button anywhere on /listings', ![sec, drawer, page].some((t) => /Generate Listing Advice/.test(t)));
    check('"Refresh Advice" (listing-only) is on /listings and posts to /api/listing-advice/refresh', /data-advice-refresh/.test(sec) && /L\.refreshAdvice/.test(sec) && adviceLabels('en').refreshAdvice === 'Refresh Advice' && /refreshListingAdvice\(\)/.test(sec) && /'\/api\/listing-advice\/refresh'/.test(client));
    check('Refresh is disabled while a generation is in flight or a refresh is running', /disabled=\{refreshing \|\| !!data\?\.generating\}/.test(sec));
    check('latest completed persisted advice still loads (SWR cache key listing-advice:latest, no polling)', /useSwrResource\(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice\)/.test(sec) && !/setInterval|polling|BroadcastChannel/i.test(sec));
    check('freshness: Generated <date> · 4-week demand window', /data-advice-freshness/.test(sec) && /L\.generated\}[\s\S]*L\.demandWindow/.test(sec));
    check('stale advice is called out (never shown silently as current)', /data-advice-stale/.test(sec) && /view\.stale/.test(sec) && /L\.listingAdviceAge|L\.listingNotRefreshedSince/.test(sec));
    check('a failed newer refresh is called out while the previous advice stays', /data-advice-refresh-failed/.test(sec) && /view\.refreshFailedAt/.test(sec));
    check('empty state: "No Listing Advice has been generated yet."', sec.includes('L.noneYet') && adviceLabels('en').noneYet === 'No Listing Advice has been generated yet.');
    check('0 cards: "No material listing advice"; all dismissed: hidden count + next resurface + View hidden', sec.includes('L.noMaterialAdvice') && /HiddenAdviceList hidden=\{view\.hidden\} allHidden/.test(sec));
    check('Resurface is available for hidden Listing cards (same semantics as the Dashboard)', /onResurface=\{resurface\}/.test(sec) && /resurfaceAdvice\(key\)/.test(sec));
    check('dismissal remains: Dismiss control per card, optimistic + persisted + rolled back on failure', /data-advice-dismiss/.test(sec) && /setHiddenKeys\(\(prev\) => \[\.\.\.prev, key\]\)/.test(sec) && /setHiddenKeys\(\(prev\) => prev\.filter\(\(k\) => k !== key\)\)/.test(sec));
    check('dismissed keys from the server hide cards (independent of generation)', /data\?\.dismissed_keys/.test(sec) && /allCards\.filter\(\(c\) => !dismissed\.has\(listingAdviceKey\(c\)\)\)/.test(sec));
    check('the dismiss control is a sibling of the card button (no nested buttons)', /<button[\s\S]*?data-advice-card[\s\S]*?<\/button>\s*<div className="flex justify-end[^"]*">\s*<button[\s\S]*?data-advice-dismiss/.test(sec));
    const layout = read('src', 'app', 'layout.tsx');
    check('no navigation change', (layout.match(/<nav[\s\S]*?<\/nav>/g) ?? []).every((nav) => JSON.stringify((nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim())) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations'])));
  }

  console.log('\n[B — runCoachRefresh: order, shared evidence, failure isolation (injected modules)]');
  {
    const calls: string[] = [];
    const deps = (over: Partial<CoachRefreshDeps> = {}): CoachRefreshDeps => ({
      loadListingDemand: async () => { calls.push('demand'); return CTX; },
      runAnalytics: async (p) => { calls.push(`analytics:${p.appUserId}`); return fakeRun; },
      generateCoachAdvice: async (p) => { calls.push(`coach:${p.runId}:${p.mode}:${p.requestingUserId}:${p.listingDemand === CTX ? 'shared' : 'other'}`); return { status: 'completed', row: { id: 77, advice: { advice_cards: [{}, {}, {}] } } as never }; },
      generateListingAdvice: async (p) => { calls.push(`listing:${p.appUserId}:${p.sharedContext === CTX ? 'shared' : 'none'}:${p.skipIfUnchanged ? 'dedupe' : 'nodedupe'}`); return { status: 'completed', run: { id: 88, output: { cards: [{}] } } as never }; },
      ...over,
    });

    const ok = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps() });
    check('order: shared evidence ONCE, then the snapshot, then BOTH modules', calls[0] === 'demand' && calls[1] === 'analytics:9' && calls.filter((c) => c === 'demand').length === 1 && calls.slice(2).sort().join() === ['coach:4242:auto:9:shared', 'listing:9:shared:dedupe'].sort().join(), calls);
    check('both modules receive the SAME canonical Listing Demand context (no second evidence build)', calls.includes('coach:4242:auto:9:shared') && calls.includes('listing:9:shared:dedupe'));
    check('result: run + per-module status, row id and card count', ok.run?.id === 4242 && ok.analyticsRunId === 4242 && ok.general.status === 'completed' && ok.general.rowId === 77 && ok.general.cardCount === 3 && ok.listings.status === 'completed' && ok.listings.rowId === 88 && ok.listings.cardCount === 1);
    check('overall: both fine -> completed', overallRefreshStatus(ok.general, ok.listings) === 'completed');

    calls.length = 0;
    const snapFail = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ runAnalytics: async () => { calls.push('analytics'); throw new AnalyticsRunError('Analytics run failed', 500, 123); } }) });
    check('a failed snapshot fails ONLY General (no Coach call) — Listing Advice still runs', snapFail.run === null && snapFail.analyticsRunId === 123 && snapFail.general.status === 'failed' && snapFail.general.code === 'ANALYTICS_RUN_FAILED' && !calls.some((c) => c.startsWith('coach')) && calls.some((c) => c.startsWith('listing')) && snapFail.listings.status === 'completed', { calls, snapFail });
    check('overall: General failed + Listing ok -> partial', overallRefreshStatus(snapFail.general, snapFail.listings) === 'partial');

    const busy = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ runAnalytics: async () => { throw new AnalyticsRunError('An Analytics run is already in progress for this account.', 409); } }) });
    check('an in-flight Analytics run maps to General skipped/ALREADY_RUNNING (not a failure)', busy.general.status === 'skipped' && busy.general.code === 'ALREADY_RUNNING');

    calls.length = 0;
    const demandDown = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ loadListingDemand: async () => { throw new Error('rpc timeout'); } }) });
    check('shared evidence failure: Coach continues without the block; Listing Advice builds its own evidence (sharedContext null)', calls.includes('coach:4242:auto:9:other') && calls.includes('listing:9:none:dedupe') && demandDown.general.status === 'completed', calls);

    const listingFailed = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ generateListingAdvice: async () => ({ status: 'failed', run: { id: 90, error_code: 'OPENAI_ERROR', error_message: 'boom' } as never }) }) });
    check('Listing Advice failure: snapshot + General stay successful, failure is visible', listingFailed.run?.id === 4242 && listingFailed.general.status === 'completed' && listingFailed.listings.status === 'failed' && listingFailed.listings.code === 'OPENAI_ERROR' && listingFailed.listings.rowId === 90);
    check('overall: Listing failed + General ok -> partial', overallRefreshStatus(listingFailed.general, listingFailed.listings) === 'partial');
    const listingThrew = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ generateListingAdvice: async () => { throw new Error('unexpected'); } }) });
    check('a Listing module that THROWS is contained (refresh resolves; General unaffected)', listingThrew.listings.status === 'failed' && listingThrew.listings.code === 'THREW' && listingThrew.general.status === 'completed');
    const coachThrew = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ generateCoachAdvice: async () => { throw new Error('coach exploded'); } }) });
    check('a General failure does not stop Listing Advice (independent modules)', coachThrew.general.status === 'failed' && coachThrew.listings.status === 'completed');
    const bothFail = await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({ runAnalytics: async () => { throw new AnalyticsRunError('x', 500); }, generateListingAdvice: async () => ({ status: 'error', message: 'x' }) }) });
    check('overall: both failed -> failed', overallRefreshStatus(bothFail.general, bothFail.listings) === 'failed');

    for (const [outcome, status, code] of [
      [{ status: 'already_generating' }, 'skipped', 'ALREADY_GENERATING'],
      [{ status: 'context_unavailable', message: 'down' }, 'failed', 'CONTEXT_UNAVAILABLE'],
      [{ status: 'error', message: 'x' }, 'failed', 'ERROR'],
      [{ status: 'completed', run: { id: 1, output: { cards: [] } } }, 'no_material_advice', null],
      [{ status: 'unchanged', run: { id: 2, output: { cards: [{}] } } }, 'completed', 'UNCHANGED_INPUT'],
    ] as [GenerateListingAdviceOutcome, string, string | null][]) {
      const r = listingResultFromOutcome(outcome);
      check(`Listing outcome ${outcome.status}${'run' in outcome ? `(${(outcome.run.output?.cards.length ?? 0)} cards)` : ''} -> ${status}/${code}`, r.status === status && r.code === code, r);
    }
    check('General: completed with 0 cards -> no_material_advice (distinct from failed / all dismissed)', generalResultFromOutcome({ status: 'completed', row: { id: 5, advice: { advice_cards: [] } } as never }).status === 'no_material_advice');

    const order: string[] = [];
    await runCoachRefresh({ appUserId: 9, serviceClient: svc, deps: deps({
      loadListingDemand: async () => { order.push('demand-start'); await new Promise((r) => setTimeout(r, 20)); order.push('demand-end'); return CTX; },
      runAnalytics: async () => { order.push('analytics-start'); await new Promise((r) => setTimeout(r, 30)); order.push('analytics-end'); return fakeRun; },
      generateCoachAdvice: async () => { order.push('coach'); return { status: 'skipped', reason: 'X' }; },
      generateListingAdvice: async () => { order.push('listing'); return { status: 'already_generating' }; },
    }) });
    check('heavy DB phases never overlap (evidence, then snapshot); model modules start after both', order.indexOf('demand-end') < order.indexOf('analytics-start') && order.indexOf('analytics-end') < order.indexOf('coach') && order.indexOf('analytics-end') < order.indexOf('listing'), order);
  }

  console.log('\n[C — entry points share ONE orchestration; no second schedule]');
  {
    const runsRoute = strip(read('src', 'app', 'api', 'analytics', 'runs', 'route.ts'));
    const weekly = strip(read('src', 'lib', 'analytics', 'automation', 'runWeeklyAutomation.ts'));
    const orch = strip(read('src', 'lib', 'analytics', 'coachRefresh.ts'));
    const refreshRoute = strip(read('src', 'app', 'api', 'listing-advice', 'refresh', 'route.ts'));
    check('manual Refresh Coach / Run Analytics route calls runCoachRefresh for the caller only', /runCoachRefresh\(\{ appUserId: appUser\.id as number, serviceClient \}\)/.test(runsRoute));
    check('manual route refuses a concurrent duplicate refresh (409 ALREADY_RUNNING) before starting', /isCoachRefreshInFlight\(serviceClient, appUser\.id as number\)/.test(runsRoute) && /status: 409/.test(runsRoute));
    check('the scheduled weekly refresh calls the SAME runCoachRefresh', /runCoachRefresh\(\{ appUserId: targetUserId, serviceClient, deps: params\.deps \}\)/.test(weekly));
    check('listing-only refresh route reuses the same Listing service via runListingAdviceRefresh', /runListingAdviceRefresh\(\{ appUserId: appUser\.id as number, serviceClient \}\)/.test(refreshRoute));
    check('no entry point calls the generators directly (no drift)', ![runsRoute, weekly, refreshRoute].some((t) => /generateAdviceForRun|generateListingAdvice\(|runAnalyticsForCurrentUser/.test(t)));
    check('coachRefresh.ts is the ONLY importer of the generateListingAdvice service in src', (() => {
      const hits: string[] = [];
      const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(e.name) && /import \{[^}]*\bgenerateListingAdvice\b[^}]*\}/.test(strip(fs.readFileSync(f, 'utf8')))) hits.push(path.relative(root, f).replace(/\\/g, '/')); } };
      walk(path.join(root, 'src'));
      return hits.join() === 'src/lib/analytics/coachRefresh.ts';
    })());
    check('orchestration: no shared transaction, both modules contained, writes to neither advice table itself', /Promise\.all\(\[/.test(orch) && (orch.match(/catch \(err\)/g) ?? []).length >= 3 && !/transaction|BEGIN|ROLLBACK/i.test(orch) && !/from\('analytics_run_advice'\)|from\('listing_advice_runs'\)/.test(orch));
    const vercel = JSON.parse(read('vercel.json')) as { crons: { path: string; schedule: string }[] };
    check('vercel.json: Listing Advice has NO separate schedule (it is a module of the weekly refresh)', vercel.crons.length === 2 && vercel.crons.every((c) => c.path === '/api/cron/weekly-analytics-advice'));
    check('no listing-advice cron route exists', fs.readdirSync(path.join(root, 'src', 'app', 'api', 'cron')).join() === 'weekly-analytics-advice');
    check('cron budget is 300 s (the 60 s cap killed the second user on 2026-11-05)', /export const maxDuration = 300;/.test(read('src', 'app', 'api', 'cron', 'weekly-analytics-advice', 'route.ts')));
    const route = strip(read('src', 'app', 'api', 'listing-advice', 'route.ts'));
    check('/api/listing-advice stays read-only (GET only) and returns dismissal dates', /export async function GET/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route) && /dismissals/.test(route));
    check('weekly execution records both modules independently', /general_status: general\.status/.test(weekly) && /listing_status: listings\.status/.test(weekly) && /listing_advice_run_id: listings\.rowId/.test(weekly) && /overallRefreshStatus\(general, listings\)/.test(weekly));
    const analyticsPage = read('src', 'app', 'analytics', 'page.tsx');
    check('Admin page shows module results even when the snapshot failed', /snapshotFailed: true/.test(analyticsPage) && /Listing Advice <StageStatus/.test(analyticsPage) && /data-run-stages/.test(analyticsPage));
    check('after a refresh the client advice cache is invalidated so /listings resolves the new advice', /invalidateListingAdviceCache\(\)/.test(analyticsPage) && /invalidateListingAdviceCache\(\)/.test(read('src', 'app', 'page.tsx')));
  }

  console.log('\n[D — dismissal identity (pure)]');
  {
    check('key is derived only from cited sources: item > channel > market > data quality', pickListingPrimarySource(['demand:market_trend', 'demand:channel:2', 'demand:item:55']) === 'demand:item:55' && pickListingPrimarySource(['demand:market_trend', 'demand:channel:2']) === 'demand:channel:2' && pickListingPrimarySource(['demand:data_quality', 'demand:market_trend']) === 'demand:market_trend' && pickListingPrimarySource([]) === '');
    check('LLM wording never affects the key', listingAdviceKey({ source_ids: ['demand:item:55', 'demand:channel:1'] }) === listingAdviceKey({ source_ids: ['demand:channel:1', 'demand:item:55'] }));
    check('different primary source -> different key', listingAdviceKey({ source_ids: ['demand:item:55'] }) !== listingAdviceKey({ source_ids: ['demand:item:56'] }));
    check('Listing Advice keys are namespaced and never collide with General Coach keys', listingAdviceKey({ source_ids: ['demand:market_trend'] }) === 'listing:v1:demand:market_trend' && computeAdviceKey({ item_id: null, source_ids: ['demand:market_trend'] }) === 'v2:-:demand:market_trend');
    const dis = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdviceDismissal.ts'));
    check('reuses the existing dismissals table + 30-day policy; never writes advice rows', /analytics_advice_dismissals/.test(dis) && /30 \* 24 \* 60 \* 60 \* 1000/.test(dis) && !/from\('listing_advice_runs'\)\s*\.(update|delete|insert)/.test(dis));
    check('resurface never deletes: it ends the window (resurface_after = now) on the caller\'s own row', /\.update\(\{ resurface_after: now \}\)/.test(dis) && /\.eq\('user_id', params\.appUserId\)/.test(dis) && !/\.delete\(\)/.test(dis));
  }

  // ── Real DB ────────────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  delete process.env.OPENAI_API_KEY;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emailA = 'listing-advice-orch-a@example.test';
  const emailB = 'listing-advice-orch-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const clean = async () => {
    await admin.from('listing_advice_runs').delete().in('user_id', [userA, userB]);
    await admin.from('analytics_advice_dismissals').delete().in('user_id', [userA, userB]);
  };
  await clean();

  const signIn = async (email: string) => {
    const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
    return c;
  };

  let modelCalls = 0;
  const modelReturning = (r: string) => async (_p: ListingAdvicePacket) => { modelCalls++; return { raw: r, model: 'injected' }; };
  // Real Listing Advice service (real DB) with an injected model, called THROUGH the Coach refresh. The General
  // module is stubbed (it has its own suites); `ctx` is the shared evidence the refresh loads once.
  const refreshDeps = (r: string | (() => Promise<{ raw: string; model: string }>), ctx: ListingDemandContext = CTX): CoachRefreshDeps => ({
    loadListingDemand: async () => ctx,
    runAnalytics: async () => fakeRun,
    generateCoachAdvice: async () => ({ status: 'skipped', reason: 'TEST' }),
    generateListingAdvice: (p) => generateListingAdvice({ ...p, deps: { callModel: typeof r === 'string' ? modelReturning(r) : r } }),
  });

  try {
    console.log('\n[E — Listing Advice generated automatically by the Coach refresh (real DB)]');
    const empty = await getLatestListingAdvice(admin, userA);
    check('before any refresh: no latest advice (empty state)', empty.latest === null && !empty.generating && empty.last_failure === null);
    const w1 = await runCoachRefresh({ appUserId: userA, serviceClient: admin, deps: refreshDeps(raw(card(), card({ advice_code: 'L2', advice_type: 'watch', title: 'Kijiji watch', source_ids: ['demand:item:5'] }))) });
    check('a Coach refresh generates Listing Advice (completed, persisted, 2 cards)', w1.listings.status === 'completed' && typeof w1.listings.rowId === 'number' && w1.listings.cardCount === 2);
    const l1 = await getLatestListingAdvice(admin, userA);
    check('/listings resolves it as the latest completed advice', l1.latest?.id === w1.listings.rowId && l1.latest?.output?.cards.length === 2);

    console.log('\n[E2 — identical input: no duplicate generation]');
    const callsBefore = modelCalls;
    const w1b = await runCoachRefresh({ appUserId: userA, serviceClient: admin, deps: refreshDeps(raw(card({ title: 'would be a duplicate' }))) });
    const { count: rowsAfterDup } = await admin.from('listing_advice_runs').select('id', { count: 'exact', head: true }).eq('user_id', userA);
    check('same evidence (same packet hash) -> UNCHANGED_INPUT: no model call, no new row, latest kept', w1b.listings.status === 'completed' && w1b.listings.code === 'UNCHANGED_INPUT' && w1b.listings.rowId === w1.listings.rowId && modelCalls === callsBefore && rowsAfterDup === 1, { w1b, rowsAfterDup });

    console.log('\n[F — a failed generation preserves the previous completed advice]');
    const w2 = await runCoachRefresh({ appUserId: userA, serviceClient: admin, deps: refreshDeps(async () => { throw new Error('openai down'); }, makeCtx(11)) });
    check('the failed Listing module does not fail the refresh/General run', w2.run?.id === 4242 && w2.listings.status === 'failed' && w2.listings.code === 'OPENAI_ERROR');
    const l2 = await getLatestListingAdvice(admin, userA);
    check('the previous completed advice is still the latest', l2.latest?.id === l1.latest?.id);
    const { data: failedRow } = await admin.from('listing_advice_runs').select('status, input_hash, error_code').eq('id', w2.listings.rowId!).single();
    check('the failed run is preserved for audit (packet hash + error code)', failedRow?.status === 'failed' && failedRow?.error_code === 'OPENAI_ERROR' && failedRow?.input_hash.length === 64);
    check('the failure is reported next to the previous advice (last_failure newer than latest)', l2.last_failure?.error_code === 'OPENAI_ERROR');

    console.log('\n[F2 — General fails, Listing Advice still refreshes (real Listing DB rows)]');
    const w2b = await runCoachRefresh({ appUserId: userA, serviceClient: admin, deps: { ...refreshDeps(raw(card({ advice_code: 'L1', title: 'Newer run' })), makeCtx(12)), runAnalytics: async () => { throw new AnalyticsRunError('Analytics run failed', 500, 999); } } });
    const l3 = await getLatestListingAdvice(admin, userA);
    check('snapshot failed (General failed) yet Listing Advice completed and became the new latest', w2b.general.status === 'failed' && w2b.listings.status === 'completed' && l3.latest?.id === w2b.listings.rowId && l3.latest?.id !== l1.latest?.id && l3.last_failure === null);

    console.log('\n[F3 — manual listing-only refresh still works]');
    const m1 = await runListingAdviceRefresh({ appUserId: userA, serviceClient: admin, deps: { generateListingAdvice: (p) => generateListingAdvice({ ...p, sharedContext: makeCtx(13), deps: { callModel: modelReturning(raw(card({ advice_code: 'L1', title: 'Manual refresh' }))) } }) } });
    const l4 = await getLatestListingAdvice(admin, userA);
    check('listing-only refresh generates through the same service (new latest)', m1.status === 'completed' && l4.latest?.id === m1.rowId && l4.latest?.output?.cards[0].title === 'Manual refresh');
    const m2 = await runListingAdviceRefresh({ appUserId: userA, serviceClient: admin, deps: { generateListingAdvice: (p) => generateListingAdvice({ ...p, sharedContext: makeCtx(13), deps: { callModel: modelReturning(raw(card())) } }) } });
    check('pressing Refresh again with the same evidence is a no-op (UNCHANGED_INPUT)', m2.status === 'completed' && m2.code === 'UNCHANGED_INPUT' && m2.rowId === m1.rowId);

    console.log('\n[G — one in-flight generation still protected]');
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let slowCalls = 0;
    const slow = async () => { slowCalls++; await gate; return { raw: raw(card()), model: 'm' }; };
    const p1 = runCoachRefresh({ appUserId: userB, serviceClient: admin, deps: refreshDeps(slow) });
    await new Promise((r) => setTimeout(r, 400));
    const p2 = await runCoachRefresh({ appUserId: userB, serviceClient: admin, deps: refreshDeps(slow) });
    check('a second simultaneous refresh skips Listing Advice (already generating) with no second model call', p2.listings.status === 'skipped' && p2.listings.code === 'ALREADY_GENERATING' && slowCalls === 1);
    const p3 = await runListingAdviceRefresh({ appUserId: userB, serviceClient: admin, deps: { generateListingAdvice: (p) => generateListingAdvice({ ...p, sharedContext: CTX, deps: { callModel: slow } }) } });
    check('a manual listing-only refresh during it is also refused (no duplicate run)', p3.status === 'skipped' && p3.code === 'ALREADY_GENERATING' && slowCalls === 1);
    release!();
    const first = await p1;
    check('the first refresh completes its Listing Advice normally', first.listings.status === 'completed');

    console.log('\n[H — dismissal + resurface (real DB, existing dismissals table)]');
    const clientA = await signIn(emailA);
    const clientB = await signIn(emailB);
    const latestA = (await getLatestListingAdvice(admin, userA)).latest!;
    const res1 = await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: latestA.id, adviceCode: 'L1' });
    check('a user can dismiss their own card', res1.status === 'dismissed' && res1.adviceKey === 'listing:v1:demand:channel:1', res1);
    const active = await getActiveListingDismissals(clientA);
    check('the dismissal is read back through RLS WITH its resurface date (Hidden until <date>)', active.some((d) => d.advice_key === 'listing:v1:demand:channel:1' && res1.status === 'dismissed' && Date.parse(d.resurface_after) === Date.parse(res1.resurfaceAfter)));
    check('the dismissal never modified the advice run', (await admin.from('listing_advice_runs').select('status').eq('id', latestA.id).single()).data?.status === 'completed');
    // a NEW run with the same primary source keeps the same semantic key -> stays dismissed
    const w4 = await runCoachRefresh({ appUserId: userA, serviceClient: admin, deps: refreshDeps(raw(card({ title: 'Completely reworded title' }), card({ advice_code: 'L9', title: 'Brand new topic', source_ids: ['demand:market_trend'] })), makeCtx(14)) });
    const latest4 = (await getLatestListingAdvice(admin, userA)).latest!;
    const keys4 = new Set(await getActiveListingDismissalKeys(clientA));
    check('a NEW refresh producing a reworded card on the same source stays dismissed', latest4.id === w4.listings.rowId && latest4.output!.cards.filter((c) => keys4.has(listingAdviceKey(c))).map((c) => c.advice_code).join() === 'L1');
    check('a card about a different source is visible', latest4.output!.cards.filter((c) => !keys4.has(listingAdviceKey(c))).map((c) => c.advice_code).join() === 'L9');

    const rs = await resurfaceAdvice({ serviceClient: admin, appUserId: userA, adviceKey: 'listing:v1:demand:channel:1' });
    check('Resurface ends the dismissal now (the card is visible again)', rs.status === 'resurfaced' && !(await getActiveListingDismissalKeys(clientA)).includes('listing:v1:demand:channel:1'));
    const { data: kept } = await admin.from('analytics_advice_dismissals').select('dismissed_at, resurface_after').eq('user_id', userA).eq('advice_key', 'listing:v1:demand:channel:1').single();
    check('Resurface keeps the row (dismissed_at history intact) — it never deletes', !!kept && Date.parse(kept.resurface_after) > Date.parse(kept.dismissed_at));
    check('resurfacing an already-visible card is not_found (idempotent, nothing written)', (await resurfaceAdvice({ serviceClient: admin, appUserId: userA, adviceKey: 'listing:v1:demand:channel:1' })).status === 'not_found');
    const res2 = await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: latest4.id, adviceCode: 'L1' });
    const { count: dupCount } = await admin.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userA).eq('advice_key', 'listing:v1:demand:channel:1');
    check('re-dismissing after a resurface upserts (no duplicate row) with a fresh window', res2.status === 'dismissed' && dupCount === 1 && (await getActiveListingDismissalKeys(clientA)).includes('listing:v1:demand:channel:1'));
    check('user B cannot resurface user A\'s dismissal (own rows only)', (await resurfaceAdvice({ serviceClient: admin, appUserId: userB, adviceKey: 'listing:v1:demand:channel:1' })).status === 'not_found' && (await getActiveListingDismissalKeys(clientA)).includes('listing:v1:demand:channel:1'));
    await admin.from('analytics_advice_dismissals').update({ resurface_after: new Date(Date.now() - 1000).toISOString(), dismissed_at: new Date(Date.now() - 31 * 86400000).toISOString() }).eq('user_id', userA).eq('advice_key', 'listing:v1:demand:channel:1');
    check('after the 30-day window the key resurfaces automatically', !(await getActiveListingDismissalKeys(clientA)).includes('listing:v1:demand:channel:1'));

    check('user B cannot dismiss user A\'s advice (not found, nothing written)', (await dismissListingAdviceCard({ db: clientB, serviceClient: admin, appUserId: userB, listingAdviceRunId: latestA.id, adviceCode: 'L1' })).status === 'not_found' && (await admin.from('analytics_advice_dismissals').select('id').eq('user_id', userB)).data?.length === 0);
    check('an unknown card code is not found', (await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: latestA.id, adviceCode: 'NOPE' })).status === 'not_found');
    check('a failed (non-completed) run cannot be dismissed against', (await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: w2.listings.rowId!, adviceCode: 'L1' })).status === 'not_found');
    check('Listing Advice dismissals never affect General Coach keys (namespaced rows only)', (await admin.from('analytics_advice_dismissals').select('advice_key').eq('user_id', userA)).data!.every((r) => (r.advice_key as string).startsWith('listing:')));
    const resurfaceRoute = strip(read('src', 'app', 'api', 'advice-dismissals', 'resurface', 'route.ts'));
    check('the resurface API takes only {adviceKey} in either namespace; the user is resolved server-side', /adviceKey/.test(resurfaceRoute) && /\^\(v2:\|listing:v1:\)/.test(resurfaceRoute) && /resurfaceAdvice\(\{ serviceClient, appUserId: appUser\.id as number, adviceKey \}\)/.test(resurfaceRoute) && !/\buser_id\b/.test(resurfaceRoute));
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
