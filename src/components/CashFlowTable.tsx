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
    <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">
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
  );
}
