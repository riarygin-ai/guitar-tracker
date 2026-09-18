/**
 * test-lead-drilldown.ts
 *
 * DB-backed validation for the /listings -> /leads drill-down:
 *   - lead_drilldown_channel_attributed_ids_v1_0 (20260918000000) returns
 *     EXACTLY the channel-attributed cohort Listing Demand Evidence counts
 *     (reconciled against getListingDemandEvidence itself)
 *   - period boundaries, exact listing-exposure attribution (cancelled
 *     cycle, stale-active realized item, before-listing/after-end dates,
 *     wrong channel, NULL channel/date)
 *   - no cross-user leakage (RPC user scoping + RLS on loadLeadsForUser)
 *   - the pure /leads filters reproduce the evidence's Market Activity
 *     weekly Leads / Serious+ counts exactly
 *
 * Local Supabase only (safety-gated like every other scripts/test-*.ts);
 * every row created is deleted before exit.
 *
 * Usage:  npx tsx scripts/test-lead-drilldown.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { getListingDemandEvidence } from '../src/lib/analytics/listingDemandEvidence';
import { loadLeadsForUser } from '../src/lib/leads/leadsServer';
import { applyLeadFilters, EMPTY_LEAD_FILTERS, parseLeadFilters } from '../src/lib/leads/leadFilters';
import { channelAttributedLeadsUrl, channelSeriousPlusUrl, marketWeekLeadsUrl, marketWeekSeriousPlusUrl } from '../src/lib/leads/leadDrilldownUrls';
import { buildChannelActivityRows, buildMarketActivityRows } from '../src/lib/listingDemandDashboardHelpers';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const PASSWORD = 'Lead-Drilldown-Fixture-Local-Only-1!';

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
async function lookupId(admin: SupabaseClient, table: string, col: string, val: string): Promise<number> {
  const { data, error } = await admin.from(table).select('id').eq(col, val).maybeSingle();
  if (error || !data) throw new Error(`${table}.${col}=${val} not found`);
  return data.id as number;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const emailA = 'lead-drilldown-fixture-a@example.test';
  const emailB = 'lead-drilldown-fixture-b@example.test';
  const authA = await ensureAuthUser(admin, emailA);
  const authB = await ensureAuthUser(admin, emailB);
  const userA = await resolveAppUserId(admin, authA);
  const userB = await resolveAppUserId(admin, authB);

  let brandId: number;
  const { data: brandRow } = await admin.from('brands').select('id').eq('name', 'Lead-Drilldown-Test-Brand').maybeSingle();
  if (brandRow) brandId = brandRow.id as number;
  else { const { data, error } = await admin.from('brands').insert({ name: 'Lead-Drilldown-Test-Brand' }).select('id').single(); if (error) throw error; brandId = data.id as number; }
  const { data: cat } = await admin.from('item_categories').select('id').eq('name', 'Guitars').single();
  const { data: sub } = await admin.from('item_subtypes').select('id').eq('category_id', cat!.id).eq('name', 'Electric Guitar').single();
  const subtypeId = sub!.id as number;
  const marketplaceId = await lookupId(admin, 'deal_channels', 'name', 'Marketplace');
  const kijijiId = await lookupId(admin, 'deal_channels', 'name', 'Kijiji');
  const reverbId = await lookupId(admin, 'deal_channels', 'name', 'Reverb');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const listingIds: number[] = [];
  const leadIds: number[] = [];
  const sourceIds: number[] = [];

  async function source(userId: number): Promise<number> {
    const { data, error } = await admin.from('lead_import_sources').upsert(
      { user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Lead Drilldown Fixture', spreadsheet_id: `lead-drilldown-${userId}`, sheet_name: 'Leads', is_enabled: true },
      { onConflict: 'user_id,source_code' },
    ).select('id').single();
    if (error) throw error;
    sourceIds.push(data.id as number);
    return data.id as number;
  }
  async function item(userId: number, key: string, model: string): Promise<number> {
    const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brandId, item_subtype_id: subtypeId, purpose_id: null, model, status: 'owned', serial_number: `LDD:${key}` }).select('id').single();
    if (error) throw error;
    itemIds.push(data.id as number);
    const { data: deal, error: dealErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: '2019-12-01', deal_channel_id: null }).select('id').single();
    if (dealErr) throw dealErr;
    dealIds.push(deal.id as number);
    const { error: diErr } = await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: data.id, direction: 'in', total_value: 100 });
    if (diErr) throw diErr;
    return data.id as number;
  }
  async function listing(userId: number, itemId: number, channelId: number, status: 'active' | 'ended' | 'cancelled', listedAt: string | null, endedAt: string | null, cancelledAt: string | null = null) {
    const { data, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channelId, status, listed_at: listedAt, ended_at: endedAt, cancelled_at: cancelledAt, is_ai_generated: false }).select('id').single();
    if (error) throw error;
    listingIds.push(data.id as number);
  }
  async function lead(userId: number, srcId: number, itemId: number, o: { first: string | null; channel: number | null; quality?: string; sourceChannel?: string }): Promise<number> {
    const { data, error } = await admin.from('item_leads').insert({
      user_id: userId, source_id: srcId, inventory_item_id: itemId, lead_id: crypto.randomUUID(),
      first_contact_at: o.first, last_contact_at: o.first, deal_channel_id: o.channel, source_channel: o.sourceChannel ?? null,
      lead_quality: o.quality ?? 'LOW', offer_type: 'NONE', status: 'OPEN', source_updated_at: new Date().toISOString(),
      buyer_message_count: 3, our_message_count: 1,
    }).select('id').single();
    if (error) throw error;
    leadIds.push(data.id as number);
    return data.id as number;
  }
  const rpc = async (user: number, channel: number, from: string, to: string): Promise<number[]> => {
    const { data, error } = await admin.rpc('lead_drilldown_channel_attributed_ids_v1_0', { p_target_user_id: user, p_deal_channel_id: channel, p_period_start: from, p_period_end: to });
    if (error) throw new Error(`rpc failed: ${error.message}`);
    return ((data ?? []) as { lead_row_id: number }[]).map((r) => r.lead_row_id).sort((a, b) => a - b);
  };

  const P_START = '2020-01-01';
  const P_END = '2020-01-30';

  try {
    console.log('\n=== Fixtures ===');
    const srcA = await source(userA);
    const srcB = await source(userB);

    // I1 — Marketplace ended 2020-01-01..2020-01-20
    const i1 = await item(userA, 'i1', 'Drilldown I1');
    await listing(userA, i1, marketplaceId, 'ended', '2020-01-01', '2020-01-20');
    const L_mkt_start = await lead(userA, srcA, i1, { first: '2020-01-01', channel: marketplaceId, quality: 'SERIOUS' });
    const L_mkt_end = await lead(userA, srcA, i1, { first: '2020-01-20', channel: marketplaceId, quality: 'LOW' });
    const L_mkt_after = await lead(userA, srcA, i1, { first: '2020-01-21', channel: marketplaceId, quality: 'HIGH_INTENT' });
    const L_kij_noexposure = await lead(userA, srcA, i1, { first: '2020-01-05', channel: kijijiId, quality: 'ENGAGED' });
    const L_nochan = await lead(userA, srcA, i1, { first: '2020-01-05', channel: null, sourceChannel: 'Other' });
    const L_nodate = await lead(userA, srcA, i1, { first: null, channel: marketplaceId });

    // I2 — Kijiji active from 2020-01-10 (open-ended)
    const i2 = await item(userA, 'i2', 'Drilldown I2');
    await listing(userA, i2, kijijiId, 'active', '2020-01-10', null);
    const L_kij_first = await lead(userA, srcA, i2, { first: '2020-01-10', channel: kijijiId, quality: 'HIGH_INTENT' });
    const L_kij_before = await lead(userA, srcA, i2, { first: '2020-01-09', channel: kijijiId });
    const L_kij_last = await lead(userA, srcA, i2, { first: '2020-01-30', channel: kijijiId });

    // I3 — Reverb 'active' but item realized 2020-01-10 (stale-active clip)
    const i3 = await item(userA, 'i3', 'Drilldown I3');
    await listing(userA, i3, reverbId, 'active', '2020-01-02', null);
    {
      const { data: deal, error } = await admin.from('deals').insert({ user_id: userA, deal_type: 'sale', deal_date: '2020-01-10', deal_channel_id: null, cash_received: 500 }).select('id').single();
      if (error) throw error;
      dealIds.push(deal.id as number);
      await admin.from('deal_items').insert({ user_id: userA, deal_id: deal.id, item_id: i3, direction: 'out', total_value: 500 });
      await admin.from('inventory_items').update({ status: 'sold', sold_date: '2020-01-10' }).eq('id', i3);
    }
    const L_rev_before_exit = await lead(userA, srcA, i3, { first: '2020-01-08', channel: reverbId, quality: 'ENGAGED' });
    const L_rev_after_exit = await lead(userA, srcA, i3, { first: '2020-01-15', channel: reverbId, quality: 'SERIOUS' });

    // I4 — cancelled Marketplace cycle never generates exposure
    const i4 = await item(userA, 'i4', 'Drilldown I4');
    await listing(userA, i4, marketplaceId, 'cancelled', '2020-01-01', null, '2020-01-02');
    const L_cancelled = await lead(userA, srcA, i4, { first: '2020-01-03', channel: marketplaceId });

    // User B — identical shape, must never leak into A
    const b1 = await item(userB, 'b1', 'Drilldown B1');
    await listing(userB, b1, marketplaceId, 'active', '2020-01-01', null);
    const L_B = await lead(userB, srcB, b1, { first: '2020-01-05', channel: marketplaceId, quality: 'SERIOUS' });

    console.log('\n[A — exact attribution cohort]');
    const mktA = await rpc(userA, marketplaceId, P_START, P_END);
    check('Marketplace: exactly {start-boundary, end-boundary}', JSON.stringify(mktA) === JSON.stringify([L_mkt_start, L_mkt_end].sort((a, b) => a - b)), mktA);
    check('Marketplace: lead the day AFTER ended_at excluded', !mktA.includes(L_mkt_after));
    check('Marketplace: cancelled-cycle lead excluded', !mktA.includes(L_cancelled));
    check('Marketplace: NULL first_contact_at lead excluded', !mktA.includes(L_nodate));
    check('Marketplace: Kijiji-channel lead on I1 never appears under Marketplace', !mktA.includes(L_kij_noexposure));
    const kijA = await rpc(userA, kijijiId, P_START, P_END);
    check('Kijiji: exactly {first exposure day, period end}', JSON.stringify(kijA) === JSON.stringify([L_kij_first, L_kij_last].sort((a, b) => a - b)), kijA);
    check('Kijiji: lead the day BEFORE listed_at excluded', !kijA.includes(L_kij_before));
    check('Kijiji: channel-tagged lead with no Kijiji exposure on that item/day excluded', !kijA.includes(L_kij_noexposure));
    const revA = await rpc(userA, reverbId, P_START, P_END);
    check('Reverb: only the pre-exit lead (stale-active clipped at exit_date)', JSON.stringify(revA) === JSON.stringify([L_rev_before_exit]), revA);
    check('Reverb: post-exit lead excluded', !revA.includes(L_rev_after_exit));
    check('lead with NULL deal_channel_id is in no channel cohort', ![...mktA, ...kijA, ...revA].includes(L_nochan));

    console.log('\n[B — period boundaries]');
    check('period 01-02..01-19 excludes both Marketplace boundary leads', (await rpc(userA, marketplaceId, '2020-01-02', '2020-01-19')).length === 0);
    check('period 01-01..01-01 includes exactly the start-boundary lead', JSON.stringify(await rpc(userA, marketplaceId, '2020-01-01', '2020-01-01')) === JSON.stringify([L_mkt_start]));
    check('period 01-20..01-20 includes exactly the ended_at-day lead', JSON.stringify(await rpc(userA, marketplaceId, '2020-01-20', '2020-01-20')) === JSON.stringify([L_mkt_end]));
    check('period after everything is empty', (await rpc(userA, marketplaceId, '2021-01-01', '2021-01-31')).length === 0);

    console.log('\n[C — reconciles with Listing Demand Evidence itself]');
    const evidence = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: P_START, endDate: P_END, trendWeeks: 4 });
    const payload = await loadLeadsForUser({ db: admin, serviceClient: admin, appUserId: userA, attribution: null });
    const channelRows = buildChannelActivityRows(evidence);
    for (const row of channelRows) {
      const ids = await rpc(userA, row.dealChannelId, evidence.period.start_date, evidence.period.end_date);
      check(`${row.channelName}: RPC count === evidence channel_attributed_leads (${row.attributedLeads})`, ids.length === row.attributedLeads, { rpc: ids.length, evidence: row.attributedLeads });
      // Drill-down URL -> parse -> filter reproduces both numbers through the exact pure path the page uses.
      const url = channelAttributedLeadsUrl({ startDate: evidence.period.start_date, endDate: evidence.period.end_date }, row);
      const seriousUrl = channelSeriousPlusUrl({ startDate: evidence.period.start_date, endDate: evidence.period.end_date }, row);
      if (row.attributedLeads > 0) {
        const f = parseLeadFilters((k) => new URL(url!, 'http://x').searchParams.get(k));
        const set = new Set(ids);
        check(`${row.channelName}: attributed drill-down URL filters to exactly ${row.attributedLeads} leads`, applyLeadFilters(payload.leads, f, set).length === row.attributedLeads);
      } else check(`${row.channelName}: zero count yields no link`, url === null);
      if (row.seriousPlusLeads > 0) {
        const f = parseLeadFilters((k) => new URL(seriousUrl!, 'http://x').searchParams.get(k));
        check(`${row.channelName}: Serious+ drill-down filters to exactly ${row.seriousPlusLeads} leads`, applyLeadFilters(payload.leads, f, new Set(ids)).length === row.seriousPlusLeads);
      } else check(`${row.channelName}: zero Serious+ yields no link`, seriousUrl === null);
    }
    const by = (name: string) => channelRows.find((r) => r.channelName === name)!;
    check('fixture expectation: Marketplace attributed = 2, Serious+ = 1', by('Marketplace').attributedLeads === 2 && by('Marketplace').seriousPlusLeads === 1, by('Marketplace'));
    check('fixture expectation: Kijiji attributed = 2, Serious+ = 1', by('Kijiji').attributedLeads === 2 && by('Kijiji').seriousPlusLeads === 1, by('Kijiji'));
    check('fixture expectation: Reverb attributed = 1, Serious+ = 0', by('Reverb').attributedLeads === 1 && by('Reverb').seriousPlusLeads === 0, by('Reverb'));

    console.log('\n[D — Market Activity weekly drill-down reconciles (leads_started, no channel attribution)]');
    for (const w of buildMarketActivityRows(evidence.weekly_trend)) {
      const leadsUrl = marketWeekLeadsUrl(w);
      const seriousUrl = marketWeekSeriousPlusUrl(w);
      const count = (url: string | null) => url === null ? 0 : applyLeadFilters(payload.leads, parseLeadFilters((k) => new URL(url, 'http://x').searchParams.get(k)), null).length;
      check(`week ${w.startDate}..${w.endDate}: drill-down Leads === leads_started (${w.leadsStarted})`, count(leadsUrl) === w.leadsStarted, { got: count(leadsUrl), want: w.leadsStarted });
      check(`week ${w.startDate}..${w.endDate}: drill-down Serious+ === serious_plus_leads_from_cohort (${w.seriousPlusLeads})`, count(seriousUrl) === w.seriousPlusLeads, { got: count(seriousUrl), want: w.seriousPlusLeads });
    }
    check('summary leads_started reconciles: filter(from..to) === summary', applyLeadFilters(payload.leads, { ...EMPTY_LEAD_FILTERS, from: P_START, to: P_END }, null).length === evidence.summary.current.leads_started);

    console.log('\n[E — user isolation]');
    const bIds = await rpc(userB, marketplaceId, P_START, P_END);
    check('user B RPC returns exactly B\'s own lead', JSON.stringify(bIds) === JSON.stringify([L_B]), bIds);
    check('A\'s cohort never contains B\'s lead', !mktA.includes(L_B));
    check('B\'s cohort never contains any of A\'s leads', bIds.every((id) => id === L_B));
    check('loadLeadsForUser(A) contains no lead of B', !payload.leads.some((l) => l.id === L_B) && payload.leads.length === 12, payload.leads.length);

    const signIn = async (email: string) => {
      const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
      if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
      return c;
    };
    const clientA = await signIn(emailA);
    const clientB = await signIn(emailB);
    const viaRlsA = await loadLeadsForUser({ db: clientA, serviceClient: null, appUserId: userA, attribution: null });
    check('RLS client A: sees all 12 of its own leads', viaRlsA.leads.length === 12, viaRlsA.leads.length);
    const spoof = await loadLeadsForUser({ db: clientA, serviceClient: null, appUserId: userB, attribution: null });
    check('RLS client A asking for B\'s user id gets ZERO leads (RLS, not just the filter)', spoof.leads.length === 0, spoof.leads.length);
    const viaRlsB = await loadLeadsForUser({ db: clientB, serviceClient: null, appUserId: userB, attribution: null });
    check('RLS client B: exactly its own single lead', viaRlsB.leads.length === 1 && viaRlsB.leads[0].id === L_B);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: anonRows } = await anon.from('item_leads').select('id').in('id', leadIds);
    check('unauthenticated client reads no leads', (anonRows?.length ?? 0) === 0);
    check('authenticated user cannot call the attribution RPC directly (service_role only)', await (async () => {
      const { error } = await clientA.rpc('lead_drilldown_channel_attributed_ids_v1_0', { p_target_user_id: userA, p_deal_channel_id: marketplaceId, p_period_start: P_START, p_period_end: P_END });
      return !!error;
    })());

    console.log('\n[F — loadLeadsForUser joins + attribution payload]');
    const withAttr = await loadLeadsForUser({ db: admin, serviceClient: admin, appUserId: userA, attribution: { channelId: marketplaceId, from: P_START, to: P_END } });
    check('attributed payload returns the same ids as the RPC', JSON.stringify([...(withAttr.attributed_lead_ids ?? [])].sort((a, b) => a - b)) === JSON.stringify(mktA));
    check('no attribution requested -> attributed_lead_ids is null', payload.attributed_lead_ids === null);
    const sample = payload.leads.find((l) => l.id === L_mkt_start)!;
    check('item_name assembled from brand + model', sample.item_name === 'Lead-Drilldown-Test-Brand Drilldown I1', sample.item_name);
    check('canonical channel name joined', sample.channel_name === 'Marketplace');
    check('NULL-channel lead keeps source_channel and has no channel_name', payload.leads.find((l) => l.id === L_nochan)!.channel_name === null && payload.leads.find((l) => l.id === L_nochan)!.source_channel === 'Other');
  } finally {
    console.log('\n=== Cleanup ===');
    if (leadIds.length) { const { error } = await admin.from('item_leads').delete().in('id', leadIds); check('cleanup: item_leads deleted', !error, error); }
    if (listingIds.length) { const { error } = await admin.from('item_listings').delete().in('id', listingIds); check('cleanup: item_listings deleted', !error, error); }
    if (itemIds.length) await admin.from('deal_items').delete().in('item_id', itemIds);
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: inventory_items deleted', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
    const { data: remaining } = await admin.from('item_leads').select('id').in('id', leadIds.length ? leadIds : [-1]);
    check('all fixture leads deleted', (remaining?.length ?? 0) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
