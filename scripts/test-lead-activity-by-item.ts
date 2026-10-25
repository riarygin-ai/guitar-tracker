/**
 * test-lead-activity-by-item.ts
 *
 * /listings "Lead Activity by Item" (lifetime, open items with leads):
 *   P — pure: last-activity rule, aggregation (zero-lead items dropped),
 *       sort modes, item search (incl. "LP" -> "Les Paul"), status label
 *   S — source structure: section uses the new endpoint, no Trend Window,
 *       Negotiating+ (not Serious+), Last Activity, search + sort controls
 *   W — local DB through a real signed-in RLS client: an unlisted item whose
 *       listing cycles ended but whose leads continue (the reported item-186
 *       shape, synthetic data), a listed item, a zero-lead item, a sold item,
 *       a second user; then the route handler.
 * Self-cleaning dedicated fixture. Synthetic names only.
 *
 * Usage:  npx tsx scripts/test-lead-activity-by-item.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { aggregateItemLeadActivity, getItemLeadActivityForUser, leadLastActivityDate, type ItemLeadActivityRow } from '../src/lib/analytics/itemLeadActivity';
import { DEFAULT_ITEM_ACTIVITY_SORT, itemLeadStatusLabel, matchesItemQuery, parseItemActivitySort, sortItemLeadActivity, viewItemLeadActivity } from '../src/lib/itemLeadActivityView';
import { LISTING_HELP } from '../src/lib/listingHelpText';
import type { LoadedLead } from '../src/lib/analytics/leadActivityService';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Item-Lead-Activity-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── P ──────────────────────────────────────────────────────────────────
const lead = (o: Partial<LoadedLead>): LoadedLead => ({
  inventory_item_id: 1, status: 'OPEN', offer_type: 'NONE', peak_stage: 'INQUIRY', lead_quality: null,
  first_contact_at: '2026-09-01', last_contact_at: null, last_inbound_at: null, last_outbound_at: null, ...o,
} as LoadedLead);
const row = (id: number, o: Partial<ItemLeadActivityRow>): ItemLeadActivityRow => ({
  item_id: id, item_display_name: `Item ${id}`, brand_name: null, is_listed: false, active_channel_names: [], lead_count: 1, negotiating_plus_count: 0,
  offer_count: 0, open_lead_count: 0, agreed_lead_count: 0, channel_days: null, last_activity_date: null, last_new_lead_date: null, ...o,
});

function pureChecks() {
  console.log('\n[P1 — Last Activity = latest real contact]');
  check('last_contact_at beats first_contact_at', leadLastActivityDate(lead({ first_contact_at: '2026-10-01', last_contact_at: '2026-10-22' })) === '2026-10-22');
  check('first contact is the floor when nothing else is recorded', leadLastActivityDate(lead({ first_contact_at: '2026-10-01' })) === '2026-10-01');
  check('last_inbound_at in the Toronto evening keeps the Toronto date (02:30Z -> previous day)', leadLastActivityDate(lead({ first_contact_at: '2026-10-01', last_inbound_at: '2026-10-23T02:30:00Z' })) === '2026-10-22');
  check('latest of inbound / outbound / contact wins', leadLastActivityDate(lead({ first_contact_at: '2026-10-01', last_contact_at: '2026-10-05', last_outbound_at: '2026-10-09T15:00:00Z', last_inbound_at: '2026-10-07T15:00:00Z' })) === '2026-10-09');
  check('no dates -> null', leadLastActivityDate(lead({ first_contact_at: null })) === null);

  console.log('\n[P2 — aggregation]');
  const items = [
    { item_id: 1, item_display_name: 'A', brand_name: null, is_listed: false, active_channel_names: [] },
    { item_id: 2, item_display_name: 'B', brand_name: null, is_listed: true, active_channel_names: ['Marketplace'] },
    { item_id: 3, item_display_name: 'Zero', brand_name: null, is_listed: true, active_channel_names: ['Reverb'] },
  ];
  const leads = [
    lead({ inventory_item_id: 1, first_contact_at: '2026-09-15', last_contact_at: '2026-10-22', peak_stage: 'HIGH_INTENT', offer_type: 'CASH', status: 'AGREED' }),
    lead({ inventory_item_id: 1, first_contact_at: '2026-10-15', peak_stage: 'NEGOTIATING', offer_type: 'TRADE' }),
    lead({ inventory_item_id: 1, first_contact_at: '2026-10-01', peak_stage: 'ENGAGED', lead_quality: 'SERIOUS' }),
    lead({ inventory_item_id: 2, first_contact_at: '2026-10-18' }),
  ];
  const agg = aggregateItemLeadActivity(items, leads, new Map([[1, 40], [2, 6]]));
  const a = agg.find((r) => r.item_id === 1)!;
  check('zero-lead item dropped', agg.length === 2 && !agg.some((r) => r.item_id === 3));
  check('lifetime counts', a.lead_count === 3 && a.offer_count === 2 && a.open_lead_count === 2 && a.agreed_lead_count === 1, a);
  check('Negotiating+ uses peak stage (ENGAGED lead with legacy SERIOUS quality is NOT counted)', a.negotiating_plus_count === 2, a.negotiating_plus_count);
  check('Last Activity = latest contact (Oct 22), newest lead separately (Oct 15)', a.last_activity_date === '2026-10-22' && a.last_new_lead_date === '2026-10-15');
  check('channel days attached', a.channel_days === 40 && agg.find((r) => r.item_id === 2)!.channel_days === 6);

  console.log('\n[P3 — sort modes]');
  const rows = [
    row(1, { item_display_name: '1994 Gibson Les Paul Special custom shop', brand_name: 'Gibson', lead_count: 18, negotiating_plus_count: 11, offer_count: 12, channel_days: 90, last_activity_date: '2026-10-22', last_new_lead_date: '2026-10-15' }),
    row(2, { item_display_name: '2019 Fender Stratocaster', brand_name: 'Fender', lead_count: 4, negotiating_plus_count: 1, offer_count: 5, channel_days: 200, last_activity_date: '2026-10-18', last_new_lead_date: '2026-10-18' }),
    row(3, { item_display_name: 'Boss Katana 50', brand_name: 'Boss', lead_count: 25, negotiating_plus_count: 3, offer_count: 2, channel_days: null, last_activity_date: '2026-08-01' }),
    row(4, { item_display_name: 'Alpha Pedal', lead_count: 1, last_activity_date: null }),
  ];
  const ids = (m: Parameters<typeof sortItemLeadActivity>[1]) => sortItemLeadActivity(rows, m).map((r) => r.item_id).join(',');
  check('default sort is Recent activity', DEFAULT_ITEM_ACTIVITY_SORT === 'recent' && parseItemActivitySort(null) === 'recent' && parseItemActivitySort('bogus') === 'recent' && parseItemActivitySort('offers') === 'offers');
  check('Recent: by latest interaction, not latest new lead (item 1 Oct 22 above item 2 whose newest lead is Oct 18); undated last', ids('recent') === '1,2,3,4', ids('recent'));
  check('Leads: lifetime lead count desc', ids('leads') === '3,1,2,4', ids('leads'));
  check('Negotiating+: desc', ids('negotiating') === '1,3,2,4', ids('negotiating'));
  check('Offers: desc', ids('offers') === '1,2,3,4', ids('offers'));
  check('Channel Days: desc, never-listed last', ids('channel_days') === '2,1,4,3' || ids('channel_days') === '2,1,3,4', ids('channel_days'));
  check('Item: alphabetical', ids('item') === '1,2,4,3', ids('item'));
  check('sort does not mutate input', rows[0].item_id === 1 && rows[3].item_id === 4);

  console.log('\n[P4 — search]');
  check('"LP Special" finds "1994 Gibson Les Paul Special custom shop"', matchesItemQuery(rows[0], 'LP Special'));
  check('case-insensitive name / brand / model / year', matchesItemQuery(rows[0], 'gibson') && matchesItemQuery(rows[0], 'LES PAUL') && matchesItemQuery(rows[0], '1994') && matchesItemQuery(rows[1], 'strat'));
  check('every word must match', !matchesItemQuery(rows[0], 'LP Stratocaster') && matchesItemQuery(rows[0], 'gibson special'));
  check('initials only for short letter words (no false hit for "katana" on the Les Paul)', !matchesItemQuery(rows[0], 'katana') && !matchesItemQuery(rows[1], 'LP'));
  check('search runs over ALL rows before sorting', JSON.stringify(viewItemLeadActivity(rows, 'boss', 'leads').map((r) => r.item_id)) === '[3]' && viewItemLeadActivity(rows, '', 'recent').length === 4);
  check('view drops any zero-lead row defensively', viewItemLeadActivity([...rows, row(9, { lead_count: 0 })], '', 'recent').length === 4);
  check('status label: "1 agreed · 13 open"; none -> null', itemLeadStatusLabel({ open_lead_count: 13, agreed_lead_count: 1 }) === '1 agreed · 13 open' && itemLeadStatusLabel({ open_lead_count: 0, agreed_lead_count: 0 }) === null);
}

// ── S ──────────────────────────────────────────────────────────────────
function structureChecks() {
  console.log('\n[S — /listings section]');
  const page = strip(src('src/app/listings/page.tsx'));
  const sec = page.slice(page.indexOf('function ItemActivitySection'), page.indexOf('function UnlistedSection'));
  const heads = (sec.match(/<th [^>]*>([\s\S]*?)<\/th>/g) ?? []).map((h) => h.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim() || (/help="(\w+)"/.exec(h)?.[1] ?? ''));
  check('columns: Item / Leads / Negotiating+ / Offers / Channel Days / Last Activity', JSON.stringify(heads) === JSON.stringify(['Item', 'itemLeads', 'itemNegotiatingPlus', 'itemOffers', 'itemChannelDays', 'itemLastActivity']), heads);
  check('help labels', LISTING_HELP.itemNegotiatingPlus.label === 'Negotiating+' && LISTING_HELP.itemLastActivity.label === 'Last Activity' && LISTING_HELP.itemChannelDays.label === 'Channel Days');
  check('no Serious+ / Last Lead in the section', !/seriousPlus"|Serious\+|Last Lead|serious_plus/.test(sec.replace(/seriousPlus: true/g, '')), sec.match(/seriousPlus"|Serious\+|Last Lead|serious_plus/g));
  check('Negotiating+ value is negotiating_plus_count (new stage semantics)', sec.includes('{item.negotiating_plus_count}'));
  check('Last Activity value is last_activity_date (never first contact / newest lead)', sec.includes('item.last_activity_date ? fmtLeadDate(item.last_activity_date)') && !sec.includes('last_new_lead_date') && !sec.includes('first_contact'));
  check('search input + sort select present', sec.includes('data-item-search') && sec.includes('data-item-sort') && sec.includes('ITEM_ACTIVITY_SORTS.map'));
  check('search + sort over the full row set (viewItemLeadActivity on all items)', sec.includes('viewItemLeadActivity(items, query, sort)'));
  check('one request for the section (new endpoint), no Trend Window / item window dependency', page.includes('useSwrResource<ItemLeadActivityRow[]>(listingsCache, ITEM_LEAD_ACTIVITY_KEY') && (page.match(/fetchItemLeadActivity\(/g) ?? []).length === 1 && !/itemActivityWindow|fetchListingItemActivity/.test(page) && !/trendWeeks/.test(sec));
  check('drill-downs: item\'s leads on /leads (Negotiating+ / Offers filters)', sec.includes('leadsUrl({ itemId: item.item_id, returnTo, ...extra })') && sec.includes('{ seriousPlus: true }') && sec.includes('{ offers: true }'));
  check('unlisted items say so; current status shown', sec.includes("'Not listed'") && sec.includes('itemLeadStatusLabel(item)'));
  const svc = src('src/lib/analytics/itemLeadActivity.ts');
  check('service: open inventory from listing evidence; leads chunked via loadLeadsForItems (no N+1); no service_role', svc.includes("rpc('build_listing_evidence_v1_0_for_current_user')") && svc.includes('loadLeadsForItems(client, items.map') && !/SERVICE_ROLE|serviceClient/.test(svc));
  check('service: Negotiating+ via isNegotiatingPlus; zero-lead items dropped', svc.includes('ls.filter(isNegotiatingPlus)') && svc.includes('if (ls.length === 0) continue;'));
  const route = src('src/app/api/lead-activity-by-item/route.ts');
  check('route: GET only, caller-scoped auth', /export async function GET/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route) && route.includes('authenticateApiUser(req)'));
}

// ── W ──────────────────────────────────────────────────────────────────
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
async function signIn(email: string): Promise<{ client: SupabaseClient; token: string }> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return { client: c, token: data.session.access_token };
}

async function main() {
  pureChecks();
  structureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, 'item-lead-activity-a@example.test'));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, 'item-lead-activity-b@example.test'));
  const { client: cA, token: tokenA } = await signIn('item-lead-activity-a@example.test');
  const { client: cB } = await signIn('item-lead-activity-b@example.test');

  const brandName = `ILA Gibsonish ${uuid().slice(0, 4)}`;
  const { data: brand } = await admin.from('brands').insert({ name: brandName }).select('id').single();
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const ch = (n: string) => (chans ?? []).find((c) => c.name === n)!.id as number;
  const itemIds: number[] = [];

  try {
    const item = async (userId: number, model: string, year: number, status: string) => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, year, status, serial_number: `ILA-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    const listing = async (userId: number, itemId: number, channel: string, listedAt: string, endedAt: string | null) => {
      const { error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: ch(channel), status: endedAt ? 'ended' : 'active', listed_at: listedAt, ended_at: endedAt });
      if (error) throw error;
    };
    const lead = async (userId: number, itemId: number, o: Record<string, unknown>) => {
      const { error } = await admin.from('item_leads').insert({
        user_id: userId, inventory_item_id: itemId, lead_id: uuid(), origin: 'DIRECT', last_write_source: 'MCP', source_channel: 'Marketplace', deal_channel_id: ch('Marketplace'),
        offer_type: 'NONE', status: 'OPEN', peak_stage: 'INQUIRY', peak_stage_source: 'DERIVED', source_updated_at: '2026-10-01T00:00:00Z', ...o,
      });
      if (error) throw error;
    };

    // Item-186 shape (synthetic): owned / unlisted, Marketplace + Kijiji + Reverb cycles ended Oct 15,
    // 18 leads, 12 offers, 11 Negotiating+ (incl. 1 High Intent), 13 OPEN + 1 AGREED,
    // newest lead first contacted Oct 15, an OLDER lead still talking through Oct 22.
    const special = await item(userA, 'Les Paul Special custom shop', 1994, 'owned');
    await listing(userA, special, 'Marketplace', '2026-09-01', '2026-10-15');
    await listing(userA, special, 'Kijiji', '2026-09-05', '2026-10-15');
    await listing(userA, special, 'Reverb', '2026-09-10', '2026-10-15');
    for (let i = 0; i < 18; i++) {
      const negotiating = i < 11;
      await lead(userA, special, {
        first_contact_at: i === 17 ? '2026-10-15' : `2026-09-${String(10 + (i % 18)).padStart(2, '0')}`,
        last_contact_at: i === 0 ? '2026-10-22' : null,
        last_inbound_at: i === 0 ? '2026-10-22T19:00:00Z' : null,
        peak_stage: i === 0 ? 'HIGH_INTENT' : negotiating ? 'NEGOTIATING' : 'ENGAGED',
        offer_type: i < 12 ? 'CASH' : 'NONE', initial_cash_offer: i < 12 ? 900 : null, best_cash_offer: i < 12 ? 950 : null,
        status: i === 0 ? 'AGREED' : i < 14 ? 'OPEN' : 'DECLINED_BY_THEM', outcome_reason: i >= 14 ? 'PRICE' : null,
      });
    }
    // Listed item with leads; its newest lead (Oct 18) is newer than the Special's newest lead (Oct 15).
    const strat = await item(userA, 'Stratocaster ILA', 2019, 'listed');
    await listing(userA, strat, 'Marketplace', '2026-10-10', null);
    await lead(userA, strat, { first_contact_at: '2026-10-18', last_contact_at: '2026-10-18' });
    await lead(userA, strat, { first_contact_at: '2026-10-12', peak_stage: 'NEGOTIATING', offer_type: 'CASH', initial_cash_offer: 500, best_cash_offer: 500 });
    // Listed item without leads; sold item with leads; user B's item with leads.
    const quiet = await item(userA, 'Quiet Tele ILA', 2015, 'listed');
    await listing(userA, quiet, 'Reverb', '2026-10-01', null);
    const sold = await item(userA, 'Sold SG ILA', 2001, 'listed');
    await lead(userA, sold, { first_contact_at: '2026-10-20', last_contact_at: '2026-10-21' });
    const { data: saleRes, error: saleErr } = await cA.rpc('create_sell_operation', { p_deal_date: '2026-10-21', p_channel_id: ch('Marketplace'), p_items: [{ item_id: sold, total_value: 700 }], p_notes: null, p_cf_description: null });
    if (saleErr) throw saleErr;
    const saleDealId = (saleRes as { deal_id: number }).deal_id;
    const bItem = await item(userB, 'B owned ILA', 2010, 'owned');
    await lead(userB, bItem, { first_contact_at: '2026-10-23', last_contact_at: '2026-10-23' });

    console.log('\n[W1 — population]');
    const rows = await getItemLeadActivityForUser(cA);
    const mine = rows.filter((r) => itemIds.includes(r.item_id));
    const sp = mine.find((r) => r.item_id === special);
    check('owned / unlisted item whose listings ended still appears', !!sp && sp.is_listed === false, mine.map((r) => r.item_id));
    check('…with its lifetime numbers: 18 leads, 11 Negotiating+, 12 offers, 13 open + 1 agreed', !!sp && sp.lead_count === 18 && sp.negotiating_plus_count === 11 && sp.offer_count === 12 && sp.open_lead_count === 13 && sp.agreed_lead_count === 1, sp);
    check('…Last Activity = Oct 22 (continuing older lead), newest lead Oct 15', sp?.last_activity_date === '2026-10-22' && sp?.last_new_lead_date === '2026-10-15', sp);
    check('…Channel Days = lifetime listed days over the three ended cycles (44 + 40 + 35 = 119)', sp?.channel_days === 119, sp?.channel_days);
    const st = mine.find((r) => r.item_id === strat);
    check('listed item with leads still appears, with its active channel', !!st && st.is_listed && st.active_channel_names.includes('Marketplace') && st.lead_count === 2 && st.negotiating_plus_count === 1, st);
    check('zero-lead listed item excluded', !mine.some((r) => r.item_id === quiet));
    check('sold item excluded (not open inventory)', !mine.some((r) => r.item_id === sold));
    check('another user\'s item never appears (RLS)', !rows.some((r) => r.item_id === bItem));
    const rowsB = await getItemLeadActivityForUser(cB);
    check('user B sees only their own item', rowsB.some((r) => r.item_id === bItem) && !rowsB.some((r) => itemIds.filter((i) => i !== bItem).includes(r.item_id)));

    console.log('\n[W2 — default view]');
    const view = viewItemLeadActivity(mine, '', 'recent').map((r) => r.item_id);
    check('Recent activity: the unlisted Special (activity Oct 22) ranks above the Strat (newest lead Oct 18)', view.indexOf(special) === 0 && view.indexOf(strat) === 1, view);
    check('Leads sort: Special (18) first', viewItemLeadActivity(mine, '', 'leads')[0].item_id === special);
    check('search "LP Special" finds it among all rows', JSON.stringify(viewItemLeadActivity(mine, 'LP Special', 'recent').map((r) => r.item_id)) === JSON.stringify([special]));
    check('search by brand / year', viewItemLeadActivity(mine, brandName.split(' ')[1], 'recent').length === 2 && JSON.stringify(viewItemLeadActivity(mine, '2019', 'recent').map((r) => r.item_id)) === JSON.stringify([strat]));

    console.log('\n[W3 — continuing activity moves an item up]');
    await admin.from('item_leads').update({ last_contact_at: '2026-10-24', last_write_source: 'MCP' }).eq('inventory_item_id', strat).eq('first_contact_at', '2026-10-12');
    const after = viewItemLeadActivity((await getItemLeadActivityForUser(cA)).filter((r) => itemIds.includes(r.item_id)), '', 'recent').map((r) => r.item_id);
    check('an older Strat lead talking on Oct 24 moves the Strat above the Special', after.indexOf(strat) === 0 && after.indexOf(special) === 1, after);

    void saleDealId;
    console.log('\n[W4 — route handler]');
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = SUPABASE_ANON_KEY;
    const { GET } = await import('../src/app/api/lead-activity-by-item/route');
    const call = (token: string | null) => GET(new NextRequest('http://local/api/lead-activity-by-item', { headers: token ? { Authorization: `Bearer ${token}` } : {} }));
    check('no token -> 401', (await call(null)).status === 401);
    const res = await call(tokenA);
    const body = await res.json();
    check('200 with the caller\'s rows only', res.status === 200 && Array.isArray(body.items) && body.items.some((r: ItemLeadActivityRow) => r.item_id === special) && !body.items.some((r: ItemLeadActivityRow) => r.item_id === bItem));
  } finally {
    console.log('\n=== Cleanup ===');
    if (itemIds.length) {
      const { data: dis } = await admin.from('deal_items').select('deal_id').in('item_id', itemIds);
      const dealIds = Array.from(new Set((dis ?? []).map((d) => d.deal_id as number)));
      if (dealIds.length) {
        await admin.from('cash_flow').delete().in('deal_id', dealIds);
        await admin.from('deal_items').delete().in('deal_id', dealIds);
        await admin.from('deals').delete().in('id', dealIds);
      }
      await admin.from('item_leads').delete().in('inventory_item_id', itemIds);
      await admin.from('item_listings').delete().in('inventory_item_id', itemIds);
      await admin.from('inventory_items').delete().in('id', itemIds);
    }
    if (brand) await admin.from('brands').delete().eq('id', brand.id);
    check('cleanup: fixture items removed', ((await admin.from('inventory_items').select('id').in('id', itemIds.length ? itemIds : [-1])).data ?? []).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
