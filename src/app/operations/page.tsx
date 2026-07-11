'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import DateRangeFilter from '@/components/DateRangeFilter';
import MoreFiltersToggle from '@/components/MoreFiltersToggle';
import { type DatePreset, DATE_PRESETS, presetToDateRange, DEFAULT_PRESET } from '@/lib/dateRange';
import { getDeals, getBrands, getInventoryItemsWithValue, getDealItems, getDisplayPhotosForItems, getInventoryExpenses } from '@/lib/supabase';
import type { InventoryExpense } from '@/types';
import { splitSearchTerms } from '@/lib/search';
import type { Brand, Deal, DealItem, InventoryItemWithValue } from '@/types';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';

const BATCH_SIZE = 25;
const SESSION_KEY = 'operations-list-state';

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
  photoByItemId: Record<number, string>,
  expenseItemIdByDealId: Record<number, number>
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
  let item: InventoryItemWithValue | null = di ? (itemMap[di.item_id] ?? null) : null;
  // Expense deals have no deal_items rows — resolve item via inventory_expenses link
  if (!item && deal.deal_type === 'expense') {
    const linkedId = expenseItemIdByDealId[deal.id];
    if (linkedId != null) item = itemMap[linkedId] ?? null;
  }
  return {
    kind: 'single',
    photoUrl: item ? photoByItemId[item.id] : undefined,
    alt: item ? brandModel(item) : (deal.notes || '—'),
    // Expense title is always the expense description, never the item name
    title: deal.deal_type === 'expense' ? (deal.notes || '—') : (item ? yearBrandModel(item) : (deal.notes || '—')),
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function savedUrlMatchesCurrent(saved: string, current: string): boolean {
  try {
    const parse = (u: string) => {
      const qi = u.indexOf('?');
      const path = qi === -1 ? u : u.slice(0, qi);
      const qs = qi === -1 ? '' : u.slice(qi + 1);
      const params = Array.from(new URLSearchParams(qs).entries()).sort(([a], [b]) => a.localeCompare(b));
      return { path, params };
    };
    const a = parse(saved), b = parse(current);
    if (a.path !== b.path) return false;
    if (a.params.length !== b.params.length) return false;
    return a.params.every(([k, v], i) => k === b.params[i][0] && v === b.params[i][1]);
  } catch {
    return saved === current;
  }
}

let _opsClickTs = 0;

export default function OperationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [expenses, setExpenses] = useState<InventoryExpense[]>([]);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('6m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [selectedDealTypes, setSelectedDealTypes] = useState<string[]>(defaultDealTypes);
  const [selectedBrandId, setSelectedBrandId] = useState<number | null>(null);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [brandFilterSearch, setBrandFilterSearch] = useState('');
  const [brandFilterFocused, setBrandFilterFocused] = useState(false);
  const [renderCount, setRenderCount] = useState(BATCH_SIZE);
  const [isRestoring, setIsRestoring] = useState(false);
  const restoredAnchorIdRef = useRef<number | null>(null);
  const restoredScrollYRef = useRef<number>(0);
  const restoredLoadedCountRef = useRef<number>(BATCH_SIZE);
  const isRestoringRef = useRef(false);
  const isFirstFilterRef = useRef(true);

  useEffect(() => {
    const currentUrl = window.location.pathname + window.location.search;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { url: string; loadedCount: number; scrollY: number; anchorId: number; timestamp: number };
      const clickAge = Date.now() - _opsClickTs;
      if (!_opsClickTs || clickAge > 60 * 60 * 1000) { _opsClickTs = 0; return; }
      _opsClickTs = 0;
      if (!savedUrlMatchesCurrent(s.url, currentUrl)) return;
      if (Date.now() - s.timestamp > 60 * 60 * 1000) { sessionStorage.removeItem(SESSION_KEY); return; }
      restoredAnchorIdRef.current = s.anchorId;
      restoredScrollYRef.current = s.scrollY;
      restoredLoadedCountRef.current = s.loadedCount;
      isRestoringRef.current = true;
      setRenderCount(s.loadedCount);
      setIsRestoring(true);
      sessionStorage.removeItem(SESSION_KEY);
    } catch { sessionStorage.removeItem(SESSION_KEY); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [dealsResult, dealItemsResult, itemsResult, brandsResult, expensesResult] = await Promise.all([
        getDeals(),
        getDealItems(),
        getInventoryItemsWithValue(),
        getBrands(),
        getInventoryExpenses(),
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
      setExpenses(expensesResult.data || []);

      // Load photos for all referenced items — includes expense-linked items which
      // have no deal_items rows and are linked only via inventory_expenses.item_id
      const dealItemIds = (dealItemsResult.data || []).map((di) => di.item_id);
      const expLinkedIds = (expensesResult.data || [])
        .filter((e) => e.item_id != null)
        .map((e) => e.item_id as number);
      const allItemIds = Array.from(new Set([...dealItemIds, ...expLinkedIds]));
      if (allItemIds.length > 0) {
        getDisplayPhotosForItems(allItemIds).then(setPhotoByItemId);
      }
    }

    loadData();
  }, []);

  useEffect(() => {
    if (!searchParams) return;

    const presetParam = searchParams.get('preset') as DatePreset | null;
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const typesParam = searchParams.get('dealTypes') || '';
    const types = typesParam
      ? typesParam.split(',').map((v) => v.trim().toLowerCase()).filter((v) => defaultDealTypes.includes(v))
      : defaultDealTypes;
    const brandParam = searchParams.get('brand_id');

    if (presetParam && DATE_PRESETS.some((p) => p.key === presetParam)) {
      setDatePreset(presetParam);
      if (presetParam === 'custom') {
        if (from !== null) setCustomFrom(from);
        if (to !== null) setCustomTo(to);
      }
      if (presetParam !== DEFAULT_PRESET) setShowMoreFilters(true);
    } else if (from !== null || to !== null) {
      // Backward compat: Dashboard links use raw from/to with no preset
      setDatePreset('custom');
      if (from !== null) setCustomFrom(from);
      if (to !== null) setCustomTo(to);
      setShowMoreFilters(true);
    }

    setSelectedDealTypes(types.length > 0 ? types : defaultDealTypes);
    if (brandParam) {
      setSelectedBrandId(Number(brandParam));
      setShowMoreFilters(true);
    }
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

  const expensesByItemId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const exp of expenses) {
      if (exp.item_id != null) map[exp.item_id] = (map[exp.item_id] ?? 0) + exp.amount;
    }
    return map;
  }, [expenses]);

  // Maps deal_id → item_id for expense deals (expense deals have no deal_items rows)
  const expenseItemIdByDealId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const exp of expenses) {
      if (exp.deal_id != null && exp.item_id != null) map[exp.deal_id] = exp.item_id;
    }
    return map;
  }, [expenses]);

  const { dateFrom: fromDate, dateTo: toDate } = useMemo(
    () => presetToDateRange(datePreset, customFrom, customTo),
    [datePreset, customFrom, customTo],
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
    const outValue    = out.reduce((s, di) => s + Number(di.total_value ?? 0), 0);
    const outCost     = out.reduce((s, di) => s + Number(valueInByItemId[di.item_id] ?? 0), 0);
    const outExpenses = out.reduce((s, di) => s + (expensesByItemId[di.item_id] ?? 0), 0);
    return outValue - outCost - outExpenses;
  };

  const getCashColor = (v: number) => v > 0 ? 'text-green-600' : v < 0 ? 'text-red-600' : 'text-slate-600';

  // Compact signed format: "+$1,200" / "−$50" / "$0" (no cents)
  const fmtCompact = (v: number) => {
    if (v === 0) return '$0';
    return `${v > 0 ? '+' : '−'}$${Math.round(Math.abs(v)).toLocaleString()}`;
  };

  const updateUrl = (overrides: {
    preset?: DatePreset;
    customFrom?: string;
    customTo?: string;
    dealTypes?: string[];
    brandId?: number | null;
  } = {}) => {
    const query = new URLSearchParams();
    const _preset = 'preset' in overrides ? overrides.preset! : datePreset;
    const _customFrom = 'customFrom' in overrides ? (overrides.customFrom ?? '') : customFrom;
    const _customTo = 'customTo' in overrides ? (overrides.customTo ?? '') : customTo;
    const _types = 'dealTypes' in overrides ? overrides.dealTypes! : selectedDealTypes;
    const _brandId = 'brandId' in overrides ? overrides.brandId : selectedBrandId;

    if (_preset !== DEFAULT_PRESET) query.set('preset', _preset);
    if (_preset === 'custom') {
      if (_customFrom) query.set('from', _customFrom);
      if (_customTo) query.set('to', _customTo);
    }
    if (_types.length > 0 && _types.length < defaultDealTypes.length) {
      query.set('dealTypes', _types.join(','));
    }
    if (_brandId != null) query.set('brand_id', String(_brandId));

    const qs = query.toString();
    router.replace(`/operations${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  const handleDealTypeToggle = (dealType: string) => {
    const next = selectedDealTypes.includes(dealType)
      ? selectedDealTypes.filter((t) => t !== dealType)
      : [...selectedDealTypes, dealType];
    const types = next.length > 0 ? next : defaultDealTypes;
    setSelectedDealTypes(types);
    updateUrl({ dealTypes: types });
  };

  const filteredBrandOptions = useMemo(
    () =>
      brands.filter(
        (b) =>
          b.id !== selectedBrandId &&
          (brandFilterSearch.length === 0 || b.name.toLowerCase().includes(brandFilterSearch.toLowerCase()))
      ),
    [brands, selectedBrandId, brandFilterSearch]
  );

  const hiddenFilterCount =
    (selectedBrandId != null ? 1 : 0) +
    (datePreset !== DEFAULT_PRESET ? 1 : 0);

  const hasActiveFilters =
    selectedBrandId != null ||
    searchQuery.length > 0 ||
    selectedDealTypes.length !== defaultDealTypes.length ||
    datePreset !== DEFAULT_PRESET;

  function clearFilters() {
    setSelectedDealTypes(defaultDealTypes);
    setSelectedBrandId(null);
    setSearchQuery('');
    setBrandFilterSearch('');
    setDatePreset(DEFAULT_PRESET);
    setCustomFrom('');
    setCustomTo(new Date().toISOString().split('T')[0]);
    updateUrl({ preset: DEFAULT_PRESET, customFrom: '', customTo: '', dealTypes: defaultDealTypes, brandId: null });
  }

  const opsFilterSig = `${searchQuery}|${fromDate}|${toDate}|${selectedDealTypes.join(',')}|${selectedBrandId ?? ''}`;
  useEffect(() => {
    if (isFirstFilterRef.current) { isFirstFilterRef.current = false; return; }
    if (isRestoringRef.current) return;
    sessionStorage.removeItem(SESSION_KEY);
    setRenderCount(BATCH_SIZE);
    setIsRestoring(false);
  }, [opsFilterSig]); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (selectedBrandId == null) return true;
        const items = dealItemsByDealId[deal.id] ?? [];
        if (items.length > 0) {
          return items.some((di) => itemMap[di.item_id]?.brand_id === selectedBrandId);
        }
        // Expense deals have no deal_items — resolve via inventory_expenses link
        if (deal.deal_type === 'expense') {
          const linkedId = expenseItemIdByDealId[deal.id];
          if (linkedId == null) return false;
          return itemMap[linkedId]?.brand_id === selectedBrandId;
        }
        return false;
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
  }, [deals, fromDate, toDate, selectedDealTypes, searchQuery, dealItemsByDealId, brandMap, itemMap, selectedBrandId, expenseItemIdByDealId]);

  const totalFilteredDeals = filteredAndSortedDeals.length;

  useEffect(() => {
    if (!isRestoring || loading) return;
    const enoughRendered =
      renderCount >= restoredLoadedCountRef.current || totalFilteredDeals <= renderCount;
    if (!enoughRendered) return;

    const anchorId = restoredAnchorIdRef.current;
    const el = anchorId != null
      ? document.querySelector(`[data-deal-id="${anchorId}"]`)
      : null;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'auto' });
        } else {
          window.scrollTo({ top: restoredScrollYRef.current, behavior: 'auto' });
        }
        isRestoringRef.current = false;
        setIsRestoring(false);
      });
    });
  }, [isRestoring, loading, renderCount, totalFilteredDeals]);

  function saveListState(anchorId: number) {
    _opsClickTs = Date.now();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      url: window.location.pathname + window.location.search,
      loadedCount: renderCount,
      scrollY: window.scrollY,
      anchorId,
      timestamp: Date.now(),
    }));
  }

  const displayedDeals = filteredAndSortedDeals.slice(0, renderCount);
  const hasMoreDeals = filteredAndSortedDeals.length > renderCount;
  const loadMoreDeals = useCallback(() => setRenderCount((c) => c + BATCH_SIZE), []);
  const sentinelRef = useInfiniteScroll(loadMoreDeals, { hasMore: hasMoreDeals, isLoading: loading, disabled: isRestoring });

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="page-overline">Operations</p>
            {!loading && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {deals.length} {deals.length === 1 ? 'transaction' : 'transactions'}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Link
              href="/operations/new"
              className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
            >
              New operation
            </Link>
          </div>
        </div>

        <div className="relative mt-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by brand, model, color, year, channel, date, notes..."
            className={`w-full rounded-2xl border border-slate-200 bg-slate-50 py-2.5 pl-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${searchQuery ? 'pr-9' : 'pr-4'}`}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700/50">
          <p className="mb-2 section-label">Operation Type</p>
          <div className="flex flex-wrap gap-2">
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

          <MoreFiltersToggle
            isOpen={showMoreFilters}
            onToggle={() => setShowMoreFilters((v) => !v)}
            count={hiddenFilterCount}
            hasActiveFilters={hasActiveFilters}
            onClear={clearFilters}
          >
            {/* Date Range */}
            <DateRangeFilter
              preset={datePreset}
              onPresetChange={(p) => {
                setDatePreset(p);
                updateUrl({ preset: p });
              }}
              customFrom={customFrom}
              onCustomFromChange={(v) => {
                setCustomFrom(v);
                updateUrl({ customFrom: v });
              }}
              customTo={customTo}
              onCustomToChange={(v) => {
                setCustomTo(v);
                updateUrl({ customTo: v });
              }}
            />

            {/* Brand — searchable single-select */}
            <div>
              <p className="mb-2 section-label">Brand</p>

              {selectedBrandId != null && (
                <div className="mb-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-900">
                    {brandMap[selectedBrandId] ?? `Brand ${selectedBrandId}`}
                    <button
                      type="button"
                      onClick={() => { setSelectedBrandId(null); setBrandFilterSearch(''); updateUrl({ brandId: null }); }}
                      aria-label="Clear brand filter"
                      className="ml-0.5 rounded-full opacity-70 hover:opacity-100"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </span>
                </div>
              )}

              <input
                type="text"
                value={brandFilterSearch}
                onChange={(e) => setBrandFilterSearch(e.target.value)}
                onFocus={() => setBrandFilterFocused(true)}
                onBlur={() => setTimeout(() => setBrandFilterFocused(false), 150)}
                placeholder="Search brands..."
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              />

              {(brandFilterFocused || brandFilterSearch.length > 0) && (
                filteredBrandOptions.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {filteredBrandOptions.map((brand) => (
                      <button
                        key={brand.id}
                        type="button"
                        onMouseDown={() => {
                          setSelectedBrandId(brand.id);
                          setBrandFilterSearch('');
                          updateUrl({ brandId: brand.id });
                        }}
                        className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500"
                      >
                        {brand.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {brandFilterSearch.length > 0 ? 'No brands match.' : 'No brands available.'}
                  </p>
                )
              )}
            </div>
          </MoreFiltersToggle>
        </div>
      </div>

      {/* Deal list */}
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
              {filteredAndSortedDeals.length > BATCH_SIZE && (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Showing {displayedDeals.length} of {filteredAndSortedDeals.length}
                </p>
              )}
              {displayedDeals.map((deal) => {
                const visual = computeDealVisual(
                  deal,
                  dealItemsByDealId[deal.id] || [],
                  itemMap,
                  brandMap,
                  photoByItemId,
                  expenseItemIdByDealId
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
                    data-deal-id={deal.id}
                    onClick={() => saveListState(deal.id)}
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
              <div ref={sentinelRef} />
            </div>
          )}
    </div>
  );
}
