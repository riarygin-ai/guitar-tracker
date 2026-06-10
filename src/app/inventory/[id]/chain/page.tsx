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

const STATUS_STYLES: Record<string, string> = {
  owned:  'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  listed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  sold:   'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
  traded: 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
};

function PhotoPlaceholder({ small }: { small?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        className={`${small ? 'h-4 w-4' : 'h-6 w-6'} text-slate-300 dark:text-slate-600`}>
        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
      </svg>
    </div>
  );
}

// ── Deal card (unified, responsive) ──────────────────────────────────────────

interface DealCardProps {
  deal:              Deal;
  outgoing:          DealItem[];
  itemMap:           Record<number, InventoryItemWithValue>;
  expensesByItemId:  Record<number, number>;
  runningProfit:     number;
}

function DealCard({ deal, outgoing, itemMap, expensesByItemId, runningProfit }: DealCardProps) {
  const isValueDeal  = deal.deal_type === 'sale' || deal.deal_type === 'trade';
  const cashPaid     = Number(deal.cash_paid ?? 0);
  const cashReceived = Number(deal.cash_received ?? 0);
  const profit = isValueDeal
    ? outgoing.reduce((sum, di) => {
        const item = itemMap[di.item_id];
        const itemExpenses = expensesByItemId[di.item_id] ?? 0;
        return sum + (Number(di.total_value ?? 0) - Number(item?.value_in ?? 0) - itemExpenses);
      }, 0)
    : null;
  const typeColor = DEAL_TYPE_COLORS[deal.deal_type] ?? DEAL_TYPE_COLORS.purchase;

  return (
    <Link
      href={`/operations/${deal.id}`}
      className="group block rounded-xl border border-slate-200 bg-slate-50 p-3 transition-colors hover:bg-slate-100 active:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:bg-slate-700/70 md:rounded-2xl md:p-4"
    >
      {/* Type · date · channel */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold md:px-2.5 md:text-xs ${typeColor}`}>
            {deal.deal_type.charAt(0).toUpperCase() + deal.deal_type.slice(1)}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400 md:text-sm">{formatDate(deal.deal_date)}</span>
          {deal.channel && (
            <>
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <span className="text-xs text-slate-400 dark:text-slate-500 md:text-sm">{deal.channel}</span>
            </>
          )}
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="shrink-0 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100">
          <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
        </svg>
      </div>

      {/* Cash in / out */}
      {(cashPaid > 0 || cashReceived > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-2.5 text-xs md:text-sm">
          {cashPaid     > 0 && <span className="font-medium text-rose-600 dark:text-rose-400">−{fmtMoney(cashPaid)} cash</span>}
          {cashReceived > 0 && <span className="font-medium text-emerald-600 dark:text-emerald-400">+{fmtMoney(cashReceived)} cash</span>}
        </div>
      )}

      {/* Profit — emphasized with border separator */}
      {profit !== null && (
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 dark:border-slate-700">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500 md:text-xs">
            Profit
          </span>
          <span className={`text-base font-bold tabular-nums md:text-lg ${profit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {profit >= 0 ? '+' : '−'}{fmtMoney(profit)}
          </span>
        </div>
      )}

      {/* Running profit */}
      {isValueDeal && runningProfit !== 0 && (
        <div className="mt-0.5 flex items-center justify-between text-xs">
          <span className="text-slate-400 dark:text-slate-500">Running</span>
          <span className={`font-semibold tabular-nums ${runningProfit >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {runningProfit >= 0 ? '+' : '−'}{fmtMoney(runningProfit)}
          </span>
        </div>
      )}
    </Link>
  );
}

// ── Chain timeline (unified, responsive) ─────────────────────────────────────
// Mobile (< md): 30px dot column, 48px photos, secondary items collapsed.
// Desktop (≥ md): 44px dot column, 64px photos, secondary items as compact cards.

interface ChainTimelineProps {
  steps:             ChainStep[];
  itemId:            number;
  itemMap:           Record<number, InventoryItemWithValue>;
  brandMap:          Record<number, string>;
  photoByItemId:     Record<number, string>;
  mainItemIds:       Set<number>;
  runningProfits:    number[];
  expensesByItemId:  Record<number, number>;
}

function ChainTimeline({
  steps, itemId, itemMap, brandMap, photoByItemId, mainItemIds, runningProfits, expensesByItemId,
}: ChainTimelineProps) {
  const [expandedDeals, setExpandedDeals] = useState(new Set<number>());

  function toggleExpand(dealId: number) {
    setExpandedDeals((prev) => {
      const next = new Set(prev);
      if (next.has(dealId)) next.delete(dealId); else next.add(dealId);
      return next;
    });
  }

  return (
    <div className="relative">
      {/* Vertical rail — dot column is 30px on mobile, 44px on desktop */}
      <div className="absolute left-[15px] top-3 bottom-3 w-px bg-slate-200 dark:bg-slate-700 md:left-[22px]" />

      {steps.map((step, index) => {
        const mainIn      = step.incoming.filter((di) =>  mainItemIds.has(di.item_id));
        const secondaryIn = step.incoming.filter((di) => !mainItemIds.has(di.item_id));
        const allFull     = mainIn.length === 0;
        const primaryIn   = allFull ? step.incoming : mainIn;
        const isExpanded  = expandedDeals.has(step.deal.id);
        const dotColor    = DOT_COLORS[step.deal.deal_type] ?? 'bg-slate-300 dark:bg-slate-600';

        return (
          <div key={step.deal.id}
            className={`relative flex gap-3 md:gap-5 ${index < steps.length - 1 ? 'pb-4 md:pb-6' : ''}`}
          >
            {/* Dot column */}
            <div className="relative z-10 flex w-[30px] shrink-0 flex-col items-center pt-[13px] md:w-[44px] md:pt-[15px]">
              <div className={`h-2.5 w-2.5 rounded-full border-2 border-white dark:border-slate-800 md:h-3 md:w-3 ${dotColor}`} />
            </div>

            {/* Content column */}
            <div className="min-w-0 flex-1 pb-1">

              {/* Deal card */}
              <DealCard
                deal={step.deal}
                outgoing={step.outgoing}
                itemMap={itemMap}
                expensesByItemId={expensesByItemId}
                runningProfit={runningProfits[index]}
              />

              {/* Primary item cards */}
              {primaryIn.length > 0 && (
                <div className="mt-2 space-y-1.5 md:mt-3 md:space-y-2">
                  {primaryIn.map((di) => {
                    const item      = itemMap[di.item_id];
                    const brand     = brandMap[item?.brand_id ?? 0] ?? 'Unknown';
                    const photoUrl  = photoByItemId[di.item_id];
                    const isCurrent = di.item_id === itemId;
                    const cost      = Number(di.total_value ?? 0);
                    const estSold   = item?.estimated_sold_value != null ? Number(item.estimated_sold_value) : null;
                    if (!item) return null;

                    return (
                      <Link key={di.id} href={`/inventory/${item.id}`}
                        className={`group block rounded-xl border p-3 transition-colors md:rounded-2xl md:p-4 ${
                          isCurrent
                            ? 'border-violet-200 bg-violet-50/60 dark:border-violet-700/50 dark:bg-violet-900/10'
                            : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/30'
                        }`}
                      >
                        {/* Current item badge */}
                        {isCurrent && (
                          <div className="mb-2">
                            <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                              Current item
                            </span>
                          </div>
                        )}

                        <div className="flex items-center gap-3 md:gap-4">
                          {/* Photo */}
                          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-700 md:h-16 md:w-16 md:rounded-xl">
                            {photoUrl
                              ? <Image src={photoUrl} alt={`${brand} ${item.model}`} fill className="object-cover"
                                  sizes="(min-width: 768px) 64px, 48px" unoptimized />
                              : <PhotoPlaceholder />}
                          </div>

                          {/* Info */}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="truncate text-sm font-semibold text-slate-900 group-hover:underline dark:text-white md:text-base">
                                {brand} {item.model}
                              </p>
                              {/* Status badge — desktop only (mobile is too tight) */}
                              {item.status && (
                                <span className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize md:inline-block ${STATUS_STYLES[item.status] ?? STATUS_STYLES.owned}`}>
                                  {item.status}
                                </span>
                              )}
                            </div>
                            {(item.year || item.color) && (
                              <p className="text-[11px] text-slate-500 dark:text-slate-400 md:text-xs">
                                {[item.year, item.color].filter(Boolean).join(' · ')}
                              </p>
                            )}
                            {(cost > 0 || (estSold != null && estSold > 0)) && (
                              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] md:mt-1 md:text-xs">
                                {cost > 0 && (
                                  <span>
                                    <span className="text-slate-400 dark:text-slate-500">Cost </span>
                                    <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(cost)}</span>
                                  </span>
                                )}
                                {estSold != null && estSold > 0 && (
                                  <span>
                                    <span className="text-slate-400 dark:text-slate-500">Est. </span>
                                    <span className="font-medium text-slate-700 dark:text-slate-200">{fmtMoney(estSold)}</span>
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}

              {/* Secondary items */}
              {!allFull && secondaryIn.length > 0 && (
                <>
                  {/* Desktop: compact cards, always expanded */}
                  <div className="mt-2 hidden md:block">
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400 dark:text-slate-500">
                      Also received
                    </p>
                    <div className={`grid gap-2 ${secondaryIn.length >= 2 ? 'md:grid-cols-2' : ''}`}>
                      {secondaryIn.map((di) => {
                        const item     = itemMap[di.item_id];
                        const brand    = brandMap[item?.brand_id ?? 0] ?? 'Unknown';
                        const photoUrl = photoByItemId[di.item_id];
                        if (!item) return null;
                        return (
                          <Link key={di.id} href={`/inventory/${item.id}`}
                            className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/30"
                          >
                            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-700">
                              {photoUrl
                                ? <Image src={photoUrl} alt={`${brand} ${item.model}`} fill className="object-cover" sizes="40px" unoptimized />
                                : <PhotoPlaceholder small />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-slate-800 group-hover:underline dark:text-slate-200">
                                {brand} {item.model}
                              </p>
                              {item.status && (
                                <span className={`mt-0.5 inline-block rounded-full px-1.5 text-[10px] font-medium capitalize ${STATUS_STYLES[item.status] ?? STATUS_STYLES.owned}`}>
                                  {item.status}
                                </span>
                              )}
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </div>

                  {/* Mobile: collapsed, expand on tap */}
                  <div className="mt-1.5 md:hidden">
                    <button type="button" onClick={() => toggleExpand(step.deal.id)}
                      className="flex items-center gap-1.5 rounded-lg py-1 pl-1 pr-2 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                    >
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-300 text-[11px] font-bold leading-none dark:border-slate-600">
                        {isExpanded ? '−' : '+'}
                      </span>
                      {isExpanded
                        ? 'Hide additional'
                        : `${secondaryIn.length} more item${secondaryIn.length > 1 ? 's' : ''}`}
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90' : '-rotate-90'}`}>
                        <polyline points="15 18 9 12 15 6"/>
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="mt-1.5 space-y-1.5">
                        {secondaryIn.map((di) => {
                          const item     = itemMap[di.item_id];
                          const brand    = brandMap[item?.brand_id ?? 0] ?? 'Unknown';
                          const photoUrl = photoByItemId[di.item_id];
                          if (!item) return null;
                          return (
                            <Link key={di.id} href={`/inventory/${item.id}`}
                              className="group flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-2.5 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700/30"
                            >
                              <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-700">
                                {photoUrl
                                  ? <Image src={photoUrl} alt={`${brand} ${item.model}`} fill className="object-cover" sizes="32px" unoptimized />
                                  : <PhotoPlaceholder small />}
                              </div>
                              <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800 group-hover:underline dark:text-slate-200">
                                {brand} {item.model}
                              </p>
                              {item.status && (
                                <span className={`ml-auto shrink-0 rounded-full px-1.5 text-[10px] font-medium capitalize ${STATUS_STYLES[item.status] ?? STATUS_STYLES.owned}`}>
                                  {item.status}
                                </span>
                              )}
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
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

  // Current asset value: owned/listed items, deduplicated by item ID
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

  // ROI = (cash extracted + current assets) / (starting cost + total expenses) − 1
  const totalValueCreated = cashExtracted + currentAssetValue;
  const totalInvested = startingCost + totalChainExpenses;
  const chainRoi = totalInvested > 0 ? ((totalValueCreated / totalInvested) - 1) * 100 : null;

  const metrics: { label: string; value: string; accent?: string }[] = [
    {
      label: 'Started',
      value: steps[0]?.deal.deal_date ? formatDate(steps[0].deal.deal_date) : '—',
    },
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

  // Backward-lineage: current item + all ancestors (items traded away to acquire it)
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

  // Cumulative profit after each sale/trade step
  const runningProfits = useMemo(() => {
    let running = 0;
    return steps.map((step) => {
      if (step.deal.deal_type === 'sale' || step.deal.deal_type === 'trade') {
        running += step.outgoing.reduce((sum, di) => {
          const item = itemMap[di.item_id];
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
            itemId={itemId}
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
