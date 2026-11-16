// Per-item economics for operation screens — Create / Draft / Edit forms
// (the shared Buy / Sell / Trade form components) and the completed
// /operations/[id] page. Pure: no I/O.
//
// This module adds NO formula of its own. Every number comes from the
// canonical implementations the rest of the app (operations list, MCP
// operations tools, analytics) already uses:
//   outgoing  → outgoingItemGain (src/lib/operations/operationFinancials.ts)
//               realized gain = value out − value in − item expenses,
//               ROI via calculateItemProfitMetrics.
//   incoming  → calculateItemProfitMetrics (src/lib/profit.ts)
//               potential reward = est. sold value − value in − item expenses,
//               potential ROI on value in.
//
// Inputs and their single sources of truth:
//   value in (outgoing)  inventory_items_with_value.value_in — the item's
//                        acquisition deal_items.total_value (direction 'in').
//   expenses             sum of inventory_expenses.amount for the item. They
//                        are NOT part of value in (cost basis); they reduce
//                        gain/reward only — never added twice.
//   est. sold value      inventory_items.estimated_sold_value.
//   value out / value in (incoming) — the operation's own deal_items.total_value
//                        (or, in a form, what the user is typing).

import { calculateItemProfitMetrics } from '../profit';
import { outgoingItemGain } from './operationFinancials';

/** UI vocabulary — one meaning per label across every operation surface. */
export const ECON_LABEL = {
  valueIn: 'Value In',               // capital assigned when the item entered inventory
  valueOut: 'Value Out',             // value assigned when the item leaves inventory
  saleValue: 'Sale Value',           // Sell's Value Out (same stored field: deal_items.total_value, direction 'out')
  estSoldValue: 'Est. Sold Value',   // inventory_items.estimated_sold_value — a current estimate of future exit
  expenses: 'Expenses',
  gain: 'Gain',                      // prospective (form, not yet saved)
  realizedGain: 'Realized Gain',     // completed Sell / Trade only
  roi: 'ROI',
  potentialReward: 'Potential Reward',
  potentialRoi: 'Potential ROI',
} as const;

export interface OutgoingEconomics {
  valueIn: number | null;
  expenses: number;
  estimatedSoldValue: number | null;
  /** null until a Value Out is entered. */
  valueOut: number | null;
  gain: number | null;
  roiPercent: number | null;
}

export interface IncomingEconomics {
  valueIn: number | null;
  expenses: number;
  estimatedSoldValue: number | null;
  potentialReward: number | null;
  potentialRoiPercent: number | null;
}

/** Parse a form amount: '' / invalid → null. */
export function parseAmount(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An item leaving inventory (Trade "What I give", Sell). Same numbers as the completed operation and the /operations list. */
export function outgoingEconomics(params: {
  itemId: number;
  valueIn: number | null;
  expenses: number;
  estimatedSoldValue: number | null;
  valueOut: number | null;
}): OutgoingEconomics {
  const { itemId, valueIn, expenses, estimatedSoldValue, valueOut } = params;
  if (valueOut == null) {
    return { valueIn, expenses, estimatedSoldValue, valueOut: null, gain: null, roiPercent: null };
  }
  const g = outgoingItemGain({ item_id: itemId, total_value: valueOut }, valueIn, expenses);
  return { valueIn, expenses, estimatedSoldValue, valueOut, gain: g.realized_gain, roiPercent: g.realized_roi_percent };
}

/** An item entering inventory (Trade "What I receive", Buy). Prospective only — never realized. */
export function incomingEconomics(params: {
  valueIn: number | null;
  expenses: number;
  estimatedSoldValue: number | null;
}): IncomingEconomics {
  const { valueIn, expenses, estimatedSoldValue } = params;
  const m = calculateItemProfitMetrics({ valueIn, estimatedSoldValue, totalExpenses: expenses });
  return { valueIn, expenses, estimatedSoldValue, potentialReward: m.potentialReward, potentialRoiPercent: m.potentialROI };
}

/** Sum inventory_expenses.amount per item — the one aggregation used by forms and the completed operation page. */
export function sumExpensesByItem(rows: { item_id: number | null; amount: number }[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of rows) if (r.item_id != null) out[r.item_id] = (out[r.item_id] ?? 0) + Number(r.amount ?? 0);
  return out;
}

// ── Formatting ───────────────────────────────────────────────────────────

const money = (n: number) =>
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** $2,200 · —  (unknown) */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v < 0 ? '−' : ''}$${money(v)}`;
}

/** +$525 · −$40 · $0 · — */
export function fmtSignedMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v === 0) return '$0';
  return `${v > 0 ? '+' : '−'}$${money(v)}`;
}

/** 23.1% · — */
export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(1)}%`;
}

/** Tailwind text color for a signed economics value. */
export function signTone(v: number | null | undefined): string {
  if (v == null || v === 0) return 'text-slate-700 dark:text-slate-200';
  return v > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
}
