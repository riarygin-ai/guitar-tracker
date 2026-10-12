// Server-only. Compact per-item buyer activity for CURRENTLY LISTED items
// over an arbitrary period (the /listings Trend Window). A thin wrapper
// over the read-only RPC listing_demand_item_activity_v1_0 (migration
// 20260919000000): every number is computed in SQL from the same
// listing-exposure foundation as Listing Demand Evidence. Constructs no
// client of its own — the API route supplies the caller's own app user id
// and a service-role client (same convention as listingDemandEvidence.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { logListingFailure, logListingSuccess } from './listingDiagnostics';

export interface ItemActivityChannel {
  channel_id: number;
  channel_name: string;
}

export interface ItemActivityEntry {
  item_id: number;
  item_display_name: string;
  active_channels: ItemActivityChannel[];
  item_attributed_leads: number;
  serious_plus_attributed_leads: number;
  offer_attributed_leads: number;
  item_listing_days: number;
  channel_listing_days: number;
  last_attributed_lead_date: string | null;
}

export class ListingItemActivityError extends Error {}

export async function getListingItemActivity(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
  startDate: string;
  endDate: string;
}): Promise<ItemActivityEntry[]> {
  const diag = { endpoint: 'listing-item-activity:listing_demand_item_activity_v1_0', appUserId: params.appUserId, params: { startDate: params.startDate, endDate: params.endDate } };
  const startedAt = Date.now();

  let data: unknown, error: unknown;
  try {
    ({ data, error } = await params.serviceClient.rpc('listing_demand_item_activity_v1_0', {
      p_target_user_id: params.appUserId,
      p_period_start: params.startDate,
      p_period_end: params.endDate,
    }));
  } catch (thrown) {
    logListingFailure(diag, Date.now() - startedAt, thrown);
    throw new ListingItemActivityError('item activity: request failed');
  }

  if (error) {
    // Structured diagnostics only (see listingDiagnostics.ts) — the public
    // message stays generic; the API route never forwards this detail.
    logListingFailure(diag, Date.now() - startedAt, error);
    throw new ListingItemActivityError('item activity: computation failed');
  }
  logListingSuccess(diag, Date.now() - startedAt);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    item_id: Number(r.item_id),
    item_display_name: String(r.item_display_name ?? ''),
    active_channels: Array.isArray(r.active_channels) ? (r.active_channels as ItemActivityChannel[]) : [],
    item_attributed_leads: Number(r.item_attributed_leads),
    serious_plus_attributed_leads: Number(r.serious_plus_attributed_leads),
    offer_attributed_leads: Number(r.offer_attributed_leads),
    item_listing_days: Number(r.item_listing_days),
    channel_listing_days: Number(r.channel_listing_days),
    last_attributed_lead_date: (r.last_attributed_lead_date as string | null) ?? null,
  }));
}
