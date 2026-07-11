'use client';

import React from 'react';

interface MoreFiltersToggleProps {
  isOpen: boolean;
  onToggle: () => void;
  count?: number;
  hasActiveFilters?: boolean;
  onClear?: () => void;
  children?: React.ReactNode;
}

export default function MoreFiltersToggle({
  isOpen,
  onToggle,
  count = 0,
  hasActiveFilters = false,
  onClear,
  children,
}: MoreFiltersToggleProps) {
  return (
    <>
      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggle}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
            isOpen
              ? 'border-slate-400 bg-slate-200 text-slate-800 dark:border-slate-500 dark:bg-slate-600 dark:text-white'
              : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700/80 dark:text-slate-300 dark:hover:bg-slate-600'
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="12" y1="18" x2="12" y2="18" strokeWidth="3"/>
          </svg>
          {isOpen ? 'Hide Filters' : `More Filters${count > 0 ? ` (${count})` : ''}`}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {hasActiveFilters && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-sm text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            Clear Filters
          </button>
        )}
      </div>
      {isOpen && children != null && (
        <div className="mt-3 space-y-4 border-t border-slate-200 pt-4 dark:border-slate-600">
          {children}
        </div>
      )}
    </>
  );
}
