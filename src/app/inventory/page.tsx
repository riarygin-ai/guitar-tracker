'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getBrands, getInventoryItems } from '@/lib/supabase';
import type { Brand, InventoryItemWithValue, Status } from '@/types';
import InventoryCard from '@/components/InventoryCard';

const statusOptions: Array<Status | 'all'> = ['all', 'owned', 'listed', 'sold', 'traded'];

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItemWithValue[]>([])
  const [brands, setBrands] = useState<Brand[]>([]);
  const [search, setSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<Status[]>(['owned', 'listed']);
  const [selectedItemTypes, setSelectedItemTypes] = useState<string[]>(['guitar']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult] = await Promise.all([getBrands(), getInventoryItems()]);

      if (brandResult.error || itemResult.error) {
        setError('Could not load inventory. Please try again.');
        setLoading(false);
        return;
      }

      setBrands(brandResult.data || []);
      setItems((itemResult.data as InventoryItemWithValue[]) || []);
      setLoading(false);
    }

    loadData();
  }, []);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return items.filter((item) => {
      const brandName = brandMap[item.brand_id] ?? 'Unknown';
      const matchesSearch =
        normalizedSearch === '' ||
        brandName.toLowerCase().includes(normalizedSearch) ||
        item.model.toLowerCase().includes(normalizedSearch);

      const matchesStatus =
        selectedStatuses.length === 0 || selectedStatuses.includes(item.status);

      const matchesItemType =
        selectedItemTypes.length === 0 || selectedItemTypes.includes(item.item_type);

      return matchesSearch && matchesStatus && matchesItemType;
    });
  }, [brandMap, selectedStatuses, selectedItemTypes, items, search]);

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Inventory</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">Guitar inventory.</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Browse all guitars, amps, pedals, and cabinets from your collection.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link href="/inventory/new" className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800">
              Add item
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-3xl bg-slate-50 p-4 text-sm">
            <p className="text-slate-500">Total items</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{items.length}</p>
          </div>
          <div className="rounded-3xl bg-slate-50 p-4 text-sm">
            <p className="text-slate-500">Filtered list</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{filteredItems.length}</p>
          </div>
          <div className="rounded-3xl bg-slate-50 p-4 text-sm">
            <p className="text-slate-500">Brands</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{brands.length}</p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">Status</p>

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
                        )
                      }}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${selectedStatuses.includes(status)
                        ? 'bg-slate-950 text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-slate-700">Item Type</p>
                <div className="flex flex-wrap gap-2">
                  {(['guitar', 'amp', 'pedal', 'cab', 'pickups', 'bass', 'prossesor'] as const).map((itemType) => (
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
                          ? 'bg-slate-950 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                    >
                      {itemType}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-500 shadow-sm">
              Loading inventory...
            </div>
          ) : error ? (
            <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700 shadow-sm">
              {error}
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-600 shadow-sm">
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
    </div>
  );
}
