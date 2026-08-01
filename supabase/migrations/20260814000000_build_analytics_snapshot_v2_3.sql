-- build_analytics_snapshot_v2_3
--
-- Analytics v2.3 — Acquisition Economics. Ports two v1 modules to
-- Purpose-aware v2 semantics: Acquisition Value Band Performance
-- (analytics/sql/01_acquisition_value_band_performance.sql, v1.1 helper
-- _build_acquisition_value_band_snapshot_v1_1) and Acquisition-to-Exit
-- Analysis (analytics/sql/02_acquisition_to_exit_analysis.sql, v1.1
-- helper _build_acquisition_to_exit_snapshot_v1_1). Adds a NEW helper and
-- a NEW top-level builder that calls build_analytics_snapshot_v2_2
-- WHOLESALE and adds two new top-level sections, shared_acquisition_
-- evidence and target_user_acquisition_evidence. Does NOT call, embed, or
-- replace any v1.0-v1.8 or v2.0-v2.2 builder — those remain entirely
-- unchanged and independently callable.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_acquisition_economics_snapshot_v2(int) -- NEW
--   public.build_analytics_snapshot_v2_3(int)              -- NEW
--
-- ── POPULATION — EVERY ITEM, EVERY PURPOSE ───────────────────────────────
-- Unlike v1.x (purpose_name = 'Business' only), this module reads
-- analytics_item_lifecycle_v2's full population: Business, Hybrid,
-- Personal, missing_purpose, missing_policy. Purpose is the item's
-- CURRENT disposition only (mutable, no historical record — see
-- analytics_item_lifecycle_v2's own migration header) — it is never an
-- economic eligibility filter here, exactly as in every prior v2 module.
-- Every section below is produced twice: once pooled across ALL purposes
-- (an "all-purpose" row/set), and once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status) — the SAME
-- missing-purpose/missing-policy collapsing rule established in v2.0
-- (analytics_purpose_policy / analytics_item_lifecycle_v2): a missing-
-- purpose item's current_purpose_id/name are NULLed before grouping so
-- every item lacking a Purpose collapses into ONE missing_purpose row,
-- and every item whose Purpose lacks a policy row collapses into ONE
-- missing_policy row, regardless of which unmapped Purpose it is.
--
-- ── SCOPE DECISION — WHICH v1 QUERIES ARE PORTED ─────────────────────────
-- Both v1.1 snapshot helpers are large (population coverage, banded
-- performance, zero/unknown-value summaries, equal-size quartiles,
-- capital-efficiency sensitivity, open-listed/open-unlisted inventory,
-- category cross-cuts, cohort/method/outlier robustness checks, integrity
-- diagnostics — 12-16 sections each). This module ports the PRIMARY,
-- load-bearing sections of each — the ones the module's own name
-- describes and that every other section exists to stress-test — and
-- deliberately omits secondary robustness/diagnostic sections (equal-size
-- quartiles, whose boundaries are explicitly "not a stable reporting
-- definition" per 01's own header; capital-efficiency sensitivity;
-- open-inventory-by-band, which substantially overlaps v1.7 Capital &
-- Liquidity and v2.1 Open Inventory Decision Support; category cross-cuts;
-- and every cohort/outlier/integrity diagnostic query, consistent with
-- the precedent already set by v1.1 itself excluding its OWN Query
-- G2/G5 dev-only per-user/item-level drilldowns from the snapshot). Ported:
--   Value Band Performance: population coverage, banded performance
--     (positive acquisition value, Query B), zero-assigned summary
--     (Query B-ZERO), unknown-acquisition summary (Query B-UNKNOWN).
--   Acquisition-to-Exit: population coverage, banded performance
--     (Query B), transition matrix (Query C), method paths (Query D).
-- Field names, band boundaries, exclusion rules, and confidence tiers are
-- copied verbatim from the v1.1 source queries named above wherever the
-- underlying population is unchanged (open+realized items with a positive
-- acquisition value for Value Band Performance; realized items with
-- positive acquisition AND positive exit value for Acquisition-to-Exit).
--
-- ── SEMANTIC RULES PRESERVED FROM v1 ──────────────────────────────────────
-- - acquisition_value is a cash purchase value OR an assigned incoming
--   trade value — never called "purchase price" here either.
-- - acquisition_method distinguishes purchase / trade / unknown (the view's
--   own CASE already collapses Historical Import/Purchase/Trade deal types
--   into 'unknown' for acquisition_method while is_historical_import keeps
--   the historical distinction separately — unchanged from v1).
-- - Historical Imports participate FULLY in acquisition value, exit value,
--   profit, ROI, transition counts, and DOM (global_days_on_market) — they
--   are excluded ONLY from holding_days-based duration metrics (holding_
--   sample_size/median_holding_days), because acquisition_date is the one
--   field treated as approximate for those rows. Rows with
--   has_lifecycle_date_issue are excluded from the same holding-based
--   metrics for the same reason (unreliable date), independent of
--   Purpose.
-- - ROI requires a positive acquisition value (the view's own roi column
--   is already NULL otherwise — nothing here overrides that).
-- - Zero-assigned (acquisition_value = 0) and unknown (acquisition_value
--   IS NULL) values remain visible in coverage counts but are excluded
--   from the positive-value-band performance rows and from ROI; a
--   zero-assigned item's net_profit remains fully calculable (ordinary
--   arithmetic against zero), never confused with "unknown."
-- - Additive totals (counts, capital sums) return 0 for an empty group via
--   COALESCE; medians/percentiles/ROI/durations remain NULL when no valid
--   sample exists — never fabricated as 0.
-- - Realization rate for Hybrid/Personal purpose_population_summary rows
--   is descriptive only — no urgency, recommendation, score, or AI prose
--   is produced anywhere in this module (consistent with every prior v2
--   module).
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- shared_acquisition_evidence pools every user's items (aggregate only —
-- no item_id, item name, model, or other item identity, and no row
-- grouped by user_id). target_user_acquisition_evidence is filtered to
-- `user_id = p_target_user_id` and is, like the shared section, aggregate
-- only — no individual item row is produced anywhere in this module.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_acquisition_economics_snapshot_v2(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    CASE
      WHEN acquisition_value IS NULL THEN 8
      WHEN acquisition_value = 0    THEN 0
      WHEN acquisition_value < 0    THEN -1
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL THEN 'Unknown acquisition value'
      WHEN acquisition_value = 0    THEN 'Zero assigned value'
      WHEN acquisition_value < 0    THEN 'Negative (invalid)'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
target_items AS (
  SELECT * FROM all_items WHERE user_id = p_target_user_id
),

-- ============================================================================
-- MODULE 1: Acquisition Value Band Performance — SHARED (pooled, all users)
-- ============================================================================

-- population_summary / purpose_population_summary
m1s_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_import_item_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL)               AS raw_realized_holding_days_present_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS eligible_realized_holding_days_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND (is_historical_import OR has_lifecycle_date_issue))        AS excluded_realized_holding_days_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value) FILTER (WHERE acquisition_value_status = 'positive')::numeric, 2) AS median_acquisition_value_positive
  FROM all_items
),
m1s_pop_purpose_rows AS (
  SELECT
    group_purpose_id                                                               AS current_purpose_id,
    group_purpose_name                                                             AS current_purpose_name,
    purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_import_item_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL)               AS raw_realized_holding_days_present_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS eligible_realized_holding_days_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND (is_historical_import OR has_lifecycle_date_issue))        AS excluded_realized_holding_days_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value) FILTER (WHERE acquisition_value_status = 'positive')::numeric, 2) AS median_acquisition_value_positive
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- band_performance / band_performance_by_purpose (Query B: positive
-- acquisition value, open + realized)
m1s_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
m1s_band_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1s_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
m1s_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1s_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_value_band_order, acquisition_value_band_label
),

-- zero_assigned_summary / zero_assigned_summary_by_purpose (Query B-ZERO)
m1s_zero AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'zero_assigned'
),
m1s_zero_row AS (
  SELECT
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND net_profit IS NOT NULL)                 AS net_profit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized AND net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    COALESCE(SUM(net_profit) FILTER (WHERE is_realized), 0)                        AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE is_realized)                                            AS roi_undefined_zero_acquisition_count,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1s_zero
),
m1s_zero_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND net_profit IS NOT NULL)                 AS net_profit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized AND net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    COALESCE(SUM(net_profit) FILTER (WHERE is_realized), 0)                        AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE is_realized)                                            AS roi_undefined_zero_acquisition_count,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1s_zero
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- unknown_acquisition_summary / unknown_acquisition_summary_by_purpose (Query B-UNKNOWN)
m1s_unknown AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'unknown'
),
m1s_unknown_row AS (
  SELECT
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m1s_unknown
),
m1s_unknown_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m1s_unknown
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- ============================================================================
-- MODULE 1: Acquisition Value Band Performance — TARGET USER ONLY
-- ============================================================================
m1t_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_import_item_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL)               AS raw_realized_holding_days_present_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS eligible_realized_holding_days_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND (is_historical_import OR has_lifecycle_date_issue))        AS excluded_realized_holding_days_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value) FILTER (WHERE acquisition_value_status = 'positive')::numeric, 2) AS median_acquisition_value_positive
  FROM target_items
),
m1t_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_import_item_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL)               AS raw_realized_holding_days_present_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS eligible_realized_holding_days_count,
    COUNT(*) FILTER (WHERE is_realized AND holding_days IS NOT NULL AND (is_historical_import OR has_lifecycle_date_issue))        AS excluded_realized_holding_days_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value) FILTER (WHERE acquisition_value_status = 'positive')::numeric, 2) AS median_acquisition_value_positive
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),
m1t_eligible AS (
  SELECT * FROM target_items WHERE acquisition_value_status = 'positive'
),
m1t_band_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1t_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
m1t_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1t_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_value_band_order, acquisition_value_band_label
),
m1t_zero AS (
  SELECT * FROM target_items WHERE acquisition_value_status = 'zero_assigned'
),
m1t_zero_row AS (
  SELECT
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND net_profit IS NOT NULL)                 AS net_profit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized AND net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    COALESCE(SUM(net_profit) FILTER (WHERE is_realized), 0)                        AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE is_realized)                                            AS roi_undefined_zero_acquisition_count,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1t_zero
),
m1t_zero_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND net_profit IS NOT NULL)                 AS net_profit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized AND net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    COALESCE(SUM(net_profit) FILTER (WHERE is_realized), 0)                        AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE is_realized)                                            AS roi_undefined_zero_acquisition_count,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM m1t_zero
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),
m1t_unknown AS (
  SELECT * FROM target_items WHERE acquisition_value_status = 'unknown'
),
m1t_unknown_row AS (
  SELECT
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m1t_unknown
),
m1t_unknown_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m1t_unknown
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- ============================================================================
-- MODULE 2: Acquisition-to-Exit Analysis — SHARED (pooled, all users)
-- Distinct banding scheme from Module 1: a single "Zero / unknown"
-- catch-all (order 0) for non-positive acquisition/exit values, matching
-- v1.1 Query B/C/D verbatim (in practice this band never has members here
-- since `eligible` already requires both values positive).
-- ============================================================================
m2s_realized AS (
  SELECT * FROM all_items WHERE is_realized
),
m2s_eligible AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS m2_acq_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS m2_acq_band_label,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS m2_exit_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 'Zero / unknown'
      WHEN exit_value < 1000 THEN '$1-999'
      WHEN exit_value < 2000 THEN '$1,000-1,999'
      WHEN exit_value < 3000 THEN '$2,000-2,999'
      WHEN exit_value < 4000 THEN '$3,000-3,999'
      WHEN exit_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS m2_exit_band_label
  FROM m2s_realized
  WHERE acquisition_value_status = 'positive' AND exit_value IS NOT NULL AND exit_value > 0
),

-- population_summary / purpose_population_summary
m2s_pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM all_items)                                               AS total_item_count,
    (SELECT COUNT(*) FROM m2s_realized)                                            AS realized_item_count,
    (SELECT COUNT(*) FROM m2s_eligible)                                            AS eligible_transition_item_count,
    (SELECT COUNT(*) FROM m2s_realized WHERE exit_type = 'sale')                   AS total_sale_exit_count,
    (SELECT COUNT(*) FROM m2s_realized WHERE exit_type = 'trade')                  AS total_trade_exit_count,
    (SELECT COUNT(*) FROM m2s_eligible WHERE exit_type = 'sale')                   AS eligible_sale_exit_count,
    (SELECT COUNT(*) FROM m2s_eligible WHERE exit_type = 'trade')                  AS eligible_trade_exit_count,
    (SELECT COUNT(*) FROM m2s_realized WHERE acquisition_value_status = 'zero_assigned') AS excluded_zero_acquisition_count,
    (SELECT COUNT(*) FROM m2s_realized WHERE acquisition_value_status = 'unknown')       AS excluded_unknown_acquisition_count,
    (SELECT COUNT(*) FROM m2s_realized WHERE exit_value IS NULL OR exit_value <= 0)      AS excluded_exit_value_missing_or_nonpositive_count,
    (SELECT COUNT(*) FROM m2s_eligible WHERE is_historical_import)                 AS historical_eligible_count,
    (SELECT COUNT(*) FROM m2s_eligible WHERE NOT is_historical_import)             AS app_tracked_eligible_count
),
m2s_pop_purpose_rows AS (
  SELECT
    r.group_purpose_id AS current_purpose_id, r.group_purpose_name AS current_purpose_name, r.purpose_policy_status,
    COUNT(*) FILTER (WHERE true)                                                   AS realized_item_count,
    COUNT(e.item_id)                                                               AS eligible_transition_item_count,
    COUNT(*) FILTER (WHERE r.exit_type = 'sale')                                   AS total_sale_exit_count,
    COUNT(*) FILTER (WHERE r.exit_type = 'trade')                                  AS total_trade_exit_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'sale')                           AS eligible_sale_exit_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'trade')                          AS eligible_trade_exit_count,
    COUNT(*) FILTER (WHERE r.acquisition_value_status = 'zero_assigned')           AS excluded_zero_acquisition_count,
    COUNT(*) FILTER (WHERE r.acquisition_value_status = 'unknown')                 AS excluded_unknown_acquisition_count,
    COUNT(*) FILTER (WHERE r.exit_value IS NULL OR r.exit_value <= 0)              AS excluded_exit_value_missing_or_nonpositive_count,
    COUNT(e.item_id) FILTER (WHERE e.is_historical_import)                         AS historical_eligible_count,
    COUNT(e.item_id) FILTER (WHERE NOT e.is_historical_import)                     AS app_tracked_eligible_count
  FROM m2s_realized r
  LEFT JOIN m2s_eligible e ON e.item_id = r.item_id
  GROUP BY r.group_purpose_id, r.group_purpose_name, r.purpose_policy_status
),

-- performance_by_band / performance_by_band_by_purpose (Query B)
m2s_band_rows AS (
  SELECT
    m2_acq_band_order, m2_acq_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2s_eligible
  GROUP BY m2_acq_band_order, m2_acq_band_label
),
m2s_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    m2_acq_band_order, m2_acq_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2s_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, m2_acq_band_order, m2_acq_band_label
),

-- transition_matrix / transition_matrix_by_purpose (Query C)
m2s_movement AS (
  SELECT
    *,
    CASE
      WHEN m2_exit_band_order < m2_acq_band_order THEN 'moved_down'
      WHEN m2_exit_band_order = m2_acq_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM m2s_eligible
),
m2s_transition_agg AS (
  SELECT
    m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m2s_movement
  GROUP BY m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement
),
m2s_transition_shared AS (
  SELECT *, SUM(item_count) OVER (PARTITION BY m2_acq_band_order) AS acquisition_band_total, SUM(item_count) OVER () AS grand_total
  FROM m2s_transition_agg
),
m2s_transition_rows AS (
  SELECT
    m2_acq_band_order AS acquisition_value_band_order, m2_acq_band_label AS acquisition_value_band_label,
    m2_exit_band_order AS exit_value_band_order, m2_exit_band_label AS exit_value_band_label,
    item_count,
    ROUND(item_count::numeric / NULLIF(acquisition_band_total, 0) * 100, 2)         AS share_within_acquisition_band_percent,
    ROUND(item_count::numeric / NULLIF(grand_total, 0) * 100, 2)                    AS share_of_all_transition_items_percent,
    median_acquisition_value, median_exit_value, median_value_increase, median_net_profit, median_roi, median_days_on_market,
    sale_exit_count, trade_exit_count, value_movement,
    CASE WHEN item_count <= 2 THEN 'insufficient' WHEN item_count <= 5 THEN 'low' WHEN item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2s_transition_shared
),
m2s_transition_purpose_agg AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m2s_movement
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement
),
m2s_transition_purpose_shared AS (
  SELECT *, SUM(item_count) OVER (PARTITION BY current_purpose_id, purpose_policy_status, m2_acq_band_order) AS acquisition_band_total,
         SUM(item_count) OVER (PARTITION BY current_purpose_id, purpose_policy_status)                       AS grand_total
  FROM m2s_transition_purpose_agg
),
m2s_transition_purpose_rows AS (
  SELECT
    current_purpose_id, current_purpose_name, purpose_policy_status,
    m2_acq_band_order AS acquisition_value_band_order, m2_acq_band_label AS acquisition_value_band_label,
    m2_exit_band_order AS exit_value_band_order, m2_exit_band_label AS exit_value_band_label,
    item_count,
    ROUND(item_count::numeric / NULLIF(acquisition_band_total, 0) * 100, 2)         AS share_within_acquisition_band_percent,
    ROUND(item_count::numeric / NULLIF(grand_total, 0) * 100, 2)                    AS share_of_all_transition_items_percent,
    median_acquisition_value, median_exit_value, median_value_increase, median_net_profit, median_roi, median_days_on_market,
    sale_exit_count, trade_exit_count, value_movement,
    CASE WHEN item_count <= 2 THEN 'insufficient' WHEN item_count <= 5 THEN 'low' WHEN item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2s_transition_purpose_shared
),

-- method_paths / method_paths_by_purpose (Query D)
m2s_method_rows AS (
  SELECT
    acquisition_method, exit_type AS exit_method,
    COUNT(*)                                                                       AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_historical_import)                                      AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                  AS app_tracked_item_count,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2s_eligible
  GROUP BY acquisition_method, exit_type
),
m2s_method_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    acquisition_method, exit_type AS exit_method,
    COUNT(*)                                                                       AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_historical_import)                                      AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                  AS app_tracked_item_count,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2s_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_method, exit_type
),

-- ============================================================================
-- MODULE 2: Acquisition-to-Exit Analysis — TARGET USER ONLY
-- ============================================================================
m2t_realized AS (
  SELECT * FROM target_items WHERE is_realized
),
m2t_eligible AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS m2_acq_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS m2_acq_band_label,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS m2_exit_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 'Zero / unknown'
      WHEN exit_value < 1000 THEN '$1-999'
      WHEN exit_value < 2000 THEN '$1,000-1,999'
      WHEN exit_value < 3000 THEN '$2,000-2,999'
      WHEN exit_value < 4000 THEN '$3,000-3,999'
      WHEN exit_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS m2_exit_band_label
  FROM m2t_realized
  WHERE acquisition_value_status = 'positive' AND exit_value IS NOT NULL AND exit_value > 0
),
m2t_pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM target_items)                                            AS total_item_count,
    (SELECT COUNT(*) FROM m2t_realized)                                            AS realized_item_count,
    (SELECT COUNT(*) FROM m2t_eligible)                                            AS eligible_transition_item_count,
    (SELECT COUNT(*) FROM m2t_realized WHERE exit_type = 'sale')                   AS total_sale_exit_count,
    (SELECT COUNT(*) FROM m2t_realized WHERE exit_type = 'trade')                  AS total_trade_exit_count,
    (SELECT COUNT(*) FROM m2t_eligible WHERE exit_type = 'sale')                   AS eligible_sale_exit_count,
    (SELECT COUNT(*) FROM m2t_eligible WHERE exit_type = 'trade')                  AS eligible_trade_exit_count,
    (SELECT COUNT(*) FROM m2t_realized WHERE acquisition_value_status = 'zero_assigned') AS excluded_zero_acquisition_count,
    (SELECT COUNT(*) FROM m2t_realized WHERE acquisition_value_status = 'unknown')       AS excluded_unknown_acquisition_count,
    (SELECT COUNT(*) FROM m2t_realized WHERE exit_value IS NULL OR exit_value <= 0)      AS excluded_exit_value_missing_or_nonpositive_count,
    (SELECT COUNT(*) FROM m2t_eligible WHERE is_historical_import)                 AS historical_eligible_count,
    (SELECT COUNT(*) FROM m2t_eligible WHERE NOT is_historical_import)             AS app_tracked_eligible_count
),
m2t_pop_purpose_rows AS (
  SELECT
    r.group_purpose_id AS current_purpose_id, r.group_purpose_name AS current_purpose_name, r.purpose_policy_status,
    COUNT(*) FILTER (WHERE true)                                                   AS realized_item_count,
    COUNT(e.item_id)                                                               AS eligible_transition_item_count,
    COUNT(*) FILTER (WHERE r.exit_type = 'sale')                                   AS total_sale_exit_count,
    COUNT(*) FILTER (WHERE r.exit_type = 'trade')                                  AS total_trade_exit_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'sale')                           AS eligible_sale_exit_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'trade')                          AS eligible_trade_exit_count,
    COUNT(*) FILTER (WHERE r.acquisition_value_status = 'zero_assigned')           AS excluded_zero_acquisition_count,
    COUNT(*) FILTER (WHERE r.acquisition_value_status = 'unknown')                 AS excluded_unknown_acquisition_count,
    COUNT(*) FILTER (WHERE r.exit_value IS NULL OR r.exit_value <= 0)              AS excluded_exit_value_missing_or_nonpositive_count,
    COUNT(e.item_id) FILTER (WHERE e.is_historical_import)                         AS historical_eligible_count,
    COUNT(e.item_id) FILTER (WHERE NOT e.is_historical_import)                     AS app_tracked_eligible_count
  FROM m2t_realized r
  LEFT JOIN m2t_eligible e ON e.item_id = r.item_id
  GROUP BY r.group_purpose_id, r.group_purpose_name, r.purpose_policy_status
),
m2t_band_rows AS (
  SELECT
    m2_acq_band_order, m2_acq_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2t_eligible
  GROUP BY m2_acq_band_order, m2_acq_band_label
),
m2t_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    m2_acq_band_order, m2_acq_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2t_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, m2_acq_band_order, m2_acq_band_label
),
m2t_movement AS (
  SELECT
    *,
    CASE
      WHEN m2_exit_band_order < m2_acq_band_order THEN 'moved_down'
      WHEN m2_exit_band_order = m2_acq_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM m2t_eligible
),
m2t_transition_agg AS (
  SELECT
    m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m2t_movement
  GROUP BY m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement
),
m2t_transition_shared AS (
  SELECT *, SUM(item_count) OVER (PARTITION BY m2_acq_band_order) AS acquisition_band_total, SUM(item_count) OVER () AS grand_total
  FROM m2t_transition_agg
),
m2t_transition_rows AS (
  SELECT
    m2_acq_band_order AS acquisition_value_band_order, m2_acq_band_label AS acquisition_value_band_label,
    m2_exit_band_order AS exit_value_band_order, m2_exit_band_label AS exit_value_band_label,
    item_count,
    ROUND(item_count::numeric / NULLIF(acquisition_band_total, 0) * 100, 2)         AS share_within_acquisition_band_percent,
    ROUND(item_count::numeric / NULLIF(grand_total, 0) * 100, 2)                    AS share_of_all_transition_items_percent,
    median_acquisition_value, median_exit_value, median_value_increase, median_net_profit, median_roi, median_days_on_market,
    sale_exit_count, trade_exit_count, value_movement,
    CASE WHEN item_count <= 2 THEN 'insufficient' WHEN item_count <= 5 THEN 'low' WHEN item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2t_transition_shared
),
m2t_transition_purpose_agg AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM m2t_movement
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, m2_acq_band_order, m2_acq_band_label, m2_exit_band_order, m2_exit_band_label, value_movement
),
m2t_transition_purpose_shared AS (
  SELECT *, SUM(item_count) OVER (PARTITION BY current_purpose_id, purpose_policy_status, m2_acq_band_order) AS acquisition_band_total,
         SUM(item_count) OVER (PARTITION BY current_purpose_id, purpose_policy_status)                       AS grand_total
  FROM m2t_transition_purpose_agg
),
m2t_transition_purpose_rows AS (
  SELECT
    current_purpose_id, current_purpose_name, purpose_policy_status,
    m2_acq_band_order AS acquisition_value_band_order, m2_acq_band_label AS acquisition_value_band_label,
    m2_exit_band_order AS exit_value_band_order, m2_exit_band_label AS exit_value_band_label,
    item_count,
    ROUND(item_count::numeric / NULLIF(acquisition_band_total, 0) * 100, 2)         AS share_within_acquisition_band_percent,
    ROUND(item_count::numeric / NULLIF(grand_total, 0) * 100, 2)                    AS share_of_all_transition_items_percent,
    median_acquisition_value, median_exit_value, median_value_increase, median_net_profit, median_roi, median_days_on_market,
    sale_exit_count, trade_exit_count, value_movement,
    CASE WHEN item_count <= 2 THEN 'insufficient' WHEN item_count <= 5 THEN 'low' WHEN item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2t_transition_purpose_shared
),
m2t_method_rows AS (
  SELECT
    acquisition_method, exit_type AS exit_method,
    COUNT(*)                                                                       AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_historical_import)                                      AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                  AS app_tracked_item_count,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2t_eligible
  GROUP BY acquisition_method, exit_type
),
m2t_method_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    acquisition_method, exit_type AS exit_method,
    COUNT(*)                                                                       AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_historical_import)                                      AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                  AS app_tracked_item_count,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM m2t_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_method, exit_type
)

SELECT jsonb_build_object(
  'shared_acquisition_evidence', jsonb_build_object(
    'acquisition_value_band_performance', jsonb_build_object(
      'population_summary',                (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_pop_row)), '[]'::jsonb) FROM m1s_pop_row),
      'purpose_population_summary',        (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_pop_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m1s_pop_purpose_rows),
      'band_performance',                  (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM m1s_band_rows),
      'band_performance_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_band_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM m1s_band_purpose_rows),
      'zero_assigned_summary',             (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_zero_row)), '[]'::jsonb) FROM m1s_zero_row),
      'zero_assigned_summary_by_purpose',  (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_zero_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m1s_zero_purpose_rows),
      'unknown_acquisition_summary',       (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_unknown_row)), '[]'::jsonb) FROM m1s_unknown_row),
      'unknown_acquisition_summary_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(m1s_unknown_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m1s_unknown_purpose_rows)
    ),
    'acquisition_to_exit_analysis', jsonb_build_object(
      'population_summary',                (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_pop_row)), '[]'::jsonb) FROM m2s_pop_row),
      'purpose_population_summary',        (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_pop_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m2s_pop_purpose_rows),
      'performance_by_band',               (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_band_rows) ORDER BY m2_acq_band_order), '[]'::jsonb) FROM m2s_band_rows),
      'performance_by_band_by_purpose',    (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_band_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, m2_acq_band_order), '[]'::jsonb) FROM m2s_band_purpose_rows),
      'transition_matrix',                 (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_transition_rows) ORDER BY acquisition_value_band_order, exit_value_band_order), '[]'::jsonb) FROM m2s_transition_rows),
      'transition_matrix_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_transition_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, acquisition_value_band_order, exit_value_band_order), '[]'::jsonb) FROM m2s_transition_purpose_rows),
      'method_paths',                      (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_method_rows) ORDER BY acquisition_method, exit_method), '[]'::jsonb) FROM m2s_method_rows),
      'method_paths_by_purpose',           (SELECT COALESCE(jsonb_agg(to_jsonb(m2s_method_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM m2s_method_purpose_rows)
    )
  ),
  'target_user_acquisition_evidence', jsonb_build_object(
    'acquisition_value_band_performance', jsonb_build_object(
      'population_summary',                (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_pop_row)), '[]'::jsonb) FROM m1t_pop_row),
      'purpose_population_summary',        (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_pop_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m1t_pop_purpose_rows),
      'band_performance',                  (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM m1t_band_rows),
      'band_performance_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_band_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM m1t_band_purpose_rows),
      'zero_assigned_summary',             (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_zero_row)), '[]'::jsonb) FROM m1t_zero_row),
      'zero_assigned_summary_by_purpose',  (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_zero_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m1t_zero_purpose_rows),
      'unknown_acquisition_summary',       (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_unknown_row)), '[]'::jsonb) FROM m1t_unknown_row),
      'unknown_acquisition_summary_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(m1t_unknown_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m1t_unknown_purpose_rows)
    ),
    'acquisition_to_exit_analysis', jsonb_build_object(
      'population_summary',                (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_pop_row)), '[]'::jsonb) FROM m2t_pop_row),
      'purpose_population_summary',        (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_pop_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST), '[]'::jsonb) FROM m2t_pop_purpose_rows),
      'performance_by_band',               (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_band_rows) ORDER BY m2_acq_band_order), '[]'::jsonb) FROM m2t_band_rows),
      'performance_by_band_by_purpose',    (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_band_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, m2_acq_band_order), '[]'::jsonb) FROM m2t_band_purpose_rows),
      'transition_matrix',                 (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_transition_rows) ORDER BY acquisition_value_band_order, exit_value_band_order), '[]'::jsonb) FROM m2t_transition_rows),
      'transition_matrix_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_transition_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, acquisition_value_band_order, exit_value_band_order), '[]'::jsonb) FROM m2t_transition_purpose_rows),
      'method_paths',                      (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_method_rows) ORDER BY acquisition_method, exit_method), '[]'::jsonb) FROM m2t_method_rows),
      'method_paths_by_purpose',           (SELECT COALESCE(jsonb_agg(to_jsonb(m2t_method_purpose_rows) ORDER BY
                                               CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                               current_purpose_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM m2t_method_purpose_rows)
    )
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_acquisition_economics_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_acquisition_economics_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_acquisition_economics_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_acquisition_economics_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_3(p_target_user_id int)
-- Calls build_analytics_snapshot_v2_2 WHOLESALE (which itself validates
-- p_target_user_id and RAISEs on failure — not repeated here), preserves
-- every v2.2 section unchanged, and adds shared_acquisition_evidence /
-- target_user_acquisition_evidence as new top-level keys.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_3(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v22               jsonb;
  v_generated_at       timestamptz := now();
  v_acquisition_econ   jsonb;
BEGIN
  v_v22 := public.build_analytics_snapshot_v2_2(p_target_user_id);
  v_acquisition_econ := public._build_acquisition_economics_snapshot_v2(p_target_user_id);

  RETURN v_v22
    || jsonb_build_object(
         'snapshot_schema_version', '2.3',
         'analytics_definition_version', '2.3',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_acquisition_evidence', v_acquisition_econ -> 'shared_acquisition_evidence',
         'target_user_acquisition_evidence', v_acquisition_econ -> 'target_user_acquisition_evidence'
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_3(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_3(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_3(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_3(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_3(int) IS
  'Analytics v2.3 — Acquisition Economics — the current PRODUCTION '
  'analytics snapshot version. SECURITY INVOKER, service_role execution '
  'only. Calls build_analytics_snapshot_v2_2 wholesale (unchanged) and '
  'adds shared_acquisition_evidence / target_user_acquisition_evidence, '
  'each containing acquisition_value_band_performance and acquisition_'
  'to_exit_analysis ported from the v1.1 snapshot helpers to read every '
  'Purpose (Business/Hybrid/Personal/missing-purpose/missing-policy) '
  'instead of Business only. v1.0-v1.8 and v2.0-v2.2 are completely '
  'unaffected. Persists nothing — see analytics_runs (20260727000000) '
  'for the persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v2.3 contract.';
