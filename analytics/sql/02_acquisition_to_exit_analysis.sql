-- ============================================================================
-- 02_acquisition_to_exit_analysis.sql
--
-- Business question: how does an item's assigned VALUE change between
-- acquisition and realization? At what value do items enter inventory, at
-- what value do they exit, which Acquisition Value Bands most often move
-- into higher Exit Value Bands, and how do typical exit value, net profit,
-- ROI, and days on market differ by acquisition band, acquisition method,
-- and exit method?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- ── SEMANTIC SCOPE — read before touching anything else in this file ──────
-- "Acquisition-to-Exit Analysis" here means VALUE movement:
--     acquisition_value -> exit_value
-- It does NOT mean acquisition-date-to-exit-date DURATION. holding_days
-- (ownership/capital-cycle duration, measured from acquisition_date) is
-- deliberately NOT computed anywhere in this file — see
-- 01_acquisition_value_band_performance.sql and 03_brand_performance.sql
-- for holding-time analysis. This file's one timing metric is
-- global_days_on_market (DOM), which is measured from first_listed_at, not
-- acquisition_date, and needs no historical-import exclusion (see next).
--
-- HISTORICAL IMPORTS REMAIN FULLY ELIGIBLE. Per
-- analytics/SEMANTIC_CONTRACT.md, the only approximate field for a
-- historical import is acquisition_date. This file never reads
-- acquisition_date and never computes anything derived from it, so NO
-- historical-import exclusion applies anywhere in this file — historical
-- rows contribute to every population, band, transition, and median below
-- exactly like app-tracked rows. historical_item_count /
-- app_tracked_item_count columns are informational cohort counts, not
-- eligibility filters.
--
-- TERMINOLOGY: acquisition_value may be a cash purchase value or an
-- assigned incoming trade value; exit_value may be a cash sale value or an
-- assigned outgoing trade value. Every section below uses "Acquisition
-- Value Band" / "Exit Value Band" (aliases acquisition_value_band_*,
-- exit_value_band_*) EXCEPT Section F (Purchase Price Band, restricted to
-- acquisition_method = 'purchase') and Section G (Sale Price Band,
-- restricted to a cash-sale exit). No generic `price_band` alias is used
-- anywhere in this file. See analytics/SEMANTIC_CONTRACT.md.
--
-- value_increase = exit_value - acquisition_value. This is DISTINCT from
-- net_profit (= exit_value - acquisition_value - item_expenses_total,
-- computed by the view). Item expenses can make net_profit lower than
-- value_increase — never conflate the two; both are always shown side by
-- side wherever either appears.
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────────
-- purpose_name = 'Business', is_realized = true, acquisition_value IS NOT
-- NULL AND > 0, exit_value IS NOT NULL AND > 0. Sections B through H all
-- read this population (Section F narrows to acquisition_method =
-- 'purchase'; Section G narrows to a cash-sale exit). Section A1 reports
-- every population above this one is carved from, plus every excluded
-- count, so nothing is silently discarded — see A1.
--
-- ── SCHEMA FIELDS USED (verified against
-- supabase/migrations/20260724000000_historical_deal_type_labels.sql
-- before writing this file, not assumed) ────────────────────────────────────
-- acquisition_method: 'purchase' | 'trade' | 'unknown' (Historical Import
--   only; the view's CASE has no other ELSE path). exit_type: the exit
--   deal's raw deal_type — 'sale' or 'trade' for every is_realized = true
--   row (is_realized is itself defined as exit deal_type IN ('sale',
--   'trade')), so an "unknown" exit_type is not structurally reachable
--   within this file's population; this file still groups by exit_type
--   verbatim rather than assuming only two values, so a future third exit
--   deal_type would surface as its own labelled row instead of being
--   silently folded in or dropped. Output columns are aliased exit_method
--   for readability (matching this task's requested naming), but the
--   underlying grouping value is exit_type. global_days_on_market is the
--   view's DOM field (exit_date - first_listed_at for realized rows, NULL
--   if never listed through a tracked platform) — the only timing metric
--   used in this file. net_profit / roi are already realized-only,
--   NULL-for-open by the view's own definition; both are non-NULL for
--   every row in this file's eligible population (roi additionally
--   requires acquisition_value > 0, already guaranteed by eligibility).
--
-- ── BAND BOUNDARIES — copied byte-for-byte from
-- 01_acquisition_value_band_performance.sql ─────────────────────────────────
-- Zero / unknown, $1-999, $1,000-1,999, $2,000-2,999, $3,000-3,999,
-- $4,000-4,999, $5,000+. The 4-expression CASE block below (order + label,
-- for both acquisition_value and exit_value) is IDENTICAL byte-for-byte
-- everywhere it appears in this file, and identical to the acquisition-side
-- boundaries in 01_acquisition_value_band_performance.sql and
-- 03_brand_performance.sql. If you ever edit a boundary, edit every
-- occurrence in all three files together, or band placement will silently
-- stop agreeing across files. The "Zero / unknown" branch is unreachable in
-- every query below except where noted (this file's eligible population
-- already requires acquisition_value > 0 and exit_value > 0) — it is kept
-- in the CASE block anyway for copy-paste safety, matching the other two
-- files' own convention of a single non-diverging block.
--
-- ── CONFIDENCE CONVENTION — reused from 03_brand_performance.sql ──────────
-- Every grouped section exposes a single `confidence` column, computed from
-- that row's own sample_size (or item_count for the transition matrix)
-- using the SAME 4-tier thresholds as 01/03's sample_confidence: 1-2
-- insufficient, 3-5 low, 6-9 moderate, 10+ stronger. This file does not add
-- a second "realized evidence" tier the way 01/03 do, because every row in
-- every section here is already realized by construction (eligibility
-- requires is_realized = true) — a second axis measuring "how much of this
-- group is realized" would be meaningless when the answer is always
-- "all of it." Small groups are never hidden with a WHERE/HAVING; they are
-- shown with a low/insufficient confidence label instead.
--
-- Each query is fully self-contained (its own WITH clause) so any single
-- query can be copy-pasted and run alone, matching this analytics folder's
-- established convention.
--
-- ── QUERY CLASSIFICATION INDEX (evidence vs. recommendation vs. developer-only;
-- see analytics/SEMANTIC_CONTRACT.md for the full definitions) ─────────────
-- Sections A1, A2, B, C, C2, D, E, F, G are SHARED AGGREGATE EVIDENCE —
-- pooled across every user accessible to the querying role, returning only
-- counts/medians/labels/percentages, never a single item's own identity.
-- Section H — DEVELOPER-ONLY item-level verification drilldown (returns
--   item_id, user_id, item_display_name for every eligible item across
--   every user). Not part of a future shared aggregate snapshot or
--   user-facing recommendation output — see H's own header.
-- No section in this file is a current-user recommendation candidate:
-- nothing here filters to a single target user's own items.
-- ============================================================================


-- ============================================================================
-- QUERY A1 — Coverage and reconciliation
-- CLASSIFICATION: shared aggregate evidence.
-- Establishes every population this file's Sections B-H are carved from, and
-- accounts for every excluded row, before any band/transition/method result
-- is interpreted. Run this first.
-- ============================================================================
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
)
SELECT
  (SELECT COUNT(*) FROM business)                                                                     AS total_business_items,
  (SELECT COUNT(*) FROM realized_business)                                                             AS realized_business_items,
  (SELECT COUNT(*) FROM realized_business WHERE acquisition_value IS NOT NULL AND acquisition_value > 0) AS realized_items_positive_acquisition_value,
  (SELECT COUNT(*) FROM realized_business WHERE exit_value IS NOT NULL AND exit_value > 0)               AS realized_items_positive_exit_value,
  (SELECT COUNT(*) FROM eligible)                                                                       AS eligible_for_value_transition_analysis,

  -- Exclusions — every row NOT in `eligible` is accounted for by one (or
  -- both) of these two counts, so nothing above is silently discarded.
  (SELECT COUNT(*) FROM realized_business WHERE acquisition_value IS NULL OR acquisition_value <= 0)     AS excluded_acquisition_value_zero_or_unknown,
  (SELECT COUNT(*) FROM realized_business WHERE exit_value IS NULL OR exit_value <= 0)                   AS excluded_exit_value_zero_or_unknown,

  -- Acquisition method breakdown of the eligible population — should sum to
  -- eligible_for_value_transition_analysis.
  (SELECT COUNT(*) FROM eligible WHERE acquisition_method = 'purchase')                                  AS purchase_acquisitions,
  (SELECT COUNT(*) FROM eligible WHERE acquisition_method = 'trade')                                     AS trade_acquisitions,
  (SELECT COUNT(*) FROM eligible WHERE acquisition_method NOT IN ('purchase', 'trade'))                  AS unknown_acquisition_methods,

  -- Exit method breakdown of the eligible population — should sum to
  -- eligible_for_value_transition_analysis. unknown_exit_methods is expected
  -- to be 0 (is_realized already requires exit_type IN ('sale','trade')) but
  -- is computed, not assumed, so a future third exit deal_type would show up
  -- here instead of silently vanishing.
  (SELECT COUNT(*) FROM eligible WHERE exit_type = 'sale')                                               AS sale_exits,
  (SELECT COUNT(*) FROM eligible WHERE exit_type = 'trade')                                              AS trade_exits,
  (SELECT COUNT(*) FROM eligible WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade'))          AS unknown_exit_methods,

  -- DOM coverage of the eligible population — should sum to
  -- eligible_for_value_transition_analysis.
  (SELECT COUNT(*) FROM eligible WHERE global_days_on_market IS NOT NULL)                                AS dom_usable_count,
  (SELECT COUNT(*) FROM eligible WHERE global_days_on_market IS NULL)                                    AS dom_missing_count,

  -- Historical-vs-app-tracked split of the eligible population — should sum
  -- to eligible_for_value_transition_analysis. Informational only: both
  -- cohorts are fully eligible (see SEMANTIC SCOPE above).
  (SELECT COUNT(*) FROM eligible WHERE is_historical_import)                                             AS historical_eligible_count,
  (SELECT COUNT(*) FROM eligible WHERE NOT is_historical_import)                                         AS app_tracked_eligible_count;


-- ============================================================================
-- QUERY A2 — Integrity summary
-- CLASSIFICATION: shared aggregate evidence.
-- One-row rollup of structural/data-quality checks over Business realized
-- items. Expected healthy values are 0 for every column except item_count
-- itself. Deliberately does NOT check anything derived from
-- acquisition_date (e.g. acquisition-to-listing delay, DOM-exceeds-holding)
-- — acquisition_date is not used anywhere in this file, so a historical
-- import's approximate acquisition date cannot and does not produce a
-- failure here. realized_dom_date_mismatch_count reuses the exact
-- definition from 01_acquisition_value_band_performance.sql's Query G5
-- (structural self-consistency check against the view's own DOM formula).
-- ============================================================================
WITH realized_business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business' AND is_realized
),
flagged AS (
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
eligible_bands AS (
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
  FROM flagged
  WHERE acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
)
SELECT
  (SELECT COUNT(*) FROM realized_business)                                              AS item_count,
  (SELECT COUNT(item_id) - COUNT(DISTINCT item_id) FROM realized_business)                AS duplicate_item_id_count,
  (SELECT COUNT(*) FROM flagged WHERE exit_before_first_listed)                           AS exit_before_first_listed_count,
  (SELECT COUNT(*) FROM flagged WHERE negative_dom)                                       AS negative_dom_count,
  (SELECT COUNT(*) FROM realized_business WHERE exit_value IS NULL)                       AS realized_missing_exit_value_count,
  (SELECT COUNT(*) FROM realized_business WHERE exit_type IS NULL)                        AS realized_missing_exit_method_count,
  (SELECT COUNT(*) FROM eligible_bands
     WHERE acquisition_value_band_order IS NULL OR acquisition_value_band_order NOT BETWEEN 1 AND 6
        OR exit_value_band_order        IS NULL OR exit_value_band_order        NOT BETWEEN 1 AND 6)  AS invalid_band_assignment_count,
  (SELECT COUNT(*) FROM flagged WHERE realized_dom_date_mismatch)                         AS realized_dom_date_mismatch_count;


-- ============================================================================
-- QUERY B — Performance by Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Primary eligible population (Business, realized, acquisition_value > 0,
-- exit_value > 0). value_increase = exit_value - acquisition_value, kept
-- distinct from net_profit (which additionally subtracts
-- item_expenses_total) everywhere in this file — see SEMANTIC SCOPE above.
-- Historical imports are fully included; historical_item_count /
-- app_tracked_item_count are informational cohort counts, not filters.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
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
agg AS (
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
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM banded
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
)
SELECT
  *,
  CASE
    WHEN sample_size <= 2 THEN 'insufficient'
    WHEN sample_size <= 5 THEN 'low'
    WHEN sample_size <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM agg
ORDER BY acquisition_value_band_order;


-- ============================================================================
-- QUERY C — Acquisition Value Band -> Exit Value Band transition matrix
-- CLASSIFICATION: shared aggregate evidence.
-- Every OBSERVED transition (empty combinations are never fabricated — a
-- plain GROUP BY only returns pairs that actually occur). movement is
-- derived purely from band ORDER comparison (exit_value_band_order vs.
-- acquisition_value_band_order), never from the dollar labels, so it is
-- immune to future label wording changes. share_within_acquisition_band_percent
-- is this row's share of ITS OWN acquisition band's total (denominator =
-- SUM(item_count) over the same acquisition_value_band_order);
-- share_of_all_transition_items_percent is this row's share of the entire
-- eligible population (denominator = grand total). Both are 0-100 scale.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
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
movement AS (
  SELECT
    *,
    CASE
      WHEN exit_value_band_order < acquisition_value_band_order THEN 'moved_down'
      WHEN exit_value_band_order = acquisition_value_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM banded
),
agg AS (
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
  FROM movement
  GROUP BY acquisition_value_band_order, acquisition_value_band_label,
           exit_value_band_order, exit_value_band_label, value_movement
),
shared AS (
  SELECT
    *,
    SUM(item_count) OVER (PARTITION BY acquisition_value_band_order) AS acquisition_band_total,
    SUM(item_count) OVER ()                                          AS grand_total
  FROM agg
)
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
FROM shared
ORDER BY acquisition_value_band_order, exit_value_band_order;


-- ============================================================================
-- QUERY C2 — Movement summary by Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Companion to Query C: collapses the transition matrix down to one row per
-- acquisition band, showing what share moved down, stayed in the same band,
-- or moved up. moved_down_percent + same_band_percent + moved_up_percent
-- reconcile to ~100% per band, subject only to independent ROUND()
-- rounding on each of the three shares.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
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
movement AS (
  SELECT
    *,
    CASE
      WHEN exit_value_band_order < acquisition_value_band_order THEN 'moved_down'
      WHEN exit_value_band_order = acquisition_value_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM banded
)
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
FROM movement
GROUP BY acquisition_value_band_order, acquisition_value_band_label
ORDER BY acquisition_value_band_order;


-- ============================================================================
-- QUERY D — Acquisition method x Exit method
-- CLASSIFICATION: shared aggregate evidence.
-- One row per OBSERVED (acquisition_method, exit_method) path — purchase ->
-- sale, purchase -> trade, trade -> sale, trade -> trade, and any
-- 'unknown' acquisition_method path (Historical Import items that were
-- later realized) if one is observed; nothing is silently discarded. Output
-- column exit_method is the view's exit_type verbatim (see header note on
-- why an "unknown" exit_method is not structurally reachable here).
-- Historical imports are fully included (see SEMANTIC SCOPE at top of
-- file); historical_item_count/app_tracked_item_count are informational.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
prepped AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
    exit_type AS exit_method
  FROM eligible
),
agg AS (
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
    COUNT(*) FILTER (WHERE NOT is_historical_import) AS app_tracked_item_count
  FROM prepped
  GROUP BY acquisition_method, exit_method
)
SELECT
  *,
  CASE
    WHEN sample_size <= 2 THEN 'insufficient'
    WHEN sample_size <= 5 THEN 'low'
    WHEN sample_size <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM agg
ORDER BY acquisition_method, exit_method;


-- ============================================================================
-- QUERY E — Acquisition Value Band x acquisition/exit method path
-- CLASSIFICATION: shared aggregate evidence.
-- Breaks the acquisition-method x exit-method paths (Query D) down by
-- Acquisition Value Band, so questions like "are $1,000-1,999 purchases
-- usually sold or traded out?" or "are $2,000-2,999 trade acquisitions
-- moving into higher exit bands?" can be answered directly. Every observed
-- combination is returned, including thin ones — see confidence before
-- treating any row as decided evidence; nothing is hidden via HAVING.
-- dom_sample_size is included alongside median_days_on_market for the same
-- reason every other section in this file pairs a median with its sample
-- size.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
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
agg AS (
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
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM banded
  GROUP BY acquisition_value_band_order, acquisition_value_band_label, acquisition_method, exit_method
)
SELECT
  *,
  CASE
    WHEN sample_size <= 2 THEN 'insufficient'
    WHEN sample_size <= 5 THEN 'low'
    WHEN sample_size <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM agg
ORDER BY acquisition_value_band_order, acquisition_method, exit_method;


-- ============================================================================
-- QUERY F — Purchase Price Band analysis
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to acquisition_method = 'purchase' — the ONLY section in this
-- file where acquisition_value may be called a "purchase price," because
-- the population is explicitly cash-purchase-only (see
-- analytics/SEMANTIC_CONTRACT.md). Uses purchase_price_band_order/label,
-- never acquisition_value_band_*, to make that restriction visible in the
-- output shape itself, not just in a comment.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_method = 'purchase'
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
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
  FROM eligible
),
agg AS (
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
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM banded
  GROUP BY purchase_price_band_order, purchase_price_band_label
)
SELECT
  *,
  CASE
    WHEN sample_size <= 2 THEN 'insufficient'
    WHEN sample_size <= 5 THEN 'low'
    WHEN sample_size <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM agg
ORDER BY purchase_price_band_order;


-- ============================================================================
-- QUERY G — Sale Price Band analysis
-- CLASSIFICATION: shared aggregate evidence.
-- Restricted to a cash-sale exit (exit_type = 'sale' — the view's own
-- exit-method convention verified against
-- 20260724000000_historical_deal_type_labels.sql before writing this
-- query; is_realized already guarantees exit_type IN ('sale','trade'), so
-- this filter cleanly isolates the cash-sale-only cohort). The ONLY section
-- in this file where exit_value may be called a "sale price." Uses
-- sale_price_band_order/label, never exit_value_band_*.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND exit_type = 'sale'
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
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
  FROM eligible
),
agg AS (
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
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market
  FROM banded
  GROUP BY sale_price_band_order, sale_price_band_label
)
SELECT
  *,
  CASE
    WHEN sample_size <= 2 THEN 'insufficient'
    WHEN sample_size <= 5 THEN 'low'
    WHEN sample_size <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM agg
ORDER BY sale_price_band_order;


-- ============================================================================
-- QUERY H — Developer-only item-level verification drilldown.
-- CLASSIFICATION: developer-only verification. Not part of a future shared
-- aggregate snapshot or user-facing recommendation output.
-- Item-level rows for manually verifying Sections B-E's aggregates during
-- this development phase only. Includes user_id so ownership can be
-- audited later, but implements NO shared-evidence or current-user
-- filtering — every eligible row across every user is returned. Only the
-- fields needed to verify the calculations above are exposed; no unrelated
-- personal or operational fields (no notes, no photos, no condition, no
-- tags). Never send this query's rows to an AI recommendation process or
-- a current user's UI as-is — see analytics/SEMANTIC_CONTRACT.md's
-- developer verification population definition.
-- ============================================================================
WITH eligible AS (
  SELECT * FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND is_realized
    AND acquisition_value IS NOT NULL AND acquisition_value > 0
    AND exit_value        IS NOT NULL AND exit_value        > 0
),
banded AS (
  SELECT
    *,
    (exit_value - acquisition_value) AS value_increase,
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
movement AS (
  SELECT
    *,
    CASE
      WHEN exit_value_band_order < acquisition_value_band_order THEN 'moved_down'
      WHEN exit_value_band_order = acquisition_value_band_order THEN 'stayed_in_same_band'
      ELSE 'moved_up'
    END AS value_movement
  FROM banded
)
SELECT
  item_id,
  user_id,
  item_display_name,
  is_historical_import,
  acquisition_method,
  exit_method,
  acquisition_value,
  acquisition_value_band_label,
  exit_value,
  exit_value_band_label,
  value_movement,
  net_profit,
  roi,
  global_days_on_market AS days_on_market
FROM movement
ORDER BY acquisition_value_band_order, exit_value_band_order, item_id;
