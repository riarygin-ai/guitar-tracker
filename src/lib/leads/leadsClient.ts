// Client-side fetch wrapper for GET /api/leads — same "get session ->
// Bearer fetch -> validate" shape as listingDemandEvidenceClient.ts.

import { supabase } from '@/lib/supabase';
import type { LeadsPayload } from './leadTypes';

export type LeadsFetchResult =
  | { status: 'success'; data: LeadsPayload }
  | { status: 'unauthenticated'; message: string }
  | { status: 'error'; message: string };

export async function fetchLeads(
  attribution?: { channelId: number; from: string; to: string } | null,
  itemAttribution?: { itemId: number; from: string; to: string } | null,
): Promise<LeadsFetchResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  const qs = new URLSearchParams();
  if (attribution) {
    qs.set('channel_id', String(attribution.channelId));
    qs.set('from', attribution.from);
    qs.set('to', attribution.to);
  }
  if (itemAttribution) {
    qs.set('item_id', String(itemAttribution.itemId));
    qs.set('item_from', itemAttribution.from);
    qs.set('item_to', itemAttribution.to);
  }

  let res: Response;
  try {
    res = await fetch(`/api/leads${qs.toString() ? `?${qs.toString()}` : ''}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }
  if (!res.ok) {
    return { status: 'error', message: `Could not load leads (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'error', message: 'Received an unexpected response from the server.' };
  }
  const p = payload as Partial<LeadsPayload> | null;
  if (!p || !Array.isArray(p.leads) || !Array.isArray(p.channels)) {
    return { status: 'error', message: 'Leads response had an unexpected shape.' };
  }
  return { status: 'success', data: { leads: p.leads, channels: p.channels, attributed_lead_ids: Array.isArray(p.attributed_lead_ids) ? p.attributed_lead_ids : null, item_attributed_lead_ids: Array.isArray(p.item_attributed_lead_ids) ? p.item_attributed_lead_ids : null } };
}

export type RenameContactResponse =
  | { status: 'renamed'; lead: { id: number; contact_name: string | null; contact_name_source: LeadsPayload['leads'][number]['contact_name_source']; version: number } }
  | { status: 'unchanged' }
  | { status: 'confirm'; message: string }
  | { status: 'error'; message: string };

/** POST /api/leads/:id/contact-name — the caller's own lead only. `confirm` saves past a similar-name warning. */
export async function saveLeadContactName(leadId: number, contactName: string | null, expectedVersion: number, mutationId: string, confirm = false): Promise<RenameContactResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { status: 'error', message: 'Not signed in — please sign in again.' };
  let res: Response;
  try {
    res = await fetch(`/api/leads/${leadId}/contact-name`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_name: contactName, expected_version: expectedVersion, mutation_id: mutationId, confirm }),
    });
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }
  const body = (await res.json().catch(() => null)) as { result?: string; message?: string; error?: string; lead?: { id: number; contact_name: string | null; contact_name_source: string | null; version: number } } | null;
  if (body?.result === 'RENAMED' && body.lead) return { status: 'renamed', lead: body.lead as never };
  if (body?.result === 'NO_CHANGE') return { status: 'unchanged' };
  if (body?.result === 'CONFIRM_REQUIRED') return { status: 'confirm', message: body.message ?? 'A similar contact exists on this item.' };
  if (body?.result === 'NOT_FOUND') return { status: 'error', message: 'Lead not found.' };
  return { status: 'error', message: body?.message || body?.error || `Could not save the name (server returned ${res.status}).` };
}
