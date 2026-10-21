// Guitar Tracker lead domain semantics — the single source of truth for the
// vocabulary shared by the UI, analytics, the MCP tool descriptions, the
// direct-write service and AI/coaching prompts.
//
// Universal domain rules only. User-specific preferences (quiet threshold,
// follow-up timing, floors/targets, negotiation style) are NOT here — they
// are passed into the read-time helpers in classification.ts as parameters.
//
// SQL enforces the same vocabularies as CHECK constraints
// (supabase/migrations/20261021000000_lead_events_direct_writes.sql) but
// never re-implements the classification rules below.

/** Bump when a derivation rule in classification.ts changes meaning. Stored on item_leads.semantics_version. */
export const SEMANTICS_VERSION = 1;

// ── Peak stage ──────────────────────────────────────────────────────────────

export const LEAD_STAGES = ['INQUIRY', 'ENGAGED', 'NEGOTIATING', 'HIGH_INTENT', 'CONVERTED'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_RANK: Record<LeadStage, number> = { INQUIRY: 1, ENGAGED: 2, NEGOTIATING: 3, HIGH_INTENT: 4, CONVERTED: 5 };

export const STAGE_DEFINITIONS: Record<LeadStage, string> = {
  INQUIRY: 'Basic contact without substance: availability, simple price or spec question, "trade?", commentary.',
  ENGAGED: 'Substantive interaction without a concrete economic proposal: detailed/condition questions, photos or info exchanged, a named trade item with open terms ("PRS + how much cash?"), a viewing request without agreed terms.',
  NEGOTIATING: 'A concrete economic proposal exists: an INBOUND buyer offer with a cash number, an explicit straight trade for specific item(s), or specific item(s) + a stated cash amount — OR our concrete OUTBOUND ask/counter that the buyer actually engaged with. Offer attractiveness never matters.',
  HIGH_INTENT: 'Execution is underway: terms accepted (AGREEMENT), or a confirmed/done execution step — payment or order initiated, or a meetup time / hold / address / shipping tied to accepted terms, or a pickup at asking price with an agreed time.',
  CONVERTED: 'A completed transaction (status COMPLETED with a valid linked deal, or a legacy COMPLETED lead).',
};

export const STAGE_SOURCES = ['DERIVED', 'LEGACY_AUDIT', 'LEGACY_STRUCTURED'] as const;
export type StageSource = (typeof STAGE_SOURCES)[number];

export const STAGE_SOURCE_DEFINITIONS: Record<StageSource, string> = {
  DERIVED: 'Computed by Guitar Tracker from recorded lead events.',
  LEGACY_AUDIT: 'Historical stage assigned by the 2026-10-21 read-only classification audit (AI judgement from structured fields + notes, not individually user-reviewed).',
  LEGACY_STRUCTURED: 'Historical stage computed only from the legacy structured fields (status, offer type, message counts) — no notes, no events.',
};

/** Negotiating+ replaces the legacy "Serious+" (SERIOUS + HIGH_INTENT) concept. */
export const NEGOTIATING_PLUS_STAGES: readonly LeadStage[] = ['NEGOTIATING', 'HIGH_INTENT', 'CONVERTED'];
export const HIGH_INTENT_PLUS_STAGES: readonly LeadStage[] = ['HIGH_INTENT', 'CONVERTED'];

// ── Status / outcome ────────────────────────────────────────────────────────

export const LEAD_STATUSES = ['OPEN', 'AGREED', 'COMPLETED', 'FAILED_AFTER_AGREEMENT', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'GHOSTED', 'CLOSED'] as const;
export type LeadStatusValue = (typeof LEAD_STATUSES)[number];

export const STATUS_DEFINITIONS: Record<LeadStatusValue, string> = {
  OPEN: 'Active; no outcome yet.',
  AGREED: 'Terms accepted, transaction not yet completed.',
  COMPLETED: 'Transaction completed (direct writes require a valid linked deal).',
  FAILED_AFTER_AGREEMENT: 'Agreed, then fell through. Final.',
  DECLINED_BY_ME: 'We ended it. Reopens automatically if the buyer returns.',
  DECLINED_BY_THEM: 'The buyer ended it. Reopens automatically if the buyer returns.',
  GHOSTED: 'The buyer stopped responding after a pending ask from us AND either a follow-up went unanswered or a committed step was missed. Never set because days passed.',
  CLOSED: 'Neutral close — neither side declined. ITEM_UNAVAILABLE (item left inventory via another deal; final) or INACTIVE (closed as stale; reopenable).',
};

export const OUTCOME_REASONS = [
  'LOW_OFFER', 'TRADE_NOT_INTERESTING', 'PRICE', 'CONDITION', 'LOGISTICS', 'NO_SHOW', 'CHANGED_MIND', 'FOUND_ANOTHER', 'UNKNOWN',
  'ITEM_UNAVAILABLE', 'INACTIVE',
] as const;
export type OutcomeReasonValue = (typeof OUTCOME_REASONS)[number];

/** Statuses a returning buyer reopens automatically (inbound event → OPEN). */
export const REOPENABLE_STATUSES: readonly LeadStatusValue[] = ['GHOSTED', 'DECLINED_BY_ME', 'DECLINED_BY_THEM'];
/** CLOSED is reopenable only with outcome INACTIVE (ITEM_UNAVAILABLE is final). */
export function isReopenable(status: string, outcome: string | null): boolean {
  return (REOPENABLE_STATUSES as readonly string[]).includes(status) || (status === 'CLOSED' && outcome === 'INACTIVE');
}
export function isFinal(status: string, outcome: string | null): boolean {
  return status === 'COMPLETED' || status === 'FAILED_AFTER_AGREEMENT' || (status === 'CLOSED' && outcome === 'ITEM_UNAVAILABLE');
}
export function isTerminal(status: string): boolean {
  return status !== 'OPEN' && status !== 'AGREED';
}

/** Outcome reasons allowed per status for NEW writes (legacy rows are not re-validated). */
export function outcomeAllowedFor(status: LeadStatusValue, outcome: OutcomeReasonValue | null): boolean {
  if (status === 'CLOSED') return outcome === 'ITEM_UNAVAILABLE' || outcome === 'INACTIVE';
  if (outcome === 'ITEM_UNAVAILABLE' || outcome === 'INACTIVE') return false;
  if (outcome === 'FOUND_ANOTHER') return status === 'DECLINED_BY_THEM';
  if (status === 'OPEN' || status === 'AGREED' || status === 'COMPLETED') return outcome === null;
  return true;
}

// ── Events ──────────────────────────────────────────────────────────────────

export const EVENT_TYPES = ['MESSAGE', 'OFFER', 'AGREEMENT', 'LOGISTICS', 'STATUS_CHANGE', 'DEAL_LINKED', 'NOTE', 'LEGACY_SNAPSHOT'] as const;
export type LeadEventType = (typeof EVENT_TYPES)[number];
/** Event types an agent may submit through MCP (LEGACY_SNAPSHOT is backfill/system only). */
export const AGENT_EVENT_TYPES = ['MESSAGE', 'OFFER', 'AGREEMENT', 'LOGISTICS', 'STATUS_CHANGE', 'DEAL_LINKED', 'NOTE'] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const EVENT_DIRECTIONS = ['INBOUND', 'OUTBOUND', 'INTERNAL'] as const;
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];

export const EVENT_TYPE_DEFINITIONS: Record<LeadEventType, string> = {
  MESSAGE: 'INBOUND/OUTBOUND conversation without new economic terms: questions, info, photos/evidence, viewing requests, follow-ups. payload: { substance: BASIC|SUBSTANTIVE, follow_up?: bool, evidence?: [PHOTOS|SERIAL|COA|VIDEO], responds_to_offer?: bool }.',
  OFFER: 'An economic position. INBOUND = buyer offer or revision; OUTBOUND = our ask or counter. payload: { offer: { cash_terms: AMOUNT|STRAIGHT|OPEN, cash_amount, items: [{ description, est_value? }], summary }, ready_to_execute?: bool, assessment?: ACCEPTABLE|NEAR|FAR_BELOW|NOT_RELEVANT, our_estimate?: number }.',
  AGREEMENT: 'Terms accepted. INBOUND = buyer accepted our terms; OUTBOUND = we accepted theirs; INTERNAL = both confirmed. payload: { terms?: offer, accepted_by?: BUYER|US|BOTH }.',
  LOGISTICS: 'Execution step. payload: { kind: MEETUP|HOLD|ADDRESS|SHIPPING|PAYMENT|ORDER, state: PROPOSED|CONFIRMED|DONE|MISSED|CANCELLED, scheduled_for?, at_asking_price?: bool, reference? }.',
  STATUS_CHANGE: 'Status/outcome transition. payload: { to, outcome_reason? } (server fills from/trigger).',
  DEAL_LINKED: 'Links the completed Guitar Tracker deal (operation) that realized this lead. payload: { deal_id }.',
  NOTE: 'Internal information that fits no other type: our valuation, research, observation. payload: { topic?: VALUATION|RESEARCH|CONDITION|OTHER, our_estimate?, assessment?, urls? }.',
  LEGACY_SNAPSHOT: 'Baseline of the pre-event legacy state (backfill/system only, never from MCP).',
};

export const MESSAGE_SUBSTANCE = ['BASIC', 'SUBSTANTIVE'] as const;
export const EVIDENCE_KINDS = ['PHOTOS', 'SERIAL', 'COA', 'VIDEO'] as const;
export const CASH_TERMS = ['AMOUNT', 'STRAIGHT', 'OPEN'] as const;
export type CashTerms = (typeof CASH_TERMS)[number];
export const LOGISTICS_KINDS = ['MEETUP', 'HOLD', 'ADDRESS', 'SHIPPING', 'PAYMENT', 'ORDER'] as const;
export const LOGISTICS_STATES = ['PROPOSED', 'CONFIRMED', 'DONE', 'MISSED', 'CANCELLED'] as const;
export const NOTE_TOPICS = ['VALUATION', 'RESEARCH', 'CONDITION', 'OTHER'] as const;
export const EVENT_PROVENANCE = ['OBSERVED', 'STATED', 'INFERRED', 'LEGACY', 'SYSTEM'] as const;
export const EVENT_ACTORS = ['USER', 'AI', 'SYSTEM'] as const;
export const EVENT_SOURCES = ['MCP', 'UI', 'SYSTEM', 'BACKFILL'] as const;

// ── Offer assessment (never affects stage) ─────────────────────────────────

export const OFFER_ASSESSMENTS = ['ACCEPTABLE', 'NEAR', 'FAR_BELOW', 'NOT_RELEVANT'] as const;
export type OfferAssessment = (typeof OFFER_ASSESSMENTS)[number];
export const OFFER_ASSESSMENT_SOURCES = ['USER', 'AI', 'COMPUTED'] as const;
export const OFFER_ASSESSMENT_DEFINITIONS: Record<OfferAssessment, string> = {
  ACCEPTABLE: 'The latest buyer offer is at or above what we would accept.',
  NEAR: 'Close to acceptable; a small gap remains.',
  FAR_BELOW: 'Far below what we would accept (lowball).',
  NOT_RELEVANT: 'Not a usable offer for us (e.g. non-music item, unwanted category).',
};

// ── Channels ────────────────────────────────────────────────────────────────

/** Channel values accepted by direct writes. 'Regular Buyer/Seller' maps to the deal_channels row 'Regular Buyer / Seller'. */
export const LEAD_CHANNELS = ['Marketplace', 'Kijiji', 'Reverb', 'Regular Buyer/Seller', 'Other'] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];
/** Channels that may carry channel_detail (e.g. Other / Instagram, Regular Buyer/Seller / SMS). */
export const DETAIL_CHANNELS: readonly LeadChannel[] = ['Other', 'Regular Buyer/Seller'];
/** deal_channels.name for each direct-write channel ('Other' has no deal_channels row). */
export const CHANNEL_DB_NAME: Record<LeadChannel, string> = {
  Marketplace: 'Marketplace', Kijiji: 'Kijiji', Reverb: 'Reverb', 'Regular Buyer/Seller': 'Regular Buyer / Seller', Other: 'Other',
};

// ── Responsiveness ──────────────────────────────────────────────────────────

export const WAITING_ON = ['BUYER', 'US', 'NONE'] as const;
export type WaitingOn = (typeof WAITING_ON)[number];
export const RESPONSIVENESS_LABELS = ['AWAITING_US', 'AWAITING_BUYER', 'QUIET'] as const;
export type ResponsivenessLabel = (typeof RESPONSIVENESS_LABELS)[number];
/** Default for the user preference "quiet after N days" (read-time only; never stored, never sets GHOSTED). */
export const DEFAULT_QUIET_AFTER_DAYS = 7;

export const RESPONSIVENESS_DEFINITIONS = {
  waiting_on: 'From the latest non-internal event: INBOUND with expects_reply → US; OUTBOUND with expects_reply → BUYER; otherwise NONE. Terminal status → NONE. NULL = unknown (legacy, no events).',
  unanswered_followups: 'Our OUTBOUND follow-ups (payload.follow_up) since the last INBOUND event.',
  reopen_count: 'Objective count of reopen transitions (a returning buyer reopened a declined/ghosted/inactive lead). Not a time-threshold metric.',
  quiet: 'Read-time label: OPEN and no event for at least the user\'s quiet threshold. Display only.',
};

// ── Prompt / tool rendering ─────────────────────────────────────────────────

/** Compact, human-readable rendering of the semantics for MCP tool descriptions and AI prompts. */
export function renderLeadSemanticsForPrompt(): string {
  const lines: string[] = [];
  lines.push('Lead semantics (Guitar Tracker, v' + SEMANTICS_VERSION + '):');
  lines.push('peak_stage = highest observable stage reached (never decreases except by voiding an event):');
  for (const s of LEAD_STAGES) lines.push(`- ${s}: ${STAGE_DEFINITIONS[s]}`);
  lines.push('Message volume alone never sets a stage; offer attractiveness (offer_assessment) never changes the stage.');
  lines.push('Negotiating+ = NEGOTIATING, HIGH_INTENT, CONVERTED (replaces legacy Serious+). High Intent+ = HIGH_INTENT, CONVERTED.');
  lines.push('status: ' + LEAD_STATUSES.map((s) => `${s} (${STATUS_DEFINITIONS[s]})`).join(' '));
  lines.push(`waiting_on: ${RESPONSIVENESS_DEFINITIONS.waiting_on}`);
  lines.push('Legacy lead_quality (LOW/ENGAGED/SERIOUS/HIGH_INTENT) is historical only; new direct-write leads have none.');
  return lines.join('\n');
}
