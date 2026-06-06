'use client';

import type { CashFlow } from '@/types';

interface CashFlowTableProps {
  rows: CashFlow[];
}

const formatMoney = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

export default function CashFlowTable({ rows }: CashFlowTableProps) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800 md:block">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm dark:divide-slate-700">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
            <tr>
              <th className="px-4 py-3 font-semibold">Date</th>
              <th className="px-4 py-3 font-semibold">Opening</th>
              <th className="px-4 py-3 font-semibold">Cash In</th>
              <th className="px-4 py-3 font-semibold">Cash Out</th>
              <th className="px-4 py-3 font-semibold">Closing</th>
              <th className="px-4 py-3 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-800">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-700">
                <td className="px-4 py-4 text-slate-700 dark:text-slate-200">{row.transaction_date}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-200">{formatMoney(row.opening_balance)}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-200">{formatMoney(row.cash_in)}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-200">{formatMoney(row.cash_out)}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-200">{formatMoney(row.closing_balance)}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-200">{row.description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <div key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-slate-900 dark:text-white">{row.transaction_date}</span>
              <span className="font-semibold text-slate-900 dark:text-white">{formatMoney(row.closing_balance)}</span>
            </div>
            {row.description && (
              <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">{row.description}</p>
            )}
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Opening</span>
                <span className="mt-0.5 block font-medium text-slate-700 dark:text-slate-300">{formatMoney(row.opening_balance)}</span>
              </div>
              <div>
                <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Cash In</span>
                <span className="mt-0.5 block font-medium text-emerald-600">{formatMoney(row.cash_in)}</span>
              </div>
              <div>
                <span className="block uppercase tracking-wide text-slate-400 dark:text-slate-500">Cash Out</span>
                <span className="mt-0.5 block font-medium text-rose-600">{formatMoney(row.cash_out)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
