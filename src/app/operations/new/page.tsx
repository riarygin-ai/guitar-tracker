'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import BuyOperationForm from '@/components/BuyOperationForm';
import SellOperationForm from '@/components/SellOperationForm';
import TradeOperationForm from '@/components/TradeOperationForm';
import ExpenseOperationForm from '@/components/ExpenseOperationForm';

const tabs = [
  { id: 'trade', label: 'Trade' },
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
  { id: 'expense', label: 'Expense' },
] as const;

type OperationTab = (typeof tabs)[number]['id'];

function toValidTab(value: string | null): OperationTab {
  return tabs.some((t) => t.id === value) ? (value as OperationTab) : 'trade';
}

export default function NewOperationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<OperationTab>(() =>
    toValidTab(searchParams.get('type'))
  );

  // Sync tab when URL changes (e.g. Quick Add navigating while already on this page)
  useEffect(() => {
    setActiveTab(toValidTab(searchParams.get('type')));
  }, [searchParams]);

  function selectTab(tab: OperationTab) {
    setActiveTab(tab); // immediate UI response
    router.replace(`/operations/new?type=${tab}`, { scroll: false }); // keep URL in sync
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 dark:bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="page-overline">Operations</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-white">New operation</h1>
              <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                Record buy, sell, and trade operations for your inventory.
              </p>
            </div>
            <Link
              href="/operations"
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
            >
              Operation history
            </Link>
          </div>
        </div>

        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap gap-3">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => selectTab(tab.id)}
                className={`rounded-full px-5 py-2.5 text-sm font-semibold transition ${activeTab === tab.id
                    ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-900'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
                  }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 space-y-6">
          {activeTab === 'buy' ? (
            <BuyOperationForm />
          ) : activeTab === 'sell' ? (
            <SellOperationForm />
          ) : activeTab === 'trade' ? (
            <TradeOperationForm />
          ) : (
            <ExpenseOperationForm />
          )}
        </div>
      </div>
    </div>
  );
}
