'use client';

// A small, single-purpose "Copy Analysis" button for one fixed scope (used
// inside an expanded channel card or the Unlisted Inventory section) — the
// full scope-picker control lives in CopyAnalysisDataControl at the top of
// the page. Shares the same core copier lib (src/lib/analysisPacketClipboard.ts),
// so both controls hit the exact same authenticated endpoint the exact same way.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  createAnalysisPacketCopier,
  type AnalysisPacketScopeSelection,
} from '@/lib/analysisPacketClipboard';
import { formatPacketConfirmationMessage } from '@/lib/analytics/listingAnalysisPacket';

const RESET_DELAY_MS = 3200;

export default function CopyAnalysisScopeButton({
  selection,
  label = 'Copy Analysis',
}: {
  selection: AnalysisPacketScopeSelection;
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  const copierRef = useRef(createAnalysisPacketCopier({
    getAccessToken: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      return session?.access_token ?? null;
    },
    fetchImpl: (input, init) => fetch(input, init),
    writeText: async (text) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(text);
    },
  }));

  async function handleClick() {
    if (state === 'loading') return;
    setState('loading');
    setMessage(null);

    const result = await copierRef.current.copy(selection);
    if (!mountedRef.current) return;
    if (result.status === 'already_in_progress') return;

    if (result.status === 'success') {
      setState('success');
      setMessage(formatPacketConfirmationMessage(result.packet));
    } else {
      setState('error');
      setMessage(result.message);
    }
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setState('idle');
      setMessage(null);
    }, RESET_DELAY_MS);
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'loading'}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
      >
        {state === 'loading' && (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400/40 border-t-slate-500 dark:border-slate-300/30 dark:border-t-slate-300" />
        )}
        {state === 'loading' ? 'Copying…' : state === 'success' ? 'Copied' : label}
      </button>
      {message && (
        <span className={`max-w-[240px] text-[11px] ${state === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500 dark:text-slate-400'}`}>
          {message}
        </span>
      )}
    </div>
  );
}
