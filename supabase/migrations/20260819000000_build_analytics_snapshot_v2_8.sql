-- build_analytics_snapshot_v2_8
--
-- Analytics v2.8 — Calendar & Seasonality. A NEW module (not a port of any
-- v1 file). Adds a NEW helper and a NEW top-level builder that calls
-- build_analytics_snapshot_v2_7 WHOLESALE and adds two new top-level
-- sections, shared_calendar_seasonality_evidence and target_user_calendar_
-- seasonality_evidence. Does NOT call, embed, or replace any v1.0-v1.8 or
-- v2.0-v2.7 builder — those remain entirely unchanged and independently
-- callable.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_calendar_seasonality_snapshot_v2(int)  -- NEW
--   public.build_analytics_snapshot_v2_8(int)             -- NEW
--
-- ── SCOPE — CALENDAR/SEASONALITY EVIDENCE ONLY ───────────────────────────
-- Calendar activity, calendar trends, descriptive seasonality only.
-- Explicitly excluded: Findings Selector, Pattern Discovery, Business
-- Coach, forecasting, recommendations, external market data. Every
-- section here is DESCRIPTIVE — no "best month" claim, no buying/selling
-- advice, no urgency, no seasonality score, no forecast, no causal claim,
-- no item-level row, no AI-generated prose.
--
-- ── SOURCES OF TRUTH — NO PARALLEL DEFINITIONS ───────────────────────────
-- Reads exclusively from public.analytics_item_lifecycle_v2 (acquisition_
-- date, first_listed_at, exit_date, is_historical_import, has_lifecycle_
-- date_issue, holding_days, global_days_on_market, acquisition_deal_id,
-- exit_deal_id, acquisition_value, exit_value, net_profit, is_realized —
-- every field already defined by 20260723000000_analytics_item_lifecycle.
-- sql and its extensions) and public.analytics_purpose_policy. No new
-- date/deal/profit definition is created here.
--
-- ── TIMEZONE ─────────────────────────────────────────────────────────────
-- All "current"/"as of" reasoning (month-to-date pace) uses
-- America/Toronto. Both the timezone string and the snapshot's as_of_date
-- are stored directly in shared_calendar_seasonality_evidence and target_
-- user_calendar_seasonality_evidence (top-level fields, and again nested
-- inside current_month_to_date_pace for readers of that section alone).
--
-- ── EVENT-DATE RELIABILITY RULES ──────────────────────────────────────────
-- acq_date_reliable  = acquisition_date IS NOT NULL AND NOT is_historical_
--   import AND NOT has_lifecycle_date_issue. A Historical Import's
--   acquisition date NEVER contributes to acquisition calendar activity,
--   month-of-year acquisition seasonality, acquisition weekday patterns,
--   or acquisition-date-dependent MTD pace — consistent with every prior
--   v2 module's Historical Import handling (holding_days, ownership age).
-- listing_date_reliable = first_listed_at IS NOT NULL AND NOT has_
--   lifecycle_date_issue. Historical Import status does NOT exclude a
--   listing date — a real, currently-recorded listing event remains
--   trustworthy regardless of how the item was acquired.
-- exit_date_reliable = is_realized AND exit_date IS NOT NULL AND NOT has_
--   lifecycle_date_issue. Historical Import status does NOT exclude an
--   exit date, for the same reason.
-- Missing/unreliable dates are NEVER treated as zero-duration or an
-- invented date — they remain visible in population_and_date_coverage's
-- explicit exclusion counters, never silently dropped from the population.
-- Every date-based computation here uses the event's own date column
-- (deal_date / listed_at), never a record's created_at.
--
-- ── PURPOSE IS CURRENT DISPOSITION, NOT PROVEN HISTORICAL INTENT ─────────
-- A historical event grouped under Business, Hybrid, or Personal reflects
-- the item's CURRENT purpose_id only — it does not prove the item had
-- that Purpose when the acquisition/listing/exit event actually occurred
-- (Purpose has no history table in this schema). Every section is
-- produced twice: pooled across all Purposes, and broken down by
-- (current_purpose_id, current_purpose_name, purpose_policy_status),
-- using the same missing-purpose/missing-policy collapsing rule
-- established in v2.0 and reused by every v2 module since. The purpose-
-- breakdown rows additionally surface the existing analytics_purpose_
-- policy fields (never a new judgmental label).
--
-- ── DEAL-COUNT / ITEM-COUNT SEPARATION — NO DOUBLE-COUNTED CASH ──────────
-- deal_items.total_value (acquisition_value / exit_value) is already the
-- PER-ITEM allocated share of a deal's cash, not the deal's full total
-- repeated on every item row (see deal_items table definition) — so
-- SUM(acquisition_value)/SUM(exit_value) never double-counts a multi-item
-- deal's cash. Distinct deal counts (COUNT(DISTINCT acquisition_deal_id),
-- COUNT(DISTINCT exit_deal_id)) are reported ALONGSIDE, never instead of,
-- item counts, so a 3-item single deal is visible as both "3 items" and
-- "1 deal" — the two are never conflated into one number. Listing events
-- have no deal_id (item_listings is not deal-based), so no deal count is
-- reported for first-listing activity.
--
-- ── MONTHLY TIMELINE — GAP-FILLED, NEVER SILENTLY SPARSE ─────────────────
-- monthly_timeline (and its _by_purpose counterpart) is generated from a
-- generate_series over every calendar month from the earliest reliable
-- event date through the current America/Toronto month, LEFT JOINed to
-- observed activity — a month with zero reliable acquisitions/listings/
-- exits still appears as a row with 0 counts, never omitted. If no
-- reliable event date exists at all, the series (and therefore the
-- timeline) is empty, never fabricated.
--
-- ── MONTH-OF-YEAR SEASONALITY — DESCRIPTIVE, YEAR-COUNT-AWARE ────────────
-- Aggregates ALL years' observations into 12 rows (Jan-Dec). Every row
-- reports its own distinct-year contributing count per event type
-- (acquisition/first-listing/realized-exit) and a confidence/status field
-- that is 'insufficient_years' whenever fewer than 2 distinct years
-- contributed an observation for that event type in that month —
-- regardless of how many items were involved — per this task's explicit
-- instruction that "a month with observations from only one year is not
-- sufficient evidence of recurring seasonality." No "best"/"worst" month
-- label, score, or causal claim is produced anywhere.
--
-- ── DAY-OF-WEEK PATTERNS — THREE SEPARATE ARRAYS ─────────────────────────
-- day_of_week_acquisition_activity, day_of_week_first_listing_activity,
-- and day_of_week_realized_exit_activity are three INDEPENDENT
-- Monday-Sunday (ISO weekday) arrays — never combined into one ambiguous
-- weekday metric, per this task's explicit instruction.
--
-- ── CURRENT MONTH-TO-DATE PACE — POOLED ONLY (SCOPE DECISION) ────────────
-- current_month_to_date_pace compares the current America/Toronto
-- month-to-date window against the SAME calendar-day cutoff in every
-- prior year with reliable data (e.g. an August 12 snapshot compares
-- August 1-12 of each prior year, never a full prior August) — computed
-- pooled only (all Purposes together), not broken down _by_purpose. A
-- per-Purpose x per-prior-year matrix would multiply an already
-- multi-dimensional computation (year x day-cutoff x 3 event types) by up
-- to 5 Purpose groups for comparatively little evidentiary value at
-- today's inventory scale; this is a deliberate scope decision, not an
-- oversight, and can be revisited later if a per-Purpose pace view proves
-- necessary. February/short months are handled via LEAST(current_day_of_
-- month, days_in_that_prior_month) for every prior year's cutoff. If zero
-- comparable prior years exist, status is 'insufficient_history' and no
-- median/average/difference is fabricated. This is never presented as a
-- forecast for the completed current month.
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- shared_calendar_seasonality_evidence pools every user's items (aggregate
-- only — no item_id, item name, model, notes, or other item identity, and
-- no row grouped by user_id). target_user_calendar_seasonality_evidence is
-- filtered to user_id = p_target_user_id and is, like the shared section,
-- aggregate only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_calendar_seasonality_snapshot_v2(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH

-- ============================================================================
-- Base population + reliability flags + Purpose grouping (shared: all
-- users; target: p_target_user_id only)
-- ============================================================================
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
ct_base AS (
  SELECT * FROM cs_base WHERE user_id = p_target_user_id
),

cs_purposes AS ( SELECT DISTINCT group_purpose_id, group_purpose_name, purpose_policy_status FROM cs_base ),
ct_purposes AS ( SELECT DISTINCT group_purpose_id, group_purpose_name, purpose_policy_status FROM ct_base ),

-- Timezone / as-of-date — America/Toronto, single row, shared by both scopes.
cs_as_of AS (
  SELECT
    'America/Toronto'::text                              AS tz,
    (now() AT TIME ZONE 'America/Toronto')::date          AS as_of_date
),

-- ============================================================================
-- Section 1: population_and_date_coverage
-- ============================================================================
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
    COUNT(*) FILTER (WHERE b.acquisition_date IS NULL)                                AS missing_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.acquisition_date IS NOT NULL AND b.is_historical_import) AS historical_import_excluded_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.acquisition_date IS NOT NULL AND NOT b.is_historical_import AND b.has_lifecycle_date_issue) AS lifecycle_issue_excluded_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.listing_date_reliable)                                   AS reliable_first_listing_date_count,
    COUNT(*) FILTER (WHERE b.first_listed_at IS NULL)                                 AS missing_first_listing_date_count,
    COUNT(*) FILTER (WHERE b.first_listed_at IS NOT NULL AND b.has_lifecycle_date_issue) AS lifecycle_issue_excluded_listing_date_count,
    COUNT(*) FILTER (WHERE b.is_realized)                                             AS realized_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable)                                      AS reliable_realized_exit_date_count,
    COUNT(*) FILTER (WHERE b.is_realized AND b.exit_date IS NULL)                     AS missing_exit_date_for_realized_count,
    COUNT(*) FILTER (WHERE b.is_realized AND b.exit_date IS NOT NULL AND b.has_lifecycle_date_issue) AS lifecycle_issue_excluded_exit_date_count,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue) AS reliable_holding_duration_sample_count,
    COUNT(*) FILTER (WHERE b.global_days_on_market IS NOT NULL)                       AS reliable_dom_sample_count,
    COUNT(*) FILTER (WHERE b.is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE b.is_historical_import AND b.is_realized)                  AS historical_import_realized_item_count,
    COUNT(*) FILTER (WHERE b.is_historical_import AND NOT b.is_realized)              AS historical_import_open_item_count,
    LEAST(
      MIN(b.acquisition_date) FILTER (WHERE b.acq_date_reliable),
      MIN(b.first_listed_at)  FILTER (WHERE b.listing_date_reliable),
      MIN(b.exit_date)        FILTER (WHERE b.exit_date_reliable)
    )                                                                                 AS earliest_eligible_event_date,
    GREATEST(
      MAX(b.acquisition_date) FILTER (WHERE b.acq_date_reliable),
      MAX(b.first_listed_at)  FILTER (WHERE b.listing_date_reliable),
      MAX(b.exit_date)        FILTER (WHERE b.exit_date_reliable)
    )                                                                                 AS latest_eligible_event_date
  FROM cs_base b
  LEFT JOIN public.analytics_purpose_policy pp ON pp.purpose_id = b.group_purpose_id AND b.purpose_policy_status = 'mapped'
  GROUP BY b.group_purpose_id, b.group_purpose_name, b.purpose_policy_status, pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description
),
ct_pop_row AS (
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
  FROM ct_base
),
ct_pop_purpose_rows AS (
  SELECT
    b.group_purpose_id AS current_purpose_id, b.group_purpose_name AS current_purpose_name, b.purpose_policy_status,
    pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description AS purpose_policy_description,
    COUNT(*)                                                                          AS total_item_count,
    COUNT(*) FILTER (WHERE b.acq_date_reliable)                                       AS reliable_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.acquisition_date IS NULL)                                AS missing_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.acquisition_date IS NOT NULL AND b.is_historical_import) AS historical_import_excluded_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.acquisition_date IS NOT NULL AND NOT b.is_historical_import AND b.has_lifecycle_date_issue) AS lifecycle_issue_excluded_acquisition_date_count,
    COUNT(*) FILTER (WHERE b.listing_date_reliable)                                   AS reliable_first_listing_date_count,
    COUNT(*) FILTER (WHERE b.first_listed_at IS NULL)                                 AS missing_first_listing_date_count,
    COUNT(*) FILTER (WHERE b.first_listed_at IS NOT NULL AND b.has_lifecycle_date_issue) AS lifecycle_issue_excluded_listing_date_count,
    COUNT(*) FILTER (WHERE b.is_realized)                                             AS realized_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable)                                      AS reliable_realized_exit_date_count,
    COUNT(*) FILTER (WHERE b.is_realized AND b.exit_date IS NULL)                     AS missing_exit_date_for_realized_count,
    COUNT(*) FILTER (WHERE b.is_realized AND b.exit_date IS NOT NULL AND b.has_lifecycle_date_issue) AS lifecycle_issue_excluded_exit_date_count,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue) AS reliable_holding_duration_sample_count,
    COUNT(*) FILTER (WHERE b.global_days_on_market IS NOT NULL)                       AS reliable_dom_sample_count,
    COUNT(*) FILTER (WHERE b.is_historical_import)                                    AS historical_import_item_count,
    COUNT(*) FILTER (WHERE b.is_historical_import AND b.is_realized)                  AS historical_import_realized_item_count,
    COUNT(*) FILTER (WHERE b.is_historical_import AND NOT b.is_realized)              AS historical_import_open_item_count,
    LEAST(
      MIN(b.acquisition_date) FILTER (WHERE b.acq_date_reliable),
      MIN(b.first_listed_at)  FILTER (WHERE b.listing_date_reliable),
      MIN(b.exit_date)        FILTER (WHERE b.exit_date_reliable)
    )                                                                                 AS earliest_eligible_event_date,
    GREATEST(
      MAX(b.acquisition_date) FILTER (WHERE b.acq_date_reliable),
      MAX(b.first_listed_at)  FILTER (WHERE b.listing_date_reliable),
      MAX(b.exit_date)        FILTER (WHERE b.exit_date_reliable)
    )                                                                                 AS latest_eligible_event_date
  FROM ct_base b
  LEFT JOIN public.analytics_purpose_policy pp ON pp.purpose_id = b.group_purpose_id AND b.purpose_policy_status = 'mapped'
  GROUP BY b.group_purpose_id, b.group_purpose_name, b.purpose_policy_status, pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description
),

-- ============================================================================
-- Section 2: monthly_timeline (gap-filled: every month from the earliest
-- reliable event date through the current America/Toronto month)
-- ============================================================================
cs_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM cs_pop_row)),
    date_trunc('month', (SELECT as_of_date FROM cs_as_of)),
    interval '1 month'
  )::date AS month_start
),
ct_month_series AS (
  SELECT generate_series(
    date_trunc('month', (SELECT earliest_eligible_event_date FROM ct_pop_row)),
    date_trunc('month', (SELECT as_of_date FROM cs_as_of)),
    interval '1 month'
  )::date AS month_start
),

cs_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT acquisition_deal_id)                                     AS deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)     AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1
),
cs_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1
),
cs_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start,
    COUNT(*)                                AS item_count,
    COUNT(DISTINCT exit_deal_id)             AS deal_count,
    SUM(exit_value)                          AS exit_value_sum,
    SUM(net_profit)                          AS net_profit_sum
  FROM cs_base WHERE exit_date_reliable GROUP BY 1
),
cs_monthly_rows AS (
  SELECT
    ms.month_start,
    COALESCE(a.item_count, 0)              AS reliable_acquisition_item_count,
    COALESCE(a.deal_count, 0)               AS reliable_acquisition_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.deal_count, 0)               AS realized_exit_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum
  FROM cs_month_series ms
  LEFT JOIN cs_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN cs_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN cs_monthly_exit e ON e.month_start = ms.month_start
),

cs_monthly_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT acquisition_deal_id)                                     AS deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)     AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
cs_monthly_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
cs_monthly_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    date_trunc('month', exit_date)::date AS month_start,
    COUNT(*)                                AS item_count,
    COUNT(DISTINCT exit_deal_id)             AS deal_count,
    SUM(exit_value)                          AS exit_value_sum,
    SUM(net_profit)                          AS net_profit_sum
  FROM cs_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
cs_monthly_purpose_rows AS (
  SELECT
    p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    ms.month_start,
    COALESCE(a.item_count, 0)              AS reliable_acquisition_item_count,
    COALESCE(a.deal_count, 0)               AS reliable_acquisition_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.deal_count, 0)               AS realized_exit_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum
  FROM cs_purposes p
  CROSS JOIN cs_month_series ms
  LEFT JOIN cs_monthly_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_start = ms.month_start
  LEFT JOIN cs_monthly_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_start = ms.month_start
  LEFT JOIN cs_monthly_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_start = ms.month_start
),

ct_monthly_acq AS (
  SELECT date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT acquisition_deal_id)                                     AS deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)     AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1
),
ct_monthly_listing AS (
  SELECT date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1
),
ct_monthly_exit AS (
  SELECT date_trunc('month', exit_date)::date AS month_start,
    COUNT(*)                                AS item_count,
    COUNT(DISTINCT exit_deal_id)             AS deal_count,
    SUM(exit_value)                          AS exit_value_sum,
    SUM(net_profit)                          AS net_profit_sum
  FROM ct_base WHERE exit_date_reliable GROUP BY 1
),
ct_monthly_rows AS (
  SELECT
    ms.month_start,
    COALESCE(a.item_count, 0)              AS reliable_acquisition_item_count,
    COALESCE(a.deal_count, 0)               AS reliable_acquisition_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.deal_count, 0)               AS realized_exit_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum
  FROM ct_month_series ms
  LEFT JOIN ct_monthly_acq a ON a.month_start = ms.month_start
  LEFT JOIN ct_monthly_listing l ON l.month_start = ms.month_start
  LEFT JOIN ct_monthly_exit e ON e.month_start = ms.month_start
),

ct_monthly_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    date_trunc('month', acquisition_date)::date AS month_start,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT acquisition_deal_id)                                     AS deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)     AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
ct_monthly_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    date_trunc('month', first_listed_at)::date AS month_start, COUNT(*) AS item_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
ct_monthly_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    date_trunc('month', exit_date)::date AS month_start,
    COUNT(*)                                AS item_count,
    COUNT(DISTINCT exit_deal_id)             AS deal_count,
    SUM(exit_value)                          AS exit_value_sum,
    SUM(net_profit)                          AS net_profit_sum
  FROM ct_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
ct_monthly_purpose_rows AS (
  SELECT
    p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    ms.month_start,
    COALESCE(a.item_count, 0)              AS reliable_acquisition_item_count,
    COALESCE(a.deal_count, 0)               AS reliable_acquisition_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS reliable_acquisition_value_sum,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.deal_count, 0)               AS realized_exit_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum
  FROM ct_purposes p
  CROSS JOIN ct_month_series ms
  LEFT JOIN ct_monthly_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_start = ms.month_start
  LEFT JOIN ct_monthly_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_start = ms.month_start
  LEFT JOIN ct_monthly_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_start = ms.month_start
),

-- ============================================================================
-- Section 3: month_of_year_seasonality (Jan-Dec, all years pooled,
-- distinct-year-aware confidence)
-- ============================================================================
cs_month_numbers AS ( SELECT generate_series(1, 12) AS month_number ),

cs_moy_acq AS (
  SELECT EXTRACT(MONTH FROM acquisition_date)::int AS month_number,
    COUNT(*)                                                              AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM acquisition_date))                   AS distinct_year_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1
),
cs_moy_listing AS (
  SELECT EXTRACT(MONTH FROM first_listed_at)::int AS month_number,
    COUNT(*)                                             AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM first_listed_at))    AS distinct_year_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1
),
cs_moy_exit AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM exit_date))                            AS distinct_year_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM cs_base WHERE exit_date_reliable GROUP BY 1
),
cs_moy_rows AS (
  SELECT
    mn.month_number,
    TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth'))         AS month_name,
    COALESCE(a.item_count, 0)               AS acquisition_item_count,
    COALESCE(a.distinct_year_count, 0)      AS acquisition_distinct_year_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum,
    CASE WHEN COALESCE(a.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(a.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN a.item_count <= 2 THEN 'insufficient' WHEN a.item_count <= 5 THEN 'low' WHEN a.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS acquisition_confidence,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(l.distinct_year_count, 0)      AS first_listing_distinct_year_count,
    CASE WHEN COALESCE(l.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(l.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN l.item_count <= 2 THEN 'insufficient' WHEN l.item_count <= 5 THEN 'low' WHEN l.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS first_listing_confidence,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.distinct_year_count, 0)      AS realized_exit_distinct_year_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum,
    e.median_net_profit,
    COALESCE(e.dom_sample_size, 0)          AS dom_sample_size,
    e.median_days_on_market,
    COALESCE(e.holding_sample_size, 0)      AS holding_sample_size,
    e.median_holding_days,
    CASE WHEN COALESCE(e.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(e.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN e.item_count <= 2 THEN 'insufficient' WHEN e.item_count <= 5 THEN 'low' WHEN e.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS realized_exit_confidence
  FROM cs_month_numbers mn
  LEFT JOIN cs_moy_acq a ON a.month_number = mn.month_number
  LEFT JOIN cs_moy_listing l ON l.month_number = mn.month_number
  LEFT JOIN cs_moy_exit e ON e.month_number = mn.month_number
),

cs_moy_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(MONTH FROM acquisition_date)::int AS month_number,
    COUNT(*)                                                              AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM acquisition_date))                   AS distinct_year_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
cs_moy_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(MONTH FROM first_listed_at)::int AS month_number,
    COUNT(*)                                             AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM first_listed_at))    AS distinct_year_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
cs_moy_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(MONTH FROM exit_date)::int AS month_number,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM exit_date))                            AS distinct_year_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM cs_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
cs_moy_purpose_rows AS (
  SELECT
    p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    mn.month_number,
    TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth'))         AS month_name,
    COALESCE(a.item_count, 0)               AS acquisition_item_count,
    COALESCE(a.distinct_year_count, 0)      AS acquisition_distinct_year_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum,
    CASE WHEN COALESCE(a.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(a.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN a.item_count <= 2 THEN 'insufficient' WHEN a.item_count <= 5 THEN 'low' WHEN a.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS acquisition_confidence,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(l.distinct_year_count, 0)      AS first_listing_distinct_year_count,
    CASE WHEN COALESCE(l.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(l.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN l.item_count <= 2 THEN 'insufficient' WHEN l.item_count <= 5 THEN 'low' WHEN l.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS first_listing_confidence,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.distinct_year_count, 0)      AS realized_exit_distinct_year_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum,
    e.median_net_profit,
    COALESCE(e.dom_sample_size, 0)          AS dom_sample_size,
    e.median_days_on_market,
    COALESCE(e.holding_sample_size, 0)      AS holding_sample_size,
    e.median_holding_days,
    CASE WHEN COALESCE(e.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(e.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN e.item_count <= 2 THEN 'insufficient' WHEN e.item_count <= 5 THEN 'low' WHEN e.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS realized_exit_confidence
  FROM cs_purposes p
  CROSS JOIN cs_month_numbers mn
  LEFT JOIN cs_moy_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_number = mn.month_number
  LEFT JOIN cs_moy_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_number = mn.month_number
  LEFT JOIN cs_moy_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_number = mn.month_number
),

ct_moy_acq AS (
  SELECT EXTRACT(MONTH FROM acquisition_date)::int AS month_number,
    COUNT(*)                                                              AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM acquisition_date))                   AS distinct_year_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1
),
ct_moy_listing AS (
  SELECT EXTRACT(MONTH FROM first_listed_at)::int AS month_number,
    COUNT(*)                                             AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM first_listed_at))    AS distinct_year_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1
),
ct_moy_exit AS (
  SELECT EXTRACT(MONTH FROM exit_date)::int AS month_number,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM exit_date))                            AS distinct_year_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM ct_base WHERE exit_date_reliable GROUP BY 1
),
ct_moy_rows AS (
  SELECT
    mn.month_number,
    TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth'))         AS month_name,
    COALESCE(a.item_count, 0)               AS acquisition_item_count,
    COALESCE(a.distinct_year_count, 0)      AS acquisition_distinct_year_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum,
    CASE WHEN COALESCE(a.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(a.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN a.item_count <= 2 THEN 'insufficient' WHEN a.item_count <= 5 THEN 'low' WHEN a.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS acquisition_confidence,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(l.distinct_year_count, 0)      AS first_listing_distinct_year_count,
    CASE WHEN COALESCE(l.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(l.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN l.item_count <= 2 THEN 'insufficient' WHEN l.item_count <= 5 THEN 'low' WHEN l.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS first_listing_confidence,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.distinct_year_count, 0)      AS realized_exit_distinct_year_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum,
    e.median_net_profit,
    COALESCE(e.dom_sample_size, 0)          AS dom_sample_size,
    e.median_days_on_market,
    COALESCE(e.holding_sample_size, 0)      AS holding_sample_size,
    e.median_holding_days,
    CASE WHEN COALESCE(e.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(e.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN e.item_count <= 2 THEN 'insufficient' WHEN e.item_count <= 5 THEN 'low' WHEN e.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS realized_exit_confidence
  FROM cs_month_numbers mn
  LEFT JOIN ct_moy_acq a ON a.month_number = mn.month_number
  LEFT JOIN ct_moy_listing l ON l.month_number = mn.month_number
  LEFT JOIN ct_moy_exit e ON e.month_number = mn.month_number
),

ct_moy_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(MONTH FROM acquisition_date)::int AS month_number,
    COUNT(*)                                                              AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM acquisition_date))                   AS distinct_year_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
ct_moy_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(MONTH FROM first_listed_at)::int AS month_number,
    COUNT(*)                                             AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM first_listed_at))    AS distinct_year_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
ct_moy_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(MONTH FROM exit_date)::int AS month_number,
    COUNT(*)                                                                AS item_count,
    COUNT(DISTINCT EXTRACT(YEAR FROM exit_date))                            AS distinct_year_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)              AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days
  FROM ct_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
ct_moy_purpose_rows AS (
  SELECT
    p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    mn.month_number,
    TRIM(TO_CHAR(MAKE_DATE(2000, mn.month_number, 1), 'FMMonth'))         AS month_name,
    COALESCE(a.item_count, 0)               AS acquisition_item_count,
    COALESCE(a.distinct_year_count, 0)      AS acquisition_distinct_year_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum,
    CASE WHEN COALESCE(a.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(a.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN a.item_count <= 2 THEN 'insufficient' WHEN a.item_count <= 5 THEN 'low' WHEN a.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS acquisition_confidence,
    COALESCE(l.item_count, 0)               AS first_listing_item_count,
    COALESCE(l.distinct_year_count, 0)      AS first_listing_distinct_year_count,
    CASE WHEN COALESCE(l.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(l.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN l.item_count <= 2 THEN 'insufficient' WHEN l.item_count <= 5 THEN 'low' WHEN l.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS first_listing_confidence,
    COALESCE(e.item_count, 0)               AS realized_exit_item_count,
    COALESCE(e.distinct_year_count, 0)      AS realized_exit_distinct_year_count,
    COALESCE(e.exit_value_sum, 0)           AS realized_exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS realized_net_profit_sum,
    e.median_net_profit,
    COALESCE(e.dom_sample_size, 0)          AS dom_sample_size,
    e.median_days_on_market,
    COALESCE(e.holding_sample_size, 0)      AS holding_sample_size,
    e.median_holding_days,
    CASE WHEN COALESCE(e.item_count, 0) = 0 THEN 'no_data' WHEN COALESCE(e.distinct_year_count, 0) <= 1 THEN 'insufficient_years'
         WHEN e.item_count <= 2 THEN 'insufficient' WHEN e.item_count <= 5 THEN 'low' WHEN e.item_count <= 9 THEN 'moderate' ELSE 'stronger' END AS realized_exit_confidence
  FROM ct_purposes p
  CROSS JOIN cs_month_numbers mn
  LEFT JOIN ct_moy_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.month_number = mn.month_number
  LEFT JOIN ct_moy_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.month_number = mn.month_number
  LEFT JOIN ct_moy_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.month_number = mn.month_number
),

-- ============================================================================
-- Section 4: day_of_week_patterns (ISO weekday, Monday=1..Sunday=7, three
-- independent event-type arrays)
-- ============================================================================
cs_weekday_numbers AS ( SELECT generate_series(1, 7) AS weekday_number ),

cs_dow_acq AS (
  SELECT EXTRACT(ISODOW FROM acquisition_date)::int AS weekday_number,
    COUNT(*)                                                              AS event_count,
    COUNT(DISTINCT acquisition_deal_id)                                   AS distinct_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1
),
cs_dow_listing AS (
  SELECT EXTRACT(ISODOW FROM first_listed_at)::int AS weekday_number, COUNT(*) AS event_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1
),
cs_dow_exit AS (
  SELECT EXTRACT(ISODOW FROM exit_date)::int AS weekday_number,
    COUNT(*)                                                                AS event_count,
    COUNT(DISTINCT exit_deal_id)                                            AS distinct_deal_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit
  FROM cs_base WHERE exit_date_reliable GROUP BY 1
),
cs_dow_acq_rows AS (
  SELECT wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(a.event_count, 0)              AS event_count,
    COALESCE(a.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum
  FROM cs_weekday_numbers wn LEFT JOIN cs_dow_acq a ON a.weekday_number = wn.weekday_number
),
cs_dow_listing_rows AS (
  SELECT wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(l.event_count, 0)              AS event_count
  FROM cs_weekday_numbers wn LEFT JOIN cs_dow_listing l ON l.weekday_number = wn.weekday_number
),
cs_dow_exit_rows AS (
  SELECT wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(e.event_count, 0)              AS event_count,
    COALESCE(e.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS net_profit_sum,
    e.median_net_profit
  FROM cs_weekday_numbers wn LEFT JOIN cs_dow_exit e ON e.weekday_number = wn.weekday_number
),

cs_dow_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(ISODOW FROM acquisition_date)::int AS weekday_number,
    COUNT(*)                                                              AS event_count,
    COUNT(DISTINCT acquisition_deal_id)                                   AS distinct_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM cs_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
cs_dow_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(ISODOW FROM first_listed_at)::int AS weekday_number, COUNT(*) AS event_count
  FROM cs_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
cs_dow_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(ISODOW FROM exit_date)::int AS weekday_number,
    COUNT(*)                                                                AS event_count,
    COUNT(DISTINCT exit_deal_id)                                            AS distinct_deal_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit
  FROM cs_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
cs_dow_acq_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(a.event_count, 0)              AS event_count,
    COALESCE(a.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum
  FROM cs_purposes p CROSS JOIN cs_weekday_numbers wn
  LEFT JOIN cs_dow_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.weekday_number = wn.weekday_number
),
cs_dow_listing_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(l.event_count, 0)              AS event_count
  FROM cs_purposes p CROSS JOIN cs_weekday_numbers wn
  LEFT JOIN cs_dow_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.weekday_number = wn.weekday_number
),
cs_dow_exit_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(e.event_count, 0)              AS event_count,
    COALESCE(e.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS net_profit_sum,
    e.median_net_profit
  FROM cs_purposes p CROSS JOIN cs_weekday_numbers wn
  LEFT JOIN cs_dow_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.weekday_number = wn.weekday_number
),

ct_dow_acq AS (
  SELECT EXTRACT(ISODOW FROM acquisition_date)::int AS weekday_number,
    COUNT(*)                                                              AS event_count,
    COUNT(DISTINCT acquisition_deal_id)                                   AS distinct_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1
),
ct_dow_listing AS (
  SELECT EXTRACT(ISODOW FROM first_listed_at)::int AS weekday_number, COUNT(*) AS event_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1
),
ct_dow_exit AS (
  SELECT EXTRACT(ISODOW FROM exit_date)::int AS weekday_number,
    COUNT(*)                                                                AS event_count,
    COUNT(DISTINCT exit_deal_id)                                            AS distinct_deal_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit
  FROM ct_base WHERE exit_date_reliable GROUP BY 1
),
ct_dow_acq_rows AS (
  SELECT wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(a.event_count, 0)              AS event_count,
    COALESCE(a.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum
  FROM cs_weekday_numbers wn LEFT JOIN ct_dow_acq a ON a.weekday_number = wn.weekday_number
),
ct_dow_listing_rows AS (
  SELECT wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(l.event_count, 0)              AS event_count
  FROM cs_weekday_numbers wn LEFT JOIN ct_dow_listing l ON l.weekday_number = wn.weekday_number
),
ct_dow_exit_rows AS (
  SELECT wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(e.event_count, 0)              AS event_count,
    COALESCE(e.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS net_profit_sum,
    e.median_net_profit
  FROM cs_weekday_numbers wn LEFT JOIN ct_dow_exit e ON e.weekday_number = wn.weekday_number
),

ct_dow_acq_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(ISODOW FROM acquisition_date)::int AS weekday_number,
    COUNT(*)                                                              AS event_count,
    COUNT(DISTINCT acquisition_deal_id)                                   AS distinct_deal_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)   AS acquisition_value_sum
  FROM ct_base WHERE acq_date_reliable GROUP BY 1, 2, 3, 4
),
ct_dow_listing_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(ISODOW FROM first_listed_at)::int AS weekday_number, COUNT(*) AS event_count
  FROM ct_base WHERE listing_date_reliable GROUP BY 1, 2, 3, 4
),
ct_dow_exit_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status,
    EXTRACT(ISODOW FROM exit_date)::int AS weekday_number,
    COUNT(*)                                                                AS event_count,
    COUNT(DISTINCT exit_deal_id)                                            AS distinct_deal_count,
    SUM(exit_value)                                                         AS exit_value_sum,
    SUM(net_profit)                                                         AS net_profit_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2) AS median_net_profit
  FROM ct_base WHERE exit_date_reliable GROUP BY 1, 2, 3, 4
),
ct_dow_acq_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(a.event_count, 0)              AS event_count,
    COALESCE(a.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(a.acquisition_value_sum, 0)    AS acquisition_value_sum
  FROM ct_purposes p CROSS JOIN cs_weekday_numbers wn
  LEFT JOIN ct_dow_acq_purpose a ON a.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND a.purpose_policy_status = p.purpose_policy_status AND a.weekday_number = wn.weekday_number
),
ct_dow_listing_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(l.event_count, 0)              AS event_count
  FROM ct_purposes p CROSS JOIN cs_weekday_numbers wn
  LEFT JOIN ct_dow_listing_purpose l ON l.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND l.purpose_policy_status = p.purpose_policy_status AND l.weekday_number = wn.weekday_number
),
ct_dow_exit_purpose_rows AS (
  SELECT p.group_purpose_id AS current_purpose_id, p.group_purpose_name AS current_purpose_name, p.purpose_policy_status,
    wn.weekday_number,
    CASE wn.weekday_number WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday' END AS weekday_name,
    COALESCE(e.event_count, 0)              AS event_count,
    COALESCE(e.distinct_deal_count, 0)      AS distinct_deal_count,
    COALESCE(e.exit_value_sum, 0)           AS exit_value_sum,
    COALESCE(e.net_profit_sum, 0)           AS net_profit_sum,
    e.median_net_profit
  FROM ct_purposes p CROSS JOIN cs_weekday_numbers wn
  LEFT JOIN ct_dow_exit_purpose e ON e.group_purpose_id IS NOT DISTINCT FROM p.group_purpose_id AND e.purpose_policy_status = p.purpose_policy_status AND e.weekday_number = wn.weekday_number
),

-- ============================================================================
-- Section 5: current_month_to_date_pace (pooled only — see SCOPE DECISION
-- in the migration header)
-- ============================================================================
cs_mtd_params AS (
  SELECT
    a.tz, a.as_of_date,
    EXTRACT(YEAR FROM a.as_of_date)::int   AS current_year,
    EXTRACT(MONTH FROM a.as_of_date)::int  AS current_month,
    EXTRACT(DAY FROM a.as_of_date)::int    AS current_day_of_month,
    p.earliest_eligible_event_date
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
cs_mtd_prior_years AS (
  SELECT y AS year FROM cs_mtd_params mp, generate_series(EXTRACT(YEAR FROM mp.earliest_eligible_event_date)::int, mp.current_year - 1) AS y
),
cs_mtd_prior_windows AS (
  SELECT
    py.year,
    make_date(py.year, mp.current_month, 1) AS window_start,
    LEAST(
      mp.current_day_of_month,
      EXTRACT(DAY FROM (make_date(py.year, mp.current_month, 1) + interval '1 month - 1 day'))::int
    ) AS day_cutoff_used
  FROM cs_mtd_prior_years py, cs_mtd_params mp
),
cs_mtd_prior_windows2 AS (
  SELECT year, window_start, day_cutoff_used, make_date(year, EXTRACT(MONTH FROM window_start)::int, day_cutoff_used) AS window_end
  FROM cs_mtd_prior_windows
),
cs_mtd_prior_rows AS (
  SELECT
    w.year, w.day_cutoff_used, w.window_start, w.window_end,
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN w.window_start AND w.window_end) AS acquisition_item_count,
    COALESCE(SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN w.window_start AND w.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN w.window_start AND w.window_end) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end) AS realized_exit_item_count,
    COALESCE(SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end), 0) AS realized_exit_value_sum,
    COALESCE(SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end), 0) AS realized_net_profit_sum
  FROM cs_mtd_prior_windows2 w
  CROSS JOIN cs_base b
  GROUP BY w.year, w.day_cutoff_used, w.window_start, w.window_end
),
cs_mtd_prior_summary AS (
  SELECT
    COUNT(*)                                                                          AS comparable_prior_years_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_item_count)::numeric, 2)   AS median_acquisition_item_count,
    ROUND(AVG(acquisition_item_count)::numeric, 2)                                    AS average_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value_sum)::numeric, 2)    AS median_acquisition_value_sum,
    ROUND(AVG(acquisition_value_sum)::numeric, 2)                                     AS average_acquisition_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_listing_item_count)::numeric, 2) AS median_first_listing_item_count,
    ROUND(AVG(first_listing_item_count)::numeric, 2)                                  AS average_first_listing_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_item_count)::numeric, 2) AS median_realized_exit_item_count,
    ROUND(AVG(realized_exit_item_count)::numeric, 2)                                  AS average_realized_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_value_sum)::numeric, 2)  AS median_realized_exit_value_sum,
    ROUND(AVG(realized_exit_value_sum)::numeric, 2)                                   AS average_realized_exit_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_net_profit_sum)::numeric, 2)  AS median_realized_net_profit_sum,
    ROUND(AVG(realized_net_profit_sum)::numeric, 2)                                   AS average_realized_net_profit_sum
  FROM cs_mtd_prior_rows
),
cs_mtd_object AS (
  SELECT jsonb_build_object(
    'timezone', mp.tz,
    'as_of_date', mp.as_of_date,
    'current_year', mp.current_year,
    'current_month', mp.current_month,
    'current_day_of_month', mp.current_day_of_month,
    'current_month_to_date', jsonb_build_object(
      'acquisition_item_count', COALESCE(cur.acquisition_item_count, 0),
      'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0),
      'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0),
      'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0),
      'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0),
      'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0)
    ),
    'comparable_prior_years_count', COALESCE(sm.comparable_prior_years_count, 0),
    'comparable_prior_years', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.year), '[]'::jsonb) FROM cs_mtd_prior_rows r),
    'prior_year_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object(
        'acquisition_item_count', sm.median_acquisition_item_count,
        'acquisition_value_sum', sm.median_acquisition_value_sum,
        'first_listing_item_count', sm.median_first_listing_item_count,
        'realized_exit_item_count', sm.median_realized_exit_item_count,
        'realized_exit_value_sum', sm.median_realized_exit_value_sum,
        'realized_net_profit_sum', sm.median_realized_net_profit_sum
      ) END,
    'prior_year_average', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object(
        'acquisition_item_count', sm.average_acquisition_item_count,
        'acquisition_value_sum', sm.average_acquisition_value_sum,
        'first_listing_item_count', sm.average_first_listing_item_count,
        'realized_exit_item_count', sm.average_realized_exit_item_count,
        'realized_exit_value_sum', sm.average_realized_exit_value_sum,
        'realized_net_profit_sum', sm.average_realized_net_profit_sum
      ) END,
    'difference_vs_prior_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object(
        'acquisition_item_count', COALESCE(cur.acquisition_item_count, 0) - sm.median_acquisition_item_count,
        'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0) - sm.median_acquisition_value_sum,
        'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0) - sm.median_first_listing_item_count,
        'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0) - sm.median_realized_exit_item_count,
        'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0) - sm.median_realized_exit_value_sum,
        'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0) - sm.median_realized_net_profit_sum
      ) END,
    'status', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN 'insufficient_history' ELSE 'sufficient_history' END,
    'note', 'Descriptive month-to-date comparison only. Not a forecast for the completed current month.'
  ) AS payload
  FROM cs_mtd_params mp, cs_mtd_current cur, cs_mtd_prior_summary sm
),

ct_mtd_params AS (
  SELECT
    a.tz, a.as_of_date,
    EXTRACT(YEAR FROM a.as_of_date)::int   AS current_year,
    EXTRACT(MONTH FROM a.as_of_date)::int  AS current_month,
    EXTRACT(DAY FROM a.as_of_date)::int    AS current_day_of_month,
    p.earliest_eligible_event_date
  FROM cs_as_of a, ct_pop_row p
),
ct_mtd_current AS (
  SELECT
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS acquisition_item_count,
    SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date AND b.acquisition_value IS NOT NULL) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_exit_item_count,
    SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_exit_value_sum,
    SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN date_trunc('month', mp.as_of_date)::date AND mp.as_of_date) AS realized_net_profit_sum
  FROM ct_base b, ct_mtd_params mp
),
ct_mtd_prior_years AS (
  SELECT y AS year FROM ct_mtd_params mp, generate_series(EXTRACT(YEAR FROM mp.earliest_eligible_event_date)::int, mp.current_year - 1) AS y
),
ct_mtd_prior_windows AS (
  SELECT
    py.year,
    make_date(py.year, mp.current_month, 1) AS window_start,
    LEAST(
      mp.current_day_of_month,
      EXTRACT(DAY FROM (make_date(py.year, mp.current_month, 1) + interval '1 month - 1 day'))::int
    ) AS day_cutoff_used
  FROM ct_mtd_prior_years py, ct_mtd_params mp
),
ct_mtd_prior_windows2 AS (
  SELECT year, window_start, day_cutoff_used, make_date(year, EXTRACT(MONTH FROM window_start)::int, day_cutoff_used) AS window_end
  FROM ct_mtd_prior_windows
),
ct_mtd_prior_rows AS (
  SELECT
    w.year, w.day_cutoff_used, w.window_start, w.window_end,
    COUNT(*) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN w.window_start AND w.window_end) AS acquisition_item_count,
    COALESCE(SUM(b.acquisition_value) FILTER (WHERE b.acq_date_reliable AND b.acquisition_date BETWEEN w.window_start AND w.window_end AND b.acquisition_value IS NOT NULL), 0) AS acquisition_value_sum,
    COUNT(*) FILTER (WHERE b.listing_date_reliable AND b.first_listed_at BETWEEN w.window_start AND w.window_end) AS first_listing_item_count,
    COUNT(*) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end) AS realized_exit_item_count,
    COALESCE(SUM(b.exit_value) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end), 0) AS realized_exit_value_sum,
    COALESCE(SUM(b.net_profit) FILTER (WHERE b.exit_date_reliable AND b.exit_date BETWEEN w.window_start AND w.window_end), 0) AS realized_net_profit_sum
  FROM ct_mtd_prior_windows2 w
  CROSS JOIN ct_base b
  GROUP BY w.year, w.day_cutoff_used, w.window_start, w.window_end
),
ct_mtd_prior_summary AS (
  SELECT
    COUNT(*)                                                                          AS comparable_prior_years_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_item_count)::numeric, 2)   AS median_acquisition_item_count,
    ROUND(AVG(acquisition_item_count)::numeric, 2)                                    AS average_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY acquisition_value_sum)::numeric, 2)    AS median_acquisition_value_sum,
    ROUND(AVG(acquisition_value_sum)::numeric, 2)                                     AS average_acquisition_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_listing_item_count)::numeric, 2) AS median_first_listing_item_count,
    ROUND(AVG(first_listing_item_count)::numeric, 2)                                  AS average_first_listing_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_item_count)::numeric, 2) AS median_realized_exit_item_count,
    ROUND(AVG(realized_exit_item_count)::numeric, 2)                                  AS average_realized_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_exit_value_sum)::numeric, 2)  AS median_realized_exit_value_sum,
    ROUND(AVG(realized_exit_value_sum)::numeric, 2)                                   AS average_realized_exit_value_sum,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY realized_net_profit_sum)::numeric, 2)  AS median_realized_net_profit_sum,
    ROUND(AVG(realized_net_profit_sum)::numeric, 2)                                   AS average_realized_net_profit_sum
  FROM ct_mtd_prior_rows
),
ct_mtd_object AS (
  SELECT jsonb_build_object(
    'timezone', mp.tz,
    'as_of_date', mp.as_of_date,
    'current_year', mp.current_year,
    'current_month', mp.current_month,
    'current_day_of_month', mp.current_day_of_month,
    'current_month_to_date', jsonb_build_object(
      'acquisition_item_count', COALESCE(cur.acquisition_item_count, 0),
      'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0),
      'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0),
      'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0),
      'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0),
      'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0)
    ),
    'comparable_prior_years_count', COALESCE(sm.comparable_prior_years_count, 0),
    'comparable_prior_years', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.year), '[]'::jsonb) FROM ct_mtd_prior_rows r),
    'prior_year_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object(
        'acquisition_item_count', sm.median_acquisition_item_count,
        'acquisition_value_sum', sm.median_acquisition_value_sum,
        'first_listing_item_count', sm.median_first_listing_item_count,
        'realized_exit_item_count', sm.median_realized_exit_item_count,
        'realized_exit_value_sum', sm.median_realized_exit_value_sum,
        'realized_net_profit_sum', sm.median_realized_net_profit_sum
      ) END,
    'prior_year_average', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object(
        'acquisition_item_count', sm.average_acquisition_item_count,
        'acquisition_value_sum', sm.average_acquisition_value_sum,
        'first_listing_item_count', sm.average_first_listing_item_count,
        'realized_exit_item_count', sm.average_realized_exit_item_count,
        'realized_exit_value_sum', sm.average_realized_exit_value_sum,
        'realized_net_profit_sum', sm.average_realized_net_profit_sum
      ) END,
    'difference_vs_prior_median', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN NULL ELSE jsonb_build_object(
        'acquisition_item_count', COALESCE(cur.acquisition_item_count, 0) - sm.median_acquisition_item_count,
        'acquisition_value_sum', COALESCE(cur.acquisition_value_sum, 0) - sm.median_acquisition_value_sum,
        'first_listing_item_count', COALESCE(cur.first_listing_item_count, 0) - sm.median_first_listing_item_count,
        'realized_exit_item_count', COALESCE(cur.realized_exit_item_count, 0) - sm.median_realized_exit_item_count,
        'realized_exit_value_sum', COALESCE(cur.realized_exit_value_sum, 0) - sm.median_realized_exit_value_sum,
        'realized_net_profit_sum', COALESCE(cur.realized_net_profit_sum, 0) - sm.median_realized_net_profit_sum
      ) END,
    'status', CASE WHEN COALESCE(sm.comparable_prior_years_count, 0) = 0 THEN 'insufficient_history' ELSE 'sufficient_history' END,
    'note', 'Descriptive month-to-date comparison only. Not a forecast for the completed current month.'
  ) AS payload
  FROM ct_mtd_params mp, ct_mtd_current cur, ct_mtd_prior_summary sm
)

SELECT jsonb_build_object(
  'shared_calendar_seasonality_evidence', jsonb_build_object(
    'timezone', (SELECT tz FROM cs_as_of),
    'as_of_date', (SELECT as_of_date FROM cs_as_of),
    'population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_row)), '[]'::jsonb) FROM cs_pop_row),
    'purpose_population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_pop_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST), '[]'::jsonb) FROM cs_pop_purpose_rows),
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM cs_monthly_rows),
    'monthly_timeline_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_monthly_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_start), '[]'::jsonb) FROM cs_monthly_purpose_rows),
    'month_of_year_seasonality', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_moy_rows) ORDER BY month_number), '[]'::jsonb) FROM cs_moy_rows),
    'month_of_year_seasonality_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_moy_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_number), '[]'::jsonb) FROM cs_moy_purpose_rows),
    'day_of_week_acquisition_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_acq_rows) ORDER BY weekday_number), '[]'::jsonb) FROM cs_dow_acq_rows),
    'day_of_week_acquisition_activity_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_acq_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, weekday_number), '[]'::jsonb) FROM cs_dow_acq_purpose_rows),
    'day_of_week_first_listing_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_listing_rows) ORDER BY weekday_number), '[]'::jsonb) FROM cs_dow_listing_rows),
    'day_of_week_first_listing_activity_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_listing_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, weekday_number), '[]'::jsonb) FROM cs_dow_listing_purpose_rows),
    'day_of_week_realized_exit_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_exit_rows) ORDER BY weekday_number), '[]'::jsonb) FROM cs_dow_exit_rows),
    'day_of_week_realized_exit_activity_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cs_dow_exit_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, weekday_number), '[]'::jsonb) FROM cs_dow_exit_purpose_rows),
    'current_month_to_date_pace', (SELECT payload FROM cs_mtd_object)
  ),
  'target_user_calendar_seasonality_evidence', jsonb_build_object(
    'timezone', (SELECT tz FROM cs_as_of),
    'as_of_date', (SELECT as_of_date FROM cs_as_of),
    'population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_pop_row)), '[]'::jsonb) FROM ct_pop_row),
    'purpose_population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_pop_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST), '[]'::jsonb) FROM ct_pop_purpose_rows),
    'monthly_timeline', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_monthly_rows) ORDER BY month_start), '[]'::jsonb) FROM ct_monthly_rows),
    'monthly_timeline_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_monthly_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_start), '[]'::jsonb) FROM ct_monthly_purpose_rows),
    'month_of_year_seasonality', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_moy_rows) ORDER BY month_number), '[]'::jsonb) FROM ct_moy_rows),
    'month_of_year_seasonality_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_moy_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, month_number), '[]'::jsonb) FROM ct_moy_purpose_rows),
    'day_of_week_acquisition_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_dow_acq_rows) ORDER BY weekday_number), '[]'::jsonb) FROM ct_dow_acq_rows),
    'day_of_week_acquisition_activity_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_dow_acq_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, weekday_number), '[]'::jsonb) FROM ct_dow_acq_purpose_rows),
    'day_of_week_first_listing_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_dow_listing_rows) ORDER BY weekday_number), '[]'::jsonb) FROM ct_dow_listing_rows),
    'day_of_week_first_listing_activity_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_dow_listing_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, weekday_number), '[]'::jsonb) FROM ct_dow_listing_purpose_rows),
    'day_of_week_realized_exit_activity', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_dow_exit_rows) ORDER BY weekday_number), '[]'::jsonb) FROM ct_dow_exit_rows),
    'day_of_week_realized_exit_activity_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(ct_dow_exit_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      current_purpose_name NULLS LAST, weekday_number), '[]'::jsonb) FROM ct_dow_exit_purpose_rows),
    'current_month_to_date_pace', (SELECT payload FROM ct_mtd_object)
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_calendar_seasonality_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_calendar_seasonality_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_calendar_seasonality_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_calendar_seasonality_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_8(p_target_user_id int)
-- Calls build_analytics_snapshot_v2_7 WHOLESALE (which itself validates
-- p_target_user_id and RAISEs on failure — not repeated here), preserves
-- every v2.7 section unchanged, and adds shared_calendar_seasonality_
-- evidence / target_user_calendar_seasonality_evidence as new top-level
-- keys.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_8(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v27                    jsonb;
  v_generated_at            timestamptz := now();
  v_calendar_seasonality    jsonb;
BEGIN
  v_v27 := public.build_analytics_snapshot_v2_7(p_target_user_id);
  v_calendar_seasonality := public._build_calendar_seasonality_snapshot_v2(p_target_user_id);

  RETURN v_v27
    || jsonb_build_object(
         'snapshot_schema_version', '2.8',
         'analytics_definition_version', '2.8',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_calendar_seasonality_evidence', v_calendar_seasonality -> 'shared_calendar_seasonality_evidence',
         'target_user_calendar_seasonality_evidence', v_calendar_seasonality -> 'target_user_calendar_seasonality_evidence'
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_8(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_8(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_8(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_8(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_8(int) IS
  'Analytics v2.8 — Calendar & Seasonality — the current PRODUCTION '
  'analytics snapshot version. SECURITY INVOKER, service_role execution '
  'only. Calls build_analytics_snapshot_v2_7 wholesale (unchanged) and '
  'adds shared_calendar_seasonality_evidence / target_user_calendar_'
  'seasonality_evidence: population_and_date_coverage (population_summary'
  '/purpose_population_summary), a gap-filled monthly_timeline, '
  'month_of_year_seasonality with distinct-year-aware confidence, three '
  'independent day_of_week_* activity arrays (acquisition/first-listing/'
  'realized-exit), and a pooled current_month_to_date_pace comparing the '
  'current America/Toronto month-to-date window against the same '
  'calendar-day cutoff in prior years. Descriptive evidence only — no '
  'forecast, recommendation, urgency, score, or item-level row. '
  'v1.0-v1.8 and v2.0-v2.7 are completely unaffected. Persists nothing — '
  'see analytics_runs (20260727000000) for the persistence step. See '
  'analytics/README.md and analytics/SEMANTIC_CONTRACT.md for the full '
  'v2.8 contract.';
