// Negotiation Analytics v1.0 — the ONE deterministic engine for "what happens
// after a lead reaches a concrete economic negotiation".
//
//   item_leads / lead_events / item_listings / item_listing_price_history
//                              ↓
//                 buildNegotiationAnalytics (pure)
//                              ↓
//                 NegotiationAnalyticsResult (typed contract)
//                              ↓
//     Business Coach (advice/negotiationContext.ts) — and, later, an MCP tool
//
// Descriptive history only: counts, rates WITH their denominators, and a
// deterministic evidence strength per metric. No prediction, no close
// probability, no buyer score. Consumers interpret; they never recompute.
//
// The contract is UI-agnostic (no Coach types here) so a future MCP tool can
// serialize it unchanged. Lead semantics (stages, statuses, offer shapes,
// round counting) come from src/lib/leads/semantics.ts + classification.ts —
// this module never re-implements them.
//
// ── Population ──────────────────────────────────────────────────────────────
// A lead is in the negotiation population when its peak_stage is NEGOTIATING,
// HIGH_INTENT or CONVERTED (Negotiating+, semantics.ts). peak_stage is the
// normalized stage for every lead, whatever its source (DERIVED from events,
// LEGACY_AUDIT, LEGACY_STRUCTURED); legacy lead_quality is never read.
// A dated period is a cohort by first_contact_at (the lead STARTED in the
// period) — the same convention as Listing Demand's leads_started. Leads with
// no first_contact_at are only in the lifetime population.
//
// ── Event-sequence eligibility ──────────────────────────────────────────────
// Rounds and counter analytics need the lead's COMPLETE economic history in
// lead_events. That holds when the lead was created by direct writes
// (origin DIRECT), or when its LEGACY_SNAPSHOT baseline had not yet reached
// NEGOTIATING (every concrete offer happened after event tracking began).
// Every other lead (legacy negotiation, notes/snapshot only) stays in the
// funnel/outcome/offer-type/channel metrics but is excluded from round and
// counter detail — nothing is manufactured for it.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConfidenceTier } from './insights/types';
import {
  deriveNegotiationRounds, offerError, offerShape, sortEvents, torontoDate,
  type ClassifiableEvent, type OfferPayload,
} from '@/lib/leads/classification';
import { CHANNEL_DB_NAME, LEAD_CHANNELS, NEGOTIATING_PLUS_STAGES, HIGH_INTENT_PLUS_STAGES, type LeadChannel } from '@/lib/leads/semantics';

export const NEGOTIATION_ANALYTICS_VERSION = '1.0';

// ── Inputs (already-loaded rows; the loader at the bottom builds them) ──────

export interface NegotiationLeadInput {
  id: number;
  inventory_item_id: number;
  deal_channel_id: number | null;
  /** YYYY-MM-DD or null. */
  first_contact_at: string | null;
  peak_stage: string | null;
  peak_stage_source: string | null;
  status: string;
  outcome_reason: string | null;
  /** item_leads.offer_type — the normalized structured offer shape (NONE/CASH/TRADE/MIXED). */
  offer_type: string;
  origin: string;
}

export interface NegotiationEventInput {
  id: number;
  item_lead_id: number;
  event_type: string;
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
  occurred_at: string;
  message_count: number;
  expects_reply: boolean;
  payload: Record<string, unknown>;
}

export interface NegotiationListingInput {
  id: number;
  inventory_item_id: number;
  deal_channel_id: number | null;
  status: string;
  asking_price: number | null;
  trade_enabled: boolean;
  /** YYYY-MM-DD */
  listed_at: string | null;
  /** YYYY-MM-DD */
  ended_at: string | null;
  created_at: string;
}

export interface NegotiationPriceHistoryInput {
  item_listing_id: number;
  old_asking_price: number | null;
  new_asking_price: number | null;
  old_trade_enabled: boolean | null;
  new_trade_enabled: boolean | null;
  changed_at: string;
}

export interface NegotiationAnalyticsInputs {
  leads: NegotiationLeadInput[];
  events: NegotiationEventInput[];
  listings: NegotiationListingInput[];
  priceHistory: NegotiationPriceHistoryInput[];
  /** deal_channels.id -> deal_channels.name */
  channelNameById: Map<number, string>;
}

export interface NegotiationPeriod {
  /** Inclusive YYYY-MM-DD. */
  start_date: string;
  /** Inclusive YYYY-MM-DD. */
  end_date: string;
  label?: string;
}

// ── Contract ────────────────────────────────────────────────────────────────

/** Existing Analytics/Insights confidence vocabulary, reused (never a new scale). */
export type EvidenceStrength = ConfidenceTier;

/** A rate is never emitted without its numerator and denominator. */
export interface RateMetric {
  count: number;
  sample_size: number;
  /** count / sample_size * 100, 1 decimal; null when sample_size = 0. */
  rate_pct: number | null;
  evidence_strength: EvidenceStrength;
}

export type NegotiationOfferType = 'CASH' | 'TRADE' | 'MIXED' | 'UNKNOWN';
export const NEGOTIATION_OFFER_TYPES: readonly NegotiationOfferType[] = ['CASH', 'TRADE', 'MIXED', 'UNKNOWN'];

export interface NegotiationSegment {
  lead_count: number;
  high_intent_count: number;
  converted_count: number;
  /** Still OPEN or AGREED — no final outcome yet. */
  open_count: number;
  declined_by_me: number;
  declined_by_them: number;
  ghosted: number;
  failed_after_agreement: number;
  closed: number;
  negotiating_to_high_intent: RateMetric;
  negotiating_to_converted: RateMetric;
  evidence_strength: EvidenceStrength;
}

export interface NegotiationOfferTypeSegment extends NegotiationSegment { offer_type: NegotiationOfferType }
export interface NegotiationChannelSegment extends NegotiationSegment { channel: LeadChannel }

export type CounterResolution =
  | 'AGREED_OR_COMPLETED'
  | 'FAILED_AFTER_AGREEMENT'
  | 'BUYER_DECLINED'
  | 'BUYER_GHOSTED'
  | 'WE_DECLINED'
  | 'CLOSED_NEUTRAL'
  | 'COUNTERED_AGAIN'
  | 'UNRESOLVED';
export const COUNTER_RESOLUTIONS: readonly CounterResolution[] = [
  'AGREED_OR_COMPLETED', 'FAILED_AFTER_AGREEMENT', 'BUYER_DECLINED', 'BUYER_GHOSTED', 'WE_DECLINED', 'CLOSED_NEUTRAL', 'COUNTERED_AGAIN', 'UNRESOLVED',
];

export type CounterSizeBucket = '0-5' | '>5-10' | '>10-15' | '>15-20' | '>20-30' | '>30';
export const COUNTER_SIZE_BUCKETS: { bucket: CounterSizeBucket; min_exclusive: number | null; max_inclusive: number | null }[] = [
  { bucket: '0-5', min_exclusive: null, max_inclusive: 5 },
  { bucket: '>5-10', min_exclusive: 5, max_inclusive: 10 },
  { bucket: '>10-15', min_exclusive: 10, max_inclusive: 15 },
  { bucket: '>15-20', min_exclusive: 15, max_inclusive: 20 },
  { bucket: '>20-30', min_exclusive: 20, max_inclusive: 30 },
  { bucket: '>30', min_exclusive: 30, max_inclusive: null },
];

export type NumericCounterMissingReason = 'NON_CASH_TERMS' | 'INVALID_DENOMINATOR' | 'COUNTER_NOT_ABOVE_BUYER_OFFER';
export type AskUnavailableReason = 'NO_CHANNEL' | 'NO_LISTING_AT_TIME' | 'AMBIGUOUS_LISTING' | 'BEFORE_PRICE_HISTORY' | 'NO_ASKING_PRICE' | 'NON_CASH_TERMS';

/** One of our counters, with everything a drill-down needs (no names, notes or message text). */
export interface CounterRecord {
  lead_id: number;
  item_id: number;
  counter_event_id: number;
  buyer_offer_event_id: number;
  counter_at: string;
  buyer_offer_type: NegotiationOfferType;
  counter_offer_type: NegotiationOfferType;
  buyer_replied: boolean;
  buyer_revised_offer: boolean;
  buyer_improved: boolean;
  /** True when a later buyer offer was comparable to the original one (so "improved" could be decided). */
  buyer_improvement_comparable: boolean;
  reached_high_intent_or_accepted: boolean;
  resolution: CounterResolution;
  lead_converted: boolean;
  buyer_offer_cash: number | null;
  our_counter_cash: number | null;
  counter_increase_vs_buyer_offer_pct: number | null;
  counter_size_bucket: CounterSizeBucket | null;
  numeric_missing_reason: NumericCounterMissingReason | null;
  listing_id: number | null;
  listing_price_at_time: number | null;
  listing_trade_enabled_at_time: boolean | null;
  buyer_offer_gap_vs_ask_pct: number | null;
  our_counter_gap_vs_ask_pct: number | null;
  ask_unavailable_reason: AskUnavailableReason | null;
}

export interface NegotiationAnalyticsResult {
  analytics_version: typeof NEGOTIATION_ANALYTICS_VERSION;
  period: { start_date: string | null; end_date: string | null; label: string; cohort_rule: string };
  coverage: {
    total_leads: number;
    negotiating_plus_leads: number;
    negotiating_plus_by_stage_source: Record<string, number>;
    event_sequence_eligible_leads: number;
    event_sequence_ineligible_leads: number;
    /** Lifetime only: leads with no first_contact_at, excluded from every dated period. */
    leads_without_first_contact_date: number;
    our_counter_count: number;
    numeric_counter_analysis_eligible: number;
    numeric_counter_analysis_missing: number;
  };
  funnel: {
    negotiating_count: number;
    high_intent_count: number;
    converted_count: number;
    still_open_count: number;
    negotiating_to_high_intent: RateMetric;
    high_intent_to_converted: RateMetric;
    negotiating_to_converted: RateMetric;
    /** Same, with leads WE declined removed from the denominator (our own filtering is not a buyer loss). */
    negotiating_to_converted_excluding_declined_by_me: RateMetric;
    /** Among leads that reached a final outcome (not OPEN/AGREED). */
    negotiating_to_converted_resolved_only: RateMetric;
    /** Item level: only one lead can realize an item, so competing leads close as ITEM_UNAVAILABLE. */
    items_with_negotiating_leads: number;
    items_realized_via_negotiating_lead: RateMetric;
  };
  outcomes: {
    by_status: Record<string, RateMetric>;
    /** Final outcomes as a share of RESOLVED leads only (OPEN/AGREED excluded) — the like-for-like basis for comparing periods. */
    share_of_resolved: Record<string, RateMetric>;
    declined_by_me_reasons: Record<string, number>;
    declined_by_them_reasons: Record<string, number>;
    closed_reasons: Record<string, number>;
  };
  by_offer_type: NegotiationOfferTypeSegment[];
  by_channel: NegotiationChannelSegment[];
  rounds: {
    definition: string;
    rounds_known_count: number;
    rounds_unknown_count: number;
    /** Eligible Negotiating+ leads with no concrete OFFER event (stage reached by other evidence). */
    zero_round_count: number;
    median_rounds: number | null;
    average_rounds: number | null;
    distribution: { bucket: '1' | '2-3' | '4+'; lead_count: number; converted_count: number; conversion: RateMetric }[];
    evidence_strength: EvidenceStrength;
  };
  counter_behavior: {
    definition: string;
    total_negotiating_leads: number;
    eligible_leads: number;
    leads_with_our_counter: number;
    /** Our concrete offers with no earlier buyer offer on the lead (an opening ask, not a counter). */
    our_opening_offer_count: number;
    our_counter_count: number;
    /** Independent flags — a counter can be several of these at once. */
    buyer_replied: RateMetric;
    buyer_revised_offer: RateMetric;
    buyer_improved: RateMetric;
    buyer_improvement_comparable_count: number;
    buyer_high_intent_or_accepted: RateMetric;
    /** Mutually exclusive resolution of each counter (sums to our_counter_count). */
    resolution: Record<CounterResolution, number>;
    buyer_ghosted: RateMetric;
    buyer_declined: RateMetric;
    we_declined: RateMetric;
    unresolved_count: number;
    evidence_strength: EvidenceStrength;
  };
  counter_size_buckets: {
    definition: string;
    numeric_counter_analysis_eligible: number;
    numeric_counter_analysis_missing: number;
    missing_reasons: Record<NumericCounterMissingReason, number>;
    median_counter_increase_vs_buyer_offer_pct: number | null;
    buckets: {
      bucket: CounterSizeBucket;
      sample_size: number;
      buyer_reply: RateMetric;
      buyer_improved: RateMetric;
      high_intent: RateMetric;
      conversion: RateMetric;
      ghosted: RateMetric;
      evidence_strength: EvidenceStrength;
    }[];
    evidence_strength: EvidenceStrength;
  };
  ask_context: {
    definition: string;
    counters_with_ask_known: number;
    counters_with_ask_unavailable: number;
    unavailable_reasons: Partial<Record<AskUnavailableReason, number>>;
    median_buyer_offer_gap_vs_ask_pct: number | null;
    median_our_counter_gap_vs_ask_pct: number | null;
    /** Every buyer cash offer on an eligible lead (countered or not) with a known ask at that time. */
    buyer_cash_offers_with_ask_known: number;
    median_buyer_cash_offer_gap_vs_ask_pct: number | null;
    counters_with_trade_state_known: number;
    counters_on_trade_enabled_listing: number;
  };
  comparison: NegotiationComparison | null;
  /** Identifiers/filters for a future drill-down consumer. Not for prompts. */
  drilldown: {
    population_filter: { peak_stage_in: string[]; first_contact_from: string | null; first_contact_to: string | null };
    counters: CounterRecord[];
  };
  limitations: string[];
}

export interface NegotiationComparisonMetric {
  metric: string;
  current: RateMetric;
  comparison: RateMetric;
  /** current.rate_pct − comparison.rate_pct, percentage points, 1 decimal. Null when either side has no rate. */
  difference_pp: number | null;
  /** The weaker of the two sides' strengths. */
  evidence_strength: EvidenceStrength;
  /** Both sides at least 'low' AND |difference| ≥ MATERIAL_DIFFERENCE_PP. */
  material: boolean;
}

export interface NegotiationComparison {
  current_period: { start_date: string; end_date: string; label: string; negotiating_count: number; still_open_count: number };
  comparison_period: { start_date: string; end_date: string; label: string; negotiating_count: number; still_open_count: number };
  metrics: NegotiationComparisonMetric[];
}

// ── Evidence strength ───────────────────────────────────────────────────────
// Same labels as every Analytics/Insights module. The cut points are higher
// than the median-based confidenceFromSampleSize (3/6/10) because these are
// RATES of binary outcomes: a rate over 6 leads swings ±17pp per lead.

export const STRENGTH_MIN_SAMPLE = { low: 10, moderate: 30, stronger: 100 } as const;
/** Smallest difference between two rates worth calling material. */
export const MATERIAL_DIFFERENCE_PP = 10;

export function evidenceStrength(sampleSize: number): EvidenceStrength {
  if (sampleSize >= STRENGTH_MIN_SAMPLE.stronger) return 'stronger';
  if (sampleSize >= STRENGTH_MIN_SAMPLE.moderate) return 'moderate';
  if (sampleSize >= STRENGTH_MIN_SAMPLE.low) return 'low';
  return 'insufficient';
}

const STRENGTH_RANK: Record<EvidenceStrength, number> = { insufficient: 0, low: 1, moderate: 2, stronger: 3 };
export function weakerStrength(a: EvidenceStrength, b: EvidenceStrength): EvidenceStrength {
  return STRENGTH_RANK[a] <= STRENGTH_RANK[b] ? a : b;
}
export function strengthAtLeast(s: EvidenceStrength, min: EvidenceStrength): boolean {
  return STRENGTH_RANK[s] >= STRENGTH_RANK[min];
}

// ── Small helpers ───────────────────────────────────────────────────────────

const round1 = (v: number) => Math.round(v * 10) / 10;

export function rate(count: number, sampleSize: number): RateMetric {
  return { count, sample_size: sampleSize, rate_pct: sampleSize > 0 ? round1((count / sampleSize) * 100) : null, evidence_strength: evidenceStrength(sampleSize) };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round1(s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m]);
}

function tally(values: (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) { const k = v ?? 'UNSPECIFIED'; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

const NEG_PLUS = new Set<string>(NEGOTIATING_PLUS_STAGES);
const HI_PLUS = new Set<string>(HIGH_INTENT_PLUS_STAGES);
const OPEN_STATUSES = new Set(['OPEN', 'AGREED']);
const DB_NAME_TO_CHANNEL = new Map<string, LeadChannel>(LEAD_CHANNELS.map((c) => [CHANNEL_DB_NAME[c], c]));

export function negotiationOfferType(offerType: string): NegotiationOfferType {
  return offerType === 'CASH' || offerType === 'TRADE' || offerType === 'MIXED' ? offerType : 'UNKNOWN';
}

export function leadChannel(dealChannelId: number | null, channelNameById: Map<number, string>): LeadChannel {
  if (dealChannelId == null) return 'Other';
  return DB_NAME_TO_CHANNEL.get(channelNameById.get(dealChannelId) ?? '') ?? 'Other';
}

function inPeriod(date: string | null, period: NegotiationPeriod | null): boolean {
  if (!period) return true;
  return date != null && date >= period.start_date && date <= period.end_date;
}

// ── Offers from events ──────────────────────────────────────────────────────

function offerOf(e: NegotiationEventInput): OfferPayload | null {
  const o = (e.payload as { offer?: OfferPayload }).offer;
  return o && !offerError(o) ? o : null;
}

function eventOfferType(o: OfferPayload): NegotiationOfferType {
  return offerShape(o).offer_type as NegotiationOfferType;
}

/** Cash amount of a CASH-only offer, else null. */
function cashOnlyAmount(o: OfferPayload): number | null {
  const s = offerShape(o);
  return s.offer_type === 'CASH' ? s.latest_cash_offer : null;
}

function itemSetKey(o: OfferPayload): string {
  return (o.items ?? []).map((i) => i.description.trim().toLowerCase().replace(/\s+/g, ' ')).sort().join('|');
}

/** Signed cash to us for a trade/mixed offer with stated terms (STRAIGHT = 0), else null. */
function statedCashToUs(o: OfferPayload): number | null {
  if (o.cash_terms === 'STRAIGHT') return 0;
  if (o.cash_terms === 'AMOUNT' && typeof o.cash_amount === 'number') return o.cash_amount;
  return null;
}

/**
 * Whether `later` is a better buyer position than `earlier`, or null when the
 * two cannot be compared without a valuation we do not have.
 *   CASH vs CASH: higher amount.
 *   TRADE/MIXED vs TRADE/MIXED: the SAME item set and both cash terms stated →
 *   more cash to us. Different items are never compared (no trade valuation).
 */
export function buyerImproved(earlier: OfferPayload, later: OfferPayload): boolean | null {
  const a = cashOnlyAmount(earlier), b = cashOnlyAmount(later);
  if (a != null && b != null) return b > a;
  if ((earlier.items ?? []).length === 0 || (later.items ?? []).length === 0) return null;
  if (itemSetKey(earlier) !== itemSetKey(later)) return null;
  const ca = statedCashToUs(earlier), cb = statedCashToUs(later);
  if (ca == null || cb == null) return null;
  return cb > ca;
}

// ── Listing terms at a point in time ────────────────────────────────────────

export interface ListingTermsAtTime {
  listing_id: number | null;
  price: number | null;
  price_known: boolean;
  trade_enabled: boolean | null;
  unavailable_reason: AskUnavailableReason | null;
}

/**
 * The asking price / Trade flag that was actually in effect on `at` for the
 * lead's item on the lead's channel. Uses item_listing_price_history: the
 * first change AFTER `at` carries the value that was in effect (old_*); with
 * no later change, the listing's current value is the one in effect — but
 * only when `at` is inside the tracked window (on/after the user's first
 * history row for price, first Trade-carrying row for Trade). Outside it the
 * value is unavailable, never guessed from today's terms.
 * A listing recorded after its listed date is read from its recorded start.
 */
export function listingTermsAtTime(
  itemId: number,
  dealChannelId: number | null,
  at: string,
  listings: NegotiationListingInput[],
  historyByListing: Map<number, NegotiationPriceHistoryInput[]>,
  tracking: { priceFrom: string | null; tradeFrom: string | null },
): ListingTermsAtTime {
  const none = (reason: AskUnavailableReason, listingId: number | null = null): ListingTermsAtTime =>
    ({ listing_id: listingId, price: null, price_known: false, trade_enabled: null, unavailable_reason: reason });
  if (dealChannelId == null) return none('NO_CHANNEL');
  const day = torontoDate(at);
  const candidates = listings.filter((l) =>
    l.inventory_item_id === itemId && l.deal_channel_id === dealChannelId && (l.status === 'active' || l.status === 'ended')
    && l.listed_at != null && l.listed_at <= day && (l.ended_at == null || l.ended_at >= day));
  if (candidates.length === 0) return none('NO_LISTING_AT_TIME');
  if (candidates.length > 1) return none('AMBIGUOUS_LISTING');
  const listing = candidates[0];
  const t = Date.parse(at) > Date.parse(listing.created_at) ? at : listing.created_at;
  const tMs = Date.parse(t);
  const rows = [...(historyByListing.get(listing.id) ?? [])].sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
  const after = rows.filter((r) => Date.parse(r.changed_at) > tMs);

  let price: number | null = null;
  let priceKnown = false;
  if (tracking.priceFrom != null && tMs >= Date.parse(tracking.priceFrom)) {
    price = after.length > 0 ? after[0].old_asking_price : listing.asking_price;
    priceKnown = true;
    // Before Trade tracking began, clearing a price to NULL was never logged —
    // a NULL read from the current row may hide an unlogged change.
    if (after.length === 0 && price == null && (tracking.tradeFrom == null || tMs < Date.parse(tracking.tradeFrom))) priceKnown = false;
  }

  let trade: boolean | null = null;
  if (tracking.tradeFrom != null && tMs >= Date.parse(tracking.tradeFrom)) {
    trade = after.length > 0 ? after[0].old_trade_enabled : listing.trade_enabled;
  }

  if (!priceKnown) return { listing_id: listing.id, price: null, price_known: false, trade_enabled: trade, unavailable_reason: 'BEFORE_PRICE_HISTORY' };
  if (price == null) return { listing_id: listing.id, price: null, price_known: true, trade_enabled: trade, unavailable_reason: 'NO_ASKING_PRICE' };
  return { listing_id: listing.id, price, price_known: true, trade_enabled: trade, unavailable_reason: null };
}

const gapPct = (value: number, base: number) => round1(((value - base) / base) * 100);

// ── Eligibility ─────────────────────────────────────────────────────────────

function eventSequenceEligible(lead: NegotiationLeadInput, events: NegotiationEventInput[]): boolean {
  if (lead.origin === 'DIRECT') return true;
  const snapshot = events.filter((e) => e.event_type === 'LEGACY_SNAPSHOT').sort((a, b) => b.id - a.id)[0];
  if (!snapshot) return false;
  const baselineStage = ((snapshot.payload as { legacy?: { peak_stage?: string | null } }).legacy?.peak_stage) ?? null;
  return baselineStage == null || !NEG_PLUS.has(baselineStage);
}

/** Events after the latest LEGACY_SNAPSHOT (or all, for a direct lead), in fold order. */
function postBaselineEvents(events: NegotiationEventInput[]): NegotiationEventInput[] {
  const sorted = sortEvents(events as (NegotiationEventInput & ClassifiableEvent)[]);
  let last = -1;
  sorted.forEach((e, i) => { if (e.event_type === 'LEGACY_SNAPSHOT') last = i; });
  return sorted.slice(last + 1);
}

// ── Counters ────────────────────────────────────────────────────────────────

function counterSizeBucket(pct: number): CounterSizeBucket {
  for (const b of COUNTER_SIZE_BUCKETS) {
    if ((b.min_exclusive == null || pct > b.min_exclusive) && (b.max_inclusive == null || pct <= b.max_inclusive)) return b.bucket;
  }
  return '>30';
}

const RESOLUTION_BY_STATUS: Record<string, CounterResolution> = {
  AGREED: 'AGREED_OR_COMPLETED', COMPLETED: 'AGREED_OR_COMPLETED', FAILED_AFTER_AGREEMENT: 'FAILED_AFTER_AGREEMENT',
  DECLINED_BY_THEM: 'BUYER_DECLINED', GHOSTED: 'BUYER_GHOSTED', DECLINED_BY_ME: 'WE_DECLINED', CLOSED: 'CLOSED_NEUTRAL',
};

function isHighIntentEvent(e: NegotiationEventInput): boolean {
  if (e.event_type === 'AGREEMENT' || e.event_type === 'DEAL_LINKED') return true;
  if (e.event_type === 'LOGISTICS') {
    const state = (e.payload as { state?: string }).state;
    return state === 'CONFIRMED' || state === 'DONE';
  }
  return false;
}

/**
 * Our counters on one eligible lead. A counter is an OUTBOUND concrete OFFER
 * that follows at least one INBOUND OFFER (the buyer's economic proposal) on
 * the same lead. Its window runs until our next concrete OFFER (or the end of
 * the history); every outcome is read inside that window.
 */
export function countersForLead(
  lead: NegotiationLeadInput,
  events: NegotiationEventInput[],
  termsAt: (at: string) => ListingTermsAtTime,
): { counters: CounterRecord[]; openingOffers: number } {
  const ev = postBaselineEvents(events);
  const isOurConcreteOffer = (e: NegotiationEventInput) => {
    if (e.event_type !== 'OFFER' || e.direction !== 'OUTBOUND') return false;
    const o = offerOf(e);
    return !!o && offerShape(o).concrete;
  };
  const counters: CounterRecord[] = [];
  let openingOffers = 0;
  let lastBuyerOffer: { e: NegotiationEventInput; o: OfferPayload } | null = null;

  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.event_type === 'OFFER' && e.direction === 'INBOUND') {
      const o = offerOf(e);
      if (o) lastBuyerOffer = { e, o };
      continue;
    }
    if (!isOurConcreteOffer(e)) continue;
    if (!lastBuyerOffer) { openingOffers++; continue; }

    const ours = offerOf(e)!;
    let end = ev.length;
    for (let j = i + 1; j < ev.length; j++) if (isOurConcreteOffer(ev[j])) { end = j; break; }
    const windowEv = ev.slice(i + 1, end);
    const isLast = end === ev.length;

    const inbound = windowEv.filter((w) => w.direction === 'INBOUND' && ['MESSAGE', 'OFFER', 'AGREEMENT', 'LOGISTICS'].includes(w.event_type));
    const laterBuyerOffers = windowEv.filter((w) => w.event_type === 'OFFER' && w.direction === 'INBOUND').map((w) => offerOf(w)).filter((o): o is OfferPayload => o !== null);
    const comparisons = laterBuyerOffers.map((o) => buyerImproved(lastBuyerOffer!.o, o));
    const statusChanges = windowEv.filter((w) => w.event_type === 'STATUS_CHANGE');
    const lastStatus = statusChanges.length > 0 ? ((statusChanges[statusChanges.length - 1].payload as { to?: string }).to ?? null) : null;
    const status = lastStatus ?? (isLast ? lead.status : 'OPEN');
    const resolution: CounterResolution = RESOLUTION_BY_STATUS[status] ?? (isLast ? 'UNRESOLVED' : 'COUNTERED_AGAIN');

    const buyerCash = cashOnlyAmount(lastBuyerOffer.o);
    const ourCash = cashOnlyAmount(ours);
    let pct: number | null = null;
    let missing: NumericCounterMissingReason | null = null;
    // A cash-only offer always states its amount (offerError), so non-cash terms are the only way to lack one.
    if (buyerCash == null || ourCash == null) missing = 'NON_CASH_TERMS';
    else if (!(buyerCash > 0)) missing = 'INVALID_DENOMINATOR';
    else if (ourCash <= buyerCash) missing = 'COUNTER_NOT_ABOVE_BUYER_OFFER';
    else pct = gapPct(ourCash, buyerCash);

    const terms = termsAt(e.occurred_at);
    const cashTerms = buyerCash != null && ourCash != null;
    const askKnown = terms.unavailable_reason == null && terms.price != null && terms.price > 0;

    counters.push({
      lead_id: lead.id,
      item_id: lead.inventory_item_id,
      counter_event_id: e.id,
      buyer_offer_event_id: lastBuyerOffer.e.id,
      counter_at: e.occurred_at,
      buyer_offer_type: eventOfferType(lastBuyerOffer.o),
      counter_offer_type: eventOfferType(ours),
      buyer_replied: inbound.length > 0,
      buyer_revised_offer: laterBuyerOffers.length > 0,
      buyer_improved: comparisons.some((c) => c === true),
      buyer_improvement_comparable: comparisons.some((c) => c !== null),
      reached_high_intent_or_accepted: windowEv.some(isHighIntentEvent) || resolution === 'AGREED_OR_COMPLETED' || resolution === 'FAILED_AFTER_AGREEMENT',
      resolution,
      lead_converted: lead.peak_stage === 'CONVERTED',
      buyer_offer_cash: buyerCash,
      our_counter_cash: ourCash,
      counter_increase_vs_buyer_offer_pct: pct,
      counter_size_bucket: pct != null ? counterSizeBucket(pct) : null,
      numeric_missing_reason: missing,
      listing_id: terms.listing_id,
      listing_price_at_time: terms.price,
      listing_trade_enabled_at_time: terms.trade_enabled,
      buyer_offer_gap_vs_ask_pct: askKnown && buyerCash != null ? gapPct(buyerCash, terms.price!) : null,
      our_counter_gap_vs_ask_pct: askKnown && ourCash != null ? gapPct(ourCash, terms.price!) : null,
      ask_unavailable_reason: askKnown ? (cashTerms ? null : 'NON_CASH_TERMS') : terms.unavailable_reason,
    });
  }
  return { counters, openingOffers };
}

// ── Segments ────────────────────────────────────────────────────────────────

function segment(leads: NegotiationLeadInput[]): NegotiationSegment {
  const n = leads.length;
  const hi = leads.filter((l) => HI_PLUS.has(l.peak_stage ?? '')).length;
  const conv = leads.filter((l) => l.peak_stage === 'CONVERTED').length;
  const by = (s: string) => leads.filter((l) => l.status === s).length;
  return {
    lead_count: n,
    high_intent_count: hi,
    converted_count: conv,
    open_count: leads.filter((l) => OPEN_STATUSES.has(l.status)).length,
    declined_by_me: by('DECLINED_BY_ME'),
    declined_by_them: by('DECLINED_BY_THEM'),
    ghosted: by('GHOSTED'),
    failed_after_agreement: by('FAILED_AFTER_AGREEMENT'),
    closed: by('CLOSED'),
    negotiating_to_high_intent: rate(hi, n),
    negotiating_to_converted: rate(conv, n),
    evidence_strength: evidenceStrength(n),
  };
}

// ── Limitations ─────────────────────────────────────────────────────────────

export const NEGOTIATION_LIMITATIONS: string[] = [
  'Descriptive history only: every rate is what happened in this sample, never a probability that a future negotiation will succeed.',
  'Most historical leads carry only a legacy snapshot (stage from the 2026-10-21 audit or legacy structured fields); they count in funnel, outcome, offer-type and channel metrics but have no round or counter detail.',
  'Round and counter metrics cover only leads whose complete economic history is in lead_events (direct-write leads, or legacy leads that had not reached NEGOTIATING before event tracking).',
  'Counter size is computed only for cash-vs-cash proposals; trade and mixed proposals are never converted into cash without a stored valuation.',
  'Only one lead can realize an item: when another lead buys it, competing leads close as CLOSED (ITEM_UNAVAILABLE). That is a neutral close, not a lost negotiation.',
  'DECLINED_BY_ME is our own decision (often a weak trade or low offer) and is reported separately from buyer-side endings (DECLINED_BY_THEM, GHOSTED).',
  'Rates on cohorts with OPEN or AGREED leads are "to date": those leads have not reached a final outcome.',
  'Historical ask price is used only where listing price history can establish it for that date; otherwise it is reported unavailable.',
];

// ── Builder ─────────────────────────────────────────────────────────────────

export interface BuildNegotiationAnalyticsOptions {
  /** null = lifetime (every lead, dated or not). */
  period?: NegotiationPeriod | null;
  /** Optional comparison period (same cohort rule). */
  comparisonPeriod?: NegotiationPeriod | null;
}

export function buildNegotiationAnalytics(inputs: NegotiationAnalyticsInputs, opts: BuildNegotiationAnalyticsOptions = {}): NegotiationAnalyticsResult {
  const period = opts.period ?? null;
  const eventsByLead = new Map<number, NegotiationEventInput[]>();
  for (const e of inputs.events) {
    const list = eventsByLead.get(e.item_lead_id) ?? [];
    list.push(e);
    eventsByLead.set(e.item_lead_id, list);
  }
  const historyByListing = new Map<number, NegotiationPriceHistoryInput[]>();
  for (const h of inputs.priceHistory) {
    const list = historyByListing.get(h.item_listing_id) ?? [];
    list.push(h);
    historyByListing.set(h.item_listing_id, list);
  }
  const sortedHistory = [...inputs.priceHistory].sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
  const tracking = {
    priceFrom: sortedHistory[0]?.changed_at ?? null,
    tradeFrom: sortedHistory.find((h) => h.new_trade_enabled != null)?.changed_at ?? null,
  };

  const cohort = inputs.leads.filter((l) => inPeriod(l.first_contact_at, period));
  const neg = cohort.filter((l) => NEG_PLUS.has(l.peak_stage ?? ''));
  const eligible = neg.filter((l) => eventSequenceEligible(l, eventsByLead.get(l.id) ?? []));

  // Funnel
  const seg = segment(neg);
  const notDeclinedByMe = neg.filter((l) => l.status !== 'DECLINED_BY_ME');
  const resolved = neg.filter((l) => !OPEN_STATUSES.has(l.status));
  const items = new Set(neg.map((l) => l.inventory_item_id));
  const itemsRealized = new Set(neg.filter((l) => l.peak_stage === 'CONVERTED').map((l) => l.inventory_item_id));

  // Outcomes
  const byStatus: Record<string, RateMetric> = {};
  for (const s of ['OPEN', 'AGREED', 'COMPLETED', 'FAILED_AFTER_AGREEMENT', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'GHOSTED', 'CLOSED']) {
    byStatus[s] = rate(neg.filter((l) => l.status === s).length, neg.length);
  }

  const shareOfResolved: Record<string, RateMetric> = {};
  for (const s of ['COMPLETED', 'FAILED_AFTER_AGREEMENT', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'GHOSTED', 'CLOSED']) {
    shareOfResolved[s] = rate(resolved.filter((l) => l.status === s).length, resolved.length);
  }

  // Rounds
  const roundsByLead = eligible.map((l) => ({
    lead: l,
    rounds: deriveNegotiationRounds(0, postBaselineEvents(eventsByLead.get(l.id) ?? []) as unknown as ClassifiableEvent[]),
  }));
  const withRounds = roundsByLead.filter((r) => r.rounds > 0);
  const roundBucket = (n: number) => (n === 1 ? '1' : n <= 3 ? '2-3' : '4+') as '1' | '2-3' | '4+';
  const roundDist = (['1', '2-3', '4+'] as const).map((b) => {
    const ls = withRounds.filter((r) => roundBucket(r.rounds) === b);
    const conv = ls.filter((r) => r.lead.peak_stage === 'CONVERTED').length;
    return { bucket: b, lead_count: ls.length, converted_count: conv, conversion: rate(conv, ls.length) };
  });

  // Counters
  const termsFor = (l: NegotiationLeadInput) => (at: string) =>
    listingTermsAtTime(l.inventory_item_id, l.deal_channel_id, at, inputs.listings, historyByListing, tracking);
  const counters: CounterRecord[] = [];
  let openingOffers = 0;
  const buyerCashGaps: number[] = [];
  for (const l of eligible) {
    const evs = eventsByLead.get(l.id) ?? [];
    const r = countersForLead(l, evs, termsFor(l));
    counters.push(...r.counters);
    openingOffers += r.openingOffers;
    for (const e of postBaselineEvents(evs)) {
      if (e.event_type !== 'OFFER' || e.direction !== 'INBOUND') continue;
      const o = offerOf(e);
      const cash = o ? cashOnlyAmount(o) : null;
      if (cash == null || !(cash > 0)) continue;
      const t = termsFor(l)(e.occurred_at);
      if (t.unavailable_reason == null && t.price != null && t.price > 0) buyerCashGaps.push(gapPct(cash, t.price));
    }
  }
  const nc = counters.length;
  const resolution = Object.fromEntries(COUNTER_RESOLUTIONS.map((r) => [r, counters.filter((c) => c.resolution === r).length])) as Record<CounterResolution, number>;
  const numeric = counters.filter((c) => c.counter_increase_vs_buyer_offer_pct != null);
  const missingReasons: Record<NumericCounterMissingReason, number> = { NON_CASH_TERMS: 0, INVALID_DENOMINATOR: 0, COUNTER_NOT_ABOVE_BUYER_OFFER: 0 };
  for (const c of counters) if (c.numeric_missing_reason) missingReasons[c.numeric_missing_reason]++;
  const askKnown = counters.filter((c) => c.our_counter_gap_vs_ask_pct != null);
  const askUnavailable: Partial<Record<AskUnavailableReason, number>> = {};
  for (const c of counters) if (c.ask_unavailable_reason) askUnavailable[c.ask_unavailable_reason] = (askUnavailable[c.ask_unavailable_reason] ?? 0) + 1;

  const result: NegotiationAnalyticsResult = {
    analytics_version: NEGOTIATION_ANALYTICS_VERSION,
    period: {
      start_date: period?.start_date ?? null,
      end_date: period?.end_date ?? null,
      label: period?.label ?? (period ? `${period.start_date}..${period.end_date}` : 'lifetime'),
      cohort_rule: period ? 'Leads whose first_contact_at falls in the period (inclusive).' : 'Every lead, including leads with no first_contact_at.',
    },
    coverage: {
      total_leads: cohort.length,
      negotiating_plus_leads: neg.length,
      negotiating_plus_by_stage_source: tally(neg.map((l) => l.peak_stage_source)),
      event_sequence_eligible_leads: eligible.length,
      event_sequence_ineligible_leads: neg.length - eligible.length,
      leads_without_first_contact_date: period ? 0 : inputs.leads.filter((l) => l.first_contact_at == null).length,
      our_counter_count: nc,
      numeric_counter_analysis_eligible: numeric.length,
      numeric_counter_analysis_missing: nc - numeric.length,
    },
    funnel: {
      negotiating_count: seg.lead_count,
      high_intent_count: seg.high_intent_count,
      converted_count: seg.converted_count,
      still_open_count: seg.open_count,
      negotiating_to_high_intent: seg.negotiating_to_high_intent,
      high_intent_to_converted: rate(seg.converted_count, seg.high_intent_count),
      negotiating_to_converted: seg.negotiating_to_converted,
      negotiating_to_converted_excluding_declined_by_me: rate(notDeclinedByMe.filter((l) => l.peak_stage === 'CONVERTED').length, notDeclinedByMe.length),
      negotiating_to_converted_resolved_only: rate(resolved.filter((l) => l.peak_stage === 'CONVERTED').length, resolved.length),
      items_with_negotiating_leads: items.size,
      items_realized_via_negotiating_lead: rate(itemsRealized.size, items.size),
    },
    outcomes: {
      by_status: byStatus,
      share_of_resolved: shareOfResolved,
      declined_by_me_reasons: tally(neg.filter((l) => l.status === 'DECLINED_BY_ME').map((l) => l.outcome_reason)),
      declined_by_them_reasons: tally(neg.filter((l) => l.status === 'DECLINED_BY_THEM').map((l) => l.outcome_reason)),
      closed_reasons: tally(neg.filter((l) => l.status === 'CLOSED').map((l) => l.outcome_reason)),
    },
    by_offer_type: NEGOTIATION_OFFER_TYPES.map((t) => ({ offer_type: t, ...segment(neg.filter((l) => negotiationOfferType(l.offer_type) === t)) })),
    by_channel: LEAD_CHANNELS.map((c) => ({ channel: c, ...segment(neg.filter((l) => leadChannel(l.deal_channel_id, inputs.channelNameById) === c)) })),
    rounds: {
      definition: 'A round is one concrete OFFER event (either side) whose terms differ from the previous concrete offer (deriveNegotiationRounds). Messages never count.',
      rounds_known_count: eligible.length,
      rounds_unknown_count: neg.length - eligible.length,
      zero_round_count: roundsByLead.length - withRounds.length,
      median_rounds: median(withRounds.map((r) => r.rounds)),
      average_rounds: withRounds.length > 0 ? round1(withRounds.reduce((s, r) => s + r.rounds, 0) / withRounds.length) : null,
      distribution: roundDist,
      evidence_strength: evidenceStrength(withRounds.length),
    },
    counter_behavior: {
      definition: 'A counter is our concrete OUTBOUND OFFER after at least one INBOUND buyer OFFER on the same lead; its outcomes are read until our next concrete offer. Flags are independent; resolution is exclusive.',
      total_negotiating_leads: neg.length,
      eligible_leads: eligible.length,
      leads_with_our_counter: new Set(counters.map((c) => c.lead_id)).size,
      our_opening_offer_count: openingOffers,
      our_counter_count: nc,
      buyer_replied: rate(counters.filter((c) => c.buyer_replied).length, nc),
      buyer_revised_offer: rate(counters.filter((c) => c.buyer_revised_offer).length, nc),
      buyer_improved: rate(counters.filter((c) => c.buyer_improved).length, nc),
      buyer_improvement_comparable_count: counters.filter((c) => c.buyer_improvement_comparable).length,
      buyer_high_intent_or_accepted: rate(counters.filter((c) => c.reached_high_intent_or_accepted).length, nc),
      resolution,
      buyer_ghosted: rate(resolution.BUYER_GHOSTED, nc),
      buyer_declined: rate(resolution.BUYER_DECLINED, nc),
      we_declined: rate(resolution.WE_DECLINED, nc),
      unresolved_count: resolution.UNRESOLVED,
      evidence_strength: evidenceStrength(nc),
    },
    counter_size_buckets: {
      definition: 'counter_increase_vs_buyer_offer_pct = (our cash counter − buyer cash offer) / buyer cash offer × 100, cash-only proposals with a positive buyer amount. Historical descriptive rates per bucket — not acceptance probabilities.',
      numeric_counter_analysis_eligible: numeric.length,
      numeric_counter_analysis_missing: nc - numeric.length,
      missing_reasons: missingReasons,
      median_counter_increase_vs_buyer_offer_pct: median(numeric.map((c) => c.counter_increase_vs_buyer_offer_pct!)),
      buckets: COUNTER_SIZE_BUCKETS.map(({ bucket }) => {
        const cs = numeric.filter((c) => c.counter_size_bucket === bucket);
        const n = cs.length;
        return {
          bucket,
          sample_size: n,
          buyer_reply: rate(cs.filter((c) => c.buyer_replied).length, n),
          buyer_improved: rate(cs.filter((c) => c.buyer_improved).length, n),
          high_intent: rate(cs.filter((c) => c.reached_high_intent_or_accepted).length, n),
          conversion: rate(cs.filter((c) => c.lead_converted).length, n),
          ghosted: rate(cs.filter((c) => c.resolution === 'BUYER_GHOSTED').length, n),
          evidence_strength: evidenceStrength(n),
        };
      }),
      evidence_strength: evidenceStrength(numeric.length),
    },
    ask_context: {
      definition: 'Gap vs the asking price in effect on that date for the lead\'s item on the lead\'s channel (from listing price history): (value − ask) / ask × 100.',
      counters_with_ask_known: askKnown.length,
      counters_with_ask_unavailable: nc - askKnown.length,
      unavailable_reasons: askUnavailable,
      median_buyer_offer_gap_vs_ask_pct: median(askKnown.map((c) => c.buyer_offer_gap_vs_ask_pct).filter((v): v is number => v != null)),
      median_our_counter_gap_vs_ask_pct: median(askKnown.map((c) => c.our_counter_gap_vs_ask_pct!)),
      buyer_cash_offers_with_ask_known: buyerCashGaps.length,
      median_buyer_cash_offer_gap_vs_ask_pct: median(buyerCashGaps),
      counters_with_trade_state_known: counters.filter((c) => c.listing_trade_enabled_at_time != null).length,
      counters_on_trade_enabled_listing: counters.filter((c) => c.listing_trade_enabled_at_time === true).length,
    },
    comparison: null,
    drilldown: {
      population_filter: { peak_stage_in: [...NEGOTIATING_PLUS_STAGES], first_contact_from: period?.start_date ?? null, first_contact_to: period?.end_date ?? null },
      counters,
    },
    limitations: [...NEGOTIATION_LIMITATIONS],
  };

  if (period && opts.comparisonPeriod) {
    const prev = buildNegotiationAnalytics(inputs, { period: opts.comparisonPeriod });
    result.comparison = compareNegotiationResults(result, prev);
  }
  return result;
}

// ── Comparison ──────────────────────────────────────────────────────────────

function compareMetric(metric: string, current: RateMetric, comparison: RateMetric): NegotiationComparisonMetric {
  const diff = current.rate_pct != null && comparison.rate_pct != null ? round1(current.rate_pct - comparison.rate_pct) : null;
  const strength = weakerStrength(current.evidence_strength, comparison.evidence_strength);
  return { metric, current, comparison, difference_pp: diff, evidence_strength: strength, material: diff != null && strengthAtLeast(strength, 'low') && Math.abs(diff) >= MATERIAL_DIFFERENCE_PP };
}

export function compareNegotiationResults(current: NegotiationAnalyticsResult, previous: NegotiationAnalyticsResult): NegotiationComparison {
  const p = (r: NegotiationAnalyticsResult) => ({ start_date: r.period.start_date ?? '', end_date: r.period.end_date ?? '', label: r.period.label, negotiating_count: r.funnel.negotiating_count, still_open_count: r.funnel.still_open_count });
  // Outcome shares and conversion are compared over RESOLVED leads: a recent period still has many OPEN leads,
  // so raw shares of all leads would differ for that reason alone.
  const st = (r: NegotiationAnalyticsResult, s: string) => r.outcomes.share_of_resolved[s];
  return {
    current_period: p(current),
    comparison_period: p(previous),
    metrics: [
      compareMetric('negotiating_to_high_intent', current.funnel.negotiating_to_high_intent, previous.funnel.negotiating_to_high_intent),
      compareMetric('negotiating_to_converted_resolved_only', current.funnel.negotiating_to_converted_resolved_only, previous.funnel.negotiating_to_converted_resolved_only),
      compareMetric('declined_by_me_share_of_resolved', st(current, 'DECLINED_BY_ME'), st(previous, 'DECLINED_BY_ME')),
      compareMetric('declined_by_them_share_of_resolved', st(current, 'DECLINED_BY_THEM'), st(previous, 'DECLINED_BY_THEM')),
      compareMetric('ghosted_share_of_resolved', st(current, 'GHOSTED'), st(previous, 'GHOSTED')),
      compareMetric('closed_item_unavailable_share_of_resolved', st(current, 'CLOSED'), st(previous, 'CLOSED')),
      compareMetric('counter_buyer_replied', current.counter_behavior.buyer_replied, previous.counter_behavior.buyer_replied),
      compareMetric('counter_buyer_improved', current.counter_behavior.buyer_improved, previous.counter_behavior.buyer_improved),
    ],
  };
}

// ── Server loader (fixed number of queries, no per-lead round trips) ────────

const PAGE = 1000;

async function selectAll<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, label: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Loads one user's negotiation inputs: item_leads, non-voided lead_events,
 * item_listings, item_listing_price_history and deal_channels — five bulk
 * reads (paged), never one per lead. Works with a service client (filtered by
 * appUserId) or a user client (RLS already scopes; the filter is harmless).
 */
export async function loadNegotiationAnalyticsInputs(params: { client: SupabaseClient; appUserId: number }): Promise<NegotiationAnalyticsInputs> {
  const { client, appUserId } = params;
  const [leads, events, listings, history, channels] = await Promise.all([
    selectAll<Record<string, unknown>>((f, t) => client.from('item_leads')
      .select('id, inventory_item_id, deal_channel_id, first_contact_at, peak_stage, peak_stage_source, status, outcome_reason, offer_type, origin')
      .eq('user_id', appUserId).order('id').range(f, t), 'item_leads'),
    selectAll<Record<string, unknown>>((f, t) => client.from('lead_events')
      .select('id, item_lead_id, event_type, direction, occurred_at, message_count, expects_reply, payload')
      .eq('user_id', appUserId).is('voided_at', null).order('id').range(f, t), 'lead_events'),
    selectAll<Record<string, unknown>>((f, t) => client.from('item_listings')
      .select('id, inventory_item_id, deal_channel_id, status, asking_price, trade_enabled, listed_at, ended_at, created_at')
      .eq('user_id', appUserId).order('id').range(f, t), 'item_listings'),
    selectAll<Record<string, unknown>>((f, t) => client.from('item_listing_price_history')
      .select('item_listing_id, old_asking_price, new_asking_price, old_trade_enabled, new_trade_enabled, changed_at')
      .eq('user_id', appUserId).order('id').range(f, t), 'item_listing_price_history'),
    selectAll<{ id: number; name: string }>((f, t) => client.from('deal_channels').select('id, name').order('id').range(f, t), 'deal_channels'),
  ]);

  return {
    leads: leads.map((r) => ({
      id: Number(r.id), inventory_item_id: Number(r.inventory_item_id), deal_channel_id: num(r.deal_channel_id),
      first_contact_at: (r.first_contact_at as string | null) ?? null, peak_stage: (r.peak_stage as string | null) ?? null,
      peak_stage_source: (r.peak_stage_source as string | null) ?? null, status: r.status as string,
      outcome_reason: (r.outcome_reason as string | null) ?? null, offer_type: r.offer_type as string, origin: (r.origin as string) ?? 'SHEET',
    })),
    events: events.map((r) => ({
      id: Number(r.id), item_lead_id: Number(r.item_lead_id), event_type: r.event_type as string,
      direction: r.direction as NegotiationEventInput['direction'], occurred_at: r.occurred_at as string,
      message_count: Number(r.message_count ?? 0), expects_reply: !!r.expects_reply, payload: (r.payload as Record<string, unknown>) ?? {},
    })),
    listings: listings.map((r) => ({
      id: Number(r.id), inventory_item_id: Number(r.inventory_item_id), deal_channel_id: num(r.deal_channel_id), status: r.status as string,
      asking_price: num(r.asking_price), trade_enabled: !!r.trade_enabled, listed_at: (r.listed_at as string | null) ?? null,
      ended_at: (r.ended_at as string | null) ?? null, created_at: r.created_at as string,
    })),
    priceHistory: history.map((r) => ({
      item_listing_id: Number(r.item_listing_id), old_asking_price: num(r.old_asking_price), new_asking_price: num(r.new_asking_price),
      old_trade_enabled: (r.old_trade_enabled as boolean | null) ?? null, new_trade_enabled: (r.new_trade_enabled as boolean | null) ?? null,
      changed_at: r.changed_at as string,
    })),
    channelNameById: new Map(channels.map((c) => [Number(c.id), c.name])),
  };
}
