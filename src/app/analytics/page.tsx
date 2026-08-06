'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import CompactPageHeader from '@/components/CompactPageHeader';
import {
  supabase,
  getRecentAnalyticsRuns,
  getAnalyticsRunSnapshot,
  getLatestAdviceMetaForRuns,
  getAdviceRevisionsForRun,
} from '@/lib/supabase';
import type { AnalyticsRun, AnalyticsRunMeta, AnalyticsRunStatus, AnalyticsSnapshot } from '@/types';
import type { AnalyticsRunAdviceMeta, AnalyticsRunAdviceRow, SourceRegistryEntry } from '@/lib/analytics/advice/types';
import {
  formatAdviceStatus,
  formatAdviceType,
  formatConfidence,
  formatDateTime as formatAdviceDateTime,
  formatKeyMetrics,
  formatPatternMetricEntry,
  formatPriority,
  formatSourceType,
  humanizeCode,
} from '@/lib/analytics/advice/presentation';
import { sourceIdToDomId, parseSourceIdsDeepLinkParam } from '@/lib/analytics/advice/buildInputPacket';

const HISTORY_LIMIT = 10;
const HIGHLIGHT_MS = 2600;

// ─── Presentation helpers ───────────────────────────────────────────────────

const STATUS_LABELS: Record<AnalyticsRunStatus, string> = {
  pending:   'Pending',
  running:   'Running',
  completed: 'Completed',
  failed:    'Failed',
};

const STATUS_BADGE_CLASSES: Record<AnalyticsRunStatus, string> = {
  pending:   'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600',
  running:   'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  completed: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700',
  failed:    'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
};

function isAnalyticsRunStatus(value: unknown): value is AnalyticsRunStatus {
  return value === 'pending' || value === 'running' || value === 'completed' || value === 'failed';
}

function StatusBadge({ status }: { status: string }) {
  const known = isAnalyticsRunStatus(status) ? status : null;
  return (
    <span className={`inline-flex shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${known ? STATUS_BADGE_CLASSES[known] : STATUS_BADGE_CLASSES.pending}`}>
      {known ? STATUS_LABELS[known] : status}
    </span>
  );
}

// ─── Advice presentation helpers (Auditable AI Advice v1.0) ────────────────

const ADVICE_STATUS_BADGE_CLASSES: Record<string, string> = {
  pending:   'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600',
  generating: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700',
  failed:    'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
};

function AdviceStatusBadge({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span className="inline-flex shrink-0 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-500">
        No advice
      </span>
    );
  }
  const cls = ADVICE_STATUS_BADGE_CLASSES[status] ?? ADVICE_STATUS_BADGE_CLASSES.pending;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="opacity-80">
        <path d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5z" />
      </svg>
      {formatAdviceStatus(status)}
    </span>
  );
}

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

function SourceTypeBadge({ sourceType }: { sourceType: string }) {
  const classes: Record<string, string> = {
    deterministic_insight: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700',
    confirmed_pattern: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300 dark:border-teal-700',
    preliminary_hypothesis: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
  };
  return (
    <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes[sourceType] ?? classes.deterministic_insight}`}>
      {formatSourceType(sourceType)}
    </span>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// This is the only readable mapping this page knows about — an unrecognized
// scope string is shown as-is rather than guessed at.
function readableEvidenceScope(scope: string): string {
  if (scope === 'shared_business_population') return 'Shared Business Population';
  if (scope === 'shared_inventory_population') return 'Shared Inventory Population';
  return scope;
}

function toMetaFromRun(run: AnalyticsRun): AnalyticsRunMeta {
  const { snapshot: _snapshot, ...meta } = run;
  return meta;
}

// ─── Collapsible JSON section ───────────────────────────────────────────────

const COPY_FEEDBACK_MS = 1800;

// Small header-only control — deliberately its own component so each
// CollapsibleSection instance gets an independent `copied` state without
// any shared/global tracking.
function CopyJsonButton({ label, data }: { label: string; data: unknown }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    // Header buttons sit beside the expand/collapse toggle — this must
    // never bubble up into it.
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) — no-op, never
      // crash the page over a copy failure.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label} JSON`}
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
    >
      {copied ? (
        <>
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
        </>
      ) : (
        <>
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = false,
  data,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  /** When provided, a Copy button appears in the header that copies
   *  JSON.stringify(data, null, 2) — this module's own data only, never the
   *  whole snapshot. Omit (or pass undefined) to render no Copy button. */
  data?: unknown;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = () => setOpen((v) => !v);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <div className="flex w-full items-center justify-between gap-2 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center text-left"
        >
          <span className="min-w-0 break-words text-sm font-semibold text-slate-900 dark:text-white">{title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {data !== undefined && <CopyJsonButton label={title} data={data} />}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
            className="shrink-0 rounded p-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${open ? 'rotate-90' : ''}`}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-700/50">
          {children}
        </div>
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
      {JSON.stringify(value, null, 2) ?? 'null'}
    </pre>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [sessionMissing, setSessionMissing] = useState(false);

  const [runs, setRuns] = useState<AnalyticsRunMeta[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [runningAnalytics, setRunningAnalytics] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  // ── Auditable AI Advice v1.0 ─────────────────────────────────────────
  const [adviceMetaByRun, setAdviceMetaByRun] = useState<Record<number, AnalyticsRunAdviceMeta>>({});
  const [adviceRevisions, setAdviceRevisions] = useState<AnalyticsRunAdviceRow[]>([]);
  const [adviceRevisionsLoading, setAdviceRevisionsLoading] = useState(false);
  const [selectedAdviceRevisionId, setSelectedAdviceRevisionId] = useState<number | null>(null);
  // Scoped to the run currently generating/retrying — NOT a single global
  // boolean — so that (a) a Generate/Retry in flight for one run never
  // blocks starting one for a different run, and (b) the completion
  // handler below can tell whether the user is still looking at the run
  // it was called for before overwriting adviceRevisions with its result.
  const [generatingAdviceForRunId, setGeneratingAdviceForRunId] = useState<number | null>(null);
  const [adviceActionError, setAdviceActionError] = useState<string | null>(null);
  const [highlightedSourceIds, setHighlightedSourceIds] = useState<Set<string>>(new Set());
  const sourceCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;
  const selectedAdvice = adviceRevisions.find((a) => a.id === selectedAdviceRevisionId) ?? adviceRevisions[0] ?? null;
  const generatingAdvice = selectedRun != null && generatingAdviceForRunId === selectedRun.id;

  // Always-current refs for values read inside async callbacks whose
  // closures were captured before the user navigated elsewhere — plain
  // state reads there would be stale.
  const selectedRunIdRef = useRef<number | null>(null);
  useEffect(() => { selectedRunIdRef.current = selectedRunId; }, [selectedRunId]);
  const runsRef = useRef<AnalyticsRunMeta[]>([]);
  useEffect(() => { runsRef.current = runs; }, [runs]);

  // Deep-link support (e.g. from the Dashboard's "View Evidence" link):
  // ?runId=123 auto-selects that run; &sourceIds=a,b,c (URI-encoded, comma
  // separated) then scrolls to and highlights those exact source cards
  // once advice has loaded — never just the top of a generic Raw Snapshot.
  const searchParams = useSearchParams();
  const runDeepLinkHandled = useRef(false);
  const sourceDeepLinkHandled = useRef(false);

  useEffect(() => {
    loadHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (runDeepLinkHandled.current || runs.length === 0) return;
    const runIdParam = searchParams.get('runId');
    runDeepLinkHandled.current = true;
    if (!runIdParam) return;
    const runId = Number(runIdParam);
    if (!Number.isFinite(runId) || !runs.some((r) => r.id === runId)) return;
    selectRun(runId);
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sourceDeepLinkHandled.current || adviceRevisions.length === 0) return;
    const sourceIdsParam = searchParams.get('sourceIds');
    sourceDeepLinkHandled.current = true;
    if (!sourceIdsParam) return;
    const ids = parseSourceIdsDeepLinkParam(sourceIdsParam);
    // Source cards render after this same tick — defer one frame so the
    // ref registry is populated before we try to scroll to it.
    setTimeout(() => handleViewEvidence(ids), 300);
  }, [adviceRevisions]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAdviceMetaForHistory(historyRuns: AnalyticsRunMeta[]) {
    const runIds = historyRuns.map((r) => r.id);
    const { data } = await getLatestAdviceMetaForRuns(runIds);
    if (data) setAdviceMetaByRun(data);
  }

  async function loadAdviceRevisions(runId: number) {
    setAdviceRevisionsLoading(true);
    setAdviceActionError(null);
    const { data, error } = await getAdviceRevisionsForRun(runId);
    setAdviceRevisionsLoading(false);
    if (error) {
      setAdviceRevisions([]);
      setSelectedAdviceRevisionId(null);
      return;
    }
    const revisions = (data as unknown as AnalyticsRunAdviceRow[] | null) ?? [];
    setAdviceRevisions(revisions);
    setSelectedAdviceRevisionId(revisions[0]?.id ?? null);
  }

  async function handleGenerateAdvice(runId: number) {
    // Defense in depth alongside the disabled/aria-busy button state below —
    // a second invocation for the SAME run while one is already in flight
    // must never fire a second request (a different run is always fine —
    // the DB-serialized RPC in generateAdviceForRun handles that safely).
    if (generatingAdviceForRunId === runId) return;
    setGeneratingAdviceForRunId(runId);
    setAdviceActionError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated — please sign in again.');

      const res = await fetch(`/api/analytics/runs/${runId}/advice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const payload = await res.json().catch(() => ({}));

      // Whether it completed or failed, the attempt is now persisted.
      // Refresh the compact History status unconditionally (harmless
      // regardless of which run is currently selected), but only overwrite
      // the visible revision list/selection if the user hasn't since
      // navigated to a different run — otherwise this stale response would
      // silently replace what's on screen for the run they're now viewing.
      if (selectedRunIdRef.current === runId) {
        await loadAdviceRevisions(runId);
      }
      await loadAdviceMetaForHistory(runsRef.current);

      if (!res.ok && res.status !== 502) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `Server error (${res.status})`);
      }
    } catch (err) {
      setAdviceActionError(err instanceof Error ? err.message : 'Could not generate advice.');
    } finally {
      setGeneratingAdviceForRunId((current) => (current === runId ? null : current));
    }
  }

  function handleViewEvidence(sourceIds: string[]) {
    if (sourceIds.length === 0) return;
    setHighlightedSourceIds(new Set(sourceIds));
    // Scroll to the first referenced source card — the rest are
    // highlighted in place even if off-screen. An unknown/malformed
    // source_id (e.g. a stale or hand-edited deep link) simply has no
    // matching ref — a safe no-op, never a crash.
    const firstEl = sourceCardRefs.current.get(sourceIds[0]);
    firstEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Move keyboard/AT focus to the target card too — the ring highlight
    // alone is a purely visual cue; tabIndex={-1} on the card (below) makes
    // it script-focusable without adding it to normal tab order.
    firstEl?.focus({ preventScroll: true });
    setTimeout(() => setHighlightedSourceIds(new Set()), HIGHLIGHT_MS);
  }

  async function loadHistory() {
    setHistoryLoading(true);
    setHistoryError(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setSessionMissing(true);
      setHistoryLoading(false);
      return;
    }
    setSessionMissing(false);

    const { data, error } = await getRecentAnalyticsRuns(HISTORY_LIMIT);
    setHistoryLoading(false);
    if (error) {
      setHistoryError('Could not load your analytics history.');
      return;
    }
    const historyRuns = (data as AnalyticsRunMeta[] | null) ?? [];
    setRuns(historyRuns);
    loadAdviceMetaForHistory(historyRuns);
  }

  async function loadSnapshot(runId: number) {
    setSnapshotLoading(true);
    setSnapshotError(null);
    setSelectedSnapshot(null);

    const { data, error } = await getAnalyticsRunSnapshot(runId);
    setSnapshotLoading(false);
    if (error) {
      setSnapshotError('Could not load the stored snapshot for this run.');
      return;
    }
    setSelectedSnapshot((data?.snapshot as AnalyticsSnapshot | null) ?? null);
  }

  function selectRun(runId: number, snapshotAlreadyKnown?: AnalyticsSnapshot | null) {
    setSelectedRunId(runId);
    loadAdviceRevisions(runId);
    if (snapshotAlreadyKnown !== undefined) {
      setSelectedSnapshot(snapshotAlreadyKnown);
      setSnapshotError(null);
      setSnapshotLoading(false);
      return;
    }
    loadSnapshot(runId);
  }

  async function handleRunAnalytics() {
    setRunningAnalytics(true);
    setRunError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Not authenticated — please sign in again.');
      }

      // Deliberately no body: the route ignores any request body and always
      // targets the authenticated caller's own app_users.id. Backed by
      // build_analytics_snapshot_v2_2 as of the v2.2 promotion.
      const res = await fetch('/api/analytics/runs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A failed run may still have been persisted server-side — refresh
        // history so it's visible, and select it if we know its id.
        await loadHistory();
        const failedRunId = typeof payload.runId === 'number' ? payload.runId : null;
        if (failedRunId !== null) selectRun(failedRunId);
        throw new Error(typeof payload.error === 'string' ? payload.error : `Server error (${res.status})`);
      }

      const run = payload.run as AnalyticsRun;
      const nextRuns = [toMetaFromRun(run), ...runs.filter((r) => r.id !== run.id)].slice(0, HISTORY_LIMIT);
      setRuns(nextRuns);
      // The API route already awaited automatic advice generation before
      // responding — reload both the compact History status and the full
      // revision list so the newly-generated (or newly-failed) advice
      // shows up immediately, no extra polling required.
      loadAdviceMetaForHistory(nextRuns);
      selectRun(run.id, run.snapshot ?? null);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Something went wrong running analytics.');
    } finally {
      setRunningAnalytics(false);
    }
  }

  const candidateCount = selectedSnapshot?.recommendation_candidates?.open_business_items?.length;

  return (
    <div className="space-y-6">

      <CompactPageHeader
        overline="Analytics"
        summary={
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Run the complete business analytics snapshot and review stored results.
          </p>
        }
        action={
          <button
            type="button"
            onClick={handleRunAnalytics}
            disabled={runningAnalytics || sessionMissing}
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
          >
            {runningAnalytics ? (
              <>
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-slate-900/40 dark:border-t-slate-900" />
                Running analytics…
              </>
            ) : (
              'Run Analytics'
            )}
          </button>
        }
      />

      {sessionMissing && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300">
          Your session could not be found.{' '}
          <Link href="/login" className="font-semibold underline">Sign in</Link> to run analytics and view your history.
        </div>
      )}

      {runError && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
          {runError}
        </div>
      )}

      {/* ── Recent runs ──────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="mb-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Recent Runs</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Only runs targeted to your own account are shown.</p>
        </div>

        {historyLoading ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Loading analytics history…</p>
        ) : historyError ? (
          <p className="py-6 text-center text-sm text-rose-600 dark:text-rose-400">{historyError}</p>
        ) : runs.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">No analytics runs yet.</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700 md:block">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-700">
                <thead className="bg-slate-50 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Created</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold">Duration</th>
                    <th className="px-4 py-2.5 font-semibold">Version</th>
                    <th className="px-4 py-2.5 font-semibold">AI Advice</th>
                    <th className="px-4 py-2.5 font-semibold"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-800">
                  {runs.map((run) => {
                    const isSelected = run.id === selectedRunId;
                    const advice = adviceMetaByRun[run.id];
                    return (
                      <tr key={run.id} className={isSelected ? 'bg-slate-50 dark:bg-slate-700/50' : 'hover:bg-slate-50 dark:hover:bg-slate-700/40'}>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{formatDateTime(run.created_at)}</td>
                        <td className="px-4 py-3"><StatusBadge status={run.status} /></td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{formatDuration(run.duration_ms)}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{run.analytics_version}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-col gap-0.5">
                            <AdviceStatusBadge status={advice?.status ?? null} />
                            {advice && (
                              <span className="text-[11px] text-slate-400 dark:text-slate-500">
                                Rev {advice.revision_number}{advice.model ? ` · ${advice.model}` : ''}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">

                          <button
                            type="button"
                            onClick={() => selectRun(run.id)}
                            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                          >
                            {isSelected ? 'Viewing' : 'View'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {runs.map((run) => {
                const isSelected = run.id === selectedRunId;
                const advice = adviceMetaByRun[run.id];
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => selectRun(run.id)}
                    className={`w-full rounded-2xl border p-4 text-left transition ${
                      isSelected
                        ? 'border-slate-300 bg-slate-50 dark:border-slate-500 dark:bg-slate-700/50'
                        : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">{formatDateTime(run.created_at)}</span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span>Duration {formatDuration(run.duration_ms)}</span>
                      <span>Version {run.analytics_version}</span>
                    </div>
                    <div className="mt-2">
                      <AdviceStatusBadge status={advice?.status ?? null} />
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── Selected run summary ─────────────────────────────────────────── */}
      {selectedRun && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Selected Run</h2>
            <StatusBadge status={selectedRun.status} />
          </div>

          {selectedRun.status === 'failed' && selectedRun.error_message && (
            <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
              {selectedRun.error_message}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Created</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatDateTime(selectedRun.created_at)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Completed</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatDateTime(selectedRun.completed_at)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Duration</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatDuration(selectedRun.duration_ms)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Analytics Version</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{selectedRun.analytics_version}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Evidence Scope</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{readableEvidenceScope(selectedRun.evidence_scope)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Snapshot Generated</p>
              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatDateTime(selectedSnapshot?.generated_at ?? null)}</p>
            </div>
            {candidateCount != null && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-700/40">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Open Business Candidates</p>
                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{candidateCount}</p>
              </div>
            )}
          </div>

          {/* ── AI Advice ─────────────────────────────────────────────────── */}
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/60">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5z" /></svg>
                  AI Advice
                </span>
                {selectedAdvice && <AdviceStatusBadge status={selectedAdvice.status} />}
              </div>
              {adviceRevisions.length > 1 && (
                <select
                  value={selectedAdviceRevisionId ?? ''}
                  onChange={(e) => setSelectedAdviceRevisionId(Number(e.target.value))}
                  className="min-w-0 max-w-full rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                >
                  {adviceRevisions.map((rev) => (
                    <option key={rev.id} value={rev.id}>
                      Revision {rev.revision_number}{rev.id === adviceRevisions[0].id ? ' (latest)' : ''} — {formatAdviceStatus(rev.status)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {adviceActionError && (
              <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-400">
                {adviceActionError}
              </div>
            )}

            {adviceRevisionsLoading ? (
              <p className="py-3 text-center text-sm text-slate-500 dark:text-slate-400">Loading advice…</p>
            ) : !selectedAdvice ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {snapshotLoading
                    ? 'Waiting on the stored snapshot…'
                    : 'No AI advice has been generated for this run yet.'}
                </p>
                <button
                  type="button"
                  onClick={() => selectedRun && handleGenerateAdvice(selectedRun.id)}
                  disabled={generatingAdvice || selectedRun?.status !== 'completed'}
                  aria-busy={generatingAdvice}
                  className="rounded-lg bg-slate-950 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
                >
                  {generatingAdvice ? 'Generating…' : 'Generate AI Advice'}
                </button>
                {selectedRun?.status !== 'completed' && (
                  <p className="text-xs text-slate-400 dark:text-slate-500">AI advice can only be generated for a completed run.</p>
                )}
              </div>
            ) : selectedAdvice.status === 'pending' || selectedAdvice.status === 'generating' ? (
              <div className="flex items-center gap-2 py-2">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600 dark:border-slate-600 dark:border-t-slate-300" />
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Advice is being generated{selectedAdvice.status === 'pending' ? ' (queued)' : ''}… the deterministic Insights and Pattern Discovery above are already final and unaffected.
                </p>
              </div>
            ) : selectedAdvice.status === 'failed' ? (
              <div className="space-y-2">
                <p className="text-sm text-rose-700 dark:text-rose-400">
                  Advice generation did not complete for this revision. The run itself remains completed and its deterministic data above is unaffected.
                </p>
                <button
                  type="button"
                  onClick={() => selectedRun && handleGenerateAdvice(selectedRun.id)}
                  disabled={generatingAdvice}
                  aria-busy={generatingAdvice}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                >
                  {generatingAdvice ? 'Retrying…' : 'Retry Advice'}
                </button>
                {(selectedAdvice.error_code || selectedAdvice.error_message) && (
                  <CollapsibleSection title="Debug: failure detail">
                    <div className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <p><span className="font-semibold">Error code:</span> {selectedAdvice.error_code ?? '—'}</p>
                      <p className="break-words"><span className="font-semibold">Message:</span> {selectedAdvice.error_message ?? '—'}</p>
                    </div>
                  </CollapsibleSection>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
                  <span>Generated {formatAdviceDateTime(selectedAdvice.generated_at)}</span>
                  <span>{selectedAdvice.provider} / {selectedAdvice.model}</span>
                  <span>Prompt {selectedAdvice.prompt_template_version}</span>
                  {selectedAdvice.canonical_input_hash && (
                    <span className="font-mono" title={selectedAdvice.canonical_input_hash}>
                      Packet hash {selectedAdvice.canonical_input_hash.slice(0, 12)}…
                    </span>
                  )}
                </div>

                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold text-slate-900 dark:text-white">{selectedAdvice.advice?.run_summary.headline}</h3>
                  <p className="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">{selectedAdvice.advice?.run_summary.summary}</p>
                  {(selectedAdvice.advice?.run_summary.source_ids.length ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => handleViewEvidence(selectedAdvice.advice!.run_summary.source_ids)}
                      className="mt-1.5 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      View Evidence ({selectedAdvice.advice!.run_summary.source_ids.length})
                    </button>
                  )}
                </div>

                {selectedAdvice.advice && selectedAdvice.advice.advice_cards.length === 0 ? (
                  <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-700/40 dark:text-slate-400">
                    No specific advice cards for this run — the evidence was neutral.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {selectedAdvice.advice?.advice_cards.map((card) => (
                      <div key={card.advice_code} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3.5 dark:border-slate-700 dark:bg-slate-700/30">
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
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => handleViewEvidence(card.source_ids)}
                            className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            View Evidence ({card.source_ids.length})
                          </button>
                          {card.item_id != null && (
                            <Link href={`/inventory/${card.item_id}`} className="shrink-0 text-xs font-medium text-slate-500 hover:underline dark:text-slate-400">
                              Open Item
                            </Link>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {selectedAdvice.advice && selectedAdvice.advice.limitations.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-700/30">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Limitations</p>
                    <ul className="mt-1 list-disc space-y-0.5 break-words pl-4 text-xs text-slate-500 dark:text-slate-400">
                      {selectedAdvice.advice.limitations.map((l) => <li key={l}>{humanizeCode(l)}</li>)}
                    </ul>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => selectedRun && handleGenerateAdvice(selectedRun.id)}
                  disabled={generatingAdvice}
                  aria-busy={generatingAdvice}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                >
                  {generatingAdvice ? 'Regenerating…' : 'Regenerate Advice'}
                </button>
              </div>
            )}
          </div>

          {/* ── Deterministic Sources Used ───────────────────────────────── */}
          {selectedAdvice?.status === 'completed' && selectedAdvice.source_refs && selectedAdvice.source_refs.length > 0 && (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800/60">
              <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-white">Deterministic Sources Used</h3>
              <div className="space-y-2.5">
                {selectedAdvice.source_refs.map((source: SourceRegistryEntry) => {
                  const isHighlighted = highlightedSourceIds.has(source.source_id);
                  const metricEntries = Array.isArray(source.key_metrics?.metrics)
                    ? (source.key_metrics.metrics as Record<string, unknown>[]).flatMap((m) => formatPatternMetricEntry(m))
                    : formatKeyMetrics(source.key_metrics ?? {});
                  return (
                    <div
                      key={source.source_id}
                      id={sourceIdToDomId(source.source_id)}
                      ref={(el) => {
                        if (el) sourceCardRefs.current.set(source.source_id, el);
                        else sourceCardRefs.current.delete(source.source_id);
                      }}
                      tabIndex={-1}
                      className={`min-w-0 rounded-xl border p-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                        isHighlighted
                          ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300 dark:border-indigo-500 dark:bg-indigo-900/20 dark:ring-indigo-700'
                          : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-700/30'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <SourceTypeBadge sourceType={source.source_type} />
                        {source.source_type === 'preliminary_hypothesis' && (
                          <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                            Preliminary
                          </span>
                        )}
                        <ConfidencePill confidence={source.confidence} />
                      </div>
                      <h4 className="mt-1.5 break-words text-sm font-semibold text-slate-900 dark:text-white">{source.headline}</h4>
                      <p className="mt-1 break-words text-xs text-slate-600 dark:text-slate-300">{source.summary}</p>

                      {metricEntries.length > 0 && (
                        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                          {metricEntries.map((m, i) => (
                            <div key={`${m.label}-${i}`} className="min-w-0">
                              <dt className="truncate text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{m.label}</dt>
                              <dd className="break-words text-xs font-medium text-slate-700 dark:text-slate-200">{m.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}

                      {source.source_type === 'preliminary_hypothesis' && (source.confirmation_needed?.length || source.ineligibility_reasons?.length) ? (
                        <div className="mt-2 space-y-1 border-t border-amber-200/60 pt-2 dark:border-amber-700/40">
                          {source.confirmation_needed && source.confirmation_needed.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Confirmation needed</p>
                              <ul className="list-disc space-y-0.5 break-words pl-4 text-[11px] text-slate-500 dark:text-slate-400">
                                {source.confirmation_needed.map((c) => <li key={c}>{c}</li>)}
                              </ul>
                            </div>
                          )}
                          {source.ineligibility_reasons && source.ineligibility_reasons.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Why not confirmed</p>
                              <ul className="list-disc space-y-0.5 break-words pl-4 text-[11px] text-slate-500 dark:text-slate-400">
                                {source.ineligibility_reasons.map((r) => <li key={r}>{humanizeCode(r)}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      ) : null}

                      {source.limitations.length > 0 && (
                        <p className="mt-2 break-words text-[11px] text-slate-400 dark:text-slate-500">
                          {source.limitations.map((l) => humanizeCode(l)).join(' · ')}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 break-all font-mono text-[10px] text-slate-400 dark:text-slate-500">{source.source_id}</span>
                        {source.item_id != null && (
                          <Link href={`/inventory/${source.item_id}`} className="shrink-0 text-xs font-medium text-slate-500 hover:underline dark:text-slate-400">
                            Open Item
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Snapshot sections ──────────────────────────────────────────── */}
          <div className="mt-5 space-y-3">
            {snapshotLoading ? (
              <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">Loading snapshot…</p>
            ) : snapshotError ? (
              <p className="py-4 text-center text-sm text-rose-600 dark:text-rose-400">{snapshotError}</p>
            ) : !selectedSnapshot ? (
              <p className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
                {selectedRun.status === 'completed'
                  ? 'Snapshot unavailable for this run.'
                  : `This run is ${STATUS_LABELS[isAnalyticsRunStatus(selectedRun.status) ? selectedRun.status : 'pending'].toLowerCase()} — no snapshot has been stored yet.`}
              </p>
            ) : (
              <>
                {/* v2.0+ sections — present on the current production shape
                    (build_analytics_snapshot_v2_10 and its v2.0-v2.9 ancestors).
                    Absent on older stored v1.0-v1.8 runs. Shared/Target
                    Calendar & Seasonality Evidence below render whatever
                    the stored run's version produced — v2.9 and v2.10
                    correct the same section keys in place (no redesign,
                    no charts). */}
                {selectedSnapshot.shared_purpose_evidence && (
                  <CollapsibleSection title="Shared Purpose Evidence" data={selectedSnapshot.shared_purpose_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_purpose_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_purpose_evidence && (
                  <CollapsibleSection title="Target User Purpose Evidence" data={selectedSnapshot.target_user_purpose_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_purpose_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_open_inventory_evidence && (
                  <CollapsibleSection title="Open Inventory Decision Support" defaultOpen data={selectedSnapshot.target_user_open_inventory_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_open_inventory_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.shared_acquisition_evidence && (
                  <CollapsibleSection title="Shared Acquisition Evidence" data={selectedSnapshot.shared_acquisition_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_acquisition_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_acquisition_evidence && (
                  <CollapsibleSection title="Target User Acquisition Evidence" data={selectedSnapshot.target_user_acquisition_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_acquisition_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.shared_inventory_segmentation_evidence && (
                  <CollapsibleSection title="Shared Inventory Segmentation Evidence" data={selectedSnapshot.shared_inventory_segmentation_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_inventory_segmentation_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_inventory_segmentation_evidence && (
                  <CollapsibleSection title="Target User Inventory Segmentation Evidence" data={selectedSnapshot.target_user_inventory_segmentation_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_inventory_segmentation_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.shared_deal_channel_evidence && (
                  <CollapsibleSection title="Shared Deal Channel Evidence" data={selectedSnapshot.shared_deal_channel_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_deal_channel_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_deal_channel_evidence && (
                  <CollapsibleSection title="Target User Deal Channel Evidence" data={selectedSnapshot.target_user_deal_channel_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_deal_channel_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.shared_listing_channel_evidence && (
                  <CollapsibleSection title="Shared Listing Channel Evidence" data={selectedSnapshot.shared_listing_channel_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_listing_channel_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_listing_channel_evidence && (
                  <CollapsibleSection title="Target User Listing Channel Evidence" data={selectedSnapshot.target_user_listing_channel_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_listing_channel_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.shared_capital_liquidity_evidence && (
                  <CollapsibleSection title="Shared Capital & Liquidity Evidence" data={selectedSnapshot.shared_capital_liquidity_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_capital_liquidity_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_capital_liquidity_evidence && (
                  <CollapsibleSection title="Target User Capital & Liquidity Evidence" data={selectedSnapshot.target_user_capital_liquidity_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_capital_liquidity_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.shared_calendar_seasonality_evidence && (
                  <CollapsibleSection title="Shared Calendar & Seasonality Evidence" data={selectedSnapshot.shared_calendar_seasonality_evidence}>
                    <JsonBlock value={selectedSnapshot.shared_calendar_seasonality_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_calendar_seasonality_evidence && (
                  <CollapsibleSection title="Target User Calendar & Seasonality Evidence" data={selectedSnapshot.target_user_calendar_seasonality_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_calendar_seasonality_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_pattern_discovery_evidence && (
                  <CollapsibleSection title="Pattern Discovery Evidence" data={selectedSnapshot.target_user_pattern_discovery_evidence}>
                    <JsonBlock value={selectedSnapshot.target_user_pattern_discovery_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.pattern_discovery && (
                  <CollapsibleSection title="Pattern Discovery Findings" data={selectedSnapshot.pattern_discovery}>
                    <JsonBlock value={selectedSnapshot.pattern_discovery} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.insights && (
                  <CollapsibleSection title="Insights" defaultOpen data={selectedSnapshot.insights}>
                    <JsonBlock value={selectedSnapshot.insights} />
                  </CollapsibleSection>
                )}

                {/* v1.0-v1.8 sections — present only on older stored runs from
                    before the v2.2 promotion. */}
                {selectedSnapshot.evidence_aggregates && (
                  <>
                    <CollapsibleSection title="Acquisition Value Band" data={selectedSnapshot.evidence_aggregates.acquisition_value_band}>
                      <JsonBlock value={selectedSnapshot.evidence_aggregates.acquisition_value_band} />
                    </CollapsibleSection>
                    <CollapsibleSection title="Acquisition to Exit" data={selectedSnapshot.evidence_aggregates.acquisition_to_exit}>
                      <JsonBlock value={selectedSnapshot.evidence_aggregates.acquisition_to_exit} />
                    </CollapsibleSection>
                    <CollapsibleSection title="Brand" data={selectedSnapshot.evidence_aggregates.brand}>
                      <JsonBlock value={selectedSnapshot.evidence_aggregates.brand} />
                    </CollapsibleSection>
                    {selectedSnapshot.evidence_aggregates.deal_in_channel && (
                      <CollapsibleSection title="Deal In Channel" data={selectedSnapshot.evidence_aggregates.deal_in_channel}>
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.deal_in_channel} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.deal_out_channel && (
                      <CollapsibleSection title="Deal Out Channel" data={selectedSnapshot.evidence_aggregates.deal_out_channel}>
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.deal_out_channel} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.channel_journey && (
                      <CollapsibleSection title="Channel Journey" data={selectedSnapshot.evidence_aggregates.channel_journey}>
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.channel_journey} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.listing_channel_exposure && (
                      <CollapsibleSection title="Listing Channel Exposure" data={selectedSnapshot.evidence_aggregates.listing_channel_exposure}>
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.listing_channel_exposure} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.category_type_performance && (
                      <CollapsibleSection title="Category & Type Performance" data={selectedSnapshot.evidence_aggregates.category_type_performance}>
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.category_type_performance} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.capital_liquidity && (
                      <CollapsibleSection title="Capital & Liquidity" data={selectedSnapshot.evidence_aggregates.capital_liquidity}>
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.capital_liquidity} />
                      </CollapsibleSection>
                    )}
                  </>
                )}
                {selectedSnapshot.target_user_evidence?.open_inventory_decision_support && (
                  <CollapsibleSection title="Open Inventory Decision Support v1" data={selectedSnapshot.target_user_evidence.open_inventory_decision_support}>
                    <JsonBlock value={selectedSnapshot.target_user_evidence.open_inventory_decision_support} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.recommendation_candidates && (
                  <CollapsibleSection title="My Open Business Items" data={selectedSnapshot.recommendation_candidates.open_business_items}>
                    <JsonBlock value={selectedSnapshot.recommendation_candidates.open_business_items} />
                  </CollapsibleSection>
                )}

                <CollapsibleSection title="Raw Snapshot" data={selectedSnapshot}>
                  <JsonBlock value={selectedSnapshot} />
                </CollapsibleSection>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
