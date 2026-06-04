'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getDeals, getBrands, getInventoryItems, getDealItems } from '@/lib/supabase';
import type { Brand, Deal, DealItem, InventoryItem } from '@/types';

export default function OperationsPage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [dealItems, setDealItems] = useState<DealItem[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      const [dealsResult, dealItemsResult, itemsResult, brandsResult] = await Promise.all([
        getDeals(),
        getDealItems(),
        getInventoryItems(),
        getBrands(),
      ]);
      setLoading(false);

      if (dealsResult.error || brandsResult.error) {
        setError('Could not load operations. Please try again.');
        return;
      }

      setDeals(dealsResult.data || []);
      setDealItems(dealItemsResult.data || []);
      setInventoryItems(itemsResult.data || []);
      setBrands(brandsResult.data || []);
    }

    loadData();
  }, []);

  const brandMap = useMemo(
    () => Object.fromEntries(brands.map((brand) => [brand.id, brand.name])),
    [brands]
  );

  const itemMap = useMemo(
    () => Object.fromEntries(inventoryItems.map((item) => [item.id, item])),
    [inventoryItems]
  );

  const dealItemsByDealId = useMemo(() => {
    const map: Record<number, DealItem[]> = {};
    dealItems.forEach((di) => {
      if (!map[di.deal_id]) map[di.deal_id] = [];
      map[di.deal_id].push(di);
    });
    return map;
  }, [dealItems]);

  const getItemDescription = (deal: Deal): string => {
    const itemsForDeal = dealItemsByDealId[deal.id] || [];

    if (deal.deal_type === 'purchase' || deal.deal_type === 'sale') {
      const item = itemsForDeal[0] && itemMap[itemsForDeal[0].item_id];
      if (item) {
        const brand = brandMap[item.brand_id] || 'Unknown';
        return `${brand} ${item.model}`.trim();
      }
    } else if (deal.deal_type === 'trade') {
      const outgoing = itemsForDeal.find((di) => di.direction === 'out');
      const incoming = itemsForDeal.find((di) => di.direction === 'in');
      const outItem = outgoing && itemMap[outgoing.item_id];
      const inItem = incoming && itemMap[incoming.item_id];

      if (outItem && inItem) {
        const outBrand = brandMap[outItem.brand_id] || 'Unknown';
        const inBrand = brandMap[inItem.brand_id] || 'Unknown';
        return `${outBrand} ${outItem.model} → ${inBrand} ${inItem.model}`.trim();
      } else if (outItem) {
        const outBrand = brandMap[outItem.brand_id] || 'Unknown';
        return `${outBrand} ${outItem.model} →`.trim();
      }
    }

    return deal.notes || '—';
  };

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

  // Filter and sort deals
  const filteredAndSortedDeals = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const validDealTypes: Array<string> = ['purchase', 'sale', 'trade', 'expense'];

    return deals
      .filter((deal) => validDealTypes.includes(deal.deal_type))
      .filter((deal) => {
        if (!normalizedQuery) return true;

        const description = getItemDescription(deal).toLowerCase();
        const dealType = deal.deal_type.toLowerCase();
        const channel = (deal.channel || '').toLowerCase();
        const amount = deal.cash_paid ? formatCurrency(deal.cash_paid).toLowerCase() : '';
        const notes = (deal.notes || '').toLowerCase();

        return (
          description.includes(normalizedQuery) ||
          dealType.includes(normalizedQuery) ||
          channel.includes(normalizedQuery) ||
          amount.includes(normalizedQuery) ||
          notes.includes(normalizedQuery)
        );
      })
      .sort((a, b) => new Date(b.deal_date).getTime() - new Date(a.deal_date).getTime());
  }, [deals, searchQuery, dealItemsByDealId, brandMap, itemMap]);

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

        {/* Search box */}
        <div className="mt-6">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by item, type, channel, amount, or notes..."
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
          />
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
          ) : filteredAndSortedDeals.length === 0 ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="text-slate-600">
                {searchQuery ? 'No operations match your search.' : 'No operations yet. Start by creating a new operation.'}
              </p>
              {!searchQuery && (
                <Link
                  href="/operations/new"
                  className="mt-4 inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Create operation
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAndSortedDeals.map((deal) => (
                <Link
                  key={deal.id}
                  href={`/operations/${deal.id}`}
                  className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-400 hover:shadow-md block"
                >
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Type</p>
                      <div
                        className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-sm font-semibold ${getDealTypeColor(deal.deal_type)}`}
                      >
                        {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Date</p>
                      <p className="mt-2 text-sm text-slate-900">{new Date(deal.deal_date).toLocaleDateString()}</p>
                    </div>

                    <div>
                      <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Channel</p>
                      <p className="mt-2 text-sm text-slate-900">{deal.channel || 'N/A'}</p>
                    </div>

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

                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-xs font-semibold uppercase text-slate-500 tracking-[0.2em]">Item/Description</p>
                        <p className="mt-2 text-sm text-slate-900 line-clamp-2">{getItemDescription(deal)}</p>
                      </div>
                      <div className="ml-2 inline-flex items-center justify-center rounded-lg bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white">
                        View
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
