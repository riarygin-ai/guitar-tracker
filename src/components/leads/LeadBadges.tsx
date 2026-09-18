// Subtle quality/status chips for the /leads screen. Text labels are
// always rendered — color is supplemental, never the only signal. No
// alarming reds: even "Declined"/"Ghosted" stay neutral.

import { QUALITY_LABEL, STATUS_LABEL } from '@/lib/leads/leadFormat';
import type { LeadQuality, LeadStatus } from '@/lib/leads/leadTypes';

const QUALITY_CLASS: Record<LeadQuality, string> = {
  LOW: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600',
  ENGAGED: 'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-300 dark:ring-cyan-800/60',
  SERIOUS: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:ring-violet-800/60',
  HIGH_INTENT: 'bg-indigo-100 text-indigo-800 ring-indigo-300 dark:bg-indigo-900/50 dark:text-indigo-200 dark:ring-indigo-700/70',
};

const STATUS_CLASS: Record<LeadStatus, string> = {
  OPEN: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:ring-blue-800/60',
  GHOSTED: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-700 dark:text-slate-400 dark:ring-slate-600',
  DECLINED_BY_ME: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600',
  DECLINED_BY_THEM: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:ring-slate-600',
  AGREED: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800/60',
  FAILED_AFTER_AGREEMENT: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800/60',
  COMPLETED: 'bg-emerald-100 text-emerald-800 ring-emerald-300 dark:bg-emerald-900/50 dark:text-emerald-200 dark:ring-emerald-700/70',
};

const BASE = 'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset';

export function QualityBadge({ quality }: { quality: LeadQuality }) {
  return <span className={`${BASE} ${QUALITY_CLASS[quality]}`} data-quality={quality}>{QUALITY_LABEL[quality]}</span>;
}

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <span className={`${BASE} ${STATUS_CLASS[status]}`} data-status={status}>{STATUS_LABEL[status]}</span>;
}
