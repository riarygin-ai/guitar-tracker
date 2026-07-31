'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import CompactPageHeader from '@/components/CompactPageHeader';
import { supabase, getRecentAnalyticsRuns, getAnalyticsRunSnapshot } from '@/lib/supabase';
import type { AnalyticsRun, AnalyticsRunMeta, AnalyticsRunStatus, AnalyticsSnapshot } from '@/types';

const HISTORY_LIMIT = 10;

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

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-slate-900 dark:text-white">{title}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-slate-400 transition-transform dark:text-slate-500 ${open ? 'rotate-90' : ''}`}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
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

  const [copied, setCopied] = useState(false);

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null;

  useEffect(() => {
    loadHistory();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    setRuns((data as AnalyticsRunMeta[] | null) ?? []);
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
    setCopied(false);
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
      setRuns((prev) => [toMetaFromRun(run), ...prev.filter((r) => r.id !== run.id)].slice(0, HISTORY_LIMIT));
      selectRun(run.id, run.snapshot ?? null);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Something went wrong running analytics.');
    } finally {
      setRunningAnalytics(false);
    }
  }

  async function handleCopySnapshot() {
    if (!selectedSnapshot) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedSnapshot, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in non-secure context — no-op.
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
                    <th className="px-4 py-2.5 font-semibold"><span className="sr-only">Action</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-800">
                  {runs.map((run) => {
                    const isSelected = run.id === selectedRunId;
                    return (
                      <tr key={run.id} className={isSelected ? 'bg-slate-50 dark:bg-slate-700/50' : 'hover:bg-slate-50 dark:hover:bg-slate-700/40'}>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{formatDateTime(run.created_at)}</td>
                        <td className="px-4 py-3"><StatusBadge status={run.status} /></td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{formatDuration(run.duration_ms)}</td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{run.analytics_version}</td>
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
                    (build_analytics_snapshot_v2_2 and its v2.0/v2.1 ancestors).
                    Absent on older stored v1.0-v1.8 runs. */}
                {selectedSnapshot.shared_purpose_evidence && (
                  <CollapsibleSection title="Shared Purpose Evidence">
                    <JsonBlock value={selectedSnapshot.shared_purpose_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_purpose_evidence && (
                  <CollapsibleSection title="Target User Purpose Evidence">
                    <JsonBlock value={selectedSnapshot.target_user_purpose_evidence} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.target_user_open_inventory_evidence && (
                  <CollapsibleSection title="Open Inventory Decision Support" defaultOpen>
                    <JsonBlock value={selectedSnapshot.target_user_open_inventory_evidence} />
                  </CollapsibleSection>
                )}

                {/* v1.0-v1.8 sections — present only on older stored runs from
                    before the v2.2 promotion. */}
                {selectedSnapshot.evidence_aggregates && (
                  <>
                    <CollapsibleSection title="Acquisition Value Band">
                      <JsonBlock value={selectedSnapshot.evidence_aggregates.acquisition_value_band} />
                    </CollapsibleSection>
                    <CollapsibleSection title="Acquisition to Exit">
                      <JsonBlock value={selectedSnapshot.evidence_aggregates.acquisition_to_exit} />
                    </CollapsibleSection>
                    <CollapsibleSection title="Brand">
                      <JsonBlock value={selectedSnapshot.evidence_aggregates.brand} />
                    </CollapsibleSection>
                    {selectedSnapshot.evidence_aggregates.deal_in_channel && (
                      <CollapsibleSection title="Deal In Channel">
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.deal_in_channel} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.deal_out_channel && (
                      <CollapsibleSection title="Deal Out Channel">
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.deal_out_channel} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.channel_journey && (
                      <CollapsibleSection title="Channel Journey">
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.channel_journey} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.listing_channel_exposure && (
                      <CollapsibleSection title="Listing Channel Exposure">
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.listing_channel_exposure} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.category_type_performance && (
                      <CollapsibleSection title="Category & Type Performance">
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.category_type_performance} />
                      </CollapsibleSection>
                    )}
                    {selectedSnapshot.evidence_aggregates.capital_liquidity && (
                      <CollapsibleSection title="Capital & Liquidity">
                        <JsonBlock value={selectedSnapshot.evidence_aggregates.capital_liquidity} />
                      </CollapsibleSection>
                    )}
                  </>
                )}
                {selectedSnapshot.target_user_evidence?.open_inventory_decision_support && (
                  <CollapsibleSection title="Open Inventory Decision Support v1">
                    <JsonBlock value={selectedSnapshot.target_user_evidence.open_inventory_decision_support} />
                  </CollapsibleSection>
                )}
                {selectedSnapshot.recommendation_candidates && (
                  <CollapsibleSection title="My Open Business Items">
                    <JsonBlock value={selectedSnapshot.recommendation_candidates.open_business_items} />
                  </CollapsibleSection>
                )}

                <CollapsibleSection title="Raw Snapshot">
                  <div className="space-y-3">
                    <JsonBlock value={selectedSnapshot} />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleCopySnapshot}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                      >
                        {copied ? (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            <span className="text-emerald-600 dark:text-emerald-400">Copied!</span>
                          </>
                        ) : (
                          <>
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                            Copy Snapshot JSON
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </CollapsibleSection>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
