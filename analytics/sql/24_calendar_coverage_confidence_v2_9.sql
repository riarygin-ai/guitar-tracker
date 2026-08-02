-- ============================================================================
-- 24_calendar_coverage_confidence_v2_9.sql
--
-- Analytics v2.9 — Calendar Observation Coverage & Confidence Correction.
-- A focused correction to v2.8 Calendar & Seasonality. See public.
-- _build_calendar_coverage_correction_v2_9(int) (supabase/migrations/
-- 20260820000000_build_analytics_snapshot_v2_9.sql) for the actual
-- production transformation and the full, authoritative month-of-year /
-- current-month-to-date-pace logic; nothing in this file creates a
-- database object and nothing here writes to production data. This file
-- illustrates the core coverage predicate and the monthly_timeline
-- correction standalone — the more elaborate month-of-year confidence
-- ladder and MTD comparable-cohort logic are only abbreviated here (see
-- the pointer comments) since they are lengthy and already fully
-- documented in the migration itself.
--
-- ── THE BUG THIS CORRECTS ─────────────────────────────────────────────────
-- v2.8 treated a calendar year's mere EXISTENCE as proof the whole year
-- had been observed. An isolated old event followed by a long tracking
-- gap made pre-tracking zero months look like genuine observed zeros, and
-- seasonality confidence could reach 'stronger' even when most
-- observations came from a single year.
--
-- ── OBSERVATION COVERAGE STORAGE ─────────────────────────────────────────
-- public.analytics_observation_coverage — one OPTIONAL row per app_users.
-- id (an absent row means 'unknown' coverage, never a fabricated earliest-
-- event date). coverage_status: 'confirmed' (verified against an external
-- fact — required for MTD comparability and the 'stronger' seasonality
-- tier), 'estimated' (a best guess — good enough to avoid false observed-
-- zeros in monthly_timeline/month-of-year, not trusted enough for MTD or
-- 'stronger'), or 'unknown' (complete_history_start_date MUST be NULL).
-- Never populated automatically — see the migration's operator
-- configuration SQL template.
--
-- ── CORE COVERAGE PREDICATE ───────────────────────────────────────────────
-- For a user's coverage row and a reference calendar month (month_start):
--   'unknown_coverage' — coverage_status = 'unknown' or no row at all.
--   'fully_observed'   — complete_history_start_date <= month_start, AND
--                        month_start has not yet reached the current
--                        America/Toronto month (the current, still-in-
--                        progress month — and any future month within the
--                        current year — is ALWAYS capped at 'partial',
--                        regardless of how early coverage began).
--   'partial'          — complete_history_start_date falls strictly
--                        inside this month, OR this IS the current/future
--                        in-progress month.
--   'pre_coverage'     — complete_history_start_date falls in some LATER
--                        month (this month entirely precedes coverage).
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_calendar_seasonality_evidence (observation_coverage_
-- summary + corrected monthly_timeline)
WITH
c9_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable
  FROM public.analytics_item_lifecycle_v2
),
c9_as_of AS (
  SELECT 'America/Toronto'::text AS tz, (now() AT TIME ZONE 'America/Toronto')::date AS as_of_date
),
c9s_scope_users AS ( SELECT DISTINCT user_id FROM c9_base ),
c9s_user_coverage AS (
  SELECT su.user_id, COALESCE(aoc.coverage_status, 'unknown') AS coverage_status, aoc.complete_history_start_date
  FROM c9s_scope_users su
  LEFT JOIN public.analytics_observation_coverage aoc ON aoc.user_id = su.user_id
),
c9s_coverage_summary AS (
  SELECT jsonb_build_object(
    'fully_observed_user_count',   COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date <= date_trunc('month', a.as_of_date)::date),
    'partial_coverage_user_count', COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date > date_trunc('month', a.as_of_date)::date AND uc.complete_history_start_date < (date_trunc('month', a.as_of_date)::date + interval '1 month')),
    'pre_coverage_user_count',     COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date >= (date_trunc('month', a.as_of_date)::date + interval '1 month')),
    'unknown_coverage_user_count', COUNT(*) FILTER (WHERE uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL),
    'total_user_count',            COUNT(*)
  ) AS payload
  FROM c9s_user_coverage uc, c9_as_of a
),
c9s_pop_earliest AS (
  SELECT LEAST(
    MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
    MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
    MIN(exit_date)        FILTER (WHERE exit_date_reliable)
  ) AS earliest_eligible_event_date
  FROM c9_base
),
c9s_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM c9s_pop_earliest)),
    date_trunc('month', (SELECT as_of_date FROM c9_as_of)),
    interval '1 month'
  )::date AS month_start
),
c9s_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c9_base WHERE acq_date_reliable GROUP BY 1
),
c9s_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM c9_base WHERE listing_date_reliable GROUP BY 1
),
c9s_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c9_base WHERE exit_date_reliable GROUP BY 1
),
-- Severity-ranked per (month, user) status (0 unknown, 1 pre_coverage, 2
-- partial, 3 fully_observed) — shared scope reports the pool's MOST
-- FAVORABLE supported label (MAX), never requiring unanimous coverage
-- (that would let one late-onboarded user permanently poison every
-- earlier month for the whole pool). Real event totals always come from
-- ALL users regardless of this label.
c9s_month_user_status AS (
  SELECT ms.month_start, uc.user_id,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 0
      WHEN ms.month_start = date_trunc('month', (SELECT as_of_date FROM c9_as_of))::date THEN 2
      WHEN uc.complete_history_start_date <= ms.month_start THEN 3
      WHEN uc.complete_history_start_date < (ms.month_start + interval '1 month') THEN 2
      ELSE 1
    END AS severity
  FROM c9s_month_series ms
  CROSS JOIN c9s_user_coverage uc
),
c9s_month_coverage AS (
  SELECT month_start,
    CASE MAX(severity) WHEN 3 THEN 'fully_observed' WHEN 2 THEN 'partial' WHEN 1 THEN 'pre_coverage' ELSE 'unknown_coverage' END AS coverage_status
  FROM c9s_month_user_status
  GROUP BY month_start
),
c9s_monthly_rows AS (
  SELECT ms.month_start, mc.coverage_status,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM c9s_month_series ms
  JOIN c9s_month_coverage mc ON mc.month_start = ms.month_start
  LEFT JOIN c9s_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN c9s_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN c9s_monthly_exit e ON e.month_start = ms.month_start
)
SELECT jsonb_build_object(
  'observation_coverage_summary', (SELECT payload FROM c9s_coverage_summary),
  'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(c9s_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM c9s_monthly_rows)
  -- monthly_timeline_by_purpose follows the exact same coverage-status
  -- join, grouped additionally by (current_purpose_id, current_purpose_
  -- name, purpose_policy_status). month_of_year_seasonality and
  -- current_month_to_date_pace require a full (user x candidate-year x
  -- month-number) coverage grid, independent of events, so a genuinely-
  -- zero-but-fully-observed year is still counted — see the migration for
  -- the complete, authoritative logic (confidence ladder: no_data /
  -- coverage_unknown / insufficient_years / low / moderate / stronger,
  -- and the confirmed-coverage-only MTD comparable-cohort rule).
);


-- Query B -> target_user_calendar_seasonality_evidence
-- Identical query, with the base CTE filtered to one user and the
-- coverage-scope reduced to that single user (no MAX-severity pooling
-- needed — one user has exactly one status per month). REPLACE 2 with a
-- real app_users.id before running.
WITH
ct_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
ct_as_of AS (
  SELECT 'America/Toronto'::text AS tz, (now() AT TIME ZONE 'America/Toronto')::date AS as_of_date
),
ct_user_coverage AS (
  SELECT 2::bigint AS user_id, COALESCE(aoc.coverage_status, 'unknown') AS coverage_status, aoc.complete_history_start_date
  FROM (SELECT 1) dummy
  LEFT JOIN public.analytics_observation_coverage aoc ON aoc.user_id = 2 -- REPLACE 2 with the same user id
),
ct_coverage_summary AS (
  SELECT jsonb_build_object(
    'fully_observed_user_count',   COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date <= date_trunc('month', a.as_of_date)::date),
    'partial_coverage_user_count', COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date > date_trunc('month', a.as_of_date)::date AND uc.complete_history_start_date < (date_trunc('month', a.as_of_date)::date + interval '1 month')),
    'pre_coverage_user_count',     COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date >= (date_trunc('month', a.as_of_date)::date + interval '1 month')),
    'unknown_coverage_user_count', COUNT(*) FILTER (WHERE uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL),
    'total_user_count',            COUNT(*)
  ) AS payload
  FROM ct_user_coverage uc, ct_as_of a
),
ct_pop_earliest AS (
  SELECT LEAST(
    MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
    MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
    MIN(exit_date)        FILTER (WHERE exit_date_reliable)
  ) AS earliest_eligible_event_date
  FROM ct_base
),
ct_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM ct_pop_earliest)),
    date_trunc('month', (SELECT as_of_date FROM ct_as_of)),
    interval '1 month'
  )::date AS month_start
),
ct_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1
),
ct_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1
),
ct_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM ct_base WHERE exit_date_reliable GROUP BY 1
),
ct_month_coverage AS (
  SELECT ms.month_start,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 'unknown_coverage'
      WHEN ms.month_start = date_trunc('month', (SELECT as_of_date FROM ct_as_of))::date THEN 'partial'
      WHEN uc.complete_history_start_date <= ms.month_start THEN 'fully_observed'
      WHEN uc.complete_history_start_date < (ms.month_start + interval '1 month') THEN 'partial'
      ELSE 'pre_coverage'
    END AS coverage_status
  FROM ct_month_series ms, ct_user_coverage uc
),
ct_monthly_rows AS (
  SELECT ms.month_start, mc.coverage_status,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM ct_month_series ms
  JOIN ct_month_coverage mc ON mc.month_start = ms.month_start
  LEFT JOIN ct_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN ct_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN ct_monthly_exit e ON e.month_start = ms.month_start
)
SELECT jsonb_build_object(
  'observation_coverage_summary', (SELECT payload FROM ct_coverage_summary),
  'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM ct_monthly_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- This module remains evidence only: no "best month" recommendation, no
-- buying/selling advice, no urgency, no seasonality score without
-- transparent sample-size/contributing-year/coverage support, no
-- forecast, no causal claim, no item-level row, no AI-generated prose.
-- A month/year is never treated as a confirmed observation merely because
-- SOME data point from that calendar year exists — only complete_
-- history_start_date, explicitly configured per user, establishes that. A
-- fully-observed zero-activity year is valid, real evidence; a pre-
-- coverage or unknown-coverage zero is NEVER presented as equivalent to
-- it. One dominating year caps confidence even when the total item count
-- is large. current_month_to_date_pace is never presented as a forecast
-- for the completed current month, and reports 'insufficient_history' or
-- 'coverage_unknown' rather than fabricating a conclusion when confirmed
-- comparable prior years don't exist.
