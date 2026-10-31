'use client';

// Draft-mode pieces shared by the normal Buy / Sell / Trade forms. A draft is
// edited in the SAME operation form as a new operation; only these differ:
// the action bar (Discard draft · Save draft · Finalize), the per-item
// "still needed before finalizing" hint + Edit link, and the incomplete-items
// notice. No economics, items or lead UI lives here.

import { useState } from 'react';
import { discardDraft, missingForFinalize, type DraftType } from '@/lib/operations/operationDraftsClient';

/** What a form needs to know to run in draft mode. */
export interface DraftFormContext {
  id: number;
  type: DraftType;
  /** The draft's winning lead (preselected in the Lead picker). */
  leadId: number | null;
  /** Contact name as captured (e.g. from ChatGPT) — only a suggestion for the Lead picker. */
  contactName: string | null;
  /** Incoming items this draft created (discard / removal may clean them up). */
  createdItemIds: number[];
}

type ItemFields = { item_subtype_id: number | null; condition: string | null; purpose_id: number | null; estimated_sold_value: number | null };

/** Incoming items that still miss a field finalization requires. */
export function incompleteIncoming(items: ItemFields[]): number {
  return items.filter((i) => missingForFinalize(i).length > 0).length;
}

/** Under an item card in draft mode: what finalization still needs + Edit (returns to the draft). */
export function DraftItemHint({ item, incoming, onEdit, disabled }: { item: ItemFields & { id: number }; incoming: boolean; onEdit: (itemId: number) => void; disabled?: boolean }) {
  const missing = incoming ? missingForFinalize(item) : [];
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-testid={`draft-item-hint-${item.id}`}>
      {missing.length > 0
        ? <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Needed before finalizing: {missing.join(', ')}</p>
        : <span />}
      <button type="button" disabled={disabled} onClick={() => onEdit(item.id)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-200 dark:hover:bg-slate-500">
        {incoming ? 'Edit · photos' : 'Edit item'}
      </button>
    </div>
  );
}

/** Replaces the form's Reset / Save buttons in draft mode. */
export function DraftActionBar({ draft, label, busy, incomplete, finalizeBlocked, onSave, onFinalize }: {
  draft: DraftFormContext;
  /** "trade" | "sale" | "purchase" */
  label: string;
  busy: boolean;
  incomplete: number;
  /** Extra reason Finalize is unavailable (e.g. trade not balanced), shown by the form itself. */
  finalizeBlocked: boolean;
  onSave: () => void;
  onFinalize: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [removeNew, setRemoveNew] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const created = draft.createdItemIds.length;

  async function discard() {
    setDiscarding(true);
    setError(null);
    const r = await discardDraft(draft.id, removeNew);
    setDiscarding(false);
    if (!r.ok) { setError(r.message); return; }
    window.location.reload(); // the page re-reads the draft and shows its discarded state
  }

  return (
    <div className="mt-6 space-y-3" data-testid="draft-action-bar">
      {incomplete > 0 && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          {incomplete === 1 ? '1 incoming item still needs' : `${incomplete} incoming items still need`} details before the {label} can be finalized — use Edit · photos on the item.
        </p>
      )}
      {confirm ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300" data-testid="discard-confirm">
          <p className="font-semibold">Discard this draft?</p>
          <p className="mt-1">Nothing was recorded, so nothing is undone: items, listings, cash and leads stay as they are.</p>
          {created > 0 && (
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" checked={removeNew} onChange={(e) => setRemoveNew(e.target.checked)} className="mt-0.5" />
              <span>Also delete the {created === 1 ? 'new item' : `${created} new items`} created for this draft — only {created === 1 ? 'if it has' : 'those with'} no photos, listings, leads, expenses or other operations; anything else is kept.</span>
            </label>
          )}
          {error && <p className="mt-2 font-medium">{error}</p>}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button type="button" disabled={discarding} onClick={() => setConfirm(false)} className="inline-flex h-10 items-center justify-center rounded-xl border border-rose-200 bg-white px-4 text-sm font-medium text-rose-700 dark:border-rose-800 dark:bg-slate-800 dark:text-rose-300">Keep draft</button>
            <button type="button" disabled={discarding} onClick={discard} className="inline-flex h-10 items-center justify-center rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-60">{discarding ? 'Discarding…' : 'Discard draft'}</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" disabled={busy} onClick={() => setConfirm(true)} className="inline-flex h-11 items-center justify-center rounded-xl border border-rose-200 bg-white px-5 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-60 sm:mr-auto dark:border-rose-800 dark:bg-slate-800 dark:text-rose-400">
            Discard draft
          </button>
          <button type="button" disabled={busy} onClick={onSave} className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">
            Save draft
          </button>
          <button type="button" disabled={busy || incomplete > 0 || finalizeBlocked} onClick={onFinalize} className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-500 dark:disabled:text-slate-300">
            {busy ? 'Saving...' : `Finalize ${label}`}
          </button>
        </div>
      )}
    </div>
  );
}
