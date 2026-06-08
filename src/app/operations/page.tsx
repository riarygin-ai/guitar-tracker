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

type TradeItemVisual = { photoUrl?: string; alt: string };

type DealVisual =
  | { kind: 'single'; photoUrl?: string; alt: string; title: string }
  | { kind: 'trade'; outItems: TradeItemVisual[]; outMore: number; inItems: TradeItemVisual[]; inMore: number; title: string };

function computeDealVisual(
  deal: Deal,
  items: DealItem[],
  itemMap: Record<number, InventoryItemWithValue>,
  brandMap: Record<number, string>,
  photoByItemId: Record<number, string>
): DealVisual {
  // "Gibson SG Junior" — used for alt text and trade title
  function brandModel(item: InventoryItemWithValue): string {
    return `${brandMap[item.brand_id] || ''} ${item.model}`.trim() || 'Unknown';
  }
  // "2017 Gibson Les Paul Class 5" — used for purchase/sale title
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
    const inItems = incoming.slice(0, 3).map(toVisual);
    const outMore = Math.max(0, outgoing.length - 3);
    const inMore = Math.max(0, incoming.length - 3);

    // Title: most valuable outgoing → most valuable incoming (one item per side only)
    const bestOut = outgoing[0] ? itemMap[outgoing[0].item_id] : null;
    const bestIn  = incoming[0] ? itemMap[incoming[0].item_id] : null;
    const title = `${bestOut ? brandModel(bestOut) : '—'} → ${bestIn ? brandModel(bestIn) : '—'}`;

    return { kind: 'trade', outItems, outMore, inItems, inMore, title };
  }

  // purchase, sale, expense: single item
  const di = items[0];
  const item = di ? itemMap[di.item_id] : null;
  return {
    kind: 'single',
    photoUrl: item ? photoByItemId[item.id] : undefined,
    alt: item ? brandModel(item) : (deal.notes || '—'),
    title: item ? yearBrandModel(item) : (deal.notes || '—'),
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

  // Compact signed format: "+$1,200" / "−$50" / "$0" (no cents)
  const fmtCompact = (v: number) => {
    if (v === 0) return '$0';
    return `${v > 0 ? '+' : '−'}$${Math.round(Math.abs(v)).toLocaleString()}`;
  };

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
                const formattedDate = new Date(deal.deal_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

                // For trades: show 1 photo per side (most valuable), +N for the rest
                const topOut    = visual.kind === 'trade' ? visual.outItems[0] : null;
                const topIn     = visual.kind === 'trade' ? visual.inItems[0]  : null;
                const moreOut   = visual.kind === 'trade' ? (visual.outItems.length - (topOut ? 1 : 0) + visual.outMore) : 0;
                const moreIn    = visual.kind === 'trade' ? (visual.inItems.length  - (topIn  ? 1 : 0) + visual.inMore)  : 0;
                const hasOutSide = visual.kind === 'trade' && (!!topOut || moreOut > 0);
                const hasInSide  = visual.kind === 'trade' && (!!topIn  || moreIn  > 0);

                const photoPlaceholder = (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-7 w-7 text-slate-300 dark:text-slate-600">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                  </svg>
                );

                return (
                  <Link
                    key={deal.id}
                    href={`/operations/${deal.id}`}
                    className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-700 dark:bg-slate-800"
                  >
                    <div className="flex items-start gap-3">

                      {/* ── Photo column — fixed width on desktop so all titles align ── */}
                      <div className="shrink-0 self-start md:w-[185px]">
                      {visual.kind === 'trade' ? (
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
                              {/* Mobile: down arrow */}
                              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-slate-400 md:hidden">
                                <line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>
                              </svg>
                              {/* Desktop: right arrow */}
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
                      ) : (
                        <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                          {visual.photoUrl
                            ? <Image src={visual.photoUrl} alt={visual.alt} fill className="object-cover" sizes="80px" unoptimized />
                            : photoPlaceholder}
                        </div>
                      )}
                      </div>

                      {/* ── Content (mirrors InventoryCard content area) ───── */}
                      <div className="min-w-0 flex-1">
                        {/* Top row: type label + type badge (like item_type + status badge) */}
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                            {deal.deal_type}
                          </p>
                          <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                            {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                          </span>
                        </div>

                        {/* Title */}
                        {visual.kind === 'trade' ? (
                          <>
                            {/* Mobile: given → received as two separate truncated lines */}
                            <div className="mt-1 md:hidden">
                              <p className="truncate text-base font-semibold text-slate-900 dark:text-white">{topOut?.alt || '—'}</p>
                              <p className="my-0.5 text-xs text-slate-400 dark:text-slate-500">↓</p>
                              <p className="truncate text-base font-semibold text-slate-900 dark:text-white">{topIn?.alt || '—'}</p>
                            </div>
                            {/* Desktop: single-line combined title */}
                            <h3 className="mt-1 hidden truncate text-base font-semibold text-slate-900 dark:text-white md:block">
                              {visual.title}
                            </h3>
                          </>
                        ) : (
                          <h3 className="mt-1 truncate text-base font-semibold text-slate-900 dark:text-white">
                            {visual.title}
                          </h3>
                        )}

                        {/* Metrics — desktop: labeled two-row layout; mobile: compact single lines */}
                        <div className="hidden md:block">
                          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-700 dark:text-slate-200">
                            <span><span className="text-slate-500 dark:text-slate-400">Date </span>{formattedDate}</span>
                            <span><span className="text-slate-500 dark:text-slate-400">Cash </span><span className={getCashColor(cash)}>{fmtCompact(cash)}</span></span>
                          </div>
                          {profit !== null && (
                            <div className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                              <span className="text-slate-500 dark:text-slate-400">Profit </span>
                              <span className={getCashColor(profit)}>{fmtCompact(profit)}</span>
                            </div>
                          )}
                        </div>
                        <div className="mt-2 md:hidden">
                          <p className="text-sm text-slate-700 dark:text-slate-200">{formattedDate}</p>
                          <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-200">
                            <span className="text-slate-500 dark:text-slate-400">Cash </span>
                            <span className={getCashColor(cash)}>{fmtCompact(cash)}</span>
                            {profit !== null && (
                              <>
                                <span className="mx-1.5 text-slate-300 dark:text-slate-600">•</span>
                                <span className="text-slate-500 dark:text-slate-400">Profit </span>
                                <span className={getCashColor(profit)}>{fmtCompact(profit)}</span>
                              </>
                            )}
                          </p>
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
