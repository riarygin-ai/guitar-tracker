'use client';

import { useEffect, useMemo, useState } from 'react';
import { createCashFlow, getCashFlows, getDeals } from '@/lib/supabase';
import type { CashFlow, Deal } from '@/types';
import CashFlowForm from '@/components/CashFlowForm';
import CashFlowTable from '@/components/CashFlowTable';

export default function CashFlowPage() {
  const [rows, setRows] = useState<CashFlow[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [cashFlowResult, dealResult] = await Promise.all([getCashFlows(), getDeals()]);
      setLoading(false);

      if (cashFlowResult.error || dealResult.error) {
        setError('Could not load cash flow data. Please try again.');
        return;
      }

      setRows(cashFlowResult.data || []);
      setDeals(dealResult.data || []);
    }

    loadData();
  }, []);

  const latestBalance = useMemo(() => {
    return rows.length > 0 ? rows[0].closing_balance : 0;
  }, [rows]);

  const handleSaved = async (cashFlow: CashFlow) => {
    setSuccess('Cash flow row saved successfully.');
    setError(null);
    setRows((current) => [cashFlow, ...current]);
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Cash flow</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900">Cash movement</h1>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Track cash moving in and out of the business, separated from inventory and deal item details.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 space-y-6">
          <CashFlowForm latestBalance={latestBalance} deals={deals} onSaved={handleSaved} />

          {success && (
            <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-700 shadow-sm">
              {success}
            </div>
          )}

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900">Cash flow history</h2>
                <p className="mt-2 text-sm text-slate-600">Showing latest transactions first.</p>
              </div>
            </div>
            {loading ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-500">
                Loading cash flow...
              </div>
            ) : error ? (
              <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700">
                {error}
              </div>
            ) : rows.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-600">
                No cash flow records yet.
              </div>
            ) : (
              <CashFlowTable rows={rows} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
