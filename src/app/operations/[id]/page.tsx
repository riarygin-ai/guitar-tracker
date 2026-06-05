'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  getDealById,
  getBrands,
  getInventoryItemsWithValue,
  getDealItemsForDeal,
  getCashFlowsForDeal,
  getInventoryExpensesForDeal,
  updateDeal,
  updateCashFlow,
  updateInventoryExpense,
  recalculateCashFlowBalancesFrom,
  editTradeOperation,
} from '@/lib/supabase';
import type { Brand, Deal, DealItem, InventoryItemWithValue, CashFlow, InventoryExpense } from '@/types';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Edit state
  const [editedDeal, setEditedDeal] = useState<Partial<Deal> | null>(null);
  const [editedCashFlows, setEditedCashFlows] = useState<Record<number, Partial<CashFlow>>>({});
  const [editedExpenses, setEditedExpenses] = useState<Record<number, Partial<InventoryExpense>>>({});
  const [editedDealItems, setEditedDealItems] = useState<Record<number, { total_value: number }>>({});

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
  }, [dealId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const brandMap = Object.fromEntries(brands.map((b) => [b.id, b.name]));
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));

  const handleEditMode = () => {
    if (editMode) {
      setEditMode(false);
      setEditedDeal(null);
      setEditedCashFlows({});
      setEditedExpenses({});
      setEditedDealItems({});
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
        const outgoing = dealItems.filter((di) => di.direction === 'out');
        const incoming = dealItems.filter((di) => di.direction === 'in');
        const cashFlowRow = cashFlows[0] ?? null;

        const cashPaid = Number(editedDeal?.cash_paid ?? deal.cash_paid ?? 0);
        const cashReceived = Number(editedDeal?.cash_received ?? deal.cash_received ?? 0);

        const outgoingTotal = outgoing.reduce(
          (sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)),
          0
        );
        const incomingTotal = incoming.reduce(
          (sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)),
          0
        );

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
          outgoingItems: outgoing.map((di) => ({
            item_id: di.item_id,
            total_value: editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0),
          })),
          incomingItems: incoming.map((di) => ({
            item_id: di.item_id,
            total_value: editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0),
          })),
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
      } else {
        // Purchase / sale / expense: individual field updates
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
      <div className="min-h-screen bg-slate-50 py-8">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm">
            Loading operation details...
          </div>
        </div>
      </div>
    );
  }

  if (error && !deal) {
    return (
      <div className="min-h-screen bg-slate-50 py-8">
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
        return 'bg-blue-50 border-blue-200 text-blue-700';
      case 'sale':
        return 'bg-green-50 border-green-200 text-green-700';
      case 'trade':
        return 'bg-purple-50 border-purple-200 text-purple-700';
      case 'expense':
        return 'bg-red-50 border-red-200 text-red-700';
      default:
        return 'bg-slate-50 border-slate-200 text-slate-700';
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
  const tradeEditOutgoingTotal = outgoingItems.reduce(
    (sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)),
    0
  );
  const tradeEditIncomingTotal = incomingItems.reduce(
    (sum, di) => sum + (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0)),
    0
  );
  const tradeGiven = tradeEditOutgoingTotal + tradeEditCashPaid;
  const tradeReceived = tradeEditIncomingTotal + tradeEditCashReceived;
  const tradeIsBalanced = Math.round(tradeGiven * 100) === Math.round(tradeReceived * 100);

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <Link href="/operations" className="text-sm text-slate-500 hover:text-slate-700">
                ← Back to operations
              </Link>
              <div className="mt-3 flex items-center gap-3">
                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                  {getDealTypeLabel(deal.deal_type)}
                </div>
                <h1 className="text-3xl font-semibold text-slate-900">Operation #{deal.id}</h1>
              </div>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={handleEditMode}
                className={`inline-flex items-center justify-center rounded-2xl px-5 py-2 text-sm font-semibold transition ${
                  editMode
                    ? 'bg-slate-200 text-slate-900 hover:bg-slate-300'
                    : 'bg-slate-100 text-slate-900 hover:bg-slate-200'
                }`}
              >
                {editMode ? 'Cancel edit' : 'Edit'}
              </button>
              {editMode && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || (editMode && deal.deal_type === 'trade' && !tradeIsBalanced)}
                  className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-400"
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
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Date</p>
                {editMode ? (
                  <input
                    type="date"
                    value={editedDeal?.deal_date ?? deal.deal_date}
                    onChange={(e) => setEditedDeal({ ...editedDeal, deal_date: e.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900">{new Date(deal.deal_date).toLocaleDateString()}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Channel</p>
                {editMode ? (
                  <input
                    type="text"
                    value={editedDeal?.channel ?? deal.channel ?? ''}
                    onChange={(e) => setEditedDeal({ ...editedDeal, channel: e.target.value })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900">{deal.channel || '—'}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Cash Paid</p>
                {editMode && deal.deal_type === 'trade' ? (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={Number(editedDeal?.cash_paid ?? deal.cash_paid ?? 0)}
                    onChange={(e) => setEditedDeal({ ...editedDeal, cash_paid: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900">{formatCurrency(deal.cash_paid)}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Cash Received</p>
                {editMode && deal.deal_type === 'trade' ? (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={Number(editedDeal?.cash_received ?? deal.cash_received ?? 0)}
                    onChange={(e) => setEditedDeal({ ...editedDeal, cash_received: e.target.value === '' ? 0 : Number(e.target.value) })}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                ) : (
                  <p className="mt-2 text-sm font-semibold text-slate-900">{formatCurrency(deal.cash_received)}</p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Notes</p>
                {editMode ? (
                  <textarea
                    value={editedDeal?.notes ?? deal.notes ?? ''}
                    onChange={(e) => setEditedDeal({ ...editedDeal, notes: e.target.value })}
                    rows={2}
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                  />
                ) : (
                  <p className="mt-2 text-sm text-slate-900 line-clamp-2">{deal.notes || '—'}</p>
                )}
              </div>
            </div>
            {editMode && deal.deal_type === 'trade' && (
              <div className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.1em]">Total given</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(tradeGiven)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.1em]">Total received</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(tradeReceived)}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.1em]">Trade balance</p>
                  <p className={`mt-1 text-sm font-semibold ${tradeIsBalanced ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {tradeIsBalanced ? 'Balanced' : `$${Math.abs(tradeGiven - tradeReceived).toFixed(2)} off`}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Gave / Outgoing Items */}
          {outgoingItems.length > 0 && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Gave / Outgoing</h2>
              <div className="mt-4 space-y-3">
                {outgoingItems.map((di) => {
                  const item = itemMap[di.item_id];
                  if (!item) return null;
                  const brand = brandMap[item.brand_id] || 'Unknown';
                  const valueIn = Number(item.value_in ?? 0);
                  const valueOut = editMode && deal.deal_type === 'trade'
                    ? (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0))
                    : Number(di.total_value ?? 0);
                  const realizedGain = valueOut - valueIn;
                  return (
                    <div key={di.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="mb-3">
                        <p className="text-sm font-semibold text-slate-900">
                          {brand} {item.model}
                        </p>
                        <p className="text-xs text-slate-600 mt-1">
                          {item.year && `${item.year} • `}
                          {item.color && `${item.color} • `}
                          {item.condition}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.08em]">Value In</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(valueIn)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.08em]">Value Out</p>
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
                              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                            />
                          ) : (
                            <p className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(valueOut)}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.08em]">Realized Gain</p>
                          <p className={`mt-1 text-sm font-semibold ${realizedGain > 0 ? 'text-green-600' : realizedGain < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                            {formatCurrency(realizedGain)}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Received / Incoming Items */}
          {incomingItems.length > 0 && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Received / Incoming</h2>
              <div className="mt-4 space-y-3">
                {incomingItems.map((di) => {
                  const item = itemMap[di.item_id];
                  if (!item) return null;
                  const brand = brandMap[item.brand_id] || 'Unknown';
                  const valueIn = editMode && deal.deal_type === 'trade'
                    ? (editedDealItems[di.id]?.total_value ?? Number(di.total_value ?? 0))
                    : Number(di.total_value ?? 0);
                  const estimatedSold = Number(item.estimated_sold_value ?? 0);
                  const potentialReward = estimatedSold - valueIn;
                  return (
                    <div key={di.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="mb-3">
                        <p className="text-sm font-semibold text-slate-900">
                          {brand} {item.model}
                        </p>
                        <p className="text-xs text-slate-600 mt-1">
                          {item.year && `${item.year} • `}
                          {item.color && `${item.color} • `}
                          {item.condition}
                        </p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.08em]">Value In</p>
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
                              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                            />
                          ) : (
                            <p className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(valueIn)}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.08em]">Estimated Sold</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{formatCurrency(estimatedSold)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.08em]">Potential Reward</p>
                          <p className={`mt-1 text-sm font-semibold ${potentialReward > 0 ? 'text-green-600' : potentialReward < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                            {formatCurrency(potentialReward)}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

            {/* Cash Flow */}
            {cashFlows.length > 0 && (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-900">Cash flow records</h2>
                <div className="mt-4 space-y-4">
                  {cashFlows.map((cf) => (
                    <div key={cf.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Transaction date</label>
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
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                            />
                          ) : (
                            <p className="mt-2 text-sm text-slate-900">{new Date(cf.transaction_date).toLocaleDateString()}</p>
                          )}
                        </div>

                        <div>
                          <label className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Description</label>
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
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                            />
                          ) : (
                            <p className="mt-2 text-sm text-slate-900">{cf.description || '—'}</p>
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Cash in</p>
                          <p className="mt-2 text-sm font-semibold text-slate-900">{formatCurrency(cf.cash_in)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Cash out</p>
                          <p className="mt-2 text-sm font-semibold text-slate-900">{formatCurrency(cf.cash_out)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Opening balance</p>
                          <p className="mt-2 text-sm text-slate-900">{formatCurrency(cf.opening_balance)}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Closing balance</p>
                          <p className="mt-2 text-sm text-slate-900">{formatCurrency(cf.closing_balance)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Expenses */}
            {expenses.length > 0 && (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-900">Expenses</h2>
                <div className="mt-4 space-y-4">
                  {expenses.map((exp) => (
                    <div key={exp.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Expense date</label>
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
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                            />
                          ) : (
                            <p className="mt-2 text-sm text-slate-900">{new Date(exp.expense_date).toLocaleDateString()}</p>
                          )}
                        </div>

                        <div>
                          <p className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Amount</p>
                          <p className="mt-2 text-sm font-semibold text-slate-900">{formatCurrency(exp.amount)}</p>
                        </div>

                        <div className="sm:col-span-2">
                          <label className="text-xs font-semibold uppercase text-slate-600 tracking-[0.1em]">Notes</label>
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
                              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                            />
                          ) : (
                            <p className="mt-2 text-sm text-slate-900">{exp.notes || '—'}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
