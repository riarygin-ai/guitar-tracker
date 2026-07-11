'use client';

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  getCashFlows,
  getDeals,
  getDealItems,
  getInventoryItemsWithValue,
  getBrands,
  getDisplayPhotosForItems,
  getInventoryExpenses,
  getTags,
  getTagsForItems,
} from '@/lib/supabase';
import type { Brand, CashFlow, Deal, DealItem, InventoryExpense, InventoryItemWithValue, InventoryTag } from '@/types';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import DateRangeFilter from '@/components/DateRangeFilter';
import MoreFiltersToggle from '@/components/MoreFiltersToggle';
import TagsFilter from '@/components/TagsFilter';
import { type DatePreset, DATE_PRESETS, presetToDateRange, DEFAULT_PRESET } from '@/lib/dateRange';
import { splitSearchTerms } from '@/lib/search';

const BATCH_SIZE = 30;
const SESSION_KEY = 'cash-flow-list-state';

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
  expenseItemIdByDealId: Record<number, number>,
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
  let item: InventoryItemWithValue | null = di ? (itemMap[di.item_id] ?? null) : null;
  // Expense deals have no deal_items rows — resolve item via inventory_expenses link
  if (!item && deal.deal_type === 'expense') {
    const linkedId = expenseItemIdByDealId[deal.id];
    if (linkedId != null) item = itemMap[linkedId] ?? null;
  }
  return {
    kind: 'single',
    photoUrl: item ? photoByItemId[item.id] : undefined,
    alt:      item ? brandModel(item) : (deal.notes || '—'),
    // Expense title is always the expense description, never the item name
    title:    deal.deal_type === 'expense' ? (deal.notes || '—') : (item ? yearBrandModel(item) : (deal.notes || '—')),
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_DEAL_TYPES = ['sale', 'purchase', 'trade', 'expense'] as const;

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

let _cfClickTs = 0;

export default function CashFlowPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [rows, setRows] = useState<CashFlow[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [expenses, setExpenses] = useState<InventoryExpense[]>([]);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [datePreset, setDatePreset] = useState<DatePreset>('6m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().split('T')[0]);
  const [selectedDealTypes, setSelectedDealTypes] = useState<string[]>([...ALL_DEAL_TYPES]);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [allTags, setAllTags] = useState<InventoryTag[]>([]);
  const [tagsByItemId, setTagsByItemId] = useState<Record<number, InventoryTag[]>>({});
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [cfSearch, setCfSearch] = useState('');
  const [renderCount, setRenderCount] = useState(BATCH_SIZE);
  const [isRestoring, setIsRestoring] = useState(false);
  const restoredAnchorIdRef = useRef<number | null>(null);
  const restoredScrollYRef = useRef<number>(0);
  const restoredLoadedCountRef = useRef<number>(BATCH_SIZE);
  const isRestoringRef = useRef(false);
  const isFirstFilterRef = useRef(true);
  const isInitializedRef = useRef(false);

  useEffect(() => {
    const currentUrl = window.location.pathname + window.location.search;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { url: string; loadedCount: number; scrollY: number; anchorId: number; timestamp: number };
      const clickAge = Date.now() - _cfClickTs;
      if (!_cfClickTs || clickAge > 60 * 60 * 1000) { _cfClickTs = 0; return; }
      _cfClickTs = 0;
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

  // Read URL params on mount (once)
  useEffect(() => {
    if (isInitializedRef.current) return;
    const presetParam = searchParams.get('preset') as DatePreset | null;
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const typesParam = searchParams.get('dealTypes') || '';
    const types = typesParam
      ? typesParam.split(',').filter((v) => (ALL_DEAL_TYPES as readonly string[]).includes(v))
      : [];
    if (presetParam && DATE_PRESETS.some((p) => p.key === presetParam)) {
      setDatePreset(presetParam);
      if (presetParam === 'custom') {
        if (from !== null) setCustomFrom(from);
        if (to !== null) setCustomTo(to);
      }
      if (presetParam !== DEFAULT_PRESET) setShowMoreFilters(true);
    }
    if (types.length > 0 && types.length < ALL_DEAL_TYPES.length) {
      setSelectedDealTypes(types);
    }
    const searchParam = searchParams.get('search') ?? '';
    if (searchParam) setCfSearch(searchParam);
    const tagParam = searchParams.get('tag_id');
    const tagIds = tagParam ? tagParam.split(',').map(Number).filter(Boolean) : [];
    if (tagIds.length > 0) {
      setSelectedTagIds(tagIds);
      setShowMoreFilters(true);
    }
    isInitializedRef.current = true;
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Write URL when filter state changes
  useEffect(() => {
    if (!isInitializedRef.current) return;
    const params = new URLSearchParams();
    if (datePreset !== DEFAULT_PRESET) params.set('preset', datePreset);
    if (datePreset === 'custom') {
      if (customFrom) params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    }
    if (selectedDealTypes.length > 0 && selectedDealTypes.length < ALL_DEAL_TYPES.length) {
      params.set('dealTypes', [...selectedDealTypes].sort().join(','));
    }
    if (cfSearch) params.set('search', cfSearch);
    if (selectedTagIds.length > 0) {
      params.set('tag_id', [...selectedTagIds].sort((a, b) => a - b).join(','));
    }
    const qs = params.toString();
    router.replace(`/cash-flow${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [datePreset, customFrom, customTo, selectedDealTypes, cfSearch, selectedTagIds, router]);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [cashFlowResult, dealsResult, dealItemsResult, itemsResult, brandsResult, expensesResult, tagsResult] = await Promise.all([
        getCashFlows(),
        getDeals(),
        getDealItems(),
        getInventoryItemsWithValue(),
        getBrands(),
        getInventoryExpenses(),
        getTags(),
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
      setExpenses(expensesResult.data || []);

      const tagsData = (!tagsResult.error ? (tagsResult.data ?? []) : []) as InventoryTag[];
      setAllTags(tagsData);

      // Include expense-linked item IDs — expense deals have no deal_items rows
      const dealItemIds = (dealItemsResult.data || []).map((di) => di.item_id);
      const expLinkedIds = (expensesResult.data || [])
        .filter((e) => e.item_id != null)
        .map((e) => e.item_id as number);
      const allItemIds = Array.from(new Set([...dealItemIds, ...expLinkedIds]));
      if (allItemIds.length > 0) {
        const [photosMap, itemTagsResult] = await Promise.all([
          getDisplayPhotosForItems(allItemIds),
          getTagsForItems(allItemIds),
        ]);
        setPhotoByItemId(photosMap);
        if (!itemTagsResult.error && itemTagsResult.data) {
          const tagById = Object.fromEntries(tagsData.map((t) => [t.id, t]));
          const tagsMap: Record<number, InventoryTag[]> = {};
          for (const row of itemTagsResult.data as { item_id: number; tag_id: number }[]) {
            const tag = tagById[row.tag_id];
            if (tag) {
              if (!tagsMap[row.item_id]) tagsMap[row.item_id] = [];
              tagsMap[row.item_id].push(tag);
            }
          }
          setTagsByItemId(tagsMap);
        }
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

  // Maps deal_id → item_id for expense deals (expense deals have no deal_items rows)
  const expenseItemIdByDealId = useMemo(() => {
    const map: Record<number, number> = {};
    for (const exp of expenses) {
      if (exp.deal_id != null && exp.item_id != null) map[exp.deal_id] = exp.item_id;
    }
    return map;
  }, [expenses]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const dateDiff = b.transaction_date.localeCompare(a.transaction_date);
        if (dateDiff !== 0) return dateDiff;
        return b.id - a.id;
      }),
    [rows],
  );

  const { dateFrom, dateTo } = useMemo(
    () => presetToDateRange(datePreset, customFrom, customTo),
    [datePreset, customFrom, customTo],
  );

  const allDealTypesSelected = selectedDealTypes.length === ALL_DEAL_TYPES.length;

  const filteredRows = useMemo(
    () => {
      const searchTerms = splitSearchTerms(cfSearch);
      return sortedRows.filter((row) => {
        if (dateFrom && row.transaction_date < dateFrom) return false;
        if (dateTo   && row.transaction_date > dateTo)   return false;
        if (!allDealTypesSelected) {
          const deal = row.deal_id ? dealMap[row.deal_id] : null;
          const dealType = deal?.deal_type ?? null;
          // Rows with no linked deal are untyped — only hide them if no deal types selected at all
          if (dealType !== null && !selectedDealTypes.includes(dealType)) return false;
        }
        if (searchTerms.length > 0) {
          const deal = row.deal_id ? dealMap[row.deal_id] : null;
          const items = deal ? (dealItemsByDealId[deal.id] ?? []) : [];
          const textFields: string[] = [
            row.description ?? '',
            row.transaction_date,
            deal?.deal_type ?? '',
            deal?.notes ?? '',
            deal?.channel ?? '',
            deal?.deal_date ?? '',
          ];
          for (const di of items) {
            const item = itemMap[di.item_id];
            if (item) {
              textFields.push(brandMap[item.brand_id] ?? '');
              textFields.push(item.model);
              textFields.push(item.color ?? '');
              textFields.push(String(item.year ?? ''));
            }
          }
          const expLinkedItemId = deal ? expenseItemIdByDealId[deal.id] : undefined;
          if (expLinkedItemId != null) {
            const item = itemMap[expLinkedItemId];
            if (item) {
              textFields.push(brandMap[item.brand_id] ?? '');
              textFields.push(item.model);
              textFields.push(item.color ?? '');
              textFields.push(String(item.year ?? ''));
            }
          }
          const lowerFields = textFields.map((f) => f.toLowerCase());
          if (!searchTerms.every((term) => lowerFields.some((f) => f.includes(term)))) return false;
        }
        if (selectedTagIds.length > 0) {
          const deal = row.deal_id ? dealMap[row.deal_id] : null;
          if (!deal) return false;
          const items = dealItemsByDealId[deal.id] ?? [];
          const allItemIds = items.map((di) => di.item_id);
          const expLinkedId = expenseItemIdByDealId[deal.id];
          if (expLinkedId != null) allItemIds.push(expLinkedId);
          const hasTag = allItemIds.some((itemId) => {
            const itemTagIds = (tagsByItemId[itemId] ?? []).map((t) => t.id);
            return selectedTagIds.every((tid) => itemTagIds.includes(tid));
          });
          if (!hasTag) return false;
        }
        return true;
      });
    },
    [sortedRows, dateFrom, dateTo, allDealTypesSelected, selectedDealTypes, dealMap, cfSearch, dealItemsByDealId, itemMap, brandMap, expenseItemIdByDealId, selectedTagIds, tagsByItemId],
  );

  const cfFilterSig = `${datePreset}|${customFrom}|${customTo}|${selectedDealTypes.join(',')}|${cfSearch}|${selectedTagIds.join(',')}`;
  useEffect(() => {
    if (isFirstFilterRef.current) { isFirstFilterRef.current = false; return; }
    if (isRestoringRef.current) return;
    sessionStorage.removeItem(SESSION_KEY);
    setRenderCount(BATCH_SIZE);
    setIsRestoring(false);
  }, [cfFilterSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalFilteredCount = filteredRows.length;
  useEffect(() => {
    if (!isRestoring || loading) return;
    const enoughRendered =
      renderCount >= restoredLoadedCountRef.current || totalFilteredCount <= renderCount;
    if (!enoughRendered) return;
    const anchorId = restoredAnchorIdRef.current;
    const el = anchorId != null
      ? document.querySelector(`[data-cash-flow-id="${anchorId}"]`)
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
  }, [isRestoring, loading, renderCount, totalFilteredCount]);

  const displayedRows = filteredRows.slice(0, renderCount);
  const hasMoreRows = filteredRows.length > renderCount;
  const loadMoreRows = useCallback(() => setRenderCount((c) => c + BATCH_SIZE), []);

  function saveListState(anchorId: number) {
    _cfClickTs = Date.now();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      url: window.location.pathname + window.location.search,
      loadedCount: renderCount,
      scrollY: window.scrollY,
      anchorId,
      timestamp: Date.now(),
    }));
  }

  const sentinelRef = useInfiniteScroll(loadMoreRows, { hasMore: hasMoreRows, isLoading: loading, disabled: isRestoring });

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

  const hiddenFilterCount = selectedTagIds.length + (datePreset !== DEFAULT_PRESET ? 1 : 0);

  const hasActiveFilters =
    datePreset !== DEFAULT_PRESET ||
    selectedDealTypes.length < ALL_DEAL_TYPES.length ||
    cfSearch.length > 0 ||
    selectedTagIds.length > 0;

  function clearFilters() {
    setDatePreset(DEFAULT_PRESET);
    setCustomFrom('');
    setCustomTo(new Date().toISOString().split('T')[0]);
    setSelectedDealTypes([...ALL_DEAL_TYPES]);
    setCfSearch('');
    setSelectedTagIds([]);
  }

  // ── Shared photo placeholders ──────────────────────────────────────────────

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
    <div className="space-y-4">

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="page-overline">Cash Flow</p>
            {!loading && (
              <div className="mt-1">
                <p className="text-xs text-slate-500 dark:text-slate-400">
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
              </div>
            )}
          </div>
        </div>

        <div className="relative mt-4">
          <input
            type="text"
            value={cfSearch}
            onChange={(e) => setCfSearch(e.target.value)}
            placeholder="Search cash flow..."
            className={`w-full rounded-2xl border border-slate-200 bg-slate-50 py-2.5 pl-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${cfSearch ? 'pr-9' : 'pr-4'}`}
          />
          {cfSearch && (
            <button
              type="button"
              onClick={() => setCfSearch('')}
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
          <p className="mb-2 section-label">Transaction Type</p>
          <div className="flex flex-wrap gap-2">
            {ALL_DEAL_TYPES.map((dealType) => (
              <button
                key={dealType}
                type="button"
                onClick={() => {
                  setSelectedDealTypes((current) => {
                    const next = current.includes(dealType)
                      ? current.filter((t) => t !== dealType)
                      : [...current, dealType];
                    return next.length > 0 ? next : [...ALL_DEAL_TYPES];
                  });
                }}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  selectedDealTypes.includes(dealType)
                    ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
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
            <DateRangeFilter
              preset={datePreset}
              onPresetChange={setDatePreset}
              customFrom={customFrom}
              onCustomFromChange={setCustomFrom}
              customTo={customTo}
              onCustomToChange={setCustomTo}
            />
            <TagsFilter
              allTags={allTags}
              selectedTagIds={selectedTagIds}
              onTagIdsChange={setSelectedTagIds}
            />
          </MoreFiltersToggle>
        </div>
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
              {rows.length === 0 ? 'No cash flow records yet.' : 'No records match the selected filters.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRows.length > BATCH_SIZE && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Showing {displayedRows.length} of {filteredRows.length}
              </p>
            )}
            {displayedRows.map((cf) => {
              const deal = cf.deal_id ? dealMap[cf.deal_id] : null;
              const items = cf.deal_id ? (dealItemsByDealId[cf.deal_id] || []) : [];
              const visual = deal
                ? computeDealVisual(deal, items, itemMap, brandMap, photoByItemId, expenseItemIdByDealId)
                : null;

              const formattedDate = new Date(cf.transaction_date + 'T12:00:00').toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              });

              const title = cf.description || visual?.title || '—';

              // ── Photo column (mirrors Operations page) ───────────────────
              const topOut   = visual?.kind === 'trade' ? visual.outItems[0]  : null;
              const topIn    = visual?.kind === 'trade' ? visual.inItems[0]   : null;
              const moreOut  = visual?.kind === 'trade' ? (visual.outItems.length - (topOut ? 1 : 0) + visual.outMore) : 0;
              const moreIn   = visual?.kind === 'trade' ? (visual.inItems.length  - (topIn  ? 1 : 0) + visual.inMore)  : 0;
              const hasOutSide = visual?.kind === 'trade' && (!!topOut || moreOut > 0);
              const hasInSide  = visual?.kind === 'trade' && (!!topIn  || moreIn  > 0);

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
                    // No linked deal — use cash icon
                    <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
                      {cashPlaceholder}
                    </div>
                  )}
                </div>
              );

              // ── Content column ────────────────────────────────────────────
              const contentCol = (
                <div className="min-w-0 flex-1">
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

                  {/* Trade: two-line title on mobile, one-line on desktop */}
                  {visual?.kind === 'trade' ? (
                    <>
                      <div className="mt-1 md:hidden">
                        <p className="truncate text-base font-semibold text-slate-900 dark:text-white">{topOut?.alt || '—'}</p>
                        <p className="my-0.5 text-xs text-slate-400 dark:text-slate-500">↓</p>
                        <p className="truncate text-base font-semibold text-slate-900 dark:text-white">{topIn?.alt || '—'}</p>
                      </div>
                      <h3 className="mt-1 hidden truncate text-base font-semibold text-slate-900 dark:text-white md:block">
                        {visual.title}
                      </h3>
                    </>
                  ) : (
                    <h3 className="mt-1 truncate text-base font-semibold text-slate-900 dark:text-white">
                      {title}
                    </h3>
                  )}

                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{formattedDate}</p>

                  {/* Amount + Balance After */}
                  <div className="mt-2 flex items-end justify-between gap-4">
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
                </div>
              );

              const cardClass = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800';

              return cf.deal_id ? (
                <Link
                  key={cf.id}
                  href={`/operations/${cf.deal_id}`}
                  data-cash-flow-id={cf.id}
                  onClick={() => saveListState(cf.id)}
                  className={`block ${cardClass} transition hover:-translate-y-0.5 hover:shadow-md`}
                >
                  <div className="flex items-start gap-3">{photoCol}{contentCol}</div>
                </Link>
              ) : (
                <div key={cf.id} data-cash-flow-id={cf.id} className={cardClass}>
                  <div className="flex items-start gap-3">{photoCol}{contentCol}</div>
                </div>
              );
            })}
            <div ref={sentinelRef} />
          </div>
        )}
      </div>
    </div>
  );
}
