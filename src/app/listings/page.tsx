'use client';

// Listings + Demand Dashboard v1.0 — the primary operational Listings
// page: current listing snapshot (Listing Evidence v1.0) plus historical
// listing/demand activity (Listing Demand Evidence v1.0/v1.1). Neither
// evidence source is recalculated here — every count, average, and rate
// rendered on this page comes straight out of fetchListingEvidence() or
// fetchListingDemandEvidenceForCurrentUser(); this page only reshapes/
// formats those fields for display (see listingDashboardHelpers.ts and
// listingDemandDashboardHelpers.ts).
//
// The two evidence sources are fetched independently and fail
// independently: a Demand Evidence outage must never blank the snapshot
// Overview or Unlisted Inventory sections, which stay fully usable off
// Listing Evidence alone.

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import CompactPageHeader from '@/components/CompactPageHeader';
import CopyAnalysisDataControl from '@/components/CopyAnalysisDataControl';
import InfoTip from '@/components/InfoTip';
import Sparkline from '@/components/Sparkline';
import { fetchListingEvidence } from '@/lib/analytics/listingEvidenceClient';
import type { ListingEvidence } from '@/lib/analytics/listingEvidence';
import { fetchListingDemandEvidenceForCurrentUser } from '@/lib/analytics/listingDemandEvidenceClient';
import { fetchListingItemActivity } from '@/lib/analytics/listingItemActivityClient';
import type { ListingDemandEvidence } from '@/lib/analytics/listingDemandEvidence';
import { channelAttributedLeadsUrl, channelSeriousPlusUrl, itemAttributedLeadsUrl, itemOffersUrl, itemSeriousPlusUrl, marketWeekLeadsUrl, marketWeekSeriousPlusUrl, type DrillPeriod } from '@/lib/leads/leadDrilldownUrls';
import { itemActiveChannelsLabel, itemActivityWindow, itemActivityWindowKey, sortItemActivity, type ItemActivityEntry, type ItemActivityWindow } from '@/lib/listingItemActivityHelpers';
import { fmtLeadDate } from '@/lib/leads/leadFormat';
import { LISTING_HELP, type ListingHelpKey } from '@/lib/listingHelpText';
import { fmtMoney, inventoryUrl, findPurposeId } from '@/lib/listingDashboardHelpers';
import { resolveDayCountPreset } from '@/lib/listingDemandEvidenceClipboard';
import {
  TREND_WEEKS_OPTIONS,
  parseTrendWeeksParam,
  trendWeeksUrl,
  fmtRate,
  buildMarketActivityRows,
  buildChannelActivityRows,
  fmtWeekLabel,
  type TrendWeeks,
} from '@/lib/listingDemandDashboardHelpers';


export default function ListingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Trend Window: derived directly from the URL every render — no
  // separate synced local state, so there is no stale-state-vs-URL race
  // window (the class of bug previously fixed on /inventory). An invalid
  // or missing value safely falls back to 4, per parseTrendWeeksParam.
  const trendWeeks = parseTrendWeeksParam(searchParams.get('trend_weeks'));

  const [evidence, setEvidence] = useState<ListingEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [demandEvidence, setDemandEvidence] = useState<ListingDemandEvidence | null>(null);
  const [demandLoading, setDemandLoading] = useState(true);
  const [demandError, setDemandError] = useState<string | null>(null);

  // Listing Evidence — the current snapshot. Independent of Trend Window.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchListingEvidence().then((result) => {
      if (cancelled) return;
      if (result.status === 'success') {
        setEvidence(result.data);
      } else {
        setError(result.message);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Listing Demand Evidence — one shared fetch feeds both Market Activity
  // and Channel Activity. The "current" summary period is the latest
  // completed/current 7-day window ending today (the same day-count-preset
  // convention already used by the Admin Debug control); trend_weeks is
  // the only thing that changes when the Trend Window selector changes.
  useEffect(() => {
    let cancelled = false;
    setDemandLoading(true);
    setDemandError(null);
    const { startDate, endDate } = resolveDayCountPreset(7);
    fetchListingDemandEvidenceForCurrentUser({ startDate, endDate, trendWeeks }).then((result) => {
      if (cancelled) return;
      if (result.status === 'success') {
        setDemandEvidence(result.data);
      } else {
        setDemandError(result.message);
      }
      setDemandLoading(false);
    });
    return () => { cancelled = true; };
  }, [trendWeeks]);

  // Lead Activity by Item — ONE compact request per Trend Window, over the
  // exact window Listing Demand Evidence reports (first weekly bucket's
  // start -> last bucket's end). Only fetched once evidence for the CURRENT
  // trendWeeks has landed, so the section can never show a different
  // window from Market/Channel Activity.
  const evidenceMatchesWindow = demandEvidence !== null && demandEvidence.trend_window_weeks === trendWeeks && !demandLoading;
  const itemWindow: ItemActivityWindow | null = evidenceMatchesWindow ? itemActivityWindow(demandEvidence) : null;
  const itemWindowKey = itemActivityWindowKey(itemWindow);
  const [itemActivity, setItemActivity] = useState<{ key: string; items: ItemActivityEntry[] } | null>(null);
  const [itemError, setItemError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (!itemWindowKey) return;
    let cancelled = false;
    const [from, to] = itemWindowKey.split('|');
    fetchListingItemActivity(from, to).then((result) => {
      if (cancelled) return;
      if (result.status === 'success') { setItemActivity({ key: itemWindowKey, items: result.items }); setItemError(null); }
      else setItemError({ key: itemWindowKey, message: result.message });
    });
    return () => { cancelled = true; };
  }, [itemWindowKey]);
  const itemReady = itemActivity !== null && itemActivity.key === itemWindowKey;
  const itemErrorMessage = demandError ?? (itemError && itemError.key === itemWindowKey ? itemError.message : null);

  const businessPurposeId = evidence ? findPurposeId(evidence, 'Business') : null;
  const hybridPurposeId = evidence ? findPurposeId(evidence, 'Hybrid') : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <CompactPageHeader
        overline="Listings"
        summary={
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Current listing state and demand activity — visibility only, no recommendations.
          </p>
        }
        action={evidence ? <CopyAnalysisDataControl /> : undefined}
      />

      {loading && (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
          Loading listing evidence...
        </div>
      )}

      {error && (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700 shadow-sm dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
          {error}
        </div>
      )}

      {evidence && (
        <OverviewSection evidence={evidence} />
      )}

      {/* Demand sections never depend on Listing Evidence: they render (and the
          Trend Window stays usable) even when the snapshot failed to load. */}
      <MarketActivitySection evidence={demandEvidence} loading={demandLoading} error={demandError} trendWeeks={trendWeeks} onTrendChange={(w) => router.replace(trendWeeksUrl(w), { scroll: false })} />

      <ChannelActivitySection evidence={demandEvidence} loading={demandLoading} error={demandError} />

      <ItemActivitySection items={itemReady ? itemActivity.items : null} window={itemWindow} trendWeeks={trendWeeks} loading={!itemReady && !itemErrorMessage} error={itemErrorMessage} />

      {evidence && (
        <UnlistedSection evidence={evidence} businessPurposeId={businessPurposeId} hybridPurposeId={hybridPurposeId} />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Shared visual primitives — same language as the main Dashboard KPI
// cards (icon chip, uppercase label, bold tabular value). Semantic accent
// map: blue = listing/exposure, cyan = leads/demand activity, violet =
// Serious+ intent, emerald = Realized Deals. Accents only ever tint icons,
// small labels, and key values — never a channel itself (no good/bad
// coloring of a factual metric).
// ══════════════════════════════════════════════════════════════════════

type Tone = 'blue' | 'cyan' | 'violet' | 'emerald' | 'rose' | 'slate';

const TONE: Record<Tone, { chip: string; icon: string; text: string; pill: string }> = {
  blue: { chip: 'bg-blue-50 dark:bg-blue-900/20', icon: 'text-blue-500 dark:text-blue-400', text: 'text-blue-700 dark:text-blue-300', pill: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
  cyan: { chip: 'bg-cyan-50 dark:bg-cyan-900/20', icon: 'text-cyan-500 dark:text-cyan-400', text: 'text-cyan-700 dark:text-cyan-300', pill: 'bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300' },
  violet: { chip: 'bg-violet-50 dark:bg-violet-900/20', icon: 'text-violet-500 dark:text-violet-400', text: 'text-violet-700 dark:text-violet-300', pill: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300' },
  emerald: { chip: 'bg-emerald-50 dark:bg-emerald-900/20', icon: 'text-emerald-500 dark:text-emerald-400', text: 'text-emerald-700 dark:text-emerald-300', pill: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  rose: { chip: 'bg-rose-50 dark:bg-rose-900/20', icon: 'text-rose-500 dark:text-rose-400', text: 'text-rose-700 dark:text-rose-300', pill: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' },
  slate: { chip: 'bg-slate-100 dark:bg-slate-700', icon: 'text-slate-500 dark:text-slate-400', text: 'text-slate-700 dark:text-slate-200', pill: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
};

type IconName = 'list' | 'tag' | 'box' | 'trend' | 'message' | 'zap' | 'check' | 'eye' | 'chevron';

function Icon({ name, tone, className = 'h-3.5 w-3.5' }: { name: IconName; tone: Tone; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={`${className} ${TONE[tone].icon}`} aria-hidden="true" focusable="false">
      {name === 'list' && (<><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>)}
      {name === 'tag' && (<><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></>)}
      {name === 'box' && (<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>)}
      {name === 'trend' && (<><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></>)}
      {name === 'message' && <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />}
      {name === 'zap' && <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />}
      {name === 'check' && (<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>)}
      {name === 'eye' && (<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>)}
      {name === 'chevron' && <polyline points="9 18 15 12 9 6" />}
    </svg>
  );
}

/** Column/metric label with its ⓘ help control (definitions live in listingHelpText.ts). */
function MetricLabel({ help, text, icon, tone }: { help?: ListingHelpKey; text?: string; icon?: IconName; tone?: Tone }) {
  const def = help ? LISTING_HELP[help] : null;
  return (
    <span className="inline-flex items-center gap-1">
      {icon && tone && <Icon name={icon} tone={tone} className="h-3 w-3" />}
      <span>{text ?? def?.label}</span>
      {def && <InfoTip label={def.label} text={def.text} />}
    </span>
  );
}

/**
 * A metric value that can later become a drill-down link (Leads screen,
 * a later task) by simply passing `href`. With no href it renders plain
 * text — no dead links.
 */
function DrillValue({ children, href, className = '' }: { children: React.ReactNode; href?: string; className?: string }) {
  if (href) {
    return (
      <Link href={href} className={`inline-block py-0.5 underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${className}`}>
        {children}
      </Link>
    );
  }
  return <span className={className}>{children}</span>;
}

// ══════════════════════════════════════════════════════════════════════
// Overview — headline snapshot KPIs (Listing Evidence). Never changes
// when Trend Window changes — these four tiles have no dependency on
// demandEvidence/trendWeeks at all.
// ══════════════════════════════════════════════════════════════════════

function StatTile({ label, value, caption, href, icon, tone }: { label: string; value: string; caption?: string; href?: string; icon: IconName; tone: Tone }) {
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span className={`inline-flex shrink-0 rounded-lg p-1.5 ${TONE[tone].chip}`}>
          <Icon name={icon} tone={tone} />
        </span>
        <p className="min-w-0 text-[11px] font-medium uppercase leading-tight tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
        {href && <Icon name="chevron" tone="slate" className="ml-auto h-3.5 w-3.5 shrink-0" />}
      </div>
      <p className="mt-2 text-xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-2xl">{value}</p>
      {caption && <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{caption}</p>}
    </>
  );
  const className = 'rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-4';
  if (href) {
    return (
      <Link href={href} className={`block transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:border-slate-600 ${className}`}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function OverviewSection({ evidence }: { evidence: ListingEvidence }) {
  const p = evidence.population_summary;
  const equityTone: Tone = (p.listed_estimated_equity ?? 0) >= 0 ? 'emerald' : 'rose';
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5">
      <p className="section-title">Overview</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Listed Items" value={String(p.distinct_listed_item_count)} caption={`of ${p.open_item_count} open`} href={inventoryUrl({ listing: 'listed' })} icon="list" tone="blue" />
        <StatTile label="Listed Cost Basis" value={fmtMoney(p.listed_cost_basis)} caption="total acquisition cost" icon="tag" tone="violet" />
        <StatTile label="Estimated Listed Value" value={fmtMoney(p.listed_estimated_sold_value)} caption="user estimate" icon="box" tone="blue" />
        <StatTile label="Estimated Equity" value={fmtMoney(p.listed_estimated_equity)} caption="estimated − cost" icon="trend" tone={equityTone} />
      </div>
      {p.total_active_asking_value == null && (
        <p className="mt-3 text-[11px] text-slate-400 dark:text-slate-500">
          Asking prices aren&apos;t tracked — value uses your estimated sold value.
        </p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Trend Window — the ONE page-level trend-window selector, rendered in
// the Market Activity header. Channel Activity's trend reads this same
// value; there is no second 4/8/12 control anywhere else on this page.
// ══════════════════════════════════════════════════════════════════════

function TrendWindowControl({ trendWeeks, onChange }: { trendWeeks: TrendWeeks; onChange: (w: TrendWeeks) => void }) {
  return (
    <div role="group" aria-label="Trend Window" className="flex items-center gap-2">
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Trend Window</p>
      <div className="inline-flex rounded-full bg-slate-100 p-0.5 dark:bg-slate-700">
        {TREND_WEEKS_OPTIONS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            aria-pressed={trendWeeks === w}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              trendWeeks === w
                ? 'bg-slate-950 text-white shadow-sm dark:bg-white dark:text-slate-900'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
            }`}
          >
            {w}W
          </button>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Shared local loading/error presentation for the two Demand Evidence
// sections — each fails/loads independently of the rest of the page.
// ══════════════════════════════════════════════════════════════════════

function DemandSectionShell({
  title,
  titleHelp,
  helpText,
  action,
  loading,
  error,
  hasData,
  children,
}: {
  title: string;
  titleHelp?: ListingHelpKey;
  helpText?: string;
  action?: React.ReactNode;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="section-title inline-flex items-center gap-1.5">
            {title}
            {titleHelp && <InfoTip label={LISTING_HELP[titleHelp].label} text={LISTING_HELP[titleHelp].text} />}
          </p>
          {helpText && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{helpText}</p>}
        </div>
        {action != null && <div className="sm:shrink-0 sm:pt-1">{action}</div>}
      </div>

      {error && (
        <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
          {error}
        </p>
      )}

      {!error && loading && !hasData && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Loading...</p>
      )}

      {!error && hasData && <div className={loading ? 'mt-3 opacity-60 transition-opacity' : 'mt-3'}>{children}</div>}
    </div>
  );
}

/** Stacked label-over-value cell used by the mobile weekly/channel cards. */
function MiniStat({ label, value, tone }: { label: React.ReactNode; value: React.ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] leading-tight text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${tone ? TONE[tone].text : 'text-slate-900 dark:text-white'}`}>{value}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Market Activity — weekly_trend (Listing Demand Evidence). Leads
// (demand/activity) and Realized Deals (realized Sell/Trade activity) are
// shown side-by-side, never as a funnel — no conversion rate exists here
// or anywhere else in this evidence. Desktop: compact weekly table.
// Mobile: one compact card per week (no shrunken table).
// ══════════════════════════════════════════════════════════════════════

function MarketActivitySection({
  evidence,
  loading,
  error,
  trendWeeks,
  onTrendChange,
}: {
  evidence: ListingDemandEvidence | null;
  loading: boolean;
  error: string | null;
  trendWeeks: TrendWeeks;
  onTrendChange: (w: TrendWeeks) => void;
}) {
  const rows = evidence ? buildMarketActivityRows(evidence.weekly_trend) : [];

  return (
    <DemandSectionShell
      title="Market Activity"
      helpText="Leads and Realized Deals are shown side-by-side, not as a funnel."
      action={<TrendWindowControl trendWeeks={trendWeeks} onChange={onTrendChange} />}
      loading={loading}
      error={error}
      hasData={rows.length > 0}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No listing activity in the selected window yet.</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 md:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-700/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Week</th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="leadsPer100ChannelDays" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel text="Leads" icon="message" tone="cyan" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="seriousPlus" icon="zap" tone="violet" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="realizedDeals" icon="check" tone="emerald" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel text="Avg Listed" icon="list" tone="blue" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="avgChannelExposure" icon="eye" tone="blue" /></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {rows.map((row) => (
                  <tr key={row.startDate} data-week-row={row.startDate}>
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900 dark:text-white">{row.weekLabel}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={`inline-block rounded-md px-2 py-0.5 font-bold tabular-nums ${TONE.cyan.pill}`}>{fmtRate(row.leadsPer100ChannelDays)}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums"><DrillValue href={marketWeekLeadsUrl(row) ?? undefined} className={`font-medium ${TONE.cyan.text}`}>{row.leadsStarted}</DrillValue></td>
                    <td className="px-3 py-2 text-right tabular-nums"><DrillValue href={marketWeekSeriousPlusUrl(row) ?? undefined} className={`font-medium ${TONE.violet.text}`}>{row.seriousPlusLeads}</DrillValue></td>
                    <td className={`px-3 py-2 text-right font-medium tabular-nums ${TONE.emerald.text}`}>{row.realizedDeals}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtRate(row.avgListedItems)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtRate(row.avgChannelExposure)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile compact weekly cards */}
          <div className="space-y-2 md:hidden">
            {rows.map((row) => (
              <div key={row.startDate} data-week-card={row.startDate} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">{row.weekLabel}</p>
                  <div className="text-right">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-base font-bold leading-tight tabular-nums ${TONE.cyan.pill}`}>{fmtRate(row.leadsPer100ChannelDays)}</span>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400"><MetricLabel help="leadsPer100ChannelDays" /></div>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <MiniStat label="Leads" value={<DrillValue href={marketWeekLeadsUrl(row) ?? undefined}>{row.leadsStarted}</DrillValue>} tone="cyan" />
                  <MiniStat label={<MetricLabel help="seriousPlus" />} value={<DrillValue href={marketWeekSeriousPlusUrl(row) ?? undefined}>{row.seriousPlusLeads}</DrillValue>} tone="violet" />
                  <MiniStat label={<MetricLabel text="Deals" help="realizedDeals" />} value={row.realizedDeals} tone="emerald" />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2 dark:border-slate-700">
                  <MiniStat label="Avg Listed" value={fmtRate(row.avgListedItems)} />
                  <MiniStat label={<MetricLabel help="avgChannelExposure" />} value={fmtRate(row.avgChannelExposure)} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </DemandSectionShell>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Channel Activity — per-channel current-period snapshot (Listing Demand
// Evidence, 7-day cohort) plus its weekly Leads/100 Channel-Days trend
// across the selected Trend Window. Channels are read dynamically from
// evidence.channels — never a hardcoded channel set. Desktop: dense
// table. Mobile: one compact card per channel.
// ══════════════════════════════════════════════════════════════════════

function TrendSequence({ points, className = '' }: { points: { weekLabel: string; leadsPer100ChannelDays: number | null }[]; className?: string }) {
  const values = points.map((p) => p.leadsPer100ChannelDays);
  const titleText = points.map((p) => `${p.weekLabel}: ${fmtRate(p.leadsPer100ChannelDays)}`).join('\n');
  return (
    <span className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 ${className}`} title={titleText}>
      <Sparkline values={values} />
      <span className="text-[11px] tabular-nums text-slate-600 dark:text-slate-300">{values.map((v) => fmtRate(v)).join(' → ')}</span>
    </span>
  );
}

function ChannelActivitySection({ evidence, loading, error }: { evidence: ListingDemandEvidence | null; loading: boolean; error: string | null }) {
  const rows = evidence ? buildChannelActivityRows(evidence) : [];
  // Exact period the channel numbers were computed for — straight from the evidence, never recomputed here.
  const period: DrillPeriod | null = evidence ? { startDate: evidence.period.start_date, endDate: evidence.period.end_date } : null;

  return (
    <DemandSectionShell
      title="Channel Activity"
      helpText="Most recent week per channel; the trend follows the Trend Window above."
      loading={loading}
      error={error}
      hasData={rows.length > 0}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No listing-capable channels found.</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 md:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-700/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Channel</th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="channelListingDays" icon="eye" tone="blue" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel text="Attributed Leads" icon="message" tone="cyan" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="seriousPlus" icon="zap" tone="violet" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="realizedDeals" icon="check" tone="emerald" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="leadsPer100ChannelDays" /></th>
                  <th className="px-3 py-2 text-left font-semibold">{rows[0].weeklyTrend.length}W Trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {rows.map((row) => (
                  <tr key={row.dealChannelId} data-channel-row={row.dealChannelId}>
                    <td className="whitespace-nowrap px-3 py-2 font-semibold">
                      <Link href={inventoryUrl({ channel_id: row.dealChannelId })} className="text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-white">
                        {row.channelName}
                      </Link>
                    </td>
                    <td className={`px-3 py-2 text-right font-medium tabular-nums ${TONE.blue.text}`}>{row.channelListingDays}</td>
                    <td className="px-3 py-2 text-right tabular-nums"><DrillValue href={period ? channelAttributedLeadsUrl(period, row) ?? undefined : undefined} className={`font-medium ${TONE.cyan.text}`}>{row.attributedLeads}</DrillValue></td>
                    <td className="px-3 py-2 text-right tabular-nums"><DrillValue href={period ? channelSeriousPlusUrl(period, row) ?? undefined : undefined} className={`font-medium ${TONE.violet.text}`}>{row.seriousPlusLeads}</DrillValue></td>
                    <td className={`px-3 py-2 text-right font-medium tabular-nums ${TONE.emerald.text}`}>{row.realizedDeals}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={`inline-block rounded-md px-2 py-0.5 font-bold tabular-nums ${TONE.cyan.pill}`}>{fmtRate(row.leadsPer100ChannelDays)}</span>
                    </td>
                    <td className="px-3 py-2">
                      <TrendSequence points={row.weeklyTrend} className="max-w-[16rem]" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile compact channel cards */}
          <div className="space-y-2 md:hidden">
            {rows.map((row) => (
              <div key={row.dealChannelId} data-channel-card={row.dealChannelId} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-start justify-between gap-3">
                  <Link href={inventoryUrl({ channel_id: row.dealChannelId })} className="font-semibold text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-white">
                    {row.channelName}
                  </Link>
                  <div className="text-right">
                    <span className={`inline-block rounded-md px-2 py-0.5 text-base font-bold leading-tight tabular-nums ${TONE.cyan.pill}`}>{fmtRate(row.leadsPer100ChannelDays)}</span>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400"><MetricLabel help="leadsPer100ChannelDays" /></div>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  <MiniStat label={<MetricLabel text="Exposure" help="channelListingDays" />} value={row.channelListingDays} tone="blue" />
                  <MiniStat label="Leads" value={<DrillValue href={period ? channelAttributedLeadsUrl(period, row) ?? undefined : undefined}>{row.attributedLeads}</DrillValue>} tone="cyan" />
                  <MiniStat label={<MetricLabel help="seriousPlus" />} value={<DrillValue href={period ? channelSeriousPlusUrl(period, row) ?? undefined : undefined}>{row.seriousPlusLeads}</DrillValue>} tone="violet" />
                  <MiniStat label={<MetricLabel text="Deals" help="realizedDeals" />} value={row.realizedDeals} tone="emerald" />
                </div>
                <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-700">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{row.weeklyTrend.length}W Trend</p>
                  <TrendSequence points={row.weeklyTrend} className="mt-0.5" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </DemandSectionShell>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Lead Activity by Item — currently listed items over the SAME Trend
// Window as Market/Channel Activity (exact window = first weekly bucket's
// start .. last bucket's end, straight off Listing Demand Evidence). Every
// number comes from the server-side listing_demand_item_activity_v1_0
// helper: ITEM-attributed leads (the item had listing exposure, on any
// channel, on first_contact_at). Zero-activity listings stay visible.
// Item name -> Inventory item detail; the count values -> the exact
// attributed cohort on /leads (zero counts are plain text, never links).
// ══════════════════════════════════════════════════════════════════════

function ItemActivitySection({
  items,
  window: win,
  trendWeeks,
  loading,
  error,
}: {
  items: ItemActivityEntry[] | null;
  window: ItemActivityWindow | null;
  trendWeeks: TrendWeeks;
  loading: boolean;
  error: string | null;
}) {
  const rows = items ? sortItemActivity(items) : [];
  const hasData = items !== null;
  const drill = (item: ItemActivityEntry) => ({
    itemId: item.item_id,
    leads: item.item_attributed_leads,
    seriousPlus: item.serious_plus_attributed_leads,
    offers: item.offer_attributed_leads,
  });

  return (
    <DemandSectionShell
      title="Lead Activity by Item"
      titleHelp="leadActivityByItem"
      helpText={win ? `${fmtWeekLabel(win.from, win.to)} · ${trendWeeks}W Trend Window` : `${trendWeeks}W Trend Window`}
      loading={loading}
      error={error}
      hasData={hasData}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No currently listed items.</p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 md:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-700/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Item</th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel text="Leads" icon="message" tone="cyan" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="seriousPlus" icon="zap" tone="violet" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="offersAttributed" /></th>
                  <th className="px-3 py-2 text-right font-semibold"><MetricLabel help="channelDays" icon="eye" tone="blue" /></th>
                  <th className="px-3 py-2 text-left font-semibold">Last Lead</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {rows.map((item) => (
                  <tr key={item.item_id} data-item-row={item.item_id} className="align-top">
                    <td className="max-w-[20rem] px-3 py-2">
                      <Link href={`/inventory/${item.item_id}`} className="break-words font-medium text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-white">
                        {item.item_display_name}
                      </Link>
                      {itemActiveChannelsLabel(item) && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{itemActiveChannelsLabel(item)}</p>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`inline-block rounded-md px-2 py-0.5 font-bold tabular-nums ${TONE.cyan.pill}`}>
                        <DrillValue href={win ? itemAttributedLeadsUrl(win, drill(item)) ?? undefined : undefined}>{item.item_attributed_leads}</DrillValue>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums"><DrillValue href={win ? itemSeriousPlusUrl(win, drill(item)) ?? undefined : undefined} className={`font-medium ${TONE.violet.text}`}>{item.serious_plus_attributed_leads}</DrillValue></td>
                    <td className="px-3 py-2 text-right tabular-nums"><DrillValue href={win ? itemOffersUrl(win, drill(item)) ?? undefined : undefined} className="font-medium text-slate-700 dark:text-slate-200">{item.offer_attributed_leads}</DrillValue></td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{item.channel_listing_days}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">{item.last_attributed_lead_date ? fmtLeadDate(item.last_attributed_lead_date) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile compact item cards */}
          <div className="space-y-2 md:hidden">
            {rows.map((item) => (
              <div key={item.item_id} data-item-card={item.item_id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <Link href={`/inventory/${item.item_id}`} className="break-words font-semibold leading-snug text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-white">
                  {item.item_display_name}
                </Link>
                {itemActiveChannelsLabel(item) && <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{itemActiveChannelsLabel(item)}</p>}
                <div className="mt-2 grid grid-cols-4 gap-2">
                  <MiniStat label="Leads" value={<DrillValue href={win ? itemAttributedLeadsUrl(win, drill(item)) ?? undefined : undefined}>{item.item_attributed_leads}</DrillValue>} tone="cyan" />
                  <MiniStat label={<MetricLabel help="seriousPlus" />} value={<DrillValue href={win ? itemSeriousPlusUrl(win, drill(item)) ?? undefined : undefined}>{item.serious_plus_attributed_leads}</DrillValue>} tone="violet" />
                  <MiniStat label={<MetricLabel help="offersAttributed" />} value={<DrillValue href={win ? itemOffersUrl(win, drill(item)) ?? undefined : undefined}>{item.offer_attributed_leads}</DrillValue>} tone="slate" />
                  <MiniStat label={<MetricLabel help="channelDays" />} value={item.channel_listing_days} />
                </div>
                <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Last Lead <span className="ml-1 tabular-nums text-slate-700 dark:text-slate-200">{item.last_attributed_lead_date ? fmtLeadDate(item.last_attributed_lead_date) : '—'}</span>
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </DemandSectionShell>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Unlisted Inventory — sourced from Listing Evidence. Never depends on
// Trend Window/Demand Evidence.
// ══════════════════════════════════════════════════════════════════════

function UnlistedSection({
  evidence,
  businessPurposeId,
  hybridPurposeId,
}: {
  evidence: ListingEvidence;
  businessPurposeId: number | null;
  hybridPurposeId: number | null;
}) {
  const byPurpose = (bucket: 'business' | 'hybrid' | 'personal') => {
    const open = evidence.population_summary.open_item_count_by_purpose.find((p) => p.purpose_bucket === bucket)?.item_count ?? 0;
    const listed = evidence.population_summary.listed_item_count_by_purpose.find((p) => p.purpose_bucket === bucket)?.item_count ?? 0;
    const unlisted = evidence.population_summary.unlisted_item_count_by_purpose.find((p) => p.purpose_bucket === bucket)?.item_count ?? 0;
    return { open, listed, unlisted };
  };
  const business = byPurpose('business');
  const hybrid = byPurpose('hybrid');
  const personal = byPurpose('personal');

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5">
      <p className="section-title">Unlisted Inventory</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {/* Business — active realization, strongly drillable */}
        <div className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex items-center justify-between gap-2">
            <p className="section-label">Business</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{business.open} open · {business.listed} listed</p>
          </div>
          <Link
            href={businessPurposeId != null ? inventoryUrl({ listing: 'unlisted', purpose_id: businessPurposeId }) : inventoryUrl({ listing: 'unlisted' })}
            className="mt-2 flex items-center justify-center gap-1 rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            {business.unlisted} Unlisted Business
          </Link>
        </div>

        {/* Hybrid — neutral, no implication it should be listed */}
        <div className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex items-center justify-between gap-2">
            <p className="section-label">Hybrid</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">{hybrid.open} open · {hybrid.listed} listed</p>
          </div>
          <Link
            href={hybridPurposeId != null ? inventoryUrl({ listing: 'unlisted', purpose_id: hybridPurposeId }) : inventoryUrl({ listing: 'unlisted' })}
            className="mt-2 flex items-center justify-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {hybrid.unlisted} Unlisted Hybrid
          </Link>
          <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">Unlisted does not imply it should be listed.</p>
        </div>

        {/* Personal — informational only, never a drill-down target */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
          <p className="section-label">Personal</p>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{personal.open} open · {personal.listed} listed · {personal.unlisted} unlisted</p>
          <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">Not a listing-optimization target — informational only.</p>
        </div>
      </div>
    </div>
  );
}
