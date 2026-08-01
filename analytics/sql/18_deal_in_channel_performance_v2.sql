-- ============================================================================
-- 18_deal_in_channel_performance_v2.sql
--
-- Purpose-aware v2 port of 04_deal_in_channel_performance.sql. See
-- public._build_deal_channel_snapshot_v2(int)
-- (supabase/migrations/20260816000000_build_analytics_snapshot_v2_5.sql)
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
-- Deal In Channel is where contact with the seller/trade partner
-- ORIGINATED for the operation an item ENTERED inventory through — never a
-- payment method or shipping method. Population is EVERY item (open +
-- realized) — acquisition always happens, unlike Deal Out Channel which
-- only exists for realized items. Missing Deal In Channel
-- (deal_in_channel_id IS NULL) is a real, visible state — GROUP BY keeps
-- the NULL group visible, never silently dropped. acquisition_method
-- distinguishes purchase/trade/unknown. Acquisition value bands (Query D)
-- restrict to acquisition_value_status = 'positive', matching every other
-- module's band convention — zero-assigned/unknown coverage stays visible
-- in population_summary, never mixed into a positive band. Historical
-- Imports participate fully wherever a Deal In Channel is known; excluded
-- ONLY from holding_days-based duration metrics. Confidence is tiered from
-- the row's own item count (1-2 insufficient, 3-5 low, 6-9 moderate, 10+
-- stronger), unchanged from 04's own convention.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- ALL FIVE of 04's queries are self-classified shared aggregate evidence
-- (see its own "QUERY CLASSIFICATION INDEX") — none are developer-only,
-- so all five are ported in full:
--   Query A -> population_summary
--   Query B -> performance_by_deal_in_channel
--   Query C -> performance_by_deal_in_channel_and_method
--   Query D -> performance_by_deal_in_channel_and_acquisition_band
--   Query E -> open_inventory_by_deal_in_channel
-- Listing-Channel data is explicitly NOT read anywhere in this file —
-- Deal In Channel is distinct from Listing Channel Exposure (a separate
-- v1.5 module, not touched here).
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_deal_channel_evidence.deal_in_channel_performance
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
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS exit_value_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 'Zero / unknown'
      WHEN exit_value < 1000 THEN '$1-999'
      WHEN exit_value < 2000 THEN '$1,000-1,999'
      WHEN exit_value < 3000 THEN '$2,000-2,999'
      WHEN exit_value < 4000 THEN '$3,000-3,999'
      WHEN exit_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS exit_value_band_label,
    CASE WHEN exit_type IN ('sale', 'trade') THEN exit_type ELSE 'unknown' END AS exit_method,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
-- MODULE 1: Deal In Channel Performance — SHARED (pooled, all users)
-- ============================================================================

-- population_summary / purpose_population_summary (Query A)
dis_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM all_items
),
dis_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_in_channel / ..._by_purpose (Query B)
dis_perf_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),
dis_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),

-- performance_by_deal_in_channel_and_method / ..._by_purpose (Query C)
dis_method_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_method
),
dis_method_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_method
),

-- performance_by_deal_in_channel_and_acquisition_band / ..._by_purpose (Query D)
dis_band_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
dis_band_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dis_band_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dis_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dis_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_deal_in_channel / ..._by_purpose (Query E)
dis_open_base AS (
  SELECT * FROM all_items WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),
dis_open_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dis_open_base
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
dis_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dis_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
)
SELECT jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dis_pop_row)), '[]'::jsonb) FROM dis_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dis_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dis_pop_purpose_rows),
      'performance_by_deal_in_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dis_perf_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_perf_rows),
      'performance_by_deal_in_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dis_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_perf_purpose_rows),
      'performance_by_deal_in_channel_and_method',       (SELECT COALESCE(jsonb_agg(to_jsonb(dis_method_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dis_method_rows),
      'performance_by_deal_in_channel_and_method_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dis_method_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dis_method_purpose_rows),
      'performance_by_deal_in_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dis_band_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dis_band_rows),
      'performance_by_deal_in_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dis_band_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dis_band_purpose_rows),
      'open_inventory_by_deal_in_channel',                (SELECT COALESCE(jsonb_agg(to_jsonb(dis_open_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_open_rows),
      'open_inventory_by_deal_in_channel_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(dis_open_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_open_purpose_rows)
);

-- ============================================================================
-- Query B -> target_user_deal_channel_evidence.deal_in_channel_performance
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
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS exit_value_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 'Zero / unknown'
      WHEN exit_value < 1000 THEN '$1-999'
      WHEN exit_value < 2000 THEN '$1,000-1,999'
      WHEN exit_value < 3000 THEN '$2,000-2,999'
      WHEN exit_value < 4000 THEN '$3,000-3,999'
      WHEN exit_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS exit_value_band_label,
    CASE WHEN exit_type IN ('sale', 'trade') THEN exit_type ELSE 'unknown' END AS exit_method,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
-- MODULE 1: Deal In Channel Performance — TARGET USER ONLY
-- ============================================================================

-- population_summary / purpose_population_summary (Query A)
dit_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM all_items
),
dit_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_in_channel / ..._by_purpose (Query B)
dit_perf_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),
dit_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),

-- performance_by_deal_in_channel_and_method / ..._by_purpose (Query C)
dit_method_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_method
),
dit_method_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_method
),

-- performance_by_deal_in_channel_and_acquisition_band / ..._by_purpose (Query D)
dit_band_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
dit_band_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dit_band_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dit_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dit_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_deal_in_channel / ..._by_purpose (Query E)
dit_open_base AS (
  SELECT * FROM all_items WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),
dit_open_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dit_open_base
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
dit_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dit_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
)
SELECT jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dit_pop_row)), '[]'::jsonb) FROM dit_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dit_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dit_pop_purpose_rows),
      'performance_by_deal_in_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dit_perf_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_perf_rows),
      'performance_by_deal_in_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dit_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_perf_purpose_rows),
      'performance_by_deal_in_channel_and_method',       (SELECT COALESCE(jsonb_agg(to_jsonb(dit_method_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dit_method_rows),
      'performance_by_deal_in_channel_and_method_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dit_method_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dit_method_purpose_rows),
      'performance_by_deal_in_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dit_band_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dit_band_rows),
      'performance_by_deal_in_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dit_band_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dit_band_purpose_rows),
      'open_inventory_by_deal_in_channel',                (SELECT COALESCE(jsonb_agg(to_jsonb(dit_open_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_open_rows),
      'open_inventory_by_deal_in_channel_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(dit_open_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_open_purpose_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 04_deal_in_channel_performance.sql: channel results are
-- descriptive associations, not proof that a channel caused an outcome.
-- Always read `confidence` alongside any figure. Purpose breakdown rows
-- are descriptive only — a Hybrid or Personal row's realization_rate is
-- not an urgency signal or a recommendation. Current Purpose is never
-- presented as Purpose at acquisition.
