'use client';

// Shared, read-only rendering of a single Auditable AI Advice card — used by
// both the Analytics Run Detail revision viewer (src/app/analytics/page.tsx)
// and the Dashboard's "Latest Analytics Advice" section (src/app/page.tsx),
// so the two never carry their own independently-drifting copies of this
// markup. Deliberately has no knowledge of WHERE "View Evidence" should
// navigate to — Run Detail scrolls to an in-page source card, the Dashboard
// links to a different page entirely — so that choice is passed in as the
// `evidence` prop rather than hardcoded here.
//
// Two variants: 'full' (Run Detail — every field, View Evidence included;
// this is the default, so Run Detail's existing call sites are unchanged)
// and 'compact' (Dashboard only — type/priority/confidence/headline/advice
// text/Open Item ONLY; deliberately never why_it_matters, limitations,
// View Evidence, or a source count — the Dashboard shows no deterministic
// evidence at all). `evidence` is only consulted in 'full' mode.

import Link from 'next/link';
import type { AdviceCard } from '@/lib/analytics/advice/types';
import { formatAdviceType, formatConfidence, formatPriority, humanizeCode } from '@/lib/analytics/advice/presentation';

function PriorityBadge({ priority }: { priority: string }) {
  const classes: Record<string, string> = {
    high: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-700',
    medium: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
    low: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600',
  };
  return (
    <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes[priority] ?? classes.low}`}>
      {formatPriority(priority)}
    </span>
  );
}

function ConfidencePill({ confidence }: { confidence: string | null }) {
  return (
    <span className="inline-flex shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300">
      Confidence: {formatConfidence(confidence)}
    </span>
  );
}

export type AdviceCardEvidenceAction =
  | { kind: 'link'; href: string }
  | { kind: 'button'; onClick: () => void };

export type AdviceCardVariant = 'full' | 'compact';

export interface AdviceCardViewProps {
  card: AdviceCard;
  /** Required for 'full' (the default) — ignored entirely in 'compact'
   *  mode, since compact never renders a View Evidence control. */
  evidence?: AdviceCardEvidenceAction;
  variant?: AdviceCardVariant;
  /** Compact-only, Dashboard-only (Advice Dismissal / Resurface v1). When
   *  provided, renders a low-emphasis "Dismiss" action. Ignored in 'full'
   *  mode — Run Detail never offers dismissal, it always shows the
   *  complete original Advice for a run. */
  onDismiss?: () => void;
  dismissing?: boolean;
}

export default function AdviceCardView({ card, evidence, variant = 'full', onDismiss, dismissing = false }: AdviceCardViewProps) {
  if (variant === 'compact') {
    return (
      <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-700 dark:bg-slate-700/30">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{formatAdviceType(card.advice_type)}</span>
          <PriorityBadge priority={card.priority} />
          <ConfidencePill confidence={card.confidence_label} />
        </div>
        <h4 className="mt-1.5 break-words text-sm font-semibold text-slate-900 dark:text-white">{card.headline}</h4>
        <p className="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">{card.advice}</p>
        {(card.item_id != null || onDismiss) && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            {onDismiss ? (
              <button
                type="button"
                onClick={onDismiss}
                disabled={dismissing}
                aria-busy={dismissing}
                className="text-xs font-medium text-slate-400 transition hover:text-slate-600 hover:underline disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-500 dark:hover:text-slate-300"
              >
                {dismissing ? 'Hiding…' : 'Dismiss'}
              </button>
            ) : <span />}
            {card.item_id != null && (
              <Link href={`/inventory/${card.item_id}`} className="shrink-0 text-xs font-medium text-slate-500 hover:underline dark:text-slate-400">
                Open Item
              </Link>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-700 dark:bg-slate-700/30">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{formatAdviceType(card.advice_type)}</span>
        <PriorityBadge priority={card.priority} />
        <ConfidencePill confidence={card.confidence_label} />
      </div>
      <h4 className="mt-1.5 break-words text-sm font-semibold text-slate-900 dark:text-white">{card.headline}</h4>
      <p className="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">{card.advice}</p>
      <p className="mt-1.5 break-words text-xs text-slate-500 dark:text-slate-400"><span className="font-semibold">Why it matters:</span> {card.why_it_matters}</p>
      {card.limitations.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 break-words pl-4 text-[11px] text-slate-400 dark:text-slate-500">
          {card.limitations.map((l) => <li key={l}>{humanizeCode(l)}</li>)}
        </ul>
      )}
      {evidence && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {evidence.kind === 'link' ? (
            <Link href={evidence.href} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">
              View Evidence ({card.source_ids.length})
            </Link>
          ) : (
            <button
              type="button"
              onClick={evidence.onClick}
              className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              View Evidence ({card.source_ids.length})
            </button>
          )}
          {card.item_id != null && (
            <Link href={`/inventory/${card.item_id}`} className="shrink-0 text-xs font-medium text-slate-500 hover:underline dark:text-slate-400">
              Open Item
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
