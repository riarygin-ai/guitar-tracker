-- ============================================================================
-- 23_calendar_seasonality_v2.sql
--
-- Analytics v2.8 — Calendar & Seasonality. A NEW module (not a port of any
-- v1 file). See public._build_calendar_seasonality_snapshot_v2(int)
-- (supabase/migrations/20260819000000_build_analytics_snapshot_v2_8.sql)
-- for the actual production transformation; nothing in this file creates
-- a database object and nothing here writes to production data. The two
-- standalone queries below are the SAME logic as that function's shared/
-- target-user pipelines, runnable independently for manual inspection.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- Calendar activity, calendar trends, descriptive seasonality only.
-- Explicitly excluded: Findings Selector, Pattern Discovery, Business
-- Coach, forecasting, recommendations, external market data. Every
-- section is DESCRIPTIVE — no "best month" claim, no buying/selling
-- advice, no urgency, no seasonality score, no forecast, no causal claim,
-- no item-level row, no AI-generated prose.
--
-- ── SOURCES OF TRUTH ──────────────────────────────────────────────────────
-- Reads exclusively from public.analytics_item_lifecycle_v2 and public.
-- analytics_purpose_policy — no parallel date/deal/profit definition.
--
-- ── EVENT-DATE RELIABILITY ─────────────────────────────────────────────────
-- acq_date_reliable  = acquisition_date IS NOT NULL AND NOT is_historical_
--   import AND NOT has_lifecycle_date_issue (a Historical Import's
--   acquisition date never contributes to acquisition calendar evidence).
-- listing_date_reliable = first_listed_at IS NOT NULL AND NOT has_
--   lifecycle_date_issue (Historical Import status does NOT exclude a
--   listing date).
-- exit_date_reliable = is_realized AND exit_date IS NOT NULL AND NOT has_
--   lifecycle_date_issue (Historical Import status does NOT exclude an
--   exit date). Missing/unreliable dates are never treated as zero-
--   duration or an invented date — they stay visible in population_and_
--   date_coverage's exclusion counters.
--
-- ── PURPOSE IS CURRENT DISPOSITION, NOT PROVEN HISTORICAL INTENT ─────────
-- A historical event grouped under Business/Hybrid/Personal reflects the
-- item's CURRENT purpose_id only. Every section is produced pooled AND
-- broken down by (current_purpose_id, current_purpose_name, purpose_
-- policy_status), using the SAME missing-purpose/missing-policy
-- collapsing rule as every other v2 module, with purpose_population_
-- summary additionally surfacing analytics_purpose_policy fields.
--
-- ── DEAL-COUNT / ITEM-COUNT SEPARATION ────────────────────────────────────
-- deal_items.total_value is already the per-item allocated share of a
-- deal's cash (not the full deal total repeated per item), so SUM(...)
-- never double-counts a multi-item deal. Distinct deal counts (COUNT
-- (DISTINCT acquisition_deal_id / exit_deal_id)) are reported ALONGSIDE,
-- never instead of, item counts. Listing events have no deal_id.
--
-- ── MONTHLY TIMELINE ──────────────────────────────────────────────────────
-- Gap-filled: a generate_series from the earliest reliable event date
-- through the current America/Toronto month, LEFT JOINed to observed
-- activity, so a zero-activity month still appears as a row with 0s.
--
-- ── MONTH-OF-YEAR SEASONALITY ─────────────────────────────────────────────
-- 12 rows (Jan-Dec), all years pooled. Every row reports its own
-- distinct-year contributing count per event type and a confidence/status
-- field that is 'insufficient_years' whenever fewer than 2 distinct years
-- contributed an observation — regardless of item count.
--
-- ── DAY-OF-WEEK PATTERNS ───────────────────────────────────────────────────
-- Three INDEPENDENT Monday-Sunday (ISO weekday) arrays — acquisition,
-- first-listing, realized-exit — never combined into one ambiguous
-- weekday metric.
--
-- ── CURRENT MONTH-TO-DATE PACE — POOLED ONLY (SCOPE DECISION) ────────────
-- Compares the current America/Toronto MTD window against the SAME
-- calendar-day cutoff in every prior year with reliable data (e.g. an
-- August 12 snapshot compares August 1-12 of each prior year, never a
-- full prior August). Computed pooled only, not broken down _by_purpose
-- (see the migration header for the full scope-decision rationale).
-- February/short months handled via LEAST(current_day_of_month, days_in_
-- that_prior_month). Zero comparable prior years -> status
-- 'insufficient_history', never a fabricated median/average/difference.
-- Never presented as a forecast for the completed current month.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_calendar_seasonality_evidence
WITH
cs_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
cs_purposes AS ( SELECT DISTINCT group_purpose_id, group_purpose_name, purpose_policy_status FROM cs_base ),
cs_as_of AS (
  SELECT 'America/Toronto'::text AS tz, (now() AT TIME ZONE 'America/Toronto')::date AS as_of_date
),

cs_pop_row AS (
  SELECT
    COUNT(*)                                                                          AS total_item_count,
    COUNT(*) FILTER (WHERE acq_date_reliable)                                         AS reliable_acquisition_date_count,
    COUNT(*) FILTER (WHERE acquisition_date IS NULL)                                  AS missing_acquisition_date_count,
    COUNT(*) FILTER (WHERE acquisition_date IS NOT NULL AND is_historical_import)     AS historical_import_excluded_acquisition_date_count,
    COUNT(*) FILTER (WHERE acquisition_date IS NOT NULL AND NOT is_historical_import AND has_lifecycle_date_issue) AS lifecycle_issue_excluded_acquisition_date_count,
    COUNT(*) FILTER (WHERE listing_date_reliable)                                     AS reliable_first_listing_date_count,
    COUNT(*) FILTER (WHERE first_listed_at IS NULL)                                   AS missing_first_listing_date_count,
    COUNT(*) FILTER (WHERE first_listed_at IS NOT NULL AND has_lifecycle_date_issue)  AS lifecycle_issue_excluded_listing_date_count,
    COUNT(*) FILTER (WHERE is_realized)                                               AS realized_item_count,
    COUNT(*) FILTER (WHERE exit_date_reliable)                                        AS reliable_realized_exit_date_count,
    COUNT(*) FILTER (WHERE is_realized AND exit_date IS NULL)                         AS missing_exit_date_for_realized_count,
    COUNT(*) FILTER (WHERE is_realized AND exit_date IS NOT NULL AND has_lifecycle_date_issue) AS lifecycle_issue_excluded_exit_date_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_holding_duration_sample_count,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                         AS reliable_dom_sample_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                      AS historical_import_item_count,
    COUNT(*) FILTER (WHERE is_historical_import AND is_realized)                      AS historical_import_realized_item_count,
    COUNT(*) FILTER (WHERE is_historical_import AND NOT is_realized)                  AS historical_import_open_item_count,
    LEAST(
      MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
      MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
      MIN(exit_date)        FILTER (WHERE exit_date_reliable)
    )                                                                                 AS earliest_eligible_event_date,
    GREATEST(
      MAX(acquisition_date) FILTER (WHERE acq_date_reliable),
      MAX(first_listed_at)  FILTER (WHERE listing_date_reliable),
      MAX(exit_date)        FILTER (WHERE exit_date_reliable)
    )                                                                                 AS latest_eligible_event_date
  FROM cs_base
),
cs_pop_purpose_rows AS (
  SELECT
    b.group_purpose_id AS current_purpose_id, b.group_purpose_name AS current_purpose_name, b.purpose_policy_status,
    pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description AS purpose_policy_description,
    COUNT(*)                                                                          AS total_item_count,
    COUNT(*) FILTER (WHERE b.acq_date_reliable)                                       AS reliable_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable)                                      AS reliable_realized_exit_date_count,
    COUNT(*) FILTER (WHERE b.listing_date_reliable)                                   AS reliable_first_listing_date_count,
    COUNT(*) FILTER (WHERE b.is_realized)                                             AS realized_item_count,
    COUNT(*) FILTER (WHERE b.is_historical_import)                                    AS historical_import_item_count
  FROM cs_base b
  LEFT JOIN public.analytics_purpose_policy pp ON pp.purpose_id = b.group_purpose_id AND b.purpose_policy_status = 'mapped'
  GROUP BY b.group_purpose_id, b.group_purpose_name, b.purpose_policy_status, pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description
),

cs_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM cs_pop_row)),
    date_trunc('month', (SELECT as_of_date FROM cs_as_of)),
    interval '1 month'
  )::date AS month_start
),
cs_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1
),
cs_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1
),
cs_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count,
    SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM cs_base WHERE exit_date_reliable GROUP BY 1
),
cs_monthly_rows AS (
  SELECT ms.month_start,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM cs_month_series ms
  LEFT JOIN cs_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN cs_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN cs_monthly_exit e ON e.month_start = ms.month_start
),
-- NOTE: see the migration's _by_purpose CTEs (cs_monthly_acq_purpose /
-- cs_monthly_listing_purpose / cs_monthly_exit_purpose / cs_monthly_
-- purpose_rows) for the full purpose-gap-filled monthly timeline —
-- omitted here for brevity; this reference file's monthly_timeline_by_
-- purpose key below is illustrative only (empty placeholder).

cs_month_numbers AS ( SELECT generate_series(1, 12) AS month_number ),
cs_moy_acq AS (
  SELECT EXTRACT(MONTH FROM acquisition_date)::int AS month_number,
    COUNT(*) AS item_count, COUNT(DISTINCT EXTRACT(YEAR FROM acquisition_date)) AS distinct_year_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1
),
cs_moy_listing AS (
  SELECT EXTRACT(MONTH FROM first_listed_at)::int AS month_number,
    COUNT(*) AS item_count, COUNT(DISTINCT EXTRACT(YEAR FROM first_listed_at)) AS distinct_year_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1
),
cs_moy_exit AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number,
    COUNT(*) AS item_count, COUNT(DISTINCT EXTRACT(YEAR FROM exit_date)) AS distinct_year_count,
    SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM cs_base WHERE exit_date_reliable GROUP BY 1
),
cs_moy_rows AS (
  SELECT mn.month_number, TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth')) AS month_name,
    COALESCE(a.item_count, 0) AS acquisition_item_count, COALESCE(a.distinct_year_count, 0) AS acquisition_distinct_year_count, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum,
    CASE WHEN COALESCE(a.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(a.distinct_year_count, 0) <= 1 THEN 'insufficient_years' WHEN a.item_count <= 2 THEN 'insufficient' WHEN a.item_count <= 5 THEN 'low' WHEN a.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS acquisition_confidence,
    COALESCE(l.item_count, 0) AS first_listing_item_count, COALESCE(l.distinct_year_count, 0) AS first_listing_distinct_year_count,
    CASE WHEN COALESCE(l.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(l.distinct_year_count, 0) <= 1 THEN 'insufficient_years' WHEN l.item_count <= 2 THEN 'insufficient' WHEN l.item_count <= 5 THEN 'low' WHEN l.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS first_listing_confidence,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.distinct_year_count, 0) AS realized_exit_distinct_year_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum,
    e.median_net_profit, COALESCE(e.dom_sample_size, 0) AS dom_sample_size, e.median_days_on_market, COALESCE(e.holding_sample_size, 0) AS holding_sample_size, e.median_holding_days,
    CASE WHEN COALESCE(e.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(e.distinct_year_count, 0) <= 1 THEN 'insufficient_years' WHEN e.item_count <= 2 THEN 'insufficient' WHEN e.item_count <= 5 THEN 'low' WHEN e.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS realized_exit_confidence
  FROM cs_month_numbers mn
  LEFT JOIN cs_moy_acq a ON a.month_number = mn.month_number
  LEFT JOIN cs_moy_listing l ON l.month_number = mn.month_number
  LEFT JOIN cs_moy_exit e ON e.month_number = mn.month_number
),

cs_weekday_numbers AS ( SELECT generate_series(1, 7) AS weekday_number ),
cs_dow_acq AS (
  SELECT EXTRACT(ISODOW FROM acquisition_date)::int AS weekday_number,
    COUNT(*) AS event_count, COUNT(DISTINCT acquisition_deal_id) AS distinct_deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1
),
cs_dow_listing AS (
  SELECT EXTRACT(ISODOW FROM first_listed_at)::int AS weekday_number, COUNT(*) AS event_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1
),
cs_dow_exit AS (
  SELECT EXTRACT(ISODOW FROM exit_date)::int AS weekday_number,
    COUNT(*) AS event_count, COUNT(DISTINCT exit_deal_id) AS distinct_deal_count,
    SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit
  FROM cs_base WHERE exit_date_reliable GROUP BY 1
),
cs_dow_acq_rows AS (
  SELECT wn.weekday_number, CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(a.event_count, 0) AS event_count, COALESCE(a.distinct_deal_count, 0) AS distinct_deal_count, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum
  FROM cs_weekday_numbers wn LEFT JOIN cs_dow_acq a ON a.weekday_number = wn.weekday_number
),
cs_dow_listing_rows AS (
  SELECT wn.weekday_number, CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(l.event_count, 0) AS event_count
  FROM cs_weekday_numbers wn LEFT JOIN cs_dow_listing l ON l.weekday_number = wn.weekday_number
),
cs_dow_exit_rows AS (
  SELECT wn.weekday_number, CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(e.event_count, 0) AS event_count, COALESCE(e.distinct_deal_count, 0) AS distinct_deal_count, COALESCE(e.exit_value_sum, 0) AS exit_value_sum, COALESCE(e.net_profit_sum, 0) AS net_profit_sum, e.median_net_profit
  FROM cs_weekday_numbers wn LEFT JOIN cs_dow_exit e ON e.weekday_number = wn.weekday_number
),

cs_mtd_params AS (
  SELECT a.tz, a.as_of_date, EXTRACT(YEAR FROM a.as_of_date)::int AS current_year, EXTRACT(MONTH FROM a.as_of_date)::int AS current_month, EXTRACT(DAY FROM a.as_of_date)::int AS current_day_of_month, p.earliest_eligible_event_date
  FROM cs_as_of a, cs_pop_row p
),
cs_mtd_current AS (
  SELECT
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS acquisition_item_count,
    SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date AND b.acquisition_value IS NOT NULL) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_exit_item_count,
    SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_exit_value_sum,
    SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_net_profit_sum
  FROM cs_base b, cs_mtd_params mp
),
cs_mtd_prior_years AS ( SELECT y AS year FROM cs_mtd_params mp, generate_series(EXTRACT(YEAR FROM mp.earliest_eligible_event_date)::int, mp.current_year - 1) AS y ),
cs_mtd_prior_windows AS (
  SELECT py.year, make_date(py.year, mp.current_month, 1) AS window_start,
    LEAST(mp.current_day_of_month, EXTRACT(DAY FROM (make_date(py.year, mp.current_month, 1) + interval '1 month - 1 day'))::int) AS day_cutoff_used
  FROM cs_mtd_prior_years py, cs_mtd_params mp
),
cs_mtd_prior_windows2 AS (
  SELECT year, window_start, day_cutoff_used, make_date(year, EXTRACT(MONTH FROM window_start)::int, day_cutoff_used) AS window_end FROM cs_mtd_prior_windows
),
cs_mtd_prior_rows AS (
  SELECT w.year, w.day_cutoff_used, w.window_start, w.window_end,
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN w.window_start AND w.window_end) AS acquisition_item_count,
    COALESCE(SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN w.window_start AND w.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN w.window_start AND w.window_end) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end) AS realized_exit_item_count,
    COALESCE(SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end), 0) AS realized_exit_value_sum,
    COALESCE(SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end), 0) AS realized_net_profit_sum
  FROM cs_mtd_prior_windows2 w CROSS JOIN cs_base b
  GROUP BY w.year, w.day_cutoff_used, w.window_start, w.window_end
),
cs_mtd_prior_summary AS (
  SELECT COUNT(*) AS comparable_prior_years_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_item_count)::numeric, 2) AS median_acquisition_item_count, ROUND(AVG(acquisition_item_count)::numeric, 2) AS average_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value_sum)::numeric, 2) AS median_acquisition_value_sum, ROUND(AVG(acquisition_value_sum)::numeric, 2) AS average_acquisition_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_listing_item_count)::numeric, 2) AS median_first_listing_item_count, ROUND(AVG(first_listing_item_count)::numeric, 2) AS average_first_listing_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_item_count)::numeric, 2) AS median_realized_exit_item_count, ROUND(AVG(realized_exit_item_count)::numeric, 2) AS average_realized_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_value_sum)::numeric, 2) AS median_realized_exit_value_sum, ROUND(AVG(realized_exit_value_sum)::numeric, 2) AS average_realized_exit_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_net_profit_sum)::numeric, 2) AS median_realized_net_profit_sum, ROUND(AVG(realized_net_profit_sum)::numeric, 2) AS average_realized_net_profit_sum
  FROM cs_mtd_prior_rows
),
cs_mtd_object AS (
  SELECT jsonb_build_object(
    'timezone', mp.tz, 'as_of_date', mp.as_of_date, 'current_year', mp.current_year, 'current_month', mp.current_month, 'current_day_of_month', mp.current_day_of_month,
    'current_month_to_date', jsonb_build_object('acquisition_item_count', COALESCE(cur.acquisition_item_count, 0), 'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0), 'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0), 'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0), 'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0), 'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0)),
    'comparable_prior_years_count', COALESCE(sm.comparable_prior_years_count, 0),
    'comparable_prior_years', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.year), '[]'::jsonb) FROM cs_mtd_prior_rows r),
    'prior_year_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', sm.median_acquisition_item_count, 'acquisition_value_sum', sm.median_acquisition_value_sum, 'first_listing_item_count', sm.median_first_listing_item_count, 'realized_exit_item_count', sm.median_realized_exit_item_count, 'realized_exit_value_sum', sm.median_realized_exit_value_sum, 'realized_net_profit_sum', sm.median_realized_net_profit_sum) END,
    'prior_year_average', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', sm.average_acquisition_item_count, 'acquisition_value_sum', sm.average_acquisition_value_sum, 'first_listing_item_count', sm.average_first_listing_item_count, 'realized_exit_item_count', sm.average_realized_exit_item_count, 'realized_exit_value_sum', sm.average_realized_exit_value_sum, 'realized_net_profit_sum', sm.average_realized_net_profit_sum) END,
    'difference_vs_prior_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', COALESCE(cur.acquisition_item_count, 0) - sm.median_acquisition_item_count, 'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0) - sm.median_acquisition_value_sum, 'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0) - sm.median_first_listing_item_count, 'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0) - sm.median_realized_exit_item_count, 'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0) - sm.median_realized_exit_value_sum, 'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0) - sm.median_realized_net_profit_sum) END,
    'status', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN 'insufficient_history' ELSE 'sufficient_history' END,
    'note', 'Descriptive month-to-date comparison only. Not a forecast for the completed current month.'
  ) AS payload
  FROM cs_mtd_params mp, cs_mtd_current cur, cs_mtd_prior_summary sm
)

SELECT jsonb_build_object(
    'timezone', (SELECT tz FROM cs_as_of),
    'as_of_date', (SELECT as_of_date FROM cs_as_of),
    'population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_row)), '[]'::jsonb) FROM cs_pop_row),
    'purpose_population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_purpose_rows) ORDER BY CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END, current_purpose_name NULLS LAST), '[]'::jsonb) FROM cs_pop_purpose_rows),
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM cs_monthly_rows),
    -- monthly_timeline_by_purpose: same pattern, cross-joined against
    -- cs_purposes x cs_month_series with purpose-grouped acq/listing/exit
    -- CTEs — see the migration for the full gap-filled version.
    'monthly_timeline_by_purpose', '[]'::jsonb,
    'month_of_year_seasonality', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_moy_rows) ORDER BY month_number), '[]'::jsonb) FROM cs_moy_rows),
    'month_of_year_seasonality_by_purpose', '[]'::jsonb,
    'day_of_week_acquisition_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_acq_rows) ORDER BY weekday_number), '[]'::jsonb) FROM cs_dow_acq_rows),
    'day_of_week_acquisition_activity_by_purpose', '[]'::jsonb,
    'day_of_week_first_listing_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_listing_rows) ORDER BY weekday_number), '[]'::jsonb) FROM cs_dow_listing_rows),
    'day_of_week_first_listing_activity_by_purpose', '[]'::jsonb,
    'day_of_week_realized_exit_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_exit_rows) ORDER BY weekday_number), '[]'::jsonb) FROM cs_dow_exit_rows),
    'day_of_week_realized_exit_activity_by_purpose', '[]'::jsonb,
    'current_month_to_date_pace', (SELECT payload FROM cs_mtd_object)
);


-- Query B -> target_user_calendar_seasonality_evidence
-- Identical query, with the base CTE filtered to one user. REPLACE 2 with
-- a real app_users.id before running.
WITH
ct_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
ct_as_of AS (
  SELECT 'America/Toronto'::text AS tz, (now() AT TIME ZONE 'America/Toronto')::date AS as_of_date
),
ct_pop_row AS (
  SELECT
    COUNT(*)                                                                          AS total_item_count,
    COUNT(*) FILTER (WHERE acq_date_reliable)                                         AS reliable_acquisition_date_count,
    COUNT(*) FILTER (WHERE exit_date_reliable)                                        AS reliable_realized_exit_date_count,
    COUNT(*) FILTER (WHERE listing_date_reliable)                                     AS reliable_first_listing_date_count,
    COUNT(*) FILTER (WHERE is_realized)                                               AS realized_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                      AS historical_import_item_count,
    LEAST(
      MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
      MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
      MIN(exit_date)        FILTER (WHERE exit_date_reliable)
    )                                                                                 AS earliest_eligible_event_date,
    GREATEST(
      MAX(acquisition_date) FILTER (WHERE acq_date_reliable),
      MAX(first_listed_at)  FILTER (WHERE listing_date_reliable),
      MAX(exit_date)        FILTER (WHERE exit_date_reliable)
    )                                                                                 AS latest_eligible_event_date
  FROM ct_base
),
ct_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM ct_pop_row)),
    date_trunc('month', (SELECT as_of_date FROM ct_as_of)),
    interval '1 month'
  )::date AS month_start
),
ct_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1
),
ct_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count FROM ct_base WHERE listing_date_reliable GROUP BY 1
),
ct_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM ct_base WHERE exit_date_reliable GROUP BY 1
),
ct_monthly_rows AS (
  SELECT ms.month_start,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM ct_month_series ms
  LEFT JOIN ct_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN ct_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN ct_monthly_exit e ON e.month_start = ms.month_start
)

SELECT jsonb_build_object(
    'timezone', (SELECT tz FROM ct_as_of),
    'as_of_date', (SELECT as_of_date FROM ct_as_of),
    'population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_pop_row)), '[]'::jsonb) FROM ct_pop_row),
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM ct_monthly_rows)
    -- purpose_population_summary / *_by_purpose / month_of_year_
    -- seasonality / day_of_week_* / current_month_to_date_pace follow the
    -- exact same pattern as Query A above, base-filtered to ct_base — see
    -- the migration (_build_calendar_seasonality_snapshot_v2) for the
    -- complete, authoritative target-user pipeline.
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- This module is evidence only: no "best month" recommendation, no
-- buying/selling advice, no urgency, no seasonality score without
-- transparent sample-size/contributing-year support, no forecast, no
-- causal claim, no item-level row, no AI-generated prose. A month or
-- weekday with observations from only one contributing year is flagged
-- 'insufficient_years' regardless of item count — never presented as
-- reliable recurring seasonality. current_month_to_date_pace is a
-- descriptive same-day-cutoff comparison only, never a forecast for the
-- completed current month, and reports 'insufficient_history' rather than
-- fabricating a conclusion when zero comparable prior years exist.
