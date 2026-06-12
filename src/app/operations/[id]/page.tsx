'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  getDealById,
  getBrands,
  getInventoryItemsWithValue,
  getDealItemsForDeal,
  getCashFlowsForDeal,
  getInventoryExpensesForDeal,
  getInventoryExpensesByItemIds,
  updateDeal,
  updateCashFlow,
  updateInventoryExpense,
  recalculateCashFlowBalancesFrom,
  editTradeOperation,
  editBuyOperation,
  getDisplayPhotosForItems,
  searchInventoryItems,
} from '@/lib/supabase';
import InventoryForm from '@/components/InventoryForm';
import type { Brand, Deal, DealItem, InventoryItem, InventoryItemWithValue, CashFlow, InventoryExpense } from '@/types';

function ItemCardLink({ href, clickable, children }: { href: string; clickable: boolean; children: React.ReactNode }) {
  const base = 'rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700';
  if (clickable) {
    return (
      <Link href={href} className={`block ${base} transition-colors hover:border-slate-300 hover:bg-white dark:hover:border-slate-500 dark:hover:bg-slate-600`}>
        {children}
      </Link>
    );
  }
  return <div className={base}>{children}</div>;
}

export default function OperationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const dealId = Number(params.id);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [items, setItems] = useState<InventoryItemWithValue[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [cashFlows, setCashFlows] = useState<CashFlow[]>([]);
  const [expenses, setExpenses] = useState<InventoryExpense[]>([]);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const [itemExpensesByItemId, setItemExpensesByItemId] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Edit state — existing fields
  const [editedDeal, setEditedDeal] = useState<Partial<Deal> | null>(null);
  const [editedCashFlows, setEditedCashFlows] = useState<Record<number, Partial<CashFlow>>>({});
  const [editedExpenses, setEditedExpenses] = useState<Record<number, Partial<InventoryExpense>>>({});
  const [editedDealItems, setEditedDealItems] = useState<Record<number, { total_value: number }>>({});

  // Trade item add / remove state
  const [pendingOutgoing, setPendingOutgoing] = useState<{ item: InventoryItem; value: number }[]>([]);
  const [pendingIncoming, setPendingIncoming] = useState<{ item: InventoryItem; value: number }[]>([]);
  const [removedDealItemIds, setRemovedDealItemIds] = useState<number[]>([]);
  const [showAddOutgoing, setShowAddOutgoing] = useState(false);
  const [showAddIncoming, setShowAddIncoming] = useState(false);
  const [addOutgoingQuery, setAddOutgoingQuery] = useState('');
  const [addIncomingQuery, setAddIncomingQuery] = useState('');
  const [addOutgoingResults, setAddOutgoingResults] = useState<InventoryItem[]>([]);
  const [addIncomingResults, setAddIncomingResults] = useState<InventoryItem[]>([]);
  const [addSearching, setAddSearching] = useState<'out' | 'in' | null>(null);
  const [showNewIncomingForm, setShowNewIncomingForm] = useState(false);
  const addSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [dealResult, brandsResult, itemsResult, dealItemsResult, cashFlowsResult, expensesResult] = await Promise.all([
      getDealById(dealId),
      getBrands(),
      getInventoryItemsWithValue(),
      getDealItemsForDeal(dealId),
      getCashFlowsForDeal(dealId),
      getInventoryExpensesForDeal(dealId),
    ]);

    setLoading(false);

    if (dealResult.error || !dealResult.data) {
      setError('Could not load operation details.');
      return;
    }

    setDeal(dealResult.data);
    setBrands(brandsResult.data || []);
    setItems(itemsResult.data || []);
    setDealItems(dealItemsResult.data || []);
    setCashFlows(cashFlowsResult.data || []);
    setExpenses(expensesResult.data || []);

    // Load photos for deal items + expense-linked items (non-blocking)
    const dealItemIds = (dealItemsResult.data || []).map((di: DealItem) => di.item_id);
    const expenseItemIds = (expensesResult.data || [])
      .filter((exp: any) => exp.item_id != null)
      .map((exp: any) => exp.item_id as number);
    const allPhotoItemIds = Array.from(new Set([...dealItemIds, ...expenseItemIds]));
    if (allPhotoItemIds.length > 0) {
      getDisplayPhotosForItems(allPhotoItemIds).then(setPhotoByItemId);
    }

    // Load expenses for all deal items (non-blocking) — outgoing: realized gain; incoming: potential reward
    const outgoingItemIds = (dealItemsResult.data || []).map((di: any) => di.item_id as number);
    if (outgoingItemIds.length > 0) {
      getInventoryExpensesByItemIds(outgoingItemIds).then((result) => {
        if (!result.error && result.data) {
          const map: Record<number, number> = {};
          for (const exp of result.data) {
            if (exp.item_id != null) {
              map[exp.item_id] = (map[exp.item_id] ?? 0) + exp.amount;
            }
          }
          setItemExpensesByItemId(map);
        }
      });
    }
  }, [dealId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const brandMap = Object.fromEntries(brands.map((b) => [b.id, b.name]));
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));

  const handleAddSearch = (query: string, direction: 'out' | 'in') => {
    if (direction === 'out') setAddOutgoingQuery(query);
    else setAddIncomingQuery(query);

    if (addSearchTimerRef.current) clearTimeout(addSearchTimerRef.current);

    if (!query.trim()) {
      if (direction === 'out') setAddOutgoingResults([]);
      else setAddIncomingResults([]);
      setAddSearching(null);
      return;
    }

    setAddSearching(direction);
    addSearchTimerRef.current = setTimeout(async () => {
      const statuses = direction === 'out'
        ? ['owned', 'listed']
        : deal?.deal_type === 'purchase' ? ['new'] : undefined;
      const result = await searchInventoryItems(query, statuses);
      setAddSearching(null);
      const found = (result.data ?? []) as InventoryItem[];
      if (direction === 'out') setAddOutgoingResults(found);
      else setAddIncomingResults(found);
    }, 300);
  };

  const resetAddRemoveState = () => {
    setPendingOutgoing([]);
    setPendingIncoming([]);
    setRemovedDealItemIds([]);
    setShowAddOutgoing(false);
    setShowAddIncoming(false);
    setAddOutgoingQuery('');
    setAddIncomingQuery('');
    setAddOutgoingResults([]);
    setAddIncomingResults([]);
    setAddSearching(null);
    setShowNewIncomingForm(false);
  };

  const handleEditMode = () => {
    if (editMode) {
      setEditMode(false);
      setEditedDeal(null);
      setEditedCashFlows({});
      setEditedExpenses({});
      setEditedDealItems({});
      resetAddRemoveState();
    } else {
      setEditMode(true);
      setSuccessMessage(null);
      if (deal) setEditedDeal({ ...deal });
      cashFlows.forEach((cf) => {
        setEditedCashFlows((prev) => ({ ...prev, [cf.id]: { ...cf } }));
      });
      expenses.forEach((exp) => {
        setEditedExpenses((prev) => ({ ...prev, [exp.id]: { ...exp } }));
      });
      dealItems.forEach((di) => {
        setEditedDealItems((prev) => ({
          ...prev,
          [di.id]: { total_value: Number(di.total_value ?? 0) },
        }));
      });
    }
  };

  const handleSave = async () => {
    if (!deal || saving) return;

    setSaving(true);
    setError(null);

    try {
      if (deal.deal_type === 'trade') {
        const outgoing = dealItems.filter((di) => di.direction === 'out' && !removedDealItemIds.includes(di.id));
        const incoming = dealItems.filter((di) => di.direction === 'in' && !removedDealItemIds.includes(di.id));
        const cashFlowRow = cashFlows[0] ?? null;

        const cashPaid = Number(editedDeal?.cash_paid ?? deal.cash_paid ?? 0);
        const cashReceived = Number(editedDeal?.cash_received ?? deal.cash_received ?? 0);

        const outgoingTotal =
          outgoing.reduce((sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)), 0) +
          pendingOutgoing.reduce((sum, p) => sum + p.value, 0);
        const incomingTotal =
          incoming.reduce((sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)), 0) +
          pendingIncoming.reduce((sum, p) => sum + p.value, 0);

        if (Math.round((outgoingTotal + cashPaid) * 100) !== Math.round((incomingTotal + cashReceived) * 100)) {
          setSaving(false);
          setError('Trade does not balance. Total given must equal total received.');
          return;
        }

        const result = await editTradeOperation({
          dealId: deal.id,
          dealDate: editedDeal?.deal_date ?? deal.deal_date,
          channel: editedDeal?.channel ?? deal.channel ?? null,
          notes: editedDeal?.notes ?? deal.notes ?? null,
          cashPaid,
          cashReceived,
          outgoingItems: [
            ...outgoing.map((di) => ({
              item_id: di.item_id,
              total_value: editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0),
            })),
            ...pendingOutgoing.map((p) => ({ item_id: p.item.id, total_value: p.value })),
          ],
          incomingItems: [
            ...incoming.map((di) => ({
              item_id: di.item_id,
              total_value: editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0),
            })),
            ...pendingIncoming.map((p) => ({ item_id: p.item.id, total_value: p.value })),
          ],
          cfTransactionDate: cashFlowRow
            ? (editedCashFlows[cashFlowRow.id]?.transaction_date ?? cashFlowRow.transaction_date)
            : null,
          cfDescription: cashFlowRow
            ? (editedCashFlows[cashFlowRow.id]?.description ?? cashFlowRow.description ?? null)
            : null,
        });

        if (result.error) {
          setSaving(false);
          setError('Could not save trade: ' + result.error.message);
          return;
        }
      } else if (deal.deal_type === 'purchase') {
        const kept = dealItems.filter((di) => di.direction === 'in' && !removedDealItemIds.includes(di.id));
        const cashFlowRow = cashFlows[0] ?? null;

        const result = await editBuyOperation({
          dealId: deal.id,
          dealDate: editedDeal?.deal_date ?? deal.deal_date,
          channel: editedDeal?.channel ?? deal.channel ?? null,
          notes: editedDeal?.notes ?? deal.notes ?? null,
          incomingItems: [
            ...kept.map((di) => ({
              item_id: di.item_id,
              total_value: editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0),
            })),
            ...pendingIncoming.map((p) => ({ item_id: p.item.id, total_value: p.value })),
          ],
          cfDescription: cashFlowRow
            ? (editedCashFlows[cashFlowRow.id]?.description ?? cashFlowRow.description ?? null)
            : null,
        });

        if (result.error) {
          setSaving(false);
          setError('Could not save purchase: ' + result.error.message);
          return;
        }
      } else {
        // Sale / expense: individual field updates
        const cashFlowsWithDateChange: { id: number; oldDate: string; newDate: string }[] = [];

        if (editedDeal && (editedDeal.deal_date !== deal.deal_date || editedDeal.channel !== deal.channel || editedDeal.notes !== deal.notes)) {
          const dealUpdates: Partial<Deal> = {};
          if (editedDeal.deal_date !== deal.deal_date) dealUpdates.deal_date = editedDeal.deal_date;
          if (editedDeal.channel !== deal.channel) dealUpdates.channel = editedDeal.channel;
          if (editedDeal.notes !== deal.notes) dealUpdates.notes = editedDeal.notes;

          const dealResult = await updateDeal(deal.id, dealUpdates);
          if (dealResult.error) {
            setSaving(false);
            setError('Could not update deal.');
            return;
          }
          setDeal(dealResult.data || deal);
        }

        for (const [cfIdStr, edits] of Object.entries(editedCashFlows)) {
          const cfId = Number(cfIdStr);
          const original = cashFlows.find((cf) => cf.id === cfId);
          if (!original) continue;

          if (edits.transaction_date !== original.transaction_date || edits.description !== original.description) {
            const cfUpdates: Partial<CashFlow> = {};
            if (edits.transaction_date && edits.transaction_date !== original.transaction_date) {
              cfUpdates.transaction_date = edits.transaction_date;
              cashFlowsWithDateChange.push({
                id: cfId,
                oldDate: original.transaction_date,
                newDate: edits.transaction_date,
              });
            }
            if (edits.description !== original.description) cfUpdates.description = edits.description;

            const cfResult = await updateCashFlow(cfId, cfUpdates);
            if (cfResult.error) {
              setSaving(false);
              setError('Could not update cash flow.');
              return;
            }

            setCashFlows((prev) =>
              prev.map((cf) => (cf.id === cfId ? cfResult.data || cf : cf))
            );
          }
        }

        for (const [expIdStr, edits] of Object.entries(editedExpenses)) {
          const expId = Number(expIdStr);
          const original = expenses.find((exp) => exp.id === expId);
          if (!original) continue;

          if (edits.expense_date !== original.expense_date || edits.notes !== original.notes) {
            const expUpdates: Partial<InventoryExpense> = {};
            if (edits.expense_date !== original.expense_date) expUpdates.expense_date = edits.expense_date;
            if (edits.notes !== original.notes) expUpdates.notes = edits.notes;

            const expResult = await updateInventoryExpense(expId, expUpdates);
            if (expResult.error) {
              setSaving(false);
              setError('Could not update expense.');
              return;
            }

            setExpenses((prev) =>
              prev.map((exp) => (exp.id === expId ? expResult.data || exp : exp))
            );
          }
        }

        for (const { id: cfId } of cashFlowsWithDateChange) {
          await recalculateCashFlowBalancesFrom(cfId);
        }
      }

      await loadData();
      setEditedDeal(null);
      setEditedCashFlows({});
      setEditedExpenses({});
      setEditedDealItems({});
      resetAddRemoveState();
      setSaving(false);
      setEditMode(false);
      setSuccessMessage('Changes saved successfully.');
    } catch (err) {
      setSaving(false);
      setError('An error occurred while saving.');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
            Loading operation details...
          </div>
        </div>
      </div>
    );
  }

  if (error && !deal) {
    return (
      <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!deal) {
    return null;
  }

  const getDealTypeLabel = (type: string) => type.charAt(0).toUpperCase() + type.slice(1);

  const getDealTypeColor = (dealType: string) => {
    switch (dealType) {
      case 'purchase':
        return 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-300';
      case 'sale':
        return 'bg-green-50 border-green-200 text-green-700 dark:bg-green-900/30 dark:border-green-700 dark:text-green-300';
      case 'trade':
        return 'bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-900/30 dark:border-purple-700 dark:text-purple-300';
      case 'expense':
        return 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/30 dark:border-red-700 dark:text-red-300';
      default:
        return 'bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200';
    }
  };

  const formatCurrency = (value: number | null) => {
    if (value === null) return '$0.00';
    return `$${Math.abs(value).toFixed(2)}`;
  };

  const outgoingItems = dealItems.filter((di) => di.direction === 'out');
  const incomingItems = dealItems.filter((di) => di.direction === 'in');

  const tradeEditCashPaid = Number(editedDeal?.cash_paid ?? deal.cash_paid ?? 0);
  const tradeEditCashReceived = Number(editedDeal?.cash_received ?? deal.cash_received ?? 0);
  const tradeEditOutgoingTotal =
    outgoingItems
      .filter((di) => !removedDealItemIds.includes(di.id))
      .reduce((sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)), 0) +
    pendingOutgoing.reduce((sum, p) => sum + p.value, 0);
  const tradeEditIncomingTotal =
    incomingItems
      .filter((di) => !removedDealItemIds.includes(di.id))
      .reduce((sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)), 0) +
    pendingIncoming.reduce((sum, p) => sum + p.value, 0);
  const tradeGiven = tradeEditOutgoingTotal + tradeEditCashPaid;
  const tradeReceived = tradeEditIncomingTotal + tradeEditCashReceived;
  const tradeIsBalanced = Math.round(tradeGiven * 100) === Math.round(tradeReceived * 100);

  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <Link href="/operations" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                ← Back to operations
              </Link>
              <div className="mt-3 flex items-center gap-3">
                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                  {getDealTypeLabel(deal.deal_type)}
                </div>
                <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">Operation #{deal.id}</h1>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={handleEditMode}
                className={`inline-flex items-center justify-center rounded-2xl px-5 py-2 text-sm font-semibold transition ${
                  editMode
                    ? 'bg-slate-200 text-slate-900 hover:bg-slate-300 dark:bg-slate-600 dark:text-white dark:hover:bg-slate-500'
                    : 'bg-slate-100 text-slate-900 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600'
                }`}
              >
                {editMode ? 'Cancel edit' : 'Edit'}
              </button>
              {editMode && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || (editMode && deal.deal_type === 'trade' && !tradeIsBalanced)}
                  className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-400 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100 dark:disabled:bg-slate-600 dark:disabled:text-slate-400"
                >
                  {saving ? 'Saving...' : 'Save changes'}
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-3xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 shadow-sm">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="mt-6 rounded-3xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 shadow-sm">
            {successMessage}
          </div>
        )}

        {/* Deal Details */}
        <div className="mt-6 space-y-6">
          {/* Compact Transaction Header */}
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Date</p>
                {editMode ? (
                  <input
                    type="date"
                    value={editedDeal?.deal_date ?? deal.deal_date}
                    onChange={(e) => setEditedDeal({ ...editedDeal, deal_date: e.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{new Date(deal.deal_date).toLocaleDateString()}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Channel</p>
                {editMode ? (
                  <input
                    type="text"
                    value={editedDeal?.channel ?? deal.channel ?? ''}
                    onChange={(e) => setEditedDeal({ ...editedDeal, channel: e.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{deal.channel || '—'}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash Paid</p>
                {editMode && deal.deal_type === 'trade' ? (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={Number(editedDeal?.cash_paid ?? deal.cash_paid ?? 0)}
                    onChange={(e) => setEditedDeal({ ...editedDeal, cash_paid: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(deal.cash_paid)}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash Received</p>
                {editMode && deal.deal_type === 'trade' ? (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={Number(editedDeal?.cash_received ?? deal.cash_received ?? 0)}
                    onChange={(e) => setEditedDeal({ ...editedDeal, cash_received: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(deal.cash_received)}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Notes</p>
                {editMode ? (
                  <textarea
                    value={editedDeal?.notes ?? deal.notes ?? ''}
                    onChange={(e) => setEditedDeal({ ...editedDeal, notes: e.target.value })}
                    rows={2}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                ) : (
                  <p className="mt-2 text-sm text-slate-900 line-clamp-2 dark:text-white">{deal.notes || '—'}</p>
                )}
              </div>
            </div>
            {editMode && deal.deal_type === 'trade' && (
              <div className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">Total given</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(tradeGiven)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">Total received</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(tradeReceived)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-slate-400">Trade balance</p>
                  <p className={`mt-1 text-sm font-semibold ${tradeIsBalanced ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {tradeIsBalanced ? 'Balanced' : `$${Math.abs(tradeGiven - tradeReceived).toFixed(2)} off`}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Gave / Outgoing Items */}
          {(outgoingItems.length > 0 || (editMode && deal.deal_type === 'trade')) && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Gave / Outgoing</h2>
                {editMode && deal.deal_type === 'trade' && !showAddOutgoing && (
                  <button
                    type="button"
                    onClick={() => setShowAddOutgoing(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span className="hidden sm:inline">Add outgoing item</span>
                  </button>
                )}
              </div>
              <div className="mt-4 space-y-3">
                {/* Existing items (excluding removed) */}
                {outgoingItems
                  .filter((di) => !removedDealItemIds.includes(di.id))
                  .map((di) => {
                    const item = itemMap[di.item_id];
                    if (!item) return null;
                    const brand = brandMap[item.brand_id] || 'Unknown';
                    const valueIn = Number(item.value_in ?? 0);
                    const valueOut = editMode && deal.deal_type === 'trade'
                      ? (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0))
                      : Number(di.total_value ?? 0);
                    const itemExpenses = itemExpensesByItemId[item.id] ?? 0;
                    const realizedGain = valueOut - valueIn - itemExpenses;
                    return (
                      <ItemCardLink key={di.id} href={`/inventory/${item.id}`} clickable={!editMode}>
                        <div className="flex gap-4">
                          {photoByItemId[item.id] && (
                            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
                              <Image src={photoByItemId[item.id]} alt={`${brand} ${item.model}`} fill className="object-cover" unoptimized sizes="80px" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold text-slate-900 dark:text-white">{brand} {item.model}</p>
                                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                                  {item.year && `${item.year} • `}{item.color && `${item.color} • `}{item.condition}
                                </p>
                              </div>
                              {editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase') && (
                                <button
                                  type="button"
                                  onClick={() => setRemovedDealItemIds((prev) => [...prev, di.id])}
                                  title="Remove from operation"
                                  className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                              )}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Value In</p>
                                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(valueIn)}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Value Out</p>
                                {editMode && deal.deal_type === 'trade' ? (
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)}
                                    onChange={(e) =>
                                      setEditedDealItems((prev) => ({
                                        ...prev,
                                        [di.id]: { total_value: Number(e.target.value) },
                                      }))
                                    }
                                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                                  />
                                ) : (
                                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(valueOut)}</p>
                                )}
                              </div>
                              {itemExpenses > 0 && (
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Expenses</p>
                                  <p className="mt-1 text-sm font-semibold text-rose-600">−{formatCurrency(itemExpenses)}</p>
                                </div>
                              )}
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Realized Gain</p>
                                <p className={`mt-1 text-sm font-semibold ${realizedGain > 0 ? 'text-green-600' : realizedGain < 0 ? 'text-red-600' : 'text-slate-900 dark:text-white'}`}>
                                  {formatCurrency(realizedGain)}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </ItemCardLink>
                    );
                  })}

                {/* Pending new outgoing items */}
                {pendingOutgoing.map((p, i) => (
                  <div key={`pending-out-${i}`} className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-700/50 dark:bg-teal-900/10">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-teal-700 dark:text-teal-400">
                          {deal.deal_type === 'purchase' ? 'Adding to purchase' : 'Adding to trade'}
                        </p>
                        <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-white">
                          {brandMap[p.item.brand_id] || 'Unknown'} {p.item.model}
                          {p.item.year ? ` (${p.item.year})` : ''}
                        </p>
                        {p.item.condition && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{p.item.condition}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => setPendingOutgoing((prev) => prev.filter((_, idx) => idx !== i))}
                        title="Remove"
                        className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Value Out</p>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={p.value}
                        onChange={(e) =>
                          setPendingOutgoing((prev) =>
                            prev.map((entry, idx) => idx === i ? { ...entry, value: Number(e.target.value) } : entry)
                          )
                        }
                        className="mt-1 w-40 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                      />
                    </div>
                  </div>
                ))}

                {/* Add outgoing search panel */}
                {editMode && deal.deal_type === 'trade' && showAddOutgoing && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Add an owned item as outgoing</p>
                      <button
                        type="button"
                        onClick={() => { setShowAddOutgoing(false); setAddOutgoingQuery(''); setAddOutgoingResults([]); }}
                        className="rounded-lg p-1 text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                    <div className="relative">
                      <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      <input
                        type="text"
                        value={addOutgoingQuery}
                        onChange={(e) => handleAddSearch(e.target.value, 'out')}
                        placeholder="Search owned inventory..."
                        className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-9 pr-4 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                      />
                      {addSearching === 'out' && (
                        <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                        </div>
                      )}
                    </div>
                    {addOutgoingResults.length > 0 && (
                      <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
                        {addOutgoingResults.map((res) => {
                          const alreadyIn = dealItems.some((di) => di.item_id === res.id && !removedDealItemIds.includes(di.id));
                          const alreadyPending = pendingOutgoing.some((p) => p.item.id === res.id);
                          const disabled = alreadyIn || alreadyPending;
                          return (
                            <button
                              key={res.id}
                              type="button"
                              disabled={disabled}
                              onClick={() => {
                                setPendingOutgoing((prev) => [...prev, { item: res, value: 0 }]);
                                setShowAddOutgoing(false);
                                setAddOutgoingQuery('');
                                setAddOutgoingResults([]);
                              }}
                              className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left text-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                            >
                              <p className="font-medium text-slate-900 dark:text-white">
                                {brandMap[res.brand_id] || 'Unknown'} {res.model}
                                {res.year ? ` (${res.year})` : ''}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                                {res.status}{res.condition ? ` · ${res.condition}` : ''}
                                {disabled ? ' · already in trade' : ''}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {addOutgoingQuery && addOutgoingResults.length === 0 && addSearching === null && (
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No owned items found for &ldquo;{addOutgoingQuery}&rdquo;</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Received / Incoming Items */}
          {(incomingItems.length > 0 || (editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase'))) && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {deal.deal_type === 'purchase' ? 'Purchased Items' : 'Received / Incoming'}
                </h2>
                {editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase') && !showAddIncoming && (
                  <button
                    type="button"
                    onClick={() => setShowAddIncoming(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span className="hidden sm:inline">{deal.deal_type === 'purchase' ? 'Add item' : 'Add incoming item'}</span>
                  </button>
                )}
              </div>
              <div className="mt-4 space-y-3">
                {/* Existing items (excluding removed) */}
                {incomingItems
                  .filter((di) => !removedDealItemIds.includes(di.id))
                  .map((di) => {
                    const item = itemMap[di.item_id];
                    if (!item) return null;
                    const brand = brandMap[item.brand_id] || 'Unknown';
                    const valueIn = editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase')
                      ? (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0))
                      : Number(di.total_value ?? 0);
                    const estimatedSold = Number(item.estimated_sold_value ?? 0);
                    const incomingItemExpenses = itemExpensesByItemId[item.id] ?? 0;
                    const potentialReward = estimatedSold - valueIn - incomingItemExpenses;
                    return (
                      <ItemCardLink key={di.id} href={`/inventory/${item.id}`} clickable={!editMode}>
                        <div className="flex gap-4">
                          {photoByItemId[item.id] && (
                            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
                              <Image src={photoByItemId[item.id]} alt={`${brand} ${item.model}`} fill className="object-cover" unoptimized sizes="80px" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold text-slate-900 dark:text-white">{brand} {item.model}</p>
                                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                                  {item.year && `${item.year} • `}{item.color && `${item.color} • `}{item.condition}
                                </p>
                              </div>
                              {editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase') && (
                                <button
                                  type="button"
                                  onClick={() => setRemovedDealItemIds((prev) => [...prev, di.id])}
                                  title="Remove from operation"
                                  className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                </button>
                              )}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">
                                  {deal.deal_type === 'purchase' ? 'Purchase Cost' : 'Value In'}
                                </p>
                                {editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase') ? (
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)}
                                    onChange={(e) =>
                                      setEditedDealItems((prev) => ({
                                        ...prev,
                                        [di.id]: { total_value: Number(e.target.value) },
                                      }))
                                    }
                                    className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                                  />
                                ) : (
                                  <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(valueIn)}</p>
                                )}
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Estimated Sold</p>
                                <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(estimatedSold)}</p>
                              </div>
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Potential Reward</p>
                                <p className={`mt-1 text-sm font-semibold ${potentialReward > 0 ? 'text-green-600' : potentialReward < 0 ? 'text-red-600' : 'text-slate-900 dark:text-white'}`}>
                                  {formatCurrency(potentialReward)}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </ItemCardLink>
                    );
                  })}

                {/* Pending new incoming items */}
                {pendingIncoming.map((p, i) => (
                  <div key={`pending-in-${i}`} className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-700/50 dark:bg-teal-900/10">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-teal-700 dark:text-teal-400">
                          {deal.deal_type === 'purchase' ? 'Adding to purchase' : 'Adding to trade'}
                        </p>
                        <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-white">
                          {brandMap[p.item.brand_id] || 'Unknown'} {p.item.model}
                          {p.item.year ? ` (${p.item.year})` : ''}
                        </p>
                        {p.item.condition && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{p.item.condition}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => setPendingIncoming((prev) => prev.filter((_, idx) => idx !== i))}
                        title="Remove"
                        className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">
                        {deal.deal_type === 'purchase' ? 'Purchase Cost' : 'Value In'}
                      </p>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={p.value}
                        onChange={(e) =>
                          setPendingIncoming((prev) =>
                            prev.map((entry, idx) => idx === i ? { ...entry, value: Number(e.target.value) } : entry)
                          )
                        }
                        className="mt-1 w-40 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                      />
                    </div>
                  </div>
                ))}

                {/* Add incoming search panel */}
                {editMode && (deal.deal_type === 'trade' || deal.deal_type === 'purchase') && showAddIncoming && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                        {deal.deal_type === 'purchase' ? 'Add a purchased item' : 'Add an incoming item'}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddIncoming(false);
                          setAddIncomingQuery('');
                          setAddIncomingResults([]);
                          setShowNewIncomingForm(false);
                        }}
                        className="rounded-lg p-1 text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>

                    {!showNewIncomingForm && (
                      <>
                        <div className="relative">
                          <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                          </svg>
                          <input
                            type="text"
                            value={addIncomingQuery}
                            onChange={(e) => handleAddSearch(e.target.value, 'in')}
                            placeholder="Search inventory..."
                            className="w-full rounded-2xl border border-slate-200 bg-white py-2.5 pl-9 pr-4 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                          />
                          {addSearching === 'in' && (
                            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                            </div>
                          )}
                        </div>
                        {addIncomingResults.length > 0 && (
                          <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
                            {addIncomingResults.map((res) => {
                              const alreadyIn = dealItems.some((di) => di.item_id === res.id && !removedDealItemIds.includes(di.id));
                              const alreadyPending = pendingIncoming.some((p) => p.item.id === res.id);
                              const invalidStatus = res.status === 'sold' || res.status === 'traded';
                              const disabled = alreadyIn || alreadyPending || invalidStatus;
                              const alreadyInLabel = deal.deal_type === 'purchase' ? 'already in purchase' : 'already in trade';
                              const disabledReason = alreadyIn || alreadyPending ? alreadyInLabel : invalidStatus ? `item is ${res.status}` : '';
                              return (
                                <button
                                  key={res.id}
                                  type="button"
                                  disabled={disabled}
                                  onClick={() => {
                                    setPendingIncoming((prev) => [...prev, { item: res, value: 0 }]);
                                    setShowAddIncoming(false);
                                    setAddIncomingQuery('');
                                    setAddIncomingResults([]);
                                  }}
                                  className="w-full rounded-xl border border-slate-200 bg-white p-3 text-left text-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-500 dark:bg-slate-600 dark:hover:bg-slate-500"
                                >
                                  <p className="font-medium text-slate-900 dark:text-white">
                                    {brandMap[res.brand_id] || 'Unknown'} {res.model}
                                    {res.year ? ` (${res.year})` : ''}
                                  </p>
                                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                                    {res.status}{res.condition ? ` · ${res.condition}` : ''}
                                    {disabledReason ? ` · ${disabledReason}` : ''}
                                  </p>
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {addIncomingQuery && addIncomingResults.length === 0 && addSearching === null && (
                          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No items found for &ldquo;{addIncomingQuery}&rdquo;</p>
                        )}
                        <div className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-500">
                          <button
                            type="button"
                            onClick={() => setShowNewIncomingForm(true)}
                            className="inline-flex items-center gap-1.5 text-sm font-medium text-teal-600 transition hover:text-teal-800 dark:text-teal-400 dark:hover:text-teal-300"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Create new inventory item
                          </button>
                        </div>
                      </>
                    )}

                    {showNewIncomingForm && (
                      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-500 dark:bg-slate-800">
                        <div className="mb-3 flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">New inventory item</p>
                          <button
                            type="button"
                            onClick={() => setShowNewIncomingForm(false)}
                            className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                          >
                            ← Back to search
                          </button>
                        </div>
                        <InventoryForm
                          hideHeader
                          hideSidebar
                          onCreated={(newItem) => {
                            setPendingIncoming((prev) => [...prev, { item: newItem, value: 0 }]);
                            setShowAddIncoming(false);
                            setShowNewIncomingForm(false);
                            setAddIncomingQuery('');
                            setAddIncomingResults([]);
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

            {/* Cash Flow */}
            {cashFlows.length > 0 && (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Cash flow records</h2>
                <div className="mt-4 space-y-4">
                  {cashFlows.map((cf) => (
                    <div key={cf.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Transaction date</label>
                          {editMode ? (
                            <input
                              type="date"
                              value={editedCashFlows[cf.id]?.transaction_date ?? cf.transaction_date}
                              onChange={(e) =>
                                setEditedCashFlows({
                                  ...editedCashFlows,
                                  [cf.id]: { ...editedCashFlows[cf.id], transaction_date: e.target.value },
                                })
                              }
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                            />
                          ) : (
                            <p className="mt-2 text-sm text-slate-900 dark:text-white">{new Date(cf.transaction_date).toLocaleDateString()}</p>
                          )}
                        </div>

                        <div>
                          <label className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Description</label>
                          {editMode ? (
                            <input
                              type="text"
                              value={editedCashFlows[cf.id]?.description ?? cf.description ?? ''}
                              onChange={(e) =>
                                setEditedCashFlows({
                                  ...editedCashFlows,
                                  [cf.id]: { ...editedCashFlows[cf.id], description: e.target.value },
                                })
                              }
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                            />
                          ) : (
                            <p className="mt-2 text-sm text-slate-900 dark:text-white">{cf.description || '—'}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash in</p>
                          <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(cf.cash_in)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash out</p>
                          <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(cf.cash_out)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Opening balance</p>
                          <p className="mt-2 text-sm text-slate-900 dark:text-white">{formatCurrency(cf.opening_balance)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Closing balance</p>
                          <p className="mt-2 text-sm text-slate-900 dark:text-white">{formatCurrency(cf.closing_balance)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Expenses */}
            {expenses.length > 0 && (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Expenses</h2>
                <div className="mt-4 space-y-4">
                  {expenses.map((exp) => {
                    const linkedItem = exp.item_id != null ? itemMap[exp.item_id] : null;
                    const linkedBrand = linkedItem ? (brandMap[linkedItem.brand_id] || 'Unknown') : null;
                    return (
                      <div key={exp.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-600 dark:bg-slate-700">

                        {/* Linked item card — shown when expense is tied to an inventory item */}
                        {linkedItem && (
                          <Link
                            href={`/inventory/${linkedItem.id}`}
                            className="mb-4 flex gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:hover:bg-slate-700"
                          >
                            {photoByItemId[linkedItem.id] && (
                              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-700">
                                <Image
                                  src={photoByItemId[linkedItem.id]}
                                  alt={`${linkedBrand} ${linkedItem.model}`}
                                  fill
                                  className="object-cover"
                                  unoptimized
                                  sizes="56px"
                                />
                              </div>
                            )}
                            <div className="min-w-0">
                              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                                {linkedItem.item_type}
                              </p>
                              <p className="mt-0.5 truncate text-sm font-semibold text-slate-900 dark:text-white">
                                {[linkedItem.year, linkedBrand, linkedItem.model].filter(Boolean).join(' ')}
                              </p>
                              {(linkedItem.color || linkedItem.condition) && (
                                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                                  {[linkedItem.color, linkedItem.condition].filter(Boolean).join(' · ')}
                                </p>
                              )}
                              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-600 dark:text-slate-300">
                                {linkedItem.value_in != null && (
                                  <span><span className="text-slate-400 dark:text-slate-500">Value In </span>${Number(linkedItem.value_in).toFixed(0)}</span>
                                )}
                              </div>
                            </div>
                          </Link>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2">
                          <div>
                            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Expense date</label>
                            {editMode ? (
                              <input
                                type="date"
                                value={editedExpenses[exp.id]?.expense_date ?? exp.expense_date}
                                onChange={(e) =>
                                  setEditedExpenses({
                                    ...editedExpenses,
                                    [exp.id]: { ...editedExpenses[exp.id], expense_date: e.target.value },
                                  })
                                }
                                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                              />
                            ) : (
                              <p className="mt-2 text-sm text-slate-900 dark:text-white">{new Date(exp.expense_date).toLocaleDateString()}</p>
                            )}
                          </div>

                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Amount</p>
                            <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(exp.amount)}</p>
                          </div>

                          <div className="sm:col-span-2">
                            <label className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Notes</label>
                            {editMode ? (
                              <textarea
                                value={editedExpenses[exp.id]?.notes ?? exp.notes ?? ''}
                                onChange={(e) =>
                                  setEditedExpenses({
                                    ...editedExpenses,
                                    [exp.id]: { ...editedExpenses[exp.id], notes: e.target.value },
                                  })
                                }
                                rows={2}
                                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-500"
                              />
                            ) : (
                              <p className="mt-2 text-sm text-slate-900 dark:text-white">{exp.notes || '—'}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
