/**
 * test-listing-price.ts
 *
 * Focused validation for Listed Price tracking + price history
 * (supabase/migrations/20260905000000_item_listing_price_history.sql,
 * src/lib/supabase.ts's startListing/updateListingPrice/
 * getItemListingPriceHistory, src/components/AiAssistantCard.tsx's
 * validateAskingPrice/parseAskingPriceInput). Same conventions as every
 * other script here: tsx, no test framework, local check(), safety-gated
 * to local Supabase only.
 *
 * Section A — pure validateAskingPrice/parseAskingPriceInput unit tests.
 * Section B — DB trigger behavior via direct SQL (service client),
 *   isolated from any application code, to prove the trigger itself is
 *   correct independent of how item_listings gets written.
 * Section C — the real src/lib/supabase.ts functions the UI calls,
 *   signed in as an authenticated test user (RLS-scoped), covering every
 *   numbered scenario from this task's Part 9.
 * Section D — multi-user isolation for item_listing_price_history RLS.
 *
 * Usage:
 *   npx tsx scripts/test-listing-price.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  supabase,
  startListing,
  updateListingPrice,
  endListing,
  cancelListing,
  getItemListingPriceHistory,
  getItemListings,
} from '../src/lib/supabase';
import { validateAskingPrice, parseAskingPriceInput } from '../src/components/AiAssistantCard';
import type { ItemListing, ItemListingPriceHistory } from '../src/types';

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

function todayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ══════════════════════════════════════════════════════════════════════
  // Section A — pure validation helpers (no DB)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A — validateAskingPrice / parseAskingPriceInput]');
  check('blank price is valid (optional)', validateAskingPrice('') === null);
  check('whitespace-only price is valid (trimmed to blank)', validateAskingPrice('   ') === null);
  check('a positive price is valid', validateAskingPrice('500') === null);
  check('a decimal price is valid', validateAskingPrice('499.99') === null);
  check('zero is rejected', validateAskingPrice('0') !== null, validateAskingPrice('0'));
  check('a negative price is rejected', validateAskingPrice('-5') !== null);
  check('non-numeric text is rejected', validateAskingPrice('abc') !== null);
  check('parseAskingPriceInput("") -> null', parseAskingPriceInput('') === null);
  check('parseAskingPriceInput("  ") -> null', parseAskingPriceInput('  ') === null);
  check('parseAskingPriceInput("650") -> 650', parseAskingPriceInput('650') === 650);
  check('parseAskingPriceInput("650.5") -> 650.5', parseAskingPriceInput('650.5') === 650.5);

  // ══════════════════════════════════════════════════════════════════════
  // Section B — DB trigger behavior via direct SQL (no application code)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B — item_listings_track_price_history trigger, direct SQL]');

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const EMAIL = 'listing-price-fixture@example.test';
  const PASSWORD = 'Listing-Price-Fixture-Local-Only-1!';
  const { data: authUsers } = await admin.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
    if (error || !created.user) throw new Error(`Failed to create test user: ${error?.message}`);
    authUserId = created.user.id;
  }
  let userId: number | null = null;
  for (let attempt = 0; attempt < 10 && !userId; attempt++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) userId = data.id as number;
    else await new Promise((r) => setTimeout(r, 200));
  }
  if (!userId) throw new Error('test user app_users row never appeared');

  const BRAND_NAME = 'Test-Listing-Price-Brand';
  const { data: existingBrand } = await admin.from('brands').select('id').eq('name', BRAND_NAME).maybeSingle();
  const brandId = existingBrand
    ? (existingBrand.id as number)
    : (await (async () => {
        const { data, error } = await admin.from('brands').insert({ name: BRAND_NAME }).select('id').single();
        if (error || !data) throw new Error(`Failed to create test brand: ${error?.message}`);
        return data.id as number;
      })());

  const { data: channels } = await admin.from('deal_channels').select('id, name').eq('is_listing_platform', true);
  const marketplaceId = (channels ?? []).find((c) => c.name === 'Marketplace')?.id as number | undefined;
  const kijijiId = (channels ?? []).find((c) => c.name === 'Kijiji')?.id as number | undefined;
  if (!marketplaceId || !kijijiId) throw new Error('Marketplace/Kijiji deal_channels not found — seed data missing');

  const createdItemIds: number[] = [];
  const createdListingIds: number[] = [];

  async function createTestItem(): Promise<number> {
    const { data, error } = await admin.from('inventory_items').insert({ brand_id: brandId, model: 'Test Model', status: 'owned', user_id: userId }).select('id').single();
    if (error || !data) throw new Error(`Failed to create test item: ${error?.message}`);
    createdItemIds.push(data.id as number);
    return data.id as number;
  }

  async function historyFor(itemListingId: number): Promise<{ old_asking_price: number | null; new_asking_price: number }[]> {
    const { data, error } = await admin.from('item_listing_price_history').select('old_asking_price, new_asking_price').eq('item_listing_id', itemListingId).order('id');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  try {
    // B1 — INSERT with a price -> exactly one history row, old=null.
    {
      const itemId = await createTestItem();
      const { data: row, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString(), asking_price: 500 }).select('id').single();
      if (error || !row) throw new Error(error?.message);
      createdListingIds.push(row.id as number);
      const hist = await historyFor(row.id as number);
      check('B1: INSERT with price creates exactly 1 history row', hist.length === 1, hist);
      check('B1: history row has old=null, new=500', hist[0]?.old_asking_price === null && hist[0]?.new_asking_price === 500, hist[0]);
    }

    // B2 — INSERT without a price -> no history row.
    {
      const itemId = await createTestItem();
      const { data: row, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString() }).select('id').single();
      if (error || !row) throw new Error(error?.message);
      createdListingIds.push(row.id as number);
      const hist = await historyFor(row.id as number);
      check('B2: INSERT without a price creates no history row', hist.length === 0, hist);
    }

    // B3 — UPDATE to a different price -> 1 more history row (old=prev, new=next).
    {
      const itemId = await createTestItem();
      const { data: row } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString(), asking_price: 500 }).select('id').single();
      createdListingIds.push(row!.id as number);
      await admin.from('item_listings').update({ asking_price: 600 }).eq('id', row!.id);
      const hist = await historyFor(row!.id as number);
      check('B3: two history rows exist (insert + update)', hist.length === 2, hist);
      check('B3: second row is old=500, new=600', hist[1]?.old_asking_price === 500 && hist[1]?.new_asking_price === 600, hist[1]);
    }

    // B4 — UPDATE to the SAME price -> no duplicate row.
    {
      const itemId = await createTestItem();
      const { data: row } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString(), asking_price: 500 }).select('id').single();
      createdListingIds.push(row!.id as number);
      await admin.from('item_listings').update({ asking_price: 500 }).eq('id', row!.id);
      const hist = await historyFor(row!.id as number);
      check('B4: updating to the same price does not create a second row', hist.length === 1, hist);
    }

    // B5 — UPDATE to NULL (clearing) -> no new row.
    {
      const itemId = await createTestItem();
      const { data: row } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString(), asking_price: 500 }).select('id').single();
      createdListingIds.push(row!.id as number);
      await admin.from('item_listings').update({ asking_price: null }).eq('id', row!.id);
      const hist = await historyFor(row!.id as number);
      check('B5: clearing the price to null does not create a new history row', hist.length === 1, hist);
      const { data: after } = await admin.from('item_listings').select('asking_price').eq('id', row!.id).single();
      check('B5: asking_price is actually null after clearing (clearing IS allowed)', after?.asking_price === null, after);
    }

    // B6 — NULL -> value (populate a previously-null price) -> 1 row, old=null.
    {
      const itemId = await createTestItem();
      const { data: row } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString() }).select('id').single();
      createdListingIds.push(row!.id as number);
      await admin.from('item_listings').update({ asking_price: 700 }).eq('id', row!.id);
      const hist = await historyFor(row!.id as number);
      check('B6: populating a null price creates exactly 1 history row', hist.length === 1, hist);
      check('B6: old=null, new=700', hist[0]?.old_asking_price === null && hist[0]?.new_asking_price === 700, hist[0]);
    }

    // B7 — a text-only UPDATE (description) never touches price history.
    {
      const itemId = await createTestItem();
      const { data: row } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'draft', asking_price: null, description: 'first draft' }).select('id').single();
      createdListingIds.push(row!.id as number);
      await admin.from('item_listings').update({ description: 'edited draft text' }).eq('id', row!.id);
      const hist = await historyFor(row!.id as number);
      check('B7: an unrelated text-only update never fires the price trigger', hist.length === 0, hist);
    }

    // B8 — DB-level positive-price constraint.
    {
      const itemId = await createTestItem();
      const { error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString(), asking_price: 0 });
      check('B8: a zero asking_price is rejected at the DB level (item_listings_asking_price_positive_check)', !!error, error);
    }

    // ══════════════════════════════════════════════════════════════════
    // Section C — real src/lib/supabase.ts functions, authenticated
    // ══════════════════════════════════════════════════════════════════
    console.log('\n[C — startListing / updateListingPrice / endListing / cancelListing, authenticated]');

    const { error: signInErr } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signInErr) throw new Error(`Failed to sign in: ${signInErr.message}`);

    // C1 — Start listing with a price.
    {
      const itemId = await createTestItem();
      const { data, error } = await startListing({ inventory_item_id: itemId, deal_channel_id: marketplaceId, listed_at: todayDateString(), asking_price: 6000 });
      check('C1: startListing succeeds', !error && !!data, error);
      const row = data as ItemListing;
      if (row) createdListingIds.push(row.id);
      check('C1: status is active', row?.status === 'active', row);
      check('C1: asking_price is set to 6000', row?.asking_price === 6000, row);

      const { data: hist } = await getItemListingPriceHistory(row!.id);
      const rows = (hist ?? []) as unknown as ItemListingPriceHistory[];
      check('C1: exactly 1 price history row', rows.length === 1, rows);
      check('C1: history row old=null, new=6000', rows[0]?.old_asking_price === null && rows[0]?.new_asking_price === 6000, rows[0]);
    }

    // C2 — Start listing without a price.
    {
      const itemId = await createTestItem();
      const { data, error } = await startListing({ inventory_item_id: itemId, deal_channel_id: marketplaceId, listed_at: todayDateString(), asking_price: null });
      check('C2: startListing succeeds with no price', !error && !!data, error);
      const row = data as ItemListing;
      if (row) createdListingIds.push(row.id);
      check('C2: asking_price stays null', row?.asking_price === null, row);

      const { data: hist } = await getItemListingPriceHistory(row!.id);
      check('C2: no price history row is created', (hist ?? []).length === 0, hist);
    }

    // C3 — Update an active listing's price.
    {
      const itemId = await createTestItem();
      const { data: started } = await startListing({ inventory_item_id: itemId, deal_channel_id: marketplaceId, listed_at: todayDateString(), asking_price: 1000 });
      const listingId = (started as ItemListing).id;
      createdListingIds.push(listingId);

      const { data: updated, error } = await updateListingPrice(listingId, 1250);
      check('C3: updateListingPrice succeeds', !error && !!updated, error);
      check('C3: asking_price is now 1250', (updated as ItemListing)?.asking_price === 1250, updated);
      check('C3: status/listed_at untouched by the price update', (updated as ItemListing)?.status === 'active' && (updated as ItemListing)?.listed_at === todayDateString(), updated);

      const { data: hist } = await getItemListingPriceHistory(listingId);
      const rows = (hist ?? []) as unknown as ItemListingPriceHistory[];
      check('C3: 2 history rows now exist (start + update)', rows.length === 2, rows);
      check('C3: newest row is old=1000, new=1250', rows[0]?.old_asking_price === 1000 && rows[0]?.new_asking_price === 1250, rows[0]);
    }

    // C4 — Update price to the SAME value -> no duplicate history row.
    {
      const itemId = await createTestItem();
      const { data: started } = await startListing({ inventory_item_id: itemId, deal_channel_id: marketplaceId, listed_at: todayDateString(), asking_price: 900 });
      const listingId = (started as ItemListing).id;
      createdListingIds.push(listingId);

      await updateListingPrice(listingId, 900);
      const { data: hist } = await getItemListingPriceHistory(listingId);
      check('C4: updating to the identical price does not create a duplicate row', (hist ?? []).length === 1, hist);
    }

    // C5 — Existing active listing with a null asking_price gets populated.
    {
      const itemId = await createTestItem();
      const { data: started } = await startListing({ inventory_item_id: itemId, deal_channel_id: marketplaceId, listed_at: todayDateString(), asking_price: null });
      const listingId = (started as ItemListing).id;
      createdListingIds.push(listingId);
      check('C5: pre-condition — asking_price starts null', (started as ItemListing)?.asking_price === null, started);

      const { data: updated, error } = await updateListingPrice(listingId, 850);
      check('C5: populating a previously-null price succeeds', !error && (updated as ItemListing)?.asking_price === 850, { error, updated });

      const { data: hist } = await getItemListingPriceHistory(listingId);
      const rows = (hist ?? []) as unknown as ItemListingPriceHistory[];
      check('C5: history row is old=null, new=850', rows[0]?.old_asking_price === null && rows[0]?.new_asking_price === 850, rows[0]);
    }

    // C6 — Cancel a listing: price history remains; not shown as current.
    {
      const itemId = await createTestItem();
      const { data: started } = await startListing({ inventory_item_id: itemId, deal_channel_id: kijijiId, listed_at: todayDateString(), asking_price: 400 });
      const listingId = (started as ItemListing).id;
      createdListingIds.push(listingId);

      const { data: cancelled, error } = await cancelListing(listingId);
      check('C6: cancelListing succeeds', !error && (cancelled as ItemListing)?.status === 'cancelled', { error, cancelled });

      const { data: hist } = await getItemListingPriceHistory(listingId);
      check('C6: price history remains after cancellation (not deleted)', (hist ?? []).length === 1, hist);

      // "Not shown as current" — the row is no longer a current/active-or-
      // draft row, so any UI deriving "current price" from getItemListings
      // (filtering to draft/active only) naturally excludes it.
      const { data: allRows } = await getItemListings(itemId);
      const currentRows = ((allRows ?? []) as unknown as ItemListing[]).filter((r) => r.status === 'draft' || r.status === 'active');
      check('C6: no draft/active row remains for this item+channel — cancelled price is not "current"', currentRows.length === 0, currentRows);
      const cancelledRow = ((allRows ?? []) as unknown as ItemListing[]).find((r) => r.id === listingId);
      check('C6: the cancelled row itself still carries its old price for audit', cancelledRow?.asking_price === 400, cancelledRow);
    }

    // C7 — End a listing: price/history remain; ending itself logs nothing.
    {
      const itemId = await createTestItem();
      const { data: started } = await startListing({ inventory_item_id: itemId, deal_channel_id: marketplaceId, listed_at: todayDateString(), asking_price: 1100 });
      const listingId = (started as ItemListing).id;
      createdListingIds.push(listingId);

      const { data: ended, error } = await endListing(listingId, todayDateString());
      check('C7: endListing succeeds', !error && (ended as ItemListing)?.status === 'ended', { error, ended });
      check('C7: asking_price is untouched by ending', (ended as ItemListing)?.asking_price === 1100, ended);

      const { data: hist } = await getItemListingPriceHistory(listingId);
      check('C7: still exactly 1 history row — ending does not add one', (hist ?? []).length === 1, hist);
    }

    await supabase.auth.signOut();

    // ══════════════════════════════════════════════════════════════════
    // Section D — multi-user isolation for item_listing_price_history
    // ══════════════════════════════════════════════════════════════════
    console.log('\n[D — multi-user isolation]');

    const EMAIL_B = 'listing-price-fixture-b@example.test';
    let authUserBId = (await admin.auth.admin.listUsers()).data?.users.find((u) => u.email === EMAIL_B)?.id ?? null;
    if (!authUserBId) {
      const { data: createdB, error } = await admin.auth.admin.createUser({ email: EMAIL_B, password: PASSWORD, email_confirm: true });
      if (error || !createdB.user) throw new Error(`Failed to create user B: ${error?.message}`);
      authUserBId = createdB.user.id;
    }
    let userBId: number | null = null;
    for (let attempt = 0; attempt < 10 && !userBId; attempt++) {
      const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserBId).maybeSingle();
      if (data) userBId = data.id as number;
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (!userBId) throw new Error('user B app_users row never appeared');

    const { data: itemB } = await admin.from('inventory_items').insert({ brand_id: brandId, model: 'User B Item', status: 'owned', user_id: userBId }).select('id').single();
    createdItemIds.push(itemB!.id as number);
    const { data: listingB } = await admin.from('item_listings').insert({ user_id: userBId, inventory_item_id: itemB!.id, deal_channel_id: marketplaceId, status: 'active', listed_at: todayDateString(), asking_price: 9999 }).select('id').single();
    createdListingIds.push(listingB!.id as number);

    const { error: signInAErr } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (signInAErr) throw new Error(`Failed to sign in as user A: ${signInAErr.message}`);

    const { data: crossUserHistory } = await getItemListingPriceHistory(listingB!.id as number);
    check("D: user A cannot read user B's price history via RLS", (crossUserHistory ?? []).length === 0, crossUserHistory);

    await supabase.auth.signOut();
  } finally {
    console.log('\n[cleanup]');
    if (createdListingIds.length) await admin.from('item_listings').delete().in('id', createdListingIds);
    if (createdItemIds.length) await admin.from('inventory_items').delete().in('id', createdItemIds);

    const { data: remainingItems } = await admin.from('inventory_items').select('id').in('id', createdItemIds.length ? createdItemIds : [-1]);
    const { data: remainingHistory } = await admin.from('item_listing_price_history').select('id').in('item_listing_id', createdListingIds.length ? createdListingIds : [-1]);
    check('cleanup: every created inventory item was removed', (remainingItems?.length ?? 0) === 0, remainingItems);
    check('cleanup: price history rows cascade-deleted with their item_listings', (remainingHistory?.length ?? 0) === 0, remainingHistory);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
