'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { InventoryItemWithValue } from '@/types';
import { calculateItemProfitMetrics } from '@/lib/profit';

const statusClasses: Record<string, string> = {
  new: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  owned: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  listed: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  sold: 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  traded: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
};

interface InventoryCardProps {
  item: InventoryItemWithValue;
  brandName: string;
  backQuery?: string;
  mainPhotoUrl?: string | null;
  subtypeName?: string;
  totalExpenses?: number;
  onBeforeNavigate?: () => void;
}

export default function InventoryCard({ item, brandName, backQuery, mainPhotoUrl, subtypeName, totalExpenses = 0, onBeforeNavigate }: InventoryCardProps) {
  const router = useRouter();
  const title = [item.year, brandName, item.model].filter(Boolean).join(' ');
  const subtitle = item.color ? `${title} — ${item.color}` : title;

  const isOwned = item.status === 'owned' || item.status === 'listed';
  const isSoldOrTraded = item.status === 'sold' || item.status === 'traded';

  const {
    potentialReward,
    potentialROI,
    realizedGain,
    realizedROI,
  } = calculateItemProfitMetrics({
    valueIn: item.value_in,
    valueOut: isSoldOrTraded ? item.value_out : null,
    estimatedSoldValue: isOwned ? item.estimated_sold_value : null,
    totalExpenses,
  });

  const roiColor = (roi: number | null) =>
    roi == null ? '' : roi > 0 ? 'text-emerald-600' : roi < 0 ? 'text-rose-600' : '';
  const fmtRoi = (roi: number | null, gain: number | null) =>
    roi != null ? `${roi.toFixed(1)}%` : gain != null ? 'N/A' : '—';

  const itemHref = backQuery ? `/inventory/${item.id}?${backQuery}` : `/inventory/${item.id}`;

  return (
    <div
      data-item-id={item.id}
      className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-700 dark:bg-slate-800"
      onClick={() => { onBeforeNavigate?.(); router.push(itemHref); }}
    >
      <div className="flex items-start gap-3">
        {/* Thumbnail */}
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-slate-700 sm:h-20 sm:w-20">
          {mainPhotoUrl ? (
            <Image
              src={mainPhotoUrl}
              alt={subtitle}
              fill
              className="object-cover"
              sizes="80px"
              unoptimized
            />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 m-auto h-7 w-7 text-slate-300 dark:text-slate-600">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                {subtypeName ?? '—'}
              </p>
              <h3 className="mt-1 truncate text-base font-semibold text-slate-900 dark:text-white">
                {subtitle}
              </h3>
            </div>

            {/* Top-right: status badge + View Chain stacked */}
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[item.status] ?? 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200'}`}
              >
                {item.status}
              </span>
              <Link
                href={`/inventory/${item.id}/chain`}
                onClick={(e) => e.stopPropagation()}
                className="hidden sm:inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
              >
                View Deal Chain
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </Link>
            </div>
          </div>

          <div className="mt-2 flex flex-col gap-y-1 text-sm text-slate-700 dark:text-slate-200 sm:flex-row sm:flex-wrap sm:gap-x-6">
            <span>
              <span className="text-slate-500 dark:text-slate-400">Value In:</span>{' '}
              {item.value_in != null ? `$${item.value_in.toFixed(0)}` : '—'}
            </span>
            {isOwned ? (
              <span>
                <span className="text-slate-500 dark:text-slate-400">Est. Sold:</span>{' '}
                ${item.estimated_sold_value?.toFixed(0) ?? '0'}
              </span>
            ) : (
              <span>
                <span className="text-slate-500 dark:text-slate-400">Value Out:</span>{' '}
                {item.value_out != null ? `$${item.value_out.toFixed(0)}` : '—'}
              </span>
            )}
            {isOwned ? (
              <>
                <span>
                  <span className="text-slate-500 dark:text-slate-400">Est. Profit:</span>{' '}
                  {potentialReward != null ? `$${potentialReward.toFixed(0)}` : '—'}
                </span>
                <span>
                  <span className="text-slate-500 dark:text-slate-400">Est. ROI:</span>{' '}
                  <span className={roiColor(potentialROI)}>
                    {fmtRoi(potentialROI, potentialReward)}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span>
                  <span className="text-slate-500 dark:text-slate-400">Realized Profit:</span>{' '}
                  {realizedGain != null ? `$${realizedGain.toFixed(0)}` : '—'}
                </span>
                <span>
                  <span className="text-slate-500 dark:text-slate-400">Realized ROI:</span>{' '}
                  <span className={roiColor(realizedROI)}>
                    {fmtRoi(realizedROI, realizedGain)}
                  </span>
                </span>
              </>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
