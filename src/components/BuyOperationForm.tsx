'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import InventoryForm from '@/components/InventoryForm';
import {
  createBuyOperation,
  getBrands,
  searchInventoryItems,
  getDisplayPhotosForItems,
} from '@/lib/supabase';
import type { Brand, InventoryItem } from '@/types';

interface LineItem {
  item: InventoryItem;
  cost: number;
}

const channelOptions = [
  'Kijiji',
  'Marketplace',
  'Reverb',
  'Regular Buyer / Seller',
];

export default function BuyOperationForm() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [items, setItems] = useState<LineItem[]>([]);
  const [showNewItemForm, setShowNewItemForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<InventoryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [dealDate, setDealDate] = useState('');
  const [channel, setChannel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((b) => [b.id, b.name])),
    [brands]
  );

  const formatItemLabel = (item: InventoryItem) => {
    const parts: string[] = [];
    if (item.year) parts.push(String(item.year));
    const brandName = brandMap[item.brand_id];
    if (brandName) parts.push(brandName);
    if (item.model) parts.push(item.model);
    const label = parts.join(' ');
    return item.color ? `${label} — ${item.color}` : label;
  };

  useEffect(() => {
    async function loadData() {
      const brandResult = await getBrands();
      if (brandResult.error) {
        setError('Could not load brands. Please try again.');
        return;
      }
      setBrands(brandResult.data || []);
    }
    loadData();
  }, []);

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setHasSearched(false);
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      const result = await searchInventoryItems(value, ['new']);
      setSearchResults(result.data ?? []);
      setHasSearched(true);
      setSearching(false);
      const found = result.data ?? [];
      if (found.length > 0) {
        getDisplayPhotosForItems(found.map((i: { id: number }) => i.id)).then((photos) =>
          setPhotoByItemId((prev) => ({ ...prev, ...photos }))
        );
      }
    }, 300);
  };

  const handleSelectItem = (item: InventoryItem) => {
    if (items.some((li) => li.item.id === item.id)) return;
    setItems((prev) => [...prev, { item, cost: 0 }]);
    clearSearch();
    setError(null);
  };

  const handleRemoveItem = (itemId: number) => {
    setItems((prev) => prev.filter((li) => li.item.id !== itemId));
  };

  const handleCostChange = (itemId: number, value: string) => {
    const num = parseFloat(value);
    setItems((prev) =>
      prev.map((li) => (li.item.id === itemId ? { ...li, cost: isNaN(num) ? 0 : num } : li))
    );
  };

  const handleItemCreated = async (item: InventoryItem) => {
    const brandResult = await getBrands();
    if (!brandResult.error) setBrands(brandResult.data || []);
    handleSelectItem(item);
    setShowNewItemForm(false);
    setSuccessMessage('New inventory item created and added.');
    setError(null);
  };

  const totalCost = items.reduce((sum, li) => sum + li.cost, 0);
  const allHaveEstimated = items.length > 0 && items.every((li) => li.item.estimated_sold_value != null);
  const totalEstimated = allHaveEstimated
    ? items.reduce((sum, li) => sum + (li.item.estimated_sold_value ?? 0), 0)
    : null;
  const potentialReward = totalEstimated != null ? totalEstimated - totalCost : null;
  const potentialRoi =
    potentialReward != null && totalCost === 0 ? (potentialReward > 0 ? 100 : null) :
    potentialReward != null && totalCost > 0 ? (potentialReward / totalCost) * 100 :
    null;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (items.length === 0) {
      setError('At least one item is required.');
      return;
    }
    if (!channel) {
      setError('Channel is required.');
      return;
    }
    for (const li of items) {
      if (li.cost < 0) {
        setError('Item cost cannot be negative.');
        return;
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const dealDateValue = dealDate || today;
    const descParts = items.map((li) =>
      [brandMap[li.item.brand_id], li.item.model].filter(Boolean).join(' ')
    );
    const cfDescription = `Purchase: ${descParts.join(', ')}`;

    setSaving(true);
    const result = await createBuyOperation({
      dealDate: dealDateValue,
      channel,
      incomingItems: items.map((li) => ({ item_id: li.item.id, total_value: li.cost })),
      cfDescription,
    });
    setSaving(false);

    if (result.error) {
      setError('Could not save purchase.');
      return;
    }

    router.push('/operations');
  };

  const fmt = (v: number | null) => (v != null ? `$${v.toFixed(2)}` : '—');
  const fmtPct = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : '—');
  const metricColor = (v: number | null) =>
    v == null
      ? 'text-slate-900 dark:text-slate-100'
      : v > 0 ? 'text-emerald-600'
      : v < 0 ? 'text-rose-600'
      : 'text-slate-900 dark:text-slate-100';

  return (
    <div className="space-y-6">
      {/* Items section */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            Items{items.length > 0 && (
              <span className="ml-1.5 text-slate-500 dark:text-slate-400">({items.length})</span>
            )}
          </h3>
          {!showNewItemForm && (
            <button
              type="button"
              onClick={() => setShowNewItemForm(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Create new
            </button>
          )}
        </div>

        {/* Selected items list — always rendered above search */}
        {items.length > 0 && (
          <div className="mb-4 space-y-3">
            {items.map((li) => (
              <div
                key={li.item.id}
                className="rounded-2xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-700 dark:bg-blue-900/20"
              >
                <div className="flex gap-4">
                  {/* Photo */}
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
                    {photoByItemId[li.item.id] ? (
                      <Image
                        src={photoByItemId[li.item.id]}
                        alt={formatItemLabel(li.item)}
                        fill
                        className="object-cover"
                        unoptimized
                        sizes="64px"
                      />
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-6 w-6 text-slate-300 dark:text-slate-500">
                        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                      </svg>
                    )}
                  </div>

                  {/* Info + cost + remove — stacks on mobile, row on sm+ */}
                  <div className="min-w-0 flex-1 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    {/* Item info */}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">
                        {formatItemLabel(li.item)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {li.item.condition && (
                          <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-600 dark:text-slate-300">
                            {li.item.condition}
                          </span>
                        )}
                        <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-600 dark:text-slate-300">
                          {li.item.item_type}
                        </span>
                      </div>
                      {li.item.estimated_sold_value != null && (
                        <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
                          Est. sold:{' '}
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            ${li.item.estimated_sold_value.toFixed(0)}
                          </span>
                        </p>
                      )}
                    </div>

                    {/* Purchase cost + remove button */}
                    <div className="flex w-full gap-2 sm:w-48">
                      <div className="flex-1">
                        <label className="mb-2 block text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                          Purchase cost
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={li.cost > 0 ? li.cost : ''}
                          onChange={(e) => handleCostChange(li.item.id, e.target.value)}
                          placeholder="0.00"
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-600"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(li.item.id)}
                        aria-label="Remove item"
                        className="mt-7 h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-rose-50 hover:text-rose-600 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Search stays visible after adding items; only replaced by inline create form */}
        {showNewItemForm ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
              <InventoryForm onCreated={handleItemCreated} hideHeader hideSidebar />
            </div>
            <button
              type="button"
              onClick={() => setShowNewItemForm(false)}
              className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={items.length === 0 ? 'Search inventory to add item...' : 'Search to add another item...'}
                className={`w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${searchQuery || searching ? 'pr-9' : 'pr-4'}`}
              />
              {searching ? (
                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                </div>
              ) : searchQuery ? (
                <button
                  type="button"
                  onClick={() => clearSearch()}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              ) : null}
            </div>

            {hasSearched && searchResults.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No items found matching &ldquo;{searchQuery}&rdquo;
              </p>
            )}

            {searchResults.length > 0 && (
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-700">
                {searchResults.map((res) => {
                  const alreadyAdded = items.some((li) => li.item.id === res.id);
                  return (
                    <button
                      key={res.id}
                      type="button"
                      disabled={alreadyAdded}
                      onClick={() => handleSelectItem(res)}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        alreadyAdded
                          ? 'cursor-not-allowed border-slate-100 bg-slate-50 opacity-50 dark:border-slate-600 dark:bg-slate-700'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {photoByItemId[res.id] && (
                          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                            <Image
                              src={photoByItemId[res.id]}
                              alt={formatItemLabel(res)}
                              fill
                              className="object-cover"
                              unoptimized
                              sizes="40px"
                            />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900 dark:text-white">
                            {formatItemLabel(res)}
                          </p>
                          <div className="mt-0.5 flex flex-wrap gap-1.5">
                            {res.condition && (
                              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                                {res.condition}
                              </span>
                            )}
                            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">
                              {res.item_type}
                            </span>
                            {alreadyAdded && (
                              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                already added
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Deal details + summary */}
      <form
        onSubmit={handleSubmit}
        className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800"
      >
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Deal date</label>
              <input
                type="date"
                value={dealDate}
                onChange={(e) => setDealDate(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Optional. If empty, today&apos;s date will be used.
              </p>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              >
                <option value="">Select channel</option>
                {channelOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Summary</p>
            <div className="grid gap-3">
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Items</p>
                <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {items.length === 0 ? '—' : items.length}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Total Cost</p>
                <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {items.length === 0 ? '—' : fmt(totalCost)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Total Est. Sold</p>
                <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                  {fmt(totalEstimated)}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Potential ROI</p>
                <p className={`mt-2 text-sm font-semibold ${metricColor(potentialRoi)}`}>
                  {fmtPct(potentialRoi)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-400">
            {successMessage}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={() => {
              setItems([]);
              setDealDate('');
              setChannel('');
              clearSearch();
              setShowNewItemForm(false);
              setError(null);
              setSuccessMessage(null);
            }}
            className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            {saving ? 'Saving...' : 'Save purchase'}
          </button>
        </div>
      </form>
    </div>
  );
}
