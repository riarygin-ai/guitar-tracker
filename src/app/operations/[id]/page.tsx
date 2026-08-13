'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  getDealById,
  getDealChannels,
  getBrands,
  getInventoryItemsWithValue,
  getDealItemsForDeal,
  getCashFlowsForDeal,
  getInventoryExpensesForDeal,
  getInventoryExpensesByItemIds,
  getDisplayPhotosForItems,
} from '@/lib/supabase';
import type { Brand, Deal, DealChannel, DealItem, InventoryItemWithValue, CashFlow, InventoryExpense } from '@/types';

const editableDealTypes = new Set(['purchase', 'sale', 'trade', 'expense']);

function ItemCardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block rounded-2xl border border-slate-200 bg-slate-50 p-4 transition-colors hover:border-slate-300 hover:bg-white dark:border-slate-600 dark:bg-slate-700 dark:hover:border-slate-500 dark:hover:bg-slate-600">
      {children}
    </Link>
  );
}

export default function OperationDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const dealId = Number(params.id);

  const [deal, setDeal] = useState<Deal | null>(null);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [channels, setChannels] = useState<DealChannel[]>([]);
  const [items, setItems] = useState<InventoryItemWithValue[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [cashFlows, setCashFlows] = useState<CashFlow[]>([]);
  const [expenses, setExpenses] = useState<InventoryExpense[]>([]);
  const [photoByItemId, setPhotoByItemId] = useState<Record<number, string>>({});
  const [itemExpensesByItemId, setItemExpensesByItemId] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [dealResult, brandsResult, itemsResult, dealItemsResult, cashFlowsResult, expensesResult, channelsResult] = await Promise.all([
      getDealById(dealId),
      getBrands(),
      getInventoryItemsWithValue(),
      getDealItemsForDeal(dealId),
      getCashFlowsForDeal(dealId),
      getInventoryExpensesForDeal(dealId),
      getDealChannels(),
    ]);

    setLoading(false);

    if (dealResult.error || !dealResult.data) {
      setError('Could not load operation details.');
      return;
    }

    setDeal(dealResult.data);
    setBrands(brandsResult.data || []);
    setChannels((channelsResult.data as DealChannel[] | null) ?? []);
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

  useEffect(() => {
    if (searchParams.get('updated') === '1') {
      setSuccessMessage('Changes saved successfully.');
    }
  }, [searchParams]);

  const brandMap = Object.fromEntries(brands.map((b) => [b.id, b.name]));
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const channelMap = Object.fromEntries(channels.map((c) => [c.id, c.name]));

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
  const canEdit = editableDealTypes.has(deal.deal_type);

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
            {canEdit && (
              <Link
                href={`/operations/${deal.id}/edit`}
                className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100"
              >
                Edit
              </Link>
            )}
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
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{new Date(deal.deal_date).toLocaleDateString()}</p>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Channel</p>
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                  {deal.deal_channel_id != null ? (channelMap[deal.deal_channel_id] ?? '—') : '—'}
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash Paid</p>
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(deal.cash_paid)}</p>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash Received</p>
                <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(deal.cash_received)}</p>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Notes</p>
                <p className="mt-2 text-sm text-slate-900 line-clamp-2 dark:text-white">{deal.notes || '—'}</p>
              </div>
            </div>
          </div>

          {/* Gave / Outgoing Items */}
          {outgoingItems.length > 0 && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Gave / Outgoing</h2>
              <div className="mt-4 space-y-3">
                {outgoingItems.map((di) => {
                  const item = itemMap[di.item_id];
                  if (!item) return null;
                  const brand = brandMap[item.brand_id] || 'Unknown';
                  const valueIn = Number(item.value_in ?? 0);
                  const valueOut = Number(di.total_value ?? 0);
                  const itemExpenses = itemExpensesByItemId[item.id] ?? 0;
                  const realizedGain = valueOut - valueIn - itemExpenses;
                  return (
                    <ItemCardLink key={di.id} href={`/inventory/${item.id}`}>
                      <div className="flex gap-4">
                        {photoByItemId[item.id] && (
                          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
                            <Image src={photoByItemId[item.id]} alt={`${brand} ${item.model}`} fill className="object-cover" unoptimized sizes="80px" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="mb-3">
                            <p className="text-sm font-semibold text-slate-900 dark:text-white">{brand} {item.model}</p>
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                              {item.year && `${item.year} • `}{item.color && `${item.color} • `}{item.condition}
                            </p>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Value In</p>
                              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(valueIn)}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Value Out</p>
                              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(valueOut)}</p>
                            </div>
                            {itemExpenses > 0 && (
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Expenses</p>
                                <p className="mt-1 text-sm font-semibold text-rose-600">−{formatCurrency(itemExpenses)}</p>
                              </div>
                            )}
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Realized Profit</p>
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
              </div>
            </div>
          )}

          {/* Received / Incoming Items */}
          {incomingItems.length > 0 && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                {deal.deal_type === 'purchase' ? 'Purchased Items' : 'Received / Incoming'}
              </h2>
              <div className="mt-4 space-y-3">
                {incomingItems.map((di) => {
                  const item = itemMap[di.item_id];
                  if (!item) return null;
                  const brand = brandMap[item.brand_id] || 'Unknown';
                  const valueIn = Number(di.total_value ?? 0);
                  const estimatedSold = Number(item.estimated_sold_value ?? 0);
                  const incomingItemExpenses = itemExpensesByItemId[item.id] ?? 0;
                  const potentialReward = estimatedSold - valueIn - incomingItemExpenses;
                  return (
                    <ItemCardLink key={di.id} href={`/inventory/${item.id}`}>
                      <div className="flex gap-4">
                        {photoByItemId[item.id] && (
                          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
                            <Image src={photoByItemId[item.id]} alt={`${brand} ${item.model}`} fill className="object-cover" unoptimized sizes="80px" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="mb-3">
                            <p className="text-sm font-semibold text-slate-900 dark:text-white">{brand} {item.model}</p>
                            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                              {item.year && `${item.year} • `}{item.color && `${item.color} • `}{item.condition}
                            </p>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">
                                {deal.deal_type === 'purchase' ? 'Purchase Cost' : 'Value In'}
                              </p>
                              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(valueIn)}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Estimated Sold</p>
                              <p className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(estimatedSold)}</p>
                            </div>
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400">Est. Profit</p>
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
                        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Transaction date</p>
                        <p className="mt-2 text-sm text-slate-900 dark:text-white">{new Date(cf.transaction_date).toLocaleDateString()}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Description</p>
                        <p className="mt-2 text-sm text-slate-900 dark:text-white">{cf.description || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash Received</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(cf.cash_in)}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Cash Paid</p>
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
                              {linkedItem.item_subtype_name ?? '—'}
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
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Expense date</p>
                          <p className="mt-2 text-sm text-slate-900 dark:text-white">{new Date(exp.expense_date).toLocaleDateString()}</p>
                        </div>

                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Amount</p>
                          <p className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">{formatCurrency(exp.amount)}</p>
                        </div>

                        <div className="sm:col-span-2">
                          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-400">Notes</p>
                          <p className="mt-2 text-sm text-slate-900 dark:text-white">{exp.notes || '—'}</p>
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
