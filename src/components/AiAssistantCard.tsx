'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';

type TabId = 'reverb' | 'marketplace' | 'trade';

interface TabState {
  content: string;
  statusMsg: string;
  errorMsg: string;
}

export interface AiAssistantCardProps {
  itemId: number;
  itemLabel: string;
}

const TABS: { id: TabId; label: string; placeholder: string }[] = [
  {
    id:          'reverb',
    label:       'Reverb',
    placeholder: 'Click Generate to create a Reverb.com listing, or write your own...',
  },
  {
    id:          'marketplace',
    label:       'Marketplace',
    placeholder: 'Click Generate to create a Marketplace / Kijiji post, or write your own...',
  },
  {
    id:          'trade',
    label:       'Trade',
    placeholder: 'Click Generate to create a trade post, or write your own...',
  },
];

function statusColor(msg: string): string {
  if (!msg) return 'text-slate-400 dark:text-slate-500';
  if (msg.includes('saved'))     return 'text-emerald-600 dark:text-emerald-400';
  if (msg.includes('Generated')) return 'text-violet-600 dark:text-violet-400';
  return 'text-slate-400 dark:text-slate-500';
}

export default function AiAssistantCard({ itemId, itemLabel }: AiAssistantCardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('reverb');
  const [tabs, setTabs] = useState<Record<TabId, TabState>>({
    reverb:      { content: '', statusMsg: '', errorMsg: '' },
    marketplace: { content: '', statusMsg: '', errorMsg: '' },
    trade:       { content: '', statusMsg: '', errorMsg: '' },
  });
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied]         = useState(false);
  const [draftToast, setDraftToast] = useState(false);

  const current = tabs[activeTab];

  function updateTab(tab: TabId, patch: Partial<TabState>) {
    setTabs((prev) => ({ ...prev, [tab]: { ...prev[tab], ...patch } }));
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleGenerate() {
    setGenerating(true);
    updateTab(activeTab, { errorMsg: '' });

    try {
      // Get the user's current auth token — keeps the API key server-side only
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated — please reload and try again');

      const res = await fetch('/api/ai/generate-listing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          inventoryItemId: itemId,
          listingType:     activeTab,
          // Pass current content as draft context so the model can refine it
          currentDraft: current.content.trim() || undefined,
        }),
      });

      const payload = await res.json();

      if (!res.ok) {
        throw new Error(payload.error ?? `Server error ${res.status}`);
      }

      updateTab(activeTab, {
        content:   payload.text,
        statusMsg: 'Generated just now',
        errorMsg:  '',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      updateTab(activeTab, { errorMsg: msg });
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!current.content) return;
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (non-secure context)
    }
  }

  function handleSaveDraft() {
    updateTab(activeTab, { statusMsg: 'Draft saved', errorMsg: '' });
    setDraftToast(true);
    setTimeout(() => setDraftToast(false), 2500);
  }

  function handleClear() {
    updateTab(activeTab, { content: '', statusMsg: '', errorMsg: '' });
  }

  // ── Shared styles ─────────────────────────────────────────────────────────────
  const secondaryBtn =
    'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">AI Assistant</h3>
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
              Beta
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Generate marketplace listings for{' '}
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {itemLabel || 'this item'}
            </span>
          </p>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 shrink-0 text-violet-300 dark:text-violet-600"
        >
          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
        </svg>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────────── */}
      <div
        className="mt-4 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-700/60"
        role="tablist"
        aria-label="Listing platform"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            {tab.label}
            {/* Dot indicator: tab has content but is not active */}
            {tabs[tab.id].content && activeTab !== tab.id && (
              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-violet-400 align-middle dark:bg-violet-500" />
            )}
          </button>
        ))}
      </div>

      {/* ── Textarea ────────────────────────────────────────────────────────── */}
      <div className="relative mt-4">
        <textarea
          value={current.content}
          onChange={(e) => updateTab(activeTab, { content: e.target.value })}
          placeholder={TABS.find((t) => t.id === activeTab)?.placeholder}
          disabled={generating}
          rows={14}
          aria-label={`${activeTab} listing content`}
          className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-relaxed text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-100 dark:focus:bg-slate-700 dark:focus:ring-slate-600"
          style={{ minHeight: '300px' }}
        />

        {/* Generating overlay */}
        {generating && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/80 backdrop-blur-[2px] dark:bg-slate-800/80">
            <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm dark:border-slate-600 dark:bg-slate-800">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-violet-200 border-t-violet-600 dark:border-violet-800 dark:border-t-violet-400" />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Generating listing...
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Status row ──────────────────────────────────────────────────────── */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={`text-xs ${statusColor(current.statusMsg)}`}>
          {current.statusMsg || 'Never generated'}
        </p>
        {current.content && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {current.content.length.toLocaleString()} chars
          </p>
        )}
      </div>

      {/* ── Error banner ────────────────────────────────────────────────────── */}
      {current.errorMsg && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
          {current.errorMsg}
        </div>
      )}

      {/* ── Action buttons ───────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">

        {/* Generate — primary */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 sm:w-auto sm:py-2 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
        >
          {generating ? (
            <>
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-slate-900/40 dark:border-t-slate-900" />
              Generating...
            </>
          ) : (
            <>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
              </svg>
              Generate
            </>
          )}
        </button>

        {/* Secondary buttons */}
        <div className="flex flex-wrap items-center gap-2">

          {/* Copy */}
          <button
            type="button"
            onClick={handleCopy}
            disabled={!current.content || generating}
            className={secondaryBtn}
          >
            {copied ? (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="text-emerald-600 dark:text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
                Copy
              </>
            )}
          </button>

          {/* Save Draft */}
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={!current.content || generating}
            className={secondaryBtn}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
              <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
              <path d="M7 3v4a1 1 0 0 0 1 1h7" />
            </svg>
            Save Draft
          </button>

          {/* Clear */}
          <button
            type="button"
            onClick={handleClear}
            disabled={!current.content || generating}
            className={secondaryBtn}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
            Clear
          </button>

        </div>
      </div>

      {/* ── Draft saved toast ────────────────────────────────────────────────── */}
      {draftToast && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-300">
          Draft saved for this session.
        </div>
      )}

    </div>
  );
}
