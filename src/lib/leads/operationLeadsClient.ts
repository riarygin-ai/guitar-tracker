// Client-side fetch wrappers for the operation winning-lead endpoints — same
// "get session -> Bearer fetch -> validate" shape as leadsClient.ts.

import { supabase } from '@/lib/supabase';
import type { OperationLeadCandidate, OperationLeadCandidates } from './operationLeads';
import type { WriteResult } from './leadWriteService';

export type { OperationLeadCandidate, OperationLeadCandidates };

/** The form's Lead selection. 'unset' is never saveable while the field is shown. */
export type LeadChoice =
  | { kind: 'unset' }
  | { kind: 'none' }
  | { kind: 'lead'; lead: OperationLeadCandidate };

async function bearer(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function fetchOperationLeadCandidates(params: { itemIds: number[]; q?: string; dealId?: number | null; signal?: AbortSignal }): Promise<
  { status: 'success'; data: OperationLeadCandidates } | { status: 'error'; message: string }
> {
  const token = await bearer();
  if (!token) return { status: 'error', message: 'Not signed in — please sign in again.' };
  const qs = new URLSearchParams();
  qs.set('item_ids', params.itemIds.join(','));
  if (params.q?.trim()) qs.set('q', params.q.trim());
  if (params.dealId != null) qs.set('deal_id', String(params.dealId));
  let res: Response;
  try {
    res = await fetch(`/api/operations/lead-candidates?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` }, signal: params.signal });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    return { status: 'error', message: 'Could not reach the server to load leads.' };
  }
  if (!res.ok) return { status: 'error', message: `Could not load leads (server returned ${res.status}).` };
  const p = (await res.json().catch(() => null)) as Partial<OperationLeadCandidates> | null;
  if (!p || typeof p.eligible_total !== 'number' || !Array.isArray(p.candidates)) return { status: 'error', message: 'Leads response had an unexpected shape.' };
  return { status: 'success', data: { eligible_total: p.eligible_total, candidates: p.candidates, linked: p.linked ?? null, blocked_item_ids: p.blocked_item_ids ?? [] } };
}

/** Links the winning lead to a saved operation. ok=false carries a user-facing message; the operation itself is already saved. */
export async function linkOperationLead(dealId: number, leadId: number): Promise<{ ok: true; result: WriteResult } | { ok: false; message: string }> {
  const token = await bearer();
  if (!token) return { ok: false, message: 'Not signed in — please sign in again.' };
  let res: Response;
  try {
    res = await fetch('/api/operations/link-lead', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deal_id: dealId, lead_id: leadId }),
    });
  } catch {
    return { ok: false, message: 'Could not reach the server to link the lead.' };
  }
  const body = (await res.json().catch(() => null)) as (WriteResult & { error?: string }) | null;
  if (res.ok && body) return { ok: true, result: body };
  return { ok: false, message: body?.message || body?.error || `Linking failed (server returned ${res.status}).` };
}
