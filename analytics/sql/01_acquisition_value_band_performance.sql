-- ============================================================================
-- 01_acquisition_value_band_performance.sql
--
-- Business question: which acquisition-value range gives the best balance of
-- absolute profit, ROI, turnover speed, capital efficiency, and open-
-- inventory risk?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations). See analytics/README.md.
--
-- ── TERMINOLOGY ──────────────────────────────────────────────────────────
-- This file groups items by ACQUISITION VALUE BAND — acquisition_value,
-- which may be either a cash purchase value or an assigned incoming trade
-- value. It is never called "Purchase Price Band" here: every query in this
-- file includes both purchase- and trade-acquired items (see Query G3's
-- acquisition-method breakdown), so "purchase price" would misdescribe the
-- population. Do not describe acquisition_value as "purchase price" unless
-- a query is explicitly filtered to acquisition_method = 'purchase' — no
-- query in this file does that filtering today. See
-- analytics/SEMANTIC_CONTRACT.md for the full Acquisition Value Band /
-- Purchase Price Band / Exit Value Band / Sale Price Band definitions.
--
-- ── HOW TO READ THIS FILE ───────────────────────────────────────────────────
-- Each query is a fully self-contained statement (its own WITH clause,
-- including its own copy of the `acquisition_value_band` CTE) so any single
-- query can be copy-pasted and run alone. The `acquisition_value_band` CTE
-- text is intentionally IDENTICAL byte-for-byte in every query that needs
-- fixed acquisition value bands — if you ever edit the band boundaries, edit
-- every occurrence together, or the queries will silently stop agreeing
-- with each other.
--
-- Open inventory (Query E) is two queries, E1 (listed) and E2 (owned / not
-- listed), not one — they don't share a meaningful timing metric, so
-- combining them would either force a market-age number onto items that
-- were never listed, or hide it for items that were. See E1/E2 below.
--
-- ── METHODOLOGY / LIMITATIONS (read before interpreting any result) ────────
-- 1. ASSOCIATION, NOT CAUSATION. An acquisition value band showing a higher
--    median ROI did not necessarily cause that ROI. Acquisition value is
--    entangled with brand, category, condition, liquidity, acquisition
--    method, and seller behavior — any of which could be the actual driver.
-- 2. CONFOUNDING. A $4,000+ guitar and a $200 pedal are not interchangeable
--    "acquisition value" data points; see Query F for a category-adjusted
--    view before drawing conclusions from the unadjusted bands in Query B.
-- 3. ONLY ACQUISITION_DATE IS APPROXIMATE FOR HISTORICAL IMPORTS. Historical
--    Import / Historical Purchase / Historical Trade records were
--    transferred from Excel; their listing dates and days-on-market were
--    tracked accurately. The ONE field this file treats as approximate for
--    those three deal types is acquisition_date (there is no placeholder
--    convention in this app as of this writing —
--    acquisition_date_is_placeholder is currently always false; it was
--    entered after the fact, not captured live by a Buy/Trade operation).
--    Historical imports are NOT "unreliable data" in general — they remain
--    fully included in sample_size, realized_items, profit, ROI,
--    realization rate, exit mix, acquisition method, and DOM everywhere in
--    this file. The acquisition_date approximation affects ONLY metrics
--    measured FROM acquisition_date (holding_days, ownership age,
--    acquisition-to-listing delay, and anything normalized by holding_days)
--    — every query in this file that aggregates holding_days excludes the
--    three historical deal types from THAT aggregate specifically (Query
--    B/C/F1/G1-G4's holding_sample_size/median_holding_days, D1/D2's
--    time-adjusted profit, E1/E2's holding-time metrics), while leaving
--    every other column for those same rows untouched. It does NOT affect
--    DOM (global_days_on_market), which is measured from first_listed_at,
--    not acquisition_date — every query in this file keeps historical
--    acquisitions IN its DOM metrics; see E1's header comment. See Query
--    G1 for the imported-historical-vs-app-tracked cohort comparison, and
--    analytics/SEMANTIC_CONTRACT.md for the full rule.
-- 4. OPEN INVENTORY HAS NOT PRODUCED A FINAL RESULT YET. Open items'
--    holding_days/global_days_on_market are still growing and their
--    net_profit/roi are NULL by definition (not zero, not bad — just not yet
--    known). Never blend open-item age into a realized "days to exit"
--    statistic — see TIMING SEMANTICS below.
-- 5. MEDIANS ARE PRIMARY. PERCENTILE_CONT(0.5) is used as the main
--    central-tendency metric throughout. As of the timing-semantics
--    standardization, most aggregate queries (B, C, F1, G1, G2, G3) report
--    medians only, to keep each query's schema focused on a single reading;
--    Query D1/D2's capital-efficiency metric still shows an average
--    alongside its median for that one figure specifically.
-- 6. SMALL GROUPS ARE NOT CONCLUSIONS. Every grouped query exposes its
--    sample_size (or equivalent) so a group of 2-3 items is never mistaken
--    for a reliable pattern. A working rule of thumb used in this file:
--    treat sample_size < 5 as "not yet reliable" (see Query F's comment).
--    Query G4's outlier trim uses a separate, larger threshold (sample_size
--    < 20 → no trimming at all) because a 5% trim of a small band rounds to
--    zero anyway — see Query G4.
--
-- ── TIMING SEMANTICS (read before touching any day-count metric) ───────────
-- Two fundamentally different clocks appear throughout this file. Never
-- conflate them, and never substitute one for the other:
--
-- - global_days_on_market (DOM) is the PRIMARY market-liquidity / market-
--   velocity metric: time the item has actually been listed for sale
--   (exit_date - first_listed_at for realized items; CURRENT_DATE -
--   first_listed_at, still growing, for open items). This is what "how
--   fast does this sell" means in this file.
-- - holding_days is SECONDARY ownership-duration / capital-cycle context:
--   time since acquisition (exit_date - acquisition_date, or CURRENT_DATE -
--   acquisition_date while open). It answers "how long is money tied up in
--   this item," not "how liquid is this item on the market." Holding time
--   must never be described as listing time, market speed, or liquidity
--   anywhere in this file.
-- - acquisition_to_first_listing_days (days_acquisition_to_first_listing in
--   the view) is the delay between acquiring an item and first listing it
--   for sale. It is NOT market time and is not evidence of poor liquidity —
--   a long delay just means the item sat owned before it was ever listed
--   (common for Historical Import/Purchase/Trade items acquired well before
--   this app existed). See Query G5.
-- - Missing global_days_on_market ALWAYS stays NULL. It is never
--   backfilled with holding_days or with zero — an item that has never
--   been listed has no market-exposure duration to report, full stop.
--
-- Standard shape for an aggregate query reporting realized timing:
--   sample_size, realized_items, dom_sample_size, median_days_on_market,
--   holding_sample_size, median_holding_days — where dom_sample_size /
--   median_days_on_market count and summarize ONLY realized rows with
--   non-null global_days_on_market (historical imports included), and
--   holding_sample_size / median_holding_days count and summarize ONLY
--   realized, non-historical-import rows with non-null holding_days. Open
--   items never contribute to a realized timing median anywhere in this file
--   except Query E1/E2, which are explicitly about open inventory and say
--   so.
--
-- ── QUERY CLASSIFICATION INDEX (evidence vs. recommendation vs. developer-only;
-- see analytics/SEMANTIC_CONTRACT.md for the full definitions) ─────────────
-- Every query below is SHARED AGGREGATE EVIDENCE — pooled across every user
-- accessible to the querying role, returning only counts/medians/labels, with
-- TWO exceptions:
--   Query G2 — DEVELOPER-ONLY diagnostic (per-user grouped comparison; final
--     scope decision — never appears in the user-facing snapshot even though
--     it contains no single item's own data, because a per-user breakdown is
--     itself information about another user's activity).
--   Query G5 — DEVELOPER-ONLY item-level verification drilldown (returns
--     item_id, user_id, item_display_name for every eligible item across
--     every user). Not part of a future shared aggregate snapshot or
--     user-facing recommendation output — see G5's own header.
-- No query in this file is a current-user recommendation candidate: nothing
-- here filters to a single target user's own items, which is what that
-- population requires (see analytics/SEMANTIC_CONTRACT.md).
-- ============================================================================


-- ============================================================================
-- QUERY A1 — Data coverage: summary counts
-- CLASSIFICATION: shared aggregate evidence.
-- Purpose: establish whether every group has enough usable data before
-- interpreting any query below. Run this first.
-- ============================================================================
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
)
SELECT
  (SELECT COUNT(*) FROM acquisition_value_band)                                                          AS total_lifecycle_rows,
  (SELECT COUNT(*) FROM business)                                                             AS business_items,
  (SELECT COUNT(*) FROM acquisition_value_band WHERE purpose_name IS DISTINCT FROM 'Business')             AS non_business_items,
  (SELECT COUNT(*) FROM business WHERE is_realized)                                            AS realized_business_items,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized)                                        AS open_business_items,
  (SELECT COUNT(*) FROM business WHERE exit_type = 'sale')                                      AS sale_exits,
  (SELECT COUNT(*) FROM business WHERE exit_type = 'trade')                                     AS trade_exits,
  (SELECT COUNT(*) FROM business WHERE is_historical_import)                                    AS historical_import_business_items,
  (SELECT COUNT(*) FROM business WHERE NOT is_historical_import)                                AS non_historical_import_business_items,
  (SELECT COUNT(*) FROM business WHERE acquisition_value > 0)                                   AS acquisition_value_positive,
  (SELECT COUNT(*) FROM business WHERE acquisition_value = 0)                                   AS acquisition_value_zero,
  (SELECT COUNT(*) FROM business WHERE acquisition_value < 0)                                   AS acquisition_value_negative,
  (SELECT COUNT(*) FROM business WHERE acquisition_value IS NULL)                                AS acquisition_value_null,
  (SELECT COUNT(*) FROM business WHERE has_lifecycle_date_issue)                                 AS rows_with_lifecycle_date_issues,

  -- Timing coverage — holding-time and DOM are tracked SEPARATELY, and
  -- realized/open are never mixed. See TIMING SEMANTICS above.
  (SELECT COUNT(*) FROM business WHERE is_realized AND holding_days IS NOT NULL)                 AS realized_holding_days_usable_count,
  (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NOT NULL)        AS realized_dom_usable_count,
  (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NULL)             AS realized_dom_missing_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed'
                                    AND global_days_on_market IS NOT NULL)                        AS open_listed_dom_usable_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status <> 'listed'
                                    AND global_days_on_market IS NULL)                            AS open_unlisted_no_dom_count,

  (SELECT MIN(acquisition_value) FROM business WHERE acquisition_value > 0)                      AS min_acquisition_value_positive,
  (SELECT MAX(acquisition_value) FROM business WHERE acquisition_value > 0)                      AS max_acquisition_value_positive,
  (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2)
     FROM business WHERE acquisition_value > 0)                                                  AS median_acquisition_value_positive,
  (SELECT MIN(acquisition_date) FROM business)                                                   AS min_acquisition_date,
  (SELECT MAX(acquisition_date) FROM business)                                                   AS max_acquisition_date,
  (SELECT MIN(exit_date) FROM business)                                                          AS min_exit_date,
  (SELECT MAX(exit_date) FROM business)                                                          AS max_exit_date;


-- ============================================================================
-- QUERY A2 — Data coverage: item count in each fixed acquisition value band
-- CLASSIFICATION: shared aggregate evidence.
-- (Business items only, all acquisition values including Zero / unknown.)
-- ============================================================================
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
)
SELECT
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*) AS item_count
FROM business
GROUP BY acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order;


-- ============================================================================
-- QUERY B — Main fixed acquisition value band performance
-- CLASSIFICATION: shared aggregate evidence.
-- Business items, positive acquisition value only. This is the main
-- descriptive result the rest of this file's robustness checks (Query C, F,
-- G1-G4) test the stability of.
--
-- days_on_market (DOM) is the PRIMARY timing metric here — it measures
-- actual market exposure/liquidity. holding_days is SECONDARY capital-cycle
-- context (time since acquisition) — see TIMING SEMANTICS at the top of
-- this file. Both are computed ONLY from realized rows: an open item's
-- holding_days/global_days_on_market is still-accruing current age, not a
-- completed duration — mixing it in would distort both metrics. Open-item
-- age lives in Query E1/E2.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  acquisition_value_band_order,
  acquisition_value_band_label,

  COUNT(*)                                    AS sample_size,
  COUNT(*) FILTER (WHERE is_realized)         AS realized_items,

  -- realization_rate_percent numerator = realized_items, denominator =
  -- sample_size (both shown above). 0-100 SCALE — the _percent suffix is
  -- deliberate so a 0-1 ratio is never mistaken for it.
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,

  COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,

  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,

  -- PRIMARY timing metric: market exposure / liquidity.
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- SECONDARY context: ownership / capital-cycle duration. Not a liquidity
  -- metric. Excludes Historical Import/Purchase/Trade — holding_days is
  -- measured from acquisition_date, the one field this file treats as
  -- approximate for those three deal types (see METHODOLOGY item 3). This
  -- does NOT remove historical rows from sample_size, realized_items,
  -- median_net_profit, median_roi, or the DOM metrics above — only from this
  -- one holding-based pair of columns.
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days

FROM eligible
GROUP BY acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order;


-- ============================================================================
-- QUERY C — Equal-size acquisition-value quartiles
-- CLASSIFICATION: shared aggregate evidence.
-- Same population as Query B (Business, acquisition_value > 0), grouped into
-- ~equal-sized quartiles instead of fixed $ bands, to check whether the
-- pattern in Query B survives when sample sizes are balanced.
--
-- NOTE: NTILE(4) boundaries are a function of the CURRENT data distribution.
-- As more items are acquired, the acquisition-value cut points between Q1/Q2/
-- Q3/Q4 will shift — unlike the fixed $ bands in acquisition_value_band, these quartile
-- boundaries are not a stable reporting definition and will differ each time
-- this query is re-run against a larger dataset.
--
-- Same DOM-first timing structure as Query B: median_days_on_market is the
-- primary timing read, median_holding_days is secondary capital-cycle
-- context — quartile holding time is ownership duration, not market
-- velocity (see TIMING SEMANTICS at the top of this file).
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
quartiled AS (
  SELECT *, NTILE(4) OVER (ORDER BY acquisition_value) AS quartile
  FROM eligible
)
SELECT
  quartile,
  COUNT(*)                                                      AS sample_size,
  MIN(acquisition_value)                                        AS minimum_acquisition_value,
  MAX(acquisition_value)                                        AS maximum_acquisition_value,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)::numeric, 2) AS median_acquisition_value,

  COUNT(*) FILTER (WHERE is_realized) AS realized_items,
  -- 0-100 scale — see Query B's comment on the _percent suffix.
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,

  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,

  -- PRIMARY timing metric: market exposure / liquidity.
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- SECONDARY context: ownership / capital-cycle duration. Not a liquidity
  -- metric. Excludes Historical Import/Purchase/Trade — same holding-only
  -- exclusion rationale as Query B; sample_size/realized_items/profit/ROI/DOM
  -- above are unaffected.
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
FROM quartiled
GROUP BY quartile
ORDER BY quartile;


-- ============================================================================
-- CLASSIFICATION: shared aggregate evidence.
-- QUERY D1 — Capital efficiency (PRIMARY: Historical Import/Purchase/Trade
-- excluded from the time-adjusted metrics — their acquisition dates are less
-- trustworthy)
--
-- median_profit_per_30_holding_days measures CAPITAL-CYCLE efficiency (net
-- profit normalized by how many 30-day periods the capital was tied up in
-- the item, i.e. holding_days) — it is NOT a repeatable monthly profit rate
-- (an item doesn't repeat this trade every 30 days) and NOT a market-
-- liquidity metric (that's global_days_on_market's job — see
-- dom_sample_size / median_days_on_market below, added so capital-cycle
-- duration can be compared separately from actual market time). Deliberately
-- NOT turned into a "profit per DOM day" ratio: DOM values can be very
-- short (a same-week sale), and dividing profit by a small denominator
-- produces unstable, misleading per-day figures.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
capital AS (
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
-- Time-adjusted population: realized, positive acquisition value (guaranteed
-- by `eligible`), holding_days > 0 (excludes same-day exits — a same-day
-- flip would otherwise produce a meaningless "infinite velocity" figure),
-- not a Historical Import/Purchase/Trade, and no lifecycle date issue.
-- global_days_on_market is carried through unfiltered-by-value so DOM
-- coverage/median can be computed on the same population without requiring
-- holding_days > 0 twice.
timing_eligible AS (
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
timing AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*)                                                                     AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit_per_30_holding_days)      AS median_profit_per_30_holding_days,
    AVG(profit_per_30_holding_days)                                              AS average_profit_per_30_holding_days,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                    AS dom_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)                          AS median_days_on_market
  FROM timing_eligible
  GROUP BY acquisition_value_band_order
)
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
FROM capital
LEFT JOIN timing ON timing.acquisition_value_band_order = capital.acquisition_value_band_order
ORDER BY capital.acquisition_value_band_order;


-- ============================================================================
-- QUERY D2 — Capital efficiency: time-adjusted SENSITIVITY
-- CLASSIFICATION: shared aggregate evidence.
-- (Historical Import/Purchase/Trade INCLUDED — compare against Query D1's
-- primary result. If the pattern changes a lot once they're added back in,
-- that's a sign the primary result is sensitive to their less-reliable
-- dates.)
--
-- Adds dom_sample_size/median_days_on_market alongside the existing
-- holding_sample_size/median_holding_days so capital-cycle duration
-- (holding-based) can be compared separately from actual market time
-- (DOM-based) for each population. holding_sample_size will typically equal
-- this query's own qualifying_item_count, since the population is already
-- restricted to holding_days > 0 — it's shown explicitly for schema
-- consistency with the rest of the file, and to make the DOM/holding
-- distinction visible at a glance.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
timing_primary AS (
  SELECT 'Primary (Historical Import/Purchase/Trade excluded)' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days,
    holding_days,
    global_days_on_market
  FROM eligible
  WHERE is_realized AND holding_days > 0 AND NOT is_historical_import AND NOT has_lifecycle_date_issue
),
timing_with_historical AS (
  SELECT 'Sensitivity (Historical Import/Purchase/Trade included)' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days,
    holding_days,
    global_days_on_market
  FROM eligible
  WHERE is_realized AND holding_days > 0 AND NOT has_lifecycle_date_issue
),
combined AS (
  SELECT * FROM timing_primary
  UNION ALL
  SELECT * FROM timing_with_historical
)
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
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit_per_30_holding_days)::numeric, 2)  AS median_profit_per_30_holding_days,
  ROUND(AVG(profit_per_30_holding_days), 2)                                          AS average_profit_per_30_holding_days
FROM combined
GROUP BY population_label, acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order, population_label;


-- ============================================================================
-- QUERY E1 — Open inventory: LISTED items (currently on the market)
-- CLASSIFICATION: shared aggregate evidence.
-- "Open" = NOT is_realized (the view's own lifecycle fact — current_status
-- currently new/owned/listed, never sold/traded). Business items, ALL
-- acquisition values (including Zero / unknown) since this is about risk
-- exposure, not profit/ROI math.
--
-- Reported separately from Query E2 (owned / not-listed) because a listed
-- item has real market-exposure (DOM) to report and an unlisted one does
-- not — combining them into one median "market age" would either invent a
-- DOM figure for items never listed, or silently drop DOM for the ones that
-- have it. See TIMING SEMANTICS at the top of this file.
--
-- listed_estimated_net_upside SUBTRACTS item expenses from the
-- estimated-sold-value-minus-cost figure, so it is named "net", not
-- "gross" (the prior version of this query subtracted expenses but was
-- named estimated_gross_upside — a naming bug, fixed here).
--
-- DOM vs. holding use DIFFERENT eligibility populations, deliberately:
-- - dom_sample_size / median_current_days_on_market / max_current_days_on_market
--   include every listed item with global_days_on_market IS NOT NULL and
--   has_lifecycle_date_issue = false. A historical acquisition record does
--   NOT exclude an item here — is_historical_import describes how/when the
--   item was ACQUIRED, not whether its listing date or current market
--   exposure is trustworthy. Those are independent facts; an item can have
--   an approximate acquisition date and a perfectly real, currently-ticking
--   DOM clock.
-- - holding_sample_size / median_holding_days additionally exclude
--   Historical Import/Purchase/Trade, because holding_days is measured FROM
--   acquisition_date, and that's the date that may be approximate for those
--   three deal types (see METHODOLOGY item 3). holding_excluded_historical_count
--   makes this exclusion's size visible instead of silently shrinking the
--   sample.
-- ============================================================================
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
listed_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status = 'listed'
),
listed_full AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                    AS listed_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS listed_acquisition_capital,
    SUM(estimated_sold_value)                                   AS listed_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside
  FROM listed_items
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
-- DOM-eligible population: excludes only rows already flagged with a
-- lifecycle date issue. Historical acquisition status does NOT exclude an
-- item from DOM — see the header comment above.
listed_dom_eligible AS (
  SELECT * FROM listed_items
  WHERE NOT has_lifecycle_date_issue
),
listed_dom_summary AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)        AS median_current_days_on_market,
    MAX(global_days_on_market)                                 AS max_current_days_on_market
  FROM listed_dom_eligible
  GROUP BY acquisition_value_band_order
),
-- Holding-eligible population: additionally excludes Historical
-- Import/Purchase/Trade (is_historical_import) — holding_days is measured
-- from acquisition_date, which may be approximate for those three deal
-- types (see METHODOLOGY item 3). This is a NARROWER population than DOM's,
-- on purpose.
listed_holding_eligible AS (
  SELECT * FROM listed_items
  WHERE NOT has_lifecycle_date_issue AND NOT is_historical_import
),
listed_holding_summary AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL) AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)        AS median_holding_days
  FROM listed_holding_eligible
  GROUP BY acquisition_value_band_order
),
-- Coverage: how many otherwise holding-eligible listed items (usable
-- holding_days, no lifecycle date issue) were excluded from the holding
-- sample purely for being a historical acquisition.
listed_holding_excluded AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL) AS holding_excluded_historical_count
  FROM listed_dom_eligible
  GROUP BY acquisition_value_band_order
)
SELECT
  listed_full.acquisition_value_band_order,
  listed_full.acquisition_value_band_label,
  listed_full.listed_item_count,
  listed_full.listed_acquisition_capital,
  listed_full.listed_estimated_value,
  CASE
    WHEN listed_full.listed_estimated_value IS NOT NULL AND listed_full.acquisition_for_upside IS NOT NULL
    THEN listed_full.listed_estimated_value
         - listed_full.acquisition_for_upside
         - COALESCE(listed_full.item_expenses_for_upside, 0)
    ELSE NULL
  END AS listed_estimated_net_upside,

  COALESCE(listed_dom_summary.dom_sample_size, 0)                      AS dom_sample_size,
  ROUND(listed_dom_summary.median_current_days_on_market::numeric, 2) AS median_current_days_on_market,
  listed_dom_summary.max_current_days_on_market,

  COALESCE(listed_holding_summary.holding_sample_size, 0)        AS holding_sample_size,
  ROUND(listed_holding_summary.median_holding_days::numeric, 2) AS median_holding_days,
  COALESCE(listed_holding_excluded.holding_excluded_historical_count, 0) AS holding_excluded_historical_count

FROM listed_full
LEFT JOIN listed_dom_summary     ON listed_dom_summary.acquisition_value_band_order     = listed_full.acquisition_value_band_order
LEFT JOIN listed_holding_summary ON listed_holding_summary.acquisition_value_band_order = listed_full.acquisition_value_band_order
LEFT JOIN listed_holding_excluded ON listed_holding_excluded.acquisition_value_band_order = listed_full.acquisition_value_band_order
ORDER BY listed_full.acquisition_value_band_order;


-- ============================================================================
-- QUERY E2 — Open inventory: OWNED / NOT-LISTED items (never listed yet)
-- CLASSIFICATION: shared aggregate evidence.
-- Companion to E1. These items have no market exposure to report — this
-- query never calculates or implies a DOM/market-age figure for them (see
-- TIMING SEMANTICS at the top of this file). median_ownership_age_days /
-- max_ownership_age_days are holding_days (time since acquisition),
-- explicitly an ownership/capital-cycle metric, not a market-time one.
--
-- unlisted_estimated_net_upside subtracts item expenses — see E1's header
-- comment on the estimated_gross_upside → estimated_net_upside naming fix.
-- ============================================================================
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
unlisted_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status <> 'listed'
),
unlisted_full AS (
  SELECT
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                    AS unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS unlisted_acquisition_capital,
    SUM(estimated_sold_value)                                   AS unlisted_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside
  FROM unlisted_items
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
-- Reliable age population — same reliability rationale as E1/D1/D2.
unlisted_reliable AS (
  SELECT * FROM unlisted_items
  WHERE NOT is_historical_import AND NOT has_lifecycle_date_issue
),
unlisted_reliable_summary AS (
  SELECT
    acquisition_value_band_order,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL)         AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)                AS median_ownership_age_days,
    MAX(holding_days)                                         AS max_ownership_age_days
  FROM unlisted_reliable
  GROUP BY acquisition_value_band_order
)
SELECT
  unlisted_full.acquisition_value_band_order,
  unlisted_full.acquisition_value_band_label,
  unlisted_full.unlisted_item_count,
  unlisted_full.unlisted_acquisition_capital,
  unlisted_full.unlisted_estimated_value,
  CASE
    WHEN unlisted_full.unlisted_estimated_value IS NOT NULL AND unlisted_full.acquisition_for_upside IS NOT NULL
    THEN unlisted_full.unlisted_estimated_value
         - unlisted_full.acquisition_for_upside
         - COALESCE(unlisted_full.item_expenses_for_upside, 0)
    ELSE NULL
  END AS unlisted_estimated_net_upside,

  COALESCE(unlisted_reliable_summary.holding_sample_size, 0)              AS holding_sample_size,
  ROUND(unlisted_reliable_summary.median_ownership_age_days::numeric, 2) AS median_ownership_age_days,
  unlisted_reliable_summary.max_ownership_age_days

FROM unlisted_full
LEFT JOIN unlisted_reliable_summary ON unlisted_reliable_summary.acquisition_value_band_order = unlisted_full.acquisition_value_band_order
ORDER BY unlisted_full.acquisition_value_band_order;


-- ============================================================================
-- QUERY F1 — Category-adjusted acquisition value band performance
-- CLASSIFICATION: shared aggregate evidence.
-- Same population as Query B (Business, acquisition_value > 0), broken down
-- by category as well as acquisition value band, so a $500 pedal and a
-- $5,000 guitar are never silently pooled into the same comparison.
--
-- Same DOM-first timing structure as Query B — median_days_on_market is
-- primary, median_holding_days is secondary capital-cycle context.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  category_id,
  category_name,
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                                    AS sample_size,
  COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
  COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,
  -- 0-100 scale — see Query B's comment on the _percent suffix.
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,

  -- PRIMARY timing metric: market exposure / liquidity.
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- SECONDARY context: ownership / capital-cycle duration. Not a liquidity
  -- metric. Excludes Historical Import/Purchase/Trade — same holding-only
  -- exclusion rationale as Query B; sample_size/realized_items/profit/ROI/DOM
  -- above are unaffected.
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
FROM eligible
GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
ORDER BY category_id, acquisition_value_band_order;
-- NOTE: every category x acquisition-value-band group is returned, including groups with
-- very few items — nothing is filtered out here. Treat any group with
-- sample_size below a configurable minimum (suggested starting point: 5) as
-- not yet reliable when INTERPRETING this result; do not apply that
-- threshold as a WHERE/HAVING clause in the query itself.


-- ============================================================================
-- QUERY F2 — Category-level acquisition-value distribution (summary)
-- CLASSIFICATION: shared aggregate evidence.
-- Companion to F1: shows whether certain acquisition value bands only exist for
-- particular categories (e.g. a category that never has a $5,000+ item).
-- No timing metrics in this query — item counts only.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  category_id,
  category_name,
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*) AS item_count
FROM eligible
GROUP BY category_id, category_name, acquisition_value_band_order, acquisition_value_band_label
ORDER BY category_id, acquisition_value_band_order;


-- ============================================================================
-- QUERY G1 — Cohort comparison: imported historical vs. app-tracked
-- CLASSIFICATION: shared aggregate evidence.
-- Same primary fixed-band metrics, computed for three population rows per
-- acquisition value band: all eligible items, the imported-historical cohort alone
-- (Historical Import, Historical Purchase, Historical Trade —
-- is_historical_import is true for all three; see analytics_item_lifecycle's
-- derivation), and the app-tracked cohort alone (is_historical_import
-- false).
--
-- This is a COHORT COMPARISON, not a data-reliability test. The imported
-- historical cohort and the app-tracked cohort are different populations of
-- real deals, tracked at different times, entered by different means — a
-- difference between them may reflect changes in deal quality, inventory
-- mix, or business behavior over time. It is NOT evidence that the
-- historical cohort's profit, ROI, or DOM figures are wrong. Only
-- acquisition_date is treated as approximate for the historical cohort (see
-- METHODOLOGY item 3) — nothing else about those records is "unreliable
-- data".
--
-- sample_size, realized_items, median_net_profit, median_roi, dom_sample_size,
-- and median_days_on_market are computed identically for all three rows —
-- historical rows are never dropped from these columns just for being
-- historical. holding_sample_size/median_holding_days are the one exception,
-- and are excluded from EVERY row (including "All eligible") for any item
-- whose acquisition_date is approximate, per METHODOLOGY item 3 — so the
-- "Imported historical" row's holding columns are always 0/NULL by
-- construction: presenting a holding-time figure for a cohort whose
-- acquisition dates are the one field known to be approximate would imply a
-- reliability that column doesn't have. DOM-first timing structure, same as
-- Query B.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
combined AS (
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
)
SELECT
  population_label,
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                            AS sample_size,
  COUNT(*) FILTER (WHERE is_realized) AS realized_items,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,

  -- PRIMARY timing metric: market exposure / liquidity. Never excludes the
  -- imported historical cohort.
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- SECONDARY context: ownership / capital-cycle duration. Not a liquidity
  -- metric. Excludes the imported historical cohort from EVERY row (see
  -- header) — this is why "Imported historical Business items" always shows
  -- holding_sample_size = 0 / median_holding_days = NULL, by design, not a
  -- coverage gap.
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
FROM combined
GROUP BY population_label, acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order, population_label;


-- ============================================================================
-- QUERY G2 — Robustness check: user-level comparison
-- CLASSIFICATION: developer-only diagnostic (final scope decision — per-user
-- grouped comparisons are developer-only robustness diagnostics and must
-- NOT appear in the user-facing snapshot; see
-- analytics/SEMANTIC_CONTRACT.md). Grouped BY user_id as a dimension for
-- robustness-checking during development; no row here is a single item's
-- own data, but breaking results down per user is itself information about
-- another user's activity that a shared snapshot must not expose.
-- Same population, split by user_id, plus a combined "All accessible users"
-- row per band — reveals whether the combined pattern in Query B is actually
-- just one user's behavior, and whether user-level timing differences come
-- from actual market speed (DOM) or ownership/pre-listing duration
-- (holding_days) — see TIMING SEMANTICS at the top of this file.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
per_user AS (
  SELECT
    user_id::text AS user_group,
    acquisition_value_band_order, acquisition_value_band_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
),
combined_all AS (
  SELECT
    'All accessible users' AS user_group,
    acquisition_value_band_order, acquisition_value_band_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
),
unioned AS (
  SELECT * FROM per_user
  UNION ALL
  SELECT * FROM combined_all
)
SELECT
  user_group,
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                            AS sample_size,
  COUNT(*) FILTER (WHERE is_realized) AS realized_items,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,

  -- PRIMARY timing metric: market exposure / liquidity.
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- SECONDARY context: ownership / capital-cycle duration. Not a liquidity
  -- metric. Excludes Historical Import/Purchase/Trade — same holding-only
  -- exclusion rationale as Query B; sample_size/realized_items/profit/ROI/DOM
  -- above are unaffected.
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
FROM unioned
GROUP BY user_group, acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order, user_group;


-- ============================================================================
-- QUERY G3 — Robustness check: acquisition method comparison
-- CLASSIFICATION: shared aggregate evidence.
-- Purchases vs. trades vs. unknown, per acquisition value band — helps
-- identify whether an acquisition value band's apparent performance is
-- really an acquisition-method effect, and lets DOM-based market liquidity,
-- holding-based ownership/
-- pre-listing duration, and capital-cycle duration all be read separately
-- (see TIMING SEMANTICS at the top of this file).
--
-- acquisition_method values: 'purchase' (covers deal_type 'purchase' and
-- 'Historical Purchase'), 'trade' (covers 'trade' and 'Historical Trade'),
-- 'unknown' (deal_type 'Historical Import' — original method not yet known).
-- 'cash' is never used as a stored or grouped value here.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
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

  -- PRIMARY timing metric: market exposure / liquidity.
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- SECONDARY context: ownership / capital-cycle duration. Not a liquidity
  -- metric. Excludes Historical Import/Purchase/Trade — same holding-only
  -- exclusion rationale as Query B; sample_size/realized_items/profit/ROI/DOM
  -- above are unaffected. Note this means the 'unknown' acquisition_method
  -- row (Historical Import) will always show holding_sample_size = 0 here —
  -- expected, not a bug: every row grouped under 'unknown' is historical by
  -- definition (see analytics_item_lifecycle's acquisition_method CASE).
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
FROM eligible
GROUP BY acquisition_method, acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_method, acquisition_value_band_order;


-- ============================================================================
-- QUERY G4 — Robustness check: outlier sensitivity
-- CLASSIFICATION: shared aggregate evidence.
-- Realized Business items with positive acquisition value, compared with and
-- without the top/bottom 5% of net_profit excluded — PER ACQUISITION VALUE BAND.
--
-- FIXED: the previous version used PERCENT_RANK() and kept rows with
-- profit_percent_rank BETWEEN 0.05 AND 0.95, which excludes every row whose
-- net_profit happens to EQUAL a boundary value — not just the intended ~5%
-- at each tail. In the $1-999 band this incorrectly removed several normal
-- $0-profit items that were never meant to be treated as outliers (net_profit
-- = 0 is a common, unremarkable value in that band, not an extreme one).
--
-- Fixed approach — deterministic row-count trimming:
--   1. original_sample_size = realized item count, computed PER acquisition value band.
--   2. trim_count = floor(original_sample_size * 0.05), PER acquisition value band.
--   3. Rows are ranked within each band by net_profit ascending, with
--      item_id as a deterministic tie-breaker (so re-running this query
--      never trims a different row when several items share a net_profit).
--   4. Exactly trim_count rows are removed from the bottom and exactly
--      trim_count from the top — trimming is based on net_profit only.
--   5. Every metric below (including DOM/holding timing) is then computed
--      from that SAME trimmed population, not re-derived from the full set.
--   6. For original_sample_size < 20, trim_count = 0 (floor(19 * 0.05) = 0)
--      — the "Profit outliers excluded" row is OMITTED entirely for those
--      bands rather than shown with removed_low_count = removed_high_count
--      = 0, so a band is never labeled "outliers excluded" when nothing was
--      removed.
--
-- original_sample_size vs. analysis_sample_size: an earlier version of this
-- query only exposed one "sample_size" column, which stayed at the ORIGINAL
-- band population even on the "Profit outliers excluded" row — ambiguous,
-- since the metrics on that row are computed from a SMALLER population.
-- Now both are shown explicitly:
--   original_sample_size = realized items in the band BEFORE trimming
--                           (same for both population rows in a band).
--   analysis_sample_size = rows actually used to compute the metrics on
--                           THIS row — equals original_sample_size for
--                           "All realized items", and
--                           original_sample_size - removed_low_count -
--                           removed_high_count for "Profit outliers
--                           excluded" (falls out directly from GROUP BY:
--                           analysis_sample_size is a plain COUNT(*) over
--                           the same trimmed rows removed_low_count/
--                           removed_high_count describe — verified in this
--                           file's validation run, not just asserted here).
--
-- Days on market (DOM) is the PRIMARY timing metric in the output; holding
-- time remains secondary context — see TIMING SEMANTICS at the top of this
-- file.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
realized AS (
  SELECT * FROM eligible WHERE is_realized
),
banded AS (
  SELECT
    *,
    COUNT(*) OVER (PARTITION BY acquisition_value_band_order)                                          AS band_sample_size,
    ROW_NUMBER() OVER (PARTITION BY acquisition_value_band_order ORDER BY net_profit ASC,  item_id ASC)  AS rank_from_bottom,
    ROW_NUMBER() OVER (PARTITION BY acquisition_value_band_order ORDER BY net_profit DESC, item_id DESC) AS rank_from_top
  FROM realized
),
trimmed AS (
  SELECT
    *,
    FLOOR(band_sample_size * 0.05)::int AS trim_count
  FROM banded
),
full_population AS (
  SELECT
    'All realized items' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    net_profit, roi, holding_days, global_days_on_market, is_historical_import,
    band_sample_size AS original_sample_size,
    0 AS removed_low_count,
    0 AS removed_high_count
  FROM trimmed
),
trimmed_population AS (
  -- Omitted entirely for bands where trim_count = 0, so a band is never
  -- labeled "outliers excluded" when nothing was actually removed.
  SELECT
    'Profit outliers excluded (5% trim each side, by acquisition value band)' AS population_label,
    acquisition_value_band_order, acquisition_value_band_label,
    net_profit, roi, holding_days, global_days_on_market, is_historical_import,
    band_sample_size AS original_sample_size,
    trim_count AS removed_low_count,
    trim_count AS removed_high_count
  FROM trimmed
  WHERE trim_count > 0
    AND rank_from_bottom > trim_count
    AND rank_from_top    > trim_count
),
combined AS (
  SELECT * FROM full_population
  UNION ALL
  SELECT * FROM trimmed_population
)
SELECT
  population_label,
  acquisition_value_band_order,
  acquisition_value_band_label,
  original_sample_size,
  -- Rows actually used to compute the metrics below for THIS row. A plain
  -- COUNT(*) over the GROUP BY: for "All realized items" every original row
  -- survived (no filter applied upstream), so this equals original_sample_size;
  -- for "Profit outliers excluded", trimmed_population already dropped
  -- exactly removed_low_count + removed_high_count rows, so this equals
  -- original_sample_size - removed_low_count - removed_high_count.
  COUNT(*) AS analysis_sample_size,
  removed_low_count,
  removed_high_count,

  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,

  -- Excludes Historical Import/Purchase/Trade — same holding-only exclusion
  -- rationale as Query B. This trims the holding-time pair only; it does not
  -- remove historical rows from analysis_sample_size or the profit/ROI/DOM
  -- metrics in this same row.
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,

  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi
FROM combined
GROUP BY population_label, acquisition_value_band_order, acquisition_value_band_label, original_sample_size, removed_low_count, removed_high_count
ORDER BY acquisition_value_band_order, population_label;


-- ============================================================================
-- QUERY G5 — Item-level drill-down
-- CLASSIFICATION: DEVELOPER-ONLY item-level verification drilldown. Not
-- part of a future shared aggregate snapshot or user-facing recommendation
-- output. Returns item_id, user_id, and item_display_name across every
-- user accessible to the querying role, with no target-user filtering —
-- see analytics/SEMANTIC_CONTRACT.md's developer verification population
-- definition. Never send this query's rows to an AI recommendation
-- process or a current user's UI as-is.
-- Source rows for the same population used by Query B/C/D/E/F/G1-G4, for
-- manually verifying which specific items produced any aggregate above.
--
-- first_listing_date / acquisition_to_first_listing_days are already
-- exposed by analytics_item_lifecycle (as first_listed_at /
-- days_acquisition_to_first_listing) — no view change was needed for this
-- query. acquisition_to_first_listing_days is the delay before an item was
-- first listed; it is NOT a market-time/liquidity figure and should not be
-- read as evidence of poor liquidity (a long delay just means the item sat
-- owned before it was ever listed) — see TIMING SEMANTICS at the top of
-- this file.
--
-- ── LIFECYCLE TIMING INTEGRITY FLAGS ────────────────────────────────────────
-- Three booleans added below. All three default to FALSE (never NULL) when
-- data is missing — missing DOM/listing information is a coverage gap, not
-- an integrity error, so it must never be conflated with an actual flagged
-- inconsistency. See Query G5A for a one-row summary of these same flags.
--
-- - acquisition_to_listing_is_negative: TRUE only when
--   days_acquisition_to_first_listing < 0 (the item's first_listed_at is
--   BEFORE its acquisition_date — the view's own has_listing_before_
--   acquisition flag describes the same fact). FALSE when NULL (never
--   listed, or no acquisition date).
--
-- - dom_exceeds_holding_days: TRUE only when global_days_on_market AND
--   holding_days are both non-null AND global_days_on_market >
--   holding_days. Both are measured from first_listed_at/acquisition_date
--   respectively to the same endpoint (exit_date if realized, else
--   CURRENT_DATE), and an item can't have been on the market longer than
--   it's been owned — so this should never be true for healthy data. FALSE
--   whenever either value is missing.
--
-- - realized_dom_date_mismatch: for REALIZED items with first_listed_at,
--   exit_date, AND global_days_on_market all present, TRUE only when
--   (exit_date - first_listed_at) <> global_days_on_market. This uses the
--   EXACT same date subtraction analytics_item_lifecycle itself uses for
--   global_days_on_market (see
--   20260724000000_historical_deal_type_labels.sql: "WHEN exit_date IS NOT
--   NULL THEN (exit_date - first_listed_at)") — no +1/-1 adjustment — so
--   under correct data this is definitionally always FALSE; it exists as a
--   structural self-consistency check, not a metric expected to ever fire.
--   FALSE for open items (no exit_date to compare) and for any row missing
--   first_listed_at/exit_date/global_days_on_market — chosen deliberately
--   over NULL so this flag (and G5A's count of it) never need special
--   NULL-handling and never gets conflated with a coverage gap.
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
flagged AS (
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
)
SELECT
  item_id,
  user_id,
  item_display_name,

  brand_name,
  category_name,
  type_name,

  acquisition_date,
  acquisition_method,
  acquisition_value,
  acquisition_value_band_label,

  is_historical_import,
  acquisition_date_is_placeholder,

  current_status,
  is_realized,
  exit_date,
  exit_type,
  exit_channel_name,
  exit_value,

  item_expenses_total,
  net_profit,
  roi,

  first_listed_at                    AS first_listing_date,
  days_acquisition_to_first_listing  AS acquisition_to_first_listing_days,
  global_days_on_market,
  holding_days,

  acquisition_to_listing_is_negative,
  dom_exceeds_holding_days,
  realized_dom_date_mismatch,

  estimated_sold_value,
  has_lifecycle_date_issue
FROM flagged
ORDER BY acquisition_value_band_order, is_realized DESC, acquisition_value, item_id;


-- ============================================================================
-- QUERY G5A — Lifecycle timing integrity summary
-- CLASSIFICATION: shared aggregate evidence (one-row rollup of counts, no
-- item-level detail).
-- One-row rollup of G5's three integrity flags, plus DOM coverage context,
-- over the same population (Business, acquisition_value > 0). Read this
-- FIRST — it tells you whether G5's per-item flags are worth drilling into
-- at all before you go looking row by row.
--
-- Expected healthy values: negative_acquisition_to_listing_count = 0,
-- dom_exceeds_holding_count = 0, realized_dom_date_mismatch_count = 0. Any
-- of these being non-zero points at a real data or view-logic problem — see
-- G5 to find which items.
--
-- realized_items_missing_dom_count / open_listed_items_missing_dom_count
-- are COVERAGE information, not integrity errors — a realized or listed
-- item can legitimately have no global_days_on_market if it was never
-- listed through a tracked platform before it exited (see Query A1, which
-- reports the same two counts for the full non-price-filtered population).
-- ============================================================================
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
eligible AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
flagged AS (
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
)
SELECT
  COUNT(*)                                                                                  AS item_count,
  COUNT(*) FILTER (WHERE acquisition_to_listing_is_negative)                                 AS negative_acquisition_to_listing_count,
  COUNT(*) FILTER (WHERE dom_exceeds_holding_days)                                            AS dom_exceeds_holding_count,
  COUNT(*) FILTER (WHERE realized_dom_date_mismatch)                                          AS realized_dom_date_mismatch_count,
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)                       AS realized_items_missing_dom_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL) AS open_listed_items_missing_dom_count
FROM flagged;
