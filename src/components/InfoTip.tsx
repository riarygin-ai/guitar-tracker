'use client';

// Small accessible "ⓘ" help control. Works by hover (desktop), keyboard
// focus, and tap/click (mobile — never hover-only). The bubble is
// position:fixed and clamped to the viewport so it is never clipped by an
// overflow-x-auto table wrapper or pushed off a narrow screen.

import { useCallback, useEffect, useId, useRef, useState } from 'react';

const BUBBLE_WIDTH = 256;
const EDGE = 8;

export default function InfoTip({ label, text }: { label: string; text: string }) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({ left: EDGE, top: 0, width: BUBBLE_WIDTH });

  const place = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const width = Math.min(BUBBLE_WIDTH, vw - EDGE * 2);
    const left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - width / 2, vw - width - EDGE));
    setPos({ left, top: rect.bottom + 6, width });
  }, []);

  const show = () => { place(); setOpen(true); };
  const hide = () => { setOpen(false); setPinned(false); };

  // Flip above the trigger when the bubble would run off the bottom.
  useEffect(() => {
    if (!open) return;
    const btn = buttonRef.current;
    const bubble = bubbleRef.current;
    if (!btn || !bubble) return;
    const rect = btn.getBoundingClientRect();
    const h = bubble.offsetHeight;
    if (rect.bottom + 6 + h > window.innerHeight - EDGE && rect.top - 6 - h > EDGE) {
      setPos((p) => ({ ...p, top: rect.top - 6 - h }));
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || bubbleRef.current?.contains(t)) return;
      hide();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open]);

  return (
    <span className="inline-flex align-middle">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={() => { if (!pinned) setOpen(false); }}
        onFocus={show}
        onBlur={() => { if (!pinned) setOpen(false); }}
        onClick={() => {
          if (pinned) { hide(); } else { show(); setPinned(true); }
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-slate-500 dark:hover:text-slate-300"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open && (
        <span
          ref={bubbleRef}
          id={id}
          role="tooltip"
          style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width }}
          className="z-50 rounded-xl border border-slate-200 bg-white p-3 text-left text-xs font-normal normal-case leading-snug tracking-normal text-slate-700 shadow-lg dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
        >
          {text}
        </span>
      )}
    </span>
  );
}
