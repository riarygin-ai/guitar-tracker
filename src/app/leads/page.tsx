'use client';

// Leads — read-only operational / data-QA screen for item_leads.
//
// Reached contextually (drill-downs from /listings); deliberately NOT in
// the primary navigation. The URL is the single source of truth for every
// filter: `filters` is re-derived from searchParams on every render and
// every change is written back with router.push/replace — there is no
// mirrored local filter state, so browser back/forward always agrees with
// what is on screen. (The search box is an uncontrolled input whose DOM
// value is reconciled to the URL, not a second copy of the filter.)
//
// No lead editing, no import logic and no evidence recomputation here:
// rows are displayed as stored; the exact channel-attributed cohort behind
// a /listings drill-down is resolved server-side (see /api/leads).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import CompactPageHeader from '@/components/CompactPageHeader';
import InfoTip from '@/components/InfoTip';
import { QualityBadge, StatusBadge } from '@/components/leads/LeadBadges';
import LeadDetailPanel from '@/components/leads/LeadDetailPanel';
import { fetchLeads } from '@/lib/leads/leadsClient';
import { LEAD_HELP } from '@/lib/leads/leadHelpText';
import {
  QUICK_FILTERS, NO_CHANNEL, activeQuickFilter, applyLeadFilters, attributionRequest, itemAttributionRequest, leadsUrl,
  parseLeadFilters, patchLeadFilters, quickFilterPatch, sortLeadsRecentFirst, type LeadFilters,
} from '@/lib/leads/leadFilters';
import {
  OFFER_TYPE_LABEL, QUALITY_LABEL, STATUS_LABEL, fmtLeadDate, fmtLeadDateFull, fmtMessages,
  formatOfferSummary, leadChannelLabel,
} from '@/lib/leads/leadFormat';
import { LEAD_QUALITIES, LEAD_STATUSES, OFFER_TYPES, type LeadsPayload } from '@/lib/leads/leadTypes';

const PAGE_SIZE = 50;

const CONTROL =
  'w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:bg-slate-700 dark:text-white';
const LABEL = 'mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400';

export default function LeadsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL -> filters, every render. Invalid params fall back to "no filter".
  const filters = parseLeadFilters((k) => searchParams.get(k));
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const attr = attributionRequest(filters);
  const attrKey = attr ? `${attr.channelId}|${attr.from}|${attr.to}` : '';
  const itemAttr = itemAttributionRequest(filters);
  const itemAttrKey = itemAttr ? `${itemAttr.itemId}|${itemAttr.from}|${itemAttr.to}` : '';
  const cohortKey = `${attrKey}#${itemAttrKey}`;

  const [loaded, setLoaded] = useState<{ key: string; payload: LeadsPayload } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // One fetch of the user's leads; re-fetched only when the requested
  // attribution cohort (channel + period) changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const [attrPart, itemPart] = cohortKey.split('#');
    const [channelId, from, to] = attrPart ? attrPart.split('|') : [];
    const [itemId, itemFrom, itemTo] = itemPart ? itemPart.split('|') : [];
    fetchLeads(
      attrPart ? { channelId: Number(channelId), from, to } : null,
      itemPart ? { itemId: Number(itemId), from: itemFrom, to: itemTo } : null,
    ).then((result) => {
      if (cancelled) return;
      if (result.status === 'success') setLoaded({ key: cohortKey, payload: result.data });
      else setError(result.message);
    });
    return () => { cancelled = true; };
  }, [cohortKey]);

  const ready = loaded !== null && loaded.key === cohortKey;
  const payload = ready ? loaded.payload : null;

  const attributedSet = payload?.attributed_lead_ids ? new Set(payload.attributed_lead_ids) : null;
  const itemAttributedSet = payload?.item_attributed_lead_ids ? new Set(payload.item_attributed_lead_ids) : null;
  const filtered = payload ? sortLeadsRecentFirst(applyLeadFilters(payload.leads, filters, attributedSet, itemAttributedSet)) : [];

  // Drill-down reconciliation diagnostic (development aid; UI stays calm).
  const expected = filters.expected;
  const filteredCount = filtered.length;
  useEffect(() => {
    if (!ready || expected === null) return;
    if (filteredCount !== expected) {
      const log = expected > 0 && filteredCount === 0 ? console.error : console.warn;
      log('[leads] drill-down count mismatch', { expected, actual: filteredCount, query: searchParams.toString() });
    }
  }, [ready, expected, filteredCount, searchParams]);

  // Show-more is derived per filter-set, so it resets whenever the URL changes.
  const queryKey = searchParams.toString();
  const [limitState, setLimitState] = useState({ key: queryKey, count: PAGE_SIZE });
  const visibleCount = limitState.key === queryKey ? limitState.count : PAGE_SIZE;
  const visible = filtered.slice(0, visibleCount);

  const update = (patch: Partial<LeadFilters>, mode: 'push' | 'replace' = 'push') => {
    router[mode](leadsUrl(patchLeadFilters(filtersRef.current, patch)), { scroll: false });
  };

  // Search: uncontrolled input, debounced into the URL; DOM value follows the URL on back/forward.
  const searchRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const el = searchRef.current;
    if (el && el.value.trim() !== filters.search) el.value = filters.search;
  }, [filters.search]);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  const closeDetail = useCallback(() => setSelectedId(null), []);
  const selectedLead = selectedId !== null && payload ? payload.leads.find((l) => l.id === selectedId) ?? null : null;

  const quick = activeQuickFilter(filters);
  const hasAnyFilter = leadsUrl({ ...filters, expected: null }) !== '/leads';
  const channelOptions = payload?.channels ?? [];
  const attributedChannelName = typeof filters.channel === 'number' ? channelOptions.find((c) => c.id === filters.channel)?.name ?? `Channel ${filters.channel}` : null;
  const itemChipName = filters.itemId != null ? payload?.leads.find((l) => l.inventory_item_id === filters.itemId)?.item_name ?? `Item #${filters.itemId}` : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <CompactPageHeader
        overline="Leads"
        summary={<p className="text-xs text-slate-500 dark:text-slate-400">Buyer conversations and recorded offers from your listing activity.</p>}
        action={
          <Link
            href="/listings"
            className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
          >
            <span aria-hidden="true">←</span> Listings
          </Link>
        }
      />

      {/* ── Filters ─────────────────────────────────────────────── */}
      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5">
        <div>
          <label htmlFor="lead-search" className={LABEL}>Search</label>
          <input
            id="lead-search"
            ref={searchRef}
            type="search"
            defaultValue={filters.search}
            placeholder="Item, trade item, or notes"
            onChange={(e) => {
              const v = e.target.value.trim();
              if (searchTimer.current) clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(() => update({ search: v }, 'replace'), 300);
            }}
            className={CONTROL}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className="min-w-0">
            <label htmlFor="lead-channel" className={LABEL}>Channel</label>
            <select
              id="lead-channel"
              value={filters.channel === null ? '' : String(filters.channel)}
              onChange={(e) => {
                const v = e.target.value;
                update({ channel: v === '' ? null : v === NO_CHANNEL ? NO_CHANNEL : Number(v) });
              }}
              className={CONTROL}
            >
              <option value="">All channels</option>
              {channelOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value={NO_CHANNEL}>Other / unknown</option>
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="lead-quality" className={LABEL}>Quality</label>
            <select id="lead-quality" value={filters.quality ?? ''} onChange={(e) => update({ quality: e.target.value ? (e.target.value as LeadFilters['quality']) : null })} className={CONTROL}>
              <option value="">All qualities</option>
              {LEAD_QUALITIES.map((q) => <option key={q} value={q}>{QUALITY_LABEL[q]}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="lead-offer-type" className={LABEL}>Offer type</label>
            <select id="lead-offer-type" value={filters.offerType ?? ''} onChange={(e) => update({ offerType: e.target.value ? (e.target.value as LeadFilters['offerType']) : null })} className={CONTROL}>
              <option value="">All offers</option>
              {OFFER_TYPES.map((t) => <option key={t} value={t}>{OFFER_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="lead-status" className={LABEL}>Status</label>
            <select id="lead-status" value={filters.status ?? ''} onChange={(e) => update({ status: e.target.value ? (e.target.value as LeadFilters['status']) : null })} className={CONTROL}>
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor="lead-from" className={LABEL}>From</label>
            <input id="lead-from" type="date" value={filters.from ?? ''} onChange={(e) => update({ from: e.target.value || null })} className={CONTROL} />
          </div>
          <div className="min-w-0">
            <label htmlFor="lead-to" className={LABEL}>To</label>
            <input id="lead-to" type="date" value={filters.to ?? ''} onChange={(e) => update({ to: e.target.value || null })} className={CONTROL} />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Quick filters" className="flex flex-wrap gap-2">
            {QUICK_FILTERS.map((q) => (
              <button
                key={q.key}
                type="button"
                aria-pressed={quick === q.key}
                onClick={() => update(quickFilterPatch(q.key))}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                  quick === q.key
                    ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                }`}
              >
                {q.label}
                {q.key === 'serious' && <span className="sr-only"> (Serious or High Intent)</span>}
              </button>
            ))}
          </div>
          <InfoTip label={LEAD_HELP.seriousPlus.label} text={LEAD_HELP.seriousPlus.text} />
          {hasAnyFilter && (
            <button
              type="button"
              onClick={() => router.push('/leads', { scroll: false })}
              className="ml-auto rounded-full px-2 py-1 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400 dark:hover:text-white"
            >
              Clear filters
            </button>
          )}
        </div>

        {(filters.attributed || filters.itemAttributed || filters.itemId != null) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {filters.attributed && (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-cyan-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-cyan-800 ring-1 ring-inset ring-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-200 dark:ring-cyan-800/60" data-chip="attributed">
                <span className="min-w-0 break-words">Channel-attributed · {attributedChannelName} · {fmtLeadDateFull(filters.from)} – {fmtLeadDateFull(filters.to)}</span>
                <InfoTip label={LEAD_HELP.attributed.label} text={LEAD_HELP.attributed.text} />
                <button type="button" aria-label="Remove channel-attributed cohort" onClick={() => update({ attributed: false })} className="rounded-full px-1.5 text-cyan-700 hover:bg-cyan-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-cyan-200 dark:hover:bg-cyan-800/50">×</button>
              </span>
            )}
            {filters.itemAttributed && (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-cyan-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-cyan-800 ring-1 ring-inset ring-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-200 dark:ring-cyan-800/60" data-chip="item-attributed">
                <span className="min-w-0 break-words">Listing-attributed · {fmtLeadDateFull(filters.from)} – {fmtLeadDateFull(filters.to)}</span>
                <InfoTip label={LEAD_HELP.itemAttributed.label} text={LEAD_HELP.itemAttributed.text} />
                <button type="button" aria-label="Remove listing-attributed cohort" onClick={() => update({ itemAttributed: false })} className="rounded-full px-1.5 text-cyan-700 hover:bg-cyan-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-cyan-200 dark:hover:bg-cyan-800/50">×</button>
              </span>
            )}
            {filters.itemId != null && (
              <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600" data-chip="item">
                <span className="min-w-0 break-words">Item: {itemChipName}</span>
                <button type="button" aria-label="Remove item filter" onClick={() => update({ itemId: null })} className="rounded-full px-1.5 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:hover:bg-slate-600">×</button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Results ─────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-center text-sm text-rose-700 shadow-sm dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400" role="alert">
          {error}
        </div>
      )}

      {!error && !ready && (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
          Loading leads...
        </div>
      )}

      {!error && payload && (
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-5">
          <p className="text-sm font-semibold text-slate-900 dark:text-white" aria-live="polite" data-lead-count>
            {filtered.length} {filtered.length === 1 ? 'lead' : 'leads'}
          </p>

          {filtered.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              {payload.leads.length === 0 ? 'No leads recorded yet.' : 'No leads match these filters.'}
            </p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="mt-3 hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 md:block">
                <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 dark:bg-slate-700/60 dark:text-slate-400">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Date</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Item</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Channel</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Quality</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Offer</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Status</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">
                        <span className="inline-flex items-center gap-1">Messages<InfoTip label={LEAD_HELP.messages.label} text={LEAD_HELP.messages.text} /></span>
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Last Contact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {visible.map((lead) => (
                      <tr key={lead.id} data-lead-row onClick={() => setSelectedId(lead.id)} className="cursor-pointer align-top transition hover:bg-slate-50 dark:hover:bg-slate-700/40">
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">{fmtLeadDate(lead.first_contact_at)}</td>
                        <td className="max-w-[16rem] px-3 py-2 font-medium text-slate-900 dark:text-white">
                          <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedId(lead.id); }} className="break-words text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                            {lead.item_name}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-slate-700 dark:text-slate-200">{leadChannelLabel(lead)}</td>
                        <td className="px-3 py-2"><QualityBadge quality={lead.lead_quality} /></td>
                        <td className="max-w-[16rem] break-words px-3 py-2 text-slate-700 dark:text-slate-200">{formatOfferSummary(lead)}</td>
                        <td className="px-3 py-2"><StatusBadge status={lead.status} /></td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">{fmtMessages(lead)}</td>
                        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">{fmtLeadDate(lead.last_contact_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <ul className="mt-3 space-y-2 md:hidden">
                {visible.map((lead) => (
                  <li key={lead.id}>
                    <button
                      type="button"
                      data-lead-card
                      onClick={() => setSelectedId(lead.id)}
                      className="block w-full min-w-0 rounded-xl border border-slate-200 p-3 text-left transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:hover:border-slate-600"
                    >
                      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        {fmtLeadDate(lead.first_contact_at)} · {leadChannelLabel(lead)}
                      </p>
                      <p className="mt-0.5 break-words text-base font-semibold leading-snug text-slate-900 dark:text-white">{lead.item_name}</p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <QualityBadge quality={lead.lead_quality} />
                        <StatusBadge status={lead.status} />
                      </div>
                      <p className="mt-2 break-words text-sm text-slate-700 dark:text-slate-200">{formatOfferSummary(lead)}</p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Messages: <span className="tabular-nums">{fmtMessages(lead)}</span> · Last contact: {fmtLeadDate(lead.last_contact_at)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>

              {filtered.length > visible.length && (
                <div className="mt-3 text-center">
                  <button
                    type="button"
                    onClick={() => setLimitState({ key: queryKey, count: visibleCount + PAGE_SIZE })}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    Show more ({filtered.length - visible.length} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {selectedLead && <LeadDetailPanel lead={selectedLead} onClose={closeDetail} />}
    </div>
  );
}
