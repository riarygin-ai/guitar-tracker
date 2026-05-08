'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import InventoryForm from '@/components/InventoryForm';
import {
  createDeal,
  createDealItem,
  createCashFlow,
  getBrands,
  getInventoryItemById,
  getLatestCashFlow,
  searchInventoryItems,
} from '@/lib/supabase';
import type { Brand, DealType, Direction, InventoryItem, NewCashFlow, NewDeal, NewDealItem } from '@/types';

const channelOptions = [
  'Kijiji',
  'Marketplace',
  'Reverb',
  'Regular Buyer / Seller',
];

export default function BuyOperationForm() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<InventoryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [dealDate, setDealDate] = useState('');
  const [cashPaid, setCashPaid] = useState('');
  const [channel, setChannel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
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
      const brandResult = await getBrands();
      setLoading(false);

      if (brandResult.error) {
        setError('Could not load brands. Please try again.');
        return;
      }

      setBrands(brandResult.data || []);
    }

    loadData();
  }, []);

  /** Debounced search: queries DB for model/year/color, then also matches brand name client-side */
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
      const result = await searchInventoryItems(value);
      let items = result.data ?? [];

      // Also match items whose brand name matches but model/color/year didn't
      const q = value.trim().toLowerCase();
      const brandMatchIds = brands
        .filter((b) => b.name.toLowerCase().includes(q))
        .map((b) => b.id);

      if (brandMatchIds.length > 0) {
        // Fetch all items (limited) and merge brand-matched ones
        const allResult = await searchInventoryItems('');
        const allItems = allResult.data ?? [];
        const brandMatched = allItems.filter(
          (i) => brandMatchIds.includes(i.brand_id) && !items.some((existing) => existing.id === i.id)
        );
        items = [...items, ...brandMatched];
      }

      setSearchResults(items);
      setHasSearched(true);
      setSearching(false);
    }, 300);
  };

  const handleItemCreated = (item: InventoryItem) => {
    setSelectedItem(item);
    setShowItemForm(false);
    setSuccessMessage('New inventory item created and selected.');
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    const parsedCashPaid = Number(cashPaid);
    const today = new Date().toISOString().slice(0, 10);
    const dealDateValue = dealDate || today;

    if (!cashPaid || Number.isNaN(parsedCashPaid) || parsedCashPaid <= 0) {
      setError('Cash Paid is required and must be greater than 0.');
      return;
    }

    if (!channel) {
      setError('Channel is required.');
      return;
    }

    if (!selectedItem) {
      setError('Inventory item is required.');
      return;
    }

    setSaving(true);

    const dealPayload: NewDeal = {
      deal_type: 'purchase' as DealType,
      deal_date: dealDateValue,
      channel,
      cash_paid: parsedCashPaid,
      cash_received: 0,
      fees: 0,
      notes: null,
    };

    const dealResult = await createDeal(dealPayload);
    if (dealResult.error || !dealResult.data) {
      setSaving(false);
      setError('Could not save purchase deal.');
      return;
    }

    const dealId = dealResult.data.id;
    const itemPayload: NewDealItem = {
      deal_id: dealId,
      item_id: selectedItem.id,
      direction: 'in' as Direction,
      cash_value: parsedCashPaid,
      trade_value: 0,
      total_value: parsedCashPaid,
      notes: null,
    };

    const dealItemResult = await createDealItem(itemPayload);

    if (dealItemResult.error || !dealItemResult.data) {
      setSaving(false);
      setError('Could not save purchase item.');
      return;
    }

    // --- Cash flow record ---
    const itemResult = await getInventoryItemById(selectedItem.id);
    let description = 'Purchase';
    if (itemResult.data) {
      const item = itemResult.data;
      const brandName = brandMap[item.brand_id] ?? '';
      description = ['Purchase', brandName, item.model, item.year, item.color]
        .filter(Boolean)
        .join(' ');
    }

    const latestCfResult = await getLatestCashFlow();
    const openingBalance = latestCfResult.data?.closing_balance ?? 0;
    const cashIn = 0;
    const cashOut = parsedCashPaid;
    const closingBalance = openingBalance - cashOut + cashIn;

    console.log('Cash flow insert:', { openingBalance, closingBalance, description });

    const cfPayload: NewCashFlow = {
      deal_id: dealId,
      transaction_date: dealDateValue,
      opening_balance: openingBalance,
      cash_in: cashIn,
      cash_out: cashOut,
      closing_balance: closingBalance,
      description,
    };

    const cfResult = await createCashFlow(cfPayload);
    setSaving(false);

    if (cfResult.error || !cfResult.data) {
      console.error('Cash flow insert failed:', cfResult.error);
      setError('Purchase saved but could not create cash flow record.');
      return;
    }

    setSuccessMessage('Buy operation saved successfully.');
    setDealDate('');
    setCashPaid('');
    setChannel('');
    setSelectedItem(null);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Operations</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Buy operation</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Record a purchase and create a new inventory item for this operation.
            </p>
          </div>
        </div>
      </div>

      {/* Item Section */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-slate-900">Item</h3>
          <p className="mt-1 text-sm text-slate-600">Search for an existing item or create a new one for this purchase.</p>
        </div>

        {selectedItem ? (
          /* ── Selected item read-only display ── */
          <div className="space-y-4">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Selected item</p>
              <p className="text-sm font-semibold text-slate-900">{formatItemLabel(selectedItem)}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Brand</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">{brandMap[selectedItem.brand_id] ?? 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Model</p>
                  <p className="mt-1 text-sm font-medium text-slate-900">{selectedItem.model}</p>
                </div>
                {selectedItem.year && (
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Year</p>
                    <p className="mt-1 text-sm font-medium text-slate-900">{selectedItem.year}</p>
                  </div>
                )}
                {selectedItem.color && (
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Color</p>
                    <p className="mt-1 text-sm font-medium text-slate-900">{selectedItem.color}</p>
                  </div>
                )}
                {selectedItem.condition && (
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Condition</p>
                    <p className="mt-1 text-sm font-medium text-slate-900">{selectedItem.condition}</p>
                  </div>
                )}
                {selectedItem.estimated_sold_value != null && (
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Estimated Value</p>
                    <p className="mt-1 text-sm font-medium text-slate-900">${selectedItem.estimated_sold_value.toFixed(2)}</p>
                  </div>
                )}
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
              className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Change item
            </button>
          </div>
        ) : showItemForm ? (
          /* ── Add new item form ── */
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <InventoryForm
                onCreated={handleItemCreated}
                hideHeader
                hideSidebar
              />
            </div>
            <button
              type="button"
              onClick={() => setShowItemForm(false)}
              className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          /* ── Search + Add New ── */
          <div className="space-y-4">
            {/* Search input */}
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">Search existing items</label>
              <div className="relative">
                <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search by brand, model, year, or color..."
                  className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                />
                {searching && (
                  <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                  </div>
                )}
              </div>
            </div>

            {/* Search results */}
            {hasSearched && searchResults.length === 0 && (
              <p className="text-sm text-slate-500">No items found matching &ldquo;{searchQuery}&rdquo;</p>
            )}

            {searchResults.length > 0 && (
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-3">
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
                    className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
                  >
                    <p className="text-sm font-medium text-slate-900">{formatItemLabel(item)}</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {item.condition && (
                        <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{item.condition}</span>
                      )}
                      <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{item.item_type}</span>
                      <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{item.status}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Divider + Add New Item */}
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-400">or</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            <button
              type="button"
              onClick={() => setShowItemForm(true)}
              className="inline-flex items-center justify-center rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
            >
              Add new item
            </button>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">Deal date</label>
              <input
                type="date"
                value={dealDate}
                onChange={(event) => setDealDate(event.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
              />
              <p className="text-xs text-slate-500">Optional. If empty, today's date will be used.</p>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">Cash Paid</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={cashPaid}
                  onChange={(event) => setCashPaid(event.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pl-10 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">Channel</label>
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
              >
                <option value="">Select channel</option>
                {channelOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-5 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div>
              <p className="text-sm font-semibold text-slate-900">Buy operation details</p>
              <p className="mt-2 text-sm text-slate-600">
                Create a new inventory item first, then record the purchase deal for this operation.
              </p>
            </div>
            <div className="grid gap-3 text-sm text-slate-600">
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Deal type</p>
                <p className="mt-2 font-medium text-slate-900">Purchase</p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Direction</p>
                <p className="mt-2 font-medium text-slate-900">In</p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Cash received</p>
                <p className="mt-2 font-medium text-slate-900">$0.00</p>
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
              setCashPaid('');
              setChannel('');
              setSelectedItem(null);
              setShowItemForm(false);
              setSearchQuery('');
              setSearchResults([]);
              setHasSearched(false);
              setError(null);
              setSuccessMessage(null);
            }}
            className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {saving ? 'Saving...' : 'Save purchase'}
          </button>
        </div>
      </form>
    </div>
  );
}
