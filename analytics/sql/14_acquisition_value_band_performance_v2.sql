-- ============================================================================
-- 14_acquisition_value_band_performance_v2.sql
--
-- Purpose-aware v2 port of 01_acquisition_value_band_performance.sql /
-- the v1.1 helper public._build_acquisition_value_band_snapshot_v1_1().
-- See public._build_acquisition_economics_snapshot_v2(int)
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
-- purpose/missing-policy collapsing rule as every other v2 module (a
-- missing-purpose item's current_purpose_id/name are NULLed before
-- grouping, so all such items collapse into ONE missing_purpose row; same
-- for missing_policy, regardless of which unmapped Purpose it is).
--
-- ── WHAT DID NOT CHANGE ───────────────────────────────────────────────────
-- Band boundaries, acquisition_value_status classification (positive /
-- zero_assigned / unknown / negative_invalid), the zero-assigned-vs-
-- unknown distinction (section 7.1), ROI requiring a positive acquisition
-- value, Historical Import inclusion in profit/ROI/DOM with exclusion ONLY
-- from holding_days-based metrics, and the confidence-tier convention are
-- all copied verbatim from the v1.1 source.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- Ports population coverage, banded performance (positive acquisition
-- value, Query B), zero-assigned summary (Query B-ZERO), and unknown-
-- acquisition summary (Query B-UNKNOWN). Equal-size quartiles (Query C —
-- explicitly not a stable reporting definition), capital-efficiency
-- sensitivity (D1/D2), open-inventory-by-band (E1/E2 — substantially
-- overlaps v1.7 Capital & Liquidity / v2.1 Open Inventory Decision
-- Support), category cross-cuts (F1/F2), and cohort/outlier/integrity
-- diagnostics (G1/G3/G4/G5A) are NOT ported — see the migration file's own
-- header for the full scope-decision rationale.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_acquisition_evidence.acquisition_value_band_performance
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
  FROM analytics_item_lifecycle_v2
),
eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
zero_assigned AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'zero_assigned'
),
unknown_acquisition AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'unknown'
),
pop_row AS (
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
pop_purpose_rows AS (
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
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value) FILTER (WHERE acquisition_value_status = 'positive')::numeric, 2) AS median_acquisition_value_positive
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),
band_rows AS (
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
  FROM eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
zero_row AS (
  SELECT
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized AND net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    COALESCE(SUM(net_profit) FILTER (WHERE is_realized), 0)                        AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE is_realized)                                            AS roi_undefined_zero_acquisition_count
  FROM zero_assigned
),
unknown_row AS (
  SELECT
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count
  FROM unknown_acquisition
)
SELECT jsonb_build_object(
  'population_summary',         (SELECT COALESCE(jsonb_agg(to_jsonb(pop_row)), '[]'::jsonb) FROM pop_row),
  'purpose_population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(pop_purpose_rows)), '[]'::jsonb) FROM pop_purpose_rows),
  'band_performance',           (SELECT COALESCE(jsonb_agg(to_jsonb(band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM band_rows),
  'zero_assigned_summary',      (SELECT COALESCE(jsonb_agg(to_jsonb(zero_row)), '[]'::jsonb) FROM zero_row),
  'unknown_acquisition_summary',(SELECT COALESCE(jsonb_agg(to_jsonb(unknown_row)), '[]'::jsonb) FROM unknown_row)
);

-- ============================================================================
-- Query B -> target_user_acquisition_evidence.acquisition_value_band_performance
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
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
),
band_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_items,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi
  FROM eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
)
SELECT jsonb_build_object(
  'population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(pop_row)), '[]'::jsonb) FROM pop_row),
  'band_performance',   (SELECT COALESCE(jsonb_agg(to_jsonb(band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM band_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 01_acquisition_value_band_performance.sql: association, not
-- causation; small groups (sample_size < 5) are not yet reliable
-- conclusions; Historical Imports are fully included except for holding-
-- day duration metrics. Purpose breakdown rows are descriptive only — a
-- Hybrid or Personal row's realization_rate_percent is not an urgency
-- signal or a recommendation.
