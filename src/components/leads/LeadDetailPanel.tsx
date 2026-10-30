'use client';

// Lead detail: right-hand drawer on md+, bottom sheet on mobile.
// Top = the current lead snapshot exactly as stored; below = the lead's
// history: its lead_events as an oldest-first timeline (fetched when the
// drawer opens — the list never loads events), with the legacy Lead Log
// notes demoted to a collapsed section. A legacy lead without real events
// shows its notes as the primary "Historical summary" instead.
// The one edit control is the contact name (add / correct / clear) — saved
// through /api/leads/:id/contact-name, which also updates contact_key and
// records an audit note; nothing else about the lead changes. Contact city and
// phone (identity signals recorded by direct writes) show under the name, only
// when present.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import InfoTip from '@/components/InfoTip';
import { StageBadge, StatusBadge } from '@/components/leads/LeadBadges';
import { LEAD_HELP, type LeadHelpKey } from '@/lib/leads/leadHelpText';
import {
  describeCashComponent, fmtCad, fmtLeadDateFull, fmtTimestamp, formatOfferSummary,
  leadChannelLabel, OFFER_TYPE_LABEL, outcomeReasonLabel, QUALITY_LABEL,
} from '@/lib/leads/leadFormat';
import LeadHistorySection from '@/components/leads/LeadHistorySection';
import { buildLeadHistory, type LeadHistory } from '@/lib/leads/leadEventHistory';
import { fetchLeadEvents, saveLeadContactName } from '@/lib/leads/leadsClient';
import type { LeadRow } from '@/lib/leads/leadTypes';

const STAGE_SOURCE_LABEL: Record<string, string> = { DERIVED: 'from events', LEGACY_AUDIT: 'legacy audit', LEGACY_STRUCTURED: 'legacy fields' };

const NAME_SOURCE_LABEL: Record<NonNullable<LeadRow['contact_name_source']>, string> = {
  LEAD_LOG: 'from the Lead Log', NOTES_PREFIX_V1: 'from the notes', DIRECT: 'logged directly', USER_EDIT: 'edited by you',
};

function ContactNameField({ lead, onSaved }: { lead: LeadRow; onSaved: (patch: Partial<LeadRow>) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lead.contact_name ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const attempt = useRef<{ value: string; id: string } | null>(null);

  const start = () => { setDraft(lead.contact_name ?? ''); setError(null); setConfirm(null); setEditing(true); };
  const cancel = () => { setEditing(false); setError(null); setConfirm(null); };

  const save = async (confirmed: boolean) => {
    const value = draft.replace(/\s+/g, ' ').trim();
    // Same typed value = same attempt (retry / confirm replays instead of writing twice).
    if (!attempt.current || attempt.current.value !== value) attempt.current = { value, id: crypto.randomUUID() };
    setSaving(true);
    setError(null);
    const r = await saveLeadContactName(lead.id, value === '' ? null : value, lead.version, attempt.current.id, confirmed);
    setSaving(false);
    if (r.status === 'confirm') { setConfirm(r.message); return; }
    if (r.status === 'error') { setError(r.message); return; }
    if (r.status === 'renamed') onSaved({ contact_name: r.lead.contact_name, contact_name_source: r.lead.contact_name_source, version: r.lead.version });
    attempt.current = null;
    setConfirm(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="col-span-2 flex items-start justify-between gap-3" data-contact-name>
        <Field label="Contact">
          {lead.contact_name ? (
            <>
              <span className="font-semibold">{lead.contact_name}</span>
              {lead.contact_name_source && <span className="ml-1 text-[11px] text-slate-500 dark:text-slate-400">{NAME_SOURCE_LABEL[lead.contact_name_source]}</span>}
            </>
          ) : <span className="text-slate-400 dark:text-slate-500">No name recorded</span>}
          {lead.contact_city && <span className="mt-0.5 block text-xs text-slate-600 [overflow-wrap:anywhere] dark:text-slate-300" data-contact-city>{lead.contact_city}</span>}
          {lead.contact_phone && (
            <a href={`tel:${lead.contact_phone.replace(/[^\d+]/g, '')}`} className="mt-0.5 block text-xs text-sky-700 [overflow-wrap:anywhere] hover:underline dark:text-sky-400" data-contact-phone>{lead.contact_phone}</a>
          )}
        </Field>
        <button type="button" onClick={start} data-contact-name-edit className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700">
          {lead.contact_name ? 'Edit' : 'Add name'}
        </button>
      </div>
    );
  }

  return (
    <form className="col-span-2 space-y-2" data-contact-name-form onSubmit={(e) => { e.preventDefault(); void save(false); }}>
      <label htmlFor={`contact-name-${lead.id}`} className="block text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Contact name</label>
      <input
        id={`contact-name-${lead.id}`}
        autoFocus
        value={draft}
        maxLength={120}
        disabled={saving}
        onChange={(e) => { setDraft(e.target.value); setConfirm(null); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}
        placeholder='e.g. Nick (collector) — leave empty for no name'
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:bg-slate-700 dark:text-white"
      />
      <p className="text-[11px] text-slate-500 dark:text-slate-400">Keep qualifiers in parentheses to tell people apart. Only the name changes — stage, status and offers stay as they are.</p>
      {confirm && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300" role="alert" data-contact-name-confirm>
          {confirm}
          <button type="button" disabled={saving} onClick={() => void save(true)} className="ml-2 font-semibold underline">Save anyway</button>
        </div>
      )}
      {error && <p className="text-xs text-rose-700 dark:text-rose-400" role="alert" data-contact-name-error>{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60 dark:bg-white dark:text-slate-900">{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" disabled={saving} onClick={cancel} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">Cancel</button>
      </div>
    </form>
  );
}

function Field({ label, help, children }: { label: string; help?: LeadHelpKey; children: React.ReactNode }) {
  return (
    <dl className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
        {help && <InfoTip label={LEAD_HELP[help].label} text={LEAD_HELP[help].text} />}
      </dt>
      <dd className="mt-0.5 min-w-0 break-words text-sm text-slate-900 dark:text-slate-100">{children}</dd>
    </dl>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 pt-4 dark:border-slate-700">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">{title}</h3>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3">{children}</div>
    </section>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export default function LeadDetailPanel({ lead, onClose, onLeadUpdated }: { lead: LeadRow; onClose: () => void; onLeadUpdated?: (id: number, patch: Partial<LeadRow>) => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [loadedHistory, setLoadedHistory] = useState<{ key: string; history: LeadHistory | null; error: string | null } | null>(null);
  const historyKey = `${lead.id}:${lead.version}`;

  // History for THIS lead only, fetched on open (and after a rename bumps the version).
  useEffect(() => {
    let cancelled = false;
    fetchLeadEvents(lead.id).then((r) => {
      if (cancelled) return;
      setLoadedHistory(r.status === 'success' ? { key: historyKey, history: buildLeadHistory(r.events), error: null } : { key: historyKey, history: null, error: r.message });
    });
    return () => { cancelled = true; };
  }, [lead.id, historyKey]);
  const historyState = loadedHistory?.key === historyKey ? loadedHistory : null;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <button type="button" aria-label="Close lead details" tabIndex={-1} onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-slate-900/40" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-detail-title"
        data-lead-detail
        className="absolute inset-x-0 bottom-0 flex max-h-[90vh] flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[30rem] md:rounded-l-3xl md:rounded-tr-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-700">
          <div className="min-w-0">
            <h2 id="lead-detail-title" className="break-words text-base font-semibold text-slate-900 dark:text-white">{lead.item_name}</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {lead.contact_name ? <span className="font-semibold text-slate-700 dark:text-slate-200">{lead.contact_name} · </span> : null}
              {leadChannelLabel(lead)} · first contact {fmtLeadDateFull(lead.first_contact_at)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StageBadge stage={lead.peak_stage} />
              <StatusBadge status={lead.status} />
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-full p-2 text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <Link
            href={`/inventory/${lead.inventory_item_id}`}
            className="inline-flex items-center gap-1 rounded-xl bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            Open Item
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
          </Link>

          <Section title="Lead">
            <ContactNameField key={`${lead.id}:${lead.version}`} lead={lead} onSaved={(patch) => onLeadUpdated?.(lead.id, patch)} />
            <Field label="First contact">{fmtLeadDateFull(lead.first_contact_at)}</Field>
            <Field label="Last contact">{fmtLeadDateFull(lead.last_contact_at)}</Field>
            <Field label="Channel">{leadChannelLabel(lead)}</Field>
            <Field label="Peak stage"><StageBadge stage={lead.peak_stage} />{lead.peak_stage_source && <span className="ml-1 text-[11px] text-slate-500 dark:text-slate-400">{STAGE_SOURCE_LABEL[lead.peak_stage_source] ?? lead.peak_stage_source}</span>}</Field>
            <Field label="Status"><StatusBadge status={lead.status} /></Field>
            <Field label="Outcome reason">{outcomeReasonLabel(lead.outcome_reason)}</Field>
          </Section>

          <Section title="Messages">
            <Field label="Buyer messages" help="messages">{lead.buyer_message_count ?? '—'}</Field>
            <Field label="Our messages">{lead.our_message_count ?? '—'}</Field>
          </Section>

          <Section title="Offer">
            <div className="col-span-2 rounded-xl bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900 dark:bg-slate-700/50 dark:text-white">{formatOfferSummary(lead)}</div>
            <Field label="Offer type">{OFFER_TYPE_LABEL[lead.offer_type]} <span className="font-mono text-[11px] text-slate-400">({lead.offer_type})</span></Field>
            <Field label="Initial cash offer">{fmtCad(lead.initial_cash_offer)}</Field>
            <Field label="Best cash offer">{fmtCad(lead.best_cash_offer)}</Field>
            <Field label="Trade item">{lead.trade_item?.trim() ? lead.trade_item : '—'}</Field>
            <Field label="Cash component" help="cashComponent">
              <span data-cash-component>{describeCashComponent(lead)}</span>
            </Field>
            <Field label="Trade est. value" help="tradeEstValue">{fmtCad(lead.trade_est_value)}</Field>
          </Section>

          <LeadHistorySection history={historyState?.history ?? null} notes={lead.notes} error={historyState?.error} />

          <details open className="group border-t border-slate-100 pt-4 dark:border-slate-700">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400">
              Source / Data QA
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-y-2 text-slate-600 dark:text-slate-300">
              <Field label="Lead ID"><span className="break-all font-mono text-[11px]">{lead.lead_id}</span></Field>
              <Field label="Legacy quality"><span className="text-xs" data-legacy-quality>{lead.lead_quality ? `${QUALITY_LABEL[lead.lead_quality]} (Lead Log, superseded by peak stage)` : '— (none)'}</span></Field>
              <Field label="Source channel (as logged)"><span className="text-xs">{lead.source_channel?.trim() || '—'}</span></Field>
              <Field label="Normalized channel"><span className="text-xs">{lead.channel_name ?? '— (none)'}</span></Field>
              <Field label="Source updated"><span className="text-xs" data-source-updated-at>{fmtTimestamp(lead.source_updated_at)}</span> <span className="font-mono text-[10px] text-slate-400">{lead.source_updated_at}</span></Field>
              <Field label="Last imported"><span className="text-xs">{fmtTimestamp(lead.last_imported_at)}</span></Field>
              <Field label="Deal ID">
                {lead.deal_id != null ? (
                  <Link href={`/operations/${lead.deal_id}`} className="text-xs font-medium text-sky-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300" data-lead-deal-id>
                    {lead.deal_id}
                  </Link>
                ) : (
                  <span className="text-xs text-slate-400 dark:text-slate-500" data-lead-deal-id>—</span>
                )}
              </Field>
            </div>
          </details>
        </div>
      </aside>
    </div>
  );
}
