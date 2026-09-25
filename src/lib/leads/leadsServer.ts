// Server-only. Loads a user's leads for the read-only /leads screen.
//
// Ownership: every query filters on user_id = appUserId AND runs through
// `db` — in production the CALLER'S OWN RLS-scoped client, so another
// user's rows are unreachable even if the explicit filter were dropped.
// The service-role client is used for exactly one thing: the read-only
// attributed-cohort RPC, always with the caller's own appUserId.
//
// No lead-import normalization happens here: rows are returned as stored.

import type { SupabaseClient } from '@supabase/supabase-js';
import { leadItemName } from './leadFormat';
import type { LeadRow, LeadsPayload, LeadChannelOption } from './leadTypes';

const PAGE = 1000;
const ID_CHUNK = 150;

const LEAD_COLUMNS =
  'id, lead_id, inventory_item_id, first_contact_at, last_contact_at, source_channel, deal_channel_id, ' +
  'buyer_message_count, our_message_count, lead_quality, offer_type, initial_cash_offer, best_cash_offer, ' +
  'trade_item, cash_component, trade_est_value, status, outcome_reason, notes, deal_id, source_updated_at, last_imported_at';

export class LeadsLoadError extends Error {}

export interface LeadAttributionRequest {
  channelId: number;
  from: string;
  to: string;
}

export interface LeadItemAttributionRequest {
  itemId: number;
  from: string;
  to: string;
}

export async function loadLeadsForUser(params: {
  db: SupabaseClient;
  serviceClient: SupabaseClient | null;
  appUserId: number;
  attribution?: LeadAttributionRequest | null;
  itemAttribution?: LeadItemAttributionRequest | null;
}): Promise<LeadsPayload> {
  const { db, serviceClient, appUserId, attribution, itemAttribution } = params;

  // 1. All of the user's leads (paged past PostgREST's row cap).
  const raw: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from('item_leads')
      .select(LEAD_COLUMNS)
      .eq('user_id', appUserId)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new LeadsLoadError(`item_leads: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    raw.push(...page);
    if (page.length < PAGE) break;
  }

  // 2. Display joins (item names, canonical channel names) — read-only.
  const itemIds = Array.from(new Set(raw.map((r) => r.inventory_item_id as number)));
  const items = new Map<number, { year: number | null; model: string | null; brand_id: number | null }>();
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from('inventory_items')
      .select('id, year, model, brand_id')
      .eq('user_id', appUserId)
      .in('id', itemIds.slice(i, i + ID_CHUNK));
    if (error) throw new LeadsLoadError(`inventory_items: ${error.message}`);
    for (const it of data ?? []) items.set(it.id as number, it as { year: number | null; model: string | null; brand_id: number | null });
  }
  const { data: brandRows, error: brandError } = await db.from('brands').select('id, name');
  if (brandError) throw new LeadsLoadError(`brands: ${brandError.message}`);
  const brandNames = new Map<number, string>((brandRows ?? []).map((b) => [b.id as number, b.name as string]));

  const { data: channelRows, error: channelError } = await db
    .from('deal_channels')
    .select('id, name, sort_order, is_listing_platform')
    .order('sort_order', { ascending: true });
  if (channelError) throw new LeadsLoadError(`deal_channels: ${channelError.message}`);
  const channelNames = new Map<number, string>((channelRows ?? []).map((c) => [c.id as number, c.name as string]));

  const usedChannelIds = new Set(raw.map((r) => r.deal_channel_id as number | null).filter((v): v is number => v != null));
  const channels: LeadChannelOption[] = (channelRows ?? [])
    .filter((c) => c.is_listing_platform === true || usedChannelIds.has(c.id as number))
    .map((c) => ({ id: c.id as number, name: c.name as string }));

  const leads: LeadRow[] = raw.map((r) => {
    const item = items.get(r.inventory_item_id as number);
    const itemId = r.inventory_item_id as number;
    return {
      ...(r as unknown as LeadRow),
      item_name: leadItemName(item?.year ?? null, item?.brand_id != null ? brandNames.get(item.brand_id) ?? null : null, item?.model ?? null, itemId),
      channel_name: r.deal_channel_id != null ? channelNames.get(r.deal_channel_id as number) ?? null : null,
    };
  });

  // 3. Exact channel-attributed cohort (same predicate as Listing Demand Evidence).
  let attributedLeadIds: number[] | null = null;
  if (attribution) {
    if (!serviceClient) throw new LeadsLoadError('service client unavailable for attributed cohort');
    const { data, error } = await serviceClient.rpc('lead_drilldown_channel_attributed_ids_v1_0', {
      p_target_user_id: appUserId,
      p_deal_channel_id: attribution.channelId,
      p_period_start: attribution.from,
      p_period_end: attribution.to,
    });
    if (error) throw new LeadsLoadError(`attributed cohort: ${error.message}`);
    attributedLeadIds = ((data ?? []) as { lead_row_id: number }[]).map((r) => r.lead_row_id);
  }

  // 4. Exact ITEM-attributed cohort (same rule as Listing Demand Evidence item_attributed_leads).
  let itemAttributedLeadIds: number[] | null = null;
  if (itemAttribution) {
    if (!serviceClient) throw new LeadsLoadError('service client unavailable for item-attributed cohort');
    const { data, error } = await serviceClient.rpc('lead_drilldown_item_attributed_ids_v1_0', {
      p_target_user_id: appUserId,
      p_item_id: itemAttribution.itemId,
      p_period_start: itemAttribution.from,
      p_period_end: itemAttribution.to,
    });
    if (error) throw new LeadsLoadError(`item-attributed cohort: ${error.message}`);
    itemAttributedLeadIds = ((data ?? []) as { lead_row_id: number }[]).map((r) => r.lead_row_id);
  }

  return { leads, channels, attributed_lead_ids: attributedLeadIds, item_attributed_lead_ids: itemAttributedLeadIds };
}
