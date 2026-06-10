'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  getCashFlows,
  getDeals,
  getDealItems,
  getInventoryItemsWithValue,
  getBrands,
  getDisplayPhotosForItems,
} from '@/lib/supabase';
import type { Brand, CashFlow, Deal, DealItem, InventoryItemWithValue } from '@/types';

// ─── Visual helper — only used for deal title derivation ─────────────────────

type TradeItemVisual = { photoUrl?: string; alt: string };

type DealVisual =
  | { kind: 'single'; photoUrl?: string; alt: string; title: string }
  | { kind: 'trade'; outItems: TradeItemVisual[]; outMore: number; inItems: TradeItemVisual[]; inMore: number; title: string };

function computeDealVisual(
  deal: Deal,
  items: DealItem[],
  itemMap: Record<number, InventoryItemWithValue>,
  brandMap: Record<number, string>,
  photoByItemId: Record<number, string>,
): DealVisual {
  function brandModel(item: InventoryItemWithValue): string {
    return `${brandMap[item.brand_id] || ''} ${item.model}`.trim() || 'Unknown';
  }
  function yearBrandModel(item: InventoryItemWithValue): string {
    const parts: string[] = [];
    if (item.year) parts.push(String(item.year));
    const brand = brandMap[item.brand_id];
    if (brand) parts.push(brand);
    if (item.model) parts.push(item.model);
    return parts.join(' ') || 'Unknown';
  }

  if (deal.deal_type === 'trade') {
    const outgoing = items
      .filter((di) => di.direction === 'out')
      .sort((a, b) => Number(b.total_value ?? 0) - Number(a.total_value ?? 0));
    const incoming = items
      .filter((di) => di.direction === 'in')
      .sort((a, b) => Number(b.total_value ?? 0) - Number(a.total_value ?? 0));
    const toVisual = (di: DealItem): TradeItemVisual => {
      const item = itemMap[di.item_id];
      return { photoUrl: item ? photoByItemId[item.id] : undefined, alt: item ? brandModel(item) : '—' };
    };
    const outItems = outgoing.slice(0, 3).map(toVisual);
    const inItems  = incoming.slice(0, 3).map(toVisual);
    const bestOut  = outgoing[0] ? itemMap[outgoing[0].item_id] : null;
    const bestIn   = incoming[0] ? itemMap[incoming[0].item_id] : null;
    return {
      kind: 'trade',
      outItems,
      outMore: Math.max(0, outgoing.length - 3),
      inItems,
      inMore: Math.max(0, incoming.length - 3),
      title: `${bestOut ? brandModel(bestOut) : '—'} → ${bestIn ? brandModel(bestIn) : '—'}`,
    };
  }

  const di = items[0];
  const item = di ? itemMap[di.item_id] : null;
  return {
    kind: 'single',
    photoUrl: item ? photoByItemId[item.id] : undefined,
    alt:      item ? brandModel(item) : (deal.notes || '—'),
    title:    item ? yearBrandModel(item) : (deal.notes || '—'),
  };
}

// ─── Date presets ─────────────────────────────────────────────────────────────

type DatePreset = '30d' | '90d' | '6m' | '12m' | 'all' | 'custom';

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: '30d',    label: '30 Days' },
  { key: '90d',    label: '90 Days' },
  { key: '6m',     label: '6 Months' },
  { key: '12m',    label: '12 Months' },
  { key: 'all',    label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CashFlowPage() {
  const [rows, setRows] = useState<CashFlow[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [datePreset, setDatePreset] = useState<DatePreset>('6m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().split('T')[0]);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [cashFlowResult, dealsResult, dealItemsResult, itemsResult, brandsResult] = await Promise.all([
        getCashFlows(),
        getDeals(),
        getDealItems(),
        getInventoryItemsWithValue(),
        getBrands(),
      ]);
      setLoading(false);

      if (cashFlowResult.error) {
        setError('Could not load cash flow data. Please try again.');
        return;
      }

      setRows(cashFlowResult.data || []);
      setDeals(dealsResult.data || []);
      setDealItems(dealItemsResult.data || []);
      setInventoryItems(itemsResult.data || []);
      setBrands(brandsResult.data || []);

      const allItemIds = Array.from(new Set((dealItemsResult.data || []).map((di) => di.item_id)));
      if (allItemIds.length > 0) {
        getDisplayPhotosForItems(allItemIds).then(setPhotoByItemId);
      }
    }
    loadData();
  }, []);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((b) => [b.id, b.name])),
    [brands],
  );
  const itemMap = useMemo(
    () => Object.fromEntries(inventoryItems.map((item) => [item.id, item])),
    [inventoryItems],
  );
  const dealMap = useMemo(
    () => Object.fromEntries(deals.map((d) => [d.id, d])),
    [deals],
  );
  const dealItemsByDealId = useMemo(() => {
    const map: Record<number, DealItem[]> = {};
    dealItems.forEach((di) => {
      if (!map[di.deal_id]) map[di.deal_id] = [];
      map[di.deal_id].push(di);
    });
    return map;
  }, [dealItems]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const dateDiff = b.transaction_date.localeCompare(a.transaction_date);
        if (dateDiff !== 0) return dateDiff;
        return b.id - a.id;
      }),
    [rows],
  );

  const { dateFrom, dateTo } = useMemo(() => {
    if (datePreset === 'all') return { dateFrom: '', dateTo: '' };
    if (datePreset === 'custom') return { dateFrom: customFrom, dateTo: customTo };
    const now = new Date();
    const from = new Date(now);
    if (datePreset === '30d') from.setDate(from.getDate() - 30);
    else if (datePreset === '90d') from.setDate(from.getDate() - 90);
    else if (datePreset === '6m')  from.setMonth(from.getMonth() - 6);
    else if (datePreset === '12m') from.setMonth(from.getMonth() - 12);
    return { dateFrom: from.toISOString().split('T')[0], dateTo: now.toISOString().split('T')[0] };
  }, [datePreset, customFrom, customTo]);

  const filteredRows = useMemo(
    () =>
      sortedRows.filter((row) => {
        if (dateFrom && row.transaction_date < dateFrom) return false;
        if (dateTo   && row.transaction_date > dateTo)   return false;
        return true;
      }),
    [sortedRows, dateFrom, dateTo],
  );

  const summaryStats = useMemo(() => {
    const currentBalance = sortedRows[0]?.closing_balance ?? 0;
    const cashIn  = filteredRows.reduce((sum, r) => sum + r.cash_in,  0);
    const cashOut = filteredRows.reduce((sum, r) => sum + r.cash_out, 0);
    return { currentBalance, cashIn, cashOut, net: cashIn - cashOut };
  }, [sortedRows, filteredRows]);

  const cashRatioInfo = useMemo(() => {
    const currentBalance = sortedRows[0]?.closing_balance ?? 0;
    const inventoryCost = inventoryItems
      .filter((i) => i.status === 'owned' || i.status === 'listed')
      .reduce((sum, i) => sum + (i.value_in ?? 0), 0);
    const total = currentBalance + inventoryCost;
    if (total === 0) return null;
    return { ratio: Math.round((currentBalance / total) * 100), inventoryCost };
  }, [sortedRows, inventoryItems]);

  const getDealTypeColor = (dealType: string) => {
    switch (dealType) {
      case 'purchase': return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700';
      case 'sale':     return 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700';
      case 'trade':    return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700';
      case 'expense':  return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700';
      default:         return 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600';
    }
  };

  const fmtCompact = (v: number) => `$${Math.round(Math.abs(v)).toLocaleString()}`;

  return (
    <div className="space-y-4">

      {/* Header card */}
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* Title + summary */}
        <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Cash Flow</p>
        {!loading && (
          <>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Current Balance {fmtCompact(summaryStats.currentBalance)}
              {' · '}Cash In {fmtCompact(summaryStats.cashIn)}
              {' · '}Cash Out {fmtCompact(summaryStats.cashOut)}
              {' · '}Net {summaryStats.net >= 0 ? '+' : '−'}{fmtCompact(summaryStats.net)}
            </p>
            {cashRatioInfo !== null && (
              <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                Cash Ratio {cashRatioInfo.ratio}%
                <span className="ml-1 text-slate-300 dark:text-slate-600">·</span>
                <span className="ml-1">Inventory Cost {fmtCompact(cashRatioInfo.inventoryCost)}</span>
              </p>
            )}
          </>
        )}

        {/* Date preset pills */}
        <div className="mt-4 flex flex-wrap gap-2">
          {DATE_PRESETS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setDatePreset(key)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                datePreset === key
                  ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Custom date inputs — only shown when Custom is selected */}
        {datePreset === 'custom' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">From</label>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">To</label>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              />
            </div>
          </div>
        )}
      </div>

      {/* Transaction list */}
      <div className="space-y-3">
        {loading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            Loading cash flow...
          </div>
        ) : error ? (
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700 shadow-sm">
            {error}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <p className="text-slate-600 dark:text-slate-300">
              {rows.length === 0 ? 'No cash flow records yet.' : 'No records match the selected date range.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRows.map((cf) => {
              const deal = cf.deal_id ? dealMap[cf.deal_id] : null;
              const items = cf.deal_id ? (dealItemsByDealId[cf.deal_id] || []) : [];
              const visual = deal
                ? computeDealVisual(deal, items, itemMap, brandMap, photoByItemId)
                : null;

              const formattedDate = new Date(cf.transaction_date + 'T12:00:00').toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              });

              const title = cf.description || visual?.title || '—';

              const cardContent = (
                <>
                  {/* Type label + badge */}
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                      {deal ? deal.deal_type : 'cash flow'}
                    </p>
                    {deal && (
                      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                        {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                      </span>
                    )}
                  </div>

                  {/* Title + date */}
                  <h3 className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-white">
                    {title}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{formattedDate}</p>

                  {/* Amount (primary) + Balance After */}
                  <div className="mt-2.5 flex items-end justify-between gap-4">
                    <div>
                      {cf.cash_in > 0 && (
                        <>
                          <p className="text-xs text-slate-400 dark:text-slate-500">Cash In</p>
                          <p className="tabular-nums text-lg font-bold text-emerald-600 dark:text-emerald-400">
                            +{fmtCompact(cf.cash_in)}
                          </p>
                        </>
                      )}
                      {cf.cash_out > 0 && (
                        <>
                          <p className="text-xs text-slate-400 dark:text-slate-500">Cash Out</p>
                          <p className="tabular-nums text-lg font-bold text-rose-600 dark:text-rose-400">
                            −{fmtCompact(cf.cash_out)}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-400 dark:text-slate-500">Balance After</p>
                      <p className="tabular-nums text-sm font-medium text-slate-700 dark:text-slate-200">
                        {fmtCompact(cf.closing_balance)}
                      </p>
                    </div>
                  </div>
                </>
              );

              const cardClass = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800';

              return cf.deal_id ? (
                <Link
                  key={cf.id}
                  href={`/operations/${cf.deal_id}`}
                  className={`block ${cardClass} transition hover:-translate-y-0.5 hover:shadow-md`}
                >
                  {cardContent}
                </Link>
              ) : (
                <div key={cf.id} className={cardClass}>
                  {cardContent}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
