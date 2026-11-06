// Contact location history (lead_contact_locations, migration 20261105000000):
// every city observed as associated with a lead's contact, with provenance.
// item_leads.contact_city is only the current snapshot; matching and
// find_contact_history consider the whole history. Read through the caller's
// RLS-scoped client ("select own"); written only by apply_lead_interaction.

import type { SupabaseClient } from '@supabase/supabase-js';
import { CITY_SOURCE_LABEL, cityKey, type ContactCitySource } from './contactDetails';

export interface LocationObservation {
  item_lead_id: number;
  city: string;
  city_key: string;
  source: ContactCitySource | null;
  source_context: string | null;
  observed_at: string | null;
  last_observed_at: string | null;
}

export const LOCATION_COLUMNS = 'item_lead_id, city, city_key, source, source_context, observed_at, last_observed_at';

const ID_CHUNK = 150;

/** Newest observation first (unknown time last), per lead. */
export async function loadContactLocations(client: SupabaseClient, leadIds: number[]): Promise<Map<number, LocationObservation[]>> {
  const out = new Map<number, LocationObservation[]>();
  const ids = Array.from(new Set(leadIds));
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await client.from('lead_contact_locations').select(LOCATION_COLUMNS).in('item_lead_id', ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`lead_contact_locations: ${error.message}`);
    for (const r of (data ?? []) as unknown as LocationObservation[]) {
      const list = out.get(r.item_lead_id) ?? [];
      list.push(r);
      out.set(r.item_lead_id, list);
    }
  }
  for (const list of Array.from(out.values())) list.sort((a, b) => (b.last_observed_at ?? '').localeCompare(a.last_observed_at ?? ''));
  return out;
}

export type CityEvidence = 'CURRENT' | 'HISTORY' | 'DIFFERENT' | 'UNKNOWN';

/**
 * How a queried city relates to a lead: its current snapshot city (CURRENT), an
 * earlier observation only (HISTORY), only other cities (DIFFERENT — never
 * evidence of another person), or no city at all (UNKNOWN).
 */
export function cityEvidence(
  lead: { contact_city: string | null },
  history: LocationObservation[] | undefined,
  city: string,
): { evidence: CityEvidence; observation: LocationObservation | null } {
  const key = cityKey(city);
  const matching = (history ?? []).filter((h) => h.city_key === key);
  if (key && cityKey(lead.contact_city) === key) return { evidence: 'CURRENT', observation: matching[0] ?? null };
  if (key && matching.length) return { evidence: 'HISTORY', observation: matching[0] };
  return { evidence: lead.contact_city || (history ?? []).length ? 'DIFFERENT' : 'UNKNOWN', observation: null };
}

/** What follows "observed": "on their Kijiji listing" / "on their Marketplace profile" / "in their message" / "as recorded by you" / "via <context>". */
export function sourcePhrase(source: ContactCitySource | null, context: string | null, channel: string | null): string | null {
  if (context) return `via ${context}`;
  const where = channel && channel !== 'Unknown' ? `${channel} ` : '';
  switch (source) {
    case 'LISTING': return `on their ${where}listing`;
    case 'PROFILE': return `on their ${where}profile`;
    case 'MESSAGE': return 'in their message';
    case 'MANUAL': return 'as recorded by you';
    default: return null;
  }
}

export const sourceLabel = (s: ContactCitySource | null) => (s ? CITY_SOURCE_LABEL[s] : 'unknown source');
