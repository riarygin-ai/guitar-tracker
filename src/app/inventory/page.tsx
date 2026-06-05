'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getBrands, getDealItems, getInventoryItems } from '@/lib/supabase';
import type { Brand, DealItem, InventoryItemWithValue, Status } from '@/types';
import InventoryCard from '@/components/InventoryCard';

const statusOptions: Array<Status | 'all'> = ['all', 'owned', 'listed', 'sold', 'traded'];

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItemWithValue[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<Status[]>(['owned', 'listed']);
  const [selectedItemTypes, setSelectedItemTypes] = useState<string[]>(['guitar']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult, dealItemsResult] = await Promise.all([
        getBrands(),
        getInventoryItems(),
        getDealItems(),
      ]);

      if (brandResult.error || itemResult.error || dealItemsResult.error) {
        setError('Could not load inventory. Please try again.');
        setLoading(false);
        return;
      }

      setBrands(brandResult.data || []);
      setItems((itemResult.data as InventoryItemWithValue[]) || []);
      setDealItems((dealItemsResult.data as DealItem[]) || []);
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
      dealItems.reduce<Record<number, number>>((accumulator, dealItem) => {
        if (dealItem.direction === 'out' && dealItem.total_value != null) {
          accumulator[dealItem.item_id] = (accumulator[dealItem.item_id] ?? 0) + Number(dealItem.total_value);
        }
        return accumulator;
      }, {}),
    [dealItems]
  );

  const itemsWithComputedValues = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        value_out: valueOutByItemId[item.id] ?? null,
      })),
    [items, valueOutByItemId]
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
                        ? current.filter((value) => value !== status)
                        : [...current, status]
                    );
                  }}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${selectedStatuses.includes(status)
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
                        ? current.filter((value) => value !== itemType)
                        : [...current, itemType]
                    );
                  }}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${selectedItemTypes.includes(itemType)
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
        ) : filteredItems.length === 0 ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            No inventory items match your filters.
          </div>
        ) : (
          <div className="space-y-4">
            {filteredItems.map((item) => (
              <InventoryCard key={item.id} item={item} brandName={brandMap[item.brand_id] ?? 'Unknown'} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
