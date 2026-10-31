// Client-side access to operation drafts (20261031000000) for the GT UI:
// reads through the signed-in browser client (RLS: own rows only), writes
// only through the draft RPCs. Finalization runs the existing operation RPC
// inside finalize_operation_draft — the normal status / listing / cash /
// lead effects happen there and only there.

import { supabase } from '@/lib/supabase';
import { invalidateListingsCache } from '@/lib/listingsCacheStore';
import { executeIdempotentMutation } from '@/lib/writeRetry';

export type DraftType = 'BUY' | 'SELL' | 'TRADE';
export type DraftStatus = 'OPEN' | 'FINALIZED' | 'DISCARDED';
export type DraftKind = 'purchase' | 'sale' | 'trade';

export interface OperationDraftItem {
  id: number;
  item_id: number;
  direction: 'in' | 'out';
  created_by_draft: boolean;
  position: number;
}

export interface OperationDraft {
  id: number;
  operation_type: DraftType;
  status: DraftStatus;
  proposed_date: string | null;
  deal_channel_id: number | null;
  contact_name: string | null;
  lead_id: number | null;
  cash_paid: number;
  cash_received: number;
  notes: string | null;
  source: 'MCP' | 'UI';
  deal_id: number | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  discarded_at: string | null;
  discard_result: DiscardResult | null;
  operation_draft_items: OperationDraftItem[];
}

export interface DiscardResult {
  draft_id: number;
  removed_item_ids: number[];
  kept_items: { item_id: number; reasons: string[] }[];
}

export const DRAFT_TYPE_LABEL: Record<DraftType, string> = { BUY: 'Buy', SELL: 'Sell', TRADE: 'Trade' };
export const DRAFT_KIND: Record<DraftType, DraftKind> = { BUY: 'purchase', SELL: 'sale', TRADE: 'trade' };

const COLUMNS = 'id, operation_type, status, proposed_date, deal_channel_id, contact_name, lead_id, cash_paid, cash_received, notes, source, deal_id, '
  + 'created_at, updated_at, finalized_at, discarded_at, discard_result, operation_draft_items(id, item_id, direction, created_by_draft, position)';

function normalize(row: Record<string, unknown>): OperationDraft {
  const d = row as unknown as OperationDraft;
  return {
    ...d,
    cash_paid: Number(d.cash_paid ?? 0),
    cash_received: Number(d.cash_received ?? 0),
    operation_draft_items: [...(d.operation_draft_items ?? [])].sort((a, b) => a.direction.localeCompare(b.direction) || a.position - b.position),
  };
}

export async function listOpenDrafts(): Promise<{ data: OperationDraft[]; error: string | null }> {
  const { data, error } = await supabase.from('operation_drafts').select(COLUMNS).eq('status', 'OPEN').order('id', { ascending: false }).limit(50);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []).map((r) => normalize(r as unknown as Record<string, unknown>)), error: null };
}

export async function getOperationDraft(id: number): Promise<{ data: OperationDraft | null; error: string | null }> {
  const { data, error } = await supabase.from('operation_drafts').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) return { data: null, error: error.message };
  return { data: data ? normalize(data as unknown as Record<string, unknown>) : null, error: null };
}

/** "DRAFT_ITEM_INCOMPLETE: item #12 needs condition" → "Item #12 needs condition". */
export function draftErrorMessage(message: string): string {
  const m = message.match(/^[A-Z_]+:\s*([\s\S]*)$/);
  const text = m ? m[1] : message;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface DraftTermsInput {
  proposed_date: string | null;
  deal_channel_id: number | null;
  contact_name: string | null;
  lead_id: number | null;
  cash_paid: number;
  cash_received: number;
  notes: string | null;
}

/** Replaces the planning terms of an OPEN draft (a full PUT — retrying is harmless). */
export async function updateDraftTerms(id: number, terms: DraftTermsInput): Promise<{ ok: true } | { ok: false; message: string }> {
  const { response: { error } } = await executeIdempotentMutation('update_operation_draft', () => supabase.rpc('update_operation_draft', { p_draft_id: id, p_request: terms }));
  return error ? { ok: false, message: draftErrorMessage(error.message) } : { ok: true };
}

/** Discards an OPEN draft. No business effect; removeNewItems deletes only untouched draft-created 'new' items. */
export async function discardDraft(id: number, removeNewItems: boolean): Promise<{ ok: true; result: DiscardResult } | { ok: false; message: string }> {
  const { response: { data, error } } = await executeIdempotentMutation('discard_operation_draft', () => supabase.rpc('discard_operation_draft', { p_draft_id: id, p_remove_new_items: removeNewItems }));
  if (error) return { ok: false, message: draftErrorMessage(error.message) };
  return { ok: true, result: data as DiscardResult };
}

/**
 * Finalizes a draft WITHOUT a winning lead: the existing create_*_operation
 * runs inside finalize_operation_draft with exactly the arguments the form
 * would send it. Idempotent per draft (an already finalized draft returns its
 * deal), so a transient failure is retried safely.
 */
export async function finalizeDraft(id: number, kind: DraftKind, operation: Record<string, unknown>): Promise<{ ok: true; dealId: number } | { ok: false; message: string }> {
  const { response: { data, error } } = await executeIdempotentMutation('finalize_operation_draft', () => supabase.rpc('finalize_operation_draft', {
    p_draft_id: id, p_kind: kind, p_operation: operation, p_deal_id: null, p_lead_request: null,
  }));
  if (error) return { ok: false, message: draftErrorMessage(error.message) };
  invalidateListingsCache();
  return { ok: true, dealId: Number((data as { deal_id: number }).deal_id) };
}

/** Fields an incoming item still needs before the draft can be finalized (the inventory form's required fields). */
export function missingForFinalize(item: { item_subtype_id: number | null; condition: string | null; purpose_id: number | null; estimated_sold_value: number | null }): string[] {
  const out: string[] = [];
  if (item.item_subtype_id == null) out.push('type');
  if (!item.condition) out.push('condition');
  if (item.purpose_id == null) out.push('purpose');
  if (item.estimated_sold_value == null) out.push('estimated sold value');
  return out;
}

/** The OPEN draft an item is an incoming item of, if any (the item page shows it and allows saving it incomplete). */
export async function getOpenDraftForIncomingItem(itemId: number): Promise<{ id: number; type: string } | null> {
  const { data, error } = await supabase.from('operation_draft_items')
    .select('draft_id, operation_drafts!inner(operation_type, status)')
    .eq('item_id', itemId).eq('direction', 'in').eq('operation_drafts.status', 'OPEN').limit(1);
  if (error || !data?.length) return null;
  const d = data[0] as unknown as { draft_id: number; operation_drafts: { operation_type: DraftType } };
  return { id: d.draft_id, type: DRAFT_TYPE_LABEL[d.operation_drafts.operation_type] ?? 'Operation' };
}
