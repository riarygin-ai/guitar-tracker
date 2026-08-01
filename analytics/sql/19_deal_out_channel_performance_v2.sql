-- ============================================================================
-- 19_deal_out_channel_performance_v2.sql
--
-- Purpose-aware v2 port of 05_deal_out_channel_performance.sql. See
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
-- Deal Out Channel is where contact ORIGINATED for the operation an item
-- LEFT inventory through — never a payment method or shipping method (a
-- Reverb contact followed by an off-platform payment remains Reverb).
-- Population is REALIZED items only — an open item has no exit deal yet
-- to read a channel from. Missing Deal Out Channel (deal_out_channel_id
-- IS NULL) is a real, visible state — a realized trade MAY have no
-- recorded channel (a realized cash sale always has one). Cash sale
-- (Query C) and trade exit (Query D) paths are NEVER conflated: exit_value
-- is a "sale price" ONLY in Query C and an "assigned trade exit value"
-- ONLY in Query D; Query B and every banded query (E, F) use the neutral
-- term "exit value." Acquisition value bands (Query F) restrict to
-- acquisition_value_status = 'positive'; exit value bands (Query E) use a
-- single "Zero / unknown" catch-all, unchanged from
-- 02_acquisition_to_exit_analysis.sql's own exit-band convention.
-- Historical Imports participate fully wherever a Deal Out Channel is
-- known; excluded ONLY from holding_days-based duration metrics.
-- Confidence is tiered from the row's own item count, unchanged from 05's
-- own convention.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- ALL SIX of 05's queries are self-classified shared aggregate evidence
-- (see its own "QUERY CLASSIFICATION INDEX") — none are developer-only,
-- so all six are ported in full:
--   Query A -> population_summary
--   Query B -> performance_by_deal_out_channel
--   Query C -> cash_sales_by_deal_out_channel
--   Query D -> trade_exits_by_deal_out_channel
--   Query E -> performance_by_deal_out_channel_and_exit_band
--   Query F -> performance_by_deal_out_channel_and_acquisition_band
-- Listing-Channel data is explicitly NOT read anywhere in this file.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_deal_channel_evidence.deal_out_channel_performance
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
-- MODULE 2: Deal Out Channel Performance — SHARED (pooled, all users)
-- Population is REALIZED items only (Query A onward) — an open item has
-- no exit deal yet to read a channel from.
-- ============================================================================

dos_realized AS (
  SELECT * FROM all_items WHERE is_realized
),

-- population_summary / purpose_population_summary (Query A)
dos_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dos_realized
),
dos_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dos_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_out_channel / ..._by_purpose (Query B)
dos_perf_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),
dos_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),

-- cash_sales_by_deal_out_channel / ..._by_purpose (Query C) — the ONLY
-- sections where exit_value may be called "sale price"
dos_cash_sales AS (
  SELECT * FROM dos_realized WHERE exit_type = 'sale'
),
dos_cash_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_cash_sales
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dos_cash_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_cash_sales
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- trade_exits_by_deal_out_channel / ..._by_purpose (Query D) — exit_value
-- here is an ASSIGNED OUTGOING TRADE VALUE, never a "sale price"
dos_trade_exits AS (
  SELECT * FROM dos_realized WHERE exit_type = 'trade'
),
dos_trade_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_trade_exits
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dos_trade_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_trade_exits
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- performance_by_deal_out_channel_and_exit_band / ..._by_purpose (Query E)
dos_exitband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),
dos_exitband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),

-- performance_by_deal_out_channel_and_acquisition_band / ..._by_purpose (Query F)
dos_acqband_eligible AS (
  SELECT * FROM dos_realized WHERE acquisition_value_status = 'positive'
),
dos_acqband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_acqband_eligible
  GROUP BY deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dos_acqband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_acqband_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
)
SELECT jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dos_pop_row)), '[]'::jsonb) FROM dos_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dos_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dos_pop_purpose_rows),
      'performance_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dos_perf_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_perf_rows),
      'performance_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dos_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_perf_purpose_rows),
      'cash_sales_by_deal_out_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dos_cash_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_cash_rows),
      'cash_sales_by_deal_out_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dos_cash_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_cash_purpose_rows),
      'trade_exits_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dos_trade_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_trade_rows),
      'trade_exits_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dos_trade_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_trade_purpose_rows),
      'performance_by_deal_out_channel_and_exit_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(dos_exitband_rows) ORDER BY deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dos_exitband_rows),
      'performance_by_deal_out_channel_and_exit_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dos_exitband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dos_exitband_purpose_rows),
      'performance_by_deal_out_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dos_acqband_rows) ORDER BY deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dos_acqband_rows),
      'performance_by_deal_out_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dos_acqband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dos_acqband_purpose_rows)
);

-- ============================================================================
-- Query B -> target_user_deal_channel_evidence.deal_out_channel_performance
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
-- MODULE 2: Deal Out Channel Performance — TARGET USER ONLY
-- Population is REALIZED items only (Query A onward) — an open item has
-- no exit deal yet to read a channel from.
-- ============================================================================

dot_realized AS (
  SELECT * FROM all_items WHERE is_realized
),

-- population_summary / purpose_population_summary (Query A)
dot_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dot_realized
),
dot_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dot_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_out_channel / ..._by_purpose (Query B)
dot_perf_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),
dot_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),

-- cash_sales_by_deal_out_channel / ..._by_purpose (Query C) — the ONLY
-- sections where exit_value may be called "sale price"
dot_cash_sales AS (
  SELECT * FROM dot_realized WHERE exit_type = 'sale'
),
dot_cash_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_cash_sales
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dot_cash_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_cash_sales
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- trade_exits_by_deal_out_channel / ..._by_purpose (Query D) — exit_value
-- here is an ASSIGNED OUTGOING TRADE VALUE, never a "sale price"
dot_trade_exits AS (
  SELECT * FROM dot_realized WHERE exit_type = 'trade'
),
dot_trade_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_trade_exits
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dot_trade_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_trade_exits
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- performance_by_deal_out_channel_and_exit_band / ..._by_purpose (Query E)
dot_exitband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),
dot_exitband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),

-- performance_by_deal_out_channel_and_acquisition_band / ..._by_purpose (Query F)
dot_acqband_eligible AS (
  SELECT * FROM dot_realized WHERE acquisition_value_status = 'positive'
),
dot_acqband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_acqband_eligible
  GROUP BY deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dot_acqband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_acqband_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
)
SELECT jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dot_pop_row)), '[]'::jsonb) FROM dot_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dot_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dot_pop_purpose_rows),
      'performance_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dot_perf_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_perf_rows),
      'performance_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dot_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_perf_purpose_rows),
      'cash_sales_by_deal_out_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dot_cash_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_cash_rows),
      'cash_sales_by_deal_out_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dot_cash_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_cash_purpose_rows),
      'trade_exits_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dot_trade_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_trade_rows),
      'trade_exits_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dot_trade_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_trade_purpose_rows),
      'performance_by_deal_out_channel_and_exit_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(dot_exitband_rows) ORDER BY deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dot_exitband_rows),
      'performance_by_deal_out_channel_and_exit_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dot_exitband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dot_exitband_purpose_rows),
      'performance_by_deal_out_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dot_acqband_rows) ORDER BY deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dot_acqband_rows),
      'performance_by_deal_out_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dot_acqband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dot_acqband_purpose_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 05_deal_out_channel_performance.sql: channel results are
-- descriptive associations, not proof that a channel caused an outcome.
-- Always read `confidence` alongside any figure. Purpose breakdown rows
-- are descriptive only. Current Purpose is never presented as Purpose at
-- exit.
