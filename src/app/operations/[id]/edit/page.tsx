'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import BuyOperationForm from '@/components/BuyOperationForm';
import SellOperationForm from '@/components/SellOperationForm';
import TradeOperationForm from '@/components/TradeOperationForm';
import ExpenseOperationForm from '@/components/ExpenseOperationForm';
import {
  getDealById,
  getDealItemsForDeal,
  getInventoryExpensesForDeal,
  getInventorySearchItemsByIds,
} from '@/lib/supabase';
import type { Deal, DealItem, InventoryExpense, InventorySearchItem } from '@/types';

const headerByType: Record<string, string> = {
  purchase: 'Edit Purchase',
  sale: 'Edit Sale',
  trade: 'Edit Trade',
  expense: 'Edit Expense',
};

export default function EditOperationPage() {
  const params = useParams();
  const dealId = Number(params.id);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [expense, setExpense] = useState<InventoryExpense | null>(null);
  const [itemById, setItemById] = useState<Record<number, InventorySearchItem>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      const dealResult = await getDealById(dealId);
      if (dealResult.error || !dealResult.data) {
        setError('Could not load operation details.');
        setLoading(false);
        return;
      }
      const loadedDeal = dealResult.data as Deal;
      setDeal(loadedDeal);

      if (loadedDeal.deal_type === 'expense') {
        const expensesResult = await getInventoryExpensesForDeal(dealId);
        const exp = (expensesResult.data ?? [])[0] ?? null;
        setExpense(exp);
        if (exp?.item_id != null) {
          const itemsResult = await getInventorySearchItemsByIds([exp.item_id]);
          const map: Record<number, InventorySearchItem> = {};
          (itemsResult.data ?? []).forEach((i) => { map[i.id] = i; });
          setItemById(map);
        }
      } else if (
        loadedDeal.deal_type === 'purchase' ||
        loadedDeal.deal_type === 'sale' ||
        loadedDeal.deal_type === 'trade'
      ) {
        const dealItemsResult = await getDealItemsForDeal(dealId);
        const items = dealItemsResult.data ?? [];
        setDealItems(items);
        const ids = items.map((di) => di.item_id);
        if (ids.length > 0) {
          const itemsResult = await getInventorySearchItemsByIds(ids);
          const map: Record<number, InventorySearchItem> = {};
          (itemsResult.data ?? []).forEach((i) => { map[i.id] = i; });
          setItemById(map);
        }
      } else {
        setError('This operation type cannot be edited.');
      }

      setLoading(false);
    }
    load();
  }, [dealId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            Loading operation...
          </div>
        </div>
      </div>
    );
  }

  if (error || !deal) {
    return (
      <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">
            {error ?? 'Could not load operation details.'}
          </div>
          <Link
            href={`/operations/${dealId}`}
            className="mt-4 inline-flex items-center text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            ← Back to operation
          </Link>
        </div>
      </div>
    );
  }

  const outgoing = dealItems.filter((di) => di.direction === 'out');
  const incoming = dealItems.filter((di) => di.direction === 'in');

  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <Link href={`/operations/${dealId}`} className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
            ← Back to operation
          </Link>
          <h1 className="mt-3 text-3xl font-semibold text-slate-900 dark:text-white">
            {headerByType[deal.deal_type] ?? 'Edit Operation'}
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Editing Operation #{deal.id}. Update the fields below and save to apply changes.
          </p>
        </div>

        <div className="mt-6 space-y-6">
          {deal.deal_type === 'purchase' && (
            <BuyOperationForm
              dealId={deal.id}
              initialDealDate={deal.deal_date}
              initialChannelId={deal.deal_channel_id}
              initialNotes={deal.notes ?? ''}
              initialItems={incoming
                .filter((di) => itemById[di.item_id] != null)
                .map((di) => ({ item: itemById[di.item_id], cost: Number(di.total_value ?? 0) }))}
            />
          )}

          {deal.deal_type === 'sale' && (
            <SellOperationForm
              dealId={deal.id}
              initialDealDate={deal.deal_date}
              initialChannelId={deal.deal_channel_id}
              initialNotes={deal.notes ?? ''}
              initialItems={outgoing
                .filter((di) => itemById[di.item_id] != null)
                .map((di) => ({ item: itemById[di.item_id], value: Number(di.total_value ?? 0) }))}
            />
          )}

          {deal.deal_type === 'trade' && (
            <TradeOperationForm
              dealId={deal.id}
              initialDealDate={deal.deal_date}
              initialChannelId={deal.deal_channel_id}
              initialNotes={deal.notes ?? ''}
              initialCashPaid={Number(deal.cash_paid ?? 0)}
              initialCashReceived={Number(deal.cash_received ?? 0)}
              initialOutgoingItems={outgoing
                .filter((di) => itemById[di.item_id] != null)
                .map((di) => ({ item: itemById[di.item_id], value: String(di.total_value ?? 0) }))}
              initialIncomingItems={incoming
                .filter((di) => itemById[di.item_id] != null)
                .map((di) => ({ item: itemById[di.item_id], value: String(di.total_value ?? 0) }))}
            />
          )}

          {deal.deal_type === 'expense' && (
            <ExpenseOperationForm
              dealId={deal.id}
              initialExpenseDate={deal.deal_date}
              initialAmount={Number(deal.cash_paid ?? 0)}
              initialNotes={deal.notes ?? ''}
              initialItem={expense?.item_id != null ? (itemById[expense.item_id] ?? null) : null}
            />
          )}
        </div>
      </div>
    </div>
  );
}
