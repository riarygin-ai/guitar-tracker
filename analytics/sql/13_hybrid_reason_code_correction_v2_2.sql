-- ============================================================================
-- 13_hybrid_reason_code_correction_v2_2.sql
--
-- Documents the ONE correction v2.2 makes on top of v2.1's output, and
-- provides read-only inspection queries to verify it. See
-- public.build_analytics_snapshot_v2_2(int)
-- (supabase/migrations/20260813000000_build_analytics_snapshot_v2_2.sql)
-- for the actual transformation; nothing in this file creates a database
-- object and nothing here writes to production data.
--
-- ── THE BUG ───────────────────────────────────────────────────────────────
-- v2.1's item_decision_evidence used ONE reason code,
-- HYBRID_RECENT_INSUFFICIENT_HISTORY, for TWO different situations:
--   (a) a genuinely recent Hybrid item with a RELIABLE ownership age under
--       30 days;
--   (b) an item whose ownership age is UNAVAILABLE because its
--       acquisition date is historical or otherwise unreliable.
-- In production this meant a Hybrid item that had been HELD for
-- 100-400+ days (but whose age is unreliable, e.g. a Historical Import)
-- carried a reason code containing the word "RECENT" — backwards.
-- hybrid_purpose_review.behavioral_signals already got this right with
-- two separate signals (RECENT_ITEM_SIGNAL / INSUFFICIENT_HISTORY_SIGNAL)
-- — v2.2 gives item_decision_evidence.reason_codes the same distinction,
-- using the EXACT SAME condition, no new threshold:
--   HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY  — ownership_age_days IS NULL
--   HYBRID_RECENT_ITEM                     — ownership_age_days reliable
--                                             AND < 30
-- These are mutually exclusive (NULL vs. reliable-and-<30) and together
-- exactly reconstruct v2.1's original combined condition — no item gains
-- or loses a flag; only the CODE NAME an already-flagged item receives
-- changes. v2.1 itself is NOT modified — it still produces the old
-- combined code, unchanged, and remains historically interpretable.
-- ============================================================================

-- Query A: which OPEN Hybrid items are genuinely recent (the
-- HYBRID_RECENT_ITEM case) — reliable ownership age under 30 days.
-- CLASSIFICATION: target-user-only inspection (REPLACE 2 with a real user id).
SELECT
  item_id,
  item_display_name,
  holding_days                                                                  AS ownership_age_days,
  is_historical_import,
  has_lifecycle_date_issue
FROM analytics_item_lifecycle_v2
WHERE user_id = 2 -- REPLACE 2 with a real user id
  AND NOT is_realized
  AND current_purpose_name = 'Hybrid'
  AND NOT is_historical_import
  AND holding_days IS NOT NULL
  AND NOT has_lifecycle_date_issue
  AND holding_days < 30;

-- Query B: which OPEN Hybrid items have UNAVAILABLE ownership history (the
-- HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY case) — historical import, no
-- reliable holding_days, or a lifecycle date issue.
-- CLASSIFICATION: target-user-only inspection.
SELECT
  item_id,
  item_display_name,
  holding_days,
  is_historical_import,
  has_lifecycle_date_issue,
  global_days_on_market                                                        AS current_dom_days_if_listed
FROM analytics_item_lifecycle_v2
WHERE user_id = 2 -- REPLACE 2 with a real user id
  AND NOT is_realized
  AND current_purpose_name = 'Hybrid'
  AND (is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue);

-- Query C: call the real v2.2 builder and show the corrected reason_codes
-- for every open Hybrid item — confirms both new codes appear where
-- expected and are mutually exclusive per item.
-- CLASSIFICATION: target-user-only inspection.
SELECT
  item->>'item_id'                                                             AS item_id,
  item->>'ownership_age_days'                                                  AS ownership_age_days,
  item->>'current_dom_days'                                                    AS current_dom_days,
  item->'reason_codes'                                                         AS reason_codes,
  ( (item->'reason_codes') ? 'HYBRID_RECENT_ITEM'
    AND (item->'reason_codes') ? 'HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY' )     AS both_codes_present_bug_check
FROM jsonb_array_elements(
  build_analytics_snapshot_v2_2(2) -- REPLACE 2 with a real user id
    -> 'target_user_open_inventory_evidence' -> 'item_decision_evidence'
) AS item
WHERE item->>'current_purpose_name' = 'Hybrid';

-- Query D: confirm the OLD, ambiguous combined code is absent everywhere in
-- v2.2 output (should return `false`).
SELECT build_analytics_snapshot_v2_2(2)::text ILIKE '%HYBRID_RECENT_INSUFFICIENT_HISTORY%' -- REPLACE 2
  AS old_ambiguous_code_still_present;

-- Query E: confirm v2.1 is UNCHANGED — it still produces the old, ambiguous
-- combined code exactly as before (should return `true` if any open Hybrid
-- item in this fixture/environment ever satisfied the combined condition).
SELECT build_analytics_snapshot_v2_1(2)::text ILIKE '%HYBRID_RECENT_INSUFFICIENT_HISTORY%' -- REPLACE 2
  AS v2_1_still_produces_old_code_unchanged;

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- HYBRID_RECENT_ITEM and HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY are
-- descriptive facts about data availability and item age — neither is an
-- urgency signal, a recommendation, or a judgment about whether the item
-- belongs in Business or Personal. Every other v2.1 value (counts,
-- capital, cohorts, other reason codes, behavioral_signals, limitations,
-- item ordering) is unchanged in v2.2 — this file documents ONLY the one
-- reason-code correction.
