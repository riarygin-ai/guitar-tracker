// Server-callable operations (deals) analysis + single-operation context —
// the data behind the read-only MCP tools get_operations_analysis and
// get_operation_context.
//
// No new financial definitions: every per-operation number comes from
// src/lib/operations/operationFinancials.ts, the module the /operations
// screens themselves now use (cash impact, per-item realized gain, ROI via
// src/lib/profit.ts). Period aggregates are plain sums of those per-
// operation values — computed ONCE per deal (cash from the deals row) and
// once per deal_items leg (values), so a multi-item trade is never counted
// once per item. The one period-level ratio, the weighted realized ROI, is
// total realized gain / total value_in over the same disposed items (never
// an average of percentages).
//
// "Operation" (UI) == a `deals` row; its canonical identifier is deals.id,
// exposed as deal_id.
//
// Identity: no user id anywhere. Every read goes through the caller's own
// authenticated client; deals / deal_items / inventory_expenses /
// cash_flow / item_leads are RLS "own rows" tables and
// inventory_items_with_value filters on get_app_user_id(). A foreign or
// nonexistent deal id therefore resolves to the same null.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Deal, DealItem } from '@/types';
import { torontoLocalDate } from './automation/torontoSchedule';
import {
  OPERATION_TYPE_LABEL,
  dealCashImpact,
  dealCashIn,
  dealCashOut,
  dealRealizedProfit,
  isRealizingDealType,
  outgoingItemGain,
  type OutgoingItemGain,
} from '../operations/operationFinancials';
import { calculateItemProfitMetrics } from '../profit';
import { formatOfferSummary, QUALITY_LABEL } from '../leads/leadFormat';

export class OperationsServiceError extends Error {}

/** Stored deal_type values (the schema's own vocabulary). UI labels: Buy/Sell/Trade/Expense. */
export const OPERATION_TYPES = ['purchase', 'sale', 'trade', 'expense', 'Historical Import', 'Historical Purchase', 'Historical Trade'] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

export const NO_CHANNEL_LABEL = 'No channel';
/** Same span as the /operations screen's default date filter (DEFAULT_PRESET '6m', src/lib/dateRange.ts). */
export const DEFAULT_OPERATIONS_MONTHS = 6;
const MAX_RANGE_DAYS = 3660;
const PAGE = 1000;
const ID_CHUNK = 150;

// ── Shared row shapes ────────────────────────────────────────────────────

interface ItemRow {
  id: number;
  brand_id: number | null;
  model: string | null;
  year: number | null;
  color: string | null;
  status: string | null;
  value_in: number | null;
  estimated_sold_value: number | null;
  item_subtype_id: number | null;
  item_subtype_name: string | null;
  purpose_name: string | null;
}

interface ExpenseRow {
  id: number;
  deal_id: number | null;
  item_id: number | null;
  expense_date: string;
  amount: number;
  notes: string | null;
}

export interface CompactItem {
  item_id: number;
  /** "year brand model (color)" */
  name: string;
  status: string | null;
}

interface Lookups {
  items: Map<number, ItemRow>;
  brandNames: Map<number, string>;
  channelNames: Map<number, string>;
  categoryBySubtypeId: Map<number, string>;
  /** All-time inventory_expenses per item (what realized gain subtracts). */
  expensesByItemId: Record<number, number>;
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

function compactItem(itemId: number, lk: Lookups): CompactItem {
  const it = lk.items.get(itemId);
  if (!it) return { item_id: itemId, name: `Item #${itemId}`, status: null };
  const base = [it.year, it.brand_id != null ? lk.brandNames.get(it.brand_id) : null, it.model].filter((p) => p != null && p !== '').join(' ');
  return { item_id: itemId, name: `${base || `Item #${itemId}`}${it.color ? ` (${it.color})` : ''}`, status: it.status };
}

function channelLabel(deal: Pick<Deal, 'deal_channel_id'>, lk: Lookups): string {
  return deal.deal_channel_id != null ? lk.channelNames.get(deal.deal_channel_id) ?? NO_CHANNEL_LABEL : NO_CHANNEL_LABEL;
}

async function chunked<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(...(await fn(ids.slice(i, i + ID_CHUNK))));
  return out;
}

async function loadLookups(client: SupabaseClient, itemIds: number[]): Promise<Lookups> {
  const [items, expenses, brandsRes, channelsRes, subtypesRes, categoriesRes] = await Promise.all([
    chunked(itemIds, async (chunk) => {
      const { data, error } = await client.from('inventory_items_with_value')
        .select('id, brand_id, model, year, color, status, value_in, estimated_sold_value, item_subtype_id, item_subtype_name, purpose_name')
        .in('id', chunk);
      if (error) throw new OperationsServiceError(`items: ${error.message}`);
      return (data ?? []) as Record<string, unknown>[];
    }),
    chunked(itemIds, async (chunk) => {
      const { data, error } = await client.from('inventory_expenses').select('item_id, amount').in('item_id', chunk);
      if (error) throw new OperationsServiceError(`item expenses: ${error.message}`);
      return (data ?? []) as { item_id: number; amount: number }[];
    }),
    client.from('brands').select('id, name'),
    client.from('deal_channels').select('id, name'),
    client.from('item_subtypes').select('id, category_id'),
    client.from('item_categories').select('id, name'),
  ]);
  for (const r of [brandsRes, channelsRes, subtypesRes, categoriesRes]) {
    if (r.error) throw new OperationsServiceError(`reference data: ${r.error.message}`);
  }
  const categoryNames = new Map<number, string>((categoriesRes.data ?? []).map((c) => [c.id as number, c.name as string]));
  const categoryBySubtypeId = new Map<number, string>();
  for (const s of subtypesRes.data ?? []) {
    const name = categoryNames.get(s.category_id as number);
    if (name) categoryBySubtypeId.set(s.id as number, name);
  }
  const expensesByItemId: Record<number, number> = {};
  for (const e of expenses) expensesByItemId[e.item_id] = (expensesByItemId[e.item_id] ?? 0) + Number(e.amount);
  return {
    items: new Map(items.map((r) => [Number(r.id), {
      id: Number(r.id),
      brand_id: num(r.brand_id),
      model: (r.model as string | null) ?? null,
      year: num(r.year),
      color: (r.color as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      value_in: num(r.value_in),
      estimated_sold_value: num(r.estimated_sold_value),
      item_subtype_id: num(r.item_subtype_id),
      item_subtype_name: (r.item_subtype_name as string | null) ?? null,
      purpose_name: (r.purpose_name as string | null) ?? null,
    }])),
    brandNames: new Map((brandsRes.data ?? []).map((b) => [b.id as number, b.name as string])),
    channelNames: new Map((channelsRes.data ?? []).map((c) => [c.id as number, c.name as string])),
    categoryBySubtypeId,
    expensesByItemId,
  };
}

function normalizeDeal(r: Record<string, unknown>): Deal {
  return {
    ...(r as unknown as Deal),
    id: Number(r.id),
    cash_paid: num(r.cash_paid),
    cash_received: num(r.cash_received),
    fees: num(r.fees),
    deal_channel_id: num(r.deal_channel_id),
  };
}

function normalizeDealItem(r: Record<string, unknown>): DealItem {
  return { ...(r as unknown as DealItem), deal_id: Number(r.deal_id), item_id: Number(r.item_id), total_value: num(r.total_value) };
}

// ── Date range ───────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const t = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return new Date(t).toISOString().slice(0, 10) === d;
}

/** Same calendar day N months earlier, clamped to the target month's last day. */
export function monthsBefore(date: string, months: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 - months;
  const d = Number(date.slice(8, 10));
  const target = new Date(Date.UTC(y, m, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

export interface ResolvedOperationsRange {
  from_date: string;
  to_date: string;
  default_applied: boolean;
}

/**
 * Both omitted -> last 6 months (to_date = today Toronto, from_date = same
 * day 6 months earlier). Only from_date -> to_date = today. Only to_date ->
 * from_date = 6 months before it. Inclusive on both ends.
 */
export function resolveOperationsRange(from: string | undefined, to: string | undefined, today: string): ResolvedOperationsRange {
  if (from !== undefined && !isValidDate(from)) throw new OperationsServiceError('from_date must be a valid YYYY-MM-DD date');
  if (to !== undefined && !isValidDate(to)) throw new OperationsServiceError('to_date must be a valid YYYY-MM-DD date');
  const toDate = to ?? today;
  const fromDate = from ?? monthsBefore(toDate, DEFAULT_OPERATIONS_MONTHS);
  if (fromDate > toDate) throw new OperationsServiceError('from_date must be on or before to_date');
  const span = (Date.parse(toDate) - Date.parse(fromDate)) / 86400000 + 1;
  if (span > MAX_RANGE_DAYS) throw new OperationsServiceError(`range must be at most ${MAX_RANGE_DAYS} days`);
  return { from_date: fromDate, to_date: toDate, default_applied: from === undefined && to === undefined };
}

// ── get_operations_analysis ──────────────────────────────────────────────

export interface OperationsAnalysisFilters {
  from_date?: string;
  to_date?: string;
  /** DealChannel names, case-insensitive. "No channel" matches operations without one. */
  channel?: string[];
  operation_type?: OperationType[];
  item_ids?: number[];
  brand?: string[];
  category?: string[];
  type?: string[];
  purpose?: string[];
}

export interface OperationItemLeg extends CompactItem {
  /** deal_items.total_value assigned to this leg. */
  value: number | null;
}

export interface OperationRow {
  deal_id: number;
  date: string;
  operation_type: string;
  operation_label: string;
  channel: string;
  cash_paid: number | null;
  cash_received: number | null;
  cash_in: number;
  cash_out: number;
  cash_impact: number;
  fees: number | null;
  /** Acquired in this operation (deal_items direction 'in'). */
  items_in: OperationItemLeg[];
  /** Disposed in this operation (direction 'out'), each with its realized gain. */
  items_out: (CompactItem & Omit<OutgoingItemGain, 'item_id'>)[];
  /** Expense operations: the item(s) the inventory_expenses rows are attached to. */
  expense_items: (CompactItem & { amount: number })[];
  realized_profit: number | null;
  notes: string | null;
}

export interface OperationsMetrics {
  operation_count: number;
  buy_count: number;
  sell_count: number;
  trade_count: number;
  expense_count: number;
  historical_count: number;
  cash_in: number;
  cash_out: number;
  net_cash_impact: number;
  sales_cash_received: number;
  exit_value_total: number;
  value_in_total: number;
  value_out_total: number;
  realized_profit: number;
  realized_deal_count: number;
  items_disposed_count: number;
  avg_realized_profit_per_realized_deal: number | null;
  realized_roi_percent_weighted: number | null;
  roi_basis_item_count: number;
  expense_operations_total: number;
  fees_recorded_total: number;
}

export interface OperationsAnalysisResult {
  generated_at: string;
  period: ResolvedOperationsRange;
  filters_applied: OperationsAnalysisFilters;
  definitions: Record<string, string>;
  summary: OperationsMetrics & { matching_items_realized_profit?: number };
  by_channel: (OperationsMetrics & { channel: string })[];
  by_operation_type: (OperationsMetrics & { operation_type: string; operation_label: string })[];
  operations: OperationRow[];
}

export const OPERATIONS_DEFINITIONS: Record<string, string> = {
  operation: 'One deals row (UI: Operation). deal_id = deals.id. operation_type is the stored deal_type: purchase=Buy, sale=Sell, trade=Trade, expense=Expense; Historical Import/Purchase/Trade are pre-app acquisitions.',
  cash_in: 'cash_received of Sell and Trade operations.',
  cash_out: 'cash_paid of Buy, Trade and Expense operations.',
  net_cash_impact: 'cash_in - cash_out (the /operations per-operation cash figure, summed). Historical operations never affect tracked cash.',
  realized_profit: 'Per disposed item: assigned value out - value_in - that item\'s inventory expenses; summed over Sell/Trade operations (the /operations "Profit"). Trade value out is the assigned (non-cash) value of the trade, not cash.',
  realized_roi_percent_weighted: 'realized gain / value_in summed over disposed items with value_in > 0 (weighted, not an average of percentages). roi_basis_item_count = items included.',
  exit_value_total: 'Sum of assigned value of items going OUT in Sell/Trade operations (the Analytics exit_value_sum basis). Closest existing metric to "turnover"; Guitar Tracker has no separate turnover or revenue definition. Includes non-cash trade value.',
  sales_cash_received: 'cash_received of Sell operations only (cash sales revenue).',
  value_in_total: 'Assigned value of every item acquired (deal_items direction in), all operation types.',
  value_out_total: 'Assigned value of every item disposed (deal_items direction out).',
  expense_operations_total: 'cash_paid of Expense operations in the period. Item expenses also reduce realized_profit when that item is later sold/traded, so the two measure different moments.',
  fees_recorded_total: 'Sum of deals.fees. Legacy column — current Buy/Sell/Trade/Expense flows always record 0; fees are recorded as Expense operations.',
  item_filters: 'item_ids/brand/category/type/purpose select OPERATIONS that involve at least one item matching every given item filter (an operation is never split). Operation cash and totals stay whole; summary.matching_items_realized_profit gives realized profit from matching disposed items only.',
};

function emptyMetrics(): OperationsMetrics {
  return {
    operation_count: 0, buy_count: 0, sell_count: 0, trade_count: 0, expense_count: 0, historical_count: 0,
    cash_in: 0, cash_out: 0, net_cash_impact: 0, sales_cash_received: 0, exit_value_total: 0,
    value_in_total: 0, value_out_total: 0, realized_profit: 0, realized_deal_count: 0, items_disposed_count: 0,
    avg_realized_profit_per_realized_deal: null, realized_roi_percent_weighted: null, roi_basis_item_count: 0,
    expense_operations_total: 0, fees_recorded_total: 0,
  };
}

interface Accumulator { m: OperationsMetrics; roiGain: number; roiBasis: number }

function addOperation(acc: Accumulator, row: OperationRow): void {
  const m = acc.m;
  m.operation_count++;
  if (row.operation_type === 'purchase') m.buy_count++;
  else if (row.operation_type === 'sale') m.sell_count++;
  else if (row.operation_type === 'trade') m.trade_count++;
  else if (row.operation_type === 'expense') m.expense_count++;
  else m.historical_count++;
  m.cash_in += row.cash_in;
  m.cash_out += row.cash_out;
  m.net_cash_impact += row.cash_impact;
  if (row.operation_type === 'sale') m.sales_cash_received += row.cash_in;
  if (row.operation_type === 'expense') m.expense_operations_total += row.cash_out;
  m.fees_recorded_total += row.fees ?? 0;
  m.value_in_total += row.items_in.reduce((s, l) => s + (l.value ?? 0), 0);
  const outValue = row.items_out.reduce((s, l) => s + l.value_out, 0);
  m.value_out_total += outValue;
  if (isRealizingDealType(row.operation_type)) {
    m.exit_value_total += outValue;
    m.realized_profit += row.realized_profit ?? 0;
    m.realized_deal_count++;
    m.items_disposed_count += row.items_out.length;
    for (const l of row.items_out) {
      if (l.value_in != null && l.value_in > 0) { acc.roiGain += l.realized_gain; acc.roiBasis += l.value_in; m.roi_basis_item_count++; }
    }
  }
}

function finish(acc: Accumulator): OperationsMetrics {
  const m = acc.m;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  m.avg_realized_profit_per_realized_deal = m.realized_deal_count > 0 ? r2(m.realized_profit / m.realized_deal_count) : null;
  m.realized_roi_percent_weighted = acc.roiBasis > 0 ? r2((acc.roiGain / acc.roiBasis) * 100) : null;
  for (const k of ['cash_in', 'cash_out', 'net_cash_impact', 'sales_cash_received', 'exit_value_total', 'value_in_total', 'value_out_total', 'realized_profit', 'expense_operations_total', 'fees_recorded_total'] as const) {
    m[k] = r2(m[k]);
  }
  return m;
}

const newAcc = (): Accumulator => ({ m: emptyMetrics(), roiGain: 0, roiBasis: 0 });

function norm(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  const s = new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean));
  return s.size > 0 ? s : null;
}

/** Pure builder over already-loaded deals/legs/lookups. Never mutates inputs. */
export function buildOperationsAnalysis(params: {
  deals: Deal[];
  dealItems: DealItem[];
  dealExpenses: ExpenseRow[];
  lookups: Lookups;
  period: ResolvedOperationsRange;
  filters: OperationsAnalysisFilters;
  generatedAt?: string;
}): OperationsAnalysisResult {
  const { deals, dealItems, dealExpenses, lookups: lk, period, filters } = params;

  const legsByDeal = new Map<number, DealItem[]>();
  for (const di of dealItems) { const a = legsByDeal.get(di.deal_id); if (a) a.push(di); else legsByDeal.set(di.deal_id, [di]); }
  const expensesByDeal = new Map<number, ExpenseRow[]>();
  for (const e of dealExpenses) if (e.deal_id != null) { const a = expensesByDeal.get(e.deal_id); if (a) a.push(e); else expensesByDeal.set(e.deal_id, [e]); }
  const valueInByItemId: Record<number, number> = {};
  lk.items.forEach((it, id) => { valueInByItemId[id] = Number(it.value_in ?? 0); });

  const channels = norm(filters.channel);
  const types = filters.operation_type && filters.operation_type.length > 0 ? new Set<string>(filters.operation_type) : null;
  const itemIds = filters.item_ids && filters.item_ids.length > 0 ? new Set(filters.item_ids) : null;
  const brands = norm(filters.brand);
  const categories = norm(filters.category);
  const typeNames = norm(filters.type);
  const purposes = norm(filters.purpose);
  const hasItemFilter = itemIds !== null || brands !== null || categories !== null || typeNames !== null || purposes !== null;

  const itemMatches = (itemId: number): boolean => {
    if (itemIds !== null && !itemIds.has(itemId)) return false;
    const it = lk.items.get(itemId);
    const lower = (v: string | null | undefined) => (v ?? '').toLowerCase();
    if (brands !== null && !(it && it.brand_id != null && brands.has(lower(lk.brandNames.get(it.brand_id))))) return false;
    if (categories !== null && !(it && it.item_subtype_id != null && categories.has(lower(lk.categoryBySubtypeId.get(it.item_subtype_id))))) return false;
    if (typeNames !== null && !(it && typeNames.has(lower(it.item_subtype_name)))) return false;
    if (purposes !== null && !(it && purposes.has(lower(it.purpose_name)))) return false;
    return true;
  };

  const rows: OperationRow[] = [];
  let matchingItemsProfit = 0;
  for (const deal of deals) {
    if (deal.deal_date < period.from_date || deal.deal_date > period.to_date) continue;
    if (types !== null && !types.has(deal.deal_type)) continue;
    const channel = channelLabel(deal, lk);
    if (channels !== null && !channels.has(channel.toLowerCase())) continue;

    const legs = legsByDeal.get(deal.id) ?? [];
    const exps = expensesByDeal.get(deal.id) ?? [];
    const involved = Array.from(new Set([...legs.map((l) => l.item_id), ...exps.map((e) => e.item_id).filter((v): v is number => v != null)]));
    if (hasItemFilter && !involved.some(itemMatches)) continue;

    const outLegs = legs.filter((l) => l.direction === 'out');
    const itemsOut = outLegs.map((l) => {
      const gain = outgoingItemGain(l, lk.items.get(l.item_id)?.value_in ?? null, lk.expensesByItemId[l.item_id] ?? 0);
      const { item_id: _ignored, ...rest } = gain;
      void _ignored;
      return { ...compactItem(l.item_id, lk), ...rest };
    });
    const realized = dealRealizedProfit(deal, legs, valueInByItemId, lk.expensesByItemId);
    if (hasItemFilter && isRealizingDealType(deal.deal_type)) {
      matchingItemsProfit += itemsOut.filter((o) => itemMatches(o.item_id)).reduce((s, o) => s + o.realized_gain, 0);
    }
    rows.push({
      deal_id: deal.id,
      date: deal.deal_date,
      operation_type: deal.deal_type,
      operation_label: OPERATION_TYPE_LABEL[deal.deal_type] ?? deal.deal_type,
      channel,
      cash_paid: deal.cash_paid,
      cash_received: deal.cash_received,
      cash_in: dealCashIn(deal),
      cash_out: dealCashOut(deal),
      cash_impact: dealCashImpact(deal),
      fees: deal.fees,
      items_in: legs.filter((l) => l.direction === 'in').map((l) => ({ ...compactItem(l.item_id, lk), value: l.total_value })),
      items_out: itemsOut,
      expense_items: exps.filter((e) => e.item_id != null).map((e) => ({ ...compactItem(e.item_id as number, lk), amount: Number(e.amount) })),
      realized_profit: realized,
      notes: deal.notes,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.deal_id - b.deal_id);

  const total = newAcc();
  const byChannel = new Map<string, Accumulator>();
  const byType = new Map<string, Accumulator>();
  for (const r of rows) {
    addOperation(total, r);
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, newAcc());
    addOperation(byChannel.get(r.channel)!, r);
    if (!byType.has(r.operation_type)) byType.set(r.operation_type, newAcc());
    addOperation(byType.get(r.operation_type)!, r);
  }

  const summary: OperationsAnalysisResult['summary'] = finish(total);
  if (hasItemFilter) summary.matching_items_realized_profit = Math.round(matchingItemsProfit * 100) / 100;

  return {
    generated_at: params.generatedAt ?? new Date().toISOString(),
    period,
    filters_applied: filters,
    definitions: OPERATIONS_DEFINITIONS,
    summary,
    by_channel: Array.from(byChannel.entries()).map(([channel, acc]) => ({ channel, ...finish(acc) })).sort((a, b) => b.operation_count - a.operation_count || a.channel.localeCompare(b.channel)),
    by_operation_type: OPERATION_TYPES.filter((t) => byType.has(t)).map((t) => ({ operation_type: t, operation_label: OPERATION_TYPE_LABEL[t], ...finish(byType.get(t)!) })),
    operations: rows,
  };
}

async function loadDealsInRange(client: SupabaseClient, from: string, to: string, types: string[] | undefined): Promise<Deal[]> {
  const out: Deal[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = client.from('deals').select('*').gte('deal_date', from).lte('deal_date', to);
    if (types && types.length > 0) q = q.in('deal_type', types);
    const { data, error } = await q.order('deal_date', { ascending: true }).order('id', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new OperationsServiceError(`deals: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    out.push(...page.map(normalizeDeal));
    if (page.length < PAGE) break;
  }
  return out;
}

export async function getOperationsAnalysisForUser(
  client: SupabaseClient,
  filters: OperationsAnalysisFilters,
  now: Date = new Date(),
): Promise<OperationsAnalysisResult> {
  const period = resolveOperationsRange(filters.from_date, filters.to_date, torontoLocalDate(now));
  const deals = await loadDealsInRange(client, period.from_date, period.to_date, filters.operation_type);
  const dealIds = deals.map((d) => d.id);
  const [dealItems, dealExpenses] = await Promise.all([
    chunked(dealIds, async (chunk) => {
      const { data, error } = await client.from('deal_items').select('id, deal_id, item_id, direction, total_value').in('deal_id', chunk);
      if (error) throw new OperationsServiceError(`deal_items: ${error.message}`);
      return ((data ?? []) as Record<string, unknown>[]).map(normalizeDealItem);
    }),
    chunked(dealIds, async (chunk) => {
      const { data, error } = await client.from('inventory_expenses').select('id, deal_id, item_id, expense_date, amount, notes').in('deal_id', chunk);
      if (error) throw new OperationsServiceError(`deal expenses: ${error.message}`);
      return (data ?? []) as ExpenseRow[];
    }),
  ]);
  const itemIds = Array.from(new Set([...dealItems.map((d) => d.item_id), ...dealExpenses.map((e) => e.item_id).filter((v): v is number => v != null)]));
  const lookups = await loadLookups(client, itemIds);
  return buildOperationsAnalysis({ deals, dealItems, dealExpenses, lookups, period, filters, generatedAt: now.toISOString() });
}

// ── get_operation_context ────────────────────────────────────────────────

export interface OperationContext {
  deal_id: number;
  date: string;
  operation_type: string;
  operation_label: string;
  channel: string;
  notes: string | null;
  /** One-line plain-language summary: what was given, what was received, and cash. */
  summary: string;
  cash_paid: number | null;
  cash_received: number | null;
  cash_impact: number;
  fees: number | null;
  gave: (CompactItem & Omit<OutgoingItemGain, 'item_id'> & { acquired_in_deal_id: number | null; acquired_date: string | null; acquisition_type: string | null })[];
  received: (CompactItem & {
    assigned_value_in: number | null;
    estimated_sold_value: number | null;
    item_expenses: number;
    potential_reward: number | null;
    potential_roi_percent: number | null;
    disposed_in_deal_id: number | null;
  })[];
  expenses: { expense_id: number; date: string; amount: number; notes: string | null; item: CompactItem | null }[];
  cash_flow: { date: string; cash_in: number; cash_out: number; description: string | null }[];
  realized_profit: number | null;
  realized_roi_percent_weighted: number | null;
  linked_leads: {
    lead_id: number;
    item_id: number;
    contact_name: string | null;
    channel: string;
    first_contact_at: string | null;
    last_contact_at: string | null;
    quality: string;
    status: string;
    offer_summary: string;
    notes: string | null;
  }[];
}

const money = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;

/** The authoritative context for one operation, or null when it doesn't exist OR isn't the caller's (indistinguishable). */
export async function getOperationContextForUser(client: SupabaseClient, dealId: number): Promise<OperationContext | null> {
  if (!Number.isInteger(dealId) || dealId <= 0) return null;
  const { data: dealRow, error: dealError } = await client.from('deals').select('*').eq('id', dealId).maybeSingle();
  if (dealError) throw new OperationsServiceError(`deal: ${dealError.message}`);
  if (!dealRow) return null;
  const deal = normalizeDeal(dealRow as Record<string, unknown>);

  const [legsRes, expRes, cfRes, leadsRes] = await Promise.all([
    client.from('deal_items').select('id, deal_id, item_id, direction, total_value').eq('deal_id', dealId),
    client.from('inventory_expenses').select('id, deal_id, item_id, expense_date, amount, notes').eq('deal_id', dealId),
    client.from('cash_flow').select('transaction_date, cash_in, cash_out, description').eq('deal_id', dealId).order('transaction_date', { ascending: true }),
    client.from('item_leads').select('id, inventory_item_id, contact_name, source_channel, deal_channel_id, first_contact_at, last_contact_at, lead_quality, status, offer_type, initial_cash_offer, best_cash_offer, trade_item, cash_component, notes').eq('deal_id', dealId),
  ]);
  for (const r of [legsRes, expRes, cfRes, leadsRes]) if (r.error) throw new OperationsServiceError(`operation context: ${r.error.message}`);
  const legs = ((legsRes.data ?? []) as Record<string, unknown>[]).map(normalizeDealItem);
  const exps = (expRes.data ?? []) as ExpenseRow[];

  const itemIds = Array.from(new Set([...legs.map((l) => l.item_id), ...exps.map((e) => e.item_id).filter((v): v is number => v != null)]));
  const lk = await loadLookups(client, itemIds);

  // Acquisition deal of each outgoing item; later disposal deal of each incoming item.
  const outIds = legs.filter((l) => l.direction === 'out').map((l) => l.item_id);
  const inIds = legs.filter((l) => l.direction === 'in').map((l) => l.item_id);
  const [acqRes, dispRes] = await Promise.all([
    outIds.length ? client.from('deal_items').select('item_id, deal_id, deals(deal_date, deal_type)').eq('direction', 'in').in('item_id', outIds) : Promise.resolve({ data: [], error: null }),
    inIds.length ? client.from('deal_items').select('item_id, deal_id').eq('direction', 'out').in('item_id', inIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (acqRes.error) throw new OperationsServiceError(`acquisitions: ${acqRes.error.message}`);
  if (dispRes.error) throw new OperationsServiceError(`disposals: ${dispRes.error.message}`);
  const acqByItem = new Map<number, { deal_id: number; date: string | null; type: string | null }>();
  for (const r of (acqRes.data ?? []) as unknown as { item_id: number; deal_id: number; deals: { deal_date: string; deal_type: string } | { deal_date: string; deal_type: string }[] | null }[]) {
    const d = Array.isArray(r.deals) ? r.deals[0] : r.deals;
    if (!acqByItem.has(r.item_id)) acqByItem.set(r.item_id, { deal_id: Number(r.deal_id), date: d?.deal_date ?? null, type: d?.deal_type ?? null });
  }
  const dispByItem = new Map<number, number>();
  for (const r of (dispRes.data ?? []) as { item_id: number; deal_id: number }[]) dispByItem.set(r.item_id, Number(r.deal_id));

  const gave = legs.filter((l) => l.direction === 'out').map((l) => {
    const { item_id: _i, ...gain } = outgoingItemGain(l, lk.items.get(l.item_id)?.value_in ?? null, lk.expensesByItemId[l.item_id] ?? 0);
    void _i;
    const acq = acqByItem.get(l.item_id) ?? null;
    return { ...compactItem(l.item_id, lk), ...gain, acquired_in_deal_id: acq?.deal_id ?? null, acquired_date: acq?.date ?? null, acquisition_type: acq?.type ?? null };
  });
  const received = legs.filter((l) => l.direction === 'in').map((l) => {
    const it = lk.items.get(l.item_id);
    const itemExpenses = lk.expensesByItemId[l.item_id] ?? 0;
    const { potentialReward, potentialROI } = calculateItemProfitMetrics({ valueIn: l.total_value, estimatedSoldValue: it?.estimated_sold_value ?? null, totalExpenses: itemExpenses });
    return {
      ...compactItem(l.item_id, lk),
      assigned_value_in: l.total_value,
      estimated_sold_value: it?.estimated_sold_value ?? null,
      item_expenses: itemExpenses,
      potential_reward: potentialReward,
      potential_roi_percent: potentialROI,
      disposed_in_deal_id: dispByItem.get(l.item_id) ?? null,
    };
  });

  const roiItems = gave.filter((g) => g.value_in != null && g.value_in > 0);
  const roiBasis = roiItems.reduce((s, g) => s + (g.value_in ?? 0), 0);
  const valueInByItemId: Record<number, number> = {};
  lk.items.forEach((it, id) => { valueInByItemId[id] = Number(it.value_in ?? 0); });

  const cashPaid = Number(deal.cash_paid ?? 0);
  const cashReceived = Number(deal.cash_received ?? 0);
  const parts: string[] = [];
  if (gave.length) parts.push(`Gave: ${gave.map((g) => g.name).join(', ')}${cashPaid > 0 && deal.deal_type !== 'expense' ? ` + ${money(cashPaid)} cash` : ''}`);
  else if (cashPaid > 0) parts.push(`Paid: ${money(cashPaid)} cash`);
  if (received.length) parts.push(`Received: ${received.map((r) => r.name).join(', ')}${cashReceived > 0 ? ` + ${money(cashReceived)} cash` : ''}`);
  else if (cashReceived > 0) parts.push(`Received: ${money(cashReceived)} cash`);
  if (deal.deal_type === 'expense' && exps.length) parts.push(`Expense on: ${exps.map((e) => (e.item_id != null ? compactItem(e.item_id, lk).name : 'no item')).join(', ')}`);

  return {
    deal_id: deal.id,
    date: deal.deal_date,
    operation_type: deal.deal_type,
    operation_label: OPERATION_TYPE_LABEL[deal.deal_type] ?? deal.deal_type,
    channel: channelLabel(deal, lk),
    notes: deal.notes,
    summary: parts.join('. ') || 'No items or cash recorded.',
    cash_paid: deal.cash_paid,
    cash_received: deal.cash_received,
    cash_impact: dealCashImpact(deal),
    fees: deal.fees,
    gave,
    received,
    expenses: exps.map((e) => ({ expense_id: Number(e.id), date: e.expense_date, amount: Number(e.amount), notes: e.notes, item: e.item_id != null ? compactItem(e.item_id, lk) : null })),
    cash_flow: ((cfRes.data ?? []) as Record<string, unknown>[]).map((c) => ({ date: c.transaction_date as string, cash_in: Number(c.cash_in ?? 0), cash_out: Number(c.cash_out ?? 0), description: (c.description as string | null) ?? null })),
    realized_profit: dealRealizedProfit(deal, legs, valueInByItemId, lk.expensesByItemId),
    realized_roi_percent_weighted: roiBasis > 0 ? Math.round((roiItems.reduce((s, g) => s + g.realized_gain, 0) / roiBasis) * 10000) / 100 : null,
    linked_leads: ((leadsRes.data ?? []) as Record<string, unknown>[]).map((l) => ({
      lead_id: Number(l.id),
      item_id: Number(l.inventory_item_id),
      contact_name: (l.contact_name as string | null) ?? null,
      channel: (l.deal_channel_id != null ? lk.channelNames.get(Number(l.deal_channel_id)) : null) ?? ((l.source_channel as string | null)?.trim() || 'Unknown'),
      first_contact_at: (l.first_contact_at as string | null) ?? null,
      last_contact_at: (l.last_contact_at as string | null) ?? null,
      quality: QUALITY_LABEL[l.lead_quality as keyof typeof QUALITY_LABEL] ?? String(l.lead_quality),
      status: String(l.status),
      offer_summary: formatOfferSummary({
        offer_type: l.offer_type as never, initial_cash_offer: num(l.initial_cash_offer), best_cash_offer: num(l.best_cash_offer),
        trade_item: (l.trade_item as string | null) ?? null, cash_component: num(l.cash_component),
      }),
      notes: (l.notes as string | null) ?? null,
    })),
  };
}
