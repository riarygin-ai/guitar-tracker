'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import InventoryForm from '@/components/InventoryForm';
import {
  createSellOperation,
  getBrands,
  getDealChannels,
  getInventoryItemWithValueById,
  getInventoryExpensesByItemIds,
  searchInventoryItems,
  getDisplayPhotosForItems,
} from '@/lib/supabase';
import type { Brand, DealChannel, InventoryItem } from '@/types';

export default function SellOperationForm() {
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [channels, setChannels] = useState<DealChannel[]>([]);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<InventoryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [dealDate, setDealDate] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [channelId, setChannelId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [valueIn, setValueIn] = useState<number | null>(null);
  const [totalExpenses, setTotalExpenses] = useState(0);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

  /** Format an item as "2023 PRS CE 24 — Seafoam Green" */
  const formatItemLabel = (item: InventoryItem) => {
    const parts: string[] = [];
    if (item.year) parts.push(String(item.year));
    const brandName = brandMap[item.brand_id];
    if (brandName) parts.push(brandName);
    if (item.model) parts.push(item.model);
    const label = parts.join(' ');
    if (item.color) return `${label} — ${item.color}`;
    return label;
  };

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, channelResult] = await Promise.all([getBrands(), getDealChannels()]);
      setLoading(false);

      if (brandResult.error) {
        setError('Could not load brands. Please try again.');
        return;
      }

      setBrands(brandResult.data || []);
      setChannels((channelResult.data as DealChannel[] | null) ?? []);
    }

    loadData();
  }, []);

  useEffect(() => {
    if (!selectedItem) { setValueIn(null); setTotalExpenses(0); return; }
    getInventoryItemWithValueById(selectedItem.id).then((r) => {
      if (!r.error && r.data) setValueIn((r.data as any).value_in ?? null);
      else setValueIn(null);
    });
    getInventoryExpensesByItemIds([selectedItem.id]).then((r) => {
      if (!r.error && r.data) setTotalExpenses(r.data.reduce((sum, exp) => sum + exp.amount, 0));
      else setTotalExpenses(0);
    });
  }, [selectedItem]);

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
      const result = await searchInventoryItems(value, ['owned', 'listed']);
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

  const handleItemCreated = async (item: InventoryItem) => {
    const brandResult = await getBrands();
    if (!brandResult.error) setBrands(brandResult.data || []);
    setSelectedItem(item);
    setShowItemForm(false);
    setSuccessMessage('New inventory item created and selected.');
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const parsedCashReceived = Number(cashReceived);
    const today = new Date().toISOString().slice(0, 10);
    const dealDateValue = dealDate || today;

    if (!cashReceived || Number.isNaN(parsedCashReceived) || parsedCashReceived <= 0) {
      setError('Cash received is required and must be greater than 0.');
      return;
    }

    if (!channelId) {
      setError('Channel is required.');
      return;
    }

    if (!selectedItem) {
      setError('Inventory item is required.');
      return;
    }

    setSaving(true);

    const brandName = brandMap[selectedItem.brand_id] ?? '';
    const description = [brandName, selectedItem.model].filter(Boolean).join(' ');
    const cfDescription = description ? `Sale: ${description}` : 'Sale';

    const result = await createSellOperation({
      dealDate: dealDateValue,
      cashReceived: parsedCashReceived,
      channelId: channelId!,
      itemId: selectedItem.id,
      cfDescription,
    });

    setSaving(false);

    if (result.error) {
      setError('Could not save sale.');
      return;
    }

    router.push('/operations');
  };

  const valueOutNum = Number(cashReceived) || 0;
  const realizedGain = valueIn != null ? valueOutNum - valueIn - totalExpenses : null;
  const realizedRoi =
    realizedGain != null && valueIn === 0 ? (realizedGain > 0 ? 100 : null) :
    realizedGain != null && valueIn != null && valueIn > 0 ? (realizedGain / valueIn) * 100 :
    null;
  const fmt = (v: number | null) => v != null ? `$${v.toFixed(2)}` : '—';
  const fmtPct = (v: number | null) => v != null ? `${v.toFixed(2)}%` : '—';
  const metricColor = (v: number | null) =>
    v == null ? 'text-slate-900 dark:text-slate-100' : v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-slate-900 dark:text-slate-100';

  return (
    <div className="space-y-6">
      {/* Item Section */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Item</h3>
          {!selectedItem && !showItemForm && (
            <button
              type="button"
              onClick={() => setShowItemForm(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span className="hidden sm:inline">Add item</span>
            </button>
          )}
        </div>

        {selectedItem ? (
          /* ── Selected item read-only display ── */
          <div className="space-y-4">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 dark:border-emerald-700 dark:bg-emerald-900/20">
              <div className="flex gap-4">
                {photoByItemId[selectedItem.id] && (
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
                    <Image src={photoByItemId[selectedItem.id]} alt={formatItemLabel(selectedItem)} fill className="object-cover" unoptimized sizes="80px" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">Selected item</p>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white">{formatItemLabel(selectedItem)}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Brand</p>
                      <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{brandMap[selectedItem.brand_id] ?? 'Unknown'}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Model</p>
                      <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{selectedItem.model}</p>
                    </div>
                    {selectedItem.year && (
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Year</p>
                        <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{selectedItem.year}</p>
                      </div>
                    )}
                    {selectedItem.color && (
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Color</p>
                        <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{selectedItem.color}</p>
                      </div>
                    )}
                    {selectedItem.condition && (
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Condition</p>
                        <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">{selectedItem.condition}</p>
                      </div>
                    )}
                    {selectedItem.estimated_sold_value != null && (
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">Est. Value</p>
                        <p className="mt-1 text-sm font-medium text-slate-900 dark:text-slate-100">${selectedItem.estimated_sold_value.toFixed(2)}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedItem(null);
                setShowItemForm(false);
                setSearchQuery('');
                setSearchResults([]);
                setHasSearched(false);
              }}
              className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
              Change item
            </button>
          </div>
        ) : showItemForm ? (
          /* ── Add new item form ── */
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
              <InventoryForm
                onCreated={handleItemCreated}
                onClose={() => setShowItemForm(false)}
                hideHeader
                hideSidebar
              />
            </div>
            <button
              type="button"
              onClick={() => setShowItemForm(false)}
              className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
              Cancel
            </button>
          </div>
        ) : (
          /* ── Search + Add New ── */
          <div className="space-y-4">
            {/* Search input */}
            <div className="relative">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search inventory..."
                  className={`w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600 ${searchQuery || searching ? 'pr-9' : 'pr-4'}`}
                />
                {searching ? (
                  <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                  </div>
                ) : searchQuery ? (
                  <button
                    type="button"
                    onClick={() => handleSearchChange('')}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                ) : null}
            </div>

            {/* Search results */}
            {hasSearched && searchResults.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400">No items found matching &ldquo;{searchQuery}&rdquo;</p>
            )}

            {searchResults.length > 0 && (
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-600 dark:bg-slate-700">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedItem(item);
                      setSearchQuery('');
                      setSearchResults([]);
                      setHasSearched(false);
                      setSuccessMessage(null);
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                  >
                    <div className="flex items-center gap-3">
                      {photoByItemId[item.id] && (
                        <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-600">
                          <Image src={photoByItemId[item.id]} alt={formatItemLabel(item)} fill className="object-cover" unoptimized sizes="48px" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 dark:text-white">{formatItemLabel(item)}</p>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {item.condition && (
                            <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">{item.condition}</span>
                          )}
                          <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">{item.item_type}</span>
                          <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-500 dark:text-slate-200">{item.status}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Deal date</label>
              <input
                type="date"
                value={dealDate}
                onChange={(event) => setDealDate(event.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">Optional. If empty, today&apos;s date will be used.</p>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Sold for</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={cashReceived}
                  onChange={(event) => setCashReceived(event.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pl-10 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Channel</label>
              <select
                value={channelId ?? ''}
                onChange={(event) => setChannelId(event.target.value ? Number(event.target.value) : null)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
              >
                <option value="">Select channel</option>
                {channels.filter((c) => c.is_active).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-4 rounded-3xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-600 dark:bg-slate-700">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Value metrics</p>
            <div className="grid gap-3">
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Value In</p>
                <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">{fmt(valueIn)}</p>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Value Out</p>
                <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">{valueOutNum > 0 ? fmt(valueOutNum) : '—'}</p>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Realized Profit</p>
                <p className={`mt-2 text-sm font-semibold ${metricColor(realizedGain)}`}>{fmt(realizedGain)}</p>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-slate-600">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Realized ROI</p>
                <p className={`mt-2 text-sm font-semibold ${metricColor(realizedRoi)}`}>{fmtPct(realizedRoi)}</p>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
            {successMessage}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={() => {
              setDealDate('');
              setCashReceived('');
              setChannelId(null);
              setSelectedItem(null);
              setShowItemForm(false);
              setSearchQuery('');
              setSearchResults([]);
              setHasSearched(false);
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
            {saving ? 'Saving...' : 'Save sale'}
          </button>
        </div>
      </form>
    </div>
  );
}
