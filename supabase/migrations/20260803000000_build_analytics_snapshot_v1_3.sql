-- build_analytics_snapshot_v1_3
--
-- Channel Analytics, module 2 of N: Deal Out Channel Performance. Adds a NEW
-- versioned snapshot builder alongside (never replacing) v1.0
-- (20260728000000_build_analytics_snapshot_v1.sql), v1.1
-- (20260730000000_build_analytics_snapshot_v1_1.sql), and v1.2
-- (20260801000000_build_analytics_snapshot_v1_2.sql). All prior functions
-- and every previously stored v1.0/v1.1/v1.2 analytics_runs.snapshot row
-- remain unchanged and fully readable — this migration only ADDS new
-- objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new lightweight top-level wrapper:
--   public._build_deal_out_channel_snapshot_v1()          -- NEW
--   public.build_analytics_snapshot_v1_3(int)             -- NEW, lightweight
-- v1.3's top-level wrapper calls public.build_analytics_snapshot_v1_2(int)
-- WHOLESALE (not its individual sub-helpers) and layers
-- evidence_aggregates.deal_out_channel on top — v1.2 already assembles
-- acquisition_value_band (with the v1.1 truncated-key fix),
-- acquisition_to_exit, brand, deal_in_channel, and recommendation_candidates,
-- so v1.3 duplicates none of that. This is a strictly narrower wrapper than
-- v1.2's own (which had to call four separate v1.1 helpers because no
-- single v1.1 entry point existed yet) — v1.2 IS that single entry point
-- now, and every future Channel Analytics module can wrap the previous
-- version the same way.
--
-- ── PART 1: _build_deal_out_channel_snapshot_v1() ────────────────────────
-- Reproduces analytics/sql/05_deal_out_channel_performance.sql. Included
-- sections mapped to stable JSON keys:
--   Query A -> population_summary
--   Query B -> overall_performance
--   Query C -> cash_sales_by_channel
--   Query D -> trade_exits_by_channel
--   Query E -> by_exit_value_band
--   Query F -> by_acquisition_value_band
-- No developer-only drilldown exists in 05 (unlike 01/02/03) — every
-- section here is shared aggregate evidence; nothing item-level, nothing
-- per-user.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_deal_out_channel_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH exit_value_band AS (
  SELECT
    *,
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
  FROM analytics_item_lifecycle
),
realized_business AS (
  SELECT * FROM exit_value_band WHERE purpose_name = 'Business' AND is_realized
),
cash_sales AS (
  SELECT * FROM realized_business WHERE exit_type = 'sale'
),
trade_exits AS (
  SELECT * FROM realized_business WHERE exit_type = 'trade'
),
eligible AS (
  SELECT * FROM realized_business WHERE acquisition_value_status = 'positive'
),

-- Query A -> population_summary
a_row AS (
  SELECT
    (SELECT COUNT(*) FROM realized_business)                                            AS realized_business_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NOT NULL)       AS deal_out_channel_known_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NULL)           AS deal_out_channel_missing_item_count,
    ROUND(
      (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NOT NULL)::numeric
        / NULLIF((SELECT COUNT(*) FROM realized_business), 0) * 100,
      2
    )                                                                                   AS deal_out_channel_coverage_percent,
    (SELECT COUNT(DISTINCT deal_out_channel_id) FROM realized_business WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    (SELECT COUNT(*) FROM realized_business WHERE exit_type = 'sale')                    AS sale_exit_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE exit_type = 'trade')                   AS trade_exit_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE is_historical_import)                  AS historical_realized_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE NOT is_historical_import)              AS app_tracked_realized_item_count
),

-- Query B -> overall_performance
b_rows AS (
  SELECT
    deal_out_channel_id,
    deal_out_channel_name,
    deal_out_channel_requires_listing,
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
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM realized_business
  GROUP BY deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),

-- Query C -> cash_sales_by_channel
c_rows AS (
  SELECT
    deal_out_channel_id,
    deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM cash_sales
  GROUP BY deal_out_channel_id, deal_out_channel_name
),

-- Query D -> trade_exits_by_channel
d_rows AS (
  SELECT
    deal_out_channel_id,
    deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM trade_exits
  GROUP BY deal_out_channel_id, deal_out_channel_name
),

-- Query E -> by_exit_value_band
e_rows AS (
  SELECT
    deal_out_channel_id,
    deal_out_channel_name,
    exit_value_band_order,
    exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM realized_business
  GROUP BY deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),

-- Query F -> by_acquisition_value_band
f_rows AS (
  SELECT
    deal_out_channel_id,
    deal_out_channel_name,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM eligible
  GROUP BY deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
)

SELECT jsonb_build_object(
  'population_summary',       (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'overall_performance',      (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM b_rows),
  'cash_sales_by_channel',    (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM c_rows),
  'trade_exits_by_channel',   (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM d_rows),
  'by_exit_value_band',       (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM e_rows),
  'by_acquisition_value_band',(SELECT COALESCE(jsonb_agg(to_jsonb(f_rows) ORDER BY deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM f_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_deal_out_channel_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_deal_out_channel_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_deal_out_channel_snapshot_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_deal_out_channel_snapshot_v1() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_3(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — calls public.build_analytics_snapshot_v1_2
-- WHOLESALE (v1.2 already validates p_recommendation_target_user_id and
-- assembles acquisition_value_band/acquisition_to_exit/brand/
-- deal_in_channel/recommendation_candidates; none of that is duplicated
-- here) and layers evidence_aggregates.deal_out_channel on top by merging
-- one extra key into the already-assembled evidence_aggregates object.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_3(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v12          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  -- v1.2 already validates p_recommendation_target_user_id (NULL check and
  -- app_users existence check) and RAISEs on failure — no need to repeat
  -- that validation here.
  v_v12 := public.build_analytics_snapshot_v1_2(p_recommendation_target_user_id);

  RETURN v_v12
    || jsonb_build_object(
         'snapshot_schema_version', '1.3',
         'analytics_definition_version', '1.3',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'evidence_aggregates',
         (v_v12 -> 'evidence_aggregates')
           || jsonb_build_object('deal_out_channel', public._build_deal_out_channel_snapshot_v1())
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_3(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_3(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_3(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_3(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_3(int) IS
  'Channel Analytics module 2 (Deal Out Channel Performance). SECURITY '
  'INVOKER, service_role execution only. Lightweight wrapper: calls '
  'build_analytics_snapshot_v1_2(int) wholesale and merges in '
  'evidence_aggregates.deal_out_channel — acquisition_value_band, '
  'acquisition_to_exit, brand, deal_in_channel, and '
  'recommendation_candidates are v1.2''s own assembled output, not copied '
  'or reimplemented. Persists nothing — see analytics_runs '
  '(20260727000000) for the persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v1.3 contract.';
