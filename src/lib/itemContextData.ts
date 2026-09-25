// Loads the history that "Copy Item Context" adds on top of what the Item
// Detail page already has in memory: every listing cycle (all platforms, all
// statuses), each cycle's complete price history, every lead for the item,
// and the item's completed EXIT deal (Sell, or the Trade it went OUT on —
// never its acquisition deal). Read-only and free of the app's supabase
// singleton — the caller passes its authenticated client, so everything is
// scoped by the caller's own RLS (item_listings / item_listing_price_history
// / item_leads / deal_items / deals each only expose the owner's rows; a
// foreign item id simply returns nothing).
//
// No N+1: exactly six queries regardless of how many cycles/leads/deals
// exist —
//   1. item_listings              WHERE inventory_item_id = :item
//   2. deal_channels               WHERE id IN (channels used by listings/leads)
//   3. item_leads                  WHERE inventory_item_id = :item
//   4. item_listing_price_history  WHERE item_listing_id IN (all cycle ids)
//   5. deal_items (direction='out') WHERE item_id = :item
//   6. deals                       WHERE id IN (deal ids from query 5)
// (1, 3 and 5 run in parallel; 2 and 4 need the listing/channel ids from 1/3;
// 6 needs the deal ids from 5).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ItemContextLead, ItemContextListingCycle, ItemContextPriceChange } from './itemContext';

export class ItemContextLoadError extends Error {}

export interface ItemContextHistory {
  listingCycles: ItemContextListingCycle[];
  leads: ItemContextLead[];
  /** The item's completed exit (realization) deal id, or null — see module header. */
  exitDealId: number | null;
}

// Deal types deal_items' 'out' direction is ever written for in this app —
// mirrors analytics_item_lifecycle's own exit_deal CTE (is_realized = deal_type
// IN ('sale', 'trade')): a Sell or a Trade the item went out on. 'out' rows are
// never created for 'purchase'/'expense'/historical-import deals (those only
// ever write 'in'), so this filter is defensive parity, not a load-bearing
// distinction in practice.
const REALIZED_EXIT_DEAL_TYPES = new Set(['sale', 'trade']);

/**
 * The completed deal that realized (sold/traded away) this item, or null.
 * NEVER the acquisition deal, and NEVER a trade that brought the item IN
 * while it is still owned — only a deal_items row on the item's OUTGOING
 * ('out') side counts. An item can leave inventory at most once (a
 * sold/traded item's status becomes terminal), so in practice at most one
 * such row exists; the ORDER BY below is defensive in case that is ever
 * violated (same tie-break as analytics_item_lifecycle's exit_deal CTE:
 * latest deal_date, then latest deal_items.id).
 */
async function loadItemExitDealId(client: SupabaseClient, itemId: number): Promise<number | null> {
  const { data: outRows, error: outError } = await client
    .from('deal_items')
    .select('id, deal_id')
    .eq('item_id', itemId)
    .eq('direction', 'out');
  if (outError) throw new ItemContextLoadError(`deal_items (exit): ${outError.message}`);

  const rows = (outRows ?? []) as { id: number; deal_id: number }[];
  if (rows.length === 0) return null;

  const dealIds = Array.from(new Set(rows.map((r) => r.deal_id)));
  const { data: dealRows, error: dealError } = await client.from('deals').select('id, deal_date, deal_type').in('id', dealIds);
  if (dealError) throw new ItemContextLoadError(`deals (exit): ${dealError.message}`);

  const dealsById = new Map(((dealRows ?? []) as { id: number; deal_date: string; deal_type: string }[]).map((d) => [d.id, d]));
  const realized = rows
    .map((r) => ({ ...r, deal: dealsById.get(r.deal_id) }))
    .filter((r): r is typeof r & { deal: { id: number; deal_date: string; deal_type: string } } => !!r.deal && REALIZED_EXIT_DEAL_TYPES.has(r.deal.deal_type));
  if (realized.length === 0) return null;

  realized.sort((a, b) => {
    if (a.deal.deal_date !== b.deal.deal_date) return a.deal.deal_date < b.deal.deal_date ? 1 : -1;
    return b.id - a.id;
  });
  return realized[0].deal_id;
}

const LISTING_COLUMNS = 'id, deal_channel_id, status, listed_at, ended_at, cancelled_at, asking_price, trade_value';
const LEAD_COLUMNS =
  'id, first_contact_at, last_contact_at, source_channel, deal_channel_id, lead_quality, status, offer_type, ' +
  'initial_cash_offer, best_cash_offer, trade_item, cash_component, trade_est_value, outcome_reason, notes, ' +
  'buyer_message_count, our_message_count';

export async function loadItemContextHistory(client: SupabaseClient, itemId: number): Promise<ItemContextHistory> {
  const [listingsRes, leadsRes, exitDealId] = await Promise.all([
    client.from('item_listings').select(LISTING_COLUMNS).eq('inventory_item_id', itemId).order('listed_at', { ascending: true, nullsFirst: false }).order('id', { ascending: true }),
    client.from('item_leads').select(LEAD_COLUMNS).eq('inventory_item_id', itemId).order('first_contact_at', { ascending: true, nullsFirst: false }).order('id', { ascending: true }),
    loadItemExitDealId(client, itemId),
  ]);
  if (listingsRes.error) throw new ItemContextLoadError(`listings: ${listingsRes.error.message}`);
  if (leadsRes.error) throw new ItemContextLoadError(`leads: ${leadsRes.error.message}`);

  const listings = (listingsRes.data ?? []) as unknown as Record<string, unknown>[];
  const leadRows = (leadsRes.data ?? []) as unknown as Record<string, unknown>[];

  const channelIds = Array.from(new Set([
    ...listings.map((l) => l.deal_channel_id as number),
    ...leadRows.map((l) => l.deal_channel_id as number | null).filter((v): v is number => v != null),
  ]));
  const listingIds = listings.map((l) => l.id as number);

  const [channelsRes, historyRes] = await Promise.all([
    channelIds.length > 0 ? client.from('deal_channels').select('id, name').in('id', channelIds) : Promise.resolve({ data: [], error: null }),
    listingIds.length > 0
      ? client.from('item_listing_price_history').select('id, item_listing_id, old_asking_price, new_asking_price, changed_at').in('item_listing_id', listingIds).order('changed_at', { ascending: true }).order('id', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (channelsRes.error) throw new ItemContextLoadError(`channels: ${channelsRes.error.message}`);
  if (historyRes.error) throw new ItemContextLoadError(`price history: ${historyRes.error.message}`);

  const channelNames = new Map<number, string>(((channelsRes.data ?? []) as { id: number; name: string }[]).map((c) => [c.id, c.name]));

  const historyByListing = new Map<number, ItemContextPriceChange[]>();
  for (const h of (historyRes.data ?? []) as Record<string, unknown>[]) {
    const id = h.item_listing_id as number;
    const list = historyByListing.get(id) ?? [];
    list.push({
      changedAt: h.changed_at as string,
      oldPrice: h.old_asking_price == null ? null : Number(h.old_asking_price),
      newPrice: Number(h.new_asking_price),
    });
    historyByListing.set(id, list);
  }

  const listingCycles: ItemContextListingCycle[] = listings.map((l) => ({
    id: l.id as number,
    platformName: channelNames.get(l.deal_channel_id as number) ?? `Channel ${l.deal_channel_id as number}`,
    status: l.status as ItemContextListingCycle['status'],
    listedAt: (l.listed_at as string | null) ?? null,
    endedAt: (l.ended_at as string | null) ?? null,
    cancelledAt: (l.cancelled_at as string | null) ?? null,
    askingPrice: l.asking_price == null ? null : Number(l.asking_price),
    tradeValue: l.trade_value == null ? null : Number(l.trade_value),
    priceHistory: historyByListing.get(l.id as number) ?? [],
  }));

  const num = (v: unknown) => (v == null ? null : Number(v));
  const leads: ItemContextLead[] = leadRows.map((r) => ({
    id: r.id as number,
    first_contact_at: (r.first_contact_at as string | null) ?? null,
    last_contact_at: (r.last_contact_at as string | null) ?? null,
    source_channel: (r.source_channel as string | null) ?? null,
    channel_name: r.deal_channel_id != null ? channelNames.get(r.deal_channel_id as number) ?? null : null,
    lead_quality: r.lead_quality as ItemContextLead['lead_quality'],
    status: r.status as ItemContextLead['status'],
    offer_type: r.offer_type as ItemContextLead['offer_type'],
    initial_cash_offer: num(r.initial_cash_offer),
    best_cash_offer: num(r.best_cash_offer),
    trade_item: (r.trade_item as string | null) ?? null,
    cash_component: num(r.cash_component),
    trade_est_value: num(r.trade_est_value),
    outcome_reason: (r.outcome_reason as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    buyer_message_count: num(r.buyer_message_count),
    our_message_count: num(r.our_message_count),
  }));

  return { listingCycles, leads, exitDealId };
}
