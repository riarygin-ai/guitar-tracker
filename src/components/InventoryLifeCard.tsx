'use client';

import Link from 'next/link';

export default function InventoryLifeCard({ itemId }: { itemId: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Trade Chain</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Full connected purchase, trade, and sale history.
          </p>
        </div>
        <Link
          href={`/inventory/${itemId}/chain`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
        >
          View Chain
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </Link>
      </div>
    </div>
  );
}
