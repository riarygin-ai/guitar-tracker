'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getBrands, getDealItems, getInventoryItems, getItemAcquisitionDates, getItemCategories, getItemSubtypes, getMainPhotosForItems, getPhotoUrl } from '@/lib/supabase';
import { splitSearchTerms } from '@/lib/search';
import type { Brand, DealItem, InventoryItemWithValue, ItemCategory, ItemSubtype, Status } from '@/types';
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
  const [acquiredDateByItemId, setAcquiredDateByItemId] = useState<Record<number, string>>({});
  const [mainPhotoByItemId, setMainPhotoByItemId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<Status[]>(['owned', 'listed']);
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<string[]>(['Guitars']);
  const [selectedSubtypeNames, setSelectedSubtypeNames] = useState<string[]>([]);

  const isInitializedRef = useRef(false);
  useEffect(() => {
    if (isInitializedRef.current) return;
    const s = searchParams.get('status');
    const cat = searchParams.get('category');
    const sub = searchParams.get('subtype');
    const q = searchParams.get('search');
    setSearch(q ?? '');
    setSelectedStatuses(s ? (s.split(',').filter(Boolean) as Status[]) : ['owned', 'listed']);
    setSelectedCategoryNames(cat ? cat.split(',').filter(Boolean) : ['Guitars']);
    setSelectedSubtypeNames(sub ? sub.split(',').filter(Boolean) : []);
    isInitializedRef.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!isInitializedRef.current) return;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedCategoryNames.length > 0) params.set('category', [...selectedCategoryNames].sort().join(','));
    if (selectedSubtypeNames.length > 0) params.set('subtype', [...selectedSubtypeNames].sort().join(','));
    const qs = params.toString();
    router.replace(`/inventory${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [search, selectedStatuses, selectedCategoryNames, selectedSubtypeNames, router]);

  const backQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedCategoryNames.length > 0) params.set('category', [...selectedCategoryNames].sort().join(','));
    if (selectedSubtypeNames.length > 0) params.set('subtype', [...selectedSubtypeNames].sort().join(','));
    return params.toString();
  }, [search, selectedStatuses, selectedCategoryNames, selectedSubtypeNames]);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult, dealItemsResult, acquisitionDatesResult, catsResult, subsResult] = await Promise.all([
        getBrands(),
        getInventoryItems(),
        getDealItems(),
        getItemAcquisitionDates(),
        getItemCategories(),
        getItemSubtypes(),
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
        const photosResult = await getMainPhotosForItems(itemIds);
        if (!photosResult.error && photosResult.data) {
          const photoMap: Record<number, string> = {};
          for (const row of photosResult.data) {
            photoMap[row.inventory_item_id] = getPhotoUrl(row.storage_path);
          }
          setMainPhotoByItemId(photoMap);
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

  // Map subtype id → subtype name for fast lookup
  const subtypeNameById = useMemo(
    () => Object.fromEntries(allSubtypes.map((s) => [s.id, s.name])),
    [allSubtypes]
  );

  // Map subtype id → category name
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

  const itemsWithComputedValues = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        value_out: valueOutByItemId[item.id] ?? null,
        acquired_date: acquiredDateByItemId[item.id] ?? null,
      })),
    [items, valueOutByItemId, acquiredDateByItemId]
  );

  // Subtype names visible in filter (only those belonging to selected categories)
  const visibleSubtypes = useMemo(() => {
    if (selectedCategoryNames.length === 0) return allSubtypes;
    return allSubtypes.filter((s) => {
      const catName = categoryNameBySubtypeId[s.id] ?? '';
      return selectedCategoryNames.includes(catName);
    });
  }, [allSubtypes, selectedCategoryNames, categoryNameBySubtypeId]);

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

      // Resolve category and subtype names for this item
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

      return matchesSearch && matchesStatus && matchesCategory && matchesSubtype;
    });
  }, [brandMap, itemsWithComputedValues, search, selectedCategoryNames, selectedSubtypeNames, selectedStatuses, subtypeNameById, categoryNameBySubtypeId]);

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

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Inventory</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">Guitar inventory.</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Browse all guitars, amps, pedals, and cabinets from your collection.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full sm:w-80">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search brand, model, serial, color, year, notes"
                className={`w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${search ? 'pr-9' : 'pr-4'}`}
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
            <Link
              href="/inventory/new"
              className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
            >
              Add item
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {/* Status filter */}
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
            <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Status</p>
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
          </div>

          {/* Category + Subtype filter */}
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
            <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Category</p>
            <div className="flex flex-wrap gap-2">
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
                    // Clear subtype selections that no longer belong to a selected category
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
            </div>

            {/* Subtype pills — only show if any category is selected */}
            {selectedCategoryNames.length > 0 && visibleSubtypes.length > 0 && (
              <>
                <p className="mb-2 mt-3 text-sm font-medium text-slate-700 dark:text-slate-200">Type</p>
                <div className="flex flex-wrap gap-2">
                  {visibleSubtypes.filter((s) => s.is_active).map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => {
                        setSelectedSubtypeNames((current) =>
                          current.includes(sub.name)
                            ? current.filter((v) => v !== sub.name)
                            : [...current, sub.name]
                        );
                      }}
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
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
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
          <div className="space-y-4">
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
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
