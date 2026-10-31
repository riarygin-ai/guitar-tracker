'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import BuyOperationForm from '@/components/BuyOperationForm';
import SellOperationForm from '@/components/SellOperationForm';
import TradeOperationForm from '@/components/TradeOperationForm';
import OperationDraftBadge from '@/components/OperationDraftBadge';
import { getInventorySearchItemsByIds } from '@/lib/supabase';
import { getOperationDraft, DRAFT_TYPE_LABEL, type OperationDraft } from '@/lib/operations/operationDraftsClient';
import { todayLocalDate } from '@/lib/dateUtils';
import type { InventorySearchItem } from '@/types';

// Finalization = the normal operation form, prefilled from the draft. Item
// values (Value In / Value Out) are left for the user to allocate; the
// planned date is used only if it is not in the future (the form's own rule).
export default function FinalizeOperationDraftPage() {
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

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">{children}</div>
    </div>
  );

  if (loading) return shell(<div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">Loading draft...</div>);
  if (error || !draft) return shell(<div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">{error ?? 'Draft not found.'}</div>);
  if (draft.status !== 'OPEN') {
    return shell(
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        This draft is {draft.status.toLowerCase()}.{' '}
        {draft.deal_id != null ? <Link href={`/operations/${draft.deal_id}`} className="font-semibold underline">Open operation #{draft.deal_id}</Link> : <Link href={`/operations/drafts/${draft.id}`} className="underline">Back to the draft</Link>}
      </div>,
    );
  }

  const label = DRAFT_TYPE_LABEL[draft.operation_type];
  const today = todayLocalDate();
  const plannedInFuture = draft.proposed_date != null && draft.proposed_date > today;
  const initialDate = draft.proposed_date && !plannedInFuture ? draft.proposed_date : '';
  const byDir = (dir: 'in' | 'out') => draft.operation_draft_items.filter((x) => x.direction === dir && items[x.item_id]).map((x) => items[x.item_id]);
  const outgoing = byDir('out');
  const incoming = byDir('in');

  return shell(
    <>
      <div className="rounded-3xl border-2 border-dashed border-amber-300 bg-white p-6 shadow-sm dark:border-amber-700 dark:bg-slate-800">
        <Link href={`/operations/drafts/${draft.id}`} className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">← Back to draft</Link>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <OperationDraftBadge type={draft.operation_type} />
          <span className="text-xs text-slate-500 dark:text-slate-400">#{draft.id}</span>
        </div>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">Finalize {label.toLowerCase()}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Review the items, set the actual date and allocate the values. Saving records the {label.toLowerCase()} exactly like a new
          operation: item statuses, listings, cash flow and the winning lead are updated now.
        </p>
        {plannedInFuture && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
            The planned date ({draft.proposed_date}) is in the future — finalize once the {label.toLowerCase()} has actually happened, with its real date.
          </p>
        )}
      </div>

      <div className="mt-6 space-y-6">
        {draft.operation_type === 'TRADE' && (
          <TradeOperationForm
            draftId={draft.id}
            draftLeadId={draft.lead_id}
            draftContactName={draft.contact_name}
            initialDealDate={initialDate}
            initialChannelId={draft.deal_channel_id}
            initialNotes={draft.notes ?? ''}
            initialCashPaid={draft.cash_paid || undefined}
            initialCashReceived={draft.cash_received || undefined}
            initialOutgoingItems={outgoing.map((item) => ({ item, value: '' }))}
            initialIncomingItems={incoming.map((item) => ({ item, value: '' }))}
          />
        )}
        {draft.operation_type === 'SELL' && (
          <SellOperationForm
            draftId={draft.id}
            draftLeadId={draft.lead_id}
            draftContactName={draft.contact_name}
            initialDealDate={initialDate}
            initialChannelId={draft.deal_channel_id}
            initialNotes={draft.notes ?? ''}
            // One item: the planned cash received is that item's sale value; several: the user allocates.
            initialItems={outgoing.map((item) => ({ item, value: outgoing.length === 1 ? draft.cash_received : 0 }))}
          />
        )}
        {draft.operation_type === 'BUY' && (
          <BuyOperationForm
            draftId={draft.id}
            initialDealDate={initialDate}
            initialChannelId={draft.deal_channel_id}
            initialNotes={draft.notes ?? ''}
            // One item: the planned cash paid is its cost; several: the user allocates.
            initialItems={incoming.map((item) => ({ item, cost: incoming.length === 1 ? draft.cash_paid : 0 }))}
          />
        )}
      </div>
    </>,
  );
}
