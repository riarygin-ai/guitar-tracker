'use client';

import { useEffect, useState } from 'react';
import { getAiPrompts, updateAiPromptById } from '@/lib/supabase';
import type { AiPrompt } from '@/types';

// ── Types ──────────────────────────────────────────────────────────────────────

type TabId = 'reverb' | 'marketplace' | 'kijiji';

interface FormValues {
  name:        string;
  description: string;
  model:       string;
  temperature: string;
  promptText:  string;
  isActive:    boolean;
}

interface TabState {
  promptId:  number | null;
  current:   FormValues;
  saved:     FormValues | null; // null while loading
  isDirty:   boolean;
  savedAt:   string | null;
  saving:    boolean;
  errorMsg:  string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TABS: { id: TabId; label: string; promptKey: string }[] = [
  { id: 'reverb',      label: 'Reverb',      promptKey: 'listing_reverb' },
  { id: 'marketplace', label: 'Marketplace', promptKey: 'listing_marketplace' },
  { id: 'kijiji',      label: 'Kijiji',      promptKey: 'listing_kijiji' },
];

const EMPTY_FORM: FormValues = {
  name:        '',
  description: '',
  model:       'gpt-4o',
  temperature: '0.65',
  promptText:  '',
  isActive:    true,
};

function promptToForm(p: AiPrompt): FormValues {
  return {
    name:        p.name,
    description: p.description ?? '',
    model:       p.model       ?? 'gpt-4o',
    temperature: p.temperature != null ? String(p.temperature) : '0.65',
    promptText:  p.prompt_text,
    isActive:    p.is_active,
  };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-CA', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [activeTab,    setActiveTab]    = useState<TabId>('reverb');
  const [loading,      setLoading]      = useState(true);
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [tabs,         setTabs]         = useState<Record<TabId, TabState>>(() => {
    const make = (): TabState => ({
      promptId:  null,
      current:   { ...EMPTY_FORM },
      saved:     null,
      isDirty:   false,
      savedAt:   null,
      saving:    false,
      errorMsg:  '',
    });
    return { reverb: make(), marketplace: make(), kijiji: make() };
  });

  const tab = tabs[activeTab];

  // ── Load prompts on mount ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data, error } = await getAiPrompts();

      if (cancelled) return;

      if (error || !data) {
        setLoadError('Could not load prompts. Please refresh the page.');
        setLoading(false);
        return;
      }

      setTabs((prev) => {
        const next = { ...prev };
        for (const tabDef of TABS) {
          const row = (data as AiPrompt[]).find((p) => p.prompt_key === tabDef.promptKey);
          if (row) {
            const form = promptToForm(row);
            next[tabDef.id] = {
              ...next[tabDef.id],
              promptId: row.id,
              current:  form,
              saved:    form,
              isDirty:  false,
              savedAt:  row.updated_at,
            };
          }
        }
        return next;
      });

      setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function updateCurrent(id: TabId, patch: Partial<FormValues>) {
    setTabs((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        current: { ...prev[id].current, ...patch },
        isDirty: true,
        errorMsg: '',
      },
    }));
  }

  function updateTabMeta(id: TabId, patch: Partial<TabState>) {
    setTabs((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!tab.promptId) return;
    if (!tab.current.promptText.trim()) {
      updateTabMeta(activeTab, { errorMsg: 'Prompt text cannot be empty.' });
      return;
    }
    if (!tab.current.name.trim()) {
      updateTabMeta(activeTab, { errorMsg: 'Name cannot be empty.' });
      return;
    }

    const tempNum = parseFloat(tab.current.temperature);
    if (isNaN(tempNum) || tempNum < 0 || tempNum > 2) {
      updateTabMeta(activeTab, { errorMsg: 'Temperature must be between 0 and 2.' });
      return;
    }

    updateTabMeta(activeTab, { saving: true, errorMsg: '' });

    const { data, error } = await updateAiPromptById(tab.promptId, {
      name:        tab.current.name.trim(),
      description: tab.current.description.trim() || null,
      model:       tab.current.model.trim()        || null,
      temperature: tempNum,
      prompt_text: tab.current.promptText,
      is_active:   tab.current.isActive,
    });

    if (error) {
      updateTabMeta(activeTab, { saving: false, errorMsg: `Save failed: ${error.message}` });
      return;
    }

    const savedAt = (data as AiPrompt | null)?.updated_at ?? new Date().toISOString();
    const savedForm = { ...tab.current, temperature: String(tempNum) };
    updateTabMeta(activeTab, {
      saving:  false,
      saved:   savedForm,
      current: savedForm,
      isDirty: false,
      savedAt,
      errorMsg: '',
    });
  }

  function handleReset() {
    if (!tab.saved) return;
    updateTabMeta(activeTab, {
      current:  { ...tab.saved },
      isDirty:  false,
      errorMsg: '',
    });
  }

  // ── Shared styles ──────────────────────────────────────────────────────────

  const inputClass =
    'h-9 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-100 dark:focus:bg-slate-700 dark:focus:ring-slate-600';

  const labelClass = 'block text-xs font-medium text-slate-600 dark:text-slate-400';

  return (
    <div className="space-y-6">

      {/* ── Page header ───────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <p className="text-xs uppercase tracking-[0.35em] text-slate-500 dark:text-slate-400">App</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950 dark:text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Manage AI generation prompts and other preferences.
        </p>
      </div>

      {/* ── AI Prompts card ───────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {/* Card header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">AI Prompts</h2>
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                Beta
              </span>
            </div>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              Edit the instructions used when generating marketplace listings.
              Changes take effect immediately on the next generation.
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

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <div
          className="mt-5 flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-700/60"
          role="tablist"
          aria-label="Listing platform"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
                activeTab === t.id
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
              }`}
            >
              {t.label}
              {tabs[t.id].isDirty && activeTab !== t.id && (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle dark:bg-amber-500" />
              )}
            </button>
          ))}
        </div>

        {/* ── Body ────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="mt-6 flex items-center gap-2.5 py-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
            <span className="text-sm text-slate-500 dark:text-slate-400">Loading prompts…</span>
          </div>
        ) : loadError ? (
          <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
            {loadError}
          </div>
        ) : (
          <div className="mt-6 space-y-5">

            {/* Row 1: Name + Description */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className={labelClass}>Name</label>
                <input
                  type="text"
                  value={tab.current.name}
                  onChange={(e) => updateCurrent(activeTab, { name: e.target.value })}
                  disabled={tab.saving}
                  className={inputClass}
                  placeholder="e.g. Reverb.com Listing"
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass}>Description <span className="font-normal text-slate-400">(optional)</span></label>
                <input
                  type="text"
                  value={tab.current.description}
                  onChange={(e) => updateCurrent(activeTab, { description: e.target.value })}
                  disabled={tab.saving}
                  className={inputClass}
                  placeholder="Short note about this prompt"
                />
              </div>
            </div>

            {/* Row 2: Model + Temperature + Active */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_140px_auto]">
              <div className="space-y-1.5">
                <label className={labelClass}>Model</label>
                <input
                  type="text"
                  value={tab.current.model}
                  onChange={(e) => updateCurrent(activeTab, { model: e.target.value })}
                  disabled={tab.saving}
                  className={inputClass}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass}>Temperature</label>
                <input
                  type="number"
                  min="0"
                  max="2"
                  step="0.05"
                  value={tab.current.temperature}
                  onChange={(e) => updateCurrent(activeTab, { temperature: e.target.value })}
                  disabled={tab.saving}
                  className={inputClass}
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass}>Active</label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={tab.current.isActive}
                  onClick={() => updateCurrent(activeTab, { isActive: !tab.current.isActive })}
                  disabled={tab.saving}
                  className={`relative mt-0.5 inline-flex h-6 w-11 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50 ${
                    tab.current.isActive
                      ? 'bg-emerald-500 dark:bg-emerald-600'
                      : 'bg-slate-300 dark:bg-slate-600'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    tab.current.isActive ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>
            </div>

            {/* Prompt text */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className={labelClass}>Prompt text</label>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {tab.current.promptText.length.toLocaleString()} chars
                </span>
              </div>
              <textarea
                value={tab.current.promptText}
                onChange={(e) => updateCurrent(activeTab, { promptText: e.target.value })}
                disabled={tab.saving}
                placeholder="Enter the instruction that tells the model how to format the listing…"
                className="w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 font-mono text-sm leading-relaxed text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700/50 dark:text-slate-100 dark:focus:bg-slate-700 dark:focus:ring-slate-600"
                style={{ minHeight: '320px' }}
              />
              <p className="text-xs text-slate-400 dark:text-slate-500">
                This replaces the per-type instruction in the AI message. The global system prompt (dealer tone, honesty rules) remains fixed.
              </p>
            </div>

            {/* Status + error */}
            <div>
              <p className={`text-xs ${
                tab.isDirty
                  ? 'text-amber-600 dark:text-amber-400'
                  : tab.savedAt
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-400 dark:text-slate-500'
              }`}>
                {tab.isDirty
                  ? 'Unsaved changes'
                  : tab.savedAt
                    ? `Saved ${formatDate(tab.savedAt)}`
                    : 'No changes'
                }
              </p>
              {tab.errorMsg && (
                <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800/50 dark:bg-rose-900/20 dark:text-rose-300">
                  {tab.errorMsg}
                </div>
              )}
            </div>

            {/* Buttons */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={tab.saving || !tab.isDirty}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
              >
                {tab.saving ? (
                  <>
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-slate-900/40 dark:border-t-slate-900" />
                    Saving…
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
                      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
                    </svg>
                    Save
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleReset}
                disabled={tab.saving || !tab.isDirty}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                Reset changes
              </button>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
