-- ============================================================================
-- 25_shared_calendar_cohort_correction_v2_10.sql
--
-- Analytics v2.10 — Shared Calendar Cohort Correction. A narrow follow-up
-- to v2.9 (24_calendar_coverage_confidence_v2_9.sql). See public.
-- _build_shared_calendar_cohort_correction_v2_10() (supabase/migrations/
-- 20260821000000_build_analytics_snapshot_v2_10.sql) for the actual
-- production transformation and the full, authoritative month-of-year /
-- MTD logic; nothing in this file creates a database object and nothing
-- here writes to production data. This file illustrates the two core
-- corrections standalone — the elaborate user-year seasonality grid and
-- the full pairwise-MTD common-cohort summary are only abbreviated here
-- (see the pointer comments), since they are lengthy and already fully
-- documented in the migration itself.
--
-- ── THE TWO PROBLEMS THIS CORRECTS (v2.9 left both in place, both
-- explicitly documented there as deliberate scope decisions) ─────────────
--
-- Problem 1 — v2.9's shared monthly_timeline / month_of_year_seasonality
-- called a period "fully_observed" whenever ANY in-scope user's coverage
-- fully observed it. If User 1 has confirmed coverage and User 2 is
-- pre-coverage or unknown, User 2's absent events were effectively read
-- as a confirmed zero — one covered user vouched for the whole
-- population.
--
-- Problem 2 — v2.9's shared current_month_to_date_pace computed the
-- CURRENT side over the full population while restricting each PRIOR
-- year to that year's confirmed cohort — comparing two different
-- populations and calling the difference a "pace."
--
-- ── THE FIX ────────────────────────────────────────────────────────────
-- A period/metric is coverage-qualified only when EVERY user counted in
-- it has CONFIRMED coverage for that period. MTD pairwise comparisons
-- use the SAME confirmed cohort on both the current-year and prior-year
-- side; a multi-year summary is computed only over the cohort common to
-- every included year (which, by monotonicity of complete_history_
-- start_date, is exactly the earliest comparable year's own cohort).
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A is SHARED AGGREGATE EVIDENCE — pooled across every user, no
-- item identity, no per-user grouping (cohort user COUNTS are exposed,
-- never which specific user_id is in a cohort).
-- ============================================================================

-- Query A -> shared_calendar_seasonality_evidence.monthly_timeline
-- (Problem 1, illustrated for the pooled monthly series)
WITH
c10_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable
  FROM public.analytics_item_lifecycle_v2
),
c10_as_of AS (
  SELECT 'America/Toronto'::text AS tz, (now() AT TIME ZONE 'America/Toronto')::date AS as_of_date
),
c10_scope_users AS ( SELECT DISTINCT user_id FROM c10_base ),
c10_user_coverage AS (
  SELECT su.user_id, COALESCE(aoc.coverage_status, 'unknown') AS coverage_status, aoc.complete_history_start_date
  FROM c10_scope_users su
  LEFT JOIN public.analytics_observation_coverage aoc ON aoc.user_id = su.user_id
),
c10_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT LEAST(
        MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
        MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
        MIN(exit_date)        FILTER (WHERE exit_date_reliable)
      ) FROM c10_base)),
    date_trunc('month', (SELECT as_of_date FROM c10_as_of)),
    interval '1 month'
  )::date AS month_start
),
-- Per (month_start, user) severity (0 unknown, 1 pre_coverage, 2 partial,
-- 3 fully_observed) — same predicate as v2.9. The FIX is in what happens
-- next: v2.9 took MAX(severity) across users (any witness qualifies);
-- v2.10 requires EVERY user to independently reach severity 3 AND
-- coverage_status = 'confirmed' before the period counts as
-- coverage-qualified for the pool.
c10_month_user_status AS (
  SELECT ms.month_start, uc.user_id, uc.coverage_status,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 0
      WHEN ms.month_start = date_trunc('month', (SELECT as_of_date FROM c10_as_of))::date THEN 2
      WHEN uc.complete_history_start_date <= ms.month_start THEN 3
      WHEN uc.complete_history_start_date < (ms.month_start + interval '1 month') THEN 2
      ELSE 1
    END AS severity
  FROM c10_month_series ms
  CROSS JOIN c10_user_coverage uc
),
c10_month_cohort AS (
  SELECT month_start,
    COUNT(*) AS total_shared_user_count,
    COUNT(*) FILTER (WHERE severity = 3 AND coverage_status = 'confirmed') AS fully_observed_confirmed_user_count,
    COUNT(*) FILTER (WHERE severity = 1) AS pre_coverage_user_count,
    COUNT(*) FILTER (WHERE severity = 0) AS unknown_coverage_user_count,
    COALESCE(ARRAY_AGG(user_id) FILTER (WHERE severity = 3 AND coverage_status = 'confirmed'), ARRAY[]::int[]) AS qualified_user_ids
  FROM c10_month_user_status
  GROUP BY month_start
)
SELECT
  month_start,
  total_shared_user_count,
  fully_observed_confirmed_user_count AS coverage_qualified_user_count,
  pre_coverage_user_count, unknown_coverage_user_count,
  -- Transparent shared status: 'fully_observed' ONLY when every user
  -- qualifies; 'unknown_coverage'/'pre_coverage' ONLY when every user
  -- shares that same status; 'partially_observed' when there is at
  -- least one (but not every) qualified witness; 'mixed_coverage'
  -- otherwise (no qualified witness, but not uniform either).
  CASE
    WHEN fully_observed_confirmed_user_count = total_shared_user_count THEN 'fully_observed'
    WHEN unknown_coverage_user_count = total_shared_user_count THEN 'unknown_coverage'
    WHEN pre_coverage_user_count = total_shared_user_count THEN 'pre_coverage'
    WHEN fully_observed_confirmed_user_count > 0 THEN 'partially_observed'
    ELSE 'mixed_coverage'
  END AS shared_coverage_status,
  -- Recorded totals: EVERY user, regardless of coverage (never hidden).
  (SELECT COUNT(*) FROM c10_base b WHERE b.acq_date_reliable AND date_trunc('month', b.acquisition_date)::date = mc.month_start) AS reliable_acquisition_item_count,
  -- Coverage-qualified totals: ONLY the qualified cohort for this month.
  -- NULL (never 0) when that cohort is empty — an absent witness is not
  -- a confirmed zero.
  CASE WHEN array_length(qualified_user_ids, 1) IS NULL THEN NULL ELSE
    (SELECT COUNT(*) FROM c10_base b WHERE b.acq_date_reliable AND date_trunc('month', b.acquisition_date)::date = mc.month_start AND b.user_id = ANY(qualified_user_ids))
  END AS coverage_qualified_acquisition_item_count
FROM c10_month_cohort mc
ORDER BY month_start;

-- See public._build_shared_calendar_cohort_correction_v2_10() for the
-- full month_of_year_seasonality user-year-observation-unit grid (every
-- (user, year, month_number) cell independently classified and
-- qualified — never pooled via a cross-user OR/MAX before qualification)
-- and the complete confidence ladder per event family.

-- Query A -> shared_calendar_seasonality_evidence.current_month_to_date_pace
-- (Problem 2, illustrated: per-prior-year cohort applied to BOTH sides)
--
-- For each candidate prior year Y with window [make_date(Y, current_
-- month, 1), make_date(Y, current_month, day_cutoff_used)]:
--   cohort_user_ids(Y) = users WHERE coverage_status = 'confirmed'
--                         AND complete_history_start_date <= window_start(Y)
--   prior_total(Y)   = SUM(events) WHERE user_id = ANY(cohort_user_ids(Y))
--                       AND event_date IN window(Y)
--   current_total(Y) = SUM(events) WHERE user_id = ANY(cohort_user_ids(Y))
--                       AND event_date IN CURRENT window
--                       -- SAME cohort as prior_total(Y), never the full
--                       -- current population.
--
-- Because complete_history_start_date is a single fixed date per user
-- and window_start(Y) strictly increases with Y, cohort_user_ids is
-- monotonically non-decreasing in Y: a user qualifying for the earliest
-- comparable year automatically qualifies for every later comparable
-- year (including the current year's own window). The cohort COMMON to
-- every comparable year therefore always equals the EARLIEST comparable
-- year's own cohort — this is the population
-- current_month_to_date_pace.common_cohort_summary uses for its
-- median/average, so every value entering that summary reflects one
-- identical, well-defined population, never a silently pooled mix of
-- different per-year cohorts. See public.
-- _build_shared_calendar_cohort_correction_v2_10() for the complete
-- per-pair current_cohort_metrics / prior_cohort_metrics / pairwise_
-- difference / excluded_pre_coverage_user_count / excluded_unknown_or_
-- estimated_user_count fields and the common-cohort summary
-- recomputation.
