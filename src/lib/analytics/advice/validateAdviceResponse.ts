// Auditable AI Advice v1.0 — response validation. Pure functions only.
// Applied AFTER OpenAI returns, independent of (never trusting) the system
// prompt's own instructions — every rule here is re-enforced server-side.
// A response that fails any hard rule is rejected in full: this module
// never silently edits/strips an otherwise-invalid response into a
// "cleaned up" version and presents it as what the model said — auditors
// must be able to trust that a saved, completed advice row is exactly and
// only what passed every check.

import type {
  AdviceCard,
  AdviceCardType,
  AdviceConfidenceLabel,
  AdvicePriority,
  AdviceRunSummary,
  SourceRegistryEntry,
  StructuredAdviceResponse,
} from './types';
import { ADVICE_SCHEMA_VERSION, MAX_ADVICE_CARDS } from './types';
import { collectStrings, findLeadDealViolations } from './sharedSemantics';

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

const ADVICE_TYPES: readonly AdviceCardType[] = ['action', 'observation', 'watch', 'review'];
const PRIORITIES: readonly AdvicePriority[] = ['high', 'medium', 'low'];
const CONFIDENCE_LABELS: readonly AdviceConfidenceLabel[] = ['stronger', 'moderate', 'low', 'preliminary'];

export interface ValidateAdviceResponseResult {
  valid: boolean;
  response: StructuredAdviceResponse | null;
  /** Machine-readable reasons — always populated when valid is false, so a
   *  failed generation's error_code/error_message can be specific rather
   *  than a generic "invalid response". */
  reasons: string[];
}

/**
 * Validates raw JSON text against the structured advice shape AND against
 * the closed source registry for this run. Never throws — a parse failure
 * or any rule violation is reported via `reasons`, never an exception.
 */
export function validateAdviceResponse(rawJson: string, sourceRegistry: SourceRegistryEntry[]): ValidateAdviceResponseResult {
  const reasons: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { valid: false, response: null, reasons: ['RESPONSE_NOT_VALID_JSON'] };
  }

  const root = toRecord(parsed);
  if (!root) return { valid: false, response: null, reasons: ['RESPONSE_NOT_AN_OBJECT'] };

  if (root.schema_version !== ADVICE_SCHEMA_VERSION) reasons.push('SCHEMA_VERSION_MISMATCH');

  const runSummaryRecord = toRecord(root.run_summary);
  if (!runSummaryRecord) reasons.push('RUN_SUMMARY_MISSING_OR_MALFORMED');

  const limitations = toStringArray(root.limitations);
  if (limitations === null) reasons.push('LIMITATIONS_MISSING_OR_MALFORMED');

  if (!Array.isArray(root.advice_cards)) {
    reasons.push('ADVICE_CARDS_MISSING_OR_NOT_AN_ARRAY');
  } else if (root.advice_cards.length > MAX_ADVICE_CARDS) {
    reasons.push('ADVICE_CARDS_EXCEEDS_MAXIMUM');
  }

  if (reasons.length > 0) return { valid: false, response: null, reasons };

  const allowedSourceIds = new Set(sourceRegistry.map((s) => s.source_id));
  const itemIdBySourceId = new Map<string, number>();
  for (const s of sourceRegistry) {
    if (s.item_id !== null) itemIdBySourceId.set(s.source_id, s.item_id);
  }

  // ── run_summary ──────────────────────────────────────────────────────
  const runSummaryHeadline = runSummaryRecord!.headline;
  const runSummarySummary = runSummaryRecord!.summary;
  const runSummarySourceIdsRaw = toStringArray(runSummaryRecord!.source_ids);
  if (typeof runSummaryHeadline !== 'string' || typeof runSummarySummary !== 'string' || runSummarySourceIdsRaw === null) {
    return { valid: false, response: null, reasons: ['RUN_SUMMARY_FIELDS_MALFORMED'] };
  }
  for (const id of runSummarySourceIdsRaw) {
    if (!allowedSourceIds.has(id)) return { valid: false, response: null, reasons: ['RUN_SUMMARY_CITES_UNKNOWN_SOURCE_ID'] };
  }
  // Duplicate source IDs are normalized (deduped), never rejected outright.
  const runSummary: AdviceRunSummary = {
    headline: runSummaryHeadline,
    summary: runSummarySummary,
    source_ids: Array.from(new Set(runSummarySourceIdsRaw)),
  };

  // ── advice_cards ─────────────────────────────────────────────────────
  const rawCards = root.advice_cards as unknown[];
  const cards: AdviceCard[] = [];

  for (let i = 0; i < rawCards.length; i++) {
    const c = toRecord(rawCards[i]);
    if (!c) return { valid: false, response: null, reasons: [`ADVICE_CARD_${i}_NOT_AN_OBJECT`] };

    const adviceCode = c.advice_code;
    const adviceType = c.advice_type;
    const priority = c.priority;
    const headline = c.headline;
    const advice = c.advice;
    const whyItMatters = c.why_it_matters;
    const confidenceLabel = c.confidence_label;
    const cardSourceIdsRaw = toStringArray(c.source_ids);
    const cardLimitations = toStringArray(c.limitations);
    const itemId = c.item_id;

    if (
      typeof adviceCode !== 'string' ||
      !ADVICE_TYPES.includes(adviceType as AdviceCardType) ||
      !PRIORITIES.includes(priority as AdvicePriority) ||
      typeof headline !== 'string' ||
      typeof advice !== 'string' ||
      typeof whyItMatters !== 'string' ||
      !CONFIDENCE_LABELS.includes(confidenceLabel as AdviceConfidenceLabel) ||
      cardSourceIdsRaw === null ||
      cardLimitations === null ||
      !(itemId === null || typeof itemId === 'number')
    ) {
      return { valid: false, response: null, reasons: [`ADVICE_CARD_${i}_FIELDS_MALFORMED`] };
    }

    // "Every substantive advice card must cite at least one allowed source
    // ID" — an empty array is a hard rejection, not silently dropped.
    if (cardSourceIdsRaw.length === 0) {
      return { valid: false, response: null, reasons: [`ADVICE_CARD_${i}_HAS_NO_SOURCES`] };
    }

    const dedupedSourceIds = Array.from(new Set(cardSourceIdsRaw));
    for (const id of dedupedSourceIds) {
      if (!allowedSourceIds.has(id)) {
        return { valid: false, response: null, reasons: [`ADVICE_CARD_${i}_CITES_UNKNOWN_SOURCE_ID`, id] };
      }
    }

    // "reject references to absent items" — a non-null item_id must be
    // justified by one of THIS card's own cited sources actually carrying
    // that item_id (never any item elsewhere in the run).
    if (itemId !== null) {
      const justified = dedupedSourceIds.some((id) => itemIdBySourceId.get(id) === itemId);
      if (!justified) {
        return { valid: false, response: null, reasons: [`ADVICE_CARD_${i}_REFERENCES_ABSENT_ITEM`] };
      }
    }

    cards.push({
      advice_code: adviceCode,
      advice_type: adviceType as AdviceCardType,
      priority: priority as AdvicePriority,
      headline,
      advice,
      why_it_matters: whyItMatters,
      confidence_label: confidenceLabel as AdviceConfidenceLabel,
      source_ids: dedupedSourceIds,
      limitations: cardLimitations,
      item_id: itemId,
    });
  }

  const response: StructuredAdviceResponse = {
    schema_version: '1.0',
    run_summary: runSummary,
    advice_cards: cards,
    limitations: limitations!,
  };

  // Canonical Lead -> Deal linkage exists only where item_leads.deal_id is
  // populated (linked_deal_analytics, `linked_deal:*` source ids). A
  // CONVERSION_CLAIM is only excused when the unit of text making it (a
  // card, or the run summary) cites at least one `linked_deal:*` source —
  // otherwise it is exactly the same unlinked/inferred claim this guard has
  // always rejected (e.g. comparing raw leads against realized_deal_count).
  // LEAD_DEAL_GAP_EXPLAINED stays unconditionally rejected regardless of
  // citations — linkage doesn't license inventing a CAUSE for the gap.
  // Listing Advice's own guard (listingAdvice.ts) is untouched: its packet
  // never carries linked_deal_analytics, so it can never satisfy this
  // citation requirement and a conversion claim there is still always
  // rejected outright.
  const globalReasons = new Set<string>();

  const isLinkedDealSource = (id: string) => id.startsWith('linked_deal:');

  const checkUnit = (texts: string[], sourceIds: string[]) => {
    const violations = new Set(texts.flatMap((t) => findLeadDealViolations(t)));
    if (violations.has('LEAD_DEAL_GAP_EXPLAINED')) globalReasons.add('LEAD_DEAL_LEAD_DEAL_GAP_EXPLAINED');
    if (violations.has('CONVERSION_CLAIM') && !sourceIds.some(isLinkedDealSource)) {
      globalReasons.add('LEAD_DEAL_CONVERSION_CLAIM');
    }
  };

  checkUnit(collectStrings({ headline: runSummary.headline, summary: runSummary.summary }), runSummary.source_ids);
  for (const c of cards) {
    checkUnit(collectStrings({ headline: c.headline, advice: c.advice, why: c.why_it_matters, limitations: c.limitations }), c.source_ids);
  }
  // Top-level response.limitations carries no source_ids of its own — never
  // excused by any citation.
  checkUnit(collectStrings(response.limitations), []);

  if (globalReasons.size > 0) {
    return { valid: false, response: null, reasons: Array.from(globalReasons) };
  }

  return { valid: true, response, reasons: [] };
}
