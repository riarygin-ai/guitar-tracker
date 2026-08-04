-- ============================================================================
-- 28_pattern_discovery_evidence_v2_13.sql
--
-- Analytics v2.13 — Pattern Discovery Evidence Foundation. See public.
-- _build_pattern_discovery_evidence_v2_13() and public.
-- build_analytics_snapshot_v2_13() (supabase/migrations/
-- 20260824000000_build_analytics_snapshot_v2_13.sql) for the actual
-- production functions and the full, authoritative logic for all 13
-- families; nothing in this file creates a database object. This file
-- illustrates ONE representative family (CATEGORY) standalone, target-
-- user scope only, for readability alongside this directory's other
-- numbered reference queries.
--
-- ── THE GAP THIS FILLS ────────────────────────────────────────────────────
-- Every prior v2.x module answers one specific question. This adds a
-- UNIFIED candidate-segment dataset — one common row shape reused across
-- 13 curated dimensions (acquisition-value band, category, type-within-
-- category, brand-within-category, category x band, type x band,
-- acquisition method, exit method, acquisition-within-exit method, Deal
-- In channel, Deal Out channel, Deal In -> Deal Out journey, listing
-- platform) — so a future TypeScript Pattern Discovery Engine can compare
-- ANY segment against its peer group generically, instead of writing
-- dimension-specific comparison code 13 times. This migration computes
-- ONLY the evidence — no ranking, no peer baseline, no effect size, no
-- selection, no recommendation.
--
-- ── QUERY CLASSIFICATION INDEX ────────────────────────────────────────────
-- Query A is TARGET-USER AGGREGATE EVIDENCE (one row per category, no
-- item-level row) — the same classification as every candidate_segments
-- row regardless of family.
--
-- Query A — CATEGORY family, target-user scope, illustrative:

WITH pd_base AS (
  SELECT *
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = :target_user_id AND is_realized = true
)
SELECT
  'CATEGORY'                                                                      AS family_code,
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
  -- DOM validity: negative (listed after exit) excluded and counted
  -- invalid; zero valid; NULL (never listed) counted missing.
  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL AND global_days_on_market >= 0) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE net_profit IS NOT NULL)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2)               AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL AND global_days_on_market >= 0)::numeric, 2) AS median_days_on_market,
  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL AND global_days_on_market < 0) AS invalid_dom_count,
  COUNT(*) FILTER (WHERE global_days_on_market IS NULL)                           AS missing_dom_count,
  COUNT(*) FILTER (WHERE is_historical_import)                                    AS historical_import_item_count,
  COUNT(*) FILTER (WHERE NOT is_historical_import)                                AS app_tracked_item_count,
  ROUND(COUNT(*) FILTER (WHERE is_historical_import)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS historical_import_percent,
  -- Confidence — reused verbatim from every other v2.x confidence-bearing
  -- CTE (see 20260816000000_build_analytics_snapshot_v2_5.sql's own
  -- header): tiered from the segment's own realized_item_count, never
  -- total row count, never a new scale.
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END                                                                             AS confidence
FROM pd_base
GROUP BY category_id, category_name
ORDER BY category_name NULLS LAST;

-- Every other family (ACQUISITION_VALUE_BAND, TYPE_WITHIN_CATEGORY,
-- BRAND_WITHIN_CATEGORY, CATEGORY_ACQUISITION_VALUE_BAND, TYPE_
-- ACQUISITION_VALUE_BAND, ACQUISITION_METHOD, EXIT_METHOD, ACQUISITION_
-- METHOD_WITHIN_EXIT_METHOD, DEAL_IN_CHANNEL, DEAL_OUT_CHANNEL, DEAL_IN_
-- TO_DEAL_OUT_JOURNEY, LISTING_PLATFORM) follows this exact same row
-- shape with a different GROUP BY / pattern_key / peer_group_key —
-- LISTING_PLATFORM additionally reuses v2.11's canonical per-platform
-- listing-to-exit timing (see 26_per_platform_listing_to_exit_timing_
-- v2_11.sql) in place of global_days_on_market — see the production
-- migration for the full, authoritative set.
