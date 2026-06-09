'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { getItemLineage, type ItemTimelineData } from '@/lib/supabase';
import type { Deal, DealItem, InventoryItemWithValue } from '@/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtMoney(v: number): string {
  return `$${Math.round(Math.abs(v)).toLocaleString()}`;
}

const TYPE_COLORS: Record<string, string> = {
  purchase: 'bg-blue-50   text-blue-700   border-blue-200   dark:bg-blue-900/30   dark:text-blue-300   dark:border-blue-700',
  sale:     'bg-green-50  text-green-700  border-green-200  dark:bg-green-900/30  dark:text-green-300  dark:border-green-700',
  trade:    'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
  expense:  'bg-red-50    text-red-700    border-red-200    dark:bg-red-900/30    dark:text-red-300    dark:border-red-700',
};

// ── Sub-components ─────────────────────────────────────────────────────────────

const PhotoPlaceholder = () => (
  <div className="absolute inset-0 flex items-center justify-center">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6 text-slate-300 dark:text-slate-600">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
    </svg>
  </div>
);

interface ItemRowProps {
  di:            DealItem;
  direction:     'in' | 'out';
  currentItemId: number;
  item:          InventoryItemWithValue | undefined;
  brand:         string;
  photoUrl:      string | undefined;
}

function ItemRow({ di, direction, currentItemId, item, brand, photoUrl }: ItemRowProps) {
  if (!item) return null;

  const isCurrentItem = di.item_id === currentItemId;
  const valueIn       = Number(item.value_in  ?? 0);
  const dealValue     = Number(di.total_value ?? 0);
  const gain          = dealValue - valueIn;

  return (
    <div className={`flex gap-3 rounded-xl p-3 ${
      isCurrentItem
        ? 'border border-violet-200 bg-violet-50/70 dark:border-violet-700/50 dark:bg-violet-900/10'
        : 'border border-slate-100 bg-slate-50 dark:border-slate-600/50 dark:bg-slate-700/40'
    }`}>

      {/* Photo */}
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
        {photoUrl
          ? <Image src={photoUrl} alt={`${brand} ${item.model}`} fill className="object-cover" sizes="56px" unoptimized />
          : <PhotoPlaceholder />}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <Link
            href={`/inventory/${item.id}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-sm font-semibold text-slate-900 hover:underline dark:text-white"
          >
            {brand} {item.model}
          </Link>
          {isCurrentItem && (
            <span className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
              This item
            </span>
          )}
        </div>

        {(item.year || item.color || item.condition) && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {[item.year, item.color, item.condition].filter(Boolean).join(' · ')}
          </p>
        )}

        {/* Value metrics */}
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          {direction === 'out' ? (
            <>
              <span>
                <span className="text-slate-400 dark:text-slate-500">Cost </span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(valueIn)}</span>
              </span>
              <span>
                <span className="text-slate-400 dark:text-slate-500">Proceeds </span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(dealValue)}</span>
              </span>
              <span>
                <span className="text-slate-400 dark:text-slate-500">Gain </span>
                <span className={`font-semibold ${gain > 0 ? 'text-emerald-600' : gain < 0 ? 'text-rose-600' : 'text-slate-700 dark:text-slate-200'}`}>
                  {gain >= 0 ? '+' : '−'}{fmtMoney(gain)}
                </span>
              </span>
            </>
          ) : (
            <>
              <span>
                <span className="text-slate-400 dark:text-slate-500">Cost </span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(dealValue)}</span>
              </span>
              {item.estimated_sold_value != null && (
                <span>
                  <span className="text-slate-400 dark:text-slate-500">Est. sold </span>
                  <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(Number(item.estimated_sold_value))}</span>
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Timeline card ──────────────────────────────────────────────────────────────

interface TimelineCardProps {
  deal:           Deal;
  dealItems:      DealItem[];
  currentItemId:  number;
  itemMap:        Record<number, InventoryItemWithValue>;
  brandMap:       Record<number, string>;
  photoByItemId:  Record<number, string>;
}

function TimelineCard({ deal, dealItems, currentItemId, itemMap, brandMap, photoByItemId }: TimelineCardProps) {
  const outgoing = dealItems.filter((di) => di.direction === 'out');
  const incoming = dealItems.filter((di) => di.direction === 'in');

  const profit =
    deal.deal_type === 'sale' || deal.deal_type === 'trade'
      ? outgoing.reduce((sum, di) => {
          const item = itemMap[di.item_id];
          return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0));
        }, 0)
      : null;

  const typeColor = TYPE_COLORS[deal.deal_type] ?? TYPE_COLORS.purchase;

  const outLabel = deal.deal_type === 'sale' ? 'Sold' : 'Gave';
  const inLabel  = deal.deal_type === 'purchase' ? 'Acquired' : 'Received';

  return (
    <Link
      href={`/operations/${deal.id}`}
      className="group block p-4 transition-colors hover:bg-slate-50 sm:p-5 dark:hover:bg-slate-700/30"
    >
      {/* ── Deal header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${typeColor}`}>
          {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
        </span>

        <span className="text-sm text-slate-700 dark:text-slate-200">{formatDate(deal.deal_date)}</span>

        {deal.channel && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span className="text-sm text-slate-500 dark:text-slate-400">{deal.channel}</span>
          </>
        )}

        {profit !== null && (
          <>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <span className={`text-sm font-semibold ${profit > 0 ? 'text-emerald-600' : profit < 0 ? 'text-rose-600' : 'text-slate-600 dark:text-slate-300'}`}>
              {profit >= 0 ? '+' : '−'}{fmtMoney(profit)}
            </span>
          </>
        )}

        {/* Hover arrow */}
        <svg
          xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="ml-auto shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 dark:text-slate-500"
        >
          <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
        </svg>
      </div>

      {/* ── Outgoing items ───────────────────────────────────────────────── */}
      {outgoing.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500">
            {outLabel}
          </p>
          <div className="space-y-2">
            {outgoing.map((di) => (
              <ItemRow
                key={di.id}
                di={di}
                direction="out"
                currentItemId={currentItemId}
                item={itemMap[di.item_id]}
                brand={brandMap[itemMap[di.item_id]?.brand_id ?? 0] ?? 'Unknown'}
                photoUrl={photoByItemId[di.item_id]}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Trade arrow ──────────────────────────────────────────────────── */}
      {deal.deal_type === 'trade' && outgoing.length > 0 && incoming.length > 0 && (
        <div className="my-2 flex justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300 dark:text-slate-600">
            <line x1="12" y1="5" x2="12" y2="19"/><polyline points="5 12 12 19 19 12"/>
          </svg>
        </div>
      )}

      {/* ── Incoming items ───────────────────────────────────────────────── */}
      {incoming.length > 0 && (
        <div className={outgoing.length > 0 && deal.deal_type !== 'trade' ? 'mt-3' : deal.deal_type === 'trade' ? '' : 'mt-3'}>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500">
            {inLabel}
          </p>
          <div className="space-y-2">
            {incoming.map((di) => (
              <ItemRow
                key={di.id}
                di={di}
                direction="in"
                currentItemId={currentItemId}
                item={itemMap[di.item_id]}
                brand={brandMap[itemMap[di.item_id]?.brand_id ?? 0] ?? 'Unknown'}
                photoUrl={photoByItemId[di.item_id]}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Cash + notes footer ──────────────────────────────────────────── */}
      {(deal.cash_paid || deal.cash_received || deal.fees || deal.notes) && (
        <div className="mt-3 border-t border-slate-100 pt-2.5 dark:border-slate-700">
          <div className="flex flex-wrap gap-x-5 gap-y-0.5 text-xs">
            {deal.cash_paid != null && deal.cash_paid > 0 && (
              <span>
                <span className="text-slate-400 dark:text-slate-500">Cash paid </span>
                <span className="font-medium text-rose-600 dark:text-rose-400">{fmtMoney(deal.cash_paid)}</span>
              </span>
            )}
            {deal.cash_received != null && deal.cash_received > 0 && (
              <span>
                <span className="text-slate-400 dark:text-slate-500">Cash received </span>
                <span className="font-medium text-emerald-600 dark:text-emerald-400">{fmtMoney(deal.cash_received)}</span>
              </span>
            )}
            {deal.fees != null && deal.fees > 0 && (
              <span>
                <span className="text-slate-400 dark:text-slate-500">Fees </span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(deal.fees)}</span>
              </span>
            )}
          </div>
          {deal.notes && (
            <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{deal.notes}</p>
          )}
        </div>
      )}
    </Link>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function InventoryLifeCard({ itemId }: { itemId: number }) {
  const [data,    setData]    = useState<ItemTimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getItemLineage(itemId).then(({ data, error }) => {
      if (!cancelled) {
        setData(data);
        setError(error);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [itemId]);

  // ── Derived maps ────────────────────────────────────────────────────────────

  const brandMap = Object.fromEntries((data?.brands        ?? []).map((b) => [b.id, b.name]));
  const itemMap  = Object.fromEntries((data?.inventoryItems ?? []).map((i) => [i.id, i]));

  const dealItemsByDealId: Record<number, DealItem[]> = {};
  (data?.dealItems ?? []).forEach((di) => {
    if (!dealItemsByDealId[di.deal_id]) dealItemsByDealId[di.deal_id] = [];
    dealItemsByDealId[di.deal_id].push(di);
  });

  const deals = data?.deals ?? [];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-800">

      {/* Section header */}
      <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-700">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Trade Chain</h2>
          {!loading && deals.length > 0 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {deals.length}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Full connected trade, purchase, and sale history for this item.
        </p>
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center gap-2.5 px-5 py-6">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
          <span className="text-sm text-slate-500 dark:text-slate-400">Building trade chain…</span>
        </div>
      ) : error ? (
        <div className="px-5 py-4 text-sm text-rose-600 dark:text-rose-400">{error}</div>
      ) : deals.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-500 dark:text-slate-400">
          No trade chain yet.
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-700">
          {deals.map((deal) => (
            <TimelineCard
              key={deal.id}
              deal={deal}
              dealItems={dealItemsByDealId[deal.id] ?? []}
              currentItemId={itemId}
              itemMap={itemMap}
              brandMap={brandMap}
              photoByItemId={data?.photoByItemId ?? {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}
