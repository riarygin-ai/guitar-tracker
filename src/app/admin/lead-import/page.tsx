'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import CompactPageHeader from '@/components/CompactPageHeader';
import { getLeadImportSources, getOrCreateAppUser, supabase, upsertLeadImportSource } from '@/lib/supabase';
import { extractSpreadsheetId } from '@/lib/leadImport/spreadsheetId';
import type { AppUser } from '@/types';
import type { LeadImportSource, PreviewResult, RowClassification } from '@/lib/leadImport/types';

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

  const currentSource = selectedUserId != null ? sources.find((s) => s.user_id === selectedUserId) ?? null : null;

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
  }, [selectedUserId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function handlePreview() {
    if (!currentSource) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewResult(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setPreviewLoading(false);
      setPreviewError('Not authenticated — please sign in again.');
      return;
    }

    try {
      const res = await fetch('/api/admin/lead-import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ sourceId: currentSource.id }),
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
            Configure each user&apos;s GT Lead Log spreadsheet and preview what an import would do. Read-only — no leads are written yet.
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
            disabled={previewLoading || !currentSource}
            className={btnSecondary}
            title={!currentSource ? 'Save the source configuration first' : undefined}
          >
            {previewLoading ? 'Running Preview…' : 'Preview Lead Import'}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          Import will be enabled after preview validation is reviewed.
        </p>
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
    </div>
  );
}
