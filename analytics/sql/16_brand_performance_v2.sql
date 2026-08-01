-- ============================================================================
-- 16_brand_performance_v2.sql
--
-- Purpose-aware v2 port of 03_brand_performance.sql. See
-- public._build_inventory_segmentation_snapshot_v2(int)
-- (supabase/migrations/20260815000000_build_analytics_snapshot_v2_4.sql)
-- for the actual transformation; nothing in this file creates a database
-- object and nothing here writes to production data.
--
-- ── WHAT CHANGED FROM v1 ──────────────────────────────────────────────────
-- Population is analytics_item_lifecycle_v2's FULL population — Business,
-- Hybrid, Personal, missing_purpose, missing_policy — instead of
-- `purpose_name = 'Business'`. Every section below is produced twice: once
-- pooled across ALL purposes, once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status), using the SAME missing-
-- purpose/missing-policy collapsing rule as every other v2 module (a
-- missing-purpose item's current_purpose_id/name are NULLed before
-- grouping, so all such items collapse into ONE missing_purpose row; same
-- for missing_policy, regardless of which unmapped Purpose it is).
--
-- ── WHAT DID NOT CHANGE ───────────────────────────────────────────────────
-- Acquisition value bands, the zero/unknown/negative_invalid distinction,
-- ROI requiring a positive acquisition value, Historical Import inclusion
-- in profit/ROI/DOM/brand/category evidence with exclusion ONLY from
-- holding_days-based metrics, "Unknown brand" grouping for NULL/blank
-- brand_name, and the dual sample/realized confidence-tier convention
-- (sample_confidence / realized_confidence / overall_confidence =
-- LEAST(sample_tier, realized_tier) / confidence_warning) are all copied
-- verbatim from 03_brand_performance.sql.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- Ports population coverage (Query A1's core reconciliation counts),
-- overall brand performance (Query B, with Query B2's "decision-ready"
-- filter folded into a `decision_ready` boolean on every row instead of a
-- separate duplicate query), brand x acquisition value band (Query C, with
-- Query C2 folded in the same way), open inventory by brand (Query E1 +
-- E2 merged via a `listing_status` dimension: 'listed' | 'unlisted' — DOM
-- fields are structurally NULL/0 for 'unlisted' rows, matching E2's own
-- "no DOM here at all" rule), and brand capital concentration (Query I).
--
-- NOT ported (see the migration file's own header for the full
-- classification and rationale for each):
--   Query A2 (brand coverage distribution / bucket histogram) — production
--     evidence, but redundant with per-brand sample_size already visible
--     in performance_by_brand.
--   Query A3 (brands lookup-table data-quality audit) — reclassified as a
--     developer/data-hygiene diagnostic; audits the shared `brands` table
--     itself, not Purpose-scoped economic evidence.
--   Query D + D2 (brand x acquisition method) — production evidence, but
--     secondary to the two headline cuts ported here.
--   Query F (cohort comparison: imported historical vs. app-tracked, by
--     brand) — superseded by the historical_item_count /
--     non_historical_item_count fields present on every section below.
--   Query G (results by user), Query H (item-level drilldown), Query H2
--     (H's integrity rollup) — developer-only diagnostics per 03's own
--     classification index; G/H would also violate this module's no-
--     cross-user-identity-exposure rule if ported to shared evidence.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_inventory_segmentation_evidence.brand_performance
WITH all_items AS (
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
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM public.analytics_item_lifecycle_v2
),
bs_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'negative_invalid')          AS negative_acquisition_item_count,
    COUNT(DISTINCT brand_label)                                                    AS distinct_brand_count,
    COUNT(*) FILTER (WHERE brand_label = 'Unknown brand')                          AS unknown_brand_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS realized_dom_usable_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)          AS realized_dom_missing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NOT NULL) AS open_listed_dom_usable_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL)     AS open_listed_dom_missing_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_item_count
  FROM all_items
),
bs_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'negative_invalid')          AS negative_acquisition_item_count,
    COUNT(DISTINCT brand_label)                                                    AS distinct_brand_count,
    COUNT(*) FILTER (WHERE brand_label = 'Unknown brand')                          AS unknown_brand_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS realized_dom_usable_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)          AS realized_dom_missing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NOT NULL) AS open_listed_dom_usable_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL)     AS open_listed_dom_missing_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_brand / performance_by_brand_by_purpose (Query B, with
-- Query B2's decision-ready filter folded into a `decision_ready` flag)
bs_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
bs_perf_rows AS (
  SELECT
    brand_label AS brand_name,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bs_eligible
  GROUP BY brand_label
),
bs_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    brand_label AS brand_name,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, brand_label
),

-- performance_by_brand_and_acquisition_band / ..._by_purpose (Query C, with
-- Query C2's decision-ready filter folded into `decision_ready`)
bs_band_rows AS (
  SELECT
    brand_label AS brand_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bs_eligible
  GROUP BY brand_label, acquisition_value_band_order, acquisition_value_band_label
),
bs_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    brand_label AS brand_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, brand_label, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_brand / ..._by_purpose (Query E1 + E2 merged via a
-- `listing_status` dimension — DOM fields are structurally NULL/0 for
-- 'unlisted' rows, matching E2's own "no DOM here at all" rule)
bs_open_base AS (
  SELECT
    *,
    CASE WHEN current_status = 'listed' THEN 'listed' ELSE 'unlisted' END AS listing_status
  FROM all_items
  WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),
bs_open_rows AS (
  SELECT
    listing_status,
    brand_label AS brand_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS acquisition_capital,
    SUM(estimated_sold_value)                                                      AS estimated_value,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_net_upside,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) ELSE 0 END AS dom_sample_size,
    CASE WHEN listing_status = 'listed' THEN ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) ELSE NULL END AS median_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN MAX(global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue) ELSE NULL END AS max_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 60) ELSE 0 END AS items_dom_60_plus,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 120) ELSE 0 END AS items_dom_120_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    MAX(holding_days) FILTER (WHERE NOT is_historical_import AND NOT has_lifecycle_date_issue) AS max_ownership_age_days,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS historical_excluded_from_age_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                         AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS acquisition_value_unknown_count
  FROM bs_open_base
  GROUP BY listing_status, brand_label
),
bs_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_status,
    brand_label AS brand_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS acquisition_capital,
    SUM(estimated_sold_value)                                                      AS estimated_value,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_net_upside,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) ELSE 0 END AS dom_sample_size,
    CASE WHEN listing_status = 'listed' THEN ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) ELSE NULL END AS median_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN MAX(global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue) ELSE NULL END AS max_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 60) ELSE 0 END AS items_dom_60_plus,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 120) ELSE 0 END AS items_dom_120_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    MAX(holding_days) FILTER (WHERE NOT is_historical_import AND NOT has_lifecycle_date_issue) AS max_ownership_age_days,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS historical_excluded_from_age_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                         AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS acquisition_value_unknown_count
  FROM bs_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_status, brand_label
),

-- capital_concentration_by_brand / ..._by_purpose (Query I)
bs_cap_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
bs_cap_agg AS (
  SELECT
    brand_label,
    SUM(acquisition_value)                                                                AS brand_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized)                                  AS open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed')    AS listed_open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed')   AS unlisted_open_capital
  FROM bs_cap_eligible
  GROUP BY brand_label
),
bs_cap_totals AS (
  SELECT
    SUM(brand_capital)         AS total_capital,
    SUM(open_capital)          AS total_open_capital,
    SUM(listed_open_capital)   AS total_listed_open_capital,
    SUM(unlisted_open_capital) AS total_unlisted_open_capital
  FROM bs_cap_agg
),
bs_cap_ranked AS (
  SELECT *, SUM(brand_capital) OVER (ORDER BY brand_capital DESC, brand_label ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_capital
  FROM bs_cap_agg
),
bs_cap_rows AS (
  SELECT
    ranked.brand_label                                                                     AS brand_name,
    totals.total_capital                                                                    AS total_acquisition_capital,
    ranked.brand_capital                                                                    AS acquisition_capital,
    ROUND(ranked.brand_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)         AS brand_share_of_total_capital_percent,
    ROUND(ranked.cumulative_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)    AS cumulative_capital_share_percent,
    ranked.open_capital,
    ROUND(ranked.open_capital::numeric / NULLIF(totals.total_open_capital, 0) * 100, 2)     AS open_capital_share_percent,
    ranked.listed_open_capital,
    ROUND(ranked.listed_open_capital::numeric / NULLIF(totals.total_listed_open_capital, 0) * 100, 2)   AS listed_open_capital_share_percent,
    ranked.unlisted_open_capital,
    ROUND(ranked.unlisted_open_capital::numeric / NULLIF(totals.total_unlisted_open_capital, 0) * 100, 2) AS unlisted_open_capital_share_percent
  FROM bs_cap_ranked ranked
  CROSS JOIN bs_cap_totals totals
),
bs_cap_purpose_agg AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    brand_label,
    SUM(acquisition_value)                                                                AS brand_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized)                                  AS open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed')    AS listed_open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed')   AS unlisted_open_capital
  FROM bs_cap_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, brand_label
),
bs_cap_purpose_totals AS (
  SELECT
    current_purpose_id, current_purpose_name, purpose_policy_status,
    SUM(brand_capital)         AS total_capital,
    SUM(open_capital)          AS total_open_capital,
    SUM(listed_open_capital)   AS total_listed_open_capital,
    SUM(unlisted_open_capital) AS total_unlisted_open_capital
  FROM bs_cap_purpose_agg
  GROUP BY current_purpose_id, current_purpose_name, purpose_policy_status
),
bs_cap_purpose_ranked AS (
  SELECT *, SUM(brand_capital) OVER (PARTITION BY current_purpose_id, purpose_policy_status ORDER BY brand_capital DESC, brand_label ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_capital
  FROM bs_cap_purpose_agg
),
bs_cap_purpose_rows AS (
  SELECT
    ranked.current_purpose_id, ranked.current_purpose_name, ranked.purpose_policy_status,
    ranked.brand_label                                                                     AS brand_name,
    totals.total_capital                                                                    AS total_acquisition_capital,
    ranked.brand_capital                                                                    AS acquisition_capital,
    ROUND(ranked.brand_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)         AS brand_share_of_total_capital_percent,
    ROUND(ranked.cumulative_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)    AS cumulative_capital_share_percent,
    ranked.open_capital,
    ROUND(ranked.open_capital::numeric / NULLIF(totals.total_open_capital, 0) * 100, 2)     AS open_capital_share_percent,
    ranked.listed_open_capital,
    ROUND(ranked.listed_open_capital::numeric / NULLIF(totals.total_listed_open_capital, 0) * 100, 2)   AS listed_open_capital_share_percent,
    ranked.unlisted_open_capital,
    ROUND(ranked.unlisted_open_capital::numeric / NULLIF(totals.total_unlisted_open_capital, 0) * 100, 2) AS unlisted_open_capital_share_percent
  FROM bs_cap_purpose_ranked ranked
  JOIN bs_cap_purpose_totals totals
    ON totals.current_purpose_id IS NOT DISTINCT FROM ranked.current_purpose_id
   AND totals.purpose_policy_status = ranked.purpose_policy_status
)
SELECT jsonb_build_object(
      'population_summary',                          (SELECT COALESCE(jsonb_agg(to_jsonb(bs_pop_row)), '[]'::jsonb) FROM bs_pop_row),
      'purpose_population_summary',                   (SELECT COALESCE(jsonb_agg(to_jsonb(bs_pop_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST), '[]'::jsonb) FROM bs_pop_purpose_rows),
      'performance_by_brand',                         (SELECT COALESCE(jsonb_agg(to_jsonb(bs_perf_rows) ORDER BY brand_name), '[]'::jsonb) FROM bs_perf_rows),
      'performance_by_brand_by_purpose',               (SELECT COALESCE(jsonb_agg(to_jsonb(bs_perf_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, brand_name), '[]'::jsonb) FROM bs_perf_purpose_rows),
      'performance_by_brand_and_acquisition_band',     (SELECT COALESCE(jsonb_agg(to_jsonb(bs_band_rows) ORDER BY brand_name, acquisition_value_band_order), '[]'::jsonb) FROM bs_band_rows),
      'performance_by_brand_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(bs_band_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, brand_name, acquisition_value_band_order), '[]'::jsonb) FROM bs_band_purpose_rows),
      'open_inventory_by_brand',                      (SELECT COALESCE(jsonb_agg(to_jsonb(bs_open_rows) ORDER BY brand_name, listing_status), '[]'::jsonb) FROM bs_open_rows),
      'open_inventory_by_brand_by_purpose',            (SELECT COALESCE(jsonb_agg(to_jsonb(bs_open_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, brand_name, listing_status), '[]'::jsonb) FROM bs_open_purpose_rows),
      'capital_concentration_by_brand',                (SELECT COALESCE(jsonb_agg(to_jsonb(bs_cap_rows) ORDER BY acquisition_capital DESC NULLS LAST, brand_name), '[]'::jsonb) FROM bs_cap_rows),
      'capital_concentration_by_brand_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(bs_cap_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, acquisition_capital DESC NULLS LAST, brand_name), '[]'::jsonb) FROM bs_cap_purpose_rows)
);

-- ============================================================================
-- Query B -> target_user_inventory_segmentation_evidence.brand_performance
-- ============================================================================
WITH all_items AS (
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
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
bt_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'negative_invalid')          AS negative_acquisition_item_count,
    COUNT(DISTINCT brand_label)                                                    AS distinct_brand_count,
    COUNT(*) FILTER (WHERE brand_label = 'Unknown brand')                          AS unknown_brand_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS realized_dom_usable_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)          AS realized_dom_missing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NOT NULL) AS open_listed_dom_usable_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL)     AS open_listed_dom_missing_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_item_count
  FROM all_items
),
bt_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'negative_invalid')          AS negative_acquisition_item_count,
    COUNT(DISTINCT brand_label)                                                    AS distinct_brand_count,
    COUNT(*) FILTER (WHERE brand_label = 'Unknown brand')                          AS unknown_brand_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS realized_dom_usable_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)          AS realized_dom_missing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NOT NULL) AS open_listed_dom_usable_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL)     AS open_listed_dom_missing_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS non_historical_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_brand / performance_by_brand_by_purpose (Query B, with
-- Query B2's decision-ready filter folded into a `decision_ready` flag)
bt_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
bt_perf_rows AS (
  SELECT
    brand_label AS brand_name,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bt_eligible
  GROUP BY brand_label
),
bt_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    brand_label AS brand_name,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, brand_label
),

-- performance_by_brand_and_acquisition_band / ..._by_purpose (Query C, with
-- Query C2's decision-ready filter folded into `decision_ready`)
bt_band_rows AS (
  SELECT
    brand_label AS brand_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bt_eligible
  GROUP BY brand_label, acquisition_value_band_order, acquisition_value_band_label
),
bt_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    brand_label AS brand_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    (COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3)            AS decision_ready,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger'
    END AS sample_confidence,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) = 0 THEN 'no realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low realized evidence'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate realized evidence'
      ELSE 'stronger realized evidence'
    END AS realized_confidence,
    CASE LEAST(
      CASE WHEN COUNT(*) <= 2 THEN 0 WHEN COUNT(*) <= 5 THEN 1 WHEN COUNT(*) <= 9 THEN 2 ELSE 3 END,
      CASE WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 0 WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 1 WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 2 ELSE 3 END
    )
      WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger'
    END AS overall_confidence
  FROM bt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, brand_label, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_brand / ..._by_purpose (Query E1 + E2 merged via a
-- `listing_status` dimension — DOM fields are structurally NULL/0 for
-- 'unlisted' rows, matching E2's own "no DOM here at all" rule)
bt_open_base AS (
  SELECT
    *,
    CASE WHEN current_status = 'listed' THEN 'listed' ELSE 'unlisted' END AS listing_status
  FROM all_items
  WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),
bt_open_rows AS (
  SELECT
    listing_status,
    brand_label AS brand_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS acquisition_capital,
    SUM(estimated_sold_value)                                                      AS estimated_value,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_net_upside,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) ELSE 0 END AS dom_sample_size,
    CASE WHEN listing_status = 'listed' THEN ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) ELSE NULL END AS median_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN MAX(global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue) ELSE NULL END AS max_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 60) ELSE 0 END AS items_dom_60_plus,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 120) ELSE 0 END AS items_dom_120_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    MAX(holding_days) FILTER (WHERE NOT is_historical_import AND NOT has_lifecycle_date_issue) AS max_ownership_age_days,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS historical_excluded_from_age_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                         AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS acquisition_value_unknown_count
  FROM bt_open_base
  GROUP BY listing_status, brand_label
),
bt_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_status,
    brand_label AS brand_name,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS acquisition_capital,
    SUM(estimated_sold_value)                                                      AS estimated_value,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_net_upside,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) ELSE 0 END AS dom_sample_size,
    CASE WHEN listing_status = 'listed' THEN ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) ELSE NULL END AS median_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN MAX(global_days_on_market) FILTER (WHERE NOT has_lifecycle_date_issue) ELSE NULL END AS max_current_days_on_market,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 60) ELSE 0 END AS items_dom_60_plus,
    CASE WHEN listing_status = 'listed' THEN COUNT(*) FILTER (WHERE NOT has_lifecycle_date_issue AND global_days_on_market >= 120) ELSE 0 END AS items_dom_120_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    MAX(holding_days) FILTER (WHERE NOT is_historical_import AND NOT has_lifecycle_date_issue) AS max_ownership_age_days,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS historical_excluded_from_age_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                         AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS acquisition_value_unknown_count
  FROM bt_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_status, brand_label
),

-- capital_concentration_by_brand / ..._by_purpose (Query I)
bt_cap_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
bt_cap_agg AS (
  SELECT
    brand_label,
    SUM(acquisition_value)                                                                AS brand_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized)                                  AS open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed')    AS listed_open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed')   AS unlisted_open_capital
  FROM bt_cap_eligible
  GROUP BY brand_label
),
bt_cap_totals AS (
  SELECT
    SUM(brand_capital)         AS total_capital,
    SUM(open_capital)          AS total_open_capital,
    SUM(listed_open_capital)   AS total_listed_open_capital,
    SUM(unlisted_open_capital) AS total_unlisted_open_capital
  FROM bt_cap_agg
),
bt_cap_ranked AS (
  SELECT *, SUM(brand_capital) OVER (ORDER BY brand_capital DESC, brand_label ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_capital
  FROM bt_cap_agg
),
bt_cap_rows AS (
  SELECT
    ranked.brand_label                                                                     AS brand_name,
    totals.total_capital                                                                    AS total_acquisition_capital,
    ranked.brand_capital                                                                    AS acquisition_capital,
    ROUND(ranked.brand_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)         AS brand_share_of_total_capital_percent,
    ROUND(ranked.cumulative_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)    AS cumulative_capital_share_percent,
    ranked.open_capital,
    ROUND(ranked.open_capital::numeric / NULLIF(totals.total_open_capital, 0) * 100, 2)     AS open_capital_share_percent,
    ranked.listed_open_capital,
    ROUND(ranked.listed_open_capital::numeric / NULLIF(totals.total_listed_open_capital, 0) * 100, 2)   AS listed_open_capital_share_percent,
    ranked.unlisted_open_capital,
    ROUND(ranked.unlisted_open_capital::numeric / NULLIF(totals.total_unlisted_open_capital, 0) * 100, 2) AS unlisted_open_capital_share_percent
  FROM bt_cap_ranked ranked
  CROSS JOIN bt_cap_totals totals
),
bt_cap_purpose_agg AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    brand_label,
    SUM(acquisition_value)                                                                AS brand_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized)                                  AS open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed')    AS listed_open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed')   AS unlisted_open_capital
  FROM bt_cap_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, brand_label
),
bt_cap_purpose_totals AS (
  SELECT
    current_purpose_id, current_purpose_name, purpose_policy_status,
    SUM(brand_capital)         AS total_capital,
    SUM(open_capital)          AS total_open_capital,
    SUM(listed_open_capital)   AS total_listed_open_capital,
    SUM(unlisted_open_capital) AS total_unlisted_open_capital
  FROM bt_cap_purpose_agg
  GROUP BY current_purpose_id, current_purpose_name, purpose_policy_status
),
bt_cap_purpose_ranked AS (
  SELECT *, SUM(brand_capital) OVER (PARTITION BY current_purpose_id, purpose_policy_status ORDER BY brand_capital DESC, brand_label ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_capital
  FROM bt_cap_purpose_agg
),
bt_cap_purpose_rows AS (
  SELECT
    ranked.current_purpose_id, ranked.current_purpose_name, ranked.purpose_policy_status,
    ranked.brand_label                                                                     AS brand_name,
    totals.total_capital                                                                    AS total_acquisition_capital,
    ranked.brand_capital                                                                    AS acquisition_capital,
    ROUND(ranked.brand_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)         AS brand_share_of_total_capital_percent,
    ROUND(ranked.cumulative_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)    AS cumulative_capital_share_percent,
    ranked.open_capital,
    ROUND(ranked.open_capital::numeric / NULLIF(totals.total_open_capital, 0) * 100, 2)     AS open_capital_share_percent,
    ranked.listed_open_capital,
    ROUND(ranked.listed_open_capital::numeric / NULLIF(totals.total_listed_open_capital, 0) * 100, 2)   AS listed_open_capital_share_percent,
    ranked.unlisted_open_capital,
    ROUND(ranked.unlisted_open_capital::numeric / NULLIF(totals.total_unlisted_open_capital, 0) * 100, 2) AS unlisted_open_capital_share_percent
  FROM bt_cap_purpose_ranked ranked
  JOIN bt_cap_purpose_totals totals
    ON totals.current_purpose_id IS NOT DISTINCT FROM ranked.current_purpose_id
   AND totals.purpose_policy_status = ranked.purpose_policy_status
)
SELECT jsonb_build_object(
      'population_summary',                          (SELECT COALESCE(jsonb_agg(to_jsonb(bt_pop_row)), '[]'::jsonb) FROM bt_pop_row),
      'purpose_population_summary',                   (SELECT COALESCE(jsonb_agg(to_jsonb(bt_pop_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST), '[]'::jsonb) FROM bt_pop_purpose_rows),
      'performance_by_brand',                         (SELECT COALESCE(jsonb_agg(to_jsonb(bt_perf_rows) ORDER BY brand_name), '[]'::jsonb) FROM bt_perf_rows),
      'performance_by_brand_by_purpose',               (SELECT COALESCE(jsonb_agg(to_jsonb(bt_perf_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, brand_name), '[]'::jsonb) FROM bt_perf_purpose_rows),
      'performance_by_brand_and_acquisition_band',     (SELECT COALESCE(jsonb_agg(to_jsonb(bt_band_rows) ORDER BY brand_name, acquisition_value_band_order), '[]'::jsonb) FROM bt_band_rows),
      'performance_by_brand_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(bt_band_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, brand_name, acquisition_value_band_order), '[]'::jsonb) FROM bt_band_purpose_rows),
      'open_inventory_by_brand',                      (SELECT COALESCE(jsonb_agg(to_jsonb(bt_open_rows) ORDER BY brand_name, listing_status), '[]'::jsonb) FROM bt_open_rows),
      'open_inventory_by_brand_by_purpose',            (SELECT COALESCE(jsonb_agg(to_jsonb(bt_open_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, brand_name, listing_status), '[]'::jsonb) FROM bt_open_purpose_rows),
      'capital_concentration_by_brand',                (SELECT COALESCE(jsonb_agg(to_jsonb(bt_cap_rows) ORDER BY acquisition_capital DESC NULLS LAST, brand_name), '[]'::jsonb) FROM bt_cap_rows),
      'capital_concentration_by_brand_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(bt_cap_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, acquisition_capital DESC NULLS LAST, brand_name), '[]'::jsonb) FROM bt_cap_purpose_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 03_brand_performance.sql: brand results are descriptive, not
-- causal; small samples (`overall_confidence` = insufficient/low) are
-- never a "best brands" ranking; `decision_ready` is a visibility flag
-- (sample_size >= 3 AND realized_items >= 3), not a recommendation.
-- Purpose breakdown rows are descriptive only — a Hybrid or Personal row's
-- realization_rate_percent is not an urgency signal or a recommendation.
