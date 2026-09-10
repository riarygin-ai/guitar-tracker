'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import CompactPageHeader from '@/components/CompactPageHeader';
import { getLeadImportSources, getOrCreateAppUser, supabase, upsertLeadImportSource } from '@/lib/supabase';
import { extractSpreadsheetId } from '@/lib/leadImport/spreadsheetId';
import type { AppUser } from '@/types';
import type {
  ImportRowResult,
  ImportRunOutcome,
  ImportRunStatus,
  LeadImportRunRow,
  LeadImportRunSummary,
  LeadImportSource,
  PreviewResult,
  RowClassification,
} from '@/lib/leadImport/types';

interface PickerUser {
  id: number;
  email: string | null;
  display_name: string;
}

const inputClass = 'h-9 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-100 dark:focus:bg-slate-700 dark:focus:ring-slate-600';
const labelClass = 'block text-xs font-medium text-slate-600 dark:text-slate-400';
const btnPrimary = 'inline-flex h-9 items-center justify-center rounded-xl bg-slate-950 px-4 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400';
const btnSecondary = 'inline-flex h-9 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

const CLASSIFICATION_STYLES: Record<RowClassification, string> = {
  NEW: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  UPDATE: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  UNCHANGED: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  SOURCE_OLDER: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  INVALID: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
};

const RUN_STATUS_STYLES: Record<ImportRunStatus, string> = {
  RUNNING: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  COMPLETED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  COMPLETED_WITH_ERRORS: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  FAILED: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
};

const RUN_STATUS_LABELS: Record<ImportRunStatus, string> = {
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  COMPLETED_WITH_ERRORS: 'Completed with errors',
  FAILED: 'Failed',
};

const ROW_RESULT_LABELS: Record<ImportRowResult, string> = {
  INSERTED: 'Inserted',
  UPDATED: 'Updated',
  SKIPPED_UNCHANGED: 'Skipped — unchanged',
  SKIPPED_SOURCE_OLDER: 'Skipped — source older',
  SKIPPED_INVALID: 'Skipped — invalid',
  SKIPPED_NOT_APPLIED: 'Not applied',
  FAILED: 'Failed',
};

function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export default function LeadImportAdminPage() {
  const router = useRouter();

  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<AppUser | null>(null);

  const [pickerUsers, setPickerUsers] = useState<PickerUser[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

  const [sources, setSources] = useState<LeadImportSource[]>([]);

  const [sourceName, setSourceName] = useState('');
  const [spreadsheetInput, setSpreadsheetInput] = useState('');
  const [sheetName, setSheetName] = useState('Leads');
  const [isEnabled, setIsEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [issueFilter, setIssueFilter] = useState<'all' | RowClassification>('INVALID');

  const [importing, setImporting] = useState(false);
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importOutcome, setImportOutcome] = useState<ImportRunOutcome | null>(null);

  const [runs, setRuns] = useState<LeadImportRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [runRows, setRunRows] = useState<Record<number, LeadImportRunRow[]>>({});
  const [runRowsLoading, setRunRowsLoading] = useState(false);

  const currentSource = selectedUserId != null ? sources.find((s) => s.user_id === selectedUserId) ?? null : null;

  // The number of rows an Import would actually write. "Changes" rather
  // than "leads" because a run can carry inserts and updates together.
  const pendingChangeCount =
    previewResult && !previewResult.fatal ? previewResult.counts.new + previewResult.counts.updates : 0;

  async function accessToken(): Promise<string | null> {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }

  // ── Auth guard ─────────────────────────────────────────────────────────
  useEffect(() => {
    getOrCreateAppUser().then((u) => {
      setUser(u);
      setAuthLoading(false);
      if (!u) router.replace('/login');
    });
  }, [router]);

  // ── Load picker users + existing sources ─────────────────────────────────
  useEffect(() => {
    if (!user?.admin) return;

    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const [usersRes, sourcesRes] = await Promise.all([
        fetch('/api/admin/lead-import/users', { headers: { Authorization: `Bearer ${session.access_token}` } }),
        getLeadImportSources(),
      ]);

      if (usersRes.ok) {
        const payload = (await usersRes.json()) as { users: PickerUser[] };
        setPickerUsers(payload.users);
        if (payload.users.length > 0) setSelectedUserId((prev) => prev ?? payload.users[0].id);
      } else {
        setPickerError('Could not load users.');
      }

      if (!sourcesRes.error) setSources((sourcesRes.data as LeadImportSource[]) ?? []);
    }

    load();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Populate the form from the selected user's existing source ──────────
  useEffect(() => {
    if (selectedUserId == null) return;
    const existing = sources.find((s) => s.user_id === selectedUserId);
    const pickerUser = pickerUsers.find((u) => u.id === selectedUserId);
    setSourceName(existing?.source_name ?? (pickerUser ? `${pickerUser.display_name} GT Lead Log` : ''));
    setSpreadsheetInput(existing?.spreadsheet_id ?? '');
    setSheetName(existing?.sheet_name ?? 'Leads');
    setIsEnabled(existing?.is_enabled ?? true);
    setSaveError(null);
    setSavedAt(null);
    setPreviewResult(null);
    setPreviewError(null);
    setImportOutcome(null);
    setImportError(null);
    setConfirmingImport(false);
    setExpandedRunId(null);
  }, [selectedUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Import history for the selected source ───────────────────────────────
  const currentSourceId = currentSource?.id ?? null;

  const loadRuns = useCallback(async (sourceId: number) => {
    setRunsLoading(true);
    try {
      const token = await accessToken();
      if (!token) return;
      const res = await fetch(`/api/admin/lead-import/runs?sourceId=${sourceId}&limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { runs: LeadImportRunSummary[] };
      setRuns(payload.runs ?? []);
    } catch {
      // History is supplementary — a failed fetch never blocks the page.
    } finally {
      setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user?.admin) return;
    if (currentSourceId == null) { setRuns([]); return; }
    loadRuns(currentSourceId);
  }, [user, currentSourceId, loadRuns]);

  async function handleSave() {
    if (selectedUserId == null) return;
    const trimmedName = sourceName.trim();
    if (!trimmedName) { setSaveError('Source Name is required.'); return; }
    const spreadsheetId = extractSpreadsheetId(spreadsheetInput);
    if (!spreadsheetId) { setSaveError('Enter a valid Google Sheets URL or spreadsheet ID.'); return; }
    const trimmedSheetName = sheetName.trim() || 'Leads';

    setSaving(true);
    setSaveError(null);
    const { data, error } = await upsertLeadImportSource({
      user_id: selectedUserId,
      source_name: trimmedName,
      spreadsheet_id: spreadsheetId,
      sheet_name: trimmedSheetName,
      is_enabled: isEnabled,
    });
    setSaving(false);

    if (error) {
      setSaveError(error.message || 'Could not save source configuration.');
      return;
    }

    const saved = data as LeadImportSource;
    setSources((prev) => {
      const withoutThisUser = prev.filter((s) => s.user_id !== selectedUserId);
      return [...withoutThisUser, saved];
    });
    setSpreadsheetInput(saved.spreadsheet_id);
    setSheetName(saved.sheet_name);
    setSavedAt(saved.updated_at);
    setPreviewResult(null);
  }

  async function runPreview(sourceId: number) {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewResult(null);
    setConfirmingImport(false);

    const token = await accessToken();
    if (!token) {
      setPreviewLoading(false);
      setPreviewError('Not authenticated — please sign in again.');
      return;
    }

    try {
      const res = await fetch('/api/admin/lead-import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sourceId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreviewError(payload.error || 'Preview failed.');
        return;
      }
      setPreviewResult(payload.result as PreviewResult);
      setIssueFilter('INVALID');
    } catch {
      setPreviewError('Preview failed (network error).');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handlePreview() {
    if (!currentSource) return;
    setImportOutcome(null);
    setImportError(null);
    await runPreview(currentSource.id);
  }

  // Sends nothing but the source id: the server re-reads the sheet,
  // re-validates and re-classifies before writing anything, so the Preview
  // shown above is never the thing that gets imported.
  async function handleImport() {
    if (!currentSource || importing) return;
    setConfirmingImport(false);
    setImporting(true);
    setImportError(null);
    setImportOutcome(null);

    const token = await accessToken();
    if (!token) {
      setImporting(false);
      setImportError('Not authenticated — please sign in again.');
      return;
    }

    try {
      const res = await fetch('/api/admin/lead-import/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sourceId: currentSource.id }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportError(payload.error || 'Import failed.');
        return;
      }
      setImportOutcome(payload.result as ImportRunOutcome);
    } catch {
      setImportError('Import failed (network error).');
    } finally {
      setImporting(false);
      // Re-run Preview straight away so the page shows the post-import
      // state (a clean second run should report every row UNCHANGED), and
      // refresh the history plus the source's own last-import timestamp.
      const refreshedSources = await getLeadImportSources();
      if (!refreshedSources.error) setSources((refreshedSources.data as LeadImportSource[]) ?? []);
      await loadRuns(currentSource.id);
      await runPreview(currentSource.id);
    }
  }

  async function toggleRunDetail(runId: number) {
    if (expandedRunId === runId) { setExpandedRunId(null); return; }
    setExpandedRunId(runId);
    if (runRows[runId]) return;

    setRunRowsLoading(true);
    try {
      const token = await accessToken();
      if (!token) return;
      const res = await fetch(`/api/admin/lead-import/runs/${runId}/rows`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { rows: LeadImportRunRow[] };
      setRunRows((prev) => ({ ...prev, [runId]: payload.rows ?? [] }));
    } catch {
      // Leave the row list empty — the run header still tells the story.
    } finally {
      setRunRowsLoading(false);
    }
  }

  // ── Render guards ─────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading...</p>
      </div>
    );
  }
  if (!user) return null;
  if (!user.admin) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 dark:border-rose-800/50 dark:bg-rose-900/20">
          <p className="text-lg font-semibold text-rose-700 dark:text-rose-400">Access denied</p>
          <p className="mt-2 text-sm text-rose-600 dark:text-rose-500">You do not have admin privileges.</p>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const filteredRows = previewResult
    ? issueFilter === 'all'
      ? previewResult.rows
      : previewResult.rows.filter((r) => r.classification === issueFilter)
    : [];

  return (
    <div className="space-y-6">
      <CompactPageHeader
        overline="Admin · Lead Log Import"
        summary={
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Configure each user&apos;s GT Lead Log spreadsheet, preview what an import would do, then import. Importing re-reads
            the whole sheet server-side and only writes new or genuinely newer rows — it never deletes a lead.
          </p>
        }
      />

      {/* ── Source configuration ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">Source configuration</h2>

        {pickerError && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{pickerError}</p>}

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className={labelClass}>Guitar Tracker user</label>
            <select
              value={selectedUserId ?? ''}
              onChange={(e) => setSelectedUserId(Number(e.target.value))}
              className={inputClass}
            >
              {pickerUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.display_name} {u.email ? `(${u.email})` : ''}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={labelClass}>Source Name</label>
            <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} disabled={saving} className={inputClass} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <label className={labelClass}>Spreadsheet URL or ID</label>
            <input
              value={spreadsheetInput}
              onChange={(e) => setSpreadsheetInput(e.target.value)}
              disabled={saving}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <label className={labelClass}>Sheet Name</label>
            <input value={sheetName} onChange={(e) => setSheetName(e.target.value)} disabled={saving} placeholder="Leads" className={inputClass} />
          </div>
          <div className="space-y-1.5">
            <label className={labelClass}>Enabled</label>
            <button
              type="button"
              role="switch"
              aria-checked={isEnabled}
              onClick={() => setIsEnabled((v) => !v)}
              disabled={saving}
              className={`relative mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${isEnabled ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>

        {saveError && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
            {saveError}
          </div>
        )}
        {savedAt && !saveError && (
          <p className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">Saved {new Date(savedAt).toLocaleString()}</p>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={handleSave} disabled={saving || selectedUserId == null} className={btnPrimary}>
            {saving ? 'Saving…' : currentSource ? 'Save changes' : 'Create source'}
          </button>
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewLoading || importing || !currentSource}
            className={btnSecondary}
            title={!currentSource ? 'Save the source configuration first' : undefined}
          >
            {previewLoading ? 'Running Preview…' : 'Preview Lead Import'}
          </button>
        </div>
        {currentSource && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            {currentSource.last_successful_import_at
              ? `Last successful import ${new Date(currentSource.last_successful_import_at).toLocaleString()}.`
              : 'This source has never been imported.'}
          </p>
        )}
      </div>

      {/* ── Preview result ────────────────────────────────────────────── */}
      {previewError && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
          {previewError}
        </div>
      )}

      {previewResult?.fatal && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 shadow-sm dark:border-rose-800/50 dark:bg-rose-900/20">
          <h2 className="text-base font-semibold text-rose-700 dark:text-rose-400">Preview could not run</h2>
          <ul className="mt-3 space-y-2">
            {previewResult.fatalIssues.map((issue, i) => (
              <li key={i} className="text-sm text-rose-700 dark:text-rose-300">
                <span className="font-mono text-xs">{issue.code}</span> — {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Import result ─────────────────────────────────────────────── */}
      {importError && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
          {importError}
        </div>
      )}

      {importOutcome && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Import result</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_STYLES[importOutcome.status]}`}>
              {RUN_STATUS_LABELS[importOutcome.status]}
            </span>
            <span className="text-xs text-slate-400 dark:text-slate-500">Run #{importOutcome.runId}</span>
          </div>

          {importOutcome.errorSummary && (
            <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{importOutcome.errorSummary}</p>
          )}
          {importOutcome.fatalIssues.map((issue, i) => (
            <p key={i} className="mt-1 text-xs text-rose-600 dark:text-rose-400">
              <span className="font-mono">{issue.code}</span> — {issue.message}
            </p>
          ))}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {([
              ['Inserted', importOutcome.counts.inserted, CLASSIFICATION_STYLES.NEW],
              ['Updated', importOutcome.counts.updated, CLASSIFICATION_STYLES.UPDATE],
              ['Unchanged', importOutcome.counts.unchanged, CLASSIFICATION_STYLES.UNCHANGED],
              ['Invalid skipped', importOutcome.counts.invalid, CLASSIFICATION_STYLES.INVALID],
              ['Source older skipped', importOutcome.counts.sourceOlder, CLASSIFICATION_STYLES.SOURCE_OLDER],
            ] as [string, number, string][]).map(([label, value, style]) => (
              <div key={label} className={`rounded-xl border border-slate-200 p-3 text-center dark:border-slate-700 ${style}`}>
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs opacity-80">{label}</p>
              </div>
            ))}
          </div>

          {importOutcome.counts.failed > 0 && (
            <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">
              {importOutcome.counts.failed} eligible row(s) were not applied. Nothing was partially written — see the run detail below.
            </p>
          )}
        </div>
      )}

      {previewResult && !previewResult.fatal && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Preview result</h2>

          {previewResult.sourceWarnings.length > 0 && (
            <div className="mt-3 space-y-1">
              {previewResult.sourceWarnings.map((w, i) => (
                <p key={i} className="text-xs text-amber-600 dark:text-amber-400">{w.message}</p>
              ))}
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {([
              ['Scanned', previewResult.counts.rowsScanned, ''],
              ['New', previewResult.counts.new, CLASSIFICATION_STYLES.NEW],
              ['Updates', previewResult.counts.updates, CLASSIFICATION_STYLES.UPDATE],
              ['Unchanged', previewResult.counts.unchanged, CLASSIFICATION_STYLES.UNCHANGED],
              ['Source older', previewResult.counts.sourceOlder, CLASSIFICATION_STYLES.SOURCE_OLDER],
              ['Invalid', previewResult.counts.invalid, CLASSIFICATION_STYLES.INVALID],
              ['Warnings', previewResult.counts.warnings, ''],
            ] as [string, number, string][]).map(([label, value, style]) => (
              <div key={label} className={`rounded-xl border border-slate-200 p-3 text-center dark:border-slate-700 ${style}`}>
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs opacity-80">{label}</p>
              </div>
            ))}
          </div>

          {/* ── Import action ──────────────────────────────────────── */}
          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-700/30">
            {pendingChangeCount === 0 ? (
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled className={btnPrimary}>No changes to import</button>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Every scanned row already matches what is stored.
                </p>
              </div>
            ) : confirmingImport ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  Import {pendingChangeCount} {pendingChangeCount === 1 ? 'change' : 'changes'} from {currentSource?.source_name}?
                </p>
                <button type="button" onClick={handleImport} disabled={importing} className={btnPrimary}>
                  {importing ? 'Importing…' : 'Yes, import'}
                </button>
                <button type="button" onClick={() => setConfirmingImport(false)} disabled={importing} className={btnSecondary}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmingImport(true)}
                  disabled={importing || previewLoading}
                  className={btnPrimary}
                >
                  {importing ? (
                    <span className="flex items-center gap-2">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Importing…
                    </span>
                  ) : (
                    `Import ${pendingChangeCount} ${pendingChangeCount === 1 ? 'change' : 'changes'}`
                  )}
                </button>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {previewResult.counts.new} new · {previewResult.counts.updates} updated
                  {previewResult.counts.invalid > 0 && ` · ${previewResult.counts.invalid} invalid row(s) will be skipped`}
                </p>
              </div>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            {(['all', 'INVALID', 'SOURCE_OLDER', 'UPDATE', 'NEW', 'UNCHANGED'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setIssueFilter(f)}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition ${issueFilter === f ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
              >
                {f === 'all' ? 'All rows' : f}
              </button>
            ))}
          </div>

          <div className="mt-3 max-h-[32rem] overflow-y-auto rounded-xl border border-slate-100 dark:border-slate-700/50">
            {filteredRows.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">No rows match this filter.</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {filteredRows.map((row) => (
                  <li key={row.rowNumber} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-400 dark:text-slate-500">Row {row.rowNumber}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CLASSIFICATION_STYLES[row.classification]}`}>
                        {row.classification}
                      </span>
                      {row.itemId != null && <span className="text-xs text-slate-400 dark:text-slate-500">item #{row.itemId}</span>}
                      {row.leadId && <span className="truncate font-mono text-xs text-slate-400 dark:text-slate-500">{row.leadId}</span>}
                    </div>
                    {row.issues.length > 0 && (
                      <ul className="mt-1.5 space-y-1 pl-1">
                        {row.issues.map((issue, i) => (
                          <li
                            key={i}
                            className={`text-xs ${issue.severity === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}
                          >
                            <span className="font-mono">{issue.code}</span> — {issue.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── Import history ────────────────────────────────────────────── */}
      {currentSource && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">Recent imports</h2>
            <button
              type="button"
              onClick={() => loadRuns(currentSource.id)}
              disabled={runsLoading || importing}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:underline disabled:opacity-50 dark:text-slate-400"
            >
              {runsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {runs.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              {runsLoading ? 'Loading…' : 'No imports have been run for this source yet.'}
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Source / user</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 text-right font-medium">Scanned</th>
                    <th className="py-2 pr-3 text-right font-medium">Inserted</th>
                    <th className="py-2 pr-3 text-right font-medium">Updated</th>
                    <th className="py-2 pr-3 text-right font-medium">Invalid</th>
                    <th className="py-2 pr-3 text-right font-medium">Took</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                  {runs.map((run) => (
                    <Fragment key={run.id}>
                      <tr className="text-slate-700 dark:text-slate-200">
                        <td className="py-2 pr-3 whitespace-nowrap">{new Date(run.started_at).toLocaleString()}</td>
                        <td className="py-2 pr-3">
                          <span className="block truncate">{run.source_name}</span>
                          {run.user_display_name && (
                            <span className="block text-xs text-slate-400 dark:text-slate-500">{run.user_display_name}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${RUN_STATUS_STYLES[run.status]}`}>
                            {RUN_STATUS_LABELS[run.status]}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{run.source_row_count}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{run.inserted_count}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{run.updated_count}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{run.invalid_count}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{formatDuration(run.started_at, run.completed_at)}</td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            onClick={() => toggleRunDetail(run.id)}
                            className="text-xs font-medium text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
                          >
                            {expandedRunId === run.id ? 'Hide' : 'Issues'}
                          </button>
                        </td>
                      </tr>
                      {expandedRunId === run.id && (
                        <tr>
                          <td colSpan={9} className="bg-slate-50 px-3 py-3 dark:bg-slate-700/30">
                            {run.error_summary && (
                              <p className="mb-2 text-xs text-rose-600 dark:text-rose-400">{run.error_summary}</p>
                            )}
                            {runRowsLoading && !runRows[run.id] ? (
                              <p className="text-xs text-slate-500 dark:text-slate-400">Loading run detail…</p>
                            ) : (runRows[run.id]?.length ?? 0) === 0 ? (
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                No invalid, source-older or unapplied rows in this run.
                              </p>
                            ) : (
                              <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                                {runRows[run.id].map((rr) => (
                                  <li key={rr.id} className="text-xs">
                                    <span className="font-mono text-slate-400 dark:text-slate-500">Row {rr.sheet_row_number}</span>
                                    <span className={`ml-2 rounded-full px-2 py-0.5 font-medium ${CLASSIFICATION_STYLES[rr.classification]}`}>
                                      {rr.classification}
                                    </span>
                                    <span className="ml-2 text-slate-500 dark:text-slate-400">{ROW_RESULT_LABELS[rr.result]}</span>
                                    {rr.issue_codes.length > 0 && (
                                      <span className="ml-2 font-mono text-rose-600 dark:text-rose-400">{rr.issue_codes.join(', ')}</span>
                                    )}
                                    {rr.issue_message && (
                                      <span className="ml-2 text-slate-500 dark:text-slate-400">{rr.issue_message}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
