-- ============================================================================
-- 15_acquisition_to_exit_analysis_v2.sql
--
-- Purpose-aware v2 port of 02_acquisition_to_exit_analysis.sql / the v1.1
-- helper public._build_acquisition_to_exit_snapshot_v1_1(). See
-- public._build_acquisition_economics_snapshot_v2(int)
-- (supabase/migrations/20260814000000_build_analytics_snapshot_v2_3.sql)
-- for the actual transformation; nothing in this file creates a database
-- object and nothing here writes to production data.
--
-- ── WHAT CHANGED FROM v1 ──────────────────────────────────────────────────
-- Population is analytics_item_lifecycle_v2's FULL population — Business,
-- Hybrid, Personal, missing_purpose, missing_policy — instead of
-- `purpose_name = 'Business'`. Every section below is produced twice: once
-- pooled across ALL purposes, once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status), using the SAME missing-
-- purpose/missing-policy collapsing rule as 14_acquisition_value_band_
-- performance_v2.sql and every other v2 module.
--
-- ── WHAT DID NOT CHANGE ───────────────────────────────────────────────────
-- `eligible` (realized, positive acquisition value, positive exit value),
-- the acquisition/exit value banding (a single "Zero / unknown" catch-all
-- band, order 0 — distinct from Module 1's separate zero_assigned/unknown/
-- negative categories, matching v1.1 Query B/C/D verbatim), value_movement
-- classification (moved_down / stayed_in_same_band / moved_up), Historical
-- Import inclusion in every eligible metric, and the confidence-tier
-- convention are all copied verbatim from the v1.1 source.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- Ports population coverage, banded performance (Query B), the acquisition-
-- to-exit-band transition matrix (Query C), and acquisition/exit method
-- paths (Query D). Movement summary (C2, a derived rollup of C),
-- method-paths-by-band (E, a cross of C and D), purchase-price-band and
-- sale-price-band (F/G, a third banding dimension), and the integrity
-- diagnostic (A2) are NOT ported — see the migration file's own header for
-- the full scope-decision rationale.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_acquisition_evidence.acquisition_to_exit_analysis
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
),
realized AS (
  SELECT * FROM all_items WHERE is_realized
),
eligible AS (
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
    END AS acq_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acq_band_label,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS exit_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 'Zero / unknown'
      WHEN exit_value < 1000 THEN '$1-999'
      WHEN exit_value < 2000 THEN '$1,000-1,999'
      WHEN exit_value < 3000 THEN '$2,000-2,999'
      WHEN exit_value < 4000 THEN '$3,000-3,999'
      WHEN exit_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS exit_band_label
  FROM realized
  WHERE acquisition_value_status = 'positive' AND exit_value IS NOT NULL AND exit_value > 0
),
pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM all_items)                                    AS total_item_count,
    (SELECT COUNT(*) FROM realized)                                     AS realized_item_count,
    (SELECT COUNT(*) FROM eligible)                                     AS eligible_transition_item_count,
    (SELECT COUNT(*) FROM realized WHERE exit_type = 'sale')            AS total_sale_exit_count,
    (SELECT COUNT(*) FROM realized WHERE exit_type = 'trade')           AS total_trade_exit_count,
    (SELECT COUNT(*) FROM eligible WHERE exit_type = 'sale')            AS eligible_sale_exit_count,
    (SELECT COUNT(*) FROM eligible WHERE exit_type = 'trade')           AS eligible_trade_exit_count,
    (SELECT COUNT(*) FROM eligible WHERE is_historical_import)          AS historical_eligible_count,
    (SELECT COUNT(*) FROM eligible WHERE NOT is_historical_import)      AS app_tracked_eligible_count
),
movement AS (
  SELECT
    *,
    CASE
      WHEN exit_band_order < acq_band_order THEN 'moved_down'
      WHEN exit_band_order = acq_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM eligible
),
transition_agg AS (
  SELECT
    acq_band_order, acq_band_label, exit_band_order, exit_band_label, value_movement,
    COUNT(*)                                                                       AS item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi
  FROM movement
  GROUP BY acq_band_order, acq_band_label, exit_band_order, exit_band_label, value_movement
),
transition_shared AS (
  SELECT *, SUM(item_count) OVER (PARTITION BY acq_band_order) AS acquisition_band_total, SUM(item_count) OVER () AS grand_total
  FROM transition_agg
),
transition_rows AS (
  SELECT
    acq_band_order AS acquisition_value_band_order, acq_band_label AS acquisition_value_band_label,
    exit_band_order AS exit_value_band_order, exit_band_label AS exit_value_band_label,
    item_count,
    ROUND(item_count::numeric / NULLIF(acquisition_band_total, 0) * 100, 2) AS share_within_acquisition_band_percent,
    ROUND(item_count::numeric / NULLIF(grand_total, 0) * 100, 2)            AS share_of_all_transition_items_percent,
    median_net_profit, median_roi, value_movement,
    CASE WHEN item_count <= 2 THEN 'insufficient' WHEN item_count <= 5 THEN 'low' WHEN item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM transition_shared
),
method_rows AS (
  SELECT
    acquisition_method, exit_type AS exit_method,
    COUNT(*)                                                                       AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM eligible
  GROUP BY acquisition_method, exit_type
)
SELECT jsonb_build_object(
  'population_summary',   (SELECT COALESCE(jsonb_agg(to_jsonb(pop_row)), '[]'::jsonb) FROM pop_row),
  'transition_matrix',    (SELECT COALESCE(jsonb_agg(to_jsonb(transition_rows) ORDER BY acquisition_value_band_order, exit_value_band_order), '[]'::jsonb) FROM transition_rows),
  'method_paths',         (SELECT COALESCE(jsonb_agg(to_jsonb(method_rows) ORDER BY acquisition_method, exit_method), '[]'::jsonb) FROM method_rows)
);

-- ============================================================================
-- Query B -> target_user_acquisition_evidence.acquisition_to_exit_analysis
-- CLASSIFICATION: target-user-only aggregate evidence (REPLACE 2 with a
-- real user id). Identical logic to Query A, scoped to one user_id.
-- ============================================================================

WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status
  FROM analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
realized AS (
  SELECT * FROM all_items WHERE is_realized
),
eligible AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acq_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acq_band_label
  FROM realized
  WHERE acquisition_value_status = 'positive' AND exit_value IS NOT NULL AND exit_value > 0
),
pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM all_items)                          AS total_item_count,
    (SELECT COUNT(*) FROM realized)                           AS realized_item_count,
    (SELECT COUNT(*) FROM eligible)                            AS eligible_transition_item_count
),
band_rows AS (
  SELECT
    acq_band_order AS acquisition_value_band_order, acq_band_label AS acquisition_value_band_label,
    COUNT(*)                                                                       AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi
  FROM eligible
  GROUP BY acq_band_order, acq_band_label
)
SELECT jsonb_build_object(
  'population_summary',        (SELECT COALESCE(jsonb_agg(to_jsonb(pop_row)), '[]'::jsonb) FROM pop_row),
  'performance_by_band',       (SELECT COALESCE(jsonb_agg(to_jsonb(band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM band_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 02_acquisition_to_exit_analysis.sql: `eligible` requires BOTH a
-- positive acquisition value and a positive exit value — a transition row
-- describes value movement, not causation. Small groups (item_count < 5)
-- are not yet reliable conclusions — see each row's own confidence tier.
-- Purpose breakdown rows are descriptive only — no urgency, recommendation,
-- score, or AI prose exists anywhere in this file.
