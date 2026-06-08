'use client';

import { useEffect, useState } from 'react';
import { getItemListings, upsertItemListing } from '@/lib/supabase';
import { supabase } from '@/lib/supabase';
import type { ListingType } from '@/types';

// ── State ──────────────────────────────────────────────────────────────────────

interface TabState {
  content:       string;
  isAiGenerated: boolean;
  aiModel:       string | null;
  savedAt:       string | null;
  // Tracks whether in-memory content differs from what's in the DB.
  // false on load, false after any successful save, true on every edit/clear.
  isDirty:       boolean;
  // Determines the wording of the saved status line.
  lastSavedVia:  'ai' | 'manual' | null;
  errorMsg:      string;
}

const EMPTY_TAB: TabState = {
  content:      '',
  isAiGenerated: false,
  aiModel:      null,
  savedAt:      null,
  isDirty:      false,
  lastSavedVia: null,
  errorMsg:     '',
};

// ── Props ──────────────────────────────────────────────────────────────────────

export interface AiAssistantCardProps {
  itemId:    number;
  itemLabel: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TABS: { id: ListingType; label: string; placeholder: string }[] = [
  {
    id:          'reverb',
    label:       'Reverb',
    placeholder: 'Click Generate to create a Reverb.com listing, or write your own...',
  },
  {
    id:          'marketplace',
    label:       'Marketplace',
    placeholder: 'Click Generate to create a Facebook Marketplace post, or write your own...',
  },
  {
    id:          'kijiji',
    label:       'Kijiji',
    placeholder: 'Click Generate to create a Kijiji ad, or write your own...',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatSavedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-CA', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function getStatusDisplay(tab: TabState): { label: string; color: string } {
  if (tab.isDirty) {
    return {
      label: 'Unsaved changes',
      color: 'text-amber-600 dark:text-amber-400',
    };
  }
  if (tab.savedAt) {
    const when   = formatSavedAt(tab.savedAt);
    const prefix = tab.lastSavedVia === 'ai' ? 'Generated and saved' : 'Saved';
    return {
      label: when ? `${prefix} ${when}` : prefix,
      color: 'text-emerald-600 dark:text-emerald-400',
    };
  }
  return {
    label: 'No draft saved',
    color: 'text-slate-400 dark:text-slate-500',
  };
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AiAssistantCard({ itemId, itemLabel }: AiAssistantCardProps) {
  const [activeTab,     setActiveTab]     = useState<ListingType>('reverb');
  const [tabs,          setTabs]          = useState<Record<ListingType, TabState>>({
    reverb:      { ...EMPTY_TAB },
    marketplace: { ...EMPTY_TAB },
    kijiji:      { ...EMPTY_TAB },
  });
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [generating,    setGenerating]    = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [copied,        setCopied]        = useState(false);

  const current = tabs[activeTab];

  // ── Load existing drafts on mount ──────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data, error } = await getItemListings(itemId);

      if (cancelled) return;

      if (!error && data) {
        setTabs((prev) => {
          const next = { ...prev };
          for (const row of data) {
            const id = row.listing_type as ListingType;
            if (id in next) {
              next[id] = {
                content:       row.description,
                isAiGenerated: row.is_ai_generated,
                aiModel:       row.ai_model ?? null,
                savedAt:       row.updated_at,
                isDirty:       false,
                lastSavedVia:  row.is_ai_generated ? 'ai' : 'manual',
                errorMsg:      '',
              };
            }
          }
          return next;
        });
      }

      setLoadingDrafts(false);
    }

    load();
    return () => { cancelled = true; };
  }, [itemId]);

  // ── Tab state updater ──────────────────────────────────────────────────────

  function updateTab(id: ListingType, patch: Partial<TabState>) {
    setTabs((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  // ── Upsert helper (shared by generate auto-save and manual Save Draft) ─────

  async function saveToDb(
    tab:      ListingType,
    content:  string,
    isAi:     boolean,
    aiModel:  string | null,
  ): Promise<{ savedAt: string | null; error: string | null }> {
    const { data, error } = await upsertItemListing({
      inventory_item_id: itemId,
      listing_type:      tab,
      description:       content,
      status:            'draft',
      is_ai_generated:   isAi,
      ai_model:          aiModel ?? undefined,
      prompt_version:    'v1',
    });

    if (error) return { savedAt: null, error: error.message };
    return { savedAt: data?.updated_at ?? new Date().toISOString(), error: null };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleGenerate() {
    setGenerating(true);
    updateTab(activeTab, { errorMsg: '' });

    const tab = activeTab; // capture — user might switch tabs mid-flight

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Not authenticated — please reload and try again');
      }

      const res = await fetch('/api/ai/generate-listing', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          inventoryItemId: itemId,
          listingType:     tab,
          currentDraft:    tabs[tab].content.trim() || undefined,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? `Server error ${res.status}`);

      const text    = payload.text as string;
      const aiModel = (payload.ai_model as string | null | undefined) ?? null;

      // Auto-save the AI response immediately
      const { savedAt, error: saveError } = await saveToDb(tab, text, true, aiModel);

      if (saveError) {
        // Generated but auto-save failed — mark dirty so Save Draft is available
        updateTab(tab, {
          content:       text,
          isAiGenerated: true,
          aiModel,
          isDirty:       true,
          lastSavedVia:  null,
          errorMsg:      `Generated, but auto-save failed: ${saveError}`,
        });
      } else {
        updateTab(tab, {
          content:       text,
          isAiGenerated: true,
          aiModel,
          savedAt:       savedAt!,
          isDirty:       false,
          lastSavedVia:  'ai',
          errorMsg:      '',
        });
      }
    } catch (err) {
      updateTab(tab, {
        errorMsg: err instanceof Error ? err.message : 'Something went wrong',
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveDraft() {
    if (!current.content.trim()) {
      updateTab(activeTab, { errorMsg: 'Cannot save an empty draft.' });
      return;
    }

    setSaving(true);
    updateTab(activeTab, { errorMsg: '' });

    const { savedAt, error } = await saveToDb(
      activeTab,
      current.content.trim(),
      current.isAiGenerated,
      current.aiModel,
    );

    setSaving(false);

    if (error) {
      updateTab(activeTab, { errorMsg: `Save failed: ${error}` });
      return;
    }

    updateTab(activeTab, {
      savedAt:      savedAt!,
      isDirty:      false,
      lastSavedVia: 'manual',
      errorMsg:     '',
    });
  }

  async function handleCopy() {
    if (!current.content) return;
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in non-secure context
    }
  }

  function handleClear() {
    updateTab(activeTab, {
      content:       '',
      isAiGenerated: false,
      aiModel:       null,
      // Dirty only if the DB still has a row — user cleared local content but DB differs
      isDirty:       current.savedAt !== null,
      errorMsg:      '',
    });
  }

  // ── Derived UI state ───────────────────────────────────────────────────────

  const status      = getStatusDisplay(current);
  const secondaryBtn =
    'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">

      {/* ── Header ────────────────────────────────────────────────────────── */}
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
          width="18" height="18" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
          className="mt-0.5 shrink-0 text-violet-300 dark:text-violet-600"
        >
          <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
        </svg>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
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
            {/* Dot: tab has content and is not the active view */}
            {tabs[tab.id].content && activeTab !== tab.id && (
              <span className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                tabs[tab.id].isDirty
                  ? 'bg-amber-400 dark:bg-amber-500'
                  : 'bg-violet-400 dark:bg-violet-500'
              }`} />
            )}
          </button>
        ))}
      </div>

      {/* ── Textarea ──────────────────────────────────────────────────────── */}
      <div className="relative mt-4">
        <textarea
          value={current.content}
          onChange={(e) => updateTab(activeTab, { content: e.target.value, isDirty: true })}
          placeholder={
            loadingDrafts
              ? 'Loading saved drafts...'
              : TABS.find((t) => t.id === activeTab)?.placeholder
          }
          disabled={generating || saving || loadingDrafts}
          rows={14}
          aria-label={`${activeTab} listing content`}
          className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm leading-relaxed text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-100 dark:focus:bg-slate-700 dark:focus:ring-slate-600"
          style={{ minHeight: '300px' }}
        />

        {/* Generating overlay (covers generate + auto-save) */}
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

        {/* Saving overlay (manual Save Draft only) */}
        {saving && !generating && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/70 backdrop-blur-[2px] dark:bg-slate-800/70">
            <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm dark:border-slate-600 dark:bg-slate-800">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600 dark:border-emerald-800 dark:border-t-emerald-400" />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Saving draft...
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Status + char count ────────────────────────────────────────────── */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={`text-xs ${status.color}`}>{status.label}</p>
        {current.content && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {current.content.length.toLocaleString()} chars
          </p>
        )}
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────── */}
      {current.errorMsg && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
          {current.errorMsg}
        </div>
      )}

      {/* ── Buttons ───────────────────────────────────────────────────────── */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">

        {/* Generate — primary */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating || saving || loadingDrafts}
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

          {/* Save Draft — enabled only when there is something unsaved */}
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving || generating || loadingDrafts || !current.isDirty}
            className={secondaryBtn}
          >
            {saving ? (
              <>
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700 dark:border-slate-600 dark:border-t-slate-200" />
                Saving...
              </>
            ) : (
              <>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                  <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
                  <path d="M7 3v4a1 1 0 0 0 1 1h7" />
                </svg>
                Save Draft
              </>
            )}
          </button>

          {/* Copy — never saves, just copies */}
          <button
            type="button"
            onClick={handleCopy}
            disabled={!current.content || generating || saving}
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

          {/* Clear — clears textarea only, does not touch DB */}
          <button
            type="button"
            onClick={handleClear}
            disabled={!current.content || generating || saving}
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

    </div>
  );
}
