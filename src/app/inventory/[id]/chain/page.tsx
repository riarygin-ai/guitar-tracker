'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getItemLineage, type ItemTimelineData } from '@/lib/supabase';
import type { Deal, DealItem, InventoryItemWithValue } from '@/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChainStep {
  deal:     Deal;
  incoming: DealItem[];
  outgoing: DealItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtMoney(v: number): string {
  return `$${Math.round(Math.abs(v)).toLocaleString()}`;
}

const DEAL_TYPE_COLORS: Record<string, string> = {
  purchase: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
  sale:     'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700',
  trade:    'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
  expense:  'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
};

const STATUS_STYLES: Record<string, string> = {
  owned:  'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  listed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  sold:   'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
  traded: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function PhotoPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-8 w-8 text-slate-300 dark:text-slate-600">
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
      </svg>
    </div>
  );
}

interface ItemNodeProps {
  di:            DealItem;
  item:          InventoryItemWithValue | undefined;
  brand:         string;
  photoUrl:      string | undefined;
  isCurrentItem: boolean;
}

function ItemNode({ di, item, brand, photoUrl, isCurrentItem }: ItemNodeProps) {
  if (!item) return null;

  const costValue = Number(di.total_value ?? 0);
  const estSold   = item.estimated_sold_value != null ? Number(item.estimated_sold_value) : null;

  return (
    <Link
      href={`/inventory/${item.id}`}
      className={`group flex gap-4 rounded-2xl border p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/30 ${
        isCurrentItem
          ? 'border-violet-200 bg-violet-50/60 dark:border-violet-700/50 dark:bg-violet-900/10'
          : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'
      }`}
    >
      {/* Photo */}
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700">
        {photoUrl
          ? <Image src={photoUrl} alt={`${brand} ${item.model}`} fill className="object-cover" sizes="80px" unoptimized />
          : <PhotoPlaceholder />}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900 group-hover:underline dark:text-white">
              {brand} {item.model}
            </p>
            {(item.year || item.color || item.condition) && (
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {[item.year, item.color, item.condition].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
          {isCurrentItem && (
            <span className="shrink-0 rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
              Current item
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          {costValue > 0 && (
            <span>
              <span className="text-slate-400 dark:text-slate-500">Cost </span>
              <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(costValue)}</span>
            </span>
          )}
          {estSold != null && estSold > 0 && (
            <span>
              <span className="text-slate-400 dark:text-slate-500">Est. sold </span>
              <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(estSold)}</span>
            </span>
          )}
        </div>

        {item.status && (
          <span className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLES[item.status] ?? STATUS_STYLES.owned}`}>
            {item.status}
          </span>
        )}
      </div>
    </Link>
  );
}

interface DealConnectorProps {
  deal:     Deal;
  outgoing: DealItem[];
  itemMap:  Record<number, InventoryItemWithValue>;
}

function DealConnector({ deal, outgoing, itemMap }: DealConnectorProps) {
  const profit =
    deal.deal_type === 'sale' || deal.deal_type === 'trade'
      ? outgoing.reduce((sum, di) => {
          const item = itemMap[di.item_id];
          return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0));
        }, 0)
      : null;

  const typeColor = DEAL_TYPE_COLORS[deal.deal_type] ?? DEAL_TYPE_COLORS.purchase;

  return (
    <Link
      href={`/operations/${deal.id}`}
      className="group flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:bg-slate-700/70"
    >
      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${typeColor}`}>
        {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
      </span>

      <span className="text-sm text-slate-600 dark:text-slate-300">{formatDate(deal.deal_date)}</span>

      {deal.channel && (
        <>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-sm text-slate-500 dark:text-slate-400">{deal.channel}</span>
        </>
      )}

      {deal.cash_paid != null && Number(deal.cash_paid) > 0 && (
        <>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-sm font-medium text-rose-600 dark:text-rose-400">
            −{fmtMoney(Number(deal.cash_paid))} cash
          </span>
        </>
      )}

      {deal.cash_received != null && Number(deal.cash_received) > 0 && (
        <>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            +{fmtMoney(Number(deal.cash_received))} cash
          </span>
        </>
      )}

      {profit !== null && (
        <>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <span className={`text-sm font-semibold ${profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {profit >= 0 ? '+' : '−'}{fmtMoney(profit)}
          </span>
        </>
      )}

      <svg
        xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className="ml-auto shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
      </svg>
    </Link>
  );
}

// ── Vertical connector line ───────────────────────────────────────────────────

function VerticalLine() {
  return (
    <div className="flex justify-center py-1">
      <div className="h-8 w-px bg-slate-200 dark:bg-slate-700" />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TradeChainPage() {
  const params = useParams();
  const itemId = Number(params.id);

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

  const itemMap = useMemo(
    () => Object.fromEntries((data?.inventoryItems ?? []).map((i) => [i.id, i])),
    [data],
  );
  const brandMap = useMemo(
    () => Object.fromEntries((data?.brands ?? []).map((b) => [b.id, b.name])),
    [data],
  );
  const dealItemsByDealId = useMemo(() => {
    const map: Record<number, DealItem[]> = {};
    (data?.dealItems ?? []).forEach((di) => {
      map[di.deal_id] ??= [];
      map[di.deal_id].push(di);
    });
    return map;
  }, [data]);

  // Each deal becomes one step; incoming items shown as nodes, outgoing implicit
  const steps: ChainStep[] = useMemo(
    () =>
      (data?.deals ?? []).map((deal) => {
        const slots = dealItemsByDealId[deal.id] ?? [];
        return {
          deal,
          incoming: slots.filter((di) => di.direction === 'in'),
          outgoing: slots.filter((di) => di.direction === 'out'),
        };
      }),
    [data, dealItemsByDealId],
  );

  const rootItem  = itemMap[itemId];
  const rootBrand = brandMap[rootItem?.brand_id ?? 0] ?? '';

  return (
    <div className="space-y-6">

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <Link
          href={`/inventory/${itemId}`}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          Back to item
        </Link>
        <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Trade Chain</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
          {rootItem ? `${rootBrand} ${rootItem.model}` : 'Item Lineage'}
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Full connected trade, purchase, and sale history for this item.
        </p>
      </section>

      {/* ── Chain body ────────────────────────────────────────────────────────── */}
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">

        {loading ? (
          <div className="flex items-center gap-2.5 py-4">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600 dark:border-slate-700 dark:border-t-slate-300" />
            <span className="text-sm text-slate-500 dark:text-slate-400">Building trade chain…</span>
          </div>

        ) : error ? (
          <p className="py-4 text-sm text-rose-600 dark:text-rose-400">{error}</p>

        ) : steps.length === 0 ? (
          <p className="py-4 text-sm text-slate-500 dark:text-slate-400">No trade chain yet.</p>

        ) : (
          <div>
            {steps.map((step, index) => (
              <div key={step.deal.id}>

                {/* Vertical line above connector (not on first step) */}
                {index > 0 && <VerticalLine />}

                {/* Deal connector */}
                <DealConnector
                  deal={step.deal}
                  outgoing={step.outgoing}
                  itemMap={itemMap}
                />

                {/* Incoming item nodes — one per newly-acquired item in this deal */}
                {step.incoming.length > 0 && (
                  <>
                    <VerticalLine />
                    <div className={`grid gap-3 ${step.incoming.length >= 2 ? 'sm:grid-cols-2' : ''}`}>
                      {step.incoming.map((di) => (
                        <ItemNode
                          key={di.id}
                          di={di}
                          item={itemMap[di.item_id]}
                          brand={brandMap[itemMap[di.item_id]?.brand_id ?? 0] ?? 'Unknown'}
                          photoUrl={data?.photoByItemId[di.item_id]}
                          isCurrentItem={di.item_id === itemId}
                        />
                      ))}
                    </div>
                  </>
                )}

              </div>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
