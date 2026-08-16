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
  createSellOperation,
  createTradeOperation,
} from '../src/lib/supabase';
import { supabase } from '../src/lib/supabase';
import { validateStartDate, validateEndDate, todayDateString, formatPreviousCycleText, computeLastEndedAt } from '../src/components/AiAssistantCard';
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

  check('formatPreviousCycleText: ended today', formatPreviousCycleText(today) === 'Last listing ended today', formatPreviousCycleText(today));
  check('formatPreviousCycleText: ended yesterday', formatPreviousCycleText(yesterday) === 'Last listing ended yesterday', formatPreviousCycleText(yesterday));
  check('formatPreviousCycleText: ended 7 days ago', formatPreviousCycleText(lastWeek) === 'Last listing ended 7 days ago', formatPreviousCycleText(lastWeek));
  check('formatPreviousCycleText: ended 24 days ago', formatPreviousCycleText(daysFromToday(-24)) === 'Last listing ended 24 days ago', formatPreviousCycleText(daysFromToday(-24)));

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
  const createdDealIds: number[] = [];

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

  // B5 — computeLastEndedAt (the "previous listing cycle" note): cancelled
  // and draft rows never count, an ended row does, and it's found even
  // when a NEW active cycle exists for the same item+channel.
  {
    const itemId = await createTestItem();

    // A cancelled row with no ended_at at all — must never count.
    await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'cancelled', cancelled_at: new Date().toISOString() });
    // A draft row — must never count.
    await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: marketplaceId, status: 'draft' });

    const { data: rowsCancelledDraftOnly } = await serviceClient.from('item_listings').select('*').eq('inventory_item_id', itemId).eq('deal_channel_id', marketplaceId);
    check('B5: cancelled + draft rows only -> no previous cycle', computeLastEndedAt((rowsCancelledDraftOnly ?? []) as unknown as ItemListing[]) === null, rowsCancelledDraftOnly);

    // Separate channel (Kijiji) for the ended-cycle checks below, so this
    // doesn't collide with the still-open draft row left on Marketplace
    // above (the partial unique index allows only one draft/active row per
    // item+channel at a time).
    const { data: endedRow } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: kijijiId, status: 'active', listed_at: daysFromToday(-30) }).select('id').single();
    const day24Ago = daysFromToday(-24);
    await serviceClient.from('item_listings').update({ status: 'ended', ended_at: day24Ago }).eq('id', endedRow!.id);

    const { data: rowsWithEnded } = await serviceClient.from('item_listings').select('*').eq('inventory_item_id', itemId).eq('deal_channel_id', kijijiId);
    const lastEndedAfterEnd = computeLastEndedAt((rowsWithEnded ?? []) as unknown as ItemListing[]);
    check('B5: an ended row IS found as the previous cycle', lastEndedAfterEnd === day24Ago, { lastEndedAfterEnd, day24Ago });
    check('B5: formats as "Last listing ended 24 days ago"', formatPreviousCycleText(lastEndedAfterEnd!) === 'Last listing ended 24 days ago', formatPreviousCycleText(lastEndedAfterEnd!));

    // A brand-new active cycle on top (same channel) — the previous ended
    // cycle must still be found (it's independent of the current row).
    await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: kijijiId, status: 'active', listed_at: today });

    const { data: rowsWithActiveOnTop } = await serviceClient.from('item_listings').select('*').eq('inventory_item_id', itemId).eq('deal_channel_id', kijijiId);
    const rows = (rowsWithActiveOnTop ?? []) as unknown as ItemListing[];
    const currentRow = rows.find((r) => r.status === 'active');
    const lastEndedWithActive = computeLastEndedAt(rows);
    check('B5: previous ended cycle is still found while a NEW cycle is active', currentRow?.status === 'active' && lastEndedWithActive === day24Ago, { currentRow, lastEndedWithActive });
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
  // Section D — analytics_item_lifecycle + Pattern Discovery evidence:
  // multi-cycle listing metrics (20260829000000/20260830000000).
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[D — analytics_item_lifecycle: multi-cycle listing metrics, cancelled exclusion]');

  const day50Ago = daysFromToday(-50);
  const day40Ago = daysFromToday(-40);
  const day30Ago = daysFromToday(-30);
  const day5Ago = daysFromToday(-5);

  const dItemId = await createTestItem();

  // Marketplace: cancelled cycle (day-50, must be fully excluded), then an
  // ended cycle (day-40 -> day-30), then a currently-active cycle (day-5).
  const { data: cancelledRow } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: dItemId, deal_channel_id: marketplaceId, status: 'active', listed_at: day50Ago }).select('id').single();
  await serviceClient.from('item_listings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', cancelledRow!.id);

  const { data: endedRow } = await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: dItemId, deal_channel_id: marketplaceId, status: 'active', listed_at: day40Ago }).select('id').single();
  await serviceClient.from('item_listings').update({ status: 'ended', ended_at: day30Ago }).eq('id', endedRow!.id);

  await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: dItemId, deal_channel_id: marketplaceId, status: 'active', listed_at: day5Ago });

  // Kijiji: draft only — must never count as listed anywhere.
  await serviceClient.from('item_listings').insert({ user_id: userId, inventory_item_id: dItemId, deal_channel_id: kijijiId, status: 'draft' });

  const { data: lifecycleRow } = await serviceClient.from('analytics_item_lifecycle').select('*').eq('item_id', dItemId).maybeSingle();

  check('D1: marketplace_listed_at is the latest active/ended cycle (cancelled excluded)', lifecycleRow?.marketplace_listed_at === day5Ago, lifecycleRow);
  check('D2: marketplace_active_listed_at reflects the currently-active cycle', lifecycleRow?.marketplace_active_listed_at === day5Ago, lifecycleRow);
  check('D3: marketplace_current_listing_age_days === 5', lifecycleRow?.marketplace_current_listing_age_days === 5, lifecycleRow);
  check('D4: marketplace_listing_cycle_count === 2 (ended + active; cancelled excluded)', lifecycleRow?.marketplace_listing_cycle_count === 2, lifecycleRow);
  check('D5: marketplace_total_listed_days === 15 (10 ended + 5 active-to-date)', lifecycleRow?.marketplace_total_listed_days === 15, lifecycleRow);
  check('D6: kijiji_listed_at is NULL (draft-only never counts as listed)', lifecycleRow?.kijiji_listed_at === null, lifecycleRow);
  check('D7: kijiji_listing_cycle_count === 0', lifecycleRow?.kijiji_listing_cycle_count === 0, lifecycleRow);
  check(
    'D8: first_listed_at is the TRUE earliest active/ended cycle across ALL cycles — not derived from LEAST() of the per-platform latest-cycle columns',
    lifecycleRow?.first_listed_at === day40Ago,
    lifecycleRow,
  );
  check('D9: last_listed_at is the latest active/ended cycle', lifecycleRow?.last_listed_at === day5Ago, lifecycleRow);
  check('D10: listing_cycle_count (global) === 2', lifecycleRow?.listing_cycle_count === 2, lifecycleRow);
  check('D11: total_listed_days (global) === 15', lifecycleRow?.total_listed_days === 15, lifecycleRow);

  // Realize dItemId (acquisition + exit deal) so it's eligible for the
  // LISTING_PLATFORM family in _build_pattern_discovery_evidence_v2_13,
  // which reads item_listings directly (independent of the view fix
  // above) and must apply the same cancelled-exclusion rule.
  const { data: acqDeal } = await serviceClient.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: daysFromToday(-60), cash_paid: 50 }).select('id').single();
  createdDealIds.push(acqDeal!.id as number);
  await serviceClient.from('deal_items').insert({ user_id: userId, deal_id: acqDeal!.id, item_id: dItemId, direction: 'in', total_value: 50 });

  const exitDate = daysFromToday(-1);
  const { data: exitDeal } = await serviceClient.from('deals').insert({ user_id: userId, deal_type: 'sale', deal_date: exitDate, deal_channel_id: marketplaceId, cash_received: 150 }).select('id').single();
  createdDealIds.push(exitDeal!.id as number);
  await serviceClient.from('deal_items').insert({ user_id: userId, deal_id: exitDeal!.id, item_id: dItemId, direction: 'out', total_value: 150 });
  await serviceClient.from('inventory_items').update({ status: 'sold', sold_date: exitDate }).eq('id', dItemId);

  const { data: evidence, error: evidenceError } = await serviceClient.rpc('_build_pattern_discovery_evidence_v2_13', { p_target_user_id: userId });
  check('D12: pattern discovery evidence RPC succeeds for the target user', !evidenceError, evidenceError);
  const candidateSegments = ((evidence as { candidate_segments?: unknown[] } | null)?.candidate_segments ?? []) as Array<{
    family_code: string;
    segment: { listing_channel_id: number };
    median_days_on_market: number | null;
    realized_item_count: number;
  }>;
  const marketplaceSegment = candidateSegments.find((s) => s.family_code === 'LISTING_PLATFORM' && s.segment?.listing_channel_id === marketplaceId);
  check('D13: LISTING_PLATFORM evidence includes a Marketplace segment for this realized item', !!marketplaceSegment, candidateSegments);
  check(
    'D14: LISTING_PLATFORM median_days_on_market is computed from the ended cycle (day-40), not the earlier cancelled cycle (day-50) — 39 days to exit',
    marketplaceSegment?.median_days_on_market === 39,
    marketplaceSegment,
  );
  const kijijiSegment = candidateSegments.find((s) => s.family_code === 'LISTING_PLATFORM' && s.segment?.listing_channel_id === kijijiId);
  check('D15: no LISTING_PLATFORM segment for Kijiji (draft-only, never a real listing)', !kijijiSegment, kijijiSegment);

  // ══════════════════════════════════════════════════════════════════════
  // Section E — create_sell_operation / create_trade_operation close open
  // listings (20260831000000_close_listings_on_sale_trade.sql). Runs AFTER
  // Section D on purpose: it creates real realized (sold/traded) items for
  // this same test user, which would otherwise inflate Section D's
  // pattern-discovery counts (those assertions assume exactly the realized
  // items Section D itself set up).
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[E — sale/trade operations close open listings]');

  const { error: signInError2 } = await supabase.auth.signInWithPassword({ email: EMAIL, password: 'Test-Item-Listings-Local-Only-1!' });
  if (signInError2) throw new Error(`Failed to sign in as test user for Section E: ${signInError2.message}`);

  // E1 — Sale closes active listings on multiple platforms, with the sale's
  // own deal_date as ended_at.
  const e1ItemId = await createTestItem();
  {
    await startListing({ inventory_item_id: e1ItemId, deal_channel_id: marketplaceId, listed_at: lastWeek });
    await startListing({ inventory_item_id: e1ItemId, deal_channel_id: kijijiId, listed_at: lastWeek });

    const { data: sellResult, error: sellError } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [{ item_id: e1ItemId, total_value: 500 }],
      cfDescription: 'E1 test sale',
    });
    check('E1: create_sell_operation succeeds', !sellError && !!sellResult?.deal_id, { sellResult, sellError });
    if (sellResult?.deal_id) createdDealIds.push(sellResult.deal_id as number);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', e1ItemId).maybeSingle();
    check('E1: item becomes sold', itemAfter?.status === 'sold', itemAfter);

    const { data: listingsAfter } = await serviceClient.from('item_listings').select('deal_channel_id, status, ended_at').eq('inventory_item_id', e1ItemId);
    const allEnded = (listingsAfter ?? []).every((l) => l.status === 'ended' && l.ended_at === today);
    check('E1: every active listing (Marketplace + Kijiji) became ended with ended_at = sale date', allEnded && (listingsAfter?.length ?? 0) === 2, listingsAfter);
  }

  // E2 — Trade closes the OUTGOING item's active listing; the INCOMING
  // item's own (unrelated) active listing is left untouched.
  const e2OutItemId = await createTestItem();
  const e2InItemId = await createTestItem();
  {
    await serviceClient.from('inventory_items').update({ status: 'new' }).eq('id', e2InItemId);

    const { data: outListing } = await startListing({ inventory_item_id: e2OutItemId, deal_channel_id: marketplaceId, listed_at: lastWeek });
    // Incoming item already carries its own active listing (e.g. from a
    // previous ownership cycle) — trading it IN must never touch this row.
    const { data: inListing } = await serviceClient
      .from('item_listings')
      .insert({ user_id: userId, inventory_item_id: e2InItemId, deal_channel_id: kijijiId, status: 'active', listed_at: lastWeek })
      .select('id')
      .single();

    const { data: tradeResult, error: tradeError } = await createTradeOperation({
      dealDate: today,
      channelId: marketplaceId,
      outgoingItems: [{ item_id: e2OutItemId, total_value: 200 }],
      incomingItems: [{ item_id: e2InItemId, total_value: 200 }],
    });
    check('E2: create_trade_operation succeeds', !tradeError && !!tradeResult?.deal_id, { tradeResult, tradeError });
    if (tradeResult?.deal_id) createdDealIds.push(tradeResult.deal_id as number);

    const { data: outItemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', e2OutItemId).maybeSingle();
    const { data: inItemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', e2InItemId).maybeSingle();
    check('E2: outgoing item becomes traded', outItemAfter?.status === 'traded', outItemAfter);
    check('E2: incoming item becomes owned', inItemAfter?.status === 'owned', inItemAfter);

    const { data: outListingAfter } = await serviceClient.from('item_listings').select('status, ended_at').eq('id', outListing!.id).single();
    check('E2: outgoing item\'s active listing becomes ended with ended_at = trade date', outListingAfter?.status === 'ended' && outListingAfter?.ended_at === today, outListingAfter);

    const { data: inListingAfter } = await serviceClient.from('item_listings').select('status').eq('id', inListing!.id).single();
    check('E2: incoming item\'s own listing is left untouched (still active)', inListingAfter?.status === 'active', inListingAfter);
  }

  // E3 — Draft listings on an item that sells are cancelled, not left open
  // and not silently left as if still listed.
  const e3ItemId = await createTestItem();
  {
    const { data: draft } = await saveListingDraftText({
      inventory_item_id: e3ItemId,
      deal_channel_id:   marketplaceId,
      description:       'E3 draft text, never actually listed',
      is_ai_generated:   false,
    });
    check('E3: draft listing created (status draft, no listed_at)', draft?.status === 'draft', draft);

    const { data: sellResult, error: sellError } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [{ item_id: e3ItemId, total_value: 100 }],
      cfDescription: 'E3 test sale',
    });
    check('E3: create_sell_operation succeeds with only a draft listing present', !sellError && !!sellResult?.deal_id, { sellResult, sellError });
    if (sellResult?.deal_id) createdDealIds.push(sellResult.deal_id as number);

    const { data: draftAfter } = await serviceClient.from('item_listings').select('status, cancelled_at').eq('id', draft!.id).single();
    check('E3: the draft row becomes cancelled (not deleted) with cancelled_at set', draftAfter?.status === 'cancelled' && !!draftAfter?.cancelled_at, draftAfter);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', e3ItemId).maybeSingle();
    check('E3: item is sold, not stuck looking "listed"', itemAfter?.status === 'sold', itemAfter);
  }

  await supabase.auth.signOut();

  // ══════════════════════════════════════════════════════════════════════
  // Cleanup + verification
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[cleanup] Removing item_listings test fixtures...');

  if (createdDealIds.length > 0) {
    // cash_flow.deal_id has NO ACTION on delete (not cascade) — Section E's
    // create_sell_operation/create_trade_operation calls each insert a
    // cash_flow row, which would otherwise block deleting the deal.
    await serviceClient.from('cash_flow').delete().in('deal_id', createdDealIds);
    // ON DELETE CASCADE removes each deal's deal_items rows with it — must
    // run before deleting inventory_items, since deal_items.item_id has no
    // ON DELETE CASCADE back to inventory_items.
    await serviceClient.from('deals').delete().in('id', createdDealIds);
  }
  if (createdItemIds.length > 0) {
    // ON DELETE CASCADE removes each item's item_listings rows with it.
    await serviceClient.from('inventory_items').delete().in('id', createdItemIds);
  }
  await serviceClient.auth.admin.deleteUser(authUserId!);

  const { data: leftoverItems } = await serviceClient.from('inventory_items').select('id').in('id', createdItemIds.length > 0 ? createdItemIds : [-1]);
  const { data: leftoverListings } = await serviceClient.from('item_listings').select('id').in('inventory_item_id', createdItemIds.length > 0 ? createdItemIds : [-1]);
  const { data: leftoverDeals } = await serviceClient.from('deals').select('id').in('id', createdDealIds.length > 0 ? createdDealIds : [-1]);
  const { data: leftoverUser } = await serviceClient.from('app_users').select('id').eq('auth_user_id', authUserId!);

  check('cleanup: every created inventory item was removed', (leftoverItems?.length ?? 0) === 0, leftoverItems);
  check('cleanup: every created item_listings row was removed (cascaded)', (leftoverListings?.length ?? 0) === 0, leftoverListings);
  check('cleanup: every created deal was removed', (leftoverDeals?.length ?? 0) === 0, leftoverDeals);
  check('cleanup: the test user was removed', (leftoverUser?.length ?? 0) === 0, leftoverUser);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
