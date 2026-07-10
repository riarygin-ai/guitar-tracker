'use client';

import { useEffect, useRef, useState } from 'react';
import type { InventoryTag } from '@/types';
import { createTag } from '@/lib/supabase';

interface TagsSelectorProps {
  allTags: InventoryTag[];
  selectedTagIds: number[];
  onChange: (tagIds: number[]) => void;
  onTagCreated?: (tag: InventoryTag) => void;
  disabled?: boolean;
}

export default function TagsSelector({
  allTags,
  selectedTagIds,
  onChange,
  onTagCreated,
  disabled,
}: TagsSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreateError(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectedTags = allTags.filter((t) => selectedTagIds.includes(t.id));
  const searchLower = search.trim().toLowerCase();
  const filteredTags = allTags.filter(
    (t) => t.is_active && !selectedTagIds.includes(t.id) && t.name.toLowerCase().includes(searchLower),
  );
  const exactMatch = allTags.some((t) => t.name.toLowerCase() === searchLower);
  const canCreate = searchLower.length > 0 && !exactMatch;

  function toggleTag(id: number) {
    onChange(selectedTagIds.includes(id) ? selectedTagIds.filter((x) => x !== id) : [...selectedTagIds, id]);
  }

  async function handleCreateAndSelect() {
    const name = search.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    const { data, error } = await createTag(name);
    setCreating(false);
    if (error || !data) {
      setCreateError(
        (error as { message?: string } | null)?.message?.includes('unique')
          ? 'A tag with this name already exists.'
          : 'Could not create tag.',
      );
      return;
    }
    const tag = data as InventoryTag;
    onTagCreated?.(tag);
    onChange([...selectedTagIds, tag.id]);
    setSearch('');
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Selected tags + search input */}
      <div
        className="min-h-10 w-full cursor-text rounded-xl border border-slate-200 bg-white px-3 py-2 transition focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:focus-within:ring-slate-600"
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus(); } }}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedTags.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-600 dark:text-slate-200"
            >
              {tag.name}
              {!disabled && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggleTag(tag.id); }}
                  className="text-slate-400 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  aria-label={`Remove ${tag.name}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </span>
          ))}
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setOpen(true); setCreateError(null); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); setSearch(''); }
              if (e.key === 'Enter') { e.preventDefault(); if (canCreate && !creating) handleCreateAndSelect(); }
            }}
            placeholder={selectedTags.length === 0 ? 'Search or add tags…' : ''}
            disabled={disabled}
            className="min-w-[120px] flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
        </div>
      </div>

      {/* Dropdown */}
      {open && !disabled && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg dark:border-slate-600 dark:bg-slate-800">
          <div className="max-h-48 overflow-y-auto">
            {filteredTags.length === 0 && !canCreate && (
              <p className="px-3 py-2.5 text-xs text-slate-500 dark:text-slate-400">
                {searchLower ? 'No matching tags.' : 'No tags available.'}
              </p>
            )}
            {filteredTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); toggleTag(tag.id); setSearch(''); }}
                className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {tag.name}
              </button>
            ))}
            {canCreate && (
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); handleCreateAndSelect(); }}
                disabled={creating}
                className="flex w-full items-center gap-1.5 border-t border-slate-100 px-3 py-2 text-left text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                {creating ? 'Creating…' : `Create "${search.trim()}"`}
              </button>
            )}
          </div>
          {createError && (
            <p className="border-t border-slate-100 px-3 py-1.5 text-xs text-rose-600 dark:border-slate-700 dark:text-rose-400">
              {createError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
