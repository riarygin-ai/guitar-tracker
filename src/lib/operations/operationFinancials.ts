// Canonical per-operation (deal) financial semantics, exactly as the
// /operations screens have always shown them — extracted unchanged from
// src/app/operations/page.tsx (getCashForDeal / getProfitForDeal) and the
// operation detail page's per-item realized gain, so the UI and the MCP
// operations tools (src/lib/analytics/operationsService.ts) share ONE
// definition. Pure: no I/O.
//
// Vocabulary: the app says "Operation" in the UI and stores it as a `deals`
// row (deal_type purchase/sale/trade/expense = Buy/Sell/Trade/Expense, plus
// the legacy pre-app 'Historical Import'/'Historical Purchase'/'Historical
// Trade' acquisitions).
//
//   cash impact  sale +cash_received; purchase -cash_paid;
//                trade cash_received - cash_paid; expense -cash_paid;
//                historical types 0 (pre-app, never part of tracked cash).
//   realized     per OUTGOING item: assigned value out (deal_items.total_value)
//   gain         - value_in (its acquisition deal_items.total_value) - that
//                item's own inventory_expenses total. Only Sell/Trade
//                operations realize gain.

import type { Deal, DealItem } from '@/types';
import { calculateItemProfitMetrics } from '../profit';

export const OPERATION_TYPE_LABEL: Record<string, string> = {
  purchase: 'Buy',
  sale: 'Sell',
  trade: 'Trade',
  expense: 'Expense',
  'Historical Import': 'Historical Import',
  'Historical Purchase': 'Historical Purchase',
  'Historical Trade': 'Historical Trade',
};

/** Signed cash effect of one operation on the business's cash. */
export function dealCashImpact(deal: Pick<Deal, 'deal_type' | 'cash_paid' | 'cash_received'>): number {
  if (deal.deal_type === 'sale')     return deal.cash_received ?? 0;
  if (deal.deal_type === 'purchase') return -(deal.cash_paid ?? 0);
  if (deal.deal_type === 'trade')    return (deal.cash_received ?? 0) - (deal.cash_paid ?? 0);
  if (deal.deal_type === 'expense')  return -(deal.cash_paid ?? 0);
  return 0;
}

/** Cash received that counts toward tracked cash (same rule as dealCashImpact, positive side only). */
export function dealCashIn(deal: Pick<Deal, 'deal_type' | 'cash_received'>): number {
  return deal.deal_type === 'sale' || deal.deal_type === 'trade' ? Number(deal.cash_received ?? 0) : 0;
}

/** Cash paid that counts toward tracked cash (same rule as dealCashImpact, negative side only). */
export function dealCashOut(deal: Pick<Deal, 'deal_type' | 'cash_paid'>): number {
  return deal.deal_type === 'purchase' || deal.deal_type === 'trade' || deal.deal_type === 'expense' ? Number(deal.cash_paid ?? 0) : 0;
}

export function isRealizingDealType(dealType: string): boolean {
  return dealType === 'sale' || dealType === 'trade';
}

export interface OutgoingItemGain {
  item_id: number;
  value_out: number;
  value_in: number | null;
  item_expenses: number;
  realized_gain: number;
  /** calculateItemProfitMetrics (src/lib/profit.ts): gain / value_in * 100; 100 for zero cost with positive gain; null when value_in unknown. */
  realized_roi_percent: number | null;
}

/** Per-item realized gain for one outgoing leg (operation detail page semantics). */
export function outgoingItemGain(
  di: Pick<DealItem, 'item_id' | 'total_value'>,
  valueIn: number | null,
  itemExpenses: number,
): OutgoingItemGain {
  const valueOut = Number(di.total_value ?? 0);
  const realizedGain = valueOut - Number(valueIn ?? 0) - itemExpenses;
  const { realizedROI } = calculateItemProfitMetrics({ valueIn, valueOut, totalExpenses: itemExpenses });
  return { item_id: di.item_id, value_out: valueOut, value_in: valueIn, item_expenses: itemExpenses, realized_gain: realizedGain, realized_roi_percent: realizedROI };
}

/** Operation-level realized profit (the /operations list's "Profit"): sum of every outgoing item's realized gain; null for non-Sell/Trade. */
export function dealRealizedProfit(
  deal: Pick<Deal, 'deal_type'>,
  dealItems: Pick<DealItem, 'item_id' | 'direction' | 'total_value'>[],
  valueInByItemId: Record<number, number>,
  expensesByItemId: Record<number, number>,
): number | null {
  if (!isRealizingDealType(deal.deal_type)) return null;
  const out = dealItems.filter((di) => di.direction === 'out');
  const outValue    = out.reduce((s, di) => s + Number(di.total_value ?? 0), 0);
  const outCost     = out.reduce((s, di) => s + Number(valueInByItemId[di.item_id] ?? 0), 0);
  const outExpenses = out.reduce((s, di) => s + (expensesByItemId[di.item_id] ?? 0), 0);
  return outValue - outCost - outExpenses;
}
