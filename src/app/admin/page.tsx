'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import AiPromptsCard from '@/components/AiPromptsCard';
import {
  createItemCategory,
  createItemSubtype,
  deleteBrand,
  getBrandUsageCount,
  getBrands,
  getItemCategories,
  getItemSubtypes,
  getOrCreateAppUser,
  updateBrand,
  updateItemCategory,
  updateItemSubtype,
} from '@/lib/supabase';
import type { AppUser, Brand, ItemCategory, ItemSubtype } from '@/types';

const BRAND_LIMIT = 10;

type EditState = { id: number; name: string };
type DeleteState = { id: number; name: string; checking: boolean };

export default function AdminPage() {
  const router = useRouter();

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AppUser | null>(null);

  // ── Brands ────────────────────────────────────────────────────────────────
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandsLoading, setBrandsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<EditState | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Categories ────────────────────────────────────────────────────────────
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [catsLoading, setCatsLoading] = useState(false);
  const [catEditing, setCatEditing] = useState<EditState | null>(null);
  const [catEditSaving, setCatEditSaving] = useState(false);
  const [catEditError, setCatEditError] = useState<string | null>(null);
  const [catCreateName, setCatCreateName] = useState('');
  const [catCreating, setCatCreating] = useState(false);
  const [catCreateError, setCatCreateError] = useState<string | null>(null);
  const [catToggling, setCatToggling] = useState<Set<number>>(new Set());
  const catEditInputRef = useRef<HTMLInputElement>(null);

  // ── Subtypes ──────────────────────────────────────────────────────────────
  const [subtypes, setSubtypes] = useState<ItemSubtype[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [subEditing, setSubEditing] = useState<EditState | null>(null);
  const [subEditSaving, setSubEditSaving] = useState(false);
  const [subEditError, setSubEditError] = useState<string | null>(null);
  const [subCreateNames, setSubCreateNames] = useState<Record<number, string>>({});
  const [subCreatingCatId, setSubCreatingCatId] = useState<number | null>(null);
  const [subCreateErrors, setSubCreateErrors] = useState<Record<number, string>>({});
  const [subToggling, setSubToggling] = useState<Set<number>>(new Set());
  const subEditInputRef = useRef<HTMLInputElement>(null);

  // ── Auth ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    getOrCreateAppUser().then((u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u) router.replace('/login');
    });
  }, [router]);

  useEffect(() => {
    if (!user?.admin) return;
    loadBrands();
    loadCategories();
    loadSubtypes();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Brands CRUD ───────────────────────────────────────────────────────────

  async function loadBrands() {
    setBrandsLoading(true);
    const { data, error } = await getBrands();
    setBrandsLoading(false);
    if (error) { setGlobalError('Could not load brands.'); return; }
    setBrands((data as Brand[]) ?? []);
  }

  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredBrands = brands.filter((b) =>
    b.name.toLowerCase().includes(search.trim().toLowerCase())
  );
  const visibleBrands = filteredBrands.slice(0, BRAND_LIMIT);
  const isLimited = filteredBrands.length > BRAND_LIMIT;
  const listStatusText = search.trim()
    ? isLimited
      ? `Showing ${BRAND_LIMIT} of ${filteredBrands.length} matching brands`
      : `${filteredBrands.length} matching brand${filteredBrands.length !== 1 ? 's' : ''}`
    : isLimited
      ? `Showing ${BRAND_LIMIT} of ${brands.length} brands`
      : null;

  function startEdit(brand: Brand) {
    setEditing({ id: brand.id, name: brand.name });
    setEditError(null);
    setDeleting(null);
    setDeleteError(null);
  }
  function cancelEdit() { setEditing(null); setEditError(null); }

  async function saveEdit() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) { setEditError('Brand name is required.'); return; }
    const duplicate = brands.find((b) => b.name.toLowerCase() === trimmed.toLowerCase() && b.id !== editing.id);
    if (duplicate) { setEditError('A brand with this name already exists.'); return; }
    setEditSaving(true);
    setEditError(null);
    const { data, error } = await updateBrand(editing.id, trimmed);
    setEditSaving(false);
    if (error) { setEditError(error.message || 'Could not update brand.'); return; }
    setBrands((prev) => prev.map((b) => (b.id === editing.id ? (data as Brand) : b)));
    setEditing(null);
  }

  async function startDelete(brand: Brand) {
    setDeleting({ id: brand.id, name: brand.name, checking: true });
    setDeleteError(null);
    setEditing(null);
    setEditError(null);
    const { count, error } = await getBrandUsageCount(brand.id);
    if (error) { setDeleteError('Could not check brand usage.'); setDeleting(null); return; }
    if ((count ?? 0) > 0) { setDeleteError(`"${brand.name}" is used by inventory items and cannot be deleted.`); setDeleting(null); return; }
    setDeleting({ id: brand.id, name: brand.name, checking: false });
  }
  function cancelDelete() { setDeleting(null); setDeleteError(null); }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleting((d) => d && { ...d, checking: true });
    setDeleteError(null);
    const { error } = await deleteBrand(deleting.id);
    if (error) { setDeleteError(error.message || 'Could not delete brand.'); setDeleting(null); return; }
    setBrands((prev) => prev.filter((b) => b.id !== deleting.id));
    setDeleting(null);
  }

  // ── Categories CRUD ───────────────────────────────────────────────────────

  async function loadCategories() {
    setCatsLoading(true);
    const { data, error } = await getItemCategories();
    setCatsLoading(false);
    if (error) return;
    setCategories((data as ItemCategory[]) ?? []);
  }

  useEffect(() => {
    if (catEditing) catEditInputRef.current?.focus();
  }, [catEditing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startCatEdit(cat: ItemCategory) {
    setCatEditing({ id: cat.id, name: cat.name });
    setCatEditError(null);
  }
  function cancelCatEdit() { setCatEditing(null); setCatEditError(null); }

  async function saveCatEdit() {
    if (!catEditing) return;
    const trimmed = catEditing.name.trim();
    if (!trimmed) { setCatEditError('Name is required.'); return; }
    setCatEditSaving(true);
    setCatEditError(null);
    const { error } = await updateItemCategory(catEditing.id, { name: trimmed });
    setCatEditSaving(false);
    if (error) { setCatEditError(error.message || 'Could not update category.'); return; }
    setCategories((prev) => prev.map((c) => c.id === catEditing.id ? { ...c, name: trimmed } : c));
    setCatEditing(null);
  }

  async function toggleCatActive(cat: ItemCategory) {
    setCatToggling((s) => new Set(s).add(cat.id));
    const { error } = await updateItemCategory(cat.id, { is_active: !cat.is_active });
    setCatToggling((s) => { const n = new Set(s); n.delete(cat.id); return n; });
    if (!error) setCategories((prev) => prev.map((c) => c.id === cat.id ? { ...c, is_active: !cat.is_active } : c));
  }

  async function handleCreateCategory() {
    const trimmed = catCreateName.trim();
    if (!trimmed) { setCatCreateError('Name is required.'); return; }
    setCatCreating(true);
    setCatCreateError(null);
    const { data, error } = await createItemCategory(trimmed);
    setCatCreating(false);
    if (error) { setCatCreateError(error.message || 'Could not create category.'); return; }
    setCategories((prev) => [...prev, data as ItemCategory]);
    setCatCreateName('');
  }

  // ── Subtypes CRUD ─────────────────────────────────────────────────────────

  async function loadSubtypes() {
    setSubsLoading(true);
    const { data, error } = await getItemSubtypes();
    setSubsLoading(false);
    if (error) return;
    setSubtypes((data as ItemSubtype[]) ?? []);
  }

  useEffect(() => {
    if (subEditing) subEditInputRef.current?.focus();
  }, [subEditing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startSubEdit(sub: ItemSubtype) {
    setSubEditing({ id: sub.id, name: sub.name });
    setSubEditError(null);
  }
  function cancelSubEdit() { setSubEditing(null); setSubEditError(null); }

  async function saveSubEdit() {
    if (!subEditing) return;
    const trimmed = subEditing.name.trim();
    if (!trimmed) { setSubEditError('Name is required.'); return; }
    setSubEditSaving(true);
    setSubEditError(null);
    const { error } = await updateItemSubtype(subEditing.id, { name: trimmed });
    setSubEditSaving(false);
    if (error) { setSubEditError(error.message || 'Could not update subtype.'); return; }
    setSubtypes((prev) => prev.map((s) => s.id === subEditing.id ? { ...s, name: trimmed } : s));
    setSubEditing(null);
  }

  async function toggleSubActive(sub: ItemSubtype) {
    setSubToggling((s) => new Set(s).add(sub.id));
    const { error } = await updateItemSubtype(sub.id, { is_active: !sub.is_active });
    setSubToggling((s) => { const n = new Set(s); n.delete(sub.id); return n; });
    if (!error) setSubtypes((prev) => prev.map((s) => s.id === sub.id ? { ...s, is_active: !sub.is_active } : s));
  }

  async function handleCreateSubtype(catId: number) {
    const trimmed = (subCreateNames[catId] ?? '').trim();
    if (!trimmed) {
      setSubCreateErrors((prev) => ({ ...prev, [catId]: 'Name is required.' }));
      return;
    }
    setSubCreatingCatId(catId);
    setSubCreateErrors((prev) => { const n = { ...prev }; delete n[catId]; return n; });
    const { data, error } = await createItemSubtype(catId, trimmed);
    setSubCreatingCatId(null);
    if (error) {
      setSubCreateErrors((prev) => ({ ...prev, [catId]: error.message || 'Could not create subtype.' }));
      return;
    }
    setSubtypes((prev) => [...prev, data as ItemSubtype]);
    setSubCreateNames((prev) => ({ ...prev, [catId]: '' }));
  }

  // ── Render guards ─────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading...</p>
      </div>
    );
  }

  if (!user) return null;

  if (!user.admin) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 dark:border-rose-800/50 dark:bg-rose-900/20">
          <p className="text-lg font-semibold text-rose-700 dark:text-rose-400">Access denied</p>
          <p className="mt-2 text-sm text-rose-600 dark:text-rose-500">You do not have admin privileges.</p>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Admin UI ──────────────────────────────────────────────────────────────

  const inputClass = 'h-9 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-100 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600';
  const btnPrimary = 'inline-flex h-9 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400';
  const btnSecondary = 'inline-flex h-9 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';
  const btnAction = 'inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">Admin</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">Admin Panel</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Signed in as {user.email ?? user.display_name}
        </p>
      </div>

      {/* ── Brands ────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Brands</h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {brands.length} brand{brands.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search brands…"
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-4 pr-9 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>
        </div>

        {globalError && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">{globalError}</div>
        )}
        {deleteError && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">{deleteError}</div>
        )}

        {brandsLoading ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Loading brands…</p>
        ) : filteredBrands.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {search ? 'No brands match your search.' : 'No brands yet.'}
          </p>
        ) : (
          <>
            {listStatusText && (
              <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">{listStatusText}</p>
            )}
            <ul className="divide-y divide-slate-100 dark:divide-slate-700">
              {visibleBrands.map((brand) => {
                const isEditing = editing?.id === brand.id;
                const isDeleting = deleting?.id === brand.id;
                return (
                  <li key={brand.id} className="py-3">
                    {isEditing ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            ref={editInputRef}
                            value={editing.name}
                            onChange={(e) => setEditing((s) => s && { ...s, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') cancelEdit(); }}
                            disabled={editSaving}
                            className={inputClass}
                          />
                          <button type="button" onClick={saveEdit} disabled={editSaving} className={btnPrimary}>
                            {editSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" onClick={cancelEdit} disabled={editSaving} className={btnSecondary}>Cancel</button>
                        </div>
                        {editError && <p className="text-xs text-rose-600 dark:text-rose-400">{editError}</p>}
                      </div>
                    ) : isDeleting ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
                          Delete <span className="font-semibold">{brand.name}</span>? This cannot be undone.
                        </p>
                        <button type="button" onClick={confirmDelete} disabled={deleting.checking} className="inline-flex h-8 items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300">
                          {deleting.checking ? 'Deleting…' : 'Delete'}
                        </button>
                        <button type="button" onClick={cancelDelete} disabled={deleting.checking} className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-white">{brand.name}</span>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button type="button" onClick={() => startEdit(brand)} className={btnAction}>Edit</button>
                          <button type="button" onClick={() => startDelete(brand)} className="inline-flex h-8 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-medium text-rose-700 transition hover:bg-rose-100 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400 dark:hover:bg-rose-900/40">Delete</button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* ── Item Categories & Subtypes ────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-5">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Item Categories</h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            {categories.length} categor{categories.length !== 1 ? 'ies' : 'y'} · {subtypes.length} subtype{subtypes.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Add new category */}
        <div className="mb-6 space-y-2">
          <div className="flex gap-2">
            <input
              value={catCreateName}
              onChange={(e) => setCatCreateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCategory(); }}
              placeholder="New category name…"
              disabled={catCreating}
              className={inputClass}
            />
            <button type="button" onClick={handleCreateCategory} disabled={catCreating || !catCreateName.trim()} className={btnPrimary}>
              {catCreating ? 'Creating…' : 'Add category'}
            </button>
          </div>
          {catCreateError && <p className="text-xs text-rose-600 dark:text-rose-400">{catCreateError}</p>}
        </div>

        {catsLoading || subsLoading ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">Loading…</p>
        ) : categories.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">No categories yet.</p>
        ) : (
          <div className="space-y-4">
            {categories.map((cat) => {
              const catSubs = subtypes.filter((s) => s.category_id === cat.id);
              const isEditingCat = catEditing?.id === cat.id;
              const subInputVal = subCreateNames[cat.id] ?? '';
              const isCreatingSub = subCreatingCatId === cat.id;

              return (
                <div key={cat.id} className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">

                  {/* Category header */}
                  <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                    {isEditingCat ? (
                      <div className="flex flex-1 flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            ref={catEditInputRef}
                            value={catEditing.name}
                            onChange={(e) => setCatEditing((s) => s && { ...s, name: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveCatEdit(); if (e.key === 'Escape') cancelCatEdit(); }}
                            disabled={catEditSaving}
                            className={inputClass}
                          />
                          <button type="button" onClick={saveCatEdit} disabled={catEditSaving} className={btnPrimary}>
                            {catEditSaving ? 'Saving…' : 'Save'}
                          </button>
                          <button type="button" onClick={cancelCatEdit} disabled={catEditSaving} className={btnSecondary}>Cancel</button>
                        </div>
                        {catEditError && <p className="text-xs text-rose-600 dark:text-rose-400">{catEditError}</p>}
                      </div>
                    ) : (
                      <>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className={`text-sm font-semibold ${cat.is_active ? 'text-slate-900 dark:text-white' : 'text-slate-400 line-through dark:text-slate-500'}`}>
                            {cat.name}
                          </span>
                          {!cat.is_active && (
                            <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-700 dark:text-slate-400">inactive</span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button type="button" onClick={() => startCatEdit(cat)} className={btnAction}>Edit</button>
                          <button
                            type="button"
                            onClick={() => toggleCatActive(cat)}
                            disabled={catToggling.has(cat.id)}
                            className={`${btnAction} disabled:opacity-50`}
                          >
                            {catToggling.has(cat.id) ? '…' : cat.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Subtypes list */}
                  {catSubs.length > 0 && (
                    <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                      {catSubs.map((sub) => {
                        const isEditingSub = subEditing?.id === sub.id;
                        return (
                          <li key={sub.id} className="px-4 py-3">
                            {isEditingSub ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <input
                                    ref={subEditInputRef}
                                    value={subEditing.name}
                                    onChange={(e) => setSubEditing((s) => s && { ...s, name: e.target.value })}
                                    onKeyDown={(e) => { if (e.key === 'Enter') saveSubEdit(); if (e.key === 'Escape') cancelSubEdit(); }}
                                    disabled={subEditSaving}
                                    className={inputClass}
                                  />
                                  <button type="button" onClick={saveSubEdit} disabled={subEditSaving} className={btnPrimary}>
                                    {subEditSaving ? 'Saving…' : 'Save'}
                                  </button>
                                  <button type="button" onClick={cancelSubEdit} disabled={subEditSaving} className={btnSecondary}>Cancel</button>
                                </div>
                                {subEditError && <p className="text-xs text-rose-600 dark:text-rose-400">{subEditError}</p>}
                              </div>
                            ) : (
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className={`min-w-0 flex-1 truncate text-sm ${sub.is_active ? 'text-slate-700 dark:text-slate-200' : 'text-slate-400 line-through dark:text-slate-500'}`}>
                                    {sub.name}
                                  </span>
                                  {!sub.is_active && (
                                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-700 dark:text-slate-400">inactive</span>
                                  )}
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button type="button" onClick={() => startSubEdit(sub)} className={btnAction}>Edit</button>
                                  <button
                                    type="button"
                                    onClick={() => toggleSubActive(sub)}
                                    disabled={subToggling.has(sub.id)}
                                    className={`${btnAction} disabled:opacity-50`}
                                  >
                                    {subToggling.has(sub.id) ? '…' : sub.is_active ? 'Deactivate' : 'Activate'}
                                  </button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* Add subtype row */}
                  <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/30">
                    <div className="flex gap-2">
                      <input
                        value={subInputVal}
                        onChange={(e) => setSubCreateNames((prev) => ({ ...prev, [cat.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSubtype(cat.id); }}
                        placeholder="Add subtype…"
                        disabled={isCreatingSub}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                      />
                      <button
                        type="button"
                        onClick={() => handleCreateSubtype(cat.id)}
                        disabled={isCreatingSub || !subInputVal.trim()}
                        className="inline-flex h-8 items-center justify-center rounded-lg bg-slate-950 px-3 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
                      >
                        {isCreatingSub ? 'Adding…' : 'Add'}
                      </button>
                    </div>
                    {subCreateErrors[cat.id] && (
                      <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{subCreateErrors[cat.id]}</p>
                    )}
                  </div>

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── AI Prompts ────────────────────────────────────────────────── */}
      <AiPromptsCard />

    </div>
  );
}
