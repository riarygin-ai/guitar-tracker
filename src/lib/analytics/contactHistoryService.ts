// Server-callable contact history — the data behind the read-only MCP
// find_contact_history tool: "has this person contacted me before, on this
// item or any other, and what happened?"
//
// Source: item_leads.contact_name (migration 20261019000000, optional Lead
// Log column T), read through the caller's RLS-scoped client ("item_leads:
// select own"). No time window. Leads on sold/traded/closed items are
// included — item_leads rows are never removed when an item leaves
// inventory. Matching rules live in src/lib/leads/contactName.ts; channel
// labels and offer summaries reuse the /leads formatters.
//
// Identity: no user id anywhere. item_id is CONTEXT only (marks same-item
// rows); it never narrows the search and is never looked up, so a foreign
// item id simply marks nothing.
//
// Contact phone / city (migration 20261029000000) are identity SIGNALS:
//   - contact_phone: the strongest lookup — every lead with the same normalized
//     phone (any name, channel, item) is "likely the same contact", never
//     "the same lead" and never guaranteed;
//   - contact_city (with a name): narrows name matches to that city; same name +
//     same city supports identity, it does not prove it. City alone is never a
//     search key.

import type { SupabaseClient } from '@supabase/supabase-js';
import { LEAD_COLUMNS } from '../leads/leadsServer';
import { leadChannelLabel, formatOfferSummary, QUALITY_LABEL, STATUS_LABEL } from '../leads/leadFormat';
import { LEAD_QUALITIES, type LeadRow } from '../leads/leadTypes';
import { normalizeContactName, possibleNameMatch, type PossibleMatchReason } from '../leads/contactName';
import { baseKey, contactKey } from '../leads/classification';
import { STAGE_RANK, type LeadStage } from '../leads/semantics';
import { cityKey, cleanCity, normalizePhone, phoneDigits, samePhone } from '../leads/contactDetails';

export class ContactHistoryServiceError extends Error {}

export interface ContactHistoryQuery {
  /** Required unless contact_phone is given. */
  contact_name?: string;
  /** Any common format; matched on the normalized Canada/US number (digits when it cannot be normalized). */
  contact_phone?: string;
  /** With contact_name only: narrows name matches to this city. */
  contact_city?: string;
  channel?: string;
  /** With channel Other / Regular Buyer/Seller: only that sub-channel (e.g. "Instagram") counts as the same channel. */
  channel_detail?: string;
  item_id?: number;
  include_possible_matches?: boolean;
}

export interface ContactLeadItem {
  item_id: number;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  status: string | null;
}

export interface ContactLeadRecord {
  lead_id: number;
  item: ContactLeadItem;
  same_item: boolean;
  channel: string;
  channel_detail: string | null;
  contact_name: string | null;
  /** The contact's own city, when recorded. */
  contact_city: string | null;
  /** Display form of the recorded phone, when recorded. */
  contact_phone: string | null;
  /** Query had a phone: true = same normalized phone, false = a DIFFERENT phone is recorded, null = not comparable. */
  same_phone: boolean | null;
  /** LEAD_LOG = structured sheet column; NOTES_PREFIX_V1 = backfilled from a historical "<name> — …" note (migration 20261020000000). */
  contact_name_source: string | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  /** Highest observable stage reached (INQUIRY..CONVERTED). */
  peak_stage: string | null;
  peak_stage_source: string | null;
  negotiation_rounds: number;
  waiting_on: string | null;
  reopen_count: number;
  /** Latest event/contact date known for this lead. */
  last_event_at: string | null;
  /** LEGACY Lead Log quality label (null for direct-write leads). Kept for one release. */
  quality: string | null;
  status: string;
  outcome_reason: string | null;
  offer_type: string;
  offer_summary: string;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  cash_component: number | null;
  trade_item: string | null;
  trade_est_value: number | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  notes: string | null;
  linked_deal_id: number | null;
}

export interface ContactHistoryResult {
  query: {
    contact_name: string | null;
    normalized_contact_name: string | null;
    contact_phone_normalized: string | null;
    contact_city: string | null;
    channel: string | null;
    item_id: number | null;
    include_possible_matches: boolean;
  };
  /** What summary counts are based on: NAME (exact name matches), NAME_CITY (name narrowed to the city), PHONE (phone matches; no name given). */
  basis: 'NAME' | 'NAME_CITY' | 'PHONE';
  summary: {
    exact_match_count: number;
    historical_lead_count: number;
    possible_match_count: number;
    other_channel_match_count: number;
    linked_deal_count: number;
    linked_deal_ids: number[];
    same_item_match_count: number;
    distinct_item_count: number;
    first_contact: string | null;
    last_contact: string | null;
    /** Highest peak stage across exact matches. */
    highest_stage: string | null;
    /** LEGACY alias (one release): highest legacy Lead Log quality. */
    highest_quality: string | null;
    by_status: Record<string, number>;
    completed_count: number;
    /** Leads that reached an agreement (AGREED, COMPLETED or FAILED_AFTER_AGREEMENT). */
    agreement_count: number;
    failed_after_agreement_count: number;
    ghosted_count: number;
    declined_by_me_count: number;
    declined_by_them_count: number;
    /** Distinct inventory items this contact has had a lead relationship on. */
    item_relationship_count: number;
  };
  coverage: {
    /** Leads with a recorded contact_name (searchable). */
    leads_with_contact_name: number;
    /** Leads without one (imported before the column existed, or left blank) — invisible to this search. */
    leads_without_contact_name: number;
    leads_with_contact_phone: number;
    leads_with_contact_city: number;
  };
  /** Only with contact_phone. Every lead with the same phone — "likely same contact", each still its own lead. */
  phone_summary: {
    statement: string;
    lead_count: number;
    distinct_item_count: number;
    contact_names: string[];
    linked_deal_ids: number[];
  } | null;
  phone_matches: ContactLeadRecord[];
  /** Only with contact_city: same-name leads with a DIFFERENT recorded city (likely other people, not counted). */
  other_city_matches: ContactLeadRecord[];
  /** Only with contact_city: same-name leads with no recorded city (cannot be narrowed, not counted). */
  unknown_city_matches: ContactLeadRecord[];
  semantics: string[];
  /** Same normalized name (and, when channel was given, same channel). Ordered newest first. */
  exact_matches: ContactLeadRecord[];
  /** channel was given: same normalized name on a DIFFERENT channel — not assumed to be the same person. */
  other_channel_matches: ContactLeadRecord[];
  /** Conservative name-pattern matches, never counted as confirmed history. */
  possible_matches: (ContactLeadRecord & { match_reason: PossibleMatchReason | 'qualifier_variant'; match_score: number; same_channel: boolean | null })[];
}

const SEMANTICS = [
  'Names are compared with the same key direct writes use: case, repeated whitespace, periods/commas, apostrophe variants and accents are ignored; parenthetical qualifiers are KEPT ("Nick (collector)" and "Nick (ES-325)" are different people). The same name with a different or missing qualifier is a possible match (qualifier_variant).',
  'A name is not an identity. exact_matches share the normalized name (and the channel, when one was given); summary counts use exact_matches only.',
  'other_channel_matches share the name but were recorded on another channel (or another channel_detail such as Other / Instagram vs Other / SMS) and are NOT assumed to be the same person.',
  'peak_stage / highest_stage use the INQUIRY..CONVERTED stage model (Negotiating+ = NEGOTIATING, HIGH_INTENT, CONVERTED). quality / highest_quality are the LEGACY Lead Log label, kept for one release.',
  'possible_matches follow a few explicit patterns (last-name initial, first-name prefix, extra middle name/suffix, first-name-only query) and carry match_reason/match_score; treat them as leads to verify, not history.',
  'contact_name_source: LEAD_LOG = recorded in the Lead Log name column; NOTES_PREFIX_V1 = recovered from a historical note that began "<name> — …"; DIRECT = recorded by a direct (MCP) write.',
  'No time window: full history, including leads on sold/traded items. Leads without a recorded contact_name cannot be found (see coverage).',
  'linked_deal_id is the completed Sell/Trade this lead was linked to; use get_operation_context(deal_id) for details.',
  'Phone is the strongest identity signal: phone_matches share the normalized Canada/US phone and are "likely the same contact" — not guaranteed, and each item/episode stays its own lead (nothing is merged). same_phone: false on a name match means a DIFFERENT phone is recorded — likely another person.',
  'contact_city narrows name matches: exact_matches then require the same recorded city; other_city_matches (different city) and unknown_city_matches (no city recorded) are listed separately and not counted. Same name + same city supports identity but does not prove it.',
];

const PAGE = 1000;
const ID_CHUNK = 150;
const QUALITY_RANK = Object.fromEntries(LEAD_QUALITIES.map((q, i) => [q, i])) as Record<string, number>;
const QUALIFIER_SCORE = 0.85;

type LoadedLead = Omit<LeadRow, 'item_name' | 'contact_name'> & { contact_name: string; contact_name_source: string | null; contact_phone_normalized: string | null };
type PhoneLead = Omit<LoadedLead, 'contact_name'> & { contact_name: string | null };

const CONTACT_COLUMNS = 'contact_name_source, contact_city, contact_phone, contact_phone_normalized';

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

async function headCount(client: SupabaseClient, column: string, isNull: boolean): Promise<number> {
  const q = client.from('item_leads').select('id', { count: 'exact', head: true });
  const { count, error } = await (isNull ? q.is(column, null) : q.not(column, 'is', null));
  if (error) throw new ContactHistoryServiceError(`item_leads count: ${error.message}`);
  return count ?? 0;
}

/** Leads with the same phone, any name. Normalized: the indexed exact lookup; otherwise digits over the leads with a phone. */
async function loadPhoneLeads(client: SupabaseClient, phone: string, channelNames: Map<number, string>): Promise<PhoneLead[]> {
  const normalized = normalizePhone(phone);
  let q = client.from('item_leads').select(`${LEAD_COLUMNS}, ${CONTACT_COLUMNS}`);
  q = normalized ? q.eq('contact_phone_normalized', normalized) : q.not('contact_phone', 'is', null);
  const { data, error } = await q.order('id', { ascending: true }).limit(PAGE);
  if (error) throw new ContactHistoryServiceError(`item_leads (phone): ${error.message}`);
  return ((data ?? []) as unknown as Record<string, unknown>[])
    .filter((r) => samePhone({ phone, normalized }, { phone: r.contact_phone as string | null, normalized: r.contact_phone_normalized as string | null }))
    .map((r) => withNumbers(r, channelNames) as unknown as PhoneLead);
}

function withNumbers(r: Record<string, unknown>, channelNames: Map<number, string>): Record<string, unknown> {
  return {
    ...r,
    initial_cash_offer: num(r.initial_cash_offer),
    best_cash_offer: num(r.best_cash_offer),
    cash_component: num(r.cash_component),
    trade_est_value: num(r.trade_est_value),
    channel_name: r.deal_channel_id != null ? channelNames.get(r.deal_channel_id as number) ?? null : null,
  };
}

async function loadChannelNames(client: SupabaseClient): Promise<Map<number, string>> {
  const { data: channelRows, error: chErr } = await client.from('deal_channels').select('id, name');
  if (chErr) throw new ContactHistoryServiceError(`deal_channels: ${chErr.message}`);
  return new Map<number, string>((channelRows ?? []).map((c) => [c.id as number, c.name as string]));
}

async function loadNamedLeads(client: SupabaseClient, channelNames: Map<number, string>): Promise<{ leads: LoadedLead[]; withoutName: number }> {
  const raw: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client.from('item_leads').select(`${LEAD_COLUMNS}, ${CONTACT_COLUMNS}`)
      .not('contact_name', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new ContactHistoryServiceError(`item_leads: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    raw.push(...page);
    if (page.length < PAGE) break;
  }
  return {
    leads: raw.map((r) => withNumbers(r, channelNames) as unknown as LoadedLead),
    withoutName: await headCount(client, 'contact_name', true),
  };
}

async function loadItems(client: SupabaseClient, itemIds: number[]): Promise<Map<number, ContactLeadItem>> {
  const out = new Map<number, ContactLeadItem>();
  if (itemIds.length === 0) return out;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const { data, error } = await client.from('inventory_items').select('id, brand_id, model, year, color, status').in('id', itemIds.slice(i, i + ID_CHUNK));
    if (error) throw new ContactHistoryServiceError(`inventory_items: ${error.message}`);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  const { data: brands, error: bErr } = await client.from('brands').select('id, name');
  if (bErr) throw new ContactHistoryServiceError(`brands: ${bErr.message}`);
  const brandNames = new Map<number, string>((brands ?? []).map((b) => [b.id as number, b.name as string]));
  for (const r of rows) {
    out.set(Number(r.id), {
      item_id: Number(r.id),
      brand: r.brand_id != null ? brandNames.get(Number(r.brand_id)) ?? null : null,
      model: (r.model as string | null) ?? null,
      year: num(r.year),
      color: (r.color as string | null) ?? null,
      status: (r.status as string | null) ?? null,
    });
  }
  return out;
}

const newestFirst = (a: ContactLeadRecord, b: ContactLeadRecord) =>
  (b.last_contact_at ?? b.first_contact_at ?? '').localeCompare(a.last_contact_at ?? a.first_contact_at ?? '') || b.lead_id - a.lead_id;

/** Pure classification over already-loaded leads (exported for tests). */
export function classifyContactLeads(
  leads: LoadedLead[],
  query: ContactHistoryQuery,
): { exact: LoadedLead[]; otherChannel: LoadedLead[]; possible: { lead: LoadedLead; reason: PossibleMatchReason | 'qualifier_variant'; score: number; sameChannel: boolean | null }[] } {
  const wanted = normalizeContactName(query.contact_name ?? '');
  const wantedKey = contactKey(query.contact_name);
  const wantedBase = baseKey(query.contact_name);
  if (!wanted) return { exact: [], otherChannel: [], possible: [] };
  const channel = query.channel?.trim().toLowerCase() || null;
  const detail = query.channel_detail?.trim() ? normalizeContactName(query.channel_detail) : null;
  const includePossible = query.include_possible_matches !== false;
  const exact: LoadedLead[] = [];
  const otherChannel: LoadedLead[] = [];
  const possible: { lead: LoadedLead; reason: PossibleMatchReason | 'qualifier_variant'; score: number; sameChannel: boolean | null }[] = [];
  for (const lead of leads) {
    const stored = normalizeContactName(lead.contact_name);
    const sameChannel = channel === null ? null
      : leadChannelLabel(lead).toLowerCase() === channel && (detail === null || normalizeContactName(lead.channel_detail ?? '') === detail);
    if (contactKey(lead.contact_name) === wantedKey) {
      if (sameChannel === false) otherChannel.push(lead); else exact.push(lead);
    } else if (includePossible) {
      if (baseKey(lead.contact_name) === wantedBase) { possible.push({ lead, reason: 'qualifier_variant', score: QUALIFIER_SCORE, sameChannel }); continue; }
      const m = possibleNameMatch(wanted, stored);
      if (m) possible.push({ lead, reason: m.reason, score: m.score, sameChannel });
    }
  }
  return { exact, otherChannel, possible };
}

export async function findContactHistoryForUser(client: SupabaseClient, query: ContactHistoryQuery): Promise<ContactHistoryResult> {
  const name = query.contact_name?.trim() || null;
  const normalized = name ? normalizeContactName(name) : '';
  const phone = query.contact_phone?.trim() || null;
  const city = cleanCity(query.contact_city);
  if (name && !normalized) throw new ContactHistoryServiceError('contact_name must contain at least one letter or digit');
  if (!name && !phone) throw new ContactHistoryServiceError('contact_name or contact_phone is required');
  if (city && !name) throw new ContactHistoryServiceError('contact_city only narrows a name search — give contact_name too (a city alone is not an identity)');
  if (phone && phoneDigits(phone).length < 7) throw new ContactHistoryServiceError('contact_phone must contain a phone number');
  const phoneNormalized = phone ? normalizePhone(phone) : null;

  const channelNames = await loadChannelNames(client);
  const { leads, withoutName } = name ? await loadNamedLeads(client, channelNames) : { leads: [] as LoadedLead[], withoutName: await headCount(client, 'contact_name', true) };
  const phoneLeads = phone ? await loadPhoneLeads(client, phone, channelNames) : [];
  const classified = classifyContactLeads(leads, { ...query, contact_name: name ?? '' });
  const { otherChannel, possible } = classified;

  // City narrowing: same city stays exact; a different or missing city is listed apart, never counted.
  let exact = classified.exact;
  const otherCity: LoadedLead[] = [];
  const unknownCity: LoadedLead[] = [];
  if (city) {
    const want = cityKey(city);
    exact = [];
    for (const l of classified.exact) {
      const k = cityKey(l.contact_city);
      if (k == null) unknownCity.push(l); else if (k === want) exact.push(l); else otherCity.push(l);
    }
  }

  const allMatched: PhoneLead[] = [...exact, ...otherChannel, ...possible.map((p) => p.lead), ...otherCity, ...unknownCity, ...phoneLeads];
  const items = await loadItems(client, Array.from(new Set(allMatched.map((l) => l.inventory_item_id))));

  const samePhoneOf = (l: PhoneLead): boolean | null =>
    phone == null || !l.contact_phone ? null : samePhone({ phone, normalized: phoneNormalized }, { phone: l.contact_phone, normalized: l.contact_phone_normalized });

  const toRecord = (l: PhoneLead): ContactLeadRecord => ({
    lead_id: l.id,
    item: items.get(l.inventory_item_id) ?? { item_id: l.inventory_item_id, brand: null, model: null, year: null, color: null, status: null },
    same_item: query.item_id != null && l.inventory_item_id === query.item_id,
    channel: leadChannelLabel(l),
    channel_detail: l.channel_detail ?? null,
    contact_name: l.contact_name,
    contact_city: l.contact_city ?? null,
    contact_phone: l.contact_phone ?? null,
    same_phone: samePhoneOf(l),
    contact_name_source: l.contact_name_source,
    first_contact_at: l.first_contact_at,
    last_contact_at: l.last_contact_at,
    peak_stage: l.peak_stage ?? null,
    peak_stage_source: l.peak_stage_source ?? null,
    negotiation_rounds: l.negotiation_rounds ?? 0,
    waiting_on: l.waiting_on ?? null,
    reopen_count: l.reopen_count ?? 0,
    last_event_at: [l.last_inbound_at, l.last_outbound_at, l.last_contact_at].filter((d): d is string => !!d).map((d) => d.slice(0, 10)).sort().pop() ?? null,
    quality: l.lead_quality ? QUALITY_LABEL[l.lead_quality] ?? l.lead_quality : null,
    status: STATUS_LABEL[l.status] ?? l.status,
    outcome_reason: l.outcome_reason,
    offer_type: l.offer_type,
    offer_summary: formatOfferSummary(l),
    initial_cash_offer: l.initial_cash_offer,
    best_cash_offer: l.best_cash_offer,
    cash_component: l.cash_component,
    trade_item: l.trade_item,
    trade_est_value: l.trade_est_value,
    buyer_message_count: l.buyer_message_count,
    our_message_count: l.our_message_count,
    notes: l.notes,
    linked_deal_id: l.deal_id,
  });

  // Summary counts: the name matches when a name was given, otherwise the phone matches.
  const basis: ContactHistoryResult['basis'] = name ? (city ? 'NAME_CITY' : 'NAME') : 'PHONE';
  const primary: PhoneLead[] = name ? exact : phoneLeads;
  const primaryRecords = primary.map(toRecord).sort(newestFirst);
  const dates = primary.flatMap((l) => [l.first_contact_at, l.last_contact_at]).filter((d): d is string => !!d).sort();
  const top = primary.reduce<string | null>((best, l) => (l.lead_quality == null ? best : best === null || QUALITY_RANK[l.lead_quality] > QUALITY_RANK[best] ? l.lead_quality : best), null);
  const topStage = primary.reduce<LeadStage | null>((best, l) => (l.peak_stage == null ? best : best === null || STAGE_RANK[l.peak_stage] > STAGE_RANK[best] ? l.peak_stage : best), null);
  const countStatus = (...st: string[]) => primary.filter((l) => st.includes(l.status)).length;
  const dealIdsOf = (ls: PhoneLead[]) => Array.from(new Set(ls.map((l) => l.deal_id).filter((v): v is number => v != null))).sort((a, b) => a - b);
  const dealIds = dealIdsOf(primary);
  const byStatus: Record<string, number> = {};
  for (const r of primaryRecords) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  const [withPhone, withCity] = await Promise.all([headCount(client, 'contact_phone', false), headCount(client, 'contact_city', false)]);
  const phoneItems = new Set(phoneLeads.map((l) => l.inventory_item_id)).size;
  const phoneBasis = phoneNormalized ? 'same normalized phone' : 'same phone digits (the number could not be normalized)';
  const phoneSummary: ContactHistoryResult['phone_summary'] = phone == null ? null : {
    statement: phoneLeads.length === 0
      ? `No lead has this phone recorded (${withPhone} lead${withPhone === 1 ? ' has' : 's have'} any phone).`
      : `Likely same contact: ${phoneBasis} appears across ${phoneLeads.length} lead${phoneLeads.length === 1 ? '' : 's'} on ${phoneItems} item${phoneItems === 1 ? '' : 's'}.`,
    lead_count: phoneLeads.length,
    distinct_item_count: phoneItems,
    contact_names: Array.from(new Set(phoneLeads.map((l) => l.contact_name).filter((n): n is string => !!n))),
    linked_deal_ids: dealIdsOf(phoneLeads),
  };

  return {
    query: {
      contact_name: name,
      normalized_contact_name: name ? normalized : null,
      contact_phone_normalized: phoneNormalized,
      contact_city: city,
      channel: query.channel?.trim() || null,
      item_id: query.item_id ?? null,
      include_possible_matches: query.include_possible_matches !== false,
    },
    basis,
    summary: {
      exact_match_count: primaryRecords.length,
      historical_lead_count: primaryRecords.length,
      possible_match_count: possible.length,
      other_channel_match_count: otherChannel.length,
      linked_deal_count: dealIds.length,
      linked_deal_ids: dealIds,
      same_item_match_count: primaryRecords.filter((r) => r.same_item).length,
      distinct_item_count: new Set(primary.map((l) => l.inventory_item_id)).size,
      first_contact: dates[0] ?? null,
      last_contact: dates[dates.length - 1] ?? null,
      highest_stage: topStage,
      highest_quality: top ? QUALITY_LABEL[top as keyof typeof QUALITY_LABEL] : null,
      by_status: byStatus,
      completed_count: countStatus('COMPLETED'),
      agreement_count: countStatus('AGREED', 'COMPLETED', 'FAILED_AFTER_AGREEMENT'),
      failed_after_agreement_count: countStatus('FAILED_AFTER_AGREEMENT'),
      ghosted_count: countStatus('GHOSTED'),
      declined_by_me_count: countStatus('DECLINED_BY_ME'),
      declined_by_them_count: countStatus('DECLINED_BY_THEM'),
      item_relationship_count: new Set(primary.map((l) => l.inventory_item_id)).size,
    },
    coverage: {
      leads_with_contact_name: name ? leads.length : await headCount(client, 'contact_name', false),
      leads_without_contact_name: withoutName,
      leads_with_contact_phone: withPhone,
      leads_with_contact_city: withCity,
    },
    semantics: SEMANTICS,
    exact_matches: name ? primaryRecords : [],
    other_channel_matches: otherChannel.map(toRecord).sort(newestFirst),
    possible_matches: possible
      .map((p) => ({ ...toRecord(p.lead), match_reason: p.reason, match_score: p.score, same_channel: p.sameChannel }))
      .sort((a, b) => b.match_score - a.match_score || newestFirst(a, b)),
    phone_summary: phoneSummary,
    phone_matches: phoneLeads.map(toRecord).sort(newestFirst),
    other_city_matches: otherCity.map(toRecord).sort(newestFirst),
    unknown_city_matches: unknownCity.map(toRecord).sort(newestFirst),
  };
}
