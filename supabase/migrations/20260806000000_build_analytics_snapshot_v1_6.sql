-- build_analytics_snapshot_v1_6
--
-- Category & Type Performance. Adds a NEW versioned snapshot builder
-- alongside (never replacing) v1.0-v1.5. All prior functions and every
-- previously stored v1.0-v1.5 analytics_runs.snapshot row remain unchanged
-- and fully readable — this migration only ADDS new objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new lightweight top-level wrapper:
--   public._build_category_type_snapshot_v1()             -- NEW
--   public.build_analytics_snapshot_v1_6(int)              -- NEW, lightweight
-- v1.6's top-level wrapper calls public.build_analytics_snapshot_v1_5(int)
-- WHOLESALE (not its individual sub-helpers) and layers
-- evidence_aggregates.category_type_performance on top — v1.5 already
-- assembles every prior module, so v1.6 duplicates none of that.
--
-- ── PART 1: _build_category_type_snapshot_v1() ───────────────────────────
-- Reproduces analytics/sql/08_category_type_performance.sql. Included
-- sections mapped to stable JSON keys:
--   Query A -> population_summary
--   Query B -> category_performance
--   Query C -> type_performance
--   Query D -> category_by_acquisition_value_band
--   Query E -> type_by_acquisition_value_band
--   Query F -> open_inventory_by_category_type
-- No developer-only drilldown exists in 08 — every section here is shared
-- aggregate evidence; nothing item-level, nothing per-user.
--
-- No analytics_item_lifecycle migration was needed for this module —
-- category_id/category_name/type_id/type_name already exist on the view.
--
-- ── CONFIDENCE — BASED ON THE REALIZED SAMPLE ───────────────────────────
-- Unlike the Channel Analytics modules (v1.2-v1.5), which tier confidence
-- from a row's TOTAL item count, every grouped section here tiers
-- confidence from that row's own REALIZED item count — see
-- 08_category_type_performance.sql's own header for the rationale.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_category_type_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH acquisition_value_band AS (
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
  FROM analytics_item_lifecycle
),
business AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value_status = 'positive'
),
open_items AS (
  SELECT * FROM business WHERE NOT is_realized
),

-- Query A -> population_summary
a_row AS (
  SELECT
    (SELECT COUNT(*) FROM business)                                                    AS business_item_count,
    (SELECT COUNT(*) FROM business WHERE is_realized)                                  AS realized_business_item_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized)                              AS open_business_item_count,
    (SELECT COUNT(*) FROM business WHERE category_id IS NOT NULL)                      AS category_known_item_count,
    (SELECT COUNT(*) FROM business WHERE category_id IS NULL)                          AS category_missing_item_count,
    ROUND(
      (SELECT COUNT(*) FROM business WHERE category_id IS NOT NULL)::numeric
        / NULLIF((SELECT COUNT(*) FROM business), 0) * 100,
      2
    )                                                                                   AS category_coverage_percent,
    (SELECT COUNT(*) FROM business WHERE type_id IS NOT NULL)                          AS type_known_item_count,
    (SELECT COUNT(*) FROM business WHERE type_id IS NULL)                              AS type_missing_item_count,
    ROUND(
      (SELECT COUNT(*) FROM business WHERE type_id IS NOT NULL)::numeric
        / NULLIF((SELECT COUNT(*) FROM business), 0) * 100,
      2
    )                                                                                   AS type_coverage_percent,
    (SELECT COUNT(*) FROM business WHERE is_realized AND type_id IS NOT NULL)          AS realized_type_known_item_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND type_id IS NOT NULL)      AS open_type_known_item_count,
    (SELECT COUNT(DISTINCT category_id) FROM business WHERE category_id IS NOT NULL)   AS distinct_category_count,
    (SELECT COUNT(DISTINCT type_id) FROM business WHERE type_id IS NOT NULL)           AS distinct_type_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'positive')        AS positive_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'zero_assigned')   AS zero_assigned_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'unknown')         AS unknown_acquisition_item_count
),

-- Query B -> category_performance
b_rows AS (
  SELECT
    category_id,
    category_name,
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
  FROM business
  GROUP BY category_id, category_name
),

-- Query C -> type_performance
c_rows AS (
  SELECT
    category_id,
    category_name,
    type_id,
    type_name,
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
  FROM business
  GROUP BY category_id, category_name, type_id, type_name
),

-- Query D -> category_by_acquisition_value_band
d_rows AS (
  SELECT
    category_id,
    category_name,
    acquisition_value_band_order,
    acquisition_value_band_label,
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
  FROM eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- Query E -> type_by_acquisition_value_band
e_rows AS (
  SELECT
    category_id,
    category_name,
    type_id,
    type_name,
    acquisition_value_band_order,
    acquisition_value_band_label,
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
  FROM eligible
  GROUP BY category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),

-- Query F -> open_inventory_by_category_type
f_rows AS (
  SELECT
    category_id,
    category_name,
    type_id,
    type_name,
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
  FROM open_items
  GROUP BY category_id, category_name, type_id, type_name
)

SELECT jsonb_build_object(
  'population_summary',                (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'category_performance',              (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY category_name NULLS LAST), '[]'::jsonb) FROM b_rows),
  'type_performance',                  (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM c_rows),
  'category_by_acquisition_value_band',(SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM d_rows),
  'type_by_acquisition_value_band',    (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM e_rows),
  'open_inventory_by_category_type',   (SELECT COALESCE(jsonb_agg(to_jsonb(f_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM f_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_category_type_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_category_type_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_category_type_snapshot_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_category_type_snapshot_v1() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_6(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — calls public.build_analytics_snapshot_v1_5
-- WHOLESALE (v1.5 already validates p_recommendation_target_user_id and
-- assembles every prior module; none of that is duplicated here) and
-- layers evidence_aggregates.category_type_performance on top by merging
-- one extra key into the already-assembled evidence_aggregates object.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_6(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v15          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  -- v1.5 already validates p_recommendation_target_user_id (NULL check and
  -- app_users existence check, inherited from v1.2) and RAISEs on failure —
  -- no need to repeat that validation here.
  v_v15 := public.build_analytics_snapshot_v1_5(p_recommendation_target_user_id);

  RETURN v_v15
    || jsonb_build_object(
         'snapshot_schema_version', '1.6',
         'analytics_definition_version', '1.6',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'evidence_aggregates',
         (v_v15 -> 'evidence_aggregates')
           || jsonb_build_object('category_type_performance', public._build_category_type_snapshot_v1())
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_6(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_6(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_6(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_6(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_6(int) IS
  'Category & Type Performance. SECURITY INVOKER, service_role execution '
  'only. Lightweight wrapper: calls build_analytics_snapshot_v1_5(int) '
  'wholesale and merges in evidence_aggregates.category_type_performance — '
  'every prior module is v1.5''s own assembled output, not copied or '
  'reimplemented. Persists nothing — see analytics_runs (20260727000000) '
  'for the persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v1.6 contract.';
