-- ============================================================================
-- 17_category_type_performance_v2.sql
--
-- Purpose-aware v2 port of 08_category_type_performance.sql. See
-- public._build_inventory_segmentation_snapshot_v2(int)
-- (supabase/migrations/20260815000000_build_analytics_snapshot_v2_4.sql)
-- for the actual transformation; nothing in this file creates a database
-- object and nothing here writes to production data.
--
-- ── WHAT CHANGED FROM v1 ──────────────────────────────────────────────────
-- Population is analytics_item_lifecycle_v2's FULL population — Business,
-- Hybrid, Personal, missing_purpose, missing_policy — instead of
-- `purpose_name = 'Business'`. Every section below is produced twice: once
-- pooled across ALL purposes, once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status), using the SAME missing-
-- purpose/missing-policy collapsing rule as every other v2 module.
--
-- ── WHAT DID NOT CHANGE ───────────────────────────────────────────────────
-- Missing category (`category_id IS NULL`) and missing type (`type_id IS
-- NULL`) are never dropped — GROUP BY naturally keeps a NULL group
-- visible. Two Types sharing a name under different Categories are NEVER
-- merged — every Type-level section groups by (category_id, type_id)
-- together, never type_id/type_name alone. Acquisition value bands
-- (Query D/E) are restricted to acquisition_value_status = 'positive',
-- matching 08's own convention (zero-assigned/unknown coverage lives in
-- population_summary, never silently placed into a band). Historical
-- Import inclusion/exclusion rules and the single realized-item-count
-- confidence tiering (1-2 insufficient, 3-5 low, 6-9 moderate, 10+
-- stronger — NOT the dual sample/realized tiering Brand Performance uses)
-- are all copied verbatim from 08_category_type_performance.sql.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- ALL SIX of 08's queries are self-classified shared aggregate evidence
-- (see its own "QUERY CLASSIFICATION INDEX") — none are developer-only,
-- so all six are ported in full:
--   Query A -> population_summary
--   Query B -> performance_by_category
--   Query C -> performance_by_category_type
--   Query D -> performance_by_category_and_acquisition_band
--   Query E -> performance_by_category_type_and_acquisition_band
--   Query F -> open_inventory_by_category_type
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_inventory_segmentation_evidence.category_type_performance
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
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM public.analytics_item_lifecycle_v2
),
cs_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
),
cs_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_category / ..._by_purpose (Query B)
cs_cat_rows AS (
  SELECT
    category_id, category_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY category_id, category_name
),
cs_cat_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name
),

-- performance_by_category_type / ..._by_purpose (Query C) — grouped by
-- (category_id, type_id) together, never type_id/type_name alone
cs_cattype_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY category_id, category_name, type_id, type_name
),
cs_cattype_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
),

-- performance_by_category_and_acquisition_band / ..._by_purpose (Query D) —
-- restricted to acquisition_value_status = 'positive', matching 08's own
-- convention (zero-assigned/unknown coverage lives in population_summary)
cs_band_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
cs_catband_rows AS (
  SELECT
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cs_band_eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),
cs_catband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cs_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- performance_by_category_type_and_acquisition_band / ..._by_purpose (Query E)
cs_cattypeband_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cs_band_eligible
  GROUP BY category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),
cs_cattypeband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cs_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_category_type / ..._by_purpose (Query F)
cs_open_base AS (
  SELECT * FROM all_items WHERE NOT is_realized
),
cs_open_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM cs_open_base
  GROUP BY category_id, category_name, type_id, type_name
),
cs_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM cs_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
)
SELECT jsonb_build_object(
      'population_summary',                           (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_row)), '[]'::jsonb) FROM cs_pop_row),
      'purpose_population_summary',                    (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST), '[]'::jsonb) FROM cs_pop_purpose_rows),
      'performance_by_category',                       (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cat_rows) ORDER BY category_name NULLS LAST), '[]'::jsonb) FROM cs_cat_rows),
      'performance_by_category_by_purpose',             (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cat_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST), '[]'::jsonb) FROM cs_cat_purpose_rows),
      'performance_by_category_type',                  (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattype_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_cattype_rows),
      'performance_by_category_type_by_purpose',        (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattype_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_cattype_purpose_rows),
      'performance_by_category_and_acquisition_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(cs_catband_rows) ORDER BY category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_catband_rows),
      'performance_by_category_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_catband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_catband_purpose_rows),
      'performance_by_category_type_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattypeband_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_cattypeband_rows),
      'performance_by_category_type_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattypeband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_cattypeband_purpose_rows),
      'open_inventory_by_category_type',               (SELECT COALESCE(jsonb_agg(to_jsonb(cs_open_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_open_rows),
      'open_inventory_by_category_type_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(cs_open_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_open_purpose_rows)
);

-- ============================================================================
-- Query B -> target_user_inventory_segmentation_evidence.category_type_performance
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
    END AS acquisition_value_band_label,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
cx_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
),
cx_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_category / ..._by_purpose (Query B)
cx_cat_rows AS (
  SELECT
    category_id, category_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY category_id, category_name
),
cx_cat_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name
),

-- performance_by_category_type / ..._by_purpose (Query C) — grouped by
-- (category_id, type_id) together, never type_id/type_name alone
cx_cattype_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY category_id, category_name, type_id, type_name
),
cx_cattype_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
),

-- performance_by_category_and_acquisition_band / ..._by_purpose (Query D) —
-- restricted to acquisition_value_status = 'positive', matching 08's own
-- convention (zero-assigned/unknown coverage lives in population_summary)
cx_band_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
cx_catband_rows AS (
  SELECT
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cx_band_eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),
cx_catband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cx_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- performance_by_category_type_and_acquisition_band / ..._by_purpose (Query E)
cx_cattypeband_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cx_band_eligible
  GROUP BY category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),
cx_cattypeband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cx_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_category_type / ..._by_purpose (Query F)
cx_open_base AS (
  SELECT * FROM all_items WHERE NOT is_realized
),
cx_open_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM cx_open_base
  GROUP BY category_id, category_name, type_id, type_name
),
cx_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM cx_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
)
SELECT jsonb_build_object(
      'population_summary',                           (SELECT COALESCE(jsonb_agg(to_jsonb(cx_pop_row)), '[]'::jsonb) FROM cx_pop_row),
      'purpose_population_summary',                    (SELECT COALESCE(jsonb_agg(to_jsonb(cx_pop_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST), '[]'::jsonb) FROM cx_pop_purpose_rows),
      'performance_by_category',                       (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cat_rows) ORDER BY category_name NULLS LAST), '[]'::jsonb) FROM cx_cat_rows),
      'performance_by_category_by_purpose',             (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cat_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST), '[]'::jsonb) FROM cx_cat_purpose_rows),
      'performance_by_category_type',                  (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattype_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_cattype_rows),
      'performance_by_category_type_by_purpose',        (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattype_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_cattype_purpose_rows),
      'performance_by_category_and_acquisition_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(cx_catband_rows) ORDER BY category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_catband_rows),
      'performance_by_category_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cx_catband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_catband_purpose_rows),
      'performance_by_category_type_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattypeband_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_cattypeband_rows),
      'performance_by_category_type_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattypeband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_cattypeband_purpose_rows),
      'open_inventory_by_category_type',               (SELECT COALESCE(jsonb_agg(to_jsonb(cx_open_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_open_rows),
      'open_inventory_by_category_type_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(cx_open_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_open_purpose_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 08_category_type_performance.sql: Category/Type results are
-- descriptive, not causal (acquisition method, brand mix, and market
-- timing are confounded with Category/Type membership and are not
-- isolated here); a thin Type-level sample must never outweigh a
-- stronger Category-level sample when both are shown together — always
-- read `confidence` alongside any number drawn from these sections; a
-- missing Type (`type_id IS NULL`) is a data-quality group, never a real
-- Type. Purpose breakdown rows are descriptive only — a Hybrid or
-- Personal row's realization_rate_percent is not an urgency signal or a
-- recommendation.
