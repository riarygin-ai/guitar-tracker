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
//   ─────────────────────────────────────────────
//   Additional items in this deal
//   + Fender Stratocaster
//   − Gibson Les Paul

interface DealCardProps {
  deal:             Deal;
  primaryIn:        DealItem[];
  outgoing:         DealItem[];
  bundleItems:      DealItem[];
  mainItemIds:      Set<number>;
  itemMap:          Record<number, InventoryItemWithValue>;
  brandMap:         Record<number, string>;
  photoByItemId:    Record<number, string>;
  expensesByItemId: Record<number, number>;
  runningProfit:    number;
}

function DealCard({
  deal, primaryIn, outgoing, bundleItems, mainItemIds,
  itemMap, brandMap, photoByItemId, expensesByItemId, runningProfit,
}: DealCardProps) {
  const isValueDeal  = deal.deal_type === 'sale' || deal.deal_type === 'trade';
  const cashPaid     = Number(deal.cash_paid ?? 0);
  const cashReceived = Number(deal.cash_received ?? 0);

  // Only count profit for main-chain items — bundle siblings must not inflate this
  const profit = isValueDeal
    ? outgoing
        .filter((di) => mainItemIds.has(di.item_id))
        .reduce((sum, di) => {
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
                    Cash Paid −{fmtMoney(cashPaid)}
                  </span>
                )}
                {cashReceived > 0 && (
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Cash Received +{fmtMoney(cashReceived)}
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

      {/* Bundle context: other items in this deal not on the main chain */}
      {bundleItems.length > 0 && (
        <div className="mt-2 border-t border-slate-100 pt-2 dark:border-slate-700">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            Additional items in this deal
          </p>
          <div className="flex flex-col gap-0.5">
            {bundleItems.map((di) => {
              const item = itemMap[di.item_id];
              if (!item) return null;
              const brand = brandMap[item.brand_id] ?? 'Unknown';
              return (
                <span key={di.item_id} className="truncate text-xs text-slate-400 dark:text-slate-500">
                  {di.direction === 'in' ? '+' : '−'} {brand} {item.model}
                </span>
              );
            })}
          </div>
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
        const mainIn      = step.incoming.filter((di) =>  mainItemIds.has(di.item_id));
        const primaryIn   = mainIn.length > 0 ? mainIn : step.incoming;
        // Bundle context: items in this deal that are NOT on the main chain
        const bundleIn    = step.incoming.filter((di) => !mainItemIds.has(di.item_id));
        const bundleOut   = step.outgoing.filter((di) => !mainItemIds.has(di.item_id));
        const bundleItems = [...bundleIn, ...bundleOut];
        const dotColor    = DOT_COLORS[step.deal.deal_type] ?? 'bg-slate-300 dark:bg-slate-600';

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
                bundleItems={bundleItems}
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
  mainItemIds:        Set<number>;
  itemMap:            Record<number, InventoryItemWithValue>;
  finalRunningProfit: number;
  totalChainExpenses: number;
}

function ChainSummary({ steps, mainItemIds, itemMap, finalRunningProfit, totalChainExpenses }: ChainSummaryProps) {
  // Cost basis = only the selected item's acquisition value, not full bundle deal cost
  const startingCost = steps[0]?.incoming
    .filter((di) => mainItemIds.has(di.item_id))
    .reduce((s, di) => s + Number(di.total_value ?? 0), 0) ?? 0;

  const cashExtracted = steps.reduce(
    (s, step) => s + Number(step.deal.cash_received ?? 0), 0,
  );

  // Only count currently-held items that are on the main chain
  const heldValues = new Map<number, number>();
  steps.forEach((step) => {
    [...step.incoming, ...step.outgoing]
      .filter((di) => mainItemIds.has(di.item_id))
      .forEach((di) => {
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
        <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">Deal Chain Summary</h2>
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

  // Direct lineage walk — avoids sibling-branch pollution.
  //
  // Algorithm:
  //   Walk BACKWARD: if item X was received in a trade, the items that went OUT
  //   in that same trade are X's "predecessors" (what was given up). Add them to
  //   the chain and recurse. Purchase deals have no outgoing items, so the walk
  //   stops at the first purchase.
  //
  //   Walk FORWARD: if item X was traded away, the items that came IN via that
  //   trade are X's "successors". Add them and recurse. Sale deals have no
  //   incoming items, so the walk stops at a sale.
  //
  //   Siblings (other items received in the SAME bundle deal) are in
  //   inItemsByDealId[deal], NOT outItemsByDealId[deal]. They are never
  //   added here, so their future deals never appear in steps.
  const mainItemIds = useMemo(() => {
    const ids = new Set<number>([itemId]);

    const acqDealByItemId:      Record<number, number>   = {};
    const disposalDealByItemId: Record<number, number>   = {};
    const inItemsByDealId:      Record<number, number[]> = {};
    const outItemsByDealId:     Record<number, number[]> = {};
    const dealTypeById:         Record<number, string>   = {};

    for (const deal of data?.deals ?? []) {
      dealTypeById[deal.id] = deal.deal_type;
    }
    for (const di of data?.dealItems ?? []) {
      if (di.direction === 'in') {
        if (acqDealByItemId[di.item_id] === undefined) acqDealByItemId[di.item_id] = di.deal_id;
        (inItemsByDealId[di.deal_id] ??= []).push(di.item_id);
      } else {
        disposalDealByItemId[di.item_id] = di.deal_id;
        (outItemsByDealId[di.deal_id] ??= []).push(di.item_id);
      }
    }

    const walkBackward = (id: number) => {
      const acqDeal = acqDealByItemId[id];
      if (acqDeal === undefined || dealTypeById[acqDeal] !== 'trade') return;
      for (const prevId of outItemsByDealId[acqDeal] ?? []) {
        if (!ids.has(prevId)) { ids.add(prevId); walkBackward(prevId); }
      }
    };

    const walkForward = (id: number) => {
      const disposalDeal = disposalDealByItemId[id];
      if (disposalDeal === undefined || dealTypeById[disposalDeal] !== 'trade') return;
      for (const nextId of inItemsByDealId[disposalDeal] ?? []) {
        if (!ids.has(nextId)) { ids.add(nextId); walkForward(nextId); }
      }
    };

    walkBackward(itemId);
    walkForward(itemId);

    return ids;
  }, [data, itemId]);

  // Only include deals where at least one main-chain item is directly involved.
  // Deals that only contain siblings are excluded entirely.
  const steps: ChainStep[] = useMemo(
    () => (data?.deals ?? [])
      .filter((deal) => {
        const slots = dealItemsByDealId[deal.id] ?? [];
        return slots.some((di) => mainItemIds.has(di.item_id));
      })
      .map((deal) => {
        const slots = dealItemsByDealId[deal.id] ?? [];
        return {
          deal,
          incoming: slots.filter((di) => di.direction === 'in'),
          outgoing: slots.filter((di) => di.direction === 'out'),
        };
      }),
    [data, dealItemsByDealId, mainItemIds],
  );

  const runningProfits = useMemo(() => {
    let running = 0;
    return steps.map((step) => {
      if (step.deal.deal_type === 'sale' || step.deal.deal_type === 'trade') {
        running += step.outgoing
          .filter((di) => mainItemIds.has(di.item_id))
          .reduce((sum, di) => {
            const item         = itemMap[di.item_id];
            const itemExpenses = expensesByItemId[di.item_id] ?? 0;
            return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0) - itemExpenses);
          }, 0);
      }
      return running;
    });
  }, [steps, itemMap, expensesByItemId, mainItemIds]);

  const finalRunningProfit = runningProfits[runningProfits.length - 1] ?? 0;
  // Expenses scoped to main-chain items only
  const totalChainExpenses = Array.from(mainItemIds).reduce(
    (sum, id) => sum + (expensesByItemId[id] ?? 0), 0,
  );

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
          Direct lineage of trades, purchases, and sales for this item.
        </p>
      </section>

      {/* Chain summary */}
      {!loading && !error && steps.length > 0 && (
        <ChainSummary
          steps={steps}
          mainItemIds={mainItemIds}
          itemMap={itemMap}
          finalRunningProfit={finalRunningProfit}
          totalChainExpenses={totalChainExpenses}
        />
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
