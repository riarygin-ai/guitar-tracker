'use client';

// TEMPORARY admin/debug utility for inspecting real Listing Demand
// Evidence v1.0 output before /listings is redesigned to use it — same
// spirit as CopyListingEvidenceButton, extended with 7/30/90-day presets
// (resolved to explicit inclusive dates before calling the evidence route
// — no "last month" logic lives in the browser either) and a Download
// action for convenient off-app inspection. Not polished analytics UI —
// do not link this from /listings.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  createListingDemandEvidenceCopier,
  createListingDemandEvidenceDownloader,
  resolveDayCountPreset,
  type ListingDemandEvidenceDeps,
} from '@/lib/listingDemandEvidenceClipboard';

type ActionState = 'idle' | 'loading' | 'success' | 'error';
type DayPreset = 7 | 30 | 90;

const RESET_DELAY_MS = 3200;
const PRESETS: DayPreset[] = [7, 30, 90];

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

export default function ListingDemandEvidenceDebugControl() {
  const [preset, setPreset] = useState<DayPreset>(30);

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

  const deps = useRef<ListingDemandEvidenceDeps>({
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

  const copierRef = useRef(createListingDemandEvidenceCopier(deps.current));
  const downloaderRef = useRef(createListingDemandEvidenceDownloader(deps.current));

  const anyLoading = copyState === 'loading' || downloadState === 'loading';

  async function handleCopy() {
    if (anyLoading) return;
    setCopyState('loading');
    setCopyMessage(null);

    const range = resolveDayCountPreset(preset);
    const result = await copierRef.current.copy(range);
    if (!mountedRef.current) return;
    if (result.status === 'already_in_progress') { setCopyState('idle'); return; }

    if (result.status === 'success') {
      setCopyState('success');
      setCopyMessage(`Copied ${range.startDate} → ${range.endDate} (${preset}d)`);
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

    const range = resolveDayCountPreset(preset);
    const result = await downloaderRef.current.download(range);
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

  const copyLabel = copyState === 'loading' ? 'Copying…' : copyState === 'success' ? 'Copied' : 'Copy Demand Evidence JSON';
  const downloadLabel = downloadState === 'loading' ? 'Preparing…' : downloadState === 'success' ? 'Downloaded' : 'Download JSON';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPreset(p)}
            disabled={anyLoading}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
              preset === p
                ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'
            }`}
          >
            {p} days
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          disabled={anyLoading}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
        >
          {copyState === 'loading' && (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400/40 border-t-slate-500 dark:border-slate-300/30 dark:border-t-slate-300" />
          )}
          {copyLabel}
        </button>

        <button
          type="button"
          onClick={handleDownload}
          disabled={anyLoading}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
        >
          {downloadState === 'loading' && (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400/40 border-t-slate-500 dark:border-slate-300/30 dark:border-t-slate-300" />
          )}
          {downloadLabel}
        </button>
      </div>

      {copyMessage && (
        <span className={`text-[11px] ${copyState === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {copyMessage}
        </span>
      )}
      {downloadMessage && (
        <span className={`text-[11px] ${downloadState === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {downloadMessage}
        </span>
      )}
    </div>
  );
}
