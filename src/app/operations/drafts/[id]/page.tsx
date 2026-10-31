'use client';

// An operation draft opens in the NORMAL Buy / Sell / Trade form (draft mode),
// prefilled from the saved draft — the same items, economics, Lead picker and
// validation as Create Operation, with a Draft badge and Save draft /
// Finalize / Discard draft. No second operation UI.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import BuyOperationForm from '@/components/BuyOperationForm';
import SellOperationForm from '@/components/SellOperationForm';
import TradeOperationForm from '@/components/TradeOperationForm';
import OperationDraftBadge from '@/components/OperationDraftBadge';
import type { DraftFormContext } from '@/components/operations/DraftOperationControls';
import { getInventorySearchItemsByIds } from '@/lib/supabase';
import { getOperationDraft, DRAFT_TYPE_LABEL, type OperationDraft } from '@/lib/operations/operationDraftsClient';
import type { InventorySearchItem } from '@/types';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}

export default function OperationDraftPage() {
  const params = useParams();
  const draftId = Number(params.id);
  const [draft, setDraft] = useState<OperationDraft | null>(null);
  const [items, setItems] = useState<Record<number, InventorySearchItem>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const d = await getOperationDraft(draftId);
      if (d.error || !d.data) { setError(d.error ? 'Could not load the draft.' : 'Draft not found.'); setLoading(false); return; }
      const r = await getInventorySearchItemsByIds(d.data.operation_draft_items.map((x) => x.item_id));
      setItems(Object.fromEntries(((r.data ?? []) as InventorySearchItem[]).map((i) => [i.id, i])));
      setDraft(d.data);
      setLoading(false);
    })();
  }, [draftId]);

  if (loading) return <Shell><div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">Loading draft...</div></Shell>;
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

  const label = DRAFT_TYPE_LABEL[draft.operation_type];
  const isOpen = draft.status === 'OPEN';
  const rows = (dir: 'in' | 'out') => draft.operation_draft_items.filter((x) => x.direction === dir && items[x.item_id]);
  const outgoing = rows('out');
  const incoming = rows('in');
  const context: DraftFormContext = {
    id: draft.id, type: draft.operation_type, leadId: draft.lead_id, contactName: draft.contact_name,
    createdItemIds: draft.operation_draft_items.filter((x) => x.created_by_draft).map((x) => x.item_id),
  };
  const valueText = (v: number | null) => (v != null ? String(v) : '');

  return (
    <Shell>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <Link href="/operations" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Operations</Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">{label}</h1>
          <OperationDraftBadge type={draft.operation_type} />
          <span className="text-xs text-slate-500 dark:text-slate-400">#{draft.id}</span>
        </div>
        {isOpen ? (
          <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400" data-testid="draft-notice">
            Not recorded yet — statuses, listings, cash and leads change only when you finalize.
            {draft.source === 'MCP' ? ' Captured from ChatGPT' : ''}{draft.contact_name ? ` · contact: ${draft.contact_name}` : ''}
          </p>
        ) : draft.status === 'FINALIZED' && draft.deal_id != null ? (
          <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
            Finalized as <Link href={`/operations/${draft.deal_id}`} className="font-semibold underline">operation #{draft.deal_id}</Link>.
          </p>
        ) : (
          <div className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300" data-testid="discard-result">
            <p>Discarded — it never affected inventory, listings, cash or leads.</p>
            {draft.discard_result?.removed_item_ids.length ? <p>Deleted the new items created for it: {draft.discard_result.removed_item_ids.map((x) => `#${x}`).join(', ')}.</p> : null}
            {draft.discard_result?.kept_items.map((k) => <p key={k.item_id}>Kept item <Link href={`/inventory/${k.item_id}`} className="underline">#{k.item_id}</Link> ({k.reasons.join(', ')}).</p>)}
          </div>
        )}
      </div>

      {isOpen && (
        <div className="mt-6 space-y-6" key={draft.updated_at}>
          {draft.operation_type === 'TRADE' && (
            <TradeOperationForm
              draft={context}
              initialDealDate={draft.proposed_date ?? ''}
              initialChannelId={draft.deal_channel_id}
              initialNotes={draft.notes ?? ''}
              initialCashPaid={draft.cash_paid || undefined}
              initialCashReceived={draft.cash_received || undefined}
              initialOutgoingItems={outgoing.map((x) => ({ item: items[x.item_id], value: valueText(x.planned_value) }))}
              initialIncomingItems={incoming.map((x) => ({ item: items[x.item_id], value: valueText(x.planned_value) }))}
            />
          )}
          {draft.operation_type === 'SELL' && (
            <SellOperationForm
              draft={context}
              initialDealDate={draft.proposed_date ?? ''}
              initialChannelId={draft.deal_channel_id}
              initialNotes={draft.notes ?? ''}
              // Saved values; for a single item never valued yet, the planned cash received is its sale price.
              initialItems={outgoing.map((x) => ({ item: items[x.item_id], value: x.planned_value ?? (outgoing.length === 1 ? draft.cash_received : 0) }))}
            />
          )}
          {draft.operation_type === 'BUY' && (
            <BuyOperationForm
              draft={context}
              initialDealDate={draft.proposed_date ?? ''}
              initialChannelId={draft.deal_channel_id}
              initialNotes={draft.notes ?? ''}
              // Saved costs; for a single item never valued yet, the planned cash paid is its cost.
              initialItems={incoming.map((x) => ({ item: items[x.item_id], cost: x.planned_value ?? (incoming.length === 1 ? draft.cash_paid : 0) }))}
            />
          )}
        </div>
      )}
    </Shell>
  );
}
