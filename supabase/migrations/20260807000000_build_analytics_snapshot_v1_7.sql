-- build_analytics_snapshot_v1_7
--
-- Capital & Liquidity. Adds a NEW versioned snapshot builder alongside
-- (never replacing) v1.0-v1.6. All prior functions and every previously
-- stored v1.0-v1.6 analytics_runs.snapshot row remain unchanged and fully
-- readable — this migration only ADDS new objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new lightweight top-level wrapper:
--   public._build_capital_liquidity_snapshot_v1()          -- NEW
--   public.build_analytics_snapshot_v1_7(int)               -- NEW, lightweight
-- v1.7's top-level wrapper calls public.build_analytics_snapshot_v1_6(int)
-- WHOLESALE (not its individual sub-helpers) and layers
-- evidence_aggregates.capital_liquidity on top — v1.6 already assembles
-- every prior module, so v1.7 duplicates none of that.
--
-- ── PART 1: _build_capital_liquidity_snapshot_v1() ───────────────────────
-- Reproduces analytics/sql/09_capital_liquidity.sql. Included sections
-- mapped to stable JSON keys:
--   Query A -> capital_position_summary
--   Query B -> open_capital_age_buckets
--   Query C -> open_capital_by_acquisition_value_band
--   Query D -> open_capital_by_acquisition_method
--   Query E -> realized_capital_efficiency_by_acquisition_value_band
--   Query F -> realized_capital_efficiency_by_acquisition_method
-- No developer-only drilldown exists in 09 — every section here is shared
-- aggregate evidence; nothing item-level, nothing per-user. No
-- cash_flow/cash-balance table is read anywhere in this function.
--
-- No analytics_item_lifecycle migration was needed — every field used
-- here already exists on the view.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_capital_liquidity_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH business AS (
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
      WHEN is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue THEN 5
      WHEN holding_days < 30  THEN 1
      WHEN holding_days < 60  THEN 2
      WHEN holding_days < 120 THEN 3
      ELSE 4
    END AS age_bucket_order,
    CASE
      WHEN is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue THEN 'unreliable/unknown age'
      WHEN holding_days < 30  THEN '0-29 days'
      WHEN holding_days < 60  THEN '30-59 days'
      WHEN holding_days < 120 THEN '60-119 days'
      ELSE '120+ days'
    END AS age_bucket_label
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business'
),
open_items AS (
  SELECT * FROM business WHERE NOT is_realized
),
open_eligible AS (
  SELECT * FROM open_items WHERE acquisition_value_status = 'positive'
),
total_open_capital AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM open_items
),
realized_eligible AS (
  SELECT
    *,
    CASE
      WHEN NOT is_historical_import AND holding_days IS NOT NULL AND holding_days > 0 AND NOT has_lifecycle_date_issue
        THEN (net_profit / holding_days::numeric) * 30
    END AS net_profit_per_30_holding_days
  FROM business
  WHERE is_realized AND acquisition_value_status = 'positive'
),

-- Query A -> capital_position_summary
a_row AS (
  SELECT
    (SELECT COUNT(*) FROM business)                                                    AS business_item_count,
    (SELECT COUNT(*) FROM business WHERE is_realized)                                  AS realized_business_item_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized)                              AS open_business_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'positive')        AS positive_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'zero_assigned')   AS zero_assigned_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'unknown')         AS unknown_acquisition_item_count,
    (SELECT SUM(acquisition_value) FROM business WHERE acquisition_value IS NOT NULL)  AS total_business_acquisition_capital,
    (SELECT SUM(acquisition_value) FROM business WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed') AS listed_open_item_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status <> 'listed') AS unlisted_open_item_count,
    (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND current_status = 'listed' AND acquisition_value IS NOT NULL) AS listed_open_acquisition_capital,
    (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND current_status <> 'listed' AND acquisition_value IS NOT NULL) AS unlisted_open_acquisition_capital,
    (SELECT SUM(net_profit) FROM business WHERE is_realized)                            AS total_realized_net_profit,
    ROUND(
      (SELECT SUM(net_profit) FROM business WHERE is_realized)
        / NULLIF((SELECT SUM(acquisition_value) FROM business WHERE is_realized AND acquisition_value IS NOT NULL), 0) * 100,
      2
    )                                                                                   AS realized_profit_to_acquisition_capital_percent,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
    (SELECT SUM(estimated_sold_value - acquisition_value - item_expenses_total) FROM business
       WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)                            AS estimated_open_net_upside,
    ROUND(
      (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND acquisition_value IS NOT NULL)
        / NULLIF((SELECT SUM(acquisition_value) FROM business WHERE acquisition_value IS NOT NULL), 0) * 100,
      2
    )                                                                                   AS open_capital_percent_of_total_business_capital
),

-- Query B -> open_capital_age_buckets
b_rows AS (
  SELECT
    age_bucket_order,
    age_bucket_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(
      SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
        / NULLIF((SELECT amount FROM total_open_capital), 0) * 100,
      2
    )                                                                               AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count
  FROM open_items
  GROUP BY age_bucket_order, age_bucket_label
),

-- Query C -> open_capital_by_acquisition_value_band
c_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value)                                                         AS open_acquisition_capital,
    ROUND(
      SUM(acquisition_value)::numeric
        / NULLIF((SELECT amount FROM total_open_capital), 0) * 100,
      2
    )                                                                               AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL)                       AS estimated_upside_available_count,
    0                                                                               AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total) FILTER (WHERE estimated_sold_value IS NOT NULL) AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM open_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- Query D -> open_capital_by_acquisition_method
-- COALESCE to 'unknown': an item with no incoming deal_item row at all
-- (e.g. fixture item 13) has a raw SQL NULL acquisition_method from the
-- view (its acquisition_method CASE never runs for it), not the string
-- 'unknown' — normalized here so this section's output always uses
-- exactly the three values the task contract requires.
d_rows AS (
  SELECT
    COALESCE(acquisition_method, 'unknown')                                        AS acquisition_method,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(
      SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
        / NULLIF((SELECT amount FROM total_open_capital), 0) * 100,
      2
    )                                                                               AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM open_items
  GROUP BY COALESCE(acquisition_method, 'unknown')
),

-- Query E -> realized_capital_efficiency_by_acquisition_value_band
e_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                       AS realized_item_count,
    SUM(acquisition_value)                                                         AS realized_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(SUM(net_profit)::numeric / NULLIF(SUM(acquisition_value), 0) * 100, 2)   AS profit_to_acquisition_capital_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)             AS time_efficiency_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit_per_30_holding_days) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)::numeric, 2) AS median_net_profit_per_30_holding_days,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM realized_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- Query F -> realized_capital_efficiency_by_acquisition_method
f_rows AS (
  SELECT
    acquisition_method,
    COUNT(*)                                                                       AS realized_item_count,
    SUM(acquisition_value)                                                         AS realized_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(SUM(net_profit)::numeric / NULLIF(SUM(acquisition_value), 0) * 100, 2)   AS profit_to_acquisition_capital_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)             AS time_efficiency_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit_per_30_holding_days) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)::numeric, 2) AS median_net_profit_per_30_holding_days,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM realized_eligible
  GROUP BY acquisition_method
)

SELECT jsonb_build_object(
  'capital_position_summary',                              (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'open_capital_age_buckets',                               (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY age_bucket_order), '[]'::jsonb) FROM b_rows),
  'open_capital_by_acquisition_value_band',                 (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM c_rows),
  'open_capital_by_acquisition_method',                     (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY acquisition_method), '[]'::jsonb) FROM d_rows),
  'realized_capital_efficiency_by_acquisition_value_band',  (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM e_rows),
  'realized_capital_efficiency_by_acquisition_method',      (SELECT COALESCE(jsonb_agg(to_jsonb(f_rows) ORDER BY acquisition_method), '[]'::jsonb) FROM f_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_capital_liquidity_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_capital_liquidity_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_capital_liquidity_snapshot_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_capital_liquidity_snapshot_v1() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_7(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — calls public.build_analytics_snapshot_v1_6
-- WHOLESALE (v1.6 already validates p_recommendation_target_user_id and
-- assembles every prior module; none of that is duplicated here) and
-- layers evidence_aggregates.capital_liquidity on top by merging one extra
-- key into the already-assembled evidence_aggregates object.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_7(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v16          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  -- v1.6 already validates p_recommendation_target_user_id (NULL check and
  -- app_users existence check, inherited from v1.2) and RAISEs on failure —
  -- no need to repeat that validation here.
  v_v16 := public.build_analytics_snapshot_v1_6(p_recommendation_target_user_id);

  RETURN v_v16
    || jsonb_build_object(
         'snapshot_schema_version', '1.7',
         'analytics_definition_version', '1.7',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'evidence_aggregates',
         (v_v16 -> 'evidence_aggregates')
           || jsonb_build_object('capital_liquidity', public._build_capital_liquidity_snapshot_v1())
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_7(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_7(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_7(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_7(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_7(int) IS
  'Capital & Liquidity. SECURITY INVOKER, service_role execution only. '
  'Lightweight wrapper: calls build_analytics_snapshot_v1_6(int) wholesale '
  'and merges in evidence_aggregates.capital_liquidity — every prior '
  'module is v1.6''s own assembled output, not copied or reimplemented. '
  'Persists nothing — see analytics_runs (20260727000000) for the '
  'persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v1.7 contract.';
