'use client';

import { useState } from 'react';
import { createCashFlow } from '@/lib/supabase';
import type { CashFlow, Deal, NewCashFlow } from '@/types';

interface CashFlowFormProps {
  latestBalance: number;
  deals: Deal[];
  onSaved: (cashFlow: CashFlow) => void;
}

export default function CashFlowForm({ latestBalance, deals, onSaved }: CashFlowFormProps) {
  const [transactionDate, setTransactionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [cashIn, setCashIn] = useState('');
  const [cashOut, setCashOut] = useState('');
  const [description, setDescription] = useState('');
  const [dealId, setDealId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const cashInValue = Number(cashIn) || 0;
    const cashOutValue = Number(cashOut) || 0;

    if (cashInValue <= 0 && cashOutValue <= 0) {
      setError('Enter a cash in or cash out amount greater than zero.');
      return;
    }

    if (!transactionDate) {
      setError('Transaction date is required.');
      return;
    }

    const openingBalance = latestBalance;
    const closingBalance = openingBalance - cashOutValue + cashInValue;

    const payload: NewCashFlow = {
      transaction_date: transactionDate,
      opening_balance: openingBalance,
      cash_in: cashInValue,
      cash_out: cashOutValue,
      closing_balance: closingBalance,
      description: description.trim() || null,
      deal_id: dealId ? Number(dealId) : null,
    };

    setLoading(true);
    try {
      const result = await createCashFlow(payload);
      if (result.error || !result.data) {
        setError(result.error?.message || 'Failed to save cash flow.');
      } else {
        onSaved(result.data);
        setSuccess('Cash flow row saved successfully.');
        setCashIn('');
        setCashOut('');
        setDescription('');
        setDealId('');
      }
    } catch (err) {
      setError('Unexpected error saving cash flow.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">Transaction date</label>
            <input
              type="date"
              value={transactionDate}
              onChange={(event) => setTransactionDate(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700">Cash in</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashIn}
                onChange={(event) => setCashIn(event.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Cash out</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={cashOut}
                onChange={(event) => setCashOut(event.target.value)}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
                placeholder="0.00"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Description</label>
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
              placeholder="Optional description"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Linked deal (optional)</label>
            <select
              value={dealId}
              onChange={(event) => setDealId(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
            >
              <option value="">No deal selected</option>
              {deals.map((deal) => (
                <option key={deal.id} value={deal.id}>
                  {deal.deal_date} — {deal.deal_type} — ${deal.cash_paid ?? deal.cash_received ?? 0}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
          <p className="text-sm font-semibold text-slate-900">Balance preview</p>
          <div className="mt-4 space-y-3">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Opening balance</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">${latestBalance.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Closing balance</p>
              <p className="mt-2 text-lg font-semibold text-slate-900">
                ${(latestBalance - (Number(cashOut) || 0) + (Number(cashIn) || 0)).toFixed(2)}
              </p>
            </div>
            <div className="rounded-2xl bg-white p-4">
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Note</p>
              <p className="mt-2 text-slate-600">Opening balance is loaded from the latest cash flow row.</p>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>
      )}
      {success && (
        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">{success}</div>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="submit"
          disabled={loading}
          className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {loading ? 'Saving...' : 'Save cash flow'}
        </button>
      </div>

      {/* TODO: later this table will be auto-generated from deals. */}
    </form>
  );
}
