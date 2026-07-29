-- build_analytics_snapshot_v1_8
--
-- Open Inventory Decision Support v1. Adds a NEW versioned snapshot builder
-- alongside (never replacing) v1.0-v1.7. All prior functions and every
-- previously stored v1.0-v1.7 analytics_runs.snapshot row remain unchanged
-- and fully readable — this migration only ADDS new objects.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One new private helper, one new lightweight top-level wrapper:
--   public._build_open_inventory_decision_support_snapshot_v1(int) -- NEW
--   public.build_analytics_snapshot_v1_8(int)                       -- NEW
-- v1.8's top-level wrapper calls public.build_analytics_snapshot_v1_7(int)
-- WHOLESALE, preserves its evidence_aggregates and recommendation_
-- candidates UNCHANGED, and adds a NEW TOP-LEVEL KEY —
-- target_user_evidence.open_inventory_decision_support — that does NOT
-- live inside evidence_aggregates. This is the first module in this
-- analytics layer to expose item-level identity (item_id, brand, category,
-- type, model) in a snapshot; it is safe ONLY because every row is
-- filtered to the caller's own recommendation_target_user_id, exactly like
-- recommendation_candidates.open_business_items already does — see the
-- PRIVACY section below.
--
-- ── PART 1: _build_open_inventory_decision_support_snapshot_v1(int) ─────
-- Reproduces analytics/sql/10_open_inventory_decision_support.sql.
-- Included sections mapped to stable JSON keys:
--   Query A -> population_summary          (target-user-only aggregate)
--   Query B -> item_decision_evidence       (target-user-only, item-level)
--   Query C -> within_brand_comparison      (target-user-only aggregate)
-- Plus two module-level fields: listing_state_basis, module_limitations.
--
-- ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────
-- No score, priority_score, recommended_action, sell/keep/reprice
-- decision, or AI-generated prose is produced anywhere in this function.
-- reason_codes is a deterministic array of evidence FLAGS — never counted,
-- weighted, or combined into a single number. See the interpretation
-- safeguards in analytics/sql/10_open_inventory_decision_support.sql and
-- analytics/SEMANTIC_CONTRACT.md section 21.
--
-- ── MODEL FIELD DECISION ─────────────────────────────────────────────────
-- inventory_items.model is a free-text field with no normalization table
-- (no "models" lookup, no canonicalization) — two items could be the "same
-- model" under different spelling/capitalization/abbreviation with no way
-- to detect that reliably. This function therefore SKIPS the "exact model"
-- comparable-cohort level entirely (task's hierarchy level 1) and starts
-- the cohort hierarchy at "brand + type + acquisition value band" instead.
-- `model` IS still exposed as a plain DISPLAY field on each item_decision_
-- evidence row (it is a real, existing column, just not reliable as an
-- equality-matching cohort key) — every item row also carries the
-- MODEL_COHORT_UNAVAILABLE limitation code documenting this decision.
--
-- ── COMPARABLE COHORT SELECTION — SPECIFICITY HIERARCHY ──────────────────
-- For each target item, up to 7 candidate cohorts are computed from the
-- POOLED (all-users) shared Business population:
--   2. brand + type + acquisition value band  (only if item's own
--      acquisition value is positive — band-restricted levels never
--      apply to a zero/unknown/negative item, matching every other band
--      section in this analytics layer)
--   3. brand + acquisition value band          (positive only)
--   4. brand                                    (unrestricted)
--   5. category + acquisition value band        (positive only)
--   6. category                                  (unrestricted)
--   7. acquisition value band                    (positive only)
--   8. all Business items                        (unrestricted)
-- Selection rule (implemented as a single ORDER BY + LIMIT 1 per item):
--   1. Prefer ANY candidate with realized_item_count >= 5, breaking ties
--      by specificity (most specific first) — i.e. search the hierarchy
--      in order for a >=5 cohort and take the first one found.
--   2. Else prefer ANY candidate with realized_item_count >= 3, same
--      specificity tie-break.
--   3. Else prefer the MOST SPECIFIC candidate with realized_item_count
--      >= 1.
--   4. Else (no candidate anywhere has even 1 realized item): no cohort —
--      comparable_cohort is NULL, comparable_evidence_available = false.
-- A cohort's own `confidence` label (insufficient/low/moderate/stronger)
-- is computed from ITS OWN realized_item_count using this analytics
-- layer's standard 4-tier thresholds — independent of which hierarchy
-- pass found it (a cohort located via the ">=5" search can still end up
-- labeled 'low' if its exact realized_item_count is, say, 5 — 3-5 is
-- 'low' under the standard thresholds).
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- item_decision_evidence and within_brand_comparison are filtered to
-- `user_id = p_target_user_id` — IDENTICAL to
-- _build_recommendation_candidates_snapshot_v1_1's own filter pattern.
-- Comparable-cohort STATISTICS may pool every user's Business items (the
-- SAME shared-evidence population every other module already reads), but
-- no other user's item_id, item name, model, or any other item-identity
-- field is ever exposed — cohorts return only counts/medians/percentages/
-- confidence labels, nothing per-item.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_open_inventory_decision_support_snapshot_v1(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH shared_business AS (
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
  WHERE purpose_name = 'Business'
),

-- ── Cohort level stats (pooled across every user) ────────────────────────
level_brand_type_band AS (
  SELECT
    brand_id, type_id, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
  WHERE acquisition_value_status = 'positive'
  GROUP BY brand_id, type_id, acquisition_value_band_order, acquisition_value_band_label
),
level_brand_band AS (
  SELECT
    brand_id, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
  WHERE acquisition_value_status = 'positive'
  GROUP BY brand_id, acquisition_value_band_order, acquisition_value_band_label
),
level_brand AS (
  SELECT
    brand_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
  GROUP BY brand_id
),
level_category_band AS (
  SELECT
    category_id, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
  WHERE acquisition_value_status = 'positive'
  GROUP BY category_id, acquisition_value_band_order, acquisition_value_band_label
),
level_category AS (
  SELECT
    category_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
  GROUP BY category_id
),
level_band AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
  WHERE acquisition_value_status = 'positive'
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
level_all AS (
  SELECT
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM shared_business
),

-- ── Target user's own open Business items ────────────────────────────────
target_items AS (
  SELECT * FROM shared_business
  WHERE user_id = p_target_user_id AND NOT is_realized
),
target_open_capital AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM target_items
),

-- ── Comparable-cohort selection per target item (LATERAL JOIN) ──────────
target_with_cohort AS (
  SELECT
    ti.*,
    cohort.cohort_scope,
    cohort.cohort_key,
    cohort.cohort_item_count,
    cohort.realized_item_count      AS cohort_realized_item_count,
    cohort.open_item_count          AS cohort_open_item_count,
    cohort.realization_rate_percent AS cohort_realization_rate_percent,
    cohort.median_net_profit        AS cohort_median_net_profit,
    cohort.median_roi                AS cohort_median_roi,
    cohort.dom_sample_size            AS cohort_dom_sample_size,
    cohort.median_days_on_market      AS cohort_median_days_on_market,
    cohort.p75_days_on_market          AS cohort_p75_days_on_market,
    cohort.holding_sample_size          AS cohort_holding_sample_size,
    cohort.median_holding_days          AS cohort_median_holding_days,
    cohort.confidence                    AS cohort_confidence
  FROM target_items ti
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT
        'brand_type_band' AS cohort_scope, 2 AS specificity_order,
        ('brand_id=' || l.brand_id || ',type_id=' || l.type_id || ',band=' || l.acquisition_value_band_label) AS cohort_key,
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_brand_type_band l
      WHERE ti.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM ti.brand_id
        AND l.type_id IS NOT DISTINCT FROM ti.type_id
        AND l.acquisition_value_band_order = ti.acquisition_value_band_order

      UNION ALL
      SELECT
        'brand_band', 3,
        ('brand_id=' || l.brand_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_brand_band l
      WHERE ti.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM ti.brand_id
        AND l.acquisition_value_band_order = ti.acquisition_value_band_order

      UNION ALL
      SELECT
        'brand', 4,
        ('brand_id=' || l.brand_id),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_brand l
      WHERE l.brand_id IS NOT DISTINCT FROM ti.brand_id

      UNION ALL
      SELECT
        'category_band', 5,
        ('category_id=' || l.category_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_category_band l
      WHERE ti.acquisition_value_status = 'positive'
        AND l.category_id IS NOT DISTINCT FROM ti.category_id
        AND l.acquisition_value_band_order = ti.acquisition_value_band_order

      UNION ALL
      SELECT
        'category', 6,
        ('category_id=' || l.category_id),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_category l
      WHERE l.category_id IS NOT DISTINCT FROM ti.category_id

      UNION ALL
      SELECT
        'acquisition_value_band', 7,
        ('band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_band l
      WHERE ti.acquisition_value_status = 'positive'
        AND l.acquisition_value_band_order = ti.acquisition_value_band_order

      UNION ALL
      SELECT
        'all_business', 8, 'all_business',
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent,
        l.median_net_profit, l.median_roi, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market,
        l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_all l
    ) candidates
    WHERE realized_item_count >= 1
    ORDER BY
      (CASE WHEN realized_item_count >= 5 THEN 0 ELSE 1 END),
      (CASE WHEN realized_item_count >= 3 THEN 0 ELSE 1 END),
      specificity_order ASC
    LIMIT 1
  ) cohort ON true
),
target_with_rank AS (
  SELECT
    twc.*,
    RANK() OVER (ORDER BY acquisition_value DESC NULLS LAST) AS acquisition_value_rank
  FROM target_with_cohort twc
),
target_facts AS (
  SELECT
    twr.*,
    (first_listed_at IS NOT NULL) AS listed_flag,
    CASE WHEN NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue
         THEN holding_days ELSE NULL END AS ownership_age_days,
    CASE WHEN first_listed_at IS NULL THEN NULL ELSE global_days_on_market END AS current_dom_days,
    CASE WHEN estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL
         THEN estimated_sold_value - acquisition_value - item_expenses_total END AS estimated_net_upside,
    CASE WHEN acquisition_value_status = 'positive'
         THEN ROUND(acquisition_value::numeric / NULLIF((SELECT amount FROM target_open_capital), 0) * 100, 2) END AS open_capital_share_percent
  FROM target_with_rank twr
),
target_facts2 AS (
  SELECT
    tf.*,
    CASE WHEN acquisition_value_status = 'positive' AND estimated_sold_value IS NOT NULL
         THEN ROUND(estimated_net_upside::numeric / NULLIF(acquisition_value, 0) * 100, 2) END AS estimated_upside_percent
  FROM target_facts tf
),

-- Query A -> population_summary
a_row AS (
  SELECT
    COUNT(*)                                                                       AS open_business_item_count,
    COUNT(*) FILTER (WHERE listed_flag)                                            AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT listed_flag)                                        AS unlisted_open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_net_upside)                                                      AS estimated_net_upside,
    COUNT(*) FILTER (WHERE ownership_age_days IS NOT NULL)                         AS reliable_ownership_age_item_count,
    COUNT(*) FILTER (WHERE ownership_age_days IS NULL)                             AS unreliable_ownership_age_item_count,
    COUNT(*) FILTER (WHERE cohort_confidence IN ('moderate', 'stronger'))          AS sufficient_comparable_cohort_item_count,
    COUNT(*) FILTER (WHERE cohort_confidence IN ('insufficient', 'low'))           AS low_confidence_comparable_cohort_item_count,
    COUNT(*) FILTER (WHERE cohort_scope IS NULL)                                   AS no_comparable_cohort_item_count
  FROM target_facts2
),

-- Query B -> item_decision_evidence
b_rows AS (
  SELECT
    item_id,
    item_display_name,
    brand_id,
    brand_name,
    category_id,
    category_name,
    type_id,
    type_name,
    model,
    acquisition_method,
    acquisition_value,
    acquisition_value_band_order,
    acquisition_value_band_label,
    estimated_sold_value,
    estimated_net_upside,
    estimated_upside_percent,
    is_historical_import,
    ownership_age_days,
    listed_flag,
    'open_item_with_listing_record'                                                AS listing_state_basis,
    ( (CASE WHEN marketplace_listed_at IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN kijiji_listed_at      IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN reverb_listed_at      IS NOT NULL THEN 1 ELSE 0 END) )             AS listing_channel_count,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN marketplace_listed_at IS NOT NULL THEN 'Marketplace' END,
      CASE WHEN kijiji_listed_at      IS NOT NULL THEN 'Kijiji' END,
      CASE WHEN reverb_listed_at      IS NOT NULL THEN 'Reverb' END
    ], NULL)                                                                       AS listing_channel_names,
    first_listed_at,
    current_dom_days,
    open_capital_share_percent,
    CASE WHEN cohort_scope IS NOT NULL THEN jsonb_build_object(
      'cohort_scope', cohort_scope,
      'cohort_key', cohort_key,
      'cohort_item_count', cohort_item_count,
      'realized_item_count', cohort_realized_item_count,
      'open_item_count', cohort_open_item_count,
      'realization_rate_percent', cohort_realization_rate_percent,
      'median_net_profit', cohort_median_net_profit,
      'median_roi', cohort_median_roi,
      'dom_sample_size', cohort_dom_sample_size,
      'median_days_on_market', cohort_median_days_on_market,
      'p75_days_on_market', cohort_p75_days_on_market,
      'holding_sample_size', cohort_holding_sample_size,
      'median_holding_days', cohort_median_holding_days,
      'confidence', cohort_confidence
    ) ELSE NULL END                                                                AS comparable_cohort,
    CASE WHEN current_dom_days IS NOT NULL AND cohort_median_days_on_market IS NOT NULL
         THEN (current_dom_days - cohort_median_days_on_market) END                AS current_dom_minus_cohort_median_days,
    CASE WHEN current_dom_days IS NOT NULL AND cohort_p75_days_on_market IS NOT NULL
         THEN (current_dom_days > cohort_p75_days_on_market) END                   AS current_dom_above_cohort_p75,
    CASE WHEN estimated_net_upside IS NOT NULL AND cohort_median_net_profit IS NOT NULL
         THEN (estimated_net_upside - cohort_median_net_profit) END                 AS estimated_upside_minus_cohort_median_profit,
    CASE WHEN estimated_upside_percent IS NOT NULL AND cohort_median_roi IS NOT NULL
         THEN (estimated_upside_percent - cohort_median_roi) END                   AS estimated_upside_percent_minus_cohort_median_roi,
    (cohort_scope IS NOT NULL)                                                     AS comparable_evidence_available,
    ARRAY(
      SELECT code FROM (VALUES
        (CASE WHEN NOT listed_flag THEN 'UNLISTED_OPEN_ITEM' END),
        (CASE WHEN listed_flag AND current_dom_days IS NOT NULL AND cohort_median_days_on_market IS NOT NULL
                AND current_dom_days > cohort_median_days_on_market THEN 'DOM_ABOVE_COMPARABLE_MEDIAN' END),
        (CASE WHEN listed_flag AND current_dom_days IS NOT NULL AND cohort_p75_days_on_market IS NOT NULL
                AND current_dom_days > cohort_p75_days_on_market THEN 'DOM_ABOVE_COMPARABLE_P75' END),
        (CASE WHEN ownership_age_days IS NOT NULL AND ownership_age_days >= 120 THEN 'OWNERSHIP_AGE_120_PLUS' END),
        (CASE WHEN acquisition_value_status = 'positive'
                AND (acquisition_value_rank <= 3 OR open_capital_share_percent >= 10)
              THEN 'HIGH_CAPITAL_EXPOSURE' END),
        (CASE WHEN acquisition_value_status = 'positive' AND estimated_sold_value IS NOT NULL
                AND estimated_net_upside >= 0 AND estimated_upside_percent < 15
              THEN 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL' END),
        (CASE WHEN estimated_net_upside IS NOT NULL AND estimated_net_upside < 0 THEN 'NEGATIVE_ESTIMATED_UPSIDE' END),
        (CASE WHEN cohort_scope IS NOT NULL AND cohort_confidence IN ('insufficient', 'low') THEN 'LOW_COMPARABLE_CONFIDENCE' END),
        (CASE WHEN cohort_scope IS NULL THEN 'NO_COMPARABLE_EVIDENCE' END),
        (CASE WHEN is_historical_import THEN 'HISTORICAL_AGE_UNRELIABLE' END),
        (CASE WHEN acquisition_value_status = 'zero_assigned' THEN 'ZERO_ASSIGNED_ACQUISITION_VALUE' END),
        (CASE WHEN acquisition_value_status = 'unknown' THEN 'UNKNOWN_ACQUISITION_VALUE' END),
        (CASE WHEN estimated_sold_value IS NULL THEN 'ESTIMATED_VALUE_MISSING' END)
      ) AS t(code)
      WHERE code IS NOT NULL
    )                                                                               AS reason_codes,
    ARRAY(
      SELECT code FROM (VALUES
        ('LISTING_ACTIVE_STATE_INFERRED'),
        (CASE WHEN is_historical_import THEN 'MARKETPLACE_KIJIJI_HISTORICAL_LISTING_EXPOSURE_MAY_BE_INCOMPLETE' END),
        (CASE WHEN is_historical_import THEN 'HISTORICAL_ACQUISITION_DATE_UNRELIABLE' END),
        (CASE WHEN cohort_scope IS NOT NULL AND cohort_confidence IN ('insufficient', 'low') THEN 'COMPARABLE_SAMPLE_SMALL' END),
        (CASE WHEN estimated_sold_value IS NOT NULL THEN 'ESTIMATED_VALUE_IS_USER_ESTIMATE' END),
        (CASE WHEN acquisition_value_status = 'zero_assigned' THEN 'ZERO_ACQUISITION_VALUE_LIMITS_ROI_COMPARISON' END),
        ('MODEL_COHORT_UNAVAILABLE')
      ) AS t(code)
      WHERE code IS NOT NULL
    )                                                                               AS limitations
  FROM target_facts2
),

-- Query C -> within_brand_comparison
c_rows AS (
  SELECT
    brand_id,
    brand_name,
    COUNT(*)                                                                       AS open_item_count,
    COUNT(*) FILTER (WHERE listed_flag)                                            AS listed_item_count,
    COUNT(*) FILTER (WHERE NOT listed_flag)                                        AS unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(
      SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
        / NULLIF((SELECT amount FROM target_open_capital), 0) * 100,
      2
    )                                                                               AS open_capital_percent,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    SUM(estimated_net_upside)                                                      AS estimated_net_upside,
    COUNT(*) FILTER (WHERE ownership_age_days IS NOT NULL)                         AS reliable_ownership_age_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ownership_age_days) FILTER (WHERE ownership_age_days IS NOT NULL)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE ownership_age_days >= 60)                               AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE ownership_age_days >= 120)                              AS items_ownership_age_120_plus,
    MAX(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS largest_item_acquisition_value,
    ROUND(
      MAX(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
        / NULLIF(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL), 0) * 100,
      2
    )                                                                               AS largest_item_share_of_brand_capital_percent
  FROM target_facts2
  GROUP BY brand_id, brand_name
)

SELECT jsonb_build_object(
  'listing_state_basis', 'open_item_with_listing_record',
  'module_limitations', jsonb_build_array(
    'LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD',
    'MODEL_COHORT_UNAVAILABLE_FREE_TEXT_MODEL_FIELD'
  ),
  'population_summary',       (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  -- Ordering: (1) positive acquisition value descending — band_order NOT IN
  -- (0, 8, -1) is a proxy for acquisition_value_status = 'positive' (0 =
  -- zero_assigned, 8 = unknown, -1 = negative_invalid, 1-6 = the six
  -- positive bands) using only a column already exposed on this row, so no
  -- extra internal-only column has to be added to b_rows just to sort by
  -- it; (2) reliable ownership age descending; (3) item_id — a fully
  -- transparent, non-hidden ordering, per the task's explicit requirement.
  'item_decision_evidence',   (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY
                                  (CASE WHEN acquisition_value_band_order NOT IN (0, 8, -1) THEN acquisition_value ELSE NULL END) DESC NULLS LAST,
                                  COALESCE(ownership_age_days, -1) DESC,
                                  item_id ASC
                                ), '[]'::jsonb) FROM b_rows),
  'within_brand_comparison',  (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY brand_name NULLS LAST), '[]'::jsonb) FROM c_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_open_inventory_decision_support_snapshot_v1(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_open_inventory_decision_support_snapshot_v1(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_open_inventory_decision_support_snapshot_v1(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_open_inventory_decision_support_snapshot_v1(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v1_8(p_recommendation_target_user_id int)
-- Lightweight top-level wrapper — calls public.build_analytics_snapshot_v1_7
-- WHOLESALE (v1.7 already validates p_recommendation_target_user_id and
-- assembles evidence_aggregates/recommendation_candidates; none of that is
-- duplicated here) and adds ONE new top-level key,
-- target_user_evidence.open_inventory_decision_support, WITHOUT touching
-- evidence_aggregates or recommendation_candidates at all.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1_8(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v17          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  -- v1.7 already validates p_recommendation_target_user_id (NULL check and
  -- app_users existence check, inherited from v1.2) and RAISEs on failure —
  -- no need to repeat that validation here.
  v_v17 := public.build_analytics_snapshot_v1_7(p_recommendation_target_user_id);

  RETURN v_v17
    || jsonb_build_object(
         'snapshot_schema_version', '1.8',
         'analytics_definition_version', '1.8',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'target_user_evidence', jsonb_build_object(
           'open_inventory_decision_support',
           public._build_open_inventory_decision_support_snapshot_v1(p_recommendation_target_user_id)
         )
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_8(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_8(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1_8(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1_8(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1_8(int) IS
  'Open Inventory Decision Support v1. SECURITY INVOKER, service_role '
  'execution only. Lightweight wrapper: calls build_analytics_snapshot_v1_7'
  '(int) wholesale (evidence_aggregates and recommendation_candidates are '
  'preserved UNCHANGED) and adds a NEW top-level key, target_user_evidence.'
  'open_inventory_decision_support — item-level evidence restricted to the '
  'target user''s own open Business items. No score, priority_score, '
  'recommended_action, or AI-generated prose is produced. Persists '
  'nothing — see analytics_runs (20260727000000) for the persistence '
  'step. See analytics/README.md and analytics/SEMANTIC_CONTRACT.md for '
  'the full v1.8 contract.';
