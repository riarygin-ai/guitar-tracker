// Server-callable inventory search — reuses the existing user-scoped
// `inventory_items_search` view and the existing term-matching behavior
// (src/lib/supabase.ts -> searchInventoryItems) so the read-only MCP
// `search_inventory` tool (src/app/api/mcp) never duplicates the view or
// the matching rule. Framework-free: takes an already-authenticated,
// request-scoped SupabaseClient, never a user id of any kind — RLS (plus
// the view's own `WHERE user_id = get_app_user_id()`) is what scopes
// results to the caller, not an application-level filter.
//
// Deliberately NOT a change to src/lib/supabase.ts's searchInventoryItems
// (still used by the browser UI, untouched) — this is a parallel, equally
// small function against the same view + the same pure splitSearchTerms,
// so neither the SQL nor the matching rule is duplicated, only the client
// plumbing differs (browser singleton vs. request-scoped MCP client).

import type { SupabaseClient } from '@supabase/supabase-js';
import { splitSearchTerms } from './search';

export const INVENTORY_SEARCH_MAX_RESULTS = 20;

/** Deliberately trimmed — identity/disambiguation fields only. Never notes,
 *  financials, leads, or listing history (see get_item_context for those). */
export interface InventorySearchResult {
  item_id: number;
  brand: string;
  model: string;
  year: number | null;
  color: string | null;
  category: string | null;
  type: string | null;
  purpose: string | null;
  status: string;
  serial_number: string | null;
}

export interface SearchInventoryParams {
  /** Free-text query, matched the same way the existing UI search matches
   *  (brand/model/color/year/serial_number/notes substrings — notes are
   *  used for MATCHING only; they never appear in the trimmed result). */
  query?: string;
  /** Defaults to excluding sold/traded, matching searchInventoryItems'
   *  own default. Pass explicit statuses to include/narrow instead. */
  status?: string[];
  /** Case-insensitive substring match against brand_name. */
  brand?: string;
  /** Case-insensitive substring match against purpose_name. */
  purpose?: string;
}

interface SearchViewRow {
  id: number;
  brand_name: string;
  model: string;
  year: number | null;
  color: string | null;
  status: string;
  serial_number: string | null;
  notes: string | null;
  item_subtype_id: number | null;
  item_subtype_name: string | null;
  purpose_name: string | null;
}

export class InventorySearchServiceError extends Error {}

/**
 * Searches the authenticated caller's own inventory only (via RLS on the
 * `inventory_items_search` view). Never accepts, and has no parameter for,
 * any user/account/owner identifier — identity comes entirely from the
 * client's own auth context.
 */
export async function searchInventoryForUser(
  client: SupabaseClient,
  params: SearchInventoryParams,
): Promise<InventorySearchResult[]> {
  let dbQuery = client
    .from('inventory_items_search')
    .select('id, brand_name, model, year, color, status, serial_number, notes, item_subtype_id, item_subtype_name, purpose_name')
    .order('created_at', { ascending: false });

  if (params.status && params.status.length > 0) {
    dbQuery = dbQuery.in('status', params.status);
  } else {
    dbQuery = dbQuery.not('status', 'in', '("sold","traded")');
  }

  const { data, error } = await dbQuery;
  if (error) throw new InventorySearchServiceError(`inventory search: ${error.message}`);

  let rows = (data ?? []) as SearchViewRow[];

  if (params.brand?.trim()) {
    const b = params.brand.trim().toLowerCase();
    rows = rows.filter((r) => r.brand_name.toLowerCase().includes(b));
  }
  if (params.purpose?.trim()) {
    const p = params.purpose.trim().toLowerCase();
    rows = rows.filter((r) => (r.purpose_name ?? '').toLowerCase().includes(p));
  }

  const terms = splitSearchTerms(params.query ?? '');
  if (terms.length > 0) {
    rows = rows.filter((item) =>
      terms.every((term) =>
        (item.brand_name ?? '').toLowerCase().includes(term) ||
        (item.model ?? '').toLowerCase().includes(term) ||
        (item.color ?? '').toLowerCase().includes(term) ||
        String(item.year ?? '').toLowerCase().includes(term) ||
        (item.serial_number ?? '').toLowerCase().includes(term) ||
        (item.notes ?? '').toLowerCase().includes(term)
      )
    );
  }

  rows = rows.slice(0, INVENTORY_SEARCH_MAX_RESULTS);

  // Category names aren't on the view (only subtype/"type" name is) —
  // one bounded lookup for the distinct subtype ids in THIS page of
  // results, never per-row (no N+1 regardless of result count).
  const subtypeIds = Array.from(new Set(rows.map((r) => r.item_subtype_id).filter((v): v is number => v != null)));
  const categoryBySubtypeId = new Map<number, string>();
  if (subtypeIds.length > 0) {
    const { data: subtypeRows, error: subtypeError } = await client
      .from('item_subtypes')
      .select('id, item_categories(name)')
      .in('id', subtypeIds);
    if (subtypeError) throw new InventorySearchServiceError(`category lookup: ${subtypeError.message}`);
    // See itemContextService.ts for why both embed shapes (object vs. one-element array) are handled.
    for (const s of (subtypeRows ?? []) as unknown as { id: number; item_categories: { name: string } | { name: string }[] | null }[]) {
      const cat = Array.isArray(s.item_categories) ? s.item_categories[0] : s.item_categories;
      if (cat?.name) categoryBySubtypeId.set(s.id, cat.name);
    }
  }

  return rows.map((r) => ({
    item_id: r.id,
    brand: r.brand_name,
    model: r.model,
    year: r.year,
    color: r.color,
    category: r.item_subtype_id != null ? categoryBySubtypeId.get(r.item_subtype_id) ?? null : null,
    type: r.item_subtype_name,
    purpose: r.purpose_name,
    status: r.status,
    serial_number: r.serial_number,
  }));
}
