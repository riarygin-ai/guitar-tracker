'use client';

// Dashboard "Listing Actions" — the compact Listing Advice subsection of the
// Business Coach. Reads the SAME persisted latest completed Listing Advice as
// /listings (same SWR cache key), never generates anything itself, and never
// silently disappears: none yet / no material actions / all hidden / stale /
// refresh failed are each stated explicitly. The detailed evidence drawer
// stays on /listings.

import Link from 'next/link';
import { useMemo } from 'react';
import { fetchLatestListingAdvice } from '@/lib/analytics/listingAdvice/listingAdviceClient';
import { LISTING_ADVICE_KEY } from '@/lib/listingsCacheKeys';
import { listingsCache } from '@/lib/listingsCacheStore';
import { useSwrResource } from '@/lib/useSwrResource';
import { listingAdviceKey } from '@/lib/listingAdviceKey';
import { deriveCoachModuleView, weeklyModuleFailureAt, type WeeklyCoachStatusPayload } from '@/lib/analytics/coachState';
import { formatAdviceDate, type AdviceLabels } from '@/lib/analytics/advice/adviceLabels';
import type { AdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';
import { PriorityBadge } from '@/components/AdviceCardView';
import HiddenAdviceList from '@/components/HiddenAdviceList';

const MAX_DASHBOARD_LISTING_CARDS = 3;

export default function DashboardListingActions({ weekly, L, language }: { weekly: WeeklyCoachStatusPayload | null; L: AdviceLabels; language: AdviceLanguage }) {
  const res = useSwrResource(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice);
  const data = res.data;
  const latest = data?.latest ?? null;

  const view = useMemo(() => deriveCoachModuleView({
    hasOutput: !!latest?.output,
    cards: latest?.output?.cards ?? [],
    keyOf: listingAdviceKey,
    dismissals: new Map((data?.dismissals ?? []).map((d) => [d.advice_key, d.resurface_after])),
    generatedAt: latest?.generated_at ?? null,
    failureTimes: [data?.last_failure?.created_at, weeklyModuleFailureAt(weekly, 'listings')],
  }), [latest, data, weekly]);

  const weeks = view.ageDays !== null ? Math.floor(view.ageDays / 7) : 0;

  return (
    <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-700" data-dashboard-listing-actions>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900 dark:text-white">{L.listingActions}</p>
        <Link href="/listings" className="text-xs font-medium text-sky-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300" data-listing-actions-view-all>
          {L.viewAllInListings} ›
        </Link>
      </div>

      {view.generatedAt && (
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400" data-listing-actions-freshness>
          {L.generated} {formatAdviceDate(view.generatedAt, language)} · {L.demandWindow}
        </p>
      )}
      {view.stale && view.generatedAt && (
        <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400" data-listing-actions-stale>
          {weeks >= 2 ? L.listingAdviceAge.replace('{n}', String(weeks)) : L.listingNotRefreshedSince.replace('{date}', formatAdviceDate(view.generatedAt, language))}
        </p>
      )}
      {view.refreshFailedAt && (
        <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400" data-listing-actions-failed>{L.listingRefreshFailed}</p>
      )}

      <div className="mt-3">
        {!data && res.isLoading ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{L.loading}</p>
        ) : !data && res.error ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{L.unavailable}</p>
        ) : view.content === 'none_yet' ? (
          <p className="text-sm text-slate-500 dark:text-slate-400" data-listing-actions-none>{L.noneYet}</p>
        ) : view.content === 'no_material' ? (
          <p className="text-sm text-slate-500 dark:text-slate-400" data-listing-actions-no-material>{L.noMaterialListingActions}</p>
        ) : view.content === 'all_dismissed' ? (
          <HiddenAdviceList hidden={view.hidden} allHidden titleOf={(c) => c.title} L={L} language={language} allowList={false} />
        ) : (
          <>
            <ul className="grid gap-2 lg:grid-cols-3" data-listing-actions-cards>
              {view.visible.slice(0, MAX_DASHBOARD_LISTING_CARDS).map((card) => (
                <li key={card.advice_code} className="min-w-0">
                  <Link href="/listings" className="flex h-full min-w-0 flex-col rounded-2xl border border-slate-200 p-3 transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:border-slate-600">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{L.type[card.advice_type]}</span>
                    <span className="mt-1 break-words text-sm font-semibold leading-snug text-slate-900 dark:text-white">{card.title}</span>
                    <span className="mt-1 line-clamp-2 break-words text-xs text-slate-600 dark:text-slate-300">{card.summary}</span>
                    <span className="mt-2"><PriorityBadge priority={card.priority} language={language} /></span>
                  </Link>
                </li>
              ))}
            </ul>
            <HiddenAdviceList hidden={view.hidden} allHidden={false} titleOf={(c) => c.title} L={L} language={language} allowList={false} />
          </>
        )}
      </div>
    </div>
  );
}
