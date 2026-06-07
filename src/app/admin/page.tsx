'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteBrand,
  getBrandUsageCount,
  getBrands,
  getOrCreateAppUser,
  updateBrand,
} from '@/lib/supabase';
import type { AppUser, Brand } from '@/types';

const BRAND_LIMIT = 10;

type EditState = { id: number; name: string };
type DeleteState = { id: number; name: string; checking: boolean };

export default function AdminPage() {
  const router = useRouter();

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AppUser | null>(null);

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

  // Auth check
  useEffect(() => {
    getOrCreateAppUser().then((u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u) {
        router.replace('/login');
      }
    });
  }, [router]);

  // Load brands
  useEffect(() => {
    if (!user?.admin) return;
    loadBrands();
  }, [user]);

  async function loadBrands() {
    setBrandsLoading(true);
    const { data, error } = await getBrands();
    setBrandsLoading(false);
    if (error) {
      setGlobalError('Could not load brands.');
      return;
    }
    setBrands((data as Brand[]) ?? []);
  }

  // Focus edit input when editing starts
  useEffect(() => {
    if (editing) editInputRef.current?.focus();
  }, [editing?.id]);

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

  // ── Edit ──────────────────────────────────────────────────────────────────

  function startEdit(brand: Brand) {
    setEditing({ id: brand.id, name: brand.name });
    setEditError(null);
    setDeleting(null);
    setDeleteError(null);
  }

  function cancelEdit() {
    setEditing(null);
    setEditError(null);
  }

  async function saveEdit() {
    if (!editing) return;
    const trimmed = editing.name.trim();
    if (!trimmed) {
      setEditError('Brand name is required.');
      return;
    }
    const duplicate = brands.find(
      (b) => b.name.toLowerCase() === trimmed.toLowerCase() && b.id !== editing.id
    );
    if (duplicate) {
      setEditError('A brand with this name already exists.');
      return;
    }

    setEditSaving(true);
    setEditError(null);
    const { data, error } = await updateBrand(editing.id, trimmed);
    setEditSaving(false);

    if (error) {
      setEditError(error.message || 'Could not update brand.');
      return;
    }

    setBrands((prev) =>
      prev.map((b) => (b.id === editing.id ? (data as Brand) : b))
    );
    setEditing(null);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function startDelete(brand: Brand) {
    setDeleting({ id: brand.id, name: brand.name, checking: true });
    setDeleteError(null);
    setEditing(null);
    setEditError(null);

    const { count, error } = await getBrandUsageCount(brand.id);
    if (error) {
      setDeleteError('Could not check brand usage.');
      setDeleting(null);
      return;
    }
    if ((count ?? 0) > 0) {
      setDeleteError(`"${brand.name}" is used by inventory items and cannot be deleted.`);
      setDeleting(null);
      return;
    }

    setDeleting({ id: brand.id, name: brand.name, checking: false });
  }

  function cancelDelete() {
    setDeleting(null);
    setDeleteError(null);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleting((d) => d && { ...d, checking: true });
    setDeleteError(null);

    const { error } = await deleteBrand(deleting.id);

    if (error) {
      setDeleteError(error.message || 'Could not delete brand.');
      setDeleting(null);
      return;
    }

    setBrands((prev) => prev.filter((b) => b.id !== deleting.id));
    setDeleting(null);
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
          <p className="mt-2 text-sm text-rose-600 dark:text-rose-500">
            You do not have admin privileges.
          </p>
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

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">
          Admin
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">
          Admin Panel
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Signed in as {user.email ?? user.display_name}
        </p>
      </div>

      {/* Brands section */}
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
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">
            {globalError}
          </div>
        )}

        {deleteError && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">
            {deleteError}
          </div>
        )}

        {brandsLoading ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Loading brands…
          </p>
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
                    /* Edit row */
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <input
                          ref={editInputRef}
                          value={editing.name}
                          onChange={(e) =>
                            setEditing((s) => s && { ...s, name: e.target.value })
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEdit();
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          disabled={editSaving}
                          className="h-9 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-100 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                        />
                        <button
                          type="button"
                          onClick={saveEdit}
                          disabled={editSaving}
                          className="inline-flex h-9 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
                        >
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={editSaving}
                          className="inline-flex h-9 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                        >
                          Cancel
                        </button>
                      </div>
                      {editError && (
                        <p className="text-xs text-rose-600 dark:text-rose-400">{editError}</p>
                      )}
                    </div>
                  ) : isDeleting ? (
                    /* Delete confirmation row */
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
                        Delete <span className="font-semibold">{brand.name}</span>? This cannot be undone.
                      </p>
                      <button
                        type="button"
                        onClick={confirmDelete}
                        disabled={deleting.checking}
                        className="inline-flex h-8 items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
                      >
                        {deleting.checking ? 'Deleting…' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelDelete}
                        disabled={deleting.checking}
                        className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    /* Normal row */
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-white">
                        {brand.name}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => startEdit(brand)}
                          className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => startDelete(brand)}
                          className="inline-flex h-8 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-3 text-xs font-medium text-rose-700 transition hover:bg-rose-100 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400 dark:hover:bg-rose-900/40"
                        >
                          Delete
                        </button>
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
    </div>
  );
}
