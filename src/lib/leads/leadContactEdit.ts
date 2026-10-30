// Server-only. User correction of a lead's contact name (Leads detail panel).
//
// Identity fields come from the direct-write lead system, never a second
// algorithm: contact_key = classification.contactKey (parenthetical
// qualifiers KEPT), sibling matching = the same channelKey / baseKey /
// possibleNameMatch rules record_lead_interaction uses.
//
// Collisions, on the SAME item + channel (+ channel detail) only:
//   - another lead already holds the exact new key -> BLOCKED (renaming would
//     make two leads indistinguishable to the matcher; nothing is merged);
//   - a near match (same base name with one side unqualified, or a
//     conservative possible-name match) -> CONFIRM_REQUIRED, then saved on
//     explicit confirmation (the direct-write matcher also asks before
//     treating those as the same person).
//
// History: an INTERNAL NOTE audit event ("Contact name changed from … to …")
// planned by leadWriteService and applied with the rename in one transaction
// (rename_lead_contact). It is not buyer activity: stage, status, offers,
// counts and legacy notes are unchanged.

import type { SupabaseClient } from '@supabase/supabase-js';
import { prepareLeadUpdate, isPlaceholderName } from './leadWriteService';
import { baseKey, channelKey, contactKey, hasQualifier } from './classification';
import { normalizeContactName, possibleNameMatch } from './contactName';
import { executeIdempotentMutation } from '../writeRetry';

export const CONTACT_NAME_MAX = 120;

export interface ContactNameLeadRef {
  lead_id: number;
  contact_name: string | null;
  status: string;
  why: string;
}

export type RenameContactResult =
  | { result: 'RENAMED'; lead: { id: number; contact_name: string | null; contact_name_source: string | null; contact_key: string | null; version: number } }
  | { result: 'NO_CHANGE' }
  | { result: 'CONFIRM_REQUIRED'; message: string; similar: ContactNameLeadRef[] }
  | { result: 'BLOCKED'; message: string; conflicting: ContactNameLeadRef }
  | { result: 'STALE'; message: string }
  | { result: 'NOT_FOUND' }
  | { result: 'INVALID'; message: string };

/** The stored form of a typed name: trimmed, inner whitespace collapsed, qualifiers untouched; '' -> null. */
export function cleanContactName(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

interface SiblingRow { id: number; contact_name: string | null; contact_key: string | null; source_channel: string | null; channel_detail: string | null; status: string }

/** Pure: collision classification of a new name against same-item siblings (the lead itself excluded by the caller). */
export function classifyContactCollision(newName: string, lead: { source_channel: string | null; channel_detail: string | null }, siblings: SiblingRow[]):
  { kind: 'exact'; lead: ContactNameLeadRef } | { kind: 'similar'; leads: ContactNameLeadRef[] } | { kind: 'none' } {
  const key = contactKey(newName);
  const myChannel = channelKey(lead.source_channel, lead.channel_detail);
  const same = siblings.filter((s) => channelKey(s.source_channel, s.channel_detail) === myChannel && s.contact_key);
  const exact = same.find((s) => s.contact_key === key);
  if (exact) return { kind: 'exact', lead: { lead_id: exact.id, contact_name: exact.contact_name, status: exact.status, why: 'same item, channel and contact' } };
  const myBase = baseKey(newName);
  const myNorm = normalizeContactName(newName);
  const similar: ContactNameLeadRef[] = [];
  for (const s of same) {
    const bothQualified = hasQualifier(newName) && hasQualifier(s.contact_name);
    if (bothQualified) continue;
    if (baseKey(s.contact_name) === myBase) { similar.push({ lead_id: s.id, contact_name: s.contact_name, status: s.status, why: 'same name, one side has a qualifier' }); continue; }
    const other = normalizeContactName(s.contact_name ?? '');
    const pm = possibleNameMatch(myNorm, other) ?? possibleNameMatch(other, myNorm);
    if (pm) similar.push({ lead_id: s.id, contact_name: s.contact_name, status: s.status, why: pm.reason });
  }
  return similar.length ? { kind: 'similar', leads: similar } : { kind: 'none' };
}

export class LeadContactEditError extends Error {}

export async function renameLeadContact(db: SupabaseClient, appUserId: number, params: {
  leadId: number;
  contactName: string | null;
  expectedVersion: number;
  mutationId: string;
  confirm?: boolean;
}, now: Date = new Date()): Promise<RenameContactResult> {
  const name = cleanContactName(params.contactName);
  if (name && name.length > CONTACT_NAME_MAX) return { result: 'INVALID', message: `Name must be at most ${CONTACT_NAME_MAX} characters.` };
  if (name && isPlaceholderName(name)) return { result: 'INVALID', message: `"${name}" is a placeholder, not a name — leave the name empty instead.` };

  const { data: lead, error } = await db.from('item_leads')
    .select('id, inventory_item_id, contact_name, contact_key, source_channel, channel_detail, status, version')
    .eq('id', params.leadId).eq('user_id', appUserId).maybeSingle();
  if (error) throw new LeadContactEditError(`item_leads: ${error.message}`);
  if (!lead) return { result: 'NOT_FOUND' };
  if (Number(lead.version) !== params.expectedVersion) return { result: 'STALE', message: 'This lead changed since you opened it. Reload and try again.' };
  if ((lead.contact_name ?? null) === name) return { result: 'NO_CHANGE' };

  const key = contactKey(name);
  if (name) {
    const { data: sibs, error: sibError } = await db.from('item_leads')
      .select('id, contact_name, contact_key, source_channel, channel_detail, status')
      .eq('user_id', appUserId).eq('inventory_item_id', lead.inventory_item_id).neq('id', lead.id);
    if (sibError) throw new LeadContactEditError(`item_leads (siblings): ${sibError.message}`);
    const c = classifyContactCollision(name, lead, (sibs ?? []) as SiblingRow[]);
    if (c.kind === 'exact') {
      return { result: 'BLOCKED', conflicting: c.lead, message: `Lead #${c.lead.lead_id} on this item and channel is already "${c.lead.contact_name}". Leads are never merged by renaming — use a distinguishing qualifier, e.g. "${name} (2)".` };
    }
    if (c.kind === 'similar' && !params.confirm) {
      return { result: 'CONFIRM_REQUIRED', similar: c.leads, message: `This item already has a similar contact on the same channel (${c.leads.map((l) => `#${l.lead_id} "${l.contact_name}"`).join(', ')}). Save anyway as a different person?` };
    }
  }

  const old = lead.contact_name as string | null;
  const summary = name == null ? `Contact name cleared (was "${old}")`
    : old == null ? `Contact name added: "${name}"`
    : `Contact name changed from "${old}" to "${name}"`;
  const prepared = await prepareLeadUpdate(db, {
    mutation_id: params.mutationId,
    lead: { lead_id: lead.id as number },
    events: [{ type: 'NOTE', direction: 'INTERNAL', occurred_at: now.toISOString(), provenance: 'STATED', summary, payload: { topic: 'OTHER', change: 'CONTACT_NAME', from: old, to: name } }],
  }, { source: 'UI', clientLabel: 'leads-ui', now });
  if ('result' in prepared) return { result: 'INVALID', message: prepared.message ?? 'The lead could not be updated.' };
  // A rename is metadata only: refuse if writing it would move any derived lead field
  // (e.g. a never-classified lead would get a first peak stage). Allowed: semantics_version
  // (bookkeeping) and waiting_on unknown -> NONE, the deterministic value for a lead in a final
  // status (legacy rows store NULL; any write through the lead layer normalizes it).
  const changes = prepared.storedResult.changes ?? {};
  const moved = Object.keys(changes).filter((k) => k !== 'semantics_version'
    && !(k === 'waiting_on' && changes[k][0] == null && changes[k][1] === 'NONE'));
  if (moved.length > 0) {
    return { result: 'INVALID', message: `Renaming would also change this lead's ${moved.join(', ')} — it has not been classified yet. Nothing was changed.` };
  }

  // Retried only on transient failures, with the same request: a committed rename replays (REPLAY → treated as saved).
  const renameArgs = { p_request: prepared.request, p_contact_name: name, p_contact_key: key };
  const { response: { data, error: rpcError } } = await executeIdempotentMutation('rename_lead_contact', () => db.rpc('rename_lead_contact', renameArgs));
  if (rpcError) {
    const m = /CONTACT_KEY_CONFLICT: lead (\d+)/.exec(rpcError.message);
    if (m) return { result: 'BLOCKED', conflicting: { lead_id: Number(m[1]), contact_name: name, status: '', why: 'same item, channel and contact' }, message: `Lead #${m[1]} on this item and channel already has that name.` };
    throw new LeadContactEditError(`rename_lead_contact: ${rpcError.message}`);
  }
  const status = (data as { status?: string } | null)?.status;
  if (status === 'NOT_FOUND') return { result: 'NOT_FOUND' };
  if (status === 'CONFLICT') return { result: 'STALE', message: 'This lead changed while saving. Reload and try again.' };

  const { data: after, error: afterError } = await db.from('item_leads').select('id, contact_name, contact_name_source, contact_key, version').eq('id', lead.id).single();
  if (afterError) throw new LeadContactEditError(`item_leads (after): ${afterError.message}`);
  return { result: 'RENAMED', lead: { id: after.id as number, contact_name: after.contact_name as string | null, contact_name_source: after.contact_name_source as string | null, contact_key: after.contact_key as string | null, version: Number(after.version) } };
}
