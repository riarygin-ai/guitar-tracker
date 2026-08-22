'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import {
  getDealChannels,
  getItemListings,
  getOrCreateAppUser,
  saveListingDraftText,
  startListing,
  endListing,
  cancelListing,
  updateListingPrice,
} from '@/lib/supabase';
import { supabase } from '@/lib/supabase';
import type { DealChannel, ItemListing } from '@/types';

// ── State ──────────────────────────────────────────────────────────────────────
// Multiple listing cycles are supported per (item, platform) — history is
// never deleted (see 20260828000000_item_listings_lifecycle.sql). Each
// channel's state below is derived from getItemListings' full row list:
// `currentRow` is the single non-terminal (draft/active) row, if any — the
// row text edits and Start Listing both act on; `lastTerminalRow` is the
// most recently ended/cancelled row, shown for context only when there is
// no current row. `lastEndedAt` is separate from both: it is the latest
// ended_at among ALL 'ended' rows for this channel (never 'cancelled',
// never 'draft'), independent of whether there's a current row — so the
// "previous listing cycle" note can show even while a new cycle is active,
// and even when the most recent terminal row is a cancellation that came
// after a real ended cycle.

interface ChannelState {
  currentRow:      ItemListing | null;
  lastTerminalRow: ItemListing | null;
  lastEndedAt:     string | null;

  // Text/draft editing (bound to currentRow — empty/fresh once currentRow
  // is null, e.g. right after a listing ends).
  content:       string;
  isAiGenerated: boolean;
  aiPromptId:    number | null;
  savedAt:       string | null;
  isDirty:       boolean;
  lastSavedVia:  'ai' | 'manual' | null;
  errorMsg:      string;

  // Platform status row — Start/End date pickers, action busy/error state,
  // confirmation dialogs. Entirely independent of the text-editing fields
  // above so switching text tabs never affects it and vice versa.
  startDateInput:    string;
  endDateInput:      string;
  listingActionBusy: boolean;
  listingActionError: string;
  confirmEnd:        boolean;
  confirmCancel:     boolean;

  // Listed/asking price — a raw string input (not a number) so the field
  // can be legitimately empty; bound to currentRow.asking_price the same
  // way the text/draft fields above are bound to currentRow.description.
  // Independent busy/error/success state from listingActionBusy/Error so
  // "Update Price" and "Start Listing"/"End Listing"/"Cancel" never fight
  // over the same spinner or error banner.
  priceInput:          string;
  priceActionBusy:     boolean;
  priceActionError:    string;
  priceActionSuccess:  boolean;
}

function emptyChannelState(): ChannelState {
  return {
    currentRow:      null,
    lastTerminalRow: null,
    lastEndedAt:     null,
    content:         '',
    isAiGenerated:   false,
    aiPromptId:      null,
    savedAt:         null,
    isDirty:         false,
    lastSavedVia:    null,
    errorMsg:        '',
    startDateInput:     todayDateString(),
    endDateInput:       todayDateString(),
    listingActionBusy:  false,
    listingActionError: '',
    confirmEnd:         false,
    confirmCancel:      false,
    priceInput:         '',
    priceActionBusy:    false,
    priceActionError:   '',
    priceActionSuccess: false,
  };
}

// ── Date helpers ───────────────────────────────────────────────────────────────
// Plain 'YYYY-MM-DD' strings throughout — lexicographic string comparison
// is chronologically correct for this format, matching how listed_at/
// ended_at/acquired dates are already compared elsewhere in this app.

// Exported (not just used locally) so this exact validation logic — not a
// reimplementation of it — is what scripts/test-item-listings.ts exercises.
export function todayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function validateStartDate(dateStr: string, acquiredDate: string | null): string | null {
  if (!dateStr) return 'Pick a listing date.';
  const today = todayDateString();
  if (dateStr > today) return 'Listing date cannot be in the future.';
  if (acquiredDate && dateStr < acquiredDate) return 'Listing date cannot be before the item was acquired.';
  return null;
}

export function validateEndDate(dateStr: string, listedAt: string | null): string | null {
  if (!dateStr) return 'Pick an end date.';
  const today = todayDateString();
  if (dateStr > today) return 'End date cannot be in the future.';
  if (listedAt && dateStr < listedAt) return 'End date cannot be before the listing date.';
  return null;
}

// Blank is always valid (asking price is optional — see the price-history
// migration's own header for why a listing may legitimately have no
// price on record). A non-blank value must parse as a number > 0;
// item_listings_asking_price_positive_check enforces the same rule at
// the DB level as defense in depth.
export function validateAskingPrice(priceStr: string): string | null {
  const trimmed = priceStr.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return 'Listed price must be greater than 0.';
  return null;
}

/** '' -> null; a valid numeric string -> that number. Assumes
 * validateAskingPrice already passed — callers must validate first. */
export function parseAskingPriceInput(priceStr: string): number | null {
  const trimmed = priceStr.trim();
  return trimmed === '' ? null : Number(trimmed);
}

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
  itemId:       number;
  itemLabel:    string;
  /** The item's earliest 'in' deal_item date ('YYYY-MM-DD'), historical or
   *  normal acquisition alike — null when unknown (e.g. still loading, or
   *  no acquisition deal_item exists at all). Used to validate that a
   *  listing's date can never predate when the item was actually
   *  acquired. */
  acquiredDate: string | null;
  /** Called after Start/End/Cancel Listing succeeds — these write
   *  immediately (unlike text edits, which wait for the form's Save), and
   *  each one can flip inventory_items.status via the DB sync trigger
   *  (owned<->listed). The parent's own copy of the item (e.g. the status
   *  badge) is not re-derived from this component's state, so without this
   *  callback it would keep showing the pre-action status until the whole
   *  form is saved or the page is reloaded. */
  onListingStatusChange?: () => void;
}

export interface AiAssistantCardHandle {
  // Saves every platform tab with unsaved TEXT changes. Resolves to an
  // error message (platforms joined) if any of them failed — tabs that
  // did save are still marked clean, only the failed ones stay dirty.
  // Never touches listing status/dates — Start/End/Cancel are their own
  // explicit actions, not part of the generic "save pending" sweep.
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

// Whole-calendar-day difference between two 'YYYY-MM-DD' strings, computed
// via Date.UTC so it can never drift by ±1 day from a local/UTC boundary
// mismatch (unlike `new Date(dateStr) - new Date(dateStr)`, which would).
// Exported so scripts/test-item-listings.ts exercises this exact function.
export function daysBetweenDateStrings(fromDateStr: string, toDateStr: string): number {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

// Latest ended_at among rows with status 'ended' for a single item+channel
// — never 'cancelled', never 'draft', and independent of whether a
// draft/active row also currently exists for that channel. Exported so
// scripts/test-item-listings.ts can verify the cancelled/draft exclusion
// directly, without mounting the component.
export function computeLastEndedAt(rows: ItemListing[]): string | null {
  return rows.reduce<string | null>((latest, r) => {
    if (r.status !== 'ended' || !r.ended_at) return latest;
    return !latest || r.ended_at > latest ? r.ended_at : latest;
  }, null);
}

// "Last listing ended today" / "...yesterday" / "...N days ago" — the
// small muted note shown per platform for a previous real (ended) listing
// cycle. `endedAt` must already be filtered to status 'ended' rows only —
// cancelled/draft rows are never passed in here.
export function formatPreviousCycleText(endedAt: string): string {
  const days = daysBetweenDateStrings(endedAt, todayDateString());
  if (days <= 0) return 'Last listing ended today';
  if (days === 1) return 'Last listing ended yesterday';
  return `Last listing ended ${days} days ago`;
}

function getStatusDisplay(tab: ChannelState): { label: string; color: string } {
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

// 'draft' is its own status — distinct from 'not_listed' — because a
// draft has a real item_listings row (cancellable, price-editable), even
// though it has no listed_at yet. Previously a draft row fell through to
// 'not_listed' below, which is exactly why Cancel could appear next to a
// "Not listed" badge (the row genuinely existed — it was only mislabeled).
type PlatformStatus = 'draft' | 'active' | 'ended' | 'cancelled' | 'not_listed';

function derivePlatformStatus(state: ChannelState): PlatformStatus {
  if (state.currentRow?.status === 'active') return 'active';
  if (state.currentRow?.status === 'draft') return 'draft';
  if (!state.currentRow && state.lastTerminalRow?.status === 'ended') return 'ended';
  if (!state.currentRow && state.lastTerminalRow?.status === 'cancelled') return 'cancelled';
  return 'not_listed';
}

const PLATFORM_STATUS_LABELS: Record<PlatformStatus, string> = {
  draft:       'Draft',
  active:      'Active',
  ended:       'Ended',
  cancelled:   'Cancelled',
  not_listed:  'Not listed',
};

const PLATFORM_STATUS_CLASSES: Record<PlatformStatus, string> = {
  draft:      'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  active:     'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  ended:      'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  cancelled:  'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  not_listed: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
};

function PlatformStatusBadge({ status }: { status: PlatformStatus }) {
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${PLATFORM_STATUS_CLASSES[status]}`}>
      {PLATFORM_STATUS_LABELS[status]}
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

const AiAssistantCard = forwardRef<AiAssistantCardHandle, AiAssistantCardProps>(
  function AiAssistantCard({ itemId, itemLabel, acquiredDate, onListingStatusChange }, ref) {
  const [channels,        setChannels]        = useState<DealChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<number | null>(null);
  const [tabs,            setTabs]            = useState<Record<number, ChannelState>>({});
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

  // ── Load channels + full listing history on mount ─────────────────────────

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

      // getItemListings returns every row for this item, newest first —
      // group by channel and derive each channel's current/terminal row.
      const rowsByChannel = new Map<number, ItemListing[]>();
      if (!listingRes.error && listingRes.data) {
        for (const row of listingRes.data as unknown as ItemListing[]) {
          const arr = rowsByChannel.get(row.deal_channel_id) ?? [];
          arr.push(row);
          rowsByChannel.set(row.deal_channel_id, arr);
        }
      }

      const initialTabs: Record<number, ChannelState> = {};
      for (const ch of platforms) {
        const rows = rowsByChannel.get(ch.id) ?? [];
        const currentRow      = rows.find((r) => r.status === 'draft' || r.status === 'active') ?? null;
        const lastTerminalRow = currentRow ? null : (rows.find((r) => r.status === 'ended' || r.status === 'cancelled') ?? null);
        // Latest ended_at across ALL 'ended' rows (not just the most recent
        // terminal row, and never a 'cancelled' row) — independent of
        // currentRow so it still shows while a new cycle is active.
        const lastEndedAt = computeLastEndedAt(rows);

        initialTabs[ch.id] = {
          ...emptyChannelState(),
          currentRow,
          lastTerminalRow,
          lastEndedAt,
          content:       currentRow?.description ?? '',
          isAiGenerated: currentRow?.is_ai_generated ?? false,
          aiPromptId:    currentRow?.ai_prompt_id ?? null,
          savedAt:       currentRow?.description ? currentRow.updated_at : null,
          lastSavedVia:  currentRow?.description ? (currentRow.is_ai_generated ? 'ai' : 'manual') : null,
          endDateInput:  todayDateString(),
          // Pre-fill from the current (draft/active) row's own price only
          // — never from lastTerminalRow, so a cancelled/ended cycle's old
          // price is never shown as if it were current (Part 6's rule).
          priceInput:    currentRow?.asking_price != null ? String(currentRow.asking_price) : '',
        };
      }

      setTabs(initialTabs);
      setLoadingDrafts(false);
    }

    load();
    return () => { cancelled = true; };
  }, [itemId]);

  // ── Tab state updater ──────────────────────────────────────────────────────

  function updateTab(id: number, patch: Partial<ChannelState>) {
    setTabs((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  // ── Text-draft save helper (shared by generate auto-save and manual
  // Save Draft) — always targets the channel's current non-terminal row,
  // creating a fresh draft only if none exists. ─────────────────────────

  async function saveDraftToDb(
    channelId:  number,
    content:    string,
    isAi:       boolean,
    aiPromptId: number | null,
  ): Promise<{ savedAt: string | null; row: ItemListing | null; error: string | null }> {
    const existingId = tabs[channelId]?.currentRow?.id ?? null;
    const { data, error } = await saveListingDraftText({
      id:                existingId ?? undefined,
      inventory_item_id: itemId,
      deal_channel_id:   channelId,
      description:       content,
      is_ai_generated:   isAi,
      ai_prompt_id:      aiPromptId ?? undefined,
    });

    if (error) return { savedAt: null, row: null, error: error.message };
    return { savedAt: data?.updated_at ?? new Date().toISOString(), row: (data as ItemListing) ?? null, error: null };
  }

  // ── Imperative handle — parent (InventoryForm) saves all pending drafts ────

  useImperativeHandle(ref, () => ({
    async savePending() {
      const dirtyEntries = channels
        .map((ch) => ({ ch, tab: tabs[ch.id] }))
        .filter((e): e is { ch: DealChannel; tab: ChannelState } => !!e.tab?.isDirty);

      if (dirtyEntries.length === 0) return { error: null };

      setSaving(true);
      const updates: Record<number, Partial<ChannelState>> = {};
      const errors: string[] = [];

      for (const { ch, tab } of dirtyEntries) {
        const trimmedContent = tab.content.trim();

        // Never create a brand-new row that would be entirely empty.
        if (!tab.currentRow && !trimmedContent) {
          updates[ch.id] = { isDirty: false, errorMsg: '' };
          continue;
        }

        const { data, error } = await saveListingDraftText({
          id:                tab.currentRow?.id ?? undefined,
          inventory_item_id: itemId,
          deal_channel_id:   ch.id,
          description:       trimmedContent || null,
          is_ai_generated:   tab.isAiGenerated,
          ai_prompt_id:      tab.aiPromptId ?? undefined,
        });

        if (error) {
          errors.push(`${ch.name}: ${error.message}`);
          updates[ch.id] = { errorMsg: error.message };
          continue;
        }

        const row = data as ItemListing | null;
        updates[ch.id] = {
          currentRow:   row ?? tab.currentRow,
          content:      row?.description ?? trimmedContent,
          savedAt:      row?.updated_at ?? new Date().toISOString(),
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

  // ── Actions: AI generate / manual save / copy / clear (text only) ─────────

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

      const { savedAt, row, error: saveError } = await saveDraftToDb(channelId, text, true, aiPromptId);

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
          currentRow:    row ?? tabs[channelId]?.currentRow ?? null,
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
    if (!trimmedContent) {
      updateTab(activeChannelId, { errorMsg: 'Add listing text before saving.' });
      return;
    }

    setSaving(true);
    updateTab(activeChannelId, { errorMsg: '' });

    const { savedAt, row, error } = await saveDraftToDb(activeChannelId, trimmedContent, current.isAiGenerated, current.aiPromptId);

    setSaving(false);

    if (error) {
      updateTab(activeChannelId, { errorMsg: `Save failed: ${error}` });
      return;
    }

    updateTab(activeChannelId, {
      currentRow:   row ?? current.currentRow,
      content:      row?.description ?? trimmedContent,
      savedAt:      savedAt!,
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

  // ── Actions: listing lifecycle (Start / End / Cancel) ──────────────────────

  async function handleStartListing(channelId: number) {
    const tab = tabs[channelId];
    if (!tab) return;

    const dateError = validateStartDate(tab.startDateInput, acquiredDate);
    if (dateError) {
      updateTab(channelId, { listingActionError: dateError });
      return;
    }
    const priceError = validateAskingPrice(tab.priceInput);
    if (priceError) {
      updateTab(channelId, { listingActionError: priceError });
      return;
    }

    updateTab(channelId, { listingActionBusy: true, listingActionError: '' });

    const { data, error } = await startListing({
      inventory_item_id: itemId,
      deal_channel_id:   channelId,
      listed_at:         tab.startDateInput,
      existingDraftId:   tab.currentRow?.status === 'draft' ? tab.currentRow.id : null,
      asking_price:      parseAskingPriceInput(tab.priceInput),
    });

    if (error || !data) {
      updateTab(channelId, { listingActionBusy: false, listingActionError: error?.message ?? 'Could not start the listing.' });
      return;
    }

    const row = data as ItemListing;
    updateTab(channelId, {
      currentRow:         row,
      lastTerminalRow:    null,
      content:            row.description ?? tab.content,
      isAiGenerated:       row.is_ai_generated,
      aiPromptId:          row.ai_prompt_id,
      priceInput:          row.asking_price != null ? String(row.asking_price) : '',
      listingActionBusy:  false,
      listingActionError: '',
    });
    onListingStatusChange?.();
  }

  // ── Action: Update Price — the ONLY field this ever touches is
  // asking_price. Never listed_at/ended_at/status/description/AI fields
  // (see updateListingPrice's own comment in src/lib/supabase.ts). Valid
  // for a draft OR active currentRow; a no-op (no network call at all) if
  // the price hasn't actually changed, matching "if price is unchanged:
  // do nothing / no history row." ────────────────────────────────────────
  async function handleUpdatePrice(channelId: number) {
    const tab = tabs[channelId];
    if (!tab?.currentRow) return;

    const priceError = validateAskingPrice(tab.priceInput);
    if (priceError) {
      updateTab(channelId, { priceActionError: priceError, priceActionSuccess: false });
      return;
    }

    const nextPrice = parseAskingPriceInput(tab.priceInput);
    if (nextPrice === tab.currentRow.asking_price) {
      updateTab(channelId, { priceActionError: '', priceActionSuccess: false });
      return;
    }

    updateTab(channelId, { priceActionBusy: true, priceActionError: '', priceActionSuccess: false });

    const { data, error } = await updateListingPrice(tab.currentRow.id, nextPrice);

    if (error || !data) {
      updateTab(channelId, { priceActionBusy: false, priceActionError: error?.message ?? 'Could not update the listed price.' });
      return;
    }

    const row = data as ItemListing;
    updateTab(channelId, {
      currentRow:         row,
      priceInput:         row.asking_price != null ? String(row.asking_price) : '',
      priceActionBusy:    false,
      priceActionError:   '',
      priceActionSuccess: true,
    });
    // Success confirmation is transient — same pattern as the Copy/Copied
    // affordance elsewhere in this component.
    setTimeout(() => updateTab(channelId, { priceActionSuccess: false }), 2000);
  }

  async function handleEndListing(channelId: number) {
    const tab = tabs[channelId];
    if (!tab?.currentRow || tab.currentRow.status !== 'active') return;

    const validationError = validateEndDate(tab.endDateInput, tab.currentRow.listed_at);
    if (validationError) {
      updateTab(channelId, { listingActionError: validationError, confirmEnd: false });
      return;
    }

    updateTab(channelId, { listingActionBusy: true, listingActionError: '' });

    const { data, error } = await endListing(tab.currentRow.id, tab.endDateInput);

    if (error || !data) {
      updateTab(channelId, { listingActionBusy: false, listingActionError: error?.message ?? 'Could not end the listing.', confirmEnd: false });
      return;
    }

    const row = data as ItemListing;
    updateTab(channelId, {
      currentRow:         null,
      lastTerminalRow:    row,
      lastEndedAt:        row.ended_at ?? tab.lastEndedAt,
      listingActionBusy:  false,
      listingActionError: '',
      confirmEnd:         false,
    });
    onListingStatusChange?.();
  }

  async function handleCancelListing(channelId: number) {
    const tab = tabs[channelId];
    if (!tab?.currentRow) return;

    updateTab(channelId, { listingActionBusy: true, listingActionError: '' });

    const { data, error } = await cancelListing(tab.currentRow.id);

    if (error || !data) {
      updateTab(channelId, { listingActionBusy: false, listingActionError: error?.message ?? 'Could not cancel this listing record.', confirmCancel: false });
      return;
    }

    const row = data as ItemListing;
    updateTab(channelId, {
      currentRow:         null,
      lastTerminalRow:    row,
      content:            '',
      isAiGenerated:      false,
      aiPromptId:         null,
      savedAt:            null,
      isDirty:            false,
      lastSavedVia:       null,
      // Cancel is a clean slate (matches the text/AI fields above) — the
      // cancelled row's price remains in its own history for audit (Part
      // 6), but must never resurface as if it were a current price.
      priceInput:         '',
      priceActionError:   '',
      priceActionSuccess: false,
      listingActionBusy:  false,
      listingActionError: '',
      confirmCancel:      false,
    });
    onListingStatusChange?.();
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
          Manage platform listing status, dates, and text for{' '}
          <span className="font-medium text-slate-700 dark:text-slate-200">
            {itemLabel || 'this item'}
          </span>
        </p>
      </div>

      {/* ── Platform status (ABOVE the text tabs, deliberately) ─────────────
          Shows listed/not-listed status per platform independent of which
          text tab is selected below — switching tabs never hides or
          changes anything in this section. ─────────────────────────────── */}
      {channels.length > 0 && (
        <div className="mt-4 space-y-2">
          {channels.map((ch) => {
            const tab = tabs[ch.id];
            if (!tab) return null;
            const platformStatus = derivePlatformStatus(tab);
            const isActive  = platformStatus === 'active';
            const isDraft   = platformStatus === 'draft';
            // Cancel/Update Price are only ever shown when a real draft or
            // active item_listings row exists — never for ended/cancelled/
            // not_listed, which have no current record to act on.
            const canCancel      = isActive || isDraft;
            const canUpdatePrice = isActive || isDraft;

            return (
              <div key={ch.id} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                {/* Header row: name + status badge + listed date / previous-
                    cycle note. Identical structure regardless of status —
                    only the badge and note content differ — so no platform
                    card looks structurally different from another. */}
                <div className="flex flex-col gap-1 p-3 pb-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-900 dark:text-white">{ch.name}</span>
                    <PlatformStatusBadge status={platformStatus} />
                  </div>
                  {isActive && tab.currentRow?.listed_at && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Listed {formatListedDate(tab.currentRow.listed_at)}
                    </span>
                  )}
                  {tab.lastEndedAt && (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      {formatPreviousCycleText(tab.lastEndedAt)}
                    </span>
                  )}
                </div>

                {/* Fields: Start Date + Listed Price side by side on sm+,
                    stacked on mobile, for any non-active status. Active
                    status shows Listed Price alone (its listed date is
                    already shown above; its end date is chosen inside the
                    End Listing confirmation below, not here). */}
                <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                  {!isActive && (
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Start Date</span>
                      <input
                        type="date"
                        value={tab.startDateInput}
                        onChange={(e) => updateTab(ch.id, { startDateInput: e.target.value, listingActionError: '' })}
                        disabled={tab.listingActionBusy || loadingDrafts}
                        aria-label={`${ch.name} listing date`}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:focus:ring-slate-600"
                      />
                    </label>
                  )}

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">Listed Price</span>
                    <div className="relative">
                      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-slate-400 dark:text-slate-500">$</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={tab.priceInput}
                        onChange={(e) => updateTab(ch.id, { priceInput: e.target.value, listingActionError: '', priceActionError: '', priceActionSuccess: false })}
                        disabled={tab.listingActionBusy || tab.priceActionBusy || loadingDrafts}
                        placeholder="0.00"
                        aria-label={`${ch.name} listed price`}
                        className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-6 pr-2.5 text-sm text-slate-700 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:focus:ring-slate-600"
                      />
                    </div>
                  </label>
                </div>

                {/* Actions: consistent order everywhere — primary action
                    first (Start Listing, or nothing extra for an already-
                    active listing), then Update Price, then End Listing,
                    then Cancel. flex-wrap so buttons never overflow on
                    mobile — they wrap to their own row instead. */}
                <div className="flex flex-wrap gap-2 px-3 pb-3">
                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => handleStartListing(ch.id)}
                      disabled={tab.listingActionBusy || loadingDrafts}
                      aria-busy={tab.listingActionBusy}
                      className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center rounded-lg bg-slate-950 px-2.5 py-2 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 sm:flex-none"
                    >
                      {tab.listingActionBusy ? 'Starting…' : 'Start Listing'}
                    </button>
                  )}

                  {canUpdatePrice && (
                    <button
                      type="button"
                      onClick={() => handleUpdatePrice(ch.id)}
                      disabled={tab.priceActionBusy || tab.listingActionBusy}
                      aria-busy={tab.priceActionBusy}
                      className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600 sm:flex-none"
                    >
                      {tab.priceActionBusy ? 'Updating…' : tab.priceActionSuccess ? 'Price updated' : 'Update Price'}
                    </button>
                  )}

                  {isActive && (
                    <button
                      type="button"
                      onClick={() => updateTab(ch.id, { confirmEnd: true, endDateInput: todayDateString() })}
                      disabled={tab.listingActionBusy}
                      className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600 sm:flex-none"
                    >
                      End Listing
                    </button>
                  )}

                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => updateTab(ch.id, { confirmCancel: true })}
                      disabled={tab.listingActionBusy}
                      className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center rounded-lg border border-rose-200 bg-white px-2.5 py-2 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800/50 dark:bg-slate-700 dark:text-rose-400 dark:hover:bg-rose-900/20 sm:flex-none"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {tab.priceActionError && (
                  <div className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
                    {tab.priceActionError}
                  </div>
                )}

                {tab.listingActionError && (
                  <div className="border-t border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
                    {tab.listingActionError}
                  </div>
                )}

                {tab.confirmEnd && (
                  <div className="flex flex-col gap-2 border-t border-amber-200 bg-amber-50 p-3 dark:border-amber-800/40 dark:bg-amber-900/10 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-amber-800 dark:text-amber-300">End Date</span>
                      <input
                        type="date"
                        value={tab.endDateInput}
                        onChange={(e) => updateTab(ch.id, { endDateInput: e.target.value, listingActionError: '' })}
                        disabled={tab.listingActionBusy}
                        aria-label={`${ch.name} end date`}
                        className="w-full rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:bg-slate-700 dark:text-slate-200 sm:w-auto"
                      />
                    </label>
                    <p className="text-xs text-amber-800 dark:text-amber-300">
                      Ends the {ch.name} listing. It stays in this item&apos;s listing history.
                    </p>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleEndListing(ch.id)}
                        disabled={tab.listingActionBusy}
                        className="rounded-lg bg-slate-950 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-slate-900"
                      >
                        {tab.listingActionBusy ? 'Ending…' : 'Confirm End'}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateTab(ch.id, { confirmEnd: false })}
                        disabled={tab.listingActionBusy}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                      >
                        Keep Active
                      </button>
                    </div>
                  </div>
                )}

                {tab.confirmCancel && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rose-200 bg-rose-50 px-3 py-2 dark:border-rose-800/40 dark:bg-rose-900/10">
                    <p className="text-xs text-rose-800 dark:text-rose-300">
                      Cancel this listing record? It will be ignored in current listing status and analytics.
                    </p>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleCancelListing(ch.id)}
                        disabled={tab.listingActionBusy}
                        className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {tab.listingActionBusy ? 'Cancelling…' : 'Confirm Cancel'}
                      </button>
                      <button
                        type="button"
                        onClick={() => updateTab(ch.id, { confirmCancel: false })}
                        disabled={tab.listingActionBusy}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                      >
                        Never Mind
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Tabs (dynamic listing platforms) — control ONLY the text editor
          below, never the platform status area above. ────────────────────── */}
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
