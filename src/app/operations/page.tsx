'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDeals, getBrands, getInventoryItemsWithValue, getDealItems, getDisplayPhotosForItems } from '@/lib/supabase';
import { splitSearchTerms } from '@/lib/search';
import type { Brand, Deal, DealItem, InventoryItemWithValue } from '@/types';

const defaultDealTypes = ['sale', 'purchase', 'trade', 'expense'];

// ─── Visual helper ────────────────────────────────────────────────────────────

type TradeItemVisual = { photoUrl?: string; desc: string };

type DealVisual =
  | { kind: 'single'; photoUrl?: string; desc: string }
  | { kind: 'trade'; outItems: TradeItemVisual[]; outMore: number; inItems: TradeItemVisual[]; inMore: number; summary: string };

function computeDealVisual(
  deal: Deal,
  items: DealItem[],
  itemMap: Record<number, InventoryItemWithValue>,
  brandMap: Record<number, string>,
  photoByItemId: Record<number, string>
): DealVisual {
  function itemLabel(item: InventoryItemWithValue): string {
    return `${brandMap[item.brand_id] || 'Unknown'} ${item.model}`.trim();
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
      return { photoUrl: item ? photoByItemId[item.id] : undefined, desc: item ? itemLabel(item) : '—' };
    };

    const outItems = outgoing.slice(0, 3).map(toVisual);
    const inItems = incoming.slice(0, 3).map(toVisual);
    const outMore = Math.max(0, outgoing.length - 3);
    const inMore = Math.max(0, incoming.length - 3);

    const outLabels = outgoing.map((di) => { const item = itemMap[di.item_id]; return item ? itemLabel(item) : '—'; });
    const inLabels = incoming.map((di) => { const item = itemMap[di.item_id]; return item ? itemLabel(item) : '—'; });
    const summary = `${outLabels.join(' + ')} → ${inLabels.join(' + ')}`;

    return { kind: 'trade', outItems, outMore, inItems, inMore, summary };
  }

  // purchase, sale, expense: single item
  const di = items[0];
  const item = di ? itemMap[di.item_id] : null;
  return {
    kind: 'single',
    photoUrl: item ? photoByItemId[item.id] : undefined,
    desc: item ? itemLabel(item) : (deal.notes || '—'),
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OperationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedDealTypes, setSelectedDealTypes] = useState<string[]>(defaultDealTypes);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [dealsResult, dealItemsResult, itemsResult, brandsResult] = await Promise.all([
        getDeals(),
        getDealItems(),
        getInventoryItemsWithValue(),
        getBrands(),
      ]);
      setLoading(false);

      if (dealsResult.error || brandsResult.error) {
        setError('Could not load operations. Please try again.');
        return;
      }

      setDeals(dealsResult.data || []);
      setDealItems(dealItemsResult.data || []);
      setInventoryItems(itemsResult.data || []);
      setBrands(brandsResult.data || []);

      // Load photos for all referenced items in one extra query (non-blocking)
      const allItemIds = Array.from(new Set((dealItemsResult.data || []).map((di) => di.item_id)));
      if (allItemIds.length > 0) {
        getDisplayPhotosForItems(allItemIds).then(setPhotoByItemId);
      }
    }

    loadData();
  }, []);

  useEffect(() => {
    if (!searchParams) return;

    const from = searchParams.get('from') || '';
    const to = searchParams.get('to') || '';
    const typesParam = searchParams.get('dealTypes') || '';
    const types = typesParam
      ? typesParam.split(',').map((v) => v.trim().toLowerCase()).filter((v) => defaultDealTypes.includes(v))
      : defaultDealTypes;

    setFromDate(from);
    setToDate(to);
    setSelectedDealTypes(types.length > 0 ? types : defaultDealTypes);
  }, [searchParams]);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((b) => [b.id, b.name])),
    [brands]
  );

  const itemMap = useMemo(
    () => Object.fromEntries(inventoryItems.map((item) => [item.id, item])),
    [inventoryItems]
  );

  const dealItemsByDealId = useMemo(() => {
    const map: Record<number, DealItem[]> = {};
    dealItems.forEach((di) => {
      if (!map[di.deal_id]) map[di.deal_id] = [];
      map[di.deal_id].push(di);
    });
    return map;
  }, [dealItems]);

  const valueInByItemId = useMemo(
    () => Object.fromEntries(inventoryItems.map((item) => [item.id, Number(item.value_in ?? 0)])),
    [inventoryItems]
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

  const formatCurrency = (value: number | null) => {
    if (value === null) return '$0.00';
    return `$${Math.abs(value).toFixed(2)}`;
  };

  const getCashForDeal = (deal: Deal): number => {
    if (deal.deal_type === 'sale')     return deal.cash_received ?? 0;
    if (deal.deal_type === 'purchase') return -(deal.cash_paid ?? 0);
    if (deal.deal_type === 'trade')    return (deal.cash_received ?? 0) - (deal.cash_paid ?? 0);
    if (deal.deal_type === 'expense')  return -(deal.cash_paid ?? 0);
    return 0;
  };

  const getProfitForDeal = (deal: Deal): number | null => {
    if (deal.deal_type !== 'sale' && deal.deal_type !== 'trade') return null;
    const items = dealItemsByDealId[deal.id] ?? [];
    const out = items.filter((di) => di.direction === 'out');
    const outValue = out.reduce((s, di) => s + Number(di.total_value ?? 0), 0);
    const outCost  = out.reduce((s, di) => s + Number(valueInByItemId[di.item_id] ?? 0), 0);
    return outValue - outCost;
  };

  const getCashColor = (v: number) => v > 0 ? 'text-green-600' : v < 0 ? 'text-red-600' : 'text-slate-600';

  const updateQueryParams = (params: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    if (params.from)      query.set('from', params.from);
    if (params.to)        query.set('to', params.to);
    if (params.dealTypes) query.set('dealTypes', params.dealTypes);
    const qs = query.toString();
    router.replace(`/operations${qs ? `?${qs}` : ''}`);
  };

  const handleFromDateChange = (value: string) => {
    setFromDate(value);
    updateQueryParams({
      from: value || undefined,
      to: toDate || undefined,
      dealTypes: selectedDealTypes.length === defaultDealTypes.length ? undefined : selectedDealTypes.join(','),
    });
  };

  const handleToDateChange = (value: string) => {
    setToDate(value);
    updateQueryParams({
      from: fromDate || undefined,
      to: value || undefined,
      dealTypes: selectedDealTypes.length === defaultDealTypes.length ? undefined : selectedDealTypes.join(','),
    });
  };

  const handleDealTypeToggle = (dealType: string) => {
    const next = selectedDealTypes.includes(dealType)
      ? selectedDealTypes.filter((t) => t !== dealType)
      : [...selectedDealTypes, dealType];
    const types = next.length > 0 ? next : defaultDealTypes;
    setSelectedDealTypes(types);
    updateQueryParams({
      from: fromDate || undefined,
      to: toDate || undefined,
      dealTypes: types.length === defaultDealTypes.length ? undefined : types.join(','),
    });
  };

  const filteredAndSortedDeals = useMemo(() => {
    const searchTerms = splitSearchTerms(searchQuery);

    return deals
      .filter((deal) => selectedDealTypes.includes(deal.deal_type))
      .filter((deal) => {
        if (fromDate && deal.deal_date < fromDate) return false;
        if (toDate   && deal.deal_date > toDate)   return false;
        return true;
      })
      .filter((deal) => {
        if (searchTerms.length === 0) return true;
        const items = dealItemsByDealId[deal.id] || [];
        const dealFields = [deal.deal_type, deal.channel || '', deal.deal_date || '', String(deal.cash_received ?? ''), String(deal.cash_paid ?? ''), deal.notes || ''].map((f) => f.toLowerCase());
        const itemFields: string[] = [];
        items.forEach((di) => {
          const item = itemMap[di.item_id];
          if (item) {
            itemFields.push((brandMap[item.brand_id] || '').toLowerCase());
            itemFields.push(item.model.toLowerCase());
            itemFields.push((item.color || '').toLowerCase());
            itemFields.push(String(item.year ?? '').toLowerCase());
            itemFields.push((item.serial_number || '').toLowerCase());
            itemFields.push((item.notes || '').toLowerCase());
          }
        });
        return searchTerms.every((term) => [...dealFields, ...itemFields].some((f) => f.includes(term)));
      })
      .sort((a, b) => new Date(b.deal_date).getTime() - new Date(a.deal_date).getTime());
  }, [deals, fromDate, toDate, selectedDealTypes, searchQuery, dealItemsByDealId, brandMap, itemMap]);

  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Operations</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">Transactions</h1>
              <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                View all your buy, sell, trade, and expense operations.
              </p>
            </div>
            <Link
              href="/operations/new"
              className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
            >
              New operation
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)]">
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Date From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => handleFromDateChange(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">Date To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => handleToDateChange(e.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
          </div>
        </div>

        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Deal type filter</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {defaultDealTypes.map((dealType) => (
              <button
                key={dealType}
                type="button"
                onClick={() => handleDealTypeToggle(dealType)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  selectedDealTypes.includes(dealType)
                    ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {dealType}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by brand, model, color, year, channel, date, notes..."
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:ring-slate-600"
          />
        </div>

        {/* Deal list */}
        <div className="mt-6">
          {loading ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              Loading operations...
            </div>
          ) : error ? (
            <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">
              {error}
            </div>
          ) : filteredAndSortedDeals.length === 0 ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <p className="text-slate-600 dark:text-slate-300">
                {searchQuery ? 'No operations match your search.' : 'No operations yet. Start by creating a new operation.'}
              </p>
              {!searchQuery && (
                <Link
                  href="/operations/new"
                  className="mt-4 inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                >
                  Create operation
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAndSortedDeals.map((deal) => {
                const visual = computeDealVisual(
                  deal,
                  dealItemsByDealId[deal.id] || [],
                  itemMap,
                  brandMap,
                  photoByItemId
                );
                const cash = getCashForDeal(deal);
                const profit = getProfitForDeal(deal);

                return (
                  <Link
                    key={deal.id}
                    href={`/operations/${deal.id}`}
                    className="block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-400 hover:shadow-md dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-500"
                  >
                    {/* 4 meta columns + 1 wide visual column */}
                    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_2fr]">

                      {/* Type */}
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Type</p>
                        <div className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                          {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                        </div>
                      </div>

                      {/* Date */}
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Date</p>
                        <p className="mt-2 text-sm text-slate-900 dark:text-slate-100">
                          {new Date(deal.deal_date).toLocaleDateString()}
                        </p>
                      </div>

                      {/* Cash */}
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Cash</p>
                        <p className={`mt-2 text-sm font-semibold ${getCashColor(cash)}`}>
                          {formatCurrency(cash)}
                        </p>
                      </div>

                      {/* Profit */}
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Profit</p>
                        <p className={`mt-2 text-sm font-semibold ${profit !== null ? getCashColor(profit) : 'text-slate-600 dark:text-slate-300'}`}>
                          {profit !== null ? formatCurrency(profit) : '—'}
                        </p>
                      </div>

                      {/* Visual — spans full width on mobile, 2 cols on desktop */}
                      <div className="sm:col-span-2 lg:col-span-1">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Item</p>
                        <div className="mt-2">
                          {visual.kind === 'trade' ? (
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                {/* Outgoing group */}
                                <div className="flex items-center gap-1">
                                  {visual.outItems.map((ti, i) =>
                                    ti.photoUrl ? (
                                      <div key={i} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
                                        <Image src={ti.photoUrl} alt={ti.desc} fill className="object-cover" sizes="48px" unoptimized />
                                      </div>
                                    ) : (
                                      <div key={i} className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 p-1 dark:bg-slate-700">
                                        <span className="line-clamp-3 text-center text-[9px] leading-tight text-slate-600 dark:text-slate-300">{ti.desc}</span>
                                      </div>
                                    )
                                  )}
                                  {visual.outMore > 0 && (
                                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                                      +{visual.outMore}
                                    </div>
                                  )}
                                </div>
                                {/* Arrow */}
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400">
                                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                                </svg>
                                {/* Incoming group */}
                                <div className="flex items-center gap-1">
                                  {visual.inItems.map((ti, i) =>
                                    ti.photoUrl ? (
                                      <div key={i} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
                                        <Image src={ti.photoUrl} alt={ti.desc} fill className="object-cover" sizes="48px" unoptimized />
                                      </div>
                                    ) : (
                                      <div key={i} className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 p-1 dark:bg-slate-700">
                                        <span className="line-clamp-3 text-center text-[9px] leading-tight text-slate-600 dark:text-slate-300">{ti.desc}</span>
                                      </div>
                                    )
                                  )}
                                  {visual.inMore > 0 && (
                                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-500 dark:bg-slate-700 dark:text-slate-400">
                                      +{visual.inMore}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <p className="mt-1.5 max-w-full truncate text-xs text-slate-500 dark:text-slate-400">{visual.summary}</p>
                            </div>
                          ) : visual.photoUrl ? (
                            <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
                              <Image
                                src={visual.photoUrl}
                                alt={visual.desc}
                                fill
                                className="object-cover"
                                sizes="64px"
                                unoptimized
                              />
                            </div>
                          ) : (
                            <p className="text-sm text-slate-900 dark:text-slate-100 line-clamp-2">{visual.desc}</p>
                          )}
                        </div>
                      </div>

                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
