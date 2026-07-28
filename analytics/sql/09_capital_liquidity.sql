-- ============================================================================
-- 09_capital_liquidity.sql
--
-- Business questions:
--   - How much acquisition capital is tied up in open Business inventory?
--   - How much open capital is listed versus unlisted?
--   - How old is the open capital?
--   - Which Acquisition Value Bands and acquisition methods contain the
--     most open capital?
--   - How efficiently has realized inventory generated profit from
--     acquisition capital?
--   - Which capital positions have reliable versus unreliable lifecycle
--     dates?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- Open Inventory Decision Support, item-level recommendations, recent
-- trends, AI interpretation, Business Coach, cash-balance analysis, and
-- any UI redesign are all OUT of scope for this file — see
-- analytics/SEMANTIC_CONTRACT.md. This module reports CAPITAL (acquisition
-- value assigned to inventory), never a user's cash_flow/cash-balance
-- ledger — those are a wholly separate subsystem, not read anywhere here.
--
-- No analytics_item_lifecycle migration was needed — every field used here
-- (acquisition_value, current_status, holding_days, estimated_sold_value,
-- item_expenses_total, is_historical_import, has_lifecycle_date_issue)
-- already exists on the view.
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────
-- purpose_name = 'Business'. Query A reports on the FULL population (open
-- + realized). Query B/C/D narrow to OPEN (NOT is_realized) items only —
-- these sections are about capital CURRENTLY tied up, not yet returned.
-- Query E/F narrow to REALIZED items with acquisition_value_status =
-- 'positive' — capital efficiency is a ratio and is undefined for a
-- zero/unknown acquisition value (see the interpretation safeguards
-- below).
--
-- ── ACQUISITION-VALUE RULES (v1.1 semantics, reused unchanged) ──────────
-- - positive acquisition value contributes to every acquisition-capital
--   total.
-- - zero-assigned acquisition value (acquisition_value = 0) remains
--   VISIBLE in every coverage count but contributes exactly $0 to any SUM
--   (never excluded, never NULL-ing the whole SUM — the v1.1 SUM fix, see
--   analytics/SEMANTIC_CONTRACT.md section 7.1).
-- - unknown acquisition value (acquisition_value IS NULL) remains visible
--   in coverage counts but is excluded from capital SUMs by ordinary NULL
--   propagation — it never silently contributes $0 (that would understate
--   how much capital is genuinely unaccounted for) and never inflates a
--   total either.
--
-- ── HISTORICAL IMPORTS — VALUE-BASED YES, TIME-BASED NO ─────────────────
-- Historical imports are INCLUDED in: acquisition capital, realized
-- profit, ROI, values, listing state (listed/unlisted), and estimated
-- upside — none of that depends on the one approximate field
-- (acquisition_date). They are EXCLUDED from every acquisition-date-
-- dependent metric: ownership age (Query B/C/D), holding days (Query
-- E/F), profit-per-30-holding-days (Query E/F), and any other
-- time-normalized capital-efficiency figure. See
-- analytics/SEMANTIC_CONTRACT.md sections 1-4 for the full rule this
-- module inherits unchanged.
--
-- ── OPEN CAPITAL AGE BUCKETS (Query B) — MUTUALLY EXCLUSIVE ─────────────
-- Every OPEN Business item lands in EXACTLY ONE bucket:
--   0-29 days / 30-59 days / 60-119 days / 120+ days, using `holding_days`
--   (CURRENT_DATE - acquisition_date, the view's own ownership-age
--   reading for an open item) — ONLY when the item is NOT a historical
--   import, `holding_days IS NOT NULL`, and `NOT has_lifecycle_date_issue`
--   (the SAME "reliable date" eligibility rule used everywhere else in
--   this analytics layer);
--   OR "unreliable/unknown age" — every item that fails that reliable-date
--   test (historical imports, a NULL holding_days, or a lifecycle date
--   issue) lands here instead. This is NOT a 5th calendar bucket — it is
--   the explicit "we cannot trust or do not have this item's age" group,
--   kept visible rather than silently split across the calendar buckets
--   or dropped.
--
-- ── CAPITAL PERCENTAGE DENOMINATOR ───────────────────────────────────────
-- Every `*_capital_percent` field in Query B/C/D divides by the SAME
-- denominator: total open acquisition capital across ALL open Business
-- items (Query A's `open_acquisition_capital`) — a zero-assigned open item
-- contributes $0 to both numerator and denominator (never excluded), an
-- unknown-acquisition-value open item is excluded from both (its capital
-- is genuinely unknown, not zero). This denominator is POSITIVE
-- acquisition capital in effect (zero contributes nothing to the sum
-- either way), matching the task's "use positive acquisition capital as
-- the denominator" instruction without needing a separately-filtered sum.
--
-- ── PROFIT-TO-CAPITAL PERCENTAGE vs. MEDIAN ROI — NEVER THE SAME NUMBER ──
-- `profit_to_acquisition_capital_percent` (Query A/E/F) is an AGGREGATE
-- descriptive ratio: SUM(net_profit) / SUM(acquisition_value) * 100 across
-- the whole group. `median_roi` is the MEDIAN of each item's OWN
-- (net_profit / acquisition_value) ratio. These answer different
-- questions ("how efficiently did this pool of capital turn into profit
-- overall" vs. "what does a typical item in this group return") and can
-- differ substantially, especially when a few large-capital items
-- dominate the aggregate ratio. Never substitute one for the other.
--
-- ── PROFIT PER 30 HOLDING DAYS (Query E/F) — ITEM-LEVEL FIRST ───────────
-- `median_net_profit_per_30_holding_days` is computed by first deriving,
-- PER ITEM, `net_profit / holding_days * 30` — restricted to realized,
-- non-historical, `holding_days IS NOT NULL AND holding_days > 0` (never
-- divides by zero), and no lifecycle date issue — and ONLY THEN taking
-- the median of that per-item figure across the group. It is NEVER
-- computed as `median_net_profit / median_holding_days * 30` (a
-- group-level ratio-of-medians, which is a different and less meaningful
-- number). `time_efficiency_sample_size` is the count of items that
-- actually contributed to this median — always reported alongside it.
--
-- ── CONFIDENCE ───────────────────────────────────────────────────────────
-- Query E/F populations are ALREADY restricted to realized items only, so
-- confidence tiered from a row's own COUNT(*) (= realized_item_count, the
-- whole population of that row) is equivalent either way. Same 4-tier
-- thresholds as everywhere else: 1-2 insufficient, 3-5 low, 6-9 moderate,
-- 10+ stronger.
--
-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- - Open acquisition capital is capital ASSIGNED TO INVENTORY (what was
--   paid or valued in a trade), NOT current market value — it says
--   nothing about what the item is worth today.
-- - Estimated upside is based on `estimated_sold_value`, a manually
--   entered guess — it is NOT guaranteed profit.
-- - `profit_to_acquisition_capital_percent` is an aggregate descriptive
--   ratio, never a substitute for `median_roi` (see above).
-- - Old inventory is NOT automatically bad inventory — an old item may
--   simply be a slow-moving, high-value, or intentionally held piece.
-- - Acquisition-method and value-band capital results can be confounded
--   by Category, Brand, and item mix — not isolated by this file.
-- - Historical imports contribute to every VALUE-based figure here but
--   NEVER to an unreliable TIME-based one (age/holding days/time
--   efficiency) — see the rule above.
-- - A zero-assigned acquisition value NEVER produces an infinite or
--   undefined ROI/capital-efficiency figure — every ratio here divides
--   with `NULLIF(..., 0)` and a zero-capital denominator simply yields
--   NULL, never `Infinity` or a crash.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Every query below is SHARED AGGREGATE EVIDENCE — pooled across every
-- user accessible to the querying role, returning only counts/sums/
-- medians/percentages, never an item ID, item name, model, or user
-- identity. No per-user capital breakdown exists in this file. No
-- cash_flow/cash-balance table is read anywhere in this file.
-- ============================================================================


-- ============================================================================
-- QUERY A — Capital position summary
-- CLASSIFICATION: shared aggregate evidence.
-- Run this first. Reconciliation (verify by eye against this row):
--   business_item_count = realized_business_item_count + open_business_item_count
--   business_item_count = positive_acquisition_item_count
--                        + zero_assigned_acquisition_item_count
--                        + unknown_acquisition_item_count
--                        (+ any negative_invalid rows, structurally rare/
--                         a data-quality state, not a separate field here)
--   total_business_acquisition_capital = realized_acquisition_capital + open_acquisition_capital
--   open_acquisition_capital = listed_open_acquisition_capital + unlisted_open_acquisition_capital
--   open_business_item_count = listed_open_item_count + unlisted_open_item_count
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
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'positive')        AS positive_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'zero_assigned')    AS zero_assigned_acquisition_item_count,
  (SELECT COUNT(*) FROM business WHERE acquisition_value_status = 'unknown')          AS unknown_acquisition_item_count,
  (SELECT SUM(acquisition_value) FROM business WHERE acquisition_value IS NOT NULL)   AS total_business_acquisition_capital,
  (SELECT SUM(acquisition_value) FROM business WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
  (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed') AS listed_open_item_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status <> 'listed') AS unlisted_open_item_count,
  (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND current_status = 'listed' AND acquisition_value IS NOT NULL) AS listed_open_acquisition_capital,
  (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND current_status <> 'listed' AND acquisition_value IS NOT NULL) AS unlisted_open_acquisition_capital,
  (SELECT SUM(net_profit) FROM business WHERE is_realized)                            AS total_realized_net_profit,
  ROUND(
    (SELECT SUM(net_profit) FROM business WHERE is_realized)
      / NULLIF((SELECT SUM(acquisition_value) FROM business WHERE is_realized AND acquisition_value IS NOT NULL), 0) * 100,
    2
  )                                                                                   AS realized_profit_to_acquisition_capital_percent,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
  (SELECT SUM(estimated_sold_value - acquisition_value - item_expenses_total) FROM business
     WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)                            AS estimated_open_net_upside,
  ROUND(
    (SELECT SUM(acquisition_value) FROM business WHERE NOT is_realized AND acquisition_value IS NOT NULL)
      / NULLIF((SELECT SUM(acquisition_value) FROM business WHERE acquisition_value IS NOT NULL), 0) * 100,
    2
  )                                                                                   AS open_capital_percent_of_total_business_capital;


-- ============================================================================
-- QUERY B — Open capital by age bucket
-- CLASSIFICATION: shared aggregate evidence.
-- Every open Business item appears in EXACTLY ONE bucket — see the file
-- header's "OPEN CAPITAL AGE BUCKETS" section for the reliable-date
-- eligibility rule and why historical imports always land in
-- "unreliable/unknown age", never a calendar bucket.
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
  SELECT
    *,
    (NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS has_reliable_age,
    CASE
      WHEN is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue THEN 5
      WHEN holding_days < 30  THEN 1
      WHEN holding_days < 60  THEN 2
      WHEN holding_days < 120 THEN 3
      ELSE 4
    END AS age_bucket_order,
    CASE
      WHEN is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue THEN 'unreliable/unknown age'
      WHEN holding_days < 30  THEN '0-29 days'
      WHEN holding_days < 60  THEN '30-59 days'
      WHEN holding_days < 120 THEN '60-119 days'
      ELSE '120+ days'
    END AS age_bucket_label
  FROM business
  WHERE NOT is_realized
),
total_open_capital AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM open_items
)
SELECT
  age_bucket_order,
  age_bucket_label,
  COUNT(*)                                                                       AS open_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
  ROUND(
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
      / NULLIF((SELECT amount FROM total_open_capital), 0) * 100,
    2
  )                                                                               AS open_capital_percent,
  COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
  COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
  COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
  COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
  SUM(estimated_sold_value - acquisition_value - item_expenses_total)
    FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
  COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
  COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count
FROM open_items
GROUP BY age_bucket_order, age_bucket_label
ORDER BY age_bucket_order;


-- ============================================================================
-- QUERY C — Open capital by Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to acquisition_value_status = 'positive' — the SAME
-- restriction 01/04/05/08's own band queries use. Zero-assigned and
-- unknown acquisition values are NEVER placed into $1-999 or any other
-- positive band; their separate coverage lives in Query A (overall) and
-- Query B (per age bucket).
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
open_items AS (
  SELECT * FROM business WHERE NOT is_realized
),
open_eligible AS (
  SELECT * FROM open_items WHERE acquisition_value_status = 'positive'
),
total_open_capital AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM open_items
)
SELECT
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                                                                       AS open_item_count,
  SUM(acquisition_value)                                                         AS open_acquisition_capital,
  ROUND(
    SUM(acquisition_value)::numeric
      / NULLIF((SELECT amount FROM total_open_capital), 0) * 100,
    2
  )                                                                               AS open_capital_percent,
  COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
  COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
  COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL)                       AS estimated_upside_available_count,
  0                                                                               AS estimated_upside_indeterminate_count,
  SUM(estimated_sold_value - acquisition_value - item_expenses_total) FILTER (WHERE estimated_sold_value IS NOT NULL) AS estimated_net_upside,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
  COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
FROM open_eligible
GROUP BY acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order;
-- estimated_upside_indeterminate_count is always 0 here by construction:
-- this population is already restricted to acquisition_value_status =
-- 'positive' (acquisition_value IS NOT NULL), so the "indeterminate"
-- case (estimated value present, acquisition value unknown) cannot occur.
-- Kept as an explicit column (not omitted) so this section's shape matches
-- Query B/D's estimated-upside field set exactly.


-- ============================================================================
-- QUERY D — Open capital by acquisition method
-- CLASSIFICATION: shared aggregate evidence.
-- acquisition_method is 'purchase'/'trade'/'unknown' for any item with an
-- acquisition record — but an item with NO incoming deal_item row at all
-- (a rare, structurally-possible state; see fixture item 13 in the test
-- suite) has a raw SQL NULL here, not the string 'unknown', because the
-- view's own acquisition_method CASE only runs for rows that exist in its
-- acquisition CTE. COALESCE to 'unknown' below so this section's output
-- always uses exactly the three normalized values the task contract
-- requires. Open Business items only — NOT restricted to positive
-- acquisition value (unlike Query C), so a zero-assigned or unknown-value
-- item still contributes to open_item_count here; it simply contributes
-- $0 (zero-assigned) or nothing (unknown, NULL-excluded) to
-- open_acquisition_capital.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
),
open_items AS (
  SELECT * FROM business WHERE NOT is_realized
),
total_open_capital AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM open_items
)
SELECT
  COALESCE(acquisition_method, 'unknown')                                        AS acquisition_method,
  COUNT(*)                                                                       AS open_item_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
  ROUND(
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
      / NULLIF((SELECT amount FROM total_open_capital), 0) * 100,
    2
  )                                                                               AS open_capital_percent,
  COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
  COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
  SUM(estimated_sold_value - acquisition_value - item_expenses_total)
    FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
  COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
FROM open_items
GROUP BY COALESCE(acquisition_method, 'unknown')
ORDER BY COALESCE(acquisition_method, 'unknown');


-- ============================================================================
-- QUERY E — Realized capital efficiency by Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Realized Business items, acquisition_value_status = 'positive' only —
-- capital efficiency is undefined for a zero/unknown acquisition value
-- (see file header). median_net_profit_per_30_holding_days is computed
-- PER ITEM first (net_profit / holding_days * 30, only where holding_days
-- > 0, non-historical, no lifecycle issue), THEN medianed — never a
-- group-level ratio of medians. See the file header for the full
-- rationale.
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
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business' AND is_realized
),
eligible AS (
  SELECT
    *,
    CASE
      WHEN NOT is_historical_import AND holding_days IS NOT NULL AND holding_days > 0 AND NOT has_lifecycle_date_issue
        THEN (net_profit / holding_days::numeric) * 30
    END AS net_profit_per_30_holding_days
  FROM business
  WHERE acquisition_value_status = 'positive'
)
SELECT
  acquisition_value_band_order,
  acquisition_value_band_label,
  COUNT(*)                                                                       AS realized_item_count,
  SUM(acquisition_value)                                                         AS realized_acquisition_capital,
  SUM(net_profit)                                                                AS total_realized_net_profit,
  ROUND(SUM(net_profit)::numeric / NULLIF(SUM(acquisition_value), 0) * 100, 2)   AS profit_to_acquisition_capital_percent,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
  COUNT(*) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)             AS time_efficiency_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit_per_30_holding_days) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)::numeric, 2) AS median_net_profit_per_30_holding_days,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM eligible
GROUP BY acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order;


-- ============================================================================
-- QUERY F — Realized capital efficiency by acquisition method
-- CLASSIFICATION: shared aggregate evidence.
-- Same population and same item-level-first time-efficiency methodology
-- as Query E, grouped by acquisition_method instead of Acquisition Value
-- Band.
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
  WHERE purpose_name = 'Business' AND is_realized
),
eligible AS (
  SELECT
    *,
    CASE
      WHEN NOT is_historical_import AND holding_days IS NOT NULL AND holding_days > 0 AND NOT has_lifecycle_date_issue
        THEN (net_profit / holding_days::numeric) * 30
    END AS net_profit_per_30_holding_days
  FROM business
  WHERE acquisition_value_status = 'positive'
)
SELECT
  acquisition_method,
  COUNT(*)                                                                       AS realized_item_count,
  SUM(acquisition_value)                                                         AS realized_acquisition_capital,
  SUM(net_profit)                                                                AS total_realized_net_profit,
  ROUND(SUM(net_profit)::numeric / NULLIF(SUM(acquisition_value), 0) * 100, 2)   AS profit_to_acquisition_capital_percent,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
  COUNT(*) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)             AS time_efficiency_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit_per_30_holding_days) FILTER (WHERE net_profit_per_30_holding_days IS NOT NULL)::numeric, 2) AS median_net_profit_per_30_holding_days,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM eligible
GROUP BY acquisition_method
ORDER BY acquisition_method;
