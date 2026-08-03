-- ============================================================================
-- 27_hybrid_comparable_dom_signals_v2_12.sql
--
-- Analytics v2.12 — Hybrid Comparable-DOM Signals. See public.
-- _enrich_hybrid_comparable_dom_signals_v2_12() and public.
-- build_analytics_snapshot_v2_12() (supabase/migrations/
-- 20260823000000_build_analytics_snapshot_v2_12.sql) for the actual
-- production functions and the full, authoritative logic; nothing in this
-- file creates a database object. This file illustrates the enrichment
-- as a standalone query over one item_decision_evidence row shape, for
-- readability alongside the rest of this directory's numbered reference
-- queries.
--
-- ── THE GAP THIS FILLS ────────────────────────────────────────────────────
-- v2.1's item_decision_evidence reason_codes computes BUSINESS_DOM_ABOVE_
-- COMPARABLE_MEDIAN / BUSINESS_DOM_ABOVE_COMPARABLE_P75 for Business rows
-- only — Hybrid rows never received an equivalent signal, even though the
-- SAME liquidity_cohort.median_days_on_market / .p75_days_on_market
-- values are already computed for every item regardless of Purpose (the
-- cohort-selection LATERAL join in v2.1 is disposition-agnostic — see
-- 07_listing_channel_exposure... no, see 20260812000000_build_analytics_
-- snapshot_v2_1.sql's own `liq` LATERAL join). This adds the missing
-- Hybrid-specific pair, mirroring the Business condition exactly (same
-- >= 30 day floor, same strict `>` comparison, same "non-null median/p75
-- value is the only gate" — no separate confidence-value check, no new
-- threshold).
--
-- ── QUERY CLASSIFICATION INDEX ────────────────────────────────────────────
-- Query A is TARGET-USER ITEM-LEVEL EVIDENCE (one row per open item) — the
-- same classification as every other row in item_decision_evidence.
--
-- Query A — illustrative single-item version of the enrichment, operating
-- directly on one item_decision_evidence row's already-computed fields
-- (no base-table access — everything read here already exists on the row):

WITH item AS (
  -- Represents one row already present in target_user_open_inventory_
  -- evidence.item_decision_evidence — current_purpose_name, purpose_
  -- policy_status, listed_flag, current_dom_days, and liquidity_cohort
  -- are all pre-existing fields, unchanged by this migration.
  SELECT
    :current_purpose_name  AS current_purpose_name,
    :purpose_policy_status AS purpose_policy_status,
    :listed_flag           AS listed_flag,
    :current_dom_days      AS current_dom_days,
    :liq_median_days_on_market AS liq_median_days_on_market,
    :liq_p75_days_on_market    AS liq_p75_days_on_market
),
qualifies AS (
  SELECT
    current_purpose_name = 'Hybrid'
      AND purpose_policy_status = 'mapped'
      AND listed_flag IS TRUE
      AND current_dom_days IS NOT NULL
      AND current_dom_days >= 30                                             AS is_hybrid_listed_dom_eligible,
    *
  FROM item
)
SELECT
  ARRAY(
    SELECT code FROM (VALUES
      (CASE WHEN is_hybrid_listed_dom_eligible
              AND liq_median_days_on_market IS NOT NULL
              AND current_dom_days > liq_median_days_on_market
            THEN 'HYBRID_DOM_ABOVE_COMPARABLE_MEDIAN' END),
      (CASE WHEN is_hybrid_listed_dom_eligible
              AND liq_p75_days_on_market IS NOT NULL
              AND current_dom_days > liq_p75_days_on_market
            THEN 'HYBRID_DOM_ABOVE_COMPARABLE_P75' END)
    ) AS t(code)
    WHERE code IS NOT NULL
  ) AS new_hybrid_dom_reason_codes
FROM qualifies;

-- These two codes are APPENDED (median before p75) to the item's existing
-- reason_codes array — every pre-existing code (HYBRID_REVIEW_REQUIRED,
-- HYBRID_LISTED_SIGNAL/HYBRID_UNLISTED_SIGNAL, HYBRID_LONG_HOLD_SIGNAL,
-- HYBRID_HIGH_CAPITAL_SIGNAL, HYBRID_LOW_UPSIDE_SIGNAL, HYBRID_RECENT_ITEM
-- / HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY) keeps its exact prior relative
-- order and spelling — nothing is renamed, reordered, or removed. Business
-- and Personal rows, and any Hybrid row that fails the eligibility gate
-- above, are returned byte-identical to v2.11.
