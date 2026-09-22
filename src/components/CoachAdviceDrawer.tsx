'use client';

// Detail drawer/sheet for one general Business Coach card (Dashboard). Shares
// the dialog shell and Evidence / Limitations / Actions sections with the
// Listing Advice drawer. Evidence is resolved from the PERSISTED input packet
// (registry fallback) of the exact analytics_run_advice revision the card came
// from — never from live data. Dismiss is the Dashboard's own handler, so the
// card list, dismissal keys and this drawer stay in sync.

import { ConfidencePill, PriorityBadge } from '@/components/AdviceCardView';
import { ActionsSection, AdviceDrawerShell, EvidenceSection, LimitationsSection } from '@/components/AdviceDrawerParts';
import type { AdviceCard, AnalyticsRunAdviceRow } from '@/lib/analytics/advice/types';
import { formatAdviceType, formatLimitation } from '@/lib/analytics/advice/presentation';
import { adviceLabels, resolveRevisionLanguage } from '@/lib/analytics/advice/adviceLabels';
import type { AdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';
import { coachActions, coachLimitations, resolveCoachCardEvidence } from '@/lib/coachAdviceView';

export default function CoachAdviceDrawer({
  card,
  revision,
  onDismiss,
  dismissing,
  returnTo,
  viewerLanguage,
  onClose,
}: {
  card: AdviceCard;
  revision: Pick<AnalyticsRunAdviceRow, 'input_packet' | 'source_refs'>;
  onDismiss: () => void;
  dismissing: boolean;
  /** Where "View Leads" should return to — supplied by the host page (e.g. "/" on the Dashboard). Re-validated by the shared allowlist. */
  returnTo: string;
  /** The viewer's CURRENT preference — used only when the revision itself stored no language (legacy). */
  viewerLanguage?: AdviceLanguage | null;
  onClose: () => void;
}) {
  const { input_packet: packet, source_refs: registry } = revision;
  // Labels follow the language stored WITH this revision (a Russian revision stays Russian after a switch to English).
  const language = resolveRevisionLanguage(packet?.language, viewerLanguage);
  const L = adviceLabels(language);
  const evidence = resolveCoachCardEvidence(card, packet, registry);
  const limitations = coachLimitations(card, packet, registry);
  const actions = coachActions(card, packet, registry, returnTo);

  return (
    <AdviceDrawerShell
      titleId="coach-advice-title"
      testId="coach-advice"
      eyebrow={(L.type as Record<string, string>)[card.advice_type] ?? formatAdviceType(card.advice_type)}
      language={language}
      title={card.headline}
      badges={<><PriorityBadge priority={card.priority} language={language} /><ConfidencePill confidence={card.confidence_label} language={language} /></>}
      onClose={onClose}
    >
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{L.advice}</h3>
        <p className="mt-1.5 break-words text-sm text-slate-800 dark:text-slate-100">{card.advice}</p>
        <h4 className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{L.whyItMatters}</h4>
        <p className="mt-1 break-words text-sm text-slate-700 dark:text-slate-200">{card.why_it_matters}</p>
      </section>

      {evidence.length > 0 && <EvidenceSection blocks={evidence} language={language} />}
      <LimitationsSection items={limitations} language={language} />
      <ActionsSection actions={actions} language={language}>
        <button
          type="button"
          onClick={onDismiss}
          disabled={dismissing}
          aria-busy={dismissing}
          className="rounded-xl px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-700"
        >
          {dismissing ? L.hiding : L.dismissFor30Days}
        </button>
      </ActionsSection>
    </AdviceDrawerShell>
  );
}
