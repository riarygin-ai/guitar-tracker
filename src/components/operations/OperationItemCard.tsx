'use client';

// The ONE item card of the editable Buy / Sell / Trade forms. Create
// (/operations/new), Draft (/operations/drafts/[id]) and Edit
// (/operations/[id]/edit) all render the same forms, and every form renders
// its items through this card — so the economics display can never drift
// between modes. The read-only /operations/[id] page reuses EconStat /
// EconLine below for the same vocabulary.
//
// Hierarchy (compact):
//   outgoing  identity · Value In · Est. Sold Value · [Value Out]
//             Expenses · Gain · ROI          (secondary, derived)
//   incoming  identity · Est. Sold Value · [Value In]
//             Potential Reward · Potential ROI (secondary, derived)

import Image from 'next/image';
import type { ReactNode } from 'react';
import {
  ECON_LABEL,
  fmtMoney,
  fmtPct,
  fmtSignedMoney,
  incomingEconomics,
  outgoingEconomics,
  parseAmount,
  signTone,
} from '@/lib/operations/itemEconomics';
import type { StoredItemEconomics } from '@/lib/operations/useItemEconomicsInputs';

const TONE = {
  trade: 'border-purple-200 bg-purple-50 dark:border-purple-700 dark:bg-purple-900/20',
  sell: 'border-emerald-200 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20',
  buy: 'border-blue-200 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20',
} as const;

/** A read-only economics figure (label over value). */
export function EconStat({ label, value, tone, testId }: { label: string; value: string; tone?: string; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-0.5 whitespace-nowrap text-sm font-semibold ${tone ?? 'text-slate-900 dark:text-white'}`}>{value}</p>
    </div>
  );
}

/** Secondary derived context: "Expenses $75 · Gain +$525 · ROI 23.1%". */
export function EconLine({ parts, testId }: { parts: { label: string; value: string; tone?: string }[]; testId?: string }) {
  if (parts.length === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400" data-testid={testId}>
      {parts.map((p) => (
        <span key={p.label} className="whitespace-nowrap">
          {p.label} <span className={`font-semibold ${p.tone ?? 'text-slate-700 dark:text-slate-200'}`}>{p.value}</span>
        </span>
      ))}
    </p>
  );
}

/** Secondary line parts for an outgoing item. Shared with the completed page. */
export function outgoingLineParts(e: { expenses: number; gain: number | null; roiPercent: number | null }, gainLabel: string) {
  const parts: { label: string; value: string; tone?: string }[] = [];
  if (e.expenses > 0) parts.push({ label: ECON_LABEL.expenses, value: fmtMoney(e.expenses) });
  if (e.gain != null) {
    parts.push({ label: gainLabel, value: fmtSignedMoney(e.gain), tone: signTone(e.gain) });
    parts.push({ label: ECON_LABEL.roi, value: fmtPct(e.roiPercent), tone: signTone(e.roiPercent) });
  }
  return parts;
}

/** Secondary line parts for an incoming item. Shared with the completed page. */
export function incomingLineParts(e: { expenses: number; potentialReward: number | null; potentialRoiPercent: number | null; estimatedSoldValue: number | null }) {
  const parts: { label: string; value: string; tone?: string }[] = [];
  if (e.expenses > 0) parts.push({ label: ECON_LABEL.expenses, value: fmtMoney(e.expenses) });
  if (e.potentialReward != null) {
    parts.push({ label: ECON_LABEL.potentialReward, value: fmtSignedMoney(e.potentialReward), tone: signTone(e.potentialReward) });
    parts.push({ label: ECON_LABEL.potentialRoi, value: fmtPct(e.potentialRoiPercent), tone: signTone(e.potentialRoiPercent) });
  } else if (e.estimatedSoldValue == null) {
    parts.push({ label: 'Potential', value: `— no ${ECON_LABEL.estSoldValue}` });
  }
  return parts;
}

const INPUT_CLASS =
  'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 dark:border-slate-600 dark:bg-slate-600 dark:text-slate-100 dark:focus:ring-slate-600';

export interface OperationItemCardProps {
  itemId: number;
  direction: 'out' | 'in';
  tone: keyof typeof TONE;
  label: string;
  photoUrl?: string;
  chips?: (string | null | undefined)[];
  estimatedSoldValue: number | null | undefined;
  /** Stored Value In + expenses (useItemEconomicsInputs); undefined while loading. */
  stored: StoredItemEconomics | undefined;
  /** Editable field: Value Out (outgoing) / Value In (incoming). Label maps onto the same stored field. */
  valueLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  onRemove?: () => void;
  /** Mode-specific extras under the card (draft "Edit · photos" hint). */
  footer?: ReactNode;
}

export default function OperationItemCard({
  itemId, direction, tone, label, photoUrl, chips, estimatedSoldValue, stored,
  valueLabel, value, onValueChange, onRemove, footer,
}: OperationItemCardProps) {
  const esv = estimatedSoldValue != null ? Number(estimatedSoldValue) : null;
  const expenses = stored?.expenses ?? 0;
  const out = direction === 'out'
    ? outgoingEconomics({ itemId, valueIn: stored?.valueIn ?? null, expenses, estimatedSoldValue: esv, valueOut: parseAmount(value) })
    : null;
  const inc = direction === 'in'
    ? incomingEconomics({ valueIn: parseAmount(value), expenses, estimatedSoldValue: esv })
    : null;
  const parts = out ? outgoingLineParts(out, ECON_LABEL.gain) : inc ? incomingLineParts(inc) : [];
  const inputId = `op-item-${direction}-${itemId}-value`;

  return (
    <div className={`rounded-2xl border p-4 ${TONE[tone]}`} data-testid={`op-item-${direction}-${itemId}`}>
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-4 gap-y-3 md:grid-cols-[4rem_minmax(0,1fr)_auto]">
        <div className="relative h-16 w-16 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-600">
          {photoUrl ? (
            <Image src={photoUrl} alt={label} fill className="object-cover" unoptimized sizes="64px" />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-6 w-6 text-slate-300 dark:text-slate-500">
              <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
            </svg>
          )}
        </div>

        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-slate-900 dark:text-white">{label}</p>
          {chips && chips.some(Boolean) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chips.filter(Boolean).map((c, i) => (
                <span key={`${c}-${i}`} className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-600 dark:text-slate-300">{c}</span>
              ))}
            </div>
          )}
        </div>

        <div className="col-span-2 grid grid-cols-2 items-end gap-x-4 gap-y-2 md:col-span-1 md:flex md:gap-4" data-testid={`op-item-${direction}-${itemId}-economics`}>
          {out && (
            <EconStat
              label={ECON_LABEL.valueIn}
              value={stored ? fmtMoney(out.valueIn) : '…'}
              testId={`op-item-out-${itemId}-value-in`}
            />
          )}
          <EconStat label={ECON_LABEL.estSoldValue} value={fmtMoney(esv)} testId={`op-item-${direction}-${itemId}-esv`} />
          <div className={`flex items-end gap-2 ${out ? 'col-span-2' : ''} md:col-span-1`}>
            <div className="min-w-0 flex-1 md:w-28 md:flex-none">
              <label htmlFor={inputId} className="mb-1 block whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {valueLabel}
              </label>
              <input
                id={inputId}
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={value}
                onChange={(e) => onValueChange(e.target.value)}
                placeholder="0.00"
                className={INPUT_CLASS}
              />
            </div>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label="Remove item"
                className="h-9 shrink-0 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-rose-50 hover:text-rose-600 dark:border-slate-500 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-rose-900/20 dark:hover:text-rose-400"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {parts.length > 0 && (
          <div className="col-span-2 md:col-span-2 md:col-start-2">
            <EconLine parts={parts} testId={`op-item-${direction}-${itemId}-derived`} />
          </div>
        )}
      </div>
      {footer}
    </div>
  );
}
