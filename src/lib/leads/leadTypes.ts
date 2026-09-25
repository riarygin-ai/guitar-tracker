// Read-only Lead types for the /leads screen. Vocabularies mirror the
// item_leads CHECK constraints (20260908000001_item_leads.sql) exactly.

export const LEAD_QUALITIES = ['LOW', 'ENGAGED', 'SERIOUS', 'HIGH_INTENT'] as const;
export type LeadQuality = (typeof LEAD_QUALITIES)[number];

export const OFFER_TYPES = ['NONE', 'CASH', 'TRADE', 'MIXED'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const LEAD_STATUSES = ['OPEN', 'GHOSTED', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'AGREED', 'FAILED_AFTER_AGREEMENT', 'COMPLETED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Quality levels that count as "Serious+" (same set Listing Demand Evidence uses). */
export const SERIOUS_PLUS_QUALITIES: readonly LeadQuality[] = ['SERIOUS', 'HIGH_INTENT'];

/** One item_leads row plus the display-only joins (item name, canonical channel name). */
export interface LeadRow {
  id: number;
  lead_id: string;
  inventory_item_id: number;
  item_name: string;
  first_contact_at: string | null;
  last_contact_at: string | null;
  source_channel: string | null;
  deal_channel_id: number | null;
  channel_name: string | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  lead_quality: LeadQuality;
  offer_type: OfferType;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  trade_item: string | null;
  cash_component: number | null;
  trade_est_value: number | null;
  status: LeadStatus;
  outcome_reason: string | null;
  notes: string | null;
  /** The completed Sell/Trade deal (deals.id) this lead has been linked to via the Lead Log, or null. */
  deal_id: number | null;
  source_updated_at: string;
  last_imported_at: string | null;
}

export interface LeadChannelOption {
  id: number;
  name: string;
}

export interface LeadsPayload {
  leads: LeadRow[];
  channels: LeadChannelOption[];
  /** item_leads.id set for the requested channel-attributed cohort; null when no cohort was requested. */
  attributed_lead_ids: number[] | null;
  /** item_leads.id set for the requested ITEM-attributed cohort; null when none was requested. */
  item_attributed_lead_ids: number[] | null;
}
