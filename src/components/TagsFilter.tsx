'use client';

import { useState } from 'react';
import type { InventoryTag } from '@/types';

interface TagsFilterProps {
  allTags: InventoryTag[];
  selectedTagIds: number[];
  onTagIdsChange: (ids: number[]) => void;
}

export default function TagsFilter({ allTags, selectedTagIds, onTagIdsChange }: TagsFilterProps) {
  const [tagSearch, setTagSearch] = useState('');
  const [tagFocused, setTagFocused] = useState(false);

  const activeTags = allTags.filter((t) => t.is_active);
  const filteredOptions = activeTags.filter(
    (t) =>
      !selectedTagIds.includes(t.id) &&
      (tagSearch.length === 0 || t.name.toLowerCase().includes(tagSearch.toLowerCase()))
  );

  return (
    <div>
      <p className="mb-2 section-label">Tags</p>

      {selectedTagIds.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedTagIds.map((tid) => {
            const tag = allTags.find((t) => t.id === tid);
            if (!tag) return null;
            return (
              <span
                key={tid}
                className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-slate-900"
              >
                {tag.name}
                <button
                  type="button"
                  onClick={() => onTagIdsChange(selectedTagIds.filter((id) => id !== tid))}
                  aria-label={`Remove ${tag.name} filter`}
                  className="ml-0.5 rounded-full opacity-70 hover:opacity-100"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </span>
            );
          })}
        </div>
      )}

      <input
        type="text"
        value={tagSearch}
        onChange={(e) => setTagSearch(e.target.value)}
        onFocus={() => setTagFocused(true)}
        onBlur={() => setTimeout(() => setTagFocused(false), 150)}
        placeholder="Search tags..."
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
      />

      {(tagFocused || tagSearch.length > 0) && (
        filteredOptions.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {filteredOptions.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onMouseDown={() => {
                  onTagIdsChange([...selectedTagIds, tag.id]);
                  setTagSearch('');
                }}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500"
              >
                + {tag.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            {tagSearch.length > 0
              ? 'No tags match.'
              : activeTags.length === 0
              ? 'No tags available.'
              : 'All tags selected.'}
          </p>
        )
      )}
    </div>
  );
}
