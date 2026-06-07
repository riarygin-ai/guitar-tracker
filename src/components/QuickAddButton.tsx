'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const OPTIONS = [
  { label: 'Buy',            href: '/operations/new?type=buy' },
  { label: 'Sell',           href: '/operations/new?type=sell' },
  { label: 'Trade',          href: '/operations/new?type=trade' },
  { label: 'Expense',        href: '/operations/new?type=expense' },
  { label: 'Inventory Item', href: '/inventory/new' },
] as const;

export default function QuickAddButton() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Quick add"
        aria-label="Quick add"
        aria-expanded={open}
        className="rounded-xl border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {/* plus */}
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800">
          {OPTIONS.map((opt, i) => (
            <Fragment key={opt.label}>
              {i === 4 && (
                <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(opt.href);
                }}
                className="flex w-full items-center px-4 py-2.5 text-sm text-slate-700 transition hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {opt.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
