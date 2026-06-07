'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  deleteItemPhoto,
  getItemPhotos,
  getPhotoUrl,
  setMainPhoto,
  uploadItemPhoto,
} from '@/lib/supabase';
import type { InventoryItemPhoto } from '@/types';

interface ItemPhotosProps {
  itemId: number;
}

export default function ItemPhotos({ itemId }: ItemPhotosProps) {
  const [photos, setPhotos] = useState<InventoryItemPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadPhotos() {
    const { data, error: fetchError } = await getItemPhotos(itemId);
    if (fetchError) {
      setError('Could not load photos.');
    } else {
      setPhotos((data as InventoryItemPhoto[]) ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadPhotos();
  }, [itemId]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setError(null);
    setUploading(true);
    const { data, error: uploadError } = await uploadItemPhoto(itemId, file);
    setUploading(false);

    if (uploadError) {
      setError(uploadError);
      return;
    }

    if (data) {
      setPhotos((prev) => {
        // If this is the first photo, auto-set as main
        if (prev.length === 0) return [{ ...data, is_main: true }];
        return [...prev, data];
      });

      // If first photo, persist is_main=true
      if (photos.length === 0) {
        await setMainPhoto(itemId, data.id);
        setPhotos((prev) => prev.map((p) => ({ ...p, is_main: p.id === data.id })));
      }
    }
  }

  async function handleSetMain(photo: InventoryItemPhoto) {
    setError(null);
    const { error: mainError } = await setMainPhoto(itemId, photo.id);
    if (mainError) {
      setError('Could not set main photo.');
      return;
    }
    setPhotos((prev) => prev.map((p) => ({ ...p, is_main: p.id === photo.id })));
  }

  async function handleDelete(photo: InventoryItemPhoto) {
    setError(null);
    const { error: deleteError } = await deleteItemPhoto(photo.id, photo.storage_path);
    if (deleteError) {
      setError(deleteError);
      return;
    }
    setPhotos((prev) => {
      const remaining = prev.filter((p) => p.id !== photo.id);
      // If deleted photo was main and others remain, promote the first one
      if (photo.is_main && remaining.length > 0) {
        const first = remaining[0];
        setMainPhoto(itemId, first.id);
        return remaining.map((p, i) => ({ ...p, is_main: i === 0 }));
      }
      return remaining;
    });
  }

  const mainPhoto = photos.find((p) => p.is_main) ?? photos[0] ?? null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900 dark:text-white">Photos</h3>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
        >
          {uploading ? (
            <>
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-slate-900/40 dark:border-t-slate-900" />
              Uploading...
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Upload photo
            </>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading photos...</p>
      ) : photos.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 py-10 dark:border-slate-600">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300 dark:text-slate-600">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
          </svg>
          <p className="mt-2 text-sm text-slate-400 dark:text-slate-500">No photos yet</p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-3 text-sm font-medium text-slate-600 underline underline-offset-2 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            Upload the first photo
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Main photo preview */}
          {mainPhoto && (
            <div className="relative overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700" style={{ aspectRatio: '16/9' }}>
              <Image
                src={getPhotoUrl(mainPhoto.storage_path)}
                alt="Main photo"
                fill
                className="object-contain"
                sizes="(max-width: 768px) 100vw, 600px"
                unoptimized
              />
              <span className="absolute left-2 top-2 rounded-full bg-slate-950/70 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-sm">
                Main
              </span>
            </div>
          )}

          {/* Photo grid */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((photo) => (
              <div
                key={photo.id}
                className={`group relative overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 ${photo.is_main ? 'ring-2 ring-slate-950 dark:ring-white' : ''}`}
                style={{ aspectRatio: '1' }}
              >
                <Image
                  src={getPhotoUrl(photo.storage_path)}
                  alt={photo.file_name ?? 'Photo'}
                  fill
                  className="object-cover"
                  sizes="(max-width: 640px) 33vw, 25vw"
                  unoptimized
                />
                {/* Hover overlay */}
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-slate-950/60 opacity-0 transition-opacity group-hover:opacity-100">
                  {!photo.is_main && (
                    <button
                      type="button"
                      onClick={() => handleSetMain(photo)}
                      className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 transition hover:bg-slate-100"
                    >
                      Set main
                    </button>
                  )}
                  {photo.is_main && (
                    <span className="rounded-lg bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white">
                      Main
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDelete(photo)}
                    className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-400 dark:text-slate-500">
            {photos.length} photo{photos.length !== 1 ? 's' : ''}
            {' · '}JPEG, PNG, WebP up to 10 MB
          </p>
        </div>
      )}
    </div>
  );
}
