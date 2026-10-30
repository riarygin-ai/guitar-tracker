// MCP `get_item_context` — the authoritative deep context for one item:
// the item/financial/listing context text (same assembly as the app's
// "Copy Item Context") plus every lead on the item as structured JSON with
// FULL legacy notes, the current snapshot (peak stage, status, offer,
// responsiveness, deal link) and its lead_events history.
//
// Nothing is silently truncated: notes are always complete; event lists
// that are capped by the default policy say so explicitly (events_total /
// events_omitted) and `full_history: true` returns all of them.
//
// Identity: caller's RLS-scoped client only. A foreign item and a missing
// item both return null.

import type { SupabaseClient } from '@supabase/supabase-js';
import { assembleItemContext } from './itemContextService';
import { deriveResponsiveness } from '../leads/classification';
import { LEAD_EVENT_COLUMNS, LEAD_SNAPSHOT_COLUMNS, type LeadEventRow, type LeadSnapshotRow } from '../leads/leadWriteService';
import { HIGH_INTENT_PLUS_STAGES, type LeadStage } from '../leads/semantics';

export const ACTIVE_LEAD_EVENT_LIMIT = 20;
export const CLOSED_LEAD_EVENT_LIMIT = 5;

export interface ItemContextMcpOptions {
  lead_id?: number;
  full_history?: boolean;
}

export interface ItemContextLeadEvent {
  event_id: number;
  type: string;
  direction: string;
  occurred_at: string;
  occurred_at_precision: string;
  summary: string;
  message_count: number;
  expects_reply: boolean;
  payload: Record<string, unknown>;
  provenance: string;
  actor: string;
  source: string;
  voided: boolean;
  void_reason?: string | null;
}

export interface ItemContextMcpLead {
  lead_id: number;
  version: number;
  origin: string;
  contact_name: string | null;
  /** The contact's own city — present only when recorded. */
  contact_city?: string;
  /** Display form of the contact's phone — present only when recorded (the normalized matching key is not exposed). */
  contact_phone?: string;
  channel: string;
  channel_detail: string | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  peak_stage: string | null;
  peak_stage_source: string | null;
  status: string;
  outcome_reason: string | null;
  negotiation_rounds: number;
  responsiveness: {
    waiting_on: string | null;
    days_waiting: number | null;
    days_since_last_event: number | null;
    label: string | null;
    unanswered_followups: number;
    reopen_count: number;
    last_inbound_at: string | null;
    last_outbound_at: string | null;
  };
  latest_buyer_offer: {
    offer_type: string;
    latest_cash_offer: number | null;
    cash_component: number | null;
    trade_item: string | null;
    trade_est_value: number | null;
    offer_is_concrete: boolean | null;
    initial_cash_offer: number | null;
    best_cash_offer: number | null;
  };
  offer_assessment: string | null;
  offer_assessment_source: string | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  deal_id: number | null;
  needs_resolution: string[];
  legacy_quality: string | null;
  /** Complete legacy Lead Log narrative (never truncated). New information lives in events. */
  legacy_notes: string | null;
  events_total: number;
  events_voided: number;
  events_omitted: number;
  events: ItemContextLeadEvent[];
}

export interface ItemContextMcpResult {
  item_id: number;
  item_status: string;
  item_context: string;
  leads_summary: { total: number; by_peak_stage: Record<string, number>; by_status: Record<string, number>; awaiting_us: number };
  event_policy: string;
  leads: ItemContextMcpLead[];
}

const num = (v: unknown) => (v == null ? null : Number(v));

/** The current-snapshot fields every MCP lead view shares (get_item_context, get_leads) — one serializer, one set of rules. */
export type LeadSnapshotView = Omit<ItemContextMcpLead, 'legacy_notes' | 'events_total' | 'events_voided' | 'events_omitted' | 'events'>;

export function leadSnapshotView(
  r: LeadSnapshotRow,
  ctx: { channelNames: Map<number, string>; itemUnavailable: boolean; now: Date },
): LeadSnapshotView {
  const resp = deriveResponsiveness(r, ctx.now);
  const needs: string[] = [];
  if (r.status === 'AGREED' && ctx.itemUnavailable) needs.push('ITEM_UNAVAILABLE_WHILE_AGREED');
  if (r.status === 'COMPLETED' && r.deal_id == null) needs.push('COMPLETED_WITHOUT_DEAL_LINK');
  return {
    lead_id: r.id,
    version: r.version,
    origin: r.origin,
    contact_name: r.contact_name,
    ...(r.contact_city ? { contact_city: r.contact_city } : {}),
    ...(r.contact_phone ? { contact_phone: r.contact_phone } : {}),
    channel: (r.deal_channel_id != null ? ctx.channelNames.get(r.deal_channel_id) : null) ?? r.source_channel ?? 'Unknown',
    channel_detail: r.channel_detail,
    first_contact_at: r.first_contact_at,
    last_contact_at: r.last_contact_at,
    peak_stage: r.peak_stage,
    peak_stage_source: r.peak_stage_source,
    status: r.status,
    outcome_reason: r.outcome_reason,
    negotiation_rounds: r.negotiation_rounds,
    responsiveness: {
      waiting_on: r.waiting_on, days_waiting: resp.days_waiting, days_since_last_event: resp.days_since_last_event, label: resp.label,
      unanswered_followups: r.unanswered_followups, reopen_count: r.reopen_count, last_inbound_at: r.last_inbound_at, last_outbound_at: r.last_outbound_at,
    },
    latest_buyer_offer: {
      offer_type: r.offer_type, latest_cash_offer: num(r.latest_cash_offer), cash_component: num(r.cash_component), trade_item: r.trade_item,
      trade_est_value: num(r.trade_est_value), offer_is_concrete: r.offer_is_concrete, initial_cash_offer: num(r.initial_cash_offer), best_cash_offer: num(r.best_cash_offer),
    },
    offer_assessment: r.offer_assessment,
    offer_assessment_source: r.offer_assessment_source,
    buyer_message_count: r.buyer_message_count,
    our_message_count: r.our_message_count,
    deal_id: r.deal_id,
    needs_resolution: needs,
    legacy_quality: r.lead_quality,
  };
}

function eventView(e: LeadEventRow, full: boolean): ItemContextLeadEvent {
  let payload = e.payload ?? {};
  if (e.event_type === 'LEGACY_SNAPSHOT' && !full) {
    const l = (payload as { legacy?: Record<string, unknown> }).legacy ?? {};
    payload = { legacy: { lead_quality: l.lead_quality, status: l.status, peak_stage: l.peak_stage, buyer_message_count: l.buyer_message_count, our_message_count: l.our_message_count } };
  }
  return {
    event_id: e.id, type: e.event_type, direction: e.direction, occurred_at: e.occurred_at, occurred_at_precision: e.occurred_at_precision,
    summary: e.summary, message_count: e.message_count, expects_reply: e.expects_reply, payload, provenance: e.provenance ?? 'OBSERVED',
    actor: e.actor, source: e.source, voided: e.voided_at != null, ...(e.voided_at ? { void_reason: e.void_reason } : {}),
  };
}

export async function getItemContextForMcp(
  client: SupabaseClient,
  itemId: number,
  opts: ItemContextMcpOptions = {},
  now: Date = new Date(),
): Promise<ItemContextMcpResult | { error: 'LEAD_NOT_FOUND' } | null> {
  const assembled = await assembleItemContext(client, itemId, { omitLeads: true });
  if (!assembled) return null;

  let q = client.from('item_leads').select(LEAD_SNAPSHOT_COLUMNS).eq('inventory_item_id', itemId).order('id', { ascending: true });
  if (opts.lead_id != null) q = q.eq('id', opts.lead_id);
  const { data: leadData, error: leadErr } = await q;
  if (leadErr) throw new Error(`item_leads: ${leadErr.message}`);
  const rows = (leadData ?? []) as unknown as LeadSnapshotRow[];
  if (opts.lead_id != null && rows.length === 0) return { error: 'LEAD_NOT_FOUND' };

  const { data: channelRows, error: chErr } = await client.from('deal_channels').select('id, name');
  if (chErr) throw new Error(`deal_channels: ${chErr.message}`);
  const channelNames = new Map<number, string>((channelRows ?? []).map((c) => [c.id as number, c.name as string]));

  const eventsByLead = new Map<number, LeadEventRow[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 150) {
      const { data, error } = await client.from('lead_events').select(LEAD_EVENT_COLUMNS).in('item_lead_id', ids.slice(i, i + 150))
        .order('occurred_at', { ascending: true }).order('id', { ascending: true });
      if (error) throw new Error(`lead_events: ${error.message}`);
      for (const e of (data ?? []) as unknown as LeadEventRow[]) {
        const arr = eventsByLead.get(e.item_lead_id);
        if (arr) arr.push(e); else eventsByLead.set(e.item_lead_id, [e]);
      }
    }
  }

  const full = opts.full_history === true;
  const itemUnavailable = assembled.itemStatus === 'sold' || assembled.itemStatus === 'traded';
  const byStage: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let awaitingUs = 0;

  const leads: ItemContextMcpLead[] = rows.map((r) => {
    const all = eventsByLead.get(r.id) ?? [];
    const live = all.filter((e) => !e.voided_at);
    const pool = full ? all : live;
    const active = r.status === 'OPEN' || r.status === 'AGREED' || (r.peak_stage != null && HIGH_INTENT_PLUS_STAGES.includes(r.peak_stage as LeadStage));
    const limit = full ? pool.length : active ? ACTIVE_LEAD_EVENT_LIMIT : CLOSED_LEAD_EVENT_LIMIT;
    const shown = pool.slice(Math.max(0, pool.length - limit));
    byStage[r.peak_stage ?? 'UNSET'] = (byStage[r.peak_stage ?? 'UNSET'] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.waiting_on === 'US' && !['COMPLETED', 'CLOSED'].includes(r.status)) awaitingUs++;
    return {
      ...leadSnapshotView(r, { channelNames, itemUnavailable, now }),
      legacy_notes: r.notes,
      events_total: live.length,
      events_voided: all.length - live.length,
      events_omitted: pool.length - shown.length,
      events: shown.map((e) => eventView(e, full)),
    };
  });

  return {
    item_id: itemId,
    item_status: assembled.itemStatus,
    item_context: assembled.text,
    leads_summary: { total: leads.length, by_peak_stage: byStage, by_status: byStatus, awaiting_us: awaitingUs },
    event_policy: full
      ? 'full_history: every event (voided ones included, flagged) with complete payloads.'
      : `Default: the most recent ${ACTIVE_LEAD_EVENT_LIMIT} events for OPEN/AGREED/High-Intent+ leads and ${CLOSED_LEAD_EVENT_LIMIT} for other leads; voided events excluded. events_omitted > 0 means older events exist — call again with lead_id + full_history: true. legacy_notes are always complete.`,
    leads,
  };
}
