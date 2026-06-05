import Link from 'next/link';
import type { InventoryItemWithValue } from '@/types';

const statusClasses: Record<string, string> = {
  owned: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  listed: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  sold: 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  traded: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
};

interface InventoryCardProps {
  item: InventoryItemWithValue;
  brandName: string;
  backQuery?: string;
}

export default function InventoryCard({ item, brandName, backQuery }: InventoryCardProps) {
  const title = [item.year, brandName, item.model].filter(Boolean).join(' ');
  const subtitle = item.color ? `${title} — ${item.color}` : title;

  const isOwned = item.status === 'owned' || item.status === 'listed';
  const isSoldOrTraded = item.status === 'sold' || item.status === 'traded';

  const potentialReward =
    isOwned && item.estimated_sold_value != null && item.value_in != null
      ? item.estimated_sold_value - item.value_in
      : null;

  const potentialRoi =
    potentialReward != null && item.value_in != null && item.value_in > 0
      ? (potentialReward / item.value_in) * 100
      : null;

  const realizedGain =
    isSoldOrTraded && item.value_out != null && item.value_in != null
      ? item.value_out - item.value_in
      : null;

  const realizedRoi =
    realizedGain != null && item.value_in != null && item.value_in > 0
      ? (realizedGain / item.value_in) * 100
      : null;

  const roiColor = (roi: number | null) =>
    roi == null ? '' : roi > 0 ? 'text-emerald-600' : roi < 0 ? 'text-rose-600' : '';

  return (
    <Link
      href={backQuery ? `/inventory/${item.id}?${backQuery}` : `/inventory/${item.id}`}
      className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-700 dark:bg-slate-800"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            {item.item_type}
          </p>

          <h3 className="mt-1 truncate text-base font-semibold text-slate-900 dark:text-white">
            {subtitle}
          </h3>
        </div>

        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[item.status] ?? 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200'
            }`}
        >
          {item.status}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-700 dark:text-slate-200">
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
      </div>

      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-700 dark:text-slate-200">
        {isOwned ? (
          <>
            <span>
              <span className="text-slate-500 dark:text-slate-400">Potential Reward:</span>{' '}
              {potentialReward != null ? `$${potentialReward.toFixed(0)}` : '—'}
            </span>
            <span>
              <span className="text-slate-500 dark:text-slate-400">Potential ROI:</span>{' '}
              <span className={roiColor(potentialRoi)}>
                {potentialRoi != null ? `${potentialRoi.toFixed(1)}%` : '—'}
              </span>
            </span>
          </>
        ) : (
          <>
            <span>
              <span className="text-slate-500 dark:text-slate-400">Realized Gain:</span>{' '}
              {realizedGain != null ? `$${realizedGain.toFixed(0)}` : '—'}
            </span>
            <span>
              <span className="text-slate-500 dark:text-slate-400">Realized ROI:</span>{' '}
              <span className={roiColor(realizedRoi)}>
                {realizedRoi != null ? `${realizedRoi.toFixed(1)}%` : '—'}
              </span>
            </span>
          </>
        )}
      </div>
    </Link>
  );
}
