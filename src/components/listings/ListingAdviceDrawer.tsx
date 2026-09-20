'use client';

// Detail drawer/sheet for one Listing Advice card: right-hand drawer on md+,
// bottom sheet on mobile (same dialog pattern as the Leads detail panel).
// Evidence is resolved from the PERSISTED packet of the advice run being
// shown — it is what the model actually saw, never today's changing data.
// Navigation actions come from cited source metadata (see
// listingAdviceView.adviceActions), never from model-written URLs.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ConfidencePill, PriorityBadge } from '@/components/AdviceCardView';
import type { ListingAdviceRunRow } from '@/lib/analytics/listingAdvice/generateListingAdvice';
import type { ListingAdviceCard } from '@/lib/analytics/listingAdvice/listingAdvice';
import { ADVICE_TYPE_LABEL, adviceActions, relevantLimitations, resolveCardEvidence } from '@/lib/listingAdviceView';

const FOCUSABLE = 'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export default function ListingAdviceDrawer({
  card,
  run,
  returnTo,
  showDebug,
  onClose,
}: {
  card: ListingAdviceCard;
  run: ListingAdviceRunRow;
  returnTo: string;
  showDebug: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

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

  const packet = run.input_packet;
  const evidence = resolveCardEvidence(card, packet);
  const limitations = relevantLimitations(card, packet);
  const actions = adviceActions(card, packet, returnTo);

  async function copyPacket() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(packet, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Debug-only convenience; failure is harmless.
    }
  }

  return (
    <div className="fixed inset-0 z-40">
      <button type="button" aria-label="Close advice details" tabIndex={-1} onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-slate-900/40" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="listing-advice-title"
        data-listing-advice-drawer
        className="absolute inset-x-0 bottom-0 flex max-h-[90vh] flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[32rem] md:rounded-l-3xl md:rounded-tr-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-700">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">{ADVICE_TYPE_LABEL[card.advice_type]}</p>
            <h2 id="listing-advice-title" className="mt-0.5 break-words text-base font-semibold text-slate-900 dark:text-white">{card.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PriorityBadge priority={card.priority} />
              <ConfidencePill confidence={card.confidence_label} />
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

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Advice</h3>
            <p className="mt-1.5 break-words text-sm text-slate-800 dark:text-slate-100">{card.summary}</p>
            <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Why it matters</h4>
            <p className="mt-1 break-words text-sm text-slate-700 dark:text-slate-200">{card.why_it_matters}</p>
            {card.next_steps.length > 0 && (
              <>
                <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Suggested checks</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
                  {card.next_steps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
                </ul>
              </>
            )}
          </section>

          <section data-advice-evidence>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Evidence the advice was based on</h3>
            <div className="mt-2 space-y-3">
              {evidence.map((b) => (
                <div key={b.sourceId} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700" data-evidence-source={b.sourceId}>
                  <p className="break-words text-sm font-semibold text-slate-900 dark:text-white">{b.title}</p>
                  {b.facts.length > 0 && (
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                      {b.facts.map((f) => (
                        <div key={f.label} className="min-w-0">
                          <dt className="text-[11px] text-slate-500 dark:text-slate-400">{f.label}</dt>
                          <dd className="break-words text-sm font-medium tabular-nums text-slate-800 dark:text-slate-100">{f.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {b.weeks.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {b.weeks.map((w, i) => <li key={i} className="break-words text-xs tabular-nums text-slate-600 dark:text-slate-300">{w}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">Shown as recorded when this advice was generated.</p>
          </section>

          {limitations.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Limitations</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-300">
                {limitations.map((l, i) => <li key={i} className="break-words">{l}</li>)}
              </ul>
            </section>
          )}

          {actions.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Actions</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {actions.map((a) => (
                  <Link
                    key={a.href}
                    href={a.href}
                    aria-label={`${a.label}: ${a.subject}`}
                    className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {a.label}
                    <span className="ml-1.5 max-w-[10rem] truncate text-xs font-normal text-slate-400 dark:text-slate-500">{a.subject}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {showDebug && (
            <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-700" data-advice-debug>
              <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400">Debug / audit</summary>
              <dl className="mt-2 space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
                <div><dt className="inline font-medium">Model: </dt><dd className="inline">{run.model}</dd></div>
                <div><dt className="inline font-medium">Prompt: </dt><dd className="inline">{run.prompt_version}</dd></div>
                <div className="break-all"><dt className="inline font-medium">Input hash: </dt><dd className="inline font-mono">{run.input_hash}</dd></div>
                <div className="break-all"><dt className="inline font-medium">Cited sources: </dt><dd className="inline font-mono">{card.source_ids.join(', ')}</dd></div>
                <div><dt className="inline font-medium">Run: </dt><dd className="inline">#{run.id}</dd></div>
              </dl>
              <button type="button" onClick={copyPacket} className="mt-2 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700">
                {copied ? 'Copied' : 'Copy input packet'}
              </button>
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}
