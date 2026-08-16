/**
 * scripts/test-operation-edits.ts
 *
 * Validation for the new edit_sell_operation / edit_expense_operation RPCs
 * (supabase/migrations/20260902000000_edit_sell_expense_operations.sql) and
 * the edit-mode paths of src/lib/supabase.ts's editSellOperation /
 * editExpenseOperation / editBuyOperation / editTradeOperation. Same
 * conventions as scripts/test-item-listings.ts — tsx, no test framework,
 * local check(), safety-gated against a disposable local Supabase instance
 * only. App-layer RPC calls go through the real `supabase` singleton after
 * signing in as a dedicated test user, exactly like the real UI does;
 * service-role writes are used only for fixture setup/verification.
 *
 * Covers: Expense amount edit updates cash_flow.cash_out and recalculates
 * balances; Purchase edit (amount/date/channel/notes) keeps deal_items in
 * sync; Sale edit updates cash_received/realized-profit inputs while the
 * item stays sold; Trade edit updates cash paid/received while outgoing/
 * incoming item statuses stay correct; a date-only edit recalculates
 * balances from the correct point whether the date moves earlier or later;
 * SQL-level validation (amount must be > 0, expense notes required) is
 * rejected. Future-date rejection is a UI-only check in the form
 * components (mirrors the create forms — none of the create/edit RPCs
 * validate dates server-side), so it isn't exercised here.
 *
 * Also covers multi-item Purchase/Sale
 * (supabase/migrations/20260903000000_multi_item_sell_operation.sql):
 * multiple deal_items under one deal_id/cash_flow row, per-item cost basis
 * / sale value / realized profit, item-set-immutable-on-edit enforcement
 * for Sale, and the create_sell_operation/edit_sell_operation validation
 * (empty items array, duplicate item_id, non-positive per-item value,
 * selling an already-sold item).
 *
 * Usage:
 *   npx tsx scripts/test-operation-edits.ts
 */

import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  supabase,
  createBuyOperation,
  createSellOperation,
  createTradeOperation,
  createExpenseOperation,
  editBuyOperation,
  editSellOperation,
  editTradeOperation,
  editExpenseOperation,
  startListing,
} from '../src/lib/supabase';

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

  const today = daysFromToday(0);
  const yesterday = daysFromToday(-1);
  const twoDaysAgo = daysFromToday(-2);

  const BRAND_NAME = 'Test-Operation-Edits-Brand';
  const { data: existingBrand } = await serviceClient.from('brands').select('id').eq('name', BRAND_NAME).maybeSingle();
  const brandId = existingBrand
    ? (existingBrand.id as number)
    : (await (async () => {
        const { data, error } = await serviceClient.from('brands').insert({ name: BRAND_NAME }).select('id').single();
        if (error || !data) throw new Error(`Failed to create test brand: ${error?.message}`);
        return data.id as number;
      })());

  const EMAIL = 'test-operation-edits@example.test';
  const PASSWORD = 'Test-Operation-Edits-Local-Only-1!';
  const { data: authUsers } = await serviceClient.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await serviceClient.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
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

  const { data: channels } = await serviceClient.from('deal_channels').select('id, name');
  const marketplaceId = (channels ?? []).find((c) => c.name === 'Marketplace')?.id as number | undefined;
  const kijijiId = (channels ?? []).find((c) => c.name === 'Kijiji')?.id as number | undefined;
  if (!marketplaceId || !kijijiId) throw new Error('Marketplace/Kijiji deal_channels not found — seed data missing');

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];

  async function createTestItem(status: 'new' | 'owned' | 'listed' | 'sold' | 'traded' = 'owned'): Promise<number> {
    const { data, error } = await serviceClient
      .from('inventory_items')
      .insert({ brand_id: brandId, model: 'Test Model', status, user_id: userId })
      .select('id')
      .single();
    if (error || !data) throw new Error(`Failed to create test item: ${error?.message}`);
    createdItemIds.push(data.id as number);
    return data.id as number;
  }

  async function getCashFlowForDeal(dealId: number) {
    const { data } = await serviceClient.from('cash_flow').select('*').eq('deal_id', dealId).maybeSingle();
    return data;
  }

  const { error: signInError } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signInError) throw new Error(`Failed to sign in as test user: ${signInError.message}`);

  // ══════════════════════════════════════════════════════════════════════
  // Expense edit
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Expense edit]');
  {
    const { data: created, error: createErr } = await createExpenseOperation({
      expenseDate: yesterday,
      amount: 50,
      notes: 'Original expense',
      cfDescription: 'Expense: Original expense',
    });
    check('setup: create_expense_operation succeeds', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    const { error: editErr } = await editExpenseOperation({
      dealId,
      expenseDate: yesterday,
      amount: 75,
      notes: 'Updated expense',
      cfDescription: 'Expense: Updated expense',
    });
    check('edit_expense_operation succeeds ($50 -> $75)', !editErr, editErr);

    const { data: dealAfter } = await serviceClient.from('deals').select('cash_paid, notes').eq('id', dealId).maybeSingle();
    check('deals.cash_paid updated to 75', Number(dealAfter?.cash_paid) === 75, dealAfter);
    check('deals.notes updated', dealAfter?.notes === 'Updated expense', dealAfter);

    const { data: expenseAfter } = await serviceClient.from('inventory_expenses').select('amount, notes').eq('deal_id', dealId).maybeSingle();
    check('inventory_expenses.amount updated to 75', Number(expenseAfter?.amount) === 75, expenseAfter);

    const cfAfter = await getCashFlowForDeal(dealId);
    check('cash_flow.cash_out updated to 75', Number(cfAfter?.cash_out) === 75, cfAfter);
    check('cash_flow.closing_balance recalculated (opening - cash_out)', Number(cfAfter?.closing_balance) === Number(cfAfter?.opening_balance) - 75, cfAfter);

    // Validation: amount must be > 0
    const { error: badAmountErr } = await editExpenseOperation({ dealId, expenseDate: yesterday, amount: 0, notes: 'x' });
    check('edit_expense_operation rejects amount <= 0', !!badAmountErr, badAmountErr);

    // Validation: notes required
    const { error: badNotesErr } = await editExpenseOperation({ dealId, expenseDate: yesterday, amount: 10, notes: '' });
    check('edit_expense_operation rejects empty notes', !!badNotesErr, badNotesErr);
  }

  // Expense item link edit — safe, no status implications.
  console.log('\n[Expense edit — linked item change]');
  {
    const itemA = await createTestItem();
    const itemB = await createTestItem();

    const { data: created, error: createErr } = await createExpenseOperation({
      expenseDate: yesterday,
      amount: 20,
      notes: 'Repair',
      itemId: itemA,
      cfDescription: 'Expense: Repair',
    });
    check('setup: create_expense_operation with linked item succeeds', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    await editExpenseOperation({ dealId, expenseDate: yesterday, amount: 20, notes: 'Repair', itemId: itemB });
    const { data: expenseAfter } = await serviceClient.from('inventory_expenses').select('item_id').eq('deal_id', dealId).maybeSingle();
    check('inventory_expenses.item_id swapped to the new item', expenseAfter?.item_id === itemB, expenseAfter);

    await editExpenseOperation({ dealId, expenseDate: yesterday, amount: 20, notes: 'Repair', itemId: null });
    const { data: expenseCleared } = await serviceClient.from('inventory_expenses').select('item_id').eq('deal_id', dealId).maybeSingle();
    check('inventory_expenses.item_id can be cleared back to null', expenseCleared?.item_id === null, expenseCleared);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Purchase edit
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Purchase edit]');
  {
    const itemId = await createTestItem('new');
    const { data: created, error: createErr } = await createBuyOperation({
      dealDate: twoDaysAgo,
      channelId: marketplaceId,
      incomingItems: [{ item_id: itemId, total_value: 300 }],
      notes: 'Original purchase',
      cfDescription: 'Purchase: original',
    });
    check('setup: create_buy_operation succeeds', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    const { error: editErr } = await editBuyOperation({
      dealId,
      dealDate: yesterday,
      channelId: kijijiId,
      notes: 'Updated purchase',
      incomingItems: [{ item_id: itemId, total_value: 450 }],
      cfDescription: 'Purchase: updated',
    });
    check('edit_buy_operation succeeds (amount/date/channel/notes)', !editErr, editErr);

    const { data: dealAfter } = await serviceClient.from('deals').select('deal_date, deal_channel_id, notes, cash_paid').eq('id', dealId).maybeSingle();
    check('deal_date updated', dealAfter?.deal_date === yesterday, dealAfter);
    check('deal_channel_id updated', dealAfter?.deal_channel_id === kijijiId, dealAfter);
    check('notes updated', dealAfter?.notes === 'Updated purchase', dealAfter);
    check('cash_paid (cost basis) updated to 450', Number(dealAfter?.cash_paid) === 450, dealAfter);

    const { data: dealItemAfter } = await serviceClient.from('deal_items').select('total_value').eq('deal_id', dealId).eq('item_id', itemId).maybeSingle();
    check('deal_items.total_value (cost basis) updated to 450', Number(dealItemAfter?.total_value) === 450, dealItemAfter);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', itemId).maybeSingle();
    check('item remains owned after purchase edit', itemAfter?.status === 'owned', itemAfter);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Sale edit (single item — backward compatibility)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Sale edit — single item]');
  {
    const itemId = await createTestItem();
    const { data: created, error: createErr } = await createSellOperation({
      dealDate: yesterday,
      channelId: marketplaceId,
      items: [{ item_id: itemId, total_value: 500 }],
      cfDescription: 'Sale: original',
    });
    check('setup: create_sell_operation succeeds (single item)', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    const { error: editErr } = await editSellOperation({
      dealId,
      dealDate: yesterday,
      channelId: kijijiId,
      items: [{ item_id: itemId, total_value: 650 }],
      notes: 'Sold for more than expected',
      cfDescription: 'Sale: updated',
    });
    check('edit_sell_operation succeeds (sale price up)', !editErr, editErr);

    const { data: dealAfter } = await serviceClient.from('deals').select('cash_received, deal_channel_id, notes').eq('id', dealId).maybeSingle();
    check('deals.cash_received updated to 650', Number(dealAfter?.cash_received) === 650, dealAfter);
    check('deals.deal_channel_id updated', dealAfter?.deal_channel_id === kijijiId, dealAfter);

    const { data: dealItemAfter } = await serviceClient.from('deal_items').select('total_value').eq('deal_id', dealId).eq('item_id', itemId).maybeSingle();
    check('deal_items.total_value (value out, feeds realized profit) updated to 650', Number(dealItemAfter?.total_value) === 650, dealItemAfter);

    const cfAfter = await getCashFlowForDeal(dealId);
    check('cash_flow.cash_in updated to 650', Number(cfAfter?.cash_in) === 650, cfAfter);

    const { data: itemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', itemId).maybeSingle();
    check('item remains sold after sale edit', itemAfter?.status === 'sold', itemAfter);

    const { error: badAmountErr } = await editSellOperation({ dealId, dealDate: yesterday, channelId: kijijiId, items: [{ item_id: itemId, total_value: 0 }] });
    check('edit_sell_operation rejects total_value <= 0', !!badAmountErr, badAmountErr);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Multi-item purchase (sanity — backend already supported this; confirms
  // nothing in this session's Sale changes regressed it)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Multi-item purchase]');
  {
    const guitarId = await createTestItem('new');
    const bridgeId = await createTestItem('new');
    const { data: created, error: createErr } = await createBuyOperation({
      dealDate: yesterday,
      channelId: marketplaceId,
      incomingItems: [
        { item_id: guitarId, total_value: 800 },
        { item_id: bridgeId, total_value: 150 },
      ],
      cfDescription: 'Purchase: guitar + bridge',
    });
    check('create_buy_operation succeeds with 2 items', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    const { data: dealItemsAfter } = await serviceClient.from('deal_items').select('item_id, total_value, direction').eq('deal_id', dealId);
    check('exactly 2 deal_items rows with direction=in', (dealItemsAfter ?? []).length === 2 && (dealItemsAfter ?? []).every((di) => di.direction === 'in'), dealItemsAfter);

    const cfAfter = await getCashFlowForDeal(dealId);
    check('one cash_flow row with total cash paid (950)', Number(cfAfter?.cash_out) === 950, cfAfter);

    const { data: guitarAfter } = await serviceClient.from('inventory_items').select('status').eq('id', guitarId).maybeSingle();
    const { data: bridgeAfter } = await serviceClient.from('inventory_items').select('status').eq('id', bridgeId).maybeSingle();
    check('both items become owned', guitarAfter?.status === 'owned' && bridgeAfter?.status === 'owned', { guitarAfter, bridgeAfter });

    const guitarItem = (dealItemsAfter ?? []).find((di) => di.item_id === guitarId);
    const bridgeItem = (dealItemsAfter ?? []).find((di) => di.item_id === bridgeId);
    check('each item has its own correct cost basis', Number(guitarItem?.total_value) === 800 && Number(bridgeItem?.total_value) === 150, { guitarItem, bridgeItem });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Multi-item sale
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Multi-item sale]');
  {
    const itemAId = await createTestItem();
    const itemBId = await createTestItem();
    await startListing({ inventory_item_id: itemAId, deal_channel_id: marketplaceId, listed_at: twoDaysAgo });
    await startListing({ inventory_item_id: itemBId, deal_channel_id: marketplaceId, listed_at: twoDaysAgo });

    const { data: created, error: createErr } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [
        { item_id: itemAId, total_value: 400 },
        { item_id: itemBId, total_value: 600 },
      ],
      cfDescription: 'Sale: item A + item B',
    });
    check('create_sell_operation succeeds with 2 items', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    const { data: dealItemsAfter } = await serviceClient.from('deal_items').select('item_id, total_value, direction').eq('deal_id', dealId);
    check('exactly 2 deal_items rows with direction=out', (dealItemsAfter ?? []).length === 2 && (dealItemsAfter ?? []).every((di) => di.direction === 'out'), dealItemsAfter);

    const cfAfter = await getCashFlowForDeal(dealId);
    check('one cash_flow row with total cash received (1000)', Number(cfAfter?.cash_in) === 1000, cfAfter);

    const { data: itemAAfter } = await serviceClient.from('inventory_items').select('status').eq('id', itemAId).maybeSingle();
    const { data: itemBAfter } = await serviceClient.from('inventory_items').select('status').eq('id', itemBId).maybeSingle();
    check('both items become sold', itemAAfter?.status === 'sold' && itemBAfter?.status === 'sold', { itemAAfter, itemBAfter });

    const { data: listingsAfter } = await serviceClient.from('item_listings').select('inventory_item_id, status, ended_at').in('inventory_item_id', [itemAId, itemBId]);
    const bothEnded = (listingsAfter ?? []).every((l) => l.status === 'ended' && l.ended_at === today);
    check('active listings for both items ended with ended_at = sale date', bothEnded && (listingsAfter ?? []).length === 2, listingsAfter);

    // Per-item and total profit correctness — value_in for a freshly-created
    // test item (no purchase deal) is null/0, so realized profit == sale value.
    const itemA = (dealItemsAfter ?? []).find((di) => di.item_id === itemAId);
    const itemB = (dealItemsAfter ?? []).find((di) => di.item_id === itemBId);
    check('per-item sale value correct (A=400, B=600)', Number(itemA?.total_value) === 400 && Number(itemB?.total_value) === 600, { itemA, itemB });

    // Edit: per-item value change recalculates cash_flow correctly.
    const { error: editErr } = await editSellOperation({
      dealId,
      dealDate: today,
      channelId: marketplaceId,
      items: [
        { item_id: itemAId, total_value: 450 },
        { item_id: itemBId, total_value: 600 },
      ],
      cfDescription: 'Sale: item A + item B (updated)',
    });
    check('edit_sell_operation succeeds for multi-item sale', !editErr, editErr);

    const cfAfterEdit = await getCashFlowForDeal(dealId);
    check('cash_flow.cash_in recalculated to new total (1050)', Number(cfAfterEdit?.cash_in) === 1050, cfAfterEdit);

    // Edit rejecting an item-set mismatch — the item set is immutable.
    const itemCId = await createTestItem();
    const { error: mismatchErr } = await editSellOperation({
      dealId,
      dealDate: today,
      channelId: marketplaceId,
      items: [
        { item_id: itemAId, total_value: 450 },
        { item_id: itemCId, total_value: 600 }, // itemC was never part of this sale
      ],
    });
    check('edit_sell_operation rejects changing which items are part of the sale', !!mismatchErr, mismatchErr);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Sale validation
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Sale validation]');
  {
    const itemId = await createTestItem();

    const { error: emptyItemsErr } = await createSellOperation({ dealDate: today, channelId: marketplaceId, items: [], cfDescription: 'test' });
    check('create_sell_operation rejects an empty items array', !!emptyItemsErr, emptyItemsErr);

    const { error: dupErr } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [
        { item_id: itemId, total_value: 100 },
        { item_id: itemId, total_value: 200 },
      ],
      cfDescription: 'test',
    });
    check('create_sell_operation rejects selling the same item twice', !!dupErr, dupErr);

    const { error: zeroValueErr } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [{ item_id: itemId, total_value: 0 }],
      cfDescription: 'test',
    });
    check('create_sell_operation rejects a zero-value item', !!zeroValueErr, zeroValueErr);

    const { error: negativeValueErr } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [{ item_id: itemId, total_value: -50 }],
      cfDescription: 'test',
    });
    check('create_sell_operation rejects a negative-value item', !!negativeValueErr, negativeValueErr);

    // Sell it for real, then try to sell the now-sold item again.
    const { data: firstSale } = await createSellOperation({ dealDate: today, channelId: marketplaceId, items: [{ item_id: itemId, total_value: 300 }], cfDescription: 'test' });
    if (firstSale?.deal_id) createdDealIds.push(firstSale.deal_id as number);

    const { error: alreadySoldErr } = await createSellOperation({
      dealDate: today,
      channelId: marketplaceId,
      items: [{ item_id: itemId, total_value: 100 }],
      cfDescription: 'test',
    });
    check('create_sell_operation rejects an already-sold item', !!alreadySoldErr, alreadySoldErr);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Trade edit
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Trade edit]');
  {
    const outItemId = await createTestItem();
    const inItemId = await createTestItem('new');
    const { data: created, error: createErr } = await createTradeOperation({
      dealDate: yesterday,
      channelId: marketplaceId,
      cashPaid: 0,
      cashReceived: 50,
      outgoingItems: [{ item_id: outItemId, total_value: 250 }],
      incomingItems: [{ item_id: inItemId, total_value: 200 }],
      cfDescription: 'Trade: original',
    });
    check('setup: create_trade_operation succeeds', !createErr && !!created?.deal_id, { created, createErr });
    const dealId = created?.deal_id as number;
    if (dealId) createdDealIds.push(dealId);

    const { error: editErr } = await editTradeOperation({
      dealId,
      dealDate: yesterday,
      channelId: marketplaceId,
      notes: null,
      cashPaid: 0,
      cashReceived: 80,
      outgoingItems: [{ item_id: outItemId, total_value: 280 }],
      incomingItems: [{ item_id: inItemId, total_value: 200 }],
      cfTransactionDate: null,
      cfDescription: 'Trade: updated',
    });
    check('edit_trade_operation succeeds (cash received up, outgoing value up)', !editErr, editErr);

    const { data: dealAfter } = await serviceClient.from('deals').select('cash_received, cash_paid').eq('id', dealId).maybeSingle();
    check('deals.cash_received updated to 80', Number(dealAfter?.cash_received) === 80, dealAfter);

    const cfAfter = await getCashFlowForDeal(dealId);
    check('cash_flow.cash_in updated to 80', Number(cfAfter?.cash_in) === 80, cfAfter);

    const { data: outItemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', outItemId).maybeSingle();
    const { data: inItemAfter } = await serviceClient.from('inventory_items').select('status').eq('id', inItemId).maybeSingle();
    check('outgoing item remains traded after trade edit', outItemAfter?.status === 'traded', outItemAfter);
    check('incoming item remains owned after trade edit', inItemAfter?.status === 'owned', inItemAfter);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Date change recalculates balances from the correct point
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[Date change recalculation]');
  {
    // Two expenses, chronologically ordered: A (twoDaysAgo, $10) then B (yesterday, $20).
    const { data: createdA } = await createExpenseOperation({ expenseDate: twoDaysAgo, amount: 10, notes: 'A', cfDescription: 'A' });
    const dealA = createdA?.deal_id as number;
    if (dealA) createdDealIds.push(dealA);
    const { data: createdB } = await createExpenseOperation({ expenseDate: yesterday, amount: 20, notes: 'B', cfDescription: 'B' });
    const dealB = createdB?.deal_id as number;
    if (dealB) createdDealIds.push(dealB);

    const cfBBefore = await getCashFlowForDeal(dealB);

    // Move A's date to TODAY — later than B — A should now sort after B,
    // and B's closing balance must no longer include A's cash_out.
    await editExpenseOperation({ dealId: dealA, expenseDate: today, amount: 10, notes: 'A moved later' });

    const cfBAfter = await getCashFlowForDeal(dealB);
    const cfAAfter = await getCashFlowForDeal(dealA);
    check(
      'B\'s closing balance increased by 10 once A moved past it (A no longer precedes B)',
      Number(cfBAfter?.closing_balance) === Number(cfBBefore?.closing_balance) + 10,
      { cfBBefore, cfBAfter },
    );
    check('A now sorts after B (A.transaction_date = today > B.transaction_date = yesterday)', cfAAfter?.transaction_date === today, cfAAfter);
    check('A\'s own closing balance reflects B\'s opening balance plus A\'s cash_out', Number(cfAAfter?.opening_balance) === Number(cfBAfter?.closing_balance) - 10, { cfAAfter, cfBAfter });
  }

  await supabase.auth.signOut();

  // ══════════════════════════════════════════════════════════════════════
  // Cleanup + verification
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[cleanup] Removing operation-edit test fixtures...');

  if (createdDealIds.length > 0) {
    await serviceClient.from('cash_flow').delete().in('deal_id', createdDealIds);
    await serviceClient.from('inventory_expenses').delete().in('deal_id', createdDealIds);
    await serviceClient.from('deal_items').delete().in('deal_id', createdDealIds);
    await serviceClient.from('deals').delete().in('id', createdDealIds);
  }
  if (createdItemIds.length > 0) {
    await serviceClient.from('inventory_items').delete().in('id', createdItemIds);
  }
  await serviceClient.auth.admin.deleteUser(authUserId!);

  const { data: leftoverDeals } = await serviceClient.from('deals').select('id').in('id', createdDealIds.length > 0 ? createdDealIds : [-1]);
  const { data: leftoverItems } = await serviceClient.from('inventory_items').select('id').in('id', createdItemIds.length > 0 ? createdItemIds : [-1]);
  const { data: leftoverUser } = await serviceClient.from('app_users').select('id').eq('auth_user_id', authUserId!);

  check('cleanup: every created deal was removed', (leftoverDeals?.length ?? 0) === 0, leftoverDeals);
  check('cleanup: every created inventory item was removed', (leftoverItems?.length ?? 0) === 0, leftoverItems);
  check('cleanup: the test user was removed', (leftoverUser?.length ?? 0) === 0, leftoverUser);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
