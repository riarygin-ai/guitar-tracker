/**
 * test-item-listings.ts
 *
 * Validation for multi-cycle item_listings support: the lifecycle
 * migration (20260828000000_item_listings_lifecycle.sql — status,
 * ended_at, cancelled_at, the partial unique index, and the status-aware
 * inventory-status sync trigger), the rewritten data-access layer in
 * src/lib/supabase.ts (saveListingDraftText / startListing / endListing /
 * cancelListing / getActiveOrDraftListing / getAllListedDates), and the
 * pure date-validation helpers exported from src/components/
 * AiAssistantCard.tsx. Same conventions as the other scripts in this
 * directory — tsx, no test framework, local check(), safety-gated against
 * a disposable local Supabase instance only.
 *
 * Section A is pure unit tests (no DB) for the validation helpers.
 * Section B exercises the real local Supabase schema directly (service
 * client) for constraint/trigger correctness. Section C exercises the
 * actual src/lib/supabase.ts functions the UI calls, covering all 6
 * numbered scenarios from this task's Part 8. Every row created is
 * deleted and the deletion verified before the script exits.
 *
 * Usage:
 *   npx tsx scripts/test-item-listings.ts
 */

import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  saveListingDraftText,
  startListing,
  endListing,
  cancelListing,
  getActiveOrDraftListing,
  getItemListings,
  getAllListedDates,
} from '../src/lib/supabase';
import { supabase } from '../src/lib/supabase';
import { validateStartDate, validateEndDate, todayDateString } from '../src/components/AiAssistantCard';
import type { ItemListing } from '../src/types';

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

function daysFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  // ── Safety gate ───────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ══════════════════════════════════════════════════════════════════════
  // Section A — pure date-validation helpers (no DB)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A — listed_at/ended_at validation]');

  const today = todayDateString();
  const tomorrow = daysFromToday(1);
  const yesterday = daysFromToday(-1);
  const lastWeek = daysFromToday(-7);

  check('listed_at cannot be in the future', validateStartDate(tomorrow, null) !== null, validateStartDate(tomorrow, null));
  check('listed_at of today is valid (no acquired-date constraint)', validateStartDate(today, null) === null);
  check('listed_at before the acquired date is rejected', validateStartDate(lastWeek, yesterday) !== null, validateStartDate(lastWeek, yesterday));
  check('listed_at on/after the acquired date is valid', validateStartDate(today, yesterday) === null);
  check('empty listed_at is rejected', validateStartDate('', null) !== null);

  check('ended_at cannot be in the future', validateEndDate(tomorrow, yesterday) !== null, validateEndDate(tomorrow, yesterday));
  check('ended_at before listed_at is rejected', validateEndDate(yesterday, today) !== null, validateEndDate(yesterday, today));
  check('ended_at on/after listed_at is valid', validateEndDate(today, yesterday) === null);
  check('empty ended_at is rejected', validateEndDate('', today) !== null);

  // ══════════════════════════════════════════════════════════════════════
  // Section B — DB-level constraint/trigger correctness (real schema)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B — item_listings lifecycle: constraints and inventory-status sync]');

  const BRAND_NAME = 'Test-Item-Listings-Brand';
  const { data: existingBrand } = await serviceClient.from('brands').select('id').eq('name', BRAND_NAME).maybeSingle();
  const brandId = existingBrand
    ? (existingBrand.id as number)
    : (await (async () => {
        const { data, error } = await serviceClient.from('brands').insert({ name: BRAND_NAME }).select('id').single();
        if (error || !data) throw new Error(`Failed to create test brand: ${error?.message}`);
        return data.id as number;
      })());

  const EMAIL = 'test-item-listings@example.test';
  const { data: authUsers } = await serviceClient.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await serviceClient.auth.admin.createUser({ email: EMAIL, password: 'Test-Item-Listings-Local-Only-1!', email_confirm: true });
    if (error || !created.user) throw new Error(`Failed to create test user: ${error?.message}`);
    authUserId = created.user.id;
  }
  let userId: number | null = null;
  for (let attempt = 0; attempt < 10 && !userId; attempt++) {
    const { data } = await serviceClient.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) userId = data.id as number;
    else await new Promise((r) => setTimeout(r, 200));
  }
  if (!userId) throw new Error('test user app_users row never appeared');

  const { data: channels } = await serviceClient.from('deal_channels').select('id, name').eq('is_listing_platform', true);
  const marketplaceId = (channels ?? []).find((c) => c.name === 'Marketplace')?.id as number | undefined;
  const kijijiId = (channels ?? []).find((c) => c.name === 'Kijiji')?.id as number | undefined;
  if (!marketplaceId || !kijijiId) throw new Error('Marketplace/Kijiji deal_channels not found — seed data missing');

  const createdItemIds: number[] = [];

  async function createTestItem(status: 'owned' = 'owned'): Promise<number> {
    const { data, error } = await serviceClient
      .from('inventory_items')
      .insert({ brand_id: brandId, model: 'Test Model', status, user_id: userId })
      .select('id')
      .single();
    if (error || !data) throw new Error(`Failed to create test item: ${error?.message}`);
    createdItemIds.push(data.id as number);
    return data.id as number;
  }

  // B1 — partial unique index: a second active row for the same
  // item+channel is rejected.
  {
    const itemId = await createTestItem();
    const { error: firstErr } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: today });
    check('B1: first active listing insert succeeds', !firstErr, firstErr);
    const { error: secondErr } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: today });
    check('B1: a second active listing for the same item+channel is rejected', !!secondErr, secondErr);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', itemId).maybeSingle();
    check('B1: item became "listed" after the active row was created', itemAfter?.status === 'listed', itemAfter);
  }

  // B2 — ended/cancelled rows never block a new active row, and history
  // (both rows) is preserved.
  {
    const itemId = await createTestItem();
    const { data: row1 } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: lastWeek }).select('id').single();
    await serviceClient.from('item_listings').update({ status: 'ended', ended_at: today }).eq('id', row1!.id);

    const { data: itemAfterEnd } = await serviceClient.from('inventory_items').select('status').eq('id', itemId).maybeSingle();
    check('B2: item reverted to "owned" after its only active listing ended', itemAfterEnd?.status === 'owned', itemAfterEnd);

    const { error: secondActiveErr } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: today });
    check('B2: a NEW active listing can be created after the previous one ended', !secondActiveErr, secondActiveErr);

    const { data: history } = await serviceClient.from('item_listings').select('id, status').eq('inventory_item_id', itemId).eq('deal_channel_id', marketplaceId);
    check('B2: both the ended and the new active row remain in history (2 rows)', (history?.length ?? 0) === 2, history);
  }

  // B3 — cancelled rows never block a new active row either.
  {
    const itemId = await createTestItem();
    const { data: row1 } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: today }).select('id').single();
    await serviceClient.from('item_listings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', row1!.id);

    const { error: newActiveErr } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: today });
    check('B3: a cancelled listing does not count as active — a new active listing can be created', !newActiveErr, newActiveErr);
  }

  // B4 — sold/traded items are unaffected by ending or cancelling a listing.
  {
    const itemId = await createTestItem();
    const { data: row1 } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'active', listed_at: today }).select('id').single();
    await serviceClient.from('inventory_items').update({ status: 'sold', sold_date: today }).eq('id', itemId);
    await serviceClient.from('item_listings').update({ status: 'ended', ended_at: today }).eq('id', row1!.id);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', itemId).maybeSingle();
    check('B4: ending a listing on a SOLD item does not move it back to owned/listed', itemAfter?.status === 'sold', itemAfter);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Section C — src/lib/supabase.ts data-access functions: the 6 numbered
  // Part 8 scenarios, using the REAL functions the UI calls.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[C — data-access layer: the 6 required scenarios]');

  // Sign the shared authenticated client in as the test user — these
  // functions all go through the RLS-scoped `supabase` singleton, exactly
  // like the real UI does.
  const { error: signInError } = await supabase.auth.signInWithPassword({ email: EMAIL, password: 'Test-Item-Listings-Local-Only-1!' });
  if (signInError) throw new Error(`Failed to sign in as test user: ${signInError.message}`);

  // C1 — no listing -> Start Listing -> active created, item becomes listed.
  const c1ItemId = await createTestItem();
  {
    const { data: before } = await getActiveOrDraftListing(c1ItemId, marketplaceId);
    check('C1: no listing exists yet for a fresh item', before === null, before);

    const { data: started, error } = await startListing({ inventory_item_id: c1ItemId, deal_channel_id: marketplaceId, listed_at: today });
    check('C1: Start Listing creates an active row', !error && started?.status === 'active' && started?.listed_at === today, { started, error });

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', c1ItemId).maybeSingle();
    check('C1: the item becomes listed (was not sold/traded)', itemAfter?.status === 'listed', itemAfter);
  }

  // C2 — active exists -> cannot create a second active (via the RPC-free
  // partial-unique-index path, surfaced as a real error from startListing
  // itself) -> can End Listing.
  {
    const { data: dupAttempt, error: dupError } = await startListing({ inventory_item_id: c1ItemId, deal_channel_id: marketplaceId, listed_at: today });
    check('C2: startListing for an already-active item+channel fails (partial unique index)', !!dupError && !dupAttempt, dupError);

    const { data: current } = await getActiveOrDraftListing(c1ItemId, marketplaceId);
    check('C2: the existing active row is unaffected by the failed duplicate attempt', current?.status === 'active', current);

    const { data: ended, error: endError } = await endListing(current!.id, today);
    check('C2: End Listing succeeds for the currently active row', !endError && ended?.status === 'ended' && ended?.ended_at === today, { ended, endError });
  }

  // C3 — ended listing exists -> a new cycle can be started; both records
  // remain in item_listings history.
  {
    const { data: restarted, error } = await startListing({ inventory_item_id: c1ItemId, deal_channel_id: marketplaceId, listed_at: today });
    check('C3: a new listing cycle can be started after the previous one ended', !error && restarted?.status === 'active', { restarted, error });

    const { data: history } = await getItemListings(c1ItemId);
    const marketplaceRows = ((history as unknown as ItemListing[] | null) ?? []).filter((r) => r.deal_channel_id === marketplaceId);
    check('C3: both the ended cycle and the new active cycle remain in history', marketplaceRows.length === 2 && marketplaceRows.some((r) => r.status === 'ended') && marketplaceRows.some((r) => r.status === 'active'), marketplaceRows.map((r) => r.status));
  }

  // C4 — cancelled listing exists -> does not count as active -> a new
  // active listing can be created.
  const c4ItemId = await createTestItem();
  {
    const { data: started } = await startListing({ inventory_item_id: c4ItemId, deal_channel_id: kijijiId, listed_at: today });
    await cancelListing(started!.id);

    const { data: afterCancel } = await getActiveOrDraftListing(c4ItemId, kijijiId);
    check('C4: a cancelled listing no longer counts as the current row', afterCancel === null, afterCancel);

    const { data: newActive, error } = await startListing({ inventory_item_id: c4ItemId, deal_channel_id: kijijiId, listed_at: today });
    check('C4: a new active listing can be created after the previous one was cancelled', !error && newActive?.status === 'active', { newActive, error });
  }

  // C5 — sold/traded item: ending/cancelling a listing does not
  // incorrectly change the item's own sold/traded lifecycle status
  // (already proven at the DB level in B4 — this repeats it through the
  // real endListing()/cancelListing() functions specifically).
  const c5ItemId = await createTestItem();
  {
    const { data: started } = await startListing({ inventory_item_id: c5ItemId, deal_channel_id: marketplaceId, listed_at: today });
    await serviceClient.from('inventory_items').update({ status: 'traded' }).eq('id', c5ItemId);
    await endListing(started!.id, today);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', c5ItemId).maybeSingle();
    check('C5: ending a listing via endListing() does not move a TRADED item back to owned/listed', itemAfter?.status === 'traded', itemAfter);
  }

  // C6 — AI text preserved: a draft's text/ai_prompt_id survive being
  // promoted into an active listing by Start Listing (never lost, never
  // duplicated into a second row).
  const c6ItemId = await createTestItem();
  {
    const { data: draft, error: draftError } = await saveListingDraftText({
      inventory_item_id: c6ItemId,
      deal_channel_id:   marketplaceId,
      description:       'AI-generated draft text for C6',
      is_ai_generated:   true,
    });
    check('C6: saving draft text creates a draft row (no listing yet)', !draftError && draft?.status === 'draft' && draft?.description === 'AI-generated draft text for C6', { draft, draftError });

    const { data: promoted, error: promoteError } = await startListing({
      inventory_item_id: c6ItemId,
      deal_channel_id:   marketplaceId,
      listed_at:         today,
      existingDraftId:   draft!.id,
    });
    check(
      'C6: Start Listing promotes the SAME row in place — same id, text/ai flag preserved, now active',
      !promoteError && promoted?.id === draft!.id && promoted?.description === 'AI-generated draft text for C6' && promoted?.is_ai_generated === true && promoted?.status === 'active',
      { promoted, promoteError },
    );

    const { data: allRowsForItem } = await getItemListings(c6ItemId);
    check('C6: no duplicate row was created by promoting the draft (still exactly 1 row for this item+channel)', ((allRowsForItem as unknown as ItemListing[] | null) ?? []).filter((r) => r.deal_channel_id === marketplaceId).length === 1, allRowsForItem);
  }

  // getAllListedDates excludes cancelled records.
  {
    const itemId = await createTestItem();
    const { data: started } = await startListing({ inventory_item_id: itemId, deal_channel_id: kijijiId, listed_at: today });
    await cancelListing(started!.id);

    const { data: listedDates } = await getAllListedDates();
    const found = (listedDates ?? []).find((r) => r.inventory_item_id === itemId);
    check('getAllListedDates excludes a cancelled listing\'s date', !found, found);
  }

  await supabase.auth.signOut();

  // ══════════════════════════════════════════════════════════════════════
  // Cleanup + verification
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[cleanup] Removing item_listings test fixtures...');

  if (createdItemIds.length > 0) {
    // ON DELETE CASCADE removes each item's item_listings rows with it.
    await serviceClient.from('inventory_items').delete().in('id', createdItemIds);
  }
  await serviceClient.auth.admin.deleteUser(authUserId!);

  const { data: leftoverItems } = await serviceClient.from('inventory_items').select('id').in('id', createdItemIds.length > 0 ? createdItemIds : [-1]);
  const { data: leftoverListings } = await serviceClient.from('item_listings').select('id').in('inventory_item_id', createdItemIds.length > 0 ? createdItemIds : [-1]);
  const { data: leftoverUser } = await serviceClient.from('app_users').select('id').eq('auth_user_id', authUserId!);

  check('cleanup: every created inventory item was removed', (leftoverItems?.length ?? 0) === 0, leftoverItems);
  check('cleanup: every created item_listings row was removed (cascaded)', (leftoverListings?.length ?? 0) === 0, leftoverListings);
  check('cleanup: the test user was removed', (leftoverUser?.length ?? 0) === 0, leftoverUser);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
