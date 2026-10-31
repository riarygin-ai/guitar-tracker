'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import OperationDraftBadge from '@/components/OperationDraftBadge';
import { getInventorySearchItemsByIds } from '@/lib/supabase';
import { listOpenDrafts, type OperationDraft } from '@/lib/operations/operationDraftsClient';
import { formatCalendarDate } from '@/lib/dateUtils';
import type { InventorySearchItem } from '@/types';

const cad = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Open operation drafts, above the completed operations. Drafts are not
 * operations yet, so they are never mixed into the list, its counts or its
 * totals — a separate, visibly "Draft" block that links to each draft.
 */
export default function OperationDraftsSection() {
  const [drafts, setDrafts] = useState<OperationDraft[]>([]);
  const [items, setItems] = useState<Record<number, InventorySearchItem>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await listOpenDrafts();
      if (!alive || r.error) return;
      setDrafts(r.data);
      const ids = Array.from(new Set(r.data.flatMap((d) => d.operation_draft_items.map((x) => x.item_id))));
      if (ids.length) {
        const it = await getInventorySearchItemsByIds(ids);
        if (alive) setItems(Object.fromEntries(((it.data ?? []) as InventorySearchItem[]).map((i) => [i.id, i])));
      }
    })();
    return () => { alive = false; };
  }, []);

  if (drafts.length === 0) return null;

  const name = (id: number) => { const i = items[id]; return i ? `${i.brand_name ?? ''} ${i.model}`.trim() : `#${id}`; };
  const side = (d: OperationDraft, dir: 'in' | 'out') => {
    const ids = d.operation_draft_items.filter((x) => x.direction === dir).map((x) => x.item_id);
    if (ids.length === 0) return null;
    return ids.length === 1 ? name(ids[0]) : `${name(ids[0])} +${ids.length - 1}`;
  };

  return (
    <section className="rounded-3xl border-2 border-dashed border-amber-300 bg-amber-50/40 p-4 shadow-sm dark:border-amber-700 dark:bg-amber-900/10" data-testid="operation-drafts">
      <div className="flex items-baseline justify-between gap-2">
        <p className="section-label">Drafts — not completed</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{drafts.length} open</p>
      </div>
      <div className="mt-3 space-y-2">
        {drafts.map((d) => {
          const give = side(d, 'out');
          const get = side(d, 'in');
          return (
            <Link key={d.id} href={`/operations/drafts/${d.id}`} className="block rounded-2xl border border-amber-200 bg-white p-3 transition hover:border-amber-300 dark:border-amber-800 dark:bg-slate-800 dark:hover:border-amber-600">
              <div className="flex flex-wrap items-center gap-2">
                <OperationDraftBadge type={d.operation_type} />
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  #{d.id}{d.proposed_date ? ` · planned ${formatCalendarDate(d.proposed_date, { month: 'short', day: 'numeric' })}` : ''}{d.contact_name ? ` · ${d.contact_name}` : ''}
                </span>
              </div>
              <p className="mt-1.5 text-sm text-slate-800 [overflow-wrap:anywhere] dark:text-slate-200">
                {give && <span>Give: <span className="font-medium">{give}</span></span>}
                {give && get && <span className="text-slate-400"> → </span>}
                {get && <span>Get: <span className="font-medium">{get}</span></span>}
                {d.cash_received > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · +{cad(d.cash_received)}</span>}
                {d.cash_paid > 0 && <span className="text-rose-700 dark:text-rose-400"> · −{cad(d.cash_paid)}</span>}
              </p>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
