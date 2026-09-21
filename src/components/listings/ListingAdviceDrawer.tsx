'use client';

// Detail drawer/sheet for one Listing Advice card. The dialog shell and the
// Evidence / Limitations / Actions sections are shared with the general
// Business Coach drawer (AdviceDrawerParts.tsx). Evidence is resolved from the
// PERSISTED packet of the advice run being shown — it is what the model
// actually saw, never today's changing data — and navigation actions come from
// cited source metadata (listingAdviceView.adviceActions), never from
// model-written URLs.

import { useState } from 'react';
import { ConfidencePill, PriorityBadge } from '@/components/AdviceCardView';
import { ActionsSection, AdviceDrawerShell, EvidenceSection, LimitationsSection } from '@/components/AdviceDrawerParts';
import type { ListingAdviceRunRow } from '@/lib/analytics/listingAdvice/generateListingAdvice';
import type { ListingAdviceCard } from '@/lib/analytics/listingAdvice/listingAdvice';
import { ADVICE_TYPE_LABEL, adviceActions, relevantLimitations, resolveCardEvidence } from '@/lib/listingAdviceView';

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
  const [copied, setCopied] = useState(false);

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
    <AdviceDrawerShell
      titleId="listing-advice-title"
      testId="listing-advice"
      eyebrow={ADVICE_TYPE_LABEL[card.advice_type]}
      title={card.title}
      badges={<><PriorityBadge priority={card.priority} /><ConfidencePill confidence={card.confidence_label} /></>}
      onClose={onClose}
    >
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

      <EvidenceSection blocks={evidence} />
      <LimitationsSection items={limitations} />
      <ActionsSection actions={actions} />

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
    </AdviceDrawerShell>
  );
}
