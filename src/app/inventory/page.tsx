'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getBrands, getDealItems, getInventoryItems, getInventoryExpenses, getItemAcquisitionDates, getItemCategories, getItemSubtypes, getMainPhotosForItems, getPhotoUrl, getTags, getTagsForItems } from '@/lib/supabase';
import { splitSearchTerms } from '@/lib/search';
import type { Brand, DealItem, InventoryExpense, InventoryItemWithValue, InventoryTag, ItemCategory, ItemSubtype, Status } from '@/types';
import InventoryCard from '@/components/InventoryCard';

const DISPLAY_LIMIT = 100;

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<Status[]>(['owned', 'listed']);
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<string[]>(['Guitars']);
  const [selectedSubtypeNames, setSelectedSubtypeNames] = useState<string[]>([]);
  const [showSubtypes, setShowSubtypes] = useState(false);
  const [selectedPurposes, setSelectedPurposes] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);

  const isInitializedRef = useRef(false);
  useEffect(() => {
    if (isInitializedRef.current) return;
    const s = searchParams.get('status');
    const cat = searchParams.get('category');
    // 'subtype' is the canonical param; 'type' is an alias from dashboard drill-down
    const sub = searchParams.get('subtype') ?? searchParams.get('type');
    const purpose = searchParams.get('purpose');
    const tagParam = searchParams.get('tag_id');
    const q = searchParams.get('search');
    setSearch(q ?? '');
    setSelectedStatuses(s ? (s.split(',').filter(Boolean) as Status[]) : ['owned', 'listed']);
    // When drilling in via type/subtype/purpose without an explicit category, clear the default
    const hasDrilldown = !cat && (searchParams.has('type') || searchParams.has('subtype') || searchParams.has('purpose'));
    setSelectedCategoryNames(cat ? cat.split(',').filter(Boolean) : (hasDrilldown ? [] : ['Guitars']));
    setSelectedSubtypeNames(sub ? sub.split(',').filter(Boolean) : []);
    setSelectedPurposes(purpose ? purpose.split(',').filter(Boolean) : []);
    setSelectedTagIds(tagParam ? tagParam.split(',').map(Number).filter(Boolean) : []);
    isInitializedRef.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!isInitializedRef.current) return;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedCategoryNames.length > 0) params.set('category', [...selectedCategoryNames].sort().join(','));
    if (selectedSubtypeNames.length > 0) params.set('subtype', [...selectedSubtypeNames].sort().join(','));
    if (selectedPurposes.length > 0) params.set('purpose', [...selectedPurposes].sort().join(','));
    if (selectedTagIds.length > 0) params.set('tag_id', [...selectedTagIds].sort((a, b) => a - b).join(','));
    const qs = params.toString();
    router.replace(`/inventory${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [search, selectedStatuses, selectedCategoryNames, selectedSubtypeNames, selectedPurposes, selectedTagIds, router]);

  const backQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedCategoryNames.length > 0) params.set('category', [...selectedCategoryNames].sort().join(','));
    if (selectedSubtypeNames.length > 0) params.set('subtype', [...selectedSubtypeNames].sort().join(','));
    if (selectedPurposes.length > 0) params.set('purpose', [...selectedPurposes].sort().join(','));
    if (selectedTagIds.length > 0) params.set('tag_id', [...selectedTagIds].sort((a, b) => a - b).join(','));
    return params.toString();
  }, [search, selectedStatuses, selectedCategoryNames, selectedSubtypeNames, selectedPurposes, selectedTagIds]);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult, dealItemsResult, acquisitionDatesResult, catsResult, subsResult, expensesResult, tagsResult] = await Promise.all([
        getBrands(),
        getInventoryItems(),
        getDealItems(),
        getItemAcquisitionDates(),
        getItemCategories(),
        getItemSubtypes(),
        getInventoryExpenses(),
        getTags(),
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

  const availablePurposes = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => set.add((item.collection_type as string | null) ?? 'Unassigned'));
    return Array.from(set).sort();
  }, [items]);

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
        selectedPurposes.length === 0 ||
        selectedPurposes.includes((item.collection_type as string | null) ?? 'Unassigned');

      const itemTagIds = (tagsByItemId[item.id] ?? []).map((t) => t.id);
      const matchesTags =
        selectedTagIds.length === 0 ||
        selectedTagIds.every((tid) => itemTagIds.includes(tid));

      return matchesSearch && matchesStatus && matchesCategory && matchesSubtype && matchesPurpose && matchesTags;
    });
  }, [brandMap, itemsWithComputedValues, search, selectedCategoryNames, selectedSubtypeNames, selectedStatuses, subtypeNameById, categoryNameBySubtypeId, selectedPurposes, selectedTagIds, tagsByItemId]);

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

  const displayItems = sortedFilteredItems.slice(0, DISPLAY_LIMIT);
  const hasMore = sortedFilteredItems.length > DISPLAY_LIMIT;

  const fmtCurrency = (v: number) => `$${Math.round(v).toLocaleString()}`;

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* Header: label + [+] button */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Inventory</p>
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
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Status</p>
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

          <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Category</p>
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
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Types</p>
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

          {/* Purpose filter */}
          {availablePurposes.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Purpose</p>
              <div className="flex flex-wrap gap-2">
                {availablePurposes.map((purpose) => (
                  <button
                    key={purpose}
                    type="button"
                    onClick={() =>
                      setSelectedPurposes((current) =>
                        current.includes(purpose)
                          ? current.filter((v) => v !== purpose)
                          : [...current, purpose]
                      )
                    }
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                      selectedPurposes.includes(purpose)
                        ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                    }`}
                  >
                    {purpose}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tag filter */}
          {allTags.filter((t) => t.is_active).length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Tags</p>
              <div className="flex flex-wrap gap-2">
                {allTags.filter((t) => t.is_active).map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      setSelectedTagIds((current) =>
                        current.includes(tag.id)
                          ? current.filter((v) => v !== tag.id)
                          : [...current, tag.id]
                      )
                    }
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                      selectedTagIds.includes(tag.id)
                        ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                    }`}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            {hasMore && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Showing first {DISPLAY_LIMIT} items.
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
                  tags={tagsByItemId[item.id]}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
