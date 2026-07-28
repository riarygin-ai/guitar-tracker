-- build_analytics_snapshot_v1_5
--
-- Channel Analytics, module 3B of N: Listing Channel Exposure. Adds a NEW
-- versioned snapshot builder alongside (never replacing) v1.0-v1.4. All
-- prior functions and every previously stored v1.0-v1.4
-- analytics_runs.snapshot row remain unchanged and fully readable — this
-- migration only ADDS new objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new lightweight top-level wrapper:
--   public._build_listing_channel_exposure_snapshot_v1()  -- NEW
--   public.build_analytics_snapshot_v1_5(int)              -- NEW, lightweight
-- v1.5's top-level wrapper calls public.build_analytics_snapshot_v1_4(int)
-- WHOLESALE (not its individual sub-helpers) and layers
-- evidence_aggregates.listing_channel_exposure on top — v1.4 already
-- assembles every prior module, so v1.5 duplicates none of that.
--
-- ── PART 1: _build_listing_channel_exposure_snapshot_v1() ───────────────
-- Reproduces analytics/sql/07_listing_channel_exposure.sql. Included
-- sections mapped to stable JSON keys:
--   Query A -> population_summary
--   Query B -> listing_channel_performance
--   Query C -> cross_listing_summary (object: buckets[] + 3 scalars)
--   Query D -> listing_to_deal_out_matrix
--   Query E -> open_inventory_by_listing_channel
--   Query F -> open_unlisted_summary
-- No developer-only drilldown exists in 07 — every section here is shared
-- aggregate evidence; nothing item-level, nothing per-user.
--
-- No analytics_item_lifecycle migration was needed for this module — see
-- 07_listing_channel_exposure.sql's own header for the item_listings
-- schema findings (no active/current-state column; deal_channel_id is
-- NOT NULL) that justify joining item_listings directly instead.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_listing_channel_exposure_snapshot_v1()
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
    END AS acquisition_value_status
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
canonical_exposure AS (
  SELECT
    inventory_item_id,
    deal_channel_id,
    COUNT(*)         AS listing_record_count,
    MIN(listed_at)   AS first_listed_at,
    MAX(listed_at)   AS latest_listed_at
  FROM eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
item_has_eligible_listing AS (
  SELECT DISTINCT inventory_item_id FROM canonical_exposure
),
eligible_listing AS (
  SELECT
    b.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count,
    ce.first_listed_at AS channel_first_listed_at
  FROM business b
  JOIN canonical_exposure ce ON ce.inventory_item_id = b.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
item_channel_counts AS (
  SELECT b.item_id, COUNT(ce.deal_channel_id) AS channel_count
  FROM business b
  LEFT JOIN canonical_exposure ce ON ce.inventory_item_id = b.item_id
  GROUP BY b.item_id
),
bucketed AS (
  SELECT
    b.*,
    icc.channel_count,
    CASE
      WHEN icc.channel_count = 0 THEN 0
      WHEN icc.channel_count = 1 THEN 1
      WHEN icc.channel_count = 2 THEN 2
      ELSE 3
    END AS listing_channel_count_bucket_order,
    CASE
      WHEN icc.channel_count = 0 THEN '0 channels'
      WHEN icc.channel_count = 1 THEN '1 channel'
      WHEN icc.channel_count = 2 THEN '2 channels'
      ELSE '3+ channels'
    END AS listing_channel_count_bucket
  FROM business b
  JOIN item_channel_counts icc ON icc.item_id = b.item_id
),

-- Query A -> population_summary
a_row AS (
  SELECT
    (SELECT COUNT(*) FROM business)                                                       AS business_item_count,
    (SELECT COUNT(*) FROM business WHERE is_realized)                                      AS realized_business_item_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized)                                  AS open_business_item_count,
    (SELECT COUNT(*) FROM business WHERE item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS item_with_eligible_listing_count,
    (SELECT COUNT(*) FROM business WHERE item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS item_without_eligible_listing_count,
    ROUND(
      (SELECT COUNT(*) FROM business WHERE item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing))::numeric
        / NULLIF((SELECT COUNT(*) FROM business), 0) * 100,
      2
    )                                                                                      AS listing_coverage_percent,
    (SELECT COUNT(*) FROM business WHERE is_realized AND item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS realized_item_with_eligible_listing_count,
    (SELECT COUNT(*) FROM business WHERE is_realized AND item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS realized_item_without_eligible_listing_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS open_item_with_eligible_listing_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS open_item_without_eligible_listing_count,
    (SELECT COUNT(*) FROM canonical_exposure)                                              AS eligible_listing_exposure_count,
    (SELECT COALESCE(SUM(listing_record_count), 0) FROM canonical_exposure)                AS eligible_listing_record_count,
    (SELECT COUNT(DISTINCT deal_channel_id) FROM canonical_exposure)                       AS distinct_listing_channel_count,
    (SELECT COUNT(*) FROM public.item_listings il
       JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
       JOIN business b ON b.item_id = il.inventory_item_id
       WHERE dc.is_listing_platform = false)                                               AS ignored_non_listing_channel_record_count,
    (SELECT COUNT(*) FROM public.item_listings il
       JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
       JOIN business b ON b.item_id = il.inventory_item_id
       WHERE dc.is_listing_platform = true AND il.listed_at IS NULL)                       AS missing_listing_channel_record_count
),

-- Query B -> listing_channel_performance
b_rows AS (
  SELECT
    listing_channel_id,
    listing_channel_name,
    COUNT(*)                                                                       AS exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_exposed_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL)        AS realized_exposed_item_with_known_deal_out_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id) AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL AND deal_out_channel_id <> listing_channel_id) AS different_channel_exit_item_count,
    ROUND(
      COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id)::numeric
        / NULLIF(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL), 0) * 100,
      2
    )                                                                               AS same_channel_exit_percent,
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
  FROM eligible_listing
  GROUP BY listing_channel_id, listing_channel_name
),

-- Query C -> cross_listing_summary (buckets)
c_buckets AS (
  SELECT
    listing_channel_count_bucket_order,
    listing_channel_count_bucket,
    COUNT(*)                                                                       AS business_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
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
  FROM bucketed
  GROUP BY listing_channel_count_bucket_order, listing_channel_count_bucket
),
c_summary AS (
  SELECT
    (SELECT COUNT(*) FROM bucketed WHERE channel_count = 1)  AS single_listed_item_count,
    (SELECT COUNT(*) FROM bucketed WHERE channel_count >= 2) AS cross_listed_item_count,
    ROUND(
      (SELECT COUNT(*) FROM bucketed WHERE channel_count >= 2)::numeric
        / NULLIF((SELECT COUNT(*) FROM bucketed), 0) * 100,
      2
    )                                                          AS cross_listed_item_percent
),

-- Query D -> listing_to_deal_out_matrix
d_rows AS (
  SELECT
    listing_channel_id,
    listing_channel_name,
    deal_out_channel_id,
    deal_out_channel_name,
    COUNT(*)                                                                       AS exposed_realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    (listing_channel_id = deal_out_channel_id)                                     AS same_channel_flag,
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
  FROM eligible_listing
  WHERE is_realized AND deal_out_channel_id IS NOT NULL
  GROUP BY listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- Query E -> open_inventory_by_listing_channel
e_rows AS (
  SELECT
    listing_channel_id,
    listing_channel_name,
    COUNT(*)                                                                       AS open_exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue)                          AS current_listing_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (CURRENT_DATE - channel_first_listed_at)) FILTER (WHERE NOT has_lifecycle_date_issue)::numeric, 2) AS median_current_listing_age_days,
    COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND (CURRENT_DATE - channel_first_listed_at) >= 60)  AS items_listing_age_60_plus,
    COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND (CURRENT_DATE - channel_first_listed_at) >= 120) AS items_listing_age_120_plus
  FROM eligible_listing
  WHERE NOT is_realized
  GROUP BY listing_channel_id, listing_channel_name
),

-- Query F -> open_unlisted_summary
f_row AS (
  SELECT
    COUNT(*)                                                                       AS open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_unlisted_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM business
  WHERE NOT is_realized
    AND item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)
)

SELECT jsonb_build_object(
  'population_summary',              (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'listing_channel_performance',      (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY listing_channel_name), '[]'::jsonb) FROM b_rows),
  'cross_listing_summary', (
    SELECT jsonb_build_object(
      'single_listed_item_count',  c_summary.single_listed_item_count,
      'cross_listed_item_count',   c_summary.cross_listed_item_count,
      'cross_listed_item_percent', c_summary.cross_listed_item_percent,
      'buckets', (SELECT COALESCE(jsonb_agg(to_jsonb(c_buckets) ORDER BY listing_channel_count_bucket_order), '[]'::jsonb) FROM c_buckets)
    )
    FROM c_summary
  ),
  'listing_to_deal_out_matrix',       (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY listing_channel_name, deal_out_channel_name), '[]'::jsonb) FROM d_rows),
  'open_inventory_by_listing_channel',(SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY listing_channel_name), '[]'::jsonb) FROM e_rows),
  'open_unlisted_summary',            (SELECT COALESCE(jsonb_agg(to_jsonb(f_row)), '[]'::jsonb) FROM f_row)
);
$$;

REVOKE ALL ON FUNCTION public._build_listing_channel_exposure_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_listing_channel_exposure_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_listing_channel_exposure_snapshot_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_listing_channel_exposure_snapshot_v1() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_5(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — calls public.build_analytics_snapshot_v1_4
-- WHOLESALE (v1.4 already validates p_recommendation_target_user_id and
-- assembles every prior module; none of that is duplicated here) and
-- layers evidence_aggregates.listing_channel_exposure on top by merging one
-- extra key into the already-assembled evidence_aggregates object.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_5(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v14          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  -- v1.4 already validates p_recommendation_target_user_id (NULL check and
  -- app_users existence check, inherited from v1.2) and RAISEs on failure —
  -- no need to repeat that validation here.
  v_v14 := public.build_analytics_snapshot_v1_4(p_recommendation_target_user_id);

  RETURN v_v14
    || jsonb_build_object(
         'snapshot_schema_version', '1.5',
         'analytics_definition_version', '1.5',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'evidence_aggregates',
         (v_v14 -> 'evidence_aggregates')
           || jsonb_build_object('listing_channel_exposure', public._build_listing_channel_exposure_snapshot_v1())
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_5(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_5(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_5(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_5(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_5(int) IS
  'Channel Analytics module 3B (Listing Channel Exposure). SECURITY '
  'INVOKER, service_role execution only. Lightweight wrapper: calls '
  'build_analytics_snapshot_v1_4(int) wholesale and merges in '
  'evidence_aggregates.listing_channel_exposure — every prior module is '
  'v1.4''s own assembled output, not copied or reimplemented. Persists '
  'nothing — see analytics_runs (20260727000000) for the persistence '
  'step. See analytics/README.md and analytics/SEMANTIC_CONTRACT.md for '
  'the full v1.5 contract.';
