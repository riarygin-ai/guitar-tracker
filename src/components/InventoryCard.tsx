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
  return (
    <Link href={`/inventory/${item.id}`} className="block rounded-3xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.item_type}</p>
          <h3 className="text-lg font-semibold text-slate-900">
            {brandName} {item.model}
          </h3>
          <p className="mt-1 text-sm text-slate-600">{item.collection_type ?? 'No collection type'}</p>
        </div>
        <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusClasses[item.status] ?? 'bg-slate-100 text-slate-800'}`}>
          {item.status}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Acquired</p>
          <p>{item.date_acquired ?? '—'}</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Listed</p>
          <p>{item.date_listed ?? '—'}</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Sold</p>
          <p>{item.sold_date ?? '—'}</p>
        </div>
        <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-700">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Est. sold value</p>
          <p>${item.estimated_sold_value?.toFixed(2) ?? '0.00'}</p>
        </div>
      </div>
    </Link>
  );
}
