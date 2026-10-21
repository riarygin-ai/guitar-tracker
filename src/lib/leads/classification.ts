// Pure, deterministic lead classification — the ONLY place the stage /
// responsiveness / offer-snapshot rules live. Consumed by the direct-write
// service (leadWriteService.ts), the historical backfill, the Lead Log
// importer (legacy structured stage) and the read tools. No I/O.
//
// Semantics are documented in semantics.ts; this file implements them.

import { torontoLocalDate } from '@/lib/analytics/automation/torontoSchedule';
import { normalizeContactName } from './contactName';
import {
  DEFAULT_QUIET_AFTER_DAYS,
  STAGE_RANK,
  isReopenable,
  isTerminal,
  type CashTerms,
  type LeadStage,
  type ResponsivenessLabel,
  type StageSource,
  type WaitingOn,
} from './semantics';

// ── Types ───────────────────────────────────────────────────────────────────

export interface OfferItem { description: string; est_value?: number | null }
export interface OfferPayload { cash_terms: CashTerms; cash_amount: number | null; items: OfferItem[]; summary?: string | null }

/** A lead event as the classifier sees it (stored row or not-yet-inserted). */
export interface ClassifiableEvent {
  id?: number | null;
  event_type: string;
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
  occurred_at: string; // ISO timestamp
  message_count: number;
  expects_reply: boolean;
  payload: Record<string, unknown>;
  provenance?: string;
  mutation_seq?: number | null;
}

export type OfferType = 'NONE' | 'CASH' | 'TRADE' | 'MIXED';

export interface OfferSnapshot {
  offer_type: OfferType;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  latest_cash_offer: number | null;
  trade_item: string | null;
  cash_component: number | null;
  trade_est_value: number | null;
  offer_is_concrete: boolean | null;
  offer_assessment: string | null;
  offer_assessment_source: string | null;
}

/** State the event fold starts from: the latest LEGACY_SNAPSHOT payload, or empty for a brand-new direct lead. */
export interface LeadBaseline {
  peak_stage: LeadStage | null;
  peak_stage_source: StageSource | null;
  peak_stage_at: string | null;
  negotiation_rounds: number;
  status: string;
  outcome_reason: string | null;
  deal_id: number | null;
  offer: OfferSnapshot;
  buyer_message_count: number | null;
  our_message_count: number | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  waiting_on: WaitingOn | null;
  reopen_count: number;
}

export interface DerivedSnapshot extends OfferSnapshot {
  peak_stage: LeadStage;
  peak_stage_source: StageSource;
  peak_stage_at: string | null;
  negotiation_rounds: number;
  status: string;
  outcome_reason: string | null;
  deal_id: number | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  waiting_on: WaitingOn | null;
  unanswered_followups: number;
  reopen_count: number;
}

export const EMPTY_OFFER: OfferSnapshot = {
  offer_type: 'NONE', initial_cash_offer: null, best_cash_offer: null, latest_cash_offer: null, trade_item: null,
  cash_component: null, trade_est_value: null, offer_is_concrete: null, offer_assessment: null, offer_assessment_source: null,
};

export function emptyBaseline(): LeadBaseline {
  return {
    peak_stage: null, peak_stage_source: null, peak_stage_at: null, negotiation_rounds: 0, status: 'OPEN', outcome_reason: null,
    deal_id: null, offer: { ...EMPTY_OFFER }, buyer_message_count: null, our_message_count: null, first_contact_at: null,
    last_contact_at: null, last_inbound_at: null, last_outbound_at: null, waiting_on: null, reopen_count: 0,
  };
}

// ── Contact / channel keys ──────────────────────────────────────────────────

/**
 * Strong match key for a display name. Case/whitespace/accent/punctuation
 * normalization (normalizeContactName) but parenthetical qualifiers are KEPT,
 * so "Nick (collector)" and "Nick (ES-325)" never collide.
 */
export function contactKey(name: string | null | undefined): string | null {
  if (name == null) return null;
  const k = normalizeContactName(name).replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*\(/g, ' (').trim();
  return k === '' ? null : k;
}

/** contactKey without one trailing parenthetical qualifier — used ONLY to raise ambiguity, never to auto-match. */
export function baseKey(name: string | null | undefined): string | null {
  const k = contactKey(name);
  if (k == null) return null;
  const b = k.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return b === '' ? k : b;
}

export function hasQualifier(name: string | null | undefined): boolean {
  const k = contactKey(name);
  return k != null && baseKey(name) !== k;
}

/** Relationship channel key: canonical channel + normalized detail ("other/instagram"). */
export function channelKey(sourceChannel: string | null, channelDetail: string | null): string {
  const base = (sourceChannel ?? '').trim().toLowerCase() || 'unknown';
  const detail = channelDetail == null ? '' : normalizeContactName(channelDetail);
  return detail ? `${base}/${detail}` : base;
}

export function baseChannelKey(sourceChannel: string | null): string {
  return (sourceChannel ?? '').trim().toLowerCase() || 'unknown';
}

// ── Offers ──────────────────────────────────────────────────────────────────

export interface OfferShape {
  offer_type: OfferType;
  concrete: boolean;
  /** Trades: signed cash term (+ to us, − from us); null = amount not stated. */
  cash_component: number | null;
  /** Cash-only offers: the amount. */
  latest_cash_offer: number | null;
  summary: string;
}

function money(n: number): string {
  return `C$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** Validates an offer object; returns an error message or null. */
export function offerError(offer: unknown): string | null {
  if (!offer || typeof offer !== 'object') return 'offer is required';
  const o = offer as Partial<OfferPayload>;
  if (!o.cash_terms || !['AMOUNT', 'STRAIGHT', 'OPEN'].includes(o.cash_terms)) return 'offer.cash_terms must be AMOUNT, STRAIGHT or OPEN';
  const items = Array.isArray(o.items) ? o.items : [];
  if (items.some((i) => !i || typeof i.description !== 'string' || i.description.trim() === '')) return 'every offer item needs a description';
  if (o.cash_terms === 'AMOUNT' && (typeof o.cash_amount !== 'number' || !Number.isFinite(o.cash_amount))) return 'offer.cash_amount is required when cash_terms is AMOUNT';
  if (o.cash_terms !== 'AMOUNT' && o.cash_amount != null) return 'offer.cash_amount must be null unless cash_terms is AMOUNT';
  if (items.length === 0) {
    if (o.cash_terms !== 'AMOUNT') return 'a cash-only offer needs cash_terms AMOUNT';
    if ((o.cash_amount as number) <= 0) return 'a cash-only offer needs a positive cash_amount';
  }
  return null;
}

export function offerShape(offer: OfferPayload): OfferShape {
  const items = offer.items ?? [];
  const itemText = items.map((i) => i.description.trim()).join(' + ');
  if (items.length === 0) {
    const amt = offer.cash_amount as number;
    return { offer_type: 'CASH', concrete: true, cash_component: null, latest_cash_offer: amt, summary: offer.summary?.trim() || `${money(amt)} cash` };
  }
  if (offer.cash_terms === 'STRAIGHT' || (offer.cash_terms === 'AMOUNT' && offer.cash_amount === 0)) {
    return { offer_type: 'TRADE', concrete: true, cash_component: 0, latest_cash_offer: null, summary: offer.summary?.trim() || `${itemText} straight` };
  }
  if (offer.cash_terms === 'AMOUNT') {
    const c = offer.cash_amount as number;
    const dir = c > 0 ? 'to us' : 'from us';
    return { offer_type: 'MIXED', concrete: true, cash_component: c, latest_cash_offer: null, summary: offer.summary?.trim() || `${itemText} + ${money(c)} ${dir}` };
  }
  return { offer_type: 'MIXED', concrete: false, cash_component: null, latest_cash_offer: null, summary: offer.summary?.trim() || `${itemText} + cash open` };
}

function offerOf(e: ClassifiableEvent): OfferPayload | null {
  const o = (e.payload as { offer?: OfferPayload }).offer;
  return o && !offerError(o) ? o : null;
}

function offerSignature(e: ClassifiableEvent): string {
  const o = offerOf(e)!;
  const s = offerShape(o);
  return [e.direction, s.offer_type, s.cash_component ?? '', s.latest_cash_offer ?? '', (o.items ?? []).map((i) => i.description.trim().toLowerCase()).join('|')].join('#');
}

const isConcreteOffer = (e: ClassifiableEvent): boolean => {
  if (e.event_type !== 'OFFER') return false;
  const o = offerOf(e);
  return !!o && offerShape(o).concrete;
};

// ── Ordering / helpers ──────────────────────────────────────────────────────

/** Fold order: occurred_at, then stored id (new events last), then mutation_seq. */
export function sortEvents<T extends ClassifiableEvent>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.occurred_at), tb = Date.parse(b.occurred_at);
    if (ta !== tb) return ta - tb;
    const ia = a.id ?? Number.MAX_SAFE_INTEGER, ib = b.id ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return (a.mutation_seq ?? 0) - (b.mutation_seq ?? 0);
  });
}

/** Recording order (stored id, then new events by mutation_seq) — the order status transitions actually happened in. */
export function sortByRecording<T extends ClassifiableEvent>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const ia = a.id ?? Number.MAX_SAFE_INTEGER, ib = b.id ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return (a.mutation_seq ?? 0) - (b.mutation_seq ?? 0);
  });
}

export const isConversational = (e: ClassifiableEvent): boolean =>
  e.direction !== 'INTERNAL' && e.event_type !== 'LEGACY_SNAPSHOT' && ['MESSAGE', 'OFFER', 'AGREEMENT', 'LOGISTICS'].includes(e.event_type);

export function maxStage(a: LeadStage | null, b: LeadStage | null): LeadStage | null {
  if (a == null) return b;
  if (b == null) return a;
  return STAGE_RANK[a] >= STAGE_RANK[b] ? a : b;
}

export function torontoDate(iso: string): string {
  return torontoLocalDate(new Date(iso));
}

// ── Stage ───────────────────────────────────────────────────────────────────

const EXECUTION_KINDS_NEED_TERMS = ['MEETUP', 'HOLD', 'ADDRESS', 'SHIPPING'];
const EXECUTION_KINDS_SELF_EVIDENT = ['PAYMENT', 'ORDER'];

/**
 * Stage implied by a (sorted) list of events alone, with no baseline.
 * Returns null when there is no conversational evidence at all.
 */
export function deriveStageFromEvents(events: ClassifiableEvent[], finalStatus: string, finalDealId: number | null): LeadStage | null {
  const ev = sortEvents(events).filter((e) => e.event_type !== 'LEGACY_SNAPSHOT');
  if (ev.some((e) => e.event_type === 'DEAL_LINKED') || (finalStatus === 'COMPLETED' && finalDealId != null)) return 'CONVERTED';

  const hasAgreement = ev.some((e) => e.event_type === 'AGREEMENT');
  if (hasAgreement) return 'HIGH_INTENT';
  for (const e of ev) {
    if (e.event_type !== 'LOGISTICS') continue;
    const p = e.payload as { kind?: string; state?: string; at_asking_price?: boolean };
    if (p.state !== 'CONFIRMED' && p.state !== 'DONE') continue;
    if (p.kind && EXECUTION_KINDS_SELF_EVIDENT.includes(p.kind)) return 'HIGH_INTENT';
    if (p.kind && EXECUTION_KINDS_NEED_TERMS.includes(p.kind) && p.at_asking_price === true) return 'HIGH_INTENT';
  }

  // NEGOTIATING: a concrete INBOUND offer, or our concrete OUTBOUND offer that
  // the buyer subsequently engaged with.
  let outboundConcreteSeen = false;
  for (const e of ev) {
    if (isConcreteOffer(e) && e.direction === 'INBOUND') return 'NEGOTIATING';
    if (isConcreteOffer(e) && e.direction === 'OUTBOUND') { outboundConcreteSeen = true; continue; }
    if (outboundConcreteSeen && e.direction === 'INBOUND') {
      if (e.event_type === 'OFFER' || e.event_type === 'AGREEMENT' || e.event_type === 'LOGISTICS') return 'NEGOTIATING';
      const p = e.payload as { substance?: string; responds_to_offer?: boolean };
      if (e.event_type === 'MESSAGE' && (p.responds_to_offer === true || p.substance === 'SUBSTANTIVE')) return 'NEGOTIATING';
    }
  }

  const inbound = ev.filter((e) => e.direction === 'INBOUND');
  if (inbound.some((e) =>
    (e.event_type === 'MESSAGE' && (e.payload as { substance?: string }).substance === 'SUBSTANTIVE') ||
    (e.event_type === 'OFFER' && !isConcreteOffer(e)) ||
    e.event_type === 'LOGISTICS')) return 'ENGAGED';
  if (ev.some(isConversational)) return 'INQUIRY';
  return null;
}

export interface PeakResult { stage: LeadStage; source: StageSource; reached_at: string | null }

/**
 * peak_stage = max(baseline peak, stage derived from events). When the
 * events raise it, the source becomes DERIVED and reached_at is the
 * occurred_at of the first event at which that stage was reached.
 */
export function derivePeakStage(baseline: LeadBaseline, events: ClassifiableEvent[], finalStatus: string, finalDealId: number | null): PeakResult {
  const sorted = sortEvents(events).filter((e) => e.event_type !== 'LEGACY_SNAPSHOT');
  const derived = deriveStageFromEvents(sorted, finalStatus, finalDealId);
  const base = baseline.peak_stage;
  if (derived != null && (base == null || STAGE_RANK[derived] > STAGE_RANK[base])) {
    let reached: string | null = null;
    for (let i = 0; i < sorted.length; i++) {
      const s = deriveStageFromEvents(sorted.slice(0, i + 1), i === sorted.length - 1 ? finalStatus : 'OPEN', i === sorted.length - 1 ? finalDealId : null);
      if (s === derived) { reached = sorted[i].occurred_at; break; }
    }
    return { stage: derived, source: 'DERIVED', reached_at: reached ?? sorted[sorted.length - 1]?.occurred_at ?? null };
  }
  if (base != null) return { stage: base, source: baseline.peak_stage_source ?? 'LEGACY_STRUCTURED', reached_at: baseline.peak_stage_at };
  return { stage: 'INQUIRY', source: 'DERIVED', reached_at: sorted[0]?.occurred_at ?? null };
}

/** Number of distinct concrete economic positions exchanged (either direction). */
export function deriveNegotiationRounds(baselineRounds: number, events: ClassifiableEvent[]): number {
  let rounds = baselineRounds;
  let prev: string | null = null;
  for (const e of sortEvents(events)) {
    if (!isConcreteOffer(e)) continue;
    const sig = offerSignature(e);
    if (sig !== prev) rounds++;
    prev = sig;
  }
  return rounds;
}

// ── Responsiveness ──────────────────────────────────────────────────────────

export function deriveWaitingOn(events: ClassifiableEvent[], status: string, baselineWaiting: WaitingOn | null): WaitingOn | null {
  if (isTerminal(status)) return 'NONE';
  const conv = sortEvents(events).filter(isConversational);
  const last = conv[conv.length - 1];
  if (!last) return baselineWaiting;
  if (!last.expects_reply) return 'NONE';
  return last.direction === 'INBOUND' ? 'US' : 'BUYER';
}

export function deriveUnansweredFollowups(events: ClassifiableEvent[]): number {
  const conv = sortEvents(events).filter(isConversational);
  let n = 0;
  for (const e of conv) {
    if (e.direction === 'INBOUND') n = 0;
    else if (e.direction === 'OUTBOUND' && (e.payload as { follow_up?: boolean }).follow_up === true) n++;
  }
  return n;
}

/**
 * GHOSTED may be applied without user confirmation only when the latest
 * conversational event is OUR pending ask (OUTBOUND + expects_reply) AND
 * either a follow-up went unanswered or a committed logistics step was
 * missed after the buyer's last message. Never based on elapsed time.
 */
export function ghostPreconditionsMet(events: ClassifiableEvent[]): boolean {
  const conv = sortEvents(events).filter(isConversational);
  const last = conv[conv.length - 1];
  if (!last || last.direction !== 'OUTBOUND' || !last.expects_reply) return false;
  const lastInboundIdx = conv.map((e) => e.direction).lastIndexOf('INBOUND');
  const after = conv.slice(lastInboundIdx + 1);
  const followups = after.filter((e) => (e.payload as { follow_up?: boolean }).follow_up === true).length;
  const missed = after.some((e) => e.event_type === 'LOGISTICS' && (e.payload as { state?: string }).state === 'MISSED');
  return followups >= 1 || missed;
}

export interface ResponsivenessView {
  waiting_on: WaitingOn | null;
  days_waiting: number | null;
  days_since_last_event: number | null;
  label: ResponsivenessLabel | null;
}

function daysBetween(fromIso: string, today: string): number {
  return Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(torontoDate(fromIso) + 'T00:00:00Z')) / 86_400_000);
}

/** Read-time responsiveness view. quietAfterDays is a USER preference. */
export function deriveResponsiveness(
  lead: { status: string; waiting_on: WaitingOn | null; last_inbound_at: string | null; last_outbound_at: string | null },
  now: Date = new Date(),
  prefs: { quietAfterDays?: number } = {},
): ResponsivenessView {
  const quiet = prefs.quietAfterDays ?? DEFAULT_QUIET_AFTER_DAYS;
  const today = torontoLocalDate(now);
  const lastAny = [lead.last_inbound_at, lead.last_outbound_at].filter((x): x is string => !!x).sort().pop() ?? null;
  const daysSince = lastAny ? daysBetween(lastAny, today) : null;
  let daysWaiting: number | null = null;
  if (lead.waiting_on === 'US' && lead.last_inbound_at) daysWaiting = daysBetween(lead.last_inbound_at, today);
  if (lead.waiting_on === 'BUYER' && lead.last_outbound_at) daysWaiting = daysBetween(lead.last_outbound_at, today);
  let label: ResponsivenessLabel | null = null;
  if (lead.status === 'OPEN' || lead.status === 'AGREED') {
    if (lead.waiting_on === 'US') label = 'AWAITING_US';
    else if (daysSince != null && daysSince >= quiet) label = 'QUIET';
    else if (lead.waiting_on === 'BUYER') label = 'AWAITING_BUYER';
  }
  return { waiting_on: lead.waiting_on, days_waiting: daysWaiting, days_since_last_event: daysSince, label };
}

// ── Full snapshot fold ──────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Derives every event-backed item_leads snapshot field from a baseline plus
 * the events recorded AFTER it (the caller passes only those). Pure.
 */
export function deriveSnapshot(baseline: LeadBaseline, eventsAfterBaseline: ClassifiableEvent[]): DerivedSnapshot {
  const events = sortEvents(eventsAfterBaseline).filter((e) => e.event_type !== 'LEGACY_SNAPSHOT');

  // Status / deal fold (explicit STATUS_CHANGE + DEAL_LINKED events only), in
  // RECORDING order: a system auto-close recorded today must not be reordered
  // after a deal link the agent dates to last week.
  let status = baseline.status;
  let outcome = baseline.outcome_reason;
  let dealId = baseline.deal_id;
  let reopenCount = baseline.reopen_count;
  for (const e of sortByRecording(events)) {
    if (e.event_type === 'STATUS_CHANGE') {
      const p = e.payload as { to?: string; outcome_reason?: string | null; from?: string; from_outcome?: string | null };
      if (!p.to) continue;
      if (p.to === 'OPEN' && isReopenable(p.from ?? status, p.from_outcome ?? outcome)) reopenCount++;
      status = p.to;
      outcome = p.outcome_reason ?? null;
    } else if (e.event_type === 'DEAL_LINKED') {
      const d = num((e.payload as { deal_id?: unknown }).deal_id);
      if (d != null) dealId = d;
    }
  }

  // Offer snapshot: latest INBOUND offer = latest buyer position.
  const offer: OfferSnapshot = { ...baseline.offer };
  const cashAmounts: number[] = [];
  let latestOfferAt: string | null = null;
  for (const e of events) {
    if (e.event_type === 'OFFER' && e.direction === 'INBOUND') {
      const o = offerOf(e);
      if (!o) continue;
      const s = offerShape(o);
      offer.offer_type = s.offer_type;
      offer.offer_is_concrete = s.concrete;
      offer.latest_cash_offer = s.latest_cash_offer;
      offer.cash_component = s.offer_type === 'CASH' ? null : s.cash_component;
      offer.trade_item = s.offer_type === 'CASH' ? null : s.summary.slice(0, 300);
      if (s.latest_cash_offer != null) cashAmounts.push(s.latest_cash_offer);
      const p = e.payload as { our_estimate?: unknown; assessment?: string; assessment_source?: string };
      offer.trade_est_value = s.offer_type === 'CASH' ? null : num(p.our_estimate);
      offer.offer_assessment = p.assessment ?? null;
      offer.offer_assessment_source = p.assessment ? (p.assessment_source ?? (e.provenance === 'STATED' ? 'USER' : 'AI')) : null;
      latestOfferAt = e.occurred_at;
    } else if (e.event_type === 'NOTE') {
      const p = e.payload as { our_estimate?: unknown; assessment?: string; assessment_source?: string };
      if (num(p.our_estimate) != null && offer.offer_type !== 'CASH' && offer.offer_type !== 'NONE') offer.trade_est_value = num(p.our_estimate);
      if (p.assessment && offer.offer_type !== 'NONE') {
        offer.offer_assessment = p.assessment;
        offer.offer_assessment_source = p.assessment_source ?? (e.provenance === 'STATED' ? 'USER' : 'AI');
      }
    }
  }
  void latestOfferAt;
  if (cashAmounts.length > 0) {
    const initial = baseline.offer.initial_cash_offer ?? cashAmounts[0];
    offer.initial_cash_offer = initial;
    offer.best_cash_offer = Math.max(initial, baseline.offer.best_cash_offer ?? initial, ...cashAmounts);
  }

  // Message totals, contact dates, responsiveness.
  const conv = events.filter(isConversational);
  const inbound = conv.filter((e) => e.direction === 'INBOUND');
  const outbound = conv.filter((e) => e.direction === 'OUTBOUND');
  const sum = (xs: ClassifiableEvent[]) => xs.reduce((s, e) => s + (e.message_count ?? 0), 0);
  const inSum = sum(inbound), outSum = sum(outbound);
  const buyerCount = baseline.buyer_message_count == null && inSum === 0 ? baseline.buyer_message_count : (baseline.buyer_message_count ?? 0) + inSum;
  const ourCount = baseline.our_message_count == null && outSum === 0 ? baseline.our_message_count : (baseline.our_message_count ?? 0) + outSum;

  const dates = conv.map((e) => torontoDate(e.occurred_at));
  const allFirst = [baseline.first_contact_at, ...dates].filter((d): d is string => !!d).sort();
  const allLast = [baseline.last_contact_at, ...dates].filter((d): d is string => !!d).sort();
  const lastIn = inbound.length ? inbound[inbound.length - 1].occurred_at : baseline.last_inbound_at;
  const lastOut = outbound.length ? outbound[outbound.length - 1].occurred_at : baseline.last_outbound_at;

  const peak = derivePeakStage(baseline, events, status, dealId);

  return {
    ...offer,
    peak_stage: peak.stage,
    peak_stage_source: peak.source,
    peak_stage_at: peak.reached_at,
    negotiation_rounds: deriveNegotiationRounds(baseline.negotiation_rounds, events),
    status,
    outcome_reason: outcome,
    deal_id: dealId,
    buyer_message_count: buyerCount,
    our_message_count: ourCount,
    first_contact_at: allFirst[0] ?? null,
    last_contact_at: allLast[allLast.length - 1] ?? null,
    last_inbound_at: lastIn,
    last_outbound_at: lastOut,
    waiting_on: deriveWaitingOn(events, status, baseline.waiting_on),
    unanswered_followups: deriveUnansweredFollowups(events),
    reopen_count: reopenCount,
  };
}

// ── Legacy structured stage (importer + backfill fallback) ──────────────────

/**
 * Stage computable from the legacy structured fields alone (no notes, no
 * events). Deliberately conservative: a TRADE/MIXED row counts as a concrete
 * offer only when its terms are defined (MIXED needs a cash amount).
 */
export function legacyStructuredStage(row: {
  status: string; deal_id: number | null; offer_type: string; cash_component: number | null;
  initial_cash_offer: number | null; best_cash_offer: number | null; trade_item: string | null; lead_quality: string | null;
}): LeadStage {
  if (row.status === 'COMPLETED' || row.deal_id != null) return 'CONVERTED';
  if (row.status === 'AGREED' || row.status === 'FAILED_AFTER_AGREEMENT') return 'HIGH_INTENT';
  const concrete =
    (row.offer_type === 'CASH' && (row.best_cash_offer != null || row.initial_cash_offer != null)) ||
    (row.offer_type === 'TRADE' && !!row.trade_item) ||
    (row.offer_type === 'MIXED' && !!row.trade_item && row.cash_component != null);
  if (concrete) return 'NEGOTIATING';
  // Message counts never decide a stage. Without events, the only legacy
  // evidence of a substantive exchange is a non-concrete offer or the
  // logger's own legacy label above LOW.
  if (row.offer_type !== 'NONE' || (row.lead_quality != null && row.lead_quality !== 'LOW')) return 'ENGAGED';
  return 'INQUIRY';
}
