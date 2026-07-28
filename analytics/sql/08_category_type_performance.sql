-- ============================================================================
-- 08_category_type_performance.sql
--
-- Business questions:
--   - Which item Categories perform best?
--   - Which Types perform best within their Category?
--   - How do Category and Type results vary by Acquisition Value Band?
--   - Where is current open inventory capital concentrated by Category and
--     Type?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- This is a Category/Type module, NOT a Channel Analytics module — it
-- reuses this analytics layer's general conventions (confidence tiers,
-- historical-import eligibility rules, Acquisition Value Band boundaries)
-- but groups by category_id/category_name/type_id/type_name instead of by
-- any Deal In/Deal Out/Listing channel. Capital & Liquidity, Open
-- Inventory Decision Support, AI interpretation, and recommendations all
-- remain OUT of scope for this file — see analytics/SEMANTIC_CONTRACT.md.
--
-- No analytics_item_lifecycle migration was needed — category_id,
-- category_name, type_id, type_name are already exposed by the view
-- (sourced from item_subtypes/item_categories).
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────
-- purpose_name = 'Business'. Query A/B/C report on the FULL population
-- (open + realized) — a Category/Type is a property an item has from the
-- moment it's created, well before any exit. Query D/E narrow further to
-- acquisition_value_status = 'positive' (matching 01/03/04/05's own band
-- convention); Query F narrows to open (NOT is_realized) items only.
--
-- ── MISSING CATEGORY / TYPE IS NEVER EXCLUDED ───────────────────────────
-- A row with `category_id IS NULL` or `type_id IS NULL` (no
-- `item_subtype_id` set on the inventory item) is NEVER dropped from any
-- query in this file — GROUP BY naturally keeps a NULL group visible,
-- exactly like the missing-channel rows in files 04/05. Query A reports
-- this coverage explicitly (`category_known_item_count` /
-- `category_missing_item_count`, and separately for type). Missing Type is
-- a DATA-QUALITY GROUP, not a real Type — it must never be interpreted as
-- "the item genuinely belongs to no category," only "no category was ever
-- recorded for it."
--
-- ── SAME TYPE NAME, DIFFERENT CATEGORY — NEVER MERGED ───────────────────
-- Every Type-level query groups by (category_id, type_id) together, never
-- by type_id or type_name alone. Two Types that happen to share the same
-- name under different Categories (e.g. a "Pedal" subtype seeded under
-- both "Amps" and "Pedals" in this project's schema) are always reported
-- as two independent rows.
--
-- ── HISTORICAL IMPORTS — SAME RULE AS EVERY OTHER MODULE ────────────────
-- Historical imports are INCLUDED in item counts, realization rate,
-- profit, ROI, DOM, acquisition/exit values, and sale/trade mix — they are
-- EXCLUDED only from holding_days/ownership-age metrics (acquisition_date
-- is the one approximate field for a historical import). See
-- analytics/SEMANTIC_CONTRACT.md sections 1-4 for the full rule.
--
-- ── acquisition_value_status (v1.1 semantics, reused here unchanged) ────
-- positive / zero_assigned (acquisition_value = 0) / unknown
-- (acquisition_value IS NULL) / negative_invalid. Query D/E restrict to
-- 'positive' only — zero-assigned and unknown values are NEVER silently
-- placed into the $1-999 band; their separate coverage is reported in
-- Query A (`positive_acquisition_item_count` /
-- `zero_assigned_acquisition_item_count` / `unknown_acquisition_item_count`).
--
-- ── CONFIDENCE — BASED ON THE REALIZED SAMPLE, NOT THE WHOLE GROUP ──────
-- Unlike the Channel Analytics modules (04-07), which tier `confidence`
-- from a row's TOTAL item count, every grouped section in THIS file tiers
-- `confidence` from that row's own REALIZED item count — profit/ROI/DOM
-- conclusions are about realized outcomes, and an open-item-heavy
-- Category/Type row should not read as falsely well-evidenced just because
-- it holds a lot of still-open inventory. Same 4-tier thresholds as
-- everywhere else: 1-2 insufficient, 3-5 low, 6-9 moderate, 10+ stronger.
--
-- ── DOM vs. HOLDING (see 01_acquisition_value_band_performance.sql's
-- TIMING SEMANTICS section for the full explanation) ────────────────────
-- global_days_on_market (DOM) is restricted to realized items in every
-- "overall performance" section here (B, C), matching 04/05's own
-- convention. holding_days (Query F's "ownership age" for open items)
-- excludes historical imports and any has_lifecycle_date_issue row.
--
-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- - Category and Type results are DESCRIPTIVE, not causal — a Category
--   with a higher median profit did not necessarily "cause" that outcome;
--   acquisition method, brand mix, and market timing are confounded with
--   Category/Type membership and are not isolated by this file.
-- - A Type with a tiny sample (`confidence: 'insufficient'`/`'low'`) must
--   NEVER outweigh a Category-level row with a stronger sample when both
--   are shown together — always report `confidence` alongside any number
--   drawn from these sections.
-- - Acquisition Value Band results (Query D/E) can still be affected by
--   acquisition method mix (purchase vs. trade) and brand mix within a
--   Category/Type — a band difference is not automatically a "band
--   effect" in isolation.
-- - "Missing Type" (`type_id IS NULL`) is a data-quality group, never a
--   real Type — never plot, rank, or recommend against it as if it were
--   a genuine inventory category.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Every query below is SHARED AGGREGATE EVIDENCE — pooled across every
-- user accessible to the querying role, returning only counts/medians/
-- labels/percentages, never an item ID, item name, model, or user
-- identity. No per-user Category/Type breakdown exists in this file.
-- ============================================================================


-- ============================================================================
-- QUERY A — Population summary and Category/Type coverage
-- CLASSIFICATION: shared aggregate evidence.
-- Run this first. Reconciliation (verify by eye against this row):
--   business_item_count = category_known_item_count + category_missing_item_count
--   business_item_count = type_known_item_count + type_missing_item_count
-- ============================================================================
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
)
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
  -- Zero-assigned/unknown acquisition-value coverage — reported here rather
  -- than a separate section (see file header). Never silently folded into
  -- Query D/E's positive bands.
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'positive')        AS positive_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'zero_assigned')   AS zero_assigned_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'unknown')         AS unknown_acquisition_item_count;


-- ============================================================================
-- QUERY B — Performance by Category
-- CLASSIFICATION: shared aggregate evidence.
-- One row per Category, including a row for category_id IS NULL (missing
-- Category) if any Business item has none recorded — GROUP BY never drops
-- a NULL group. confidence is tiered from realized_item_count (see file
-- header), not item_count.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
)
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
ORDER BY category_name NULLS LAST;


-- ============================================================================
-- QUERY C — Performance by Category + Type
-- CLASSIFICATION: shared aggregate evidence.
-- One row per (category_id, type_id) pair — NEVER grouped by type_id or
-- type_name alone, so two Types sharing a name under different Categories
-- are always kept separate. A missing Type (type_id IS NULL) remains
-- visible as its own row within its Category (or within the missing-
-- Category group, if both are unknown).
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
)
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
ORDER BY category_name NULLS LAST, type_name NULLS LAST;


-- ============================================================================
-- QUERY D — Category x Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to acquisition_value_status = 'positive' — the SAME
-- restriction 01/04/05's own band queries use. Zero-assigned and unknown
-- acquisition values are excluded from these positive bands; their
-- separate coverage lives in Query A, never mixed in here. Band boundaries
-- copied byte-for-byte from 01_acquisition_value_band_performance.sql
-- (v1.1).
-- ============================================================================
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
)
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
ORDER BY category_name NULLS LAST, acquisition_value_band_order;


-- ============================================================================
-- QUERY E — Category + Type x Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Same restriction as Query D (positive acquisition value only), grouped
-- additionally by (category_id, type_id) — never type_id/type_name alone.
-- Every row is kept, including tiny-sample rows — `confidence` classifies
-- them, they are never dropped.
-- ============================================================================
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
)
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
ORDER BY category_name NULLS LAST, type_name NULLS LAST, acquisition_value_band_order;


-- ============================================================================
-- QUERY F — Open inventory by Category + Type
-- CLASSIFICATION: shared aggregate evidence.
-- Business items, NOT is_realized (open) only. One row per (category_id,
-- type_id) pair, including missing Category/Type groups. listed_item_count
-- / unlisted_item_count reuse the view's own current_status = 'listed'
-- convention (same as 04/05's open-inventory sections) — no cross-platform
-- comparison is attempted here (see analytics/SEMANTIC_CONTRACT.md section
-- 18 for that — Listing Channel Exposure is a separate module).
-- ============================================================================
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
open_items AS (
  SELECT * FROM business WHERE NOT is_realized
)
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
ORDER BY category_name NULLS LAST, type_name NULLS LAST;
