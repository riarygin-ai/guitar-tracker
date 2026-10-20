// Trade Chain accounting — full capital-tree traversal, plus the existing
// single-item linear lineage (relocated here unchanged, byte-for-byte
// equivalent to the pre-existing inline logic in src/app/inventory/[id]/
// chain/page.tsx). Extracted into a standalone, pure module so it is
// testable without a DOM/React and so the page component stays thin.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
// The original chain page computed "Cost Basis"/"Cash Extracted"/"Current
// Assets"/"ROI" using ONLY the single item-to-item lineage that shares a
// direction with the currently-viewed item (walkBackward/walkForward,
// still present here as computeMainLineageItemIds — kept for the "Item
// Lineage" UI, which is still useful for "how did THIS item get here?").
// That traversal silently drops every sibling item created by a
// multi-item trade, which in real data can be the majority of the
// resulting value (see the investigation that motivated this module).
// buildCapitalChain below instead walks the FULL descendant tree from the
// original root acquisition — every incoming item of every trade a
// tracked item enters becomes a tracked descendant — and computes chain
// economics purely from real cash (deal.cash_paid / deal.cash_received)
// and current asset estimates, never from the assigned per-item
// deal_items.total_value deltas used by the old Running Profit metric.
//
// ── CORRECTNESS NOTES ────────────────────────────────────────────────────
// - A "root" is any item whose acquisition deal is NOT a trade (purchase,
//   Historical Import/Purchase/Trade, or no acquisition record at all).
//   Walking backward from the viewed item can surface MULTIPLE roots if a
//   multi-item trade gave away several already-owned items at once — see
//   findChainRootItemIds.
//   *Deprecation note:* deal_type also allows 'sale'/'expense' as literal
//   values, but neither can appear as an item's acquisition (di.direction
//   = 'in') in this schema, so encountering one there is already
//   malformed data — treated defensively as a root (walk stops) rather
//   than thrown.
// - Every item is visited AT MOST ONCE across the whole traversal (a
//   shared `completed` map, keyed by item id) — this is what prevents
//   double-counting when multiple roots or multiple branches converge on
//   the same downstream item (e.g. two tracked items bundled together
//   into the same outgoing trade leg). A deal's cash_paid/cash_received is
//   similarly charged at most once (a shared `chargedDealIds` set),
//   because a single deal can have multiple tracked outgoing items (a
//   multi-item Sale/Trade) — without this guard the same real dollars
//   would be added once per co-disposed item.
// - Cycle protection: an `inProgress` set catches the (invalid-data-only)
//   case of an item's disposal eventually leading back to itself; such a
//   node resolves as `cycle_detected` and contributes nothing further,
//   rather than recursing forever.

import type { Deal, DealItem, InventoryItemWithValue } from '@/types';

// ── Shared lookup context ────────────────────────────────────────────────

export interface ChainContext {
  dealById: Record<number, Deal>;
  /** Item id -> the deal id in which that item first appears with direction 'in'. */
  acqDealByItemId: Record<number, number>;
  /** Item id -> the deal id in which that item appears with direction 'out' (at most one, per this schema's item lifecycle). */
  disposalDealByItemId: Record<number, number>;
  /** Deal id -> item ids with direction 'in' in that deal. */
  inItemsByDealId: Record<number, number[]>;
  /** Deal id -> item ids with direction 'out' in that deal. */
  outItemsByDealId: Record<number, number[]>;
}

export function buildChainContext(deals: Deal[], dealItems: DealItem[]): ChainContext {
  const dealById: Record<number, Deal> = {};
  for (const d of deals) dealById[d.id] = d;

  const acqDealByItemId: Record<number, number> = {};
  const disposalDealByItemId: Record<number, number> = {};
  const inItemsByDealId: Record<number, number[]> = {};
  const outItemsByDealId: Record<number, number[]> = {};

  for (const di of dealItems) {
    if (di.direction === 'in') {
      if (acqDealByItemId[di.item_id] === undefined) acqDealByItemId[di.item_id] = di.deal_id;
      (inItemsByDealId[di.deal_id] ??= []).push(di.item_id);
    } else {
      disposalDealByItemId[di.item_id] = di.deal_id;
      (outItemsByDealId[di.deal_id] ??= []).push(di.item_id);
    }
  }

  return { dealById, acqDealByItemId, disposalDealByItemId, inItemsByDealId, outItemsByDealId };
}

// ── Existing linear item lineage (unchanged behavior, relocated) ────────
// "How did THIS specific item get here?" — direct predecessor/successor
// walk only, deliberately excludes bundle siblings. See the chain page's
// own long-standing comment (now here) for the exact algorithm rationale.

export function computeMainLineageItemIds(startItemId: number, ctx: ChainContext): Set<number> {
  const ids = new Set<number>([startItemId]);

  const walkBackward = (id: number) => {
    const acqDeal = ctx.acqDealByItemId[id];
    if (acqDeal === undefined || ctx.dealById[acqDeal]?.deal_type !== 'trade') return;
    for (const prevId of ctx.outItemsByDealId[acqDeal] ?? []) {
      if (!ids.has(prevId)) { ids.add(prevId); walkBackward(prevId); }
    }
  };

  const walkForward = (id: number) => {
    const disposalDeal = ctx.disposalDealByItemId[id];
    if (disposalDeal === undefined || ctx.dealById[disposalDeal]?.deal_type !== 'trade') return;
    for (const nextId of ctx.inItemsByDealId[disposalDeal] ?? []) {
      if (!ids.has(nextId)) { ids.add(nextId); walkForward(nextId); }
    }
  };

  walkBackward(startItemId);
  walkForward(startItemId);
  return ids;
}

// ── Root finding ──────────────────────────────────────────────────────────

/**
 * Walks backward through trades from `startItemId` until hitting, on every
 * branch, an item whose acquisition is not a trade (or has no acquisition
 * record at all). Returns every such origin item id — usually one, but a
 * multi-item trade that gave away several already-owned items at once can
 * legitimately surface more than one root.
 */
export function findChainRootItemIds(startItemId: number, ctx: ChainContext): number[] {
  const roots = new Set<number>();
  const visited = new Set<number>();

  const walk = (id: number) => {
    if (visited.has(id)) return;
    visited.add(id);

    const acqDeal = ctx.acqDealByItemId[id];
    const deal = acqDeal !== undefined ? ctx.dealById[acqDeal] : undefined;
    if (acqDeal === undefined || !deal || deal.deal_type !== 'trade') {
      roots.add(id);
      return;
    }

    const predecessors = ctx.outItemsByDealId[acqDeal] ?? [];
    if (predecessors.length === 0) { roots.add(id); return; }
    for (const p of predecessors) walk(p);
  };

  walk(startItemId);
  return Array.from(roots);
}

// ── Full capital tree ────────────────────────────────────────────────────

export type ChainNodeResolution =
  | { kind: 'held'; estimatedSoldValue: number }
  | { kind: 'sold'; saleDealId: number; cashReceived: number }
  | { kind: 'traded'; tradeDealId: number; cashPaid: number; cashReceived: number; children: ChainNode[] }
  /** This item's value was already counted via a different branch that reached it first (shared descendant of a multi-item disposal, or a second root converging here) — contributes nothing further to any total. */
  | { kind: 'already_counted' }
  /** Defensive: this item's disposal eventually leads back to an ancestor of itself. Only possible with malformed data; contributes nothing further. */
  | { kind: 'cycle_detected' }
  /** Defensive: item.status says sold/traded but no matching deal_items 'out' row was found, or the disposal deal id doesn't resolve to a known deal. */
  | { kind: 'unresolved' };

export interface ChainNode {
  itemId: number;
  acquisitionDealId: number | null;
  resolution: ChainNodeResolution;
  /** This item's own inventory_expenses total — 0 on already_counted/cycle_detected reference nodes (the real value was already attributed once, at first visit). */
  expenses: number;
}

function walkChain(
  itemId: number,
  ctx: ChainContext,
  itemsById: Record<number, InventoryItemWithValue | undefined>,
  expensesByItemId: Record<number, number>,
  inProgress: Set<number>,
  completed: Map<number, ChainNode>,
): ChainNode {
  const existing = completed.get(itemId);
  if (existing) {
    return { itemId, acquisitionDealId: ctx.acqDealByItemId[itemId] ?? null, resolution: { kind: 'already_counted' }, expenses: 0 };
  }
  if (inProgress.has(itemId)) {
    return { itemId, acquisitionDealId: ctx.acqDealByItemId[itemId] ?? null, resolution: { kind: 'cycle_detected' }, expenses: 0 };
  }
  inProgress.add(itemId);

  const item = itemsById[itemId];
  const expenses = expensesByItemId[itemId] ?? 0;
  const disposalDealId = ctx.disposalDealByItemId[itemId];

  let resolution: ChainNodeResolution;
  if (disposalDealId === undefined) {
    resolution = item && (item.status === 'owned' || item.status === 'listed')
      ? { kind: 'held', estimatedSoldValue: Number(item.estimated_sold_value ?? 0) }
      : { kind: 'unresolved' };
  } else {
    const deal = ctx.dealById[disposalDealId];
    if (!deal) {
      resolution = { kind: 'unresolved' };
    } else if (deal.deal_type === 'sale') {
      resolution = { kind: 'sold', saleDealId: disposalDealId, cashReceived: Number(deal.cash_received ?? 0) };
    } else if (deal.deal_type === 'trade') {
      const childIds = ctx.inItemsByDealId[disposalDealId] ?? [];
      const children = childIds.map((cid) => walkChain(cid, ctx, itemsById, expensesByItemId, inProgress, completed));
      resolution = { kind: 'traded', tradeDealId: disposalDealId, cashPaid: Number(deal.cash_paid ?? 0), cashReceived: Number(deal.cash_received ?? 0), children };
    } else {
      resolution = { kind: 'unresolved' };
    }
  }

  inProgress.delete(itemId);
  const node: ChainNode = { itemId, acquisitionDealId: ctx.acqDealByItemId[itemId] ?? null, resolution, expenses };
  completed.set(itemId, node);
  return node;
}

interface ChainAggregate {
  cashExtracted: number;
  currentAssets: number;
  expenses: number;
  tradeCashPaid: number;
}

function aggregateChain(roots: ChainNode[]): ChainAggregate {
  let cashExtracted = 0, currentAssets = 0, expenses = 0, tradeCashPaid = 0;
  const chargedDealIds = new Set<number>();

  const visit = (node: ChainNode) => {
    expenses += node.expenses;
    switch (node.resolution.kind) {
      case 'held':
        currentAssets += node.resolution.estimatedSoldValue;
        break;
      case 'sold':
        if (!chargedDealIds.has(node.resolution.saleDealId)) {
          chargedDealIds.add(node.resolution.saleDealId);
          cashExtracted += node.resolution.cashReceived;
        }
        break;
      case 'traded':
        if (!chargedDealIds.has(node.resolution.tradeDealId)) {
          chargedDealIds.add(node.resolution.tradeDealId);
          cashExtracted += node.resolution.cashReceived;
          tradeCashPaid += node.resolution.cashPaid;
        }
        node.resolution.children.forEach(visit);
        break;
      default:
        break;
    }
  };
  roots.forEach(visit);

  return { cashExtracted, currentAssets, expenses, tradeCashPaid };
}

/** Every terminal (held/sold) node in the tree, flattened, in a stable
 * (item id ascending) order — the data source for an "Other Descendants"
 * UI list. */
export function flattenTerminalNodes(roots: ChainNode[]): ChainNode[] {
  const out: ChainNode[] = [];
  const visit = (node: ChainNode) => {
    if (node.resolution.kind === 'held' || node.resolution.kind === 'sold') out.push(node);
    else if (node.resolution.kind === 'traded') node.resolution.children.forEach(visit);
  };
  roots.forEach(visit);
  return out.sort((a, b) => a.itemId - b.itemId);
}

export interface CapitalChainResult {
  rootItemIds: number[];
  roots: ChainNode[];
  /** Original + every later deal.cash_paid in the tree, plus chain expenses. */
  totalInvested: number;
  /** Every deal.cash_received in the tree (sales and trades alike), charged once per deal. */
  cashExtracted: number;
  /** Sum of estimated_sold_value across every currently owned/listed terminal descendant. */
  currentAssets: number;
  /** Sum of inventory_expenses across every item in the tree. */
  expenses: number;
  totalValueReturned: number;
  profit: number;
  /** Percent, e.g. 121.4 for +121.4%. Null when totalInvested is 0 (nothing to divide by). */
  roi: number | null;
}

export interface BuildCapitalChainInput {
  startItemId: number;
  deals: Deal[];
  dealItems: DealItem[];
  itemsById: Record<number, InventoryItemWithValue | undefined>;
  expensesByItemId: Record<number, number>;
}

export function buildCapitalChain(input: BuildCapitalChainInput): CapitalChainResult {
  const { startItemId, deals, dealItems, itemsById, expensesByItemId } = input;
  const ctx = buildChainContext(deals, dealItems);
  const rootItemIds = findChainRootItemIds(startItemId, ctx);

  const inProgress = new Set<number>();
  const completed = new Map<number, ChainNode>();
  const roots = rootItemIds.map((id) => walkChain(id, ctx, itemsById, expensesByItemId, inProgress, completed));

  const { cashExtracted, currentAssets, expenses, tradeCashPaid } = aggregateChain(roots);

  // Root purchase cash, deduped by deal id (two roots can share one
  // multi-item purchase deal if they were bought together and later
  // re-merged by a trade).
  const rootAcqDealIds = new Set<number>();
  for (const id of rootItemIds) {
    const acqDealId = ctx.acqDealByItemId[id];
    if (acqDealId !== undefined) rootAcqDealIds.add(acqDealId);
  }
  const rootPurchaseCash = Array.from(rootAcqDealIds).reduce(
    (sum, dealId) => sum + Number(ctx.dealById[dealId]?.cash_paid ?? 0), 0,
  );

  const totalInvested = rootPurchaseCash + tradeCashPaid + expenses;
  const totalValueReturned = cashExtracted + currentAssets;
  const profit = totalValueReturned - totalInvested;
  const roi = totalInvested > 0 ? (profit / totalInvested) * 100 : null;

  return { rootItemIds, roots, totalInvested, cashExtracted, currentAssets, expenses, totalValueReturned, profit, roi };
}

// ── Item lineage steps + per-step profit (relocated from the chain page) ──
// The "Item Lineage" timeline: every deal in which at least one main-lineage
// item is directly involved, oldest first (deals arrive pre-sorted by
// deal_date from the loader), split into incoming/outgoing legs. Deals that
// only contain bundle siblings are excluded entirely. Moved here unchanged
// so the page and the MCP get_deal_chain tool share one implementation.

export interface ChainStep {
  deal: Deal;
  incoming: DealItem[];
  outgoing: DealItem[];
}

export function buildLineageSteps(deals: Deal[], dealItems: DealItem[], mainItemIds: Set<number>): ChainStep[] {
  const dealItemsByDealId: Record<number, DealItem[]> = {};
  dealItems.forEach((di) => { (dealItemsByDealId[di.deal_id] ??= []).push(di); });
  return deals
    .filter((deal) => (dealItemsByDealId[deal.id] ?? []).some((di) => mainItemIds.has(di.item_id)))
    .map((deal) => {
      const slots = dealItemsByDealId[deal.id] ?? [];
      return {
        deal,
        incoming: slots.filter((di) => di.direction === 'in'),
        outgoing: slots.filter((di) => di.direction === 'out'),
      };
    });
}

/**
 * A Sale/Trade step's profit: for each OUTGOING main-lineage item,
 * assigned value out (deal_items.total_value) - its value_in - its own
 * inventory_expenses. Bundle siblings never inflate it. null for
 * Buy/Expense/historical steps. Same formula as the Operations screens'
 * per-item realized gain.
 */
export function lineageStepProfit(
  step: ChainStep,
  mainItemIds: Set<number>,
  itemsById: Record<number, InventoryItemWithValue | undefined>,
  expensesByItemId: Record<number, number>,
): number | null {
  if (step.deal.deal_type !== 'sale' && step.deal.deal_type !== 'trade') return null;
  return step.outgoing
    .filter((di) => mainItemIds.has(di.item_id))
    .reduce((sum, di) => {
      const item = itemsById[di.item_id];
      const itemExpenses = expensesByItemId[di.item_id] ?? 0;
      return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0) - itemExpenses);
    }, 0);
}

/** Cumulative lineage profit after each step ("Running" on the page). */
export function computeRunningProfits(
  steps: ChainStep[],
  mainItemIds: Set<number>,
  itemsById: Record<number, InventoryItemWithValue | undefined>,
  expensesByItemId: Record<number, number>,
): number[] {
  let running = 0;
  return steps.map((step) => {
    running += lineageStepProfit(step, mainItemIds, itemsById, expensesByItemId) ?? 0;
    return running;
  });
}
