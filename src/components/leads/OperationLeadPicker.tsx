'use client';

// Winning-lead picker for Sell / Trade operations.
//
// Hidden entirely when none of the outgoing items has an eligible lead (users
// who don't track leads see the form exactly as before). Otherwise the parent
// must require a choice: one lead, or the explicit "No matching lead". The
// initial list (top 6, ranked server-side) and search (server-side, bounded)
// both come from /api/operations/lead-candidates — the browser never holds
// the full lead history.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { StageBadge, StatusBadge } from '@/components/leads/LeadBadges';
import { fmtLeadDate } from '@/lib/leads/leadFormat';
import { calendarDateIn } from '@/lib/dateUtils';
import {
  createOperationWithLead,
  fetchOperationLeadCandidates,
  linkOperationLead,
  type LeadChoice,
  type OperationLeadCandidate,
  type OperationLeadCandidates,
} from '@/lib/leads/operationLeadsClient';
import { invalidateListingsCache } from '@/lib/listingsCacheStore';
import { leadSaveBlocker, type LeadPickerAvailability } from '@/lib/leads/operationLeadSave';
import type { LeadStatus } from '@/lib/leads/leadTypes';

export type { LeadPickerAvailability };

interface Props {
  itemIds: number[];
  value: LeadChoice;
  onChange: (choice: LeadChoice) => void;
  onAvailabilityChange: (a: LeadPickerAvailability) => void;
  /** Edit flow: the saved operation. Shows its linked lead read-only, else offers adding one. */
  dealId?: number;
  disabled?: boolean;
}

const NONE_ID = 'none';

/**
 * Form-side state for the winning lead.
 *  - NEW operation with a chosen lead: `saveNewWithLead` saves operation +
 *    link in one server transaction (nothing is saved unless all of it is);
 *    the operation key survives retries so a lost response never duplicates.
 *  - EXISTING operation (edit): the edit RPC commits first, then
 *    `linkAfterSave` links; on failure `pendingLink` keeps the operation id
 *    so Save retries ONLY the link.
 */
export function useOperationLeadLink() {
  const [choice, setChoice] = useState<LeadChoice>({ kind: 'unset' });
  const [availability, setAvailability] = useState<LeadPickerAvailability>({ lookup: 'idle', required: false, linked: null });
  const [pendingLink, setPendingLink] = useState<{ dealId: number; message: string } | null>(null);
  const operationKey = useRef<string | null>(null);

  const saveBlocker = leadSaveBlocker(availability, choice);

  async function saveNewWithLead(kind: 'sale' | 'trade', operation: Record<string, unknown>): Promise<{ ok: true; dealId: number } | { ok: false; message: string }> {
    if (choice.kind !== 'lead') return { ok: false, message: 'No lead selected.' };
    operationKey.current ??= crypto.randomUUID();
    const r = await createOperationWithLead({ kind, operation, leadId: choice.lead.lead_id, operationKey: operationKey.current });
    if (r.ok) { operationKey.current = null; invalidateListingsCache(); }
    return r;
  }

  /** Edit flow: links the chosen lead (if any) to the saved operation. true = done / nothing to link. */
  async function linkAfterSave(dealId: number): Promise<boolean> {
    if (choice.kind !== 'lead') { setPendingLink(null); return true; }
    const r = await linkOperationLead(dealId, choice.lead.lead_id);
    if (r.ok) { setPendingLink(null); return true; }
    setPendingLink({ dealId, message: r.message });
    return false;
  }

  function reset() { setChoice({ kind: 'unset' }); setPendingLink(null); operationKey.current = null; }

  return { choice, setChoice, availability, setAvailability, saveBlocker, pendingLink, saveNewWithLead, linkAfterSave, reset };
}

/** Edit flow: shown when the operation update saved but the lead link did not. */
export function LeadLinkFailure({ message, leadName, retrying, onRetry, onSkip }: { message: string; leadName: string; retrying: boolean; onRetry: () => void; onSkip: () => void }) {
  return (
    <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300" role="alert" data-testid="lead-link-failure">
      <p className="font-semibold">The operation was saved, but linking {leadName} failed.</p>
      <p className="mt-1">{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={retrying} onClick={onRetry} className="rounded-xl bg-amber-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-60">{retrying ? 'Retrying…' : 'Retry linking'}</button>
        <button type="button" disabled={retrying} onClick={onSkip} className="rounded-xl border border-amber-300 px-4 py-2 text-xs font-semibold">Continue without linking</button>
      </div>
    </div>
  );
}

export function leadDisplayName(c: Pick<OperationLeadCandidate, 'contact_name' | 'lead_id'>): string {
  return c.contact_name?.trim() || `Unnamed lead #${c.lead_id}`;
}

function channelText(c: OperationLeadCandidate): string {
  return [c.channel, c.channel_detail].filter(Boolean).join(' · ') || 'Unknown channel';
}

// Long names / trade descriptions wrap anywhere on mobile instead of being
// cut off; from `sm` up the original single-line (truncated) layout returns.
const WRAP = '[overflow-wrap:anywhere] sm:truncate';

/** One dropdown option: name + badges, then channel · offer · last activity. */
function CandidateLine({ c, showItem }: { c: OperationLeadCandidate; showItem: boolean }) {
  const last = c.last_activity_at ? fmtLeadDate(calendarDateIn(new Date(c.last_activity_at))) : null;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`min-w-0 text-sm font-semibold text-slate-900 dark:text-white ${WRAP}`}>{leadDisplayName(c)}</span>
        <StatusBadge status={c.status as LeadStatus} />
        {c.peak_stage && <StageBadge stage={c.peak_stage} />}
      </div>
      <p className={`mt-0.5 text-xs text-slate-500 dark:text-slate-400 ${WRAP}`}>
        {channelText(c)} · {c.offer_summary}{last ? ` · ${last}` : ''}
      </p>
      {showItem && <p className={`mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-300 ${WRAP}`}>For: {c.item_label}</p>}
    </div>
  );
}

/**
 * The chosen (or already linked) lead as a compact summary. Mobile: one
 * column — name (strongest), channel, stage + status badges on their own
 * wrapping row, then the offer — every line wraps. From `sm` up it is the
 * same two-line layout as a dropdown option (name + badges, then
 * channel · offer · last activity). Never notes, events, counts or ids.
 * `mobileAction` (the picker's "Change" cue) shares the NAME row on mobile,
 * so channel/badges/offer below get the card's full width.
 */
export function LeadSummary({ c, showItem, mobileAction }: { c: OperationLeadCandidate; showItem: boolean; mobileAction?: React.ReactNode }) {
  const last = c.last_activity_at ? fmtLeadDate(calendarDateIn(new Date(c.last_activity_at))) : null;
  return (
    <div className="min-w-0 flex-1" data-testid="lead-summary">
      <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-1.5">
        <span className="flex items-start justify-between gap-2 sm:contents">
          <span className={`min-w-0 text-sm font-semibold text-slate-900 dark:text-white ${WRAP}`} data-lead-name>{leadDisplayName(c)}</span>
          {mobileAction}
        </span>
        <span className="text-xs text-slate-500 [overflow-wrap:anywhere] dark:text-slate-400 sm:hidden" data-lead-channel>{channelText(c)}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 sm:mt-0" data-lead-badges>
          {c.peak_stage && <StageBadge stage={c.peak_stage} />}
          <StatusBadge status={c.status as LeadStatus} />
        </span>
      </div>
      <p className={`mt-1.5 text-xs text-slate-700 dark:text-slate-300 sm:mt-0.5 sm:text-slate-500 sm:dark:text-slate-400 ${WRAP}`} data-lead-offer>
        <span className="hidden sm:inline">{channelText(c)} · </span>
        {c.offer_summary}
        {last && <span className="hidden sm:inline"> · {last}</span>}
      </p>
      {showItem && <p className={`mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-300 ${WRAP}`}>For: {c.item_label}</p>}
    </div>
  );
}

export default function OperationLeadPicker({ itemIds, value, onChange, onAvailabilityChange, dealId, disabled }: Props) {
  const isEdit = dealId != null;
  const listId = useId();
  const itemKey = useMemo(() => Array.from(new Set(itemIds)).sort((a, b) => a - b).join(','), [itemIds]);
  const showItem = new Set(itemIds).size > 1;

  const [initial, setInitial] = useState<OperationLeadCandidates | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OperationLeadCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Keep the latest callbacks without re-running the load effect.
  const cb = useRef({ onChange, onAvailabilityChange, value });
  cb.current = { onChange, onAvailabilityChange, value };

  // Initial (unsearched) candidates for the current outgoing item set.
  useEffect(() => {
    const ids = itemKey ? itemKey.split(',').map(Number) : [];
    if (ids.length === 0 && !isEdit) {
      setInitial(null);
      setLoadError(null);
      cb.current.onAvailabilityChange({ lookup: 'idle', required: false, linked: null });
      if (cb.current.value.kind !== 'unset') cb.current.onChange({ kind: 'unset' });
      return;
    }
    const ctrl = new AbortController();
    setLoadError(null);
    // Until the lookup answers, the form does not know whether a choice is required.
    cb.current.onAvailabilityChange({ lookup: 'loading', required: false, linked: null });
    const fail = (message: string) => {
      setInitial(null);
      setLoadError(message);
      cb.current.onAvailabilityChange({ lookup: 'error', required: false, linked: null });
    };
    fetchOperationLeadCandidates({ itemIds: ids, dealId: dealId ?? null, signal: ctrl.signal })
      .then((r) => {
        if (r.status === 'error') { fail(r.message); return; }
        const d = r.data;
        setInitial(d);
        const required = d.linked == null && d.eligible_total > 0;
        cb.current.onAvailabilityChange({ lookup: 'ready', required, linked: d.linked });
        const v = cb.current.value;
        if (!required) {
          if (v.kind !== 'unset') cb.current.onChange({ kind: 'unset' });
          return;
        }
        // A selected lead whose item left the operation is no longer valid.
        if (v.kind === 'lead' && !ids.includes(v.lead.item_id)) {
          cb.current.onChange({ kind: 'unset' });
          return;
        }
        if (v.kind === 'unset') {
          if (isEdit) cb.current.onChange({ kind: 'none' });
          else if (d.eligible_total === 1 && d.candidates.length === 1) cb.current.onChange({ kind: 'lead', lead: d.candidates[0] });
        }
      })
      .catch((e) => { if ((e as { name?: string }).name !== 'AbortError') fail('Could not load leads.'); });
    return () => ctrl.abort();
  }, [itemKey, dealId, isEdit, reloadTick]);

  // Server-side search (debounced).
  useEffect(() => {
    if (!open || !query.trim()) { setResults(null); setSearching(false); return; }
    const ids = itemKey ? itemKey.split(',').map(Number) : [];
    const ctrl = new AbortController();
    setSearching(true);
    const t = setTimeout(() => {
      fetchOperationLeadCandidates({ itemIds: ids, q: query, signal: ctrl.signal })
        .then((r) => { setResults(r.status === 'success' ? r.data.candidates : []); setSearching(false); setActive(0); })
        .catch((e) => { if ((e as { name?: string }).name !== 'AbortError') setSearching(false); });
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query, open, itemKey]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); };
  }, [open]);

  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);

  if (loadError) {
    return (
      <div className="space-y-2" data-testid="lead-picker-error" role="alert">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Lead</p>
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <span className="min-w-0 flex-1">{loadError} Save is paused until we know whether these items have logged leads.</span>
          <button type="button" className="rounded-xl bg-amber-700 px-3 py-1.5 font-semibold text-white" onClick={() => setReloadTick((n) => n + 1)}>Retry</button>
        </div>
      </div>
    );
  }
  if (!initial) return null;

  if (initial.linked) {
    return (
      <div className="space-y-2" data-testid="lead-picker-linked">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Lead</p>
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-600 dark:bg-slate-700">
          <LeadSummary c={initial.linked} showItem={showItem} />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Linked winning lead. Changing it is a lead-history correction, not an operation edit.</p>
      </div>
    );
  }
  if (initial.eligible_total === 0) return null;

  const options: (OperationLeadCandidate | typeof NONE_ID)[] = [...(results ?? initial.candidates), NONE_ID];
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const select = (o: OperationLeadCandidate | typeof NONE_ID) => {
    onChange(o === NONE_ID ? { kind: 'none' } : { kind: 'lead', lead: o });
    setOpen(false);
    setQuery('');
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[active]) select(options[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };
  const hiddenCount = results == null ? initial.eligible_total - initial.candidates.length : 0;

  return (
    <div ref={rootRef} className="relative space-y-2" data-testid="lead-picker">
      <label className="text-sm font-medium text-slate-700 dark:text-slate-300" htmlFor={`${listId}-btn`}>
        Lead {!isEdit && <span className="text-rose-600">*</span>}
      </label>
      <button
        id={`${listId}-btn`}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setActive(0); }}
        className={`flex min-h-11 w-full justify-between gap-3 rounded-2xl border bg-white px-4 py-3 text-left text-sm outline-none transition focus:ring-2 focus:ring-slate-100 dark:bg-slate-700 dark:focus:ring-slate-600 items-center ${value.kind === 'unset' ? 'border-amber-300 dark:border-amber-600' : 'border-slate-200 dark:border-slate-600'}`}
        data-selected={value.kind}
      >
        {value.kind === 'lead' ? (
          <LeadSummary
            c={value.lead}
            showItem={showItem}
            mobileAction={<span aria-hidden="true" className="-mr-1 -mt-0.5 shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 dark:border-slate-500 dark:text-slate-300 sm:hidden" data-lead-change>Change</span>}
          />
        ) : value.kind === 'none' ? (
          <span className="text-slate-900 dark:text-slate-100" data-testid="lead-picker-none">No matching lead</span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Choose who bought / traded…</span>
        )}
        {/* Selected lead: mobile shows the "Change" cue in the name row (the whole card is the tap target); desktop keeps the chevron. */}
        <svg className={`h-4 w-4 shrink-0 text-slate-400 ${value.kind === 'lead' ? 'hidden sm:block' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {isEdit
          ? 'Optional: link the winning lead to this operation.'
          : `${initial.eligible_total} logged lead${initial.eligible_total === 1 ? '' : 's'} on ${showItem ? 'these items' : 'this item'}. Pick the winner, or "No matching lead" if the buyer wasn't logged.`}
      </p>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg dark:border-slate-600 dark:bg-slate-800">
          <div className="border-b border-slate-100 p-2 dark:border-slate-700">
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={`${listId}-list`}
              aria-activedescendant={optionId(active)}
              aria-autocomplete="list"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search by name or channel…"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
          </div>
          <ul id={`${listId}-list`} role="listbox" className="max-h-80 overflow-y-auto py-1">
            {searching && <li className="px-4 py-2 text-xs text-slate-500">Searching…</li>}
            {!searching && results != null && results.length === 0 && <li className="px-4 py-2 text-xs text-slate-500">No leads match &ldquo;{query}&rdquo;.</li>}
            {options.map((o, i) => {
              const selected = o === NONE_ID ? value.kind === 'none' : value.kind === 'lead' && value.lead.lead_id === o.lead_id;
              return (
                <li
                  key={o === NONE_ID ? NONE_ID : o.lead_id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(o)}
                  className={`cursor-pointer px-4 py-2.5 ${i === active ? 'bg-slate-100 dark:bg-slate-700' : ''} ${o === NONE_ID ? 'border-t border-slate-100 dark:border-slate-700' : ''}`}
                >
                  {o === NONE_ID ? (
                    <div>
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">No matching lead</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">The buyer wasn&apos;t logged as a lead. Nothing gets linked.</p>
                    </div>
                  ) : (
                    <CandidateLine c={o} showItem={showItem} />
                  )}
                </li>
              );
            })}
          </ul>
          {hiddenCount > 0 && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">{hiddenCount} more — type to search.</p>}
        </div>
      )}
    </div>
  );
}
