'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getBrands, getDealItems, getInventoryItems, getInventoryExpenses, getItemAcquisitionDates, getItemCategories, getItemPurposes, getItemSubtypes, getMainPhotosForItems, getPhotoUrl, getTags, getTagsForItems } from '@/lib/supabase';
import { splitSearchTerms } from '@/lib/search';
import type { Brand, DealItem, InventoryExpense, InventoryItemWithValue, InventoryTag, ItemCategory, ItemPurpose, ItemSubtype, Status } from '@/types';
import InventoryCard from '@/components/InventoryCard';
import MoreFiltersToggle from '@/components/MoreFiltersToggle';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';

const BATCH_SIZE = 30;
const SESSION_KEY = 'inventory-list-state';

const LEGACY_TYPE_TO_CATEGORY: Record<string, string> = {
  guitar: 'Guitars',
  bass: 'Guitars',
  'acoustic guitar': 'Guitars',
  amp: 'Amps',
  cab: 'Amps',
  processor: 'Amps',
  pedal: 'Pedals',
  parts: 'Parts',
  pickups: 'Parts',
};

const LEGACY_TYPE_TO_SUBTYPE_NAME: Record<string, string> = {
  guitar: 'Electric Guitar',
  bass: 'Bass',
  'acoustic guitar': 'Acoustic Guitar',
  amp: 'Amp',
  cab: 'Cabinet',
  processor: 'Processor',
  pedal: 'Pedal',
  parts: 'Parts',
  pickups: 'Pickups',
};

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

// Module-level: set when a card is clicked, consumed on next mount.
// Lives outside React so Next.js router.push cannot overwrite it
// (unlike window.history.state which Next.js replaces before pushState).
let _invClickTs = 0;

export default function InventoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [items, setItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [allSubtypes, setAllSubtypes] = useState<ItemSubtype[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [expenses, setExpenses] = useState<InventoryExpense[]>([]);
  const [acquiredDateByItemId, setAcquiredDateByItemId] = useState<Record<number, string>>({});
  const [mainPhotoByItemId, setMainPhotoByItemId] = useState<Record<number, string>>({});
  const [allTags, setAllTags] = useState<InventoryTag[]>([]);
  const [tagsByItemId, setTagsByItemId] = useState<Record<number, InventoryTag[]>>({});
  const [allPurposes, setAllPurposes] = useState<ItemPurpose[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<Status[]>(['owned', 'listed']);
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<string[]>(['Guitars']);
  const [selectedSubtypeNames, setSelectedSubtypeNames] = useState<string[]>([]);
  const [showSubtypes, setShowSubtypes] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [tagFilterSearch, setTagFilterSearch] = useState('');
  const [tagFilterFocused, setTagFilterFocused] = useState(false);
  const [selectedPurposeIds, setSelectedPurposeIds] = useState<number[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);

  const [renderCount, setRenderCount] = useState(BATCH_SIZE);
  const [isRestoring, setIsRestoring] = useState(false);
  const restoredAnchorIdRef = useRef<number | null>(null);
  const restoredScrollYRef = useRef<number>(0);
  const restoredLoadedCountRef = useRef<number>(BATCH_SIZE);
  // Ref mirrors isRestoring so filterSig effect can read it without being in its deps
  const isRestoringRef = useRef(false);
  const isFirstFilterRef = useRef(true);

  // On browser Back: read saved state and prepare restoration
  useEffect(() => {
    const currentUrl = window.location.pathname + window.location.search;
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { url: string; loadedCount: number; scrollY: number; anchorId: number; timestamp: number };
      const clickAge = Date.now() - _invClickTs;
      if (!_invClickTs || clickAge > 60 * 60 * 1000) { _invClickTs = 0; return; }
      _invClickTs = 0;
      const urlMatches = savedUrlMatchesCurrent(s.url, currentUrl);
      if (!urlMatches) return;
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

  const isInitializedRef = useRef(false);
  useEffect(() => {
    if (isInitializedRef.current) return;
    const s = searchParams.get('status');
    const cat = searchParams.get('category');
    // 'subtype' is the canonical param; 'type' is an alias from dashboard drill-down
    const sub = searchParams.get('subtype') ?? searchParams.get('type');
    const purposeParam = searchParams.get('purpose_id');
    const tagParam = searchParams.get('tag_id');
    const q = searchParams.get('search');
    setSearch(q ?? '');
    setSelectedStatuses(s ? (s.split(',').filter(Boolean) as Status[]) : ['owned', 'listed']);
    // When drilling in via type/subtype/purpose_id without an explicit category, clear the default
    const hasDrilldown = !cat && (searchParams.has('type') || searchParams.has('subtype') || searchParams.has('purpose_id'));
    setSelectedCategoryNames(cat ? cat.split(',').filter(Boolean) : (hasDrilldown ? [] : ['Guitars']));
    setSelectedSubtypeNames(sub ? sub.split(',').filter(Boolean) : []);
    setSelectedPurposeIds(purposeParam ? purposeParam.split(',').map(Number).filter(Boolean) : []);
    setSelectedTagIds(tagParam ? tagParam.split(',').map(Number).filter(Boolean) : []);
    if (purposeParam || tagParam) setShowMoreFilters(true);
    isInitializedRef.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!isInitializedRef.current) return;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedCategoryNames.length > 0) params.set('category', [...selectedCategoryNames].sort().join(','));
    if (selectedSubtypeNames.length > 0) params.set('subtype', [...selectedSubtypeNames].sort().join(','));
    if (selectedPurposeIds.length > 0) params.set('purpose_id', [...selectedPurposeIds].sort((a, b) => a - b).join(','));
    if (selectedTagIds.length > 0) params.set('tag_id', [...selectedTagIds].sort((a, b) => a - b).join(','));
    const qs = params.toString();
    router.replace(`/inventory${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [search, selectedStatuses, selectedCategoryNames, selectedSubtypeNames, selectedPurposeIds, selectedTagIds, router]);

  const backQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedCategoryNames.length > 0) params.set('category', [...selectedCategoryNames].sort().join(','));
    if (selectedSubtypeNames.length > 0) params.set('subtype', [...selectedSubtypeNames].sort().join(','));
    if (selectedPurposeIds.length > 0) params.set('purpose_id', [...selectedPurposeIds].sort((a, b) => a - b).join(','));
    if (selectedTagIds.length > 0) params.set('tag_id', [...selectedTagIds].sort((a, b) => a - b).join(','));
    return params.toString();
  }, [search, selectedStatuses, selectedCategoryNames, selectedSubtypeNames, selectedPurposeIds, selectedTagIds]);

  // Reset display window when any filter changes (skip the very first run and any run during restoration)
  const filterSig = `${search}|${selectedStatuses.join(',')}|${selectedCategoryNames.join(',')}|${selectedSubtypeNames.join(',')}|${selectedPurposeIds.join(',')}|${selectedTagIds.join(',')}`;
  useEffect(() => {
    if (isFirstFilterRef.current) { isFirstFilterRef.current = false; return; }
    // Do not cancel restoration when URL-param initialization triggers a filterSig change on mount
    if (isRestoringRef.current) return;
    sessionStorage.removeItem(SESSION_KEY);
    setRenderCount(BATCH_SIZE);
    setIsRestoring(false);
  }, [filterSig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult, dealItemsResult, acquisitionDatesResult, catsResult, subsResult, expensesResult, tagsResult, purposesResult] = await Promise.all([
        getBrands(),
        getInventoryItems(),
        getDealItems(),
        getItemAcquisitionDates(),
        getItemCategories(),
        getItemSubtypes(),
        getInventoryExpenses(),
        getTags(),
        getItemPurposes(),
      ]);

      if (brandResult.error || itemResult.error || dealItemsResult.error) {
        setError('Could not load inventory. Please try again.');
        setLoading(false);
        return;
      }

      setBrands(brandResult.data || []);
      const loadedItems = (itemResult.data as InventoryItemWithValue[]) || [];
      setItems(loadedItems);
      setDealItems((dealItemsResult.data as DealItem[]) || []);
      setCategories((catsResult.data as ItemCategory[]) || []);
      setAllSubtypes((subsResult.data as ItemSubtype[]) || []);
      setExpenses((expensesResult.data as InventoryExpense[]) || []);

      const tagsData = (!tagsResult.error ? (tagsResult.data ?? []) : []) as InventoryTag[];
      setAllTags(tagsData);
      if (!purposesResult.error) setAllPurposes((purposesResult.data ?? []) as ItemPurpose[]);
      const tagById = Object.fromEntries(tagsData.map((t) => [t.id, t]));

      if (!acquisitionDatesResult.error && acquisitionDatesResult.data) {
        const map: Record<number, string> = {};
        for (const row of acquisitionDatesResult.data as any[]) {
          const dealDate = row.deals?.deal_date;
          if (row.item_id != null && dealDate) map[row.item_id] = dealDate;
        }
        setAcquiredDateByItemId(map);
      }

      if (loadedItems.length > 0) {
        const itemIds = loadedItems.map((i) => i.id);
        const [photosResult, itemTagsResult] = await Promise.all([
          getMainPhotosForItems(itemIds),
          getTagsForItems(itemIds),
        ]);
        if (!photosResult.error && photosResult.data) {
          const photoMap: Record<number, string> = {};
          for (const row of photosResult.data) {
            photoMap[row.inventory_item_id] = getPhotoUrl(row.storage_path);
          }
          setMainPhotoByItemId(photoMap);
        }
        if (!itemTagsResult.error && itemTagsResult.data) {
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

      setLoading(false);
    }

    loadData();
  }, []);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

  const subtypeNameById = useMemo(
    () => Object.fromEntries(allSubtypes.map((s) => [s.id, s.name])),
    [allSubtypes]
  );

  const categoryNameBySubtypeId = useMemo(() => {
    const catById = Object.fromEntries(categories.map((c) => [c.id, c.name]));
    return Object.fromEntries(allSubtypes.map((s) => [s.id, catById[s.category_id] ?? '']));
  }, [allSubtypes, categories]);

  const valueOutByItemId = useMemo(
    () =>
      dealItems.reduce<Record<number, number>>((acc, di) => {
        if (di.direction === 'out' && di.total_value != null) {
          acc[di.item_id] = (acc[di.item_id] ?? 0) + Number(di.total_value);
        }
        return acc;
      }, {}),
    [dealItems]
  );

  const expensesByItemId = useMemo(
    () =>
      expenses.reduce<Record<number, number>>((acc, exp) => {
        if (exp.item_id != null) {
          acc[exp.item_id] = (acc[exp.item_id] ?? 0) + exp.amount;
        }
        return acc;
      }, {}),
    [expenses]
  );

  const itemsWithComputedValues = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        value_out: valueOutByItemId[item.id] ?? null,
        acquired_date: acquiredDateByItemId[item.id] ?? null,
      })),
    [items, valueOutByItemId, acquiredDateByItemId]
  );

  const summaryStats = useMemo(() => {
    const activeItems = items.filter((i) => i.status === 'owned' || i.status === 'listed');
    const totalValue = activeItems.reduce((sum, i) => sum + (i.estimated_sold_value ?? i.value_in ?? 0), 0);
    const totalCost = activeItems.reduce((sum, i) => sum + (i.value_in ?? 0), 0);
    return {
      count: items.length,
      totalValue,
      equity: totalValue - totalCost,
    };
  }, [items]);

  const visibleSubtypes = useMemo(() => {
    if (selectedCategoryNames.length === 0) return allSubtypes;
    return allSubtypes.filter((s) => {
      const catName = categoryNameBySubtypeId[s.id] ?? '';
      return selectedCategoryNames.includes(catName);
    });
  }, [allSubtypes, selectedCategoryNames, categoryNameBySubtypeId]);

  const activePurposes = useMemo(() => allPurposes.filter((p) => p.is_active), [allPurposes]);

  const activeTags = useMemo(() => allTags.filter((t) => t.is_active), [allTags]);

  const filteredTagOptions = useMemo(
    () =>
      activeTags.filter(
        (t) =>
          !selectedTagIds.includes(t.id) &&
          (tagFilterSearch.length === 0 || t.name.toLowerCase().includes(tagFilterSearch.toLowerCase()))
      ),
    [activeTags, selectedTagIds, tagFilterSearch]
  );

  const hiddenFilterCount = selectedPurposeIds.length + selectedTagIds.length;

  const hasActiveFilters =
    search.length > 0 ||
    selectedStatuses.length > 0 ||
    selectedCategoryNames.length > 0 ||
    selectedSubtypeNames.length > 0 ||
    selectedPurposeIds.length > 0 ||
    selectedTagIds.length > 0;

  function clearFilters() {
    setSearch('');
    setSelectedStatuses([]);
    setSelectedCategoryNames([]);
    setSelectedSubtypeNames([]);
    setSelectedPurposeIds([]);
    setSelectedTagIds([]);
    setTagFilterSearch('');
  }

  const filteredItems = useMemo(() => {
    const searchTerms = splitSearchTerms(search);

    return itemsWithComputedValues.filter((item) => {
      const brandName = brandMap[item.brand_id] ?? 'Unknown';
      const matchesSearch =
        searchTerms.length === 0 ||
        searchTerms.every((term) =>
          brandName.toLowerCase().includes(term) ||
          item.model.toLowerCase().includes(term) ||
          (item.color ?? '').toLowerCase().includes(term) ||
          String(item.year ?? '').toLowerCase().includes(term) ||
          (item.serial_number ?? '').toLowerCase().includes(term) ||
          (item.notes ?? '').toLowerCase().includes(term)
        );

      const matchesStatus =
        selectedStatuses.length === 0 || selectedStatuses.includes(item.status);

      let itemCategoryName: string;
      let itemSubtypeName: string;
      if (item.item_subtype_id != null) {
        itemSubtypeName = subtypeNameById[item.item_subtype_id] ?? '';
        itemCategoryName = categoryNameBySubtypeId[item.item_subtype_id] ?? '';
      } else {
        const legacy = item.item_type.toLowerCase();
        itemCategoryName = LEGACY_TYPE_TO_CATEGORY[legacy] ?? '';
        itemSubtypeName = LEGACY_TYPE_TO_SUBTYPE_NAME[legacy] ?? item.item_type;
      }

      const matchesCategory =
        selectedCategoryNames.length === 0 || selectedCategoryNames.includes(itemCategoryName);

      const matchesSubtype =
        selectedSubtypeNames.length === 0 || selectedSubtypeNames.includes(itemSubtypeName);

      const matchesPurpose =
        selectedPurposeIds.length === 0 ||
        (item.purpose_id != null && selectedPurposeIds.includes(item.purpose_id));

      const itemTagIds = (tagsByItemId[item.id] ?? []).map((t) => t.id);
      const matchesTags =
        selectedTagIds.length === 0 ||
        selectedTagIds.every((tid) => itemTagIds.includes(tid));

      return matchesSearch && matchesStatus && matchesCategory && matchesSubtype && matchesPurpose && matchesTags;
    });
  }, [brandMap, itemsWithComputedValues, search, selectedCategoryNames, selectedSubtypeNames, selectedStatuses, subtypeNameById, categoryNameBySubtypeId, selectedPurposeIds, selectedTagIds, tagsByItemId]);

  const sortedFilteredItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      const aDate = a.acquired_date ?? null;
      const bDate = b.acquired_date ?? null;
      if (aDate === null && bDate === null) return 0;
      if (aDate === null) return 1;
      if (bDate === null) return -1;
      return bDate.localeCompare(aDate);
    });
  }, [filteredItems]);

  const totalFilteredCount = sortedFilteredItems.length;

  // Complete restoration once all required items are rendered
  useEffect(() => {
    if (!isRestoring || loading) return;
    const enoughRendered =
      renderCount >= restoredLoadedCountRef.current || totalFilteredCount <= renderCount;
    if (!enoughRendered) return;

    const anchorId = restoredAnchorIdRef.current;
    const el = anchorId != null
      ? document.querySelector(`[data-item-id="${anchorId}"]`)
      : null;

    // Double-rAF: ensures browser has painted the newly rendered items and any
    // Next.js layout-effect scroll restoration has already run before we scroll.
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
  }, [isRestoring, loading, renderCount, totalFilteredCount, items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function saveListState(anchorId: number) {
    _invClickTs = Date.now();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      url: window.location.pathname + window.location.search,
      loadedCount: renderCount,
      scrollY: window.scrollY,
      anchorId,
      timestamp: Date.now(),
    }));
  }

  const displayItems = sortedFilteredItems.slice(0, renderCount);
  const hasMore = sortedFilteredItems.length > renderCount;

  const loadMore = useCallback(() => setRenderCount((c) => c + BATCH_SIZE), []);
  const sentinelRef = useInfiniteScroll(loadMore, { hasMore, isLoading: loading, disabled: isRestoring });

  const fmtCurrency = (v: number) => `$${Math.round(v).toLocaleString()}`;

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* Header: label + [+] button */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="page-overline">Inventory</p>
            {!loading && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {summaryStats.count} items · Total Value {fmtCurrency(summaryStats.totalValue)} · Equity {fmtCurrency(summaryStats.equity)}
              </p>
            )}
          </div>
          <Link
            href="/inventory/new"
            title="Add inventory item"
            aria-label="Add inventory item"
            className="rounded-xl border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </Link>
        </div>

        {/* Search */}
        <div className="relative mt-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search inventory..."
            className={`w-full rounded-2xl border border-slate-200 bg-slate-50 py-2.5 pl-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${search ? 'pr-9' : 'pr-4'}`}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>

        {/* Filters — Status + Category in one card */}
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700/50">
          <p className="mb-2 section-label">Status</p>
          <div className="flex flex-wrap gap-2">
            {(['new', 'owned', 'listed', 'sold', 'traded'] as Status[]).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => {
                  setSelectedStatuses((current) =>
                    current.includes(status)
                      ? current.filter((v) => v !== status)
                      : [...current, status]
                  );
                }}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  selectedStatuses.includes(status)
                    ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                }`}
              >
                {status}
              </button>
            ))}
          </div>

          <p className="mb-2 mt-4 section-label">Category</p>
          <div className="flex flex-wrap items-center gap-2">
            {categories.filter((c) => c.is_active).map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => {
                  setSelectedCategoryNames((current) =>
                    current.includes(cat.name)
                      ? current.filter((v) => v !== cat.name)
                      : [...current, cat.name]
                  );
                  setSelectedSubtypeNames((current) => {
                    const nextCats = selectedCategoryNames.includes(cat.name)
                      ? selectedCategoryNames.filter((v) => v !== cat.name)
                      : [...selectedCategoryNames, cat.name];
                    return current.filter((subName) => {
                      const sub = allSubtypes.find((s) => s.name === subName);
                      if (!sub) return false;
                      const subCatName = categoryNameBySubtypeId[sub.id] ?? '';
                      return nextCats.includes(subCatName);
                    });
                  });
                }}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                  selectedCategoryNames.includes(cat.name)
                    ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                }`}
              >
                {cat.name}
              </button>
            ))}

            {/* Subtypes toggle — only when a category is selected and it has subtypes */}
            {selectedCategoryNames.length > 0 && visibleSubtypes.length > 0 && (
              <button
                type="button"
                onClick={() => setShowSubtypes((v) => !v)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  showSubtypes
                    ? 'border-slate-400 bg-slate-200 text-slate-800 dark:border-slate-500 dark:bg-slate-600 dark:text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700/80 dark:text-slate-300 dark:hover:bg-slate-600'
                }`}
              >
                Types
                {selectedSubtypeNames.length > 0 && (
                  <span className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-slate-700 px-1 text-[10px] font-bold text-white dark:bg-slate-200 dark:text-slate-900">
                    {selectedSubtypeNames.length}
                  </span>
                )}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`shrink-0 transition-transform duration-150 ${showSubtypes ? 'rotate-180' : ''}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
          </div>

          {/* Subtypes chip row — visible only when panel is open */}
          {showSubtypes && selectedCategoryNames.length > 0 && visibleSubtypes.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 section-label">Types</p>
              <div className="flex flex-wrap gap-2">
                {visibleSubtypes.map((sub) => (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() =>
                      setSelectedSubtypeNames((current) =>
                        current.includes(sub.name)
                          ? current.filter((v) => v !== sub.name)
                          : [...current, sub.name]
                      )
                    }
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                      selectedSubtypeNames.includes(sub.name)
                        ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                    }`}
                  >
                    {sub.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <MoreFiltersToggle
            isOpen={showMoreFilters}
            onToggle={() => setShowMoreFilters((v) => !v)}
            count={hiddenFilterCount}
            hasActiveFilters={hasActiveFilters}
            onClear={clearFilters}
          >
            {/* Purpose */}
            {activePurposes.length > 0 && (
              <div>
                <p className="mb-2 section-label">Purpose</p>
                <div className="flex flex-wrap gap-2">
                  {activePurposes.map((purpose) => (
                    <button
                      key={purpose.id}
                      type="button"
                      onClick={() =>
                        setSelectedPurposeIds((current) =>
                          current.includes(purpose.id)
                            ? current.filter((v) => v !== purpose.id)
                            : [...current, purpose.id]
                        )
                      }
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                        selectedPurposeIds.includes(purpose.id)
                          ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                      }`}
                    >
                      {purpose.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tags — searchable multi-select */}
            <div>
              <p className="mb-2 section-label">Tags</p>

              {selectedTagIds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {selectedTagIds.map((tid) => {
                    const tag = allTags.find((t) => t.id === tid);
                    if (!tag) return null;
                    return (
                      <span
                        key={tid}
                        className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-900"
                      >
                        {tag.name}
                        <button
                          type="button"
                          onClick={() => setSelectedTagIds((c) => c.filter((id) => id !== tid))}
                          aria-label={`Remove ${tag.name} filter`}
                          className="ml-0.5 rounded-full opacity-70 hover:opacity-100"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              <input
                type="text"
                value={tagFilterSearch}
                onChange={(e) => setTagFilterSearch(e.target.value)}
                onFocus={() => setTagFilterFocused(true)}
                onBlur={() => setTimeout(() => setTagFilterFocused(false), 150)}
                placeholder="Search tags..."
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              />

              {(tagFilterFocused || tagFilterSearch.length > 0) && (
                filteredTagOptions.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {filteredTagOptions.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        onMouseDown={() => {
                          setSelectedTagIds((c) => [...c, tag.id]);
                          setTagFilterSearch('');
                        }}
                        className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500"
                      >
                        + {tag.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                    {tagFilterSearch.length > 0 ? 'No tags match.' : 'All tags selected.'}
                  </p>
                )
              )}
            </div>
          </MoreFiltersToggle>
        </div>
      </div>

      <div className="space-y-3">
        {loading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            Loading inventory...
          </div>
        ) : error ? (
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700 shadow-sm">
            {error}
          </div>
        ) : sortedFilteredItems.length === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            No inventory items match your filters.
          </div>
        ) : (
          <div className="space-y-3">
            {sortedFilteredItems.length > BATCH_SIZE && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Showing {displayItems.length} of {sortedFilteredItems.length}
              </p>
            )}
            {displayItems.map((item) => {
              const subtypeName = item.item_subtype_id != null
                ? subtypeNameById[item.item_subtype_id]
                : undefined;
              return (
                <InventoryCard
                  key={item.id}
                  item={item}
                  brandName={brandMap[item.brand_id] ?? 'Unknown'}
                  backQuery={backQuery}
                  mainPhotoUrl={mainPhotoByItemId[item.id] ?? null}
                  subtypeName={subtypeName}
                  totalExpenses={expensesByItemId[item.id] ?? 0}
                  onBeforeNavigate={() => saveListState(item.id)}
                />
              );
            })}
            <div ref={sentinelRef} />
          </div>
        )}
      </div>
    </div>
  );
}
