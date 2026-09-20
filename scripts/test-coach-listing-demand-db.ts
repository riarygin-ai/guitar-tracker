/**
 * test-coach-listing-demand-db.ts
 *
 * DB-backed validation of the Business Coach Listing Demand enrichment:
 *   - loadListingDemandContext against real rows: reconciles with the
 *     canonical helpers, Purpose-agnostic, NULL-channel lead is
 *     item-attributed but never channel-attributed, other users excluded,
 *     no raw lead data (notes/offer amounts/UUIDs) anywhere in the block
 *   - generateAdviceForRun end to end (OpenAI deliberately disabled — the
 *     generation fails at the OpenAI step AFTER the packet is persisted):
 *     the persisted input_packet carries the exact demand block + demand:*
 *     source ids, and its hash reconciles; and when the demand evidence
 *     fails the Coach still proceeds WITHOUT the block (failure isolation)
 *   - timing (parallel vs sequential fetch) and context size measurements
 *
 * Local Supabase only (safety-gated); every row created is deleted.
 *
 * Usage:  npx tsx scripts/test-coach-listing-demand-db.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { getListingDemandEvidence } from '../src/lib/analytics/listingDemandEvidence';
import { getListingItemActivity } from '../src/lib/analytics/listingItemActivity';
import { buildListingDemandContext, loadListingDemandContext } from '../src/lib/analytics/advice/listingDemandContext';
import { buildAdviceInputPacket } from '../src/lib/analytics/advice/buildInputPacket';
import { hashCanonicalInputPacket } from '../src/lib/analytics/advice/canonicalHash';
import { generateAdviceForRun } from '../src/lib/analytics/advice/generateAdvice';
import { itemActivityWindow } from '../src/lib/listingItemActivityHelpers';
import { ADVICE_SYSTEM_PROMPT } from '../src/lib/openai';
import type { AdviceInputPacket } from '../src/lib/analytics/advice/types';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const PASSWORD = 'Coach-Demand-Fixture-Local-Only-1!';
const NOW = new Date('2026-09-20T15:00:00Z'); // Toronto date 2026-09-20 -> window 2026-08-24 .. 2026-09-20

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
async function lookupId(admin: SupabaseClient, table: string, col: string, val: string, ilike = false): Promise<number> {
  const q = admin.from(table).select('id');
  const { data, error } = await (ilike ? q.ilike(col, val) : q.eq(col, val)).maybeSingle();
  if (error || !data) throw new Error(`${table}.${col}=${val} not found`);
  return data.id as number;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // Guarantee no real OpenAI call can ever happen from this test.
  delete process.env.OPENAI_API_KEY;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, 'coach-demand-fixture-a@example.test'));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, 'coach-demand-fixture-b@example.test'));

  let brandId: number;
  const { data: brandRow } = await admin.from('brands').select('id').eq('name', 'Coach-Demand-Test-Brand').maybeSingle();
  if (brandRow) brandId = brandRow.id as number;
  else { const { data, error } = await admin.from('brands').insert({ name: 'Coach-Demand-Test-Brand' }).select('id').single(); if (error) throw error; brandId = data.id as number; }
  const { data: cat } = await admin.from('item_categories').select('id').eq('name', 'Guitars').single();
  const { data: sub } = await admin.from('item_subtypes').select('id').eq('category_id', cat!.id).eq('name', 'Electric Guitar').single();
  const businessId = await lookupId(admin, 'item_purposes', 'name', 'Business', true);
  const hybridId = await lookupId(admin, 'item_purposes', 'name', 'Hybrid', true);
  const personalId = await lookupId(admin, 'item_purposes', 'name', 'Personal', true);
  const marketplaceId = await lookupId(admin, 'deal_channels', 'name', 'Marketplace');
  const kijijiId = await lookupId(admin, 'deal_channels', 'name', 'Kijiji');
  const reverbId = await lookupId(admin, 'deal_channels', 'name', 'Reverb');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const listingIds: number[] = [];
  const leadIds: number[] = [];
  const sourceIds: number[] = [];
  const runIds: number[] = [];

  try {
    console.log('\n=== Fixtures ===');
    const srcFor = async (userId: number) => {
      const { data, error } = await admin.from('lead_import_sources').upsert({ user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Coach Demand Fixture', spreadsheet_id: `coach-demand-${userId}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
      if (error) throw error;
      sourceIds.push(data.id as number);
      return data.id as number;
    };
    const srcA = await srcFor(userA);
    const srcB = await srcFor(userB);

    const mkItem = async (userId: number, model: string, purposeId: number) => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brandId, item_subtype_id: sub!.id, purpose_id: purposeId, model, status: 'owned', serial_number: `CDF:${crypto.randomUUID().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      const { data: deal, error: dErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: '2026-06-01', deal_channel_id: null }).select('id').single();
      if (dErr) throw dErr;
      dealIds.push(deal.id as number);
      await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: data.id, direction: 'in', total_value: 1000 });
      return data.id as number;
    };
    const listing = async (userId: number, itemId: number, channelId: number, listedAt: string) => {
      const { data, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channelId, status: 'active', listed_at: listedAt, asking_price: 1500, is_ai_generated: false }).select('id').single();
      if (error) throw error;
      listingIds.push(data.id as number);
    };
    const lead = async (userId: number, src: number, itemId: number, o: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_leads').insert({
        user_id: userId, source_id: src, inventory_item_id: itemId, lead_id: crypto.randomUUID(), lead_quality: 'LOW', offer_type: 'NONE', status: 'OPEN',
        source_updated_at: new Date().toISOString(), buyer_message_count: 4, our_message_count: 2, ...o,
      }).select('id').single();
      if (error) throw error;
      leadIds.push(data.id as number);
    };

    // P1 Business — Marketplace only
    const p1 = await mkItem(userA, 'Coach P1 Business', businessId);
    await listing(userA, p1, marketplaceId, '2026-08-01');
    await lead(userA, srcA, p1, { first_contact_at: '2026-09-02', last_contact_at: '2026-09-04', deal_channel_id: marketplaceId, source_channel: 'Marketplace', lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 4321, initial_cash_offer: 4000, notes: 'SECRET-NOTE buyer John Smith 555-0100' });
    await lead(userA, srcA, p1, { first_contact_at: '2026-09-10', last_contact_at: '2026-09-10', deal_channel_id: null, source_channel: 'Other', lead_quality: 'HIGH_INTENT', offer_type: 'TRADE', trade_item: 'SECRET-TRADE-ITEM', cash_component: 0, trade_est_value: 777 });
    await lead(userA, srcA, p1, { first_contact_at: '2026-09-15', last_contact_at: '2026-09-15', deal_channel_id: kijijiId, source_channel: 'Kijiji', lead_quality: 'LOW' }); // tagged Kijiji, item only listed on Marketplace
    await lead(userA, srcA, p1, { first_contact_at: '2026-08-10', last_contact_at: '2026-08-10', deal_channel_id: marketplaceId, source_channel: 'Marketplace' }); // before the 4W window
    // P2 Hybrid — Reverb, exposure but zero leads
    const p2 = await mkItem(userA, 'Coach P2 Hybrid', hybridId);
    await listing(userA, p2, reverbId, '2026-08-01');
    // P3 Personal — Kijiji, two leads
    const p3 = await mkItem(userA, 'Coach P3 Personal', personalId);
    await listing(userA, p3, kijijiId, '2026-08-01');
    await lead(userA, srcA, p3, { first_contact_at: '2026-09-05', last_contact_at: '2026-09-05', deal_channel_id: kijijiId, source_channel: 'Kijiji', lead_quality: 'LOW' });
    await lead(userA, srcA, p3, { first_contact_at: '2026-09-18', last_contact_at: '2026-09-18', deal_channel_id: kijijiId, source_channel: 'Kijiji', lead_quality: 'ENGAGED', offer_type: 'MIXED', trade_item: 'Another secret', cash_component: 250 });
    // P4 realized — must not appear as a currently listed item
    const p4 = await mkItem(userA, 'Coach P4 Sold', businessId);
    await listing(userA, p4, reverbId, '2026-08-01');
    {
      const { data: deal, error } = await admin.from('deals').insert({ user_id: userA, deal_type: 'sale', deal_date: '2026-09-01', deal_channel_id: reverbId, cash_received: 900 }).select('id').single();
      if (error) throw error;
      dealIds.push(deal.id as number);
      await admin.from('deal_items').insert({ user_id: userA, deal_id: deal.id, item_id: p4, direction: 'out', total_value: 900 });
      await admin.from('inventory_items').update({ status: 'sold', sold_date: '2026-09-01' }).eq('id', p4);
    }
    // User B
    const b1 = await mkItem(userB, 'Coach B1 Other User', businessId);
    await listing(userB, b1, marketplaceId, '2026-08-01');
    await lead(userB, srcB, b1, { first_contact_at: '2026-09-05', last_contact_at: '2026-09-05', deal_channel_id: marketplaceId, source_channel: 'Marketplace', notes: 'B-ONLY-NOTE' });

    console.log('\n[A — loader reconciles with the canonical helpers]');
    const t0 = Date.now();
    const ctx = await loadListingDemandContext({ appUserId: userA, serviceClient: admin, now: NOW });
    const loaderMs = Date.now() - t0;
    const evidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: '2026-09-14', endDate: '2026-09-20', trendWeeks: 4 });
    const win = itemActivityWindow(evidence)!;
    const items = await getListingItemActivity({ appUserId: userA, serviceClient: admin, startDate: win.from, endDate: win.to });
    check('window is 4 weekly buckets ending 2026-09-20 (2026-08-24 .. 2026-09-20)', ctx.start_date === '2026-08-24' && ctx.end_date === '2026-09-20' && ctx.market_trend.weeks.length === 4, [ctx.start_date, ctx.end_date]);
    check('loader output === builder over the canonical evidence + item activity (nothing recomputed)', JSON.stringify(ctx) === JSON.stringify(buildListingDemandContext(evidence, items)));
    check('window matches the evidence weekly_trend boundaries exactly', win.from === ctx.start_date && win.to === ctx.end_date);

    console.log('\n[B — semantics on real rows]');
    const ids = [...ctx.items.highest_activity, ...ctx.items.zero_activity_high_exposure].map((i) => i.item_id);
    check('Purpose-agnostic: Business, Personal AND Hybrid items are all present', [p1, p2, p3].every((id) => ids.includes(id)), ids);
    check('realized item and other users\' items are absent', !ids.includes(p4) && !ids.includes(b1));
    const c1 = ctx.items.highest_activity.find((i) => i.item_id === p1)!;
    check('P1: 3 attributed leads (NULL-channel and Kijiji-tagged leads count for the item; the pre-window lead does not)', c1.item_attributed_leads === 3, c1);
    check('P1: Serious+ 2 (SERIOUS + HIGH_INTENT), Offers 2 (CASH + TRADE), last lead 2026-09-15 (period-scoped)', c1.serious_plus_attributed_leads === 2 && c1.offer_attributed_leads === 2 && c1.last_attributed_lead_date === '2026-09-15', c1);
    const c3 = ctx.items.highest_activity.find((i) => i.item_id === p3)!;
    check('P3: 2 leads, 1 offer', c3.item_attributed_leads === 2 && c3.offer_attributed_leads === 1 && c3.serious_plus_attributed_leads === 0, c3);
    check('highest-activity order: P1 (3) before P3 (2)', ctx.items.highest_activity[0].item_id === p1 && ctx.items.highest_activity[1].item_id === p3);
    const z = ctx.items.zero_activity_high_exposure[0];
    check('P2 (Hybrid, zero leads, real exposure) is selected as zero-activity/high-exposure', z.item_id === p2 && z.item_attributed_leads === 0 && z.channel_listing_days > 0 && z.current_active_channels.join() === 'Reverb', z);
    const sumChannelLeads = ctx.channels.reduce((n, c) => n + c.weeks.reduce((m, w) => m + w.channel_attributed_leads, 0), 0);
    const sumMarketLeads = ctx.market_trend.weeks.reduce((n, w) => n + w.leads_started, 0);
    check('market leads_started over 4 weeks = 5 in-window leads', sumMarketLeads === 5, sumMarketLeads);
    check('channel-attributed leads total 3 (< item-attributed 5): the NULL-channel and the Kijiji-tag-on-Marketplace-item leads are item-attributed only', sumChannelLeads === 3, sumChannelLeads);
    check('exactly the canonical channels are present, with the same 4 weeks', ctx.channels.length === evidence.channels.length && ctx.channels.every((c) => c.weeks.length === 4));
    check('a realized deal is reported as a fact by recorded channel (Reverb, week of 09-01), not linked to any lead', ctx.channels.find((c) => c.channel_id === reverbId)!.weeks.reduce((n, w) => n + w.realized_deal_count_by_recorded_channel, 0) === 1);

    console.log('\n[C — privacy on real data]');
    const json = JSON.stringify(ctx);
    check('no notes / trade items / offer amounts / names from the lead rows', !/SECRET|John Smith|555-0100|4321|4000|777|B-ONLY/.test(json), json.match(/SECRET[^"]*/));
    check('no lead UUIDs and no lead_id field', !/lead_id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(json));
    check('no other user\'s data in the block', !json.includes('Coach B1'));

    console.log('\n[D — persisted packet via generateAdviceForRun (OpenAI disabled)]');
    const { data: run, error: runErr } = await admin.from('analytics_runs').insert({
      requested_by_user_id: userA, recommendation_target_user_id: userA, analytics_version: '2.13', evidence_scope: 'shared_business_population', status: 'completed',
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      snapshot: {
        snapshot_schema_version: '2.13', analytics_definition_version: '2.13', generated_at: '2026-09-19T00:00:00Z', evidence_scope: 'shared_business_population',
        insights: { insights_engine_version: 'x', findings_selector_version: 'y', selected_findings: [{ finding_code: 'OPEN_INVENTORY_PRIORITY', headline: 'P1 review', summary: 'Business item aged', confidence: null, metrics: { days_open: 90 }, limitations: [], segment: { item_id: p1 } }] },
      },
    }).select('id').single();
    if (runErr) throw runErr;
    runIds.push(run.id as number);

    const outcome = await generateAdviceForRun({ runId: run.id as number, requestingUserId: userA, serviceClient: admin, mode: 'auto' });
    check('generation reaches the OpenAI step and fails there only because the key is absent (packet was built + persisted)', outcome.status === 'failed' && (outcome as { row: { error_code: string | null } }).row.error_code === 'OPENAI_ERROR', outcome);
    const { data: advRow } = await admin.from('analytics_run_advice').select('input_packet, canonical_input_hash, prompt_template_version').eq('analytics_run_id', run.id).single();
    const packet = advRow!.input_packet as AdviceInputPacket;
    check('the persisted input_packet contains the exact demand block the Coach saw', !!packet.listing_demand && packet.listing_demand.window_weeks === 4 && packet.listing_demand.items.highest_activity.some((i) => i.item_id === p1));
    check('demand:* ids are in allowed_source_ids alongside the insight id', packet.allowed_source_ids.includes('demand:market_trend') && packet.allowed_source_ids.includes(`demand:item:${p1}`) && packet.allowed_source_ids.includes(`insight:OPEN_INVENTORY_PRIORITY:item:${p1}`));
    check('the persisted hash equals the hash of the persisted packet (auditable)', advRow!.canonical_input_hash === hashCanonicalInputPacket(packet));
    check('the packet rebuilt from the saved snapshot + the persisted demand block reproduces the hash exactly', hashCanonicalInputPacket(buildAdviceInputPacket({ runId: run.id as number, analyticsVersion: '2.13', evidenceScope: 'shared_business_population', snapshot: (await admin.from('analytics_runs').select('snapshot').eq('id', run.id).single()).data!.snapshot, listingDemand: packet.listing_demand ?? null }).packet) === advRow!.canonical_input_hash);
    check('revision records the new prompt template version', advRow!.prompt_template_version === 'analytics-advice-v2');
    check('the persisted packet is free of raw lead data', !/SECRET|John Smith|4321|B-ONLY/.test(JSON.stringify(packet)));

    console.log('\n[E — failure isolation: demand evidence failing must not stop the Coach]');
    const failingDemand = new Proxy(admin, {
      get(target, prop, receiver) {
        if (prop === 'rpc') {
          return (fn: string, args: unknown) => (fn === 'build_listing_demand_evidence_v1_1' ? Promise.resolve({ data: null, error: { message: 'simulated demand outage' } }) : target.rpc(fn, args as never));
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as SupabaseClient;
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    const outcome2 = await generateAdviceForRun({ runId: run.id as number, requestingUserId: userA, serviceClient: failingDemand, mode: 'retry' });
    console.error = origError;
    check('Coach still proceeds (reaches the OpenAI step) when demand evidence fails', outcome2.status === 'failed' && (outcome2 as { row: { error_code: string | null } }).row.error_code === 'OPENAI_ERROR', outcome2);
    check('the failure was logged', errors.some((e) => /listing demand enrichment unavailable/.test(e)), errors);
    const { data: rows2 } = await admin.from('analytics_run_advice').select('revision_number, input_packet').eq('analytics_run_id', run.id).order('revision_number', { ascending: true });
    const p2Packet = rows2![1].input_packet as AdviceInputPacket;
    check('the second revision\'s packet simply has NO listing_demand block (no fabricated fallback)', rows2!.length === 2 && !('listing_demand' in p2Packet) && !p2Packet.allowed_source_ids.some((id) => id.startsWith('demand:')));
    check('its existing insight context is intact', p2Packet.allowed_source_ids.join() === `insight:OPEN_INVENTORY_PRIORITY:item:${p1}` && p2Packet.deterministic_insights.length === 1);

    console.log('\n[F — performance & size]');
    const seqStart = Date.now();
    const seqEv = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: '2026-09-14', endDate: '2026-09-20', trendWeeks: 4 });
    const w2 = itemActivityWindow(seqEv)!;
    await getListingItemActivity({ appUserId: userA, serviceClient: admin, startDate: w2.from, endDate: w2.to });
    const seqMs = Date.now() - seqStart;
    const parStart = Date.now();
    await loadListingDemandContext({ appUserId: userA, serviceClient: admin, now: NOW });
    const parMs = Date.now() - parStart;
    console.log(`  INFO: demand enrichment — sequential (evidence then item activity): ${seqMs} ms; concurrent loader: ${parMs} ms (first cold call ${loaderMs} ms)`);
    check('the concurrent loader is not slower than sequential fetching (allowing 50 ms noise)', parMs <= seqMs + 50, { parMs, seqMs });
    console.log(`  INFO: this small fixture's demand block: ${json.length.toLocaleString()} chars (~${Math.round(json.length / 4)} tokens)`);

    // Baseline: the largest real packet the existing pipeline can build from recent local runs
    const { data: recent } = await admin.from('analytics_runs').select('id, snapshot, analytics_version, evidence_scope').eq('status', 'completed').order('id', { ascending: false }).limit(15);
    let baseline = 0;
    for (const r of recent ?? []) {
      const built = buildAdviceInputPacket({ runId: r.id as number, analyticsVersion: r.analytics_version as string, evidenceScope: r.evidence_scope as string, snapshot: r.snapshot });
      if (built.packet) baseline = Math.max(baseline, JSON.stringify(built.packet).length);
    }
    console.log(`  INFO: baseline Advice Input Packet (largest recent local run, no demand): ${baseline.toLocaleString()} chars (~${Math.round(baseline / 4).toLocaleString()} tokens); system prompt now ${ADVICE_SYSTEM_PROMPT.length.toLocaleString()} chars`);
  } finally {
    console.log('\n=== Cleanup ===');
    if (runIds.length) await admin.from('analytics_runs').delete().in('id', runIds);
    if (leadIds.length) await admin.from('item_leads').delete().in('id', leadIds);
    if (listingIds.length) await admin.from('item_listings').delete().in('id', listingIds);
    if (itemIds.length) await admin.from('deal_items').delete().in('item_id', itemIds);
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: inventory_items deleted', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
    const { data: left } = await admin.from('analytics_runs').select('id').in('id', runIds.length ? runIds : [-1]);
    check('cleanup: fixture analytics run (and cascaded advice rows) removed', (left?.length ?? 0) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
