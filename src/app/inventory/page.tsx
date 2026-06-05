'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getBrands, getDealItems, getInventoryItems, getItemAcquisitionDates } from '@/lib/supabase';
import type { Brand, DealItem, InventoryItemWithValue, Status } from '@/types';
import InventoryCard from '@/components/InventoryCard';

const DISPLAY_LIMIT = 100;

export default function InventoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [items, setItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [acquiredDateByItemId, setAcquiredDateByItemId] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initialize filter state from URL params; fall back to defaults
  const [search, setSearch] = useState(() => searchParams.get('search') ?? '');
  const [selectedStatuses, setSelectedStatuses] = useState<Status[]>(() => {
    const s = searchParams.get('status');
    return s ? (s.split(',').filter(Boolean) as Status[]) : ['owned', 'listed'];
  });
  const [selectedItemTypes, setSelectedItemTypes] = useState<string[]>(() => {
    const t = searchParams.get('type');
    return t ? t.split(',').filter(Boolean) : ['guitar'];
  });

  // Keep URL in sync with filter state so links to items carry the current context
  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedItemTypes.length > 0) params.set('type', [...selectedItemTypes].sort().join(','));
    const qs = params.toString();
    router.replace(`/inventory${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [search, selectedStatuses, selectedItemTypes, router]);

  // Query string passed to each card so item URLs carry back-navigation context
  const backQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedStatuses.length > 0) params.set('status', [...selectedStatuses].sort().join(','));
    if (selectedItemTypes.length > 0) params.set('type', [...selectedItemTypes].sort().join(','));
    return params.toString();
  }, [search, selectedStatuses, selectedItemTypes]);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult, dealItemsResult, acquisitionDatesResult] = await Promise.all([
        getBrands(),
        getInventoryItems(),
        getDealItems(),
        getItemAcquisitionDates(),
      ]);

      if (brandResult.error || itemResult.error || dealItemsResult.error) {
        setError('Could not load inventory. Please try again.');
        setLoading(false);
        return;
      }

      setBrands(brandResult.data || []);
      setItems((itemResult.data as InventoryItemWithValue[]) || []);
      setDealItems((dealItemsResult.data as DealItem[]) || []);

      if (!acquisitionDatesResult.error && acquisitionDatesResult.data) {
        const map: Record<number, string> = {};
        for (const row of acquisitionDatesResult.data as any[]) {
          const dealDate = row.deals?.deal_date;
          if (row.item_id != null && dealDate) map[row.item_id] = dealDate;
        }
        setAcquiredDateByItemId(map);
      }

      setLoading(false);
    }

    loadData();
  }, []);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

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

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return itemsWithComputedValues.filter((item) => {
      const brandName = brandMap[item.brand_id] ?? 'Unknown';
      const matchesSearch =
        normalizedSearch === '' ||
        brandName.toLowerCase().includes(normalizedSearch) ||
        item.model.toLowerCase().includes(normalizedSearch) ||
        (item.color ?? '').toLowerCase().includes(normalizedSearch) ||
        String(item.year ?? '').toLowerCase().includes(normalizedSearch) ||
        (item.notes ?? '').toLowerCase().includes(normalizedSearch);

      const matchesStatus =
        selectedStatuses.length === 0 || selectedStatuses.includes(item.status);

      const matchesItemType =
        selectedItemTypes.length === 0 || selectedItemTypes.includes(item.item_type);

      return matchesSearch && matchesStatus && matchesItemType;
    });
  }, [brandMap, itemsWithComputedValues, search, selectedItemTypes, selectedStatuses]);

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
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by brand, model, color, year, or notes"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 sm:w-80"
            />
            <Link
              href="/inventory/new"
              className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
            >
              Add item
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
            <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Status</p>
            <div className="flex flex-wrap gap-2">
              {(['owned', 'listed', 'sold', 'traded'] as Status[]).map((status) => (
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

          <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700">
            <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Item Type</p>
            <div className="flex flex-wrap gap-2">
              {(['guitar', 'amp', 'pedal', 'cab', 'parts', 'bass', 'processor', 'acoustic guitar'] as const).map((itemType) => (
                <button
                  key={itemType}
                  type="button"
                  onClick={() => {
                    setSelectedItemTypes((current) =>
                      current.includes(itemType)
                        ? current.filter((v) => v !== itemType)
                        : [...current, itemType]
                    );
                  }}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    selectedItemTypes.includes(itemType)
                      ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
                  }`}
                >
                  {itemType}
                </button>
              ))}
            </div>
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
            {displayItems.map((item) => (
              <InventoryCard
                key={item.id}
                item={item}
                brandName={brandMap[item.brand_id] ?? 'Unknown'}
                backQuery={backQuery}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
