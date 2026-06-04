'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getDeals, getBrands } from '@/lib/supabase';
import type { Brand, Deal } from '@/types';

export default function OperationsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [dealsResult, brandsResult] = await Promise.all([getDeals(), getBrands()]);
      setLoading(false);

      if (dealsResult.error || brandsResult.error) {
        setError('Could not load operations. Please try again.');
        return;
      }

      setDeals(dealsResult.data || []);
      setBrands(brandsResult.data || []);
    }

    loadData();
  }, []);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

  const getDealTypeColor = (dealType: string) => {
    switch (dealType) {
      case 'purchase':
        return 'bg-blue-50 text-blue-700 border-blue-200';
      case 'sale':
        return 'bg-green-50 text-green-700 border-green-200';
      case 'trade':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      case 'expense':
        return 'bg-red-50 text-red-700 border-red-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  const formatCurrency = (value: number | null) => {
    if (value === null) return '$0.00';
    return `$${Math.abs(value).toFixed(2)}`;
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-500">Operations</p>
              <h1 className="mt-2 text-3xl font-semibold text-slate-900">Transactions</h1>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                View all your buy, sell, trade, and expense operations.
              </p>
            </div>
            <Link
              href="/operations/new"
              className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              New operation
            </Link>
          </div>
        </div>

        {/* Content */}
        <div className="mt-6">
          {loading ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm">
              Loading operations...
            </div>
          ) : error ? (
            <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center text-rose-700 shadow-sm">
              {error}
            </div>
          ) : deals.length === 0 ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="text-slate-600">No operations yet. Start by creating a new operation.</p>
              <Link
                href="/operations/new"
                className="mt-4 inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                Create operation
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {deals.map((deal) => (
                <div key={deal.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Type</p>
                      <div className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${getDealTypeColor(deal.deal_type)}`}>
                        {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Date</p>
                      <p className="mt-2 text-sm text-slate-900">
                        {new Date(deal.deal_date).toLocaleDateString()}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Channel</p>
                      <p className="mt-2 text-sm text-slate-900">
                        {deal.channel || 'N/A'}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <div>
                        <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Amount</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          {deal.cash_paid !== null && deal.cash_paid > 0
                            ? `Paid: ${formatCurrency(deal.cash_paid)}`
                            : deal.cash_received !== null && deal.cash_received > 0
                              ? `Received: ${formatCurrency(deal.cash_received)}`
                              : '—'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
