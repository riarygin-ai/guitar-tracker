-- ============================================================================
-- 20_channel_journey_v2.sql
--
-- Purpose-aware v2 port of 06_channel_journey.sql. See
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
-- Population is REALIZED items only (a journey needs both an entry and an
-- exit event). journey_eligible additionally requires BOTH deal_in_
-- channel_id AND deal_out_channel_id to be known — a missing-channel
-- realized item is excluded from the journey matrix but counted in
-- population_summary's coverage fields, never silently dropped. "Same
-- channel" (deal_in_channel_id = deal_out_channel_id) is DESCRIPTIVE PATH
-- EVIDENCE ONLY — same_channel_exit_percent is never a conversion rate
-- and never implies the channel caused the exit; it must always be read
-- alongside its own sample size and `confidence`, and must never be
-- compared against Deal In Channel's (file 18) or Deal Out Channel's
-- (file 19) own item counts as though they shared a denominator — this
-- file's population is the narrower realized-AND-both-channels-known
-- intersection. Historical items MAY contribute to the journey matrix (a
-- historical acquisition with a KNOWN Deal In Channel is still a real,
-- known path) but are still excluded from holding_days-based metrics.
-- Confidence is tiered from the row's own item count, unchanged from 06's
-- own convention.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- ALL FIVE of 06's queries are self-classified shared aggregate evidence
-- (see its own "QUERY CLASSIFICATION INDEX") — none are developer-only,
-- so all five are ported in full:
--   Query A -> population_summary
--   Query B -> deal_in_to_deal_out_matrix
--   Query C -> same_channel_summary
--   Query D -> same_channel_summary_by_deal_in_channel
--   Query E -> paths_by_acquisition_and_exit_method
-- Listing-Channel data is explicitly NOT read anywhere in this file.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_deal_channel_evidence.channel_journey
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
-- MODULE 3: Channel Journey — SHARED (pooled, all users)
-- journey_eligible requires BOTH deal_in_channel_id AND deal_out_channel_id
-- known — a missing-channel realized item is excluded from the journey
-- matrix but counted in population_summary's coverage fields.
-- ============================================================================

cjs_realized AS (
  SELECT * FROM all_items WHERE is_realized
),
cjs_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM cjs_realized
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
),

-- population_summary / purpose_population_summary (Query A)
cjs_pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM cjs_realized)                                            AS realized_item_count,
    (SELECT COUNT(*) FROM cjs_eligible)                                             AS journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjs_realized WHERE deal_in_channel_id IS NULL)            AS missing_deal_in_channel_item_count,
    (SELECT COUNT(*) FROM cjs_realized WHERE deal_out_channel_id IS NULL)           AS missing_deal_out_channel_item_count,
    (SELECT COUNT(*) FROM cjs_realized WHERE deal_in_channel_id IS NULL AND deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND((SELECT COUNT(*) FROM cjs_eligible)::numeric / NULLIF((SELECT COUNT(*) FROM cjs_realized), 0) * 100, 2) AS journey_coverage_percent,
    (SELECT COUNT(*) FROM cjs_eligible WHERE exit_type = 'sale')                    AS journey_sale_exit_item_count,
    (SELECT COUNT(*) FROM cjs_eligible WHERE exit_type = 'trade')                   AS journey_trade_exit_item_count,
    (SELECT COUNT(*) FROM cjs_eligible WHERE is_historical_import)                  AS historical_journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjs_eligible WHERE NOT is_historical_import)              AS app_tracked_journey_eligible_item_count,
    (SELECT COUNT(DISTINCT deal_in_channel_id) FROM cjs_eligible)                   AS distinct_deal_in_channel_count,
    (SELECT COUNT(DISTINCT deal_out_channel_id) FROM cjs_eligible)                  AS distinct_deal_out_channel_count
),
cjs_pop_purpose_rows AS (
  SELECT
    r.group_purpose_id AS current_purpose_id, r.group_purpose_name AS current_purpose_name, r.purpose_policy_status,
    COUNT(*) FILTER (WHERE true)                                                   AS realized_item_count,
    COUNT(e.item_id)                                                               AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL)                           AS missing_deal_in_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_out_channel_id IS NULL)                          AS missing_deal_out_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL AND r.deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND(COUNT(e.item_id)::numeric / NULLIF(COUNT(*), 0) * 100, 2)                AS journey_coverage_percent,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'sale')                           AS journey_sale_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'trade')                          AS journey_trade_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.is_historical_import)                         AS historical_journey_eligible_item_count,
    COUNT(e.item_id) FILTER (WHERE NOT e.is_historical_import)                     AS app_tracked_journey_eligible_item_count,
    COUNT(DISTINCT e.deal_in_channel_id)                                           AS distinct_deal_in_channel_count,
    COUNT(DISTINCT e.deal_out_channel_id)                                          AS distinct_deal_out_channel_count
  FROM cjs_realized r
  LEFT JOIN cjs_eligible e ON e.item_id = r.item_id
  GROUP BY r.group_purpose_id, r.group_purpose_name, r.purpose_policy_status
),

-- deal_in_to_deal_out_matrix / ..._by_purpose (Query B)
cjs_matrix_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),
cjs_matrix_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- same_channel_summary / ..._by_purpose (Query C) — single-row summary
cjs_samechan_row AS (
  SELECT
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjs_eligible
),
cjs_samechan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- same_channel_summary_by_deal_in_channel / ..._by_purpose (Query D)
cjs_samechan_bychan_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
cjs_samechan_bychan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
),

-- paths_by_acquisition_and_exit_method / ..._by_purpose (Query E)
cjs_paths_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
),
cjs_paths_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
)
SELECT jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_pop_row)), '[]'::jsonb) FROM cjs_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjs_pop_purpose_rows),
      'deal_in_to_deal_out_matrix',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_matrix_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_matrix_rows),
      'deal_in_to_deal_out_matrix_by_purpose',           (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_matrix_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_matrix_purpose_rows),
      'same_channel_summary',                            (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_row)), '[]'::jsonb) FROM cjs_samechan_row),
      'same_channel_summary_by_purpose',                 (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjs_samechan_purpose_rows),
      'same_channel_summary_by_deal_in_channel',          (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_bychan_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_samechan_bychan_rows),
      'same_channel_summary_by_deal_in_channel_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_bychan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_samechan_bychan_purpose_rows),
      'paths_by_acquisition_and_exit_method',             (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_paths_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjs_paths_rows),
      'paths_by_acquisition_and_exit_method_by_purpose',  (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_paths_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjs_paths_purpose_rows)
);

-- ============================================================================
-- Query B -> target_user_deal_channel_evidence.channel_journey
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
-- MODULE 3: Channel Journey — TARGET USER ONLY
-- journey_eligible requires BOTH deal_in_channel_id AND deal_out_channel_id
-- known — a missing-channel realized item is excluded from the journey
-- matrix but counted in population_summary's coverage fields.
-- ============================================================================

cjt_realized AS (
  SELECT * FROM all_items WHERE is_realized
),
cjt_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM cjt_realized
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
),

-- population_summary / purpose_population_summary (Query A)
cjt_pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM cjt_realized)                                            AS realized_item_count,
    (SELECT COUNT(*) FROM cjt_eligible)                                             AS journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjt_realized WHERE deal_in_channel_id IS NULL)            AS missing_deal_in_channel_item_count,
    (SELECT COUNT(*) FROM cjt_realized WHERE deal_out_channel_id IS NULL)           AS missing_deal_out_channel_item_count,
    (SELECT COUNT(*) FROM cjt_realized WHERE deal_in_channel_id IS NULL AND deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND((SELECT COUNT(*) FROM cjt_eligible)::numeric / NULLIF((SELECT COUNT(*) FROM cjt_realized), 0) * 100, 2) AS journey_coverage_percent,
    (SELECT COUNT(*) FROM cjt_eligible WHERE exit_type = 'sale')                    AS journey_sale_exit_item_count,
    (SELECT COUNT(*) FROM cjt_eligible WHERE exit_type = 'trade')                   AS journey_trade_exit_item_count,
    (SELECT COUNT(*) FROM cjt_eligible WHERE is_historical_import)                  AS historical_journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjt_eligible WHERE NOT is_historical_import)              AS app_tracked_journey_eligible_item_count,
    (SELECT COUNT(DISTINCT deal_in_channel_id) FROM cjt_eligible)                   AS distinct_deal_in_channel_count,
    (SELECT COUNT(DISTINCT deal_out_channel_id) FROM cjt_eligible)                  AS distinct_deal_out_channel_count
),
cjt_pop_purpose_rows AS (
  SELECT
    r.group_purpose_id AS current_purpose_id, r.group_purpose_name AS current_purpose_name, r.purpose_policy_status,
    COUNT(*) FILTER (WHERE true)                                                   AS realized_item_count,
    COUNT(e.item_id)                                                               AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL)                           AS missing_deal_in_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_out_channel_id IS NULL)                          AS missing_deal_out_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL AND r.deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND(COUNT(e.item_id)::numeric / NULLIF(COUNT(*), 0) * 100, 2)                AS journey_coverage_percent,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'sale')                           AS journey_sale_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'trade')                          AS journey_trade_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.is_historical_import)                         AS historical_journey_eligible_item_count,
    COUNT(e.item_id) FILTER (WHERE NOT e.is_historical_import)                     AS app_tracked_journey_eligible_item_count,
    COUNT(DISTINCT e.deal_in_channel_id)                                           AS distinct_deal_in_channel_count,
    COUNT(DISTINCT e.deal_out_channel_id)                                          AS distinct_deal_out_channel_count
  FROM cjt_realized r
  LEFT JOIN cjt_eligible e ON e.item_id = r.item_id
  GROUP BY r.group_purpose_id, r.group_purpose_name, r.purpose_policy_status
),

-- deal_in_to_deal_out_matrix / ..._by_purpose (Query B)
cjt_matrix_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),
cjt_matrix_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- same_channel_summary / ..._by_purpose (Query C) — single-row summary
cjt_samechan_row AS (
  SELECT
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjt_eligible
),
cjt_samechan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- same_channel_summary_by_deal_in_channel / ..._by_purpose (Query D)
cjt_samechan_bychan_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
cjt_samechan_bychan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
),

-- paths_by_acquisition_and_exit_method / ..._by_purpose (Query E)
cjt_paths_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
),
cjt_paths_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
)

SELECT jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_pop_row)), '[]'::jsonb) FROM cjt_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjt_pop_purpose_rows),
      'deal_in_to_deal_out_matrix',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_matrix_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_matrix_rows),
      'deal_in_to_deal_out_matrix_by_purpose',           (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_matrix_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_matrix_purpose_rows),
      'same_channel_summary',                            (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_row)), '[]'::jsonb) FROM cjt_samechan_row),
      'same_channel_summary_by_purpose',                 (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjt_samechan_purpose_rows),
      'same_channel_summary_by_deal_in_channel',          (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_bychan_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_samechan_bychan_rows),
      'same_channel_summary_by_deal_in_channel_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_bychan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_samechan_bychan_purpose_rows),
      'paths_by_acquisition_and_exit_method',             (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_paths_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjt_paths_rows),
      'paths_by_acquisition_and_exit_method_by_purpose',  (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_paths_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjt_paths_purpose_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 06_channel_journey.sql: journey paths are descriptive, not
-- causal. same_channel_exit_percent is never a conversion rate. Always
-- read journey_eligible_item_count / eligible_realized_item_count (the
-- sample size) and `confidence` alongside any path percentage. Purpose
-- breakdown rows are descriptive only.
