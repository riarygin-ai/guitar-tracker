'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Image from 'next/image';
import {
  deleteItemPhoto,
  getItemPhotos,
  getPhotoUrl,
  setMainPhoto,
  uploadItemPhoto,
} from '@/lib/supabase';
import type { InventoryItemPhoto } from '@/types';

export interface ItemPhotosHandle {
  uploadPending: () => Promise<{ error: string | null }>;
  hasPending: () => boolean;
}

interface PendingPhoto {
  tempId: string;
  file: File;
  previewUrl: string;
}

interface ItemPhotosProps {
  itemId: number;
  onMainPhotoChange?: (url: string | null) => void;
  onClose?: () => void;
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

const ItemPhotos = forwardRef<ItemPhotosHandle, ItemPhotosProps>(
  function ItemPhotos({ itemId, onMainPhotoChange, onClose }, ref) {
    const [photos,    setPhotos]    = useState<InventoryItemPhoto[]>([]);
    const [pending,   setPending]   = useState<PendingPhoto[]>([]);
    const [loading,   setLoading]   = useState(true);
    const [uploading, setUploading] = useState(false);
    const [error,     setError]     = useState<string | null>(null);

    const fileInputRef         = useRef<HTMLInputElement>(null);
    const onMainPhotoChangeRef = useRef(onMainPhotoChange);
    useEffect(() => { onMainPhotoChangeRef.current = onMainPhotoChange; }, [onMainPhotoChange]);

    // ── Imperative handle ──────────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        async uploadPending() {
          if (pending.length === 0) return { error: null };

          setUploading(true);
          setError(null);
          const uploaded: InventoryItemPhoto[] = [];

          for (const p of pending) {
            const { data, error: uploadError } = await uploadItemPhoto(itemId, p.file);
            if (uploadError) {
              setUploading(false);
              setError(uploadError);
              return { error: uploadError };
            }
            if (data) uploaded.push(data);
            URL.revokeObjectURL(p.previewUrl);
          }

          const hasExistingMain = photos.some((p) => p.is_main);
          if (!hasExistingMain && uploaded.length > 0) {
            await setMainPhoto(itemId, uploaded[0].id);
            uploaded[0] = { ...uploaded[0], is_main: true };
          }

          setPending([]);
          setPhotos((prev) => {
            const next = [...prev, ...uploaded];
            const main = next.find((p) => p.is_main) ?? next[0] ?? null;
            onMainPhotoChangeRef.current?.(main ? getPhotoUrl(main.storage_path) : null);
            return next;
          });
          setUploading(false);
          return { error: null };
        },
        hasPending() {
          return pending.length > 0;
        },
      }),
      [pending, photos, itemId],
    );

    // ── Load ───────────────────────────────────────────────────────────────────

    async function loadPhotos() {
      const { data, error: fetchError } = await getItemPhotos(itemId);
      if (fetchError) {
        setError('Could not load photos.');
      } else {
        const loaded = (data as InventoryItemPhoto[]) ?? [];
        setPhotos(loaded);
        const main = loaded.find((p) => p.is_main) ?? loaded[0] ?? null;
        onMainPhotoChangeRef.current?.(main ? getPhotoUrl(main.storage_path) : null);
      }
      setLoading(false);
    }

    useEffect(() => { loadPhotos(); }, [itemId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      return () => { pending.forEach((p) => URL.revokeObjectURL(p.previewUrl)); };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── File selection ─────────────────────────────────────────────────────────

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';

      if (!ALLOWED_TYPES.includes(file.type)) {
        setError('Only JPEG, PNG, and WebP images are allowed.');
        return;
      }
      if (file.size > MAX_BYTES) {
        setError('File size must be 10 MB or less.');
        return;
      }

      setError(null);
      setPending((prev) => [
        ...prev,
        { tempId: `pending-${Date.now()}-${Math.random()}`, file, previewUrl: URL.createObjectURL(file) },
      ]);
    }

    function handleRemovePending(tempId: string) {
      setPending((prev) => {
        const p = prev.find((x) => x.tempId === tempId);
        if (p) URL.revokeObjectURL(p.previewUrl);
        return prev.filter((x) => x.tempId !== tempId);
      });
    }

    // ── Photo actions ──────────────────────────────────────────────────────────

    async function handleSetMain(photo: InventoryItemPhoto) {
      setError(null);
      const { error: mainError } = await setMainPhoto(itemId, photo.id);
      if (mainError) { setError('Could not set main photo.'); return; }
      setPhotos((prev) => prev.map((p) => ({ ...p, is_main: p.id === photo.id })));
      onMainPhotoChangeRef.current?.(getPhotoUrl(photo.storage_path));
    }

    async function handleDelete(photo: InventoryItemPhoto) {
      setError(null);
      const { error: deleteError } = await deleteItemPhoto(photo.id, photo.storage_path);
      if (deleteError) { setError(deleteError); return; }

      const remaining = photos.filter((p) => p.id !== photo.id);
      if (photo.is_main && remaining.length > 0) {
        await setMainPhoto(itemId, remaining[0].id);
        setPhotos(remaining.map((p, i) => ({ ...p, is_main: i === 0 })));
        onMainPhotoChangeRef.current?.(getPhotoUrl(remaining[0].storage_path));
      } else {
        setPhotos(remaining);
        if (photo.is_main) onMainPhotoChangeRef.current?.(null);
      }
    }

    // ── Derived ────────────────────────────────────────────────────────────────

    const hasThumbnails = !loading && (photos.length > 0 || pending.length > 0);

    // ── Render ─────────────────────────────────────────────────────────────────

    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">Photos</h3>
            {!loading && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {photos.length > 0
                  ? `${photos.length} saved${pending.length > 0 ? ` · ${pending.length} pending` : ''}`
                  : pending.length > 0
                    ? `${pending.length} pending`
                    : 'None saved'
                }
              </span>
            )}
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              Close
            </button>
          )}
        </div>

        {/* ── Error banner ───────────────────────────────────────────────── */}
        {error && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">
            {error}
          </div>
        )}

        {/* ── Compact thumbnail grid ─────────────────────────────────────── */}
        {hasThumbnails && (
          <div className="mt-4 grid grid-cols-4 gap-1.5 sm:grid-cols-5">

            {photos.map((photo) => (
              <div
                key={photo.id}
                className={`relative overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 ${
                  photo.is_main ? 'ring-2 ring-slate-950 dark:ring-white' : ''
                }`}
                style={{ aspectRatio: '1' }}
              >
                <Image
                  src={getPhotoUrl(photo.storage_path)}
                  alt={photo.file_name ?? 'Photo'}
                  fill
                  className="object-cover"
                  sizes="(max-width: 640px) 25vw, 20vw"
                  unoptimized
                />
                <button
                  type="button"
                  onClick={() => handleDelete(photo)}
                  aria-label="Delete photo"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-950/60 text-white backdrop-blur-sm transition hover:bg-rose-600"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
                {photo.is_main ? (
                  <span className="absolute bottom-0.5 left-0.5 rounded-full bg-slate-950/60 px-1.5 py-px text-[10px] font-medium leading-tight text-white backdrop-blur-sm">
                    Main
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSetMain(photo)}
                    className="absolute bottom-0.5 left-0.5 rounded-full bg-slate-950/60 px-1.5 py-px text-[10px] font-medium leading-tight text-white backdrop-blur-sm transition hover:bg-slate-950"
                  >
                    Set main
                  </button>
                )}
              </div>
            ))}

            {pending.map((p) => (
              <div
                key={p.tempId}
                className="relative overflow-hidden rounded-xl bg-slate-100 ring-2 ring-amber-400 dark:bg-slate-700 dark:ring-amber-500"
                style={{ aspectRatio: '1' }}
              >
                <Image
                  src={p.previewUrl}
                  alt={p.file.name}
                  fill
                  className="object-cover opacity-80"
                  sizes="(max-width: 640px) 25vw, 20vw"
                  unoptimized
                />
                <button
                  type="button"
                  onClick={() => handleRemovePending(p.tempId)}
                  aria-label="Remove photo"
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-950/60 text-white backdrop-blur-sm transition hover:bg-rose-600"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
                <span className="absolute bottom-0.5 left-0.5 rounded-full bg-amber-500/80 px-1.5 py-px text-[10px] font-medium leading-tight text-white backdrop-blur-sm">
                  Pending
                </span>
              </div>
            ))}

          </div>
        )}

        {/* ── Pending notice ──────────────────────────────────────────────── */}
        {pending.length > 0 && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            {pending.length} photo{pending.length !== 1 ? 's' : ''} queued — will upload when you click{' '}
            <strong>Update item</strong>.
          </p>
        )}

        {/* ── Upload zone ─────────────────────────────────────────────────── */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 py-7 transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed dark:border-slate-600 dark:hover:border-slate-400 dark:hover:bg-slate-700/30"
          >
            {uploading ? (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
                <span className="text-sm text-slate-500 dark:text-slate-400">Uploading…</span>
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300 dark:text-slate-600">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
                  Click to select a photo
                </span>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  JPEG, PNG, WebP · up to 10 MB
                </span>
              </>
            )}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    );
  },
);

export default ItemPhotos;
