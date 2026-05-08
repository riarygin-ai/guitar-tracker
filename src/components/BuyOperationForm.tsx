'use client';

import { useEffect, useMemo, useState } from 'react';
import InventoryForm from '@/components/InventoryForm';
import {
  createDeal,
  createDealItem,
  getBrands,
  getInventoryItems,
} from '@/lib/supabase';
import type { Brand, DealType, Direction, InventoryItem, NewDeal, NewDealItem } from '@/types';

const channelOptions = [
  'Kijiji',
  'Marketplace',
  'Reverb',
  'Regular Buyer / Seller',
];

export default function BuyOperationForm() {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [dealDate, setDealDate] = useState('');
  const [cashPaid, setCashPaid] = useState('');
  const [channel, setChannel] = useState('');
  const [showNewItem, setShowNewItem] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

  const itemOptions = useMemo(
    () =>
      items.map((item) => ({
        id: item.id,
        label: `${brandMap[item.brand_id] ?? 'Unknown'} ${item.model}`,
      })),
    [items, brandMap]
  );

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [brandResult, itemResult] = await Promise.all([getBrands(), getInventoryItems()]);
      setLoading(false);

      if (brandResult.error || itemResult.error) {
        setError('Could not load inventory items. Please try again.');
        return;
      }

      setBrands(brandResult.data || []);
      setItems(itemResult.data || []);
    }

    loadData();
  }, []);

  const handleItemCreated = (item: InventoryItem) => {
    setItems((current) => [...current, item]);
    setSelectedItemId(item.id);
    setShowNewItem(false);
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

    if (!selectedItemId) {
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
      item_id: selectedItemId,
      direction: 'in' as Direction,
      cash_value: parsedCashPaid,
      trade_value: 0,
      total_value: parsedCashPaid,
      notes: null,
    };

    const dealItemResult = await createDealItem(itemPayload);
    setSaving(false);

    if (dealItemResult.error || !dealItemResult.data) {
      setError('Could not save purchase item.');
      return;
    }

    setSuccessMessage('Buy operation saved successfully.');
    setDealDate('');
    setCashPaid('');
    setChannel('');
    setSelectedItemId(null);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Operations</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Buy operation</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Record a purchase and attach an inventory item. You can select an existing item or add a new one.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowNewItem((current) => !current)}
            className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            {showNewItem ? 'Close new item form' : 'Add New Item'}
          </button>
        </div>
      </div>

      {showNewItem && (
        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
          <InventoryForm
            onCreated={handleItemCreated}
            onClose={() => setShowNewItem(false)}
            hideHeader
            hideSidebar
          />
        </div>
      )}

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

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">Inventory item</label>
              <select
                value={selectedItemId ?? ''}
                onChange={(event) => setSelectedItemId(Number(event.target.value) || null)}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
              >
                <option value="">Select existing inventory item</option>
                {itemOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-5 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div>
              <p className="text-sm font-semibold text-slate-900">Buy operation details</p>
              <p className="mt-2 text-sm text-slate-600">
                Record a single purchase deal and attach one inventory item to this operation.
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
              setSelectedItemId(null);
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
