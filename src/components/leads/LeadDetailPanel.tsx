'use client';

// Read-only lead detail: right-hand drawer on md+, bottom sheet on mobile.
// Shows the stored structured values exactly as recorded so they can be
// compared against the real conversation (Data QA). No edit controls.

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import InfoTip from '@/components/InfoTip';
import { QualityBadge, StatusBadge } from '@/components/leads/LeadBadges';
import { LEAD_HELP, type LeadHelpKey } from '@/lib/leads/leadHelpText';
import {
  describeCashComponent, fmtCad, fmtLeadDateFull, fmtTimestamp, formatOfferSummary,
  leadChannelLabel, OFFER_TYPE_LABEL, outcomeReasonLabel,
} from '@/lib/leads/leadFormat';
import type { LeadRow } from '@/lib/leads/leadTypes';

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

export default function LeadDetailPanel({ lead, onClose }: { lead: LeadRow; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

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
              {leadChannelLabel(lead)} · first contact {fmtLeadDateFull(lead.first_contact_at)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <QualityBadge quality={lead.lead_quality} />
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
            <Field label="First contact">{fmtLeadDateFull(lead.first_contact_at)}</Field>
            <Field label="Last contact">{fmtLeadDateFull(lead.last_contact_at)}</Field>
            <Field label="Channel">{leadChannelLabel(lead)}</Field>
            <Field label="Quality"><QualityBadge quality={lead.lead_quality} /> <span className="text-[11px] text-slate-500 dark:text-slate-400">highest reached</span></Field>
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

          <Section title="Notes">
            <div className="col-span-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:bg-slate-700/50 dark:text-slate-100">
              {lead.notes?.trim() ? lead.notes : <span className="text-slate-400 dark:text-slate-500">No notes recorded.</span>}
            </div>
          </Section>

          <details open className="group border-t border-slate-100 pt-4 dark:border-slate-700">
            <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400">
              Source / Data QA
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-y-2 text-slate-600 dark:text-slate-300">
              <Field label="Lead ID"><span className="break-all font-mono text-[11px]">{lead.lead_id}</span></Field>
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
