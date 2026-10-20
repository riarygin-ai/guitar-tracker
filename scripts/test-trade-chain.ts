/**
 * test-trade-chain.ts
 *
 * Focused validation for the Trade Chain full-capital-tree accounting fix
 * (src/lib/tradeChain.ts) — replaces the old single-item-lineage ROI/
 * "Running Profit" on src/app/inventory/[id]/chain/page.tsx, which
 * silently dropped sibling assets/cash created by multi-item trades.
 *
 * Section A is pure unit tests (no DB) against hand-built Deal/DealItem/
 * InventoryItem fixtures — buildCapitalChain never touches the database,
 * so this is the primary coverage. Section B is a DB-backed multi-user
 * isolation check (local Supabase only) confirming the underlying data
 * fetch (getItemLineage, unchanged by this task) still can't leak another
 * user's items into the tree. Same "no test framework, local check()"
 * convention as every other script here.
 *
 * Usage:
 *   npx tsx scripts/test-trade-chain.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  buildChainContext,
  findChainRootItemIds,
  computeMainLineageItemIds,
  buildCapitalChain,
  flattenTerminalNodes,
  type ChainNode,
} from '../src/lib/tradeChain';
import { supabase, getItemLineage } from '../src/lib/supabase';
import type { Deal, DealItem, InventoryItemWithValue, DealType, Direction, Status } from '../src/types';

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

// ── Synthetic fixture builders (pure, no DB) ─────────────────────────────

let nextDealId = 1;
let nextDealItemId = 1;

function makeDeal(type: DealType, cashPaid: number, cashReceived: number): Deal {
  return {
    id: nextDealId++,
    user_id: 1,
    deal_date: '2026-01-01',
    deal_type: type,
    deal_channel_id: null,
    cash_received: cashReceived,
    cash_paid: cashPaid,
    fees: 0,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function makeDealItem(dealId: number, itemId: number, direction: Direction, totalValue = 0): DealItem {
  return {
    id: nextDealItemId++,
    user_id: 1,
    deal_id: dealId,
    item_id: itemId,
    direction,
    total_value: totalValue,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function makeItem(id: number, status: Status, estimatedSoldValue: number | null): InventoryItemWithValue {
  return {
    id,
    user_id: 1,
    brand_id: 1,
    item_subtype_id: null,
    model: `Test Item ${id}`,
    serial_number: null,
    sold_date: null,
    estimated_sold_value: estimatedSoldValue,
    collection_type: null,
    purpose_id: null,
    condition: null,
    status,
    notes: null,
    year: null,
    color: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    value_in: null,
  };
}

function toItemsById(items: InventoryItemWithValue[]): Record<number, InventoryItemWithValue | undefined> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

function nodeFor(roots: ChainNode[], itemId: number): ChainNode | undefined {
  const found: ChainNode[] = [];
  const visit = (n: ChainNode) => {
    found.push(n);
    if (n.resolution.kind === 'traded') n.resolution.children.forEach(visit);
  };
  roots.forEach(visit);
  return found.find((n) => n.itemId === itemId);
}

async function main() {
  console.log('\n[A1 — single linear trade chain: purchase -> trade -> trade -> sale]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 1000, 0);
    const trade1 = makeDeal('trade', 0, 0);
    const trade2 = makeDeal('trade', 0, 0);
    const sale = makeDeal('sale', 0, 1600);

    const deals = [buy, trade1, trade2, sale];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(trade1.id, 1, 'out'),
      makeDealItem(trade1.id, 2, 'in'),
      makeDealItem(trade2.id, 2, 'out'),
      makeDealItem(trade2.id, 3, 'in'),
      makeDealItem(sale.id, 3, 'out'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'traded', null), makeItem(3, 'sold', null)];

    const result = buildCapitalChain({ startItemId: 3, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('root is item 1', JSON.stringify(result.rootItemIds) === '[1]', result.rootItemIds);
    check('totalInvested = 1000 (only the original purchase)', result.totalInvested === 1000, result.totalInvested);
    check('cashExtracted = 1600 (the final sale)', result.cashExtracted === 1600, result.cashExtracted);
    check('currentAssets = 0 (nothing held)', result.currentAssets === 0, result.currentAssets);
    check('profit = 600', result.profit === 600, result.profit);
    check('roi = 60%', result.roi === 60, result.roi);
  }

  console.log('\n[A2 — multi-item branching trade: one item out, several items in]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 2200, 0);
    const bigTrade = makeDeal('trade', 0, 0);

    const deals = [buy, bigTrade];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(bigTrade.id, 1, 'out'),
      makeDealItem(bigTrade.id, 2, 'in'),
      makeDealItem(bigTrade.id, 3, 'in'),
      makeDealItem(bigTrade.id, 4, 'in'),
    ];
    const items = [
      makeItem(1, 'traded', null),
      makeItem(2, 'owned', 500), // main lineage continues from here in a real UI, but for this test it's just held
      makeItem(3, 'owned', 200),
      makeItem(4, 'listed', 100),
    ];

    const result = buildCapitalChain({ startItemId: 2, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('root is item 1 even though we started the trace from sibling item 2', JSON.stringify(result.rootItemIds) === '[1]', result.rootItemIds);
    check('currentAssets sums ALL three siblings, not just item 2 (500+200+100=800)', result.currentAssets === 800, result.currentAssets);
    check('totalInvested = 2200', result.totalInvested === 2200, result.totalInvested);
    check('profit = 800 - 2200 = -1400', result.profit === -1400, result.profit);

    const flatTerminals = flattenTerminalNodes(result.roots);
    check('flattenTerminalNodes returns exactly the 3 sibling leaves', flatTerminals.length === 3 && flatTerminals.every((n) => [2, 3, 4].includes(n.itemId)), flatTerminals.map((n) => n.itemId));
  }

  console.log('\n[A3 — sibling item sold later]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 1000, 0);
    const trade = makeDeal('trade', 0, 0);
    const siblingSale = makeDeal('sale', 0, 350);

    const deals = [buy, trade, siblingSale];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(trade.id, 1, 'out'),
      makeDealItem(trade.id, 2, 'in'),
      makeDealItem(trade.id, 3, 'in'), // sibling, later sold
      makeDealItem(siblingSale.id, 3, 'out'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'owned', 400), makeItem(3, 'sold', 300)];

    const result = buildCapitalChain({ startItemId: 2, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    const soldSibling = nodeFor(result.roots, 3);
    check('sibling node resolves as sold', soldSibling?.resolution.kind === 'sold', soldSibling);
    check('sold sibling contributes its ACTUAL cash received (350), not its estimated_sold_value (300)', result.cashExtracted === 350, result.cashExtracted);
    check('currentAssets only counts the still-held sibling (400)', result.currentAssets === 400, result.currentAssets);
  }

  console.log('\n[A4 — sibling item traded again (multi-hop descendant)]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 1000, 0);
    const trade1 = makeDeal('trade', 0, 0);
    const trade2 = makeDeal('trade', 0, 0); // sibling traded again

    const deals = [buy, trade1, trade2];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(trade1.id, 1, 'out'),
      makeDealItem(trade1.id, 2, 'in'),
      makeDealItem(trade1.id, 3, 'in'), // sibling
      makeDealItem(trade2.id, 3, 'out'),
      makeDealItem(trade2.id, 4, 'in'), // grandchild via sibling's own further trade
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'owned', 400), makeItem(3, 'traded', null), makeItem(4, 'owned', 275)];

    const result = buildCapitalChain({ startItemId: 2, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('sibling grandchild (item 4) is reached and counted', result.currentAssets === 400 + 275, result.currentAssets);
    const flatTerminals = flattenTerminalNodes(result.roots);
    check('exactly 2 terminal leaves (2 and 4) — item 3 is intermediate, not terminal', flatTerminals.length === 2 && flatTerminals.every((n) => [2, 4].includes(n.itemId)));
  }

  console.log('\n[A5 — additional cash paid in a later trade]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 2200, 0);
    const trade1 = makeDeal('trade', 0, 0);
    const cashTopUpTrade = makeDeal('trade', 600, 0);

    const deals = [buy, trade1, cashTopUpTrade];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(trade1.id, 1, 'out'),
      makeDealItem(trade1.id, 2, 'in'),
      makeDealItem(cashTopUpTrade.id, 2, 'out'),
      makeDealItem(cashTopUpTrade.id, 3, 'in'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'traded', null), makeItem(3, 'owned', 1800)];

    const result = buildCapitalChain({ startItemId: 3, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('totalInvested = 2200 (root) + 600 (later cash top-up) = 2800', result.totalInvested === 2800, result.totalInvested);
  }

  console.log('\n[A6 — cash received in a trade (not just a sale)]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 3000, 0);
    const tradeWithCashBack = makeDeal('trade', 0, 1000);

    const deals = [buy, tradeWithCashBack];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(tradeWithCashBack.id, 1, 'out'),
      makeDealItem(tradeWithCashBack.id, 2, 'in'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'owned', 2000)];

    const result = buildCapitalChain({ startItemId: 2, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('cashExtracted = 1000 from the trade itself, not just from a sale deal', result.cashExtracted === 1000, result.cashExtracted);
    check('currentAssets = 2000', result.currentAssets === 2000);
    check('profit = (1000 + 2000) - 3000 = 0', result.profit === 0, result.profit);
  }

  console.log('\n[A7 — held/listed terminal descendants use estimated_sold_value]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 500, 0);
    const items = [makeItem(1, 'listed', 750)];
    const result = buildCapitalChain({
      startItemId: 1,
      deals: [buy],
      dealItems: [makeDealItem(buy.id, 1, 'in')],
      itemsById: toItemsById(items),
      expensesByItemId: {},
    });
    check('a root item that was never traded/sold is itself the sole held terminal', result.currentAssets === 750, result.currentAssets);
    check('profit = 750 - 500 = 250', result.profit === 250);
  }

  console.log('\n[A8 — expenses reduce profit and are summed across the whole tree]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 1000, 0);
    const trade = makeDeal('trade', 0, 0);
    const deals = [buy, trade];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(trade.id, 1, 'out'),
      makeDealItem(trade.id, 2, 'in'),
      makeDealItem(trade.id, 3, 'in'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'owned', 800), makeItem(3, 'owned', 200)];
    const expensesByItemId = { 1: 50, 2: 30, 3: 20 };

    const result = buildCapitalChain({ startItemId: 2, deals, dealItems, itemsById: toItemsById(items), expensesByItemId });
    check('expenses summed across every item in the tree (50+30+20=100)', result.expenses === 100, result.expenses);
    check('totalInvested includes expenses (1000 + 0 + 100 = 1100)', result.totalInvested === 1100, result.totalInvested);
    check('profit = (0 + 1000) - 1100 = -100', result.profit === -100, result.profit);
  }

  console.log('\n[A9 — no duplicate traversal/counting: two co-tracked items disposed together]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy1 = makeDeal('purchase', 500, 0);
    const buy2 = makeDeal('purchase', 300, 0);
    // Two SEPARATE purchases later bundled together into one outgoing trade leg.
    const mergeTrade = makeDeal('trade', 0, 400);
    const deals = [buy1, buy2, mergeTrade];
    const dealItems = [
      makeDealItem(buy1.id, 1, 'in'),
      makeDealItem(buy2.id, 2, 'in'),
      makeDealItem(mergeTrade.id, 1, 'out'),
      makeDealItem(mergeTrade.id, 2, 'out'),
      makeDealItem(mergeTrade.id, 3, 'in'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'traded', null), makeItem(3, 'owned', 900)];

    const result = buildCapitalChain({ startItemId: 3, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('both roots (1 and 2) are found', result.rootItemIds.sort().join(',') === '1,2', result.rootItemIds);
    check('totalInvested sums BOTH original purchases (500+300=800), not the merge deal double-counted', result.totalInvested === 800, result.totalInvested);
    check('cashExtracted from the merge trade is charged exactly ONCE (400), not once per co-disposed item (would be 800 if double-counted)', result.cashExtracted === 400, result.cashExtracted);
    check('item 3 is counted exactly once as a held terminal (900), not twice', result.currentAssets === 900, result.currentAssets);
    check('profit = (400 + 900) - 800 = 500', result.profit === 500, result.profit);
  }

  console.log('\n[A9b — no duplicate counting: shared purchase deal for two co-purchased items that both become roots]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const bundlePurchase = makeDeal('purchase', 700, 0); // one deal, cash_paid=700, buys BOTH item 1 and item 2
    const mergeTrade = makeDeal('trade', 0, 0);
    const deals = [bundlePurchase, mergeTrade];
    const dealItems = [
      makeDealItem(bundlePurchase.id, 1, 'in'),
      makeDealItem(bundlePurchase.id, 2, 'in'),
      makeDealItem(mergeTrade.id, 1, 'out'),
      makeDealItem(mergeTrade.id, 2, 'out'),
      makeDealItem(mergeTrade.id, 3, 'in'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'traded', null), makeItem(3, 'owned', 700)];

    const result = buildCapitalChain({ startItemId: 3, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    check('the single shared purchase deal is only charged once (700, not 1400)', result.totalInvested === 700, result.totalInvested);
  }

  console.log('\n[A10 — cycle / defensive protection with malformed data]');
  {
    nextDealId = 1; nextDealItemId = 1;
    // Malformed: item 1's disposal (trade X) produces item 2, and item 2's
    // disposal (trade Y) produces item 1 again — a cycle that should never
    // occur in real data but must not hang or crash the traversal.
    const tradeX = makeDeal('trade', 0, 0);
    const tradeY = makeDeal('trade', 0, 0);
    const deals = [tradeX, tradeY];
    const dealItems = [
      makeDealItem(tradeX.id, 1, 'out'),
      makeDealItem(tradeX.id, 2, 'in'),
      makeDealItem(tradeY.id, 2, 'out'),
      makeDealItem(tradeY.id, 1, 'in'),
    ];
    const items = [makeItem(1, 'traded', null), makeItem(2, 'traded', null)];

    let threw = false;
    let result;
    try {
      result = buildCapitalChain({ startItemId: 1, deals, dealItems, itemsById: toItemsById(items), expensesByItemId: {} });
    } catch {
      threw = true;
    }
    check('a cyclic graph does not throw or hang', !threw);
    if (result) {
      check('traversal terminates with a finite result', typeof result.profit === 'number' && Number.isFinite(result.profit), result.profit);
    }
  }

  console.log('\n[A11 — computeMainLineageItemIds still matches the original single-item-lineage algorithm]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 2200, 0);
    const trade1 = makeDeal('trade', 0, 0);
    const trade2 = makeDeal('trade', 0, 1000);
    const deals = [buy, trade1, trade2];
    const dealItems = [
      makeDealItem(buy.id, 1, 'in'),
      makeDealItem(trade1.id, 1, 'out'),
      makeDealItem(trade1.id, 2, 'in'),
      makeDealItem(trade1.id, 3, 'in'), // sibling — must be excluded from the linear lineage
      makeDealItem(trade2.id, 2, 'out'),
      makeDealItem(trade2.id, 4, 'in'),
    ];
    const ctx = buildChainContext(deals, dealItems);
    const lineage = computeMainLineageItemIds(4, ctx);
    const lineageArr = Array.from(lineage).sort((a, b) => a - b);
    check('linear lineage is exactly {1,2,4} — sibling item 3 excluded', lineageArr.join(',') === '1,2,4', lineageArr);
  }

  console.log('\n[A12 — findChainRootItemIds handles a normal single-root case]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const buy = makeDeal('purchase', 100, 0);
    const trade = makeDeal('trade', 0, 0);
    const deals = [buy, trade];
    const dealItems = [makeDealItem(buy.id, 1, 'in'), makeDealItem(trade.id, 1, 'out'), makeDealItem(trade.id, 2, 'in')];
    const ctx = buildChainContext(deals, dealItems);
    const roots = findChainRootItemIds(2, ctx);
    check('single root found', roots.length === 1 && roots[0] === 1, roots);
  }

  console.log('\n[A13 — historical import root contributes $0 real cash (no assigned-value substitution)]');
  {
    nextDealId = 1; nextDealItemId = 1;
    const historicalImport = makeDeal('Historical Import', 0, 0);
    const items = [makeItem(1, 'owned', 900)];
    const result = buildCapitalChain({
      startItemId: 1,
      deals: [historicalImport],
      dealItems: [makeDealItem(historicalImport.id, 1, 'in')],
      itemsById: toItemsById(items),
      expensesByItemId: {},
    });
    check('totalInvested is 0 for a historical-import root (no real cash outlay on record)', result.totalInvested === 0, result.totalInvested);
    check('roi is null when totalInvested is 0 (no divide-by-zero)', result.roi === null, result.roi);
  }

  console.log('\n[cleanup: none needed — Section A is pure logic, no DB rows created]');

  // ══════════════════════════════════════════════════════════════════════
  // Section B — multi-user isolation (local Supabase only). getItemLineage
  // itself is UNCHANGED by this task; this confirms the full-tree
  // accounting still can't be handed another user's data to aggregate,
  // since buildCapitalChain only ever operates on whatever getItemLineage
  // actually returns under RLS.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B — multi-user isolation]');
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  async function ensureTestUser(email: string, password: string): Promise<number> {
    const { data: authUsers } = await admin.auth.admin.listUsers();
    let authUserId = authUsers?.users.find((u) => u.email === email)?.id ?? null;
    if (!authUserId) {
      const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !created.user) throw new Error(`Failed to create test user ${email}: ${error?.message}`);
      authUserId = created.user.id;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
      if (data) return data.id as number;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`app_users row for ${email} never appeared`);
  }

  async function ensureBrand(name: string): Promise<number> {
    const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
    if (existing) return existing.id as number;
    const { data: created, error } = await admin.from('brands').insert({ name }).select('id').single();
    if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
    return created.id as number;
  }

  const brandId = await ensureBrand('Trade-Chain-Test-Brand');
  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];

  async function buildMiniChain(userId: number, marker: string): Promise<{ rootItemId: number; leafItemId: number }> {
    const { data: rootItem, error: rootErr } = await admin.from('inventory_items').insert({
      user_id: userId, brand_id: brandId, model: `Root ${marker}`, status: 'traded', serial_number: `CHAIN:${marker}:root`,
    }).select('id').single();
    if (rootErr) throw new Error(rootErr.message);
    createdItemIds.push(rootItem.id as number);

    const { data: leafItem, error: leafErr } = await admin.from('inventory_items').insert({
      user_id: userId, brand_id: brandId, model: `Leaf ${marker}`, status: 'owned', estimated_sold_value: 111, serial_number: `CHAIN:${marker}:leaf`,
    }).select('id').single();
    if (leafErr) throw new Error(leafErr.message);
    createdItemIds.push(leafItem.id as number);

    const { data: buyDeal, error: buyErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: '2026-01-01', cash_paid: 222, cash_received: 0 }).select('id').single();
    if (buyErr) throw new Error(buyErr.message);
    createdDealIds.push(buyDeal.id as number);
    await admin.from('deal_items').insert({ user_id: userId, deal_id: buyDeal.id, item_id: rootItem.id, direction: 'in', total_value: 222 });

    const { data: tradeDeal, error: tradeErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'trade', deal_date: '2026-01-02', cash_paid: 0, cash_received: 0 }).select('id').single();
    if (tradeErr) throw new Error(tradeErr.message);
    createdDealIds.push(tradeDeal.id as number);
    await admin.from('deal_items').insert([
      { user_id: userId, deal_id: tradeDeal.id, item_id: rootItem.id, direction: 'out', total_value: 111 },
      { user_id: userId, deal_id: tradeDeal.id, item_id: leafItem.id, direction: 'in', total_value: 111 },
    ]);

    return { rootItemId: rootItem.id as number, leafItemId: leafItem.id as number };
  }

  try {
    const userAId = await ensureTestUser('trade-chain-user-a@example.test', 'Trade-Chain-Fixture-Local-Only-1!');
    const userBId = await ensureTestUser('trade-chain-user-b@example.test', 'Trade-Chain-Fixture-Local-Only-1!');
    const chainA = await buildMiniChain(userAId, 'A');
    const chainB = await buildMiniChain(userBId, 'B');

    const { error: signInAErr } = await supabase.auth.signInWithPassword({ email: 'trade-chain-user-a@example.test', password: 'Trade-Chain-Fixture-Local-Only-1!' });
    if (signInAErr) throw new Error(`Failed to sign in as user A: ${signInAErr.message}`);

    const { data: dataA } = await getItemLineage(chainA.leafItemId);
    check('user A sees their own root item in their own chain', !!dataA?.inventoryItems.some((i) => i.id === chainA.rootItemId));
    check('user A sees their own leaf item in their own chain', !!dataA?.inventoryItems.some((i) => i.id === chainA.leafItemId));
    check("user A's chain never contains user B's root item id", !dataA?.inventoryItems.some((i) => i.id === chainB.rootItemId));
    check("user A's chain never contains user B's leaf item id", !dataA?.inventoryItems.some((i) => i.id === chainB.leafItemId));
    check("user A's chain never contains any of user B's deal ids", !dataA?.deals.some((d) => createdDealIds.slice(2).includes(d.id) && d.user_id === userBId));

    const resultA = buildCapitalChain({
      startItemId: chainA.leafItemId,
      deals: dataA?.deals ?? [],
      dealItems: dataA?.dealItems ?? [],
      itemsById: Object.fromEntries((dataA?.inventoryItems ?? []).map((i) => [i.id, i])),
      expensesByItemId: {},
    });
    check("user A's capital chain totalInvested reflects only their own $222 purchase", resultA.totalInvested === 222, resultA.totalInvested);

    // Attempting to view user B's item while authenticated as user A must
    // return nothing (RLS-blocked), not user B's real chain.
    const { data: crossAttempt } = await getItemLineage(chainB.leafItemId);
    check("user A directly requesting user B's item id gets an empty lineage, never user B's data", (crossAttempt?.inventoryItems.length ?? 0) === 0, crossAttempt);

    const { error: signInBErr } = await supabase.auth.signInWithPassword({ email: 'trade-chain-user-b@example.test', password: 'Trade-Chain-Fixture-Local-Only-1!' });
    if (signInBErr) throw new Error(`Failed to sign in as user B: ${signInBErr.message}`);

    const { data: dataB } = await getItemLineage(chainB.leafItemId);
    check('user B sees their own chain', !!dataB?.inventoryItems.some((i) => i.id === chainB.rootItemId));
    check("user B's chain never contains user A's items", !dataB?.inventoryItems.some((i) => i.id === chainA.rootItemId || i.id === chainA.leafItemId));

    await supabase.auth.signOut();
  } finally {
    console.log('\n[cleanup]');
    if (createdDealIds.length) {
      await admin.from('deal_items').delete().in('deal_id', createdDealIds);
      await admin.from('deals').delete().in('id', createdDealIds);
    }
    if (createdItemIds.length) await admin.from('inventory_items').delete().in('id', createdItemIds);

    const { data: remainingItems } = await admin.from('inventory_items').select('id').in('id', createdItemIds.length ? createdItemIds : [-1]);
    check('all fixture items deleted', (remainingItems?.length ?? 0) === 0, remainingItems);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
