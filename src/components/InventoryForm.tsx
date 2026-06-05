'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  Brand,
  CollectionType,
  Condition,
  ItemType,
  InventoryItem,
  NewBrand,
  NewInventoryItem,
} from '@/types';
import {
  createBrand,
  createInventoryItem,
  getBrands,
  getInventoryItemById,
  getInventoryItemWithValueById,
  getDealItemsByItemId,
  updateInventoryItem,
} from '@/lib/supabase';

const itemTypeOptions: Array<{ label: string; value: ItemType }> = [
  { label: 'Guitar', value: 'guitar' },
  { label: 'Amp', value: 'amp' },
  { label: 'Cab', value: 'cab' },
  { label: 'Pedal', value: 'pedal' },
  { label: 'Pickups', value: 'pickups' },
  { label: 'Bass', value: 'bass' },
  { label: 'Processor', value: 'processor' },
  { label: 'Acoustic Guitar', value: 'acoustic guitar' },
];

const conditionOptions: Array<{ label: string; value: Condition }> = [
  { label: 'Mint', value: 'Mint' },
  { label: 'Excellent', value: 'Excellent' },
  { label: 'Very Good', value: 'Very Good' },
  { label: 'Good', value: 'Good' },
  { label: 'Fair', value: 'Fair' },
];

const collectionOptions: Array<{ label: string; value: CollectionType }> = [
  { label: 'Personal', value: 'Personal' },
  { label: 'Hybrid', value: 'Hybrid' },
  { label: 'Business', value: 'Business' },
];

interface InventoryFormProps {
  itemId?: string;
  onCreated?: (item: InventoryItem) => void;
  onClose?: () => void;
  hideHeader?: boolean;
  hideSidebar?: boolean;
}

export default function InventoryForm({
  itemId,
  onCreated,
  onClose,
  hideHeader = false,
  hideSidebar = false,
}: InventoryFormProps) {
  const router = useRouter();

  // Form state
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandSuggestions, setBrandSuggestions] = useState<Brand[]>([]);
  const [brandInput, setBrandInput] = useState('');
  const [selectedBrandId, setSelectedBrandId] = useState<number | null>(null);
  const [showBrandSuggestions, setShowBrandSuggestions] = useState(false);
  const [brandSearchLoading, setBrandSearchLoading] = useState(false);
  const [itemType, setItemType] = useState<ItemType>('guitar');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [year, setYear] = useState('');
  const [color, setColor] = useState('');
  const [condition, setCondition] = useState<Condition | ''>('');
  const [collectionType, setCollectionType] = useState<CollectionType | ''>('');
  const [estimatedSoldValue, setEstimatedSoldValue] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingBrand, setCreatingBrand] = useState(false);
  const [existingItem, setExistingItem] = useState<InventoryItem | null>(null);

  // Metrics state (edit mode only)
  const [valueIn, setValueIn] = useState<number | null>(null);
  const [valueOut, setValueOut] = useState<number | null>(null);

  const existingBrand = useMemo(
    () => brands.find((b) => b.name.toLowerCase() === brandInput.trim().toLowerCase()),
    [brandInput, brands],
  );

  // Load all brands on mount
  useEffect(() => {
    async function loadBrands() {
      setLoading(true);
      const result = await getBrands();
      setLoading(false);
      if (result.error) { setError('Could not load brands.'); return; }
      const fetched = result.data || [];
      setBrands(fetched);
      setBrandSuggestions(fetched);
    }
    loadBrands();
  }, []);

  // Brand search debounce
  useEffect(() => {
    if (!brandInput.trim()) { setBrandSuggestions(brands); return; }
    const handler = window.setTimeout(async () => {
      setBrandSearchLoading(true);
      const result = await getBrands(brandInput.trim());
      setBrandSearchLoading(false);
      if (!result.error) setBrandSuggestions(result.data || []);
    }, 250);
    return () => window.clearTimeout(handler);
  }, [brandInput, brands]);

  // Load existing item when editing
  useEffect(() => {
    if (!itemId || brands.length === 0) return;

    async function loadItem() {
      setLoading(true);
      const [itemResult, withValueResult, dealItemsResult] = await Promise.all([
        getInventoryItemById(Number(itemId)),
        getInventoryItemWithValueById(Number(itemId)),
        getDealItemsByItemId(Number(itemId)),
      ]);
      setLoading(false);

      if (itemResult.error || !itemResult.data) {
        setError('Could not load the inventory item.');
        return;
      }

      const item = itemResult.data;
      setExistingItem(item);
      setItemType(item.item_type);
      setModel(item.model);
      setSerialNumber(item.serial_number ?? '');
      setYear(item.year != null ? String(item.year) : '');
      setColor(item.color ?? '');
      setCondition(item.condition ?? '');
      setCollectionType(item.collection_type ?? '');
      setEstimatedSoldValue(item.estimated_sold_value?.toString() ?? '');
      setNotes(item.notes ?? '');
      setSelectedBrandId(item.brand_id);
      const brand = brands.find((b) => b.id === item.brand_id);
      setBrandInput(brand?.name ?? '');

      // Metrics
      if (!withValueResult.error && withValueResult.data) {
        setValueIn((withValueResult.data as any).value_in ?? null);
      }
      if (!dealItemsResult.error && dealItemsResult.data) {
        const outSum = dealItemsResult.data
          .filter((di) => di.direction === 'out')
          .reduce((s, di) => s + Number(di.total_value ?? 0), 0);
        setValueOut(outSum > 0 ? outSum : null);
      }
    }

    loadItem();
  }, [itemId, brands]);

  // Sync selected brand id when user types an existing brand name
  useEffect(() => {
    setSelectedBrandId(existingBrand ? existingBrand.id : null);
  }, [existingBrand]);

  // Sync brand input when brand id is set externally
  useEffect(() => {
    if (!selectedBrandId || brands.length === 0) return;
    const brand = brands.find((b) => b.id === selectedBrandId);
    if (brand) setBrandInput(brand.name);
  }, [selectedBrandId, brands]);

  const handleCreateBrand = async () => {
    if (!brandInput.trim()) { setError('Brand name is required.'); return; }
    setCreatingBrand(true);
    try {
      const result = await createBrand({ name: brandInput.trim() } as NewBrand);
      if (result.error || !result.data) { setError('Could not create brand.'); return; }
      const created = result.data;
      setBrands((prev) => [...prev, created]);
      setSelectedBrandId(created.id);
      setError(null);
      setSuccessMessage('Brand created.');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch {
      setError('An unexpected error occurred.');
    } finally {
      setCreatingBrand(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!model.trim()) { setError('Model is required.'); return; }
    if (!brandInput.trim() && !selectedBrandId) { setError('Brand is required.'); return; }
    if (!itemType) { setError('Item type is required.'); return; }
    if (year) {
      const n = Number(year);
      const max = new Date().getFullYear() + 1;
      if (!Number.isInteger(n) || n < 1900 || n > max) {
        setError(`Year must be between 1900 and ${max}.`);
        return;
      }
    }

    setSaving(true);

    let brandId = selectedBrandId;
    if (!brandId) {
      const brandResult = await createBrand({ name: brandInput.trim() });
      if (brandResult.error || !brandResult.data) {
        setSaving(false);
        setError('Could not create brand.');
        return;
      }
      brandId = brandResult.data.id;
      setBrands((prev) => [...prev, brandResult.data]);
    }

    const payload: NewInventoryItem = {
      brand_id: brandId!,
      item_type: itemType,
      model: model.trim(),
      serial_number: serialNumber.trim() || null,
      year: year ? Number(year) : null,
      color: color.trim() || null,
      condition: condition || null,
      collection_type: collectionType || null,
      estimated_sold_value: estimatedSoldValue ? Number(estimatedSoldValue) : null,
      notes: notes.trim() || null,
      date_listed: null,
      sold_date: null,
      status: existingItem?.status ?? 'owned',
    };

    const result = itemId
      ? await updateInventoryItem(Number(itemId), { id: Number(itemId), ...payload })
      : await createInventoryItem(payload);

    setSaving(false);
    if (result.error || !result.data) { setError('Could not save inventory item.'); return; }

    setSuccessMessage('Inventory item saved successfully.');
    setError(null);

    if (!itemId) {
      if (onCreated) onCreated(result.data);
      setBrandInput('');
      setSelectedBrandId(null);
      setModel('');
      setSerialNumber('');
      setYear('');
      setColor('');
      setCondition('');
      setCollectionType('');
      setEstimatedSoldValue('');
      setNotes('');
    }
  };

  const modelError = Boolean(error?.includes('Model'));
  const brandError = Boolean(error?.includes('Brand'));
  const saveLabel = saving ? 'Saving...' : itemId ? 'Update item' : 'Save item';
  const disabled = loading || saving;
  const brandCreateDisabled = !brandInput.trim() || !!existingBrand || disabled || creatingBrand;

  // Metrics
  const parsedEstimated = estimatedSoldValue ? Number(estimatedSoldValue) : null;
  const potentialReward = parsedEstimated != null && valueIn != null ? parsedEstimated - valueIn : null;
  const realizedGain = valueOut != null && valueIn != null ? valueOut - valueIn : null;
  const isOwned = existingItem?.status === 'owned' || existingItem?.status === 'listed';
  const isSoldOrTraded = existingItem?.status === 'sold' || existingItem?.status === 'traded';
  const showMetrics = !!itemId && !!existingItem && !hideSidebar;
  const fmt = (v: number | null) => (v != null ? `$${v.toFixed(2)}` : '—');

  const inputClass = 'h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100';

  return (
    <div className={hideHeader ? '' : 'min-h-screen bg-slate-50'}>
      <div className={hideHeader ? '' : 'mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8'}>

        {!hideHeader && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs uppercase tracking-[0.35em] text-slate-500">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              {itemId ? 'Update item' : 'Add inventory item'}
            </h1>
          </div>
        )}

        {loading && (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            Loading...
          </div>
        )}

        <div className={`gap-6 ${showMetrics ? 'lg:grid lg:grid-cols-3' : ''}`}>
          {/* Main form card */}
          <div className={showMetrics ? 'lg:col-span-2' : ''}>
            <form onSubmit={handleSubmit} aria-busy={disabled}>
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="grid gap-5 sm:grid-cols-2">

                  {/* Item type */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">
                      Item type <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={itemType}
                      onChange={(e) => setItemType(e.target.value as ItemType)}
                      disabled={disabled}
                      className={inputClass}
                    >
                      {itemTypeOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Brand */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">
                      Brand <span className="text-rose-500">*</span>
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          value={brandInput}
                          onChange={(e) => { setBrandInput(e.target.value); setShowBrandSuggestions(true); }}
                          onFocus={() => setShowBrandSuggestions(true)}
                          onBlur={() => window.setTimeout(() => setShowBrandSuggestions(false), 120)}
                          disabled={disabled}
                          placeholder="Search or add brand"
                          className={`min-w-0 w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-slate-100 ${
                            brandError ? 'border-rose-300 bg-rose-50 focus:border-rose-400' : 'border-slate-200 bg-white focus:border-slate-400'
                          }`}
                        />
                        {brandSearchLoading && (
                          <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">
                            Searching...
                          </div>
                        )}
                        {showBrandSuggestions && brandSuggestions.length > 0 && (
                          <ul className="absolute left-0 right-0 z-20 mt-1 max-h-52 overflow-auto rounded-2xl border border-slate-200 bg-white text-sm shadow-lg">
                            {brandSuggestions.map((brand) => (
                              <li
                                key={brand.id}
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  setBrandInput(brand.name);
                                  setSelectedBrandId(brand.id);
                                  setShowBrandSuggestions(false);
                                }}
                                className="cursor-pointer px-3 py-2 text-slate-700 hover:bg-slate-100"
                              >
                                {brand.name}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleCreateBrand(); }}
                        disabled={brandCreateDisabled}
                        className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {creatingBrand ? 'Creating...' : 'Create'}
                      </button>
                    </div>
                  </div>

                  {/* Model */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="block text-sm font-medium text-slate-700">
                      Model <span className="text-rose-500">*</span>
                    </label>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      disabled={disabled}
                      placeholder="e.g. Stratocaster"
                      className={`w-full rounded-xl border px-3 py-2 text-sm text-slate-900 outline-none transition focus:ring-2 focus:ring-slate-100 ${
                        modelError ? 'border-rose-300 bg-rose-50 focus:border-rose-400' : 'border-slate-200 bg-white focus:border-slate-400'
                      }`}
                    />
                  </div>

                  {/* Year */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">Year</label>
                    <input
                      type="number"
                      min="1900"
                      max={new Date().getFullYear() + 1}
                      value={year}
                      onChange={(e) => setYear(e.target.value)}
                      disabled={disabled}
                      placeholder="e.g. 2023"
                      className={inputClass}
                    />
                  </div>

                  {/* Color */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">Color</label>
                    <input
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      disabled={disabled}
                      placeholder="e.g. Seafoam Green"
                      className={inputClass}
                    />
                  </div>

                  {/* Serial number */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">Serial number</label>
                    <input
                      value={serialNumber}
                      onChange={(e) => setSerialNumber(e.target.value)}
                      disabled={disabled}
                      placeholder="e.g. MX22345678"
                      className={inputClass}
                    />
                  </div>

                  {/* Condition */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">Condition</label>
                    <select
                      value={condition}
                      onChange={(e) => setCondition(e.target.value as Condition)}
                      disabled={disabled}
                      className={inputClass}
                    >
                      <option value="">Choose condition</option>
                      {conditionOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Collection */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">Purpose / collection</label>
                    <select
                      value={collectionType}
                      onChange={(e) => setCollectionType(e.target.value as CollectionType)}
                      disabled={disabled}
                      className={inputClass}
                    >
                      <option value="">Choose type</option>
                      {collectionOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>

                  {/* Estimated sold value */}
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium text-slate-700">Estimated sold value</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={estimatedSoldValue}
                        onChange={(e) => setEstimatedSoldValue(e.target.value)}
                        disabled={disabled}
                        placeholder="0.00"
                        className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-7 pr-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                      />
                    </div>
                    <p className="text-xs text-slate-500">Estimated values help track potential returns.</p>
                  </div>

                  {/* Notes */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="block text-sm font-medium text-slate-700">Notes</label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      disabled={disabled}
                      placeholder="Add any additional notes..."
                      rows={3}
                      className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                    />
                  </div>
                </div>

                {error && (
                  <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                    {error}
                  </div>
                )}
                {successMessage && (
                  <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
                    {successMessage}
                  </div>
                )}

                <div className="mt-6 hidden lg:flex lg:items-center lg:justify-end lg:gap-3">
                  <button
                    type="button"
                    onClick={() => { if (onClose) { onClose(); return; } router.push('/inventory'); }}
                    className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-6 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={disabled}
                    className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    {saveLabel}
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Value metrics card (edit only) */}
          {showMetrics && (
            <div className="mt-6 lg:col-span-1 lg:mt-0">
              <div className="sticky top-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-900">Value metrics</h3>
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Value In</span>
                    <span className="text-sm font-medium text-slate-900">{fmt(valueIn)}</span>
                  </div>

                  {isOwned && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-slate-600">Estimated Sold</span>
                        <span className="text-sm font-medium text-slate-900">{fmt(parsedEstimated)}</span>
                      </div>
                      <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                        <span className="text-sm font-medium text-slate-700">Potential Reward</span>
                        <span className={`text-sm font-semibold ${
                          potentialReward != null && potentialReward > 0 ? 'text-emerald-600' :
                          potentialReward != null && potentialReward < 0 ? 'text-rose-600' :
                          'text-slate-900'
                        }`}>
                          {fmt(potentialReward)}
                        </span>
                      </div>
                    </>
                  )}

                  {isSoldOrTraded && (
                    <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                      <span className="text-sm font-medium text-slate-700">Realized Gain</span>
                      <span className={`text-sm font-semibold ${
                        realizedGain != null && realizedGain > 0 ? 'text-emerald-600' :
                        realizedGain != null && realizedGain < 0 ? 'text-rose-600' :
                        'text-slate-900'
                      }`}>
                        {fmt(realizedGain)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Mobile sticky footer */}
        {!hideHeader && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-4 backdrop-blur-sm lg:hidden">
            <div className="mx-auto flex max-w-6xl items-center gap-3">
              <button
                type="button"
                onClick={() => router.push('/inventory')}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                onClick={() => document.querySelector('form')?.requestSubmit()}
                disabled={disabled}
                className="flex-1 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {saveLabel}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
