'use client';

// "Copy Analysis Data" — the normal user-facing GPT export control for the
// Listing Dashboard. Reuses the exact Bearer-token auth pattern already
// established for Listing Evidence copying (src/components/
// CopyListingEvidenceButton.tsx): resolve the current Supabase session at
// click time, send its access token, never accept/derive a user id
// client-side. GET /api/listing-analysis-packet resolves the target user
// from that token server-side.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  createAnalysisPacketCopier,
  fetchAnalysisPacket,
  type AnalysisPacketScopeSelection,
} from '@/lib/analysisPacketClipboard';
import { formatPacketConfirmationMessage, type ListingAnalysisPacket } from '@/lib/analytics/listingAnalysisPacket';

export interface CopyAnalysisDataControlProps {
  channels: { channel_id: number; channel_name: string }[];
}

type CopyState = 'idle' | 'loading' | 'success' | 'error';
type PreviewState = 'idle' | 'loading' | 'error';

const RESET_DELAY_MS = 4000;

function selectionKey(selection: AnalysisPacketScopeSelection): string {
  return selection.scope === 'channel' ? `channel:${selection.channelId}` : selection.scope;
}

function parseSelectionKey(key: string): AnalysisPacketScopeSelection {
  if (key === 'all' || key === 'unlisted') return { scope: key };
  const [, idStr] = key.split(':');
  return { scope: 'channel', channelId: Number(idStr) };
}

export default function CopyAnalysisDataControl({ channels }: CopyAnalysisDataControlProps) {
  const [selectedKey, setSelectedKey] = useState('all');

  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPacket, setPreviewPacket] = useState<ListingAnalysisPacket | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const deps = useRef({
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
  });

  const copierRef = useRef(createAnalysisPacketCopier(deps.current));

  function scheduleReset() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setCopyState('idle');
      setCopyMessage(null);
    }, RESET_DELAY_MS);
  }

  async function handleCopy() {
    if (copyState === 'loading') return;
    setCopyState('loading');
    setCopyMessage(null);

    const result = await copierRef.current.copy(parseSelectionKey(selectedKey));
    if (!mountedRef.current) return;

    if (result.status === 'already_in_progress') return;

    if (result.status === 'success') {
      setCopyState('success');
      setCopyMessage(formatPacketConfirmationMessage(result.packet));
      scheduleReset();
      return;
    }

    setCopyState('error');
    setCopyMessage(result.message);
    scheduleReset();
  }

  async function handlePreview() {
    setPreviewState('loading');
    setPreviewError(null);
    setPreviewOpen(true);

    const result = await fetchAnalysisPacket(deps.current, parseSelectionKey(selectedKey));
    if (!mountedRef.current) return;

    if (result.status === 'success') {
      setPreviewPacket(result.packet);
      setPreviewState('idle');
    } else {
      setPreviewError(result.message);
      setPreviewState('error');
    }
  }

  const copyLabel = copyState === 'loading' ? 'Copying…' : copyState === 'success' ? 'Copied' : 'Copy Analysis Data';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          aria-label="Analysis data scope"
          className="h-9 max-w-[200px] rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-700 outline-none transition focus:border-slate-400 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200"
        >
          <option value="all">All Inventory</option>
          {channels.map((c) => (
            <option key={c.channel_id} value={selectionKey({ scope: 'channel', channelId: c.channel_id })}>
              {c.channel_name}
            </option>
          ))}
          <option value="unlisted">Unlisted Inventory</option>
        </select>

        <button
          type="button"
          onClick={handleCopy}
          disabled={copyState === 'loading'}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-950 px-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600"
        >
          {copyState === 'loading' && (
            <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-slate-900/40 dark:border-t-slate-900" />
          )}
          {copyLabel}
        </button>

        <button
          type="button"
          onClick={handlePreview}
          className="h-9 shrink-0 rounded-lg px-2 text-xs font-medium text-slate-500 underline-offset-2 transition hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
        >
          Preview JSON
        </button>
      </div>

      {copyMessage && (
        <p className={`text-xs ${copyState === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {copyMessage}
        </p>
      )}

      {previewOpen && (
        <PreviewModal
          state={previewState}
          error={previewError}
          packet={previewPacket}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function PreviewModal({
  state,
  error,
  packet,
  onClose,
}: {
  state: PreviewState;
  error: string | null;
  packet: ListingAnalysisPacket | null;
  onClose: () => void;
}) {
  const json = packet ? JSON.stringify(packet, null, 2) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl dark:border-slate-700 dark:bg-slate-800"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Analysis data preview"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <p className="text-sm font-semibold text-slate-900 dark:text-white">Preview JSON</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-lg p-1 text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {state === 'loading' ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading preview…</p>
          ) : state === 'error' ? (
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-xs text-slate-700 dark:text-slate-300">{json}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
