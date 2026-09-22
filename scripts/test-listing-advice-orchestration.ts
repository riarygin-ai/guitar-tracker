/**
 * test-listing-advice-orchestration.ts
 *
 * Validates the "Run Analytics is the single generation entry point" change:
 *   - /listings has no Generate / Refresh; latest completed advice still
 *     loads; empty state; dismissal (independent of generation)
 *   - the shared workflow (Analytics snapshot -> Business Coach -> Listing
 *     Advice): order, failure isolation, both entry points reuse it, no
 *     second Listing Advice schedule, no exposed generation endpoint
 *   - REAL DB: Listing Advice generated through the workflow, a failed
 *     generation preserves the previous completed advice, one-in-flight
 *     protection, dismissal semantics (identity, namespace, resurface,
 *     isolation) on the existing dismissals table
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
import { runAnalyticsWorkflow, runAiStagesForRun, type AnalyticsWorkflowDeps } from '../src/lib/analytics/runAnalyticsWorkflow';
import { AnalyticsRunError } from '../src/lib/analytics/runAnalytics';
import { generateListingAdvice, getLatestListingAdvice, type GenerateListingAdviceOutcome } from '../src/lib/analytics/listingAdvice/generateListingAdvice';
import { dismissListingAdviceCard, getActiveListingDismissalKeys } from '../src/lib/analytics/listingAdvice/listingAdviceDismissal';
import { listingAdviceKey, pickListingPrimarySource } from '../src/lib/listingAdviceKey';
import { computeAdviceKey } from '../src/lib/analytics/advice/adviceKey';
import { buildListingDemandContext } from '../src/lib/analytics/advice/listingDemandContext';
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

function makeCtx() {
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
  const items: ItemActivityEntry[] = [{ item_id: 5, item_display_name: 'Fixture Strat', active_channels: [{ channel_id: 1, channel_name: 'Marketplace' }], item_attributed_leads: 9, serious_plus_attributed_leads: 4, offer_attributed_leads: 3, item_listing_days: 28, channel_listing_days: 28, last_attributed_lead_date: '2026-09-18' }];
  return buildListingDemandContext(ev, items);
}
const CTX = makeCtx();
const card = (over: Record<string, unknown> = {}) => ({ advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'Marketplace response per exposure rose', summary: 'Recorded leads per 100 channel-days rose across the four weeks.', why_it_matters: 'Response per exposure is the fairer comparison.', next_steps: [], source_ids: ['demand:channel:1'], limitations: [], ...over });
const raw = (...cards: Record<string, unknown>[]) => JSON.stringify({ schema_version: '1.0', cards });

const fakeRun = { id: 4242 } as unknown as Awaited<ReturnType<typeof import('../src/lib/analytics/runAnalytics').runAnalyticsForCurrentUser>>;

async function main() {
  console.log('\n[A — /listings is display-only for generation; empty state; dismissal UI]');
  {
    const sec = strip(read('src', 'components', 'listings', 'ListingAdviceSection.tsx'));
    const drawer = strip(read('src', 'components', 'listings', 'ListingAdviceDrawer.tsx'));
    const page = strip(read('src', 'app', 'listings', 'page.tsx'));
    const client = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdviceClient.ts'));
    check('NO "Generate Listing Advice" button anywhere on /listings (section, drawer, page)', ![sec, drawer, page].some((t) => /Generate Listing Advice/.test(t)));
    check('NO "Refresh Advice" button anywhere on /listings', ![sec, drawer, page].some((t) => /Refresh Advice/.test(t)));
    check('no dead/disabled generation controls left behind', !/data-advice-generate|onClick=\{generate\}|const generate\b|generating|Generating/.test(sec));
    check('no code path on the client can generate advice (only fetch + dismiss)', !/method: 'POST'[\s\S]{0,200}\/api\/listing-advice['`]/.test(client) && /dismissListingAdvice/.test(client) && !/requestListingAdviceGeneration/.test(client + sec + page));
    check('latest completed persisted advice still loads (SWR cache key listing-advice:latest, no polling)', /useSwrResource\(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice\)/.test(sec) && !/setInterval|polling|BroadcastChannel|storage/i.test(sec));
    check('empty state: "No Listing Advice has been generated yet."', sec.includes('L.noneYet') && adviceLabels('en').noneYet === 'No Listing Advice has been generated yet.');
    check('admin-only "Run Analytics" link to the Analytics page in the empty state', /viewer_is_admin && \(\s*<Link href="\/analytics"[^>]*>\{L\.runAnalytics\}<\/Link>/.test(sec) && adviceLabels('en').runAnalytics === 'Run Analytics');
    check('a non-admin sees no Run Analytics link (gated on viewer_is_admin)', (sec.match(/L\.runAnalytics/g) ?? []).length === 1 && /data\?\.viewer_is_admin/.test(sec));
    check('0 cards: calm "No material listing advice"; all dismissed: calm notice pointing at the next Analytics run', sec.includes('L.noMaterialAdvice') && adviceLabels('en').noMaterialAdvice === 'No material listing advice for this window.' && sec.includes('L.allDismissed') && /dismissed all current Listing Advice\. New advice appears after the next Analytics run\./.test(adviceLabels('en').allDismissed));
    check('dismissal remains: Dismiss control per card, optimistic + persisted + rolled back on failure', /data-advice-dismiss/.test(sec) && /setHiddenKeys\(\(prev\) => \[\.\.\.prev, key\]\)/.test(sec) && /setHiddenKeys\(\(prev\) => prev\.filter\(\(k\) => k !== key\)\)/.test(sec));
    check('dismissed keys from the server hide cards (independent of generation)', /data\?\.dismissed_keys/.test(sec) && /allCards\.filter\(\(c\) => !dismissed\.has\(listingAdviceKey\(c\)\)\)/.test(sec));
    check('the dismiss control is a sibling of the card button (no nested buttons)', /<button[\s\S]*?data-advice-card[\s\S]*?<\/button>\s*<div className="flex justify-end[^"]*">\s*<button[\s\S]*?data-advice-dismiss/.test(sec));
    const layout = read('src', 'app', 'layout.tsx');
    check('no navigation change', (layout.match(/<nav[\s\S]*?<\/nav>/g) ?? []).every((nav) => JSON.stringify((nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim())) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations'])));
  }

  console.log('\n[B — shared workflow: order, stages, failure isolation (injected stages)]');
  {
    const calls: string[] = [];
    const deps = (over: Partial<AnalyticsWorkflowDeps> = {}): AnalyticsWorkflowDeps => ({
      runAnalytics: async (p) => { calls.push(`analytics:${p.appUserId}`); return fakeRun; },
      generateCoachAdvice: async (p) => { calls.push(`coach:${p.runId}:${p.mode}:${p.requestingUserId}`); return { status: 'completed', row: { id: 77 } as never }; },
      generateListingAdvice: async (p) => { calls.push(`listing:${p.appUserId}`); return { status: 'completed', run: { id: 88 } as never }; },
      ...over,
    });
    const svc = {} as SupabaseClient;

    const ok = await runAnalyticsWorkflow({ appUserId: 9, serviceClient: svc, deps: deps() });
    check('order: analytics first, then BOTH AI stages for that run/user', calls[0] === 'analytics:9' && calls.slice(1).sort().join() === ['coach:4242:auto:9', 'listing:9'].sort().join(), calls);
    check('result carries the run and both stage outcomes with their persisted row ids', ok.run.id === 4242 && ok.businessCoach.status === 'completed' && ok.businessCoach.rowId === 77 && ok.listingAdvice.status === 'completed' && ok.listingAdvice.rowId === 88);

    calls.length = 0;
    let failedSnapshot: unknown = null;
    try { await runAnalyticsWorkflow({ appUserId: 9, serviceClient: svc, deps: deps({ runAnalytics: async () => { throw new AnalyticsRunError('snapshot failed', 500, 123); } }) }); } catch (e) { failedSnapshot = e; }
    check('a failed snapshot propagates AnalyticsRunError and NO AI stage runs', failedSnapshot instanceof AnalyticsRunError && calls.length === 0, calls);

    calls.length = 0;
    const listingFailed = await runAnalyticsWorkflow({ appUserId: 9, serviceClient: svc, deps: deps({ generateListingAdvice: async () => ({ status: 'failed', run: { id: 90, error_code: 'OPENAI_ERROR', error_message: 'boom' } as never }) }) });
    check('Listing Advice failure: analytics run + Business Coach stay successful, failure is visible', listingFailed.run.id === 4242 && listingFailed.businessCoach.status === 'completed' && listingFailed.listingAdvice.status === 'failed' && listingFailed.listingAdvice.code === 'OPENAI_ERROR' && listingFailed.listingAdvice.rowId === 90);
    const listingThrew = await runAnalyticsWorkflow({ appUserId: 9, serviceClient: svc, deps: deps({ generateListingAdvice: async () => { throw new Error('unexpected'); } }) });
    check('a Listing Advice stage that THROWS is contained (workflow resolves; coach unaffected)', listingThrew.listingAdvice.status === 'failed' && listingThrew.listingAdvice.code === 'THREW' && listingThrew.businessCoach.status === 'completed');
    const coachFailed = await runAnalyticsWorkflow({ appUserId: 9, serviceClient: svc, deps: deps({ generateCoachAdvice: async () => { throw new Error('coach exploded'); } }) });
    check('a Coach failure does not stop Listing Advice (independent stages)', coachFailed.businessCoach.status === 'failed' && coachFailed.listingAdvice.status === 'completed');
    for (const [outcome, status, code] of [
      [{ status: 'already_generating' }, 'skipped', 'ALREADY_GENERATING'],
      [{ status: 'context_unavailable', message: 'down' }, 'failed', 'CONTEXT_UNAVAILABLE'],
      [{ status: 'error', message: 'x' }, 'failed', 'ERROR'],
    ] as [GenerateListingAdviceOutcome, string, string][]) {
      const r = await runAiStagesForRun({ runId: 1, appUserId: 9, serviceClient: svc, deps: deps({ generateListingAdvice: async () => outcome }) });
      check(`Listing Advice outcome ${outcome.status} -> stage ${status}/${code}`, r.listingAdvice.status === status && r.listingAdvice.code === code);
    }
    const order: string[] = [];
    await runAnalyticsWorkflow({ appUserId: 9, serviceClient: svc, deps: deps({ runAnalytics: async () => { order.push('analytics-start'); await new Promise((r) => setTimeout(r, 30)); order.push('analytics-end'); return fakeRun; }, generateCoachAdvice: async () => { order.push('coach'); return { status: 'skipped', reason: 'X' } as never; }, generateListingAdvice: async () => { order.push('listing'); return { status: 'already_generating' }; } }) });
    check('AI stages start only AFTER the snapshot has completed', order.indexOf('analytics-end') < order.indexOf('coach') && order.indexOf('analytics-end') < order.indexOf('listing'), order);
  }

  console.log('\n[C — both entry points reuse ONE workflow; no second schedule; no exposed generation endpoint]');
  {
    const runsRoute = strip(read('src', 'app', 'api', 'analytics', 'runs', 'route.ts'));
    const weekly = strip(read('src', 'lib', 'analytics', 'automation', 'runWeeklyAutomation.ts'));
    const wf = strip(read('src', 'lib', 'analytics', 'runAnalyticsWorkflow.ts'));
    check('Admin Run Analytics route calls runAnalyticsWorkflow', /runAnalyticsWorkflow\(\{[\s\S]*?appUserId: appUser\.id as number/.test(runsRoute));
    check('the scheduled weekly automation calls the SAME runAnalyticsWorkflow', /runAnalyticsWorkflow\(\{ appUserId: targetUserId, serviceClient \}\)/.test(weekly));
    check('neither entry point calls the Coach / Listing Advice generators directly (no drift)', ![runsRoute, weekly].some((t) => /generateAdviceForRun|generateListingAdvice|runAnalyticsForCurrentUser/.test(t)));
    check('the workflow is the ONLY importer of the generateListingAdvice service in src (routes/pages/components never import it)', (() => {
      const hits: string[] = [];
      const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(ts|tsx)$/.test(e.name) && /import \{[^}]*\bgenerateListingAdvice\b[^}]*\}/.test(strip(fs.readFileSync(f, 'utf8')))) hits.push(path.relative(root, f).replace(/\\/g, '/')); } };
      walk(path.join(root, 'src'));
      return hits.join() === 'src/lib/analytics/runAnalyticsWorkflow.ts';
    })());
    check('workflow sequences snapshot -> (Coach ∥ Listing Advice) with per-stage containment and no shared transaction', /await runAnalytics\(/.test(wf) && /Promise\.all\(\[/.test(wf) && (wf.match(/catch \(err\)/g) ?? []).length === 2 && !/transaction|BEGIN|ROLLBACK/i.test(wf));
    check('the two AI systems stay separately persisted (no merged schema; workflow writes to neither table itself)', !/from\('analytics_run_advice'\)|from\('listing_advice_runs'\)/.test(wf));
    const vercel = JSON.parse(read('vercel.json')) as { crons: { path: string; schedule: string }[] };
    check('vercel.json has NO Listing Advice schedule (only the two DST slots of the weekly analytics cron)', vercel.crons.length === 2 && vercel.crons.every((c) => c.path === '/api/cron/weekly-analytics-advice'));
    check('no listing-advice cron route exists', !fs.existsSync(path.join(root, 'src', 'app', 'api', 'cron', 'listing-advice')) && fs.readdirSync(path.join(root, 'src', 'app', 'api', 'cron')).join() === 'weekly-analytics-advice');
    const route = strip(read('src', 'app', 'api', 'listing-advice', 'route.ts'));
    check('DECISION: /api/listing-advice POST was removed (GET only); generation is not exposed over HTTP', /export async function GET/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
    check('the generation SERVICE and its persistence/validation/concurrency code are kept internal', fs.existsSync(path.join(root, 'src', 'lib', 'analytics', 'listingAdvice', 'generateListingAdvice.ts')) && /export async function generateListingAdvice/.test(read('src', 'lib', 'analytics', 'listingAdvice', 'generateListingAdvice.ts')) && /23505/.test(read('src', 'lib', 'analytics', 'listingAdvice', 'generateListingAdvice.ts')));
    check('the weekly automation execution record still tracks the Coach row and now reports the Listing Advice stage', /adviceRowId: number \| null = workflow\.businessCoach\.rowId/.test(weekly) && /listingAdviceStatus: workflow\.listingAdvice\.status/.test(weekly) && /WEEKLY_AUTOMATION_CODE = 'weekly_analytics_advice'/.test(weekly));
    const analyticsPage = read('src', 'app', 'analytics', 'page.tsx');
    check('Run Analytics button label unchanged ("Run Analytics"); helper text explains the complete workflow', />\s*'Run Analytics'\s*\)/.test(analyticsPage.replace(/\s+/g, ' ').replace(/ \) : \(/g, ') : (')) || /'Run Analytics'/.test(analyticsPage));
    check('helper text: "refreshes Business Coach and Listing Advice"', /Runs the complete business analytics snapshot and refreshes Business Coach and Listing Advice\./.test(analyticsPage) && !/Run Analytics \+/.test(analyticsPage));
    check('admin UI shows a compact stage line (snapshot / Business Coach / Listing Advice) with the failure visible', /data-run-stages/.test(analyticsPage) && /Listing Advice <StageStatus/.test(analyticsPage) && /Business Coach <StageStatus/.test(analyticsPage) && /payload\.stages\?\.listing_advice/.test(analyticsPage));
    check('after a run the client advice cache is invalidated so /listings resolves the new advice', /invalidateListingAdviceCache\(\)/.test(analyticsPage));
    check('the run API reports each stage (snapshot success is never masked by an AI stage failure)', /stages: \{ analytics: \{ status: 'completed' \}, business_coach: businessCoach, listing_advice: listingAdvice \}/.test(runsRoute));
  }

  console.log('\n[D — dismissal identity (pure)]');
  {
    check('key is derived only from cited sources: item > channel > market > data quality', pickListingPrimarySource(['demand:market_trend', 'demand:channel:2', 'demand:item:55']) === 'demand:item:55' && pickListingPrimarySource(['demand:market_trend', 'demand:channel:2']) === 'demand:channel:2' && pickListingPrimarySource(['demand:data_quality', 'demand:market_trend']) === 'demand:market_trend' && pickListingPrimarySource([]) === '');
    check('LLM wording never affects the key (title/summary reworded, same sources -> same key)', listingAdviceKey({ source_ids: ['demand:item:55'] }) === listingAdviceKey({ source_ids: ['demand:item:55'] }) && listingAdviceKey({ source_ids: ['demand:item:55', 'demand:channel:1'] }) === listingAdviceKey({ source_ids: ['demand:channel:1', 'demand:item:55'] }));
    check('different primary source -> different key', listingAdviceKey({ source_ids: ['demand:item:55'] }) !== listingAdviceKey({ source_ids: ['demand:item:56'] }));
    check('Listing Advice keys are namespaced and can never collide with general Coach keys', listingAdviceKey({ source_ids: ['demand:market_trend'] }) === 'listing:v1:demand:market_trend' && computeAdviceKey({ item_id: null, source_ids: ['demand:market_trend'] }) === 'v2:-:demand:market_trend' && listingAdviceKey({ source_ids: ['demand:market_trend'] }) !== computeAdviceKey({ item_id: null, source_ids: ['demand:market_trend'] }));
    const dis = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdviceDismissal.ts'));
    check('reuses the existing dismissals table + 30-day resurface policy; never writes advice rows', /analytics_advice_dismissals/.test(dis) && /30 \* 24 \* 60 \* 60 \* 1000/.test(dis) && !/from\('listing_advice_runs'\)\s*\.(update|delete|insert)/.test(dis));
    const migs = fs.readdirSync(path.join(root, 'supabase', 'migrations')).sort();
    check('orchestration change added no migration of its own (Listing Advice table is still the latest orchestration-era migration; the later one is the additive preferred_language column)', migs.includes('20260920000000_listing_advice_runs.sql') && migs[migs.length - 1] === '20260921000000_app_users_preferred_language.sql', migs[migs.length - 1]);
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

  const loadContext = async () => CTX;
  let modelCalls = 0;
  const modelReturning = (r: string) => async (_p: ListingAdvicePacket) => { modelCalls++; return { raw: r, model: 'injected' }; };
  // Real Listing Advice service (real DB) with an injected model, called THROUGH the shared workflow.
  const workflowDeps = (r: string | (() => Promise<{ raw: string; model: string }>)): AnalyticsWorkflowDeps => ({
    runAnalytics: async () => fakeRun,
    generateCoachAdvice: async () => ({ status: 'skipped', reason: 'TEST' }) as never,
    generateListingAdvice: (p) => generateListingAdvice({ ...p, deps: { loadContext, callModel: typeof r === 'string' ? modelReturning(r) : r } }),
  });

  try {
    console.log('\n[E — Listing Advice generated through the workflow (real DB)]');
    const empty = await getLatestListingAdvice(admin, userA);
    check('before any run: no latest advice (empty state)', empty.latest === null && !empty.generating && empty.last_failure === null);
    const w1 = await runAnalyticsWorkflow({ appUserId: userA, serviceClient: admin, deps: workflowDeps(raw(card(), card({ advice_code: 'L2', advice_type: 'watch', title: 'Kijiji watch', source_ids: ['demand:item:5'] }))) });
    check('a workflow run generates Listing Advice (completed, persisted)', w1.listingAdvice.status === 'completed' && typeof w1.listingAdvice.rowId === 'number');
    const l1 = await getLatestListingAdvice(admin, userA);
    check('/listings can now resolve it as the latest completed advice (2 cards)', l1.latest?.id === w1.listingAdvice.rowId && l1.latest?.output?.cards.length === 2);

    console.log('\n[F — failed generation preserves the previous completed advice]');
    const w2 = await runAnalyticsWorkflow({ appUserId: userA, serviceClient: admin, deps: workflowDeps(async () => { throw new Error('openai down'); }) });
    check('the failed Listing Advice stage does not fail the workflow/run', w2.run.id === 4242 && w2.listingAdvice.status === 'failed' && w2.listingAdvice.code === 'OPENAI_ERROR');
    const l2 = await getLatestListingAdvice(admin, userA);
    check('the previous completed advice is still the latest', l2.latest?.id === l1.latest?.id);
    const { data: failedRow } = await admin.from('listing_advice_runs').select('status, input_hash, error_code').eq('id', w2.listingAdvice.rowId!).single();
    check('the failed run is preserved for audit (packet hash + error code)', failedRow?.status === 'failed' && failedRow?.error_code === 'OPENAI_ERROR' && failedRow?.input_hash.length === 64);
    check('admins can see the failure note data (last_failure) while the old advice is served', l2.last_failure?.error_code === 'OPENAI_ERROR');
    const w3 = await runAnalyticsWorkflow({ appUserId: userA, serviceClient: admin, deps: workflowDeps(raw(card({ advice_code: 'L1', title: 'Newer run' }))) });
    const l3 = await getLatestListingAdvice(admin, userA);
    check('the next successful Analytics run supersedes it as the new latest', l3.latest?.id === w3.listingAdvice.rowId && l3.latest?.id !== l1.latest?.id && l3.last_failure === null);

    console.log('\n[G — one in-flight generation still protected (through the workflow)]');
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let slowCalls = 0;
    const slow = async () => { slowCalls++; await gate; return { raw: raw(card()), model: 'm' }; };
    const p1 = runAnalyticsWorkflow({ appUserId: userB, serviceClient: admin, deps: workflowDeps(slow) });
    await new Promise((r) => setTimeout(r, 400));
    const p2 = await runAnalyticsWorkflow({ appUserId: userB, serviceClient: admin, deps: workflowDeps(slow) });
    check('a second simultaneous workflow skips Listing Advice (already generating) with no second model call', p2.listingAdvice.status === 'skipped' && p2.listingAdvice.code === 'ALREADY_GENERATING' && slowCalls === 1);
    release!();
    const first = await p1;
    check('the first workflow completes its Listing Advice normally', first.listingAdvice.status === 'completed');

    console.log('\n[H — dismissal (real DB, existing dismissals table)]');
    const clientA = await signIn(emailA);
    const clientB = await signIn(emailB);
    const latestA = (await getLatestListingAdvice(admin, userA)).latest!;
    const res1 = await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: latestA.id, adviceCode: 'L1' });
    check('a user can dismiss their own card (independent of generation)', res1.status === 'dismissed' && res1.adviceKey === 'listing:v1:demand:channel:1', res1);
    check('the dismissal is active and read back through RLS', (await getActiveListingDismissalKeys(clientA)).includes('listing:v1:demand:channel:1'));
    check('the dismissal never modified the advice run (immutable, still completed with its cards)', (await admin.from('listing_advice_runs').select('status, output').eq('id', latestA.id).single()).data?.status === 'completed');
    const dismissedKeys = new Set(await getActiveListingDismissalKeys(clientA));
    check('the dismissed card is hidden by key; other cards remain', !!latestA.output && latestA.output.cards.filter((c) => !dismissedKeys.has(listingAdviceKey(c))).length === latestA.output.cards.length - latestA.output.cards.filter((c) => dismissedKeys.has(listingAdviceKey(c))).length);
    // a NEW run with the same primary source keeps the same semantic key -> stays dismissed
    const w4 = await runAnalyticsWorkflow({ appUserId: userA, serviceClient: admin, deps: workflowDeps(raw(card({ title: 'Completely reworded title', summary: 'Different wording, same evidence.' }), card({ advice_code: 'L9', title: 'Brand new topic', source_ids: ['demand:market_trend'] }))) });
    const latest4 = (await getLatestListingAdvice(admin, userA)).latest!;
    const keys4 = new Set(await getActiveListingDismissalKeys(clientA));
    check('a NEW Analytics run producing a reworded card on the same source stays dismissed (semantic identity)', latest4.id === w4.listingAdvice.rowId && latest4.output!.cards.filter((c) => keys4.has(listingAdviceKey(c))).map((c) => c.advice_code).join() === 'L1');
    check('a card about a different source is visible', latest4.output!.cards.filter((c) => !keys4.has(listingAdviceKey(c))).map((c) => c.advice_code).join() === 'L9');
    const res2 = await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: latest4.id, adviceCode: 'L1' });
    const { count: dupCount } = await admin.from('analytics_advice_dismissals').select('id', { count: 'exact', head: true }).eq('user_id', userA).eq('advice_key', 'listing:v1:demand:channel:1');
    check('re-dismissing the same key upserts (no duplicate row) and refreshes the window', res2.status === 'dismissed' && dupCount === 1);
    await admin.from('analytics_advice_dismissals').update({ resurface_after: new Date(Date.now() - 1000).toISOString(), dismissed_at: new Date(Date.now() - 31 * 86400000).toISOString() }).eq('user_id', userA).eq('advice_key', 'listing:v1:demand:channel:1');
    check('after the 30-day window the key resurfaces (no longer active)', !(await getActiveListingDismissalKeys(clientA)).includes('listing:v1:demand:channel:1'));

    check('user B cannot dismiss user A\'s advice (not found, nothing written)', (await dismissListingAdviceCard({ db: clientB, serviceClient: admin, appUserId: userB, listingAdviceRunId: latestA.id, adviceCode: 'L1' })).status === 'not_found' && (await admin.from('analytics_advice_dismissals').select('id').eq('user_id', userB)).data?.length === 0);
    check('an unknown card code is not found', (await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: latestA.id, adviceCode: 'NOPE' })).status === 'not_found');
    check('a failed (non-completed) run cannot be dismissed against', (await dismissListingAdviceCard({ db: clientA, serviceClient: admin, appUserId: userA, listingAdviceRunId: w2.listingAdvice.rowId!, adviceCode: 'L1' })).status === 'not_found');
    check('user B\'s active dismissal keys never include A\'s', !(await getActiveListingDismissalKeys(clientB)).includes('listing:v1:demand:channel:1'));
    check('Listing Advice dismissals never affect general Coach keys (namespaced rows only)', (await admin.from('analytics_advice_dismissals').select('advice_key').eq('user_id', userA)).data!.every((r) => (r.advice_key as string).startsWith('listing:')));
    const dismissRoute = strip(read('src', 'app', 'api', 'listing-advice', 'dismiss', 'route.ts'));
    check('the dismiss API takes only {listingAdviceRunId, adviceCode}; user + key are resolved server-side', /listingAdviceRunId/.test(dismissRoute) && /adviceCode/.test(dismissRoute) && !/\buser_id\b|\badvice_key\b/.test(dismissRoute.replace(/advice_key: result\.adviceKey/, '')) && /dismissListingAdviceCard\(\{ db, serviceClient, appUserId: appUser\.id as number/.test(dismissRoute));
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
