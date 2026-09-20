'use client';

// "Listing Advice" section on /listings — persisted AI interpretation of the
// 4-week Listing Demand evidence, shown right after Overview. It is optional
// enrichment: it has its own cache key/fetch/error state and NEVER gates any
// other Listings section. Advice is generated manually (never on page load);
// while a refresh runs the previous completed cards stay visible, and a failed
// refresh keeps them and shows a local, non-destructive error.

import { useCallback, useState } from 'react';
import { ConfidencePill, PriorityBadge } from '@/components/AdviceCardView';
import ListingAdviceDrawer from '@/components/listings/ListingAdviceDrawer';
import { fetchLatestListingAdvice, requestListingAdviceGeneration } from '@/lib/analytics/listingAdvice/listingAdviceClient';
import { LISTING_ADVICE_KEY } from '@/lib/listingsCacheKeys';
import { listingsCache } from '@/lib/listingsCacheStore';
import { useSwrResource } from '@/lib/useSwrResource';
import { ADVICE_TYPE_LABEL, formatGeneratedAt, formatWindowLabel } from '@/lib/listingAdviceView';
import type { ListingAdviceCard } from '@/lib/analytics/listingAdvice/listingAdvice';

const TYPE_TONE: Record<string, string> = {
  action: 'text-violet-700 dark:text-violet-300',
  observation: 'text-cyan-700 dark:text-cyan-300',
  watch: 'text-slate-600 dark:text-slate-300',
};

const BTN = 'inline-flex h-8 items-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

export default function ListingAdviceSection({ returnTo }: { returnTo: string }) {
  const res = useSwrResource(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const data = res.data;
  const latest = data?.latest ?? null;
  const cards = latest?.output?.cards ?? [];
  // Another tab/device may be generating right now.
  const busy = generating || !!data?.generating;

  const generate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    const result = await requestListingAdviceGeneration();
    if (result.ok) {
      // Replace the displayed advice only now, after a successful generation.
      try {
        await listingsCache.load(LISTING_ADVICE_KEY, fetchLatestListingAdvice, { force: true });
      } catch {
        setGenError('Advice was generated but could not be refreshed on screen — reload to see it.');
      }
    } else {
      // Old completed cards stay on screen.
      setGenError(result.message);
    }
    setGenerating(false);
  }, [generating]);

  const closeDrawer = useCallback(() => setOpenIndex(null), []);
  const openCard: ListingAdviceCard | null = openIndex !== null && cards[openIndex] ? cards[openIndex] : null;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5" data-listing-advice>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="section-title inline-flex items-center gap-2">
            Listing Advice
            {busy && <span role="status" className="text-[11px] font-normal text-slate-400 dark:text-slate-500">Generating…</span>}
          </p>
          {latest ? (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Generated {formatGeneratedAt(latest.generated_at)} · 4-week demand window: {formatWindowLabel(latest.window_start, latest.window_end)}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">AI interpretation of your recent listing demand — separate from the facts below.</p>
          )}
        </div>
        {(latest || (!res.isLoading && !res.error)) && (
          <button type="button" onClick={generate} disabled={busy} className={BTN} data-advice-generate>
            {busy ? 'Generating…' : latest ? 'Refresh Advice' : 'Generate Listing Advice'}
          </button>
        )}
      </div>

      {genError && (
        <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300" data-advice-error>
          {genError}{latest ? ' Your previous advice is still shown below.' : ''}
        </p>
      )}

      {!latest && res.isLoading && <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Loading Listing Advice…</p>}

      {!latest && res.error && (
        <div className="mt-3 flex flex-wrap items-center gap-3" data-advice-load-error>
          <p className="text-sm text-slate-500 dark:text-slate-400">Listing Advice is unavailable right now.</p>
          <button type="button" className={BTN} onClick={() => { listingsCache.load(LISTING_ADVICE_KEY, fetchLatestListingAdvice, { force: true }).catch(() => undefined); }}>Retry</button>
        </div>
      )}

      {!latest && !res.isLoading && !res.error && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-advice-empty>No Listing Advice has been generated yet.</p>
      )}

      {latest && cards.length === 0 && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400" data-advice-no-cards>No material listing advice for this window.</p>
      )}

      {latest && cards.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3" data-advice-grid>
          {cards.map((card, i) => (
            <button
              key={card.advice_code + i}
              type="button"
              data-advice-card
              onClick={() => setOpenIndex(i)}
              className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-3.5 text-left transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-800/60 dark:hover:border-slate-600"
            >
              <span className={`text-[11px] font-semibold uppercase tracking-wider ${TYPE_TONE[card.advice_type] ?? ''}`}>{ADVICE_TYPE_LABEL[card.advice_type]}</span>
              <span className="mt-1 break-words text-sm font-semibold leading-snug text-slate-900 dark:text-white">{card.title}</span>
              <span className="mt-1.5 line-clamp-4 break-words text-xs text-slate-600 dark:text-slate-300">{card.summary}</span>
              <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <PriorityBadge priority={card.priority} />
                <ConfidencePill confidence={card.confidence_label} />
              </span>
              <span className="mt-2 text-[11px] font-medium text-slate-400 dark:text-slate-500">View details ›</span>
            </button>
          ))}
        </div>
      )}

      {openCard && latest && (
        <ListingAdviceDrawer card={openCard} run={latest} returnTo={returnTo} showDebug={!!data?.viewer_is_admin} onClose={closeDrawer} />
      )}
    </div>
  );
}
