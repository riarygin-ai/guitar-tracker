'use client';

import { useState } from 'react';
import Link from 'next/link';
import BuyOperationForm from '@/components/BuyOperationForm';
import SellOperationForm from '@/components/SellOperationForm';
import TradeOperationForm from '@/components/TradeOperationForm';
import ExpenseOperationForm from '@/components/ExpenseOperationForm';

const tabs = [
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
  { id: 'trade', label: 'Trade' },
  { id: 'expense', label: 'Expense' },
] as const;

type OperationTab = (typeof tabs)[number]['id'];

export default function NewOperationPage() {
  const [activeTab, setActiveTab] = useState<OperationTab>('buy');

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Operations</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900">New operation</h1>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Record buy, sell, and trade operations for your inventory.
              </p>
            </div>
            <Link
              href="/operations"
              className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
            >
              Back to operations
            </Link>
          </div>
        </div>

        <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap gap-3">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-full px-5 py-2.5 text-sm font-semibold transition ${activeTab === tab.id
                    ? 'bg-slate-950 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
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
