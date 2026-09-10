'use client';

// "Copy Analysis Data" / "Download Analysis Data" — the primary
// user-facing export controls for the Listing Dashboard. Always exports
// the complete dataset: every currently-open inventory item (listed AND
// unlisted), each with its full listing history and price history — no
// scope selector, since there is only one export now (see analysisExport
// Clipboard.ts / buildAnalysisExportData). Reuses the exact Bearer-token
// auth pattern already established for Listing Evidence copying (src/
// components/CopyListingEvidenceButton.tsx): resolve the current Supabase
// session at click time, send its access token, never accept/derive a
// user id client-side. GET /api/listing-analysis-export resolves the
// target user from that token server-side.
//
// Per-channel "Copy {Channel} Analysis" quick-copy buttons elsewhere on
// the page are a separate, narrower feature (src/components/
// CopyAnalysisScopeButton.tsx) and are unaffected by this control.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  createAnalysisExportCopier,
  createAnalysisExportDownloader,
  type AnalysisExportDeps,
} from '@/lib/analysisExportClipboard';
import { formatAnalysisExportConfirmationMessage } from '@/lib/analytics/listingAnalysisPacket';

type ActionState = 'idle' | 'loading' | 'success' | 'error';

const RESET_DELAY_MS = 4000;

// Standard Blob + anchor-click download — works in every modern desktop
// and mobile browser (this is *why* the button exists: pasting a large
// JSON payload out of a modal on a phone is painful, downloading a file
// is not). Some older mobile Safari versions open the file in a new tab
// instead of saving it directly; that's a platform limitation, not
// something fixable from here.
function triggerBrowserDownload(filename: string, json: string) {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export default function CopyAnalysisDataControl() {
  const [copyState, setCopyState] = useState<ActionState>('idle');
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const [downloadState, setDownloadState] = useState<ActionState>('idle');
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    if (downloadResetTimerRef.current) clearTimeout(downloadResetTimerRef.current);
  }, []);

  const deps = useRef<AnalysisExportDeps>({
    getAccessToken: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      return session?.access_token ?? null;
    },
    fetchImpl: (input: string, init?: RequestInit) => fetch(input, init),
    writeText: async (text: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(text);
    },
    downloadFile: triggerBrowserDownload,
  });

  const copierRef = useRef(createAnalysisExportCopier(deps.current));
  const downloaderRef = useRef(createAnalysisExportDownloader(deps.current));

  const anyLoading = copyState === 'loading' || downloadState === 'loading';

  async function handleCopy() {
    if (anyLoading) return;
    setCopyState('loading');
    setCopyMessage(null);

    const result = await copierRef.current.copy();
    if (!mountedRef.current) return;
    if (result.status === 'already_in_progress') { setCopyState('idle'); return; }

    if (result.status === 'success') {
      setCopyState('success');
      setCopyMessage(formatAnalysisExportConfirmationMessage(result.data));
    } else {
      setCopyState('error');
      setCopyMessage(result.message);
    }

    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setCopyState('idle');
      setCopyMessage(null);
    }, RESET_DELAY_MS);
  }

  async function handleDownload() {
    if (anyLoading) return;
    setDownloadState('loading');
    setDownloadMessage(null);

    const result = await downloaderRef.current.download();
    if (!mountedRef.current) return;
    if (result.status === 'already_in_progress') { setDownloadState('idle'); return; }

    if (result.status === 'success') {
      setDownloadState('success');
      setDownloadMessage(`Downloaded ${result.filename}`);
    } else {
      setDownloadState('error');
      setDownloadMessage(result.message);
    }

    if (downloadResetTimerRef.current) clearTimeout(downloadResetTimerRef.current);
    downloadResetTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setDownloadState('idle');
      setDownloadMessage(null);
    }, RESET_DELAY_MS);
  }

  const copyLabel = copyState === 'loading' ? 'Copying…' : copyState === 'success' ? 'Copied' : 'Copy Analysis Data';
  const downloadLabel = downloadState === 'loading' ? 'Preparing…' : downloadState === 'success' ? 'Downloaded' : 'Download Analysis Data';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <button
          type="button"
          onClick={handleCopy}
          disabled={anyLoading}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-950 px-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 sm:w-auto sm:shrink-0"
        >
          {copyState === 'loading' && (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-slate-900/40 dark:border-t-slate-900" />
          )}
          {copyLabel}
        </button>

        <button
          type="button"
          onClick={handleDownload}
          disabled={anyLoading}
          className="inline-flex h-9 w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 sm:w-auto sm:shrink-0"
        >
          {downloadState === 'loading' && (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400/40 border-t-slate-500 dark:border-slate-300/30 dark:border-t-slate-300" />
          )}
          {downloadLabel}
        </button>
      </div>

      {copyMessage && (
        <p className={`text-xs ${copyState === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {copyMessage}
        </p>
      )}
      {downloadMessage && (
        <p className={`text-xs ${downloadState === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {downloadMessage}
        </p>
      )}
    </div>
  );
}
