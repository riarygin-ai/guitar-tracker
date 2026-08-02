-- build_analytics_snapshot_v2_10
--
-- Analytics v2.10 — Shared Calendar Cohort Correction.
-- A narrow follow-up to v2.9. v2.9 correctly fixed TARGET-USER calendar
-- coverage (a single user's own confirmed/estimated/unknown coverage
-- governs their own evidence). It left two SHARED-scope cohort problems
-- in place, both explicitly documented as deliberate scope decisions in
-- v2.9's own header — this migration corrects both:
--
-- Problem 1 — one covered user vouched for the whole shared population.
-- v2.9's shared monthly_timeline / month_of_year_seasonality called a
-- period "fully_observed" whenever ANY in-scope user's coverage fully
-- observed it. If User 1 has confirmed coverage and User 2 is pre-
-- coverage or unknown, User 2's absent events were effectively treated
-- as a confirmed zero. v2.10 requires EVERY user counted in a metric to
-- have CONFIRMED coverage for that period before it counts as
-- coverage-qualified — one user can no longer vouch for another.
--
-- Problem 2 — shared MTD compared different populations. v2.9's shared
-- current_month_to_date_pace computed the CURRENT side over the full
-- population while restricting each PRIOR year to that year's confirmed
-- cohort — an apples-to-full-basket-of-fruit comparison. v2.10 computes
-- both sides of every prior-year comparison over the EXACT SAME
-- confirmed cohort (pairwise cohort matching), and only pools a summary
-- median/average across years that share a common cohort (see
-- current_month_to_date_pace.summary_rule below).
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_shared_calendar_cohort_correction_v2_10()   -- NEW
--   public.build_analytics_snapshot_v2_10(int)                 -- NEW
--
-- ── SCOPE — SHARED CALENDAR COHORT CORRECTION ONLY ───────────────────────
-- Findings Selector, Pattern Discovery, Business Coach, forecasting,
-- charts, and every non-calendar section are untouched. This migration
-- ONLY replaces shared_calendar_seasonality_evidence.{monthly_timeline,
-- monthly_timeline_by_purpose, month_of_year_seasonality,
-- current_month_to_date_pace}. target_user_calendar_seasonality_evidence
-- is NOT recomputed here — v2.9's target-user logic already evaluates a
-- single user's own coverage in isolation, so the "one user vouches for
-- another" and "different populations" problems structurally cannot
-- occur in a one-user scope; it passes through from v2.9 unchanged (no
-- regression, per this task's explicit requirement). timezone, as_of_date,
-- purpose_population_summary, observation_coverage_summary, every
-- day_of_week_* array, and month_of_year_seasonality_by_purpose (still
-- explicitly out of scope, same as v2.9) are UNCHANGED and pass through
-- from v2.9 completely unchanged.
--
-- ── CORRECTED SHARED-SCOPE COHORT RULE ───────────────────────────────────
-- Per-user-per-period severity classification is unchanged from v2.9
-- (0 unknown_coverage, 1 pre_coverage, 2 partial, 3 fully_observed — the
-- current/future in-progress month is always capped at severity 2). What
-- changes is how the POOL's status and qualified-evidence set are derived
-- from those per-user severities:
--   coverage-qualified user  — severity = 3 (fully_observed) AND
--                               coverage_status = 'confirmed' specifically
--                               (an 'estimated' fully-observed user does
--                               NOT qualify — matches v2.9's existing
--                               'stronger'/MTD confirmed-only bar).
--   shared_coverage_status   — 'fully_observed' only when EVERY in-scope
--                               user is coverage-qualified for that period;
--                               'unknown_coverage' only when EVERY user is
--                               unknown; 'pre_coverage' only when EVERY
--                               user pre-dates coverage; 'partially_
--                               observed' when at least one (but not all)
--                               users are coverage-qualified; 'mixed_
--                               coverage' otherwise (no qualified witness,
--                               but statuses are not uniform either).
-- Recorded event totals ALWAYS come from every user regardless of
-- coverage (never hidden) — a separate, explicitly named coverage-
-- qualified total is computed ONLY from the coverage-qualified user set
-- for that period, and is NULL (not 0) when that set is empty, so a
-- missing-witness period is never misread as a confirmed zero.
--
-- ── MONTH-OF-YEAR: USER-YEAR OBSERVATION UNITS ───────────────────────────
-- v2.9's month-of-year confidence pooled a (month_number, year) cell
-- across users via BOOL_OR — one confirmed user's coverage made the
-- whole YEAR "fully observed" for the pooled row, again letting one user
-- vouch for another. v2.10 restructures the denominator as independent
-- (user, year, month_number) UNITS: a user-year-month is qualified only
-- when that SPECIFIC user has confirmed coverage for that specific
-- period. Confidence tiers reuse v2.9's exact thresholds, generalized
-- from "fully-observed confirmed YEARS" to "fully-observed confirmed
-- USER-YEARS" (documented per-family below), so 'stronger' still
-- requires confirmed-only coverage and balanced evidence, just measured
-- over the corrected unit.
--
-- ── MTD: PAIRWISE COHORT MATCHING ─────────────────────────────────────────
-- For each candidate prior year, users are classified against that
-- year's MTD window: 'included' (confirmed AND complete_history_start_
-- date <= that year's window_start), 'excluded_pre_coverage' (confirmed
-- but coverage starts after that window), or 'excluded_unknown_or_
-- estimated' (coverage_status IN ('unknown','estimated') regardless of
-- any date). The resulting cohort_user_ids is used to compute BOTH the
-- prior-year total AND the current-year total for that pair — never the
-- current year's full population. Because complete_history_start_date is
-- a single fixed date per user, cohort membership is MONOTONIC in year
-- (an earlier prior-year window is a strictly earlier date-cutoff than a
-- later one, so qualifying for an earlier year always implies qualifying
-- for every later one, including the current year) — this guarantees a
-- user confirmed for prior year Y is automatically confirmed for the
-- current year's own window too, so no separate "confirmed for current"
-- check is needed beyond the per-year cohort test itself.
--
-- A separate, clearly labeled full_population_current_month_to_date
-- object is retained for descriptive context only (per this task's
-- explicit allowance) — it is never used as a comparison side.
--
-- Because cohort membership is monotonic, the SET of users common to
-- every comparable prior year (the "common cohort") is always exactly
-- equal to the EARLIEST comparable year's own cohort (every later
-- comparable year's cohort is a superset of it). common_cohort_summary
-- uses this fact to compute one honest median/average: it recomputes
-- EVERY comparable year's prior total AND the current total using only
-- that common cohort (a valid, if sometimes narrower, subset of each
-- year's own cohort), so every value entering the summary reflects the
-- identical population. Individual pairwise_comparisons entries may
-- still use a larger, year-specific cohort — that is expected, not an
-- inconsistency, and is why the two are kept as separate fields rather
-- than one merged number.
-- ============================================================================


-- ============================================================================
-- PART 1: public._build_shared_calendar_cohort_correction_v2_10()
--
-- Shared-scope only — target-user evidence is not recomputed by this
-- migration (see header), so this helper takes no target-user argument.
-- Returns ONLY the corrected keys; the wrapper in Part 2 merges this on
-- top of v2.9's own shared_calendar_seasonality_evidence via jsonb `||`,
-- so every untouched v2.9 key (timezone, as_of_date, purpose_population_
-- summary, observation_coverage_summary, day_of_week_*, month_of_year_
-- seasonality_by_purpose(+_note)) passes through exactly as v2.9 produced
-- it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_shared_calendar_cohort_correction_v2_10()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH

-- ============================================================================
-- Base population and coverage rows (shared scope — every user who has
-- ever had an item). Same reliability rules as v2.8/v2.9 (unchanged).
-- ============================================================================
c10_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
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
c10_pop_earliest AS (
  SELECT LEAST(
    MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
    MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
    MIN(exit_date)        FILTER (WHERE exit_date_reliable)
  ) AS earliest_eligible_event_date
  FROM c10_base
),
c10_purposes AS ( SELECT DISTINCT group_purpose_id, group_purpose_name, purpose_policy_status FROM c10_base ),

-- ============================================================================
-- Section 1: monthly_timeline / monthly_timeline_by_purpose
-- ============================================================================
c10_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM c10_pop_earliest)),
    date_trunc('month', (SELECT as_of_date FROM c10_as_of)),
    interval '1 month'
  )::date AS month_start
),
-- Per (month_start, user) severity (0 unknown_coverage, 1 pre_coverage,
-- 2 partial, 3 fully_observed) — identical predicate to v2.9. The
-- current, still-in-progress America/Toronto month is always capped at
-- severity 2.
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
-- A user is coverage-QUALIFIED for a month only at severity 3 AND
-- coverage_status = 'confirmed' — an 'estimated' fully-observed user
-- lands in partial_coverage_user_count instead (real activity data
-- exists, but not confirmed reliable enough to certify a genuine zero;
-- same evidentiary bar v2.9 already used for 'stronger'/MTD).
c10_month_cohort AS (
  SELECT month_start,
    COUNT(*)::int AS total_shared_user_count,
    COUNT(*) FILTER (WHERE severity = 3 AND coverage_status = 'confirmed')::int AS fully_observed_confirmed_user_count,
    COUNT(*) FILTER (WHERE severity = 1)::int AS pre_coverage_user_count,
    COUNT(*) FILTER (WHERE severity = 0)::int AS unknown_coverage_user_count,
    COUNT(*) FILTER (WHERE severity = 2 OR (severity = 3 AND coverage_status <> 'confirmed'))::int AS partial_coverage_user_count,
    COALESCE(ARRAY_AGG(user_id) FILTER (WHERE severity = 3 AND coverage_status = 'confirmed'), ARRAY[]::int[]) AS qualified_user_ids
  FROM c10_month_user_status
  GROUP BY month_start
),
c10_month_status AS (
  SELECT month_start, total_shared_user_count, fully_observed_confirmed_user_count, partial_coverage_user_count,
    pre_coverage_user_count, unknown_coverage_user_count,
    fully_observed_confirmed_user_count AS coverage_qualified_user_count,
    qualified_user_ids,
    CASE
      WHEN fully_observed_confirmed_user_count = total_shared_user_count THEN 'fully_observed'
      WHEN unknown_coverage_user_count = total_shared_user_count THEN 'unknown_coverage'
      WHEN pre_coverage_user_count = total_shared_user_count THEN 'pre_coverage'
      WHEN fully_observed_confirmed_user_count > 0 THEN 'partially_observed'
      ELSE 'mixed_coverage'
    END AS shared_coverage_status
  FROM c10_month_cohort
),
c10_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c10_base WHERE acq_date_reliable GROUP BY 1
),
c10_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM c10_base WHERE listing_date_reliable GROUP BY 1
),
c10_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c10_base WHERE exit_date_reliable GROUP BY 1
),
c10_monthly_rows AS (
  SELECT
    ms.month_start, ms.shared_coverage_status,
    ms.total_shared_user_count, ms.fully_observed_confirmed_user_count, ms.partial_coverage_user_count,
    ms.pre_coverage_user_count, ms.unknown_coverage_user_count, ms.coverage_qualified_user_count,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      (SELECT COUNT(*) FROM c10_base b WHERE b.acq_date_reliable AND date_trunc('month', b.acquisition_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids))
    END AS coverage_qualified_acquisition_item_count,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      COALESCE((SELECT SUM(b.acquisition_value) FROM c10_base b WHERE b.acq_date_reliable AND date_trunc('month', b.acquisition_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.acquisition_value IS NOT NULL), 0)
    END AS coverage_qualified_acquisition_value_sum,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      (SELECT COUNT(*) FROM c10_base b WHERE b.listing_date_reliable AND date_trunc('month', b.first_listed_at)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids))
    END AS coverage_qualified_first_listing_item_count,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      (SELECT COUNT(*) FROM c10_base b WHERE b.exit_date_reliable AND date_trunc('month', b.exit_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids))
    END AS coverage_qualified_realized_exit_item_count,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      COALESCE((SELECT SUM(b.exit_value) FROM c10_base b WHERE b.exit_date_reliable AND date_trunc('month', b.exit_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids)), 0)
    END AS coverage_qualified_realized_exit_value_sum,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      COALESCE((SELECT SUM(b.net_profit) FROM c10_base b WHERE b.exit_date_reliable AND date_trunc('month', b.exit_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids)), 0)
    END AS coverage_qualified_realized_net_profit_sum
  FROM c10_month_status ms
  LEFT JOIN c10_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN c10_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN c10_monthly_exit e ON e.month_start = ms.month_start
),
c10_monthly_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c10_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
c10_monthly_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM c10_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
c10_monthly_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', exit_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c10_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
c10_monthly_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    ms.month_start, ms.shared_coverage_status,
    ms.total_shared_user_count, ms.fully_observed_confirmed_user_count, ms.partial_coverage_user_count,
    ms.pre_coverage_user_count, ms.unknown_coverage_user_count, ms.coverage_qualified_user_count,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      (SELECT COUNT(*) FROM c10_base b WHERE b.acq_date_reliable AND date_trunc('month', b.acquisition_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND b.purpose_policy_status = p.purpose_policy_status)
    END AS coverage_qualified_acquisition_item_count,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      COALESCE((SELECT SUM(b.acquisition_value) FROM c10_base b WHERE b.acq_date_reliable AND date_trunc('month', b.acquisition_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.acquisition_value IS NOT NULL AND b.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND b.purpose_policy_status = p.purpose_policy_status), 0)
    END AS coverage_qualified_acquisition_value_sum,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      (SELECT COUNT(*) FROM c10_base b WHERE b.listing_date_reliable AND date_trunc('month', b.first_listed_at)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND b.purpose_policy_status = p.purpose_policy_status)
    END AS coverage_qualified_first_listing_item_count,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      (SELECT COUNT(*) FROM c10_base b WHERE b.exit_date_reliable AND date_trunc('month', b.exit_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND b.purpose_policy_status = p.purpose_policy_status)
    END AS coverage_qualified_realized_exit_item_count,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      COALESCE((SELECT SUM(b.exit_value) FROM c10_base b WHERE b.exit_date_reliable AND date_trunc('month', b.exit_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND b.purpose_policy_status = p.purpose_policy_status), 0)
    END AS coverage_qualified_realized_exit_value_sum,
    CASE WHEN ms.coverage_qualified_user_count = 0 THEN NULL ELSE
      COALESCE((SELECT SUM(b.net_profit) FROM c10_base b WHERE b.exit_date_reliable AND date_trunc('month', b.exit_date)::date = ms.month_start AND b.user_id = ANY(ms.qualified_user_ids) AND b.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND b.purpose_policy_status = p.purpose_policy_status), 0)
    END AS coverage_qualified_realized_net_profit_sum
  FROM c10_purposes p
  CROSS JOIN c10_month_status ms
  LEFT JOIN c10_monthly_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_start = ms.month_start
  LEFT JOIN c10_monthly_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_start = ms.month_start
  LEFT JOIN c10_monthly_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_start = ms.month_start
),

-- ============================================================================
-- Section 2: month_of_year_seasonality — user-year-month observation units.
-- A (user, year, month_number) cell is QUALIFIED only when that specific
-- user has CONFIRMED coverage fully observing that specific period — one
-- user's coverage never qualifies another user's cell.
-- ============================================================================
c10_month_numbers AS ( SELECT generate_series(1, 12) AS month_number ),
c10_year_bounds AS (
  SELECT
    LEAST(
      COALESCE((SELECT MIN(EXTRACT(YEAR FROM complete_history_start_date))::int FROM c10_user_coverage WHERE complete_history_start_date IS NOT NULL), (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c10_as_of)),
      COALESCE((SELECT EXTRACT(YEAR FROM earliest_eligible_event_date)::int FROM c10_pop_earliest), (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c10_as_of))
    ) AS min_year,
    (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c10_as_of) AS max_year
),
c10_candidate_years AS ( SELECT generate_series(b.min_year, b.max_year) AS year FROM c10_year_bounds b ),
c10_moy_user_year_grid AS (
  SELECT uc.user_id, cy.year, mn.month_number, uc.coverage_status,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 'unknown_coverage'
      WHEN make_date(cy.year, mn.month_number, 1) >= date_trunc('month', (SELECT as_of_date FROM c10_as_of))::date THEN 'partial'
      WHEN uc.complete_history_start_date <= make_date(cy.year, mn.month_number, 1) THEN 'fully_observed'
      WHEN uc.complete_history_start_date < (make_date(cy.year, mn.month_number, 1) + interval '1 month') THEN 'partial'
      ELSE 'pre_coverage'
    END AS period_status
  FROM c10_user_coverage uc
  CROSS JOIN c10_candidate_years cy
  CROSS JOIN c10_month_numbers mn
),
c10_moy_user_year AS (
  SELECT user_id, year, month_number, coverage_status, period_status,
    (period_status = 'fully_observed' AND coverage_status = 'confirmed') AS is_qualified_user_year
  FROM c10_moy_user_year_grid
),
c10_moy_acq_user_year AS (
  SELECT user_id, EXTRACT(MONTH FROM acquisition_date)::int AS month_number, EXTRACT(YEAR FROM acquisition_date)::int AS year,
    COUNT(*) AS event_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c10_base WHERE acq_date_reliable GROUP BY 1, 2, 3
),
c10_moy_listing_user_year AS (
  SELECT user_id, EXTRACT(MONTH FROM first_listed_at)::int AS month_number, EXTRACT(YEAR FROM first_listed_at)::int AS year, COUNT(*) AS event_count
  FROM c10_base WHERE listing_date_reliable GROUP BY 1, 2, 3
),
c10_moy_exit_user_year AS (
  SELECT user_id, EXTRACT(MONTH FROM exit_date)::int AS month_number, EXTRACT(YEAR FROM exit_date)::int AS year,
    COUNT(*) AS event_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c10_base WHERE exit_date_reliable GROUP BY 1, 2, 3
),
-- Non-year-grouped exit medians (DOM/holding/profit) — a reliability
-- concept (Historical Import / lifecycle-date-issue), not a period-
-- coverage concept, identical methodology to v2.8/v2.9. Recomputed here
-- since this function rebuilds the whole month_of_year_seasonality array.
c10_moy_exit_medians AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM c10_base WHERE exit_date_reliable GROUP BY 1
),
c10_moy_acq_full AS (
  SELECT g.user_id, g.year, g.month_number, g.is_qualified_user_year,
    COALESCE(a.event_count, 0) AS event_count, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum
  FROM c10_moy_user_year g
  LEFT JOIN c10_moy_acq_user_year a ON a.user_id = g.user_id AND a.year = g.year AND a.month_number = g.month_number
),
c10_moy_listing_full AS (
  SELECT g.user_id, g.year, g.month_number, g.is_qualified_user_year, COALESCE(l.event_count, 0) AS event_count
  FROM c10_moy_user_year g
  LEFT JOIN c10_moy_listing_user_year l ON l.user_id = g.user_id AND l.year = g.year AND l.month_number = g.month_number
),
c10_moy_exit_full AS (
  SELECT g.user_id, g.year, g.month_number, g.is_qualified_user_year,
    COALESCE(e.event_count, 0) AS event_count, COALESCE(e.exit_value_sum, 0) AS exit_value_sum, COALESCE(e.net_profit_sum, 0) AS net_profit_sum
  FROM c10_moy_user_year g
  LEFT JOIN c10_moy_exit_user_year e ON e.user_id = g.user_id AND e.year = g.year AND e.month_number = g.month_number
),
c10_moy_acq_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS recorded_event_count,
    SUM(acquisition_value_sum) AS recorded_acquisition_value_sum,
    COALESCE(SUM(event_count) FILTER (WHERE is_qualified_user_year), 0)::int AS coverage_qualified_event_count,
    SUM(acquisition_value_sum) FILTER (WHERE is_qualified_user_year) AS coverage_qualified_acquisition_value_sum,
    COUNT(*) FILTER (WHERE is_qualified_user_year) AS fully_observed_user_year_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year AND event_count > 0) AS active_fully_observed_user_year_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year AND event_count = 0) AS zero_activity_fully_observed_user_year_count,
    COUNT(DISTINCT user_id) FILTER (WHERE is_qualified_user_year) AS confirmed_covered_user_count,
    ROUND((MAX(event_count) FILTER (WHERE is_qualified_user_year))::numeric / NULLIF(SUM(event_count) FILTER (WHERE is_qualified_user_year), 0), 4) AS largest_user_year_event_share
  FROM c10_moy_acq_full GROUP BY month_number
),
c10_moy_listing_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS recorded_event_count,
    COALESCE(SUM(event_count) FILTER (WHERE is_qualified_user_year), 0)::int AS coverage_qualified_event_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year) AS fully_observed_user_year_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year AND event_count > 0) AS active_fully_observed_user_year_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year AND event_count = 0) AS zero_activity_fully_observed_user_year_count,
    COUNT(DISTINCT user_id) FILTER (WHERE is_qualified_user_year) AS confirmed_covered_user_count,
    ROUND((MAX(event_count) FILTER (WHERE is_qualified_user_year))::numeric / NULLIF(SUM(event_count) FILTER (WHERE is_qualified_user_year), 0), 4) AS largest_user_year_event_share
  FROM c10_moy_listing_full GROUP BY month_number
),
c10_moy_exit_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS recorded_event_count,
    SUM(exit_value_sum) AS recorded_exit_value_sum, SUM(net_profit_sum) AS recorded_net_profit_sum,
    COALESCE(SUM(event_count) FILTER (WHERE is_qualified_user_year), 0)::int AS coverage_qualified_event_count,
    SUM(exit_value_sum) FILTER (WHERE is_qualified_user_year) AS coverage_qualified_exit_value_sum,
    SUM(net_profit_sum) FILTER (WHERE is_qualified_user_year) AS coverage_qualified_net_profit_sum,
    COUNT(*) FILTER (WHERE is_qualified_user_year) AS fully_observed_user_year_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year AND event_count > 0) AS active_fully_observed_user_year_count,
    COUNT(*) FILTER (WHERE is_qualified_user_year AND event_count = 0) AS zero_activity_fully_observed_user_year_count,
    COUNT(DISTINCT user_id) FILTER (WHERE is_qualified_user_year) AS confirmed_covered_user_count,
    ROUND((MAX(event_count) FILTER (WHERE is_qualified_user_year))::numeric / NULLIF(SUM(event_count) FILTER (WHERE is_qualified_user_year), 0), 4) AS largest_user_year_event_share
  FROM c10_moy_exit_full GROUP BY month_number
),
-- Combine into one row per month_number, applying the confidence ladder
-- documented in this function's header (same thresholds as v2.9,
-- generalized from fully-observed-confirmed YEARS to fully-observed-
-- confirmed USER-YEARS): <=1 insufficient_years, >=2 low/moderate,
-- >=3 (+balanced evidence) stronger.
c10_moy_rows AS (
  SELECT mn.month_number, TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth')) AS month_name,

    COALESCE(a.recorded_event_count, 0) AS acquisition_recorded_event_count,
    COALESCE(a.recorded_acquisition_value_sum, 0) AS recorded_acquisition_value_sum,
    COALESCE(a.coverage_qualified_event_count, 0) AS acquisition_coverage_qualified_event_count,
    a.coverage_qualified_acquisition_value_sum AS coverage_qualified_acquisition_value_sum,
    COALESCE(a.fully_observed_user_year_count, 0) AS acquisition_fully_observed_user_year_count,
    COALESCE(a.active_fully_observed_user_year_count, 0) AS acquisition_active_fully_observed_user_year_count,
    COALESCE(a.zero_activity_fully_observed_user_year_count, 0) AS acquisition_zero_activity_fully_observed_user_year_count,
    COALESCE(a.confirmed_covered_user_count, 0) AS acquisition_confirmed_covered_user_count,
    a.largest_user_year_event_share AS acquisition_largest_user_year_event_share,
    CASE
      WHEN COALESCE(a.recorded_event_count, 0) = 0 AND COALESCE(a.fully_observed_user_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(a.fully_observed_user_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN a.fully_observed_user_year_count < 2 THEN 'insufficient_years'
      WHEN a.fully_observed_user_year_count >= 3 AND a.coverage_qualified_event_count >= 10 AND a.active_fully_observed_user_year_count >= 2 AND a.largest_user_year_event_share <= 0.60 THEN 'stronger'
      WHEN a.fully_observed_user_year_count >= 2 AND a.coverage_qualified_event_count >= 6 AND a.largest_user_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS acquisition_confidence,
    COALESCE((SELECT jsonb_agg(x) FROM unnest(ARRAY[
        CASE WHEN COALESCE(a.fully_observed_user_year_count, 0) = 0 THEN 'NO_QUALIFIED_COVERAGE' END,
        CASE WHEN a.largest_user_year_event_share > 0.60 THEN 'SINGLE_USER_YEAR_DOMINATES' END,
        CASE WHEN COALESCE(a.confirmed_covered_user_count, 0) = 1 THEN 'ONLY_ONE_CONFIRMED_USER_CONTRIBUTES' END
      ]) AS x WHERE x IS NOT NULL), '[]'::jsonb) AS acquisition_limitations,

    COALESCE(l.recorded_event_count, 0) AS first_listing_recorded_event_count,
    COALESCE(l.coverage_qualified_event_count, 0) AS first_listing_coverage_qualified_event_count,
    COALESCE(l.fully_observed_user_year_count, 0) AS first_listing_fully_observed_user_year_count,
    COALESCE(l.active_fully_observed_user_year_count, 0) AS first_listing_active_fully_observed_user_year_count,
    COALESCE(l.zero_activity_fully_observed_user_year_count, 0) AS first_listing_zero_activity_fully_observed_user_year_count,
    COALESCE(l.confirmed_covered_user_count, 0) AS first_listing_confirmed_covered_user_count,
    l.largest_user_year_event_share AS first_listing_largest_user_year_event_share,
    CASE
      WHEN COALESCE(l.recorded_event_count, 0) = 0 AND COALESCE(l.fully_observed_user_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(l.fully_observed_user_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN l.fully_observed_user_year_count < 2 THEN 'insufficient_years'
      WHEN l.fully_observed_user_year_count >= 3 AND l.coverage_qualified_event_count >= 10 AND l.active_fully_observed_user_year_count >= 2 AND l.largest_user_year_event_share <= 0.60 THEN 'stronger'
      WHEN l.fully_observed_user_year_count >= 2 AND l.coverage_qualified_event_count >= 6 AND l.largest_user_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS first_listing_confidence,
    COALESCE((SELECT jsonb_agg(x) FROM unnest(ARRAY[
        CASE WHEN COALESCE(l.fully_observed_user_year_count, 0) = 0 THEN 'NO_QUALIFIED_COVERAGE' END,
        CASE WHEN l.largest_user_year_event_share > 0.60 THEN 'SINGLE_USER_YEAR_DOMINATES' END,
        CASE WHEN COALESCE(l.confirmed_covered_user_count, 0) = 1 THEN 'ONLY_ONE_CONFIRMED_USER_CONTRIBUTES' END
      ]) AS x WHERE x IS NOT NULL), '[]'::jsonb) AS first_listing_limitations,

    COALESCE(e.recorded_event_count, 0) AS realized_exit_recorded_event_count,
    COALESCE(e.recorded_exit_value_sum, 0) AS recorded_realized_exit_value_sum,
    COALESCE(e.recorded_net_profit_sum, 0) AS recorded_realized_net_profit_sum,
    COALESCE(e.coverage_qualified_event_count, 0) AS realized_exit_coverage_qualified_event_count,
    e.coverage_qualified_exit_value_sum AS coverage_qualified_realized_exit_value_sum,
    e.coverage_qualified_net_profit_sum AS coverage_qualified_realized_net_profit_sum,
    COALESCE(e.fully_observed_user_year_count, 0) AS realized_exit_fully_observed_user_year_count,
    COALESCE(e.active_fully_observed_user_year_count, 0) AS realized_exit_active_fully_observed_user_year_count,
    COALESCE(e.zero_activity_fully_observed_user_year_count, 0) AS realized_exit_zero_activity_fully_observed_user_year_count,
    COALESCE(e.confirmed_covered_user_count, 0) AS realized_exit_confirmed_covered_user_count,
    e.largest_user_year_event_share AS realized_exit_largest_user_year_event_share,
    em.median_net_profit, COALESCE(em.dom_sample_size, 0) AS dom_sample_size, em.median_days_on_market,
    COALESCE(em.holding_sample_size, 0) AS holding_sample_size, em.median_holding_days,
    CASE
      WHEN COALESCE(e.recorded_event_count, 0) = 0 AND COALESCE(e.fully_observed_user_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(e.fully_observed_user_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN e.fully_observed_user_year_count < 2 THEN 'insufficient_years'
      WHEN e.fully_observed_user_year_count >= 3 AND e.coverage_qualified_event_count >= 10 AND e.active_fully_observed_user_year_count >= 2 AND e.largest_user_year_event_share <= 0.60 THEN 'stronger'
      WHEN e.fully_observed_user_year_count >= 2 AND e.coverage_qualified_event_count >= 6 AND e.largest_user_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS realized_exit_confidence,
    COALESCE((SELECT jsonb_agg(x) FROM unnest(ARRAY[
        CASE WHEN COALESCE(e.fully_observed_user_year_count, 0) = 0 THEN 'NO_QUALIFIED_COVERAGE' END,
        CASE WHEN e.largest_user_year_event_share > 0.60 THEN 'SINGLE_USER_YEAR_DOMINATES' END,
        CASE WHEN COALESCE(e.confirmed_covered_user_count, 0) = 1 THEN 'ONLY_ONE_CONFIRMED_USER_CONTRIBUTES' END
      ]) AS x WHERE x IS NOT NULL), '[]'::jsonb) AS realized_exit_limitations
  FROM c10_month_numbers mn
  LEFT JOIN c10_moy_acq_rows a ON a.month_number = mn.month_number
  LEFT JOIN c10_moy_listing_rows l ON l.month_number = mn.month_number
  LEFT JOIN c10_moy_exit_rows e ON e.month_number = mn.month_number
  LEFT JOIN c10_moy_exit_medians em ON em.month_number = mn.month_number
),

-- ============================================================================
-- Section 3: current_month_to_date_pace — pairwise cohort matching.
-- ============================================================================
c10_mtd_params AS (
  SELECT a.tz, a.as_of_date, EXTRACT(YEAR FROM a.as_of_date)::int AS current_year, EXTRACT(MONTH FROM a.as_of_date)::int AS current_month, EXTRACT(DAY FROM a.as_of_date)::int AS current_day_of_month,
    (SELECT earliest_eligible_event_date FROM c10_pop_earliest) AS earliest_eligible_event_date
  FROM c10_as_of a
),
c10_mtd_current_window AS (
  SELECT date_trunc('month', mp.as_of_date)::date AS window_start, mp.as_of_date AS window_end
  FROM c10_mtd_params mp
),
c10_mtd_candidate_years AS ( SELECT y AS year FROM c10_mtd_params mp, generate_series(EXTRACT(YEAR FROM mp.earliest_eligible_event_date)::int, mp.current_year - 1) AS y ),
c10_mtd_windows AS (
  SELECT cy.year, make_date(cy.year, mp.current_month, 1) AS window_start,
    LEAST(mp.current_day_of_month, EXTRACT(DAY FROM (make_date(cy.year, mp.current_month, 1) + interval '1 month - 1 day'))::int) AS day_cutoff_used
  FROM c10_mtd_candidate_years cy, c10_mtd_params mp
),
c10_mtd_windows2 AS ( SELECT year, window_start, day_cutoff_used, make_date(year, EXTRACT(MONTH FROM window_start)::int, day_cutoff_used) AS window_end FROM c10_mtd_windows ),
-- Per candidate year, classify every in-scope user against THAT year's
-- MTD window. 'included' requires confirmed coverage starting on/before
-- that window — the same users are then used for BOTH the prior-year AND
-- the current-year side of the pair (see header note on monotonicity).
c10_mtd_user_classification AS (
  SELECT w.year, w.window_start, w.window_end, w.day_cutoff_used, uc.user_id, uc.coverage_status, uc.complete_history_start_date,
    CASE
      WHEN uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start THEN 'included'
      WHEN uc.coverage_status = 'confirmed' AND uc.complete_history_start_date > w.window_start THEN 'excluded_pre_coverage'
      ELSE 'excluded_unknown_or_estimated'
    END AS classification
  FROM c10_mtd_windows2 w
  CROSS JOIN c10_user_coverage uc
),
c10_mtd_cohort AS (
  SELECT year, window_start, window_end, day_cutoff_used,
    COALESCE(ARRAY_AGG(user_id) FILTER (WHERE classification = 'included'), ARRAY[]::int[]) AS cohort_user_ids,
    COUNT(*) FILTER (WHERE classification = 'included')::int AS cohort_user_count,
    COUNT(*) FILTER (WHERE classification = 'excluded_pre_coverage')::int AS excluded_pre_coverage_user_count,
    COUNT(*) FILTER (WHERE classification = 'excluded_unknown_or_estimated')::int AS excluded_unknown_or_estimated_user_count
  FROM c10_mtd_user_classification
  GROUP BY year, window_start, window_end, day_cutoff_used
),
c10_mtd_pairs AS (
  SELECT c.year, c.window_start AS prior_window_start, c.window_end AS prior_window_end, c.day_cutoff_used,
    c.cohort_user_ids, c.cohort_user_count, c.excluded_pre_coverage_user_count, c.excluded_unknown_or_estimated_user_count,
    (c.cohort_user_count > 0) AS is_comparable,

    COALESCE((SELECT COUNT(*) FROM c10_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN c.window_start AND c.window_end), 0) AS prior_acquisition_item_count,
    COALESCE((SELECT SUM(b.acquisition_value) FROM c10_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN c.window_start AND c.window_end AND b.acquisition_value IS NOT NULL), 0) AS prior_acquisition_value_sum,
    COALESCE((SELECT COUNT(*) FROM c10_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.listing_date_reliable AND b.first_listed_at BETWEEN c.window_start AND c.window_end), 0) AS prior_first_listing_item_count,
    COALESCE((SELECT COUNT(*) FROM c10_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS prior_realized_exit_item_count,
    COALESCE((SELECT SUM(b.exit_value) FROM c10_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS prior_realized_exit_value_sum,
    COALESCE((SELECT SUM(b.net_profit) FROM c10_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS prior_realized_net_profit_sum,

    COALESCE((SELECT COUNT(*) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN cw.window_start AND cw.window_end), 0) AS current_acquisition_item_count,
    COALESCE((SELECT SUM(b.acquisition_value) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN cw.window_start AND cw.window_end AND b.acquisition_value IS NOT NULL), 0) AS current_acquisition_value_sum,
    COALESCE((SELECT COUNT(*) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id = ANY(c.cohort_user_ids) AND b.listing_date_reliable AND b.first_listed_at BETWEEN cw.window_start AND cw.window_end), 0) AS current_first_listing_item_count,
    COALESCE((SELECT COUNT(*) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS current_realized_exit_item_count,
    COALESCE((SELECT SUM(b.exit_value) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS current_realized_exit_value_sum,
    COALESCE((SELECT SUM(b.net_profit) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS current_realized_net_profit_sum
  FROM c10_mtd_cohort c
),
-- Descriptive-only, full-population current MTD (never a comparison side).
c10_mtd_full_population_current AS (
  SELECT
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN cw.window_start AND cw.window_end) AS acquisition_item_count,
    COALESCE(SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN cw.window_start AND cw.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN cw.window_start AND cw.window_end) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end) AS realized_exit_item_count,
    COALESCE(SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS realized_exit_value_sum,
    COALESCE(SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS realized_net_profit_sum
  FROM c10_base b, c10_mtd_current_window cw
),
c10_mtd_comparable_summary AS (
  SELECT
    COUNT(*)::int AS candidate_prior_years_count,
    COUNT(*) FILTER (WHERE is_comparable)::int AS comparable_prior_years_count,
    BOOL_OR(cohort_user_count > 0 OR excluded_pre_coverage_user_count > 0) AS any_known_coverage_exists,
    MIN(year) FILTER (WHERE is_comparable) AS earliest_comparable_year
  FROM c10_mtd_pairs
),
-- The common cohort shared by every comparable year is, by monotonicity
-- (see header), exactly the EARLIEST comparable year's own cohort.
c10_mtd_common_cohort_ids AS (
  SELECT p.cohort_user_ids, p.cohort_user_count
  FROM c10_mtd_pairs p, c10_mtd_comparable_summary s
  WHERE p.year = s.earliest_comparable_year
),
-- Recompute EVERY comparable year's prior total using ONLY the common
-- cohort (a valid subset of that year's own, possibly larger, cohort),
-- so every value entering the summary reflects one identical population.
c10_mtd_common_recompute AS (
  SELECT p.year, p.prior_window_start AS window_start, p.prior_window_end AS window_end,
    COALESCE((SELECT COUNT(*) FROM c10_base b WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN p.prior_window_start AND p.prior_window_end), 0) AS acquisition_item_count,
    COALESCE((SELECT SUM(b.acquisition_value) FROM c10_base b WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN p.prior_window_start AND p.prior_window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COALESCE((SELECT COUNT(*) FROM c10_base b WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.listing_date_reliable AND b.first_listed_at BETWEEN p.prior_window_start AND p.prior_window_end), 0) AS first_listing_item_count,
    COALESCE((SELECT COUNT(*) FROM c10_base b WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN p.prior_window_start AND p.prior_window_end), 0) AS realized_exit_item_count,
    COALESCE((SELECT SUM(b.exit_value) FROM c10_base b WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN p.prior_window_start AND p.prior_window_end), 0) AS realized_exit_value_sum,
    COALESCE((SELECT SUM(b.net_profit) FROM c10_base b WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN p.prior_window_start AND p.prior_window_end), 0) AS realized_net_profit_sum
  FROM c10_mtd_pairs p
  WHERE p.is_comparable AND COALESCE((SELECT cohort_user_count FROM c10_mtd_common_cohort_ids), 0) > 0
),
c10_mtd_common_current AS (
  SELECT
    COALESCE((SELECT COUNT(*) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN cw.window_start AND cw.window_end), 0) AS acquisition_item_count,
    COALESCE((SELECT SUM(b.acquisition_value) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN cw.window_start AND cw.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COALESCE((SELECT COUNT(*) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.listing_date_reliable AND b.first_listed_at BETWEEN cw.window_start AND cw.window_end), 0) AS first_listing_item_count,
    COALESCE((SELECT COUNT(*) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS realized_exit_item_count,
    COALESCE((SELECT SUM(b.exit_value) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS realized_exit_value_sum,
    COALESCE((SELECT SUM(b.net_profit) FROM c10_base b, c10_mtd_current_window cw WHERE b.user_id IN (SELECT unnest(cohort_user_ids) FROM c10_mtd_common_cohort_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN cw.window_start AND cw.window_end), 0) AS realized_net_profit_sum
),
c10_mtd_common_summary_stats AS (
  SELECT
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_item_count)::numeric, 2) AS median_acquisition_item_count,
    ROUND(AVG(acquisition_item_count)::numeric, 2) AS average_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value_sum)::numeric, 2) AS median_acquisition_value_sum,
    ROUND(AVG(acquisition_value_sum)::numeric, 2) AS average_acquisition_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_listing_item_count)::numeric, 2) AS median_first_listing_item_count,
    ROUND(AVG(first_listing_item_count)::numeric, 2) AS average_first_listing_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_item_count)::numeric, 2) AS median_realized_exit_item_count,
    ROUND(AVG(realized_exit_item_count)::numeric, 2) AS average_realized_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_value_sum)::numeric, 2) AS median_realized_exit_value_sum,
    ROUND(AVG(realized_exit_value_sum)::numeric, 2) AS average_realized_exit_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_net_profit_sum)::numeric, 2) AS median_realized_net_profit_sum,
    ROUND(AVG(realized_net_profit_sum)::numeric, 2) AS average_realized_net_profit_sum,
    COUNT(*)::int AS years_used_in_summary
  FROM c10_mtd_common_recompute
),
c10_mtd_object AS (
  SELECT jsonb_build_object(
    'timezone', mp.tz, 'as_of_date', mp.as_of_date, 'current_year', mp.current_year, 'current_month', mp.current_month, 'current_day_of_month', mp.current_day_of_month,

    'full_population_current_month_to_date', jsonb_build_object(
      'acquisition_item_count', fp.acquisition_item_count, 'acquisition_value_sum', fp.acquisition_value_sum,
      'first_listing_item_count', fp.first_listing_item_count,
      'realized_exit_item_count', fp.realized_exit_item_count, 'realized_exit_value_sum', fp.realized_exit_value_sum, 'realized_net_profit_sum', fp.realized_net_profit_sum
    ),
    'full_population_note', 'Descriptive only — pools every user regardless of coverage. Never a comparison side; see pairwise_comparisons for cohort-matched current-vs-prior figures.',

    'candidate_prior_years_count', COALESCE(sm.candidate_prior_years_count, 0),
    'comparable_prior_years_count', COALESCE(sm.comparable_prior_years_count, 0),

    'pairwise_comparisons', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'year', pr.year, 'day_cutoff_used', pr.day_cutoff_used,
        'prior_window_start', pr.prior_window_start, 'prior_window_end', pr.prior_window_end,
        'cohort_user_count', pr.cohort_user_count,
        'excluded_pre_coverage_user_count', pr.excluded_pre_coverage_user_count,
        'excluded_unknown_or_estimated_user_count', pr.excluded_unknown_or_estimated_user_count,
        'current_cohort_metrics', jsonb_build_object('acquisition_item_count', pr.current_acquisition_item_count, 'acquisition_value_sum', pr.current_acquisition_value_sum, 'first_listing_item_count', pr.current_first_listing_item_count, 'realized_exit_item_count', pr.current_realized_exit_item_count, 'realized_exit_value_sum', pr.current_realized_exit_value_sum, 'realized_net_profit_sum', pr.current_realized_net_profit_sum),
        'prior_cohort_metrics', jsonb_build_object('acquisition_item_count', pr.prior_acquisition_item_count, 'acquisition_value_sum', pr.prior_acquisition_value_sum, 'first_listing_item_count', pr.prior_first_listing_item_count, 'realized_exit_item_count', pr.prior_realized_exit_item_count, 'realized_exit_value_sum', pr.prior_realized_exit_value_sum, 'realized_net_profit_sum', pr.prior_realized_net_profit_sum),
        'pairwise_difference', jsonb_build_object(
          'acquisition_item_count', pr.current_acquisition_item_count - pr.prior_acquisition_item_count,
          'acquisition_value_sum', pr.current_acquisition_value_sum - pr.prior_acquisition_value_sum,
          'first_listing_item_count', pr.current_first_listing_item_count - pr.prior_first_listing_item_count,
          'realized_exit_item_count', pr.current_realized_exit_item_count - pr.prior_realized_exit_item_count,
          'realized_exit_value_sum', pr.current_realized_exit_value_sum - pr.prior_realized_exit_value_sum,
          'realized_net_profit_sum', pr.current_realized_net_profit_sum - pr.prior_realized_net_profit_sum
        )
      ) ORDER BY pr.year), '[]'::jsonb) FROM c10_mtd_pairs pr WHERE pr.is_comparable),

    'excluded_prior_years', (SELECT COALESCE(jsonb_agg(jsonb_build_object('year', pr.year, 'reason', CASE WHEN pr.excluded_pre_coverage_user_count > 0 THEN 'excluded_pre_coverage' ELSE 'excluded_unknown_coverage' END) ORDER BY pr.year), '[]'::jsonb) FROM c10_mtd_pairs pr WHERE NOT pr.is_comparable),

    'common_cohort_summary', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 OR COALESCE((SELECT cohort_user_count FROM c10_mtd_common_cohort_ids), 0) = 0 THEN NULL ELSE
      jsonb_build_object(
        'common_cohort_user_count', (SELECT cohort_user_count FROM c10_mtd_common_cohort_ids),
        'years_used_in_summary', COALESCE(cs.years_used_in_summary, 0),
        'current_common_cohort_metrics', jsonb_build_object('acquisition_item_count', cc.acquisition_item_count, 'acquisition_value_sum', cc.acquisition_value_sum, 'first_listing_item_count', cc.first_listing_item_count, 'realized_exit_item_count', cc.realized_exit_item_count, 'realized_exit_value_sum', cc.realized_exit_value_sum, 'realized_net_profit_sum', cc.realized_net_profit_sum),
        'prior_year_median', jsonb_build_object('acquisition_item_count', cs.median_acquisition_item_count, 'acquisition_value_sum', cs.median_acquisition_value_sum, 'first_listing_item_count', cs.median_first_listing_item_count, 'realized_exit_item_count', cs.median_realized_exit_item_count, 'realized_exit_value_sum', cs.median_realized_exit_value_sum, 'realized_net_profit_sum', cs.median_realized_net_profit_sum),
        'prior_year_average', jsonb_build_object('acquisition_item_count', cs.average_acquisition_item_count, 'acquisition_value_sum', cs.average_acquisition_value_sum, 'first_listing_item_count', cs.average_first_listing_item_count, 'realized_exit_item_count', cs.average_realized_exit_item_count, 'realized_exit_value_sum', cs.average_realized_exit_value_sum, 'realized_net_profit_sum', cs.average_realized_net_profit_sum),
        'difference_vs_prior_median', jsonb_build_object(
          'acquisition_item_count', cc.acquisition_item_count - cs.median_acquisition_item_count,
          'acquisition_value_sum', cc.acquisition_value_sum - cs.median_acquisition_value_sum,
          'first_listing_item_count', cc.first_listing_item_count - cs.median_first_listing_item_count,
          'realized_exit_item_count', cc.realized_exit_item_count - cs.median_realized_exit_item_count,
          'realized_exit_value_sum', cc.realized_exit_value_sum - cs.median_realized_exit_value_sum,
          'realized_net_profit_sum', cc.realized_net_profit_sum - cs.median_realized_net_profit_sum
        )
      )
    END,
    'summary_rule', 'Prior-year median/average is computed only over the confirmed cohort common to every comparable prior year. Because cohort membership is monotonic in a user''s complete_history_start_date (an earlier start date qualifies a user for every later comparable year too), this common cohort equals the earliest comparable year''s own cohort. Individual pairwise_comparisons entries may use a larger, year-specific cohort than common_cohort_summary when a later year qualifies additional users — this is expected, not an inconsistency.',

    'status', CASE
      WHEN COALESCE(sm.comparable_prior_years_count, 0) >= 2 THEN 'sufficient_history'
      WHEN NOT COALESCE(sm.any_known_coverage_exists, false) THEN 'coverage_unknown'
      ELSE 'insufficient_history'
    END,
    'note', 'Descriptive month-to-date comparison only. Not a forecast for the completed current month. Every pairwise comparison uses the SAME confirmed-coverage cohort on both the current-year and prior-year side; the full-population current total above is retained for descriptive context only, never as a comparison side.'
  ) AS payload
  FROM c10_mtd_params mp, c10_mtd_full_population_current fp, c10_mtd_comparable_summary sm, c10_mtd_common_current cc, c10_mtd_common_summary_stats cs
)

SELECT jsonb_build_object(
  'shared_calendar_seasonality_evidence', jsonb_build_object(
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(c10_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM c10_monthly_rows),
    'monthly_timeline_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(c10_monthly_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_start), '[]'::jsonb) FROM c10_monthly_purpose_rows),
    'month_of_year_seasonality', (SELECT COALESCE(jsonb_agg(to_jsonb(c10_moy_rows) ORDER BY month_number), '[]'::jsonb) FROM c10_moy_rows),
    'current_month_to_date_pace', (SELECT payload FROM c10_mtd_object),
    'cohort_correction_methodology_note', 'v2.10: a shared month/user-year is fully_observed / coverage-qualified only when EVERY user counted in that metric has CONFIRMED coverage for the period — one confirmed user no longer vouches for another (see analytics/SEMANTIC_CONTRACT.md section 33). MTD prior-year comparisons use a per-year confirmed cohort applied identically to BOTH the current-year and prior-year side (see current_month_to_date_pace.summary_rule for the multi-year summary rule).'
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_shared_calendar_cohort_correction_v2_10() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_shared_calendar_cohort_correction_v2_10() FROM anon;
REVOKE ALL ON FUNCTION public._build_shared_calendar_cohort_correction_v2_10() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_shared_calendar_cohort_correction_v2_10() TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_10(p_target_user_id int)
--
-- Calls build_analytics_snapshot_v2_9 WHOLESALE, then MERGES the shared
-- cohort correction on top of v2.9's OWN shared_calendar_seasonality_
-- evidence object via jsonb `||` (same key names as v2.9, per this
-- task's preference to keep downstream consumers automatically on
-- corrected evidence) — superseding only monthly_timeline(_by_purpose),
-- month_of_year_seasonality, and current_month_to_date_pace.
-- target_user_calendar_seasonality_evidence and every other v2.9 section
-- (evidence_aggregates-equivalent purpose/acquisition/segmentation/
-- channel/capital-liquidity/open-inventory sections) are NOT recomputed
-- and pass through completely unchanged — see this file's header for why
-- target-user calendar logic needs no correction here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_10(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v29          jsonb;
  v_generated_at timestamptz := now();
  v_correction   jsonb;
BEGIN
  v_v29 := public.build_analytics_snapshot_v2_9(p_target_user_id);
  v_correction := public._build_shared_calendar_cohort_correction_v2_10();

  RETURN v_v29
    || jsonb_build_object(
         'snapshot_schema_version', '2.10',
         'analytics_definition_version', '2.10',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_calendar_seasonality_evidence',
           (v_v29 -> 'shared_calendar_seasonality_evidence') || (v_correction -> 'shared_calendar_seasonality_evidence')
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_10(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_10(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_10(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_10(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_10(int) IS
  'Analytics v2.10 — Shared Calendar Cohort Correction — the current '
  'PRODUCTION analytics snapshot version. SECURITY INVOKER, service_role '
  'execution only. Calls build_analytics_snapshot_v2_9 wholesale and '
  'MERGES a shared-scope cohort correction on top of its '
  'shared_calendar_seasonality_evidence object (same key names): a '
  'shared period is fully_observed / coverage-qualified only when EVERY '
  'user counted in that metric has CONFIRMED coverage — one user no '
  'longer vouches for another (Problem 1); current_month_to_date_pace '
  'now compares the SAME confirmed cohort on both the current-year and '
  'prior-year side of every pairwise comparison (Problem 2), with a '
  'clearly documented common-cohort rule for the multi-year summary. '
  'target_user_calendar_seasonality_evidence and every non-calendar '
  'section pass through from v2.9 unchanged — this is a narrow, focused '
  'correction, not a new module. v1.0-v1.8 and v2.0-v2.9 are completely '
  'unaffected. Persists nothing — see analytics_runs (20260727000000) '
  'for the persistence step. See analytics/README.md and analytics/'
  'SEMANTIC_CONTRACT.md section 33 for the full v2.10 contract.';
