-- build_analytics_snapshot_v2_9
--
-- Analytics v2.9 — Calendar Observation Coverage & Confidence Correction.
-- A focused correction to v2.8 Calendar & Seasonality: v2.8 computed
-- calendar confidence as if a calendar year's mere EXISTENCE proved the
-- whole year had been observed. It had not — this migration adds an
-- explicit, per-user "when did complete tracking begin" record and uses
-- it to distinguish a genuinely observed zero from a month before
-- tracking began, a partial first month, or unknown coverage.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public.analytics_observation_coverage (TABLE)             -- NEW
--   public._build_calendar_coverage_correction_v2_9(int)      -- NEW
--   public.build_analytics_snapshot_v2_9(int)                 -- NEW
--
-- ── SCOPE — CALENDAR CORRECTION ONLY ─────────────────────────────────────
-- Findings Selector, Pattern Discovery, Business Coach, forecasting,
-- recommendations, charts, and every non-calendar v2.8 section are
-- untouched. This migration ONLY corrects shared_calendar_seasonality_
-- evidence / target_user_calendar_seasonality_evidence.
--
-- ── PART 1: OBSERVATION COVERAGE STORAGE ─────────────────────────────────
-- No existing field in this schema records "inventory tracking is known
-- complete for this user from date X onward" (confirmed by repository-
-- wide search: app_users has no such column, no migration/import script
-- defines one, and Historical Import's acquisition_date is an ITEM-level
-- provenance flag, not a user-level completeness marker). This table is
-- therefore a genuinely new concept, not a duplicate of existing work.
--
-- complete_history_start_date is NEVER defaulted from the earliest
-- acquisition/listing/exit/record-creation date — that would smuggle
-- back in exactly the "existence proves observation" bug this migration
-- fixes. The table starts EMPTY (every user defaults to coverage_status
-- 'unknown' via LEFT JOIN + COALESCE downstream) until a human explicitly
-- configures a row after confirming the date some other way (see the
-- configuration SQL template in this file's final comment block).
--
-- coverage_status:
--   'confirmed'  — the operator has verified this date against an
--                  external record (e.g. a known "I started using this
--                  app on X" fact). Required for MTD comparability
--                  (section 5/6) and for the 'stronger' seasonality tier.
--   'estimated'  — a best-guess date, good enough to avoid treating
--                  pre-tracking gaps as confirmed zeros in monthly_
--                  timeline / month-of-year seasonality, but NOT trusted
--                  enough for month-to-date year-over-year comparison or
--                  the top seasonality confidence tier.
--   'unknown'    — no reliable date exists. complete_history_start_date
--                  MUST be NULL in this state (enforced by CHECK).
--
-- ── SECURITY ──────────────────────────────────────────────────────────────
-- No settings UI exists for this table in this task. Ordinary
-- authenticated users get NO grant at all (not even SELECT) — this
-- matches analytics_runs' least-privilege pattern
-- (20260729000000_analytics_runs_grant_hardening.sql) rather than
-- analytics_purpose_policy's authenticated-SELECT-all model, since this
-- is per-user operational metadata a user should never read or write
-- directly, not shared reference data. service_role only, both layers
-- (explicit REVOKE + RLS with no policies, since this project's ambient
-- default privileges grant anon/authenticated full table privileges on
-- any newly created table regardless of GRANTs — see the analytics_
-- purpose_policy and analytics_runs migrations for the same note).
-- ============================================================================

CREATE TABLE public.analytics_observation_coverage (
  user_id                      bigint      PRIMARY KEY REFERENCES public.app_users(id),
  complete_history_start_date  date,
  coverage_status              text        NOT NULL DEFAULT 'unknown',
  notes                        text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_observation_coverage_status_check
    CHECK (coverage_status IN ('confirmed', 'estimated', 'unknown')),
  CONSTRAINT analytics_observation_coverage_date_matches_status
    CHECK (
      (coverage_status = 'unknown' AND complete_history_start_date IS NULL)
      OR (coverage_status IN ('confirmed', 'estimated') AND complete_history_start_date IS NOT NULL)
    )
);

CREATE TRIGGER analytics_observation_coverage_set_updated_at
  BEFORE UPDATE ON public.analytics_observation_coverage
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.analytics_observation_coverage IS
  'One row per app_users.id (rows are OPTIONAL — an absent row means '
  '''unknown'' coverage, never a default earliest-event date). Records the '
  'date from which a user''s inventory activity tracking is known '
  'COMPLETE, for Analytics v2.9''s calendar-coverage-aware confidence '
  'corrections. Never populated automatically from event dates. '
  'service_role-managed only — see analytics/SEMANTIC_CONTRACT.md section '
  '32 and the configuration SQL template at the end of this migration '
  'file for how to set a row after confirming the date out-of-band.';

ALTER TABLE public.analytics_observation_coverage ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON public.analytics_observation_coverage FROM anon;
REVOKE ALL PRIVILEGES ON public.analytics_observation_coverage FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_observation_coverage TO service_role;
-- No RLS policy is created for anon/authenticated — RLS is enabled with
-- zero policies, so both roles are denied by default in addition to the
-- explicit REVOKE above (defense in depth, matching this project's
-- documented ambient-default-privilege gotcha).


-- ============================================================================
-- PART 2: public._build_calendar_coverage_correction_v2_9(p_target_user_id int)
--
-- Computes ONLY the corrected/added calendar keys — population_summary,
-- purpose_population_summary, day_of_week_*, timezone, and as_of_date are
-- UNCHANGED from v2.8 and are not recomputed here; the builder in Part 3
-- merges this function's output on top of v2.8's calendar evidence
-- objects via jsonb `||`, so those untouched keys pass through exactly as
-- v2.8 produced them (same event totals, same Historical Import
-- behavior).
--
-- ── CORE COVERAGE PREDICATE (reused everywhere in this function) ────────
-- For a user's coverage row and a reference calendar month (month_start =
-- first day of that month):
--   'unknown_coverage' — coverage_status = 'unknown' or no row at all.
--   'fully_observed'   — complete_history_start_date <= month_start (the
--                        WHOLE month is on/after the day tracking began).
--   'partial'          — complete_history_start_date falls strictly
--                        inside this month (after day 1, before the
--                        following month's day 1).
--   'pre_coverage'     — complete_history_start_date falls in some LATER
--                        month (this month entirely precedes coverage).
-- The CURRENT, still-in-progress America/Toronto calendar month — and, in
-- the month-of-year coverage-year grid, any FUTURE month within the
-- current year (month_number > current_month) — is ALWAYS capped at
-- 'partial' (never 'fully_observed'), regardless of how early coverage
-- began. Neither has finished yet, so its zero/nonzero status cannot yet
-- be treated as a completed observation. This applies in both monthly_
-- timeline (whose gap-filled series never extends past the current
-- month anyway) and the month-of-year coverage-year grid (which spans
-- all 12 month numbers for the current year, including ones still ahead).
--
-- ── SHARED-SCOPE COHORT RULE (deliberate, documented design choice) ─────
-- Shared evidence pools users with different coverage-start dates. This
-- module does NOT require unanimous coverage across every user who has
-- ever had an item before trusting a period (that would make one late-
-- onboarded user permanently poison every earlier calendar month for the
-- whole pool, forever). Instead, for monthly_timeline and month_of_year_
-- seasonality, a period is treated as having AT LEAST one covering
-- witness (fully_observed) whenever ANY in-scope user's own coverage
-- fully observes it — real event totals always come from ALL users
-- regardless (never hidden), and a period is only called a "genuine
-- observed zero" when a covering witness exists AND the TOTAL event count
-- across everyone is actually zero. When no user fully observes a period,
-- the label falls back to the most favorable status any user in the pool
-- supports (partial > pre_coverage > unknown_coverage), so 'unknown_
-- coverage' is reported only when EVERY in-scope user is unknown for
-- that period.
-- For current_month_to_date_pace specifically (section 5/6 of the task),
-- a STRICTER, PER-PRIOR-YEAR cohort rule applies instead: a prior year is
-- "comparable" only when the SAME set of users can vouch for it with
-- coverage_status = 'confirmed' specifically (not 'estimated' — MTD is
-- the highest-stakes comparison in this module, per the task's explicit
-- "confirmed complete-history coverage" wording), and that year's event
-- totals are summed ONLY over that year's comparable cohort — never the
-- full population. The CURRENT month-to-date totals are always computed
-- over the full current population (present-day tracking activity is
-- real regardless of any user's past coverage gaps); only PAST comparison
-- years are cohort-restricted. This intentional asymmetry (current =
-- full population, prior years = per-year cohort) is documented here and
-- in analytics/SEMANTIC_CONTRACT.md section 32 rather than silently
-- assumed.
--
-- ── MONTH-OF-YEAR CONFIDENCE THRESHOLDS (documented, consistent with the
-- existing repo-wide item-count confidence convention: <=2 insufficient,
-- <=5 low, <=9 moderate, >=10 stronger) ───────────────────────────────────
--   no_data           — zero eligible events AND zero fully-observed years.
--   coverage_unknown  — events exist, but no year is fully observed by
--                       any in-scope user (coverage genuinely can't
--                       support a conclusion either way).
--   insufficient_years — fewer than 2 fully-observed years.
--   low                — >=2 fully-observed years, but total_event_count
--                       <= 5 OR the single largest year contributes more
--                       than 80% of all events (one-year domination caps
--                       confidence even with a large total).
--   moderate           — >=2 fully-observed years, total_event_count >= 6,
--                       largest-year share <= 80%.
--   stronger           — ALL of: >=3 fully-observed years using ONLY
--                       'confirmed' coverage (an 'estimated'-only year
--                       never counts toward this tier — a material
--                       coverage limitation caps confidence at
--                       'moderate'), total_event_count >= 10, >=2 active
--                       years (years with >=1 real event), largest-year
--                       share <= 60%.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_calendar_coverage_correction_v2_9(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH

-- ============================================================================
-- Base population (identical reliability rules to v2.8 — unchanged)
-- ============================================================================
c9_base AS (
  SELECT
    *,
    (acquisition_date IS NOT NULL AND NOT is_historical_import AND NOT has_lifecycle_date_issue) AS acq_date_reliable,
    (first_listed_at IS NOT NULL AND NOT has_lifecycle_date_issue)                                 AS listing_date_reliable,
    (is_realized AND exit_date IS NOT NULL AND NOT has_lifecycle_date_issue)                       AS exit_date_reliable,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
c9t_base AS ( SELECT * FROM c9_base WHERE user_id = p_target_user_id ),

c9_as_of AS (
  SELECT 'America/Toronto'::text AS tz, (now() AT TIME ZONE 'America/Toronto')::date AS as_of_date
),

-- ── Coverage rows: EVERY user who has ever had an item (shared scope) /
-- the target user alone (target scope), LEFT JOINed to the coverage
-- table — an absent row (or coverage_status = 'unknown') always yields
-- 'unknown_coverage', never a fabricated date. ───────────────────────────
c9s_scope_users AS ( SELECT DISTINCT user_id FROM c9_base ),
c9t_scope_users AS ( SELECT p_target_user_id AS user_id ),
c9s_user_coverage AS (
  SELECT su.user_id, COALESCE(aoc.coverage_status, 'unknown') AS coverage_status, aoc.complete_history_start_date
  FROM c9s_scope_users su
  LEFT JOIN public.analytics_observation_coverage aoc ON aoc.user_id = su.user_id
),
c9t_user_coverage AS (
  SELECT su.user_id, COALESCE(aoc.coverage_status, 'unknown') AS coverage_status, aoc.complete_history_start_date
  FROM c9t_scope_users su
  LEFT JOIN public.analytics_observation_coverage aoc ON aoc.user_id = su.user_id
),

-- ============================================================================
-- observation_coverage_summary (both scopes) — classifies each in-scope
-- user's status AS OF THE CURRENT America/Toronto month.
-- ============================================================================
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
c9t_coverage_summary AS (
  SELECT jsonb_build_object(
    'fully_observed_user_count',   COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date <= date_trunc('month', a.as_of_date)::date),
    'partial_coverage_user_count', COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date > date_trunc('month', a.as_of_date)::date AND uc.complete_history_start_date < (date_trunc('month', a.as_of_date)::date + interval '1 month')),
    'pre_coverage_user_count',     COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND uc.complete_history_start_date >= (date_trunc('month', a.as_of_date)::date + interval '1 month')),
    'unknown_coverage_user_count', COUNT(*) FILTER (WHERE uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL),
    'total_user_count',            COUNT(*)
  ) AS payload
  FROM c9t_user_coverage uc, c9_as_of a
),

-- ============================================================================
-- Section 3: monthly_timeline / monthly_timeline_by_purpose — same event
-- gap-fill range as v2.8, plus a per-row coverage_status label.
-- ============================================================================
c9s_pop_earliest AS (
  SELECT LEAST(
    MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
    MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
    MIN(exit_date)        FILTER (WHERE exit_date_reliable)
  ) AS earliest_eligible_event_date
  FROM c9_base
),
c9t_pop_earliest AS (
  SELECT LEAST(
    MIN(acquisition_date) FILTER (WHERE acq_date_reliable),
    MIN(first_listed_at)  FILTER (WHERE listing_date_reliable),
    MIN(exit_date)        FILTER (WHERE exit_date_reliable)
  ) AS earliest_eligible_event_date
  FROM c9t_base
),
c9s_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM c9s_pop_earliest)),
    date_trunc('month', (SELECT as_of_date FROM c9_as_of)),
    interval '1 month'
  )::date AS month_start
),
c9t_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM c9t_pop_earliest)),
    date_trunc('month', (SELECT as_of_date FROM c9_as_of)),
    interval '1 month'
  )::date AS month_start
),
c9_purposes AS ( SELECT DISTINCT group_purpose_id, group_purpose_name, purpose_policy_status FROM c9_base ),
c9t_purposes AS ( SELECT DISTINCT group_purpose_id, group_purpose_name, purpose_policy_status FROM c9t_base ),

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
-- Per (month_start, user) coverage classification, severity-ranked
-- (0 unknown_coverage, 1 pre_coverage, 2 partial, 3 fully_observed) so
-- the pool's most-favorable-supported label can be taken via MAX().
c9s_month_user_status AS (
  SELECT ms.month_start, uc.user_id,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 0
      -- The current, still-in-progress America/Toronto month can never be
      -- 'fully_observed' — it has not finished yet, regardless of how
      -- early coverage began. Capped at 'partial' (severity 2).
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
),
c9s_monthly_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c9_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
c9s_monthly_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM c9_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
c9s_monthly_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', exit_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c9_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
c9s_monthly_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    ms.month_start, mc.coverage_status,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM c9_purposes p
  CROSS JOIN c9s_month_series ms
  JOIN c9s_month_coverage mc ON mc.month_start = ms.month_start
  LEFT JOIN c9s_monthly_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_start = ms.month_start
  LEFT JOIN c9s_monthly_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_start = ms.month_start
  LEFT JOIN c9s_monthly_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_start = ms.month_start
),

ct_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c9t_base WHERE acq_date_reliable GROUP BY 1
),
ct_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM c9t_base WHERE listing_date_reliable GROUP BY 1
),
ct_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start, COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c9t_base WHERE exit_date_reliable GROUP BY 1
),
c9t_month_coverage AS (
  SELECT ms.month_start,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 'unknown_coverage'
      WHEN ms.month_start = date_trunc('month', (SELECT as_of_date FROM c9_as_of))::date THEN 'partial'
      WHEN uc.complete_history_start_date <= ms.month_start THEN 'fully_observed'
      WHEN uc.complete_history_start_date < (ms.month_start + interval '1 month') THEN 'partial'
      ELSE 'pre_coverage'
    END AS coverage_status
  FROM c9t_month_series ms, c9t_user_coverage uc
),
ct_monthly_rows AS (
  SELECT ms.month_start, mc.coverage_status,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM c9t_month_series ms
  JOIN c9t_month_coverage mc ON mc.month_start = ms.month_start
  LEFT JOIN ct_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN ct_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN ct_monthly_exit e ON e.month_start = ms.month_start
),
ct_monthly_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT acquisition_deal_id) AS deal_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c9t_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
ct_monthly_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM c9t_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
ct_monthly_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, date_trunc('month', exit_date)::date AS month_start,
    COUNT(*) AS item_count, COUNT(DISTINCT exit_deal_id) AS deal_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c9t_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
ct_monthly_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    ms.month_start, mc.coverage_status,
    COALESCE(a.item_count, 0) AS reliable_acquisition_item_count, COALESCE(a.deal_count, 0) AS reliable_acquisition_deal_count, COALESCE(a.acquisition_value_sum, 0) AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0) AS first_listing_item_count,
    COALESCE(e.item_count, 0) AS realized_exit_item_count, COALESCE(e.deal_count, 0) AS realized_exit_deal_count, COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum
  FROM c9t_purposes p
  CROSS JOIN c9t_month_series ms
  JOIN c9t_month_coverage mc ON mc.month_start = ms.month_start
  LEFT JOIN ct_monthly_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_start = ms.month_start
  LEFT JOIN ct_monthly_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_start = ms.month_start
  LEFT JOIN ct_monthly_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_start = ms.month_start
),

-- ============================================================================
-- Section 4: month_of_year_seasonality / *_by_purpose — coverage-year
-- grid (user x candidate-year x month-number), independent of events, so
-- a genuinely-zero-but-fully-observed year is counted even with no event
-- row at all.
-- ============================================================================
c9_month_numbers AS ( SELECT generate_series(1, 12) AS month_number ),
c9s_year_bounds AS (
  SELECT
    LEAST(
      COALESCE((SELECT MIN(EXTRACT(YEAR FROM complete_history_start_date))::int FROM c9s_user_coverage WHERE complete_history_start_date IS NOT NULL), (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c9_as_of)),
      COALESCE((SELECT EXTRACT(YEAR FROM earliest_eligible_event_date)::int FROM c9s_pop_earliest), (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c9_as_of))
    ) AS min_year,
    (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c9_as_of) AS max_year
),
c9t_year_bounds AS (
  SELECT
    LEAST(
      COALESCE((SELECT MIN(EXTRACT(YEAR FROM complete_history_start_date))::int FROM c9t_user_coverage WHERE complete_history_start_date IS NOT NULL), (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c9_as_of)),
      COALESCE((SELECT EXTRACT(YEAR FROM earliest_eligible_event_date)::int FROM c9t_pop_earliest), (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c9_as_of))
    ) AS min_year,
    (SELECT EXTRACT(YEAR FROM as_of_date)::int FROM c9_as_of) AS max_year
),
c9s_candidate_years AS ( SELECT generate_series(b.min_year, b.max_year) AS year FROM c9s_year_bounds b ),
c9t_candidate_years AS ( SELECT generate_series(b.min_year, b.max_year) AS year FROM c9t_year_bounds b ),

c9s_coverage_grid AS (
  SELECT uc.user_id, cy.year, mn.month_number, uc.coverage_status,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 'unknown_coverage'
      -- The current, still-in-progress month AND any future month within
      -- the current year can never be 'fully_observed' for seasonality
      -- purposes — neither has finished yet, regardless of how early
      -- coverage began.
      WHEN make_date(cy.year, mn.month_number, 1) >= date_trunc('month', (SELECT as_of_date FROM c9_as_of))::date THEN 'partial'
      WHEN uc.complete_history_start_date <= make_date(cy.year, mn.month_number, 1) THEN 'fully_observed'
      WHEN uc.complete_history_start_date < (make_date(cy.year, mn.month_number, 1) + interval '1 month') THEN 'partial'
      ELSE 'pre_coverage'
    END AS period_status
  FROM c9s_user_coverage uc
  CROSS JOIN c9s_candidate_years cy
  CROSS JOIN c9_month_numbers mn
),
c9s_moy_year_summary AS (
  SELECT month_number, year,
    BOOL_OR(period_status = 'fully_observed') AS is_fully_observed_year,
    BOOL_OR(period_status = 'fully_observed' AND coverage_status = 'confirmed') AS is_fully_observed_confirmed_year
  FROM c9s_coverage_grid
  GROUP BY month_number, year
),
c9t_coverage_grid AS (
  SELECT uc.user_id, cy.year, mn.month_number, uc.coverage_status,
    CASE
      WHEN uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL THEN 'unknown_coverage'
      WHEN make_date(cy.year, mn.month_number, 1) >= date_trunc('month', (SELECT as_of_date FROM c9_as_of))::date THEN 'partial'
      WHEN uc.complete_history_start_date <= make_date(cy.year, mn.month_number, 1) THEN 'fully_observed'
      WHEN uc.complete_history_start_date < (make_date(cy.year, mn.month_number, 1) + interval '1 month') THEN 'partial'
      ELSE 'pre_coverage'
    END AS period_status
  FROM c9t_user_coverage uc
  CROSS JOIN c9t_candidate_years cy
  CROSS JOIN c9_month_numbers mn
),
c9t_moy_year_summary AS (
  SELECT month_number, year,
    BOOL_OR(period_status = 'fully_observed') AS is_fully_observed_year,
    BOOL_OR(period_status = 'fully_observed' AND coverage_status = 'confirmed') AS is_fully_observed_confirmed_year
  FROM c9t_coverage_grid
  GROUP BY month_number, year
),

-- Per (month_number, year) event data, joined onto the coverage-year grid
-- (LEFT JOIN from the grid so a zero-event fully-observed year still
-- appears).
c9s_moy_acq_year AS (
  SELECT EXTRACT(MONTH FROM acquisition_date)::int AS month_number, EXTRACT(YEAR FROM acquisition_date)::int AS year, COUNT(*) AS event_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c9_base WHERE acq_date_reliable GROUP BY 1, 2
),
c9s_moy_listing_year AS (
  SELECT EXTRACT(MONTH FROM first_listed_at)::int AS month_number, EXTRACT(YEAR FROM first_listed_at)::int AS year, COUNT(*) AS event_count
  FROM c9_base WHERE listing_date_reliable GROUP BY 1, 2
),
c9s_moy_exit_year AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number, EXTRACT(YEAR FROM exit_date)::int AS year, COUNT(*) AS event_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c9_base WHERE exit_date_reliable GROUP BY 1, 2
),
-- Non-year-grouped exit stats (median DOM/holding/profit) — identical to
-- v2.8, unaffected by coverage (a reliability concept, not a period-
-- coverage concept).
c9s_moy_exit_medians AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM c9_base WHERE exit_date_reliable GROUP BY 1
),
c9s_moy_acq_full AS (
  SELECT c.month_number, c.year, c.is_fully_observed_year, c.is_fully_observed_confirmed_year, COALESCE(a.event_count, 0) AS event_count, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum
  FROM c9s_moy_year_summary c LEFT JOIN c9s_moy_acq_year a ON a.month_number = c.month_number AND a.year = c.year
),
c9s_moy_listing_full AS (
  SELECT c.month_number, c.year, c.is_fully_observed_year, c.is_fully_observed_confirmed_year, COALESCE(l.event_count, 0) AS event_count
  FROM c9s_moy_year_summary c LEFT JOIN c9s_moy_listing_year l ON l.month_number = c.month_number AND l.year = c.year
),
c9s_moy_exit_full AS (
  SELECT c.month_number, c.year, c.is_fully_observed_year, c.is_fully_observed_confirmed_year, COALESCE(e.event_count, 0) AS event_count, COALESCE(e.exit_value_sum, 0) AS exit_value_sum, COALESCE(e.net_profit_sum, 0) AS net_profit_sum
  FROM c9s_moy_year_summary c LEFT JOIN c9s_moy_exit_year e ON e.month_number = c.month_number AND e.year = c.year
),
c9s_moy_acq_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS total_event_count,
    COUNT(*) FILTER (WHERE event_count > 0) AS active_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year) AS fully_observed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_confirmed_year) AS fully_observed_confirmed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year AND event_count = 0) AS zero_activity_fully_observed_year_count,
    ROUND((MAX(event_count)::numeric / NULLIF(SUM(event_count), 0)), 4) AS largest_year_event_share,
    SUM(acquisition_value_sum) AS acquisition_value_sum
  FROM c9s_moy_acq_full GROUP BY month_number
),
c9s_moy_listing_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS total_event_count,
    COUNT(*) FILTER (WHERE event_count > 0) AS active_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year) AS fully_observed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_confirmed_year) AS fully_observed_confirmed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year AND event_count = 0) AS zero_activity_fully_observed_year_count,
    ROUND((MAX(event_count)::numeric / NULLIF(SUM(event_count), 0)), 4) AS largest_year_event_share
  FROM c9s_moy_listing_full GROUP BY month_number
),
c9s_moy_exit_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS total_event_count,
    COUNT(*) FILTER (WHERE event_count > 0) AS active_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year) AS fully_observed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_confirmed_year) AS fully_observed_confirmed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year AND event_count = 0) AS zero_activity_fully_observed_year_count,
    ROUND((MAX(event_count)::numeric / NULLIF(SUM(event_count), 0)), 4) AS largest_year_event_share,
    SUM(exit_value_sum) AS exit_value_sum, SUM(net_profit_sum) AS net_profit_sum
  FROM c9s_moy_exit_full GROUP BY month_number
),

ct_moy_acq_year AS (
  SELECT EXTRACT(MONTH FROM acquisition_date)::int AS month_number, EXTRACT(YEAR FROM acquisition_date)::int AS year, COUNT(*) AS event_count, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS acquisition_value_sum
  FROM c9t_base WHERE acq_date_reliable GROUP BY 1, 2
),
ct_moy_listing_year AS (
  SELECT EXTRACT(MONTH FROM first_listed_at)::int AS month_number, EXTRACT(YEAR FROM first_listed_at)::int AS year, COUNT(*) AS event_count
  FROM c9t_base WHERE listing_date_reliable GROUP BY 1, 2
),
ct_moy_exit_year AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number, EXTRACT(YEAR FROM exit_date)::int AS year, COUNT(*) AS event_count, SUM(exit_value) AS exit_value_sum, SUM(net_profit) AS net_profit_sum
  FROM c9t_base WHERE exit_date_reliable GROUP BY 1, 2
),
ct_moy_exit_medians AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM c9t_base WHERE exit_date_reliable GROUP BY 1
),
ct_moy_acq_full AS (
  SELECT c.month_number, c.year, c.is_fully_observed_year, c.is_fully_observed_confirmed_year, COALESCE(a.event_count, 0) AS event_count, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum
  FROM c9t_moy_year_summary c LEFT JOIN ct_moy_acq_year a ON a.month_number = c.month_number AND a.year = c.year
),
ct_moy_listing_full AS (
  SELECT c.month_number, c.year, c.is_fully_observed_year, c.is_fully_observed_confirmed_year, COALESCE(l.event_count, 0) AS event_count
  FROM c9t_moy_year_summary c LEFT JOIN ct_moy_listing_year l ON l.month_number = c.month_number AND l.year = c.year
),
ct_moy_exit_full AS (
  SELECT c.month_number, c.year, c.is_fully_observed_year, c.is_fully_observed_confirmed_year, COALESCE(e.event_count, 0) AS event_count, COALESCE(e.exit_value_sum, 0) AS exit_value_sum, COALESCE(e.net_profit_sum, 0) AS net_profit_sum
  FROM c9t_moy_year_summary c LEFT JOIN ct_moy_exit_year e ON e.month_number = c.month_number AND e.year = c.year
),
ct_moy_acq_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS total_event_count,
    COUNT(*) FILTER (WHERE event_count > 0) AS active_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year) AS fully_observed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_confirmed_year) AS fully_observed_confirmed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year AND event_count = 0) AS zero_activity_fully_observed_year_count,
    ROUND((MAX(event_count)::numeric / NULLIF(SUM(event_count), 0)), 4) AS largest_year_event_share,
    SUM(acquisition_value_sum) AS acquisition_value_sum
  FROM ct_moy_acq_full GROUP BY month_number
),
ct_moy_listing_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS total_event_count,
    COUNT(*) FILTER (WHERE event_count > 0) AS active_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year) AS fully_observed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_confirmed_year) AS fully_observed_confirmed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year AND event_count = 0) AS zero_activity_fully_observed_year_count,
    ROUND((MAX(event_count)::numeric / NULLIF(SUM(event_count), 0)), 4) AS largest_year_event_share
  FROM ct_moy_listing_full GROUP BY month_number
),
ct_moy_exit_rows AS (
  SELECT month_number,
    SUM(event_count)::int AS total_event_count,
    COUNT(*) FILTER (WHERE event_count > 0) AS active_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year) AS fully_observed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_confirmed_year) AS fully_observed_confirmed_year_count,
    COUNT(*) FILTER (WHERE is_fully_observed_year AND event_count = 0) AS zero_activity_fully_observed_year_count,
    ROUND((MAX(event_count)::numeric / NULLIF(SUM(event_count), 0)), 4) AS largest_year_event_share,
    SUM(exit_value_sum) AS exit_value_sum, SUM(net_profit_sum) AS net_profit_sum
  FROM ct_moy_exit_full GROUP BY month_number
),

-- ── Combine into one row per month_number (pooled), applying the
-- confidence ladder documented in this function's header. ───────────────
c9s_moy_rows AS (
  SELECT mn.month_number, TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth')) AS month_name,

    a.total_event_count AS acquisition_total_event_count, a.active_year_count AS acquisition_active_year_count,
    a.fully_observed_year_count AS acquisition_fully_observed_year_count, a.fully_observed_confirmed_year_count AS acquisition_fully_observed_confirmed_year_count,
    a.zero_activity_fully_observed_year_count AS acquisition_zero_activity_fully_observed_year_count,
    a.largest_year_event_share AS acquisition_largest_year_event_share, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum,
    CASE
      WHEN COALESCE(a.total_event_count, 0) = 0 AND COALESCE(a.fully_observed_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(a.fully_observed_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN a.fully_observed_year_count < 2 THEN 'insufficient_years'
      WHEN a.fully_observed_confirmed_year_count >= 3 AND a.total_event_count >= 10 AND a.active_year_count >= 2 AND a.largest_year_event_share <= 0.60 THEN 'stronger'
      WHEN a.fully_observed_year_count >= 2 AND a.total_event_count >= 6 AND a.largest_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS acquisition_confidence,

    l.total_event_count AS first_listing_total_event_count, l.active_year_count AS first_listing_active_year_count,
    l.fully_observed_year_count AS first_listing_fully_observed_year_count, l.fully_observed_confirmed_year_count AS first_listing_fully_observed_confirmed_year_count,
    l.zero_activity_fully_observed_year_count AS first_listing_zero_activity_fully_observed_year_count,
    l.largest_year_event_share AS first_listing_largest_year_event_share,
    CASE
      WHEN COALESCE(l.total_event_count, 0) = 0 AND COALESCE(l.fully_observed_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(l.fully_observed_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN l.fully_observed_year_count < 2 THEN 'insufficient_years'
      WHEN l.fully_observed_confirmed_year_count >= 3 AND l.total_event_count >= 10 AND l.active_year_count >= 2 AND l.largest_year_event_share <= 0.60 THEN 'stronger'
      WHEN l.fully_observed_year_count >= 2 AND l.total_event_count >= 6 AND l.largest_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS first_listing_confidence,

    e.total_event_count AS realized_exit_total_event_count, e.active_year_count AS realized_exit_active_year_count,
    e.fully_observed_year_count AS realized_exit_fully_observed_year_count, e.fully_observed_confirmed_year_count AS realized_exit_fully_observed_confirmed_year_count,
    e.zero_activity_fully_observed_year_count AS realized_exit_zero_activity_fully_observed_year_count,
    e.largest_year_event_share AS realized_exit_largest_year_event_share,
    COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum,
    em.median_net_profit, COALESCE(em.dom_sample_size, 0) AS dom_sample_size, em.median_days_on_market,
    COALESCE(em.holding_sample_size, 0) AS holding_sample_size, em.median_holding_days,
    CASE
      WHEN COALESCE(e.total_event_count, 0) = 0 AND COALESCE(e.fully_observed_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(e.fully_observed_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN e.fully_observed_year_count < 2 THEN 'insufficient_years'
      WHEN e.fully_observed_confirmed_year_count >= 3 AND e.total_event_count >= 10 AND e.active_year_count >= 2 AND e.largest_year_event_share <= 0.60 THEN 'stronger'
      WHEN e.fully_observed_year_count >= 2 AND e.total_event_count >= 6 AND e.largest_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS realized_exit_confidence
  FROM c9_month_numbers mn
  LEFT JOIN c9s_moy_acq_rows a ON a.month_number = mn.month_number
  LEFT JOIN c9s_moy_listing_rows l ON l.month_number = mn.month_number
  LEFT JOIN c9s_moy_exit_rows e ON e.month_number = mn.month_number
  LEFT JOIN c9s_moy_exit_medians em ON em.month_number = mn.month_number
),
ct_moy_rows AS (
  SELECT mn.month_number, TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth')) AS month_name,

    a.total_event_count AS acquisition_total_event_count, a.active_year_count AS acquisition_active_year_count,
    a.fully_observed_year_count AS acquisition_fully_observed_year_count, a.fully_observed_confirmed_year_count AS acquisition_fully_observed_confirmed_year_count,
    a.zero_activity_fully_observed_year_count AS acquisition_zero_activity_fully_observed_year_count,
    a.largest_year_event_share AS acquisition_largest_year_event_share, COALESCE(a.acquisition_value_sum, 0) AS acquisition_value_sum,
    CASE
      WHEN COALESCE(a.total_event_count, 0) = 0 AND COALESCE(a.fully_observed_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(a.fully_observed_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN a.fully_observed_year_count < 2 THEN 'insufficient_years'
      WHEN a.fully_observed_confirmed_year_count >= 3 AND a.total_event_count >= 10 AND a.active_year_count >= 2 AND a.largest_year_event_share <= 0.60 THEN 'stronger'
      WHEN a.fully_observed_year_count >= 2 AND a.total_event_count >= 6 AND a.largest_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS acquisition_confidence,

    l.total_event_count AS first_listing_total_event_count, l.active_year_count AS first_listing_active_year_count,
    l.fully_observed_year_count AS first_listing_fully_observed_year_count, l.fully_observed_confirmed_year_count AS first_listing_fully_observed_confirmed_year_count,
    l.zero_activity_fully_observed_year_count AS first_listing_zero_activity_fully_observed_year_count,
    l.largest_year_event_share AS first_listing_largest_year_event_share,
    CASE
      WHEN COALESCE(l.total_event_count, 0) = 0 AND COALESCE(l.fully_observed_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(l.fully_observed_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN l.fully_observed_year_count < 2 THEN 'insufficient_years'
      WHEN l.fully_observed_confirmed_year_count >= 3 AND l.total_event_count >= 10 AND l.active_year_count >= 2 AND l.largest_year_event_share <= 0.60 THEN 'stronger'
      WHEN l.fully_observed_year_count >= 2 AND l.total_event_count >= 6 AND l.largest_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS first_listing_confidence,

    e.total_event_count AS realized_exit_total_event_count, e.active_year_count AS realized_exit_active_year_count,
    e.fully_observed_year_count AS realized_exit_fully_observed_year_count, e.fully_observed_confirmed_year_count AS realized_exit_fully_observed_confirmed_year_count,
    e.zero_activity_fully_observed_year_count AS realized_exit_zero_activity_fully_observed_year_count,
    e.largest_year_event_share AS realized_exit_largest_year_event_share,
    COALESCE(e.exit_value_sum, 0) AS realized_exit_value_sum, COALESCE(e.net_profit_sum, 0) AS realized_net_profit_sum,
    em.median_net_profit, COALESCE(em.dom_sample_size, 0) AS dom_sample_size, em.median_days_on_market,
    COALESCE(em.holding_sample_size, 0) AS holding_sample_size, em.median_holding_days,
    CASE
      WHEN COALESCE(e.total_event_count, 0) = 0 AND COALESCE(e.fully_observed_year_count, 0) = 0 THEN 'no_data'
      WHEN COALESCE(e.fully_observed_year_count, 0) = 0 THEN 'coverage_unknown'
      WHEN e.fully_observed_year_count < 2 THEN 'insufficient_years'
      WHEN e.fully_observed_confirmed_year_count >= 3 AND e.total_event_count >= 10 AND e.active_year_count >= 2 AND e.largest_year_event_share <= 0.60 THEN 'stronger'
      WHEN e.fully_observed_year_count >= 2 AND e.total_event_count >= 6 AND e.largest_year_event_share <= 0.80 THEN 'moderate'
      ELSE 'low'
    END AS realized_exit_confidence
  FROM c9_month_numbers mn
  LEFT JOIN ct_moy_acq_rows a ON a.month_number = mn.month_number
  LEFT JOIN ct_moy_listing_rows l ON l.month_number = mn.month_number
  LEFT JOIN ct_moy_exit_rows e ON e.month_number = mn.month_number
  LEFT JOIN ct_moy_exit_medians em ON em.month_number = mn.month_number
),

-- ============================================================================
-- Section 5/6: current_month_to_date_pace — current totals over the FULL
-- population; each prior year restricted to that year's 'confirmed'-only
-- comparable cohort (see header note on the documented current/prior
-- asymmetry).
-- ============================================================================
c9s_mtd_params AS (
  SELECT a.tz, a.as_of_date, EXTRACT(YEAR FROM a.as_of_date)::int AS current_year, EXTRACT(MONTH FROM a.as_of_date)::int AS current_month, EXTRACT(DAY FROM a.as_of_date)::int AS current_day_of_month,
    (SELECT earliest_eligible_event_date FROM c9s_pop_earliest) AS earliest_eligible_event_date
  FROM c9_as_of a
),
c9t_mtd_params AS (
  SELECT a.tz, a.as_of_date, EXTRACT(YEAR FROM a.as_of_date)::int AS current_year, EXTRACT(MONTH FROM a.as_of_date)::int AS current_month, EXTRACT(DAY FROM a.as_of_date)::int AS current_day_of_month,
    (SELECT earliest_eligible_event_date FROM c9t_pop_earliest) AS earliest_eligible_event_date
  FROM c9_as_of a
),
c9s_mtd_current AS (
  SELECT
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS acquisition_item_count,
    COALESCE(SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_exit_item_count,
    COALESCE(SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date), 0) AS realized_exit_value_sum,
    COALESCE(SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date), 0) AS realized_net_profit_sum
  FROM c9_base b, c9s_mtd_params mp
),
c9t_mtd_current AS (
  SELECT
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS acquisition_item_count,
    COALESCE(SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_exit_item_count,
    COALESCE(SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date), 0) AS realized_exit_value_sum,
    COALESCE(SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date), 0) AS realized_net_profit_sum
  FROM c9t_base b, c9t_mtd_params mp
),
c9s_mtd_candidate_years AS ( SELECT y AS year FROM c9s_mtd_params mp, generate_series(EXTRACT(YEAR FROM mp.earliest_eligible_event_date)::int, mp.current_year - 1) AS y ),
c9t_mtd_candidate_years AS ( SELECT y AS year FROM c9t_mtd_params mp, generate_series(EXTRACT(YEAR FROM mp.earliest_eligible_event_date)::int, mp.current_year - 1) AS y ),

c9s_mtd_windows AS (
  SELECT cy.year, make_date(cy.year, mp.current_month, 1) AS window_start,
    LEAST(mp.current_day_of_month, EXTRACT(DAY FROM (make_date(cy.year, mp.current_month, 1) + interval '1 month - 1 day'))::int) AS day_cutoff_used
  FROM c9s_mtd_candidate_years cy, c9s_mtd_params mp
),
c9t_mtd_windows AS (
  SELECT cy.year, make_date(cy.year, mp.current_month, 1) AS window_start,
    LEAST(mp.current_day_of_month, EXTRACT(DAY FROM (make_date(cy.year, mp.current_month, 1) + interval '1 month - 1 day'))::int) AS day_cutoff_used
  FROM c9t_mtd_candidate_years cy, c9t_mtd_params mp
),
c9s_mtd_windows2 AS ( SELECT year, window_start, day_cutoff_used, make_date(year, EXTRACT(MONTH FROM window_start)::int, day_cutoff_used) AS window_end FROM c9s_mtd_windows ),
c9t_mtd_windows2 AS ( SELECT year, window_start, day_cutoff_used, make_date(year, EXTRACT(MONTH FROM window_start)::int, day_cutoff_used) AS window_end FROM c9t_mtd_windows ),

-- Confirmed-only cohort per candidate year (MTD requires the highest
-- evidentiary bar — 'estimated' coverage does not count here, matching
-- this task's explicit "confirmed complete-history coverage" wording).
c9s_mtd_cohort AS (
  SELECT w.year, w.window_start, w.window_end, w.day_cutoff_used,
    ARRAY_AGG(uc.user_id) FILTER (WHERE uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start) AS cohort_user_ids,
    COUNT(*) FILTER (WHERE uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start) AS comparable_user_count,
    COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND NOT (uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start)) AS known_but_excluded_user_count,
    COUNT(*) FILTER (WHERE uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL) AS unknown_user_count
  FROM c9s_mtd_windows2 w
  CROSS JOIN c9s_user_coverage uc
  GROUP BY w.year, w.window_start, w.window_end, w.day_cutoff_used
),
c9t_mtd_cohort AS (
  SELECT w.year, w.window_start, w.window_end, w.day_cutoff_used,
    ARRAY_AGG(uc.user_id) FILTER (WHERE uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start) AS cohort_user_ids,
    COUNT(*) FILTER (WHERE uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start) AS comparable_user_count,
    COUNT(*) FILTER (WHERE uc.complete_history_start_date IS NOT NULL AND NOT (uc.coverage_status = 'confirmed' AND uc.complete_history_start_date <= w.window_start)) AS known_but_excluded_user_count,
    COUNT(*) FILTER (WHERE uc.coverage_status = 'unknown' OR uc.complete_history_start_date IS NULL) AS unknown_user_count
  FROM c9t_mtd_windows2 w
  CROSS JOIN c9t_user_coverage uc
  GROUP BY w.year, w.window_start, w.window_end, w.day_cutoff_used
),
c9s_mtd_year_rows AS (
  SELECT c.year, c.window_start, c.window_end, c.day_cutoff_used, c.comparable_user_count, c.known_but_excluded_user_count, c.unknown_user_count,
    (c.comparable_user_count > 0) AS is_comparable,
    CASE WHEN c.comparable_user_count > 0 THEN 'comparable' WHEN c.known_but_excluded_user_count > 0 THEN 'excluded_pre_coverage' ELSE 'excluded_unknown_coverage' END AS exclusion_reason,
    COALESCE((SELECT COUNT(*) FROM c9_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN c.window_start AND c.window_end), 0) AS acquisition_item_count,
    COALESCE((SELECT SUM(b.acquisition_value) FROM c9_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN c.window_start AND c.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COALESCE((SELECT COUNT(*) FROM c9_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.listing_date_reliable AND b.first_listed_at BETWEEN c.window_start AND c.window_end), 0) AS first_listing_item_count,
    COALESCE((SELECT COUNT(*) FROM c9_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS realized_exit_item_count,
    COALESCE((SELECT SUM(b.exit_value) FROM c9_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS realized_exit_value_sum,
    COALESCE((SELECT SUM(b.net_profit) FROM c9_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS realized_net_profit_sum
  FROM c9s_mtd_cohort c
),
c9t_mtd_year_rows AS (
  SELECT c.year, c.window_start, c.window_end, c.day_cutoff_used, c.comparable_user_count, c.known_but_excluded_user_count, c.unknown_user_count,
    (c.comparable_user_count > 0) AS is_comparable,
    CASE WHEN c.comparable_user_count > 0 THEN 'comparable' WHEN c.known_but_excluded_user_count > 0 THEN 'excluded_pre_coverage' ELSE 'excluded_unknown_coverage' END AS exclusion_reason,
    COALESCE((SELECT COUNT(*) FROM c9t_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN c.window_start AND c.window_end), 0) AS acquisition_item_count,
    COALESCE((SELECT SUM(b.acquisition_value) FROM c9t_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.acq_date_reliable AND b.acquisition_date BETWEEN c.window_start AND c.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COALESCE((SELECT COUNT(*) FROM c9t_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.listing_date_reliable AND b.first_listed_at BETWEEN c.window_start AND c.window_end), 0) AS first_listing_item_count,
    COALESCE((SELECT COUNT(*) FROM c9t_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS realized_exit_item_count,
    COALESCE((SELECT SUM(b.exit_value) FROM c9t_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS realized_exit_value_sum,
    COALESCE((SELECT SUM(b.net_profit) FROM c9t_base b WHERE b.user_id = ANY(c.cohort_user_ids) AND b.exit_date_reliable AND b.exit_date BETWEEN c.window_start AND c.window_end), 0) AS realized_net_profit_sum
  FROM c9t_mtd_cohort c
),
c9s_mtd_comparable_summary AS (
  SELECT
    COUNT(*) FILTER (WHERE is_comparable) AS comparable_prior_years_count,
    COUNT(*) FILTER (WHERE is_comparable AND acquisition_item_count + first_listing_item_count + realized_exit_item_count > 0) AS active_comparable_year_count,
    COUNT(*) FILTER (WHERE exclusion_reason = 'excluded_pre_coverage') AS excluded_pre_coverage_year_count,
    COUNT(*) FILTER (WHERE exclusion_reason = 'excluded_unknown_coverage') AS excluded_unknown_coverage_year_count,
    COUNT(*) AS candidate_prior_years_count,
    BOOL_OR(comparable_user_count > 0 OR known_but_excluded_user_count > 0) AS any_known_coverage_exists,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS median_acquisition_item_count,
    ROUND(AVG(acquisition_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS average_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS median_acquisition_value_sum,
    ROUND(AVG(acquisition_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS average_acquisition_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_listing_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS median_first_listing_item_count,
    ROUND(AVG(first_listing_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS average_first_listing_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS median_realized_exit_item_count,
    ROUND(AVG(realized_exit_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS average_realized_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS median_realized_exit_value_sum,
    ROUND(AVG(realized_exit_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS average_realized_exit_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_net_profit_sum) FILTER (WHERE is_comparable)::numeric, 2) AS median_realized_net_profit_sum,
    ROUND(AVG(realized_net_profit_sum) FILTER (WHERE is_comparable)::numeric, 2) AS average_realized_net_profit_sum
  FROM c9s_mtd_year_rows
),
c9t_mtd_comparable_summary AS (
  SELECT
    COUNT(*) FILTER (WHERE is_comparable) AS comparable_prior_years_count,
    COUNT(*) FILTER (WHERE is_comparable AND acquisition_item_count + first_listing_item_count + realized_exit_item_count > 0) AS active_comparable_year_count,
    COUNT(*) FILTER (WHERE exclusion_reason = 'excluded_pre_coverage') AS excluded_pre_coverage_year_count,
    COUNT(*) FILTER (WHERE exclusion_reason = 'excluded_unknown_coverage') AS excluded_unknown_coverage_year_count,
    COUNT(*) AS candidate_prior_years_count,
    BOOL_OR(comparable_user_count > 0 OR known_but_excluded_user_count > 0) AS any_known_coverage_exists,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS median_acquisition_item_count,
    ROUND(AVG(acquisition_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS average_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS median_acquisition_value_sum,
    ROUND(AVG(acquisition_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS average_acquisition_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_listing_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS median_first_listing_item_count,
    ROUND(AVG(first_listing_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS average_first_listing_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS median_realized_exit_item_count,
    ROUND(AVG(realized_exit_item_count) FILTER (WHERE is_comparable)::numeric, 2) AS average_realized_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS median_realized_exit_value_sum,
    ROUND(AVG(realized_exit_value_sum) FILTER (WHERE is_comparable)::numeric, 2) AS average_realized_exit_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_net_profit_sum) FILTER (WHERE is_comparable)::numeric, 2) AS median_realized_net_profit_sum,
    ROUND(AVG(realized_net_profit_sum) FILTER (WHERE is_comparable)::numeric, 2) AS average_realized_net_profit_sum
  FROM c9t_mtd_year_rows
),
c9s_mtd_object AS (
  SELECT jsonb_build_object(
    'timezone', mp.tz, 'as_of_date', mp.as_of_date, 'current_year', mp.current_year, 'current_month', mp.current_month, 'current_day_of_month', mp.current_day_of_month,
    'current_month_to_date', jsonb_build_object('acquisition_item_count', COALESCE(cur.acquisition_item_count, 0), 'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0), 'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0), 'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0), 'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0), 'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0)),
    'candidate_prior_years_count', COALESCE(sm.candidate_prior_years_count, 0),
    'comparable_prior_years_count', COALESCE(sm.comparable_prior_years_count, 0),
    'active_comparable_year_count', COALESCE(sm.active_comparable_year_count, 0),
    'excluded_pre_coverage_year_count', COALESCE(sm.excluded_pre_coverage_year_count, 0),
    'excluded_unknown_coverage_year_count', COALESCE(sm.excluded_unknown_coverage_year_count, 0),
    'comparable_prior_years', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'year', r.year, 'day_cutoff_used', r.day_cutoff_used, 'window_start', r.window_start, 'window_end', r.window_end,
        'comparable_user_count', r.comparable_user_count,
        'acquisition_item_count', r.acquisition_item_count, 'acquisition_value_sum', r.acquisition_value_sum,
        'first_listing_item_count', r.first_listing_item_count,
        'realized_exit_item_count', r.realized_exit_item_count, 'realized_exit_value_sum', r.realized_exit_value_sum, 'realized_net_profit_sum', r.realized_net_profit_sum
      ) ORDER BY r.year), '[]'::jsonb) FROM c9s_mtd_year_rows r WHERE r.is_comparable),
    'excluded_prior_years', (SELECT COALESCE(jsonb_agg(jsonb_build_object('year', r.year, 'reason', r.exclusion_reason) ORDER BY r.year), '[]'::jsonb) FROM c9s_mtd_year_rows r WHERE NOT r.is_comparable),
    'prior_year_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', sm.median_acquisition_item_count, 'acquisition_value_sum', sm.median_acquisition_value_sum, 'first_listing_item_count', sm.median_first_listing_item_count, 'realized_exit_item_count', sm.median_realized_exit_item_count, 'realized_exit_value_sum', sm.median_realized_exit_value_sum, 'realized_net_profit_sum', sm.median_realized_net_profit_sum) END,
    'prior_year_average', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', sm.average_acquisition_item_count, 'acquisition_value_sum', sm.average_acquisition_value_sum, 'first_listing_item_count', sm.average_first_listing_item_count, 'realized_exit_item_count', sm.average_realized_exit_item_count, 'realized_exit_value_sum', sm.average_realized_exit_value_sum, 'realized_net_profit_sum', sm.average_realized_net_profit_sum) END,
    'difference_vs_prior_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', COALESCE(cur.acquisition_item_count, 0) - sm.median_acquisition_item_count, 'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0) - sm.median_acquisition_value_sum, 'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0) - sm.median_first_listing_item_count, 'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0) - sm.median_realized_exit_item_count, 'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0) - sm.median_realized_exit_value_sum, 'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0) - sm.median_realized_net_profit_sum) END,
    'status', CASE
      WHEN COALESCE(sm.comparable_prior_years_count, 0) >= 2 THEN 'sufficient_history'
      WHEN NOT COALESCE(sm.any_known_coverage_exists, false) THEN 'coverage_unknown'
      ELSE 'insufficient_history'
    END,
    'note', 'Descriptive month-to-date comparison only. Not a forecast for the completed current month. Prior years are comparable only when confirmed coverage vouches for the same day-cutoff window.'
  ) AS payload
  FROM c9s_mtd_params mp, c9s_mtd_current cur, c9s_mtd_comparable_summary sm
),
c9t_mtd_object AS (
  SELECT jsonb_build_object(
    'timezone', mp.tz, 'as_of_date', mp.as_of_date, 'current_year', mp.current_year, 'current_month', mp.current_month, 'current_day_of_month', mp.current_day_of_month,
    'current_month_to_date', jsonb_build_object('acquisition_item_count', COALESCE(cur.acquisition_item_count, 0), 'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0), 'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0), 'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0), 'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0), 'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0)),
    'candidate_prior_years_count', COALESCE(sm.candidate_prior_years_count, 0),
    'comparable_prior_years_count', COALESCE(sm.comparable_prior_years_count, 0),
    'active_comparable_year_count', COALESCE(sm.active_comparable_year_count, 0),
    'excluded_pre_coverage_year_count', COALESCE(sm.excluded_pre_coverage_year_count, 0),
    'excluded_unknown_coverage_year_count', COALESCE(sm.excluded_unknown_coverage_year_count, 0),
    'comparable_prior_years', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'year', r.year, 'day_cutoff_used', r.day_cutoff_used, 'window_start', r.window_start, 'window_end', r.window_end,
        'comparable_user_count', r.comparable_user_count,
        'acquisition_item_count', r.acquisition_item_count, 'acquisition_value_sum', r.acquisition_value_sum,
        'first_listing_item_count', r.first_listing_item_count,
        'realized_exit_item_count', r.realized_exit_item_count, 'realized_exit_value_sum', r.realized_exit_value_sum, 'realized_net_profit_sum', r.realized_net_profit_sum
      ) ORDER BY r.year), '[]'::jsonb) FROM c9t_mtd_year_rows r WHERE r.is_comparable),
    'excluded_prior_years', (SELECT COALESCE(jsonb_agg(jsonb_build_object('year', r.year, 'reason', r.exclusion_reason) ORDER BY r.year), '[]'::jsonb) FROM c9t_mtd_year_rows r WHERE NOT r.is_comparable),
    'prior_year_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', sm.median_acquisition_item_count, 'acquisition_value_sum', sm.median_acquisition_value_sum, 'first_listing_item_count', sm.median_first_listing_item_count, 'realized_exit_item_count', sm.median_realized_exit_item_count, 'realized_exit_value_sum', sm.median_realized_exit_value_sum, 'realized_net_profit_sum', sm.median_realized_net_profit_sum) END,
    'prior_year_average', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', sm.average_acquisition_item_count, 'acquisition_value_sum', sm.average_acquisition_value_sum, 'first_listing_item_count', sm.average_first_listing_item_count, 'realized_exit_item_count', sm.average_realized_exit_item_count, 'realized_exit_value_sum', sm.average_realized_exit_value_sum, 'realized_net_profit_sum', sm.average_realized_net_profit_sum) END,
    'difference_vs_prior_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object('acquisition_item_count', COALESCE(cur.acquisition_item_count, 0) - sm.median_acquisition_item_count, 'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0) - sm.median_acquisition_value_sum, 'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0) - sm.median_first_listing_item_count, 'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0) - sm.median_realized_exit_item_count, 'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0) - sm.median_realized_exit_value_sum, 'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0) - sm.median_realized_net_profit_sum) END,
    'status', CASE
      WHEN COALESCE(sm.comparable_prior_years_count, 0) >= 2 THEN 'sufficient_history'
      WHEN NOT COALESCE(sm.any_known_coverage_exists, false) THEN 'coverage_unknown'
      ELSE 'insufficient_history'
    END,
    'note', 'Descriptive month-to-date comparison only. Not a forecast for the completed current month. Prior years are comparable only when confirmed coverage vouches for the same day-cutoff window.'
  ) AS payload
  FROM c9t_mtd_params mp, c9t_mtd_current cur, c9t_mtd_comparable_summary sm
)

SELECT jsonb_build_object(
  'shared_calendar_seasonality_evidence', jsonb_build_object(
    'observation_coverage_summary', (SELECT payload FROM c9s_coverage_summary),
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(c9s_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM c9s_monthly_rows),
    'monthly_timeline_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(c9s_monthly_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_start), '[]'::jsonb) FROM c9s_monthly_purpose_rows),
    'month_of_year_seasonality', (SELECT COALESCE(jsonb_agg(to_jsonb(c9s_moy_rows) ORDER BY month_number), '[]'::jsonb) FROM c9s_moy_rows),
    -- v2.8's month_of_year_seasonality_by_purpose used the OLD, uncorrected
    -- confidence logic. Rather than silently leave it in place next to
    -- the corrected pooled section (which would look like a matching,
    -- also-corrected breakdown), it is explicitly emptied here with a
    -- note — a per-Purpose coverage-aware breakdown was out of scope for
    -- this correction (see this migration's header and analytics/
    -- SEMANTIC_CONTRACT.md section 32). Use month_of_year_seasonality
    -- (pooled) for coverage-aware confidence.
    'month_of_year_seasonality_by_purpose', '[]'::jsonb,
    'month_of_year_seasonality_by_purpose_note', 'Not corrected in v2.9 — out of scope for this correction. Use month_of_year_seasonality (pooled) for coverage-aware confidence.',
    'current_month_to_date_pace', (SELECT payload FROM c9s_mtd_object)
  ),
  'target_user_calendar_seasonality_evidence', jsonb_build_object(
    'observation_coverage_summary', (SELECT payload FROM c9t_coverage_summary),
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM ct_monthly_rows),
    'monthly_timeline_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_monthly_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_start), '[]'::jsonb) FROM ct_monthly_purpose_rows),
    'month_of_year_seasonality', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_moy_rows) ORDER BY month_number), '[]'::jsonb) FROM ct_moy_rows),
    'month_of_year_seasonality_by_purpose', '[]'::jsonb,
    'month_of_year_seasonality_by_purpose_note', 'Not corrected in v2.9 — out of scope for this correction. Use month_of_year_seasonality (pooled) for coverage-aware confidence.',
    'current_month_to_date_pace', (SELECT payload FROM c9t_mtd_object)
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_calendar_coverage_correction_v2_9(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_calendar_coverage_correction_v2_9(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_calendar_coverage_correction_v2_9(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_calendar_coverage_correction_v2_9(int) TO service_role;


-- ============================================================================
-- PART 3: public.build_analytics_snapshot_v2_9(p_target_user_id int)
--
-- Calls build_analytics_snapshot_v2_8 WHOLESALE, then MERGES the coverage
-- correction on top of v2.8's OWN shared_calendar_seasonality_evidence /
-- target_user_calendar_seasonality_evidence objects via jsonb `||` — this
-- preserves the existing public section NAMES (per this task's explicit
-- preference) while superseding only population_summary [augmented with
-- observation_coverage_summary — see note below], monthly_timeline(
-- _by_purpose), month_of_year_seasonality, and current_month_to_date_pace.
-- timezone, as_of_date, purpose_population_summary, and every day_of_
-- week_* array are NOT recomputed here — they pass through from v2.8
-- completely unchanged (same values, same Historical Import behavior),
-- since nothing in this correction touches their semantics.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_9(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v28                 jsonb;
  v_generated_at         timestamptz := now();
  v_correction           jsonb;
BEGIN
  v_v28 := public.build_analytics_snapshot_v2_8(p_target_user_id);
  v_correction := public._build_calendar_coverage_correction_v2_9(p_target_user_id);

  RETURN v_v28
    || jsonb_build_object(
         'snapshot_schema_version', '2.9',
         'analytics_definition_version', '2.9',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_calendar_seasonality_evidence',
           (v_v28 -> 'shared_calendar_seasonality_evidence') || (v_correction -> 'shared_calendar_seasonality_evidence'),
         'target_user_calendar_seasonality_evidence',
           (v_v28 -> 'target_user_calendar_seasonality_evidence') || (v_correction -> 'target_user_calendar_seasonality_evidence')
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_9(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_9(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_9(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_9(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_9(int) IS
  'Analytics v2.9 — Calendar Observation Coverage & Confidence Correction '
  '— the current PRODUCTION analytics snapshot version. SECURITY INVOKER, '
  'service_role execution only. Calls build_analytics_snapshot_v2_8 '
  'wholesale and MERGES a coverage-aware correction on top of its '
  'shared_calendar_seasonality_evidence / target_user_calendar_'
  'seasonality_evidence objects (same key names, per this task''s '
  'preference to keep downstream consumers automatically on corrected '
  'evidence): adds observation_coverage_summary; supersedes monthly_'
  'timeline(_by_purpose) with a per-row coverage_status; supersedes '
  'month_of_year_seasonality with fully-observed-year-aware confidence '
  '(no_data/coverage_unknown/insufficient_years/low/moderate/stronger); '
  'supersedes current_month_to_date_pace with confirmed-coverage-only '
  'prior-year comparability. timezone, as_of_date, purpose_population_'
  'summary, population_summary, and every day_of_week_* array are '
  'unchanged from v2.8. v1.0-v1.8 and v2.0-v2.8 are completely '
  'unaffected. Persists nothing — see analytics_runs (20260727000000) '
  'for the persistence step. See analytics/README.md and analytics/'
  'SEMANTIC_CONTRACT.md section 32 for the full v2.9 contract.';


-- ============================================================================
-- OPERATOR CONFIGURATION TEMPLATE — run manually, per user, only after
-- confirming the date out-of-band (e.g. against a known "I started using
-- this app on X" fact, an account-creation record, or another external
-- source). Never inferred automatically by this migration.
--
-- Example (REPLACE the user id and date before running):
--
--   INSERT INTO public.analytics_observation_coverage
--     (user_id, complete_history_start_date, coverage_status, notes)
--   VALUES
--     (1, '2025-10-01', 'confirmed', 'Confirmed against account creation records.')
--   ON CONFLICT (user_id) DO UPDATE SET
--     complete_history_start_date = EXCLUDED.complete_history_start_date,
--     coverage_status             = EXCLUDED.coverage_status,
--     notes                       = EXCLUDED.notes;
--
-- To mark a user's coverage back to unknown (e.g. a prior guess turned
-- out to be wrong):
--
--   UPDATE public.analytics_observation_coverage
--   SET complete_history_start_date = NULL, coverage_status = 'unknown', notes = NULL
--   WHERE user_id = 1;
-- ============================================================================
