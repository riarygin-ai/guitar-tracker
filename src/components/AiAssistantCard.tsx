'use client';

import { useEffect, useState } from 'react';
import { getItemListings, getOrCreateAppUser, upsertItemListing } from '@/lib/supabase';
import { supabase } from '@/lib/supabase';
import type { ListingType } from '@/types';

// ── State ──────────────────────────────────────────────────────────────────────

interface TabState {
  content:        string;
  isAiGenerated:  boolean;
  aiModel:        string | null;
  aiPromptId:     number | null;
  promptSnapshot: string | null;
  savedAt:        string | null;
  // Tracks whether in-memory content differs from what's in the DB.
  // false on load, false after any successful save, true on every edit/clear.
  isDirty:        boolean;
  // Determines the wording of the saved status line.
  lastSavedVia:   'ai' | 'manual' | null;
  errorMsg:       string;
}

const EMPTY_TAB: TabState = {
  content:        '',
  isAiGenerated:  false,
  aiModel:        null,
  aiPromptId:     null,
  promptSnapshot: null,
  savedAt:        null,
  isDirty:        false,
  lastSavedVia:   null,
  errorMsg:       '',
};

// ── Debug payload type ─────────────────────────────────────────────────────────

interface DebugPayload {
  model:               string;
  temperature:         number;
  maxTokens:           number;
  listingType:         string;
  category:            string;
  detectedCategory:    string;
  aiPromptId:          number | null;
  promptName:          string | null;
  systemMessage:       string;
  itemDataBlock:       string;
  taskPrompt:          string;
  existingDraft:       string | null;
  finalUserMessage:    string;
  fullMessagesPayload: Array<{ role: string; content: unknown }>;
  photoCount:          number;
  photoUrls:           string[];
}

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
  const [loadingDrafts,  setLoadingDrafts]  = useState(true);
  const [generating,     setGenerating]     = useState(false);
  const [saving,         setSaving]         = useState(false);
  const [copied,         setCopied]         = useState(false);
  const [isAdmin,        setIsAdmin]        = useState(false);
  const [debugging,      setDebugging]      = useState(false);
  const [debugPayload,   setDebugPayload]   = useState<DebugPayload | null>(null);
  const [debugPanelOpen, setDebugPanelOpen] = useState(true);
  const [debugCopied,    setDebugCopied]    = useState(false);

  const current = tabs[activeTab];

  // ── Load admin flag on mount ───────────────────────────────────────────────

  useEffect(() => {
    getOrCreateAppUser().then((u) => { if (u) setIsAdmin(u.admin); });
  }, []);

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
                content:        row.description,
                isAiGenerated:  row.is_ai_generated,
                aiModel:        row.ai_model        ?? null,
                aiPromptId:     row.ai_prompt_id    ?? null,
                promptSnapshot: row.prompt_snapshot ?? null,
                savedAt:        row.updated_at,
                isDirty:        false,
                lastSavedVia:   row.is_ai_generated ? 'ai' : 'manual',
                errorMsg:       '',
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
    tab:            ListingType,
    content:        string,
    isAi:           boolean,
    aiModel:        string | null,
    aiPromptId:     number | null,
    promptSnapshot: string | null,
  ): Promise<{ savedAt: string | null; error: string | null }> {
    const { data, error } = await upsertItemListing({
      inventory_item_id: itemId,
      listing_type:      tab,
      description:       content,
      status:            'draft',
      is_ai_generated:   isAi,
      ai_model:          aiModel        ?? undefined,
      ai_prompt_id:      aiPromptId     ?? undefined,
      prompt_snapshot:   promptSnapshot ?? undefined,
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

      const text           = payload.text as string;
      const aiModel        = (payload.ai_model     as string | null | undefined) ?? null;
      const aiPromptId     = (payload.ai_prompt_id as number | null | undefined) ?? null;
      const promptSnapshot = (payload.prompt_snapshot as string | null | undefined) ?? null;

      // Auto-save the AI response immediately
      const { savedAt, error: saveError } = await saveToDb(tab, text, true, aiModel, aiPromptId, promptSnapshot);

      if (saveError) {
        // Generated but auto-save failed — mark dirty so Save Draft is available
        updateTab(tab, {
          content:        text,
          isAiGenerated:  true,
          aiModel,
          aiPromptId,
          promptSnapshot,
          isDirty:        true,
          lastSavedVia:   null,
          errorMsg:       `Generated, but auto-save failed: ${saveError}`,
        });
      } else {
        updateTab(tab, {
          content:        text,
          isAiGenerated:  true,
          aiModel,
          aiPromptId,
          promptSnapshot,
          savedAt:        savedAt!,
          isDirty:        false,
          lastSavedVia:   'ai',
          errorMsg:       '',
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
      current.aiPromptId,
      current.promptSnapshot,
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

  async function handleDebugPrompt() {
    setDebugging(true);
    setDebugPayload(null);

    const tab = activeTab;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');

      const res = await fetch('/api/ai/debug-prompt', {
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

      setDebugPayload(payload as DebugPayload);
      setDebugPanelOpen(true);
    } catch (err) {
      updateTab(activeTab, {
        errorMsg: `Debug failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setDebugging(false);
    }
  }

  async function handleCopyDebug() {
    if (!debugPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(debugPayload, null, 2));
      setDebugCopied(true);
      setTimeout(() => setDebugCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
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

          {/* Debug Prompt — admin only */}
          {isAdmin && (
            <button
              type="button"
              onClick={handleDebugPrompt}
              disabled={debugging || generating || saving || loadingDrafts}
              className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300 dark:hover:bg-amber-900/40"
            >
              {debugging ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-amber-300 border-t-amber-700 dark:border-amber-700 dark:border-t-amber-300" />
                  Inspecting...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                    <path d="M12 8v4" />
                    <path d="M12 16h.01" />
                  </svg>
                  Debug Prompt
                </>
              )}
            </button>
          )}

        </div>
      </div>

      {/* ── AI Debug Panel ────────────────────────────────────────────────── */}
      {isAdmin && debugPayload && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-800/40 dark:bg-amber-900/10">

          {/* Panel header / toggle */}
          <button
            type="button"
            onClick={() => setDebugPanelOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-amber-900 dark:text-amber-200">AI Debug</span>
              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-800/50 dark:text-amber-200">
                {debugPayload.listingType}
              </span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                {debugPayload.category}{debugPayload.detectedCategory !== debugPayload.category ? ` (detected: ${debugPayload.detectedCategory})` : ''}
              </span>
              {debugPayload.promptName && (
                <span className="text-xs text-amber-700 dark:text-amber-400">
                  prompt: <span className="font-medium">{debugPayload.promptName}</span>
                </span>
              )}
              {debugPayload.aiPromptId === null && (
                <span className="text-xs text-slate-500 dark:text-slate-400 italic">fallback (no DB prompt)</span>
              )}
            </div>
            <svg
              xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`shrink-0 text-amber-600 transition-transform dark:text-amber-400 ${debugPanelOpen ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {debugPanelOpen && (
            <div className="border-t border-amber-200 px-4 pb-4 dark:border-amber-800/40">

              {/* Meta row */}
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                {[
                  ['model',       debugPayload.model],
                  ['temperature', String(debugPayload.temperature)],
                  ['maxTokens',   String(debugPayload.maxTokens)],
                  ['promptId',    debugPayload.aiPromptId != null ? String(debugPayload.aiPromptId) : 'none (fallback)'],
                ].map(([k, v]) => (
                  <span key={k}>
                    <span className="font-medium text-slate-500 dark:text-slate-500">{k}:</span>{' '}
                    <code className="font-mono text-slate-800 dark:text-slate-200">{v}</code>
                  </span>
                ))}
              </div>

              {/* Photos */}
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">
                  Photos sent to vision
                  <span className="ml-2 font-normal normal-case text-slate-500 dark:text-slate-400">
                    {debugPayload.photoCount === 0 ? '(none)' : `${debugPayload.photoCount} photo${debugPayload.photoCount > 1 ? 's' : ''}`}
                  </span>
                </p>
                {debugPayload.photoUrls.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {debugPayload.photoUrls.map((url, i) => (
                      <a
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-slate-700"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                      </a>
                    ))}
                  </div>
                )}
              </div>

              {/* System message */}
              <div className="mt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">System message</p>
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
                  {debugPayload.systemMessage}
                </pre>
              </div>

              {/* Item data block */}
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">Item data block</p>
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
                  {debugPayload.itemDataBlock}
                </pre>
              </div>

              {/* Task prompt */}
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">Task prompt</p>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
                  {debugPayload.taskPrompt}
                </pre>
              </div>

              {/* Existing draft */}
              {debugPayload.existingDraft && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">Existing draft (included)</p>
                  <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
                    {debugPayload.existingDraft}
                  </pre>
                </div>
              )}

              {/* Final user message */}
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">Final user message</p>
                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
                  {debugPayload.finalUserMessage}
                </pre>
              </div>

              {/* Full messages JSON */}
              <div className="mt-3">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-400">Full messages payload (JSON)</p>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 px-3 py-2.5 text-xs leading-relaxed text-slate-100 dark:bg-slate-950">
                  {JSON.stringify(debugPayload.fullMessagesPayload, null, 2)}
                </pre>
              </div>

              {/* Copy button */}
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleCopyDebug}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-50 dark:border-amber-700/60 dark:bg-slate-800 dark:text-amber-300 dark:hover:bg-slate-700"
                >
                  {debugCopied ? (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span className="text-emerald-600 dark:text-emerald-400">Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                      </svg>
                      Copy Debug Payload
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
