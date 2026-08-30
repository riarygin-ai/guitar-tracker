'use client';

// "Copy Item Context" button for the Inventory Item detail page. Builds a
// plain-text summary of the item (via getText, evaluated at click time so
// it always reflects the latest loaded data) and copies it to the
// clipboard for pasting into an external ChatGPT conversation.

import { useEffect, useRef, useState } from 'react';
import { createItemContextCopier } from '@/lib/itemContextClipboard';

type ButtonState = 'idle' | 'copying' | 'success' | 'error';

const RESET_DELAY_MS = 2200;

export default function CopyItemContextButton({ getText }: { getText: () => string }) {
  const [state, setState] = useState<ButtonState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimerRef.current) clearTimeout(resetTimerRef.current); }, []);

  // Created once per mount; the copier's own in-flight guard (not just the
  // disabled button below) is what actually prevents a second copy from a
  // double click.
  const copierRef = useRef(createItemContextCopier({
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
    if (state === 'copying') return;
    setState('copying');
    setErrorMessage(null);

    const result = await copierRef.current.copy(getText());
    if (!mountedRef.current) return;

    if (result.status === 'already_in_progress') return;

    if (result.status === 'success') {
      setState('success');
    } else {
      setState('error');
      setErrorMessage(result.message);
    }
    scheduleReset();
  }

  const label = state === 'copying' ? 'Copying…' : state === 'success' ? 'Item context copied' : 'Copy Item Context';

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === 'copying'}
        className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        {label}
      </button>
      {state === 'error' && errorMessage && (
        <span className="max-w-[220px] text-xs text-rose-600 dark:text-rose-400">{errorMessage}</span>
      )}
    </div>
  );
}
