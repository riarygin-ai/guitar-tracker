-- ============================================================================
-- 04_deal_in_channel_performance.sql
--
-- Business question: through which contact-source channels do Business
-- items enter inventory, and how do those sourced items perform?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- ── CHANNEL ANALYTICS, MODULE 1 OF N ────────────────────────────────────
-- This is the first Channel Analytics module: Deal In Channel Performance
-- only. Deal Out Channel, Listing Channel, the Deal In -> Deal Out journey
-- matrix, listing-conversion/same-channel-exit-rate, channel x brand,
-- channel x category/type, and monthly trends are explicitly OUT of scope
-- for this file — see analytics/SEMANTIC_CONTRACT.md.
--
-- ── SEMANTIC DEFINITION — READ BEFORE TOUCHING ANYTHING ELSE IN THIS FILE ──
-- Deal In Channel is the channel where CONTACT with the seller or trade
-- partner ORIGINATED for the operation through which an item ENTERED
-- inventory: Marketplace, Kijiji, Reverb, or Regular Buyer / Seller. It is
-- NOT a payment method, NOT a shipping method, and NOT "the technical place
-- where the deal was completed."
--   - For a purchase, this is the purchase deal's deal_channel_id.
--   - For a trade acquisition, this is the trade deal's deal_channel_id.
--   - For Historical Purchase / Historical Trade, this is the historical
--     deal's own channel, when one was recorded.
--   - Historical Import (method never determined) or ANY acquisition with
--     no recorded channel has deal_in_channel_id = NULL. This is a real,
--     visible "missing channel" state — see Query A's coverage counts.
--     It is NEVER silently dropped from any query in this file.
--
-- deal_in_channel_id / deal_in_channel_name / deal_in_channel_requires_listing
-- are exposed by analytics_item_lifecycle directly (added in
-- 20260731000000_analytics_item_lifecycle_deal_in_channel.sql) — this file
-- never re-derives them. NEVER use the ambiguous names channel_id,
-- channel_name, acquisition_channel, or source_channel anywhere in this
-- file or its output.
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────
-- purpose_name = 'Business'. Unlike 01/03's profit/ROI-ranking queries,
-- this population is NOT restricted to positive acquisition value —
-- coverage (Query A), per-channel item/deal counts, and open-inventory
-- exposure (Query B, E) are about EVERY Business item sourced through a
-- channel, regardless of acquisition-value status. Only Query D (banded by
-- Acquisition Value Band) restricts to positive acquisition value, exactly
-- like 01/03's own band queries — zero-assigned and unknown acquisition
-- values are excluded from positive bands but their counts are surfaced
-- separately in Query A's coverage fields, never silently dropped.
--
-- ── acquisition_value_status (v1.1 semantics, reused here unchanged) ────
-- positive / zero_assigned (acquisition_value = 0, possibly an intentional
-- assigned value — never treated as unknown) / unknown
-- (acquisition_value IS NULL) / negative_invalid (a data-quality state,
-- excluded from this file's item populations same as 01/03). See
-- analytics/SEMANTIC_CONTRACT.md section 7.1.
--
-- ── DOM vs. HOLDING (see 01_acquisition_value_band_performance.sql's
-- TIMING SEMANTICS section for the full explanation) ────────────────────
-- global_days_on_market (DOM) is the PRIMARY market-liquidity metric and
-- MAY include historical items whenever global_days_on_market is usable
-- and has_lifecycle_date_issue = false — a historical ACQUISITION record
-- does not make a real, currently-ticking listing date untrustworthy.
-- holding_days is SECONDARY ownership/capital-cycle context and EXCLUDES
-- historical imports (acquisition_date may be approximate for them) AND
-- any row with has_lifecycle_date_issue = true — the SAME eligibility rule
-- used everywhere else in this analytics layer since the v1.1 cleanup.
--
-- net_profit and roi reuse analytics_item_lifecycle's own columns exactly
-- as computed (v1.1 semantics): net_profit is valid arithmetic for a known
-- zero acquisition value (never NULL merely because acquisition_value is
-- 0); roi is NULL whenever acquisition_value is NULL or <= 0 (never a
-- computed 0 or infinity) — nothing in this file re-derives either column,
-- so zero-assigned/unknown acquisition values can never distort them.
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
-- identity. No per-user channel breakdown exists in this file (unlike
-- 01/03's Query G2/G, no analog is added here — a per-user Deal In Channel
-- breakdown would itself be information about another user's activity).
-- ============================================================================


-- ============================================================================
-- QUERY A — Population summary and channel coverage
-- CLASSIFICATION: shared aggregate evidence.
-- Run this first. Reconciliation (verify by eye against this row):
--   business_item_count = deal_in_channel_known_item_count
--                        + deal_in_channel_missing_item_count
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
  (SELECT COUNT(*) FROM business WHERE deal_in_channel_id IS NOT NULL)                AS deal_in_channel_known_item_count,
  (SELECT COUNT(*) FROM business WHERE deal_in_channel_id IS NULL)                    AS deal_in_channel_missing_item_count,
  ROUND(
    (SELECT COUNT(*) FROM business WHERE deal_in_channel_id IS NOT NULL)::numeric
      / NULLIF((SELECT COUNT(*) FROM business), 0) * 100,
    2
  )                                                                                   AS deal_in_channel_coverage_percent,
  (SELECT COUNT(DISTINCT deal_in_channel_id) FROM business WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_method = 'purchase')              AS purchase_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_method = 'trade')                 AS trade_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_method NOT IN ('purchase', 'trade')) AS unknown_acquisition_method_item_count,
  (SELECT COUNT(*) FROM business WHERE is_historical_import)                         AS historical_business_item_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_historical_import)                     AS app_tracked_business_item_count,
  -- Special-value coverage — same acquisition_value_status semantics as
  -- 01/03; never conflate zero_assigned with unknown. See Query D below.
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'zero_assigned')   AS deal_in_zero_assigned_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'unknown')         AS deal_in_unknown_acquisition_item_count;


-- ============================================================================
-- QUERY B — Overall performance by Deal In Channel
-- CLASSIFICATION: shared aggregate evidence.
-- One row per Deal In Channel, including a row for deal_in_channel_id IS
-- NULL (missing channel) if any Business item has no recorded channel —
-- GROUP BY never drops a NULL group, so that population stays visible
-- here exactly like it does in Query A.
--
-- deal_in_distinct_deal_count counts DISTINCT acquisition_deal_id, not
-- items — a single multi-item purchase/trade deal (e.g. one trade bringing
-- in three guitars at once) contributes many to deal_in_item_count but
-- only ONE to deal_in_distinct_deal_count.
--
-- total_acquisition_capital / realized_acquisition_capital SUM
-- acquisition_value directly (NULL-safe): a known zero-assigned value
-- contributes $0 to the sum (not excluded, not NULL-ing the whole sum —
-- see analytics/SEMANTIC_CONTRACT.md section 7.1 / the v1.1 SUM fix);
-- unknown acquisition value is excluded by ordinary NULL propagation.
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
  deal_in_channel_id,
  deal_in_channel_name,
  deal_in_channel_requires_listing,
  COUNT(*)                                                                       AS deal_in_item_count,
  COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
  COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
  COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
  COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
  COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
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
FROM business
GROUP BY deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
ORDER BY deal_in_channel_name NULLS LAST;


-- ============================================================================
-- QUERY C — Deal In Channel x acquisition method
-- CLASSIFICATION: shared aggregate evidence.
-- Same population as Query B, additionally grouped by acquisition_method —
-- already normalized to exactly 'purchase' / 'trade' / 'unknown' by the
-- view itself, so no extra filtering is needed to keep those the only
-- values grouped here.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
)
SELECT
  deal_in_channel_id,
  deal_in_channel_name,
  acquisition_method,
  COUNT(*)                                                                       AS deal_in_item_count,
  COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
  COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
  COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
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
FROM business
GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_method
ORDER BY deal_in_channel_name NULLS LAST, acquisition_method;


-- ============================================================================
-- QUERY D — Deal In Channel x Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to acquisition_value_status = 'positive' — the SAME
-- restriction 01/03's own band queries use. Zero-assigned and unknown
-- acquisition values are excluded from these positive bands; their
-- separate coverage lives in Query A's deal_in_zero_assigned_acquisition_
-- item_count / deal_in_unknown_acquisition_item_count, never mixed in
-- here. Band boundaries copied byte-for-byte from
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
business AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value_status = 'positive'
)
SELECT
  deal_in_channel_id,
  deal_in_channel_name,
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                                                                       AS deal_in_item_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
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
FROM eligible
GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
ORDER BY deal_in_channel_name NULLS LAST, acquisition_value_band_order;


-- ============================================================================
-- QUERY E — Open inventory exposure by Deal In Channel
-- CLASSIFICATION: shared aggregate evidence.
-- Business items, NOT is_realized (open), ALL acquisition-value statuses
-- except negative_invalid (a data-quality state excluded here same as
-- 01/03's own open-inventory queries) — this is about risk exposure, not
-- profit/ROI math. One row per Deal In Channel (including the missing-
-- channel NULL group, per Query B's same GROUP BY behavior).
--
-- open_acquisition_capital SUMs acquisition_value directly: a known
-- zero-assigned open item contributes $0 (not excluded, not NULL-ing the
-- sum). estimated_net_upside is a PROJECTION (estimated_sold_value -
-- acquisition_value - item_expenses_total), never a guaranteed profit, and
-- is NULL whenever acquisition_value is unknown (never presented as zero
-- capital) — see analytics/SEMANTIC_CONTRACT.md section 7.1 / Part 9.
--
-- current_dom_sample_size / median_current_days_on_market / items_dom_60_
-- plus / items_dom_120_plus are computed ONLY over LISTED items with no
-- lifecycle date issue — unlisted items have no market-exposure duration
-- to report (see 01_acquisition_value_band_performance.sql's Query E1/E2
-- header for the same DOM-vs-unlisted distinction).
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
  SELECT * FROM business
  WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
)
SELECT
  deal_in_channel_id,
  deal_in_channel_name,
  COUNT(*)                                                                       AS deal_in_open_item_count,
  COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
  COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
  COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
  COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
  COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
  COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
  COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
  COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
  SUM(estimated_sold_value - acquisition_value - item_expenses_total)
    FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
  COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                     AND global_days_on_market IS NOT NULL)                       AS current_dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
    FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
              AND global_days_on_market IS NOT NULL)::numeric, 2)                AS median_current_days_on_market,
  COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                     AND global_days_on_market >= 60)                            AS items_dom_60_plus,
  COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue
                     AND global_days_on_market >= 120)                           AS items_dom_120_plus
FROM open_items
GROUP BY deal_in_channel_id, deal_in_channel_name
ORDER BY deal_in_channel_name NULLS LAST;
