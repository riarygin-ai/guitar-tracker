// Server-only. The winning-lead link for Sell / Trade operations.
//
// Candidates: the caller's own leads (RLS client + explicit user_id filter) on
// the operation's OUTGOING items only, bounded by that item set. Eligible =
// not already holding a deal link and not COMPLETED; an item whose lead
// already holds a deal link is skipped entirely (the lead write layer rejects
// a second link on the same item — DEAL_LINK_CONFLICT).
//
// Linking reuses the lead write layer (leadWriteService — the single source
// of lead rules): one DEAL_LINKED event → the layer derives the STATUS_CHANGE
// to COMPLETED and peak_stage CONVERTED, appended to the lead's history,
// recorded with write source UI.
//
// New operation with a winning lead (createOperationWithWinningLead): the
// deal id is reserved first, the lead mutation is planned against it, and
// create_operation_with_winning_lead (20261024000000) then runs the
// operation RPC + that mutation in ONE transaction, with the winner exempt
// from the item-unavailable auto-close — history OPEN/AGREED → COMPLETED,
// never a false CLOSED / ITEM_UNAVAILABLE. Idempotent per operation_key.
//
// Existing operation (edit flow, linkWinningLeadToDeal): the deal already
// exists, so the link is a plain lead update; the mutation_id is derived from
// (deal, lead), so a retry is idempotent.

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { prepareLeadUpdate, recordLeadInteraction, type AgentEventInput, type WriteResult } from './leadWriteService';
import { formatOfferSummary, leadItemName } from './leadFormat';
import { STAGE_RANK, type LeadStage } from './semantics';
import type { OfferType } from './leadTypes';
import { cityKey, maskedPhone } from './contactDetails';

export const OPERATION_LEAD_INITIAL_LIMIT = 6;
export const OPERATION_LEAD_SEARCH_LIMIT = 12;
export const OPERATION_LEAD_MAX_ITEMS = 25;
const MAX_ROWS = 500;

export interface OperationLeadCandidate {
  lead_id: number;
  item_id: number;
  item_label: string;
  contact_name: string | null;
  /**
   * Only when another eligible lead has the same name: the city, or a masked
   * phone ("…1234") when the city does not tell them apart. Never a full phone.
   */
  contact_hint: string | null;
  channel: string | null;
  channel_detail: string | null;
  status: string;
  outcome_reason: string | null;
  peak_stage: LeadStage | null;
  offer_summary: string;
  last_activity_at: string | null;
}

export interface OperationLeadCandidates {
  /** Eligible leads across all outgoing items (before search / limit). 0 → the Lead field is hidden. */
  eligible_total: number;
  /** Ranked, searched and limited. */
  candidates: OperationLeadCandidate[];
  /** The lead already linked to `deal_id` (edit flow), if any. */
  linked: OperationLeadCandidate | null;
  /** Outgoing items skipped because one of their leads already holds a deal link. */
  blocked_item_ids: number[];
}

export interface LeadCandidateRow {
  id: number;
  inventory_item_id: number;
  contact_name: string | null;
  source_channel: string | null;
  channel_detail: string | null;
  status: string;
  outcome_reason: string | null;
  peak_stage: LeadStage | null;
  deal_id: number | null;
  offer_type: OfferType;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  latest_cash_offer: number | null;
  trade_item: string | null;
  cash_component: number | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  contact_city: string | null;
  contact_phone: string | null;
}

const ROW_COLUMNS =
  'id, inventory_item_id, contact_name, source_channel, channel_detail, status, outcome_reason, peak_stage, deal_id, offer_type, ' +
  'initial_cash_offer, best_cash_offer, latest_cash_offer, trade_item, cash_component, first_contact_at, last_contact_at, last_inbound_at, last_outbound_at, ' +
  'contact_city, contact_phone';

/** Latest known activity (date-only values anchored at 12:00Z so the calendar day is preserved). */
export function lastActivityAt(r: Pick<LeadCandidateRow, 'last_contact_at' | 'last_inbound_at' | 'last_outbound_at' | 'first_contact_at'>): string | null {
  const ms = [r.last_inbound_at, r.last_outbound_at, r.last_contact_at, r.first_contact_at]
    .filter((x): x is string => !!x)
    .map((x) => Date.parse(x.length === 10 ? `${x}T12:00:00Z` : x))
    .filter((t) => !Number.isNaN(t));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : null;
}

/** Eligible to become an operation's winning lead: not already linked to a deal and not COMPLETED. */
export function isEligibleRow(r: Pick<LeadCandidateRow, 'deal_id' | 'status'>): boolean {
  return r.deal_id == null && r.status !== 'COMPLETED';
}

/**
 * Default order, using existing fields only: AGREED first; then OPEN by
 * highest peak_stage; then everything else; most recent activity breaks ties
 * (and orders within each group), then lead id descending.
 */
export function rankLeadRows<T extends Pick<LeadCandidateRow, 'id' | 'status' | 'peak_stage' | 'last_contact_at' | 'last_inbound_at' | 'last_outbound_at' | 'first_contact_at'>>(rows: T[]): T[] {
  const group = (r: T) => (r.status === 'AGREED' ? 0 : r.status === 'OPEN' ? 1 : 2);
  const recency = (r: T) => { const a = lastActivityAt(r); return a ? Date.parse(a) : 0; };
  return [...rows].sort((a, b) =>
    group(a) - group(b)
    || (group(a) === 1 ? (STAGE_RANK[b.peak_stage as LeadStage] ?? 0) - (STAGE_RANK[a.peak_stage as LeadStage] ?? 0) : 0)
    || recency(b) - recency(a)
    || b.id - a.id);
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Search by contact name, city, channel, channel detail, trade item or item label; every query word must match. */
export function matchesLeadQuery(r: Pick<LeadCandidateRow, 'contact_name' | 'source_channel' | 'channel_detail' | 'trade_item'> & { contact_city?: string | null }, itemLabel: string, q: string): boolean {
  const words = norm(q).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = [r.contact_name, r.contact_city ?? null, r.source_channel, r.channel_detail, r.trade_item, itemLabel].map(norm).join(' | ');
  return words.every((w) => hay.includes(w));
}

/**
 * Disambiguation hints for leads that share a name with another eligible lead:
 * the city when it differs from every same-name sibling's, otherwise a masked
 * phone when that differs. Unique names get no hint (no extra clutter).
 */
export function contactHints(rows: Pick<LeadCandidateRow, 'id' | 'contact_name' | 'contact_city' | 'contact_phone'>[]): Map<number, string | null> {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = norm(r.contact_name);
    if (!k) continue;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  const out = new Map<number, string | null>();
  for (const g of Array.from(groups.values())) {
    if (g.length < 2) continue;
    for (const r of g) {
      const others = g.filter((o) => o.id !== r.id);
      const city = cityKey(r.contact_city);
      const phone = maskedPhone(r.contact_phone);
      if (r.contact_city && others.every((o) => cityKey(o.contact_city) !== city)) out.set(r.id, r.contact_city);
      else if (phone && others.every((o) => maskedPhone(o.contact_phone) !== phone)) out.set(r.id, r.contact_city ? `${r.contact_city} · ${phone}` : phone);
      else out.set(r.id, r.contact_city ?? null);
    }
  }
  return out;
}

function toCandidate(r: LeadCandidateRow, itemLabel: string, hint: string | null = null): OperationLeadCandidate {
  return {
    lead_id: r.id, item_id: r.inventory_item_id, item_label: itemLabel, contact_name: r.contact_name, contact_hint: hint,
    channel: r.source_channel, channel_detail: r.channel_detail, status: r.status, outcome_reason: r.outcome_reason,
    peak_stage: r.peak_stage,
    offer_summary: formatOfferSummary({ ...r, best_cash_offer: r.latest_cash_offer ?? r.best_cash_offer }),
    last_activity_at: lastActivityAt(r),
  };
}

export class OperationLeadsError extends Error {}

export async function loadOperationLeadCandidates(db: SupabaseClient, appUserId: number, params: {
  itemIds: number[];
  q?: string | null;
  limit?: number;
  dealId?: number | null;
}): Promise<OperationLeadCandidates> {
  const itemIds = Array.from(new Set(params.itemIds)).slice(0, OPERATION_LEAD_MAX_ITEMS);
  const empty: OperationLeadCandidates = { eligible_total: 0, candidates: [], linked: null, blocked_item_ids: [] };
  if (itemIds.length === 0 && params.dealId == null) return empty;

  const rows: LeadCandidateRow[] = [];
  if (itemIds.length > 0) {
    const { data, error } = await db.from('item_leads').select(ROW_COLUMNS)
      .eq('user_id', appUserId).in('inventory_item_id', itemIds).order('id', { ascending: true }).limit(MAX_ROWS);
    if (error) throw new OperationLeadsError(`item_leads: ${error.message}`);
    rows.push(...((data ?? []) as unknown as LeadCandidateRow[]));
  }
  let linkedRow: LeadCandidateRow | null = null;
  if (params.dealId != null) {
    const { data, error } = await db.from('item_leads').select(ROW_COLUMNS)
      .eq('user_id', appUserId).eq('deal_id', params.dealId).order('id', { ascending: true }).limit(1);
    if (error) throw new OperationLeadsError(`item_leads (linked): ${error.message}`);
    linkedRow = ((data ?? []) as unknown as LeadCandidateRow[])[0] ?? null;
  }

  // Display labels for the involved items (read-only).
  const labelItemIds = Array.from(new Set([...itemIds, ...(linkedRow ? [linkedRow.inventory_item_id] : [])]));
  const labels = new Map<number, string>();
  if (labelItemIds.length > 0) {
    const { data: items, error: itemsError } = await db.from('inventory_items').select('id, year, model, brand_id').eq('user_id', appUserId).in('id', labelItemIds);
    if (itemsError) throw new OperationLeadsError(`inventory_items: ${itemsError.message}`);
    const brandIds = Array.from(new Set((items ?? []).map((i) => i.brand_id).filter((b): b is number => b != null)));
    const brands = new Map<number, string>();
    if (brandIds.length > 0) {
      const { data: brandRows, error: brandError } = await db.from('brands').select('id, name').in('id', brandIds);
      if (brandError) throw new OperationLeadsError(`brands: ${brandError.message}`);
      for (const b of brandRows ?? []) brands.set(b.id as number, b.name as string);
    }
    for (const it of items ?? []) labels.set(it.id as number, leadItemName(it.year as number | null, it.brand_id != null ? brands.get(it.brand_id as number) ?? null : null, it.model as string | null, it.id as number));
  }
  const labelOf = (itemId: number) => labels.get(itemId) ?? `Item #${itemId}`;

  const blocked = new Set(rows.filter((r) => r.deal_id != null).map((r) => r.inventory_item_id));
  const eligible = rows.filter((r) => isEligibleRow(r) && !blocked.has(r.inventory_item_id));
  const q = params.q?.trim() ?? '';
  const limit = Math.max(1, Math.min(params.limit ?? (q ? OPERATION_LEAD_SEARCH_LIMIT : OPERATION_LEAD_INITIAL_LIMIT), OPERATION_LEAD_SEARCH_LIMIT));
  const matched = q ? eligible.filter((r) => matchesLeadQuery(r, labelOf(r.inventory_item_id), q)) : eligible;
  const hints = contactHints(eligible);

  return {
    eligible_total: eligible.length,
    candidates: rankLeadRows(matched).slice(0, limit).map((r) => toCandidate(r, labelOf(r.inventory_item_id), hints.get(r.id) ?? null)),
    linked: linkedRow ? toCandidate(linkedRow, labelOf(linkedRow.inventory_item_id)) : null,
    blocked_item_ids: Array.from(blocked).sort((a, b) => a - b),
  };
}

/** Deterministic UUID-shaped mutation id for (deal, lead): a retried link replays instead of duplicating. */
export function dealLinkMutationId(dealId: number, leadId: number): string {
  const h = createHash('sha256').update(`operation-deal-link:v1:${dealId}:${leadId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

function dealLinkedEvent(kind: 'sale' | 'trade', dealId: number, dealDate: string, contactName: string | null): AgentEventInput {
  const who = contactName?.trim();
  return {
    type: 'DEAL_LINKED', direction: 'INTERNAL', occurred_at: dealDate, provenance: 'STATED',
    summary: `${kind === 'sale' ? 'Sale' : 'Trade'} recorded in Guitar Tracker${who ? ` — winning lead ${who}` : ''} (operation ${dealId})`,
    payload: { deal_id: dealId },
  };
}

const UI_CONTEXT = { source: 'UI' as const, clientLabel: 'operation-form' };

/**
 * Links the winning lead to an EXISTING Sell / Trade operation (edit flow).
 * The lead must belong to one of the deal's outgoing items.
 */
export async function linkWinningLeadToDeal(db: SupabaseClient, appUserId: number, params: { dealId: number; leadId: number }, now?: Date): Promise<WriteResult> {
  const { data: deal, error: dealError } = await db.from('deals').select('id, deal_type, deal_date').eq('id', params.dealId).eq('user_id', appUserId).maybeSingle();
  if (dealError) throw new OperationLeadsError(`deals: ${dealError.message}`);
  if (!deal || !['sale', 'trade'].includes(deal.deal_type as string)) {
    return { result: 'REJECTED', reason: 'DEAL_NOT_VALID', message: `Operation ${params.dealId} is not a sale or trade.` };
  }
  const { data: lead, error: leadError } = await db.from('item_leads').select('id, inventory_item_id, contact_name').eq('id', params.leadId).eq('user_id', appUserId).maybeSingle();
  if (leadError) throw new OperationLeadsError(`item_leads: ${leadError.message}`);
  if (!lead) return { result: 'REJECTED', reason: 'LEAD_NOT_FOUND', message: `Lead ${params.leadId} not found.` };
  const { data: out, error: outError } = await db.from('deal_items').select('item_id').eq('deal_id', params.dealId).eq('direction', 'out');
  if (outError) throw new OperationLeadsError(`deal_items: ${outError.message}`);
  if (!(out ?? []).some((d) => Number(d.item_id) === Number(lead.inventory_item_id))) {
    return { result: 'REJECTED', reason: 'DEAL_NOT_VALID', message: `Lead ${params.leadId} belongs to an item that is not part of this operation.` };
  }

  return recordLeadInteraction(db, {
    mutation_id: dealLinkMutationId(params.dealId, params.leadId),
    lead: { lead_id: params.leadId },
    events: [dealLinkedEvent(deal.deal_type as OperationKind, params.dealId, deal.deal_date as string, lead.contact_name as string | null)],
  }, { ...UI_CONTEXT, now });
}

export type OperationKind = 'sale' | 'trade';

/** Named arguments of create_sell_operation / create_trade_operation, as the forms send them. */
export type OperationParams = Record<string, unknown> & { p_deal_date: string };

export type CreateWithLeadResult =
  | { ok: true; deal_id: number; replayed: boolean }
  | { ok: false; status: 400 | 409; message: string; result?: WriteResult };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function operationOutgoingItemIds(kind: OperationKind, op: OperationParams): number[] {
  const list = (kind === 'sale' ? op.p_items : op.p_outgoing_items) as { item_id?: unknown }[] | undefined;
  return Array.isArray(list) ? list.map((x) => Number(x?.item_id)).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/**
 * Creates a NEW Sell / Trade together with its winning lead, atomically
 * (operation + DEAL_LINKED → COMPLETED + neutral close of the other OPEN
 * leads). `operationKey` — a UUID the form keeps until success — is the lead
 * mutation id: a retry after a lost response returns the saved operation
 * instead of creating a second one.
 */
export async function createOperationWithWinningLead(db: SupabaseClient, appUserId: number, params: {
  kind: OperationKind;
  operation: OperationParams;
  leadId: number;
  operationKey: string;
}, now?: Date): Promise<CreateWithLeadResult> {
  const { kind, operation, leadId, operationKey } = params;
  if (!UUID_RE.test(operationKey)) return { ok: false, status: 400, message: 'operation_key must be a UUID' };
  if (typeof operation.p_deal_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(operation.p_deal_date)) {
    return { ok: false, status: 400, message: 'p_deal_date must be YYYY-MM-DD' };
  }

  // Already saved under this key (response lost): return it.
  const { data: prior, error: priorError } = await db.from('lead_events').select('item_lead_id').eq('user_id', appUserId).eq('mutation_id', operationKey).limit(1);
  if (priorError) throw new OperationLeadsError(`lead_events: ${priorError.message}`);
  if ((prior ?? []).length > 0) {
    const { data: linked } = await db.from('item_leads').select('deal_id').eq('id', prior![0].item_lead_id).maybeSingle();
    if (linked?.deal_id != null) return { ok: true, deal_id: Number(linked.deal_id), replayed: true };
  }

  const { data: lead, error: leadError } = await db.from('item_leads').select('id, inventory_item_id, contact_name').eq('id', leadId).eq('user_id', appUserId).maybeSingle();
  if (leadError) throw new OperationLeadsError(`item_leads: ${leadError.message}`);
  if (!lead) return { ok: false, status: 409, message: `Lead ${leadId} not found.` };
  if (!operationOutgoingItemIds(kind, operation).includes(Number(lead.inventory_item_id))) {
    return { ok: false, status: 409, message: 'The selected lead belongs to an item that is not part of this operation.' };
  }

  const { data: reserved, error: reserveError } = await db.rpc('reserve_deal_id');
  if (reserveError || reserved == null) throw new OperationLeadsError(`reserve_deal_id: ${reserveError?.message ?? 'no id'}`);
  const dealId = Number(reserved);

  for (let attempt = 0; attempt < 2; attempt++) {
    const prepared = await prepareLeadUpdate(db, {
      mutation_id: operationKey,
      lead: { lead_id: leadId },
      events: [dealLinkedEvent(kind, dealId, operation.p_deal_date, lead.contact_name as string | null)],
    }, { ...UI_CONTEXT, now, pendingDealId: dealId });
    if ('result' in prepared) return { ok: false, status: 409, message: prepared.message ?? 'The lead cannot be linked.', result: prepared };

    const { data, error } = await db.rpc('create_operation_with_winning_lead', {
      p_kind: kind, p_deal_id: dealId, p_operation: operation, p_lead_request: prepared.request,
    });
    if (!error) {
      const d = data as { status: string; deal_id: number | null };
      return { ok: true, deal_id: Number(d.deal_id ?? dealId), replayed: d.status === 'REPLAY' };
    }
    // The lead changed between planning and the transaction (all rolled back, reservation intact): re-plan once.
    if (/LEAD_LINK_CONFLICT/.test(error.message) && attempt === 0) continue;
    // Operation validation (e.g. "Sale value must be greater than 0") or a lead invariant: nothing was saved.
    return { ok: false, status: 400, message: error.message };
  }
  return { ok: false, status: 409, message: 'The lead changed while saving; nothing was saved. Please try again.' };
}
