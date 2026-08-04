-- build_analytics_snapshot_v2_13
--
-- Analytics v2.13 — Pattern Discovery Evidence Foundation. A narrow,
-- additive follow-up adding a single new target-user aggregate section:
-- target_user_pattern_discovery_evidence. This is EVIDENCE ONLY — SQL
-- calculates factual aggregate candidate segments across 13 curated
-- dimensions; it does NOT rank, compare, select, or recommend anything.
-- A later TypeScript Pattern Discovery Engine will read this evidence and
-- perform leave-one-out peer comparison, effect sizing, and selection —
-- none of that exists yet. Does NOT touch any existing Insights rule, any
-- fixed rule's evidence, or Open Inventory Decision Support. Personal
-- items are included only as REALIZED economic history (like every other
-- Purpose) — no Personal "current holding intent" analysis of any kind
-- exists in this module (that remains personal_inventory_control's job,
-- untouched, for OPEN items only, which this module never reads at all).
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────
-- Every prior v2.x module answers ONE specific question (acquisition
-- bands, category segmentation, deal channels, listing platforms,
-- calendar seasonality, capital/liquidity). None of them expose a
-- UNIFIED, common-shaped dataset spanning multiple candidate dimensions
-- that a future generic pattern-comparison engine could iterate over
-- without dimension-specific code. This migration adds exactly that: one
-- flat array (candidate_segments) where every row — regardless of which
-- of the 13 families it belongs to — has the identical field set, so a
-- future TypeScript engine can treat "compare a segment's median_net_
-- profit/median_roi/median_days_on_market against its peer group" as one
-- generic operation instead of 13 bespoke ones.
--
-- ── SOURCE ────────────────────────────────────────────────────────────
-- public.analytics_item_lifecycle_v2, user_id = p_target_user_id AND
-- is_realized = true — the exact same base view every v2.1+ module reads,
-- filtered to REALIZED items only (see "REALIZED_ITEMS_ONLY" limitation).
-- No raw table is queried directly except item_listings/deal_channels for
-- the LISTING_PLATFORM family's canonical exposure join (families 1-12
-- need no join beyond the base view — deal_in_channel_id/_name,
-- deal_out_channel_id/_name, acquisition_method, and global_days_on_market
-- are all already-computed columns on analytics_item_lifecycle_v2 as of
-- 20260731000000/20260802000000/20260724000000 — this migration re-
-- derives nothing that already exists there).
--
-- ── NET PROFIT / ROI / DOM — REUSED VERBATIM, NO NEW THRESHOLD ─────────
-- net_profit, roi, and global_days_on_market are read directly from
-- analytics_item_lifecycle_v2's own columns (exit_value - acquisition_
-- value - item_expenses_total; (net_profit / acquisition_value) * 100
-- when acquisition_value > 0; exit_date - first_listed_at) — this
-- migration computes none of these itself, only aggregates them.
-- DOM validity: global_days_on_market IS NULL means "never listed"
-- (counted as missing_dom_count); a NEGATIVE value (first_listed_at
-- after exit_date — the has_listing_after_exit case) is EXCLUDED from
-- dom_sample_size / median_days_on_market and counted under
-- invalid_dom_count instead; a value of exactly 0 is a VALID sample
-- entry (same-day listing and exit). dom_sample_size + invalid_dom_count
-- + missing_dom_count = realized_item_count for every family except
-- LISTING_PLATFORM, whose denominator is realized EXPOSURES, not items
-- (see below).
--
-- ── ACQUISITION-VALUE BAND / EXIT-METHOD DERIVATION — REUSED VERBATIM ──
-- The acquisition_value_status/_band_order/_band_label CASE expression
-- and the `CASE WHEN exit_type IN ('sale','trade') THEN exit_type ELSE
-- 'unknown' END` exit_method expression are copied verbatim from
-- 20260816000000_build_analytics_snapshot_v2_5.sql's own `all_items` CTE
-- (the same expression v2.5/v2.7 already established) — no new threshold
-- is invented. acquisition_method needs no re-derivation at all:
-- analytics_item_lifecycle_v2.acquisition_method is ALREADY normalized to
-- exactly 'purchase' / 'trade' / 'unknown' (see 20260724000000_
-- historical_deal_type_labels.sql, which maps deal_type IN ('purchase',
-- 'Historical Purchase') -> 'purchase', IN ('trade', 'Historical Trade')
-- -> 'trade', 'Historical Import' -> 'unknown') — Historical Purchase and
-- Historical Trade therefore already map correctly with zero extra logic
-- here.
--
-- ── LISTING_PLATFORM — REUSES v2.11's CANONICALIZATION VERBATIM ────────
-- Same rule as v2.6/v2.11 (is_listing_platform = true, listed_at IS NOT
-- NULL, MIN(listed_at) per (item, channel) — a v2.x migration's CTEs
-- cannot be referenced from a different function, so the identical
-- expression is reproduced here rather than approximated, exactly as
-- v2.11 itself did relative to v2.6). One item x listing-platform row —
-- a cross-listed realized item legitimately appears once per eligible
-- platform (LISTING_PLATFORM_ITEMS_MAY_APPEAR_IN_MULTIPLE_SEGMENTS).
-- Population basis is REALIZED_LISTING_EXPOSURES, not REALIZED_ITEMS:
-- realized_item_count on a LISTING_PLATFORM row means realized items
-- EXPOSED to that platform (may double-count a cross-listed item across
-- rows); distinct_exit_deal_count remains distinct exit deals within that
-- platform's exposure set. DOM here is platform-specific listing-to-exit
-- duration (exit_date - canonical_channel_listed_at, same-day valid,
-- listed-after-exit invalid/excluded/counted) — NEVER global_days_on_
-- market. Association, not causal platform attribution — no buyer
-- inference of any kind.
--
-- ── CONFIDENCE — REUSED VERBATIM, ONE CONVENTION FOUND ──────────────────
-- Every confidence-bearing CTE across every v2.x migration inspected
-- (economic_cohort, liquidity_cohort, deal_in/deal_out/listing-channel
-- performance rows, acquisition-band rows) uses the SAME four-tier
-- boundary on a realized/relevant-sample COUNT: <=2 'insufficient', <=5
-- 'low', <=9 'moderate', else 'stronger' — confirmed explicitly by
-- 20260816000000_build_analytics_snapshot_v2_5.sql's own header comment:
-- "Confidence is tiered from the row's own item count (1-2 insufficient,
-- 3-5 low, 6-9 moderate, 10+ stronger), the single-tier convention 04/05/
-- 06 already use." This migration reuses that exact boundary set, based
-- on each segment's own realized_item_count (or realized-exposure count
-- for LISTING_PLATFORM) — never total row count, never a new scale.
--
-- ── PATTERN_KEY / PEER_GROUP_KEY ─────────────────────────────────────────
-- pattern_key encodes every stable identifier the segment's own identity
-- needs (never a display label alone when a stable id exists — e.g.
-- CATEGORY|category_id=1, not CATEGORY|Guitars). peer_group_key +
-- comparison_scope encode exactly what a future leave-one-out comparison
-- needs to find this segment's peers (e.g. family=TYPE_WITHIN_CATEGORY|
-- category_id=1 — every other type within category 1). No peer baseline,
-- no effect size, and no strong/weak label is computed in this task.
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- target_user_pattern_discovery_evidence is target-user-scoped aggregate
-- evidence only (WHERE user_id = p_target_user_id, like every other
-- target_user_* section) — never added to a shared-population section.
-- No item_id, user_id, item name, model, notes, serial number,
-- counterparty, listing text, photo/storage path, or array of source IDs
-- appears anywhere in candidate_segments, family_summary, coverage_
-- summary, or module_limitations — only aggregate ids/names/counts/
-- medians/confidence/coverage.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_pattern_discovery_evidence_v2_13(int)  -- NEW
--   public.build_analytics_snapshot_v2_13(int)             -- NEW
--
-- See analytics/sql/28_pattern_discovery_evidence_v2_13.sql for a
-- standalone, illustrative copy of one family's query shape.
-- ============================================================================

-- ── PART 1: focused helper — computes target_user_pattern_discovery_
-- evidence for one target user only ──────────────────────────────────────

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
-- Reused verbatim: acquisition_value_status/_band_order/_band_label and
-- exit_method from 20260816000000_build_analytics_snapshot_v2_5.sql's
-- own `all_items` CTE. valid_dom_days / is_invalid_dom implement this
-- migration's own explicit DOM validity policy (negative excluded and
-- counted invalid; zero valid; NULL = never listed = missing).
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
-- Canonicalization reused verbatim from v2.11 (see this migration's
-- header). Built off ALL target-user items (open + realized), then
-- restricted to realized exposures in the aggregate below — a platform
-- with zero realized exposure never produces a candidate row (HAVING).
lp_base_all AS (
  SELECT * FROM public.analytics_item_lifecycle_v2 WHERE user_id = p_target_user_id
),
lp_eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN lp_base_all ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
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

-- ── PART 2: builder — wraps v2.12 wholesale, adds one new top-level key ──

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_13(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH v212 AS MATERIALIZED (
  SELECT public.build_analytics_snapshot_v2_12(p_target_user_id) AS snapshot
),
pattern_discovery AS MATERIALIZED (
  SELECT public._build_pattern_discovery_evidence_v2_13(p_target_user_id) AS evidence
)
SELECT
  v212.snapshot
  || jsonb_build_object(
       'snapshot_schema_version', '2.13',
       'analytics_definition_version', '2.13',
       'generated_at', to_jsonb(now())
     )
  || jsonb_build_object(
       'target_user_pattern_discovery_evidence', (SELECT evidence FROM pattern_discovery)
     )
FROM v212;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_13(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_13(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_13(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_13(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_13(int) IS
  'Pattern Discovery Evidence Foundation — adds target_user_pattern_'
  'discovery_evidence (schema_version, population_summary, '
  'candidate_segments[13 families], family_summary, coverage_summary, '
  'module_limitations). Evidence only — no pattern selection, ranking, '
  'peer baseline, effect size, or recommendation. SECURITY INVOKER, '
  'service_role execution only. Wraps build_analytics_snapshot_v2_12 '
  'wholesale — v2.12 and every version before it remain independently '
  'callable and unchanged. See this migration''s own header for the full '
  'v2.13 contract.';
