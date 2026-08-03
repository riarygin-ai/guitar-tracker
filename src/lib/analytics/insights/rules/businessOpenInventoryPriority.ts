// Insights Engine v1.7 — Findings Selector rule: BUSINESS_OPEN_INVENTORY_
// PRIORITY. Pure functions only — no I/O, no Supabase client. Selects at
// most one CURRENT (open, not realized) Business item that deserves the
// user's attention first, by deterministically matching it against seven
// ordered priority profiles built from existing Open Inventory Decision
// Support reason codes — never a weighted score, never a price
// recommendation, never a guarantee of a sale outcome.
//
// This is the first Insights rule scoped to a single Purpose (Business
// only) and the first to select an ITEM-LEVEL finding (target user's own
// item_id/item_display_name/basic classification — never another user's
// item, never notes/serial number/counterparty/listing text/photo paths).
//
// Evidence shape consumed (Analytics v2.11, unchanged by this task — see
// supabase/migrations/20260812000000_build_analytics_snapshot_v2_1.sql,
// Query C / c_rows, passed through unmodified by v2.2-v2.11 for Business
// rows):
//   target_user_open_inventory_evidence.item_decision_evidence[] — one row
//   per OPEN item, ALL Purposes pooled at the source (Business, Hybrid,
//   Personal, and unclassified) — this rule filters to current_purpose_
//   name = 'Business' itself; it never reads shared_open_inventory_
//   evidence (no such section exists — OIDS has no shared/pooled
//   counterpart), never hybrid_purpose_review, never personal_inventory_
//   control, never recommendation_candidates (a v1.x-only legacy section,
//   absent from v2.x snapshots entirely), never aggregate brand rows, and
//   never raw inventory tables.
//
// reason_codes on this evidence are the REAL SQL-generated strings, not
// abbreviations — confirmed by direct inspection of both the migration
// and live evidence. Three of this rule's five "actionable" signals carry
// a BUSINESS_ prefix at the source:
//   BUSINESS_DOM_ABOVE_COMPARABLE_P75, BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN,
//   BUSINESS_UNLISTED_OPEN_ITEM, BUSINESS_OWNERSHIP_AGE_120_PLUS
// The other two are unprefixed (shared with the 'unclassified' bucket,
// never reached here since this rule's candidate pool is Business-only):
//   HIGH_CAPITAL_EXPOSURE, LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL
//
// item_decision_evidence rows carry NO `limitations` array of their own
// (unlike hybrid_purpose_review/personal_inventory_control in the same
// module) — only reason_codes. This finding's own `limitations` array is
// synthesized from applicable reason_codes/fields plus fixed required
// strings (see buildLimitations below).
//
// No precomputed "current DOM minus comparable cohort median" delta field
// exists anywhere in v2.1+/v2.11's item_decision_evidence (it only ever
// existed in the superseded, pre-v2 "Open Inventory Decision Support v1"
// module — analytics/sql/10_open_inventory_decision_support.sql /
// 20260808000000_build_analytics_snapshot_v1_8.sql — which this task does
// not read). Per this task's own instruction not to reconstruct a cohort
// median comparison when evidence does not provide the delta, ranking
// step 4 (see compareCandidates below) is a permanent, documented no-op.

import type {
  BusinessOpenInventoryCandidate,
  BusinessOpenInventoryCandidateEvaluation,
  BusinessOpenInventoryPriorityFinding,
  BusinessOpenInventoryPriorityProfile,
  BusinessOpenInventoryRuleEvaluationResult,
} from '../types';
import { toRecord, toNumber, toNonNegativeInt, chainCompare } from '../comparisonHelpers';

export const FINDING_CODE = 'BUSINESS_OPEN_INVENTORY_PRIORITY';

// ── Evidence-vocabulary constants (real SQL-generated reason_codes) ─────
const BUSINESS_DOM_ABOVE_COMPARABLE_P75 = 'BUSINESS_DOM_ABOVE_COMPARABLE_P75';
const BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN = 'BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN';
const BUSINESS_UNLISTED_OPEN_ITEM = 'BUSINESS_UNLISTED_OPEN_ITEM';
const BUSINESS_OWNERSHIP_AGE_120_PLUS = 'BUSINESS_OWNERSHIP_AGE_120_PLUS';
const HIGH_CAPITAL_EXPOSURE = 'HIGH_CAPITAL_EXPOSURE';
const LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL = 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL';

// Data-quality/limitation codes — never independently actionable, only
// ever translated into this finding's own `limitations` output.
const LOW_COMPARABLE_CONFIDENCE = 'LOW_COMPARABLE_CONFIDENCE';
const PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE = 'PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE';
const HISTORICAL_AGE_UNRELIABLE = 'HISTORICAL_AGE_UNRELIABLE';
const HISTORICAL_ACQUISITION_DATE_UNRELIABLE_EVIDENCE_CODE = 'HISTORICAL_ACQUISITION_DATE_UNRELIABLE';
const ZERO_ASSIGNED_ACQUISITION_VALUE = 'ZERO_ASSIGNED_ACQUISITION_VALUE';

const ACTIONABLE_VOCABULARY = [
  BUSINESS_DOM_ABOVE_COMPARABLE_P75,
  BUSINESS_UNLISTED_OPEN_ITEM,
  BUSINESS_OWNERSHIP_AGE_120_PLUS,
  HIGH_CAPITAL_EXPOSURE,
  LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL,
];

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
 * filtered to current_purpose_name === 'Business' (this rule's entire
 * candidate pool — Hybrid/Personal/unclassified items never appear here
 * and never receive a rule_evaluations row from this rule). Never throws
 * — malformed or missing evidence simply yields no candidates.
 */
export function extractBusinessOpenInventoryCandidates(
  targetUserOpenInventoryEvidence: unknown,
): BusinessOpenInventoryCandidate[] {
  const evidence = toRecord(targetUserOpenInventoryEvidence);
  const rows = Array.isArray(evidence?.item_decision_evidence)
    ? (evidence!.item_decision_evidence as unknown[])
    : [];

  const candidates: BusinessOpenInventoryCandidate[] = [];
  for (const row of rows) {
    const r = toRecord(row);
    if (!r) continue;
    if (r.current_purpose_name !== 'Business') continue;

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
      first_listed_at: toStringOrNull(r.first_listed_at),
      current_dom_days: toNumber(r.current_dom_days),
      ownership_age_days: toNumber(r.ownership_age_days),
      acquisition_value: toNumber(r.acquisition_value),
      estimated_sold_value: toNumber(r.estimated_sold_value),
      estimated_net_upside: toNumber(r.estimated_net_upside),
      estimated_upside_percent: toNumber(r.estimated_upside_percent),
      open_capital_share_percent: toNumber(r.open_capital_share_percent),
      purpose_open_capital_share_percent: toNumber(r.purpose_open_capital_share_percent),
      listing_channel_count: toNonNegativeInt(r.listing_channel_count),
      listing_channel_names: toStringArray(r.listing_channel_names),
      acquisition_value_band_label: toStringOrNull(r.acquisition_value_band_label),
      acquisition_value_band_order: toNumber(r.acquisition_value_band_order),
      comparable_evidence_available: toBoolean(r.comparable_evidence_available) === true,
      liquidity_cohort_match: toStringOrNull(r.liquidity_cohort_match),
      reason_codes: toStringArray(r.reason_codes),
      is_historical_import: toBoolean(r.is_historical_import) === true,
    });
  }

  return candidates;
}

// ── Eligibility ───────────────────────────────────────────────────────────
// Scope: current_purpose_name = 'Business' (pool filter, above) AND
// disposition_mode = 'active_realization' AND active_realization_flag =
// true AND purpose_policy_status = 'mapped'. All four are checked
// independently (never short-circuited) so eligibility_failure_reasons
// reports every violated condition, not just the first.

function evaluateEligibility(c: BusinessOpenInventoryCandidate): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (c.current_purpose_name !== 'Business') reasons.push('PURPOSE_NOT_BUSINESS');
  if (c.disposition_mode !== 'active_realization') reasons.push('DISPOSITION_MODE_NOT_ACTIVE_REALIZATION');
  if (c.active_realization_flag !== true) reasons.push('ACTIVE_REALIZATION_FLAG_FALSE');
  if (c.purpose_policy_status !== 'mapped') reasons.push('PURPOSE_POLICY_STATUS_NOT_MAPPED');

  return { eligible: reasons.length === 0, reasons };
}

// ── Historical/unreliable ownership age safety ───────────────────────────
// ownership_age_days is already NULL at the evidence layer whenever an
// item is a Historical Import or has a lifecycle-date issue (see
// target_base in the v2.1 migration) — BUSINESS_OWNERSHIP_AGE_120_PLUS
// itself can never fire without a non-null ownership_age_days >= 120
// either. These checks are deliberate defense-in-depth, exactly as this
// task specifies, not evidence that the underlying gap is otherwise open.

function reliableOwnershipAgeDays(c: BusinessOpenInventoryCandidate): number | null {
  if (c.ownership_age_days === null) return null;
  if (c.is_historical_import) return null;
  if (c.reason_codes.includes(HISTORICAL_AGE_UNRELIABLE)) return null;
  if (c.reason_codes.includes(HISTORICAL_ACQUISITION_DATE_UNRELIABLE_EVIDENCE_CODE)) return null;
  return c.ownership_age_days;
}

function hasReliableOwnershipAge120Plus(c: BusinessOpenInventoryCandidate): boolean {
  return c.reason_codes.includes(BUSINESS_OWNERSHIP_AGE_120_PLUS) && reliableOwnershipAgeDays(c) !== null;
}

// ── Priority profiles (checked in this exact order; first match wins) ────
// DOM_ABOVE_COMPARABLE_MEDIAN alone is supporting evidence only — never a
// profile trigger by itself. UNLISTED_OPEN_ITEM alone and LOW_ESTIMATED_
// UPSIDE_RELATIVE_TO_CAPITAL alone are both deliberately insufficient too
// (newly acquired Business inventory may legitimately be unlisted yet).

interface ProfileDefinition {
  profile: BusinessOpenInventoryPriorityProfile;
  actionCode: string;
  matches: (c: BusinessOpenInventoryCandidate) => boolean;
}

const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  {
    profile: 'STALE_HIGH_CAPITAL_LOW_UPSIDE',
    actionCode: 'REVIEW_PRICE_LISTING_AND_EXIT_PLAN',
    matches: (c) =>
      c.listed_flag
      && c.reason_codes.includes(BUSINESS_DOM_ABOVE_COMPARABLE_P75)
      && c.reason_codes.includes(HIGH_CAPITAL_EXPOSURE)
      && c.reason_codes.includes(LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL),
  },
  {
    profile: 'UNLISTED_HIGH_CAPITAL_LOW_UPSIDE',
    actionCode: 'LIST_OR_RECLASSIFY',
    matches: (c) =>
      !c.listed_flag
      && c.reason_codes.includes(BUSINESS_UNLISTED_OPEN_ITEM)
      && c.reason_codes.includes(HIGH_CAPITAL_EXPOSURE)
      && c.reason_codes.includes(LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL),
  },
  {
    profile: 'STALE_HIGH_CAPITAL',
    actionCode: 'REFRESH_LISTING_AND_REVIEW_EXIT_PLAN',
    matches: (c) =>
      c.listed_flag
      && c.reason_codes.includes(BUSINESS_DOM_ABOVE_COMPARABLE_P75)
      && c.reason_codes.includes(HIGH_CAPITAL_EXPOSURE),
  },
  {
    profile: 'UNLISTED_HIGH_CAPITAL_OR_AGED',
    actionCode: 'LIST_OR_RECLASSIFY',
    matches: (c) =>
      !c.listed_flag
      && c.reason_codes.includes(BUSINESS_UNLISTED_OPEN_ITEM)
      && (c.reason_codes.includes(HIGH_CAPITAL_EXPOSURE) || hasReliableOwnershipAge120Plus(c)),
  },
  {
    profile: 'STALE_LOW_UPSIDE',
    actionCode: 'REVIEW_PRICE_AND_EXIT_PLAN',
    matches: (c) =>
      c.listed_flag
      && c.reason_codes.includes(BUSINESS_DOM_ABOVE_COMPARABLE_P75)
      && c.reason_codes.includes(LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL),
  },
  {
    profile: 'STALE_LISTING',
    actionCode: 'REFRESH_LISTING',
    matches: (c) => c.listed_flag && c.reason_codes.includes(BUSINESS_DOM_ABOVE_COMPARABLE_P75),
  },
  {
    profile: 'AGED_BUSINESS_HOLD',
    actionCode: 'REVIEW_HOLD_OR_EXIT_DECISION',
    matches: (c) => hasReliableOwnershipAge120Plus(c),
  },
];

function assignProfile(c: BusinessOpenInventoryCandidate): ProfileDefinition | null {
  for (const def of PROFILE_DEFINITIONS) {
    if (def.matches(c)) return def;
  }
  return null;
}

function actionableReasonCodesFor(c: BusinessOpenInventoryCandidate): string[] {
  const codes = ACTIONABLE_VOCABULARY.filter((code) => c.reason_codes.includes(code));
  // BUSINESS_OWNERSHIP_AGE_120_PLUS is only reported as actionable when
  // the underlying age is reliable (never historical/unreliable).
  return codes.filter((code) => code !== BUSINESS_OWNERSHIP_AGE_120_PLUS || hasReliableOwnershipAge120Plus(c));
}

// ── Deterministic ranking (no weighted score) ────────────────────────────
// 1. Priority profile order (above)
// 2. Larger open_capital_share_percent, null last
// 3. Larger purpose_open_capital_share_percent, null last
// 4. No-op — no precomputed "current DOM minus comparable median" delta
//    exists in this evidence (see module header); never reconstructed.
// 5. Larger current_dom_days, null last
// 6. Larger reliable ownership_age_days, null last
// 7. Lower estimated_upside_percent, null last
// 8. Larger acquisition_value, null last
// 9. Ascending item_id

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
  candidate: BusinessOpenInventoryCandidate;
  profileIndex: number;
  profileDef: ProfileDefinition;
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  return chainCompare(a, b, [
    (x, y) => x.profileIndex - y.profileIndex,
    (x, y) => compareDescendingNullsLast(x.candidate.open_capital_share_percent, y.candidate.open_capital_share_percent),
    (x, y) => compareDescendingNullsLast(x.candidate.purpose_open_capital_share_percent, y.candidate.purpose_open_capital_share_percent),
    () => 0, // step 4 — no reconstructable delta, always tied
    (x, y) => compareDescendingNullsLast(x.candidate.current_dom_days, y.candidate.current_dom_days),
    (x, y) => compareDescendingNullsLast(reliableOwnershipAgeDays(x.candidate), reliableOwnershipAgeDays(y.candidate)),
    (x, y) => compareAscendingNullsLast(x.candidate.estimated_upside_percent, y.candidate.estimated_upside_percent),
    (x, y) => compareDescendingNullsLast(x.candidate.acquisition_value, y.candidate.acquisition_value),
    (x, y) => x.candidate.item_id - y.candidate.item_id,
  ]);
}

// ── Finding assembly ──────────────────────────────────────────────────────

function buildSegment(c: BusinessOpenInventoryCandidate): Record<string, unknown> {
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

function buildMetrics(c: BusinessOpenInventoryCandidate): Record<string, unknown> {
  return {
    listed_flag: c.listed_flag,
    listing_channel_names: c.listing_channel_names,
    acquisition_value: c.acquisition_value,
    estimated_sold_value: c.estimated_sold_value,
    estimated_net_upside: c.estimated_net_upside,
    estimated_upside_percent: c.estimated_upside_percent,
    current_dom_days: c.current_dom_days,
    reliable_ownership_age_days: reliableOwnershipAgeDays(c),
    open_capital_share_percent: c.open_capital_share_percent,
    purpose_open_capital_share_percent: c.purpose_open_capital_share_percent,
  };
}

const PROFILE_SUMMARY_TEXT: Record<BusinessOpenInventoryPriorityProfile, string> = {
  STALE_HIGH_CAPITAL_LOW_UPSIDE:
    "The item is listed materially longer than its comparable liquidity cohort, represents a meaningful share of Business capital, and its estimated upside relative to that capital is currently low. Review the item's price, listing quality, and exit plan.",
  UNLISTED_HIGH_CAPITAL_LOW_UPSIDE:
    'The item is unlisted despite representing a meaningful share of Business capital and a low estimated upside relative to that capital. Consider listing it now or changing its Purpose if active realization is no longer intended.',
  STALE_HIGH_CAPITAL:
    'The item is listed materially longer than its comparable liquidity cohort and represents a meaningful share of Business capital. Review the listing quality and exit plan.',
  UNLISTED_HIGH_CAPITAL_OR_AGED:
    'The item is unlisted despite representing meaningful Business capital or a long, reliably-tracked ownership age. Consider listing it now or changing its Purpose if active realization is no longer intended.',
  STALE_LOW_UPSIDE:
    "The item is listed materially longer than its comparable liquidity cohort and its estimated upside relative to capital is currently low. Review the item's price and exit plan.",
  STALE_LISTING:
    'The item is listed materially longer than its comparable liquidity cohort. Review and consider refreshing the listing.',
  AGED_BUSINESS_HOLD:
    'The item has a reliably-tracked ownership age of 120 days or more while still intended for active realization. Review whether to continue holding it or move toward an exit decision.',
};

function buildSummary(profile: BusinessOpenInventoryPriorityProfile): string {
  return (
    `${PROFILE_SUMMARY_TEXT[profile]} This is decision support based on existing evidence signals, not an ` +
    `automated action and not a guarantee of a specific outcome.`
  );
}

function buildLimitations(c: BusinessOpenInventoryCandidate): string[] {
  const limitations = [
    'TARGET_USER_ITEM_LEVEL_EVIDENCE',
    'OPEN_INVENTORY_PRIORITY_IS_DECISION_SUPPORT_NOT_AUTOMATION',
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

export interface BusinessOpenInventoryPriorityEvaluation {
  result: BusinessOpenInventoryRuleEvaluationResult;
  candidateEvaluations: BusinessOpenInventoryCandidateEvaluation[];
}

export function evaluateBusinessOpenInventoryPriority(
  targetUserOpenInventoryEvidence: unknown,
): BusinessOpenInventoryPriorityEvaluation {
  const evidence = toRecord(targetUserOpenInventoryEvidence);
  if (!Array.isArray(evidence?.item_decision_evidence)) {
    return {
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['EVIDENCE_UNAVAILABLE'] },
      candidateEvaluations: [],
    };
  }

  const candidates = extractBusinessOpenInventoryCandidates(targetUserOpenInventoryEvidence);

  const candidateEvaluations: BusinessOpenInventoryCandidateEvaluation[] = [];
  const eligibleCandidates: BusinessOpenInventoryCandidate[] = [];

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
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['NO_ELIGIBLE_BUSINESS_OPEN_ITEMS'] },
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
      result: { status: 'no_eligible_finding', finding_code: FINDING_CODE, reason_codes: ['NO_ACTIONABLE_BUSINESS_OPEN_ITEM'] },
      candidateEvaluations,
    };
  }

  const ranked = [...scored].sort(compareScoredCandidates);
  const winner = ranked[0];
  const runnerUp = ranked.length > 1 ? ranked[1] : null;

  const winnerEvalRow = candidateEvaluations.find((e) => e.item_id === winner.candidate.item_id)!;
  winnerEvalRow.selected = true;

  const finding: BusinessOpenInventoryPriorityFinding = {
    finding_code: FINDING_CODE,
    family: 'open_inventory_action',
    direction: 'action',
    status: 'selected',
    headline: `${winner.candidate.item_display_name ?? `Item ${winner.candidate.item_id}`} needs review first among open Business inventory`,
    summary: buildSummary(winner.profileDef.profile),
    segment: buildSegment(winner.candidate),
    metrics: buildMetrics(winner.candidate),
    priority_profile: winner.profileDef.profile,
    recommended_action_code: winner.profileDef.actionCode,
    triggered_reason_codes: actionableReasonCodesFor(winner.candidate),
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
