-- build_analytics_snapshot_v1_4
--
-- Channel Analytics, module 3A of N: Channel Journey. Adds a NEW versioned
-- snapshot builder alongside (never replacing) v1.0
-- (20260728000000_build_analytics_snapshot_v1.sql), v1.1
-- (20260730000000_build_analytics_snapshot_v1_1.sql), v1.2
-- (20260801000000_build_analytics_snapshot_v1_2.sql), and v1.3
-- (20260803000000_build_analytics_snapshot_v1_3.sql). All prior functions
-- and every previously stored v1.0/v1.1/v1.2/v1.3 analytics_runs.snapshot
-- row remain unchanged and fully readable — this migration only ADDS new
-- objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new lightweight top-level wrapper:
--   public._build_channel_journey_snapshot_v1()           -- NEW
--   public.build_analytics_snapshot_v1_4(int)              -- NEW, lightweight
-- v1.4's top-level wrapper calls public.build_analytics_snapshot_v1_3(int)
-- WHOLESALE (not its individual sub-helpers) and layers
-- evidence_aggregates.channel_journey on top — v1.3 already assembles
-- acquisition_value_band, acquisition_to_exit, brand, deal_in_channel,
-- deal_out_channel, and recommendation_candidates, so v1.4 duplicates none
-- of that. Same lightweight-wrapper pattern as v1.3's own wrapper around
-- v1.2 — every future Channel Analytics module wraps the immediately
-- preceding version the same way.
--
-- ── PART 1: _build_channel_journey_snapshot_v1() ─────────────────────────
-- Reproduces analytics/sql/06_channel_journey.sql. Included sections
-- mapped to stable JSON keys:
--   Query A -> population_summary
--   Query B -> deal_in_to_deal_out_matrix
--   Query C -> same_channel_summary
--   Query D -> same_channel_by_deal_in_channel
--   Query E -> paths_by_method
-- No developer-only drilldown exists in 06 — every section here is shared
-- aggregate evidence; nothing item-level, nothing per-user.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_channel_journey_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH realized_business AS (
  SELECT
    *,
    CASE WHEN exit_type IN ('sale', 'trade') THEN exit_type ELSE 'unknown' END AS exit_method
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
),
journey_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM realized_business
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
),

-- Query A -> population_summary
a_row AS (
  SELECT
    (SELECT COUNT(*) FROM realized_business)                                              AS realized_business_item_count,
    (SELECT COUNT(*) FROM journey_eligible)                                                AS journey_eligible_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE deal_in_channel_id IS NULL)              AS missing_deal_in_channel_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NULL)             AS missing_deal_out_channel_item_count,
    (SELECT COUNT(*) FROM realized_business WHERE deal_in_channel_id IS NULL AND deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND(
      (SELECT COUNT(*) FROM journey_eligible)::numeric
        / NULLIF((SELECT COUNT(*) FROM realized_business), 0) * 100,
      2
    )                                                                                     AS journey_coverage_percent,
    (SELECT COUNT(*) FROM journey_eligible WHERE exit_type = 'sale')                       AS journey_sale_exit_item_count,
    (SELECT COUNT(*) FROM journey_eligible WHERE exit_type = 'trade')                      AS journey_trade_exit_item_count,
    (SELECT COUNT(*) FROM journey_eligible WHERE is_historical_import)                     AS historical_journey_eligible_item_count,
    (SELECT COUNT(*) FROM journey_eligible WHERE NOT is_historical_import)                 AS app_tracked_journey_eligible_item_count,
    (SELECT COUNT(DISTINCT deal_in_channel_id) FROM journey_eligible)                      AS distinct_deal_in_channel_count,
    (SELECT COUNT(DISTINCT deal_out_channel_id) FROM journey_eligible)                     AS distinct_deal_out_channel_count
),

-- Query B -> deal_in_to_deal_out_matrix
b_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
    deal_out_channel_id,
    deal_out_channel_name,
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
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM journey_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- Query C -> same_channel_summary
c_row AS (
  SELECT
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)  AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM journey_eligible
),

-- Query D -> same_channel_by_deal_in_channel
d_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM journey_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name
),

-- Query E -> paths_by_method
e_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
    deal_out_channel_id,
    deal_out_channel_name,
    acquisition_method,
    exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM journey_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
)

SELECT jsonb_build_object(
  'population_summary',              (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'deal_in_to_deal_out_matrix',       (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM b_rows),
  'same_channel_summary',             (SELECT COALESCE(jsonb_agg(to_jsonb(c_row)), '[]'::jsonb) FROM c_row),
  'same_channel_by_deal_in_channel',  (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM d_rows),
  'paths_by_method',                  (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM e_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_channel_journey_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_channel_journey_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_channel_journey_snapshot_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_channel_journey_snapshot_v1() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_4(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — calls public.build_analytics_snapshot_v1_3
-- WHOLESALE (v1.3 already validates p_recommendation_target_user_id and
-- assembles acquisition_value_band/acquisition_to_exit/brand/
-- deal_in_channel/deal_out_channel/recommendation_candidates; none of that
-- is duplicated here) and layers evidence_aggregates.channel_journey on top
-- by merging one extra key into the already-assembled evidence_aggregates
-- object.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_4(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v13          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  -- v1.3 already validates p_recommendation_target_user_id (NULL check and
  -- app_users existence check, inherited from v1.2) and RAISEs on failure —
  -- no need to repeat that validation here.
  v_v13 := public.build_analytics_snapshot_v1_3(p_recommendation_target_user_id);

  RETURN v_v13
    || jsonb_build_object(
         'snapshot_schema_version', '1.4',
         'analytics_definition_version', '1.4',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'evidence_aggregates',
         (v_v13 -> 'evidence_aggregates')
           || jsonb_build_object('channel_journey', public._build_channel_journey_snapshot_v1())
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_4(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_4(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_4(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_4(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_4(int) IS
  'Channel Analytics module 3A (Channel Journey). SECURITY INVOKER, '
  'service_role execution only. Lightweight wrapper: calls '
  'build_analytics_snapshot_v1_3(int) wholesale and merges in '
  'evidence_aggregates.channel_journey — acquisition_value_band, '
  'acquisition_to_exit, brand, deal_in_channel, deal_out_channel, and '
  'recommendation_candidates are v1.3''s own assembled output, not copied '
  'or reimplemented. Persists nothing — see analytics_runs '
  '(20260727000000) for the persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v1.4 contract.';
