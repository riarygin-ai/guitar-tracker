'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ItemPhotos, { type ItemPhotosHandle } from '@/components/ItemPhotos';
import type {
  Brand,
  CollectionType,
  Condition,
  ItemCategory,
  ItemSubtype,
  ItemType,
  InventoryItem,
  NewBrand,
  NewInventoryItem,
} from '@/types';
import {
  createBrand,
  createInventoryItem,
  getBrands,
  getItemCategories,
  getItemSubtypes,
  getInventoryItemById,
  getInventoryItemWithValueById,
  getDealItemsByItemId,
  getMainPhotosForItems,
  getPhotoUrl,
  updateInventoryItem,
} from '@/lib/supabase';

const SUBTYPE_TO_LEGACY_TYPE: Record<string, ItemType> = {
  'Electric Guitar': 'guitar',
  'Bass': 'bass',
  'Acoustic Guitar': 'acoustic guitar',
  'Amp': 'amp',
  'Cabinet': 'cab',
  'Processor': 'processor',
  'Pedal': 'pedal',
  'Parts': 'parts',
  'Pickups': 'parts',
};

const LEGACY_TYPE_TO_SUBTYPE: Record<string, string> = {
  guitar: 'Electric Guitar',
  bass: 'Bass',
  'acoustic guitar': 'Acoustic Guitar',
  amp: 'Amp',
  cab: 'Cabinet',
  processor: 'Processor',
  pedal: 'Pedal',
  parts: 'Parts',
};

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

const statusClasses: Record<string, string> = {
  new: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  owned: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  listed: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  sold: 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  traded: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
};

interface InventoryFormProps {
  itemId?: string;
  onCreated?: (item: InventoryItem) => void;
  onClose?: () => void;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  backHref?: string;
}

export default function InventoryForm({
  itemId,
  onCreated,
  onClose,
  hideHeader = false,
  hideSidebar = false,
  backHref,
}: InventoryFormProps) {
  const router = useRouter();
  const photosRef = useRef<ItemPhotosHandle>(null);

  // Form state
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [allSubtypes, setAllSubtypes] = useState<ItemSubtype[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedSubtypeId, setSelectedSubtypeId] = useState<number | null>(null);
  const [formDataReady, setFormDataReady] = useState(false);
  const [brandSuggestions, setBrandSuggestions] = useState<Brand[]>([]);
  const [brandInput, setBrandInput] = useState('');
  const [selectedBrandId, setSelectedBrandId] = useState<number | null>(null);
  const [showBrandSuggestions, setShowBrandSuggestions] = useState(false);
  const [brandSearchLoading, setBrandSearchLoading] = useState(false);
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
  const [mainPhotoUrl, setMainPhotoUrl] = useState<string | null>(null);

  // Metrics state (edit mode only)
  const [valueIn, setValueIn] = useState<number | null>(null);
  const [valueOut, setValueOut] = useState<number | null>(null);

  const existingBrand = useMemo(
    () => brands.find((b) => b.name.toLowerCase() === brandInput.trim().toLowerCase()),
    [brandInput, brands],
  );

  // Load brands, categories, and subtypes on mount
  useEffect(() => {
    async function loadFormData() {
      setLoading(true);
      const [brandsResult, catsResult, subsResult] = await Promise.all([
        getBrands(),
        getItemCategories(),
        getItemSubtypes(),
      ]);
      setLoading(false);
      if (brandsResult.error) { setError('Could not load brands.'); return; }
      const fetchedBrands = brandsResult.data || [];
      setBrands(fetchedBrands);
      setBrandSuggestions(fetchedBrands);
      const fetchedCats = (catsResult.data || []) as ItemCategory[];
      const fetchedSubs = (subsResult.data || []) as ItemSubtype[];
      setCategories(fetchedCats);
      setAllSubtypes(fetchedSubs);
      // Default for new items: first active category + first active subtype
      if (!itemId) {
        const firstCat = fetchedCats.find((c) => c.is_active) ?? fetchedCats[0] ?? null;
        if (firstCat) {
          setSelectedCategoryId(firstCat.id);
          const firstSub = fetchedSubs.find((s) => s.category_id === firstCat.id && s.is_active)
            ?? fetchedSubs.find((s) => s.category_id === firstCat.id) ?? null;
          if (firstSub) setSelectedSubtypeId(firstSub.id);
        }
      }
      setFormDataReady(true);
    }
    loadFormData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!itemId || !formDataReady) return;

    async function loadItem() {
      setLoading(true);
      const [itemResult, withValueResult, dealItemsResult, photosResult] = await Promise.all([
        getInventoryItemById(Number(itemId)),
        getInventoryItemWithValueById(Number(itemId)),
        getDealItemsByItemId(Number(itemId)),
        getMainPhotosForItems([Number(itemId)]),
      ]);
      setLoading(false);

      if (itemResult.error || !itemResult.data) {
        setError('Could not load the inventory item.');
        return;
      }

      const item = itemResult.data;
      setExistingItem(item);

      // Resolve category and subtype
      if (item.item_subtype_id) {
        const sub = allSubtypes.find((s) => s.id === item.item_subtype_id);
        if (sub) {
          setSelectedSubtypeId(sub.id);
          setSelectedCategoryId(sub.category_id);
        }
      } else {
        // Legacy fallback: map item_type → subtype name → ids
        const subtypeName = LEGACY_TYPE_TO_SUBTYPE[item.item_type.toLowerCase()];
        if (subtypeName) {
          const sub = allSubtypes.find((s) => s.name === subtypeName);
          if (sub) {
            setSelectedSubtypeId(sub.id);
            setSelectedCategoryId(sub.category_id);
          }
        }
      }

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

      // Main photo for sticky panel
      if (!photosResult.error && photosResult.data && photosResult.data.length > 0) {
        setMainPhotoUrl(getPhotoUrl(photosResult.data[0].storage_path));
      }

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
  }, [itemId, formDataReady]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Derived category/subtype data
  const filteredSubtypes = allSubtypes.filter((s) => s.category_id === selectedCategoryId);
  const selectedSubtype = allSubtypes.find((s) => s.id === selectedSubtypeId) ?? null;

  const handleCategoryChange = (catId: number) => {
    setSelectedCategoryId(catId);
    const firstSub = allSubtypes.find((s) => s.category_id === catId && s.is_active)
      ?? allSubtypes.find((s) => s.category_id === catId) ?? null;
    setSelectedSubtypeId(firstSub?.id ?? null);
  };

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
    if (!selectedSubtypeId) { setError('Item subtype is required.'); return; }
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

    const derivedItemType: ItemType =
      (selectedSubtype && SUBTYPE_TO_LEGACY_TYPE[selectedSubtype.name]) ?? 'guitar';

    const payload: NewInventoryItem = {
      brand_id: brandId!,
      item_type: derivedItemType,
      item_subtype_id: selectedSubtypeId,
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
      status: existingItem?.status ?? 'new',
    };

    const result = itemId
      ? await updateInventoryItem(Number(itemId), { id: Number(itemId), ...payload })
      : await createInventoryItem(payload);

    setSaving(false);
    if (result.error || !result.data) { setError('Could not save inventory item.'); return; }

    // Upload any pending photos that were queued before the form was submitted
    if (itemId && photosRef.current?.hasPending()) {
      const { error: photoError } = await photosRef.current.uploadPending();
      if (photoError) {
        setError(`Item saved but photo upload failed: ${photoError}`);
        return;
      }
    }

    // Standalone form: navigate back to the list with filters intact
    if (!hideHeader) {
      router.push(backHref ?? '/inventory');
      return;
    }

    // Embedded form (inside operation forms): notify parent and reset
    if (onCreated) onCreated(result.data);
    setBrandInput('');
    setSelectedBrandId(null);
    // Reset to default category/subtype
    const firstCat = categories.find((c) => c.is_active) ?? categories[0] ?? null;
    if (firstCat) {
      setSelectedCategoryId(firstCat.id);
      const firstSub = allSubtypes.find((s) => s.category_id === firstCat.id && s.is_active)
        ?? allSubtypes.find((s) => s.category_id === firstCat.id) ?? null;
      setSelectedSubtypeId(firstSub?.id ?? null);
    }
    setModel('');
    setSerialNumber('');
    setYear('');
    setColor('');
    setCondition('');
    setCollectionType('');
    setEstimatedSoldValue('');
    setNotes('');
    setSuccessMessage('Item saved.');
    setError(null);
  };

  const modelError = Boolean(error?.includes('Model'));
  const brandError = Boolean(error?.includes('Brand'));
  const saveLabel = saving ? 'Saving...' : itemId ? 'Update item' : 'Save item';
  const disabled = loading || saving;
  const brandCreateDisabled = !brandInput.trim() || !!existingBrand || disabled || creatingBrand;

  // Metrics
  const parsedEstimated = estimatedSoldValue ? Number(estimatedSoldValue) : null;
  const potentialReward = parsedEstimated != null && valueIn != null ? parsedEstimated - valueIn : null;
  const potentialRoi = potentialReward != null && valueIn != null && valueIn > 0
    ? (potentialReward / valueIn) * 100 : null;
  const realizedGain = valueOut != null && valueIn != null ? valueOut - valueIn : null;
  const realizedRoi = realizedGain != null && valueIn != null && valueIn > 0
    ? (realizedGain / valueIn) * 100 : null;
  const isOwned = existingItem?.status === 'owned' || existingItem?.status === 'listed';
  const isSoldOrTraded = existingItem?.status === 'sold' || existingItem?.status === 'traded';
  const showMetrics = !!itemId && !!existingItem && !hideSidebar;
  const fmt = (v: number | null) => (v != null ? `$${v.toFixed(2)}` : '—');
  const fmtPct = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : '—');
  const metricColor = (v: number | null) =>
    v == null ? 'text-slate-900 dark:text-slate-100' : v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-slate-900 dark:text-slate-100';

  const itemTitle = existingItem
    ? `${brandInput} ${existingItem.model}${existingItem.color ? ` — ${existingItem.color}` : ''}`
    : null;

  const inputClass = 'h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600';

  // Shared form fields used in both single-column and two-column layouts
  const formFields = (
    <div className="grid gap-5 sm:grid-cols-2">

      {/* Category */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          Category <span className="text-rose-500">*</span>
        </label>
        <select
          value={selectedCategoryId ?? ''}
          onChange={(e) => handleCategoryChange(Number(e.target.value))}
          disabled={disabled}
          className={inputClass}
        >
          <option value="" disabled>Choose category</option>
          {categories.filter((c) => c.is_active).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Subtype */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          Type <span className="text-rose-500">*</span>
        </label>
        <select
          value={selectedSubtypeId ?? ''}
          onChange={(e) => setSelectedSubtypeId(Number(e.target.value))}
          disabled={disabled || filteredSubtypes.length === 0}
          className={inputClass}
        >
          <option value="" disabled>Choose type</option>
          {filteredSubtypes.filter((s) => s.is_active).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Brand */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
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
              className={`min-w-0 w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-slate-100 dark:focus:ring-slate-600 ${
                brandError
                  ? 'border-rose-300 bg-rose-50 focus:border-rose-400 dark:border-rose-700 dark:bg-rose-900/20'
                  : 'border-slate-200 bg-white focus:border-slate-400 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100'
              }`}
            />
            {brandSearchLoading && (
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
                Searching...
              </div>
            )}
            {showBrandSuggestions && brandSuggestions.length > 0 && (
              <ul className="absolute left-0 right-0 z-20 mt-1 max-h-52 overflow-auto rounded-2xl border border-slate-200 bg-white text-sm shadow-lg dark:border-slate-600 dark:bg-slate-800">
                {brandSuggestions.map((brand) => (
                  <li
                    key={brand.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setBrandInput(brand.name);
                      setSelectedBrandId(brand.id);
                      setShowBrandSuggestions(false);
                    }}
                    className="cursor-pointer px-3 py-2 text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
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
            className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
          >
            {creatingBrand ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>

      {/* Model */}
      <div className="space-y-1.5 sm:col-span-2">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          Model <span className="text-rose-500">*</span>
        </label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={disabled}
          placeholder="e.g. Stratocaster"
          className={`w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-slate-100 dark:focus:ring-slate-600 ${
            modelError
              ? 'border-rose-300 bg-rose-50 text-slate-900 focus:border-rose-400 dark:border-rose-700 dark:bg-rose-900/20 dark:text-slate-100'
              : 'border-slate-200 bg-white text-slate-900 focus:border-slate-400 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100'
          }`}
        />
      </div>

      {/* Year */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Year</label>
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
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Color</label>
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
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Serial number</label>
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
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Condition</label>
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
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Purpose / collection</label>
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
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Estimated sold value</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500 dark:text-slate-400">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={estimatedSoldValue}
            onChange={(e) => setEstimatedSoldValue(e.target.value)}
            disabled={disabled}
            placeholder="0.00"
            className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-7 pr-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
          />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Estimated values help track potential returns.</p>
      </div>

      {/* Notes */}
      <div className="space-y-1.5 sm:col-span-2">
        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={disabled}
          placeholder="Add any additional notes..."
          rows={3}
          className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
        />
      </div>
    </div>
  );

  const formActionButtons = (
    <div className="mt-6 hidden lg:flex lg:items-center lg:justify-end lg:gap-3">
      <button
        type="button"
        onClick={() => { if (onClose) { onClose(); return; } router.push(backHref ?? '/inventory'); }}
        className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 bg-white px-6 text-sm font-medium text-slate-900 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={disabled}
        className="inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
      >
        {saveLabel}
      </button>
    </div>
  );

  return (
    <div className={hideHeader ? '' : 'min-h-screen bg-slate-50 dark:bg-slate-900'}>
      <div className={hideHeader ? '' : 'mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8'}>

        {/* Header */}
        {!hideHeader && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            {itemId ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <Link
                    href={backHref ?? '/inventory'}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 12H5M12 19l-7-7 7-7"/>
                    </svg>
                    Back to Inventory
                  </Link>
                  {existingItem && (
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[existingItem.status] ?? 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200'}`}>
                      {existingItem.status}
                    </span>
                  )}
                </div>
                <div className="mt-4">
                  <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Inventory</p>
                  <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">
                    {itemTitle ?? 'Update item'}
                  </h1>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Inventory</p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">
                  Add inventory item
                </h1>
              </>
            )}
          </div>
        )}

        {loading && (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            Loading...
          </div>
        )}

        {/* Edit mode: two-column layout on desktop (sticky photo panel + form) */}
        {itemId && !hideHeader ? (
          <div className="lg:flex lg:items-start lg:gap-6">

            {/* Left: sticky photo panel with summary + metrics */}
            <div className="mb-6 lg:mb-0 lg:w-72 lg:shrink-0 lg:sticky lg:top-6">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
                {/* Photo: 16:9 on mobile, square on desktop */}
                <div className="relative aspect-square w-full bg-slate-100 dark:bg-slate-700">
                  {mainPhotoUrl ? (
                    <Image
                      src={mainPhotoUrl}
                      alt={itemTitle ?? 'Item photo'}
                      fill
                      className="object-cover"
                      sizes="(max-width: 1024px) 100vw, 288px"
                      unoptimized
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-12 w-12 text-slate-300 dark:text-slate-600">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                      </svg>
                    </div>
                  )}
                </div>

                {/* Item summary */}
                {existingItem && (
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                        {selectedSubtype?.name ?? existingItem.item_type}
                      </p>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses[existingItem.status] ?? 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200'}`}>
                        {existingItem.status}
                      </span>
                    </div>
                    <p className="mt-1 text-base font-semibold leading-snug text-slate-900 dark:text-white">
                      {itemTitle}
                    </p>
                    {(existingItem.year || existingItem.color) && (
                      <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                        {[existingItem.year, existingItem.color].filter(Boolean).join(' · ')}
                      </p>
                    )}

                    {/* Metrics */}
                    {showMetrics && (
                      <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-700">
                        <div className="space-y-3">
                          <div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Value In</p>
                            <p className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-100">{fmt(valueIn)}</p>
                          </div>
                          {isOwned && (
                            <>
                              <div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Est. Sold</p>
                                <p className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-100">{fmt(parsedEstimated)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Potential Reward</p>
                                <p className={`mt-0.5 text-lg font-semibold ${metricColor(potentialReward)}`}>{fmt(potentialReward)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Potential ROI</p>
                                <p className={`mt-0.5 text-lg font-semibold ${metricColor(potentialRoi)}`}>{fmtPct(potentialRoi)}</p>
                              </div>
                            </>
                          )}
                          {isSoldOrTraded && (
                            <>
                              <div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Value Out</p>
                                <p className="mt-0.5 text-lg font-semibold text-slate-900 dark:text-slate-100">{fmt(valueOut)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Realized Gain</p>
                                <p className={`mt-0.5 text-lg font-semibold ${metricColor(realizedGain)}`}>{fmt(realizedGain)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-slate-500 dark:text-slate-400">Realized ROI</p>
                                <p className={`mt-0.5 text-lg font-semibold ${metricColor(realizedRoi)}`}>{fmtPct(realizedRoi)}</p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Right: form fields + photo management */}
            <div className="min-w-0 flex-1 space-y-6">
              <form onSubmit={handleSubmit} aria-busy={disabled}>
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                  {formFields}
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
                  {formActionButtons}
                </div>
              </form>

              <ItemPhotos ref={photosRef} itemId={Number(itemId)} onMainPhotoChange={setMainPhotoUrl} />
            </div>
          </div>
        ) : (
          /* Create mode or embedded in operation forms: single-column */
          <form onSubmit={handleSubmit} aria-busy={disabled}>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              {formFields}
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
              {formActionButtons}
            </div>
          </form>
        )}

        {/* Mobile sticky footer */}
        {!hideHeader && (
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-4 backdrop-blur-sm lg:hidden dark:border-slate-700 dark:bg-slate-900/95">
            <div className="mx-auto flex max-w-4xl items-center gap-3">
              <button
                type="button"
                onClick={() => router.push(backHref ?? '/inventory')}
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                onClick={() => document.querySelector('form')?.requestSubmit()}
                disabled={disabled}
                className="flex-1 rounded-xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
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
