// Listing Advice — types, deterministic input packet, and response validation.
// Pure (no I/O): importable from plain Node tests. The generation lifecycle
// lives in generateListingAdvice.ts.
//
// Reuses (does not reimplement): the compact 4-week Listing Demand context
// and its citable source ids (advice/listingDemandContext.ts), canonical
// hashing (advice/canonicalHash.ts), and the shared lead/deal guard
// (advice/sharedSemantics.ts). The packet contains ONLY that context —
// never raw leads, lead ids, notes, offers or sheet content.

import { hashCanonicalInputPacket } from '../advice/canonicalHash';
import { buildListingDemandSources, type ListingDemandContext } from '../advice/listingDemandContext';
import { collectStrings, findLeadDealViolations } from '../advice/sharedSemantics';
import { DEFAULT_ADVICE_LANGUAGE, type AdviceLanguage } from '../advice/adviceLanguage';

export const LISTING_ADVICE_SCHEMA_VERSION = '1.0';
export const LISTING_ADVICE_PROMPT_VERSION = 'listing-advice-v1';
export const LISTING_ADVICE_PROVIDER = 'openai';
export const MAX_LISTING_ADVICE_CARDS = 3;
export const MAX_NEXT_STEPS = 3;

export type ListingAdviceType = 'action' | 'observation' | 'watch';
export type ListingAdvicePriority = 'high' | 'medium' | 'low';
export type ListingAdviceConfidence = 'stronger' | 'moderate' | 'low' | 'preliminary';

export const LISTING_ADVICE_TYPES: readonly ListingAdviceType[] = ['action', 'observation', 'watch'];
export const LISTING_ADVICE_PRIORITIES: readonly ListingAdvicePriority[] = ['high', 'medium', 'low'];
export const LISTING_ADVICE_CONFIDENCES: readonly ListingAdviceConfidence[] = ['stronger', 'moderate', 'low', 'preliminary'];

export interface ListingAdviceCard {
  advice_code: string;
  advice_type: ListingAdviceType;
  priority: ListingAdvicePriority;
  confidence_label: ListingAdviceConfidence;
  title: string;
  summary: string;
  why_it_matters: string;
  next_steps: string[];
  source_ids: string[];
  limitations: string[];
}

export interface ListingAdviceOutput {
  schema_version: typeof LISTING_ADVICE_SCHEMA_VERSION;
  cards: ListingAdviceCard[];
}

export interface ListingAdvicePacket {
  packet_version: '1.0';
  kind: 'listing_advice';
  window: { start_date: string; end_date: string; weeks: number };
  listing_demand: ListingDemandContext;
  /** Requested advice language (user's preferred_language at generation). Hashed + persisted with the run. */
  language: AdviceLanguage;
  semantics: {
    lead_deal_linkage: string;
    demand_evidence_purpose_agnostic: boolean;
    lead_quality: string;
  };
  allowed_source_ids: string[];
}

export const LISTING_ADVICE_SEMANTICS = {
  lead_deal_linkage: 'No canonical lead_id -> deal_id linkage exists; realized deals are factual Sell/Trade activity and conversion cannot be calculated.',
  demand_evidence_purpose_agnostic: true,
  lead_quality: 'lead_quality is the highest intent level ever reached; Serious+ means SERIOUS or HIGH_INTENT.',
} as const;

/** Deterministic packet from the shared compact context — same input, same bytes, same hash. */
export function buildListingAdvicePacket(ctx: ListingDemandContext, language: AdviceLanguage = DEFAULT_ADVICE_LANGUAGE): ListingAdvicePacket {
  return {
    packet_version: '1.0',
    kind: 'listing_advice',
    window: { start_date: ctx.start_date, end_date: ctx.end_date, weeks: ctx.window_weeks },
    listing_demand: ctx,
    language,
    semantics: { ...LISTING_ADVICE_SEMANTICS },
    allowed_source_ids: buildListingDemandSources(ctx).map((s) => s.source_id),
  };
}

export function hashListingAdvicePacket(packet: ListingAdvicePacket): string {
  return hashCanonicalInputPacket(packet);
}

// ── Response validation ───────────────────────────────────────────────────

export interface ValidateListingAdviceResult {
  valid: boolean;
  output: ListingAdviceOutput | null;
  reasons: string[];
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function strArr(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}
const fail = (...reasons: string[]): ValidateListingAdviceResult => ({ valid: false, output: null, reasons });

/**
 * Validates raw model JSON against the strict card shape AND the packet's
 * closed source list. Rejects in full (never edits) on any violation,
 * including unsupported evidence (unknown/absent source ids) and any
 * asserted lead/deal conversion. Never throws.
 */
export function validateListingAdviceResponse(rawJson: string, allowedSourceIds: readonly string[]): ValidateListingAdviceResult {
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); } catch { return fail('RESPONSE_NOT_VALID_JSON'); }
  const root = rec(parsed);
  if (!root) return fail('RESPONSE_NOT_AN_OBJECT');
  if (root.schema_version !== LISTING_ADVICE_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH');
  if (!Array.isArray(root.cards)) return fail('CARDS_MISSING_OR_NOT_AN_ARRAY');
  if (root.cards.length > MAX_LISTING_ADVICE_CARDS) return fail('CARDS_EXCEEDS_MAXIMUM');

  const allowed = new Set(allowedSourceIds);
  const cards: ListingAdviceCard[] = [];

  for (let i = 0; i < root.cards.length; i++) {
    const c = rec(root.cards[i]);
    if (!c) return fail(`CARD_${i}_NOT_AN_OBJECT`);
    const sourceIds = strArr(c.source_ids);
    const nextSteps = strArr(c.next_steps);
    const limitations = strArr(c.limitations);
    if (
      typeof c.advice_code !== 'string' || c.advice_code.trim() === ''
      || !LISTING_ADVICE_TYPES.includes(c.advice_type as ListingAdviceType)
      || !LISTING_ADVICE_PRIORITIES.includes(c.priority as ListingAdvicePriority)
      || !LISTING_ADVICE_CONFIDENCES.includes(c.confidence_label as ListingAdviceConfidence)
      || typeof c.title !== 'string' || c.title.trim() === ''
      || typeof c.summary !== 'string' || c.summary.trim() === ''
      || typeof c.why_it_matters !== 'string' || c.why_it_matters.trim() === ''
      || sourceIds === null || nextSteps === null || limitations === null
    ) return fail(`CARD_${i}_FIELDS_MALFORMED`);
    if (nextSteps.length > MAX_NEXT_STEPS) return fail(`CARD_${i}_TOO_MANY_NEXT_STEPS`);
    if (sourceIds.length === 0) return fail(`CARD_${i}_HAS_NO_SOURCES`);

    const deduped = Array.from(new Set(sourceIds));
    for (const id of deduped) {
      if (!allowed.has(id)) return fail(`CARD_${i}_CITES_UNKNOWN_SOURCE_ID`, id);
    }
    cards.push({
      advice_code: c.advice_code,
      advice_type: c.advice_type as ListingAdviceType,
      priority: c.priority as ListingAdvicePriority,
      confidence_label: c.confidence_label as ListingAdviceConfidence,
      title: c.title,
      summary: c.summary,
      why_it_matters: c.why_it_matters,
      next_steps: nextSteps,
      source_ids: deduped,
      limitations,
    });
  }

  // No asserted lead->deal conversion / unsupported gap explanation anywhere in the prose.
  const violations = new Set(collectStrings(cards.map((c) => ({ t: c.title, s: c.summary, w: c.why_it_matters, n: c.next_steps, l: c.limitations }))).flatMap((t) => findLeadDealViolations(t)));
  if (violations.size > 0) return fail(...Array.from(violations).map((v) => `LEAD_DEAL_${v}`));

  return { valid: true, output: { schema_version: LISTING_ADVICE_SCHEMA_VERSION, cards }, reasons: [] };
}
