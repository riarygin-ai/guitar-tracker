'use client';

// Listing Dashboard v1.0 — visibility, drill-down, and deterministic
// export over Listing Evidence v1.0. This page never recalculates listing
// state itself: every count and grouping rendered here comes straight out
// of the single fetchListingEvidence() call below (see the Listing
// Evidence migration's own header — it is the single authoritative source
// for current listing state; Dashboard/Analysis Packet/drill-down must
// never recompute it independently).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import CompactPageHeader from '@/components/CompactPageHeader';
import CopyAnalysisDataControl from '@/components/CopyAnalysisDataControl';
import CopyAnalysisScopeButton from '@/components/CopyAnalysisScopeButton';
import { fetchListingEvidence } from '@/lib/analytics/listingEvidenceClient';
import type {
  ListingEvidence,
  ChannelSummaryEntry,
  ListingAgeBucketCode,
} from '@/lib/analytics/listingEvidence';
import { fmtMoney, fmtDays, inventoryUrl, findPurposeId } from '@/lib/listingDashboardHelpers';

const AGE_BUCKET_LABELS: Record<ListingAgeBucketCode, string> = {
  LT_14: '< 14d',
  D14_30: '14-30d',
  D31_60: '31-60d',
  D61_90: '61-90d',
  D90_PLUS: '90+d',
};

export default function ListingsPage() {
  const [evidence, setEvidence] = useState<ListingEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedChannelId, setExpandedChannelId] = useState<number | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);

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

  const channels = useMemo(
    () => (evidence ? evidence.channel_summary.map((c) => ({ channel_id: c.channel_id, channel_name: c.channel_name })) : []),
    [evidence],
  );

  const businessPurposeId = evidence ? findPurposeId(evidence, 'Business') : null;
  const hybridPurposeId = evidence ? findPurposeId(evidence, 'Hybrid') : null;

  return (
    <div className="space-y-6">
      <CompactPageHeader
        overline="Listings"
        summary={
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Current listing state, sourced from Listing Evidence v1.0 — visibility and drill-down only, no recommendations.
          </p>
        }
        action={evidence ? <CopyAnalysisDataControl channels={channels} /> : undefined}
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

          <ChannelsSection
            evidence={evidence}
            expandedChannelId={expandedChannelId}
            onToggle={(id) => setExpandedChannelId((cur) => (cur === id ? null : id))}
          />

          <CrossListingSection evidence={evidence} />

          <CategoryChannelSection evidence={evidence} open={matrixOpen} onToggle={() => setMatrixOpen((v) => !v)} />

          <UnlistedSection evidence={evidence} businessPurposeId={businessPurposeId} hybridPurposeId={hybridPurposeId} />
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Overview — headline KPIs
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
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Listed Items" value={String(p.distinct_listed_item_count)} caption={`of ${p.open_item_count} open`} href={inventoryUrl({ listing: 'listed' })} />
        <StatTile label="Active Channel Listings" value={String(p.active_channel_listing_count)} caption="item/channel exposures" />
        <StatTile label="Cross-listed Items" value={String(p.cross_listed_item_count)} caption="2+ channels" href={inventoryUrl({ channel_count: '2,3_plus' })} />
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
// Channels
// ══════════════════════════════════════════════════════════════════════

function ChannelsSection({
  evidence,
  expandedChannelId,
  onToggle,
}: {
  evidence: ListingEvidence;
  expandedChannelId: number | null;
  onToggle: (id: number) => void;
}) {
  if (evidence.channel_summary.length === 0) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="section-title">Channels</p>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">No listing-capable channels have any active listings yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="section-title">Channels</p>
      <div className="mt-4 space-y-3">
        {evidence.channel_summary.map((channel) => (
          <ChannelCard
            key={channel.channel_id}
            channel={channel}
            expanded={expandedChannelId === channel.channel_id}
            onToggle={() => onToggle(channel.channel_id)}
          />
        ))}
      </div>
    </div>
  );
}

function ChannelCard({ channel, expanded, onToggle }: { channel: ChannelSummaryEntry; expanded: boolean; onToggle: () => void }) {
  const topCategories = [...channel.category_breakdown]
    .sort((a, b) => b.listed_item_count - a.listed_item_count)
    .slice(0, 4);
  const overNinety = channel.listing_age_bucket_breakdown.find((b) => b.bucket_code === 'D90_PLUS')?.item_count ?? 0;

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 p-4 text-left"
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <Link
            href={inventoryUrl({ channel_id: channel.channel_id })}
            onClick={(e) => e.stopPropagation()}
            className="font-semibold text-slate-900 hover:underline dark:text-white"
          >
            {channel.channel_name}
          </Link>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            {channel.listed_item_count} item{channel.listed_item_count === 1 ? '' : 's'}
          </p>
          {topCategories.length > 0 && (
            <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
              {topCategories.map((c) => `${c.category_name ?? 'Uncategorized'} ${c.listed_item_count}`).join(' · ')}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Median age {fmtDays(channel.median_current_listing_age_days)}
            {overNinety > 0 && <> · {overNinety} over 90d</>}
          </p>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`mt-1 shrink-0 text-slate-400 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-slate-200 p-4 dark:border-slate-700">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="section-label">Cost Basis</p>
              <p className="mt-0.5 font-medium text-slate-900 dark:text-white">{fmtMoney(channel.cost_basis)}</p>
            </div>
            <div>
              <p className="section-label">Est. Value</p>
              <p className="mt-0.5 font-medium text-slate-900 dark:text-white">{fmtMoney(channel.estimated_sold_value)}</p>
            </div>
            <div>
              <p className="section-label">Est. Equity</p>
              <p className="mt-0.5 font-medium text-slate-900 dark:text-white">{fmtMoney(channel.estimated_equity)}</p>
            </div>
            <div>
              <p className="section-label">Oldest Active</p>
              <p className="mt-0.5 font-medium text-slate-900 dark:text-white">{fmtDays(channel.oldest_current_listing_age_days)}</p>
            </div>
          </div>

          <div>
            <p className="section-label">Category</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {channel.category_breakdown.map((c) => (
                <Link
                  key={`${c.category_id}`}
                  href={inventoryUrl({ channel_id: channel.channel_id, category: c.category_name ?? undefined })}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                >
                  {c.category_name ?? 'Uncategorized'} {c.listed_item_count}
                </Link>
              ))}
            </div>
          </div>

          <div>
            <p className="section-label">Purpose</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {channel.purpose_breakdown.map((pu) => (
                <span key={pu.purpose_bucket} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium capitalize text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                  {pu.purpose_bucket} {pu.listed_item_count}
                </span>
              ))}
            </div>
          </div>

          <div>
            <p className="section-label">Listing Age (descriptive — not a performance score)</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {channel.listing_age_bucket_breakdown.map((b) => (
                <Link
                  key={b.bucket_code}
                  href={inventoryUrl({ channel_id: channel.channel_id, age_bucket: b.bucket_code })}
                  className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                >
                  {AGE_BUCKET_LABELS[b.bucket_code]} {b.item_count}
                </Link>
              ))}
              {channel.listing_age_bucket_breakdown.length === 0 && (
                <span className="text-xs text-slate-400 dark:text-slate-500">No age data available.</span>
              )}
            </div>
          </div>

          <CopyAnalysisScopeButton selection={{ scope: 'channel', channelId: channel.channel_id }} label={`Copy ${channel.channel_name} Analysis`} />
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Cross-listing
// ══════════════════════════════════════════════════════════════════════

function CrossListingSection({ evidence }: { evidence: ListingEvidence }) {
  const cl = evidence.cross_listing_evidence;
  const hasMultiChannelCombo = cl.combinations.some((c) => c.channel_ids.length > 1);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <p className="section-title">Channel Coverage</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Descriptive only — a single-channel item is not a coverage problem.</p>

      <div className="mt-3">
        <p className="section-label">By channel count</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {cl.by_active_channel_count.map((b) => (
            <Link
              key={b.active_channel_count}
              href={inventoryUrl({ channel_count: b.active_channel_count })}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
              {b.active_channel_count === '3_plus' ? '3+' : b.active_channel_count} channel{b.active_channel_count === '1' ? '' : 's'} · {b.item_count}
            </Link>
          ))}
        </div>
      </div>

      {cl.combinations.length > 0 && (
        <div className="mt-4">
          <p className="section-label">Combinations</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {cl.combinations.map((combo) => (
              <li key={combo.label} className="flex items-center justify-between gap-2">
                {combo.channel_ids.length === 1 ? (
                  <Link href={inventoryUrl({ channel_id: combo.channel_ids[0] })} className="min-w-0 break-words text-slate-700 hover:underline dark:text-slate-200">
                    {combo.label}
                  </Link>
                ) : (
                  <span className="min-w-0 break-words text-slate-700 dark:text-slate-200">{combo.label}</span>
                )}
                <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{combo.item_count}</span>
              </li>
            ))}
          </ul>
          {hasMultiChannelCombo && (
            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              Exact multi-channel combination drill-down isn&apos;t supported yet — use individual channel filters or channel count above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Category × Channel
// ══════════════════════════════════════════════════════════════════════

function CategoryChannelSection({ evidence, open, onToggle }: { evidence: ListingEvidence; open: boolean; onToggle: () => void }) {
  const matrix = evidence.category_channel_matrix;
  if (matrix.category_totals.length === 0) return null;

  const channelIds = evidence.channel_summary.map((c) => c.channel_id);
  const channelNameById = new Map(evidence.channel_summary.map((c) => [c.channel_id, c.channel_name]));

  const cellByKey = new Map<string, number>();
  for (const row of matrix.rows) cellByKey.set(`${row.category_id}:${row.channel_id}`, row.listed_item_count);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open}>
        <p className="section-title">Category × Channel</p>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-slate-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="mt-4">
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 md:block">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-700">
              <thead className="bg-slate-50 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                <tr>
                  <th className="px-3 py-2 font-semibold">Category</th>
                  {channelIds.map((id) => (
                    <th key={id} className="px-3 py-2 font-semibold">{channelNameById.get(id)}</th>
                  ))}
                  <th className="px-3 py-2 font-semibold">Total (distinct)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {matrix.category_totals.map((cat) => (
                  <tr key={`${cat.category_id}`}>
                    <td className="px-3 py-2 font-medium text-slate-900 dark:text-white">{cat.category_name ?? 'Uncategorized'}</td>
                    {channelIds.map((id) => {
                      const count = cellByKey.get(`${cat.category_id}:${id}`) ?? 0;
                      return (
                        <td key={id} className="px-3 py-2">
                          {count > 0 ? (
                            <Link href={inventoryUrl({ channel_id: id, category: cat.category_name ?? undefined })} className="tabular-nums text-slate-700 hover:underline dark:text-slate-200">
                              {count}
                            </Link>
                          ) : (
                            <span className="tabular-nums text-slate-300 dark:text-slate-600">0</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="px-3 py-2">
                      <Link href={inventoryUrl({ listing: 'listed', category: cat.category_name ?? undefined })} className="tabular-nums font-medium text-slate-900 hover:underline dark:text-white">
                        {cat.distinct_listed_item_count}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <div className="space-y-3 md:hidden">
            {matrix.category_totals.map((cat) => (
              <div key={`${cat.category_id}`} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 break-words font-medium text-slate-900 dark:text-white">{cat.category_name ?? 'Uncategorized'}</p>
                  <Link href={inventoryUrl({ listing: 'listed', category: cat.category_name ?? undefined })} className="shrink-0 text-xs font-medium text-slate-500 hover:underline dark:text-slate-400">
                    {cat.distinct_listed_item_count} distinct
                  </Link>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {channelIds.map((id) => {
                    const count = cellByKey.get(`${cat.category_id}:${id}`) ?? 0;
                    if (count === 0) return null;
                    return (
                      <Link
                        key={id}
                        href={inventoryUrl({ channel_id: id, category: cat.category_name ?? undefined })}
                        className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                      >
                        {channelNameById.get(id)} {count}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
            &quot;Total (distinct)&quot; comes directly from evidence — it is not the sum of the channel columns, since a cross-listed item counts once.
          </p>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
// Unlisted Inventory
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

      <div className="mt-4">
        <CopyAnalysisScopeButton selection={{ scope: 'unlisted' }} label="Copy Unlisted Analysis" />
      </div>
    </div>
  );
}
