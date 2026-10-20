// Server-callable Trade Chain for one inventory item — the data behind the
// read-only MCP get_deal_chain tool. Thin wrapper over the SAME
// implementation as /inventory/[id]/chain:
//   - graph loading: loadItemLineage (src/lib/itemLineageData.ts), the
//     traversal getItemLineage itself delegates to
//   - Item Lineage timeline + per-step / running profit:
//     computeMainLineageItemIds, buildLineageSteps, lineageStepProfit,
//     computeRunningProfits (src/lib/tradeChain.ts)
//   - Capital Summary (full capital tree, real cash only):
//     buildCapitalChain / flattenTerminalNodes (src/lib/tradeChain.ts)
// Nothing here re-derives chain math; it only serializes those results.
//
// Identity: the caller's own request-scoped client; deals / deal_items /
// inventory_expenses are RLS "own rows" and inventory_items_with_value
// filters on get_app_user_id(). A foreign or nonexistent item id returns
// null, indistinguishably.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InventoryItemWithValue } from '@/types';
import { loadItemLineage } from '../itemLineageData';
import {
  buildChainContext,
  buildCapitalChain,
  buildLineageSteps,
  computeMainLineageItemIds,
  computeRunningProfits,
  flattenTerminalNodes,
  lineageStepProfit,
  type ChainNode,
} from '../tradeChain';
import { OPERATION_TYPE_LABEL, dealCashImpact } from '../operations/operationFinancials';

export class DealChainServiceError extends Error {}

interface ChainItem {
  item_id: number;
  name: string;
  status: string | null;
}

export interface DealChainStep {
  deal_id: number;
  date: string;
  operation_type: string;
  operation_label: string;
  channel: string | null;
  /** Items disposed in this deal (deal_items 'out'), with assigned value. on_lineage=false marks a bundle sibling. */
  gave: (ChainItem & { value: number | null; on_lineage: boolean })[];
  /** Items acquired in this deal (deal_items 'in'), with assigned value. */
  received: (ChainItem & { value: number | null; on_lineage: boolean })[];
  cash_paid: number;
  cash_received: number;
  cash_impact: number;
  /** inventory_expenses of this step's OUTGOING lineage items (what the step profit subtracts). */
  lineage_item_expenses: number;
  /** Sell/Trade only: value out - value_in - expenses over outgoing LINEAGE items (the page's "Profit"). */
  step_profit: number | null;
  /** Cumulative step_profit (the page's "Running"). */
  running_profit: number;
  /** Lineage item ids this step produced (received items on the lineage). */
  resulting_item_ids: number[];
  notes: string | null;
}

export interface DealChainNode {
  item_id: number;
  name: string;
  acquired_in_deal_id: number | null;
  item_expenses: number;
  /** held | sold | traded | already_counted | cycle_detected | unresolved (tradeChain.ts ChainNodeResolution). */
  outcome: string;
  estimated_sold_value?: number;
  sale_deal_id?: number;
  cash_received?: number;
  trade_deal_id?: number;
  cash_paid?: number;
  children?: DealChainNode[];
}

export interface DealChainResult {
  item: ChainItem;
  definitions: Record<string, string>;
  lineage: {
    item_ids: number[];
    started_date: string | null;
    deal_count: number;
    final_running_profit: number;
    lineage_cash_impact: number;
    steps: DealChainStep[];
  };
  capital_summary: {
    root_item_ids: number[];
    started_date: string | null;
    total_invested: number;
    cash_extracted: number;
    current_assets: number;
    expenses: number;
    total_value_returned: number;
    profit: number;
    roi_percent: number | null;
  };
  capital_tree: DealChainNode[];
  /** Terminal held/sold items of the full tree that are NOT on this item's own lineage (multi-item trade siblings). */
  other_descendants: (ChainItem & { outcome: string })[];
  limitations: string[];
}

export const DEAL_CHAIN_DEFINITIONS: Record<string, string> = {
  lineage: 'The /inventory/[id]/chain "Item Lineage": this item\'s direct predecessor/successor path through trades only (bundle siblings excluded). Steps are chronological deals that directly involve a lineage item.',
  step_profit: 'Sell/Trade steps: assigned value out - value_in - item expenses over the step\'s outgoing lineage items. Trade value is assigned (non-cash). running_profit accumulates it.',
  lineage_cash_impact: 'Sum of each lineage step\'s cash impact (Sell +cash_received, Buy -cash_paid, Trade received - paid). Uses each step\'s full deal cash.',
  capital_summary: 'The chain page "Capital Summary": every deal and descendant item reachable from the chain\'s root acquisition(s), real cash only. total_invested = root purchase cash + every later trade cash_paid + expenses; cash_extracted = every cash_received (once per deal); current_assets = estimated_sold_value of still-held descendants; profit = cash_extracted + current_assets - total_invested; roi_percent = profit / total_invested.',
};

function itemName(it: InventoryItemWithValue | undefined, brandNames: Map<number, string>, itemId: number): string {
  if (!it) return `Item #${itemId}`;
  const base = [it.year, brandNames.get(it.brand_id), it.model].filter((p) => p != null && p !== '').join(' ');
  return `${base || `Item #${itemId}`}${it.color ? ` (${it.color})` : ''}`;
}

/** The chain for one of the caller's items, or null when the item doesn't exist OR isn't theirs. */
export async function getDealChainForUser(client: SupabaseClient, itemId: number): Promise<DealChainResult | null> {
  if (!Number.isInteger(itemId) || itemId <= 0) return null;

  const { data: own, error: ownError } = await client.from('inventory_items_with_value').select('id').eq('id', itemId).maybeSingle();
  if (ownError) throw new DealChainServiceError(`item lookup: ${ownError.message}`);
  if (!own) return null;

  const { data, error } = await loadItemLineage(client, itemId);
  if (error || !data) throw new DealChainServiceError(`lineage: ${error}`);

  const chainItemIds = Array.from(new Set([itemId, ...data.inventoryItems.map((i) => i.id)]));
  const [expRes, channelsRes] = await Promise.all([
    client.from('inventory_expenses').select('item_id, amount').in('item_id', chainItemIds),
    client.from('deal_channels').select('id, name'),
  ]);
  if (expRes.error) throw new DealChainServiceError(`expenses: ${expRes.error.message}`);
  if (channelsRes.error) throw new DealChainServiceError(`channels: ${channelsRes.error.message}`);

  const expensesByItemId: Record<number, number> = {};
  for (const e of (expRes.data ?? []) as { item_id: number; amount: number }[]) {
    expensesByItemId[e.item_id] = (expensesByItemId[e.item_id] ?? 0) + Number(e.amount);
  }
  const channelNames = new Map<number, string>((channelsRes.data ?? []).map((c) => [c.id as number, c.name as string]));
  const brandNames = new Map<number, string>(data.brands.map((b) => [b.id, b.name]));
  const itemMap: Record<number, InventoryItemWithValue> = Object.fromEntries(data.inventoryItems.map((i) => [i.id, i]));
  const chainItem = (id: number): ChainItem => ({ item_id: id, name: itemName(itemMap[id], brandNames, id), status: itemMap[id]?.status ?? null });

  // Same calls, same order, as the chain page.
  const ctx = buildChainContext(data.deals, data.dealItems);
  const mainItemIds = computeMainLineageItemIds(itemId, ctx);
  const steps = buildLineageSteps(data.deals, data.dealItems, mainItemIds);
  const running = computeRunningProfits(steps, mainItemIds, itemMap, expensesByItemId);
  const capital = buildCapitalChain({ startItemId: itemId, deals: data.deals, dealItems: data.dealItems, itemsById: itemMap, expensesByItemId });
  const startedDate = capital.rootItemIds
    .map((id) => ctx.acqDealByItemId[id])
    .filter((dealId): dealId is number => dealId !== undefined)
    .map((dealId) => ctx.dealById[dealId]?.deal_date)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;

  const outSteps: DealChainStep[] = steps.map((step, i) => ({
    deal_id: step.deal.id,
    date: step.deal.deal_date,
    operation_type: step.deal.deal_type,
    operation_label: OPERATION_TYPE_LABEL[step.deal.deal_type] ?? step.deal.deal_type,
    channel: step.deal.deal_channel_id != null ? channelNames.get(step.deal.deal_channel_id) ?? null : null,
    gave: step.outgoing.map((di) => ({ ...chainItem(di.item_id), value: di.total_value == null ? null : Number(di.total_value), on_lineage: mainItemIds.has(di.item_id) })),
    received: step.incoming.map((di) => ({ ...chainItem(di.item_id), value: di.total_value == null ? null : Number(di.total_value), on_lineage: mainItemIds.has(di.item_id) })),
    cash_paid: Number(step.deal.cash_paid ?? 0),
    cash_received: Number(step.deal.cash_received ?? 0),
    cash_impact: dealCashImpact({ deal_type: step.deal.deal_type, cash_paid: num(step.deal.cash_paid), cash_received: num(step.deal.cash_received) }),
    lineage_item_expenses: step.outgoing.filter((di) => mainItemIds.has(di.item_id)).reduce((s, di) => s + (expensesByItemId[di.item_id] ?? 0), 0),
    step_profit: lineageStepProfit(step, mainItemIds, itemMap, expensesByItemId),
    running_profit: running[i],
    resulting_item_ids: step.incoming.filter((di) => mainItemIds.has(di.item_id)).map((di) => di.item_id),
    notes: step.deal.notes,
  }));

  const serialize = (node: ChainNode): DealChainNode => {
    const base: DealChainNode = { item_id: node.itemId, name: itemName(itemMap[node.itemId], brandNames, node.itemId), acquired_in_deal_id: node.acquisitionDealId, item_expenses: node.expenses, outcome: node.resolution.kind };
    const r = node.resolution;
    if (r.kind === 'held') base.estimated_sold_value = r.estimatedSoldValue;
    if (r.kind === 'sold') { base.sale_deal_id = r.saleDealId; base.cash_received = r.cashReceived; }
    if (r.kind === 'traded') { base.trade_deal_id = r.tradeDealId; base.cash_paid = r.cashPaid; base.cash_received = r.cashReceived; base.children = r.children.map(serialize); }
    return base;
  };

  const limitations: string[] = [];
  if (data.deals.length > 0 && steps.length === 0) limitations.push('No deal directly involves this item\'s lineage.');
  const hasUnresolved = (n: ChainNode): boolean =>
    n.resolution.kind === 'unresolved' || (n.resolution.kind === 'traded' && n.resolution.children.some(hasUnresolved));
  if (capital.roots.some(hasUnresolved)) {
    limitations.push('Some chain items have no resolvable outcome (status and deal records disagree); they contribute nothing to capital totals.');
  }
  limitations.push('Graph loading stops after 10 traversal rounds (same cap as the chain page); extremely long chains may be truncated.');

  return {
    item: chainItem(itemId),
    definitions: DEAL_CHAIN_DEFINITIONS,
    lineage: {
      item_ids: Array.from(mainItemIds).sort((a, b) => a - b),
      started_date: steps[0]?.deal.deal_date ?? null,
      deal_count: steps.length,
      final_running_profit: running.length > 0 ? running[running.length - 1] : 0,
      lineage_cash_impact: outSteps.reduce((s, st) => s + st.cash_impact, 0),
      steps: outSteps,
    },
    capital_summary: {
      root_item_ids: capital.rootItemIds,
      started_date: startedDate,
      total_invested: capital.totalInvested,
      cash_extracted: capital.cashExtracted,
      current_assets: capital.currentAssets,
      expenses: capital.expenses,
      total_value_returned: capital.totalValueReturned,
      profit: capital.profit,
      roi_percent: capital.roi == null ? null : Math.round(capital.roi * 100) / 100,
    },
    capital_tree: capital.roots.map(serialize),
    other_descendants: flattenTerminalNodes(capital.roots)
      .filter((n) => !mainItemIds.has(n.itemId))
      .map((n) => ({ ...chainItem(n.itemId), outcome: n.resolution.kind })),
    limitations,
  };
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}
