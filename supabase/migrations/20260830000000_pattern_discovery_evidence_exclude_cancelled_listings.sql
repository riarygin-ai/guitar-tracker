-- _build_pattern_discovery_evidence_v2_13: exclude cancelled listings
-- from the LISTING_PLATFORM family (Rule 1).
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────
-- This helper (called only by build_analytics_snapshot_v2_13) reads
-- item_listings directly for its LISTING_PLATFORM family (family 13) —
-- independent of, and NOT fixed by, 20260829000000's
-- analytics_item_lifecycle view fix, since this function never reads that
-- view for this part. Its lp_eligible_records CTE used
-- `il.listed_at IS NOT NULL` with no status filter — under the pre-
-- 20260828000000 schema that was equivalent to "a real listing exists";
-- now that item_listings supports draft/active/ended/cancelled cycles, a
-- cancelled row can still carry a listed_at (see
-- item_listings_status_fields_check — cancelling an ACTIVE listing does
-- not clear listed_at), so it would wrongly still count as listing-
-- platform evidence and could wrongly become the canonical
-- (MIN(listed_at)) exposure date for an item+platform.
--
-- ── FIX ───────────────────────────────────────────────────────────────────
-- lp_eligible_records now filters to status IN ('active', 'ended') —
-- identical rule to the analytics_item_lifecycle view fix, Rule 1/6.
-- Draft rows never have listed_at set (item_listings_status_fields_check),
-- so they were already structurally excluded either way; this makes that
-- explicit rather than incidental, matching Rule 2. Nothing else in this
-- function changes — schema_version stays '1.0', every other family,
-- every field name, every limitation code is byte-identical to
-- 20260824000000's own version. No version bump: this is a bug fix to a
-- helper's evidence computation, not a change to
-- target_user_pattern_discovery_evidence's own output shape — see this
-- session's report and 20260829000000's header for the identical
-- reasoning applied to analytics_item_lifecycle.
--
-- CREATE OR REPLACE FUNCTION requires the full body — Postgres has no
-- partial-function-alter — so the entire function is reproduced here,
-- verbatim from 20260824000000_build_analytics_snapshot_v2_13.sql, with
-- ONLY the lp_eligible_records WHERE clause changed (marked below).

CREATE OR REPLACE FUNCTION public._build_pattern_discovery_evidence_v2_13(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH

-- ── Realized-item base population (target user only) ────────────────────
pd_base AS (
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
    CASE WHEN exit_type IN ('sale', 'trade') THEN exit_type ELSE 'unknown' END AS exit_method,
    CASE WHEN global_days_on_market IS NOT NULL AND global_days_on_market >= 0 THEN global_days_on_market END AS valid_dom_days,
    (global_days_on_market IS NOT NULL AND global_days_on_market < 0) AS is_invalid_dom
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = p_target_user_id AND is_realized = true
),

-- ── population_summary ───────────────────────────────────────────────────
pd_population_summary AS (
  SELECT
    COUNT(*)                                          AS total_realized_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)      AS historical_import_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)  AS app_tracked_realized_item_count
  FROM pd_base
),

-- ── Family 1: ACQUISITION_VALUE_BAND ─────────────────────────────────────
fam1_rows AS (
  SELECT
    'ACQUISITION_VALUE_BAND'::text                                                 AS family_code,
    1                                                                               AS family_order,
    ('ACQUISITION_VALUE_BAND|band_order=' || acquisition_value_band_order)          AS pattern_key,
    'family=ACQUISITION_VALUE_BAND'                                                 AS peer_group_key,
    jsonb_build_object('family', 'ACQUISITION_VALUE_BAND')                          AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('acquisition_value_band_order', acquisition_value_band_order, 'acquisition_value_band_label', acquisition_value_band_label) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- ── Family 2: CATEGORY ───────────────────────────────────────────────────
fam2_rows AS (
  SELECT
    'CATEGORY'::text                                                               AS family_code,
    2                                                                               AS family_order,
    ('CATEGORY|category_id=' || COALESCE(category_id::text, 'null'))                AS pattern_key,
    'family=CATEGORY'                                                               AS peer_group_key,
    jsonb_build_object('family', 'CATEGORY')                                        AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('category_id', category_id, 'category_name', category_name)  AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY category_id, category_name
),

-- ── Family 3: TYPE_WITHIN_CATEGORY ───────────────────────────────────────
fam3_rows AS (
  SELECT
    'TYPE_WITHIN_CATEGORY'::text                                                   AS family_code,
    3                                                                               AS family_order,
    ('TYPE_WITHIN_CATEGORY|category_id=' || COALESCE(category_id::text, 'null') || '|type_id=' || COALESCE(type_id::text, 'null')) AS pattern_key,
    ('family=TYPE_WITHIN_CATEGORY|category_id=' || COALESCE(category_id::text, 'null')) AS peer_group_key,
    jsonb_build_object('family', 'TYPE_WITHIN_CATEGORY', 'category_id', category_id) AS comparison_scope,
    2                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('category_id', category_id, 'category_name', category_name, 'type_id', type_id, 'type_name', type_name) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY category_id, category_name, type_id, type_name
),

-- ── Family 4: BRAND_WITHIN_CATEGORY ──────────────────────────────────────
fam4_rows AS (
  SELECT
    'BRAND_WITHIN_CATEGORY'::text                                                  AS family_code,
    4                                                                               AS family_order,
    ('BRAND_WITHIN_CATEGORY|category_id=' || COALESCE(category_id::text, 'null') || '|brand_id=' || COALESCE(brand_id::text, 'null')) AS pattern_key,
    ('family=BRAND_WITHIN_CATEGORY|category_id=' || COALESCE(category_id::text, 'null')) AS peer_group_key,
    jsonb_build_object('family', 'BRAND_WITHIN_CATEGORY', 'category_id', category_id) AS comparison_scope,
    2                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('category_id', category_id, 'category_name', category_name, 'brand_id', brand_id, 'brand_name', brand_name) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY category_id, category_name, brand_id, brand_name
),

-- ── Family 5: CATEGORY_ACQUISITION_VALUE_BAND ────────────────────────────
fam5_rows AS (
  SELECT
    'CATEGORY_ACQUISITION_VALUE_BAND'::text                                        AS family_code,
    5                                                                               AS family_order,
    ('CATEGORY_ACQUISITION_VALUE_BAND|category_id=' || COALESCE(category_id::text, 'null') || '|band_order=' || acquisition_value_band_order) AS pattern_key,
    ('family=CATEGORY_ACQUISITION_VALUE_BAND|category_id=' || COALESCE(category_id::text, 'null')) AS peer_group_key,
    jsonb_build_object('family', 'CATEGORY_ACQUISITION_VALUE_BAND', 'category_id', category_id) AS comparison_scope,
    2                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('category_id', category_id, 'category_name', category_name, 'acquisition_value_band_order', acquisition_value_band_order, 'acquisition_value_band_label', acquisition_value_band_label) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- ── Family 6: TYPE_ACQUISITION_VALUE_BAND ────────────────────────────────
fam6_rows AS (
  SELECT
    'TYPE_ACQUISITION_VALUE_BAND'::text                                            AS family_code,
    6                                                                               AS family_order,
    ('TYPE_ACQUISITION_VALUE_BAND|type_id=' || COALESCE(type_id::text, 'null') || '|band_order=' || acquisition_value_band_order) AS pattern_key,
    ('family=TYPE_ACQUISITION_VALUE_BAND|type_id=' || COALESCE(type_id::text, 'null')) AS peer_group_key,
    jsonb_build_object('family', 'TYPE_ACQUISITION_VALUE_BAND', 'type_id', type_id) AS comparison_scope,
    2                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('category_id', category_id, 'category_name', category_name, 'type_id', type_id, 'type_name', type_name, 'acquisition_value_band_order', acquisition_value_band_order, 'acquisition_value_band_label', acquisition_value_band_label) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),

-- ── Family 7: ACQUISITION_METHOD ─────────────────────────────────────────
fam7_rows AS (
  SELECT
    'ACQUISITION_METHOD'::text                                                     AS family_code,
    7                                                                               AS family_order,
    ('ACQUISITION_METHOD|method=' || acquisition_method)                            AS pattern_key,
    'family=ACQUISITION_METHOD'                                                     AS peer_group_key,
    jsonb_build_object('family', 'ACQUISITION_METHOD')                              AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('acquisition_method', acquisition_method)                    AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY acquisition_method
),

-- ── Family 8: EXIT_METHOD ────────────────────────────────────────────────
fam8_rows AS (
  SELECT
    'EXIT_METHOD'::text                                                            AS family_code,
    8                                                                               AS family_order,
    ('EXIT_METHOD|method=' || exit_method)                                         AS pattern_key,
    'family=EXIT_METHOD'                                                            AS peer_group_key,
    jsonb_build_object('family', 'EXIT_METHOD')                                    AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('exit_method', exit_method)                                  AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY exit_method
),

-- ── Family 9: ACQUISITION_METHOD_WITHIN_EXIT_METHOD ──────────────────────
fam9_rows AS (
  SELECT
    'ACQUISITION_METHOD_WITHIN_EXIT_METHOD'::text                                  AS family_code,
    9                                                                               AS family_order,
    ('ACQUISITION_METHOD_WITHIN_EXIT_METHOD|exit=' || exit_method || '|acquisition=' || acquisition_method) AS pattern_key,
    ('family=ACQUISITION_METHOD_WITHIN_EXIT_METHOD|exit_method=' || exit_method)    AS peer_group_key,
    jsonb_build_object('family', 'ACQUISITION_METHOD_WITHIN_EXIT_METHOD', 'exit_method', exit_method) AS comparison_scope,
    2                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('acquisition_method', acquisition_method, 'exit_method', exit_method) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  GROUP BY exit_method, acquisition_method
),

-- ── Family 10: DEAL_IN_CHANNEL (null channel excluded, reported in
-- coverage_summary separately) ───────────────────────────────────────────
fam10_rows AS (
  SELECT
    'DEAL_IN_CHANNEL'::text                                                        AS family_code,
    10                                                                              AS family_order,
    ('DEAL_IN_CHANNEL|channel_id=' || deal_in_channel_id)                           AS pattern_key,
    'family=DEAL_IN_CHANNEL'                                                        AS peer_group_key,
    jsonb_build_object('family', 'DEAL_IN_CHANNEL')                                 AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('deal_in_channel_id', deal_in_channel_id, 'deal_in_channel_name', deal_in_channel_name) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  WHERE deal_in_channel_id IS NOT NULL
  GROUP BY deal_in_channel_id, deal_in_channel_name
),

-- ── Family 11: DEAL_OUT_CHANNEL (null channel excluded) ──────────────────
fam11_rows AS (
  SELECT
    'DEAL_OUT_CHANNEL'::text                                                       AS family_code,
    11                                                                              AS family_order,
    ('DEAL_OUT_CHANNEL|channel_id=' || deal_out_channel_id)                         AS pattern_key,
    'family=DEAL_OUT_CHANNEL'                                                       AS peer_group_key,
    jsonb_build_object('family', 'DEAL_OUT_CHANNEL')                                AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('deal_out_channel_id', deal_out_channel_id, 'deal_out_channel_name', deal_out_channel_name) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  WHERE deal_out_channel_id IS NOT NULL
  GROUP BY deal_out_channel_id, deal_out_channel_name
),

-- ── Family 12: DEAL_IN_TO_DEAL_OUT_JOURNEY (both channel identities
-- required; incomplete journeys reported in coverage_summary) ───────────
fam12_rows AS (
  SELECT
    'DEAL_IN_TO_DEAL_OUT_JOURNEY'::text                                            AS family_code,
    12                                                                              AS family_order,
    ('DEAL_IN_TO_DEAL_OUT_JOURNEY|in=' || deal_in_channel_id || '|out=' || deal_out_channel_id) AS pattern_key,
    'family=DEAL_IN_TO_DEAL_OUT_JOURNEY'                                            AS peer_group_key,
    jsonb_build_object('family', 'DEAL_IN_TO_DEAL_OUT_JOURNEY')                     AS comparison_scope,
    2                                                                               AS dimension_count,
    'REALIZED_ITEMS'                                                                AS population_basis,
    jsonb_build_object('deal_in_channel_id', deal_in_channel_id, 'deal_in_channel_name', deal_in_channel_name, 'deal_out_channel_id', deal_out_channel_id, 'deal_out_channel_name', deal_out_channel_name) AS segment,
    COUNT(*)                                                                        AS realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                    AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE net_profit IS NOT NULL)                                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE roi IS NOT NULL)                                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE valid_dom_days IS NOT NULL)                              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY valid_dom_days) FILTER (WHERE valid_dom_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_dom)                                          AS invalid_dom_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    '[]'::jsonb                                                                     AS limitations
  FROM pd_base
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- ── Family 13: LISTING_PLATFORM ──────────────────────────────────────────
-- Built off ALL target-user items (open + realized), then restricted to
-- realized exposures in the aggregate below — a platform with zero
-- realized exposure never produces a candidate row (HAVING).
lp_base_all AS (
  SELECT * FROM public.analytics_item_lifecycle_v2 WHERE user_id = p_target_user_id
),
lp_eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN lp_base_all ai ON ai.item_id = il.inventory_item_id
  -- FIXED (20260830000000, Rule 1): status IN ('active','ended') — was
  -- `il.listed_at IS NOT NULL`, which also matched cancelled listings
  -- (cancelling an active listing does not clear listed_at). Draft rows
  -- never have listed_at set at all, so this changes nothing for them.
  WHERE dc.is_listing_platform = true AND il.status IN ('active', 'ended')
),
lp_canonical AS (
  SELECT inventory_item_id, deal_channel_id, MIN(listed_at) AS canonical_channel_listed_at
  FROM lp_eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
lp_exposure AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.canonical_channel_listed_at
  FROM lp_base_all ai
  JOIN lp_canonical ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
lp_timed AS (
  SELECT
    *,
    (is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL AND canonical_channel_listed_at > exit_date) AS is_invalid_after_exit,
    CASE
      WHEN is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL AND canonical_channel_listed_at <= exit_date
      THEN (exit_date - canonical_channel_listed_at)
    END AS channel_listing_to_exit_days
  FROM lp_exposure
),
fam13_rows AS (
  SELECT
    'LISTING_PLATFORM'::text                                                       AS family_code,
    13                                                                              AS family_order,
    ('LISTING_PLATFORM|channel_id=' || listing_channel_id)                          AS pattern_key,
    'family=LISTING_PLATFORM'                                                       AS peer_group_key,
    jsonb_build_object('family', 'LISTING_PLATFORM')                                AS comparison_scope,
    1                                                                               AS dimension_count,
    'REALIZED_LISTING_EXPOSURES'                                                    AS population_basis,
    jsonb_build_object('listing_channel_id', listing_channel_id, 'listing_channel_name', listing_channel_name) AS segment,
    COUNT(*) FILTER (WHERE is_realized)                                             AS realized_item_count,
    COUNT(DISTINCT exit_deal_id) FILTER (WHERE is_realized)                         AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE is_realized AND net_profit IS NOT NULL)                  AS profit_sample_size,
    COUNT(*) FILTER (WHERE is_realized AND roi IS NOT NULL)                         AS roi_sample_size,
    COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)                AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized AND net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2)               AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY channel_listing_to_exit_days) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_invalid_after_exit)                                   AS invalid_dom_count,
    COUNT(*) FILTER (WHERE is_realized AND channel_listing_to_exit_days IS NULL AND NOT is_invalid_after_exit) AS missing_dom_count,
    COUNT(*) FILTER (WHERE is_realized AND is_historical_import)                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import)                AS app_tracked_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized AND is_historical_import)::numeric / NULLIF(COUNT(*) FILTER (WHERE is_realized), 0) * 100, 2) AS historical_import_percent,
    CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient' WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low' WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence,
    jsonb_build_array('LISTING_PLATFORM_ITEMS_MAY_APPEAR_IN_MULTIPLE_SEGMENTS')      AS limitations
  FROM lp_timed
  GROUP BY listing_channel_id, listing_channel_name
  HAVING COUNT(*) FILTER (WHERE is_realized) > 0
),

-- ── Unified candidate_segments, deterministically ordered ───────────────
pd_all_candidates AS (
  SELECT * FROM fam1_rows  UNION ALL
  SELECT * FROM fam2_rows  UNION ALL
  SELECT * FROM fam3_rows  UNION ALL
  SELECT * FROM fam4_rows  UNION ALL
  SELECT * FROM fam5_rows  UNION ALL
  SELECT * FROM fam6_rows  UNION ALL
  SELECT * FROM fam7_rows  UNION ALL
  SELECT * FROM fam8_rows  UNION ALL
  SELECT * FROM fam9_rows  UNION ALL
  SELECT * FROM fam10_rows UNION ALL
  SELECT * FROM fam11_rows UNION ALL
  SELECT * FROM fam12_rows UNION ALL
  SELECT * FROM fam13_rows
),
pd_candidate_segments_ordered AS (
  SELECT
    jsonb_build_object(
      'family_code', family_code,
      'pattern_key', pattern_key,
      'peer_group_key', peer_group_key,
      'comparison_scope', comparison_scope,
      'dimension_count', dimension_count,
      'population_basis', population_basis,
      'segment', segment,
      'realized_item_count', realized_item_count,
      'distinct_exit_deal_count', distinct_exit_deal_count,
      'profit_sample_size', profit_sample_size,
      'roi_sample_size', roi_sample_size,
      'dom_sample_size', dom_sample_size,
      'median_net_profit', median_net_profit,
      'median_roi', median_roi,
      'median_days_on_market', median_days_on_market,
      'invalid_dom_count', invalid_dom_count,
      'missing_dom_count', missing_dom_count,
      'historical_import_item_count', historical_import_item_count,
      'app_tracked_item_count', app_tracked_item_count,
      'historical_import_percent', historical_import_percent,
      'confidence', confidence,
      'limitations', limitations
    ) AS row_json,
    family_order, peer_group_key, pattern_key,
    family_code, realized_item_count, median_net_profit, median_roi, median_days_on_market, confidence
  FROM pd_all_candidates
),

-- ── family_summary ────────────────────────────────────────────────────────
pd_family_summary_source AS (
  SELECT
    family_code, family_order,
    COUNT(*)                                                                        AS candidate_segment_count,
    SUM(realized_item_count)                                                        AS realized_item_membership_count,
    COUNT(*) FILTER (WHERE median_net_profit IS NOT NULL OR median_roi IS NOT NULL OR median_days_on_market IS NOT NULL) AS eligible_metric_row_count,
    BOOL_OR(confidence IN ('insufficient', 'low'))                                  AS has_sparse_segment
  FROM pd_candidate_segments_ordered
  GROUP BY family_code, family_order
),
pd_distinct_item_counts AS (
  SELECT 'ACQUISITION_VALUE_BAND'::text AS family_code, (SELECT total_realized_item_count FROM pd_population_summary) AS distinct_realized_item_count, NULL::bigint AS null_identity_excluded_count
  UNION ALL SELECT 'CATEGORY', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'TYPE_WITHIN_CATEGORY', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'BRAND_WITHIN_CATEGORY', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'CATEGORY_ACQUISITION_VALUE_BAND', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'TYPE_ACQUISITION_VALUE_BAND', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'ACQUISITION_METHOD', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'EXIT_METHOD', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'ACQUISITION_METHOD_WITHIN_EXIT_METHOD', (SELECT total_realized_item_count FROM pd_population_summary), NULL
  UNION ALL SELECT 'DEAL_IN_CHANNEL', (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NOT NULL), (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NULL)
  UNION ALL SELECT 'DEAL_OUT_CHANNEL', (SELECT COUNT(*) FROM pd_base WHERE deal_out_channel_id IS NOT NULL), (SELECT COUNT(*) FROM pd_base WHERE deal_out_channel_id IS NULL)
  UNION ALL SELECT 'DEAL_IN_TO_DEAL_OUT_JOURNEY', (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL), (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NULL OR deal_out_channel_id IS NULL)
  UNION ALL SELECT 'LISTING_PLATFORM', (SELECT COUNT(DISTINCT item_id) FROM lp_timed WHERE is_realized), NULL
),
pd_family_notes AS (
  SELECT 'ACQUISITION_VALUE_BAND'::text AS family_code, 'Peer group: all acquisition-value bands.' AS notes
  UNION ALL SELECT 'CATEGORY', 'Peer group: all categories.'
  UNION ALL SELECT 'TYPE_WITHIN_CATEGORY', 'Peer group: other types within the same category.'
  UNION ALL SELECT 'BRAND_WITHIN_CATEGORY', 'Peer group: other brands within the same category.'
  UNION ALL SELECT 'CATEGORY_ACQUISITION_VALUE_BAND', 'Peer group: other acquisition-value bands within the same category.'
  UNION ALL SELECT 'TYPE_ACQUISITION_VALUE_BAND', 'Peer group: other acquisition-value bands within the same type.'
  UNION ALL SELECT 'ACQUISITION_METHOD', 'Peer group: other acquisition methods.'
  UNION ALL SELECT 'EXIT_METHOD', 'Peer group: other exit methods.'
  UNION ALL SELECT 'ACQUISITION_METHOD_WITHIN_EXIT_METHOD', 'Peer group: other acquisition methods within the same exit method.'
  UNION ALL SELECT 'DEAL_IN_CHANNEL', 'Peer group: other Deal In channels. Deal In means where the item entered inventory. Null channel identity excluded from candidate rows, reported in coverage_summary.'
  UNION ALL SELECT 'DEAL_OUT_CHANNEL', 'Peer group: other Deal Out channels. Deal Out means where the realized item exited inventory. Null channel identity excluded from candidate rows, reported in coverage_summary.'
  UNION ALL SELECT 'DEAL_IN_TO_DEAL_OUT_JOURNEY', 'Peer group: other complete channel journeys. Requires both channel identities; incomplete journeys reported in coverage_summary.'
  UNION ALL SELECT 'LISTING_PLATFORM', 'Peer group: other listing platforms. Population basis is realized listing exposures, not realized items — a cross-listed item may appear once per eligible platform, so realized_item_membership_count may exceed distinct_realized_item_count.'
),
pd_family_summary_rows AS (
  SELECT
    jsonb_build_object(
      'family_code', s.family_code,
      'candidate_segment_count', s.candidate_segment_count,
      'realized_item_membership_count', s.realized_item_membership_count,
      'distinct_realized_item_count', d.distinct_realized_item_count,
      'eligible_metric_row_count', s.eligible_metric_row_count,
      'null_identity_excluded_count', d.null_identity_excluded_count,
      'notes', n.notes
    ) AS row_json,
    s.family_order, s.has_sparse_segment
  FROM pd_family_summary_source s
  JOIN pd_distinct_item_counts d ON d.family_code = s.family_code
  JOIN pd_family_notes n ON n.family_code = s.family_code
),

-- ── coverage_summary ──────────────────────────────────────────────────────
pd_journey_incomplete AS (
  SELECT COUNT(*) AS incomplete_count FROM pd_base WHERE deal_in_channel_id IS NULL OR deal_out_channel_id IS NULL
),
pd_listing_exposure_per_item AS (
  SELECT inventory_item_id AS item_id, COUNT(DISTINCT deal_channel_id) AS platform_count
  FROM lp_canonical
  GROUP BY inventory_item_id
),
pd_coverage AS (
  SELECT
    (SELECT total_realized_item_count FROM pd_population_summary)                                        AS total_realized_item_count,
    (SELECT COUNT(*) FROM pd_base WHERE net_profit IS NOT NULL)                                           AS profit_available_count,
    (SELECT COUNT(*) FROM pd_base WHERE roi IS NOT NULL)                                                  AS roi_available_count,
    (SELECT COUNT(*) FROM pd_base WHERE valid_dom_days IS NOT NULL)                                       AS global_dom_available_count,
    (SELECT COUNT(*) FROM pd_base WHERE global_days_on_market IS NULL)                                    AS global_dom_missing_count,
    (SELECT COUNT(*) FROM pd_base WHERE is_invalid_dom)                                                   AS global_dom_invalid_count,
    (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NOT NULL)                                   AS deal_in_channel_available_count,
    (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NULL)                                       AS deal_in_channel_missing_count,
    (SELECT COUNT(*) FROM pd_base WHERE deal_out_channel_id IS NOT NULL)                                  AS deal_out_channel_available_count,
    (SELECT COUNT(*) FROM pd_base WHERE deal_out_channel_id IS NULL)                                      AS deal_out_channel_missing_count,
    (SELECT COUNT(*) FROM pd_base WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL) AS complete_channel_journey_available_count,
    (SELECT incomplete_count FROM pd_journey_incomplete)                                                  AS complete_channel_journey_missing_count,
    (SELECT COUNT(*) FROM pd_base b WHERE EXISTS (SELECT 1 FROM pd_listing_exposure_per_item e WHERE e.item_id = b.item_id)) AS listing_platform_exposure_available_count,
    (SELECT COUNT(*) FROM pd_base b WHERE NOT EXISTS (SELECT 1 FROM pd_listing_exposure_per_item e WHERE e.item_id = b.item_id)) AS listing_platform_exposure_missing_count,
    (SELECT COUNT(*) FROM pd_base b WHERE EXISTS (SELECT 1 FROM pd_listing_exposure_per_item e WHERE e.item_id = b.item_id AND e.platform_count > 1)) AS realized_items_exposed_to_multiple_listing_platforms_count,
    (SELECT historical_import_realized_item_count FROM pd_population_summary)                             AS historical_import_realized_item_count,
    (SELECT app_tracked_realized_item_count FROM pd_population_summary)                                   AS app_tracked_realized_item_count
),

-- ── module_limitations ────────────────────────────────────────────────────
pd_limitations AS (
  SELECT ARRAY(
    SELECT code FROM (VALUES
      ('REALIZED_ITEMS_ONLY'),
      ('ASSOCIATION_NOT_CAUSATION'),
      ('CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE'),
      ('HISTORICAL_AND_APP_TRACKED_ITEMS_POOLED'),
      ('CATEGORY_TYPE_AND_BRAND_ARE_CURRENT_ITEM_ATTRIBUTES'),
      ('MULTIPLE_HYPOTHESIS_TESTING_NOT_YET_APPLIED'),
      ('PATTERN_SELECTION_NOT_IMPLEMENTED'),
      ('OPEN_INVENTORY_NOT_ANALYZED'),
      ('PERSONAL_HOLDING_INTENT_NOT_ANALYZED'),
      ('LISTING_PLATFORM_ITEMS_MAY_APPEAR_IN_MULTIPLE_SEGMENTS'),
      (CASE WHEN (SELECT deal_in_channel_missing_count FROM pd_coverage) > 0 THEN 'NULL_DEAL_IN_CHANNEL_REDUCES_COVERAGE' END),
      (CASE WHEN (SELECT deal_out_channel_missing_count FROM pd_coverage) > 0 THEN 'NULL_DEAL_OUT_CHANNEL_REDUCES_COVERAGE' END),
      (CASE WHEN (SELECT complete_channel_journey_missing_count FROM pd_coverage) > 0 THEN 'INCOMPLETE_CHANNEL_JOURNEY_REDUCES_COVERAGE' END),
      (CASE WHEN EXISTS (SELECT 1 FROM pd_family_summary_rows WHERE family_order = 4 AND has_sparse_segment) THEN 'SPARSE_BRAND_SEGMENTS_PRESENT' END),
      (CASE WHEN EXISTS (SELECT 1 FROM pd_family_summary_rows WHERE family_order = 3 AND has_sparse_segment) THEN 'SPARSE_TYPE_SEGMENTS_PRESENT' END)
    ) AS t(code)
    WHERE code IS NOT NULL
  ) AS codes
)

SELECT jsonb_build_object(
  'schema_version', '1.0',
  'population_summary', (SELECT to_jsonb(pd_population_summary) FROM pd_population_summary),
  'candidate_segments', (SELECT COALESCE(jsonb_agg(row_json ORDER BY family_order, peer_group_key, pattern_key), '[]'::jsonb) FROM pd_candidate_segments_ordered),
  'family_summary', (SELECT COALESCE(jsonb_agg(row_json ORDER BY family_order), '[]'::jsonb) FROM pd_family_summary_rows),
  'coverage_summary', (SELECT to_jsonb(pd_coverage) FROM pd_coverage),
  'module_limitations', (SELECT to_jsonb(codes) FROM pd_limitations)
);
$$;

REVOKE ALL ON FUNCTION public._build_pattern_discovery_evidence_v2_13(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_pattern_discovery_evidence_v2_13(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_pattern_discovery_evidence_v2_13(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_pattern_discovery_evidence_v2_13(int) TO service_role;

COMMENT ON FUNCTION public._build_pattern_discovery_evidence_v2_13(int) IS
  'Pattern Discovery Evidence Foundation helper (v2.13) — computes '
  'target_user_pattern_discovery_evidence for one target user. LISTING_'
  'PLATFORM family (13) excludes cancelled item_listings rows from its '
  'canonical exposure date since 20260830000000 (Rule 1) — draft rows '
  'were already excluded structurally (no listed_at). Every other family '
  'and field is unchanged from 20260824000000. SECURITY INVOKER, '
  'service_role execution only, called exclusively by '
  'build_analytics_snapshot_v2_13.';
