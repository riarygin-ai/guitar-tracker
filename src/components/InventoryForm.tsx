'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brand,
  CollectionType,
  Condition,
  Deal,
  Direction,
  ItemType,
  InventoryItem,
  NewBrand,
  NewInventoryItem,
  NewDealItem,
  NewDeal,
  Status,
} from '@/types';
import {
  createBrand,
  createInventoryItem,
  getBrands,
  getInventoryItemById,
  updateInventoryItem,
} from '@/lib/supabase';

const itemTypeOptions: Array<{ label: string; value: ItemType }> = [
  { label: 'Guitar', value: 'guitar' },
  { label: 'Amp', value: 'amp' },
  { label: 'Cab', value: 'cab' },
  { label: 'Pedal', value: 'pedal' },
  { label: 'Pickups', value: 'pickups' },
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

const acquisitionChannelOptions = [
  'Kijiji',
  'Marketplace',
  'Reverb',
  'Regular Buyer / Seller',
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
  console.log('InventoryForm itemId:', itemId);
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandSuggestions, setBrandSuggestions] = useState<Brand[]>([]);
  const [brandInput, setBrandInput] = useState('');
  const [selectedBrandId, setSelectedBrandId] = useState<number | null>(null);
  const [showBrandSuggestions, setShowBrandSuggestions] = useState(false);
  const [brandSearchLoading, setBrandSearchLoading] = useState(false);
  const [itemType, setItemType] = useState<ItemType>('guitar');
  const [model, setModel] = useState('');
  const [dateAcquired, setDateAcquired] = useState('');
  const [estimatedSoldValue, setEstimatedSoldValue] = useState('');
  const [condition, setCondition] = useState<Condition | ''>('');
  const [collectionType, setCollectionType] = useState<CollectionType | ''>('');
  const [acquisitionChannel, setAcquisitionChannel] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingBrand, setCreatingBrand] = useState(false);

  const currentDate = useMemo(() => {
    return new Date().toISOString().slice(0, 10);
  }, []);

  const existingBrand = useMemo(
    () => brands.find((brand) => brand.name.toLowerCase() === brandInput.trim().toLowerCase()),
    [brandInput, brands]
  );

  useEffect(() => {
    async function loadBrands() {
      setLoading(true);
      const result = await getBrands();
      setLoading(false);
      if (result.error) {
        setError('Could not load brands.');
        return;
      }
      const fetchedBrands = result.data || [];
      setBrands(fetchedBrands);
      setBrandSuggestions(fetchedBrands);
    }

    loadBrands();
  }, []);

  useEffect(() => {
    if (!brandInput.trim()) {
      setBrandSuggestions(brands);
      return;
    }

    const handler = window.setTimeout(async () => {
      setBrandSearchLoading(true);
      const result = await getBrands(brandInput.trim());
      setBrandSearchLoading(false);
      if (result.error) {
        setError('Could not search brands.');
        return;
      }
      setBrandSuggestions(result.data || []);
    }, 250);

    return () => window.clearTimeout(handler);
  }, [brandInput, brands]);

  useEffect(() => {
    if (!itemId || brands.length === 0) {
      return;
    }

    async function loadItem() {
      console.log('Loading item with id:', itemId);
      setLoading(true);
      const result = await getInventoryItemById(Number(itemId));
      setLoading(false);
      if (result.error || !result.data) {
        setError('Could not load the inventory item.');
        return;
      }
      const item = result.data;
      console.log('Loaded item:', item);
      setItemType(item.item_type);
      setModel(item.model);
      setDateAcquired(item.date_acquired ? item.date_acquired.slice(0, 10) : '');
      setEstimatedSoldValue(item.estimated_sold_value?.toString() ?? '');
      setCondition(item.condition ?? '');
      setCollectionType(item.collection_type ?? '');
      setSelectedBrandId(item.brand_id);
      // Find the brand name from loaded brands
      const brand = brands.find((b) => b.id === item.brand_id);
      setBrandInput(brand ? brand.name : '');
      setNotes(item.notes ?? '');
      console.log('Form values after population:', {
        itemType: item.item_type,
        model: item.model,
        dateAcquired: item.date_acquired ? item.date_acquired.slice(0, 10) : '',
        estimatedSoldValue: item.estimated_sold_value?.toString() ?? '',
        condition: item.condition ?? '',
        collectionType: item.collection_type ?? '',
        selectedBrandId: item.brand_id,
        brandInput: brand ? brand.name : '',
        notes: item.notes ?? ''
      });
    }

    loadItem();
  }, [itemId, brands]);

  useEffect(() => {
    if (!existingBrand) {
      setSelectedBrandId(null);
      return;
    }

    setSelectedBrandId(existingBrand.id);
  }, [existingBrand]);

  useEffect(() => {
    if (!selectedBrandId || brands.length === 0) {
      return;
    }

    const brand = brands.find((b) => b.id === selectedBrandId);
    if (brand) {
      setBrandInput(brand.name);
    }
  }, [selectedBrandId, brands]);

  const handleCreateBrand = async () => {
    if (!brandInput.trim()) {
      setError('Brand name is required to create a new brand.');
      return;
    }

    setCreatingBrand(true);

    try {
      const brandPayload: NewBrand = { name: brandInput.trim() };
      const result = await createBrand(brandPayload);

      if (result.error || !result.data) {
        setError('Could not create brand.');
        return;
      }

      const created = result.data;
      setBrands((current) => [...current, created]);
      setSelectedBrandId(created.id);
      setError(null);
      setSuccessMessage('Brand created successfully!');
      
      // Reset success message after 3 seconds
      setTimeout(() => {
        setSuccessMessage(null);
      }, 3000);
      
    } catch (error) {
      setError('An unexpected error occurred while creating the brand.');
    } finally {
      setCreatingBrand(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!model.trim()) {
      setError('Model is required.');
      return;
    }

    if (!brandInput.trim() && !selectedBrandId) {
      setError('Brand is required.');
      return;
    }

    if (!itemType) {
      setError('Item type is required.');
      return;
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
      setBrands((current) => [...current, brandResult.data]);
    }

    const payload: NewInventoryItem = {
      brand_id: brandId!,
      item_type: itemType,
      model: model.trim(),
      date_acquired: dateAcquired || currentDate,
      estimated_sold_value: estimatedSoldValue ? Number(estimatedSoldValue) : null,
      condition: condition || null,
      collection_type: collectionType || null,
      date_listed: null,
      sold_date: null,
      status: 'owned',
      notes: notes.trim() || null,
    };

    // TODO: save acquisitionChannel into deals / deal_items when we add acquisition tracking.
    const result = itemId
      ? await updateInventoryItem({ id: Number(itemId), ...payload })
      : await createInventoryItem(payload);

    setSaving(false);
    if (result.error || !result.data) {
      setError('Could not save inventory item.');
      return;
    }

    const createdItem = result.data;
    setSuccessMessage('Inventory item saved successfully.');
    setError(null);
    if (!itemId && onCreated) {
      onCreated(createdItem);
    }

    if (!itemId) {
      setBrandInput('');
      setSelectedBrandId(null);
      setModel('');
      setDateAcquired('');
      setEstimatedSoldValue('');
      setCondition('');
      setCollectionType('');
      setAcquisitionChannel('');
      setNotes('');
    }
  };

  const modelError = Boolean(error?.includes('Model'));
  const brandError = Boolean(error?.includes('Brand'));
  const saveLabel = saving ? 'Saving...' : itemId ? 'Update item' : 'Save item';
  const disabled = loading || saving;
  const brandCreateDisabled = !brandInput.trim() || !!existingBrand || disabled || creatingBrand;

  return (
    <div className={hideHeader ? '' : 'min-h-screen bg-slate-50'}>
      <div className={hideHeader ? '' : 'mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8'}>
        {/* Header */}
        {!hideHeader && (
          <div className="mb-8">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs uppercase tracking-[0.35em] text-slate-500">Inventory</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                {itemId ? 'Update item' : 'Add inventory item'}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                Enter the details for this guitar or gear item. The form is optimized for both mobile and desktop experiences.
              </p>
            </div>
          </div>
        )}

        {loading && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600 shadow-sm">
            Loading inventory details...
          </div>
        )}

        {/* Desktop: 2-column layout, Mobile: single column */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Form */}
          <div className="lg:col-span-2">
            <form onSubmit={handleSubmit} className="space-y-6" aria-busy={disabled}>
              {/* Basic Info Section */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">Basic Info</h2>
                  <p className="mt-1 text-sm text-slate-600">Core details for this inventory item.</p>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">
                      Item type <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={itemType}
                      onChange={(event) => setItemType(event.target.value as ItemType)}
                      disabled={disabled}
                      className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                    >
                      {itemTypeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">
                      Brand <span className="text-rose-500">*</span>
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          value={brandInput}
                          onChange={(event) => {
                            setBrandInput(event.target.value);
                            setShowBrandSuggestions(true);
                          }}
                          onFocus={() => setShowBrandSuggestions(true)}
                          onBlur={() => {
                            window.setTimeout(() => setShowBrandSuggestions(false), 120);
                          }}
                          disabled={disabled}
                          placeholder="Search or add brand"
                          className={`min-w-0 w-full rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-slate-100 ${
                            brandError ? 'border-rose-300 bg-rose-50 focus:border-rose-400' : 'border-slate-200 bg-white focus:border-slate-400'
                          }`}
                        />
                        {brandSearchLoading && (
                          <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">
                            Searching...
                          </div>
                        )}

                        {showBrandSuggestions && brandSuggestions.length > 0 && (
                          <ul className="absolute left-0 right-0 z-20 mt-1 max-h-56 overflow-auto rounded-2xl border border-slate-200 bg-white text-sm shadow-lg">
                            {brandSuggestions.map((brand) => (
                              <li
                                key={brand.id}
                                onMouseDown={(event) => {
                                  event.preventDefault();
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
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleCreateBrand();
                        }}
                        disabled={brandCreateDisabled}
                        className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                      >
                        {creatingBrand ? 'Creating...' : 'Create'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-500">
                      Start typing to search brands, or create a new one if it doesn't exist.
                    </p>
                  </div>
                </div>

                <div className="mt-6 space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    Model <span className="text-rose-500">*</span>
                  </label>
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    disabled={disabled}
                    placeholder="Fender Stratocaster"
                    className={`w-full rounded-xl border px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:ring-2 focus:ring-slate-100 ${
                      modelError ? 'border-rose-300 bg-rose-50 focus:border-rose-400' : 'border-slate-200 bg-white focus:border-slate-400'
                    }`}
                  />
                  <p className="text-xs text-slate-500">Use a short model name for faster scanning.</p>
                </div>
              </div>

              {/* Acquisition Section */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">Acquisition</h2>
                  <p className="mt-1 text-sm text-slate-600">When and how you acquired this item.</p>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">Date acquired</label>
                    <input
                      type="date"
                      value={dateAcquired}
                      onChange={(event) => setDateAcquired(event.target.value)}
                      disabled={disabled}
                      className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">Acquisition channel</label>
                    <select
                      value={acquisitionChannel}
                      onChange={(event) => setAcquisitionChannel(event.target.value)}
                      disabled={disabled}
                      className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                    >
                      <option value="">Select channel</option>
                      {acquisitionChannelOptions.map((channel) => (
                        <option key={channel} value={channel}>
                          {channel}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Listing / Sale Section */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">Listing & Sale</h2>
                  <p className="mt-1 text-sm text-slate-600">Current status and condition information.</p>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">Condition</label>
                    <select
                      value={condition}
                      onChange={(event) => setCondition(event.target.value as Condition)}
                      disabled={disabled}
                      className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                    >
                      <option value="">Choose condition</option>
                      {conditionOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">Purpose / collection</label>
                    <select
                      value={collectionType}
                      onChange={(event) => setCollectionType(event.target.value as CollectionType)}
                      disabled={disabled}
                      className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                    >
                      <option value="">Choose type</option>
                      {collectionOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Financials Section */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">Financials</h2>
                  <p className="mt-1 text-sm text-slate-600">Estimated values to help track potential returns.</p>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-slate-700">Estimated sold value</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={estimatedSoldValue}
                        onChange={(event) => setEstimatedSoldValue(event.target.value)}
                        disabled={disabled}
                        placeholder="0.00"
                        className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-7 pr-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Notes Section */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-6">
                  <h2 className="text-lg font-semibold text-slate-900">Notes</h2>
                  <p className="mt-1 text-sm text-slate-600">Additional details about this item.</p>
                </div>

                <div className="space-y-2">
                  <textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    disabled={disabled}
                    placeholder="Add any additional notes about this item..."
                    rows={4}
                    className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                </div>
              </div>

              {/* Error/Success Messages */}
              {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                  {error}
                </div>
              )}
              {successMessage && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
                  {successMessage}
                </div>
              )}

              {/* Desktop Action Buttons */}
              <div className="hidden lg:flex lg:items-center lg:justify-end lg:gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (onClose) {
                      onClose();
                      return;
                    }
                    router.push('/inventory');
                  }}
                  className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-6 text-sm font-medium text-slate-900 transition hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={disabled}
                  className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  {saveLabel}
                </button>
              </div>
            </form>
          </div>

          {!hideSidebar && (
            <div className="hidden lg:block lg:col-span-1">
              <div className="sticky top-6 space-y-6">
              {/* Status Summary */}
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-900">Item Summary</h3>
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">Status</span>
                    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
                      Owned
                    </span>
                  </div>
                  {estimatedSoldValue && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-600">Est. Value</span>
                      <span className="text-sm font-medium text-slate-900">
                        ${Number(estimatedSoldValue).toLocaleString()}
                      </span>
                    </div>
                  )}
                  {dateAcquired && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-600">Acquired</span>
                      <span className="text-sm font-medium text-slate-900">
                        {new Date(dateAcquired).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                  {condition && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-600">Condition</span>
                      <span className="text-sm font-medium text-slate-900">{condition}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Quick Tips */}
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-900">Quick Tips</h3>
                <ul className="mt-3 space-y-2 text-xs text-slate-600">
                  <li>• Use clear, descriptive model names</li>
                  <li>• Set realistic estimated values</li>
                  <li>• Keep notes brief but informative</li>
                  <li>• Regular condition updates help tracking</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

        {!hideHeader && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-4 backdrop-blur-sm lg:hidden">
            <div className="mx-auto flex max-w-7xl items-center gap-3">
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
