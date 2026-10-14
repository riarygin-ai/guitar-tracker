// Server-callable "Copy Item Context" assembly — the authoritative item
// context used by both the Inventory Item detail page's Copy Item Context
// button AND the read-only MCP `get_item_context` tool (src/app/api/mcp).
//
// This module does NOT reimplement item-context business logic. It only
// performs the small set of TARGETED lookups needed to replace what
// InventoryForm.tsx currently happens to already have in React state
// (brand name, category/type/purpose names, tags, financials, acquired
// date) — then hands everything to the existing, unmodified formatter
// (buildItemContext) and history loader (loadItemContextHistory), exactly
// as InventoryForm.tsx itself does. See itemContext.ts / itemContextData.ts
// for those.
//
// Ownership / isolation: this module takes NO user id of any kind. The
// caller passes an already-authenticated, request-scoped SupabaseClient
// (RLS-bound to whoever that token belongs to); every query here is a
// plain `.eq('id', itemId)`-style read through that client. A foreign
// item_id simply returns zero rows everywhere (RLS, not an app-level
// filter) — getItemContextForUser treats that identically to a genuinely
// nonexistent item, returning `null` either way, so a caller can never
// distinguish "exists but not yours" from "doesn't exist".
//
// Query shape: 1 (base item + value_in + subtype/purpose names, via the
// existing inventory_items_with_value view) + up to 4 small targeted
// lookups (brand name, category name, tags, value_out, acquired date) run
// in parallel where independent, plus loadItemContextHistory's own fixed 6
// queries. No N+1: the query count never grows with how much history the
// item has.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InventoryItem, InventoryItemWithValue } from '@/types';
import { buildItemContext } from '../itemContext';
import { loadItemContextHistory, ItemContextLoadError } from '../itemContextData';
import { calculateItemProfitMetrics } from '../profit';

export class ItemContextServiceError extends Error {}

/**
 * Builds the exact "Copy Item Context" plain-text snapshot for one item,
 * scoped entirely by the caller's own client/RLS. Returns `null` when the
 * item does not exist OR does not belong to the authenticated caller —
 * the two cases are indistinguishable by design (see module header).
 */
export async function getItemContextForUser(
  client: SupabaseClient,
  itemId: number,
): Promise<string | null> {
  if (!Number.isInteger(itemId) || itemId <= 0) return null;

  // ── 1. Base item (ownership check happens HERE, via RLS: a foreign or
  // nonexistent id both resolve to no row). Reuses the same view
  // InventoryForm.tsx's own metrics panel already relies on — it already
  // joins item_subtype_name/purpose_name and computes value_in. ──────────
  const { data: itemRow, error: itemError } = await client
    .from('inventory_items_with_value')
    .select('*')
    .eq('id', itemId)
    .maybeSingle();
  if (itemError) throw new ItemContextServiceError(`item lookup: ${itemError.message}`);
  if (!itemRow) return null;

  const item = itemRow as unknown as InventoryItemWithValue;

  // ── 2. Everything else: independent, run in parallel. ──────────────────
  const [brandRes, categoryRes, tagsRes, outValueRes, acquiredRes, expensesRes, history] = await Promise.all([
    client.from('brands').select('name').eq('id', item.brand_id).maybeSingle(),
    item.item_subtype_id != null
      ? client.from('item_subtypes').select('item_categories(name)').eq('id', item.item_subtype_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    client.from('inventory_item_tags').select('tag_id').eq('item_id', itemId),
    client.from('deal_items').select('direction, total_value').eq('item_id', itemId),
    client.from('deal_items').select('deals(deal_date)').eq('item_id', itemId).eq('direction', 'in'),
    client.from('inventory_expenses').select('amount').eq('item_id', itemId),
    loadItemContextHistory(client, itemId),
  ]);

  if (brandRes.error) throw new ItemContextServiceError(`brand lookup: ${brandRes.error.message}`);
  if (categoryRes.error) throw new ItemContextServiceError(`category lookup: ${categoryRes.error.message}`);
  if (tagsRes.error) throw new ItemContextServiceError(`tags lookup: ${tagsRes.error.message}`);
  if (outValueRes.error) throw new ItemContextServiceError(`deal_items (value out) lookup: ${outValueRes.error.message}`);
  if (acquiredRes.error) throw new ItemContextServiceError(`deal_items (acquired date) lookup: ${acquiredRes.error.message}`);
  if (expensesRes.error) throw new ItemContextServiceError(`expenses lookup: ${expensesRes.error.message}`);

  const brandName = (brandRes.data as { name: string } | null)?.name ?? null;
  // PostgREST may embed a to-one relation as a single object or (when supabase-js
  // can't infer cardinality without generated Database types) as a one-element
  // array — handle both shapes rather than assuming one.
  const categoryEmbed = (categoryRes.data as unknown as { item_categories: { name: string } | { name: string }[] | null } | null)?.item_categories ?? null;
  const categoryName = (Array.isArray(categoryEmbed) ? categoryEmbed[0] : categoryEmbed)?.name ?? null;

  const tagIds = ((tagsRes.data ?? []) as { tag_id: number }[]).map((r) => r.tag_id);
  let tagNames: string[] = [];
  if (tagIds.length > 0) {
    const { data: tagRows, error: tagNamesError } = await client.from('inventory_tags').select('id, name').in('id', tagIds);
    if (tagNamesError) throw new ItemContextServiceError(`tag names lookup: ${tagNamesError.message}`);
    tagNames = ((tagRows ?? []) as { id: number; name: string }[])
      .sort((a, b) => tagIds.indexOf(a.id) - tagIds.indexOf(b.id))
      .map((t) => t.name);
  }

  const outRows = (outValueRes.data ?? []) as { direction: string; total_value: number | null }[];
  const outSum = outRows.filter((r) => r.direction === 'out').reduce((s, r) => s + Number(r.total_value ?? 0), 0);
  const valueOut = outSum > 0 ? outSum : null;

  const acquiredDates = ((acquiredRes.data ?? []) as unknown as { deals: { deal_date: string } | { deal_date: string }[] | null }[])
    .map((r) => (Array.isArray(r.deals) ? r.deals[0] : r.deals)?.deal_date)
    .filter((d): d is string => !!d)
    .sort();
  const acquiredDate = acquiredDates.length > 0 ? acquiredDates[acquiredDates.length - 1] : null;

  const totalExpenses = ((expensesRes.data ?? []) as { amount: number | null }[]).reduce((sum, e) => sum + (e.amount ?? 0), 0);

  const { potentialReward, potentialROI, realizedGain, realizedROI } = calculateItemProfitMetrics({
    valueIn: item.value_in,
    valueOut,
    estimatedSoldValue: item.estimated_sold_value,
    totalExpenses,
  });

  const baseItem: InventoryItem = {
    id: item.id,
    user_id: item.user_id,
    brand_id: item.brand_id,
    item_subtype_id: item.item_subtype_id,
    model: item.model,
    serial_number: item.serial_number,
    sold_date: item.sold_date,
    estimated_sold_value: item.estimated_sold_value,
    collection_type: item.collection_type,
    purpose_id: item.purpose_id,
    condition: item.condition,
    status: item.status,
    notes: item.notes,
    year: item.year,
    color: item.color,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  return buildItemContext(baseItem, {
    brandName,
    categoryName,
    typeName: item.item_subtype_name ?? null,
    purposeName: item.purpose_name ?? null,
    tagNames,
    valueIn: item.value_in,
    valueOut,
    totalExpenses,
    potentialReward,
    potentialRoi: potentialROI,
    realizedGain,
    realizedRoi: realizedROI,
    acquiredDate,
    exitDealId: history.exitDealId,
    listingCycles: history.listingCycles,
    leads: history.leads,
  });
}

export { ItemContextLoadError };
