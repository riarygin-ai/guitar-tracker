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

// ─── Visual helper ─────────────────────────────────────────────────────────────

function getDealPhotoAndTitle(
  deal: Deal,
  items: DealItem[],
  itemMap: Record<number, InventoryItemWithValue>,
  brandMap: Record<number, string>,
  photoByItemId: Record<number, string>,
): { photoUrl: string | undefined; alt: string; title: string } {
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
    const sorted = [...items].sort((a, b) => Number(b.total_value ?? 0) - Number(a.total_value ?? 0));
    const bestOut = sorted.find((di) => di.direction === 'out');
    const bestIn  = sorted.find((di) => di.direction === 'in');
    const photoItem = (bestOut ?? bestIn) ? itemMap[(bestOut ?? bestIn)!.item_id] : null;
    const outItem = bestOut ? itemMap[bestOut.item_id] : null;
    const inItem  = bestIn  ? itemMap[bestIn.item_id]  : null;
    return {
      photoUrl: photoItem ? photoByItemId[photoItem.id] : undefined,
      alt:      photoItem ? brandModel(photoItem) : '—',
      title:    `${outItem ? brandModel(outItem) : '—'} → ${inItem ? brandModel(inItem) : '—'}`,
    };
  }

  const di = items[0];
  const item = di ? itemMap[di.item_id] : null;
  return {
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
        if (dateTo && row.transaction_date > dateTo) return false;
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

  const arrowRight = (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-300 dark:text-slate-600">
      <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
    </svg>
  );

  const imgPlaceholder = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-4 w-4 text-slate-300 dark:text-slate-600">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  );

  const cashIconPlaceholder = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-4 w-4 text-slate-300 dark:text-slate-600">
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
                const dealInfo = deal
                  ? getDealPhotoAndTitle(deal, items, itemMap, brandMap, photoByItemId)
                  : null;

                const title = cf.description || dealInfo?.title || '—';

                const formattedDate = new Date(cf.transaction_date + 'T12:00:00').toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                });

                const hasCashIn  = cf.cash_in > 0;
                const hasCashOut = cf.cash_out > 0;
                const movementLabel =
                  hasCashIn && hasCashOut ? 'Cash flow'
                  : hasCashIn  ? 'Cash in'
                  : hasCashOut ? 'Cash out'
                  : 'No movement';

                const cardClass = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800';

                const cardBody = (
                  <>
                    {/* ── Header row: small photo + type label + badge ─── */}
                    <div className="mb-3.5 flex items-center gap-2.5">
                      {/* Small photo */}
                      <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-700">
                        {dealInfo?.photoUrl ? (
                          <Image
                            src={dealInfo.photoUrl}
                            alt={dealInfo.alt}
                            fill
                            className="object-cover"
                            sizes="32px"
                            unoptimized
                          />
                        ) : deal ? imgPlaceholder : cashIconPlaceholder}
                      </div>

                      <p className="flex-1 text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                        {deal ? deal.deal_type : 'cash flow'}
                      </p>

                      {deal && (
                        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                          {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                        </span>
                      )}
                    </div>

                    {/* ── Financial flow — main visual focus ─────────── */}
                    <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-4 dark:bg-slate-700/40 sm:gap-3">

                      {/* Opening */}
                      <div className="min-w-0 flex-1 text-center">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                          Opening
                        </p>
                        <p className="mt-1.5 tabular-nums text-sm font-medium text-slate-600 dark:text-slate-300">
                          {fmt(cf.opening_balance)}
                        </p>
                      </div>

                      {arrowRight}

                      {/* Cash movement — center, prominent */}
                      <div className="min-w-0 flex-[2] text-center">
                        {hasCashIn && (
                          <p className="tabular-nums text-xl font-bold leading-tight text-emerald-600 dark:text-emerald-400 sm:text-2xl">
                            +{fmt(cf.cash_in)}
                          </p>
                        )}
                        {hasCashOut && (
                          <p className="tabular-nums text-xl font-bold leading-tight text-rose-600 dark:text-rose-400 sm:text-2xl">
                            −{fmt(cf.cash_out)}
                          </p>
                        )}
                        {!hasCashIn && !hasCashOut && (
                          <p className="tabular-nums text-xl font-bold text-slate-400 dark:text-slate-500 sm:text-2xl">—</p>
                        )}
                        <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                          {movementLabel}
                        </p>
                      </div>

                      {arrowRight}

                      {/* Closing */}
                      <div className="min-w-0 flex-1 text-center">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                          Closing
                        </p>
                        <p className="mt-1.5 tabular-nums text-sm font-medium text-slate-600 dark:text-slate-300">
                          {fmt(cf.closing_balance)}
                        </p>
                      </div>
                    </div>

                    {/* ── Footer: description + date — secondary ─────── */}
                    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-700">
                      <p className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">
                        {title}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{formattedDate}</p>
                    </div>
                  </>
                );

                return cf.deal_id ? (
                  <Link
                    key={cf.id}
                    href={`/operations/${cf.deal_id}`}
                    className={`block ${cardClass} transition hover:-translate-y-0.5 hover:shadow-md`}
                  >
                    {cardBody}
                  </Link>
                ) : (
                  <div key={cf.id} className={cardClass}>
                    {cardBody}
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
