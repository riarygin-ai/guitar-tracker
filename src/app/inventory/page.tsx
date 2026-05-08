'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getBrands, getInventoryItems } from '@/lib/supabase';
import type { Brand, InventoryItem, Status } from '@/types';
import InventoryCard from '@/components/InventoryCard';

const statusOptions: Array<Status | 'all'> = ['all', 'owned', 'listed', 'sold', 'traded'];

export default function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<Status | 'all'>('all');
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
      setItems(itemResult.data || []);
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

      const matchesStatus = filterStatus === 'all' || item.status === filterStatus;
      return matchesSearch && matchesStatus;
    });
  }, [brandMap, filterStatus, items, search]);

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

      <div className="grid gap-4 sm:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium text-slate-700">Search</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search brand or model"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium text-slate-700">Status</span>
                <select
                  value={filterStatus}
                  onChange={(event) => setFilterStatus(event.target.value as Status | 'all')}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                >
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {status === 'all' ? 'All statuses' : status}
                    </option>
                  ))}
                </select>
              </label>
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

        <aside className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm uppercase tracking-[0.24em] text-slate-500">Quick tips</p>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
              <li>Search by brand or model for a fast lookup.</li>
              <li>Filter by status to see owned, listed, sold, or traded items.</li>
              <li>Tap an item card to view details and update it later.</li>
            </ul>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm uppercase tracking-[0.24em] text-slate-500">Statuses</p>
            <div className="mt-4 grid gap-3 text-sm text-slate-700">
              <div className="rounded-2xl bg-green-50 p-3">owned - guitars you currently keep</div>
              <div className="rounded-2xl bg-yellow-50 p-3">listed - guitars currently for sale</div>
              <div className="rounded-2xl bg-slate-50 p-3">sold - finished sales</div>
              <div className="rounded-2xl bg-indigo-50 p-3">traded - item exchanged</div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
