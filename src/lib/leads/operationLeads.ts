// Server-only. The winning-lead link for Sell / Trade operations.
//
// Candidates: the caller's own leads (RLS client + explicit user_id filter) on
// the operation's OUTGOING items only, bounded by that item set. Eligible =
// not already holding a deal link and not COMPLETED; an item whose lead
// already holds a deal link is skipped entirely (the lead write layer rejects
// a second link on the same item — DEAL_LINK_CONFLICT).
//
// Linking reuses recordLeadInteraction (the single lead write path): one
// DEAL_LINKED event → the lead layer derives the STATUS_CHANGE to COMPLETED
// and peak_stage CONVERTED, appended to the lead's existing history. The
// operation RPC runs first (its own transaction); its item-unavailable
// trigger may close the winning OPEN lead as CLOSED / ITEM_UNAVAILABLE, and
// the DEAL_LINKED then completes it (CLOSED → COMPLETED) — the documented
// flow of 20261021000000. The mutation_id is derived from (deal, lead), so a
// retry after a failed link is idempotent.

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordLeadInteraction, type WriteResult } from './leadWriteService';
import { formatOfferSummary, leadItemName } from './leadFormat';
import { STAGE_RANK, type LeadStage } from './semantics';
import type { OfferType } from './leadTypes';

export const OPERATION_LEAD_INITIAL_LIMIT = 6;
export const OPERATION_LEAD_SEARCH_LIMIT = 12;
export const OPERATION_LEAD_MAX_ITEMS = 25;
const MAX_ROWS = 500;

export interface OperationLeadCandidate {
  lead_id: number;
  item_id: number;
  item_label: string;
  contact_name: string | null;
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
}

const ROW_COLUMNS =
  'id, inventory_item_id, contact_name, source_channel, channel_detail, status, outcome_reason, peak_stage, deal_id, offer_type, ' +
  'initial_cash_offer, best_cash_offer, latest_cash_offer, trade_item, cash_component, first_contact_at, last_contact_at, last_inbound_at, last_outbound_at';

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

/** Search by contact name, channel, channel detail, trade item or item label; every query word must match. */
export function matchesLeadQuery(r: Pick<LeadCandidateRow, 'contact_name' | 'source_channel' | 'channel_detail' | 'trade_item'>, itemLabel: string, q: string): boolean {
  const words = norm(q).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = [r.contact_name, r.source_channel, r.channel_detail, r.trade_item, itemLabel].map(norm).join(' | ');
  return words.every((w) => hay.includes(w));
}

function toCandidate(r: LeadCandidateRow, itemLabel: string): OperationLeadCandidate {
  return {
    lead_id: r.id, item_id: r.inventory_item_id, item_label: itemLabel, contact_name: r.contact_name,
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

  return {
    eligible_total: eligible.length,
    candidates: rankLeadRows(matched).slice(0, limit).map((r) => toCandidate(r, labelOf(r.inventory_item_id))),
    linked: linkedRow ? toCandidate(linkedRow, labelOf(linkedRow.inventory_item_id)) : null,
    blocked_item_ids: Array.from(blocked).sort((a, b) => a - b),
  };
}

/** Deterministic UUID-shaped mutation id for (deal, lead): a retried link replays instead of duplicating. */
export function dealLinkMutationId(dealId: number, leadId: number): string {
  const h = createHash('sha256').update(`operation-deal-link:v1:${dealId}:${leadId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * Links the operation's winning lead to its (already created) deal through the
 * lead write layer. The lead must belong to one of the deal's outgoing items.
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

  const who = (lead.contact_name as string | null)?.trim();
  const kind = deal.deal_type === 'sale' ? 'Sale' : 'Trade';
  return recordLeadInteraction(db, {
    mutation_id: dealLinkMutationId(params.dealId, params.leadId),
    lead: { lead_id: params.leadId },
    events: [{
      type: 'DEAL_LINKED', direction: 'INTERNAL', occurred_at: deal.deal_date as string, provenance: 'STATED',
      summary: `${kind} recorded in Guitar Tracker${who ? ` — winning lead ${who}` : ''} (operation ${params.dealId})`,
      payload: { deal_id: params.dealId },
    }],
  }, { source: 'UI', clientLabel: 'operation-form', now });
}
