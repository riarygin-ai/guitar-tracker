// Trade Chain data loader — the deal/item graph reachable from one item.
//
// Extracted unchanged from src/lib/supabase.ts getItemLineage (which now
// delegates here) so the SAME traversal can run against any Supabase
// client: the browser's own client on /inventory/[id]/chain, and the MCP
// server's request-scoped, RLS-bound client for get_deal_chain. Every query
// is a plain read through `client`; deals / deal_items / inventory_items_
// with_value only ever expose the caller's own rows (RLS / the view's
// get_app_user_id() filter), so a foreign item id simply yields nothing.
//
// Algorithm (unchanged): breadth-first over deal_items — items -> every deal
// they appear in -> every item in those deals — up to MAX_DEPTH rounds, then
// one parallel round for the full rows. Photos are deliberately not loaded
// here (storage URLs are a UI concern; getItemLineage adds them).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Brand, Deal, DealItem, InventoryItemWithValue } from '@/types';

export interface ItemLineageRows {
  deals: Deal[];
  dealItems: DealItem[];
  inventoryItems: InventoryItemWithValue[];
  brands: Brand[];
}

const MAX_DEPTH = 10;

export async function loadItemLineage(
  client: SupabaseClient,
  rootItemId: number,
): Promise<{ data: ItemLineageRows | null; error: string | null }> {
  const empty: ItemLineageRows = { deals: [], dealItems: [], inventoryItems: [], brands: [] };

  const visitedDealIds = new Set<number>();
  const visitedItemIds = new Set<number>();

  let itemQueue: number[] = [rootItemId];

  for (let depth = 0; depth < MAX_DEPTH && itemQueue.length > 0; depth++) {
    itemQueue.forEach((id) => visitedItemIds.add(id));

    // Find deals involving any item in the current queue
    const { data: itemSlots, error: e1 } = await client
      .from('deal_items')
      .select('deal_id, item_id')
      .in('item_id', itemQueue);

    if (e1) return { data: null, error: e1.message };
    if (!itemSlots?.length) break;

    const newDealIds = Array.from(
      new Set((itemSlots as { deal_id: number }[]).map((s) => s.deal_id))
    ).filter((id) => !visitedDealIds.has(id));

    if (newDealIds.length === 0) break;
    newDealIds.forEach((id) => visitedDealIds.add(id));

    // Find all items in those new deals
    const { data: dealSlots, error: e2 } = await client
      .from('deal_items')
      .select('deal_id, item_id')
      .in('deal_id', newDealIds);

    if (e2) return { data: null, error: e2.message };
    if (!dealSlots) break;

    // Enqueue items we haven't visited yet
    itemQueue = Array.from(
      new Set((dealSlots as { item_id: number }[]).map((s) => s.item_id))
    ).filter((id) => !visitedItemIds.has(id));
  }

  if (visitedDealIds.size === 0) return { data: empty, error: null };

  const dealIdList = Array.from(visitedDealIds);
  const itemIdList = Array.from(visitedItemIds);

  const [dealsRes, allSlotsRes, itemsRes, brandsRes] = await Promise.all([
    client.from('deals').select('*').in('id', dealIdList).order('deal_date', { ascending: true }),
    client.from('deal_items').select('*').in('deal_id', dealIdList),
    client.from('inventory_items_with_value').select('*').in('id', itemIdList),
    client.from('brands').select('*').order('name', { ascending: true }),
  ]);

  if (dealsRes.error) return { data: null, error: dealsRes.error.message };

  return {
    data: {
      deals:          (dealsRes.data    ?? []) as Deal[],
      dealItems:      (allSlotsRes.data ?? []) as DealItem[],
      inventoryItems: (itemsRes.data    ?? []) as InventoryItemWithValue[],
      brands:         (brandsRes.data   ?? []) as Brand[],
    },
    error: null,
  };
}
