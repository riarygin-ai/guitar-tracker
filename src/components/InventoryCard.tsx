import Link from 'next/link';
import type { InventoryItem } from '@/types';

const statusClasses: Record<string, string> = {
  owned: 'bg-green-100 text-green-800',
  listed: 'bg-yellow-100 text-yellow-800',
  sold: 'bg-slate-100 text-slate-800',
  traded: 'bg-indigo-100 text-indigo-800',
};

interface InventoryCardProps {
  item: InventoryItem;
  brandName: string;
}

export default function InventoryCard({ item, brandName }: InventoryCardProps) {
  const title = [item.year, brandName, item.model].filter(Boolean).join(' ');
  const subtitle = item.color ? `${title} — ${item.color}` : title;

  return (
    <Link
      href={`/inventory/${item.id}`}
      className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
            {item.item_type}
          </p>

          <h3 className="mt-1 truncate text-base font-semibold text-slate-900">
            {subtitle}
          </h3>
        </div>

        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[item.status] ?? 'bg-slate-100 text-slate-800'
            }`}
        >
          {item.status}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-700">
        <span>
          <span className="text-slate-500">Value In:</span> —
        </span>

        <span>
          <span className="text-slate-500">Est. Sold:</span>{' '}
          ${item.estimated_sold_value?.toFixed(0) ?? '0'}
        </span>

        <span>
          <span className="text-slate-500">Listed:</span>{' '}
          {item.date_listed ?? '—'}
        </span>

        <span>
          <span className="text-slate-500">Collection:</span>{' '}
          {item.collection_type ?? '—'}
        </span>
      </div>
    </Link>
  );
}
