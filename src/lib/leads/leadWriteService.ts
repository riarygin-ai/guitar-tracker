// Direct lead writes — the service behind the MCP record_lead_interaction /
// void_lead_event tools.
//
//   validate → idempotency replay check → resolve lead (match / review)
//   → load baseline + events → synthesize system events → validate transitions
//   → dedupe → derive snapshot (classification.ts) → atomic RPC
//   (apply_lead_interaction: events + snapshot in ONE transaction)
//   → one CONFLICT rebase → machine-readable result.
//
// Security: takes NO user identity. `client` is the caller's own RLS-scoped
// Supabase client (MCP: the OAuth user's). Every read is RLS-filtered; the
// only write is the SECURITY DEFINER RPC, which resolves the user itself.
// A foreign item/lead/deal is indistinguishable from a nonexistent one.
//
// Results: APPLIED_CREATE | APPLIED_UPDATE | NO_CHANGE | REVIEW_REQUIRED |
// REJECTED. Review is STATELESS: nothing is written; the agent re-sends the
// same request (same mutation_id) with `resolution` after asking the user.

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CHANNEL_DB_NAME,
  DETAIL_CHANNELS,
  EVIDENCE_KINDS,
  LEAD_STATUSES,
  LOGISTICS_KINDS,
  LOGISTICS_STATES,
  NOTE_TOPICS,
  OFFER_ASSESSMENTS,
  OUTCOME_REASONS,
  SEMANTICS_VERSION,
  isFinal,
  isReopenable,
  isTerminal,
  outcomeAllowedFor,
  type AgentEventType,
  type LeadChannel,
  type LeadStatusValue,
  type OutcomeReasonValue,
  type StageSource,
  type WaitingOn,
} from './semantics';
import {
  EMPTY_OFFER,
  baseChannelKey,
  baseKey,
  channelKey,
  contactKey,
  deriveSnapshot,
  emptyBaseline,
  ghostPreconditionsMet,
  hasQualifier,
  isConversational,
  offerError,
  offerShape,
  sortEvents,
  type ClassifiableEvent,
  type DerivedSnapshot,
  type LeadBaseline,
  type OfferPayload,
  type OfferType,
} from './classification';
import { normalizeContactName, possibleNameMatch } from './contactName';

// ── Public types ────────────────────────────────────────────────────────────

export type WriteResultCode = 'APPLIED_CREATE' | 'APPLIED_UPDATE' | 'NO_CHANGE' | 'REVIEW_REQUIRED' | 'REJECTED';

export const REVIEW_REASONS = [
  'MULTIPLE_CONTACT_MATCHES', 'POSSIBLE_DUPLICATE', 'POSSIBLE_DIFFERENT_PERSON', 'CROSS_CHANNEL_MATCH',
  'CONTACT_NAME_MISSING', 'ITEM_MISMATCH', 'CONTACT_MISMATCH', 'CHANNEL_MISMATCH', 'EVENT_ON_FINAL_LEAD',
  'DESTRUCTIVE_TRANSITION', 'GHOST_PRECONDITIONS_UNMET', 'DEAL_LINK_CONFLICT', 'CONTRADICTION',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REJECT_REASONS = [
  'VALIDATION_ERROR', 'ITEM_NOT_FOUND', 'INVALID_CHANNEL', 'LEAD_NOT_FOUND', 'EVENT_NOT_FOUND', 'DEAL_NOT_VALID',
  'DEAL_REQUIRED', 'MUTATION_ID_REUSED', 'CONCURRENT_UPDATE', 'EVENT_PRECEDES_BASELINE', 'NOT_AUTHENTICATED',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const RESOLUTION_ACTIONS = ['USE_LEAD', 'CREATE_NEW', 'CREATE_UNNAMED', 'CONFIRM'] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

export interface AgentEventInput {
  type: AgentEventType;
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
  occurred_at: string;
  summary: string;
  message_count?: number;
  expects_reply?: boolean;
  provenance?: 'OBSERVED' | 'STATED' | 'INFERRED';
  payload?: Record<string, unknown>;
}

export interface RecordLeadInteractionInput {
  mutation_id: string;
  lead: { lead_id?: number; item_id?: number; channel?: LeadChannel; channel_detail?: string; contact_name?: string };
  events: AgentEventInput[];
  resolution?: { action: ResolutionAction; lead_id?: number };
  dry_run?: boolean;
}

export interface VoidLeadEventInput {
  mutation_id: string;
  event_id: number;
  reason: string;
  expected_version: number;
  confirm?: boolean;
}

export interface WriteContext {
  clientLabel?: string | null;
  /** Where the write originates: the MCP tools (default) or the app UI (operation forms). Recorded on each submitted event. */
  source?: 'MCP' | 'UI';
  now?: Date;
}

export type Changes = Record<string, [unknown, unknown]>;

export interface LeadCandidate {
  lead_id: number;
  item_id: number;
  channel: string | null;
  channel_detail: string | null;
  contact_name: string | null;
  status: string;
  outcome_reason: string | null;
  peak_stage: string | null;
  last_contact_at: string | null;
  match: 'exact' | 'base_name' | 'possible' | 'cross_channel' | 'lead_id';
  why: string;
}

export interface WriteResult {
  result: WriteResultCode;
  lead_id?: number;
  version?: number;
  event_ids?: number[];
  matched_by?: 'lead_id' | 'item_channel_contact' | 'resolution' | 'new';
  changes?: Changes;
  snapshot?: Record<string, unknown>;
  related_contacts?: { lead_id: number; item_id: number; status: string; peak_stage: string | null }[];
  warnings?: string[];
  skipped_events?: number;
  reason?: ReviewReason | RejectReason | 'DUPLICATE_EVENTS' | 'ALREADY_VOIDED';
  message?: string;
  candidates?: LeadCandidate[];
  proposed?: { action: string; lead_id?: number; changes?: Changes };
  allowed_resolutions?: ResolutionAction[];
  retryable?: boolean;
  current_version?: number;
  replayed?: boolean;
  dry_run?: boolean;
  voided_event_ids?: number[];
}

// ── Row shapes ──────────────────────────────────────────────────────────────

export const LEAD_SNAPSHOT_COLUMNS =
  'id, user_id, inventory_item_id, lead_id, source_channel, deal_channel_id, channel_detail, contact_name, contact_key, ' +
  'lead_quality, status, outcome_reason, deal_id, offer_type, initial_cash_offer, best_cash_offer, latest_cash_offer, trade_item, ' +
  'cash_component, trade_est_value, offer_is_concrete, offer_assessment, offer_assessment_source, buyer_message_count, ' +
  'our_message_count, first_contact_at, last_contact_at, last_inbound_at, last_outbound_at, waiting_on, unanswered_followups, ' +
  'reopen_count, peak_stage, peak_stage_source, peak_stage_at, negotiation_rounds, origin, last_write_source, version, ' +
  'semantics_version, notes';

export interface LeadSnapshotRow {
  id: number; user_id: number; inventory_item_id: number; lead_id: string; source_channel: string | null; deal_channel_id: number | null;
  channel_detail: string | null; contact_name: string | null; contact_key: string | null; lead_quality: string | null; status: string;
  outcome_reason: string | null; deal_id: number | null; offer_type: OfferType; initial_cash_offer: number | null; best_cash_offer: number | null;
  latest_cash_offer: number | null; trade_item: string | null; cash_component: number | null; trade_est_value: number | null;
  offer_is_concrete: boolean | null; offer_assessment: string | null; offer_assessment_source: string | null;
  buyer_message_count: number | null; our_message_count: number | null; first_contact_at: string | null; last_contact_at: string | null;
  last_inbound_at: string | null; last_outbound_at: string | null; waiting_on: WaitingOn | null; unanswered_followups: number;
  reopen_count: number; peak_stage: DerivedSnapshot['peak_stage'] | null; peak_stage_source: StageSource | null; peak_stage_at: string | null;
  negotiation_rounds: number; origin: 'SHEET' | 'DIRECT'; last_write_source: string; version: number; semantics_version: number | null;
  notes: string | null;
}

export const LEAD_EVENT_COLUMNS =
  'id, item_lead_id, event_type, direction, occurred_at, occurred_at_precision, summary, message_count, expects_reply, payload, ' +
  'provenance, actor, source, client_label, mutation_id, mutation_seq, request_hash, content_hash, applied_changes, recorded_at, ' +
  'voided_at, void_reason';

export interface LeadEventRow extends ClassifiableEvent {
  id: number; item_lead_id: number; occurred_at_precision: 'TIME' | 'DATE'; summary: string; actor: string; source: string;
  client_label: string | null; mutation_id: string | null; mutation_seq: number | null; request_hash: string | null; content_hash: string;
  applied_changes: Record<string, unknown> | null; recorded_at: string; voided_at: string | null; void_reason: string | null;
}

/** A not-yet-inserted event as sent to apply_lead_interaction. */
interface PendingEvent extends ClassifiableEvent {
  occurred_at_precision: 'TIME' | 'DATE';
  summary: string;
  provenance: string;
  actor: 'USER' | 'AI' | 'SYSTEM';
  source: 'MCP' | 'UI' | 'SYSTEM';
  client_label: string | null;
  mutation_seq: number;
  content_hash: string;
  is_agent: boolean;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) acc[k] = canonical(val);
      return acc;
    }, {});
  }
  return v;
}
const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');

const PLACEHOLDER_NAMES = new Set([
  'unknown', 'n/a', 'na', 'none', 'someone', 'somebody', 'buyer', 'seller', 'user', 'customer', 'anonymous', 'anon', 'guy',
  'marketplace buyer', 'marketplace user', 'kijiji buyer', 'kijiji user', 'reverb buyer', 'reverb user', 'facebook user',
  'unknown buyer', 'unknown seller', 'lead', 'contact', 'me',
]);
export function isPlaceholderName(name: string | null | undefined): boolean {
  const k = name == null ? '' : normalizeContactName(name);
  return k === '' || PLACEHOLDER_NAMES.has(k);
}

function torontoOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Toronto', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** Parses an agent timestamp. YYYY-MM-DD → DATE precision (stored at 12:00Z so the Toronto date is unchanged); naive date-times are Toronto wall time. */
export function parseOccurredAt(raw: string): { iso: string; precision: 'TIME' | 'DATE' } | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T12:00:00Z`);
    return Number.isNaN(t) ? null : { iso: new Date(t).toISOString(), precision: 'DATE' };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    const guess = Date.parse(s.replace(' ', 'T') + 'Z');
    if (Number.isNaN(guess)) return null;
    const utc = guess - torontoOffsetMinutes(guess) * 60000;
    return { iso: new Date(utc).toISOString(), precision: 'TIME' };
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : { iso: new Date(t).toISOString(), precision: 'TIME' };
}

function rejected(reason: RejectReason, message: string, extra: Partial<WriteResult> = {}): WriteResult {
  return { result: 'REJECTED', reason, message, retryable: reason === 'CONCURRENT_UPDATE', ...extra };
}

function review(reason: ReviewReason, message: string, extra: Partial<WriteResult>): WriteResult {
  return { result: 'REVIEW_REQUIRED', reason, message, ...extra };
}

const SNAPSHOT_FIELDS = [
  'peak_stage', 'peak_stage_source', 'peak_stage_at', 'negotiation_rounds', 'status', 'outcome_reason', 'deal_id',
  'offer_type', 'latest_cash_offer', 'cash_component', 'trade_item', 'trade_est_value', 'offer_is_concrete',
  'offer_assessment', 'offer_assessment_source', 'initial_cash_offer', 'best_cash_offer', 'buyer_message_count',
  'our_message_count', 'first_contact_at', 'last_contact_at', 'last_inbound_at', 'last_outbound_at', 'waiting_on',
  'unanswered_followups', 'reopen_count', 'semantics_version',
] as const;
const TIMESTAMP_FIELDS = new Set(['peak_stage_at', 'last_inbound_at', 'last_outbound_at']);

function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (TIMESTAMP_FIELDS.has(field)) return Date.parse(String(a)) === Date.parse(String(b));
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return a === b;
}

function diffSnapshot(before: Partial<Record<string, unknown>>, after: DerivedSnapshot & { semantics_version: number }): Changes {
  const changes: Changes = {};
  for (const f of SNAPSHOT_FIELDS) {
    const a = before[f] ?? null;
    const b = (after as unknown as Record<string, unknown>)[f] ?? null;
    if (!sameValue(f, a, b)) changes[f] = [a, b];
  }
  return changes;
}

function snapshotSummary(s: DerivedSnapshot, version?: number): Record<string, unknown> {
  return {
    peak_stage: s.peak_stage, peak_stage_source: s.peak_stage_source, status: s.status, outcome_reason: s.outcome_reason,
    waiting_on: s.waiting_on, negotiation_rounds: s.negotiation_rounds, offer_type: s.offer_type,
    offer_summary: s.offer_type === 'CASH' ? (s.latest_cash_offer != null ? `C$${s.latest_cash_offer} cash` : 'cash') : s.trade_item,
    offer_is_concrete: s.offer_is_concrete, offer_assessment: s.offer_assessment, trade_est_value: s.trade_est_value,
    buyer_message_count: s.buyer_message_count, our_message_count: s.our_message_count, deal_id: s.deal_id,
    first_contact_at: s.first_contact_at, last_contact_at: s.last_contact_at, ...(version != null ? { version } : {}),
  };
}

// ── Baseline (LEGACY_SNAPSHOT) ──────────────────────────────────────────────

export interface LegacySnapshotPayload {
  legacy: {
    lead_quality: string | null;
    peak_stage: string | null; peak_stage_source: string | null; peak_stage_at: string | null; negotiation_rounds: number;
    status: string; outcome_reason: string | null; deal_id: number | null;
    offer: typeof EMPTY_OFFER;
    buyer_message_count: number | null; our_message_count: number | null;
    first_contact_at: string | null; last_contact_at: string | null;
    last_inbound_at: string | null; last_outbound_at: string | null; waiting_on: string | null; reopen_count: number;
    notes_sha256: string | null;
  };
}

/** The legacy-baseline payload for a lead row (used by the backfill and by the first direct write on a Sheet-maintained lead). */
export function buildLegacyPayload(row: Partial<LeadSnapshotRow> & { status: string }): LegacySnapshotPayload {
  return {
    legacy: {
      lead_quality: row.lead_quality ?? null,
      peak_stage: row.peak_stage ?? null, peak_stage_source: row.peak_stage_source ?? null, peak_stage_at: row.peak_stage_at ?? null,
      negotiation_rounds: row.negotiation_rounds ?? 0,
      status: row.status, outcome_reason: row.outcome_reason ?? null, deal_id: row.deal_id ?? null,
      offer: {
        offer_type: (row.offer_type ?? 'NONE') as OfferType,
        initial_cash_offer: row.initial_cash_offer ?? null, best_cash_offer: row.best_cash_offer ?? null,
        latest_cash_offer: row.latest_cash_offer ?? null, trade_item: row.trade_item ?? null, cash_component: row.cash_component ?? null,
        trade_est_value: row.trade_est_value ?? null, offer_is_concrete: row.offer_is_concrete ?? null,
        offer_assessment: row.offer_assessment ?? null, offer_assessment_source: row.offer_assessment_source ?? null,
      },
      buyer_message_count: row.buyer_message_count ?? null, our_message_count: row.our_message_count ?? null,
      first_contact_at: row.first_contact_at ?? null, last_contact_at: row.last_contact_at ?? null,
      last_inbound_at: row.last_inbound_at ?? null, last_outbound_at: row.last_outbound_at ?? null,
      waiting_on: row.waiting_on ?? null, reopen_count: row.reopen_count ?? 0,
      notes_sha256: row.notes ? createHash('sha256').update(row.notes).digest('hex') : null,
    },
  };
}

export function baselineFromLegacyPayload(payload: unknown): LeadBaseline {
  const l = (payload as LegacySnapshotPayload | null)?.legacy;
  if (!l) return emptyBaseline();
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    peak_stage: (l.peak_stage as LeadBaseline['peak_stage']) ?? null,
    peak_stage_source: (l.peak_stage_source as StageSource) ?? null,
    peak_stage_at: l.peak_stage_at ?? null,
    negotiation_rounds: l.negotiation_rounds ?? 0,
    status: l.status, outcome_reason: l.outcome_reason ?? null, deal_id: n(l.deal_id),
    offer: {
      ...EMPTY_OFFER, ...l.offer,
      initial_cash_offer: n(l.offer?.initial_cash_offer), best_cash_offer: n(l.offer?.best_cash_offer),
      latest_cash_offer: n(l.offer?.latest_cash_offer), cash_component: n(l.offer?.cash_component), trade_est_value: n(l.offer?.trade_est_value),
    },
    buyer_message_count: n(l.buyer_message_count), our_message_count: n(l.our_message_count),
    first_contact_at: l.first_contact_at ?? null, last_contact_at: l.last_contact_at ?? null,
    last_inbound_at: l.last_inbound_at ?? null, last_outbound_at: l.last_outbound_at ?? null,
    waiting_on: (l.waiting_on as WaitingOn) ?? null, reopen_count: l.reopen_count ?? 0,
  };
}

interface LeadState {
  row: LeadSnapshotRow;
  events: LeadEventRow[]; // all events, voided included
  baseline: LeadBaseline;
  baselineEventId: number | null;
  /** Events after the baseline, unvoided. */
  foldEvents: LeadEventRow[];
  /** True when this mutation must first record a fresh LEGACY_SNAPSHOT of the current row. */
  needsSnapshot: boolean;
}

function computeState(row: LeadSnapshotRow, events: LeadEventRow[], excludeIds: Set<number> = new Set()): LeadState {
  const live = events.filter((e) => !e.voided_at && !excludeIds.has(e.id));
  const snaps = live.filter((e) => e.event_type === 'LEGACY_SNAPSHOT').sort((a, b) => a.id - b.id);
  const latestSnap = snaps[snaps.length - 1] ?? null;
  // A Sheet-maintained lead whose latest write came from the Sheet (or that
  // has never been baselined) gets a fresh baseline of its current row.
  const needsSnapshot = row.origin === 'SHEET' && (latestSnap == null || row.last_write_source === 'SHEET');
  if (needsSnapshot) {
    return { row, events, baseline: baselineFromLegacyPayload(buildLegacyPayload(row)), baselineEventId: null, foldEvents: [], needsSnapshot };
  }
  const baseline = latestSnap ? baselineFromLegacyPayload(latestSnap.payload) : emptyBaseline();
  const foldEvents = live.filter((e) => e.event_type !== 'LEGACY_SNAPSHOT' && (latestSnap == null || e.id > latestSnap.id));
  return { row, events, baseline, baselineEventId: latestSnap?.id ?? null, foldEvents, needsSnapshot };
}

// ── Data access (RLS client) ────────────────────────────────────────────────

async function loadLead(client: SupabaseClient, leadId: number): Promise<LeadSnapshotRow | null> {
  const { data, error } = await client.from('item_leads').select(LEAD_SNAPSHOT_COLUMNS).eq('id', leadId).maybeSingle();
  if (error) throw new Error(`item_leads: ${error.message}`);
  return (data as unknown as LeadSnapshotRow) ?? null;
}

export async function loadLeadEvents(client: SupabaseClient, leadIds: number[]): Promise<LeadEventRow[]> {
  if (leadIds.length === 0) return [];
  const out: LeadEventRow[] = [];
  for (let i = 0; i < leadIds.length; i += 150) {
    const { data, error } = await client.from('lead_events').select(LEAD_EVENT_COLUMNS)
      .in('item_lead_id', leadIds.slice(i, i + 150)).order('occurred_at', { ascending: true }).order('id', { ascending: true });
    if (error) throw new Error(`lead_events: ${error.message}`);
    out.push(...((data ?? []) as unknown as LeadEventRow[]));
  }
  return out;
}

// ── Event validation / normalization ───────────────────────────────────────

function validatePayload(e: AgentEventInput): string | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const bool = (k: string) => p[k] === undefined || typeof p[k] === 'boolean';
  const numNonNeg = (k: string) => p[k] === undefined || p[k] === null || (typeof p[k] === 'number' && (p[k] as number) >= 0);
  const assessmentOk = p.assessment === undefined || p.assessment === null || (OFFER_ASSESSMENTS as readonly string[]).includes(p.assessment as string);
  const assessmentSourceOk = p.assessment_source === undefined || p.assessment_source === 'USER' || p.assessment_source === 'AI';
  switch (e.type) {
    case 'MESSAGE':
      if (e.direction === 'INTERNAL') return 'MESSAGE must be INBOUND or OUTBOUND';
      if (p.substance !== undefined && p.substance !== 'BASIC' && p.substance !== 'SUBSTANTIVE') return 'MESSAGE.substance must be BASIC or SUBSTANTIVE';
      if (!bool('follow_up') || !bool('responds_to_offer')) return 'MESSAGE.follow_up / responds_to_offer must be booleans';
      if (p.evidence !== undefined && (!Array.isArray(p.evidence) || p.evidence.some((x) => !(EVIDENCE_KINDS as readonly string[]).includes(x as string)))) return `MESSAGE.evidence must be a subset of ${EVIDENCE_KINDS.join('/')}`;
      return null;
    case 'OFFER': {
      if (e.direction === 'INTERNAL') return 'OFFER must be INBOUND (buyer offer) or OUTBOUND (our ask/counter)';
      const err = offerError(p.offer);
      if (err) return err;
      if (!bool('ready_to_execute')) return 'OFFER.ready_to_execute must be boolean';
      if (!assessmentOk || !assessmentSourceOk) return `OFFER.assessment must be one of ${OFFER_ASSESSMENTS.join('/')} (assessment_source USER|AI)`;
      if (!numNonNeg('our_estimate')) return 'OFFER.our_estimate must be a non-negative number';
      if (e.direction === 'OUTBOUND' && (p.assessment != null || p.our_estimate != null)) return 'assessment/our_estimate describe the BUYER offer — use them on INBOUND offers or a NOTE';
      return null;
    }
    case 'AGREEMENT':
      if (p.terms !== undefined && offerError(p.terms)) return `AGREEMENT.terms: ${offerError(p.terms)}`;
      return null;
    case 'LOGISTICS':
      if (!(LOGISTICS_KINDS as readonly string[]).includes(p.kind as string)) return `LOGISTICS.kind must be one of ${LOGISTICS_KINDS.join('/')}`;
      if (!(LOGISTICS_STATES as readonly string[]).includes(p.state as string)) return `LOGISTICS.state must be one of ${LOGISTICS_STATES.join('/')}`;
      if (!bool('at_asking_price')) return 'LOGISTICS.at_asking_price must be boolean';
      if (p.scheduled_for !== undefined && p.scheduled_for !== null && (typeof p.scheduled_for !== 'string' || !parseOccurredAt(p.scheduled_for))) return 'LOGISTICS.scheduled_for must be an ISO date/time';
      return null;
    case 'STATUS_CHANGE':
      if (e.direction !== 'INTERNAL') return 'STATUS_CHANGE must be INTERNAL';
      if (!(LEAD_STATUSES as readonly string[]).includes(p.to as string)) return `STATUS_CHANGE.to must be one of ${LEAD_STATUSES.join('/')}`;
      if (p.outcome_reason != null && !(OUTCOME_REASONS as readonly string[]).includes(p.outcome_reason as string)) return 'STATUS_CHANGE.outcome_reason is not a recognized value';
      if (!outcomeAllowedFor(p.to as LeadStatusValue, (p.outcome_reason ?? null) as OutcomeReasonValue | null)) return `outcome_reason ${p.outcome_reason ?? 'null'} is not valid for status ${p.to}`;
      return null;
    case 'DEAL_LINKED':
      if (e.direction !== 'INTERNAL') return 'DEAL_LINKED must be INTERNAL';
      if (!Number.isInteger(p.deal_id) || (p.deal_id as number) <= 0) return 'DEAL_LINKED.deal_id must be a positive integer';
      return null;
    case 'NOTE':
      if (e.direction !== 'INTERNAL') return 'NOTE must be INTERNAL';
      if (p.topic !== undefined && !(NOTE_TOPICS as readonly string[]).includes(p.topic as string)) return `NOTE.topic must be one of ${NOTE_TOPICS.join('/')}`;
      if (!numNonNeg('our_estimate') || !assessmentOk || !assessmentSourceOk) return 'NOTE.our_estimate / assessment invalid';
      return null;
    default:
      return `event type ${(e as { type: string }).type} cannot be submitted`;
  }
}

function defaultExpectsReply(e: AgentEventInput): boolean {
  if (e.direction === 'INTERNAL') return false;
  return e.type === 'MESSAGE' || e.type === 'OFFER';
}

function contentHash(e: Pick<PendingEvent, 'event_type' | 'direction' | 'occurred_at' | 'occurred_at_precision' | 'message_count' | 'payload' | 'summary'>): string {
  return sha256([e.event_type, e.direction, new Date(e.occurred_at).toISOString(), e.occurred_at_precision, e.message_count, e.payload, normalizeContactName(e.summary)]);
}

interface NormalizedInput {
  events: Omit<PendingEvent, 'mutation_seq'>[];
  requestHash: string;
}

function normalizeInput(input: RecordLeadInteractionInput, ctx: WriteContext): NormalizedInput | WriteResult {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.mutation_id ?? '')) return rejected('VALIDATION_ERROR', 'mutation_id must be a UUID');
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 10) return rejected('VALIDATION_ERROR', 'events must contain 1-10 events');
  const now = (ctx.now ?? new Date()).getTime();
  const events: Omit<PendingEvent, 'mutation_seq'>[] = [];
  for (let i = 0; i < input.events.length; i++) {
    const e = input.events[i];
    const err = validatePayload(e);
    if (err) return rejected('VALIDATION_ERROR', `events[${i}]: ${err}`);
    const t = parseOccurredAt(e.occurred_at ?? '');
    if (!t) return rejected('VALIDATION_ERROR', `events[${i}].occurred_at is not a valid date or date-time`);
    if (Date.parse(t.iso) > now + 36 * 3600 * 1000) return rejected('VALIDATION_ERROR', `events[${i}].occurred_at is in the future`);
    const summary = (e.summary ?? '').trim();
    if (summary.length < 1 || summary.length > 1000) return rejected('VALIDATION_ERROR', `events[${i}].summary must be 1-1000 characters`);
    const messageCount = e.direction === 'INTERNAL' ? 0 : (e.message_count ?? 1);
    if (!Number.isInteger(messageCount) || messageCount < 0 || messageCount > 50) return rejected('VALIDATION_ERROR', `events[${i}].message_count must be 0-50`);
    if (e.direction === 'INTERNAL' && e.expects_reply) return rejected('VALIDATION_ERROR', `events[${i}]: INTERNAL events cannot expect a reply`);
    const payload = { ...(e.payload ?? {}) };
    if (e.type === 'MESSAGE' && payload.substance === undefined) payload.substance = 'BASIC';
    if (e.type === 'OFFER') {
      const o = payload.offer as OfferPayload;
      payload.offer = { cash_terms: o.cash_terms, cash_amount: o.cash_amount ?? null, items: (o.items ?? []).map((it) => ({ description: it.description.trim(), ...(it.est_value != null ? { est_value: it.est_value } : {}) })), summary: o.summary?.trim() || offerShape(o).summary };
    }
    const ev = {
      event_type: e.type, direction: e.direction, occurred_at: t.iso, occurred_at_precision: t.precision, summary,
      message_count: messageCount, expects_reply: e.expects_reply ?? defaultExpectsReply(e), payload,
      provenance: e.provenance ?? 'OBSERVED', actor: (e.provenance === 'STATED' ? 'USER' : 'AI') as 'USER' | 'AI', source: ctx.source ?? 'MCP',
      client_label: ctx.clientLabel?.slice(0, 64) ?? null, is_agent: true, content_hash: '',
    };
    ev.content_hash = contentHash(ev);
    events.push(ev);
  }
  const requestHash = sha256({
    lead: { ...input.lead, contact_name: input.lead.contact_name?.trim(), channel_detail: input.lead.channel_detail?.trim() },
    events: events.map((e) => [e.event_type, e.direction, e.occurred_at, e.occurred_at_precision, e.summary, e.message_count, e.expects_reply, e.provenance, e.payload]),
  });
  return { events, requestHash };
}

// ── Matching ────────────────────────────────────────────────────────────────

interface CandidateRow {
  id: number; inventory_item_id: number; source_channel: string | null; channel_detail: string | null; contact_name: string | null;
  contact_key: string | null; status: string; outcome_reason: string | null; peak_stage: string | null; last_contact_at: string | null;
  deal_id: number | null; last_inbound_at: string | null; last_outbound_at: string | null;
}
const CANDIDATE_COLUMNS = 'id, inventory_item_id, source_channel, channel_detail, contact_name, contact_key, status, outcome_reason, peak_stage, last_contact_at, deal_id, last_inbound_at, last_outbound_at';

function candidate(r: CandidateRow, match: LeadCandidate['match'], why: string): LeadCandidate {
  return { lead_id: r.id, item_id: r.inventory_item_id, channel: r.source_channel, channel_detail: r.channel_detail, contact_name: r.contact_name, status: r.status, outcome_reason: r.outcome_reason, peak_stage: r.peak_stage, last_contact_at: r.last_contact_at, match, why };
}

type Resolution =
  | { kind: 'existing'; leadId: number; matchedBy: 'lead_id' | 'item_channel_contact' | 'resolution'; allowFinal: boolean; confirm: boolean }
  | { kind: 'create'; forceNew: boolean; unnamed: boolean };

interface ResolveContext {
  itemId: number | null;
  sourceChannel: string | null;
  dealChannelId: number | null;
  channelDetail: string | null;
  contactName: string | null;
  key: string | null;
  related: WriteResult['related_contacts'];
}

async function resolveChannel(client: SupabaseClient, channel: LeadChannel | undefined, detail: string | undefined): Promise<{ sourceChannel: string; dealChannelId: number | null; channelDetail: string | null } | WriteResult> {
  if (!channel) return rejected('VALIDATION_ERROR', 'lead.channel is required for a lead without lead_id');
  const d = detail?.trim() || null;
  if (d && !DETAIL_CHANNELS.includes(channel)) return rejected('VALIDATION_ERROR', `channel_detail is only allowed with ${DETAIL_CHANNELS.join(' / ')}`);
  if (d && d.length > 80) return rejected('VALIDATION_ERROR', 'channel_detail must be at most 80 characters');
  const dbName = CHANNEL_DB_NAME[channel];
  if (!dbName) return rejected('INVALID_CHANNEL', `unknown channel ${channel}`);
  if (channel === 'Other') return { sourceChannel: 'Other', dealChannelId: null, channelDetail: d };
  const { data, error } = await client.from('deal_channels').select('id, name');
  if (error) throw new Error(`deal_channels: ${error.message}`);
  const row = (data ?? []).find((c) => String(c.name).toLowerCase() === dbName.toLowerCase());
  if (!row) return rejected('INVALID_CHANNEL', `channel ${channel} is not configured`);
  return { sourceChannel: row.name as string, dealChannelId: row.id as number, channelDetail: d };
}

async function resolveLead(client: SupabaseClient, input: RecordLeadInteractionInput): Promise<{ resolution: Resolution; rc: ResolveContext } | WriteResult> {
  const res = input.resolution;
  const rawName = input.lead.contact_name?.trim() || null;
  const name = rawName && !isPlaceholderName(rawName) ? rawName : null;
  const key = contactKey(name);

  // ── Explicit lead_id ─────────────────────────────────────────────────
  if ((res?.action === 'CREATE_NEW' || res?.action === 'CREATE_UNNAMED') && input.lead.lead_id != null) {
    const { data: src, error: srcError } = await client.from('item_leads').select(CANDIDATE_COLUMNS).eq('id', input.lead.lead_id).maybeSingle();
    if (srcError) throw new Error(`item_leads: ${srcError.message}`);
    const s0 = src as unknown as CandidateRow | null;
    if (!s0) return rejected('LEAD_NOT_FOUND', `Lead ${input.lead.lead_id} not found.`);
    const channelName = (Object.keys(CHANNEL_DB_NAME) as LeadChannel[]).find((c) => CHANNEL_DB_NAME[c].toLowerCase() === (s0.source_channel ?? 'Other').toLowerCase()) ?? 'Other';
    return resolveLead(client, { ...input, lead: { item_id: input.lead.item_id ?? s0.inventory_item_id, channel: input.lead.channel ?? channelName, channel_detail: input.lead.channel_detail ?? s0.channel_detail ?? undefined, contact_name: input.lead.contact_name ?? s0.contact_name ?? undefined } });
  }
  const explicitId = input.lead.lead_id ?? (res?.action === 'USE_LEAD' ? res.lead_id : undefined);
  if (explicitId != null) {
    const { data, error } = await client.from('item_leads').select(CANDIDATE_COLUMNS).eq('id', explicitId).maybeSingle();
    if (error) throw new Error(`item_leads: ${error.message}`);
    const lead = data as unknown as CandidateRow | null;
    if (!lead) return rejected('LEAD_NOT_FOUND', `Lead ${explicitId} not found.`);
    const rc: ResolveContext = { itemId: lead.inventory_item_id, sourceChannel: lead.source_channel, dealChannelId: null, channelDetail: lead.channel_detail, contactName: name, key, related: [] };
    const viaResolution = res?.action === 'USE_LEAD' && res.lead_id === explicitId;
    if (!viaResolution) {
      const allowed: ResolutionAction[] = ['USE_LEAD'];
      if (input.lead.item_id != null && input.lead.item_id !== lead.inventory_item_id) {
        return review('ITEM_MISMATCH', `Lead ${lead.id} belongs to item ${lead.inventory_item_id}, not item ${input.lead.item_id}.`, { candidates: [candidate(lead, 'lead_id', 'lead_id supplied')], allowed_resolutions: allowed });
      }
      if (key && lead.contact_key && key !== lead.contact_key) {
        return review('CONTACT_MISMATCH', `Lead ${lead.id} is "${lead.contact_name}", not "${name}".`, { candidates: [candidate(lead, 'lead_id', 'lead_id supplied')], allowed_resolutions: allowed });
      }
      if (input.lead.channel) {
        const ch = await resolveChannel(client, input.lead.channel, input.lead.channel_detail);
        if ('result' in ch) return ch;
        if (channelKey(ch.sourceChannel, ch.channelDetail) !== channelKey(lead.source_channel, lead.channel_detail)) {
          return review('CHANNEL_MISMATCH', `Lead ${lead.id} is on ${lead.source_channel}${lead.channel_detail ? ' / ' + lead.channel_detail : ''}, not ${ch.sourceChannel}${ch.channelDetail ? ' / ' + ch.channelDetail : ''}.`, { candidates: [candidate(lead, 'lead_id', 'lead_id supplied')], allowed_resolutions: allowed });
        }
      }
    }
    return { resolution: { kind: 'existing', leadId: lead.id, matchedBy: viaResolution ? 'resolution' : 'lead_id', allowFinal: viaResolution || res?.action === 'CONFIRM', confirm: res?.action === 'CONFIRM' }, rc };
  }

  // ── Match by item + channel + contact ────────────────────────────────
  if (input.lead.item_id == null) return rejected('VALIDATION_ERROR', 'lead.item_id (or lead.lead_id) is required');
  const { data: itemRow, error: itemError } = await client.from('inventory_items').select('id, status').eq('id', input.lead.item_id).maybeSingle();
  if (itemError) throw new Error(`inventory_items: ${itemError.message}`);
  if (!itemRow) return rejected('ITEM_NOT_FOUND', `Inventory item ${input.lead.item_id} not found.`);
  const ch = await resolveChannel(client, input.lead.channel, input.lead.channel_detail);
  if ('result' in ch) return ch;

  const rc: ResolveContext = { itemId: input.lead.item_id, sourceChannel: ch.sourceChannel, dealChannelId: ch.dealChannelId, channelDetail: ch.channelDetail, contactName: name, key, related: [] };

  if (key) {
    const { data: relRows, error: relError } = await client.from('item_leads').select('id, inventory_item_id, status, peak_stage').eq('contact_key', key).neq('inventory_item_id', input.lead.item_id).limit(5);
    if (relError) throw new Error(`item_leads (related): ${relError.message}`);
    rc.related = ((relRows ?? []) as { id: number; inventory_item_id: number; status: string; peak_stage: string | null }[]).map((r) => ({ lead_id: r.id, item_id: r.inventory_item_id, status: r.status, peak_stage: r.peak_stage }));
  }

  if (res?.action === 'CREATE_UNNAMED') return { resolution: { kind: 'create', forceNew: true, unnamed: true }, rc };
  if (!name) {
    return review('CONTACT_NAME_MISSING', rawName ? `"${rawName}" is a placeholder, not a contact name.` : 'No contact name was provided for a new lead.', {
      proposed: { action: 'CREATE_UNNAMED' }, allowed_resolutions: ['CREATE_UNNAMED'],
    });
  }
  if (res?.action === 'CREATE_NEW') return { resolution: { kind: 'create', forceNew: true, unnamed: false }, rc };

  const { data: itemLeads, error: leadsError } = await client.from('item_leads').select(CANDIDATE_COLUMNS).eq('inventory_item_id', input.lead.item_id);
  if (leadsError) throw new Error(`item_leads: ${leadsError.message}`);
  const leads = (itemLeads ?? []) as unknown as CandidateRow[];
  const myChannel = channelKey(ch.sourceChannel, ch.channelDetail);
  const myBase = baseKey(name)!;
  const myNorm = normalizeContactName(name);

  const exact = leads.filter((l) => l.contact_key === key && channelKey(l.source_channel, l.channel_detail) === myChannel);
  if (exact.length > 1) {
    return review('MULTIPLE_CONTACT_MATCHES', `${exact.length} existing leads on this item/channel are recorded for "${name}".`, {
      candidates: exact.map((l) => candidate(l, 'exact', 'same item, channel and contact')), allowed_resolutions: ['USE_LEAD', 'CREATE_NEW'],
    });
  }
  if (exact.length === 1) {
    const l = exact[0];
    const confirmed = res?.action === 'CONFIRM';
    if (!confirmed && isFinal(l.status, l.outcome_reason)) {
      return review('EVENT_ON_FINAL_LEAD', `The matching lead ${l.id} is ${l.status}${l.outcome_reason ? '/' + l.outcome_reason : ''}. Is this the same relationship (append) or a new episode?`, {
        candidates: [candidate(l, 'exact', 'same item, channel and contact')], allowed_resolutions: ['USE_LEAD', 'CREATE_NEW'],
      });
    }
    const lastActivity = [l.last_contact_at, l.last_inbound_at, l.last_outbound_at].filter((x): x is string => !!x).map((x) => Date.parse(x.length === 10 ? x + 'T12:00:00Z' : x)).sort().pop();
    const single = !myNorm.includes(' ') && !hasQualifier(name);
    if (!confirmed && single && isReopenable(l.status, l.outcome_reason) && lastActivity != null && Date.now() - lastActivity > 14 * 86_400_000) {
      return review('POSSIBLE_DIFFERENT_PERSON', `"${name}" is a first name only and the earlier lead ${l.id} (${l.status}) has been inactive for over two weeks — it may be a different person.`, {
        candidates: [candidate(l, 'exact', 'same first name, item and channel')], allowed_resolutions: ['USE_LEAD', 'CREATE_NEW'],
      });
    }
    return { resolution: { kind: 'existing', leadId: l.id, matchedBy: 'item_channel_contact', allowFinal: confirmed, confirm: confirmed }, rc };
  }

  // No exact match: anything plausible requires the user's decision.
  const cands: LeadCandidate[] = [];
  for (const l of leads) {
    if (!l.contact_key) continue;
    const sameChannel = channelKey(l.source_channel, l.channel_detail) === myChannel;
    if (sameChannel) {
      const otherBase = baseKey(l.contact_name);
      const bothQualified = hasQualifier(name) && hasQualifier(l.contact_name);
      if (otherBase === myBase && !bothQualified) { cands.push(candidate(l, 'base_name', 'same name, one side has a qualifier')); continue; }
      const pm = possibleNameMatch(myNorm, normalizeContactName(l.contact_name ?? '')) ?? possibleNameMatch(normalizeContactName(l.contact_name ?? ''), myNorm);
      if (pm && !bothQualified) cands.push(candidate(l, 'possible', pm.reason));
    } else if (l.contact_key === key) {
      cands.push(candidate(l, 'cross_channel', baseChannelKey(l.source_channel) === baseChannelKey(ch.sourceChannel) ? 'same contact, different channel detail' : 'same contact on another channel'));
    }
  }
  if (cands.length > 0) {
    const crossOnly = cands.every((c) => c.match === 'cross_channel');
    return review(crossOnly ? 'CROSS_CHANNEL_MATCH' : 'POSSIBLE_DUPLICATE',
      crossOnly ? `"${name}" already has a lead on this item through a different channel.` : `"${name}" may already have a lead on this item.`,
      { candidates: cands, proposed: { action: 'CREATE_NEW' }, allowed_resolutions: ['USE_LEAD', 'CREATE_NEW'] });
  }
  return { resolution: { kind: 'create', forceNew: false, unnamed: false }, rc };
}

// ── Planning (pure given loaded state) ─────────────────────────────────────

interface Plan {
  pending: PendingEvent[];
  agentEventCount: number;
  skippedDuplicates: number;
  snapshot: DerivedSnapshot & { semantics_version: number };
  changes: Changes;
  warnings: string[];
}

async function validateDeal(client: SupabaseClient, dealId: number, itemId: number): Promise<boolean> {
  const { data: deal, error } = await client.from('deals').select('id, deal_type').eq('id', dealId).maybeSingle();
  if (error) throw new Error(`deals: ${error.message}`);
  if (!deal || !['sale', 'trade'].includes(deal.deal_type as string)) return false;
  const { data: items, error: itemsError } = await client.from('deal_items').select('id').eq('deal_id', dealId).eq('item_id', itemId).eq('direction', 'out');
  if (itemsError) throw new Error(`deal_items: ${itemsError.message}`);
  return (items ?? []).length > 0;
}

async function plan(
  client: SupabaseClient,
  state: LeadState | null,
  itemId: number,
  normalized: NormalizedInput,
  resolution: Resolution,
  ctx: WriteContext,
): Promise<Plan | WriteResult> {
  const now = ctx.now ?? new Date();
  const confirm = resolution.kind === 'existing' && resolution.confirm;
  const allowFinal = resolution.kind === 'existing' && resolution.allowFinal;
  const baseline = state?.baseline ?? emptyBaseline();
  const existingFold: ClassifiableEvent[] = state?.foldEvents ?? [];
  const warnings: string[] = [];

  // Dedupe against the lead's live events (content fingerprint) and within the request.
  const seen = new Set((state?.events ?? []).filter((e) => !e.voided_at).map((e) => e.content_hash));
  const agentEvents: Omit<PendingEvent, 'mutation_seq'>[] = [];
  let skipped = 0;
  for (const e of normalized.events) {
    if (seen.has(e.content_hash)) { skipped++; continue; }
    seen.add(e.content_hash);
    agentEvents.push(e);
  }
  if (agentEvents.length === 0) return { result: 'NO_CHANGE', lead_id: state?.row.id, reason: 'DUPLICATE_EVENTS', skipped_events: skipped, message: 'Every submitted event is already recorded on this lead.' };
  if (skipped > 0) warnings.push(`DUPLICATE_EVENTS_SKIPPED:${skipped}`);

  // Build the ordered pending list, synthesizing system events.
  const sys = (base: Omit<PendingEvent, 'mutation_seq' | 'content_hash' | 'is_agent' | 'provenance' | 'actor' | 'source' | 'client_label' | 'message_count' | 'expects_reply' | 'occurred_at_precision'>): Omit<PendingEvent, 'mutation_seq'> => {
    const e = { ...base, message_count: 0, expects_reply: false, occurred_at_precision: 'TIME' as const, provenance: 'SYSTEM', actor: 'SYSTEM' as const, source: 'SYSTEM' as const, client_label: null, is_agent: false, content_hash: '' };
    e.content_hash = contentHash(e) + ':' + normalized.requestHash.slice(0, 12);
    return e;
  };

  const out: Omit<PendingEvent, 'mutation_seq'>[] = [];
  if (state?.needsSnapshot) {
    out.push(sys({ event_type: 'LEGACY_SNAPSHOT', direction: 'INTERNAL', occurred_at: now.toISOString(), summary: 'Baseline of the Lead Log state before direct logging', payload: buildLegacyPayload(state.row) as unknown as Record<string, unknown> }));
  }

  let status = (state?.row.status ?? 'OPEN') as string;
  let outcome = state?.row.outcome_reason ?? null;
  let dealId = state?.row.deal_id ?? null;
  const priorForGhost: ClassifiableEvent[] = [...existingFold];
  const sortedAgent = sortEvents(agentEvents.map((e, i) => ({ ...e, mutation_seq: i }))) as (Omit<PendingEvent, 'mutation_seq'> & { mutation_seq: number })[];

  for (const e of sortedAgent) {
    const conversational = isConversational(e);
    // Returning buyer on a final lead: only with explicit confirmation; no automatic reopen.
    if (conversational && e.direction === 'INBOUND' && isFinal(status, outcome) && !allowFinal) {
      return review('EVENT_ON_FINAL_LEAD', `Lead ${state?.row.id} is ${status}${outcome ? '/' + outcome : ''}; new buyer activity needs confirmation.`, { lead_id: state?.row.id, allowed_resolutions: ['CONFIRM', 'CREATE_NEW'] });
    }
    // Returning buyer reopens a declined / ghosted / inactive lead.
    if (conversational && e.direction === 'INBOUND' && isReopenable(status, outcome)) {
      out.push(sys({ event_type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: e.occurred_at, summary: `Buyer returned — reopened from ${status}`, payload: { from: status, from_outcome: outcome, to: 'OPEN', trigger: 'AUTO_REOPEN' } }));
      status = 'OPEN'; outcome = null;
    }
    if (e.event_type === 'AGREEMENT' && isTerminal(status) && !confirm) {
      return review('CONTRADICTION', `An agreement was recorded on a ${status} lead.`, { lead_id: state?.row.id, allowed_resolutions: ['CONFIRM'] });
    }
    if (e.event_type === 'STATUS_CHANGE') {
      const p = e.payload as { to: LeadStatusValue; outcome_reason?: OutcomeReasonValue | null };
      if (p.to === 'COMPLETED' && dealId == null) return rejected('DEAL_REQUIRED', 'COMPLETED requires a linked deal: add a DEAL_LINKED event with the Guitar Tracker deal (operation) id.');
      if ((status === 'COMPLETED' && p.to !== 'COMPLETED') || (status === 'AGREED' && p.to === 'OPEN')) {
        if (!confirm) return review('DESTRUCTIVE_TRANSITION', `Changing ${status} → ${p.to} needs confirmation.`, { lead_id: state?.row.id, allowed_resolutions: ['CONFIRM'] });
      }
      if (p.to === 'GHOSTED' && !confirm && !ghostPreconditionsMet(priorForGhost)) {
        return review('GHOST_PRECONDITIONS_UNMET', 'GHOSTED requires our pending ask (a counter/question/logistics expecting a reply) plus an unanswered follow-up or a missed committed step. Confirm only if the user explicitly wants it marked ghosted.', { lead_id: state?.row.id, allowed_resolutions: ['CONFIRM'] });
      }
      e.payload = { ...e.payload, from: status, from_outcome: outcome, trigger: 'USER' };
      status = p.to; outcome = p.outcome_reason ?? null;
      out.push(e);
      priorForGhost.push(e);
      continue;
    }
    if (e.event_type === 'DEAL_LINKED') {
      const d = (e.payload as { deal_id: number }).deal_id;
      if (dealId != null && dealId !== d) return review('DEAL_LINK_CONFLICT', `Lead ${state?.row.id} is already linked to deal ${dealId}.`, { lead_id: state?.row.id, allowed_resolutions: ['CONFIRM'] });
      if (!(await validateDeal(client, d, itemId))) return rejected('DEAL_NOT_VALID', `Deal ${d} is not a completed sale/trade with this item on its outgoing side.`);
      const { data: others, error: othersError } = await client.from('item_leads').select('id, deal_id').eq('inventory_item_id', itemId).not('deal_id', 'is', null);
      if (othersError) throw new Error(`item_leads (deal links): ${othersError.message}`);
      const holder = (others ?? []).find((o) => o.id !== state?.row.id);
      if (holder) return review('DEAL_LINK_CONFLICT', `Lead ${holder.id} already holds this item's completed-deal link.`, { lead_id: state?.row.id, allowed_resolutions: [] });
      out.push(e);
      priorForGhost.push(e);
      if (status !== 'COMPLETED') {
        out.push(sys({ event_type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: e.occurred_at, summary: `Deal ${d} linked — completed`, payload: { from: status, from_outcome: outcome, to: 'COMPLETED', trigger: 'AUTO_FROM_EVENT', cause: 'DEAL_LINKED' } }));
        status = 'COMPLETED'; outcome = null;
      }
      dealId = d;
      continue;
    }
    out.push(e);
    priorForGhost.push(e);
    if (e.event_type === 'AGREEMENT' && status === 'OPEN') {
      out.push(sys({ event_type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: e.occurred_at, summary: 'Terms accepted — agreed', payload: { from: 'OPEN', from_outcome: null, to: 'AGREED', trigger: 'AUTO_FROM_EVENT', cause: 'AGREEMENT' } }));
      status = 'AGREED';
    }
    if (e.event_type === 'OFFER' && e.direction === 'INBOUND' && (e.payload as { ready_to_execute?: boolean }).ready_to_execute) warnings.push('READY_TO_EXECUTE');
  }

  const pending: PendingEvent[] = out.map((e, i) => ({ ...e, mutation_seq: i }));
  const foldAll: ClassifiableEvent[] = [...existingFold, ...pending.filter((e) => e.event_type !== 'LEGACY_SNAPSHOT')];
  const derived = deriveSnapshot(baseline, foldAll);
  const snapshot = { ...derived, semantics_version: SEMANTICS_VERSION };
  const before: Partial<Record<string, unknown>> = state ? (state.row as unknown as Record<string, unknown>) : { status: 'OPEN', offer_type: 'NONE', negotiation_rounds: 0, unanswered_followups: 0, reopen_count: 0 };
  const changes = diffSnapshot(before, snapshot);
  if (snapshot.status === 'AGREED' && state && ['sold', 'traded'].includes((await itemStatus(client, itemId)) ?? '')) warnings.push('ITEM_UNAVAILABLE_WHILE_AGREED');
  return { pending, agentEventCount: agentEvents.length, skippedDuplicates: skipped, snapshot, changes, warnings };
}

async function itemStatus(client: SupabaseClient, itemId: number): Promise<string | null> {
  const { data } = await client.from('inventory_items').select('status').eq('id', itemId).maybeSingle();
  return (data?.status as string) ?? null;
}

// ── RPC ─────────────────────────────────────────────────────────────────────

interface RpcOk { status: 'OK'; lead_id: number; version: number; event_ids: number[] }
type RpcResult = RpcOk | { status: 'REPLAY'; lead_id: number; result?: WriteResult; request_hash?: string; event_ids?: number[] } | { status: 'CONFLICT'; reason: string; current_version?: number } | { status: 'NOT_FOUND' };

class RpcRejection extends Error { constructor(public reason: RejectReason, message: string) { super(message); } }

async function callRpc(client: SupabaseClient, request: Record<string, unknown>): Promise<RpcResult> {
  const { data, error } = await client.rpc('apply_lead_interaction', { p_request: request });
  if (error) {
    const m = error.message ?? '';
    for (const code of ['NOT_AUTHENTICATED', 'ITEM_NOT_FOUND', 'INVALID_CHANNEL', 'DEAL_NOT_VALID', 'EVENT_NOT_FOUND', 'VALIDATION_ERROR'] as const) {
      if (m.includes(code)) throw new RpcRejection(code, m);
    }
    if (m.includes('PEAK_STAGE_REGRESSION')) throw new RpcRejection('CONCURRENT_UPDATE', m);
    throw new Error(`apply_lead_interaction: ${m}`);
  }
  return data as RpcResult;
}

function pendingForRpc(e: PendingEvent) {
  return {
    event_type: e.event_type, direction: e.direction, occurred_at: e.occurred_at, occurred_at_precision: e.occurred_at_precision,
    summary: e.summary, message_count: e.message_count, expects_reply: e.expects_reply, payload: e.payload, provenance: e.provenance,
    actor: e.actor, source: e.source, client_label: e.client_label, mutation_seq: e.mutation_seq, content_hash: e.content_hash,
  };
}

function snapshotForRpc(s: DerivedSnapshot & { semantics_version: number }) {
  const out: Record<string, unknown> = {};
  for (const f of SNAPSHOT_FIELDS) out[f] = (s as unknown as Record<string, unknown>)[f] ?? null;
  return out;
}

// ── record_lead_interaction ─────────────────────────────────────────────────

async function replayCheck(client: SupabaseClient, mutationId: string, requestHash: string): Promise<WriteResult | null> {
  const { data, error } = await client.from('lead_events').select('id, item_lead_id, mutation_seq, request_hash, applied_changes')
    .eq('mutation_id', mutationId).order('mutation_seq', { ascending: true });
  if (error) throw new Error(`lead_events (replay): ${error.message}`);
  const rows = (data ?? []) as { id: number; item_lead_id: number; mutation_seq: number; request_hash: string | null; applied_changes: WriteResult | null }[];
  if (rows.length === 0) return null;
  if (rows[0].request_hash !== requestHash) return rejected('MUTATION_ID_REUSED', 'This mutation_id was already used for a different request. Generate a new mutation_id for a new interaction.');
  return { ...(rows[0].applied_changes ?? { result: 'APPLIED_UPDATE' }), lead_id: rows[0].item_lead_id, event_ids: rows.map((r) => r.id), replayed: true };
}

export async function recordLeadInteraction(client: SupabaseClient, input: RecordLeadInteractionInput, ctx: WriteContext = {}): Promise<WriteResult> {
  const normalized = normalizeInput(input, ctx);
  if ('result' in normalized) return normalized;

  const replay = await replayCheck(client, input.mutation_id, normalized.requestHash);
  if (replay) return replay;

  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await resolveLead(client, input);
    if ('result' in resolved) return resolved;
    const { resolution, rc } = resolved;

    let state: LeadState | null = null;
    if (resolution.kind === 'existing') {
      const row = await loadLead(client, resolution.leadId);
      if (!row) return rejected('LEAD_NOT_FOUND', `Lead ${resolution.leadId} not found.`);
      state = computeState(row, await loadLeadEvents(client, [row.id]));
      rc.itemId = row.inventory_item_id;
    }

    const p = await plan(client, state, rc.itemId!, normalized, resolution, ctx);
    if ('result' in p) return p;

    const isCreate = resolution.kind === 'create';
    const matchedBy = isCreate ? 'new' : resolution.matchedBy;
    const resultCode: WriteResultCode = isCreate ? 'APPLIED_CREATE' : 'APPLIED_UPDATE';
    const storedResult: WriteResult = {
      result: resultCode, matched_by: matchedBy, changes: p.changes, snapshot: snapshotSummary(p.snapshot),
      ...(p.warnings.length ? { warnings: p.warnings } : {}), ...(rc.related && rc.related.length ? { related_contacts: rc.related } : {}),
    };

    if (input.dry_run) return { ...storedResult, lead_id: state?.row.id, dry_run: true };

    const request: Record<string, unknown> = {
      mode: isCreate ? 'create' : 'update',
      mutation_id: input.mutation_id,
      request_hash: normalized.requestHash,
      lead_id: state?.row.id ?? null,
      expected_version: state?.row.version ?? null,
      force_new: isCreate ? resolution.forceNew : false,
      lead: {
        inventory_item_id: rc.itemId, source_channel: rc.sourceChannel, deal_channel_id: rc.dealChannelId, channel_detail: rc.channelDetail,
        contact_name: isCreate && resolution.unnamed ? null : rc.contactName, contact_key: isCreate && resolution.unnamed ? null : rc.key,
      },
      snapshot: snapshotForRpc(p.snapshot),
      events: p.pending.map(pendingForRpc),
      result: storedResult,
    };

    let rpc: RpcResult;
    try {
      rpc = await callRpc(client, request);
    } catch (e) {
      if (e instanceof RpcRejection) {
        if (e.reason === 'CONCURRENT_UPDATE' && attempt === 0) continue;
        return rejected(e.reason, e.message);
      }
      throw e;
    }
    if (rpc.status === 'OK') {
      return { ...storedResult, lead_id: rpc.lead_id, version: rpc.version, event_ids: rpc.event_ids, snapshot: { ...storedResult.snapshot, version: rpc.version } };
    }
    if (rpc.status === 'REPLAY') {
      if (rpc.request_hash && rpc.request_hash !== normalized.requestHash) return rejected('MUTATION_ID_REUSED', 'This mutation_id was already used for a different request.');
      return { ...(rpc.result ?? { result: resultCode }), lead_id: rpc.lead_id, event_ids: rpc.event_ids, replayed: true };
    }
    if (rpc.status === 'NOT_FOUND') return rejected('LEAD_NOT_FOUND', 'The lead disappeared before the write.');
    // CONFLICT: re-read and rebase once.
  }
  return rejected('CONCURRENT_UPDATE', 'The lead changed concurrently twice; retry the same request (same mutation_id).');
}

// ── void_lead_event ─────────────────────────────────────────────────────────

const HIGH_IMPACT_STATUS = new Set(['COMPLETED', 'AGREED']);

export async function voidLeadEvent(client: SupabaseClient, input: VoidLeadEventInput, ctx: WriteContext = {}): Promise<WriteResult> {
  void ctx;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.mutation_id ?? '')) return rejected('VALIDATION_ERROR', 'mutation_id must be a UUID');
  const reason = (input.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 500) return rejected('VALIDATION_ERROR', 'reason must be 3-500 characters');

  const { data: replayRows, error: replayError } = await client.from('lead_events').select('id, item_lead_id').eq('voided_by_mutation_id', input.mutation_id);
  if (replayError) throw new Error(`lead_events (replay): ${replayError.message}`);
  if ((replayRows ?? []).length > 0) {
    const leadId = replayRows![0].item_lead_id as number;
    const row = await loadLead(client, leadId);
    return { result: 'APPLIED_UPDATE', lead_id: leadId, version: row?.version, voided_event_ids: replayRows!.map((r) => r.id as number), replayed: true };
  }

  const { data: evData, error: evError } = await client.from('lead_events').select(LEAD_EVENT_COLUMNS).eq('id', input.event_id).maybeSingle();
  if (evError) throw new Error(`lead_events: ${evError.message}`);
  const target = evData as unknown as LeadEventRow | null;
  if (!target) return rejected('EVENT_NOT_FOUND', `Event ${input.event_id} not found.`);
  if (target.event_type === 'LEGACY_SNAPSHOT') return rejected('VALIDATION_ERROR', 'The legacy baseline cannot be voided.');
  if (target.voided_at) return { result: 'NO_CHANGE', lead_id: target.item_lead_id, reason: 'ALREADY_VOIDED', message: `Event ${target.id} is already voided.` };

  const row = await loadLead(client, target.item_lead_id);
  if (!row) return rejected('LEAD_NOT_FOUND', 'Lead not found.');
  if (row.version !== input.expected_version) return rejected('CONCURRENT_UPDATE', `The lead is at version ${row.version}, not ${input.expected_version}. Re-read it (get_item_context) and retry.`, { current_version: row.version, lead_id: row.id });

  const highImpact = target.event_type === 'DEAL_LINKED' || target.event_type === 'AGREEMENT' ||
    (target.event_type === 'STATUS_CHANGE' && HIGH_IMPACT_STATUS.has(String((target.payload as { to?: string }).to)));
  if (highImpact && !input.confirm) {
    return review('DESTRUCTIVE_TRANSITION', `Voiding a ${target.event_type} event can undo an agreement or a completed deal. Re-send with confirm: true only if the user explicitly wants this.`, { lead_id: row.id });
  }

  const events = await loadLeadEvents(client, [row.id]);
  // System events this event caused in the same mutation are voided with it.
  const cascade = events.filter((e) => !e.voided_at && e.id !== target.id && target.mutation_id && e.mutation_id === target.mutation_id && e.source === 'SYSTEM' && e.event_type === 'STATUS_CHANGE' &&
    ['AUTO_FROM_EVENT'].includes(String((e.payload as { trigger?: string }).trigger)) && (e.payload as { cause?: string }).cause === target.event_type);
  const voidIds = new Set([target.id, ...cascade.map((e) => e.id)]);

  const live = events.filter((e) => !e.voided_at);
  const snaps = live.filter((e) => e.event_type === 'LEGACY_SNAPSHOT').sort((a, b) => a.id - b.id);
  const baselineEvent = snaps[snaps.length - 1] ?? null;
  if (baselineEvent && target.id < baselineEvent.id) return rejected('EVENT_PRECEDES_BASELINE', 'This event is already folded into a later baseline snapshot and cannot be voided individually.');
  const baseline = baselineEvent ? baselineFromLegacyPayload(baselineEvent.payload) : emptyBaseline();
  const fold = live.filter((e) => e.event_type !== 'LEGACY_SNAPSHOT' && !voidIds.has(e.id) && (baselineEvent == null || e.id > baselineEvent.id));
  const derived = { ...deriveSnapshot(baseline, fold), semantics_version: SEMANTICS_VERSION };
  const changes = diffSnapshot(row as unknown as Record<string, unknown>, derived);

  let rpc: RpcResult;
  try {
    rpc = await callRpc(client, {
      mode: 'void', mutation_id: input.mutation_id, lead_id: row.id, expected_version: row.version,
      void_event_ids: Array.from(voidIds), void_reason: reason, snapshot: snapshotForRpc(derived), lead: {},
    });
  } catch (e) {
    if (e instanceof RpcRejection) return rejected(e.reason, e.message);
    throw e;
  }
  if (rpc.status === 'OK') return { result: 'APPLIED_UPDATE', lead_id: rpc.lead_id, version: rpc.version, voided_event_ids: Array.from(voidIds), changes, snapshot: snapshotSummary(derived, rpc.version) };
  if (rpc.status === 'REPLAY') return { result: 'APPLIED_UPDATE', lead_id: rpc.lead_id, replayed: true };
  if (rpc.status === 'CONFLICT') return rejected('CONCURRENT_UPDATE', 'The lead changed concurrently. Re-read and retry.', { current_version: rpc.current_version });
  return rejected('LEAD_NOT_FOUND', 'Lead not found.');
}
