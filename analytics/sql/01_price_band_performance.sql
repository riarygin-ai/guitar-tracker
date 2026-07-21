-- ============================================================================
-- 01_price_band_performance.sql
--
-- Business question: which acquisition-price range gives the best balance of
-- absolute profit, ROI, turnover speed, capital efficiency, and open-
-- inventory risk?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations). See analytics/README.md.
--
-- ── HOW TO READ THIS FILE ───────────────────────────────────────────────────
-- Each query is a fully self-contained statement (its own WITH clause,
-- including its own copy of the `price_band` CTE) so any single query can be
-- copy-pasted and run alone. The `price_band` CTE text is intentionally
-- IDENTICAL byte-for-byte in every query that needs fixed price bands — if
-- you ever edit the band boundaries, edit every occurrence together, or the
-- queries will silently stop agreeing with each other.
--
-- ── METHODOLOGY / LIMITATIONS (read before interpreting any result) ────────
-- 1. ASSOCIATION, NOT CAUSATION. A price band showing a higher median ROI
--    did not necessarily cause that ROI. Price is entangled with brand,
--    category, condition, liquidity, acquisition method, and seller
--    behavior — any of which could be the actual driver.
-- 2. CONFOUNDING. A $4,000+ guitar and a $200 pedal are not interchangeable
--    "acquisition price" data points; see Query F for a category-adjusted
--    view before drawing conclusions from the unadjusted bands in Query B.
-- 3. HISTORICAL IMPORT DATES MAY BE UNRELIABLE. Historical Import
--    acquisition dates are real user-entered dates (there is no placeholder
--    convention in this app as of this writing — acquisition_date_is_placeholder
--    is currently always false), but they were entered after the fact and may
--    not be as reliable as dates captured by an actual Buy/Trade operation at
--    the time. Time-based metrics involving Historical Imports should be
--    treated with more caution than metrics from ordinary purchases/trades.
-- 4. OPEN INVENTORY HAS NOT PRODUCED A FINAL RESULT YET. Open items'
--    holding_days/global_days_on_market are still growing and their
--    net_profit/roi are NULL by definition (not zero, not bad — just not yet
--    known). Never blend open-item age into a "days to exit" statistic.
-- 5. MEDIANS ARE PRIMARY. PERCENTILE_CONT(0.5) is used as the main
--    central-tendency metric throughout; averages are shown alongside for
--    context but are far more sensitive to one unusually cheap/expensive or
--    unusually profitable/unprofitable item.
-- 6. SMALL GROUPS ARE NOT CONCLUSIONS. Every grouped query exposes its
--    sample_size (or equivalent) so a group of 2-3 items is never mistaken
--    for a reliable pattern. A working rule of thumb used in this file:
--    treat sample_size < 5 as "not yet reliable" (see Query F's comment).
--
-- ============================================================================


-- ============================================================================
-- QUERY A1 — Data coverage: summary counts
-- Purpose: establish whether every group has enough usable data before
-- interpreting any query below. Run this first.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business'
)
SELECT
  (SELECT COUNT(*) FROM price_band)                                                          AS total_lifecycle_rows,
  (SELECT COUNT(*) FROM business)                                                             AS business_items,
  (SELECT COUNT(*) FROM price_band WHERE purpose_name IS DISTINCT FROM 'Business')             AS non_business_items,
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
  (SELECT COUNT(*) FROM business WHERE holding_days IS NOT NULL)                                 AS rows_with_usable_holding_days,
  (SELECT COUNT(*) FROM business WHERE global_days_on_market IS NOT NULL)                        AS rows_with_usable_global_days_on_market,
  (SELECT MIN(acquisition_value) FROM business WHERE acquisition_value > 0)                      AS min_acquisition_value_positive,
  (SELECT MAX(acquisition_value) FROM business WHERE acquisition_value > 0)                      AS max_acquisition_value_positive,
  (SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value), 2)
     FROM business WHERE acquisition_value > 0)                                                  AS median_acquisition_value_positive,
  (SELECT MIN(acquisition_date) FROM business)                                                   AS min_acquisition_date,
  (SELECT MAX(acquisition_date) FROM business)                                                   AS max_acquisition_date,
  (SELECT MIN(exit_date) FROM business)                                                          AS min_exit_date,
  (SELECT MAX(exit_date) FROM business)                                                          AS max_exit_date;


-- ============================================================================
-- QUERY A2 — Data coverage: item count in each fixed price band
-- (Business items only, all acquisition values including Zero / unknown.)
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business'
)
SELECT
  price_band_order,
  price_band_label,
  COUNT(*) AS item_count
FROM business
GROUP BY price_band_order, price_band_label
ORDER BY price_band_order;


-- ============================================================================
-- QUERY B — Main fixed price-band performance
-- Business items, positive acquisition value only. This is the main
-- descriptive result the rest of this file's robustness checks (Query C, F,
-- G1-G4) test the stability of.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  price_band_order,
  price_band_label,

  COUNT(*)                                    AS sample_size,
  COUNT(*) FILTER (WHERE NOT is_realized)     AS open_items,
  COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
  COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,

  -- realization_rate_percent numerator = realized_items, denominator = sample_size (both shown above)
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,

  -- Profit/ROI computed ONLY from realized rows.
  SUM(acquisition_value) FILTER (WHERE is_realized) AS total_acquisition_value_realized,
  SUM(exit_value)        FILTER (WHERE is_realized) AS total_exit_value,
  SUM(net_profit)        FILTER (WHERE is_realized) AS total_net_profit,

  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized), 2) AS median_net_profit,
  ROUND(AVG(net_profit) FILTER (WHERE is_realized), 2)                                          AS average_net_profit,

  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2) AS median_roi,
  ROUND(AVG(roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2)                                          AS average_roi,

  -- CAUTION: holding_days below mixes open items' still-accruing current age
  -- with realized items' final duration (that is how the view itself defines
  -- holding_days). Do not read this as "average time to exit" — see Query D
  -- for a metric computed only from realized, non-Historical-Import items.
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days,
  ROUND(AVG(holding_days) FILTER (WHERE holding_days IS NOT NULL), 2)                                          AS average_holding_days,

  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS items_with_days_on_market,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL), 2) AS median_global_days_on_market,
  ROUND(AVG(global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL), 2)                                          AS average_global_days_on_market

FROM eligible
GROUP BY price_band_order, price_band_label
ORDER BY price_band_order;


-- ============================================================================
-- QUERY C — Equal-size acquisition-value quartiles
-- Same population as Query B (Business, acquisition_value > 0), grouped into
-- ~equal-sized quartiles instead of fixed $ bands, to check whether the
-- pattern in Query B survives when sample sizes are balanced.
--
-- NOTE: NTILE(4) boundaries are a function of the CURRENT data distribution.
-- As more items are acquired, the acquisition-value cut points between Q1/Q2/
-- Q3/Q4 will shift — unlike the fixed $ bands in price_band, these quartile
-- boundaries are not a stable reporting definition and will differ each time
-- this query is re-run against a larger dataset.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
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
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value), 2) AS median_acquisition_value,

  COUNT(*) FILTER (WHERE is_realized) AS realized_items,
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,

  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized), 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL), 2) AS median_global_days_on_market
FROM quartiled
GROUP BY quartile
ORDER BY quartile;


-- ============================================================================
-- QUERY D1 — Capital efficiency (PRIMARY: Historical Imports excluded from
-- the time-adjusted metric — their acquisition dates are less trustworthy)
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
capital AS (
  SELECT
    price_band_order,
    price_band_label,
    COUNT(*) FILTER (WHERE is_realized)               AS realized_item_count,
    SUM(acquisition_value) FILTER (WHERE is_realized) AS total_acquisition_capital,
    SUM(net_profit)        FILTER (WHERE is_realized) AS total_net_profit,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL) AS median_roi
  FROM eligible
  GROUP BY price_band_order, price_band_label
),
-- Time-adjusted profit: realized, positive acquisition value (guaranteed by
-- `eligible`), holding_days > 0 (excludes same-day exits — a same-day flip
-- would otherwise produce a meaningless "infinite velocity" figure), not a
-- Historical Import, and no lifecycle date issue.
timing_eligible AS (
  SELECT
    price_band_order,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days
  FROM eligible
  WHERE is_realized
    AND holding_days > 0
    AND NOT is_historical_import
    AND NOT has_lifecycle_date_issue
),
timing AS (
  SELECT
    price_band_order,
    COUNT(*)                                                                     AS reliable_timing_item_count,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit_per_30_holding_days)      AS median_profit_per_30_holding_days,
    AVG(profit_per_30_holding_days)                                              AS average_profit_per_30_holding_days
  FROM timing_eligible
  GROUP BY price_band_order
)
SELECT
  capital.price_band_order,
  capital.price_band_label,
  capital.realized_item_count,
  capital.total_acquisition_capital,
  capital.total_net_profit,
  ROUND(capital.total_net_profit / NULLIF(capital.total_acquisition_capital, 0) * 1000, 2) AS net_profit_per_1000_invested,
  ROUND(capital.median_roi, 2)                                                             AS median_roi,
  COALESCE(timing.reliable_timing_item_count, 0)                                           AS reliable_timing_item_count,
  ROUND(timing.median_profit_per_30_holding_days, 2)                                        AS median_profit_per_30_holding_days,
  ROUND(timing.average_profit_per_30_holding_days, 2)                                       AS average_profit_per_30_holding_days
FROM capital
LEFT JOIN timing ON timing.price_band_order = capital.price_band_order
ORDER BY capital.price_band_order;


-- ============================================================================
-- QUERY D2 — Capital efficiency: time-adjusted SENSITIVITY
-- (Historical Imports INCLUDED — compare against Query D1's primary result.
-- If the pattern changes a lot once Historical Imports are added back in,
-- that's a sign the primary result is sensitive to their less-reliable dates.)
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
timing_primary AS (
  SELECT 'Primary (Historical Imports excluded)' AS population_label,
    price_band_order, price_band_label,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days
  FROM eligible
  WHERE is_realized AND holding_days > 0 AND NOT is_historical_import AND NOT has_lifecycle_date_issue
),
timing_with_historical AS (
  SELECT 'Sensitivity (Historical Imports included)' AS population_label,
    price_band_order, price_band_label,
    (net_profit / holding_days * 30) AS profit_per_30_holding_days
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
  price_band_order,
  price_band_label,
  COUNT(*)                                                                          AS qualifying_item_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY profit_per_30_holding_days), 2)  AS median_profit_per_30_holding_days,
  ROUND(AVG(profit_per_30_holding_days), 2)                                          AS average_profit_per_30_holding_days
FROM combined
GROUP BY population_label, price_band_order, price_band_label
ORDER BY price_band_order, population_label;


-- ============================================================================
-- QUERY E — Open inventory and capital at risk
-- "Open" = NOT is_realized (the view's own lifecycle fact — current_status
-- currently owned/listed/new, never sold/traded). Business items, ALL
-- acquisition values (including Zero / unknown) since this is about risk
-- exposure, not profit/ROI math.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business'
),
open_items AS (
  SELECT * FROM business WHERE NOT is_realized
),
open_summary AS (
  SELECT
    price_band_order,
    price_band_label,
    COUNT(*)                                                              AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0)           AS open_acquisition_capital,
    AVG(acquisition_value) FILTER (WHERE acquisition_value > 0)           AS average_acquisition_value,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value)
      FILTER (WHERE acquisition_value > 0)                                AS median_acquisition_value,
    SUM(estimated_sold_value)                                             AS total_estimated_sold_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0)           AS total_acquisition_value_for_upside,
    SUM(item_expenses_total)                                              AS total_item_expenses
  FROM open_items
  GROUP BY price_band_order, price_band_label
),
-- Reliable current-age population: excludes Historical Imports (unreliable
-- acquisition dates) and any row already flagged with a lifecycle date issue.
reliable_open AS (
  SELECT *
  FROM open_items
  WHERE NOT is_historical_import
    AND NOT has_lifecycle_date_issue
    AND holding_days IS NOT NULL
),
reliable_summary AS (
  SELECT
    price_band_order,
    COUNT(*)                                                          AS items_with_reliable_holding_age,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)         AS median_current_holding_days,
    AVG(holding_days)                                                 AS average_current_holding_days,
    COUNT(*) FILTER (WHERE holding_days > 60)                         AS open_over_60_days,
    COUNT(*) FILTER (WHERE holding_days > 90)                         AS open_over_90_days,
    COUNT(*) FILTER (WHERE holding_days > 180)                        AS open_over_180_days
  FROM reliable_open
  GROUP BY price_band_order
),
excluded_historical AS (
  SELECT
    price_band_order,
    COUNT(*) AS excluded_historical_import_open_items
  FROM open_items
  WHERE is_historical_import
  GROUP BY price_band_order
)
SELECT
  open_summary.price_band_order,
  open_summary.price_band_label,
  open_summary.open_item_count,
  open_summary.open_acquisition_capital,
  ROUND(open_summary.average_acquisition_value, 2) AS average_acquisition_value,
  ROUND(open_summary.median_acquisition_value, 2)  AS median_acquisition_value,

  COALESCE(reliable_summary.items_with_reliable_holding_age, 0)     AS items_with_reliable_holding_age,
  ROUND(reliable_summary.median_current_holding_days, 2)            AS median_current_holding_days,
  ROUND(reliable_summary.average_current_holding_days, 2)           AS average_current_holding_days,

  COALESCE(reliable_summary.open_over_60_days, 0)  AS open_over_60_days,
  COALESCE(reliable_summary.open_over_90_days, 0)  AS open_over_90_days,
  COALESCE(reliable_summary.open_over_180_days, 0) AS open_over_180_days,

  ROUND(COALESCE(reliable_summary.open_over_60_days, 0)::numeric
        / NULLIF(reliable_summary.items_with_reliable_holding_age, 0) * 100, 2)  AS percent_open_over_60_days,
  ROUND(COALESCE(reliable_summary.open_over_90_days, 0)::numeric
        / NULLIF(reliable_summary.items_with_reliable_holding_age, 0) * 100, 2)  AS percent_open_over_90_days,
  ROUND(COALESCE(reliable_summary.open_over_180_days, 0)::numeric
        / NULLIF(reliable_summary.items_with_reliable_holding_age, 0) * 100, 2)  AS percent_open_over_180_days,

  open_summary.total_estimated_sold_value,
  CASE
    WHEN open_summary.total_estimated_sold_value IS NOT NULL
     AND open_summary.total_acquisition_value_for_upside IS NOT NULL
    THEN open_summary.total_estimated_sold_value
         - open_summary.total_acquisition_value_for_upside
         - COALESCE(open_summary.total_item_expenses, 0)
    ELSE NULL
  END AS estimated_gross_upside,

  COALESCE(excluded_historical.excluded_historical_import_open_items, 0) AS excluded_historical_import_open_items_from_age_calcs

FROM open_summary
LEFT JOIN reliable_summary    ON reliable_summary.price_band_order    = open_summary.price_band_order
LEFT JOIN excluded_historical ON excluded_historical.price_band_order = open_summary.price_band_order
ORDER BY open_summary.price_band_order;


-- ============================================================================
-- QUERY F1 — Category-adjusted price performance
-- Same population as Query B (Business, acquisition_value > 0), broken down
-- by category as well as price band, so a $500 pedal and a $5,000 guitar are
-- never silently pooled into the same comparison.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  category_id,
  category_name,
  price_band_order,
  price_band_label,
  COUNT(*)                                    AS sample_size,
  COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
  COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,
  ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized), 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL), 2) AS median_global_days_on_market
FROM eligible
GROUP BY category_id, category_name, price_band_order, price_band_label
ORDER BY category_id, price_band_order;
-- NOTE: every category x price-band group is returned, including groups with
-- very few items — nothing is filtered out here. Treat any group with
-- sample_size below a configurable minimum (suggested starting point: 5) as
-- not yet reliable when INTERPRETING this result; do not apply that
-- threshold as a WHERE/HAVING clause in the query itself.


-- ============================================================================
-- QUERY F2 — Category-level acquisition-value distribution (summary)
-- Companion to F1: shows whether certain price bands only exist for
-- particular categories (e.g. a category that never has a $5,000+ item).
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  category_id,
  category_name,
  price_band_order,
  price_band_label,
  COUNT(*) AS item_count
FROM eligible
GROUP BY category_id, category_name, price_band_order, price_band_label
ORDER BY category_id, price_band_order;


-- ============================================================================
-- QUERY G1 — Robustness check: Historical Import sensitivity
-- Same primary fixed-band metrics, run once on all valid Business items and
-- again with Historical Imports removed. Large swings between the two rows
-- for the same price band mean that band's result is being driven by
-- Historical Import data quality, not by the price band itself.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
combined AS (
  SELECT 'All valid Business items' AS population_label,
    price_band_order, price_band_label, is_realized, net_profit, roi, holding_days
  FROM eligible
  UNION ALL
  SELECT 'Non-Historical Import Business items only',
    price_band_order, price_band_label, is_realized, net_profit, roi, holding_days
  FROM eligible
  WHERE NOT is_historical_import
)
SELECT
  population_label,
  price_band_order,
  price_band_label,
  COUNT(*)                            AS sample_size,
  COUNT(*) FILTER (WHERE is_realized) AS realized_items,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized), 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days
FROM combined
GROUP BY population_label, price_band_order, price_band_label
ORDER BY price_band_order, population_label;


-- ============================================================================
-- QUERY G2 — Robustness check: user-level comparison
-- Same population, split by user_id, plus a combined "All accessible users"
-- row per band — reveals whether the combined pattern in Query B is actually
-- just one user's behavior.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
per_user AS (
  SELECT
    user_id::text AS user_group,
    price_band_order, price_band_label, is_realized, net_profit, roi, holding_days
  FROM eligible
),
combined_all AS (
  SELECT
    'All accessible users' AS user_group,
    price_band_order, price_band_label, is_realized, net_profit, roi, holding_days
  FROM eligible
),
unioned AS (
  SELECT * FROM per_user
  UNION ALL
  SELECT * FROM combined_all
)
SELECT
  user_group,
  price_band_order,
  price_band_label,
  COUNT(*)                            AS sample_size,
  COUNT(*) FILTER (WHERE is_realized) AS realized_items,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized), 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days
FROM unioned
GROUP BY user_group, price_band_order, price_band_label
ORDER BY price_band_order, user_group;


-- ============================================================================
-- QUERY G3 — Robustness check: acquisition-method comparison
-- Cash purchases vs. trades, per price band — helps identify whether a
-- price band's apparent performance is really an acquisition-method effect.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  acquisition_method,
  price_band_order,
  price_band_label,
  COUNT(*)                                    AS sample_size,
  COUNT(*) FILTER (WHERE is_realized)         AS realized_items,
  COUNT(*) FILTER (WHERE exit_type = 'sale')  AS sale_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade') AS trade_count,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized), 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL), 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days
FROM eligible
GROUP BY acquisition_method, price_band_order, price_band_label
ORDER BY acquisition_method, price_band_order;


-- ============================================================================
-- QUERY G4 — Robustness check: outlier sensitivity
-- Realized Business items with positive acquisition value, compared with and
-- without the top/bottom 5% of net_profit excluded.
--
-- NOTE: the top/bottom 5% trim is computed GLOBALLY across all qualifying
-- realized items, not separately within each price band. Per-band realized
-- sample sizes in this dataset are small enough (commonly under 20, some
-- under 5) that a per-band 5% trim would round to zero excluded items and
-- give a false impression of robustness. Treat this check as indicative
-- only, and revisit per-band trimming once band sample sizes are larger.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
),
realized AS (
  SELECT *, PERCENT_RANK() OVER (ORDER BY net_profit) AS profit_percent_rank
  FROM eligible
  WHERE is_realized
),
combined AS (
  SELECT 'All realized items' AS population_label,
    price_band_order, price_band_label, roi, holding_days, net_profit
  FROM realized
  UNION ALL
  SELECT 'Profit outliers excluded (top/bottom 5%)',
    price_band_order, price_band_label, roi, holding_days, net_profit
  FROM realized
  WHERE profit_percent_rank >= 0.05 AND profit_percent_rank <= 0.95
)
SELECT
  population_label,
  price_band_order,
  price_band_label,
  COUNT(*) AS sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit), 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL), 2) AS median_roi,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE holding_days IS NOT NULL), 2) AS median_holding_days
FROM combined
GROUP BY population_label, price_band_order, price_band_label
ORDER BY price_band_order, population_label;


-- ============================================================================
-- QUERY G5 — Item-level drill-down
-- Source rows for the same population used by Query B/C/D/F/G1-G4, for
-- manually verifying which specific items produced any aggregate above.
-- ============================================================================
WITH price_band AS (
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
    END AS price_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS price_band_label
  FROM analytics_item_lifecycle
),
eligible AS (
  SELECT * FROM price_band WHERE purpose_name = 'Business' AND acquisition_value > 0
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
  price_band_label,

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

  holding_days,
  global_days_on_market,

  estimated_sold_value,
  has_lifecycle_date_issue
FROM eligible
ORDER BY price_band_order, is_realized DESC, acquisition_value, item_id;
