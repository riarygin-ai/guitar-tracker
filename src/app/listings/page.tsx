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
import { fetchListingEvidence } from '@/lib/analytics/listingEvidenceClient';
import type { ListingEvidence } from '@/lib/analytics/listingEvidence';
import { fetchListingDemandEvidenceForCurrentUser } from '@/lib/analytics/listingDemandEvidenceClient';
import type { ListingDemandEvidence } from '@/lib/analytics/listingDemandEvidence';
import { fmtMoney, inventoryUrl, findPurposeId } from '@/lib/listingDashboardHelpers';
import { resolveDayCountPreset } from '@/lib/listingDemandEvidenceClipboard';
import {
  TREND_WEEKS_OPTIONS,
  parseTrendWeeksParam,
  trendWeeksUrl,
  fmtRate,
  buildMarketActivityRows,
  buildChannelActivityRows,
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

  const businessPurposeId = evidence ? findPurposeId(evidence, 'Business') : null;
  const hybridPurposeId = evidence ? findPurposeId(evidence, 'Hybrid') : null;

  return (
    <div className="space-y-6">
      <CompactPageHeader
        overline="Listings"
        summary={
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Current listing state and demand activity — visibility only, no recommendations.
          </p>
        }
        action={evidence ? <CopyAnalysisDataControl /> : undefined}
      />

      <TrendWindowControl
        trendWeeks={trendWeeks}
        onChange={(w) => router.replace(trendWeeksUrl(w), { scroll: false })}
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
        <>
          <OverviewSection evidence={evidence} />

          <MarketActivitySection evidence={demandEvidence} loading={demandLoading} error={demandError} />

          <ChannelActivitySection evidence={demandEvidence} loading={demandLoading} error={demandError} />

          <UnlistedSection evidence={evidence} businessPurposeId={businessPurposeId} hybridPurposeId={hybridPurposeId} />
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Trend Window — the ONE page-level trend-window selector. Historical
// sections (Market Activity, Channel Activity) all read this same value;
// there is no second 4/8/12 control anywhere else on this page.
// ══════════════════════════════════════════════════════════════════════

function TrendWindowControl({ trendWeeks, onChange }: { trendWeeks: TrendWeeks; onChange: (w: TrendWeeks) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:px-5">
      <p className="section-label shrink-0">Trend Window</p>
      <div className="flex flex-wrap gap-2">
        {TREND_WEEKS_OPTIONS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onChange(w)}
            aria-pressed={trendWeeks === w}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
              trendWeeks === w
                ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500'
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
// Overview — headline snapshot KPIs (Listing Evidence). Never changes
// when Trend Window changes — these four tiles have no dependency on
// demandEvidence/trendWeeks at all.
// ══════════════════════════════════════════════════════════════════════

function StatTile({ label, value, caption, href }: { label: string; value: string; caption?: string; href?: string }) {
  const inner = (
    <>
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-2xl">{value}</p>
      {caption && <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{caption}</p>}
    </>
  );
  const className = 'rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800/60 sm:p-5';
  if (href) {
    return (
      <Link href={href} className={`block transition hover:border-slate-300 dark:hover:border-slate-600 ${className}`}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function OverviewSection({ evidence }: { evidence: ListingEvidence }) {
  const p = evidence.population_summary;
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="section-title">Overview</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Listed Items" value={String(p.distinct_listed_item_count)} caption={`of ${p.open_item_count} open`} href={inventoryUrl({ listing: 'listed' })} />
        <StatTile label="Listed Cost Basis" value={fmtMoney(p.listed_cost_basis)} />
        <StatTile label="Estimated Listed Value" value={fmtMoney(p.listed_estimated_sold_value)} caption="user estimate" />
        <StatTile label="Estimated Equity" value={fmtMoney(p.listed_estimated_equity)} caption="estimated − cost" />
      </div>
      {p.total_active_asking_value == null && (
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          Asking price data isn&apos;t currently tracked for active listings — Estimated Listed Value uses estimated sold value, never a substituted asking price.
        </p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Shared local loading/error presentation for the two Demand Evidence
// sections — each fails/loads independently of the rest of the page.
// ══════════════════════════════════════════════════════════════════════

function DemandSectionShell({
  title,
  helpText,
  loading,
  error,
  hasData,
  children,
}: {
  title: string;
  helpText?: string;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="section-title">{title}</p>
      {helpText && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{helpText}</p>}

      {error && (
        <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
          {error}
        </p>
      )}

      {!error && loading && !hasData && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Loading...</p>
      )}

      {!error && hasData && <div className={loading ? 'mt-4 opacity-60 transition-opacity' : 'mt-4'}>{children}</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Market Activity — weekly_trend (Listing Demand Evidence). Leads
// (demand/activity) and Realized Deals (realized Sell/Trade activity) are
// shown side-by-side, never as a funnel — no conversion rate exists here
// or anywhere else in this evidence.
// ══════════════════════════════════════════════════════════════════════

function MarketActivitySection({ evidence, loading, error }: { evidence: ListingDemandEvidence | null; loading: boolean; error: string | null }) {
  const rows = evidence ? buildMarketActivityRows(evidence.weekly_trend) : [];

  return (
    <DemandSectionShell
      title="Market Activity"
      helpText="Leads reflect buyer demand/activity on your listings. Realized Deals reflect completed Sell/Trade activity in the same week. They are shown side-by-side, not as a funnel — a deal in a given week does not necessarily come from a lead shown in that same week."
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
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-700">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                <tr>
                  <th className="px-3 py-2 font-semibold">Week</th>
                  <th className="px-3 py-2 font-semibold">Leads / 100 Channel-Days</th>
                  <th className="px-3 py-2 font-semibold">Leads</th>
                  <th className="px-3 py-2 font-semibold">Serious+</th>
                  <th className="px-3 py-2 font-semibold">Realized Deals</th>
                  <th className="px-3 py-2 font-semibold">Avg Listed</th>
                  <th className="px-3 py-2 font-semibold">Avg Channel Exposure</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {rows.map((row) => (
                  <tr key={row.startDate}>
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900 dark:text-white">{row.weekLabel}</td>
                    <td className="px-3 py-2 font-semibold tabular-nums text-slate-900 dark:text-white">{fmtRate(row.leadsPer100ChannelDays)}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700 dark:text-slate-200">{row.leadsStarted}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700 dark:text-slate-200">{row.seriousPlusLeads}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700 dark:text-slate-200">{row.realizedDeals}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700 dark:text-slate-200">{fmtRate(row.avgListedItems)}</td>
                    <td className="px-3 py-2 tabular-nums text-slate-700 dark:text-slate-200">{fmtRate(row.avgChannelExposure)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <div className="space-y-3 md:hidden">
            {rows.map((row) => (
              <div key={row.startDate} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-slate-900 dark:text-white">{row.weekLabel}</p>
                  <p className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">{fmtRate(row.leadsPer100ChannelDays)}</p>
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500">Leads / 100 Channel-Days</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-slate-500 dark:text-slate-400">Leads </span><span className="tabular-nums text-slate-900 dark:text-white">{row.leadsStarted}</span></div>
                  <div><span className="text-slate-500 dark:text-slate-400">Serious+ </span><span className="tabular-nums text-slate-900 dark:text-white">{row.seriousPlusLeads}</span></div>
                  <div><span className="text-slate-500 dark:text-slate-400">Realized Deals </span><span className="tabular-nums text-slate-900 dark:text-white">{row.realizedDeals}</span></div>
                  <div><span className="text-slate-500 dark:text-slate-400">Avg Listed </span><span className="tabular-nums text-slate-900 dark:text-white">{fmtRate(row.avgListedItems)}</span></div>
                  <div className="col-span-2"><span className="text-slate-500 dark:text-slate-400">Avg Channel Exposure </span><span className="tabular-nums text-slate-900 dark:text-white">{fmtRate(row.avgChannelExposure)}</span></div>
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
// evidence.channels — never a hardcoded Marketplace/Kijiji/Reverb set.
// ══════════════════════════════════════════════════════════════════════

function ChannelActivitySection({ evidence, loading, error }: { evidence: ListingDemandEvidence | null; loading: boolean; error: string | null }) {
  const rows = evidence ? buildChannelActivityRows(evidence) : [];

  return (
    <DemandSectionShell
      title="Channel Activity"
      helpText="Attributed Leads and Realized Deals are shown side-by-side per channel — factual activity, not a performance judgment. Leads / 100 Channel-Days is the primary comparison metric because it normalizes demand by how much exposure a channel actually had."
      loading={loading}
      error={error}
      hasData={rows.length > 0}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No listing-capable channels found.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.dealChannelId} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
              <div className="flex items-start justify-between gap-3">
                <Link href={inventoryUrl({ channel_id: row.dealChannelId })} className="font-semibold text-slate-900 hover:underline dark:text-white">
                  {row.channelName}
                </Link>
                <div className="text-right">
                  <p className="text-lg font-bold tabular-nums text-slate-900 dark:text-white">{fmtRate(row.leadsPer100ChannelDays)}</p>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500">Leads / 100 Channel-Days</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="section-label">Channel Listing Days</p>
                  <p className="mt-0.5 font-medium tabular-nums text-slate-900 dark:text-white">{row.channelListingDays}</p>
                </div>
                <div>
                  <p className="section-label">Attributed Leads</p>
                  <p className="mt-0.5 font-medium tabular-nums text-slate-900 dark:text-white">{row.attributedLeads}</p>
                </div>
                <div>
                  <p className="section-label">Serious+</p>
                  <p className="mt-0.5 font-medium tabular-nums text-slate-900 dark:text-white">{row.seriousPlusLeads}</p>
                </div>
                <div>
                  <p className="section-label">Realized Deals</p>
                  <p className="mt-0.5 font-medium tabular-nums text-slate-900 dark:text-white">{row.realizedDeals}</p>
                </div>
              </div>

              {row.weeklyTrend.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead className="text-slate-500 dark:text-slate-400">
                      <tr>
                        {row.weeklyTrend.map((point) => (
                          <th key={point.startDate} className="whitespace-nowrap px-2 py-1 font-medium">{point.weekLabel}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {row.weeklyTrend.map((point) => (
                          <td key={point.startDate} className="whitespace-nowrap px-2 py-1 tabular-nums font-medium text-slate-900 dark:text-white">{fmtRate(point.leadsPer100ChannelDays)}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </DemandSectionShell>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Unlisted Inventory — unchanged, sourced from Listing Evidence. Never
// depends on Trend Window/Demand Evidence.
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
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="section-title">Unlisted Inventory</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {/* Business — active realization, strongly drillable */}
        <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <p className="section-label">Business</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{business.open} open · {business.listed} listed</p>
          <Link
            href={businessPurposeId != null ? inventoryUrl({ listing: 'unlisted', purpose_id: businessPurposeId }) : inventoryUrl({ listing: 'unlisted' })}
            className="mt-2 block rounded-xl bg-slate-950 px-3 py-2 text-center text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            {business.unlisted} Unlisted Business
          </Link>
        </div>

        {/* Hybrid — neutral, no implication it should be listed */}
        <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <p className="section-label">Hybrid</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hybrid.open} open · {hybrid.listed} listed</p>
          <Link
            href={hybridPurposeId != null ? inventoryUrl({ listing: 'unlisted', purpose_id: hybridPurposeId }) : inventoryUrl({ listing: 'unlisted' })}
            className="mt-2 block rounded-xl border border-slate-200 px-3 py-2 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {hybrid.unlisted} Unlisted Hybrid
          </Link>
          <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">Unlisted does not imply it should be listed — longer holding may be intentional.</p>
        </div>

        {/* Personal — informational only, never a drill-down target */}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700/40">
          <p className="section-label">Personal</p>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-200">{personal.open} open · {personal.listed} listed · {personal.unlisted} unlisted</p>
          <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">Not a listing-optimization target — informational only.</p>
        </div>
      </div>
    </div>
  );
}
