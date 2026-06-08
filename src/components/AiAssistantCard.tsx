'use client';

import { useState } from 'react';

type TabId = 'reverb' | 'marketplace' | 'trade';

interface TabState {
  content: string;
  statusMsg: string;
}

export interface AiAssistantCardProps {
  itemLabel: string;
  condition?: string | null;
  year?: number | null;
  color?: string | null;
  estimatedValue?: number | null;
}

const TABS: { id: TabId; label: string; placeholder: string }[] = [
  { id: 'reverb',      label: 'Reverb',      placeholder: 'Write or generate a Reverb.com listing for this item...' },
  { id: 'marketplace', label: 'Marketplace', placeholder: 'Write or generate a Marketplace / Kijiji post for this item...' },
  { id: 'trade',       label: 'Trade',       placeholder: 'Write or generate a trade post for this item...' },
];

// ── Placeholder content builder (replace body with real API call later) ────────
function buildPlaceholder(
  tab: TabId,
  itemLabel: string,
  condition?: string | null,
  year?: number | null,
  color?: string | null,
  estimatedValue?: number | null,
): string {
  const yr    = year  ? `${year} ` : '';
  const col   = color ? ` in ${color}` : '';
  const cond  = condition ?? 'Very Good';
  const price = estimatedValue ? `$${estimatedValue.toLocaleString()}` : null;

  switch (tab) {
    case 'reverb':
      return [
        `Up for sale is a ${cond.toLowerCase()} condition ${yr}${itemLabel}${col}.`,
        '',
        `This is a fantastic instrument that plays and sounds amazing. The neck is comfortable, the action is dialed in, and all electronics are fully functional with no issues.`,
        '',
        `Cosmetically it shows typical signs of play wear consistent with the condition rating — nothing that affects playability or tone.`,
        '',
        price
          ? `Asking ${price}. Priced fairly for the condition — open to reasonable offers.`
          : 'Priced to sell — open to reasonable offers.',
        '',
        `Ships safely in original case/gig bag. Feel free to message with any questions!`,
      ].join('\n');

    case 'marketplace':
      return [
        `SELLING — ${yr}${itemLabel}${col}`,
        '',
        `Condition: ${cond}`,
        price ? `Price: ${price} (firm)` : 'Price: Make an offer',
        '',
        `Up for sale is my ${yr}${itemLabel}${col}. In ${cond.toLowerCase()} condition and sounds incredible. Great for gigging, recording, or adding to your collection.`,
        '',
        `Can meet locally or ship at buyer's expense. Serious inquiries only — no low-ball offers.`,
        '',
        `Comment below or send a DM if interested.`,
      ].join('\n');

    case 'trade':
      return [
        `TRADE — ${yr}${itemLabel}${col}`,
        '',
        `Looking to trade my ${yr}${itemLabel}${col}.`,
        `Condition: ${cond} — no cracks, no repairs, all original.`,
        '',
        `Open to:`,
        `• Quality guitars of similar value`,
        `• Amps or combo amp`,
        `• Boutique pedals or effects`,
        `• Cash + trade combos`,
        '',
        price ? `Current value: ${price}` : '',
        '',
        `Not looking for anything specific — open to interesting offers. DM with photos and your offer.`,
      ].filter((l) => l !== null).join('\n');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusColor(msg: string): string {
  if (!msg) return 'text-slate-400 dark:text-slate-500';
  if (msg.includes('saved'))     return 'text-emerald-600 dark:text-emerald-400';
  if (msg.includes('Generated')) return 'text-violet-600 dark:text-violet-400';
  return 'text-slate-400 dark:text-slate-500';
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function AiAssistantCard({
  itemLabel,
  condition,
  year,
  color,
  estimatedValue,
}: AiAssistantCardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('reverb');
  const [tabs, setTabs] = useState<Record<TabId, TabState>>({
    reverb:      { content: '', statusMsg: '' },
    marketplace: { content: '', statusMsg: '' },
    trade:       { content: '', statusMsg: '' },
  });
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied]         = useState(false);
  const [draftToast, setDraftToast] = useState(false);

  const current = tabs[activeTab];

  function updateTab(tab: TabId, patch: Partial<TabState>) {
    setTabs((prev) => ({ ...prev, [tab]: { ...prev[tab], ...patch } }));
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  async function handleGenerate() {
    setGenerating(true);
    // Simulated latency — swap this block for a real API call when ready:
    // const { text } = await openai.chat(...)
    await new Promise((r) => setTimeout(r, 650));
    const content = buildPlaceholder(activeTab, itemLabel, condition, year, color, estimatedValue);
    updateTab(activeTab, { content, statusMsg: 'Generated just now' });
    setGenerating(false);
  }

  async function handleCopy() {
    if (!current.content) return;
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in non-secure context — silently ignore
    }
  }

  function handleSaveDraft() {
    updateTab(activeTab, { statusMsg: 'Draft saved' });
    setDraftToast(true);
    setTimeout(() => setDraftToast(false), 2500);
  }

  function handleClear() {
    updateTab(activeTab, { content: '', statusMsg: '' });
  }

  // ── Shared class strings ─────────────────────────────────────────────────────
  const secondaryBtn =
    'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
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
        {/* Sparkle icon */}
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

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
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
            {/* Dot indicator if this tab has content */}
            {tabs[tab.id].content && activeTab !== tab.id && (
              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-violet-400 align-middle dark:bg-violet-500" />
            )}
          </button>
        ))}
      </div>

      {/* ── Textarea ───────────────────────────────────────────────────────── */}
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

      {/* ── Status row ─────────────────────────────────────────────────────── */}
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

      {/* ── Action buttons ─────────────────────────────────────────────────── */}
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

      {/* ── Draft saved toast ───────────────────────────────────────────────── */}
      {draftToast && (
        <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-900/20 dark:text-emerald-300">
          Draft saved for this session.
        </div>
      )}

    </div>
  );
}
