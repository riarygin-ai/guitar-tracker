-- build_analytics_snapshot_v1
--
-- Phase 2 Step 2 of the analytics autorunner plan: a single controlled
-- database function that computes the three reusable analytics modules
-- (analytics/sql/01_acquisition_value_band_performance.sql,
-- analytics/sql/02_acquisition_to_exit_analysis.sql,
-- analytics/sql/03_brand_performance.sql) plus one target user's open
-- Business item candidates, and returns one stable JSONB snapshot.
--
-- This migration PERSISTS NOTHING. No table, view, or materialized view is
-- created. No row in analytics_runs is created or updated here — Phase 2
-- Step 3 will call this function and store its return value. No API route,
-- frontend UI, scheduled job, or AI interpretation exists yet.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
-- One top-level callable function:
--   public.build_analytics_snapshot_v1(p_recommendation_target_user_id int)
--     RETURNS jsonb
-- backed by four private helpers, one per analytical module, each also
-- versioned _v1 and each with client execution revoked (see GRANTS below —
-- none of these five functions are meant to be called directly by an
-- ordinary authenticated app session):
--   public._build_acquisition_value_band_snapshot_v1()
--   public._build_acquisition_to_exit_snapshot_v1()
--   public._build_brand_snapshot_v1()
--   public._build_recommendation_candidates_snapshot_v1(p_recommendation_target_user_id int)
--
-- ── SECURITY MODEL ───────────────────────────────────────────────────────
-- Every function here is SECURITY INVOKER (never SECURITY DEFINER) and
-- never calls auth.uid() or public.get_app_user_id(). The recommendation
-- target is always an explicit int argument — app_users.id, validated
-- against public.app_users before use, never inferred from the calling
-- session. The intended caller is the future server-side autorunner running
-- with the service_role database context, which is what makes the shared
-- evidence aggregates below possible: service_role bypasses ordinary RLS,
-- so SECURITY INVOKER here means "run with whatever access the CALLER
-- already has" — for service_role, that is every row in
-- analytics_item_lifecycle; for an ordinary authenticated session it would
-- only be that session's own rows (RLS-scoped), which is exactly why EXECUTE
-- is revoked from authenticated/anon/PUBLIC below — this function is not
-- designed to be safely callable by an ordinary user in the first place
-- (an authenticated caller would get an evidence snapshot computed only
-- over their OWN rows, silently wrong/misleading, rather than a real error).
--
-- ── EVIDENCE VS. RECOMMENDATION SCOPE (see analytics/SEMANTIC_CONTRACT.md
-- sections 9-11) ─────────────────────────────────────────────────────────
-- evidence_aggregates draws from ALL eligible shared Business rows visible
-- to the executing role (the controlled service-role context) — never
-- filtered to p_recommendation_target_user_id. recommendation_candidates
-- draws ONLY from p_recommendation_target_user_id's own open Business
-- items. No developer-only drilldown (01's Query G5, 02's Query H, 03's
-- Query H) and no per-user comparative diagnostic (01's Query G2, 03's
-- Query G — both reclassified developer-only in this same change) is
-- included anywhere in this snapshot.
--
-- ── CONSISTENCY WITH THE MANUAL SQL FILES ───────────────────────────────
-- Every section below reproduces its manual-file counterpart's population
-- filters, band boundaries, medians, confidence thresholds, historical-
-- import rules, and DOM/holding rules EXACTLY — see the per-section
-- comments for the query letter each one reproduces. The one deliberate
-- structural difference: the manual files copy each query's CTEs
-- byte-for-byte into every single query so any one query can be
-- copy-pasted and run alone (see each file's own header). Inside a single
-- compiled function that isn't a concern — this migration instead computes
-- each module's shared base population/band CTEs ONCE and has every
-- section within that module's function reference the same CTE, which
-- centralizes the logic (matching this project's general "one source of
-- truth per boundary" preference) without changing what any section
-- computes. Where a section's own SQL still needed its own nested CTEs
-- (e.g. Query D1/D2's capital-efficiency sub-populations, Query G4's
-- outlier trim), those are reproduced in full, just renamed with a
-- section-scoped prefix to avoid name collisions inside the shared WITH
-- clause.
--
-- ── RESULT SHAPE ─────────────────────────────────────────────────────────
-- Every tabular result becomes a JSON array of row objects via
-- `jsonb_agg(to_jsonb(row) ORDER BY ...)`, wrapped in COALESCE(..., '[]')
-- so an empty result is an empty array, never JSON null. to_jsonb() on a
-- numeric/integer/boolean/date column produces a genuine JSON
-- number/boolean/string — nothing here is stringified merely because psql
-- would have displayed it as text. Every array has an explicit,
-- deterministic ORDER BY matching (or, where the manual query had none
-- because it was a single row, imposing one) the manual query's own
-- ordering.
-- ============================================================================


-- ============================================================================
-- 1. public._build_acquisition_value_band_snapshot_v1()
-- Reproduces analytics/sql/01_acquisition_value_band_performance.sql.
-- Included sections (CLASSIFICATION: shared aggregate evidence in that
-- file) mapped to stable JSON keys:
--   Query A1  -> population_summary
--   Query A2  -> band_coverage_counts
--   Query B   -> performance
--   Query C   -> quartile_performance
--   Query D1  -> capital_efficiency
--   Query D2  -> capital_efficiency_sensitivity
--   Query E1  -> open_listed_inventory
--   Query E2  -> open_unlisted_inventory
--   Query F1  -> category_performance
--   Query F2  -> category_distribution
--   Query G1  -> cohort_comparison
--   Query G3  -> acquisition_method_comparison
--   Query G4  -> outlier_sensitivity
--   Query G5A -> integrity_summary
-- EXCLUDED: Query G2 (developer-only per-user diagnostic, reclassified in
-- this same change) and Query G5 (developer-only item-level drilldown).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_acquisition_value_band_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
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
  SELECT * FROM business WHERE acquisition_value > 0
),

-- Query A1 -> population_summary
a1_row AS (
  SELECT
    (SELECT COUNT(*) FROM acquisition_value_band)                                                          AS total_lifecycle_rows,
    (SELECT COUNT(*) FROM business)                                                                        AS business_items,
    (SELECT COUNT(*) FROM acquisition_value_band WHERE purpose_name IS DISTINCT FROM 'Business')            AS non_business_items,
    (SELECT COUNT(*) FROM business WHERE is_realized)                                                       AS realized_business_items,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized)                                                   AS open_business_items,
    (SELECT COUNT(*) FROM business WHERE exit_type = 'sale')                                                AS sale_exits,
    (SELECT COUNT(*) FROM business WHERE exit_type = 'trade')                                               AS trade_exits,
    (SELECT COUNT(*) FROM business WHERE is_historical_import)                                              AS historical_import_business_items,
    (SELECT COUNT(*) FROM business WHERE NOT is_historical_import)                                          AS non_historical_import_business_items,
    (SELECT COUNT(*) FROM business WHERE acquisition_value > 0)                                             AS acquisition_value_positive,
    (SELECT COUNT(*) FROM business WHERE acquisition_value = 0)                                             AS acquisition_value_zero,
    (SELECT COUNT(*) FROM business WHERE acquisition_value < 0)                                             AS acquisition_value_negative,
    (SELECT COUNT(*) FROM business WHERE acquisition_value IS NULL)                                         AS acquisition_value_null,
    (SELECT COUNT(*) FROM business WHERE has_lifecycle_date_issue)                                          AS rows_with_lifecycle_date_issues,
    (SELECT COUNT(*) FROM business WHERE is_realized AND holding_days IS NOT NULL)                          AS realized_holding_days_usable_count,
    (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NOT NULL)                 AS realized_dom_usable_count,
    (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NULL)                     AS realized_dom_missing_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed'
                                      AND global_days_on_market IS NOT NULL)                                AS open_listed_dom_usable_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status <> 'listed'
                                      AND global_days_on_market IS NULL)                                    AS open_unlisted_no_dom_count,
    (SELECT MIN(acquisition_value) FROM business WHERE acquisition_value > 0)                               AS min_acquisition_value_positive,
    (SELECT MAX(acquisition_value) FROM business WHERE acquisition_value > 0)                               AS max_acquisition_value_positive,
    (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2)
       FROM business WHERE acquisition_value > 0)                                                           AS median_acquisition_value_positive,
    (SELECT MIN(acquisition_date) FROM business)                                                            AS min_acquisition_date,
    (SELECT MAX(acquisition_date) FROM business)                                                            AS max_acquisition_date,
    (SELECT MIN(exit_date) FROM business)                                                                   AS min_exit_date,
    (SELECT MAX(exit_date) FROM business)                                                                   AS max_exit_date
),

-- Query A2 -> band_coverage_counts
a2_rows AS (
  SELECT acquisition_value_band_order, acquisition_value_band_label, COUNT(*) AS item_count
  FROM business
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- Query B -> performance
b_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                    AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- Query C -> quartile_performance
c_quartiled AS (
  SELECT *, NTILE(4) OVER (ORDER BY acquisition_value) AS quartile
  FROM eligible
),
c_rows AS (
  SELECT
    quartile,
    COUNT(*)                                                      AS sample_size,
    MIN(acquisition_value)                                        AS minimum_acquisition_value,
    MAX(acquisition_value)                                        AS maximum_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    COUNT(*) FILTER (WHERE is_realized)                           AS realized_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM c_quartiled
  GROUP BY quartile
),

-- Query D1 -> capital_efficiency
d1_capital AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*) FILTER (WHERE is_realized)               AS realized_item_count,
    SUM(acquisition_value) FILTER (WHERE is_realized) AS total_acquisition_capital,
    SUM(net_profit)        FILTER (WHERE is_realized) AS total_net_profit,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL) AS median_roi
  FROM eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
d1_timing_eligible AS (
  SELECT
    acquisition_value_band_order,
    holding_days,
    global_days_on_market,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days
  FROM eligible
  WHERE is_realized
    AND holding_days > 0
    AND NOT is_historical_import
    AND NOT has_lifecycle_date_issue
),
d1_timing AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*)                                                                     AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit_per_30_holding_days)      AS median_profit_per_30_holding_days,
    AVG(profit_per_30_holding_days)                                              AS average_profit_per_30_holding_days,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                    AS dom_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)                          AS median_days_on_market
  FROM d1_timing_eligible
  GROUP BY acquisition_value_band_order
),
d1_rows AS (
  SELECT
    capital.acquisition_value_band_order,
    capital.acquisition_value_band_label,
    capital.realized_item_count,
    capital.total_acquisition_capital,
    capital.total_net_profit,
    ROUND(capital.total_net_profit / NULLIF(capital.total_acquisition_capital, 0) * 1000, 2) AS net_profit_per_1000_invested,
    ROUND(capital.median_roi::numeric, 2)                                                    AS median_roi,
    COALESCE(timing.holding_sample_size, 0)                                                  AS holding_sample_size,
    ROUND(timing.median_profit_per_30_holding_days::numeric, 2)                               AS median_profit_per_30_holding_days,
    ROUND(timing.average_profit_per_30_holding_days, 2)                                       AS average_profit_per_30_holding_days,
    COALESCE(timing.dom_sample_size, 0)                                                       AS dom_sample_size,
    ROUND(timing.median_days_on_market::numeric, 2)                                           AS median_days_on_market
  FROM d1_capital capital
  LEFT JOIN d1_timing timing ON timing.acquisition_value_band_order = capital.acquisition_value_band_order
),

-- Query D2 -> capital_efficiency_sensitivity
d2_primary AS (
  SELECT 'Primary (Historical Import/Purchase/Trade excluded)' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days,
    holding_days, global_days_on_market
  FROM eligible
  WHERE is_realized AND holding_days > 0 AND NOT is_historical_import AND NOT has_lifecycle_date_issue
),
d2_with_historical AS (
  SELECT 'Sensitivity (Historical Import/Purchase/Trade included)' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days,
    holding_days, global_days_on_market
  FROM eligible
  WHERE is_realized AND holding_days > 0 AND NOT has_lifecycle_date_issue
),
d2_combined AS (
  SELECT * FROM d2_primary
  UNION ALL
  SELECT * FROM d2_with_historical
),
d2_rows AS (
  SELECT
    population_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                          AS qualifying_item_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2)                   AS median_days_on_market,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL)                                  AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)::numeric, 2)                            AS median_holding_days,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit_per_30_holding_days)::numeric, 2) AS median_profit_per_30_holding_days,
    ROUND(AVG(profit_per_30_holding_days), 2)                                          AS average_profit_per_30_holding_days
  FROM d2_combined
  GROUP BY population_label, acquisition_value_band_order, acquisition_value_band_label
),

-- Query E1 -> open_listed_inventory
e1_listed_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status = 'listed'
),
e1_listed_full AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                    AS listed_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS listed_acquisition_capital,
    SUM(estimated_sold_value)                                   AS listed_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside
  FROM e1_listed_items
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
e1_dom_eligible AS (
  SELECT * FROM e1_listed_items WHERE NOT has_lifecycle_date_issue
),
e1_dom_summary AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)        AS median_current_days_on_market,
    MAX(global_days_on_market)                                 AS max_current_days_on_market
  FROM e1_dom_eligible
  GROUP BY acquisition_value_band_order
),
e1_holding_eligible AS (
  SELECT * FROM e1_listed_items WHERE NOT has_lifecycle_date_issue AND NOT is_historical_import
),
e1_holding_summary AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL) AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)        AS median_holding_days
  FROM e1_holding_eligible
  GROUP BY acquisition_value_band_order
),
e1_holding_excluded AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL) AS holding_excluded_historical_count
  FROM e1_dom_eligible
  GROUP BY acquisition_value_band_order
),
e1_rows AS (
  SELECT
    lf.acquisition_value_band_order,
    lf.acquisition_value_band_label,
    lf.listed_item_count,
    lf.listed_acquisition_capital,
    lf.listed_estimated_value,
    CASE
      WHEN lf.listed_estimated_value IS NOT NULL AND lf.acquisition_for_upside IS NOT NULL
      THEN lf.listed_estimated_value - lf.acquisition_for_upside - COALESCE(lf.item_expenses_for_upside, 0)
      ELSE NULL
    END AS listed_estimated_net_upside,
    COALESCE(ds.dom_sample_size, 0)                      AS dom_sample_size,
    ROUND(ds.median_current_days_on_market::numeric, 2) AS median_current_days_on_market,
    ds.max_current_days_on_market,
    COALESCE(hs.holding_sample_size, 0)        AS holding_sample_size,
    ROUND(hs.median_holding_days::numeric, 2) AS median_holding_days,
    COALESCE(he.holding_excluded_historical_count, 0) AS holding_excluded_historical_count
  FROM e1_listed_full lf
  LEFT JOIN e1_dom_summary ds     ON ds.acquisition_value_band_order = lf.acquisition_value_band_order
  LEFT JOIN e1_holding_summary hs ON hs.acquisition_value_band_order = lf.acquisition_value_band_order
  LEFT JOIN e1_holding_excluded he ON he.acquisition_value_band_order = lf.acquisition_value_band_order
),

-- Query E2 -> open_unlisted_inventory
e2_unlisted_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status <> 'listed'
),
e2_unlisted_full AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                    AS unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS unlisted_acquisition_capital,
    SUM(estimated_sold_value)                                   AS unlisted_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside
  FROM e2_unlisted_items
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
e2_reliable AS (
  SELECT * FROM e2_unlisted_items WHERE NOT is_historical_import AND NOT has_lifecycle_date_issue
),
e2_reliable_summary AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL)         AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)                AS median_ownership_age_days,
    MAX(holding_days)                                         AS max_ownership_age_days
  FROM e2_reliable
  GROUP BY acquisition_value_band_order
),
e2_rows AS (
  SELECT
    uf.acquisition_value_band_order,
    uf.acquisition_value_band_label,
    uf.unlisted_item_count,
    uf.unlisted_acquisition_capital,
    uf.unlisted_estimated_value,
    CASE
      WHEN uf.unlisted_estimated_value IS NOT NULL AND uf.acquisition_for_upside IS NOT NULL
      THEN uf.unlisted_estimated_value - uf.acquisition_for_upside - COALESCE(uf.item_expenses_for_upside, 0)
      ELSE NULL
    END AS unlisted_estimated_net_upside,
    COALESCE(rs.holding_sample_size, 0)              AS holding_sample_size,
    ROUND(rs.median_ownership_age_days::numeric, 2) AS median_ownership_age_days,
    rs.max_ownership_age_days
  FROM e2_unlisted_full uf
  LEFT JOIN e2_reliable_summary rs ON rs.acquisition_value_band_order = uf.acquisition_value_band_order
),

-- Query F1 -> category_performance
f1_rows AS (
  SELECT
    category_id,
    category_name,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                    AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
    COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- Query F2 -> category_distribution
f2_rows AS (
  SELECT
    category_id, category_name, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*) AS item_count
  FROM eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- Query G1 -> cohort_comparison
g1_combined AS (
  SELECT 'All eligible Business items' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  UNION ALL
  SELECT 'Imported historical Business items' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  WHERE is_historical_import
  UNION ALL
  SELECT 'App-tracked Business items' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  WHERE NOT is_historical_import
),
g1_rows AS (
  SELECT
    population_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                            AS sample_size,
    COUNT(*) FILTER (WHERE is_realized) AS realized_items,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM g1_combined
  GROUP BY population_label, acquisition_value_band_order, acquisition_value_band_label
),

-- Query G3 -> acquisition_method_comparison
g3_rows AS (
  SELECT
    acquisition_method,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                    AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
    COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY acquisition_method, acquisition_value_band_order, acquisition_value_band_label
),

-- Query G4 -> outlier_sensitivity
g4_realized AS (
  SELECT * FROM eligible WHERE is_realized
),
g4_banded AS (
  SELECT
    *,
    COUNT(*) OVER (PARTITION BY acquisition_value_band_order)                                          AS band_sample_size,
    ROW_NUMBER() OVER (PARTITION BY acquisition_value_band_order ORDER BY net_profit ASC,  item_id ASC)  AS rank_from_bottom,
    ROW_NUMBER() OVER (PARTITION BY acquisition_value_band_order ORDER BY net_profit DESC, item_id DESC) AS rank_from_top
  FROM g4_realized
),
g4_trimmed AS (
  SELECT *, FLOOR(band_sample_size * 0.05)::int AS trim_count
  FROM g4_banded
),
g4_full_population AS (
  SELECT
    'All realized items' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    net_profit, roi, holding_days, global_days_on_market, is_historical_import,
    band_sample_size AS original_sample_size,
    0 AS removed_low_count,
    0 AS removed_high_count
  FROM g4_trimmed
),
g4_trimmed_population AS (
  SELECT
    'Profit outliers excluded (5% trim each side, by acquisition value band)' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    net_profit, roi, holding_days, global_days_on_market, is_historical_import,
    band_sample_size AS original_sample_size,
    trim_count AS removed_low_count,
    trim_count AS removed_high_count
  FROM g4_trimmed
  WHERE trim_count > 0
    AND rank_from_bottom > trim_count
    AND rank_from_top    > trim_count
),
g4_combined AS (
  SELECT * FROM g4_full_population
  UNION ALL
  SELECT * FROM g4_trimmed_population
),
g4_rows AS (
  SELECT
    population_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    original_sample_size,
    COUNT(*) AS analysis_sample_size,
    removed_low_count,
    removed_high_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi
  FROM g4_combined
  GROUP BY population_label, acquisition_value_band_order, acquisition_value_band_label, original_sample_size, removed_low_count, removed_high_count
),

-- Query G5A -> integrity_summary
g5a_flagged AS (
  SELECT
    *,
    COALESCE(days_acquisition_to_first_listing < 0, false) AS acquisition_to_listing_is_negative,
    COALESCE(
      global_days_on_market IS NOT NULL
      AND holding_days IS NOT NULL
      AND global_days_on_market > holding_days,
      false
    ) AS dom_exceeds_holding_days,
    COALESCE(
      is_realized
      AND first_listed_at IS NOT NULL
      AND exit_date IS NOT NULL
      AND global_days_on_market IS NOT NULL
      AND (exit_date - first_listed_at) <> global_days_on_market,
      false
    ) AS realized_dom_date_mismatch
  FROM eligible
),
g5a_row AS (
  SELECT
    COUNT(*)                                                                                  AS item_count,
    COUNT(*) FILTER (WHERE acquisition_to_listing_is_negative)                                 AS negative_acquisition_to_listing_count,
    COUNT(*) FILTER (WHERE dom_exceeds_holding_days)                                            AS dom_exceeds_holding_count,
    COUNT(*) FILTER (WHERE realized_dom_date_mismatch)                                          AS realized_dom_date_mismatch_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)                       AS realized_items_missing_dom_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL) AS open_listed_items_missing_dom_count
  FROM g5a_flagged
)

SELECT jsonb_build_object(
  'population_summary',            (SELECT COALESCE(jsonb_agg(to_jsonb(a1_row)), '[]'::jsonb) FROM a1_row),
  'band_coverage_counts',          (SELECT COALESCE(jsonb_agg(to_jsonb(a2_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM a2_rows),
  'performance',                   (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM b_rows),
  'quartile_performance',          (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY quartile), '[]'::jsonb) FROM c_rows),
  'capital_efficiency',            (SELECT COALESCE(jsonb_agg(to_jsonb(d1_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM d1_rows),
  'capital_efficiency_sensitivity',(SELECT COALESCE(jsonb_agg(to_jsonb(d2_rows) ORDER BY acquisition_value_band_order, population_label), '[]'::jsonb) FROM d2_rows),
  'open_listed_inventory',         (SELECT COALESCE(jsonb_agg(to_jsonb(e1_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM e1_rows),
  'open_unlisted_inventory',       (SELECT COALESCE(jsonb_agg(to_jsonb(e2_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM e2_rows),
  'category_performance',          (SELECT COALESCE(jsonb_agg(to_jsonb(f1_rows) ORDER BY category_id, acquisition_value_band_order), '[]'::jsonb) FROM f1_rows),
  'category_distribution',         (SELECT COALESCE(jsonb_agg(to_jsonb(f2_rows) ORDER BY category_id, acquisition_value_band_order), '[]'::jsonb) FROM f2_rows),
  'cohort_comparison',             (SELECT COALESCE(jsonb_agg(to_jsonb(g1_rows) ORDER BY acquisition_value_band_order, population_label), '[]'::jsonb) FROM g1_rows),
  'acquisition_method_comparison', (SELECT COALESCE(jsonb_agg(to_jsonb(g3_rows) ORDER BY acquisition_method, acquisition_value_band_order), '[]'::jsonb) FROM g3_rows),
  'outlier_sensitivity',           (SELECT COALESCE(jsonb_agg(to_jsonb(g4_rows) ORDER BY acquisition_value_band_order, population_label), '[]'::jsonb) FROM g4_rows),
  'integrity_summary',             (SELECT COALESCE(jsonb_agg(to_jsonb(g5a_row)), '[]'::jsonb) FROM g5a_row)
);
$$;

REVOKE ALL ON FUNCTION public._build_acquisition_value_band_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_acquisition_value_band_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_acquisition_value_band_snapshot_v1() FROM authenticated;


-- ============================================================================
-- 2. public._build_acquisition_to_exit_snapshot_v1()
-- Reproduces analytics/sql/02_acquisition_to_exit_analysis.sql. This module
-- computes NO holding_days-derived metric (matches the manual file's own
-- SEMANTIC SCOPE — "Acquisition-to-Exit" means value movement, not
-- duration). Included sections mapped to stable JSON keys:
--   Query A1 -> population_summary
--   Query A2 -> integrity_summary
--   Query B  -> performance_by_acquisition_value_band
--   Query C  -> transition_matrix
--   Query C2 -> movement_summary
--   Query D  -> method_paths
--   Query E  -> method_paths_by_acquisition_value_band
--   Query F  -> purchase_price_band
--   Query G  -> sale_price_band
-- EXCLUDED: Query H (developer-only item-level drilldown).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_acquisition_to_exit_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
),
realized_business AS (
  SELECT * FROM business WHERE is_realized
),
eligible AS (
  SELECT * FROM realized_business
  WHERE acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),

-- Query A1 -> population_summary
a1_row AS (
  SELECT
    (SELECT COUNT(*) FROM business)                                                                       AS total_business_items,
    (SELECT COUNT(*) FROM realized_business)                                                               AS realized_business_items,
    (SELECT COUNT(*) FROM realized_business WHERE acquisition_value IS NOT NULL AND acquisition_value > 0) AS realized_items_positive_acquisition_value,
    (SELECT COUNT(*) FROM realized_business WHERE exit_value IS NOT NULL AND exit_value > 0)               AS realized_items_positive_exit_value,
    (SELECT COUNT(*) FROM eligible)                                                                        AS eligible_for_value_transition_analysis,
    (SELECT COUNT(*) FROM realized_business WHERE acquisition_value IS NULL OR acquisition_value <= 0)     AS excluded_acquisition_value_zero_or_unknown,
    (SELECT COUNT(*) FROM realized_business WHERE exit_value IS NULL OR exit_value <= 0)                   AS excluded_exit_value_zero_or_unknown,
    (SELECT COUNT(*) FROM eligible WHERE acquisition_method = 'purchase')                                  AS purchase_acquisitions,
    (SELECT COUNT(*) FROM eligible WHERE acquisition_method = 'trade')                                     AS trade_acquisitions,
    (SELECT COUNT(*) FROM eligible WHERE acquisition_method NOT IN ('purchase', 'trade'))                  AS unknown_acquisition_methods,
    (SELECT COUNT(*) FROM eligible WHERE exit_type = 'sale')                                               AS sale_exits,
    (SELECT COUNT(*) FROM eligible WHERE exit_type = 'trade')                                              AS trade_exits,
    (SELECT COUNT(*) FROM eligible WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade'))          AS unknown_exit_methods,
    (SELECT COUNT(*) FROM eligible WHERE global_days_on_market IS NOT NULL)                                AS dom_usable_count,
    (SELECT COUNT(*) FROM eligible WHERE global_days_on_market IS NULL)                                    AS dom_missing_count,
    (SELECT COUNT(*) FROM eligible WHERE is_historical_import)                                             AS historical_eligible_count,
    (SELECT COUNT(*) FROM eligible WHERE NOT is_historical_import)                                         AS app_tracked_eligible_count
),

-- Query A2 -> integrity_summary
a2_flagged AS (
  SELECT
    *,
    COALESCE(
      first_listed_at IS NOT NULL AND exit_date IS NOT NULL AND exit_date < first_listed_at,
      false
    ) AS exit_before_first_listed,
    COALESCE(global_days_on_market IS NOT NULL AND global_days_on_market < 0, false) AS negative_dom,
    COALESCE(
      first_listed_at IS NOT NULL AND exit_date IS NOT NULL AND global_days_on_market IS NOT NULL
      AND (exit_date - first_listed_at) <> global_days_on_market,
      false
    ) AS realized_dom_date_mismatch
  FROM realized_business
),
a2_eligible_bands AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS exit_value_band_order
  FROM a2_flagged
  WHERE acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
a2_row AS (
  SELECT
    (SELECT COUNT(*) FROM realized_business)                                              AS item_count,
    (SELECT COUNT(item_id) - COUNT(DISTINCT item_id) FROM realized_business)                AS duplicate_item_id_count,
    (SELECT COUNT(*) FROM a2_flagged WHERE exit_before_first_listed)                        AS exit_before_first_listed_count,
    (SELECT COUNT(*) FROM a2_flagged WHERE negative_dom)                                    AS negative_dom_count,
    (SELECT COUNT(*) FROM realized_business WHERE exit_value IS NULL)                       AS realized_missing_exit_value_count,
    (SELECT COUNT(*) FROM realized_business WHERE exit_type IS NULL)                        AS realized_missing_exit_method_count,
    (SELECT COUNT(*) FROM a2_eligible_bands
       WHERE acquisition_value_band_order IS NULL OR acquisition_value_band_order NOT BETWEEN 1 AND 6
          OR exit_value_band_order        IS NULL OR exit_value_band_order        NOT BETWEEN 1 AND 6)  AS invalid_band_assignment_count,
    (SELECT COUNT(*) FROM a2_flagged WHERE realized_dom_date_mismatch)                      AS realized_dom_date_mismatch_count
),

-- Query B -> performance_by_acquisition_value_band
b_banded AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM eligible
),
b_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                      AS sample_size,
    COUNT(*) FILTER (WHERE exit_type = 'sale')    AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')   AS trade_exit_count,
    COUNT(*) FILTER (WHERE is_historical_import)  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import) AS app_tracked_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM b_banded
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- Query C -> transition_matrix
c_banded AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label,
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
    END AS exit_value_band_label
  FROM eligible
),
c_movement AS (
  SELECT
    *,
    CASE
      WHEN exit_value_band_order < acquisition_value_band_order THEN 'moved_down'
      WHEN exit_value_band_order = acquisition_value_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM c_banded
),
c_agg AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    exit_value_band_order,
    exit_value_band_label,
    value_movement,
    COUNT(*)                                    AS item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM c_movement
  GROUP BY acquisition_value_band_order, acquisition_value_band_label,
           exit_value_band_order, exit_value_band_label, value_movement
),
c_shared AS (
  SELECT
    *,
    SUM(item_count) OVER (PARTITION BY acquisition_value_band_order) AS acquisition_band_total,
    SUM(item_count) OVER ()                                          AS grand_total
  FROM c_agg
),
c_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    exit_value_band_order,
    exit_value_band_label,
    item_count,
    ROUND(item_count::numeric / NULLIF(acquisition_band_total, 0) * 100, 2) AS share_within_acquisition_band_percent,
    ROUND(item_count::numeric / NULLIF(grand_total, 0) * 100, 2)            AS share_of_all_transition_items_percent,
    median_acquisition_value,
    median_exit_value,
    median_value_increase,
    median_net_profit,
    median_roi,
    median_days_on_market,
    sale_exit_count,
    trade_exit_count,
    value_movement,
    CASE
      WHEN item_count <= 2 THEN 'insufficient'
      WHEN item_count <= 5 THEN 'low'
      WHEN item_count <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM c_shared
),

-- Query C2 -> movement_summary
c2_banded AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 0
      WHEN exit_value < 1000 THEN 1
      WHEN exit_value < 2000 THEN 2
      WHEN exit_value < 3000 THEN 3
      WHEN exit_value < 4000 THEN 4
      WHEN exit_value < 5000 THEN 5
      ELSE 6
    END AS exit_value_band_order
  FROM eligible
),
c2_movement AS (
  SELECT
    *,
    CASE
      WHEN exit_value_band_order < acquisition_value_band_order THEN 'moved_down'
      WHEN exit_value_band_order = acquisition_value_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM c2_banded
),
c2_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                     AS sample_size,
    COUNT(*) FILTER (WHERE value_movement = 'moved_down')        AS moved_down_count,
    ROUND(COUNT(*) FILTER (WHERE value_movement = 'moved_down')::numeric   / NULLIF(COUNT(*), 0) * 100, 2) AS moved_down_percent,
    COUNT(*) FILTER (WHERE value_movement = 'stayed_in_same_band') AS same_band_count,
    ROUND(COUNT(*) FILTER (WHERE value_movement = 'stayed_in_same_band')::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_band_percent,
    COUNT(*) FILTER (WHERE value_movement = 'moved_up')          AS moved_up_count,
    ROUND(COUNT(*) FILTER (WHERE value_movement = 'moved_up')::numeric     / NULLIF(COUNT(*), 0) * 100, 2) AS moved_up_percent,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM c2_movement
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),

-- Query D -> method_paths
d_prepped AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
    exit_type AS exit_method
  FROM eligible
),
d_rows AS (
  SELECT
    acquisition_method,
    exit_method,
    COUNT(*)                                         AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_increase)::numeric, 2)    AS median_value_increase,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_historical_import)     AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import) AS app_tracked_item_count,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM d_prepped
  GROUP BY acquisition_method, exit_method
),

-- Query E -> method_paths_by_acquisition_value_band
e_banded AS (
  SELECT
    *,
    exit_type AS exit_method,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM eligible
),
e_rows AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    acquisition_method,
    exit_method,
    COUNT(*)                                                                          AS sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM e_banded
  GROUP BY acquisition_value_band_order, acquisition_value_band_label, acquisition_method, exit_method
),

-- Query F -> purchase_price_band
f_eligible AS (
  SELECT * FROM eligible WHERE acquisition_method = 'purchase'
),
f_banded AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS purchase_price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS purchase_price_band_label
  FROM f_eligible
),
f_rows AS (
  SELECT
    purchase_price_band_order,
    purchase_price_band_label,
    COUNT(*)                                    AS sample_size,
    COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_exit_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_exit_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_purchase_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM f_banded
  GROUP BY purchase_price_band_order, purchase_price_band_label
),

-- Query G -> sale_price_band
g_eligible AS (
  SELECT * FROM eligible WHERE exit_type = 'sale'
),
g_banded AS (
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
    END AS sale_price_band_order,
    CASE
      WHEN exit_value IS NULL OR exit_value <= 0 THEN 'Zero / unknown'
      WHEN exit_value < 1000 THEN '$1-999'
      WHEN exit_value < 2000 THEN '$1,000-1,999'
      WHEN exit_value < 3000 THEN '$2,000-2,999'
      WHEN exit_value < 4000 THEN '$3,000-3,999'
      WHEN exit_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS sale_price_band_label
  FROM g_eligible
),
g_rows AS (
  SELECT
    sale_price_band_order,
    sale_price_band_label,
    COUNT(*)                                             AS sample_size,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase') AS purchase_acquisition_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')    AS trade_acquisition_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)        AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)        AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM g_banded
  GROUP BY sale_price_band_order, sale_price_band_label
)

SELECT jsonb_build_object(
  'population_summary',                       (SELECT COALESCE(jsonb_agg(to_jsonb(a1_row)), '[]'::jsonb) FROM a1_row),
  'integrity_summary',                         (SELECT COALESCE(jsonb_agg(to_jsonb(a2_row)), '[]'::jsonb) FROM a2_row),
  'performance_by_acquisition_value_band',     (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM b_rows),
  'transition_matrix',                         (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY acquisition_value_band_order, exit_value_band_order), '[]'::jsonb) FROM c_rows),
  'movement_summary',                          (SELECT COALESCE(jsonb_agg(to_jsonb(c2_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM c2_rows),
  'method_paths',                              (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY acquisition_method, exit_method), '[]'::jsonb) FROM d_rows),
  'method_paths_by_acquisition_value_band',    (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY acquisition_value_band_order, acquisition_method, exit_method), '[]'::jsonb) FROM e_rows),
  'purchase_price_band',                       (SELECT COALESCE(jsonb_agg(to_jsonb(f_rows) ORDER BY purchase_price_band_order), '[]'::jsonb) FROM f_rows),
  'sale_price_band',                           (SELECT COALESCE(jsonb_agg(to_jsonb(g_rows) ORDER BY sale_price_band_order), '[]'::jsonb) FROM g_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_acquisition_to_exit_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_acquisition_to_exit_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_acquisition_to_exit_snapshot_v1() FROM authenticated;


-- ============================================================================
-- 3. public._build_brand_snapshot_v1()
-- Reproduces analytics/sql/03_brand_performance.sql. Included sections
-- mapped to stable JSON keys:
--   Query A1 -> population_summary
--   Query A2 -> fragmentation_summary
--   Query A3 -> brand_quality_audit
--   Query B  -> overall_performance
--   Query B2 -> decision_ready_performance
--   Query C  -> by_acquisition_value_band
--   Query C2 -> decision_ready_by_acquisition_value_band
--   Query D  -> by_acquisition_method
--   Query D2 -> decision_ready_by_acquisition_method
--   Query E1 -> open_listed_inventory
--   Query E2 -> open_unlisted_inventory
--   Query F  -> cohort_comparison
--   Query I  -> capital_concentration
--   Query H2 -> integrity_summary
-- EXCLUDED: Query G (developer-only per-user diagnostic, reclassified in
-- this same change) and Query H (developer-only item-level drilldown).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_brand_snapshot_v1()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
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
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),

-- Query A1 -> population_summary
a1_row AS (
  SELECT
    (SELECT COUNT(*) FROM acquisition_value_band)                                                                       AS total_lifecycle_rows,
    (SELECT COUNT(*) FROM business)                                                                                     AS business_items,
    (SELECT COUNT(*) FROM business WHERE acquisition_value > 0)                                                         AS business_positive_acquisition_items,
    (SELECT COUNT(*) FROM business WHERE acquisition_value IS NULL OR acquisition_value <= 0)                           AS business_zero_or_unknown_acquisition_items,
    (SELECT COUNT(*) FROM business WHERE is_realized)                                                                   AS realized_business_items,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized)                                                               AS open_business_items,
    (SELECT COUNT(DISTINCT brand_label) FROM business)                                                                  AS distinct_brand_count,
    (SELECT COUNT(*) FROM business WHERE brand_label = 'Unknown brand')                                                 AS unknown_brand_item_count,
    (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NOT NULL)                             AS realized_dom_usable_count,
    (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NULL)                                 AS realized_dom_missing_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NOT NULL) AS open_listed_dom_usable_count,
    (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL)     AS open_listed_dom_missing_count,
    (SELECT COUNT(*) FROM business WHERE is_historical_import)                                                          AS historical_business_items,
    (SELECT COUNT(*) FROM business WHERE NOT is_historical_import)                                                      AS non_historical_business_items
),

-- Query A2 -> fragmentation_summary
a2_brand_counts AS (
  SELECT
    brand_label,
    COUNT(*)                            AS item_count,
    COUNT(*) FILTER (WHERE is_realized) AS realized_count
  FROM eligible
  GROUP BY brand_label
),
a2_bucketed AS (
  SELECT
    *,
    CASE
      WHEN item_count = 1 THEN '1 item'
      WHEN item_count = 2 THEN '2 items'
      WHEN item_count BETWEEN 3 AND 5 THEN '3-5 items'
      WHEN item_count BETWEEN 6 AND 9 THEN '6-9 items'
      ELSE '10+ items'
    END AS bucket,
    CASE
      WHEN item_count = 1 THEN 1
      WHEN item_count = 2 THEN 2
      WHEN item_count BETWEEN 3 AND 5 THEN 3
      WHEN item_count BETWEEN 6 AND 9 THEN 4
      ELSE 5
    END AS bucket_order
  FROM a2_brand_counts
),
a2_bucket_summary AS (
  SELECT bucket, bucket_order, COUNT(*) AS brand_count, SUM(item_count) AS items_in_bucket
  FROM a2_bucketed
  GROUP BY bucket, bucket_order
),
a2_totals AS (
  SELECT
    (SELECT COUNT(*) FROM eligible)                                    AS total_items,
    (SELECT COUNT(*) FROM a2_brand_counts WHERE item_count >= 3)        AS brands_with_3plus_items,
    (SELECT COUNT(*) FROM a2_brand_counts WHERE realized_count >= 3)    AS brands_with_3plus_realized,
    (SELECT COUNT(*) FROM a2_brand_counts WHERE realized_count >= 5)    AS brands_with_5plus_realized
),
a2_top5 AS (
  SELECT COALESCE(SUM(item_count), 0) AS top5_item_count
  FROM (SELECT item_count FROM a2_brand_counts ORDER BY item_count DESC, brand_label LIMIT 5) x
),
a2_small AS (
  SELECT COALESCE(SUM(item_count), 0) AS small_brand_item_count
  FROM a2_brand_counts
  WHERE item_count < 3
),
a2_rows AS (
  SELECT
    bs.bucket,
    bs.bucket_order,
    bs.brand_count,
    bs.items_in_bucket,
    t.brands_with_3plus_items,
    t.brands_with_3plus_realized,
    t.brands_with_5plus_realized,
    ROUND(top5.top5_item_count::numeric / NULLIF(t.total_items, 0) * 100, 2)  AS top5_brand_share_percent,
    ROUND(small.small_brand_item_count::numeric / NULLIF(t.total_items, 0) * 100, 2) AS brands_under_3_items_share_percent
  FROM a2_bucket_summary bs
  CROSS JOIN a2_totals t
  CROSS JOIN a2_top5 top5
  CROSS JOIN a2_small small
),

-- Query A3 -> brand_quality_audit
a3_brand_stats AS (
  SELECT brand_name, COUNT(*) AS item_count
  FROM eligible
  WHERE brand_name IS NOT NULL AND trim(brand_name) <> ''
  GROUP BY brand_name
),
a3_null_blank AS (
  SELECT
    COALESCE(brand_name, '(null)')     AS brand_name,
    COUNT(*)                          AS item_count,
    NULL::text                        AS possible_matching_brand,
    NULL::bigint                      AS matching_brand_item_count,
    'null_or_blank'                    AS issue_type,
    'Brand name is missing or the underlying brands row is blank — grouped under ''Unknown brand'' in analytical output; not merged with any real brands row.' AS review_note
  FROM eligible
  WHERE brand_name IS NULL OR trim(brand_name) = ''
  GROUP BY brand_name
),
a3_case_whitespace_dupes AS (
  SELECT
    a.brand_name                      AS brand_name,
    a.item_count,
    b.brand_name                      AS possible_matching_brand,
    b.item_count                      AS matching_brand_item_count,
    'capitalization_or_whitespace'     AS issue_type,
    'Normalizes to the same name as "' || b.brand_name || '" (' || b.item_count || ' items) — likely two separate brands rows for what should be one brand.' AS review_note
  FROM a3_brand_stats a
  JOIN a3_brand_stats b
    ON a.brand_name <> b.brand_name
   AND a.brand_name > b.brand_name
   AND trim(LOWER(regexp_replace(a.brand_name, '\s+', ' ', 'g'))) = trim(LOWER(regexp_replace(b.brand_name, '\s+', ' ', 'g')))
),
a3_near_duplicate_typo AS (
  SELECT
    a.brand_name                      AS brand_name,
    a.item_count,
    b.brand_name                      AS possible_matching_brand,
    b.item_count                      AS matching_brand_item_count,
    'possible_typo'                    AS issue_type,
    'Same length, differs by exactly one character from "' || b.brand_name || '" (' || b.item_count || ' items) — review for a possible misspelled brands row.' AS review_note
  FROM a3_brand_stats a
  JOIN a3_brand_stats b
    ON a.brand_name <> b.brand_name
   AND length(a.brand_name) = length(b.brand_name)
   AND a.item_count <= 2
   AND b.item_count >= 5
   AND (
     SELECT COUNT(*)
     FROM generate_series(1, length(a.brand_name)) i
     WHERE substring(a.brand_name FROM i FOR 1) <> substring(b.brand_name FROM i FOR 1)
   ) = 1
),
a3_rows AS (
  SELECT brand_name, item_count, possible_matching_brand, matching_brand_item_count, issue_type, review_note FROM a3_null_blank
  UNION ALL
  SELECT brand_name, item_count, possible_matching_brand, matching_brand_item_count, issue_type, review_note FROM a3_case_whitespace_dupes
  UNION ALL
  SELECT brand_name, item_count, possible_matching_brand, matching_brand_item_count, issue_type, review_note FROM a3_near_duplicate_typo
),

-- Query B -> overall_performance
b_agg AS (
  SELECT
    brand_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    SUM(acquisition_value)                                                   AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized)                        AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                               AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count
  FROM eligible
  GROUP BY brand_label
),
b_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM b_agg
),
b_rows AS (
  SELECT
    brand_label AS brand_name,
    sample_size, realized_items, open_items, realization_rate_percent, sale_count, trade_count,
    total_acquisition_capital, realized_acquisition_capital, total_realized_net_profit,
    median_net_profit, median_roi, dom_sample_size, median_days_on_market,
    holding_sample_size, median_holding_days, historical_item_count, non_historical_item_count,
    CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
    CASE
      WHEN realized_items = 0 THEN 'no realized evidence'
      WHEN realized_items <= 2 THEN 'insufficient realized evidence'
      WHEN realized_items <= 5 THEN 'low realized evidence'
      WHEN realized_items <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
    CASE
      WHEN realized_items = 0 THEN 'No realized items yet'
      WHEN realized_items = 1 THEN 'Only 1 realized item'
      WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
      WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
      WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
      WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
      ELSE 'Stronger evidence'
    END AS confidence_warning,
    sample_tier, realized_tier
  FROM b_scored
),

-- Query B2 -> decision_ready_performance
b2_agg AS (
  SELECT
    brand_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    SUM(acquisition_value)                                                   AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized)                        AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                               AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count
  FROM eligible
  GROUP BY brand_label
  HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3
),
b2_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM b2_agg
),
b2_rows AS (
  SELECT
    brand_label AS brand_name,
    sample_size, realized_items, open_items, realization_rate_percent, sale_count, trade_count,
    total_acquisition_capital, realized_acquisition_capital, total_realized_net_profit,
    median_net_profit AS typical_profit_per_item,
    median_roi        AS typical_roi_percent,
    dom_sample_size, median_days_on_market,
    CASE
      WHEN median_days_on_market IS NULL THEN 'insufficient DOM data'
      WHEN median_days_on_market <= 14 THEN 'very fast'
      WHEN median_days_on_market <= 30 THEN 'fast'
      WHEN median_days_on_market <= 60 THEN 'moderate'
      WHEN median_days_on_market <= 120 THEN 'slow'
      ELSE 'very slow'
    END AS market_velocity_label,
    holding_sample_size, median_holding_days, historical_item_count, non_historical_item_count,
    CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
    CASE
      WHEN realized_items = 0 THEN 'no realized evidence'
      WHEN realized_items <= 2 THEN 'insufficient realized evidence'
      WHEN realized_items <= 5 THEN 'low realized evidence'
      WHEN realized_items <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
    CASE
      WHEN realized_items = 0 THEN 'No realized items yet'
      WHEN realized_items = 1 THEN 'Only 1 realized item'
      WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
      WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
      WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
      WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
      ELSE 'Stronger evidence'
    END AS confidence_warning,
    sample_tier, realized_tier
  FROM b2_scored
),

-- Query C -> by_acquisition_value_band
c_agg AS (
  SELECT
    brand_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY brand_label, acquisition_value_band_order, acquisition_value_band_label
),
c_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM c_agg
),
c_rows AS (
  SELECT
    brand_label AS brand_name, acquisition_value_band_order, acquisition_value_band_label,
    sample_size, realized_items, open_items, realization_rate_percent, sale_count, trade_count,
    median_net_profit, median_roi, dom_sample_size, median_days_on_market, holding_sample_size, median_holding_days,
    CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
    CASE
      WHEN realized_items = 0 THEN 'no realized evidence'
      WHEN realized_items <= 2 THEN 'insufficient realized evidence'
      WHEN realized_items <= 5 THEN 'low realized evidence'
      WHEN realized_items <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
    CASE
      WHEN realized_items = 0 THEN 'No realized items yet'
      WHEN realized_items = 1 THEN 'Only 1 realized item'
      WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
      WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
      WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
      WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
      ELSE 'Stronger evidence'
    END AS confidence_warning
  FROM c_scored
),

-- Query C2 -> decision_ready_by_acquisition_value_band
c2_agg AS (
  SELECT
    brand_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY brand_label, acquisition_value_band_order, acquisition_value_band_label
  HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3
),
c2_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM c2_agg
),
c2_rows AS (
  SELECT
    brand_label AS brand_name, acquisition_value_band_order, acquisition_value_band_label,
    sample_size, realized_items, open_items, realization_rate_percent, sale_count, trade_count,
    median_net_profit, median_roi, dom_sample_size, median_days_on_market, holding_sample_size, median_holding_days,
    CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
    CASE
      WHEN realized_items = 0 THEN 'no realized evidence'
      WHEN realized_items <= 2 THEN 'insufficient realized evidence'
      WHEN realized_items <= 5 THEN 'low realized evidence'
      WHEN realized_items <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
    CASE
      WHEN realized_items = 0 THEN 'No realized items yet'
      WHEN realized_items = 1 THEN 'Only 1 realized item'
      WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
      WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
      WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
      WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
      ELSE 'Stronger evidence'
    END AS confidence_warning
  FROM c2_scored
),

-- Query D -> by_acquisition_method
d_agg AS (
  SELECT
    brand_label,
    acquisition_method,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count
  FROM eligible
  GROUP BY brand_label, acquisition_method
),
d_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM d_agg
),
d_rows AS (
  SELECT
    brand_label AS brand_name, acquisition_method,
    sample_size, realized_items, open_items, sale_count, trade_count,
    median_net_profit, median_roi, dom_sample_size, median_days_on_market, holding_sample_size, median_holding_days, historical_item_count,
    CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
    CASE
      WHEN realized_items = 0 THEN 'no realized evidence'
      WHEN realized_items <= 2 THEN 'insufficient realized evidence'
      WHEN realized_items <= 5 THEN 'low realized evidence'
      WHEN realized_items <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
    CASE
      WHEN realized_items = 0 THEN 'No realized items yet'
      WHEN realized_items = 1 THEN 'Only 1 realized item'
      WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
      WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
      WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
      WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
      ELSE 'Stronger evidence'
    END AS confidence_warning
  FROM d_scored
),

-- Query D2 -> decision_ready_by_acquisition_method
d2_agg AS (
  SELECT
    brand_label,
    acquisition_method,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count
  FROM eligible
  GROUP BY brand_label, acquisition_method
  HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3
),
d2_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM d2_agg
),
d2_rows AS (
  SELECT
    brand_label AS brand_name, acquisition_method,
    sample_size, realized_items, open_items, sale_count, trade_count,
    median_net_profit, median_roi, dom_sample_size, median_days_on_market, holding_sample_size, median_holding_days, historical_item_count,
    CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
    CASE
      WHEN realized_items = 0 THEN 'no realized evidence'
      WHEN realized_items <= 2 THEN 'insufficient realized evidence'
      WHEN realized_items <= 5 THEN 'low realized evidence'
      WHEN realized_items <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
    CASE
      WHEN realized_items = 0 THEN 'No realized items yet'
      WHEN realized_items = 1 THEN 'Only 1 realized item'
      WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
      WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
      WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
      WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
      ELSE 'Stronger evidence'
    END AS confidence_warning
  FROM d2_scored
),

-- Query E1 -> open_listed_inventory
e1_listed_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status = 'listed'
),
e1_listed_full AS (
  SELECT
    brand_label,
    COUNT(*)                                                    AS listed_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS listed_acquisition_capital,
    SUM(estimated_sold_value)                                   AS listed_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)        AS estimated_upside_missing_count
  FROM e1_listed_items
  GROUP BY brand_label
),
e1_dom_eligible AS (
  SELECT * FROM e1_listed_items WHERE NOT has_lifecycle_date_issue
),
e1_dom_summary AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)        AS median_current_days_on_market,
    MAX(global_days_on_market)                                 AS max_current_days_on_market,
    COUNT(*) FILTER (WHERE global_days_on_market >= 60)        AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE global_days_on_market >= 120)       AS items_dom_120_plus
  FROM e1_dom_eligible
  GROUP BY brand_label
),
e1_holding_eligible AS (
  SELECT * FROM e1_listed_items WHERE NOT has_lifecycle_date_issue AND NOT is_historical_import
),
e1_holding_summary AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL) AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)        AS median_holding_days
  FROM e1_holding_eligible
  GROUP BY brand_label
),
e1_holding_excluded AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL) AS holding_excluded_historical_count
  FROM e1_dom_eligible
  GROUP BY brand_label
),
e1_rows AS (
  SELECT
    lf.brand_label AS brand_name,
    lf.listed_item_count,
    lf.listed_acquisition_capital,
    lf.listed_estimated_value,
    CASE
      WHEN lf.listed_estimated_value IS NOT NULL AND lf.acquisition_for_upside IS NOT NULL
      THEN lf.listed_estimated_value - lf.acquisition_for_upside - COALESCE(lf.item_expenses_for_upside, 0)
      ELSE NULL
    END AS listed_estimated_net_upside,
    COALESCE(ds.dom_sample_size, 0)                      AS dom_sample_size,
    ROUND(ds.median_current_days_on_market::numeric, 2) AS median_current_days_on_market,
    ds.max_current_days_on_market,
    COALESCE(ds.items_dom_60_plus, 0)  AS items_dom_60_plus,
    COALESCE(ds.items_dom_120_plus, 0) AS items_dom_120_plus,
    COALESCE(hs.holding_sample_size, 0) AS holding_sample_size,
    ROUND(hs.median_holding_days::numeric, 2) AS median_holding_days,
    COALESCE(he.holding_excluded_historical_count, 0) AS holding_excluded_historical_count,
    lf.estimated_upside_missing_count
  FROM e1_listed_full lf
  LEFT JOIN e1_dom_summary ds      ON ds.brand_label = lf.brand_label
  LEFT JOIN e1_holding_summary hs  ON hs.brand_label = lf.brand_label
  LEFT JOIN e1_holding_excluded he ON he.brand_label = lf.brand_label
),

-- Query E2 -> open_unlisted_inventory
e2_unlisted_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status <> 'listed'
),
e2_unlisted_full AS (
  SELECT
    brand_label,
    COUNT(*)                                                    AS unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS unlisted_acquisition_capital,
    SUM(estimated_sold_value)                                   AS unlisted_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)        AS estimated_upside_missing_count
  FROM e2_unlisted_items
  GROUP BY brand_label
),
e2_reliable AS (
  SELECT * FROM e2_unlisted_items WHERE NOT has_lifecycle_date_issue AND NOT is_historical_import
),
e2_reliable_summary AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL)         AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)                AS median_ownership_age_days,
    MAX(holding_days)                                         AS max_ownership_age_days
  FROM e2_reliable
  GROUP BY brand_label
),
e2_excluded AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL) AS historical_excluded_from_age_count
  FROM e2_unlisted_items
  WHERE NOT has_lifecycle_date_issue
  GROUP BY brand_label
),
e2_rows AS (
  SELECT
    uf.brand_label AS brand_name,
    uf.unlisted_item_count,
    uf.unlisted_acquisition_capital,
    uf.unlisted_estimated_value,
    CASE
      WHEN uf.unlisted_estimated_value IS NOT NULL AND uf.acquisition_for_upside IS NOT NULL
      THEN uf.unlisted_estimated_value - uf.acquisition_for_upside - COALESCE(uf.item_expenses_for_upside, 0)
      ELSE NULL
    END AS unlisted_estimated_net_upside,
    COALESCE(rs.holding_sample_size, 0)             AS holding_sample_size,
    ROUND(rs.median_ownership_age_days::numeric, 2) AS median_ownership_age_days,
    rs.max_ownership_age_days,
    COALESCE(ex.historical_excluded_from_age_count, 0) AS historical_excluded_from_age_count,
    uf.estimated_upside_missing_count
  FROM e2_unlisted_full uf
  LEFT JOIN e2_reliable_summary rs ON rs.brand_label = uf.brand_label
  LEFT JOIN e2_excluded ex         ON ex.brand_label = uf.brand_label
),

-- Query F -> cohort_comparison
f_combined AS (
  SELECT 'All eligible Business items' AS population_label,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  UNION ALL
  SELECT 'Imported historical Business items' AS population_label,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  WHERE is_historical_import
  UNION ALL
  SELECT 'App-tracked Business items' AS population_label,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  WHERE NOT is_historical_import
),
f_agg AS (
  SELECT
    population_label,
    brand_label,
    COUNT(*)                            AS sample_size,
    COUNT(*) FILTER (WHERE is_realized) AS realized_items,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM f_combined
  GROUP BY population_label, brand_label
),
f_qualifying_brands AS (
  SELECT DISTINCT brand_label
  FROM f_agg
  WHERE sample_size >= 3 AND realized_items >= 3
),
f_scored AS (
  SELECT
    *,
    CASE WHEN sample_size <= 2 THEN 0 WHEN sample_size <= 5 THEN 1 WHEN sample_size <= 9 THEN 2 ELSE 3 END AS sample_tier,
    CASE WHEN realized_items <= 2 THEN 0 WHEN realized_items <= 5 THEN 1 WHEN realized_items <= 9 THEN 2 ELSE 3 END AS realized_tier
  FROM f_agg
  WHERE brand_label IN (SELECT brand_label FROM f_qualifying_brands)
),
f_rows AS (
  SELECT
    population_label,
    brand_label AS brand_name,
    sample_size, realized_items, median_net_profit, median_roi, dom_sample_size, median_days_on_market,
    holding_sample_size, median_holding_days,
    CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence
  FROM f_scored
),

-- Query I -> capital_concentration
i_brand_capital AS (
  SELECT
    brand_label,
    SUM(acquisition_value)                                                                   AS brand_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized)                                     AS open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed')       AS listed_open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed')      AS unlisted_open_capital
  FROM eligible
  GROUP BY brand_label
),
i_totals AS (
  SELECT
    SUM(brand_capital)         AS total_capital,
    SUM(open_capital)          AS total_open_capital,
    SUM(listed_open_capital)   AS total_listed_open_capital,
    SUM(unlisted_open_capital) AS total_unlisted_open_capital
  FROM i_brand_capital
),
i_ranked AS (
  SELECT
    *,
    SUM(brand_capital) OVER (ORDER BY brand_capital DESC, brand_label ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_capital
  FROM i_brand_capital
),
i_rows AS (
  SELECT
    r.brand_label AS brand_name,
    t.total_capital                                                                    AS total_business_acquisition_capital,
    r.brand_capital                                                                    AS acquisition_capital,
    ROUND(r.brand_capital::numeric / NULLIF(t.total_capital, 0) * 100, 2)              AS brand_share_of_total_capital_percent,
    ROUND(r.cumulative_capital::numeric / NULLIF(t.total_capital, 0) * 100, 2)         AS cumulative_capital_share_percent,
    r.open_capital,
    ROUND(r.open_capital::numeric / NULLIF(t.total_open_capital, 0) * 100, 2)          AS open_capital_share_percent,
    r.listed_open_capital,
    ROUND(r.listed_open_capital::numeric / NULLIF(t.total_listed_open_capital, 0) * 100, 2)   AS listed_open_capital_share_percent,
    r.unlisted_open_capital,
    ROUND(r.unlisted_open_capital::numeric / NULLIF(t.total_unlisted_open_capital, 0) * 100, 2) AS unlisted_open_capital_share_percent
  FROM i_ranked r
  CROSS JOIN i_totals t
),

-- Query H2 -> integrity_summary
h2_flagged AS (
  SELECT
    *,
    COALESCE(days_acquisition_to_first_listing < 0, false) AS acquisition_to_listing_is_negative,
    COALESCE(
      global_days_on_market IS NOT NULL
      AND holding_days IS NOT NULL
      AND global_days_on_market > holding_days,
      false
    ) AS dom_exceeds_holding_days,
    COALESCE(
      is_realized
      AND first_listed_at IS NOT NULL
      AND exit_date IS NOT NULL
      AND global_days_on_market IS NOT NULL
      AND (exit_date - first_listed_at) <> global_days_on_market,
      false
    ) AS realized_dom_date_mismatch
  FROM eligible
),
h2_row AS (
  SELECT
    COUNT(*)                                                                                   AS item_count,
    COUNT(DISTINCT brand_label)                                                                 AS distinct_brand_count,
    COUNT(*) FILTER (WHERE brand_label = 'Unknown brand')                                       AS unknown_brand_item_count,
    (SELECT COUNT(*) FROM (SELECT item_id FROM h2_flagged GROUP BY item_id HAVING COUNT(*) > 1) dup) AS duplicate_item_id_count,
    COUNT(*) FILTER (WHERE acquisition_to_listing_is_negative)                                   AS negative_acquisition_to_listing_count,
    COUNT(*) FILTER (WHERE dom_exceeds_holding_days)                                             AS dom_exceeds_holding_count,
    COUNT(*) FILTER (WHERE realized_dom_date_mismatch)                                           AS realized_dom_date_mismatch_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)                        AS realized_items_missing_dom_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL) AS open_listed_items_missing_dom_count
  FROM h2_flagged
)

SELECT jsonb_build_object(
  'population_summary',                        (SELECT COALESCE(jsonb_agg(to_jsonb(a1_row)), '[]'::jsonb) FROM a1_row),
  'fragmentation_summary',                     (SELECT COALESCE(jsonb_agg(to_jsonb(a2_rows) ORDER BY bucket_order), '[]'::jsonb) FROM a2_rows),
  'brand_quality_audit',                       (SELECT COALESCE(jsonb_agg(to_jsonb(a3_rows) ORDER BY issue_type, brand_name), '[]'::jsonb) FROM a3_rows),
  'overall_performance',                       (SELECT COALESCE(jsonb_agg((to_jsonb(b_rows) - 'sample_tier' - 'realized_tier') ORDER BY LEAST(sample_tier, realized_tier) DESC, realized_items DESC, median_net_profit DESC NULLS LAST), '[]'::jsonb) FROM b_rows),
  'decision_ready_performance',                (SELECT COALESCE(jsonb_agg((to_jsonb(b2_rows) - 'sample_tier' - 'realized_tier') ORDER BY LEAST(sample_tier, realized_tier) DESC, realized_items DESC, typical_profit_per_item DESC NULLS LAST), '[]'::jsonb) FROM b2_rows),
  'by_acquisition_value_band',                 (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY brand_name, acquisition_value_band_order), '[]'::jsonb) FROM c_rows),
  'decision_ready_by_acquisition_value_band',  (SELECT COALESCE(jsonb_agg(to_jsonb(c2_rows) ORDER BY brand_name, acquisition_value_band_order), '[]'::jsonb) FROM c2_rows),
  'by_acquisition_method',                     (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY brand_name, acquisition_method), '[]'::jsonb) FROM d_rows),
  'decision_ready_by_acquisition_method',      (SELECT COALESCE(jsonb_agg(to_jsonb(d2_rows) ORDER BY brand_name, acquisition_method), '[]'::jsonb) FROM d2_rows),
  'open_listed_inventory',                     (SELECT COALESCE(jsonb_agg(to_jsonb(e1_rows) ORDER BY listed_acquisition_capital DESC NULLS LAST), '[]'::jsonb) FROM e1_rows),
  'open_unlisted_inventory',                   (SELECT COALESCE(jsonb_agg(to_jsonb(e2_rows) ORDER BY unlisted_acquisition_capital DESC NULLS LAST), '[]'::jsonb) FROM e2_rows),
  'cohort_comparison',                         (SELECT COALESCE(jsonb_agg(to_jsonb(f_rows) ORDER BY brand_name, population_label), '[]'::jsonb) FROM f_rows),
  'capital_concentration',                     (SELECT COALESCE(jsonb_agg(to_jsonb(i_rows) ORDER BY acquisition_capital DESC NULLS LAST, brand_name), '[]'::jsonb) FROM i_rows),
  'integrity_summary',                         (SELECT COALESCE(jsonb_agg(to_jsonb(h2_row)), '[]'::jsonb) FROM h2_row)
);
$$;

REVOKE ALL ON FUNCTION public._build_brand_snapshot_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_brand_snapshot_v1() FROM anon;
REVOKE ALL ON FUNCTION public._build_brand_snapshot_v1() FROM authenticated;


-- ============================================================================
-- 4. public._build_recommendation_candidates_snapshot_v1(p_recommendation_target_user_id int)
-- recommendation_candidates.open_business_items. This is a FACTUAL CANDIDATE
-- DATASET ONLY — no recommendation type (reprice/list/relist/trade
-- out/bundle) is produced here or anywhere in this migration.
--
-- Eligibility: analytics_item_lifecycle.user_id = p_recommendation_target_user_id
-- AND purpose_name = 'Business' AND is_realized = false. Includes both
-- listed and owned/unlisted items.
--
-- Fields included (every one inspected against the lifecycle view before
-- use, not assumed) and why: item_id, item_display_name, brand_id/brand_name,
-- category_id/category_name, type_id/type_name (shared lookup identifiers,
-- not personal data), current_status (listed/owned state), acquisition_method,
-- acquisition_value, estimated_sold_value, item_expenses_total,
-- estimated_net_upside (derived: estimated_sold_value - acquisition_value -
-- item_expenses_total, NULL if either input is NULL — same formula as the
-- manual files' E1/E2/H sections), first_listed_at, current_days_on_market
-- (global_days_on_market — DOM, measured from first_listed_at),
-- ownership_age_days (holding_days, but ONLY when NOT is_historical_import —
-- acquisition_date is the one approximate field for historical imports, so
-- an "ownership age" derived from it is never presented as reliable for
-- those items), is_historical_import, and the three listing-channel dates
-- the view already exposes (marketplace/kijiji/reverb_listed_at).
--
-- Fields deliberately EXCLUDED: any OTHER user's data (the WHERE clause
-- guarantees only p_recommendation_target_user_id's own rows are read in
-- the first place), user_id itself (redundant — the target is already the
-- snapshot's top-level recommendation_target_user_id), serial_number,
-- notes, photo storage paths, created_at/updated_at audit metadata (none of
-- these are exposed by analytics_item_lifecycle in the first place, so
-- nothing extra needs to be stripped here — the view's own column set
-- already excludes them).
--
-- Ordering (deterministic): listed items before unlisted, current DOM
-- descending within listed, reliable ownership age descending within
-- unlisted, item_id as final tie-breaker.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_recommendation_candidates_snapshot_v1(
  p_recommendation_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH candidates AS (
  SELECT *
  FROM analytics_item_lifecycle
  WHERE user_id = p_recommendation_target_user_id
    AND purpose_name = 'Business'
    AND NOT is_realized
),
rows AS (
  SELECT
    item_id,
    item_display_name,
    brand_id,
    brand_name,
    category_id,
    category_name,
    type_id,
    type_name,
    current_status,
    acquisition_method,
    acquisition_value,
    estimated_sold_value,
    item_expenses_total,
    CASE
      WHEN estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL
      THEN estimated_sold_value - acquisition_value - item_expenses_total
      ELSE NULL
    END AS estimated_net_upside,
    first_listed_at,
    global_days_on_market AS current_days_on_market,
    CASE WHEN NOT is_historical_import THEN holding_days ELSE NULL END AS ownership_age_days,
    is_historical_import,
    marketplace_listed_at,
    kijiji_listed_at,
    reverb_listed_at
  FROM candidates
)
SELECT COALESCE(
  jsonb_agg(
    to_jsonb(rows)
    ORDER BY
      (current_status = 'listed') DESC,
      COALESCE(current_days_on_market, -1) DESC,
      COALESCE(ownership_age_days, -1) DESC,
      item_id ASC
  ),
  '[]'::jsonb
)
FROM rows;
$$;

REVOKE ALL ON FUNCTION public._build_recommendation_candidates_snapshot_v1(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_recommendation_candidates_snapshot_v1(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_recommendation_candidates_snapshot_v1(int) FROM authenticated;


-- ============================================================================
-- 5. public.build_analytics_snapshot_v1(p_recommendation_target_user_id int)
-- Top-level callable function. Validates the target, then assembles the
-- stable snapshot contract:
--
-- {
--   "snapshot_schema_version": "1.0",
--   "analytics_definition_version": "1.0",
--   "generated_at": "...",
--   "evidence_scope": "shared_business_population",
--   "recommendation_target_user_id": <int>,
--   "evidence_aggregates": {
--     "acquisition_value_band": { ... 14 keys, see function 1 above ... },
--     "acquisition_to_exit":    { ... 9 keys, see function 2 above ... },
--     "brand":                  { ... 14 keys, see function 3 above ... }
--   },
--   "recommendation_candidates": {
--     "open_business_items": [ ... ]
--   }
-- }
--
-- requested_by_user_id, run status, and error_message are deliberately NOT
-- part of this contract — those are analytics_runs metadata (Phase 2 Step 1
-- / Step 3), not analytical content. No JSON structure beyond this
-- top-level shape is enforced by the database — the shape of each
-- evidence_aggregates/recommendation_candidates value is documented above
-- and in analytics/SEMANTIC_CONTRACT.md, not schema-validated in SQL.
--
-- generated_at uses now() (the transaction timestamp, stable for the whole
-- call), not clock_timestamp(), specifically so every part of one snapshot
-- — evidence and candidates alike — shares the exact same instant, per the
-- "one generated_at value for the entire snapshot" requirement.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v1(
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
BEGIN
  IF p_recommendation_target_user_id IS NULL THEN
    RAISE EXCEPTION 'build_analytics_snapshot_v1: p_recommendation_target_user_id must not be NULL';
  END IF;

  SELECT COUNT(*) INTO v_target_count
  FROM public.app_users
  WHERE id = p_recommendation_target_user_id;

  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'build_analytics_snapshot_v1: expected exactly 1 app_users row for id % (recommendation target), found %',
      p_recommendation_target_user_id, v_target_count;
  END IF;

  RETURN jsonb_build_object(
    'snapshot_schema_version', '1.0',
    'analytics_definition_version', '1.0',
    'generated_at', to_jsonb(v_generated_at),
    'evidence_scope', 'shared_business_population',
    'recommendation_target_user_id', p_recommendation_target_user_id,
    'evidence_aggregates', jsonb_build_object(
      'acquisition_value_band', public._build_acquisition_value_band_snapshot_v1(),
      'acquisition_to_exit',    public._build_acquisition_to_exit_snapshot_v1(),
      'brand',                  public._build_brand_snapshot_v1()
    ),
    'recommendation_candidates', jsonb_build_object(
      'open_business_items', public._build_recommendation_candidates_snapshot_v1(p_recommendation_target_user_id)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v1(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v1(int) TO service_role;

-- Helpers are also usable only by service_role, for the same reason as the
-- top-level function (see SECURITY MODEL at the top of this file) — this
-- is defense in depth, not a second public entry point: nothing calls these
-- four directly except build_analytics_snapshot_v1 itself.
GRANT EXECUTE ON FUNCTION public._build_acquisition_value_band_snapshot_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public._build_acquisition_to_exit_snapshot_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public._build_brand_snapshot_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public._build_recommendation_candidates_snapshot_v1(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v1(int) IS
  'Phase 2 Step 2 analytics snapshot builder. SECURITY INVOKER, service_role '
  'execution only. Computes evidence_aggregates over the full shared '
  'Business population visible to the calling role plus '
  'recommendation_candidates restricted to the given '
  'recommendation_target_user_id (validated against app_users; NULL or '
  'unknown IDs raise an exception). Persists nothing — see analytics_runs '
  '(20260727000000) for the future persistence step. See '
  'analytics/README.md and analytics/SEMANTIC_CONTRACT.md.';
