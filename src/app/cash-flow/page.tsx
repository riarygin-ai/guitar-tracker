'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useMemo, useState } from 'react';
import { getCashFlows } from '@/lib/supabase';
import type { CashFlow } from '@/types';
import CashFlowTable from '@/components/CashFlowTable';

export default function CashFlowPage() {
  const [rows, setRows] = useState<CashFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const result = await getCashFlows();
      setLoading(false);
      if (result.error) {
        setError('Could not load cash flow data. Please try again.');
        return;
      }
      setRows(result.data || []);
    }
    loadData();
  }, []);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const dateDiff = b.transaction_date.localeCompare(a.transaction_date);
        if (dateDiff !== 0) return dateDiff;
        return b.id - a.id;
      }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    return sortedRows.filter((row) => {
      if (dateFrom && row.transaction_date < dateFrom) return false;
      if (dateTo && row.transaction_date > dateTo) return false;
      return true;
    });
  }, [sortedRows, dateFrom, dateTo]);

  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Cash flow</p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">Cash movement</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
              Track cash moving in and out of the business, separated from inventory and deal item details.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Cash flow history</h2>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Date from</label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Date to</label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:focus:ring-slate-600"
                  />
                </div>
                {(dateFrom || dateTo) && (
                  <button
                    type="button"
                    onClick={() => { setDateFrom(''); setDateTo(''); }}
                    className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-500 dark:border-slate-700 dark:bg-slate-700 dark:text-slate-400">
                Loading cash flow...
              </div>
            ) : error ? (
              <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 text-center text-rose-700">
                {error}
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-600 dark:border-slate-700 dark:bg-slate-700 dark:text-slate-300">
                {rows.length === 0 ? 'No cash flow records yet.' : 'No records match the selected date range.'}
              </div>
            ) : (
              <CashFlowTable rows={filteredRows} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
