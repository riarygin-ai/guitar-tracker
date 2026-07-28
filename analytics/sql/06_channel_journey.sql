-- ============================================================================
-- 06_channel_journey.sql
--
-- Business question: how do Business items move from their Deal In
-- contact-source channel to their Deal Out contact-source channel?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- ── CHANNEL ANALYTICS, MODULE 3A OF N ───────────────────────────────────
-- This is the third Channel Analytics module: Channel Journey only.
-- Listing Channel Exposure, listing conversion, current listing
-- recommendations, AI interpretation, and recommendations/rankings all
-- remain OUT of scope for this file — see analytics/SEMANTIC_CONTRACT.md.
--
-- ── FIELDS USED — READ BEFORE TOUCHING ANYTHING ELSE IN THIS FILE ───────
-- This file uses ONLY the explicit Channel-Analytics-facing fields already
-- exposed by analytics_item_lifecycle: deal_in_channel_id,
-- deal_in_channel_name (added 20260731000000, module 1) and
-- deal_out_channel_id, deal_out_channel_name (added 20260802000000,
-- module 2). It NEVER uses the legacy acquisition_channel_*/exit_channel_*
-- names in any query or output column — those remain valid columns on the
-- view for their own, older readers, but this file is not one of them.
--
-- ── ELIGIBILITY ──────────────────────────────────────────────────────────
-- The journey matrix (Query B onward) includes ONLY realized Business
-- items where BOTH deal_in_channel_id AND deal_out_channel_id are known
-- (NOT NULL). Missing Deal In Channels are NEVER invented or backfilled —
-- a historical-acquisition realized item with no recorded Deal In Channel
-- is EXCLUDED from the journey matrix but explicitly counted in Query A's
-- coverage fields (missing_deal_in_channel_item_count /
-- missing_deal_out_channel_item_count / missing_both_channels_item_count).
-- A missing-channel record is reported, never silently dropped.
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────
-- purpose_name = 'Business' AND is_realized (same "realized-only" base
-- population as 05_deal_out_channel_performance.sql, since a journey needs
-- both an entry and an exit event). Query A reports over this full
-- realized population PLUS the narrower journey_eligible subset (both
-- channels known); Query B onward operate ONLY on journey_eligible.
--
-- ── WHY THIS FILE NEVER MIXES ACQUISITION_VALUE_STATUS RESTRICTIONS ─────
-- Unlike 01/02/03/04/05's banded sections, no query in this file restricts
-- to acquisition_value_status = 'positive' — Channel Journey is about WHERE
-- items moved, not about ranking profit by acquisition price band. A
-- zero-assigned or historical item's journey is just as real a path as any
-- other and is included here as long as both channels are known.
--
-- ── SAME CHANNEL — DESCRIPTIVE, NOT CAUSAL ──────────────────────────────
-- "Same channel" (Query C, D) means deal_in_channel_id = deal_out_channel_id
-- — the item entered and left inventory through contact with the SAME
-- channel. This is DESCRIPTIVE PATH EVIDENCE ONLY. same_channel_exit_percent
-- is NEVER a "conversion rate" — it does not measure how many items listed
-- on a channel sold there, does not imply the channel CAUSED the exit, and
-- must not be compared against Deal In Channel's own item counts (file 04)
-- or Deal Out Channel's own item counts (file 05) as though they shared a
-- denominator: file 04's population is ALL Business items (open + realized,
-- deal_in known or not); file 05's population is ALL realized items
-- (deal_out known or not); THIS file's population is the narrower
-- intersection — realized AND both channels known. Report the sample size
-- (journey_eligible_item_count / eligible_realized_item_count) and
-- `confidence` alongside every path percentage — never a bare percentage.
--
-- ── DOM vs. HOLDING (see 01_acquisition_value_band_performance.sql's
-- TIMING SEMANTICS section for the full explanation) ────────────────────
-- global_days_on_market (DOM) is the PRIMARY market-liquidity metric.
-- holding_days is SECONDARY ownership/capital-cycle context and EXCLUDES
-- historical imports AND any row with has_lifecycle_date_issue = true —
-- the SAME eligibility rule used everywhere else in this analytics layer.
-- Historical items MAY contribute to the journey matrix (Query B) — a
-- historical acquisition with a KNOWN Deal In Channel is still a real,
-- known path — but they are still excluded from holding_sample_size /
-- median_holding_days specifically, same as every other module.
--
-- net_profit and roi reuse analytics_item_lifecycle's own columns exactly
-- as computed. Nothing in this file re-derives either column.
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
-- identity. No per-user channel breakdown exists in this file.
-- ============================================================================


-- ============================================================================
-- QUERY A — Population summary and journey coverage
-- CLASSIFICATION: shared aggregate evidence.
-- Run this first. Reconciliation (verify by eye against this row):
--   realized_business_item_count = journey_eligible_item_count
--                                 + missing_deal_in_channel_item_count
--                                 + missing_deal_out_channel_item_count
--                                 - missing_both_channels_item_count
-- (subtracting missing_both_channels_item_count avoids double-counting
-- items that are missing BOTH channels — they would otherwise be counted
-- once in missing_deal_in_channel_item_count and once in
-- missing_deal_out_channel_item_count).
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
),
journey_eligible AS (
  SELECT * FROM realized_business
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
)
SELECT
  (SELECT COUNT(*) FROM realized_business)                                              AS realized_business_item_count,
  (SELECT COUNT(*) FROM journey_eligible)                                                AS journey_eligible_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE deal_in_channel_id IS NULL)              AS missing_deal_in_channel_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE deal_out_channel_id IS NULL)             AS missing_deal_out_channel_item_count,
  (SELECT COUNT(*) FROM realized_business WHERE deal_in_channel_id IS NULL AND deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
  ROUND(
    (SELECT COUNT(*) FROM journey_eligible)::numeric
      / NULLIF((SELECT COUNT(*) FROM realized_business), 0) * 100,
    2
  )                                                                                     AS journey_coverage_percent,
  (SELECT COUNT(*) FROM journey_eligible WHERE exit_type = 'sale')                       AS journey_sale_exit_item_count,
  (SELECT COUNT(*) FROM journey_eligible WHERE exit_type = 'trade')                      AS journey_trade_exit_item_count,
  (SELECT COUNT(*) FROM journey_eligible WHERE is_historical_import)                     AS historical_journey_eligible_item_count,
  (SELECT COUNT(*) FROM journey_eligible WHERE NOT is_historical_import)                 AS app_tracked_journey_eligible_item_count,
  (SELECT COUNT(DISTINCT deal_in_channel_id) FROM journey_eligible)                      AS distinct_deal_in_channel_count,
  (SELECT COUNT(DISTINCT deal_out_channel_id) FROM journey_eligible)                     AS distinct_deal_out_channel_count;


-- ============================================================================
-- QUERY B — Deal In -> Deal Out matrix
-- CLASSIFICATION: shared aggregate evidence.
-- One row per OBSERVED (deal_in_channel, deal_out_channel) pair — a plain
-- GROUP BY only returns pairs that actually occur, no empty combination is
-- fabricated. Only journey_eligible items (both channels known) can appear
-- here — a missing-channel item is never assigned a fabricated pair.
--
-- distinct_acquisition_deal_count / distinct_exit_deal_count count DISTINCT
-- acquisition_deal_id / exit_deal_id, not items — a single multi-item trade
-- deal (incoming OR outgoing) contributes many items but one deal on
-- whichever side it applies to; the two counts are tracked separately
-- because a row's acquisition-side and exit-side deal-sharing can differ
-- independently (e.g. two items acquired together but sold separately, or
-- vice versa).
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
),
journey_eligible AS (
  SELECT * FROM realized_business
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
)
SELECT
  deal_in_channel_id,
  deal_in_channel_name,
  deal_out_channel_id,
  deal_out_channel_name,
  COUNT(*)                                                                       AS journey_item_count,
  COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
  COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
  COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
  SUM(net_profit)                                                                AS total_realized_net_profit,
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
FROM journey_eligible
GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST;


-- ============================================================================
-- QUERY C — Same-channel summary
-- CLASSIFICATION: shared aggregate evidence.
-- Single-row summary across ALL journey_eligible items. "Same channel"
-- means deal_in_channel_id = deal_out_channel_id (the item entered and left
-- inventory through contact with the SAME channel). This is DESCRIPTIVE
-- PATH EVIDENCE ONLY — same_channel_exit_percent is NOT a conversion rate,
-- does NOT imply the channel caused the exit, and must always be read
-- alongside journey_eligible_item_count (the sample size) — see the file
-- header's "SAME CHANNEL — DESCRIPTIVE, NOT CAUSAL" section.
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
),
journey_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM realized_business
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
)
SELECT
  COUNT(*)                                                                       AS journey_eligible_item_count,
  COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
  COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
  ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)     AS same_channel_exit_percent,
  ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)  AS different_channel_exit_percent,
  COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
  COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
  COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
  COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
FROM journey_eligible;


-- ============================================================================
-- QUERY D — Same-channel summary by Deal In Channel
-- CLASSIFICATION: shared aggregate evidence.
-- Same "same channel" definition as Query C, one row per Deal In Channel.
-- Still descriptive path evidence, not a conversion rate — see the file
-- header. eligible_realized_item_count is this row's own sample size;
-- `confidence` is derived from it, exactly like every other grouped
-- section in this analytics layer.
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
),
journey_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM realized_business
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
)
SELECT
  deal_in_channel_id,
  deal_in_channel_name,
  COUNT(*)                                                                       AS eligible_realized_item_count,
  COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
  COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
  ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM journey_eligible
GROUP BY deal_in_channel_id, deal_in_channel_name
ORDER BY deal_in_channel_name NULLS LAST;


-- ============================================================================
-- QUERY E — Paths by acquisition/exit method
-- CLASSIFICATION: shared aggregate evidence.
-- Same journey_eligible population as Query B, additionally grouped by
-- acquisition_method and exit_method. acquisition_method is already
-- normalized to exactly 'purchase' / 'trade' / 'unknown' by the view.
-- exit_method is derived defensively here (is_realized already guarantees
-- exit_type IN ('sale','trade') today, so 'unknown' is unreachable in this
-- schema, but the derivation exists so this query's own output contract
-- never silently breaks if a future exit method is introduced — matching
-- 05_deal_out_channel_performance.sql's own defensive convention).
-- ============================================================================
WITH realized_business AS (
  SELECT
    *,
    CASE WHEN exit_type IN ('sale', 'trade') THEN exit_type ELSE 'unknown' END AS exit_method
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
),
journey_eligible AS (
  SELECT * FROM realized_business
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
)
SELECT
  deal_in_channel_id,
  deal_in_channel_name,
  deal_out_channel_id,
  deal_out_channel_name,
  acquisition_method,
  exit_method,
  COUNT(*)                                                                       AS journey_item_count,
  COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM journey_eligible
GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method;
