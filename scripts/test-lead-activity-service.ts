/**
 * test-lead-activity-service.ts
 *
 * Database-backed coverage for src/lib/analytics/leadActivityService.ts —
 * the dataset behind the read-only MCP get_lead_activity tool (2026-10-14
 * three-layer redesign: current-period lead details + calendar period
 * buckets + lifetime summary).
 *
 * Uses its own dedicated fixture users/items/leads (created and deleted
 * here) so exact counts are deterministic, and a fixed "now" (Wednesday
 * 2026-10-14, Toronto) so calendar buckets are deterministic. Every call
 * goes through a real signed-in (authenticated, RLS-scoped) client.
 *
 * Covers: default weekly shape, month buckets, explicit range, current
 * details, counts vs. raw item_leads, the Explorer regression (quiet now,
 * strong history), item_ids/channel/combined filters, validation, item-set
 * parity with get_inventory_analysis, cross-user isolation, and response
 * size measurement.
 *
 * Usage:  npx tsx scripts/test-lead-activity-service.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning, setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { getLeadActivityForUser, LeadActivityServiceError, type LeadActivityResult } from '../src/lib/analytics/leadActivityService';
import { getInventoryAnalysisForUser } from '../src/lib/analytics/inventoryAnalysisService';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const PASSWORD = 'Lead-Activity-Fixture-Local-Only-1!';
const NOW = new Date('2026-10-14T16:00:00Z'); // Wednesday, Toronto

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
async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}
async function expectError(p: Promise<unknown>): Promise<boolean> {
  try { await p; return false; } catch (e) { return e instanceof LeadActivityServiceError; }
}
const kb = (o: unknown) => (JSON.stringify(o).length / 1024).toFixed(1);

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const emailA = 'lead-activity-fixture-a@example.test';
  const emailB = 'lead-activity-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));

  const brandId = await lookupId(admin, 'brands', 'name', 'Gibson').catch(async () => {
    const { data, error } = await admin.from('brands').insert({ name: 'Gibson' }).select('id').single();
    if (error) throw error;
    return data.id as number;
  });
  const marketplaceId = await lookupId(admin, 'deal_channels', 'name', 'Marketplace');
  const kijijiId = await lookupId(admin, 'deal_channels', 'name', 'Kijiji');
  const reverbId = await lookupId(admin, 'deal_channels', 'name', 'Reverb');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const listingIds: number[] = [];
  const leadIds: number[] = [];
  const sourceIds: number[] = [];

  try {
    console.log('\n=== Fixtures ===');
    const insertItem = async (userId: number, model: string, status: 'owned' | 'sold' = 'owned'): Promise<number> => {
      const { data, error } = await admin.from('inventory_items').insert({
        user_id: userId, brand_id: brandId, purpose_id: null, model, status: 'owned', year: 2019, serial_number: `LA-${crypto.randomUUID().slice(0, 8)}`,
      }).select('id').single();
      if (error) throw error;
      const id = data.id as number;
      itemIds.push(id);
      const { data: deal, error: dErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: '2026-03-01', deal_channel_id: null }).select('id').single();
      if (dErr) throw dErr;
      dealIds.push(deal.id as number);
      await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: id, direction: 'in', total_value: 1000 });
      if (status === 'sold') {
        const { data: sale, error: sErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'sale', deal_date: '2026-09-01', deal_channel_id: reverbId }).select('id').single();
        if (sErr) throw sErr;
        dealIds.push(sale.id as number);
        await admin.from('deal_items').insert({ user_id: userId, deal_id: sale.id, item_id: id, direction: 'out', total_value: 1500 });
        await admin.from('inventory_items').update({ status: 'sold', sold_date: '2026-09-01' }).eq('id', id);
      }
      return id;
    };
    const explorer = await insertItem(userA, 'Explorer (LA fixture)');
    const strat = await insertItem(userA, 'Stratocaster (LA fixture)');
    const quiet = await insertItem(userA, 'Quiet (LA fixture)');
    const sold = await insertItem(userA, 'Sold (LA fixture)', 'sold');
    const itemB = await insertItem(userB, 'B-Only (LA fixture)');

    // Strat is currently listed on Marketplace; Explorer's local exposure ENDED (relist candidate shape).
    const listing = async (userId: number, itemId: number, channelId: number, row: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channelId, is_ai_generated: false, ...row }).select('id').single();
      if (error) throw error;
      listingIds.push(data.id as number);
      return data.id as number;
    };
    const exMkt = await listing(userA, explorer, marketplaceId, { status: 'active', listed_at: '2026-05-25', asking_price: 1900 });
    await admin.from('item_listings').update({ status: 'ended', ended_at: '2026-08-31' }).eq('id', exMkt);
    await listing(userA, strat, marketplaceId, { status: 'active', listed_at: '2026-09-01', asking_price: 1600 });

    const source = async (userId: number) => {
      const { data, error } = await admin.from('lead_import_sources').upsert({ user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Lead Activity Fixture', spreadsheet_id: `la-${userId}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
      if (error) throw error;
      sourceIds.push(data.id as number);
      return data.id as number;
    };
    const srcA = await source(userA);
    const srcB = await source(userB);

    const lead = async (userId: number, srcId: number, itemId: number, o: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_leads').insert({
        user_id: userId, source_id: srcId, inventory_item_id: itemId, lead_id: crypto.randomUUID(), lead_quality: 'LOW', offer_type: 'NONE', status: 'OPEN',
        source_updated_at: new Date().toISOString(), ...o,
      }).select('id').single();
      if (error) throw error;
      leadIds.push(data.id as number);
      return data.id as number;
    };

    // Explorer: 19 historical leads Jun 2 - Aug 18 (Marketplace 12 / Kijiji 7), 16 offers, 13 Serious, 3 High Intent; nothing recent.
    for (let i = 0; i < 19; i++) {
      const d = `2026-0${6 + Math.floor(i / 7)}-${String(2 + (i % 7) * 4).padStart(2, '0')}`;
      const kij = i % 3 === 0;
      await lead(userA, srcA, explorer, {
        first_contact_at: d, last_contact_at: d, deal_channel_id: kij ? kijijiId : marketplaceId, source_channel: kij ? 'Kijiji' : 'Marketplace',
        lead_quality: i < 3 ? 'HIGH_INTENT' : i < 16 ? 'SERIOUS' : i < 18 ? 'ENGAGED' : 'LOW',
        offer_type: i < 16 ? 'CASH' : 'NONE', best_cash_offer: i < 16 ? 1500 + i * 10 : null, status: 'DECLINED_BY_ME', outcome_reason: i < 16 ? 'LOW_OFFER' : null,
      });
    }
    // Strat: current-week activity, a continuing conversation, last week, an undated lead, an old trade offer.
    const s1 = await lead(userA, srcA, strat, { first_contact_at: '2026-10-13', last_contact_at: '2026-10-14', deal_channel_id: marketplaceId, source_channel: 'Marketplace', lead_quality: 'SERIOUS', offer_type: 'MIXED', trade_item: 'Fender Jazzmaster', cash_component: 300, buyer_message_count: 6, our_message_count: 4, notes: 'Wants Jazzmaster + $300 to us.' });
    const s2 = await lead(userA, srcA, strat, { first_contact_at: '2026-10-14', last_contact_at: '2026-10-14', deal_channel_id: reverbId, source_channel: 'Reverb', lead_quality: 'ENGAGED' });
    const s3 = await lead(userA, srcA, strat, { first_contact_at: '2026-10-01', last_contact_at: '2026-10-13', deal_channel_id: kijijiId, source_channel: 'Kijiji', lead_quality: 'HIGH_INTENT', offer_type: 'CASH', initial_cash_offer: 1400, best_cash_offer: 1500 });
    await lead(userA, srcA, strat, { first_contact_at: '2026-10-06', last_contact_at: '2026-10-06', deal_channel_id: marketplaceId, source_channel: 'Marketplace', status: 'GHOSTED' });
    await lead(userA, srcA, strat, { first_contact_at: null, deal_channel_id: null, source_channel: 'FB Group' });
    await lead(userA, srcA, strat, { first_contact_at: '2026-03-02', last_contact_at: '2026-03-03', deal_channel_id: marketplaceId, source_channel: 'Marketplace', lead_quality: 'SERIOUS', offer_type: 'TRADE', trade_item: 'Gibson SG', cash_component: 0 });
    // Sold item lead (closed inventory — not part of the open set).
    await lead(userA, srcA, sold, { first_contact_at: '2026-10-13', notes: 'SOLD-ITEM-NOTE' });
    // User B — must never leak.
    await lead(userB, srcB, itemB, { first_contact_at: '2026-10-13', last_contact_at: '2026-10-13', deal_channel_id: marketplaceId, lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 99, notes: 'B-ONLY-NOTE' });

    const clientA = await signIn(emailA, PASSWORD);
    const clientB = await signIn(emailB, PASSWORD);
    const ex = (r: LeadActivityResult) => r.items.find((i) => i.item_id === explorer);
    const st = (r: LeadActivityResult) => r.items.find((i) => i.item_id === strat);

    console.log('\n[A — {} = weekly review: current week details + 4 complete weeks + lifetime]');
    const def = await getLeadActivityForUser(clientA, {}, NOW);
    {
      check('today is the Toronto date', def.today === '2026-10-14');
      check('bucket=week, rolling, 5 buckets', def.bucket === 'week' && def.mode === 'rolling' && def.periods.length === 5);
      check('current week Oct 12-14 partial; prior 4 weeks complete', def.current_period.start_date === '2026-10-12' && def.current_period.end_date === '2026-10-14' && def.current_period.is_partial && def.periods.slice(0, 4).every((p) => !p.is_partial));
      check('items with leads: Explorer + Strat; Quiet in items_without_leads', def.items.map((i) => i.item_id).sort().join() === [explorer, strat].sort().join() && def.items_without_leads.some((i) => i.item_id === quiet), { items: def.items.map((i) => i.item_id), none: def.items_without_leads });
      check('sold item is outside the open set (never present)', !def.items.some((i) => i.item_id === sold) && !def.items_without_leads.some((i) => i.item_id === sold) && !JSON.stringify(def).includes('SOLD-ITEM-NOTE'));
    }

    console.log('\n[B — current-period details are individual lead records]');
    {
      const s = st(def)!;
      check('Strat current week = the 2 leads first contacted Oct 13/14', JSON.stringify(s.current_period.new_leads.map((l) => l.lead_id)) === JSON.stringify([s1, s2]));
      const d1 = s.current_period.new_leads[0];
      check('detail fields carried verbatim from item_leads', d1.channel === 'Marketplace' && d1.quality === 'SERIOUS' && d1.offer_type === 'MIXED' && d1.trade_item === 'Fender Jazzmaster' && d1.cash_component === 300 && d1.buyer_message_count === 6 && d1.our_message_count === 4 && d1.notes === 'Wants Jazzmaster + $300 to us.' && d1.status === 'OPEN' && d1.last_contact_at === '2026-10-14', d1);
      check('offer_summary uses the /leads formatter', d1.offer_summary === 'Fender Jazzmaster + $300 to us');
      check('continuing lead: first contacted Oct 1, still active Oct 13', s.current_period.continuing_leads.length === 1 && s.current_period.continuing_leads[0].lead_id === s3 && s.current_period.continuing_leads[0].best_cash_offer === 1500);
    }

    console.log('\n[C — period buckets and lifetime match raw item_leads]');
    {
      const { data: raw } = await admin.from('item_leads').select('inventory_item_id, first_contact_at, lead_quality, offer_type, deal_channel_id, source_channel').in('inventory_item_id', [explorer, strat]);
      const rows = raw ?? [];
      const chName = (r: { deal_channel_id: number | null; source_channel: string | null }) =>
        r.deal_channel_id === marketplaceId ? 'Marketplace' : r.deal_channel_id === kijijiId ? 'Kijiji' : r.deal_channel_id === reverbId ? 'Reverb' : (r.source_channel ?? 'Unknown');
      let bucketMismatches = 0;
      let bucketsChecked = 0;
      for (const item of def.items) {
        const mine = rows.filter((r) => r.inventory_item_id === item.item_id);
        const L = item.lifetime;
        check(`item ${item.item_id}: lifetime lead_count matches raw`, L.lead_count === mine.length);
        check(`item ${item.item_id}: lifetime offers match raw (offer_type <> NONE)`, L.offer_count === mine.filter((r) => r.offer_type !== 'NONE').length);
        check(`item ${item.item_id}: Serious / High Intent match raw`, L.serious_count === mine.filter((r) => r.lead_quality === 'SERIOUS').length && L.high_intent_count === mine.filter((r) => r.lead_quality === 'HIGH_INTENT').length);
        const expectCh: Record<string, number> = {};
        for (const r of mine) expectCh[chName(r)] = (expectCh[chName(r)] ?? 0) + 1;
        check(`item ${item.item_id}: lifetime by_channel matches raw`, JSON.stringify(Object.entries(L.by_channel).sort()) === JSON.stringify(Object.entries(expectCh).sort()), { got: L.by_channel, expectCh });
        for (const [k, p] of Array.from(item.periods.entries())) {
          const inP = mine.filter((r) => r.first_contact_at && r.first_contact_at >= p.start_date && r.first_contact_at <= p.end_date);
          bucketsChecked++;
          if (p.lead_count !== inP.length || p.offer_count !== inP.filter((r) => r.offer_type !== 'NONE').length || p.serious_plus_count !== inP.filter((r) => r.lead_quality === 'SERIOUS' || r.lead_quality === 'HIGH_INTENT').length) {
            bucketMismatches++;
            console.log(`    mismatch: item ${item.item_id} bucket ${k}`, { p, raw: inP.length });
          }
        }
      }
      check(`all ${bucketsChecked} item buckets match raw counts (lead/offer/Serious+)`, bucketsChecked === 10 && bucketMismatches === 0, { bucketsChecked, bucketMismatches });
      check('Strat weekly buckets = [0,0,1,1,2]', JSON.stringify(st(def)!.periods.map((p) => p.lead_count)) === JSON.stringify([0, 0, 1, 1, 2]));
      check('Strat current-week channel breakdown', JSON.stringify(st(def)!.periods[4].by_channel) === JSON.stringify({ Marketplace: 1, Reverb: 1 }));
      check('undated lead only in lifetime', st(def)!.lifetime.undated_lead_count === 1 && st(def)!.lifetime.by_channel['FB Group'] === 1);
      check('totals.lifetime sums the items', def.totals.lifetime.lead_count === 25);
    }

    console.log('\n[D — Explorer regression: quiet now, strong history]');
    {
      const e = ex(def)!;
      check('Explorer is still represented despite zero recent leads and ENDED listing exposure', !!e);
      check('Explorer current week: 0 new, 0 continuing', e.current_period.new_leads.length === 0 && e.current_period.continuing_leads.length === 0);
      check('Explorer recent weekly buckets all zero', e.periods.every((p) => p.lead_count === 0));
      check('Explorer lifetime: 19 leads / 16 offers / 13 Serious / 3 High Intent', e.lifetime.lead_count === 19 && e.lifetime.offer_count === 16 && e.lifetime.serious_count === 13 && e.lifetime.high_intent_count === 3, e.lifetime);
      check('Explorer lifetime channels: Marketplace 12 / Kijiji 7', e.lifetime.by_channel.Marketplace === 12 && e.lifetime.by_channel.Kijiji === 7);
      check('Explorer first/last/last-Serious+ dates', e.lifetime.first_lead_date === '2026-06-02' && e.lifetime.last_lead_date === '2026-08-18' && e.lifetime.last_serious_plus_lead_date === '2026-08-06', e.lifetime);
      const m = await getLeadActivityForUser(clientA, { bucket: 'month' }, NOW);
      check('Explorer monthly trend Jun..Oct = 7/7/5/0/0', JSON.stringify(ex(m)!.periods.map((p) => p.lead_count)) === JSON.stringify([7, 7, 5, 0, 0]));
    }

    console.log('\n[E — month buckets and explicit range]');
    {
      const m = await getLeadActivityForUser(clientA, { bucket: 'month' }, NOW);
      check('month: Jun..Oct, October partial', m.periods.map((p) => p.start_date).join() === '2026-06-01,2026-07-01,2026-08-01,2026-09-01,2026-10-01' && m.current_period.is_partial && m.periods.slice(0, 4).every((p) => !p.is_partial));
      check('month: October details = all 4 October-first-contact Strat leads', st(m)!.current_period.new_leads.length === 4 && st(m)!.current_period.new_leads.every((l) => l.first_contact_at!.startsWith('2026-10')), st(m)!.current_period.new_leads.map((l) => l.first_contact_at));
      const p2 = await getLeadActivityForUser(clientA, { periods: 1 }, NOW);
      check('periods=1 -> 2 weekly buckets', p2.periods.length === 2);
      const range = await getLeadActivityForUser(clientA, { bucket: 'month', from_date: '2026-06-01', to_date: '2026-08-31' }, NOW);
      check('explicit Jun 1 - Aug 31 by month: 3 complete buckets, current_period = August', range.mode === 'explicit' && range.periods.length === 3 && range.periods.every((p) => !p.is_partial) && range.current_period.start_date === '2026-08-01');
      check('explicit range: Explorer August details = 5 leads; lifetime unchanged', ex(range)!.current_period.new_leads.length === 5 && ex(range)!.lifetime.lead_count === 19);
      check('explicit range: Strat has no in-range leads but keeps lifetime', st(range)!.periods.every((p) => p.lead_count === 0) && st(range)!.lifetime.lead_count === 6);
      check('periods + from_date rejected', await expectError(getLeadActivityForUser(clientA, { from_date: '2026-06-01', periods: 2 }, NOW)));
      check('to_date alone rejected', await expectError(getLeadActivityForUser(clientA, { to_date: '2026-06-01' }, NOW)));
      check('from_date after to_date rejected', await expectError(getLeadActivityForUser(clientA, { from_date: '2026-07-01', to_date: '2026-06-01' }, NOW)));
    }

    console.log('\n[F — filters]');
    {
      const ids = await getLeadActivityForUser(clientA, { item_ids: [explorer] }, NOW);
      check('item_ids: exactly Explorer', ids.items.length === 1 && ids.items[0].item_id === explorer && ids.items_without_leads.length === 0);
      const idsQuiet = await getLeadActivityForUser(clientA, { item_ids: [quiet] }, NOW);
      check('item_ids on a lead-less item -> items_without_leads', idsQuiet.items.length === 0 && idsQuiet.items_without_leads.length === 1);
      const idsSold = await getLeadActivityForUser(clientA, { item_ids: [sold] }, NOW);
      check('item_ids on a sold item -> nothing (same open set as get_inventory_analysis)', idsSold.items.length === 0 && idsSold.items_without_leads.length === 0);
      const kij = await getLeadActivityForUser(clientA, { channel: ['kijiji'] }, NOW);
      check('channel=Kijiji: Explorer lifetime 7, Strat lifetime 1, only Kijiji anywhere', ex(kij)!.lifetime.lead_count === 7 && st(kij)!.lifetime.lead_count === 1 && kij.items.every((i) => Object.keys(i.lifetime.by_channel).join() === 'Kijiji'));
      check('channel=Kijiji: Strat continuing lead kept, no new leads this week', st(kij)!.current_period.new_leads.length === 0 && st(kij)!.current_period.continuing_leads.length === 1);
      const rev = await getLeadActivityForUser(clientA, { channel: ['Reverb'] }, NOW);
      check('channel=Reverb: only Strat; Explorer moves to items_without_leads', rev.items.length === 1 && rev.items[0].item_id === strat && rev.items_without_leads.some((i) => i.item_id === explorer));
      const combo = await getLeadActivityForUser(clientA, { item_ids: [strat], channel: ['Marketplace'], bucket: 'month', periods: 1 }, NOW);
      check('combined item_ids + channel + month + periods', combo.items.length === 1 && combo.periods.length === 2 && combo.items[0].lifetime.lead_count === 3 && combo.items[0].periods[1].lead_count === 2, combo.items[0]?.periods);
      const none = await getLeadActivityForUser(clientA, { channel: ['ZZZ_NO_SUCH_CHANNEL'] }, NOW);
      check('a channel matching nothing returns empty items, not an error', none.items.length === 0);
    }

    console.log('\n[G — item set parity with get_inventory_analysis (join on item_id)]');
    {
      const inv = await getInventoryAnalysisForUser(clientA, { include_listing_history: false });
      const d = inv.data;
      const invIds = new Set([...d.listed_items, ...d.unlisted_business_items, ...d.unlisted_hybrid_items, ...d.unlisted_unclassified_items].map((i) => i.item_id));
      const laIds = new Set([...def.items.map((i) => i.item_id), ...def.items_without_leads.map((i) => i.item_id)]);
      check('same item ids in both tools', invIds.size === laIds.size && Array.from(invIds).every((id) => laIds.has(id)), { inv: Array.from(invIds), la: Array.from(laIds) });
    }

    console.log('\n[H — cross-user isolation]');
    {
      const b = await getLeadActivityForUser(clientB, {}, NOW);
      check('user B sees only their own item', b.items.map((i) => i.item_id).join() === String(itemB));
      check('user A never sees user B\'s lead note', !JSON.stringify(def).includes('B-ONLY-NOTE'));
      check('user B never sees user A\'s leads', !JSON.stringify(b).includes('Jazzmaster') && !b.items.some((i) => i.item_id === explorer || i.item_id === strat));
      const probe = await getLeadActivityForUser(clientB, { item_ids: [explorer, strat, quiet] }, NOW);
      check('user B passing user A\'s item_ids gets no data at all', probe.items.length === 0 && probe.items_without_leads.length === 0);
      const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      check('anonymous client is rejected', await getLeadActivityForUser(anon, {}, NOW).then(() => false, () => true));
    }

    console.log('\n[I — response size (informational)]');
    {
      const month = await getLeadActivityForUser(clientA, { bucket: 'month' }, NOW);
      console.log(`  dedicated fixture (3 open items, 25 leads): weekly default = ${kb(def)} KB, monthly = ${kb(month)} KB`);
      const parts = {
        current_period_details: def.items.map((i) => i.current_period),
        per_item_periods: def.items.map((i) => i.periods),
        per_item_lifetime: def.items.map((i) => i.lifetime),
        totals: def.totals,
        semantics_and_metadata: { s: def.semantics, p: def.periods, f: def.filters_applied },
      };
      for (const [k, v] of Object.entries(parts)) console.log(`    ${k}: ${kb(v)} KB`);

      const fixtures = await setupAnalyticsTestFixtures(admin);
      const shared = await signIn(fixtures.userAEmail, fixtures.password);
      const sw = await getLeadActivityForUser(shared, {}, NOW);
      const sm = await getLeadActivityForUser(shared, { bucket: 'month' }, NOW);
      console.log(`  shared analytics fixture user A (${sw.item_count + sw.items_without_leads.length} open items, ${sw.totals.lifetime.lead_count} leads): weekly = ${kb(sw)} KB, monthly = ${kb(sm)} KB`);
      check('size measurement ran', true);
    }
  } finally {
    console.log('\n=== Cleanup ===');
    if (leadIds.length) await admin.from('item_leads').delete().in('id', leadIds);
    if (listingIds.length) await admin.from('item_listings').delete().in('id', listingIds);
    if (itemIds.length) await admin.from('deal_items').delete().in('item_id', itemIds);
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: inventory_items deleted', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
