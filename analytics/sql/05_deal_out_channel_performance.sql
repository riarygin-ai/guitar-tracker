-- ============================================================================
-- 05_deal_out_channel_performance.sql
--
-- Business question: through which contact-source channels do Business
-- items LEAVE inventory, and how do cash-sale and trade exits perform?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- ── CHANNEL ANALYTICS, MODULE 2 OF N ────────────────────────────────────
-- This is the second Channel Analytics module: Deal Out Channel Performance
-- only. Listing Channel, the Deal In -> Deal Out journey matrix, and every
-- other Channel Analytics module remain OUT of scope for this file — see
-- analytics/SEMANTIC_CONTRACT.md.
--
-- ── SEMANTIC DEFINITION — READ BEFORE TOUCHING ANYTHING ELSE IN THIS FILE ──
-- Deal Out Channel is the contact-source channel of the operation through
-- which an item LEFT inventory: Marketplace, Kijiji, Reverb, or Regular
-- Buyer / Seller. It is NOT a payment method, NOT a shipping method, and
-- NOT "the technical place where the deal was completed."
--   - Example: a buyer contacted us through Reverb but payment happened
--     outside Reverb — Deal Out Channel = Reverb.
--   - Example: a trade partner contacted us through Marketplace — the
--     outgoing item(s) have Deal Out Channel = Marketplace.
--   - For a trade, the existing deal_channel_id is the ONE counterparty/
--     contact-source channel for the whole deal — incoming and outgoing
--     items on the same trade deal are NEVER assigned separate channels.
--   - Open (not-yet-realized) items ALWAYS have deal_out_channel_id = NULL
--     — there is no exit deal yet to read a channel from. This is why every
--     query below restricts its population to is_realized items only.
--   - A realized cash sale always has a channel (create_sell_operation
--     requires p_channel_id); a realized trade MAY have no channel recorded
--     (create_trade_operation's p_channel_id is optional) — this is a real,
--     visible "missing channel" state, never hidden or defaulted. See
--     Query A's coverage counts.
--
-- deal_out_channel_id / deal_out_channel_name / deal_out_channel_requires_listing
-- are exposed by analytics_item_lifecycle directly (added in
-- 20260802000000_analytics_item_lifecycle_deal_out_channel.sql) — this file
-- never re-derives them. NEVER use the ambiguous names channel_id,
-- channel_name, exit_channel, or source_channel anywhere in this file or
-- its output.
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────
-- purpose_name = 'Business' AND is_realized. Unlike 04's Deal In Channel
-- file (which reports on EVERY Business item, open or realized, because
-- acquisition always happens), Deal Out Channel only exists for items that
-- have actually exited — so every query here is scoped to realized items.
-- Query C (cash_sales_by_channel) additionally narrows to exit_type =
-- 'sale'; Query D (trade_exits_by_channel) additionally narrows to
-- exit_type = 'trade'; Query F (by_acquisition_value_band) additionally
-- narrows to acquisition_value_status = 'positive', exactly like 01/03/04's
-- own band queries.
--
-- ── CASH SALE vs. TRADE EXIT — NEVER CONFLATE THE TWO ───────────────────
-- exit_value stores either a cash sale value OR an assigned outgoing trade
-- value in the SAME column (see analytics/SEMANTIC_CONTRACT.md). This file
-- follows the SAME convention as 02_acquisition_to_exit_analysis.sql's
-- Query G: exit_value may be called a "sale price" ONLY in Query C
-- (cash_sales_by_channel), and an "assigned trade exit value" ONLY in
-- Query D (trade_exits_by_channel). Query B (overall_performance) and every
-- banded query (E, F) use the neutral term "exit value," never "sale
-- price" and never "assigned trade exit value," because those sections mix
-- both exit methods together.
--
-- ── acquisition_value_status (v1.1 semantics, reused here unchanged) ────
-- positive / zero_assigned (acquisition_value = 0, possibly an intentional
-- assigned value — never treated as unknown) / unknown
-- (acquisition_value IS NULL) / negative_invalid (a data-quality state,
-- excluded from this file's item populations same as 01/02/03/04). See
-- analytics/SEMANTIC_CONTRACT.md section 7.1.
--
-- ── DOM vs. HOLDING (see 01_acquisition_value_band_performance.sql's
-- TIMING SEMANTICS section for the full explanation) ────────────────────
-- global_days_on_market (DOM) is the PRIMARY market-liquidity metric.
-- holding_days is SECONDARY ownership/capital-cycle context and EXCLUDES
-- historical imports (acquisition_date may be approximate for them) AND
-- any row with has_lifecycle_date_issue = true — the SAME eligibility rule
-- used everywhere else in this analytics layer since the v1.1 cleanup.
-- historical_item_count / app_tracked_item_count in Query B are cohort
-- splits based on the item's ACQUISITION history (is_historical_import) —
-- a historically-acquired item can still exit through a perfectly normal,
-- non-historical sale/trade deal with a known or missing channel, exactly
-- like any other item; "historical" here is never about the exit itself
-- (no "Historical Sale"/"Historical Trade exit" deal_type exists in this
-- schema — every realized exit's deal_type is exactly 'sale' or 'trade').
--
-- net_profit and roi reuse analytics_item_lifecycle's own columns exactly
-- as computed (v1.1 semantics): net_profit is valid arithmetic for a known
-- zero acquisition value; roi is NULL whenever acquisition_value is NULL or
-- <= 0. Nothing in this file re-derives either column.
--
-- ── CONFIDENCE CONVENTION — reused from 02_acquisition_to_exit_analysis.sql ──
-- Every grouped section exposes one `confidence` column, computed from
-- that row's own item count using the SAME 4-tier thresholds used
-- throughout this analytics layer: 1-2 insufficient, 3-5 low, 6-9
-- moderate, 10+ stronger. No new threshold is invented here.
--
-- Each query is fully self-contained (its own WITH clause) so any single
-- query can be copy-pasted and run alone, matching this folder's
-- established convention.
--
-- ── QUERY CLASSIFICATION INDEX (evidence vs. recommendation vs.
-- developer-only; see analytics/SEMANTIC_CONTRACT.md) ───────────────────
-- Every query below is SHARED AGGREGATE EVIDENCE — pooled across every
-- user accessible to the querying role, returning only counts/medians/
-- labels/percentages, never an item ID, item name, model, or user
-- identity. No per-user channel breakdown exists in this file, matching
-- 04's own Deal In Channel file.
-- ============================================================================


-- ============================================================================
-- QUERY A — Population summary and channel coverage
-- CLASSIFICATION: shared aggregate evidence.
-- Run this first. Reconciliation (verify by eye against this row):
--   realized_business_item_count = deal_out_channel_known_item_count
--                                + deal_out_channel_missing_item_count
--   realized_business_item_count = sale_exit_item_count
--                                + trade_exit_item_count
--                                + unknown_exit_method_item_count
-- unknown_exit_method_item_count is structurally always 0 in this schema
-- today (is_realized guarantees exit_type IN ('sale','trade')) — kept for
-- defensive completeness and so the second reconciliation above always
-- holds even if a future exit method is introduced.
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
)
SELECT
  (SELECT COUNT(*) FROM realized_business)                                            AS realized_business_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NOT NULL)       AS deal_out_channel_known_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NULL)           AS deal_out_channel_missing_item_count,
  ROUND(
    (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NOT NULL)::numeric
      / NULLIF((SELECT COUNT(*) FROM realized_business), 0) * 100,
    2
  )                                                                                   AS deal_out_channel_coverage_percent,
  (SELECT COUNT(DISTINCT deal_out_channel_id) FROM realized_business WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
  (SELECT COUNT(*) FROM realized_business WHERE exit_type = 'sale')                    AS sale_exit_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE exit_type = 'trade')                   AS trade_exit_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE is_historical_import)                  AS historical_realized_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE NOT is_historical_import)              AS app_tracked_realized_item_count;


-- ============================================================================
-- QUERY B — Overall performance by Deal Out Channel
-- CLASSIFICATION: shared aggregate evidence.
-- One row per Deal Out Channel, including a row for deal_out_channel_id IS
-- NULL (missing channel) if any realized Business item has no recorded
-- exit channel — GROUP BY never drops a NULL group, so that population
-- stays visible here exactly like it does in Query A.
--
-- deal_out_distinct_deal_count counts DISTINCT exit_deal_id, not items — a
-- single multi-item trade deal (e.g. one trade sending out two guitars at
-- once) contributes many to deal_out_item_count but only ONE to
-- deal_out_distinct_deal_count.
--
-- total_exit_value / total_acquisition_capital SUM directly (NULL-safe): a
-- known zero-assigned value contributes $0 to the sum (not excluded, not
-- NULL-ing the whole sum — see analytics/SEMANTIC_CONTRACT.md section
-- 7.1 / the v1.1 SUM fix); unknown value is excluded by ordinary NULL
-- propagation. This population is already 100% is_realized (see the
-- primary evidence population note above), so no is_realized FILTER is
-- needed on the profit/DOM aggregates themselves — only holding_days
-- retains its own FILTER, for the historical/lifecycle-issue exclusion.
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
)
SELECT
  deal_out_channel_id,
  deal_out_channel_name,
  deal_out_channel_requires_listing,
  COUNT(*)                                                                       AS deal_out_item_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
  COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
  COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
  SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(net_profit)                                                                AS total_realized_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM realized_business
GROUP BY deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
ORDER BY deal_out_channel_name NULLS LAST;


-- ============================================================================
-- QUERY C — Cash sales by Deal Out Channel
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to exit_type = 'sale' (a cash sale — the view's own exit-
-- method convention, verified against
-- 20260724000000_historical_deal_type_labels.sql). The ONLY section in
-- this file where exit_value may be called a "sale price" — see the CASH
-- SALE vs. TRADE EXIT header note above.
-- ============================================================================
WITH cash_sales AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized AND exit_type = 'sale'
)
SELECT
  deal_out_channel_id,
  deal_out_channel_name,
  COUNT(*)                                                                       AS sale_item_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
  SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
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
FROM cash_sales
GROUP BY deal_out_channel_id, deal_out_channel_name
ORDER BY deal_out_channel_name NULLS LAST;


-- ============================================================================
-- QUERY D — Trade exits by Deal Out Channel
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to exit_type = 'trade'. exit_value here is an ASSIGNED
-- OUTGOING TRADE VALUE, never called a "sale price" — see the CASH SALE
-- vs. TRADE EXIT header note above.
-- ============================================================================
WITH trade_exits AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized AND exit_type = 'trade'
)
SELECT
  deal_out_channel_id,
  deal_out_channel_name,
  COUNT(*)                                                                       AS trade_exit_item_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
  SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
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
FROM trade_exits
GROUP BY deal_out_channel_id, deal_out_channel_name
ORDER BY deal_out_channel_name NULLS LAST;


-- ============================================================================
-- QUERY E — Deal Out Channel x Exit Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- ALL realized items (cash sale AND trade together) — sale_exit_item_count/
-- trade_exit_item_count expose the split within each band without
-- excluding either method. Band boundaries copied byte-for-byte from
-- 02_acquisition_to_exit_analysis.sql's own exit_value_band_order/label
-- (v1.0, unchanged) — the merged "Zero / unknown" label is this file's
-- established exit-value-band convention and is NOT split the way the
-- v1.1 cleanup split acquisition_value_band's zero/unknown/negative — see
-- analytics/SEMANTIC_CONTRACT.md section 7.1 (that split applies to
-- ACQUISITION value bands only).
-- ============================================================================
WITH exit_value_band AS (
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
  FROM analytics_item_lifecycle
),
realized_business AS (
  SELECT * FROM exit_value_band WHERE purpose_name = 'Business' AND is_realized
)
SELECT
  deal_out_channel_id,
  deal_out_channel_name,
  exit_value_band_order,
  exit_value_band_label,
  COUNT(*)                                                                       AS deal_out_item_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
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
FROM realized_business
GROUP BY deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
ORDER BY deal_out_channel_name NULLS LAST, exit_value_band_order;


-- ============================================================================
-- QUERY F — Deal Out Channel x Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to acquisition_value_status = 'positive' — the SAME
-- restriction 01/03/04's own band queries use. Zero-assigned and unknown
-- acquisition values are excluded from these positive bands. Band
-- boundaries copied byte-for-byte from
-- 01_acquisition_value_band_performance.sql (v1.1) — six positive bands
-- plus the same zero/unknown/negative labels for defensive completeness
-- (unreachable in this query's own `eligible` population, kept for
-- copy-paste safety matching this file's own convention).
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
realized_business AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND is_realized
),
eligible AS (
  SELECT * FROM realized_business WHERE acquisition_value_status = 'positive'
)
SELECT
  deal_out_channel_id,
  deal_out_channel_name,
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                                                                       AS deal_out_item_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
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
FROM eligible
GROUP BY deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
ORDER BY deal_out_channel_name NULLS LAST, acquisition_value_band_order;
