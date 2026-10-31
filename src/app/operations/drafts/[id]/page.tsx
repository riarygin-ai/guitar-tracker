'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import OperationDraftBadge from '@/components/OperationDraftBadge';
import { getDealChannels, getDisplayPhotosForItems, getInventorySearchItemsByIds, supabase } from '@/lib/supabase';
import {
  discardDraft, getOperationDraft, missingForFinalize, updateDraftTerms, DRAFT_TYPE_LABEL,
  type DiscardResult, type OperationDraft,
} from '@/lib/operations/operationDraftsClient';
import { formatCalendarDate } from '@/lib/dateUtils';
import type { DealChannel, InventorySearchItem } from '@/types';

const inputClass = 'w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600';
const cad = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}

function itemLabel(i: InventorySearchItem | undefined, id: number): string {
  if (!i) return `Item #${id}`;
  const base = [i.year, i.brand_name, i.model].filter(Boolean).join(' ');
  return i.color ? `${base} — ${i.color}` : base;
}

export default function OperationDraftPage() {
  const params = useParams();
  const router = useRouter();
  const draftId = Number(params.id);

  const [draft, setDraft] = useState<OperationDraft | null>(null);
  const [items, setItems] = useState<Record<number, InventorySearchItem>>({});
  const [photos, setPhotos] = useState<Record<number, string>>({});
  const [channels, setChannels] = useState<DealChannel[]>([]);
  const [leadName, setLeadName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [terms, setTerms] = useState({ proposed_date: '', deal_channel_id: '', contact_name: '', cash_paid: '', cash_received: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);

  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [removeNewItems, setRemoveNewItems] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState<DiscardResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [d, ch] = await Promise.all([getOperationDraft(draftId), getDealChannels()]);
    setChannels((ch.data as DealChannel[] | null) ?? []);
    if (d.error || !d.data) {
      setError(d.error ? 'Could not load the draft.' : 'Draft not found.');
      setLoading(false);
      return;
    }
    setDraft(d.data);
    const ids = d.data.operation_draft_items.map((x) => x.item_id);
    const [it, ph] = await Promise.all([getInventorySearchItemsByIds(ids), getDisplayPhotosForItems(ids)]);
    setItems(Object.fromEntries(((it.data ?? []) as InventorySearchItem[]).map((i) => [i.id, i])));
    setPhotos(ph);
    if (d.data.lead_id != null) {
      const { data: lead } = await supabase.from('item_leads').select('contact_name').eq('id', d.data.lead_id).maybeSingle();
      setLeadName((lead?.contact_name as string | null) ?? null);
    } else setLeadName(null);
    setLoading(false);
  }, [draftId]);

  useEffect(() => { load(); }, [load]);

  function startEdit(d: OperationDraft) {
    setTerms({
      proposed_date: d.proposed_date ?? '', deal_channel_id: d.deal_channel_id != null ? String(d.deal_channel_id) : '',
      contact_name: d.contact_name ?? '', cash_paid: d.cash_paid ? String(d.cash_paid) : '', cash_received: d.cash_received ? String(d.cash_received) : '',
      notes: d.notes ?? '',
    });
    setTermsError(null);
    setEditing(true);
  }

  async function saveTerms() {
    if (!draft) return;
    const paid = Number(terms.cash_paid || 0);
    const received = Number(terms.cash_received || 0);
    if (Number.isNaN(paid) || paid < 0 || Number.isNaN(received) || received < 0) { setTermsError('Cash amounts must be 0 or greater.'); return; }
    setSaving(true);
    const r = await updateDraftTerms(draft.id, {
      proposed_date: terms.proposed_date || null,
      deal_channel_id: terms.deal_channel_id ? Number(terms.deal_channel_id) : null,
      contact_name: terms.contact_name.trim() || null,
      lead_id: draft.lead_id,
      cash_paid: paid,
      cash_received: received,
      notes: terms.notes.trim() || null,
    });
    setSaving(false);
    if (!r.ok) { setTermsError(r.message); return; }
    setEditing(false);
    await load();
  }

  async function runDiscard() {
    if (!draft) return;
    setDiscarding(true);
    setDiscardError(null);
    const r = await discardDraft(draft.id, removeNewItems);
    setDiscarding(false);
    if (!r.ok) { setDiscardError(r.message); return; }
    setDiscarded(r.result);
    setConfirmDiscard(false);
    await load();
  }

  if (loading && !draft) {
    return <Shell><div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">Loading draft...</div></Shell>;
  }
  if (error || !draft) {
    return (
      <Shell>
        <div className="space-y-4">
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">{error ?? 'Draft not found.'}</div>
          <Link href="/operations" className="inline-flex text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Operations</Link>
        </div>
      </Shell>
    );
  }

  const isOpen = draft.status === 'OPEN';
  const outgoing = draft.operation_draft_items.filter((x) => x.direction === 'out');
  const incoming = draft.operation_draft_items.filter((x) => x.direction === 'in');
  const newCreated = incoming.filter((x) => x.created_by_draft).length;
  const channelName = channels.find((c) => c.id === draft.deal_channel_id)?.name ?? null;
  const label = DRAFT_TYPE_LABEL[draft.operation_type];
  const incomplete = incoming.filter((x) => items[x.item_id] && missingForFinalize(items[x.item_id]).length > 0).length;

  const itemRow = (itemId: number, side: 'in' | 'out') => {
    const it = items[itemId];
    const missing = side === 'in' && it ? missingForFinalize(it) : [];
    return (
      <Link key={itemId} href={`/inventory/${itemId}`} className="block rounded-2xl border border-slate-200 bg-slate-50 p-3 transition hover:border-slate-300 hover:bg-white dark:border-slate-600 dark:bg-slate-700 dark:hover:bg-slate-600" data-testid={`draft-item-${itemId}`}>
        <div className="flex items-start gap-3">
          {photos[itemId] ? (
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
              <Image src={photos[itemId]} alt={itemLabel(it, itemId)} fill className="object-cover" unoptimized sizes="56px" />
            </div>
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-[10px] text-slate-400 dark:border-slate-500">No photo</div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-white">#{itemId} {itemLabel(it, itemId)}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {it && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300">{it.status}</span>}
              {it?.item_subtype_name && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-600 dark:text-slate-300">{it.item_subtype_name}</span>}
              {it?.condition && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-600 dark:text-slate-300">{it.condition}</span>}
              {side === 'in' && it?.estimated_sold_value != null && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-600 dark:text-slate-300">Est. {cad(Number(it.estimated_sold_value))}</span>}
            </div>
            {side === 'in' && isOpen && missing.length > 0 && (
              <p className="mt-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">Needs before finalizing: {missing.join(', ')}</p>
            )}
          </div>
          <span className="shrink-0 self-center text-xs font-medium text-slate-500 dark:text-slate-400">{side === 'in' && isOpen ? 'Edit · photos →' : 'Open →'}</span>
        </div>
      </Link>
    );
  };

  return (
    <Shell>
    <div className="space-y-4">
      <div className="rounded-3xl border-2 border-dashed border-amber-300 bg-white p-5 shadow-sm dark:border-amber-700 dark:bg-slate-800">
        <Link href="/operations" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Operations</Link>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <OperationDraftBadge type={draft.operation_type} />
          <span className="text-xs text-slate-500 dark:text-slate-400">#{draft.id} · captured {draft.source === 'MCP' ? 'from ChatGPT' : 'in Guitar Tracker'}</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
          {isOpen ? `Planned ${label.toLowerCase()} — not completed` : draft.status === 'FINALIZED' ? `Draft ${label} — finalized` : `Draft ${label} — discarded`}
        </h1>
        {isOpen && (
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Nothing has happened yet: item statuses, listings, cash and leads are unchanged. Add photos and details to the incoming items,
            then finalize — the {label.toLowerCase()} is recorded exactly like a new operation at that moment.
          </p>
        )}
        {draft.status === 'FINALIZED' && draft.deal_id != null && (
          <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
            Recorded as <Link href={`/operations/${draft.deal_id}`} className="font-semibold underline">operation #{draft.deal_id}</Link>.
          </p>
        )}
        {draft.status === 'DISCARDED' && (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Discarded — it never affected inventory, listings, cash or leads.</p>
        )}
      </div>

      {(discarded ?? draft.discard_result) && draft.status === 'DISCARDED' && (() => {
        const r = (discarded ?? draft.discard_result)!;
        return (
          <div className="rounded-3xl border border-slate-200 bg-white p-5 text-sm text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300" data-testid="discard-result">
            {r.removed_item_ids.length > 0 && <p>Deleted the new items created for this draft: {r.removed_item_ids.map((x) => `#${x}`).join(', ')}.</p>}
            {r.kept_items.map((k) => <p key={k.item_id}>Kept item <Link href={`/inventory/${k.item_id}`} className="underline">#{k.item_id}</Link> ({k.reasons.join(', ')}) — it stays a new item.</p>)}
            {r.removed_item_ids.length === 0 && r.kept_items.length === 0 && <p>No items were created by this draft.</p>}
          </div>
        );
      })()}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">What I give</h2>
          <div className="mt-3 space-y-2">
            {outgoing.length ? outgoing.map((x) => itemRow(x.item_id, 'out')) : <p className="text-sm text-slate-500 dark:text-slate-400">No items.</p>}
          </div>
          {draft.cash_paid > 0 && <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">Cash paid (planned): <span className="font-semibold">{cad(draft.cash_paid)}</span></p>}
        </section>
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">What I receive</h2>
          <div className="mt-3 space-y-2">
            {incoming.length ? incoming.map((x) => itemRow(x.item_id, 'in')) : <p className="text-sm text-slate-500 dark:text-slate-400">No items.</p>}
          </div>
          {draft.cash_received > 0 && <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">Cash received (planned): <span className="font-semibold">{cad(draft.cash_received)}</span></p>}
        </section>
      </div>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Planned terms</h2>
          {isOpen && !editing && (
            <button type="button" onClick={() => startEdit(draft)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700">Edit</button>
          )}
        </div>
        {!editing ? (
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Proposed date</dt><dd className="mt-1 text-slate-900 dark:text-white">{draft.proposed_date ? formatCalendarDate(draft.proposed_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</dd></div>
            <div><dt className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Channel</dt><dd className="mt-1 text-slate-900 dark:text-white">{channelName ?? '—'}</dd></div>
            <div><dt className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Contact</dt><dd className="mt-1 text-slate-900 dark:text-white">{draft.contact_name ?? '—'}</dd></div>
            <div><dt className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Lead</dt><dd className="mt-1 text-slate-900 dark:text-white">{draft.lead_id != null ? `${leadName ?? 'Lead'} (#${draft.lead_id})${isOpen ? ' — completed only at finalization' : ''}` : isOpen ? 'Chosen when finalizing' : '—'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Notes</dt><dd className="mt-1 whitespace-pre-wrap text-slate-900 [overflow-wrap:anywhere] dark:text-white">{draft.notes ?? '—'}</dd></div>
          </dl>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm font-medium text-slate-700 dark:text-slate-300">Proposed date
              <input type="date" value={terms.proposed_date} onChange={(e) => setTerms({ ...terms, proposed_date: e.target.value })} className={inputClass} />
            </label>
            <label className="space-y-1 text-sm font-medium text-slate-700 dark:text-slate-300">Channel
              <select value={terms.deal_channel_id} onChange={(e) => setTerms({ ...terms, deal_channel_id: e.target.value })} className={inputClass}>
                <option value="">—</option>
                {channels.filter((c) => c.is_active || c.id === draft.deal_channel_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium text-slate-700 dark:text-slate-300">Contact
              <input type="text" value={terms.contact_name} onChange={(e) => setTerms({ ...terms, contact_name: e.target.value })} className={inputClass} />
            </label>
            <div />
            {draft.operation_type !== 'SELL' && (
              <label className="space-y-1 text-sm font-medium text-slate-700 dark:text-slate-300">Cash paid
                <input type="number" min="0" step="0.01" value={terms.cash_paid} onChange={(e) => setTerms({ ...terms, cash_paid: e.target.value })} className={inputClass} placeholder="0.00" />
              </label>
            )}
            {draft.operation_type !== 'BUY' && (
              <label className="space-y-1 text-sm font-medium text-slate-700 dark:text-slate-300">Cash received
                <input type="number" min="0" step="0.01" value={terms.cash_received} onChange={(e) => setTerms({ ...terms, cash_received: e.target.value })} className={inputClass} placeholder="0.00" />
              </label>
            )}
            <label className="space-y-1 text-sm font-medium text-slate-700 sm:col-span-2 dark:text-slate-300">Notes
              <textarea rows={4} value={terms.notes} onChange={(e) => setTerms({ ...terms, notes: e.target.value })} className={inputClass} />
            </label>
            {termsError && <p className="text-sm text-rose-700 sm:col-span-2">{termsError}</p>}
            <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setEditing(false)} className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100">Cancel</button>
              <button type="button" disabled={saving} onClick={saveTerms} className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400 dark:bg-white dark:text-slate-900">{saving ? 'Saving...' : 'Save terms'}</button>
            </div>
          </div>
        )}
      </section>

      {isOpen && (
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          {incomplete > 0 && (
            <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
              {incomplete === 1 ? '1 incoming item still needs' : `${incomplete} incoming items still need`} details before the {label.toLowerCase()} can be finalized.
            </p>
          )}
          {!confirmDiscard ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setConfirmDiscard(true)} className="inline-flex h-11 items-center justify-center rounded-xl border border-rose-200 bg-white px-5 text-sm font-medium text-rose-700 transition hover:bg-rose-50 dark:border-rose-800 dark:bg-slate-800 dark:text-rose-400">Discard draft</button>
              <button type="button" onClick={() => router.push(`/operations/drafts/${draft.id}/finalize`)} className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-medium text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100">
                Review &amp; finalize {label.toLowerCase()}
              </button>
            </div>
          ) : (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-300" data-testid="discard-confirm">
              <p className="font-semibold">Discard this draft?</p>
              <p className="mt-1">Nothing was recorded, so nothing is undone: items, listings, cash and leads stay as they are.</p>
              {newCreated > 0 && (
                <label className="mt-3 flex items-start gap-2">
                  <input type="checkbox" checked={removeNewItems} onChange={(e) => setRemoveNewItems(e.target.checked)} className="mt-0.5" />
                  <span>Also delete the {newCreated === 1 ? 'new item' : `${newCreated} new items`} created for this draft — only {newCreated === 1 ? 'if it has' : 'those with'} no photos, listings, leads, expenses or other operations; anything else is kept.</span>
                </label>
              )}
              {discardError && <p className="mt-2 font-medium">{discardError}</p>}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <button type="button" disabled={discarding} onClick={() => setConfirmDiscard(false)} className="inline-flex h-10 items-center justify-center rounded-xl border border-rose-200 bg-white px-4 text-sm font-medium text-rose-700 dark:border-rose-800 dark:bg-slate-800 dark:text-rose-300">Keep draft</button>
                <button type="button" disabled={discarding} onClick={runDiscard} className="inline-flex h-10 items-center justify-center rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-60">{discarding ? 'Discarding…' : 'Discard draft'}</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
    </Shell>
  );
}
