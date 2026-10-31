// Server-only. Operation DRAFTS — a planned Buy / Sell / Trade captured from
// ChatGPT/MCP (create_operation_draft tool) and finished in the GT UI.
//
// One operation model, two control surfaces: a draft lives in
// operation_drafts / operation_draft_items (20261031000000) and is
// finalized by the UNCHANGED operation RPCs (finalize_operation_draft).
// Nothing here touches deals / deal_items / cash_flow / listings / leads:
// creating a draft has no completed-operation effect at all.
//
// Capture is permissive, finalization strict:
//   - outgoing items are existing items by id (id is authoritative; never
//     created or duplicated from a description) — owned / listed only;
//   - incoming items become ordinary inventory items with the existing
//     status 'new' — brand + model required, every other fact optional and
//     left empty when unknown (no placeholders). A fact GT cannot store as
//     given (an unknown type / purpose / condition / tag) is kept verbatim
//     in the item notes and reported as a warning, never guessed;
//   - cash terms are planning data on the draft only; Value In / Value Out
//     are allocated by the user in the finalization form.
// The winning lead is optional: lead_id, or the one eligible lead on the
// outgoing items whose contact name matches exactly — never mutated here.
//
// Idempotent per mutation_id (the database replays the saved result) and
// retried on transient failures with the SAME request (writeRetry).

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { executeIdempotentMutation, type IdempotentMutationOptions } from '../writeRetry';
import { normalizeContactName } from '../leads/contactName';
import { leadItemName } from '../leads/leadFormat';

export const DRAFT_OPERATION_TYPES = ['BUY', 'SELL', 'TRADE'] as const;
export type DraftOperationType = (typeof DRAFT_OPERATION_TYPES)[number];
export const DRAFT_ITEM_CONDITIONS = ['Mint', 'Excellent', 'Very Good', 'Good', 'Fair'] as const;
export const DRAFT_MAX_ITEMS = 20;

export interface DraftIncomingItemInput {
  brand: string;
  model: string;
  year?: number | null;
  color?: string | null;
  category?: string | null;
  type?: string | null;
  condition?: string | null;
  purpose?: string | null;
  serial_number?: string | null;
  description?: string | null;
  estimated_sold_value?: number | null;
  notes?: string | null;
  tags?: string[] | null;
}

export interface CreateOperationDraftInput {
  mutation_id: string;
  operation_type: DraftOperationType;
  /** Planned / proposed date (may be in the future). YYYY-MM-DD, or an ISO date-time (Toronto date is used). */
  occurred_on?: string | null;
  channel?: string | null;
  contact_name?: string | null;
  lead_id?: number | null;
  outgoing_item_ids?: number[] | null;
  incoming_items?: DraftIncomingItemInput[] | null;
  cash_paid?: number | null;
  cash_received?: number | null;
  notes?: string | null;
}

export interface DraftContext {
  source?: 'MCP' | 'UI';
  clientLabel?: string | null;
  /** Origin used to build the GT link in the result (e.g. https://guitar-tracker-dusky.vercel.app). */
  appOrigin?: string | null;
  retry?: IdempotentMutationOptions;
}

export type LeadResolution =
  | { kind: 'GIVEN'; lead_id: number }
  | { kind: 'MATCHED'; lead_id: number; contact_name: string | null }
  | { kind: 'AMBIGUOUS'; candidate_lead_ids: number[] }
  | { kind: 'NONE' };

export interface DraftItemSummary {
  item_id: number;
  label: string;
  status: string | null;
  /** Fields the finalization will require that are still empty (incoming items only). */
  missing?: string[];
}

export interface CreateOperationDraftResult {
  result: 'CREATED' | 'REJECTED';
  /** true = this mutation_id had already created the draft (nothing new written). */
  replayed: boolean;
  draft_id?: number;
  operation_type?: DraftOperationType;
  status?: 'DRAFT';
  outgoing_item_ids: number[];
  incoming_item_ids: number[];
  lead_id?: number | null;
  lead_resolution?: LeadResolution;
  outgoing?: DraftItemSummary[];
  incoming?: DraftItemSummary[];
  url?: string | null;
  /** e.g. "🟢 Draft Trade created" — show it, then `lines`. */
  headline: string;
  lines: string[];
  warnings: string[];
  reason?: string;
  message?: string;
}

const TYPE_LABEL: Record<DraftOperationType, string> = { BUY: 'Buy', SELL: 'Sell', TRADE: 'Trade' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ALIASES: Record<string, string> = {
  'facebook marketplace': 'marketplace', 'fb marketplace': 'marketplace', facebook: 'marketplace', fb: 'marketplace', fbm: 'marketplace',
};
/** Database error codes raised by the draft RPCs (RAISE EXCEPTION '<CODE>: …'). */
const DB_CODES = [
  'MUTATION_ID_REUSED', 'VALIDATION_ERROR', 'ITEM_NOT_FOUND', 'ITEM_NOT_AVAILABLE', 'INVALID_CHANNEL',
  'LEAD_NOT_FOUND', 'LEAD_NOT_ON_OUTGOING_ITEM', 'LEAD_NOT_ELIGIBLE', 'NOT_AUTHENTICATED',
] as const;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined && val !== null) acc[k] = canonical(val);
      return acc;
    }, {});
  }
  return v;
}
const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const ci = (s: string | null | undefined) => (s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const clean = (s: string | null | undefined) => { const t = (s ?? '').trim(); return t ? t : null; };
const singular = (s: string) => s.replace(/s$/, '');

/** Planned date: YYYY-MM-DD kept as given (no timezone shift); an ISO date-time → its Toronto calendar date. */
export function draftDate(value: string | null | undefined): string | null | 'INVALID' {
  if (value == null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = Date.parse(`${v}T12:00:00Z`);
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? 'INVALID' : v;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) return 'INVALID';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date(t));
}

export function formatCad(n: number): string {
  return `C$${Number(n).toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function rejected(reason: string, message: string, warnings: string[] = []): CreateOperationDraftResult {
  return { result: 'REJECTED', replayed: false, outgoing_item_ids: [], incoming_item_ids: [], headline: '🔴 Draft: REJECTED', lines: [message], warnings, reason, message };
}

interface Lookups {
  channels: { id: number; name: string }[];
  brands: { id: number; name: string }[];
  categories: { id: number; name: string }[];
  subtypes: { id: number; name: string; category_id: number }[];
  purposes: { id: number; name: string }[];
  tags: { id: number; name: string }[];
}

async function loadLookups(client: SupabaseClient, brandNames: string[]): Promise<Lookups> {
  const [ch, br, cat, st, pu, tg] = await Promise.all([
    client.from('deal_channels').select('id, name').eq('is_active', true),
    brandNames.length ? client.from('brands').select('id, name') : Promise.resolve({ data: [], error: null }),
    client.from('item_categories').select('id, name').eq('is_active', true),
    client.from('item_subtypes').select('id, name, category_id').eq('is_active', true),
    client.from('item_purposes').select('id, name').eq('is_active', true),
    client.from('inventory_tags').select('id, name').eq('is_active', true),
  ]);
  const err = ch.error ?? br.error ?? cat.error ?? st.error ?? pu.error ?? tg.error;
  if (err) throw new Error(`lookups: ${err.message}`);
  return {
    channels: (ch.data ?? []) as Lookups['channels'], brands: (br.data ?? []) as Lookups['brands'],
    categories: (cat.data ?? []) as Lookups['categories'], subtypes: (st.data ?? []) as Lookups['subtypes'],
    purposes: (pu.data ?? []) as Lookups['purposes'], tags: (tg.data ?? []) as Lookups['tags'],
  };
}

/**
 * Category / type → item_subtype_id. Exact (case-insensitive) type name; or,
 * within the given category, the ONE type whose name appears as a word of
 * the text ("Distortion pedal" in Pedals → Pedal). Otherwise unresolved.
 */
export function resolveItemType(l: Pick<Lookups, 'categories' | 'subtypes'>, category: string | null, type: string | null):
  { subtype_id: number | null; note: string | null; warning: string | null } {
  if (!category && !type) return { subtype_id: null, note: null, warning: null };
  const cat = category ? l.categories.find((c) => ci(c.name) === ci(category) || singular(ci(c.name)) === singular(ci(category))) ?? null : null;
  const pool = cat ? l.subtypes.filter((s) => s.category_id === cat.id) : l.subtypes;
  const shown = `${category ?? ''}${category && type ? ' / ' : ''}${type ?? ''}`;
  if (type) {
    const exact = pool.filter((s) => ci(s.name) === ci(type));
    if (exact.length === 1) return { subtype_id: exact[0].id, note: null, warning: null };
    if (cat) {
      const words = new Set(ci(type).split(/[^a-z0-9]+/).filter(Boolean).map(singular));
      const partial = pool.filter((s) => s.name.toLowerCase() !== 'other' && words.has(singular(ci(s.name))));
      if (partial.length === 1) return { subtype_id: partial[0].id, note: `Type: ${type}`, warning: null };
    }
  }
  const options = (cat ? pool : l.subtypes).map((s) => s.name).join(', ');
  return {
    subtype_id: null,
    note: `Category / type (as captured): ${shown}`,
    warning: `Item type "${shown}" is not a Guitar Tracker type — left empty (set it in GT${options ? `; types: ${options}` : ''}).`,
  };
}

interface PreparedItem {
  request: Record<string, unknown>;
  warnings: string[];
}

function prepareIncoming(l: Lookups, it: DraftIncomingItemInput, idx: number): PreparedItem | { error: string } {
  const n = idx + 1;
  const brand = clean(it.brand);
  const model = clean(it.model);
  if (!brand) return { error: `Incoming item ${n} needs a brand.` };
  if (!model) return { error: `Incoming item ${n} needs a model.` };
  if (it.year != null && (!Number.isInteger(it.year) || it.year < 1900 || it.year > 2100)) return { error: `Incoming item ${n}: year must be a whole number between 1900 and 2100 (omit it when unknown).` };
  if (it.estimated_sold_value != null && !(Number.isFinite(it.estimated_sold_value) && it.estimated_sold_value > 0)) return { error: `Incoming item ${n}: estimated_sold_value must be greater than 0 (omit it when unknown).` };
  const warnings: string[] = [];
  const captured: string[] = [];
  const label = `${brand} ${model}`;

  const existingBrand = l.brands.find((b) => ci(b.name) === ci(brand)) ?? null;
  const t = resolveItemType(l, clean(it.category), clean(it.type));
  if (t.note) captured.push(t.note);
  if (t.warning) warnings.push(`${label}: ${t.warning}`);

  let condition: string | null = null;
  if (clean(it.condition)) {
    condition = DRAFT_ITEM_CONDITIONS.find((c) => ci(c) === ci(it.condition)) ?? null;
    if (!condition) { captured.push(`Condition (as captured): ${clean(it.condition)}`); warnings.push(`${label}: condition "${clean(it.condition)}" is not one of ${DRAFT_ITEM_CONDITIONS.join(', ')} — left empty.`); }
  }
  let purposeId: number | null = null;
  if (clean(it.purpose)) {
    purposeId = l.purposes.find((p) => ci(p.name) === ci(it.purpose))?.id ?? null;
    if (purposeId == null) { captured.push(`Purpose (as captured): ${clean(it.purpose)}`); warnings.push(`${label}: purpose "${clean(it.purpose)}" is not one of ${l.purposes.map((p) => p.name).join(', ')} — left empty.`); }
  }
  const tagIds: number[] = [];
  for (const tag of it.tags ?? []) {
    const hit = l.tags.find((x) => ci(x.name) === ci(tag));
    if (hit) { if (!tagIds.includes(hit.id)) tagIds.push(hit.id); }
    else if (clean(tag)) warnings.push(`${label}: tag "${clean(tag)}" does not exist in GT — not added (tags are managed in GT).`);
  }

  const notes = [clean(it.description), clean(it.notes), captured.length ? captured.join('\n') : null].filter(Boolean).join('\n\n') || null;
  if (notes && notes.length > 4000) return { error: `Incoming item ${n}: description + notes are too long (max 4000 characters).` };

  return {
    request: {
      ...(existingBrand ? { brand_id: existingBrand.id } : { brand_name: brand }),
      model, year: it.year ?? null, color: clean(it.color), serial_number: clean(it.serial_number),
      item_subtype_id: t.subtype_id, condition, purpose_id: purposeId,
      estimated_sold_value: it.estimated_sold_value ?? null, notes, tag_ids: tagIds,
    },
    warnings,
  };
}

/** The one eligible lead on the outgoing items with exactly this contact name (and channel, when given). */
async function matchLead(client: SupabaseClient, outgoing: number[], contactName: string | null, channelName: string | null): Promise<LeadResolution> {
  if (!contactName || outgoing.length === 0) return { kind: 'NONE' };
  const { data, error } = await client.from('item_leads').select('id, contact_name, source_channel, status, deal_id').in('inventory_item_id', outgoing);
  if (error) throw new Error(`item_leads: ${error.message}`);
  const want = normalizeContactName(contactName);
  const hits = (data ?? []).filter((r) => r.deal_id == null && r.status !== 'COMPLETED'
    && r.contact_name && normalizeContactName(r.contact_name as string) === want
    && (!channelName || ci(r.source_channel as string) === ci(channelName)));
  if (hits.length === 1) return { kind: 'MATCHED', lead_id: Number(hits[0].id), contact_name: hits[0].contact_name as string };
  if (hits.length > 1) return { kind: 'AMBIGUOUS', candidate_lead_ids: hits.map((h) => Number(h.id)).sort((a, b) => a - b) };
  return { kind: 'NONE' };
}

const REQUIRED_AT_FINALIZE: [string, string][] = [['item_subtype_id', 'type'], ['condition', 'condition'], ['purpose_id', 'purpose'], ['estimated_sold_value', 'estimated sold value']];

/** Display summaries for the draft's items (read-only, the caller's own rows). */
export async function summarizeDraftItems(client: SupabaseClient, ids: number[]): Promise<Map<number, DraftItemSummary>> {
  const out = new Map<number, DraftItemSummary>();
  if (ids.length === 0) return out;
  const { data: items, error } = await client.from('inventory_items')
    .select('id, year, model, color, brand_id, status, item_subtype_id, condition, purpose_id, estimated_sold_value').in('id', ids);
  if (error) throw new Error(`inventory_items: ${error.message}`);
  const brandIds = Array.from(new Set((items ?? []).map((i) => i.brand_id as number)));
  const { data: brands } = brandIds.length ? await client.from('brands').select('id, name').in('id', brandIds) : { data: [] };
  const brandName = new Map((brands ?? []).map((b) => [b.id as number, b.name as string]));
  for (const it of items ?? []) {
    const base = leadItemName(it.year as number | null, brandName.get(it.brand_id as number) ?? null, it.model as string, it.id as number);
    const missing = REQUIRED_AT_FINALIZE.filter(([k]) => (it as Record<string, unknown>)[k] == null).map(([, label]) => label);
    out.set(it.id as number, { item_id: it.id as number, label: it.color ? `${base} — ${it.color}` : base, status: it.status as string, missing });
  }
  return out;
}

export async function createOperationDraft(client: SupabaseClient, input: CreateOperationDraftInput, ctx: DraftContext = {}): Promise<CreateOperationDraftResult> {
  // ── Shape ──────────────────────────────────────────────────────────────
  if (typeof input.mutation_id !== 'string' || !UUID_RE.test(input.mutation_id)) return rejected('VALIDATION_ERROR', 'mutation_id must be a UUID (one per logical draft; reuse it on retries).');
  if (!DRAFT_OPERATION_TYPES.includes(input.operation_type)) return rejected('VALIDATION_ERROR', 'operation_type must be BUY, SELL or TRADE.');
  const type = input.operation_type;
  const outgoing = (input.outgoing_item_ids ?? []).map(Number);
  const incomingIn = input.incoming_items ?? [];
  if (outgoing.some((n) => !Number.isInteger(n) || n <= 0)) return rejected('VALIDATION_ERROR', 'outgoing_item_ids must be positive item ids.');
  if (new Set(outgoing).size !== outgoing.length) return rejected('VALIDATION_ERROR', 'An outgoing item is listed twice.');
  if (outgoing.length > DRAFT_MAX_ITEMS || incomingIn.length > DRAFT_MAX_ITEMS) return rejected('VALIDATION_ERROR', `At most ${DRAFT_MAX_ITEMS} outgoing and ${DRAFT_MAX_ITEMS} incoming items.`);
  if (type === 'BUY' && (outgoing.length > 0 || incomingIn.length === 0)) return rejected('VALIDATION_ERROR', 'A Buy draft needs at least one incoming item and no outgoing items.');
  if (type === 'SELL' && (incomingIn.length > 0 || outgoing.length === 0)) return rejected('VALIDATION_ERROR', 'A Sell draft needs at least one outgoing item (by id) and no incoming items.');
  if (type === 'TRADE' && outgoing.length + incomingIn.length === 0) return rejected('VALIDATION_ERROR', 'A Trade draft needs at least one item.');
  const cashPaid = input.cash_paid ?? 0;
  const cashReceived = input.cash_received ?? 0;
  for (const [k, v] of [['cash_paid', cashPaid], ['cash_received', cashReceived]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 10_000_000) return rejected('VALIDATION_ERROR', `${k} must be 0 or a positive amount.`);
  }
  if (type === 'BUY' && cashReceived > 0) return rejected('VALIDATION_ERROR', 'A Buy draft has no cash received.');
  if (type === 'SELL' && cashPaid > 0) return rejected('VALIDATION_ERROR', 'A Sell draft has no cash paid.');
  const date = draftDate(input.occurred_on);
  if (date === 'INVALID') return rejected('VALIDATION_ERROR', 'occurred_on must be YYYY-MM-DD (or an ISO date-time).');
  const notes = clean(input.notes);
  if (notes && notes.length > 4000) return rejected('VALIDATION_ERROR', 'notes are too long (max 4000 characters).');
  const contactName = clean(input.contact_name);
  if (contactName && contactName.length > 200) return rejected('VALIDATION_ERROR', 'contact_name is too long.');
  if (input.lead_id != null && (!Number.isInteger(input.lead_id) || input.lead_id <= 0)) return rejected('VALIDATION_ERROR', 'lead_id must be a positive id.');

  // ── Names → ids ────────────────────────────────────────────────────────
  const lookups = await loadLookups(client, incomingIn.map((i) => i.brand));
  let channel: { id: number; name: string } | null = null;
  if (clean(input.channel)) {
    const want = CHANNEL_ALIASES[ci(input.channel)] ?? ci(input.channel);
    channel = lookups.channels.find((c) => ci(c.name) === want) ?? null;
    if (!channel) return rejected('INVALID_CHANNEL', `Channel "${clean(input.channel)}" is not a Guitar Tracker channel. Use one of: ${lookups.channels.map((c) => c.name).join(', ')}.`);
  }
  const warnings: string[] = [];
  const incoming: Record<string, unknown>[] = [];
  for (let i = 0; i < incomingIn.length; i++) {
    const p = prepareIncoming(lookups, incomingIn[i], i);
    if ('error' in p) return rejected('VALIDATION_ERROR', p.error);
    incoming.push(p.request);
    warnings.push(...p.warnings);
  }

  // ── Lead (optional; never mutated while draft) ─────────────────────────
  const leadResolution: LeadResolution = input.lead_id != null
    ? { kind: 'GIVEN', lead_id: input.lead_id }
    : await matchLead(client, outgoing, contactName, channel?.name ?? null);
  const leadId = leadResolution.kind === 'GIVEN' || leadResolution.kind === 'MATCHED' ? leadResolution.lead_id : null;
  if (leadResolution.kind === 'AMBIGUOUS') warnings.push(`Several open leads match "${contactName}" (${leadResolution.candidate_lead_ids.map((x) => `#${x}`).join(', ')}) — no lead linked; pick the winning lead in GT when finalizing.`);

  // Outgoing items already planned in another open draft (allowed — alternative proposals — but worth saying).
  if (outgoing.length) {
    const { data: others } = await client.from('operation_draft_items').select('item_id, draft_id, operation_drafts!inner(status)')
      .in('item_id', outgoing).eq('direction', 'out').eq('operation_drafts.status', 'OPEN');
    for (const o of others ?? []) warnings.push(`Item #${o.item_id} is also the outgoing item of open draft #${o.draft_id}.`);
  }

  // The hash covers the caller's request (not resolved ids), so a retry replays even if lookups changed meanwhile.
  const requestHash = sha256({
    operation_type: type, occurred_on: date, channel: channel?.name ?? null, contact_name: contactName, lead_id: input.lead_id ?? null,
    outgoing_item_ids: outgoing, incoming_items: incomingIn, cash_paid: cashPaid, cash_received: cashReceived, notes,
  });
  const p_request = {
    mutation_id: input.mutation_id, request_hash: requestHash, source: ctx.source ?? 'MCP', client_label: ctx.clientLabel ?? null,
    operation_type: type, proposed_date: date, deal_channel_id: channel?.id ?? null, contact_name: contactName, lead_id: leadId,
    cash_paid: cashPaid, cash_received: cashReceived, notes, outgoing_item_ids: outgoing, incoming_items: incoming,
  };

  const { response: { data, error }, attempts, exhausted } = await executeIdempotentMutation(
    'create_operation_draft', () => client.rpc('create_operation_draft', { p_request }), ctx.retry);
  if (error) {
    const code = DB_CODES.find((c) => error.message.startsWith(c) || error.message.includes(`${c}:`)) ?? 'WRITE_FAILED';
    const detail = error.message.replace(/^[A-Z_]+:\s*/, '');
    const message = code === 'WRITE_FAILED'
      ? `Could not save the draft${exhausted ? ` after ${attempts} attempts` : ''}: ${error.message}. Nothing was saved; retry with the SAME mutation_id.`
      : code === 'MUTATION_ID_REUSED' ? `${detail}. Use a new mutation_id for a new draft.` : detail;
    return rejected(code, message, warnings);
  }
  const r = data as { status: 'OK' | 'REPLAY'; draft_id: number; outgoing_item_ids: number[]; incoming_item_ids: number[]; lead_id: number | null };
  // REPLAY on a later attempt = this call's own earlier attempt committed (response lost): it is this call's write.
  const replayed = r.status === 'REPLAY' && attempts === 1;

  const summaries = await summarizeDraftItems(client, [...r.outgoing_item_ids, ...r.incoming_item_ids]);
  const out = r.outgoing_item_ids.map((id) => summaries.get(id) ?? { item_id: id, label: `Item #${id}`, status: null });
  const inc = r.incoming_item_ids.map((id) => summaries.get(id) ?? { item_id: id, label: `Item #${id}`, status: 'new' });
  const url = ctx.appOrigin ? `${ctx.appOrigin.replace(/\/$/, '')}/operations/drafts/${r.draft_id}` : null;

  const lines: string[] = [`Draft #${r.draft_id}`];
  if (out.length) lines.push('OUT', ...out.map((s) => `#${s.item_id} ${s.label}`));
  if (inc.length) lines.push('IN', ...inc.map((s) => `#${s.item_id} ${s.label} (new)`));
  if (cashReceived > 0) lines.push(`Cash received: ${formatCad(cashReceived)}`);
  if (cashPaid > 0) lines.push(`Cash paid: ${formatCad(cashPaid)}`);
  if (date) lines.push(`Proposed date: ${date}`);
  if (channel || contactName) lines.push([channel?.name, contactName].filter(Boolean).join(' · '));
  if (r.lead_id) lines.push(`Lead: #${r.lead_id} (completed only when the operation is finalized)`);
  lines.push('Status: DRAFT — not completed. Finish (photos, specs, values, economics) and finalize in Guitar Tracker.');
  if (url) lines.push(url);

  return {
    result: 'CREATED', replayed, draft_id: r.draft_id, operation_type: type, status: 'DRAFT',
    outgoing_item_ids: r.outgoing_item_ids, incoming_item_ids: r.incoming_item_ids, lead_id: r.lead_id, lead_resolution: leadResolution,
    outgoing: out, incoming: inc, url,
    headline: replayed ? `⚪ Draft ${TYPE_LABEL[type]} already created (same mutation_id)` : `🟢 Draft ${TYPE_LABEL[type]} created`,
    lines, warnings,
  };
}
