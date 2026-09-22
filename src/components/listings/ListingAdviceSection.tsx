'use client';

// "Listing Advice" section on /listings — persisted AI interpretation of the
// 4-week Listing Demand evidence, shown right after Overview.
//
// DISPLAY-ONLY with respect to AI generation: this page shows the latest
// completed persisted advice and lets the user dismiss cards, but it can never
// generate or refresh advice. Listing Advice is produced solely by the
// Analytics workflow (Admin "Run Analytics" and the scheduled weekly run). It
// is optional enrichment: its own cache key/fetch/error state, and it never
// gates any other Listings section.

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ConfidencePill, PriorityBadge } from '@/components/AdviceCardView';
import ListingAdviceDrawer from '@/components/listings/ListingAdviceDrawer';
import { dismissListingAdvice, fetchLatestListingAdvice } from '@/lib/analytics/listingAdvice/listingAdviceClient';
import { LISTING_ADVICE_KEY } from '@/lib/listingsCacheKeys';
import { listingsCache } from '@/lib/listingsCacheStore';
import { useSwrResource } from '@/lib/useSwrResource';
import { listingAdviceKey } from '@/lib/listingAdviceKey';
import { formatWindowLabel } from '@/lib/listingAdviceView';
import { adviceLabels, formatAdviceTimestamp, resolveRevisionLanguage } from '@/lib/analytics/advice/adviceLabels';
import type { ListingAdviceCard } from '@/lib/analytics/listingAdvice/listingAdvice';

const TYPE_TONE: Record<string, string> = {
  action: 'text-violet-700 dark:text-violet-300',
  observation: 'text-cyan-700 dark:text-cyan-300',
  watch: 'text-slate-600 dark:text-slate-300',
};

const BTN = 'inline-flex h-8 items-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

export default function ListingAdviceSection({ returnTo }: { returnTo: string }) {
  const res = useSwrResource(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice);
  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<ListingAdviceCard | null>(null);

  const data = res.data;
  const latest = data?.latest ?? null;
  const allCards = latest?.output?.cards ?? [];
  // Chrome follows the language stored with the displayed run (legacy: viewer's current preference, then English).
  const language = resolveRevisionLanguage(latest?.input_packet?.language, data?.viewer_language);
  const L = adviceLabels(language);
  const dismissed = new Set([...(data?.dismissed_keys ?? []), ...hiddenKeys]);
  const cards = allCards.filter((c) => !dismissed.has(listingAdviceKey(c)));

  const dismiss = useCallback(async (card: ListingAdviceCard) => {
    if (!latest) return;
    const key = listingAdviceKey(card);
    setDismissError(null);
    setHiddenKeys((prev) => [...prev, key]); // optimistic
    const result = await dismissListingAdvice(latest.id, card.advice_code);
    if (!result.ok) {
      setHiddenKeys((prev) => prev.filter((k) => k !== key));
      setDismissError(result.message);
      return;
    }
    // Persisted: refresh the cached snapshot so the dismissal survives navigation.
    listingsCache.load(LISTING_ADVICE_KEY, fetchLatestListingAdvice, { force: true }).catch(() => undefined);
  }, [latest]);

  const closeDrawer = useCallback(() => setOpenCard(null), []);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5" data-listing-advice>
      <div className="min-w-0">
        <p className="section-title">{L.listingAdviceTitle}</p>
        {latest ? (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {L.generated} {formatAdviceTimestamp(latest.generated_at, language)} · {L.demandWindow}: {formatWindowLabel(latest.window_start, latest.window_end)}
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{L.listingAdviceSubtitle}</p>
        )}
      </div>

      {dismissError && (
        <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300" data-advice-error>
          {dismissError}
        </p>
      )}

      {!latest && res.isLoading && <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{L.loading}</p>}

      {!latest && res.error && (
        <div className="mt-3 flex flex-wrap items-center gap-3" data-advice-load-error>
          <p className="text-sm text-slate-500 dark:text-slate-400">{L.unavailable}</p>
          <button type="button" className={BTN} onClick={() => { listingsCache.load(LISTING_ADVICE_KEY, fetchLatestListingAdvice, { force: true }).catch(() => undefined); }}>{L.retry}</button>
        </div>
      )}

      {!latest && !res.isLoading && !res.error && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1" data-advice-empty>
          <p className="text-sm text-slate-500 dark:text-slate-400">{L.noneYet}</p>
          {data?.viewer_is_admin && (
            <Link href="/analytics" className="text-xs font-medium text-sky-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300">{L.runAnalytics}</Link>
          )}
        </div>
      )}

      {latest && allCards.length === 0 && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-advice-no-cards>{L.noMaterialAdvice}</p>
      )}

      {latest && allCards.length > 0 && cards.length === 0 && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-advice-all-dismissed>
          {L.allDismissed}
        </p>
      )}

      {latest && cards.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3" data-advice-grid>
          {cards.map((card) => (
            <div key={card.advice_code} className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/60 dark:hover:border-slate-600">
              <button
                type="button"
                data-advice-card
                onClick={() => setOpenCard(card)}
                className="flex min-w-0 flex-1 flex-col rounded-t-2xl p-3.5 pb-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              >
                <span className={`text-[11px] font-semibold uppercase tracking-wider ${TYPE_TONE[card.advice_type] ?? ''}`}>{L.type[card.advice_type]}</span>
                <span className="mt-1 break-words text-sm font-semibold leading-snug text-slate-900 dark:text-white">{card.title}</span>
                <span className="mt-1.5 line-clamp-4 break-words text-xs text-slate-600 dark:text-slate-300">{card.summary}</span>
                <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <PriorityBadge priority={card.priority} language={language} />
                  <ConfidencePill confidence={card.confidence_label} language={language} />
                </span>
                <span className="mt-2 text-[11px] font-medium text-slate-400 dark:text-slate-500">{L.viewDetails} ›</span>
              </button>
              <div className="flex justify-end px-3 pb-2.5">
                <button
                  type="button"
                  data-advice-dismiss
                  onClick={() => dismiss(card)}
                  aria-label={`${L.dismissAdvice}: ${card.title}`}
                  className="rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                >
                  {L.dismiss}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {latest && data?.viewer_is_admin && data.last_failure && (
        <p className="mt-3 text-[11px] text-slate-400 dark:text-slate-500" data-advice-last-failure>
          {L.lastFailure.replace('{code}', data.last_failure.error_code)}
        </p>
      )}

      {openCard && latest && (
        <ListingAdviceDrawer card={openCard} run={latest} returnTo={returnTo} showDebug={!!data?.viewer_is_admin} viewerLanguage={data?.viewer_language} onClose={closeDrawer} />
      )}
    </div>
  );
}
