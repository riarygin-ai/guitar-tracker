/**
 * test-listing-management.ts
 *
 * Listing management (migration 20261026000000): the Trade flag, Kijiji
 * trade-only listings, Unlist vs inventory-exit End, and the one write path
 * shared by the item page and MCP manage_listing — apply_listing_changes
 * via src/lib/listings/listingWriteService.ts.
 *
 *   A  pure rules: listingTerms, UI validation, formatting, dates
 *   B  schema: columns/defaults, Reverb-Trade guard, end_reason check
 *   C  apply_listing_changes as an authenticated user (LIST/UPDATE/UNLIST,
 *      terms per platform, price history, review/reject, batch atomicity,
 *      idempotency, cycles, aggregate item status, draft promotion)
 *   D  Sell/Trade operations end listings as ITEM_EXITED (never cancelled)
 *   E  MCP manage_listing service (platform names, result shape, wording)
 *   F  isolation: another user can't touch or see this user's listings
 *   G  read models: item context text + analysis export
 *   H  UI wiring (listing card source structure)
 *
 * Local Supabase only (safety-gated). Every row created is removed.
 *
 * Usage: npx tsx scripts/test-listing-management.ts
 */

import fs from 'fs';
import path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, assertLocalSupabaseUrl, assertLocalSupabaseIsRunning } from './setup-analytics-test-fixtures';
import { supabase, createSellOperation, createTradeOperation, saveListingDraftText, applyItemListingChanges } from '../src/lib/supabase';
import { applyListingChanges, manageListing, formatActionLine, toTorontoDate, listingResultError, type ApplyListingChangesResult } from '../src/lib/listings/listingWriteService';
import { listingTermsError, listingTermsMessage, formatListingTerms, platformSupportsTrade, listingOfferMode } from '../src/lib/listings/listingTerms';
import { validateListingTermsInput } from '../src/components/AiAssistantCard';
import { buildItemContext } from '../src/lib/itemContext';
import { loadItemContextHistory } from '../src/lib/itemContextData';
import { getCanonicalInventoryAnalysis } from '../src/lib/analytics/inventoryAnalysisService';
import type { InventoryItem } from '../src/types';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail, null, 1)?.slice(0, 1500) : ''); }
}

function localDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const uuid = () => crypto.randomUUID();

async function ensureUser(admin: SupabaseClient, email: string, password: string): Promise<number> {
  const { data: list } = await admin.auth.admin.listUsers();
  let authId = list?.users.find((u) => u.email === email)?.id ?? null;
  if (!authId) {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    authId = data.user.id;
  }
  for (let i = 0; i < 20; i++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`app_users row for ${email} never appeared`);
}

async function main() {
  // ═══ A — pure rules ════════════════════════════════════════════════════
  console.log('\n[A — terms rules, UI validation, formatting]');
  check('Marketplace + Kijiji offer Trade; Reverb does not', platformSupportsTrade('Marketplace') && platformSupportsTrade('kijiji') && !platformSupportsTrade('Reverb'));
  check('Marketplace: price, no trade = valid', listingTermsError('Marketplace', 1800, false) === null);
  check('Marketplace: price + trade = valid', listingTermsError('Marketplace', 1800, true) === null);
  check('Marketplace: no price = LISTING_PRICE_REQUIRED (even with Trade)', listingTermsError('Marketplace', null, true) === 'LISTING_PRICE_REQUIRED' && listingTermsError('Marketplace', null, false) === 'LISTING_PRICE_REQUIRED');
  check('Kijiji: price only / price + trade / trade only are valid', listingTermsError('Kijiji', 1800, false) === null && listingTermsError('Kijiji', 1800, true) === null && listingTermsError('Kijiji', null, true) === null);
  check('Kijiji: no price + no trade = LISTING_PRICE_OR_TRADE_REQUIRED', listingTermsError('Kijiji', null, false) === 'LISTING_PRICE_OR_TRADE_REQUIRED');
  check('Reverb: price required, Trade not supported', listingTermsError('Reverb', null, false) === 'LISTING_PRICE_REQUIRED' && listingTermsError('Reverb', 1899, true) === 'LISTING_TRADE_NOT_SUPPORTED' && listingTermsError('Reverb', 1899, false) === null);
  check('UI messages: Kijiji "Enter a price or enable Trade." / others "Listed price is required."',
    listingTermsMessage('Kijiji', null, false) === 'Enter a price or enable Trade.' && listingTermsMessage('Marketplace', null, false) === 'Listed price is required.' && listingTermsMessage('Reverb', null, false) === 'Listed price is required.');
  check('validateListingTermsInput: Kijiji blank price + Trade passes; blank without Trade fails', validateListingTermsInput('Kijiji', '', true) === null && validateListingTermsInput('Kijiji', '  ', false) === 'Enter a price or enable Trade.');
  check('validateListingTermsInput: Marketplace blank fails, bad number fails, 950 passes', validateListingTermsInput('Marketplace', '', true) === 'Listed price is required.' && validateListingTermsInput('Marketplace', '-3', false) === 'Listed price must be greater than 0.' && validateListingTermsInput('Marketplace', '950', true) === null);
  check('validateListingTermsInput: a Trade value is ignored on Reverb (no checkbox there)', validateListingTermsInput('Reverb', '1899', true) === null && validateListingTermsInput('Reverb', '', true) === 'Listed price is required.');
  check('terms labels: "C$1,800 · Trade", "C$1,899", "Trade only"', formatListingTerms(1800, true) === 'C$1,800 · Trade' && formatListingTerms(1899, false) === 'C$1,899' && formatListingTerms(null, true) === 'Trade only');
  check('offer mode derived: sale only / sale + trade / trade only / none', listingOfferMode(1, false) === 'SALE_ONLY' && listingOfferMode(1, true) === 'SALE_AND_TRADE' && listingOfferMode(null, true) === 'TRADE_ONLY' && listingOfferMode(null, false) === null);
  check('toTorontoDate: bare date kept, late-evening UTC instant -> Toronto date, default = today in Toronto, garbage -> null',
    toTorontoDate('2026-10-20') === '2026-10-20' && toTorontoDate('2026-10-27T02:30:00Z') === '2026-10-26' && toTorontoDate(undefined, new Date('2026-10-27T03:00:00Z')) === '2026-10-26' && toTorontoDate('soon') === null);
  const before = { status: 'active', asking_price: 1800, trade_enabled: true, listed_at: '2026-10-01' };
  check('line: price drop keeps "· Trade" suffix', formatActionLine({ platform: 'Marketplace', channel_name: 'Marketplace', outcome: 'UPDATED', code: null, before, after: { ...before, asking_price: 1700 } }) === 'Marketplace: C$1,800 → C$1,700 · Trade');
  check('line: trade removed, price kept', formatActionLine({ platform: 'Marketplace', channel_name: 'Marketplace', outcome: 'UPDATED', code: null, before, after: { ...before, trade_enabled: false } }) === 'Marketplace: C$1,800 (Trade removed)');
  check('line: created trade only', formatActionLine({ platform: 'Kijiji', channel_name: 'Kijiji', outcome: 'CREATED', code: null, before: null, after: { ...before, asking_price: null } }) === 'Kijiji: Trade only');
  check('line: trade only -> priced keeps Trade', formatActionLine({ platform: 'Kijiji', channel_name: 'Kijiji', outcome: 'UPDATED', code: null, before: { ...before, asking_price: null }, after: { ...before, asking_price: 1900 } }) === 'Kijiji: Trade only → C$1,900 · Trade');
  check('line: review "No active Kijiji listing exists."', formatActionLine({ platform: 'Kijiji', channel_name: 'Kijiji', outcome: 'REVIEW', code: 'NO_ACTIVE_LISTING', before: null, after: null }) === 'No active Kijiji listing exists.');

  // ═══ setup ═════════════════════════════════════════════════════════════
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const EMAIL_A = 'listing-mgmt-a@example.test';
  const EMAIL_B = 'listing-mgmt-b@example.test';
  const PW = 'Listing-Mgmt-Local-Only-1!';
  const userA = await ensureUser(admin, EMAIL_A, PW);
  const userB = await ensureUser(admin, EMAIL_B, PW);
  const { error: signErr } = await supabase.auth.signInWithPassword({ email: EMAIL_A, password: PW });
  if (signErr) throw new Error(signErr.message);
  const cA: SupabaseClient = supabase as unknown as SupabaseClient;
  const cB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signErrB } = await cB.auth.signInWithPassword({ email: EMAIL_B, password: PW });
  if (signErrB) throw new Error(signErrB.message);

  const { data: channels } = await admin.from('deal_channels').select('id, name').eq('is_listing_platform', true);
  const ch = (n: string) => (channels ?? []).find((c) => c.name === n)?.id as number;
  const MKT = ch('Marketplace'), KIJ = ch('Kijiji'), REV = ch('Reverb');
  if (!MKT || !KIJ || !REV) throw new Error('Marketplace/Kijiji/Reverb channels missing');

  const BRAND = 'Test-Listing-Mgmt-Brand';
  const brandId = ((await admin.from('brands').select('id').eq('name', BRAND).maybeSingle()).data?.id as number | undefined)
    ?? ((await admin.from('brands').insert({ name: BRAND }).select('id').single()).data!.id as number);
  const items: number[] = [];
  const deals: number[] = [];
  async function item(userId = userA, status = 'owned'): Promise<number> {
    const { data, error } = await admin.from('inventory_items').insert({ brand_id: brandId, model: 'Studio', status, user_id: userId }).select('id').single();
    if (error || !data) throw new Error(error?.message);
    items.push(data.id as number);
    return data.id as number;
  }
  const rows = async (itemId: number) => ((await admin.from('item_listings').select('*').eq('inventory_item_id', itemId).order('id')).data ?? []) as Record<string, unknown>[];
  const history = async (listingId: number) => ((await admin.from('item_listing_price_history').select('old_asking_price, new_asking_price').eq('item_listing_id', listingId).order('id')).data ?? []);
  const itemStatus = async (itemId: number) => (await admin.from('inventory_items').select('status').eq('id', itemId).single()).data?.status as string;
  const apply = (itemId: number, actions: Parameters<typeof applyListingChanges>[1]['actions'], mutationId = uuid(), client: SupabaseClient = cA) =>
    applyListingChanges(client, { mutationId, itemId, source: 'MCP', actions });
  const today = localDate(0);
  const lastWeek = localDate(-7);

  try {
    // ═══ B — schema ══════════════════════════════════════════════════════
    console.log('\n[B — schema]');
    const plain = await item();
    const { data: plainRow, error: plainErr } = await admin.from('item_listings').insert({ user_id: userA, inventory_item_id: plain, deal_channel_id: MKT, status: 'active', listed_at: today, asking_price: 500 }).select('*').single();
    check('trade_enabled defaults to false (existing/legacy-shaped rows read false), end_reason null', !plainErr && plainRow?.trade_enabled === false && plainRow?.end_reason === null, { plainErr, plainRow });
    const { error: nullTradeErr } = await admin.from('item_listings').update({ trade_enabled: null }).eq('id', plainRow!.id);
    check('trade_enabled is NOT NULL', !!nullTradeErr);
    const { error: revTradeErr } = await admin.from('item_listings').insert({ user_id: userA, inventory_item_id: plain, deal_channel_id: REV, status: 'active', listed_at: today, asking_price: 900, trade_enabled: true });
    check('Reverb can never be trade_enabled, on ANY write path (table guard)', !!revTradeErr && /LISTING_TRADE_NOT_SUPPORTED/.test(revTradeErr.message), revTradeErr);
    const { error: reasonErr } = await admin.from('item_listings').update({ end_reason: 'UNLISTED' }).eq('id', plainRow!.id);
    check('end_reason only allowed on ended rows', !!reasonErr, reasonErr);
    const { data: legacy } = await admin.from('item_listings').insert({ user_id: userA, inventory_item_id: plain, deal_channel_id: KIJ, status: 'active', listed_at: today }).select('id').single();
    check('a legacy-shaped active listing with no price is still representable (direct insert)', !!legacy);
    const { error: legacyTextErr } = await admin.from('item_listings').update({ description: 'edited text' }).eq('id', legacy!.id);
    check('...and its text can still be edited', !legacyTextErr, legacyTextErr);

    // ═══ C — apply_listing_changes ═══════════════════════════════════════
    console.log('\n[C — LIST / UPDATE / UNLIST]');
    const studio = await item();
    // "Listed the Studio on Marketplace for 1800 and Kijiji for 1750, trade on both."
    const m1 = uuid();
    const list2 = await apply(studio, [
      { action: 'LIST', dealChannelId: MKT, askingPrice: 1800, tradeEnabled: true, date: lastWeek },
      { action: 'LIST', dealChannelId: KIJ, askingPrice: 1750, tradeEnabled: true, date: lastWeek },
    ], m1);
    check('LIST two platforms in one request -> APPLIED, both CREATED', list2.status === 'APPLIED' && list2.actions.every((a) => a.outcome === 'CREATED') && list2.actions.length === 2, list2);
    let r = await rows(studio);
    const mktRow = r.find((x) => x.deal_channel_id === MKT)!;
    const kijRow = r.find((x) => x.deal_channel_id === KIJ)!;
    check('Marketplace = 1800 + Trade, Kijiji = 1750 + Trade, both active, listed_at = given date',
      Number(mktRow.asking_price) === 1800 && mktRow.trade_enabled === true && Number(kijRow.asking_price) === 1750 && kijRow.trade_enabled === true && mktRow.status === 'active' && kijRow.listed_at === lastWeek, r);
    check('item aggregate status -> listed', list2.item_status_before === 'owned' && list2.item_status_after === 'listed' && (await itemStatus(studio)) === 'listed');
    check('each new listing got exactly one price-history row (initial price)', (await history(mktRow.id as number)).length === 1 && (await history(kijRow.id as number)).length === 1);

    // retry the SAME mutation -> replay, no duplicates
    const replay = await apply(studio, [
      { action: 'LIST', dealChannelId: MKT, askingPrice: 1800, tradeEnabled: true, date: lastWeek },
      { action: 'LIST', dealChannelId: KIJ, askingPrice: 1750, tradeEnabled: true, date: lastWeek },
    ], m1);
    check('same mutation_id retried -> replay of the original result, no second cycle', replay.replay === true && replay.status === 'APPLIED' && (await rows(studio)).length === 2, replay);
    const reused = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 1 }], m1);
    check('same mutation_id with a DIFFERENT request -> REJECTED MUTATION_ID_REUSED, nothing written', reused.status === 'REJECTED' && reused.code === 'MUTATION_ID_REUSED' && Number((await rows(studio)).find((x) => x.id === mktRow.id)!.asking_price) === 1800, reused);

    // LIST while active -> review, no duplicate
    const dupList = await apply(studio, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 1700, date: today }]);
    check('LIST on a platform that already has an active listing -> REVIEW_REQUIRED LISTING_ALREADY_ACTIVE with current terms', dupList.status === 'REVIEW_REQUIRED' && dupList.actions[0].code === 'LISTING_ALREADY_ACTIVE' && dupList.actions[0].before?.asking_price === 1800 && dupList.actions[0].before?.trade_enabled === true, dupList);
    check('...and no second open Marketplace listing exists', (await rows(studio)).filter((x) => x.deal_channel_id === MKT).length === 1);

    // UPDATE price only (Trade preserved) — "Drop the Studio on Marketplace to 1699."
    const upPrice = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 1699 }]);
    r = await rows(studio);
    check('UPDATE price only -> 1800 → 1699, Trade preserved', upPrice.status === 'APPLIED' && upPrice.actions[0].outcome === 'UPDATED' && Number(r.find((x) => x.id === mktRow.id)!.asking_price) === 1699 && r.find((x) => x.id === mktRow.id)!.trade_enabled === true, upPrice);
    check('...price history records 1800 → 1699', JSON.stringify((await history(mktRow.id as number)).map((h) => [h.old_asking_price, h.new_asking_price])) === JSON.stringify([[null, 1800], [1800, 1699]]));
    check('...Kijiji unchanged by a Marketplace-only command', Number(r.find((x) => x.id === kijRow.id)!.asking_price) === 1750);

    // UPDATE trade only (price preserved, no fake price history) — "Remove trade from Marketplace but leave the price."
    const upTrade = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, tradeEnabled: false }]);
    r = await rows(studio);
    check('UPDATE Trade only -> trade true → false, price kept', upTrade.status === 'APPLIED' && r.find((x) => x.id === mktRow.id)!.trade_enabled === false && Number(r.find((x) => x.id === mktRow.id)!.asking_price) === 1699, upTrade);
    check('...no price-history row for a Trade change (still 2 rows)', (await history(mktRow.id as number)).length === 2);
    const upTradeBack = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, tradeEnabled: true }]);
    check('...false → true is not a price change either (still 2 rows)', upTradeBack.status === 'APPLIED' && (await history(mktRow.id as number)).length === 2);

    // UPDATE price + trade together
    const upBoth = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 1650, tradeEnabled: false }]);
    r = await rows(studio);
    check('UPDATE price + Trade together', upBoth.status === 'APPLIED' && Number(r.find((x) => x.id === mktRow.id)!.asking_price) === 1650 && r.find((x) => x.id === mktRow.id)!.trade_enabled === false && (await history(mktRow.id as number)).length === 3, upBoth);

    // identical update -> NO_CHANGE
    const same = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 1650, tradeEnabled: false }]);
    check('UPDATE to the current terms -> NO_CHANGE, nothing written', same.status === 'NO_CHANGE' && same.actions[0].outcome === 'NO_CHANGE' && (await history(mktRow.id as number)).length === 3, same);

    // Kijiji: priced -> trade only -> priced again
    const toTradeOnly = await apply(studio, [{ action: 'UPDATE', dealChannelId: KIJ, askingPrice: null, tradeEnabled: true }]);
    r = await rows(studio);
    check('Kijiji can become trade only (price null + Trade)', toTradeOnly.status === 'APPLIED' && r.find((x) => x.id === kijRow.id)!.asking_price === null && r.find((x) => x.id === kijRow.id)!.trade_enabled === true, toTradeOnly);
    check('...clearing the price writes no price-history row', (await history(kijRow.id as number)).length === 1);
    const kijBad = await apply(studio, [{ action: 'UPDATE', dealChannelId: KIJ, tradeEnabled: false }]);
    check('Kijiji trade only -> removing Trade without a price -> REJECTED LISTING_PRICE_OR_TRADE_REQUIRED', kijBad.status === 'REJECTED' && kijBad.actions[0].code === 'LISTING_PRICE_OR_TRADE_REQUIRED' && listingResultError(kijBad) === 'Enter a price or enable Trade.', kijBad);
    const kijPriced = await apply(studio, [{ action: 'UPDATE', dealChannelId: KIJ, askingPrice: 1900 }]);
    r = await rows(studio);
    check('"Kijiji isn\'t trade-only anymore, 1900, leave Trade" -> 1900 + Trade', kijPriced.status === 'APPLIED' && Number(r.find((x) => x.id === kijRow.id)!.asking_price) === 1900 && r.find((x) => x.id === kijRow.id)!.trade_enabled === true);
    check('...price history: initial 1750, then NULL → 1900 (set again)', JSON.stringify((await history(kijRow.id as number)).map((h) => [h.old_asking_price, h.new_asking_price])) === JSON.stringify([[null, 1750], [null, 1900]]));

    // Marketplace price required
    const mktNull = await apply(studio, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: null }]);
    check('Marketplace: clearing the price -> REJECTED LISTING_PRICE_REQUIRED', mktNull.status === 'REJECTED' && mktNull.actions[0].code === 'LISTING_PRICE_REQUIRED' && listingResultError(mktNull) === 'Listed price is required.', mktNull);

    // UPDATE with no active listing -> review, nothing created
    const rv = await apply(studio, [{ action: 'UPDATE', dealChannelId: REV, askingPrice: 1700 }]);
    check('UPDATE a platform with no active listing -> REVIEW_REQUIRED NO_ACTIVE_LISTING, nothing created', rv.status === 'REVIEW_REQUIRED' && rv.actions[0].code === 'NO_ACTIVE_LISTING' && !(await rows(studio)).some((x) => x.deal_channel_id === REV), rv);

    // Batch atomicity
    const atomicReview = await apply(studio, [
      { action: 'UPDATE', dealChannelId: MKT, askingPrice: 1500 },
      { action: 'UPDATE', dealChannelId: REV, askingPrice: 1700 },
    ]);
    check('batch: one action needs review -> whole batch REVIEW_REQUIRED and the valid Marketplace change is NOT applied',
      atomicReview.status === 'REVIEW_REQUIRED' && Number((await rows(studio)).find((x) => x.id === mktRow.id)!.asking_price) === 1650 && atomicReview.actions[0].outcome === 'UPDATED' && atomicReview.actions[1].outcome === 'REVIEW', atomicReview);
    const fresh = await item();
    const atomicReject = await apply(fresh, [
      { action: 'LIST', dealChannelId: MKT, askingPrice: 1800, date: today },
      { action: 'LIST', dealChannelId: KIJ, askingPrice: null, tradeEnabled: false, date: today },
    ]);
    check('batch: one invalid LIST -> REJECTED, the valid LIST is not created either', atomicReject.status === 'REJECTED' && (await rows(fresh)).length === 0 && (await itemStatus(fresh)) === 'owned', atomicReject);
    const dupPlat = await apply(fresh, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 1, date: today }, { action: 'UPDATE', dealChannelId: MKT, askingPrice: 2 }]);
    check('batch: the same platform twice -> REJECTED DUPLICATE_PLATFORM', dupPlat.status === 'REJECTED' && dupPlat.actions[1].code === 'DUPLICATE_PLATFORM' && (await rows(fresh)).length === 0, dupPlat);

    // Kijiji trade only LIST; Reverb rules
    const js = await item();
    const tradeOnly = await apply(js, [{ action: 'LIST', dealChannelId: KIJ, askingPrice: null, tradeEnabled: true, date: today }]);
    r = await rows(js);
    check('"Put the JS1600 on Kijiji trade only" -> asking_price NULL, trade_enabled true, active', tradeOnly.status === 'APPLIED' && r.length === 1 && r[0].asking_price === null && r[0].trade_enabled === true && r[0].status === 'active', { tradeOnly, r });
    check('...no price-history row for a trade-only listing', (await history(r[0].id as number)).length === 0);
    const kijNone = await apply(js, [{ action: 'LIST', dealChannelId: MKT, askingPrice: null, date: today }]);
    check('Marketplace LIST without price -> REJECTED LISTING_PRICE_REQUIRED', kijNone.status === 'REJECTED' && kijNone.actions[0].code === 'LISTING_PRICE_REQUIRED');
    const revTrade = await apply(js, [{ action: 'LIST', dealChannelId: REV, askingPrice: 1899, tradeEnabled: true, date: today }]);
    check('Reverb LIST with Trade -> REJECTED LISTING_TRADE_NOT_SUPPORTED', revTrade.status === 'REJECTED' && revTrade.actions[0].code === 'LISTING_TRADE_NOT_SUPPORTED', revTrade);
    const revNoPrice = await apply(js, [{ action: 'LIST', dealChannelId: REV, askingPrice: null, date: today }]);
    check('Reverb LIST without price -> REJECTED LISTING_PRICE_REQUIRED', revNoPrice.status === 'REJECTED' && revNoPrice.actions[0].code === 'LISTING_PRICE_REQUIRED');
    const revOk = await apply(js, [{ action: 'LIST', dealChannelId: REV, askingPrice: 1899, date: today }]);
    check('Reverb LIST with price -> CREATED, trade_enabled stays false', revOk.status === 'APPLIED' && (await rows(js)).find((x) => x.deal_channel_id === REV)?.trade_enabled === false);

    // dates
    const future = await apply(fresh, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 5, date: localDate(3) }]);
    check('LIST dated in the future -> REJECTED DATE_IN_FUTURE', future.status === 'REJECTED' && future.actions[0].code === 'DATE_IN_FUTURE');
    const { data: acqDeal } = await admin.from('deals').insert({ user_id: userA, deal_type: 'purchase', deal_date: localDate(-3), deal_channel_id: null }).select('id').single();
    deals.push(acqDeal!.id as number);
    await admin.from('deal_items').insert({ user_id: userA, deal_id: acqDeal!.id, item_id: fresh, direction: 'in', total_value: 100 });
    const beforeAcq = await apply(fresh, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 5, date: localDate(-10) }]);
    check('LIST dated before the item was acquired -> REJECTED LISTED_BEFORE_ACQUIRED', beforeAcq.status === 'REJECTED' && beforeAcq.actions[0].code === 'LISTED_BEFORE_ACQUIRED', beforeAcq);

    // UNLIST — "Take the Studio off Kijiji."
    console.log('\n[C — UNLIST, relist, aggregate status]');
    const unlist = await apply(studio, [{ action: 'UNLIST', dealChannelId: KIJ, date: today }]);
    r = await rows(studio);
    const kijAfter = r.find((x) => x.id === kijRow.id)!;
    check('UNLIST Kijiji -> status ended, end_reason UNLISTED, ended_at = date (never cancelled)', unlist.status === 'APPLIED' && unlist.actions[0].outcome === 'UNLISTED' && kijAfter.status === 'ended' && kijAfter.end_reason === 'UNLISTED' && kijAfter.ended_at === today && kijAfter.cancelled_at === null, { unlist, kijAfter });
    check('...the cycle keeps its Trade state (1900 + Trade) in history', Number(kijAfter.asking_price) === 1900 && kijAfter.trade_enabled === true);
    check('...item stays listed: Marketplace is still active', unlist.item_status_after === 'listed' && (await itemStatus(studio)) === 'listed' && JSON.stringify(unlist.active_channel_ids_after) === JSON.stringify([MKT]), unlist);
    const unlistAgain = await apply(studio, [{ action: 'UNLIST', dealChannelId: KIJ }]);
    check('UNLIST again (new mutation) -> NO_CHANGE NOT_LISTED, nothing re-ended', unlistAgain.status === 'NO_CHANGE' && unlistAgain.actions[0].code === 'NOT_LISTED' && (await rows(studio)).filter((x) => x.deal_channel_id === KIJ).length === 1, unlistAgain);
    const badUnlistItem = await item();
    await apply(badUnlistItem, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 10, date: today }]);
    const unlistEarly = await apply(badUnlistItem, [{ action: 'UNLIST', dealChannelId: MKT, date: lastWeek }]);
    check('UNLIST dated before the listing started -> REJECTED UNLISTED_BEFORE_LISTED', unlistEarly.status === 'REJECTED' && unlistEarly.actions[0].code === 'UNLISTED_BEFORE_LISTED', unlistEarly);

    // relist -> new cycle
    const relist = await apply(studio, [{ action: 'LIST', dealChannelId: KIJ, askingPrice: 1800, tradeEnabled: true, date: today }]);
    r = await rows(studio);
    const kijCycles = r.filter((x) => x.deal_channel_id === KIJ);
    check('relisting Kijiji creates a NEW cycle; the unlisted one is preserved untouched', relist.status === 'APPLIED' && kijCycles.length === 2 && kijCycles[0].status === 'ended' && kijCycles[0].end_reason === 'UNLISTED' && kijCycles[1].status === 'active' && kijCycles[1].id !== kijRow.id, kijCycles);

    // unlist everything -> owned
    const unlistAll = await apply(studio, [{ action: 'UNLIST', dealChannelId: KIJ }, { action: 'UNLIST', dealChannelId: MKT }]);
    check('unlisting the last active platforms -> item back to owned', unlistAll.status === 'APPLIED' && unlistAll.item_status_after === 'owned' && (await itemStatus(studio)) === 'owned', unlistAll);
    const unlistReplay = await applyListingChanges(cA, { mutationId: m1, itemId: studio, source: 'MCP', actions: [
      { action: 'LIST', dealChannelId: MKT, askingPrice: 1800, tradeEnabled: true, date: lastWeek },
      { action: 'LIST', dealChannelId: KIJ, askingPrice: 1750, tradeEnabled: true, date: lastWeek },
    ] });
    check('a late retry of the very first mutation still replays (no new cycles even after unlisting)', unlistReplay.replay === true && (await rows(studio)).filter((x) => x.status === 'active').length === 0);

    // draft promotion
    const drafted = await item();
    const { data: draft } = await saveListingDraftText({ inventory_item_id: drafted, deal_channel_id: MKT, description: 'Draft ad text', is_ai_generated: true });
    const promote = await apply(drafted, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 999, tradeEnabled: true, date: today }]);
    r = await rows(drafted);
    check('LIST over a saved draft promotes the SAME row (text kept), no second row', promote.status === 'APPLIED' && r.length === 1 && r[0].id === draft!.id && r[0].description === 'Draft ad text' && r[0].status === 'active' && r[0].trade_enabled === true, { promote, r });

    // UI entry point (same RPC, source UI)
    const uiItem = await item();
    const ui = await applyItemListingChanges(uiItem, [{ action: 'LIST', dealChannelId: KIJ, askingPrice: null, tradeEnabled: true, date: today }]);
    const { data: uiMut } = await admin.from('item_listing_mutations').select('source').eq('inventory_item_id', uiItem);
    check('item page path (applyItemListingChanges) uses the same RPC and is recorded as source UI', ui.status === 'APPLIED' && uiMut?.length === 1 && uiMut[0].source === 'UI', { ui, uiMut });
    const { data: noMut } = await admin.from('item_listing_mutations').select('id').eq('inventory_item_id', fresh);
    check('REVIEW/REJECTED calls leave no mutation record (the corrected request may reuse the id)', (noMut ?? []).length === 0, noMut);

    // ═══ D — Sell / Trade ═══════════════════════════════════════════════
    console.log('\n[D — Sell/Trade end listings as ITEM_EXITED]');
    const sold = await item();
    await apply(sold, [{ action: 'LIST', dealChannelId: MKT, askingPrice: 1000, tradeEnabled: true, date: lastWeek }, { action: 'LIST', dealChannelId: REV, askingPrice: 1100, date: lastWeek }]);
    const { data: sale, error: saleErr } = await createSellOperation({ dealDate: today, channelId: MKT, items: [{ item_id: sold, total_value: 950 }], cfDescription: 'listing-mgmt sale' });
    if (sale?.deal_id) deals.push(sale.deal_id as number);
    r = await rows(sold);
    check('Sell ends ALL active listings: status ended, end_reason ITEM_EXITED, ended_at = sale date', !saleErr && r.length === 2 && r.every((x) => x.status === 'ended' && x.end_reason === 'ITEM_EXITED' && x.ended_at === today && x.cancelled_at === null), { saleErr, r });
    const afterSale = await apply(sold, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 900 }]);
    check('a sold item cannot be listed/updated -> REJECTED ITEM_NOT_IN_INVENTORY', afterSale.status === 'REJECTED' && afterSale.actions[0].code === 'ITEM_NOT_IN_INVENTORY', afterSale);
    const traded = await item();
    const incoming = await item(userA, 'new');
    await apply(traded, [{ action: 'LIST', dealChannelId: KIJ, askingPrice: null, tradeEnabled: true, date: lastWeek }]);
    const { data: trade, error: tradeErr } = await createTradeOperation({ dealDate: today, channelId: KIJ, outgoingItems: [{ item_id: traded, total_value: 300 }], incomingItems: [{ item_id: incoming, total_value: 300 }] });
    if (trade?.deal_id) deals.push(trade.deal_id as number);
    r = await rows(traded);
    check('Trade ends the outgoing item\'s active listing as ITEM_EXITED (Trade state kept)', !tradeErr && r.length === 1 && r[0].status === 'ended' && r[0].end_reason === 'ITEM_EXITED' && r[0].trade_enabled === true, { tradeErr, r });
    check('automatic end (ITEM_EXITED) is distinguishable from manual unlist (UNLISTED)', kijCycles[0].end_reason === 'UNLISTED' && r[0].end_reason === 'ITEM_EXITED');
    const ownedEnd = await item();
    const { data: oe } = await admin.from('item_listings').insert({ user_id: userA, inventory_item_id: ownedEnd, deal_channel_id: MKT, status: 'active', listed_at: today, asking_price: 50 }).select('id').single();
    await admin.from('item_listings').update({ status: 'ended', ended_at: today }).eq('id', oe!.id);
    check('a raw end of a listing on a still-owned item defaults to UNLISTED', (await rows(ownedEnd))[0].end_reason === 'UNLISTED');

    // ═══ E — MCP manage_listing ══════════════════════════════════════════
    console.log('\n[E — MCP manage_listing]');
    const mcpItem = await item();
    const mm = uuid();
    const created = await manageListing(cA, { mutation_id: mm, item_id: mcpItem, actions: [
      { action: 'LIST', platform: 'facebook marketplace', asking_price: 1800, trade_enabled: true },
      { action: 'LIST', platform: 'Kijiji', asking_price: 1750, trade_enabled: true },
    ] });
    check('LIST x2 -> "🟢 Listings: CREATED" with one line per platform', created.result === 'APPLIED' && created.headline === '🟢 Listings: CREATED' && JSON.stringify(created.lines) === JSON.stringify(['Marketplace: C$1,800 · Trade', 'Kijiji: C$1,750 · Trade']), created);
    check('...default listed date = today (Toronto) and active platforms reported', (await rows(mcpItem)).every((x) => x.listed_at === toTorontoDate(undefined)) && JSON.stringify(created.active_platforms_after) === JSON.stringify(['Marketplace', 'Kijiji']) && created.item_status_after === 'listed');
    const createdAgain = await manageListing(cA, { mutation_id: mm, item_id: mcpItem, actions: [
      { action: 'LIST', platform: 'facebook marketplace', asking_price: 1800, trade_enabled: true },
      { action: 'LIST', platform: 'Kijiji', asking_price: 1750, trade_enabled: true },
    ] });
    check('MCP retry with the same mutation_id -> replay, same lines, still 2 rows', createdAgain.replay && JSON.stringify(createdAgain.lines) === JSON.stringify(created.lines) && (await rows(mcpItem)).length === 2);
    const drop = await manageListing(cA, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UPDATE', platform: 'Marketplace', asking_price: 1700 }] });
    check('"Marketplace 1700 now, leave Kijiji" -> "🟢 Listings: UPDATED / Marketplace: C$1,800 → C$1,700 · Trade"', drop.headline === '🟢 Listings: UPDATED' && JSON.stringify(drop.lines) === JSON.stringify(['Marketplace: C$1,800 → C$1,700 · Trade']) && drop.actions.length === 1, drop);
    const review = await manageListing(cA, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UPDATE', platform: 'Reverb', asking_price: 1700 }] });
    check('"Change Reverb to 1700" with none active -> "🟡 Listings: REVIEW REQUIRED / No active Reverb listing exists."', review.result === 'REVIEW_REQUIRED' && review.headline === '🟡 Listings: REVIEW REQUIRED' && review.lines[0] === 'No active Reverb listing exists.' && !!review.next_step, review);
    const kOnly = await item();
    const tOnly = await manageListing(cA, { mutation_id: uuid(), item_id: kOnly, actions: [{ action: 'LIST', platform: 'kijiji', asking_price: null, trade_enabled: true, occurred_at: lastWeek }] });
    check('Kijiji trade only via MCP -> "🟢 Listings: CREATED / Kijiji: Trade only", dated occurred_at', tOnly.headline === '🟢 Listings: CREATED' && tOnly.lines[0] === 'Kijiji: Trade only' && (await rows(kOnly))[0].listed_at === lastWeek, tOnly);
    const off = await manageListing(cA, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UNLIST', platform: 'Kijiji' }] });
    check('"Take it off Kijiji" -> "🟢 Listings: UNLISTED / Kijiji: Unlisted (was C$1,750 · Trade)", item still listed', off.headline === '🟢 Listings: UNLISTED' && off.lines[0] === 'Kijiji: Unlisted (was C$1,750 · Trade)' && off.item_status_after === 'listed' && JSON.stringify(off.active_platforms_after) === JSON.stringify(['Marketplace']), off);
    const unknown = await manageListing(cA, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UPDATE', platform: 'Craigslist', asking_price: 1 }] });
    check('unknown platform -> REJECTED with the valid platform names', unknown.result === 'REJECTED' && unknown.code === 'INVALID_PLATFORM' && /Marketplace, Kijiji, Reverb|Marketplace.*Kijiji.*Reverb/.test(unknown.message ?? ''), unknown);
    const unlistWithPrice = await manageListing(cA, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UNLIST', platform: 'Marketplace', asking_price: 5 }] });
    check('UNLIST carrying a price -> REJECTED (no hidden price change)', unlistWithPrice.result === 'REJECTED' && Number((await rows(mcpItem)).find((x) => x.deal_channel_id === MKT)!.asking_price) === 1700);
    const emptyUpdate = await manageListing(cA, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UPDATE', platform: 'Marketplace' }] });
    check('UPDATE with nothing to change -> REJECTED VALIDATION_ERROR', emptyUpdate.result === 'REJECTED' && emptyUpdate.code === 'VALIDATION_ERROR');
    const badDate = await manageListing(cA, { mutation_id: uuid(), item_id: kOnly, actions: [{ action: 'LIST', platform: 'Marketplace', asking_price: 5, occurred_at: 'yesterday-ish' }] });
    check('unparseable occurred_at -> REJECTED', badDate.result === 'REJECTED' && badDate.code === 'VALIDATION_ERROR');
    const noItem = await manageListing(cA, { mutation_id: uuid(), item_id: 999999999, actions: [{ action: 'UPDATE', platform: 'Marketplace', asking_price: 5 }] });
    check('unknown item -> REJECTED ITEM_NOT_FOUND', noItem.result === 'REJECTED' && noItem.code === 'ITEM_NOT_FOUND', noItem);

    // ═══ F — isolation ════════════════════════════════════════════════════
    console.log('\n[F — isolation]');
    const otherUpdate = await apply(mcpItem, [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 1 }], uuid(), cB);
    check('another user cannot update this user\'s listing (ITEM_NOT_FOUND, price unchanged)', otherUpdate.status === 'REJECTED' && otherUpdate.code === 'ITEM_NOT_FOUND' && Number((await rows(mcpItem)).find((x) => x.deal_channel_id === MKT)!.asking_price) === 1700, otherUpdate);
    const otherUnlist = await manageListing(cB, { mutation_id: uuid(), item_id: mcpItem, actions: [{ action: 'UNLIST', platform: 'Marketplace' }] });
    check('another user cannot unlist it via MCP either', otherUnlist.result === 'REJECTED' && (await rows(mcpItem)).find((x) => x.deal_channel_id === MKT)!.status === 'active');
    const replayOther = await apply(mcpItem, [
      { action: 'LIST', dealChannelId: MKT, askingPrice: 1800, tradeEnabled: true, date: toTorontoDate(undefined)! },
      { action: 'LIST', dealChannelId: KIJ, askingPrice: 1750, tradeEnabled: true, date: toTorontoDate(undefined)! },
    ], mm, cB);
    check('another user reusing this user\'s mutation_id gets no replay of it', replayOther.replay === false && replayOther.status === 'REJECTED');
    const { data: bMuts } = await cB.from('item_listing_mutations').select('id').eq('inventory_item_id', mcpItem);
    check('mutation records are not visible to another user', (bMuts ?? []).length === 0);
    const { error: forgeErr } = await cB.from('item_listing_mutations').insert({ user_id: userA, mutation_id: uuid(), inventory_item_id: mcpItem, request_hash: 'x', result: {}, source: 'MCP' });
    check('another user cannot plant a mutation record for this user', !!forgeErr);

    // ═══ G — read models ═════════════════════════════════════════════════
    console.log('\n[G — read models]');
    const ctxBase = { brandName: BRAND, categoryName: null, typeName: null, purposeName: null, tagNames: [], valueIn: null, valueOut: null, totalExpenses: 0, potentialReward: null, potentialRoi: null, realizedGain: null, realizedRoi: null, acquiredDate: null };
    const ctxItem = (await admin.from('inventory_items').select('*').eq('id', studio).single()).data as InventoryItem;
    const hist = await loadItemContextHistory(cA, studio);
    const text = buildItemContext(ctxItem, { ...ctxBase, listingCycles: hist.listingCycles, leads: hist.leads });
    check('item context: unlisted cycle says Unlisted and keeps "Offer: Sale + Trade"', /Status: Unlisted \(ad removed, item still owned\)/.test(text) && /Offer: Sale \+ Trade/.test(text), text);
    const tOnlyCtx = buildItemContext((await admin.from('inventory_items').select('*').eq('id', kOnly).single()).data as InventoryItem,
      { ...ctxBase, listingCycles: (await loadItemContextHistory(cA, kOnly)).listingCycles, leads: [] });
    check('item context: Kijiji trade-only cycle says "Offer: Trade only"', /Kijiji\nCycle 1:[\s\S]*Status: Active[\s\S]*Offer: Trade only/.test(tOnlyCtx), tOnlyCtx);
    const soldCtx = buildItemContext((await admin.from('inventory_items').select('*').eq('id', sold).single()).data as InventoryItem,
      { ...ctxBase, listingCycles: (await loadItemContextHistory(cA, sold)).listingCycles, leads: [] });
    check('item context: Sell-ended cycle says "Ended (item sold/traded)"; Reverb has no Offer line (no Trade recorded)', /Status: Ended \(item sold\/traded\)/.test(soldCtx) && !/Reverb\nCycle 1:[^]*?Offer:[^]*?Price History/.test(soldCtx.split('Marketplace')[0]), soldCtx);
    const plainCtx = buildItemContext((await admin.from('inventory_items').select('*').eq('id', plain).single()).data as InventoryItem,
      { ...ctxBase, listingCycles: (await loadItemContextHistory(cA, plain)).listingCycles, leads: [] });
    check('item context: an unflagged (legacy) listing is never labelled "Sale only"', !/Offer:/.test(plainCtx) && !/Sale only/.test(plainCtx), plainCtx);
    const exportData = await getCanonicalInventoryAnalysis(cA);
    const mcpExport = exportData.listed_items.find((i) => i.item_id === mcpItem);
    check('analysis export: active_listings carry trade_enabled + listing_terms', !!mcpExport && mcpExport.active_listings.some((a) => a.channel_name === 'Marketplace' && a.trade_enabled === true && a.listing_terms === 'C$1,700 · Trade'), mcpExport?.active_listings);
    const kOnlyExport = exportData.listed_items.find((i) => i.item_id === kOnly);
    check('analysis export: Kijiji trade only -> listing_terms "Trade only"', kOnlyExport?.active_listings[0]?.listing_terms === 'Trade only', kOnlyExport?.active_listings);
    const unlistedEntry = mcpExport?.listing_history.find((h) => h.channel_name === 'Kijiji');
    check('analysis export: listing_history carries trade_enabled + end_reason per cycle', unlistedEntry?.trade_enabled === true && unlistedEntry?.end_reason === 'UNLISTED' && unlistedEntry?.status === 'ended', unlistedEntry);

    // ═══ H — UI wiring ═══════════════════════════════════════════════════
    console.log('\n[H — listing card wiring]');
    const card = fs.readFileSync(path.join(process.cwd(), 'src/components/AiAssistantCard.tsx'), 'utf8');
    check('Trade checkbox rendered only where platformSupportsTrade (Marketplace/Kijiji, not Reverb)', /const supportsTrade = platformSupportsTrade\(ch\.name\)/.test(card) && /\{supportsTrade && \(\s*<label className="mt-2 flex w-fit cursor-pointer items-center gap-2" data-trade-toggle>/.test(card) && />Trade<\/span>/.test(card));
    check('active listing card: "Update Listing" + "Unlist"; no manual "End Listing"/"Cancel" button', />\s*Unlist\s*</.test(card) && /'Update Listing'/.test(card) && !/End Listing/.test(card) && !/>\s*Cancel\s*</.test(card) && !/handleEndListing|endListing\(/.test(card));
    check('Start / Update / Unlist all go through applyItemListingChanges (the shared RPC path)', (card.match(/applyItemListingChanges\(itemId/g) ?? []).length === 3 && /action:\s+'LIST'/.test(card) && /action:\s+'UPDATE'/.test(card) && /action: 'UNLIST'/.test(card));
    check('form validation uses the platform terms rule (no DB errors shown raw)', (card.match(/validateListingTermsInput\(platform, tab\.priceInput, tab\.tradeInput\)/g) ?? []).length === 2 && /listingResultError\(result\)/.test(card));
    check('a record created by mistake can still be voided (behind the Unlist confirmation), drafts discarded', /Recorded by mistake\?/.test(card) && /'Void Record'/.test(card) && /Discard Draft/.test(card) && /cancelListing\(tab\.currentRow\.id\)/.test(card));
    check('status badge distinguishes Unlisted from Ended via end_reason', /end_reason === 'UNLISTED' \? 'unlisted' : 'ended'/.test(card) && /unlisted:\s+'Unlisted'/.test(card));
    check('mobile: action row wraps, fields stack (grid-cols-1 sm:grid-cols-2), Trade sits under the price', /flex flex-wrap gap-2 px-3 pb-3/.test(card) && /grid grid-cols-1 gap-3 p-3 sm:grid-cols-2/.test(card) && card.indexOf('data-trade-toggle') > card.indexOf('listed price`}'));
    const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/mcp/[[...path]]/route.ts'), 'utf8');
    const svc = fs.readFileSync(path.join(process.cwd(), 'src/lib/listings/listingWriteService.ts'), 'utf8');
    check('listing write service: caller\'s client only (no service_role / createClient / env), one RPC, no user_id filter, no direct table writes',
      !/service_role|SERVICE_ROLE|createClient|process\.env/.test(svc)
      && JSON.stringify(Array.from(svc.matchAll(/\.rpc\(\s*'([a-z_]+)'/g)).map((m) => m[1])) === JSON.stringify(['apply_listing_changes'])
      && !/\.eq\(\s*'user_id'/.test(svc) && !/\.(insert|update|upsert|delete)\s*\(/.test(svc));
    check('MCP manage_listing calls the shared service (no listing SQL in the route)', /manageListing\(supabase, input as ManageListingInput\)/.test(route) && !/from\('item_listings'\)/.test(route) && !/END'/.test(route.slice(route.indexOf("'manage_listing'"))) );
  } finally {
    console.log('\n[cleanup]');
    await supabase.auth.signOut();
    if (items.length) {
      await admin.from('item_listings').delete().in('inventory_item_id', items);
      await admin.from('cash_flow').delete().in('deal_id', deals);
      await admin.from('deal_items').delete().in('item_id', items);
      await admin.from('deals').delete().in('id', deals);
      await admin.from('inventory_items').delete().in('id', items);
    }
    const { data: leftItems } = await admin.from('inventory_items').select('id').in('id', items);
    const { data: leftMuts } = await admin.from('item_listing_mutations').select('id').in('inventory_item_id', items);
    check('cleanup: items, listings and mutation records removed', (leftItems ?? []).length === 0 && (leftMuts ?? []).length === 0, { leftItems, leftMuts });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });

export type { ApplyListingChangesResult };
