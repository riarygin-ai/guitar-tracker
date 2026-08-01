-- build_analytics_snapshot_v2_4
--
-- Analytics v2.4 — Inventory Segmentation. Ports two v1 modules to
-- Purpose-aware v2 semantics: Brand Performance
-- (analytics/sql/03_brand_performance.sql) and Category & Type Performance
-- (analytics/sql/08_category_type_performance.sql). Adds a NEW helper and a
-- NEW top-level builder that calls build_analytics_snapshot_v2_3 WHOLESALE
-- and adds two new top-level sections, shared_inventory_segmentation_
-- evidence and target_user_inventory_segmentation_evidence. Does NOT call,
-- embed, or replace any v1.0-v1.8 or v2.0-v2.3 builder — those remain
-- entirely unchanged and independently callable.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_inventory_segmentation_snapshot_v2(int) -- NEW
--   public.build_analytics_snapshot_v2_4(int)               -- NEW
--
-- ── POPULATION — EVERY ITEM, EVERY PURPOSE ───────────────────────────────
-- Unlike v1.x (purpose_name = 'Business' only), this module reads
-- analytics_item_lifecycle_v2's full population: Business, Hybrid,
-- Personal, missing_purpose, missing_policy. Purpose is the item's CURRENT
-- disposition only — never an economic eligibility filter. Every section
-- below is produced twice: once pooled across ALL purposes, and once
-- broken down by (current_purpose_id, current_purpose_name,
-- purpose_policy_status) using the same missing-purpose/missing-policy
-- collapsing rule established in v2.0 and reused by every v2 module since
-- (see build_analytics_snapshot_v2_3's own header for the full
-- explanation of the group_purpose_id/group_purpose_name NULL-collapse).
--
-- ── SCOPE DECISION — WHICH v1 QUERIES ARE PORTED ─────────────────────────
-- Both v1 source files were audited query-by-query and each section
-- classified as PRODUCTION EVIDENCE or DEVELOPER DIAGNOSTIC/AUDIT (see each
-- file's own "QUERY CLASSIFICATION INDEX"). Production evidence is
-- preserved; diagnostic-only sections are omitted. Full disposition below.
--
-- Category & Type Performance (08) — every one of its 6 queries (A-F) is
-- self-classified as shared aggregate evidence; ALL SIX are ported:
--   A -> population_summary            B -> performance_by_category
--   C -> performance_by_category_type  D -> performance_by_category_and_acquisition_band
--   E -> performance_by_category_type_and_acquisition_band
--   F -> open_inventory_by_category_type
--
-- Brand Performance (03) has 13 queries (A1-A3, B, B2, C, C2, D, D2, E1,
-- E2, F, G, H, H2, I). Ported (5 sections, each a genuine, non-redundant
-- cut of the data):
--   A1      -> population_summary (core reconciliation counts only)
--   B + B2  -> performance_by_brand (B2's "decision-ready" filter is folded
--              into a `decision_ready` boolean on every B row instead of a
--              separate duplicate query — same underlying fact, no second
--              query needed)
--   C + C2  -> performance_by_brand_and_acquisition_band (same fold-in)
--   E1 + E2 -> open_inventory_by_brand (merged via a `listing_status`
--              dimension: 'listed' | 'unlisted' — DOM fields are
--              structurally NULL/0 for 'unlisted' rows, exactly matching
--              E2's own "no DOM here at all" rule)
--   I       -> capital_concentration_by_brand
-- Omitted, with classification and rationale:
--   A2 (brand coverage distribution / bucket histogram) — PRODUCTION
--     EVIDENCE but redundant: every fact it reports (brands_with_3plus_
--     items, brands_with_3plus_realized, top5_brand_share_percent, etc.)
--     is a re-aggregation of `sample_size`/`realized_items`, which remain
--     visible per-brand in performance_by_brand. Omitted to control size;
--     reconstructable client-side from performance_by_brand.
--   A3 (brands lookup-table data-quality audit) — reclassified for this
--     port as a DEVELOPER/DATA-HYGIENE DIAGNOSTIC: it audits the shared
--     `public.brands` table itself for duplicate/misspelled rows, not
--     Purpose-scoped economic evidence about inventory, and has no natural
--     per-Purpose or per-target-user structure. Omitted.
--   D + D2 (brand x acquisition method) — PRODUCTION EVIDENCE, a genuine
--     cross-cut, but secondary to the two headline cuts already ported
--     (overall performance, performance by value band). Omitted to control
--     size; every ported brand-performance section still exposes
--     `historical_item_count` (method mix's app-tracked-vs-historical
--     component remains visible).
--   F (cohort comparison: imported historical vs. app-tracked, by brand) —
--     PRODUCTION EVIDENCE; its headline signal is superseded by the
--     `historical_item_count` / `non_historical_item_count` fields now
--     present on every ported brand section (population_summary,
--     performance_by_brand, performance_by_brand_and_acquisition_band).
--     The full side-by-side cohort medians are omitted for scope.
--   G (results by user) — DEVELOPER-ONLY DIAGNOSTIC per 03's own
--     classification index (a per-user breakdown is itself information
--     about another user's activity — would also violate this module's
--     own no-cross-user-identity-exposure rule if ported to shared
--     evidence). Omitted.
--   H (item-level verification drilldown) — DEVELOPER-ONLY DIAGNOSTIC per
--     03's own classification index; returns item_id/user_id/item display
--     name. Cannot appear in shared or target-user evidence under this
--     module's privacy rules regardless of classification. Omitted.
--   H2 (brand drilldown integrity rollup) — supports H (omitted); its
--     counts are subsumed by population_summary. Omitted.
--
-- ── SEMANTIC RULES PRESERVED FROM v1 ──────────────────────────────────────
-- - Acquisition value bands (order/label/status) copied byte-for-byte from
--   01_acquisition_value_band_performance.sql, as every prior module does.
-- - Historical Imports participate FULLY in item counts, realization rate,
--   profit, ROI, DOM (global_days_on_market), brand, category, and type
--   evidence. Excluded ONLY from holding_days-based duration metrics
--   (holding_sample_size / median_holding_days / median_ownership_age_days
--   / ownership-age threshold counts), because acquisition_date is the one
--   approximate field for those rows. Rows with has_lifecycle_date_issue
--   are excluded from the same holding-based metrics for the same reason.
-- - ROI requires a positive acquisition value (the view's own `roi` column
--   is already NULL otherwise).
-- - Zero-assigned (acquisition_value = 0) and unknown (acquisition_value
--   IS NULL) values remain visible in every population/coverage count but
--   are excluded from the positive-value-band performance rows and from
--   ROI, exactly as in every prior module.
-- - Missing brand (`brand_name` NULL/blank) is grouped under the label
--   'Unknown brand' and never dropped. Missing category (`category_id IS
--   NULL`) and missing type (`type_id IS NULL`) are never dropped — GROUP
--   BY naturally keeps a NULL group visible. Missing Purpose and missing
--   policy items are never dropped either — they collapse into their own
--   `missing_purpose` / `missing_policy` group exactly like every other
--   v2 module.
-- - Two Types sharing a name under different Categories are NEVER merged —
--   every Type-level query groups by (category_id, type_id) together,
--   never type_id/type_name alone (unchanged from v1).
-- - Additive totals (counts, capital sums) return 0 for an empty group via
--   COALESCE at the jsonb_agg level (`'[]'::jsonb` for an empty row set);
--   medians/percentiles/ROI/durations remain NULL when no valid sample
--   exists — never fabricated as 0.
-- - Realization rate and time metrics for Hybrid/Personal purpose rows are
--   descriptive only — no urgency, recommendation, score, item row, or AI
--   prose is produced anywhere in this module.
-- - Brand-level confidence uses the dual sample/realized tiering from 03
--   (sample_confidence, realized_confidence, overall_confidence =
--   LEAST(sample_tier, realized_tier), confidence_warning). Category/Type
--   confidence uses the single realized-item-count tiering from 08
--   (unlike the Channel Analytics modules, which tier from total item
--   count — see 08's own header).
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- shared_inventory_segmentation_evidence pools every user's items —
-- aggregate only, no item_id, item name, model, brand-owner identity, or
-- row grouped by user_id. target_user_inventory_segmentation_evidence is
-- filtered to `user_id = p_target_user_id` and is, like the shared
-- section, aggregate only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_inventory_segmentation_snapshot_v2(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
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
target_items AS (
  SELECT * FROM all_items WHERE user_id = p_target_user_id
),

-- ============================================================================
-- MODULE 1: Brand Performance — SHARED (pooled, all users)
-- ============================================================================

-- population_summary / purpose_population_summary (from Query A1's core
-- reconciliation counts; A2's bucket-distribution stats are omitted — see
-- SCOPE DECISION above)
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
),
-- MODULE 1: Brand Performance — TARGET USER ONLY
-- ============================================================================

-- population_summary / purpose_population_summary (from Query A1's core
-- reconciliation counts; A2's bucket-distribution stats are omitted — see
-- SCOPE DECISION above)
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
  FROM target_items
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
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_brand / performance_by_brand_by_purpose (Query B, with
-- Query B2's decision-ready filter folded into a `decision_ready` flag)
bt_eligible AS (
  SELECT * FROM target_items WHERE acquisition_value_status = 'positive'
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
  FROM target_items
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
  SELECT * FROM target_items WHERE acquisition_value_status = 'positive'
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
),

-- ============================================================================
-- MODULE 2: Category & Type Performance — SHARED (pooled, all users)
-- All six v1 queries (A-F) are self-classified production evidence; every
-- one is ported. Confidence here is tiered from the row's own REALIZED
-- item count (single tier), not the dual sample/realized tiering used by
-- Brand Performance above — matching 08's own convention (see its header).
-- ============================================================================

-- population_summary / purpose_population_summary (Query A)
cs_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
),
cs_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_category / ..._by_purpose (Query B)
cs_cat_rows AS (
  SELECT
    category_id, category_name,
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
  FROM all_items
  GROUP BY category_id, category_name
),
cs_cat_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
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
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name
),

-- performance_by_category_type / ..._by_purpose (Query C) — grouped by
-- (category_id, type_id) together, never type_id/type_name alone
cs_cattype_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
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
  FROM all_items
  GROUP BY category_id, category_name, type_id, type_name
),
cs_cattype_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
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
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
),

-- performance_by_category_and_acquisition_band / ..._by_purpose (Query D) —
-- restricted to acquisition_value_status = 'positive', matching 08's own
-- convention (zero-assigned/unknown coverage lives in population_summary)
cs_band_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
cs_catband_rows AS (
  SELECT
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cs_band_eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),
cs_catband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cs_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- performance_by_category_type_and_acquisition_band / ..._by_purpose (Query E)
cs_cattypeband_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cs_band_eligible
  GROUP BY category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),
cs_cattypeband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cs_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_category_type / ..._by_purpose (Query F)
cs_open_base AS (
  SELECT * FROM all_items WHERE NOT is_realized
),
cs_open_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
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
  FROM cs_open_base
  GROUP BY category_id, category_name, type_id, type_name
),
cs_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
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
  FROM cs_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
),
-- MODULE 2: Category & Type Performance — TARGET USER ONLY
-- All six v1 queries (A-F) are self-classified production evidence; every
-- one is ported. Confidence here is tiered from the row's own REALIZED
-- item count (single tier), not the dual sample/realized tiering used by
-- Brand Performance above — matching 08's own convention (see its header).
-- ============================================================================

-- population_summary / purpose_population_summary (Query A)
cx_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM target_items
),
cx_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE category_id IS NOT NULL)                                AS category_known_item_count,
    COUNT(*) FILTER (WHERE category_id IS NULL)                                    AS category_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE category_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS category_coverage_percent,
    COUNT(*) FILTER (WHERE type_id IS NOT NULL)                                    AS type_known_item_count,
    COUNT(*) FILTER (WHERE type_id IS NULL)                                        AS type_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE type_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS type_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND type_id IS NOT NULL)                    AS realized_type_known_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND type_id IS NOT NULL)                AS open_type_known_item_count,
    COUNT(DISTINCT category_id) FILTER (WHERE category_id IS NOT NULL)             AS distinct_category_count,
    COUNT(DISTINCT type_id) FILTER (WHERE type_id IS NOT NULL)                     AS distinct_type_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_category / ..._by_purpose (Query B)
cx_cat_rows AS (
  SELECT
    category_id, category_name,
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
  FROM target_items
  GROUP BY category_id, category_name
),
cx_cat_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
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
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name
),

-- performance_by_category_type / ..._by_purpose (Query C) — grouped by
-- (category_id, type_id) together, never type_id/type_name alone
cx_cattype_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
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
  FROM target_items
  GROUP BY category_id, category_name, type_id, type_name
),
cx_cattype_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
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
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
),

-- performance_by_category_and_acquisition_band / ..._by_purpose (Query D) —
-- restricted to acquisition_value_status = 'positive', matching 08's own
-- convention (zero-assigned/unknown coverage lives in population_summary)
cx_band_eligible AS (
  SELECT * FROM target_items WHERE acquisition_value_status = 'positive'
),
cx_catband_rows AS (
  SELECT
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cx_band_eligible
  GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),
cx_catband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cx_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
),

-- performance_by_category_type_and_acquisition_band / ..._by_purpose (Query E)
cx_cattypeband_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cx_band_eligible
  GROUP BY category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),
cx_cattypeband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
    acquisition_value_band_order, acquisition_value_band_label,
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
  FROM cx_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_category_type / ..._by_purpose (Query F)
cx_open_base AS (
  SELECT * FROM target_items WHERE NOT is_realized
),
cx_open_rows AS (
  SELECT
    category_id, category_name, type_id, type_name,
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
  FROM cx_open_base
  GROUP BY category_id, category_name, type_id, type_name
),
cx_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    category_id, category_name, type_id, type_name,
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
  FROM cx_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, category_id, category_name, type_id, type_name
)

SELECT jsonb_build_object(
  'shared_inventory_segmentation_evidence', jsonb_build_object(
    'brand_performance', jsonb_build_object(
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
    ),
    'category_type_performance', jsonb_build_object(
      'population_summary',                           (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_row)), '[]'::jsonb) FROM cs_pop_row),
      'purpose_population_summary',                    (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST), '[]'::jsonb) FROM cs_pop_purpose_rows),
      'performance_by_category',                       (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cat_rows) ORDER BY category_name NULLS LAST), '[]'::jsonb) FROM cs_cat_rows),
      'performance_by_category_by_purpose',             (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cat_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST), '[]'::jsonb) FROM cs_cat_purpose_rows),
      'performance_by_category_type',                  (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattype_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_cattype_rows),
      'performance_by_category_type_by_purpose',        (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattype_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_cattype_purpose_rows),
      'performance_by_category_and_acquisition_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(cs_catband_rows) ORDER BY category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_catband_rows),
      'performance_by_category_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_catband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_catband_purpose_rows),
      'performance_by_category_type_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattypeband_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_cattypeband_rows),
      'performance_by_category_type_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_cattypeband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cs_cattypeband_purpose_rows),
      'open_inventory_by_category_type',               (SELECT COALESCE(jsonb_agg(to_jsonb(cs_open_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_open_rows),
      'open_inventory_by_category_type_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(cs_open_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cs_open_purpose_rows)
    )
  ),
  'target_user_inventory_segmentation_evidence', jsonb_build_object(
    'brand_performance', jsonb_build_object(
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
    ),
    'category_type_performance', jsonb_build_object(
      'population_summary',                           (SELECT COALESCE(jsonb_agg(to_jsonb(cx_pop_row)), '[]'::jsonb) FROM cx_pop_row),
      'purpose_population_summary',                    (SELECT COALESCE(jsonb_agg(to_jsonb(cx_pop_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST), '[]'::jsonb) FROM cx_pop_purpose_rows),
      'performance_by_category',                       (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cat_rows) ORDER BY category_name NULLS LAST), '[]'::jsonb) FROM cx_cat_rows),
      'performance_by_category_by_purpose',             (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cat_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST), '[]'::jsonb) FROM cx_cat_purpose_rows),
      'performance_by_category_type',                  (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattype_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_cattype_rows),
      'performance_by_category_type_by_purpose',        (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattype_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_cattype_purpose_rows),
      'performance_by_category_and_acquisition_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(cx_catband_rows) ORDER BY category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_catband_rows),
      'performance_by_category_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cx_catband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_catband_purpose_rows),
      'performance_by_category_type_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattypeband_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_cattypeband_rows),
      'performance_by_category_type_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cx_cattypeband_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cx_cattypeband_purpose_rows),
      'open_inventory_by_category_type',               (SELECT COALESCE(jsonb_agg(to_jsonb(cx_open_rows) ORDER BY category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_open_rows),
      'open_inventory_by_category_type_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(cx_open_purpose_rows) ORDER BY
                                                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                          current_purpose_name NULLS LAST, category_name NULLS LAST, type_name NULLS LAST), '[]'::jsonb) FROM cx_open_purpose_rows)
    )
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_inventory_segmentation_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_inventory_segmentation_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_inventory_segmentation_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_inventory_segmentation_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_4(p_target_user_id int)
-- Calls build_analytics_snapshot_v2_3 WHOLESALE (which itself validates
-- p_target_user_id and RAISEs on failure — not repeated here), preserves
-- every v2.3 section unchanged, and adds shared_inventory_segmentation_
-- evidence / target_user_inventory_segmentation_evidence as new top-level
-- keys.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_4(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v23                 jsonb;
  v_generated_at         timestamptz := now();
  v_inventory_segmentation jsonb;
BEGIN
  v_v23 := public.build_analytics_snapshot_v2_3(p_target_user_id);
  v_inventory_segmentation := public._build_inventory_segmentation_snapshot_v2(p_target_user_id);

  RETURN v_v23
    || jsonb_build_object(
         'snapshot_schema_version', '2.4',
         'analytics_definition_version', '2.4',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_inventory_segmentation_evidence', v_inventory_segmentation -> 'shared_inventory_segmentation_evidence',
         'target_user_inventory_segmentation_evidence', v_inventory_segmentation -> 'target_user_inventory_segmentation_evidence'
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_4(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_4(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_4(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_4(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_4(int) IS
  'Analytics v2.4 — Inventory Segmentation — the current PRODUCTION '
  'analytics snapshot version. SECURITY INVOKER, service_role execution '
  'only. Calls build_analytics_snapshot_v2_3 wholesale (unchanged) and '
  'adds shared_inventory_segmentation_evidence / target_user_inventory_'
  'segmentation_evidence, each containing brand_performance and '
  'category_type_performance ported from the v1 Brand Performance and '
  'Category & Type Performance files to read every Purpose (Business/'
  'Hybrid/Personal/missing-purpose/missing-policy) instead of Business '
  'only. v1.0-v1.8 and v2.0-v2.3 are completely unaffected. Persists '
  'nothing — see analytics_runs (20260727000000) for the persistence '
  'step. See analytics/README.md and analytics/SEMANTIC_CONTRACT.md for '
  'the full v2.4 contract.';
