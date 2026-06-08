'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
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

// ─── Visual helper — same approach as Operations page ─────────────────────────

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

  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0]);

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

  const filteredRows = useMemo(
    () =>
      sortedRows.filter((row) => {
        if (dateFrom && row.transaction_date < dateFrom) return false;
        if (dateTo   && row.transaction_date > dateTo)   return false;
        return true;
      }),
    [sortedRows, dateFrom, dateTo],
  );

  const getDealTypeColor = (dealType: string) => {
    switch (dealType) {
      case 'purchase': return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700';
      case 'sale':     return 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700';
      case 'trade':    return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700';
      case 'expense':  return 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700';
      default:         return 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600';
    }
  };

  const fmt = (v: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v);

  const photoPlaceholder = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-7 w-7 text-slate-300 dark:text-slate-600">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  );

  const cashPlaceholder = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-7 w-7 text-slate-300 dark:text-slate-600">
      <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
    </svg>
  );

  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Cash flow</p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">Cash movement</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Track cash moving in and out of the business, separated from inventory and deal item details.
          </p>
        </div>

        {/* Date filters */}
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)]">
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Date From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Date To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
          </div>
        </div>

        {/* Cash flow list */}
        <div className="mt-6">
          {loading ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              Loading cash flow...
            </div>
          ) : error ? (
            <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">
              {error}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <p className="text-slate-600 dark:text-slate-300">
                {rows.length === 0 ? 'No cash flow records yet.' : 'No records match the selected date range.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRows.map((cf) => {
                const deal = cf.deal_id ? dealMap[cf.deal_id] : null;
                const items = cf.deal_id ? (dealItemsByDealId[cf.deal_id] || []) : [];
                const visual = deal ? computeDealVisual(deal, items, itemMap, brandMap, photoByItemId) : null;

                const formattedDate = new Date(cf.transaction_date + 'T12:00:00').toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                });

                const title = cf.description || visual?.title || '—';

                // Trade photo vars
                const topOut   = visual?.kind === 'trade' ? visual.outItems[0]  : null;
                const topIn    = visual?.kind === 'trade' ? visual.inItems[0]   : null;
                const moreOut  = visual?.kind === 'trade' ? (visual.outItems.length - (topOut ? 1 : 0) + visual.outMore) : 0;
                const moreIn   = visual?.kind === 'trade' ? (visual.inItems.length  - (topIn  ? 1 : 0) + visual.inMore)  : 0;
                const hasOutSide = visual?.kind === 'trade' && (!!topOut || moreOut > 0);
                const hasInSide  = visual?.kind === 'trade' && (!!topIn  || moreIn  > 0);

                // ── Photo column ────────────────────────────────────────────
                const photoCol = (
                  <div className="shrink-0 self-start md:w-[185px]">
                    {visual?.kind === 'trade' ? (
                      <div className="flex flex-col items-center gap-1 md:flex-row md:gap-1.5">
                        {hasOutSide && (
                          <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                            {topOut?.photoUrl
                              ? <Image src={topOut.photoUrl} alt={topOut.alt} fill className="object-cover" sizes="80px" unoptimized />
                              : photoPlaceholder}
                            {moreOut > 0 && (
                              <div className="absolute bottom-1 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900/70 px-1 text-[10px] font-semibold text-white">
                                +{moreOut}
                              </div>
                            )}
                          </div>
                        )}
                        {hasOutSide && hasInSide && (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400 md:hidden">
                              <line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>
                            </svg>
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="hidden shrink-0 text-slate-400 md:block">
                              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                            </svg>
                          </>
                        )}
                        {hasInSide && (
                          <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                            {topIn?.photoUrl
                              ? <Image src={topIn.photoUrl} alt={topIn.alt} fill className="object-cover" sizes="80px" unoptimized />
                              : photoPlaceholder}
                            {moreIn > 0 && (
                              <div className="absolute bottom-1 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-900/70 px-1 text-[10px] font-semibold text-white">
                                +{moreIn}
                              </div>
                            )}
                          </div>
                        )}
                        {!hasOutSide && !hasInSide && (
                          <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                            {photoPlaceholder}
                          </div>
                        )}
                      </div>
                    ) : visual?.kind === 'single' ? (
                      <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                        {visual.photoUrl
                          ? <Image src={visual.photoUrl} alt={visual.alt} fill className="object-cover" sizes="80px" unoptimized />
                          : photoPlaceholder}
                      </div>
                    ) : (
                      <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                        {cashPlaceholder}
                      </div>
                    )}
                  </div>
                );

                // ── Content column ──────────────────────────────────────────
                const contentCol = (
                  <div className="min-w-0 flex-1">

                    {/* Type label + badge */}
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                        {deal ? deal.deal_type : 'cash flow'}
                      </p>
                      {deal && (
                        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                          {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <h3 className="mt-1 truncate text-base font-semibold text-slate-900 dark:text-white">
                      {title}
                    </h3>

                    {/* Date */}
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{formattedDate}</p>

                    {/* Financial rows: Opening → Cash In/Out → Closing */}
                    <div className="mt-2.5 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-0.5">

                      <span className="text-xs text-slate-400 dark:text-slate-500">Opening</span>
                      <span className="tabular-nums text-sm text-slate-500 dark:text-slate-400">
                        {fmt(cf.opening_balance)}
                      </span>

                      {cf.cash_in > 0 && (
                        <>
                          <span className="text-xs text-slate-400 dark:text-slate-500">Cash In</span>
                          <span className="tabular-nums text-base font-bold text-emerald-600 dark:text-emerald-400">
                            +{fmt(cf.cash_in)}
                          </span>
                        </>
                      )}

                      {cf.cash_out > 0 && (
                        <>
                          <span className="text-xs text-slate-400 dark:text-slate-500">Cash Out</span>
                          <span className="tabular-nums text-base font-bold text-rose-600 dark:text-rose-400">
                            −{fmt(cf.cash_out)}
                          </span>
                        </>
                      )}

                      <span className="text-xs text-slate-400 dark:text-slate-500">Closing</span>
                      <span className="tabular-nums text-sm font-medium text-slate-700 dark:text-slate-200">
                        {fmt(cf.closing_balance)}
                      </span>

                    </div>
                  </div>
                );

                const cardClass = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800';

                return cf.deal_id ? (
                  <Link
                    key={cf.id}
                    href={`/operations/${cf.deal_id}`}
                    className={`block ${cardClass} transition hover:-translate-y-0.5 hover:shadow-md`}
                  >
                    <div className="flex items-start gap-3">{photoCol}{contentCol}</div>
                  </Link>
                ) : (
                  <div key={cf.id} className={cardClass}>
                    <div className="flex items-start gap-3">{photoCol}{contentCol}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
