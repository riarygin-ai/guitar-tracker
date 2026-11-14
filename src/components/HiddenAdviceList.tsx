'use client';

// Shared "hidden suggestions" UI for the two Coach modules (General Coach on
// the Dashboard, Listing Advice on /listings + the Dashboard subsection).
// Same semantics everywhere: Dismiss -> "Hidden until <date>" -> Resurface.
// The namespaces stay separate: each caller passes its own cards and keys.

import { useState } from 'react';
import type { HiddenAdviceCard } from '@/lib/analytics/coachState';
import { formatAdviceDate, hiddenCountLabel, type AdviceLabels } from '@/lib/analytics/advice/adviceLabels';
import type { AdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';

export default function HiddenAdviceList<T>({
  hidden, allHidden, titleOf, onResurface, resurfacingKey, L, language, allowList = true,
}: {
  hidden: HiddenAdviceCard<T>[];
  /** Every generated card is hidden: lead with "No new visible advice". */
  allHidden: boolean;
  titleOf: (card: T) => string;
  onResurface?: (key: string) => void;
  resurfacingKey?: string | null;
  L: AdviceLabels;
  language: AdviceLanguage;
  /** False = counts + next date only (compact Dashboard subsection). */
  allowList?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (hidden.length === 0) return null;
  const next = hidden[0]?.resurfaceAfter ?? null;

  return (
    <div className={allHidden ? '' : 'mt-3'} data-advice-hidden-summary>
      {allHidden && <p className="text-sm font-semibold text-slate-900 dark:text-white" data-advice-all-dismissed>{L.noVisibleAdvice}</p>}
      <p className={`${allHidden ? 'mt-1 text-sm' : 'text-xs'} text-slate-500 dark:text-slate-400`}>
        {hiddenCountLabel(L, hidden.length)}
        {next && <> {L.nextResurface.replace('{date}', formatAdviceDate(next, language))}</>}
        {allowList && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="font-medium text-sky-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
              data-advice-view-hidden
            >
              {open ? L.hideHidden : L.viewHidden}
            </button>
          </>
        )}
      </p>
      {allowList && open && (
        <ul className="mt-2 divide-y divide-slate-100 rounded-2xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700" data-advice-hidden-list>
          {hidden.map((h) => (
            <li key={h.key} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
              <span className="min-w-0 break-words text-sm text-slate-700 dark:text-slate-200">{titleOf(h.card)}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] text-slate-400 dark:text-slate-500">{L.hiddenUntil.replace('{date}', formatAdviceDate(h.resurfaceAfter, language))}</span>
                {onResurface && (
                  <button
                    type="button"
                    disabled={resurfacingKey === h.key}
                    onClick={() => onResurface(h.key)}
                    className="rounded-lg px-2 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-60 dark:text-sky-300 dark:hover:bg-slate-700"
                    data-advice-resurface
                  >
                    {L.resurface}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
