'use client';

import { useState } from 'react';
import BuyOperationForm from '@/components/BuyOperationForm';

const tabs = [
  { id: 'buy', label: 'Buy' },
  { id: 'sell', label: 'Sell' },
  { id: 'trade', label: 'Trade' },
] as const;

type OperationTab = (typeof tabs)[number]['id'];

export default function OperationsPage() {
  const [activeTab, setActiveTab] = useState<OperationTab>('buy');

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Operations</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900">Transactions</h1>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Record a purchase operation for your inventory. Sell and Trade are coming later.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`rounded-full px-5 py-2.5 text-sm font-semibold transition ${
                    activeTab === tab.id
                      ? 'bg-slate-950 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 space-y-6">
          {activeTab === 'buy' ? (
            <BuyOperationForm />
          ) : (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-slate-900">Coming later</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                The {activeTab} operation is not implemented yet. For now, you can record purchases using the Buy tab.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
