'use client';

// Loads the stored economics inputs an operation form does not hold itself:
// each item's existing Value In (inventory_items_with_value.value_in, its
// acquisition deal_items.total_value) and its accumulated inventory expenses
// (inventory_expenses). Same sources the completed /operations/[id] page uses.
// Shared by the Buy / Sell / Trade forms, so Create, Draft and Edit show the
// same numbers.

import { useEffect, useState } from 'react';
import { getInventoryExpensesByItemIds, getInventoryItemsWithValueByIds } from '@/lib/supabase';
import { sumExpensesByItem } from '@/lib/operations/itemEconomics';

export interface StoredItemEconomics {
  /** Existing acquisition value; null when the item has no acquisition yet (e.g. a new incoming item). */
  valueIn: number | null;
  expenses: number;
}

export function useItemEconomicsInputs(itemIds: number[]): {
  byItemId: Record<number, StoredItemEconomics>;
  loaded: boolean;
} {
  const key = Array.from(new Set(itemIds)).sort((a, b) => a - b).join(',');
  const [state, setState] = useState<{ key: string; byItemId: Record<number, StoredItemEconomics> }>({ key: '', byItemId: {} });

  useEffect(() => {
    const ids = key ? key.split(',').map(Number) : [];
    if (ids.length === 0) { setState({ key, byItemId: {} }); return; }
    let cancelled = false;
    Promise.all([getInventoryItemsWithValueByIds(ids), getInventoryExpensesByItemIds(ids)]).then(([vals, exps]) => {
      if (cancelled) return;
      const valueIn: Record<number, number | null> = {};
      for (const r of (vals.data ?? []) as { id: number; value_in: number | null }[]) {
        valueIn[r.id] = r.value_in != null ? Number(r.value_in) : null;
      }
      const expenses = sumExpensesByItem((exps.data ?? []) as { item_id: number | null; amount: number }[]);
      const next: Record<number, StoredItemEconomics> = {};
      for (const id of ids) next[id] = { valueIn: valueIn[id] ?? null, expenses: expenses[id] ?? 0 };
      setState({ key, byItemId: next });
    });
    return () => { cancelled = true; };
  }, [key]);

  return { byItemId: state.byItemId, loaded: state.key === key };
}
