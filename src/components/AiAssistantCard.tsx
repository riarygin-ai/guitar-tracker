'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { getDealChannels, getItemListings, getOrCreateAppUser, upsertItemListing } from '@/lib/supabase';
import { supabase } from '@/lib/supabase';
import type { DealChannel } from '@/types';

// ── State ──────────────────────────────────────────────────────────────────────

interface TabState {
  listingId:     number | null;
  content:       string;
  isAiGenerated: boolean;
  aiPromptId:    number | null;
  listedAt:      string | null;
  savedAt:       string | null;
  isDirty:       boolean;
  lastSavedVia:  'ai' | 'manual' | null;
  errorMsg:      string;
}

const EMPTY_TAB: TabState = {
  listingId:     null,
  content:       '',
  isAiGenerated: false,
  aiPromptId:    null,
  listedAt:      null,
  savedAt:       null,
  isDirty:       false,
  lastSavedVia:  null,
  errorMsg:      '',
};

// ── Debug payload type ─────────────────────────────────────────────────────────

interface DebugPayload {
  model:               string;
  temperature:         number;
  maxTokens:           number;
  channelName:         string;
  channelId:           number;
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

// ── Props / handle ─────────────────────────────────────────────────────────────

export interface AiAssistantCardProps {
  itemId:    number;
  itemLabel: string;
}

export interface AiAssistantCardHandle {
  // Saves every platform tab with unsaved changes (text and/or listing date).
  // Resolves to an error message (platforms joined) if any of them failed —
  // tabs that did save are still marked clean, only the failed ones stay dirty.
  savePending: () => Promise<{ error: string | null }>;
}

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

function formatListedDate(dateStr: string): string {
  try {
    // Date-only string ('YYYY-MM-DD') — parse as local, not UTC midnight.
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-CA', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return dateStr;
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

const AiAssistantCard = forwardRef<AiAssistantCardHandle, AiAssistantCardProps>(
  function AiAssistantCard({ itemId, itemLabel }, ref) {
  const [channels,        setChannels]        = useState<DealChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<number | null>(null);
  const [tabs,            setTabs]            = useState<Record<number, TabState>>({});
  const [loadingDrafts,   setLoadingDrafts]   = useState(true);
  const [generating,      setGenerating]      = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [copied,          setCopied]          = useState(false);
  const [isAdmin,         setIsAdmin]         = useState(false);
  const [debugging,       setDebugging]       = useState(false);
  const [debugPayload,    setDebugPayload]    = useState<DebugPayload | null>(null);
  const [debugPanelOpen,  setDebugPanelOpen]  = useState(true);
  const [debugCopied,     setDebugCopied]     = useState(false);

  const current = activeChannelId !== null ? tabs[activeChannelId] : undefined;

  // ── Load admin flag on mount ───────────────────────────────────────────────

  useEffect(() => {
    getOrCreateAppUser().then((u) => { if (u) setIsAdmin(u.admin); });
  }, []);

  // ── Load channels + existing drafts on mount ───────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [channelRes, listingRes] = await Promise.all([
        getDealChannels(),
        getItemListings(itemId),
      ]);

      if (cancelled) return;

      const platforms = ((channelRes.data ?? []) as DealChannel[]).filter(
        (c) => c.is_listing_platform && c.is_active,
      );
      setChannels(platforms);
      if (platforms.length > 0) setActiveChannelId(platforms[0].id);

      // Initialise one empty tab per channel, then overlay DB rows
      const initialTabs: Record<number, TabState> = {};
      for (const ch of platforms) {
        initialTabs[ch.id] = { ...EMPTY_TAB };
      }

      if (!listingRes.error && listingRes.data) {
        for (const row of listingRes.data) {
          const chId = row.deal_channel_id;
          if (chId in initialTabs) {
            initialTabs[chId] = {
              listingId:     row.id,
              content:       row.description ?? '',
              isAiGenerated: row.is_ai_generated,
              aiPromptId:    row.ai_prompt_id ?? null,
              listedAt:      row.listed_at    ?? null,
              // A row can exist with only a listed_at date and no saved text.
              savedAt:       row.description ? row.updated_at : null,
              isDirty:       false,
              lastSavedVia:  row.description ? (row.is_ai_generated ? 'ai' : 'manual') : null,
              errorMsg:      '',
            };
          }
        }
      }

      setTabs(initialTabs);
      setLoadingDrafts(false);
    }

    load();
    return () => { cancelled = true; };
  }, [itemId]);

  // ── Tab state updater ──────────────────────────────────────────────────────

  function updateTab(id: number, patch: Partial<TabState>) {
    setTabs((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  // ── Upsert helper (shared by generate auto-save and manual Save Draft) ─────

  async function saveToDb(
    channelId:  number,
    listingId:  number | null,
    content:    string,
    isAi:       boolean,
    aiPromptId: number | null,
  ): Promise<{ savedAt: string | null; listingId: number | null; error: string | null }> {
    const { data, error } = await upsertItemListing({
      id:                listingId ?? undefined,
      inventory_item_id: itemId,
      deal_channel_id:   channelId,
      description:       content,
      is_ai_generated:   isAi,
      ai_prompt_id:      aiPromptId ?? undefined,
    });

    if (error) return { savedAt: null, listingId: null, error: error.message };
    return { savedAt: data?.updated_at ?? new Date().toISOString(), listingId: data?.id ?? null, error: null };
  }

  // ── Listing date (local only — persisted via Save Draft / Update item) ─────

  function handleListedAtChange(channelId: number, value: string | null) {
    updateTab(channelId, { listedAt: value, isDirty: true, errorMsg: '' });
  }

  // ── Imperative handle — parent (InventoryForm) saves all pending listings ──

  useImperativeHandle(ref, () => ({
    async savePending() {
      const dirtyEntries = channels
        .map((ch) => ({ ch, tab: tabs[ch.id] }))
        .filter((e): e is { ch: DealChannel; tab: TabState } => !!e.tab?.isDirty);

      if (dirtyEntries.length === 0) return { error: null };

      setSaving(true);
      const updates: Record<number, Partial<TabState>> = {};
      const errors: string[] = [];

      for (const { ch, tab } of dirtyEntries) {
        const trimmedContent = tab.content.trim();

        // Never create a brand-new row that would be entirely empty.
        if (!tab.listingId && !trimmedContent && !tab.listedAt) {
          updates[ch.id] = { isDirty: false, errorMsg: '' };
          continue;
        }

        const { data, error } = await upsertItemListing({
          id:                tab.listingId ?? undefined,
          inventory_item_id: itemId,
          deal_channel_id:   ch.id,
          description:       trimmedContent || null,
          is_ai_generated:   tab.isAiGenerated,
          ai_prompt_id:      tab.aiPromptId ?? undefined,
          listed_at:         tab.listedAt,
        });

        if (error) {
          errors.push(`${ch.name}: ${error.message}`);
          updates[ch.id] = { errorMsg: error.message };
          continue;
        }

        updates[ch.id] = {
          listingId:    data?.id ?? tab.listingId,
          content:      data?.description ?? trimmedContent,
          listedAt:     data?.listed_at ?? tab.listedAt,
          savedAt:      data?.updated_at ?? new Date().toISOString(),
          isDirty:      false,
          lastSavedVia: tab.lastSavedVia ?? 'manual',
          errorMsg:     '',
        };
      }

      setTabs((prev) => {
        const next = { ...prev };
        for (const [id, patch] of Object.entries(updates)) {
          next[Number(id)] = { ...next[Number(id)], ...patch };
        }
        return next;
      });

      setSaving(false);
      return { error: errors.length > 0 ? errors.join('; ') : null };
    },
  }), [channels, tabs, itemId]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleGenerate() {
    if (activeChannelId === null || !current) return;

    setGenerating(true);
    updateTab(activeChannelId, { errorMsg: '' });

    const channelId = activeChannelId; // capture — user might switch tabs mid-flight

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
          dealChannelId:   channelId,
          currentDraft:    tabs[channelId]?.content.trim() || undefined,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? `Server error ${res.status}`);

      const text       = payload.text as string;
      const aiPromptId = (payload.ai_prompt_id as number | null | undefined) ?? null;

      const existingListingId = tabs[channelId]?.listingId ?? null;
      const { savedAt, listingId: newListingId, error: saveError } = await saveToDb(
        channelId, existingListingId, text, true, aiPromptId,
      );

      if (saveError) {
        updateTab(channelId, {
          content:       text,
          isAiGenerated: true,
          aiPromptId,
          isDirty:       true,
          lastSavedVia:  null,
          errorMsg:      `Generated, but auto-save failed: ${saveError}`,
        });
      } else {
        updateTab(channelId, {
          listingId:     newListingId,
          content:       text,
          isAiGenerated: true,
          aiPromptId,
          savedAt:       savedAt!,
          isDirty:       false,
          lastSavedVia:  'ai',
          errorMsg:      '',
        });
      }
    } catch (err) {
      updateTab(activeChannelId, {
        errorMsg: err instanceof Error ? err.message : 'Something went wrong',
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveDraft() {
    if (activeChannelId === null || !current) return;

    const trimmedContent = current.content.trim();
    if (!trimmedContent && !current.listedAt) {
      updateTab(activeChannelId, { errorMsg: 'Add listing text or a listing date before saving.' });
      return;
    }

    setSaving(true);
    updateTab(activeChannelId, { errorMsg: '' });

    const { data, error } = await upsertItemListing({
      id:                current.listingId ?? undefined,
      inventory_item_id: itemId,
      deal_channel_id:   activeChannelId,
      description:       trimmedContent || null,
      is_ai_generated:   current.isAiGenerated,
      ai_prompt_id:      current.aiPromptId ?? undefined,
      listed_at:         current.listedAt,
    });

    setSaving(false);

    if (error) {
      updateTab(activeChannelId, { errorMsg: `Save failed: ${error.message}` });
      return;
    }

    updateTab(activeChannelId, {
      listingId:    data?.id ?? current.listingId,
      content:      data?.description ?? trimmedContent,
      listedAt:     data?.listed_at ?? current.listedAt,
      savedAt:      data?.updated_at ?? new Date().toISOString(),
      isDirty:      false,
      lastSavedVia: 'manual',
      errorMsg:     '',
    });
  }

  async function handleCopy() {
    if (!current?.content) return;
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable in non-secure context
    }
  }

  function handleClear() {
    if (activeChannelId === null || !current) return;
    updateTab(activeChannelId, {
      content:       '',
      isAiGenerated: false,
      isDirty:       current.savedAt !== null,
      errorMsg:      '',
    });
  }

  async function handleDebugPrompt() {
    if (activeChannelId === null) return;

    setDebugging(true);
    setDebugPayload(null);

    const channelId = activeChannelId;

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
          dealChannelId:   channelId,
          currentDraft:    tabs[channelId]?.content.trim() || undefined,
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? `Server error ${res.status}`);

      setDebugPayload(payload as DebugPayload);
      setDebugPanelOpen(true);
    } catch (err) {
      if (activeChannelId !== null) {
        updateTab(activeChannelId, {
          errorMsg: `Debug failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        });
      }
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

  const status      = current ? getStatusDisplay(current) : { label: 'No draft saved', color: 'text-slate-400 dark:text-slate-500' };
  const secondaryBtn =
    'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600';

  const placeholder = loadingDrafts
    ? 'Loading saved drafts...'
    : activeChannelId !== null
      ? `Click Generate below to create a ${channels.find((c) => c.id === activeChannelId)?.name ?? ''} listing, or write your own...`
      : '';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 dark:text-white">Listings</h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Manage platform listing dates and text for{' '}
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {itemLabel || 'this item'}
          </span>
        </p>
      </div>

      {/* ── Tabs (dynamic listing platforms) ──────────────────────────────── */}
      {channels.length > 0 && (
        <div
          className="mt-4 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-700/60"
          role="tablist"
          aria-label="Listing platform"
        >
          {channels.map((ch) => (
            <button
              key={ch.id}
              type="button"
              role="tab"
              aria-selected={activeChannelId === ch.id}
              onClick={() => setActiveChannelId(ch.id)}
              className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
                activeChannelId === ch.id
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {ch.name}
              {tabs[ch.id]?.content && activeChannelId !== ch.id && (
                <span className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                  tabs[ch.id]?.isDirty
                    ? 'bg-amber-400 dark:bg-amber-500'
                    : 'bg-violet-400 dark:bg-violet-500'
                }`} />
              )}
            </button>
          ))}
        </div>
      )}

      {/* ── Per-platform listing status ──────────────────────────────────── */}
      {channels.length > 0 && (
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {channels.map((ch) => {
            const tab      = tabs[ch.id];
            const listedAt = tab?.listedAt ?? null;
            return (
              <div key={ch.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-900 dark:text-white">{ch.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    tab?.content
                      ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                      : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
                  }`}>
                    {tab?.content ? 'Text saved' : 'No text'}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    listedAt
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                  }`}>
                    {listedAt ? `Listed ${formatListedDate(listedAt)}` : 'Not listed'}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <input
                    type="date"
                    value={listedAt ?? ''}
                    onChange={(e) => handleListedAtChange(ch.id, e.target.value || null)}
                    disabled={saving || loadingDrafts}
                    aria-label={`${ch.name} listing date`}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:focus:ring-slate-600"
                  />
                  {listedAt && (
                    <button
                      type="button"
                      onClick={() => handleListedAtChange(ch.id, null)}
                      disabled={saving || loadingDrafts}
                      className="text-xs font-medium text-slate-400 transition hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-500 dark:hover:text-slate-300"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Textarea ──────────────────────────────────────────────────────── */}
      <div className="relative mt-4">
        <textarea
          value={current?.content ?? ''}
          onChange={(e) => { if (activeChannelId !== null) updateTab(activeChannelId, { content: e.target.value, isDirty: true }); }}
          placeholder={placeholder}
          disabled={generating || saving || loadingDrafts || activeChannelId === null}
          rows={14}
          aria-label={`${channels.find((c) => c.id === activeChannelId)?.name ?? ''} listing content`}
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

        {/* Saving overlay */}
        {saving && !generating && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/70 backdrop-blur-[2px] dark:bg-slate-800/70">
            <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm dark:border-slate-600 dark:bg-slate-800">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600 dark:border-emerald-800 dark:border-t-emerald-400" />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                Saving...
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Status + char count ────────────────────────────────────────────── */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={`text-xs ${status.color}`}>{status.label}</p>
        {current?.content && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {current.content.length.toLocaleString()} chars
          </p>
        )}
      </div>

      {/* ── Error banner ──────────────────────────────────────────────────── */}
      {current?.errorMsg && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
          {current.errorMsg}
        </div>
      )}

      {/* ── Regular listing actions ─────────────────────────────────────────── */}
      <div className="mt-4 flex flex-wrap items-center gap-2">

        {/* Save Draft */}
        <button
          type="button"
          onClick={handleSaveDraft}
          disabled={saving || generating || loadingDrafts || !current?.isDirty}
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

        {/* Copy */}
        <button
          type="button"
          onClick={handleCopy}
          disabled={!current?.content || generating || saving}
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

        {/* Clear */}
        <button
          type="button"
          onClick={handleClear}
          disabled={!current?.content || generating || saving}
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

      {/* ── AI Assistant subsection ─────────────────────────────────────────── */}
      <div className="mt-6 border-t border-slate-100 pt-4 dark:border-slate-700">
        <div className="flex items-center gap-2.5">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-white">AI Assistant</h4>
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
            Beta
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">

          {/* Generate */}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || saving || loadingDrafts || activeChannelId === null}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
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

          {/* Debug Prompt — admin only */}
          {isAdmin && (
            <button
              type="button"
              onClick={handleDebugPrompt}
              disabled={debugging || generating || saving || loadingDrafts || activeChannelId === null}
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

        {/* ── AI Debug Panel ──────────────────────────────────────────────── */}
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
                  {debugPayload.channelName}
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

    </div>
  );
  },
);

export default AiAssistantCard;
