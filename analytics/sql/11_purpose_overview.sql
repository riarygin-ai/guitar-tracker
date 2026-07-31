-- ============================================================================
-- 11_purpose_overview.sql
--
-- Business questions:
--   - How is the whole shared inventory population distributed across
--     Business, Hybrid, and Personal (by CURRENT Purpose)?
--   - How many items have no Purpose assigned, or a Purpose with no
--     analytics policy row yet?
--   - Does each Purpose's disposition policy (urgency, expected holding
--     behavior) look right against its actual population/capital/profit
--     numbers?
--   - For one target user: how is THEIR OWN inventory distributed across
--     Purpose, and what does their open position look like per Purpose?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle_v2` (public.analytics_purpose_policy is
-- already joined into that view — see its own migration,
-- 20260810000000_analytics_item_lifecycle_v2.sql). Nothing in this file
-- creates a database object (no views/tables/functions/migrations) and
-- nothing here writes to production data. See analytics/README.md.
--
-- Calendar & Seasonality, Findings Selector, Business Coach,
-- recommendations, scores, and any UI redesign are all OUT of scope for
-- this file — see analytics/SEMANTIC_CONTRACT.md. This module also does
-- NOT touch Open Inventory Decision Support (item-level evidence) — it
-- produces aggregate rows only, never an individual item row.
--
-- ── PRIMARY EVIDENCE POPULATION — EVERY PURPOSE, NOT BUSINESS-ONLY ───────
-- Unlike every v1.x module (`purpose_name = 'Business'`), this file reads
-- the FULL analytics_item_lifecycle_v2 population: Business, Hybrid,
-- Personal, items with no Purpose assigned (`missing_purpose`), and items
-- whose Purpose has no analytics_purpose_policy row yet (`missing_policy`).
-- Purpose here controls DISPOSITION AND INTERPRETATION ONLY — it is never
-- an economic eligibility filter. Profit, ROI, acquisition/exit values,
-- and every other financial figure are computed identically regardless of
-- Purpose.
--
-- ── CURRENT PURPOSE, NOT HISTORICAL PURPOSE ──────────────────────────────
-- `current_purpose_id`/`current_purpose_name` (and everything grouped by
-- them below) reflect an item's Purpose RIGHT NOW. Purpose is mutable and
-- this schema keeps no historical record of what an item's Purpose was at
-- any past date — a Personal item that was Business six months ago
-- appears here as Personal for its ENTIRE lifecycle, including profit
-- realized while it may have actually been Business.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A/B are SHARED AGGREGATE EVIDENCE — pooled across every user, no
-- item identity, no per-user grouping anywhere.
-- Query C/D are TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to one
-- user_id, still aggregate-only (no item_id, no item name/model/notes
-- exposed at any point in this file).
--
-- ── PURPOSE_BREAKDOWN / PURPOSE_POSITION_BREAKDOWN GROUPING ──────────────
-- Grouped by (current_purpose_id, current_purpose_name,
-- purpose_policy_status, disposition_mode, realization_priority_order,
-- active_realization_flag, expected_holding_policy). Mapped Purposes
-- (Business/Hybrid/Personal) each get their own row (their disposition
-- policy differs, so they never collapse together). Missing-purpose and
-- missing-policy items collapse into ONE explicit coverage row each
-- (current_purpose_id/name NULLed before grouping) — never merged into a
-- mapped Purpose, "unknown," or an acquisition-method bucket.
-- ============================================================================

-- Query A -> shared_purpose_evidence.population_summary
WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM analytics_item_lifecycle_v2
)
-- CLASSIFICATION: shared aggregate evidence. Reconciliation: open +
-- realized = total; listed_open + unlisted_open = open; positive +
-- zero_assigned + unknown (acquisition value) = total (assumes no
-- negative_invalid rows exist, matching every other module in this
-- analytics layer); mapped + missing_purpose + missing_policy = total;
-- reliable + unreliable acquisition date = total.
SELECT
  COUNT(*)                                                                       AS total_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
  SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
  COUNT(*) FILTER (WHERE purpose_policy_status = 'mapped')                       AS mapped_purpose_item_count,
  COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_purpose')              AS missing_purpose_item_count,
  COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_policy')               AS missing_policy_item_count,
  COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
  COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
  COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND acquisition_date IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_acquisition_date_item_count,
  COUNT(*) FILTER (WHERE is_historical_import OR acquisition_date IS NULL OR has_lifecycle_date_issue)               AS unreliable_acquisition_date_item_count
FROM all_items;

-- ============================================================================
-- Query B -> shared_purpose_evidence.purpose_breakdown
-- CLASSIFICATION: shared aggregate evidence. One row per mapped Purpose
-- (Business/Hybrid/Personal), plus one missing_purpose row and one
-- missing_policy row. Profit/ROI use realized items only; ROI additionally
-- requires a positive acquisition value; DOM uses realized items with a
-- reliable global_days_on_market; holding metrics exclude Historical
-- Imports and lifecycle-date issues (this analytics layer's standard
-- reliable-date rule, unchanged here).
-- ============================================================================

WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM analytics_item_lifecycle_v2
)
SELECT
  group_purpose_id                                                               AS current_purpose_id,
  group_purpose_name                                                             AS current_purpose_name,
  purpose_policy_status,
  disposition_mode,
  realization_priority_order,
  active_realization_flag,
  expected_holding_policy,
  COUNT(*)                                                                       AS total_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
  SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
  COUNT(*) FILTER (WHERE is_realized AND acquisition_value_status = 'positive')  AS realized_positive_acquisition_item_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
  COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_ownership_age_open_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND (is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue))             AS unreliable_ownership_age_open_item_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_open_ownership_age_days
FROM all_items
GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy
ORDER BY
  CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
  realization_priority_order NULLS LAST,
  current_purpose_name NULLS LAST;

-- ============================================================================
-- Query C -> target_user_purpose_evidence.position_summary
-- CLASSIFICATION: target-user-only aggregate evidence. Restricted to one
-- user_id — no other user's data is aggregated into these numbers. Still
-- an aggregate: no item_id, item name, model, or notes appears anywhere.
-- ============================================================================

WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
)
SELECT
  COUNT(*)                                                                       AS total_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
  SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
  COUNT(*) FILTER (WHERE purpose_policy_status = 'mapped')                       AS mapped_purpose_item_count,
  COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_purpose')              AS missing_purpose_item_count,
  COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_policy')               AS missing_policy_item_count
FROM all_items;

-- ============================================================================
-- Query D -> target_user_purpose_evidence.purpose_position_breakdown
-- CLASSIFICATION: target-user-only aggregate evidence. Same grouping rule
-- as Query B, scoped to one user_id. Never exposes an individual item row
-- — contrast with Open Inventory Decision Support's item_decision_evidence
-- (analytics/sql/10_open_inventory_decision_support.sql), which this
-- module does not touch.
-- ============================================================================

WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
)
SELECT
  group_purpose_id                                                               AS current_purpose_id,
  group_purpose_name                                                             AS current_purpose_name,
  purpose_policy_status,
  disposition_mode,
  realization_priority_order,
  active_realization_flag,
  expected_holding_policy,
  COUNT(*)                                                                       AS total_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
  SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
  COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
  SUM(estimated_sold_value - acquisition_value - item_expenses_total)
    FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_open_net_upside,
  COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_ownership_age_open_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND (is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue))             AS unreliable_ownership_age_open_item_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_open_ownership_age_days,
  COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS open_items_ownership_age_60_plus,
  COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS open_items_ownership_age_120_plus
FROM all_items
GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy
ORDER BY
  CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
  realization_priority_order NULLS LAST,
  current_purpose_name NULLS LAST;

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Purpose-based rows here are descriptive breakdowns, not a ranking or a
-- recommendation. active_realization_flag = false (Personal) does not
-- mean those items are unimportant — it means active realization is not
-- expected under that Purpose's policy. A missing_purpose or
-- missing_policy row is a data-coverage gap to close (assign a Purpose;
-- add a policy row for a new Purpose), not a judgment about those items.
-- Every median/percentage above inherits the same small-sample caveats as
-- every other module in this analytics layer — no confidence label is
-- computed in this file (unlike Open Inventory Decision Support's cohort
-- confidence), since no cohort-selection or comparison logic exists here.
