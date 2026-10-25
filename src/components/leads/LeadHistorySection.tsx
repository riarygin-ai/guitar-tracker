// The lead drawer's history: the stored lead_events as an oldest-first
// timeline (see leadEventHistory.ts for what is shown/hidden) and the legacy
// Lead Log notes — collapsed when real events exist, shown as the primary
// "Historical summary" when they are the only history. Never edits anything.

import Link from 'next/link';
import type { LeadHistory, TimelineEntry } from '@/lib/leads/leadEventHistory';

const WHO_CLASS: Record<TimelineEntry['who'], string> = {
  BUYER: 'text-cyan-700 dark:text-cyan-300',
  US: 'text-slate-900 dark:text-white',
  INTERNAL: 'text-slate-500 dark:text-slate-400',
};
const DOT_CLASS: Record<TimelineEntry['who'], string> = {
  BUYER: 'bg-cyan-500 dark:bg-cyan-400',
  US: 'bg-slate-700 dark:bg-slate-200',
  INTERNAL: 'bg-slate-300 dark:bg-slate-600',
};

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="mt-2 space-y-3 border-l border-slate-200 pl-4 dark:border-slate-700" data-event-timeline>
      {entries.map((e) => (
        <li key={e.id} className="relative min-w-0" data-event-row data-event-who={e.who}>
          <span aria-hidden="true" className={`absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-slate-800 ${DOT_CLASS[e.who]}`} />
          <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">{e.date}{e.time ? ` · ${e.time}` : ''}</span>
            <span><span className={`font-semibold ${WHO_CLASS[e.who]}`}>{e.whoLabel}</span> · {e.typeLabel}</span>
          </p>
          <p className="mt-0.5 break-words text-sm text-slate-900 dark:text-slate-100">{e.summary}</p>
          {e.details.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
              {e.details.map((d, i) => (
                <li key={i} className="break-words">
                  {d.href ? <Link href={d.href} className="font-medium text-sky-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300">{d.text}</Link> : d.text}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

function NotesBody({ notes }: { notes: string }) {
  return <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:bg-slate-700/50 dark:text-slate-100" data-legacy-notes-body>{notes}</div>;
}

const HISTORY_TITLE = 'text-xs font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300';

/** Event timeline first; legacy notes collapsed when real events exist, prominent when they are the only history. */
export default function LeadHistorySection({ history, notes, error }: { history: LeadHistory | null; notes: string | null; error?: string | null }) {
  const legacy = notes?.trim() ? notes : null;
  const entries = history?.entries ?? [];
  const primaryNotes = legacy != null && !(history?.hasSubstantive ?? false);
  return (
    <section className="space-y-3 border-t border-slate-100 pt-4 dark:border-slate-700" data-lead-history>
      {error && <p className="text-xs text-rose-700 dark:text-rose-400" role="alert" data-history-error>{error}</p>}
      {history == null && !error && <p className="text-xs text-slate-500 dark:text-slate-400" data-history-loading>Loading history…</p>}
      {primaryNotes && (
        <div data-historical-summary>
          <h3 className={HISTORY_TITLE}>Historical summary</h3>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Detailed events were not recorded for this legacy lead.</p>
          <div className="mt-2"><NotesBody notes={legacy} /></div>
        </div>
      )}
      {entries.length > 0 && (
        <div>
          <h3 className={HISTORY_TITLE}>Event history</h3>
          <Timeline entries={entries} />
        </div>
      )}
      {legacy != null && !primaryNotes && (
        <details className="group" data-legacy-notes>
          <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-400">
            Legacy notes
          </summary>
          <div className="mt-2"><NotesBody notes={legacy} /></div>
        </details>
      )}
      {history != null && entries.length === 0 && legacy == null && (
        <p className="text-sm text-slate-500 dark:text-slate-400" data-history-empty>No history recorded for this lead.</p>
      )}
    </section>
  );
}
