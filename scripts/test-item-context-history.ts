/**
 * test-item-context-history.ts
 *
 * DB-backed validation for the expanded "Copy Item Context": the loader
 * (src/lib/itemContextData.ts) + formatter (src/lib/itemContext.ts) against
 * real rows — real item_listings cycles on several platforms (including an
 * ended cycle and a cancelled one), REAL price history written by the
 * item_listings_track_price_history trigger, tags, and item_leads — read
 * through a signed-in user's own RLS client.
 *
 * Verifies: Item ID present; every cycle is listed under the right
 * platform/cycle number; price history is chronological and attached to the
 * right cycle; lead totals/platform counts equal the underlying rows; no
 * N+1 (5 queries when the item has no exit deal, 6 when it does — see [A]);
 * the completed EXIT deal (never an acquisition/incoming deal) is resolved
 * correctly for sold/traded/still-owned/incoming-trade items (see [E2]); no
 * cross-user leakage in either direction. Prints the generated context at
 * the end.
 *
 * Local Supabase only (safety-gated); every row created is deleted.
 *
 * Usage:  npx tsx scripts/test-item-context-history.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { buildItemContext } from '../src/lib/itemContext';
import { loadItemContextHistory } from '../src/lib/itemContextData';
import type { InventoryItem } from '../src/types';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const PASSWORD = 'Item-Context-Fixture-Local-Only-1!';

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

/** Wraps a client so every .from() call is counted (proves no N+1). */
function countingClient(client: SupabaseClient): { client: SupabaseClient; calls: () => string[] } {
  const log: string[] = [];
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') return (table: string) => { log.push(table); return target.from(table); };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { client: proxy as SupabaseClient, calls: () => log };
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const emailA = 'item-context-fixture-a@example.test';
  const emailB = 'item-context-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));

  let brandId: number;
  const { data: brandRow } = await admin.from('brands').select('id').eq('name', 'Gibson-Context-Test').maybeSingle();
  if (brandRow) brandId = brandRow.id as number;
  else { const { data, error } = await admin.from('brands').insert({ name: 'Gibson-Context-Test' }).select('id').single(); if (error) throw error; brandId = data.id as number; }
  const { data: cat } = await admin.from('item_categories').select('id').eq('name', 'Guitars').single();
  const { data: sub } = await admin.from('item_subtypes').select('id').eq('category_id', cat!.id).eq('name', 'Electric Guitar').single();
  const marketplaceId = await lookupId(admin, 'deal_channels', 'name', 'Marketplace');
  const kijijiId = await lookupId(admin, 'deal_channels', 'name', 'Kijiji');
  const reverbId = await lookupId(admin, 'deal_channels', 'name', 'Reverb');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const listingIds: number[] = [];
  const leadIds: number[] = [];
  const sourceIds: number[] = [];
  const tagIds: number[] = [];

  try {
    console.log('\n=== Fixtures ===');
    const insertItem = async (userId: number, model: string): Promise<InventoryItem> => {
      const { data, error } = await admin.from('inventory_items').insert({
        user_id: userId, brand_id: brandId, item_subtype_id: sub!.id, purpose_id: null, model, status: 'owned', year: 2024, color: 'Desert Burst',
        condition: 'Excellent', estimated_sold_value: 2700, serial_number: `CTX-${crypto.randomUUID().slice(0, 6)}`, notes: 'Original case included.',
      }).select('*').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      const { data: deal, error: dErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: '2026-05-07', deal_channel_id: null }).select('id').single();
      if (dErr) throw dErr;
      dealIds.push(deal.id as number);
      await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: data.id, direction: 'in', total_value: 2200 });
      return data as InventoryItem;
    };
    const item = await insertItem(userA, 'Les Paul Standard 50s');
    const itemB = await insertItem(userB, 'B-Owned Secret Model');

    // Tags
    for (const name of ['Ctx Original Case', 'Ctx Case Candy', 'Ctx COA']) {
      const { data: existing } = await admin.from('inventory_tags').select('id').eq('name', name).maybeSingle();
      let id = existing?.id as number | undefined;
      if (!id) { const { data, error } = await admin.from('inventory_tags').insert({ name }).select('id').single(); if (error) throw error; id = data.id as number; tagIds.push(id); }
      await admin.from('inventory_item_tags').insert({ item_id: item.id, tag_id: id });
    }

    const listing = async (userId: number, itemId: number, channelId: number, row: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channelId, is_ai_generated: false, ...row }).select('id').single();
      if (error) throw error;
      listingIds.push(data.id as number);
      return data.id as number;
    };
    // Reverb cycle 1 (ended) — created with a price, then ended
    const rev1 = await listing(userA, item.id, reverbId, { status: 'active', listed_at: '2026-05-10', asking_price: 3400 });
    await admin.from('item_listings').update({ status: 'ended', ended_at: '2026-06-15' }).eq('id', rev1);
    // Reverb cycle 2 (active) — three price events via real UPDATEs (trigger writes history)
    const rev2 = await listing(userA, item.id, reverbId, { status: 'active', listed_at: '2026-07-11', asking_price: 3200 });
    await admin.from('item_listings').update({ asking_price: 3100 }).eq('id', rev2);
    await admin.from('item_listings').update({ asking_price: 2950 }).eq('id', rev2);
    // Marketplace (active, trade value)
    const mkt = await listing(userA, item.id, marketplaceId, { status: 'active', listed_at: '2026-07-15', asking_price: 3000, trade_value: 2800 });
    // Kijiji (cancelled)
    const kij = await listing(userA, item.id, kijijiId, { status: 'cancelled', listed_at: '2026-06-20', cancelled_at: '2026-06-22T15:00:00Z', asking_price: 2900 });
    // User B listing on B's item (must never leak)
    const bList = await listing(userB, itemB.id, reverbId, { status: 'active', listed_at: '2026-07-01', asking_price: 111 });

    // Give the trigger-written history rows deterministic, spread-out dates (service_role may adjust audit timestamps in a fixture)
    const stamp = async (listingId: number, dates: string[]) => {
      const { data } = await admin.from('item_listing_price_history').select('id').eq('item_listing_id', listingId).order('id', { ascending: true });
      for (let i = 0; i < (data ?? []).length; i++) await admin.from('item_listing_price_history').update({ changed_at: `${dates[i]}T15:00:00Z` }).eq('id', data![i].id);
    };
    await stamp(rev1, ['2026-05-10']);
    await stamp(rev2, ['2026-07-11', '2026-07-28', '2026-08-15']);
    await stamp(mkt, ['2026-07-15']);
    await stamp(kij, ['2026-06-20']);

    const { data: srcA, error: srcErrA } = await admin.from('lead_import_sources').upsert({ user_id: userA, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Item Context Fixture', spreadsheet_id: `ctx-${userA}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
    if (srcErrA) throw srcErrA;
    sourceIds.push(srcA!.id as number);
    const { data: srcB, error: srcErrB } = await admin.from('lead_import_sources').upsert({ user_id: userB, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Item Context Fixture', spreadsheet_id: `ctx-${userB}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
    if (srcErrB) throw srcErrB;
    sourceIds.push(srcB!.id as number);

    const lead = async (userId: number, srcId: number, itemId: number, o: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_leads').insert({
        user_id: userId, source_id: srcId, inventory_item_id: itemId, lead_id: crypto.randomUUID(), lead_quality: 'LOW', offer_type: 'NONE', status: 'OPEN',
        source_updated_at: new Date().toISOString(), buyer_message_count: 3, our_message_count: 1, ...o,
      }).select('id').single();
      if (error) throw error;
      leadIds.push(data.id as number);
    };
    await lead(userA, srcA!.id as number, item.id, { first_contact_at: '2026-07-13', last_contact_at: '2026-07-15', deal_channel_id: marketplaceId, source_channel: 'Marketplace', lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 2600, initial_cash_offer: 2500, status: 'DECLINED_BY_ME', outcome_reason: 'LOW_OFFER', notes: 'Offered $2,500 first, moved to $2,600. I countered at $3,100.' });
    await lead(userA, srcA!.id as number, item.id, { first_contact_at: '2026-07-20', last_contact_at: '2026-07-20', deal_channel_id: kijijiId, source_channel: 'Kijiji', lead_quality: 'ENGAGED', offer_type: 'TRADE', trade_item: 'Fender Stratocaster', cash_component: 0, trade_est_value: 1800, status: 'GHOSTED' });
    await lead(userA, srcA!.id as number, item.id, { first_contact_at: '2026-08-02', last_contact_at: '2026-08-05', deal_channel_id: marketplaceId, source_channel: 'Marketplace', lead_quality: 'HIGH_INTENT', offer_type: 'MIXED', trade_item: 'Rickenbacker 330', cash_component: 500, status: 'OPEN' });
    await lead(userA, srcA!.id as number, item.id, { first_contact_at: '2026-08-14', last_contact_at: '2026-08-14', deal_channel_id: reverbId, source_channel: 'Reverb', lead_quality: 'ENGAGED', status: 'GHOSTED' });
    await lead(userA, srcA!.id as number, item.id, { first_contact_at: '2026-08-16', last_contact_at: '2026-08-16', deal_channel_id: null, source_channel: 'Other', lead_quality: 'LOW', status: 'OPEN' });
    await lead(userB, srcB!.id as number, itemB.id, { first_contact_at: '2026-07-05', last_contact_at: '2026-07-05', deal_channel_id: reverbId, source_channel: 'Reverb', lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 99, status: 'OPEN', notes: 'B-ONLY-NOTE' });

    const signIn = async (email: string) => {
      const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
      if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
      return c;
    };
    const clientA = await signIn(emailA);
    const clientB = await signIn(emailB);

    console.log('\n[A — loader: no N+1]');
    const counted = countingClient(clientA);
    const history = await loadItemContextHistory(counted.client, item.id);
    const calls = counted.calls();
    // This item has no 'out' deal_items row at all (still owned, acquisition-
    // only), so the exit-deal resolver short-circuits before ever querying
    // `deals` — 5 queries here, not 6 (a sold/traded item's own history call,
    // exercised below in [E2], does reach `deals` and makes exactly 6).
    check('exactly 5 queries (listings, leads, channels, price history, deal_items) — no exit deal means `deals` is never queried', calls.length === 5, calls);
    check('one query per table (no per-cycle / per-lead / per-deal queries)', new Set(calls).size === 5 && calls.filter((c) => c === 'item_listing_price_history').length === 1);
    check('this item has no exit deal (acquisition-only, still owned)', history.exitDealId === null, history.exitDealId);
    check('4 listing cycles loaded (ended + active Reverb, Marketplace, cancelled Kijiji)', history.listingCycles.length === 4, history.listingCycles.length);
    check('5 leads loaded for the item', history.leads.length === 5, history.leads.length);

    // Related data as the form would supply it
    const { data: tagRows } = await clientA.from('inventory_item_tags').select('tag_id').eq('item_id', item.id);
    const { data: tagNamesRows } = await clientA.from('inventory_tags').select('name').in('id', (tagRows ?? []).map((t) => t.tag_id));
    const text = buildItemContext(item, {
      brandName: 'Gibson-Context-Test', categoryName: 'Guitars', typeName: 'Electric Guitar', purposeName: 'Business',
      tagNames: (tagNamesRows ?? []).map((t) => t.name as string).sort(), valueIn: 2200, valueOut: null, totalExpenses: 0,
      potentialReward: 500, potentialRoi: 22.7, realizedGain: null, realizedRoi: null, acquiredDate: '2026-05-07',
      listingCycles: history.listingCycles, leads: history.leads, asOfDate: '2026-08-20',
    });

    console.log('\n[B — identity & sections]');
    check('Item ID is present and first after the title', text.split('\n').filter((l) => l.trim())[1] === `Item ID: ${item.id}`);
    check('Tags listed', text.includes('Tags: Ctx COA, Ctx Case Candy, Ctx Original Case'), text.split('\n').find((l) => l.startsWith('Tags')));
    check('Notes present at the end', text.trimEnd().endsWith('NOTES\nOriginal case included.'));
    check('serial number included', /Serial Number: CTX-/.test(text));
    check('section order: header, FINANCIALS, DATES, LISTING HISTORY, LEADS, NOTES', ['FINANCIALS', 'DATES', 'LISTING HISTORY', 'LEADS', 'NOTES'].map((h) => text.indexOf(`\n${h}\n`)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
    check('no null/undefined/N/A leaks', !/null|undefined|N\/A/.test(text));

    console.log('\n[C — listing history: platform, cycle, chronology]');
    const block = (name: string) => text.slice(text.indexOf(`\n${name}\nCycle 1:`));
    check('Reverb shows two separate cycles', text.includes('Reverb\nCycle 1:') && text.includes('Cycle 2:\nListed: 2026-07-11'));
    check('Reverb cycle 1 = ended 2026-05-10 → 2026-06-15 with its single price entry', text.includes('Listed: 2026-05-10\nEnded: 2026-06-15\nStatus: Ended\nDays Listed: 36\nLast Asking Price: $3,400\nPrice History:\n- 2026-05-10: Listed at $3,400'), text);
    check('Reverb cycle 2 = active with the FULL price trail in order', text.includes('Listed: 2026-07-11\nStatus: Active\nDays Listed: 40\nAsking Price: $2,950\nPrice History:\n- 2026-07-11: Listed at $3,200\n- 2026-07-28: $3,200 → $3,100\n- 2026-08-15: $3,100 → $2,950'), text);
    check('Marketplace shows trade value and its own price entry only', block('Marketplace').startsWith('\nMarketplace\nCycle 1:\nListed: 2026-07-15\nStatus: Active') && block('Marketplace').includes('Trade Value: $2,800') && block('Marketplace').includes('- 2026-07-15: Listed at $3,000'));
    check('cancelled Kijiji cycle is included with its cancelled date', text.includes('Kijiji\nCycle 1:\nListed: 2026-06-20\nCancelled: 2026-06-22\nStatus: Cancelled'));
    check('platform order follows first listing date: Reverb (05-10), Kijiji (06-20), Marketplace (07-15)', text.indexOf('\nReverb\n') < text.indexOf('\nKijiji\n') && text.indexOf('\nKijiji\n') < text.indexOf('\nMarketplace\n'));
    const totalHistoryLines = (text.match(/^- \d{4}-\d{2}-\d{2}: (Listed at|\$)/gm) ?? []).length;
    const { count: dbHistoryCount } = await admin.from('item_listing_price_history').select('id', { count: 'exact', head: true }).in('item_listing_id', [rev1, rev2, mkt, kij]);
    check(`printed price-history lines (${totalHistoryLines}) === history rows in the database (${dbHistoryCount})`, totalHistoryLines === dbHistoryCount, { totalHistoryLines, dbHistoryCount });
    check('B\'s listing/price never appears', !text.includes('$111') && !text.includes(String(bList) + ':'));

    console.log('\n[D — leads: counts match the underlying rows]');
    const { data: dbLeads } = await admin.from('item_leads').select('id, deal_channel_id, status, offer_type').eq('inventory_item_id', item.id);
    check('Total Leads === DB row count', text.includes(`Total Leads: ${dbLeads!.length}`) && dbLeads!.length === 5);
    check('Open === DB OPEN count (2)', text.includes(`Open: ${dbLeads!.filter((l) => l.status === 'OPEN').length}`) && dbLeads!.filter((l) => l.status === 'OPEN').length === 2);
    check('By Platform: Marketplace 2, Kijiji 1, Other 1, Reverb 1', text.includes('By Platform:\nMarketplace: 2\nKijiji: 1\nOther: 1\nReverb: 1'));
    check('With Offers === DB offer_type <> NONE count (3)', text.includes(`With Offers: ${dbLeads!.filter((l) => l.offer_type !== 'NONE').length} (Cash 1, Trade 1, Mixed 1)`));
    const histLines = text.slice(text.indexOf('Lead History:')).split('\n').filter((l) => l.startsWith('- '));
    check('history has one line per lead, chronological', histLines.length === 5 && histLines.map((l) => l.slice(2, 12)).join() === '2026-07-13,2026-07-20,2026-08-02,2026-08-14,2026-08-16', histLines.map((l) => l.slice(0, 12)));
    check('cash lead: $2,600 cash, Serious, declined with reason, note quoted', histLines[0].includes('Marketplace | Serious | $2,600 cash | Declined by me (Low offer)') && histLines[0].includes('Note: Offered $2,500 first'));
    check('trade lead: cash component 0 rendered as a straight trade', histLines[1].includes('Kijiji | Engaged | Trade: Fender Stratocaster (trade est. $1,800) | Ghosted'));
    check('mixed lead: cash to us', histLines[2].includes('Rickenbacker 330 + $500 to us'));
    check('NULL-channel lead keeps its logged source ("Other")', histLines[4].includes('| Other |'));
    check('B\'s lead never appears', !text.includes('B-ONLY-NOTE') && !text.includes('$99 cash'));

    console.log('\n[E — isolation]');
    const asB = await loadItemContextHistory(clientB, item.id);
    check('user B loading A\'s item gets nothing (RLS)', asB.listingCycles.length === 0 && asB.leads.length === 0);
    const aAsksB = await loadItemContextHistory(clientA, itemB.id);
    check('user A loading B\'s item gets nothing (RLS)', aAsksB.listingCycles.length === 0 && aAsksB.leads.length === 0);
    const bOwn = await loadItemContextHistory(clientB, itemB.id);
    check('user B still sees its own history', bOwn.listingCycles.length === 1 && bOwn.leads.length === 1 && bOwn.listingCycles[0].priceHistory.length === 1);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    let anonBlocked = false;
    try { const anonHistory = await loadItemContextHistory(anon, item.id); anonBlocked = anonHistory.listingCycles.length === 0 && anonHistory.leads.length === 0; } catch { anonBlocked = true; }
    check('an unauthenticated client gets nothing (or is denied outright)', anonBlocked);

    console.log('\n[E2 — Deal ID: the completed EXIT deal, never the acquisition/incoming deal]');
    {
      // Each of these starts from insertItem's own default acquisition
      // ('purchase' deal, direction='in') — exactly the "historical import /
      // opening acquisition only" shape (edge case G) — then gets ONE more
      // deal_items row to model its actual outcome.
      const soldItem = await insertItem(userA, 'Ctx Sold Exit Item');
      const { data: saleDeal, error: saleErr } = await admin.from('deals').insert({ user_id: userA, deal_type: 'sale', deal_date: '2026-08-10' }).select('id').single();
      if (saleErr) throw saleErr;
      dealIds.push(saleDeal.id as number);
      await admin.from('deal_items').insert({ user_id: userA, deal_id: saleDeal.id, item_id: soldItem.id, direction: 'out', total_value: 3000 });

      const tradedAwayItem = await insertItem(userA, 'Ctx Traded Away Exit Item');
      const { data: tradeOutDeal, error: tradeOutErr } = await admin.from('deals').insert({ user_id: userA, deal_type: 'trade', deal_date: '2026-08-11' }).select('id').single();
      if (tradeOutErr) throw tradeOutErr;
      dealIds.push(tradeOutDeal.id as number);
      await admin.from('deal_items').insert({ user_id: userA, deal_id: tradeOutDeal.id, item_id: tradedAwayItem.id, direction: 'out', total_value: 2500 });

      // An item that came IN on a trade (in addition to insertItem's own
      // 'purchase' acquisition) and is still owned — its ONLY deal_items rows
      // are both 'in'. The incoming trade must never be exposed as an exit deal.
      const incomingTradeItem = await insertItem(userA, 'Ctx Incoming Trade Item');
      const { data: tradeInDeal, error: tradeInErr } = await admin.from('deals').insert({ user_id: userA, deal_type: 'trade', deal_date: '2026-08-12' }).select('id').single();
      if (tradeInErr) throw tradeInErr;
      dealIds.push(tradeInDeal.id as number);
      await admin.from('deal_items').insert({ user_id: userA, deal_id: tradeInDeal.id, item_id: incomingTradeItem.id, direction: 'in', total_value: 2400 });

      const { data: soldAcquisition } = await admin.from('deal_items').select('deal_id').eq('item_id', soldItem.id).eq('direction', 'in').single();

      const countedSold = countingClient(clientA);
      const soldHistory = await loadItemContextHistory(countedSold.client, soldItem.id);
      // (channel/price-history queries are themselves skipped when there are
      // no listings — this fresh item has none — so only the `deals` lookup
      // triggered by having an exit deal is asserted here, not a fixed total.)
      check('an item WITH an exit deal makes the extra `deals` lookup (skipped entirely when there is no exit deal, per [A])', countedSold.calls().includes('deals') && countedSold.calls().includes('deal_items'), countedSold.calls());
      check('B: a sold item resolves its Sell deal as the exit deal (not the purchase deal insertItem also created)', soldHistory.exitDealId === saleDeal.id && soldHistory.exitDealId !== soldAcquisition?.deal_id, soldHistory.exitDealId);

      const tradedHistory = await loadItemContextHistory(clientA, tradedAwayItem.id);
      check('C: an item traded away resolves the Trade it went OUT on as the exit deal', tradedHistory.exitDealId === tradeOutDeal.id, tradedHistory.exitDealId);

      const incomingHistory = await loadItemContextHistory(clientA, incomingTradeItem.id);
      check('F: an item that came IN via a trade and is still owned has NO exit deal — the incoming trade is never exposed as one',
        incomingHistory.exitDealId === null && incomingHistory.exitDealId !== tradeInDeal.id, incomingHistory.exitDealId);

      const stillOwnedHistory = await loadItemContextHistory(clientA, item.id);
      check('A/G: an item that is only ever acquired (historical import / opening acquisition) and still owned has no exit deal', stillOwnedHistory.exitDealId === null, stillOwnedHistory.exitDealId);

      // Copy Item Context actually renders it.
      const emptyRelated = {
        brandName: null, categoryName: null, typeName: null, purposeName: null, tagNames: [] as string[],
        valueIn: null, valueOut: null, totalExpenses: 0, potentialReward: null, potentialRoi: null,
        realizedGain: null, realizedRoi: null, acquiredDate: null,
      };
      const soldText = buildItemContext({ ...soldItem, status: 'sold', sold_date: '2026-08-10' }, { ...emptyRelated, exitDealId: soldHistory.exitDealId });
      check('Copy Item Context for the sold item shows "Deal ID: <sell deal id>"', soldText.includes(`Deal ID: ${saleDeal.id}`), soldText);

      // Cross-user isolation: user B cannot resolve an exit deal for user A's item through RLS.
      const asBExit = await loadItemContextHistory(clientB, soldItem.id);
      check('user B cannot resolve an exit deal for user A\'s item (RLS: deal_items/deals rows are invisible)', asBExit.exitDealId === null, asBExit.exitDealId);
    }

    console.log('\n[F — readable, paste-ready plain text]');
    check('plain text, no JSON/markup braces', !/[{}]/.test(text) && !text.includes('```'));
    check('lines are short enough to wrap cleanly on mobile except long lead notes (max 420)', text.split('\n').every((l) => l.length <= 420));
    check('no blank-line runs longer than one', !/\n\n\n/.test(text));
    console.log('\n----- GENERATED CONTEXT (real DB fixture) -----\n' + text + '\n----- END -----');

    // Empty-history item still produces a clean context
    const bare = await insertItem(userA, 'Bare Item');
    const bareHistory = await loadItemContextHistory(clientA, bare.id);
    const bareText = buildItemContext(bare, { brandName: 'Gibson-Context-Test', categoryName: null, typeName: null, purposeName: null, tagNames: [], valueIn: null, valueOut: null, totalExpenses: 0, potentialReward: null, potentialRoi: null, realizedGain: null, realizedRoi: null, acquiredDate: null, listingCycles: bareHistory.listingCycles, leads: bareHistory.leads });
    check('an item with no listings/leads omits LISTING HISTORY and LEADS but keeps Item ID', bareText.includes(`Item ID: ${bare.id}`) && !bareText.includes('LISTING HISTORY') && !bareText.includes('LEADS'));
  } finally {
    console.log('\n=== Cleanup ===');
    if (leadIds.length) await admin.from('item_leads').delete().in('id', leadIds);
    if (listingIds.length) await admin.from('item_listings').delete().in('id', listingIds);
    if (itemIds.length) await admin.from('inventory_item_tags').delete().in('item_id', itemIds);
    if (tagIds.length) await admin.from('inventory_tags').delete().in('id', tagIds);
    if (itemIds.length) await admin.from('deal_items').delete().in('item_id', itemIds);
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: inventory_items deleted', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
    const { data: remaining } = await admin.from('inventory_items').select('id').in('id', itemIds.length ? itemIds : [-1]);
    check('all fixture items deleted', (remaining?.length ?? 0) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
