'use client';

// Temporary/internal tooling for reviewing real Listing Evidence v1.0
// output before the Listing Dashboard is built. Reuses the exact same
// auth pattern as the "Run Analytics" button on this page (src/app/
// analytics/page.tsx): resolve the current Supabase session at click
// time, send its access token as a Bearer header, never accept/derive a
// user id client-side. GET /api/listing-evidence resolves the target user
// from that token server-side — unchanged by this component.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { createListingEvidenceCopier, type CopyListingEvidenceResult } from '@/lib/listingEvidenceClipboard';

type ButtonState = 'idle' | 'loading' | 'success' | 'error';

const RESET_DELAY_MS = 2200;

export default function CopyListingEvidenceButton() {
  const [state, setState] = useState<ButtonState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  // Created once per mount; the copier's own in-flight guard (not just the
  // disabled button below) is what actually prevents a second request from
  // a double click, so it must persist across renders rather than being
  // recreated on every one.
  const copierRef = useRef(createListingEvidenceCopier({
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

  function scheduleReset() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      setState('idle');
      setErrorMessage(null);
    }, RESET_DELAY_MS);
  }

  async function handleClick() {
    if (state === 'loading') return;

    setState('loading');
    setErrorMessage(null);

    const result: CopyListingEvidenceResult = await copierRef.current.copy();
    if (!mountedRef.current) return;

    if (result.status === 'already_in_progress') {
      // A second click landed while the first was still in flight — the
      // first click's own handler owns the state transition, so this one
      // does nothing further.
      return;
    }

    if (result.status === 'success') {
      setState('success');
      scheduleReset();
      return;
    }

    setState('error');
    setErrorMessage(result.message);
    scheduleReset();
  }

  const label = state === 'loading' ? 'Copying…' : state === 'success' ? 'Copied' : 'Copy Listing Evidence JSON';

  return (
    <div className="flex max-w-full flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'loading'}
        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
      >
        {state === 'loading' && (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-400/40 border-t-slate-500 dark:border-slate-300/30 dark:border-t-slate-300" />
        )}
        {label}
      </button>
      {state === 'error' && errorMessage && (
        <span className="max-w-[220px] text-right text-[11px] text-rose-600 dark:text-rose-400">{errorMessage}</span>
      )}
    </div>
  );
}
