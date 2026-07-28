-- build_analytics_snapshot_v1_2
--
-- Channel Analytics, module 1 of N: Deal In Channel Performance. Adds a NEW
-- versioned snapshot builder alongside (never replacing) v1.0
-- (20260728000000_build_analytics_snapshot_v1.sql) and v1.1
-- (20260730000000_build_analytics_snapshot_v1_1.sql). All prior functions
-- and every previously stored v1.0/v1.1 analytics_runs.snapshot row remain
-- unchanged and fully readable — this migration only ADDS new objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new (num rebuilt) private helper — three of
-- v1.1's four helpers are REUSED AS-IS, not copied or reimplemented:
--   public._build_deal_in_channel_snapshot_v1()          -- NEW
--   public.build_analytics_snapshot_v1_2(int)             -- NEW, lightweight
-- calls straight through to:
--   public._build_acquisition_to_exit_snapshot_v1_1()     -- v1.1, unchanged
--   public._build_brand_snapshot_v1_1()                   -- v1.1, unchanged
--   public._build_recommendation_candidates_snapshot_v1_1(int) -- v1.1, unchanged
-- and to v1.1's acquisition_value_band helper WITH a narrow JSONB patch
-- (see part 2 below) — the helper itself is never copied or rewritten.
--
-- ── PART 1: _build_deal_in_channel_snapshot_v1() ─────────────────────────
-- Reproduces analytics/sql/04_deal_in_channel_performance.sql. Included
-- sections mapped to stable JSON keys:
--   Query A -> population_summary
--   Query B -> overall_performance
--   Query C -> by_acquisition_method
--   Query D -> by_acquisition_value_band
--   Query E -> open_inventory_exposure
-- No developer-only drilldown exists in 04 (unlike 01/02/03) — every
-- section here is shared aggregate evidence; nothing item-level, nothing
-- per-user.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_deal_in_channel_snapshot_v1()
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
  SELECT * FROM business
  WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),

-- Query A -> population_summary
a_row AS (
  SELECT
    (SELECT COUNT(*) FROM business)                                                    AS business_item_count,
    (SELECT COUNT(*) FROM business WHERE deal_in_channel_id IS NOT NULL)                AS deal_in_channel_known_item_count,
    (SELECT COUNT(*) FROM business WHERE deal_in_channel_id IS NULL)                    AS deal_in_channel_missing_item_count,
    ROUND(
      (SELECT COUNT(*) FROM business WHERE deal_in_channel_id IS NOT NULL)::numeric
        / NULLIF((SELECT COUNT(*) FROM business), 0) * 100,
      2
    )                                                                                   AS deal_in_channel_coverage_percent,
    (SELECT COUNT(DISTINCT deal_in_channel_id) FROM business WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_method = 'purchase')              AS purchase_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_method = 'trade')                 AS trade_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_method NOT IN ('purchase', 'trade')) AS unknown_acquisition_method_item_count,
    (SELECT COUNT(*) FROM business WHERE is_historical_import)                         AS historical_business_item_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_historical_import)                     AS app_tracked_business_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'zero_assigned')   AS deal_in_zero_assigned_acquisition_item_count,
    (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'unknown')         AS deal_in_unknown_acquisition_item_count
),

-- Query B -> overall_performance
b_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
    deal_in_channel_requires_listing,
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
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM business
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),

-- Query C -> by_acquisition_method
c_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
    acquisition_method,
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
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM business
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_method
),

-- Query D -> by_acquisition_value_band
d_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),

-- Query E -> open_inventory_exposure
e_rows AS (
  SELECT
    deal_in_channel_id,
    deal_in_channel_name,
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
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                       AND global_days_on_market IS NOT NULL)                       AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                AND global_days_on_market IS NOT NULL)::numeric, 2)                AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                       AND global_days_on_market >= 60)                            AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                       AND global_days_on_market >= 120)                           AS items_dom_120_plus
  FROM open_items
  GROUP BY deal_in_channel_id, deal_in_channel_name
)

SELECT jsonb_build_object(
  'population_summary',      (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'overall_performance',      (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM b_rows),
  'by_acquisition_method',    (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM c_rows),
  'by_acquisition_value_band',(SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM d_rows),
  'open_inventory_exposure',  (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM e_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_deal_in_channel_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_deal_in_channel_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_deal_in_channel_snapshot_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_deal_in_channel_snapshot_v1() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_2(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — does NOT copy or reimplement v1.1's
-- acquisition_to_exit, brand, or recommendation_candidates helpers; it
-- calls them directly. Only the acquisition_value_band section is
-- post-processed, with a narrow JSONB rename (NOT a rewrite of that
-- ~600-line helper), fixing a genuine v1.1 bug:
--
-- ── THE TRUNCATED-KEY BUG ────────────────────────────────────────────────
-- v1.1's acquisition_value_band population_summary SELECT alias
-- `excluded_unreliable_acquisition_date_realized_holding_days_count` is 64
-- bytes long. PostgreSQL identifiers are limited to 63 bytes (NAMEDATALEN
-- - 1) and SILENTLY TRUNCATE anything longer — the column Postgres
-- actually created is `excluded_unreliable_acquisition_date_realized_
-- holding_days_coun` (missing the final "t"), and that truncated name is
-- what to_jsonb() serializes into every v1.1 snapshot's population_summary
-- to this day. v1.0 and already-stored v1.1 snapshots are NOT touched —
-- this fix only applies to NEW v1.2 snapshots, via the rename below.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_2(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_target_count int;
  v_generated_at timestamptz := now();
  v_avb_raw   jsonb;
  v_pop_fixed jsonb;
  v_avb_fixed jsonb;
BEGIN
  IF p_recommendation_target_user_id IS NULL THEN
    RAISE EXCEPTION 'build_analytics_snapshot_v1_2: p_recommendation_target_user_id must not be NULL';
  END IF;

  SELECT COUNT(*) INTO v_target_count
  FROM public.app_users
  WHERE id = p_recommendation_target_user_id;

  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'build_analytics_snapshot_v1_2: expected exactly 1 app_users row for id % (recommendation target), found %',
      p_recommendation_target_user_id, v_target_count;
  END IF;

  -- Reuse v1.1's acquisition_value_band helper as-is, then rename the one
  -- truncated key in its population_summary row (see PART 2 header above).
  -- The truncated key is looked up dynamically (rather than hardcoding the
  -- 63-byte truncated literal) so this migration's own source stays
  -- readable and is not itself at risk of a copy-paste truncation typo.
  v_avb_raw := public._build_acquisition_value_band_snapshot_v1_1();

  SELECT
    (v_avb_raw -> 'population_summary' -> 0)
      - key
      || jsonb_build_object('excluded_unreliable_acquisition_date_holding_count', value)
  INTO v_pop_fixed
  FROM jsonb_each(v_avb_raw -> 'population_summary' -> 0) AS kv(key, value)
  WHERE key LIKE 'excluded_unreliable_acquisition_date%holding%coun%';

  -- Defensive fallback: if v1.1's shape ever changes and no matching key is
  -- found, fall back to the unmodified population_summary row rather than
  -- producing a NULL population_summary.
  v_pop_fixed := COALESCE(v_pop_fixed, v_avb_raw -> 'population_summary' -> 0);

  v_avb_fixed := v_avb_raw || jsonb_build_object('population_summary', jsonb_build_array(v_pop_fixed));

  RETURN jsonb_build_object(
    'snapshot_schema_version', '1.2',
    'analytics_definition_version', '1.2',
    'generated_at', to_jsonb(v_generated_at),
    'evidence_scope', 'shared_business_population',
    'recommendation_target_user_id', p_recommendation_target_user_id,
    'evidence_aggregates', jsonb_build_object(
      'acquisition_value_band', v_avb_fixed,
      'acquisition_to_exit',    public._build_acquisition_to_exit_snapshot_v1_1(),
      'brand',                  public._build_brand_snapshot_v1_1(),
      'deal_in_channel',        public._build_deal_in_channel_snapshot_v1()
    ),
    'recommendation_candidates', jsonb_build_object(
      'open_business_items', public._build_recommendation_candidates_snapshot_v1_1(p_recommendation_target_user_id)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_2(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_2(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_2(int) IS
  'Channel Analytics module 1 (Deal In Channel Performance) + the v1.1 '
  'acquisition-value-band truncated-key fix. SECURITY INVOKER, service_role '
  'execution only. Lightweight wrapper: acquisition_to_exit, brand, and '
  'recommendation_candidates are v1.1''s own helpers called directly, not '
  'copied. Persists nothing — see analytics_runs (20260727000000) for the '
  'persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v1.2 contract.';
