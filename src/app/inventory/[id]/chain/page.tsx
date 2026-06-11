'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getItemLineage, getInventoryExpensesByItemIds, type ItemTimelineData } from '@/lib/supabase';
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

const DOT_COLORS: Record<string, string> = {
  purchase: 'bg-blue-400 dark:bg-blue-500',
  sale:     'bg-emerald-400 dark:bg-emerald-500',
  trade:    'bg-violet-400 dark:bg-violet-500',
  expense:  'bg-rose-400 dark:bg-rose-500',
};

// ── Unified deal card ─────────────────────────────────────────────────────────
// Layout (mobile-first):
//   [Badge] Item name                     [Photo?]
//   Date
//   Channel
//                                         ±$X cash
//   ─────────────────────────────────────────────
//   PROFIT                               ±$X,XXX
//   Running                              ±$X,XXX

interface DealCardProps {
  deal:             Deal;
  primaryIn:        DealItem[];
  outgoing:         DealItem[];
  mainItemIds:      Set<number>;
  itemMap:          Record<number, InventoryItemWithValue>;
  brandMap:         Record<number, string>;
  photoByItemId:    Record<number, string>;
  expensesByItemId: Record<number, number>;
  runningProfit:    number;
}

function DealCard({
  deal, primaryIn, outgoing, mainItemIds,
  itemMap, brandMap, photoByItemId, expensesByItemId, runningProfit,
}: DealCardProps) {
  const isValueDeal  = deal.deal_type === 'sale' || deal.deal_type === 'trade';
  const cashPaid     = Number(deal.cash_paid ?? 0);
  const cashReceived = Number(deal.cash_received ?? 0);

  const profit = isValueDeal
    ? outgoing.reduce((sum, di) => {
        const item         = itemMap[di.item_id];
        const itemExpenses = expensesByItemId[di.item_id] ?? 0;
        return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0) - itemExpenses);
      }, 0)
    : null;

  const typeColor = DEAL_TYPE_COLORS[deal.deal_type] ?? DEAL_TYPE_COLORS.purchase;

  // Primary item: prefer main-chain incoming; fall back to main-chain outgoing (sale)
  const primaryDi   = primaryIn[0] ?? outgoing.find((di) => mainItemIds.has(di.item_id)) ?? null;
  const primaryItem = primaryDi ? itemMap[primaryDi.item_id] : null;
  const displayName = primaryItem
    ? `${brandMap[primaryItem.brand_id] ?? 'Unknown'} ${primaryItem.model}`
    : null;
  const photoUrl = primaryDi ? (photoByItemId[primaryDi.item_id] ?? null) : null;

  const hasCash  = cashPaid > 0 || cashReceived > 0;
  const hasRight = !!photoUrl || hasCash;

  return (
    <Link
      href={`/operations/${deal.id}`}
      className="group block rounded-xl border border-slate-200 bg-slate-50 p-3 transition-colors hover:bg-slate-100 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:bg-slate-700/70 md:rounded-2xl md:p-4"
    >
      {/* Top section: left info | right photo + cash */}
      <div className="flex items-start justify-between gap-3">

        {/* Left: badge + name, date, channel */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold md:px-2.5 md:text-xs ${typeColor}`}>
              {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
            </span>
            {displayName && (
              <span className="truncate text-sm font-semibold text-slate-900 dark:text-white">
                {displayName}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {formatDate(deal.deal_date)}
          </p>
          {deal.channel && (
            <p className="text-xs text-slate-400 dark:text-slate-500">{deal.channel}</p>
          )}
        </div>

        {/* Right: photo (if available) + cash adjustment */}
        {hasRight && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            {photoUrl && (
              <div className="relative h-12 w-12 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-700">
                <Image
                  src={photoUrl}
                  alt={displayName ?? ''}
                  fill
                  className="object-cover"
                  sizes="48px"
                  unoptimized
                />
              </div>
            )}
            {hasCash && (
              <div className="flex flex-col items-end gap-0.5">
                {cashPaid > 0 && (
                  <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
                    −{fmtMoney(cashPaid)} cash
                  </span>
                )}
                {cashReceived > 0 && (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    +{fmtMoney(cashReceived)} cash
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Profit + running (sale / trade only) */}
      {profit !== null && (
        <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-700">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500 md:text-xs">
              Profit
            </span>
            <span className={`text-base font-bold tabular-nums md:text-lg ${profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {profit >= 0 ? '+' : '−'}{fmtMoney(profit)}
            </span>
          </div>
          {runningProfit !== 0 && (
            <div className="mt-0.5 flex items-center justify-between text-xs">
              <span className="text-slate-400 dark:text-slate-500">Running</span>
              <span className={`font-semibold tabular-nums ${runningProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {runningProfit >= 0 ? '+' : '−'}{fmtMoney(runningProfit)}
              </span>
            </div>
          )}
        </div>
      )}
    </Link>
  );
}

// ── Chain timeline ────────────────────────────────────────────────────────────

interface ChainTimelineProps {
  steps:            ChainStep[];
  itemMap:          Record<number, InventoryItemWithValue>;
  brandMap:         Record<number, string>;
  photoByItemId:    Record<number, string>;
  mainItemIds:      Set<number>;
  runningProfits:   number[];
  expensesByItemId: Record<number, number>;
}

function ChainTimeline({
  steps, itemMap, brandMap, photoByItemId, mainItemIds, runningProfits, expensesByItemId,
}: ChainTimelineProps) {
  return (
    <div className="relative">
      {/* Vertical rail */}
      <div className="absolute bottom-3 left-[15px] top-3 w-px bg-slate-200 dark:bg-slate-700 md:left-[22px]" />

      {steps.map((step, index) => {
        const mainIn    = step.incoming.filter((di) => mainItemIds.has(di.item_id));
        const primaryIn = mainIn.length > 0 ? mainIn : step.incoming;
        const dotColor  = DOT_COLORS[step.deal.deal_type] ?? 'bg-slate-300 dark:bg-slate-600';

        return (
          <div
            key={step.deal.id}
            className={`relative flex gap-3 md:gap-5 ${index < steps.length - 1 ? 'pb-4 md:pb-6' : ''}`}
          >
            {/* Dot */}
            <div className="relative z-10 flex w-[30px] shrink-0 flex-col items-center pt-[13px] md:w-[44px] md:pt-[15px]">
              <div className={`h-2.5 w-2.5 rounded-full border-2 border-white dark:border-slate-800 md:h-3 md:w-3 ${dotColor}`} />
            </div>

            {/* Unified card */}
            <div className="min-w-0 flex-1 pb-1">
              <DealCard
                deal={step.deal}
                primaryIn={primaryIn}
                outgoing={step.outgoing}
                mainItemIds={mainItemIds}
                itemMap={itemMap}
                brandMap={brandMap}
                photoByItemId={photoByItemId}
                expensesByItemId={expensesByItemId}
                runningProfit={runningProfits[index]}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Chain summary ─────────────────────────────────────────────────────────────

interface ChainSummaryProps {
  steps:              ChainStep[];
  itemMap:            Record<number, InventoryItemWithValue>;
  finalRunningProfit: number;
  totalChainExpenses: number;
}

function ChainSummary({ steps, itemMap, finalRunningProfit, totalChainExpenses }: ChainSummaryProps) {
  const startingCost = steps[0]?.incoming.reduce(
    (s, di) => s + Number(di.total_value ?? 0), 0,
  ) ?? 0;

  const cashExtracted = steps.reduce(
    (s, step) => s + Number(step.deal.cash_received ?? 0), 0,
  );

  const heldValues = new Map<number, number>();
  steps.forEach((step) => {
    [...step.incoming, ...step.outgoing].forEach((di) => {
      if (heldValues.has(di.item_id)) return;
      const item = itemMap[di.item_id];
      if (item?.status === 'owned' || item?.status === 'listed') {
        heldValues.set(di.item_id, Number(item.estimated_sold_value ?? 0));
      }
    });
  });
  const currentAssetValue = Array.from(heldValues.values()).reduce((a, b) => a + b, 0);

  const totalValueCreated = cashExtracted + currentAssetValue;
  const totalInvested     = startingCost + totalChainExpenses;
  const chainRoi          = totalInvested > 0 ? ((totalValueCreated / totalInvested) - 1) * 100 : null;

  const metrics: { label: string; value: string; accent?: string }[] = [
    { label: 'Started', value: steps[0]?.deal.deal_date ? formatDate(steps[0].deal.deal_date) : '—' },
    { label: 'Operations', value: String(steps.length) },
    { label: 'Cost Basis', value: startingCost > 0 ? fmtMoney(startingCost) : '—' },
    {
      label: 'Cash Extracted',
      value: cashExtracted > 0 ? fmtMoney(cashExtracted) : '—',
      accent: cashExtracted > 0 ? 'text-emerald-600 dark:text-emerald-400' : undefined,
    },
    {
      label: 'Running Profit',
      value: finalRunningProfit !== 0
        ? (finalRunningProfit >= 0 ? '+' : '−') + fmtMoney(finalRunningProfit)
        : '—',
      accent: finalRunningProfit > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : finalRunningProfit < 0
        ? 'text-rose-600 dark:text-rose-400'
        : undefined,
    },
    { label: 'Current Assets', value: fmtMoney(currentAssetValue) },
    ...(chainRoi !== null ? [{
      label: 'ROI',
      value: (chainRoi >= 0 ? '+' : '') + chainRoi.toFixed(0) + '%',
      accent: chainRoi >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
    }] : []),
  ];

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <div className="mb-4">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">Chain Summary</p>
        <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">Investment journey</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {metrics.map(({ label, value, accent }) => (
          <div key={label} className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/60">
            <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-slate-400 dark:text-slate-500">{label}</p>
            <p className={`mt-1 text-lg font-bold tabular-nums leading-tight ${accent ?? 'text-slate-900 dark:text-white'}`}>
              {value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TradeChainPage() {
  const params = useParams();
  const itemId = Number(params.id);

  const [data,             setData]             = useState<ItemTimelineData | null>(null);
  const [loading,          setLoading]          = useState(true);
  const [error,            setError]            = useState<string | null>(null);
  const [expensesByItemId, setExpensesByItemId] = useState<Record<number, number>>({});

  useEffect(() => {
    let cancelled = false;
    getItemLineage(itemId).then(({ data, error }) => {
      if (!cancelled) { setData(data); setError(error); setLoading(false); }

      const allItemIds = (data?.inventoryItems ?? []).map((i: any) => i.id as number);
      if (allItemIds.length > 0) {
        getInventoryExpensesByItemIds(allItemIds).then((result) => {
          if (cancelled || result.error || !result.data) return;
          const map: Record<number, number> = {};
          for (const exp of result.data) {
            if (exp.item_id != null) map[exp.item_id] = (map[exp.item_id] ?? 0) + exp.amount;
          }
          if (!cancelled) setExpensesByItemId(map);
        });
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
    (data?.dealItems ?? []).forEach((di) => { map[di.deal_id] ??= []; map[di.deal_id].push(di); });
    return map;
  }, [data]);

  const steps: ChainStep[] = useMemo(
    () => (data?.deals ?? []).map((deal) => {
      const slots = dealItemsByDealId[deal.id] ?? [];
      return {
        deal,
        incoming: slots.filter((di) => di.direction === 'in'),
        outgoing: slots.filter((di) => di.direction === 'out'),
      };
    }),
    [data, dealItemsByDealId],
  );

  const mainItemIds = useMemo(() => {
    const ids = new Set<number>([itemId]);
    const acqDeal: Record<number, number>    = {};
    const outItems: Record<number, number[]> = {};
    (data?.dealItems ?? []).forEach((di) => {
      if (di.direction === 'in'  && acqDeal[di.item_id]  === undefined) acqDeal[di.item_id] = di.deal_id;
      if (di.direction === 'out') { outItems[di.deal_id] ??= []; outItems[di.deal_id].push(di.item_id); }
    });
    let queue = [itemId];
    while (queue.length > 0) {
      const next: number[] = [];
      for (const id of queue) {
        const deal = acqDeal[id];
        if (deal === undefined) continue;
        for (const prev of outItems[deal] ?? []) {
          if (!ids.has(prev)) { ids.add(prev); next.push(prev); }
        }
      }
      queue = next;
    }
    return ids;
  }, [data, itemId]);

  const runningProfits = useMemo(() => {
    let running = 0;
    return steps.map((step) => {
      if (step.deal.deal_type === 'sale' || step.deal.deal_type === 'trade') {
        running += step.outgoing.reduce((sum, di) => {
          const item         = itemMap[di.item_id];
          const itemExpenses = expensesByItemId[di.item_id] ?? 0;
          return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0) - itemExpenses);
        }, 0);
      }
      return running;
    });
  }, [steps, itemMap, expensesByItemId]);

  const finalRunningProfit = runningProfits[runningProfits.length - 1] ?? 0;
  const totalChainExpenses = Object.values(expensesByItemId).reduce((sum, v) => sum + v, 0);

  const rootItem  = itemMap[itemId];
  const rootBrand = brandMap[rootItem?.brand_id ?? 0] ?? '';

  return (
    <div className="space-y-6">

      {/* Page header */}
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <Link href={`/inventory/${itemId}`}
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

      {/* Chain summary */}
      {!loading && !error && steps.length > 0 && (
        <ChainSummary steps={steps} itemMap={itemMap} finalRunningProfit={finalRunningProfit} totalChainExpenses={totalChainExpenses} />
      )}

      {/* Chain timeline */}
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
          <ChainTimeline
            steps={steps}
            itemMap={itemMap}
            brandMap={brandMap}
            photoByItemId={data?.photoByItemId ?? {}}
            mainItemIds={mainItemIds}
            runningProfits={runningProfits}
            expensesByItemId={expensesByItemId}
          />
        )}
      </section>

    </div>
  );
}
