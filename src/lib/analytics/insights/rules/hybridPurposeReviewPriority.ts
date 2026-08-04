// Insights Engine v1.8 — Findings Selector rule: HYBRID_PURPOSE_REVIEW_
// PRIORITY. Pure functions only — no I/O, no Supabase client. Selects at
// most one CURRENT (open, not realized) Hybrid item whose behavior
// creates meaningful ambiguity between active Business realization,
// intentional Personal ownership, and a legitimate continued Hybrid
// position — by deterministically matching it against eight ordered
// priority profiles built from existing Open Inventory Decision Support
// reason codes. Never a weighted score, never an automatic Purpose
// change, never an implication that Hybrid is inherently wrong or
// temporary — the finding asks the user to confirm current intent.
//
// This is the second Purpose-scoped, item-level Insights rule (after
// BUSINESS_OPEN_INVENTORY_PRIORITY, v1.7) — target user's own item_id/
// item_display_name/basic classification only, never another user's
// item, never notes/serial number/counterparty/listing text/photo paths.
//
// Evidence shape consumed (Analytics v2.1's item_decision_evidence,
// unchanged through v2.11 for Hybrid rows except v2.2's HYBRID_RECENT_
// INSUFFICIENT_HISTORY -> HYBRID_RECENT_ITEM/HYBRID_INSUFFICIENT_
// OWNERSHIP_HISTORY split, plus Analytics v2.12 which added the two
// comparable-DOM codes this rule needed — see supabase/migrations/
// 20260812000000_build_analytics_snapshot_v2_1.sql,
// 20260813000000_build_analytics_snapshot_v2_2.sql, and
// 20260823000000_build_analytics_snapshot_v2_12.sql):
//   target_user_open_inventory_evidence.item_decision_evidence[] — one row
//   per OPEN item, ALL Purposes pooled at the source — this rule filters
//   to current_purpose_name = 'Hybrid' itself; it never reads
//   hybrid_purpose_review (a DIFFERENT section, built for a different
//   purpose — behavioral_signals/limitations shaped differently — this
//   rule reads ONLY item_decision_evidence, per this task's explicit
//   scope), never shared_open_inventory_evidence (no such section exists
//   — OIDS has no shared/pooled counterpart), never personal_inventory_
//   control, never another user's rows, and never AI-generated text.
//
// reason_codes are the REAL SQL-generated, Hybrid-prefixed strings —
// confirmed by direct inspection of the migrations above and live
// evidence. This rule NEVER uses the Business-prefixed codes (BUSINESS_
// DOM_ABOVE_COMPARABLE_P75/_MEDIAN, BUSINESS_UNLISTED_OPEN_ITEM,
// BUSINESS_OWNERSHIP_AGE_120_PLUS) and NEVER uses the generic Business/
// unclassified codes (HIGH_CAPITAL_EXPOSURE, LOW_ESTIMATED_UPSIDE_
// RELATIVE_TO_CAPITAL) — only the Hybrid-specific equivalents:
//   HYBRID_REVIEW_REQUIRED, HYBRID_LISTED_SIGNAL, HYBRID_UNLISTED_SIGNAL,
//   HYBRID_LONG_HOLD_SIGNAL, HYBRID_HIGH_CAPITAL_SIGNAL, HYBRID_LOW_
//   UPSIDE_SIGNAL, HYBRID_RECENT_ITEM, HYBRID_INSUFFICIENT_OWNERSHIP_
//   HISTORY, HYBRID_DOM_ABOVE_COMPARABLE_MEDIAN, HYBRID_DOM_ABOVE_
//   COMPARABLE_P75.
//
// item_decision_evidence rows carry NO `limitations` array of their own
// — only reason_codes. This finding's own `limitations` array is
// synthesized from applicable reason_codes/fields plus fixed required
// strings (see buildLimitations below).

import type {
  HybridOpenItemCandidate,
  HybridOpenItemCandidateEvaluation,
  HybridPurposeReviewPriorityFinding,
  HybridPurposeReviewPriorityProfile,
  HybridPurposeReviewRuleEvaluationResult,
} from '../types';
import { toRecord, toNumber, chainCompare } from '../comparisonHelpers';

export const FINDING_CODE = 'HYBRID_PURPOSE_REVIEW_PRIORITY';

// ── Evidence-vocabulary constants (real SQL-generated reason_codes) ─────
const HYBRID_DOM_ABOVE_COMPARABLE_P75 = 'HYBRID_DOM_ABOVE_COMPARABLE_P75';
const HYBRID_UNLISTED_SIGNAL = 'HYBRID_UNLISTED_SIGNAL';
const HYBRID_LONG_HOLD_SIGNAL = 'HYBRID_LONG_HOLD_SIGNAL';
const HYBRID_HIGH_CAPITAL_SIGNAL = 'HYBRID_HIGH_CAPITAL_SIGNAL';
const HYBRID_LOW_UPSIDE_SIGNAL = 'HYBRID_LOW_UPSIDE_SIGNAL';

// Data-quality/limitation codes — never independently actionable, only
// ever translated into this finding's own `limitations` output.
const LOW_COMPARABLE_CONFIDENCE = 'LOW_COMPARABLE_CONFIDENCE';
const PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE = 'PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE';
const HISTORICAL_AGE_UNRELIABLE = 'HISTORICAL_AGE_UNRELIABLE';
const HISTORICAL_ACQUISITION_DATE_UNRELIABLE_EVIDENCE_CODE = 'HISTORICAL_ACQUISITION_DATE_UNRELIABLE';
const ZERO_ASSIGNED_ACQUISITION_VALUE = 'ZERO_ASSIGNED_ACQUISITION_VALUE';

const ACTIONABLE_VOCABULARY = [
  HYBRID_DOM_ABOVE_COMPARABLE_P75,
  HYBRID_UNLISTED_SIGNAL,
  HYBRID_LONG_HOLD_SIGNAL,
  HYBRID_HIGH_CAPITAL_SIGNAL,
  HYBRID_LOW_UPSIDE_SIGNAL,
];

const PURPOSE_REVIEW_OPTIONS = ['KEEP_HYBRID', 'CHANGE_TO_BUSINESS', 'CHANGE_TO_PERSONAL'];

function toBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Reads target_user_open_inventory_evidence.item_decision_evidence only,
 * filtered to current_purpose_name === 'Hybrid' (this rule's entire
 * candidate pool — Business/Personal/unclassified items never appear
 * here and never receive a rule_evaluations row from this rule). Never
 * throws — malformed or missing evidence simply yields no candidates.
 */
export function extractHybridOpenItemCandidates(
  targetUserOpenInventoryEvidence: unknown,
): HybridOpenItemCandidate[] {
  const evidence = toRecord(targetUserOpenInventoryEvidence);
  const rows = Array.isArray(evidence?.item_decision_evidence)
    ? (evidence!.item_decision_evidence as unknown[])
    : [];

  const candidates: HybridOpenItemCandidate[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;
    if (r.current_purpose_name !== 'Hybrid') continue;

    const itemId = toNumber(r.item_id);
    if (itemId === null) continue;

    candidates.push({
      item_id: itemId,
      item_display_name: toStringOrNull(r.item_display_name),
      brand_name: toStringOrNull(r.brand_name),
      category_name: toStringOrNull(r.category_name),
      type_name: toStringOrNull(r.type_name),
      current_purpose_id: toNumber(r.current_purpose_id),
      current_purpose_name: toStringOrNull(r.current_purpose_name),
      disposition_mode: toStringOrNull(r.disposition_mode),
      active_realization_flag: toBoolean(r.active_realization_flag),
      realization_priority_order: toNumber(r.realization_priority_order),
      purpose_policy_status: toStringOrNull(r.purpose_policy_status),
      listed_flag: toBoolean(r.listed_flag) === true,
      current_dom_days: toNumber(r.current_dom_days),
      ownership_age_days: toNumber(r.ownership_age_days),
      acquisition_value: toNumber(r.acquisition_value),
      estimated_sold_value: toNumber(r.estimated_sold_value),
      estimated_net_upside: toNumber(r.estimated_net_upside),
      estimated_upside_percent: toNumber(r.estimated_upside_percent),
      open_capital_share_percent: toNumber(r.open_capital_share_percent),
      purpose_open_capital_share_percent: toNumber(r.purpose_open_capital_share_percent),
      listing_channel_names: toStringArray(r.listing_channel_names),
      reason_codes: toStringArray(r.reason_codes),
      is_historical_import: toBoolean(r.is_historical_import) === true,
      liquidity_cohort_match: toStringOrNull(r.liquidity_cohort_match),
      comparable_evidence_available: toBoolean(r.comparable_evidence_available) === true,
    });
  }

  return candidates;
}

// ── Eligibility ───────────────────────────────────────────────────────────
// Scope: current_purpose_name = 'Hybrid' (pool filter, above) AND
// disposition_mode = 'selective_realization' AND active_realization_flag
// = true AND realization_priority_order = 2 AND purpose_policy_status =
// 'mapped'. All five are checked independently (never short-circuited)
// so eligibility_failure_reasons reports every violated condition.

function evaluateEligibility(c: HybridOpenItemCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (c.current_purpose_name !== 'Hybrid') reasons.push('PURPOSE_NOT_HYBRID');
  if (c.disposition_mode !== 'selective_realization') reasons.push('DISPOSITION_MODE_NOT_SELECTIVE_REALIZATION');
  if (c.active_realization_flag !== true) reasons.push('ACTIVE_REALIZATION_FLAG_FALSE');
  if (c.realization_priority_order !== 2) reasons.push('REALIZATION_PRIORITY_ORDER_NOT_TWO');
  if (c.purpose_policy_status !== 'mapped') reasons.push('PURPOSE_POLICY_STATUS_NOT_MAPPED');

  return { eligible: reasons.length === 0, reasons };
}

// ── Historical/unreliable ownership age safety ───────────────────────────
// Long age alone is never automatically a problem for Hybrid — this only
// gates whether HYBRID_LONG_HOLD_SIGNAL may be treated as actionable, not
// whether long-held Hybrid items are somehow suspect. ownership_age_days
// is already NULL at the evidence layer whenever an item is a Historical
// Import or has a lifecycle-date issue — these checks are deliberate
// defense-in-depth, exactly as this task specifies, not evidence that the
// underlying gap is otherwise open. No new TypeScript age threshold is
// introduced — the 120-day boundary lives entirely in the SQL-generated
// HYBRID_LONG_HOLD_SIGNAL code; this function only checks reliability.

function reliableOwnershipAgeDays(c: HybridOpenItemCandidate): number | null {
  if (c.ownership_age_days === null) return null;
  if (c.is_historical_import) return null;
  if (c.reason_codes.includes(HISTORICAL_AGE_UNRELIABLE)) return null;
  if (c.reason_codes.includes(HISTORICAL_ACQUISITION_DATE_UNRELIABLE_EVIDENCE_CODE)) return null;
  return c.ownership_age_days;
}

function hasReliableLongHoldSignal(c: HybridOpenItemCandidate): boolean {
  return c.reason_codes.includes(HYBRID_LONG_HOLD_SIGNAL) && reliableOwnershipAgeDays(c) !== null;
}

// ── Priority profiles (checked in this exact order; first match wins) ────
// HYBRID_DOM_ABOVE_COMPARABLE_MEDIAN alone is supporting evidence only —
// never a profile trigger by itself (only HYBRID_DOM_ABOVE_COMPARABLE_P75
// drives a stale profile). HYBRID_REVIEW_REQUIRED (unconditional on every
// Hybrid row), HYBRID_UNLISTED_SIGNAL alone, HYBRID_LOW_UPSIDE_SIGNAL
// alone, and HYBRID_RECENT_ITEM are all deliberately insufficient too.

interface ProfileDefinition {
  profile: HybridPurposeReviewPriorityProfile;
  actionCode: string;
  matches: (c: HybridOpenItemCandidate) => boolean;
}

const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  {
    profile: 'UNLISTED_HIGH_CAPITAL_AGED',
    actionCode: 'DECIDE_LIST_AS_BUSINESS_OR_HOLD_AS_PERSONAL',
    matches: (c) =>
      !c.listed_flag
      && c.reason_codes.includes(HYBRID_UNLISTED_SIGNAL)
      && c.reason_codes.includes(HYBRID_HIGH_CAPITAL_SIGNAL)
      && hasReliableLongHoldSignal(c),
  },
  {
    profile: 'LISTED_STALE_HIGH_CAPITAL_LOW_UPSIDE',
    actionCode: 'REVIEW_EXIT_PLAN_OR_PERSONAL_HOLD',
    matches: (c) =>
      c.listed_flag
      && c.reason_codes.includes(HYBRID_DOM_ABOVE_COMPARABLE_P75)
      && c.reason_codes.includes(HYBRID_HIGH_CAPITAL_SIGNAL)
      && c.reason_codes.includes(HYBRID_LOW_UPSIDE_SIGNAL),
  },
  {
    profile: 'UNLISTED_HIGH_CAPITAL_LOW_UPSIDE',
    actionCode: 'DECIDE_LIST_AS_BUSINESS_OR_HOLD_AS_PERSONAL',
    matches: (c) =>
      !c.listed_flag
      && c.reason_codes.includes(HYBRID_UNLISTED_SIGNAL)
      && c.reason_codes.includes(HYBRID_HIGH_CAPITAL_SIGNAL)
      && c.reason_codes.includes(HYBRID_LOW_UPSIDE_SIGNAL),
  },
  {
    profile: 'LISTED_STALE_HIGH_CAPITAL',
    actionCode: 'CONFIRM_ACTIVE_EXIT_OR_PERSONAL_HOLD',
    matches: (c) =>
      c.listed_flag
      && c.reason_codes.includes(HYBRID_DOM_ABOVE_COMPARABLE_P75)
      && c.reason_codes.includes(HYBRID_HIGH_CAPITAL_SIGNAL),
  },
  {
    profile: 'UNLISTED_HIGH_CAPITAL',
    actionCode: 'DECIDE_LIST_AS_BUSINESS_OR_KEEP_HYBRID',
    matches: (c) =>
      !c.listed_flag
      && c.reason_codes.includes(HYBRID_UNLISTED_SIGNAL)
      && c.reason_codes.includes(HYBRID_HIGH_CAPITAL_SIGNAL),
  },
  {
    profile: 'LISTED_STALE_LOW_UPSIDE',
    actionCode: 'REVIEW_PRICE_EXIT_OR_PURPOSE',
    matches: (c) =>
      c.listed_flag
      && c.reason_codes.includes(HYBRID_DOM_ABOVE_COMPARABLE_P75)
      && c.reason_codes.includes(HYBRID_LOW_UPSIDE_SIGNAL),
  },
  {
    profile: 'LISTED_STALE',
    actionCode: 'CONFIRM_ACTIVE_EXIT_OR_PERSONAL_HOLD',
    matches: (c) => c.listed_flag && c.reason_codes.includes(HYBRID_DOM_ABOVE_COMPARABLE_P75),
  },
  {
    profile: 'UNLISTED_AGED',
    actionCode: 'CONFIRM_HYBRID_PURPOSE',
    matches: (c) =>
      !c.listed_flag
      && c.reason_codes.includes(HYBRID_UNLISTED_SIGNAL)
      && hasReliableLongHoldSignal(c),
  },
];

function assignProfile(c: HybridOpenItemCandidate): ProfileDefinition | null {
  for (const def of PROFILE_DEFINITIONS) {
    if (def.matches(c)) return def;
  }
  return null;
}

function actionableReasonCodesFor(c: HybridOpenItemCandidate): string[] {
  const codes = ACTIONABLE_VOCABULARY.filter((code) => c.reason_codes.includes(code));
  // HYBRID_LONG_HOLD_SIGNAL is only reported as actionable when the
  // underlying age is reliable (never historical/unreliable).
  return codes.filter((code) => code !== HYBRID_LONG_HOLD_SIGNAL || hasReliableLongHoldSignal(c));
}

// ── Deterministic ranking (no weighted score) ────────────────────────────
// 1. Priority profile order (above)
// 2. Larger purpose_open_capital_share_percent, null last
// 3. Larger open_capital_share_percent, null last
// 4. Larger reliable ownership_age_days, null last
// 5. Larger current_dom_days, null last
// 6. Lower estimated_upside_percent, null last
// 7. Larger acquisition_value, null last
// 8. Ascending item_id

function compareDescendingNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function compareAscendingNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

interface ScoredCandidate {
  candidate: HybridOpenItemCandidate;
  profileIndex: number;
  profileDef: ProfileDefinition;
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  return chainCompare(a, b, [
    (x, y) => x.profileIndex - y.profileIndex,
    (x, y) => compareDescendingNullsLast(x.candidate.purpose_open_capital_share_percent, y.candidate.purpose_open_capital_share_percent),
    (x, y) => compareDescendingNullsLast(x.candidate.open_capital_share_percent, y.candidate.open_capital_share_percent),
    (x, y) => compareDescendingNullsLast(reliableOwnershipAgeDays(x.candidate), reliableOwnershipAgeDays(y.candidate)),
    (x, y) => compareDescendingNullsLast(x.candidate.current_dom_days, y.candidate.current_dom_days),
    (x, y) => compareAscendingNullsLast(x.candidate.estimated_upside_percent, y.candidate.estimated_upside_percent),
    (x, y) => compareDescendingNullsLast(x.candidate.acquisition_value, y.candidate.acquisition_value),
    (x, y) => x.candidate.item_id - y.candidate.item_id,
  ]);
}

// ── Finding assembly ──────────────────────────────────────────────────────

function buildSegment(c: HybridOpenItemCandidate): Record<string, unknown> {
  return {
    item_id: c.item_id,
    item_display_name: c.item_display_name,
    brand_name: c.brand_name,
    category_name: c.category_name,
    type_name: c.type_name,
    current_purpose_name: c.current_purpose_name,
    disposition_mode: c.disposition_mode,
  };
}

function buildMetrics(c: HybridOpenItemCandidate): Record<string, unknown> {
  return {
    listed_flag: c.listed_flag,
    listing_channel_names: c.listing_channel_names,
    current_dom_days: c.current_dom_days,
    reliable_ownership_age_days: reliableOwnershipAgeDays(c),
    acquisition_value: c.acquisition_value,
    estimated_sold_value: c.estimated_sold_value,
    estimated_net_upside: c.estimated_net_upside,
    estimated_upside_percent: c.estimated_upside_percent,
    open_capital_share_percent: c.open_capital_share_percent,
    purpose_open_capital_share_percent: c.purpose_open_capital_share_percent,
  };
}

// Every summary ends with the same Business/Hybrid/Personal distinction
// and an explicit statement that Hybrid may remain valid — required
// wording, not profile-specific.
const PURPOSE_DISTINCTION_CLOSING =
  'Business means active realization and turnover; Hybrid means a genuine combination of realization and personal ' +
  'interest; Personal means the item is primarily held for enjoyment, collection, or appreciation. If the item is ' +
  'meant to generate turnover, consider treating it as Business and maintaining an active listing; if it is ' +
  'primarily being kept for enjoyment or appreciation, Personal may describe the current intent more accurately. ' +
  'Keeping it as Hybrid remains valid when both objectives are genuine — this is decision support asking you to ' +
  'confirm current intent, not an automated Purpose change or a guarantee of a specific outcome.';

const PROFILE_SUMMARY_OPENER: Record<HybridPurposeReviewPriorityProfile, string> = {
  UNLISTED_HIGH_CAPITAL_AGED:
    'This Hybrid item is unlisted, represents a meaningful share of Hybrid capital, and has a reliably-tracked ' +
    'ownership age of 120 days or more.',
  LISTED_STALE_HIGH_CAPITAL_LOW_UPSIDE:
    'This Hybrid item has been listed materially longer than its comparable liquidity cohort, represents a ' +
    'meaningful share of Hybrid capital, and its estimated upside relative to that capital is currently low.',
  UNLISTED_HIGH_CAPITAL_LOW_UPSIDE:
    'This Hybrid item is unlisted, represents a meaningful share of Hybrid capital, and its estimated upside ' +
    'relative to that capital is currently low.',
  LISTED_STALE_HIGH_CAPITAL:
    'This Hybrid item has been listed materially longer than its comparable liquidity cohort and represents a ' +
    'meaningful share of Hybrid capital.',
  UNLISTED_HIGH_CAPITAL:
    'This Hybrid item is unlisted and represents a meaningful share of Hybrid capital.',
  LISTED_STALE_LOW_UPSIDE:
    'This Hybrid item has been listed materially longer than its comparable liquidity cohort and its estimated ' +
    'upside relative to capital is currently low.',
  LISTED_STALE:
    'This Hybrid item has been listed materially longer than its comparable liquidity cohort.',
  UNLISTED_AGED:
    'This Hybrid item is unlisted and has a reliably-tracked ownership age of 120 days or more.',
};

function buildSummary(profile: HybridPurposeReviewPriorityProfile): string {
  return `${PROFILE_SUMMARY_OPENER[profile]} Confirm whether active realization is still intended for this item. ${PURPOSE_DISTINCTION_CLOSING}`;
}

function buildLimitations(c: HybridOpenItemCandidate): string[] {
  const limitations = [
    'TARGET_USER_ITEM_LEVEL_EVIDENCE',
    'PURPOSE_REVIEW_IS_DECISION_SUPPORT_NOT_AUTOMATION',
    'HYBRID_PURPOSE_MAY_REMAIN_VALID',
    'ESTIMATED_VALUE_IS_USER_ESTIMATE',
    'LISTING_ACTIVE_STATE_INFERRED',
    'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
    'ITEM_SELECTION_ASSOCIATION_NOT_CAUSATION',
  ];
  if (c.is_historical_import || c.reason_codes.includes(HISTORICAL_AGE_UNRELIABLE)) {
    limitations.push('HISTORICAL_ACQUISITION_DATE_UNRELIABLE');
  }
  if (c.reason_codes.includes(LOW_COMPARABLE_CONFIDENCE)) {
    limitations.push('LOW_COMPARABLE_CONFIDENCE');
  }
  if (c.reason_codes.includes(PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE) || c.liquidity_cohort_match === 'cross_purpose_fallback') {
    limitations.push('PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE');
  }
  if (c.reason_codes.includes(ZERO_ASSIGNED_ACQUISITION_VALUE)) {
    limitations.push('ZERO_ASSIGNED_ACQUISITION_VALUE_LIMITS_ECONOMIC_INTERPRETATION');
  }
  return limitations;
}

// ── Rule entry point ──────────────────────────────────────────────────────

export interface HybridPurposeReviewPriorityEvaluation {
  result: HybridPurposeReviewRuleEvaluationResult;
  candidateEvaluations: HybridOpenItemCandidateEvaluation[];
}

export function evaluateHybridPurposeReviewPriority(
  targetUserOpenInventoryEvidence: unknown,
): HybridPurposeReviewPriorityEvaluation {
  const evidence = toRecord(targetUserOpenInventoryEvidence);
  if (!Array.isArray(evidence?.item_decision_evidence)) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidates = extractHybridOpenItemCandidates(targetUserOpenInventoryEvidence);

  const candidateEvaluations: HybridOpenItemCandidateEvaluation[] = [];
  const eligibleCandidates: HybridOpenItemCandidate[] = [];

  for (const candidate of candidates) {
    const { eligible, reasons } = evaluateEligibility(candidate);
    if (eligible) eligibleCandidates.push(candidate);
    candidateEvaluations.push({
      finding_code: FINDING_CODE,
      item_id: candidate.item_id,
      item_display_name: candidate.item_display_name,
      eligible,
      actionable: false,
      selected: false,
      priority_profile: null,
      recommended_action_code: null,
      actionable_reason_codes: eligible ? actionableReasonCodesFor(candidate) : [],
      eligibility_failure_reasons: reasons,
    });
  }

  if (eligibleCandidates.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['NO_ELIGIBLE_HYBRID_OPEN_ITEMS'] },
      candidateEvaluations,
    };
  }

  const scored: ScoredCandidate[] = [];
  for (const candidate of eligibleCandidates) {
    const profileDef = assignProfile(candidate);
    const evalRow = candidateEvaluations.find((e) => e.item_id === candidate.item_id)!;
    if (profileDef) {
      evalRow.actionable = true;
      evalRow.priority_profile = profileDef.profile;
      evalRow.recommended_action_code = profileDef.actionCode;
      scored.push({ candidate, profileIndex: PROFILE_DEFINITIONS.indexOf(profileDef), profileDef });
    }
  }

  if (scored.length === 0) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['NO_ACTIONABLE_HYBRID_PURPOSE_REVIEW'] },
      candidateEvaluations,
    };
  }

  const ranked = [...scored].sort(compareScoredCandidates);
  const winner = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1] : null;

  const winnerEvalRow = candidateEvaluations.find((e) => e.item_id === winner.candidate.item_id)!;
  winnerEvalRow.selected = true;

  const finding: HybridPurposeReviewPriorityFinding = {
    finding_code: FINDING_CODE,
    family: 'purpose_alignment',
    direction: 'review',
    status: 'selected',
    headline: `${winner.candidate.item_display_name ?? `Item ${winner.candidate.item_id}`}'s Hybrid Purpose deserves review`,
    summary: buildSummary(winner.profileDef.profile),
    segment: buildSegment(winner.candidate),
    metrics: buildMetrics(winner.candidate),
    priority_profile: winner.profileDef.profile,
    recommended_action_code: winner.profileDef.actionCode,
    triggered_reason_codes: actionableReasonCodesFor(winner.candidate),
    purpose_review_options: [...PURPOSE_REVIEW_OPTIONS],
    limitations: buildLimitations(winner.candidate),
    evidence_refs: ['target_user_open_inventory_evidence.item_decision_evidence'],
  };

  if (runnerUp) {
    finding.runner_up = {
      item_id: runnerUp.candidate.item_id,
      item_display_name: runnerUp.candidate.item_display_name,
      priority_profile: runnerUp.profileDef.profile,
      recommended_action_code: runnerUp.profileDef.actionCode,
      triggered_reason_codes: actionableReasonCodesFor(runnerUp.candidate),
      reason_not_selected: 'LOWER_RANKED_BY_DETERMINISTIC_PRIORITY',
    };
  }

  return { result: finding, candidateEvaluations };
}
