'use client';

// Shared presentation pieces for advice detail drawers (Listing Advice on
// /listings and the general Business Coach on the Dashboard): the dialog shell
// (right-side drawer on md+, bottom sheet on mobile, focus trap, Escape,
// scroll lock, focus return) and the Evidence / Limitations / Actions sections.
// Everything here is purely presentational — evidence blocks and actions are
// resolved elsewhere from the PERSISTED packet of the advice revision shown
// (listingAdviceView.ts / coachAdviceView.ts), never from live data.

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import type { AdviceAction, EvidenceBlock } from '@/lib/listingAdviceView';
import { adviceLabels } from '@/lib/analytics/advice/adviceLabels';
import type { AdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';

const FOCUSABLE = 'a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function AdviceDrawerShell({
  titleId,
  testId,
  eyebrow,
  title,
  badges,
  language = 'en',
  onClose,
  children,
}: {
  titleId: string;
  testId: string;
  eyebrow: React.ReactNode;
  title: string;
  badges?: React.ReactNode;
  language?: AdviceLanguage;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const L = adviceLabels(language);
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
      <button type="button" aria-label={L.closeAdviceDetails} tabIndex={-1} onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-slate-900/40" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-advice-drawer={testId}
        className="absolute inset-x-0 bottom-0 flex max-h-[90vh] flex-col overflow-hidden rounded-t-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-800 md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[32rem] md:rounded-l-3xl md:rounded-tr-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-700">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">{eyebrow}</p>
            <h2 id={titleId} className="mt-0.5 break-words text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
            {badges && <div className="mt-2 flex flex-wrap items-center gap-2">{badges}</div>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={L.close}
            className="shrink-0 rounded-full p-2 text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

export function EvidenceSection({ blocks, language = 'en' }: { blocks: EvidenceBlock[]; language?: AdviceLanguage }) {
  const L = adviceLabels(language);
  return (
    <section data-advice-evidence>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{L.evidenceHeading}</h3>
      <div className="mt-2 space-y-3">
        {blocks.map((b) => (
          <div key={b.sourceId} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700" data-evidence-source={b.sourceId}>
            {b.badge && <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{b.badge}</p>}
            <p className="break-words text-sm font-semibold text-slate-900 dark:text-white">{b.title}</p>
            {b.text && <p className="mt-1 break-words text-xs text-slate-600 dark:text-slate-300">{b.text}</p>}
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
      <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">{L.evidenceFooter}</p>
    </section>
  );
}

export function LimitationsSection({ items, language = 'en' }: { items: string[]; language?: AdviceLanguage }) {
  if (items.length === 0) return null;
  const L = adviceLabels(language);
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{L.limitations}</h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-300">
        {items.map((l, i) => <li key={i} className="break-words">{l}</li>)}
      </ul>
    </section>
  );
}

export function ActionsSection({ actions, children, language = 'en' }: { actions: AdviceAction[]; children?: React.ReactNode; language?: AdviceLanguage }) {
  if (actions.length === 0 && !children) return null;
  const L = adviceLabels(language);
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{L.actions}</h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {actions.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            aria-label={`${a.kind === 'open_item' ? L.openItem : L.viewLeads}: ${a.subject}`}
            className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {a.kind === 'open_item' ? L.openItem : L.viewLeads}
            <span className="ml-1.5 max-w-[10rem] truncate text-xs font-normal text-slate-400 dark:text-slate-500">{a.subjectKey === 'market_window' ? L.marketWindowSubject : a.subject}</span>
          </Link>
        ))}
        {children}
      </div>
    </section>
  );
}
