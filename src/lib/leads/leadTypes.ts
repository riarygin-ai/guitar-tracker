import type { LeadStage } from './semantics';

// Read-only Lead types for the /leads screen. Vocabularies mirror the
// item_leads CHECK constraints (20260908000001_item_leads.sql) exactly.

export const LEAD_QUALITIES = ['LOW', 'ENGAGED', 'SERIOUS', 'HIGH_INTENT'] as const;
export type LeadQuality = (typeof LEAD_QUALITIES)[number];

export const OFFER_TYPES = ['NONE', 'CASH', 'TRADE', 'MIXED'] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export const LEAD_STATUSES = ['OPEN', 'GHOSTED', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'AGREED', 'FAILED_AFTER_AGREEMENT', 'COMPLETED', 'CLOSED'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** LEGACY: quality levels that counted as "Serious+". Superseded by NEGOTIATING_PLUS_STAGES (semantics.ts). */
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
  /** LEGACY Lead Log quality — null on direct-write leads. */
  lead_quality: LeadQuality | null;
  peak_stage: LeadStage | null;
  peak_stage_source: string | null;
  peak_stage_at: string | null;
  negotiation_rounds: number;
  latest_cash_offer: number | null;
  offer_is_concrete: boolean | null;
  offer_assessment: string | null;
  offer_assessment_source: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  waiting_on: 'BUYER' | 'US' | 'NONE' | null;
  unanswered_followups: number;
  reopen_count: number;
  channel_detail: string | null;
  origin: 'SHEET' | 'DIRECT';
  version: number;
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
  /** Buyer/trader name as recorded in the Lead Log (optional Sheet column T), or null. */
  contact_name: string | null;
  /** Provenance of contact_name: LEAD_LOG, NOTES_PREFIX_V1, DIRECT or USER_EDIT (corrected in the app); null when there is no name. */
  contact_name_source: 'LEAD_LOG' | 'NOTES_PREFIX_V1' | 'DIRECT' | 'USER_EDIT' | null;
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

/** Neutral values for the 2026-10 snapshot columns (fixtures / legacy rows without events). */
export const LEAD_SNAPSHOT_DEFAULTS: Pick<LeadRow,
  'peak_stage' | 'peak_stage_source' | 'peak_stage_at' | 'negotiation_rounds' | 'latest_cash_offer' | 'offer_is_concrete' |
  'offer_assessment' | 'offer_assessment_source' | 'last_inbound_at' | 'last_outbound_at' | 'waiting_on' | 'unanswered_followups' |
  'reopen_count' | 'channel_detail' | 'origin' | 'version' | 'contact_name_source'> = {
  peak_stage: null, peak_stage_source: null, peak_stage_at: null, negotiation_rounds: 0, latest_cash_offer: null, offer_is_concrete: null,
  offer_assessment: null, offer_assessment_source: null, last_inbound_at: null, last_outbound_at: null, waiting_on: null,
  unanswered_followups: 0, reopen_count: 0, channel_detail: null, origin: 'SHEET', version: 1, contact_name_source: null,
};
