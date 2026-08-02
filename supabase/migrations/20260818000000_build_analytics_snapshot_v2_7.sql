-- build_analytics_snapshot_v2_7
--
-- Analytics v2.7 — Capital & Liquidity. Ports one v1 module to Purpose-
-- aware v2 semantics: Capital & Liquidity (analytics/sql/09_capital_
-- liquidity.sql). Adds a NEW helper and a NEW top-level builder that
-- calls build_analytics_snapshot_v2_6 WHOLESALE and adds two new
-- top-level sections, shared_capital_liquidity_evidence and target_user_
-- capital_liquidity_evidence. Does NOT call, embed, or replace any
-- v1.0-v1.8 or v2.0-v2.6 builder — those remain entirely unchanged and
-- independently callable. Open Inventory Decision Support, Listing
-- Channel Exposure, and the Deal Channel modules are NOT touched by this
-- migration.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_capital_liquidity_snapshot_v2(int)  -- NEW
--   public.build_analytics_snapshot_v2_7(int)           -- NEW
--
-- ── POPULATION — EVERY ITEM, EVERY PURPOSE ───────────────────────────────
-- Unlike v1.x (purpose_name = 'Business' only), this module reads
-- analytics_item_lifecycle_v2's full population: Business, Hybrid,
-- Personal, missing_purpose, missing_policy. Purpose is a CURRENT
-- disposition policy, not an economic eligibility filter and not proven
-- historical intent — never presented as "Purpose at acquisition,
-- listing, or exit time." Every section is produced twice: once pooled
-- across ALL purposes, once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status), using the same missing-
-- purpose/missing-policy collapsing rule established in v2.0 and reused
-- by every v2 module since.
--
-- ── PURPOSE-AWARE INTERPRETATION — NEUTRAL BUCKETS, NO UNIVERSAL URGENCY ──
-- 09_capital_liquidity.sql's own bucket labels and interpretation
-- safeguards were reviewed for judgmental/urgency language before
-- porting: they were already neutral ("0-29 days" / "30-59 days" /
-- "60-119 days" / "120+ days" / "unreliable/unknown age" — no "stale",
-- "slow", or "trapped" label anywhere), and the file's own safeguard
-- already warns "Old inventory is NOT automatically bad inventory." This
-- module ports those SAME neutral buckets and calculations unchanged,
-- and additionally joins `public.analytics_purpose_policy` onto every
-- `*_by_purpose` row's `purpose_population_summary` entry — surfacing
-- the EXISTING, already-reviewed policy fields (`disposition_mode`,
-- `realization_priority_order`, `active_realization_flag`,
-- `expected_holding_policy`, `description`) as the ONLY source of
-- Purpose-level interpretive framing. No new judgmental label, score, or
-- universal "stale"/"trapped"/urgency interpretation is invented here:
-- Business's policy row already reads 'shorter_holding_preferred',
-- Hybrid's 'extended_holding_acceptable', Personal's 'long_holding_
-- acceptable' — the same held-time buckets are simply reported ALONGSIDE
-- that pre-existing, already-reviewed policy context, letting a reader
-- apply the correct interpretation per Purpose instead of this module
-- applying one for them. This module does NOT encode any operator's
-- personal inventory-reduction goal for any Purpose as a rule — it
-- reports capital and liquidity facts only.
--
-- ── SCOPE DECISION — ALL SIX v1 QUERIES ARE PRODUCTION EVIDENCE ──────────
-- 09_capital_liquidity.sql's own "QUERY CLASSIFICATION INDEX" self-
-- classifies EVERY one of its six queries as shared aggregate evidence —
-- none are developer-only diagnostics, and none are superseded by
-- Purpose-aware OIDS (v2.1's Open Inventory Decision Support reports
-- ITEM-LEVEL decision evidence with reason codes for one target user;
-- this module reports only AGGREGATE capital/liquidity totals across
-- buckets — genuinely different scope, never duplicated here). All six
-- are therefore ported in full:
--   Query A -> population_summary (capital position summary)
--   Query B -> open_capital_by_age_bucket (mutually exclusive buckets)
--   Query C -> open_capital_by_acquisition_band (positive value only)
--   Query D -> open_capital_by_acquisition_method
--   Query E -> realized_capital_efficiency_by_acquisition_band (positive
--     value, realized only)
--   Query F -> realized_capital_efficiency_by_acquisition_method (same
--     population as E)
--
-- ── SEMANTIC RULES PRESERVED FROM v1 ──────────────────────────────────────
-- - This module reports CAPITAL (acquisition value assigned to
--   inventory), never a user's cash_flow/cash-balance ledger — that
--   remains a wholly separate subsystem, not read anywhere here.
-- - Positive acquisition value contributes to every acquisition-capital
--   total. Zero-assigned value remains visible in coverage and
--   contributes exactly $0 to any SUM (never excluded, never NULL-ing
--   the whole SUM). Unknown (NULL) acquisition value remains visible in
--   coverage but is excluded from capital SUMs by ordinary NULL
--   propagation — never silently $0, never inflating a total.
-- - Historical Imports are INCLUDED in acquisition capital, realized
--   profit, ROI, values, listing state, and estimated upside — none of
--   that depends on the one approximate field (acquisition_date). They
--   are EXCLUDED from every acquisition-date-dependent metric: ownership
--   age, holding days, profit-per-30-holding-days, and any other
--   time-normalized capital-efficiency figure. Rows with has_lifecycle_
--   date_issue are excluded from the same metrics regardless of Purpose.
--   DOM (global_days_on_market) is NOT excluded for historical imports —
--   a historical acquisition does not make a real, currently-ticking
--   listing/exit date untrustworthy.
-- - Open capital age buckets (0-29/30-59/60-119/120+ days, plus
--   "unreliable/unknown age" for historical imports, NULL holding_days,
--   or a lifecycle date issue) are MUTUALLY EXCLUSIVE — every open item
--   lands in exactly one bucket.
-- - Every `*_capital_percent` field divides by the SAME denominator
--   within its scope: the pooled rows use total open acquisition capital
--   across ALL open items of that scope (shared: every user; target:
--   that user only); the `_by_purpose` rows use that Purpose's own total
--   open acquisition capital, so percentages sum to ~100% within their
--   own scope. Always paired with the raw capital amount, never shown
--   alone.
-- - `profit_to_acquisition_capital_percent` (population_summary, Query
--   E/F) is an AGGREGATE descriptive ratio (SUM(net_profit) /
--   SUM(acquisition_value) * 100), never a substitute for `median_roi`
--   (the median of each item's own ratio) — the two answer different
--   questions and are never conflated.
-- - `median_net_profit_per_30_holding_days` (Query E/F) is computed PER
--   ITEM FIRST (net_profit / holding_days * 30, restricted to realized,
--   non-historical, holding_days > 0, no lifecycle date issue), THEN
--   medianed — never a group-level ratio of medians.
-- (`time_efficiency_sample_size` is always reported alongside it.
-- - Every ratio divides with NULLIF(..., 0) — a zero-capital denominator
--   yields NULL, never Infinity or a crash.
-- - Additive totals (counts, capital sums) return 0 for an empty group;
--   medians/percentiles/ROI/durations remain NULL when no valid sample
--   exists — never fabricated as 0, and never treated as zero when
--   merely unreliable/missing. Confidence is tiered from the row's own
--   item count (1-2 insufficient, 3-5 low, 6-9 moderate, 10+ stronger),
--   unchanged from 09's own convention.
-- - This module never duplicates OIDS' item-level decision evidence — no
--   item_id, item row, reason code, or recommendation is produced
--   anywhere here.
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- shared_capital_liquidity_evidence pools every user's items (aggregate
-- only — no item_id, item name, model, notes, or other item identity,
-- and no row grouped by user_id). target_user_capital_liquidity_evidence
-- is filtered to `user_id = p_target_user_id` and is, like the shared
-- section, aggregate only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_capital_liquidity_snapshot_v2(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH all_items AS (
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
    END AS acquisition_value_band_label,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
target_items AS (
  SELECT * FROM all_items WHERE user_id = p_target_user_id
),

-- ============================================================================
-- Capital & Liquidity — SHARED (pooled, all users)
-- ============================================================================

-- population_summary / purpose_population_summary (Query A). The
-- purpose-breakdown rows additionally LEFT JOIN analytics_purpose_policy
-- — the ONLY source of Purpose-level interpretive framing this module
-- surfaces (disposition_mode / realization_priority_order /
-- active_realization_flag / expected_holding_policy / description),
-- NULL for missing_purpose/missing_policy rows (no policy row exists to
-- join).
cl_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'negative_invalid')          AS negative_acquisition_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND acquisition_value IS NOT NULL) AS listed_open_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed' AND acquisition_value IS NOT NULL) AS unlisted_open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(SUM(net_profit) FILTER (WHERE is_realized) / NULLIF(SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL), 0) * 100, 2) AS realized_profit_to_acquisition_capital_percent,
    COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)        AS estimated_open_net_upside,
    ROUND(SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) / NULLIF(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL), 0) * 100, 2) AS open_capital_percent_of_total_capital
  FROM all_items
),
cl_pop_purpose_rows AS (
  SELECT
    ai.group_purpose_id AS current_purpose_id, ai.group_purpose_name AS current_purpose_name, ai.purpose_policy_status,
    pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description AS purpose_policy_description,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE ai.is_realized)                                         AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized)                                     AS open_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'positive')               AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'zero_assigned')          AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'unknown')                AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'negative_invalid')       AS negative_acquisition_item_count,
    SUM(ai.acquisition_value) FILTER (WHERE ai.acquisition_value IS NOT NULL)      AS total_acquisition_capital,
    SUM(ai.acquisition_value) FILTER (WHERE ai.is_realized AND ai.acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.acquisition_value IS NOT NULL) AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.current_status = 'listed')    AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.current_status <> 'listed')   AS unlisted_open_item_count,
    SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.current_status = 'listed' AND ai.acquisition_value IS NOT NULL) AS listed_open_acquisition_capital,
    SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.current_status <> 'listed' AND ai.acquisition_value IS NOT NULL) AS unlisted_open_acquisition_capital,
    SUM(ai.net_profit) FILTER (WHERE ai.is_realized)                               AS total_realized_net_profit,
    ROUND(SUM(ai.net_profit) FILTER (WHERE ai.is_realized) / NULLIF(SUM(ai.acquisition_value) FILTER (WHERE ai.is_realized AND ai.acquisition_value IS NOT NULL), 0) * 100, 2) AS realized_profit_to_acquisition_capital_percent,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
    SUM(ai.estimated_sold_value - ai.acquisition_value - ai.item_expenses_total)
      FILTER (WHERE NOT ai.is_realized AND ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NOT NULL)        AS estimated_open_net_upside,
    ROUND(SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.acquisition_value IS NOT NULL) / NULLIF(SUM(ai.acquisition_value) FILTER (WHERE ai.acquisition_value IS NOT NULL), 0) * 100, 2) AS open_capital_percent_of_total_capital
  FROM all_items ai
  LEFT JOIN public.analytics_purpose_policy pp ON pp.purpose_id = ai.group_purpose_id AND ai.purpose_policy_status = 'mapped'
  GROUP BY ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description
),

-- Denominators for open_capital_percent in Query B/C/D. Pooled rows use
-- the scope-wide open-capital total; _by_purpose rows use that Purpose's
-- own open-capital total, so percentages sum to ~100% within their scope.
cl_total_open_capital_pooled AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM all_items WHERE NOT is_realized
),
cl_total_open_capital_by_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount
  FROM all_items WHERE NOT is_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- open_capital_by_age_bucket / ..._by_purpose (Query B) — MUTUALLY
-- EXCLUSIVE buckets; historical imports / NULL holding_days / a
-- lifecycle date issue always land in "unreliable/unknown age", never a
-- calendar bucket.
cl_open_aged AS (
  SELECT
    *,
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
  FROM all_items
  WHERE NOT is_realized
),
cl_age_rows AS (
  SELECT
    age_bucket_order, age_bucket_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT amount FROM cl_total_open_capital_pooled), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count
  FROM cl_open_aged
  GROUP BY age_bucket_order, age_bucket_label
),
cl_age_purpose_rows AS (
  SELECT
    o.group_purpose_id AS current_purpose_id, o.group_purpose_name AS current_purpose_name, o.purpose_policy_status,
    o.age_bucket_order, o.age_bucket_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)        AS open_acquisition_capital,
    ROUND(SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT t.amount FROM cl_total_open_capital_by_purpose t WHERE t.group_purpose_id IS NOT DISTINCT FROM o.group_purpose_id AND t.purpose_policy_status = o.purpose_policy_status), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE o.current_status = 'listed')                            AS listed_item_count,
    COUNT(*) FILTER (WHERE o.current_status <> 'listed')                           AS unlisted_item_count,
    COUNT(*) FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(o.estimated_sold_value - o.acquisition_value - o.item_expenses_total)
      FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE o.acquisition_value_status = 'zero_assigned')           AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE o.acquisition_value_status = 'unknown')                 AS acquisition_value_unknown_count
  FROM cl_open_aged o
  GROUP BY o.group_purpose_id, o.group_purpose_name, o.purpose_policy_status, o.age_bucket_order, o.age_bucket_label
),

-- open_capital_by_acquisition_band / ..._by_purpose (Query C) —
-- restricted to acquisition_value_status = 'positive', matching every
-- other module's band convention.
cl_open_items AS (
  SELECT * FROM all_items WHERE NOT is_realized
),
cl_band_eligible AS (
  SELECT * FROM cl_open_items WHERE acquisition_value_status = 'positive'
),
cl_band_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value)                                                         AS open_acquisition_capital,
    ROUND(SUM(acquisition_value)::numeric / NULLIF((SELECT amount FROM cl_total_open_capital_pooled), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL)                       AS estimated_upside_available_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total) FILTER (WHERE estimated_sold_value IS NOT NULL) AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM cl_band_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
cl_band_purpose_rows AS (
  SELECT
    b.group_purpose_id AS current_purpose_id, b.group_purpose_name AS current_purpose_name, b.purpose_policy_status,
    b.acquisition_value_band_order, b.acquisition_value_band_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(b.acquisition_value)                                                       AS open_acquisition_capital,
    ROUND(SUM(b.acquisition_value)::numeric / NULLIF((SELECT t.amount FROM cl_total_open_capital_by_purpose t WHERE t.group_purpose_id IS NOT DISTINCT FROM b.group_purpose_id AND t.purpose_policy_status = b.purpose_policy_status), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE b.current_status = 'listed')                            AS listed_item_count,
    COUNT(*) FILTER (WHERE b.current_status <> 'listed')                           AS unlisted_item_count,
    COUNT(*) FILTER (WHERE b.estimated_sold_value IS NOT NULL)                     AS estimated_upside_available_count,
    SUM(b.estimated_sold_value - b.acquisition_value - b.item_expenses_total) FILTER (WHERE b.estimated_sold_value IS NOT NULL) AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.holding_days) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue AND b.holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue AND b.holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE b.is_historical_import)                                 AS historical_excluded_from_age_count
  FROM cl_band_eligible b
  GROUP BY b.group_purpose_id, b.group_purpose_name, b.purpose_policy_status, b.acquisition_value_band_order, b.acquisition_value_band_label
),

-- open_capital_by_acquisition_method / ..._by_purpose (Query D) — open
-- items, ALL acquisition-value statuses (not restricted to positive,
-- unlike Query C).
cl_method_rows AS (
  SELECT
    COALESCE(acquisition_method, 'unknown')                                        AS acquisition_method,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT amount FROM cl_total_open_capital_pooled), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM cl_open_items
  GROUP BY COALESCE(acquisition_method, 'unknown')
),
cl_method_purpose_rows AS (
  SELECT
    o.group_purpose_id AS current_purpose_id, o.group_purpose_name AS current_purpose_name, o.purpose_policy_status,
    COALESCE(o.acquisition_method, 'unknown')                                      AS acquisition_method,
    COUNT(*)                                                                       AS open_item_count,
    SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)        AS open_acquisition_capital,
    ROUND(SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT t.amount FROM cl_total_open_capital_by_purpose t WHERE t.group_purpose_id IS NOT DISTINCT FROM o.group_purpose_id AND t.purpose_policy_status = o.purpose_policy_status), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE o.current_status = 'listed')                            AS listed_item_count,
    COUNT(*) FILTER (WHERE o.current_status <> 'listed')                           AS unlisted_item_count,
    SUM(o.estimated_sold_value - o.acquisition_value - o.item_expenses_total)
      FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NOT NULL)     AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.holding_days) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue AND o.holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue AND o.holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE o.is_historical_import)                                 AS historical_excluded_from_age_count
  FROM cl_open_items o
  GROUP BY o.group_purpose_id, o.group_purpose_name, o.purpose_policy_status, COALESCE(o.acquisition_method, 'unknown')
),

-- realized_capital_efficiency_by_acquisition_band / ..._by_purpose
-- (Query E) and realized_capital_efficiency_by_acquisition_method /
-- ..._by_purpose (Query F) — realized items, acquisition_value_status =
-- 'positive' only (capital efficiency is undefined otherwise).
cl_eff_eligible AS (
  SELECT
    *,
    CASE
      WHEN NOT is_historical_import AND holding_days IS NOT NULL AND holding_days > 0 AND NOT has_lifecycle_date_issue
        THEN (net_profit / holding_days::numeric) * 30
    END AS net_profit_per_30_holding_days
  FROM all_items
  WHERE is_realized AND acquisition_value_status = 'positive'
),
cl_effband_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cl_eff_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
cl_effband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    acquisition_value_band_order, acquisition_value_band_label,
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cl_eff_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_value_band_order, acquisition_value_band_label
),
cl_effmethod_rows AS (
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cl_eff_eligible
  GROUP BY acquisition_method
),
cl_effmethod_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cl_eff_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_method
),
-- Capital & Liquidity — TARGET USER ONLY
-- ============================================================================

-- population_summary / purpose_population_summary (Query A). The
-- purpose-breakdown rows additionally LEFT JOIN analytics_purpose_policy
-- — the ONLY source of Purpose-level interpretive framing this module
-- surfaces (disposition_mode / realization_priority_order /
-- active_realization_flag / expected_holding_policy / description),
-- NULL for missing_purpose/missing_policy rows (no policy row exists to
-- join).
ct_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'negative_invalid')          AS negative_acquisition_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND acquisition_value IS NOT NULL) AS listed_open_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed' AND acquisition_value IS NOT NULL) AS unlisted_open_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(SUM(net_profit) FILTER (WHERE is_realized) / NULLIF(SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL), 0) * 100, 2) AS realized_profit_to_acquisition_capital_percent,
    COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)        AS estimated_open_net_upside,
    ROUND(SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) / NULLIF(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL), 0) * 100, 2) AS open_capital_percent_of_total_capital
  FROM target_items
),
ct_pop_purpose_rows AS (
  SELECT
    ai.group_purpose_id AS current_purpose_id, ai.group_purpose_name AS current_purpose_name, ai.purpose_policy_status,
    pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description AS purpose_policy_description,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE ai.is_realized)                                         AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized)                                     AS open_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'positive')               AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'zero_assigned')          AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'unknown')                AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE ai.acquisition_value_status = 'negative_invalid')       AS negative_acquisition_item_count,
    SUM(ai.acquisition_value) FILTER (WHERE ai.acquisition_value IS NOT NULL)      AS total_acquisition_capital,
    SUM(ai.acquisition_value) FILTER (WHERE ai.is_realized AND ai.acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.acquisition_value IS NOT NULL) AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.current_status = 'listed')    AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.current_status <> 'listed')   AS unlisted_open_item_count,
    SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.current_status = 'listed' AND ai.acquisition_value IS NOT NULL) AS listed_open_acquisition_capital,
    SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.current_status <> 'listed' AND ai.acquisition_value IS NOT NULL) AS unlisted_open_acquisition_capital,
    SUM(ai.net_profit) FILTER (WHERE ai.is_realized)                               AS total_realized_net_profit,
    ROUND(SUM(ai.net_profit) FILTER (WHERE ai.is_realized) / NULLIF(SUM(ai.acquisition_value) FILTER (WHERE ai.is_realized AND ai.acquisition_value IS NOT NULL), 0) * 100, 2) AS realized_profit_to_acquisition_capital_percent,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
    SUM(ai.estimated_sold_value - ai.acquisition_value - ai.item_expenses_total)
      FILTER (WHERE NOT ai.is_realized AND ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NOT NULL)        AS estimated_open_net_upside,
    ROUND(SUM(ai.acquisition_value) FILTER (WHERE NOT ai.is_realized AND ai.acquisition_value IS NOT NULL) / NULLIF(SUM(ai.acquisition_value) FILTER (WHERE ai.acquisition_value IS NOT NULL), 0) * 100, 2) AS open_capital_percent_of_total_capital
  FROM target_items ai
  LEFT JOIN public.analytics_purpose_policy pp ON pp.purpose_id = ai.group_purpose_id AND ai.purpose_policy_status = 'mapped'
  GROUP BY ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description
),

-- Denominators for open_capital_percent in Query B/C/D. Pooled rows use
-- the scope-wide open-capital total; _by_purpose rows use that Purpose's
-- own open-capital total, so percentages sum to ~100% within their scope.
ct_total_open_capital_pooled AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM target_items WHERE NOT is_realized
),
ct_total_open_capital_by_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount
  FROM target_items WHERE NOT is_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- open_capital_by_age_bucket / ..._by_purpose (Query B) — MUTUALLY
-- EXCLUSIVE buckets; historical imports / NULL holding_days / a
-- lifecycle date issue always land in "unreliable/unknown age", never a
-- calendar bucket.
ct_open_aged AS (
  SELECT
    *,
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
  FROM target_items
  WHERE NOT is_realized
),
ct_age_rows AS (
  SELECT
    age_bucket_order, age_bucket_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT amount FROM ct_total_open_capital_pooled), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count
  FROM ct_open_aged
  GROUP BY age_bucket_order, age_bucket_label
),
ct_age_purpose_rows AS (
  SELECT
    o.group_purpose_id AS current_purpose_id, o.group_purpose_name AS current_purpose_name, o.purpose_policy_status,
    o.age_bucket_order, o.age_bucket_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)        AS open_acquisition_capital,
    ROUND(SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT t.amount FROM ct_total_open_capital_by_purpose t WHERE t.group_purpose_id IS NOT DISTINCT FROM o.group_purpose_id AND t.purpose_policy_status = o.purpose_policy_status), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE o.current_status = 'listed')                            AS listed_item_count,
    COUNT(*) FILTER (WHERE o.current_status <> 'listed')                           AS unlisted_item_count,
    COUNT(*) FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(o.estimated_sold_value - o.acquisition_value - o.item_expenses_total)
      FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE o.acquisition_value_status = 'zero_assigned')           AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE o.acquisition_value_status = 'unknown')                 AS acquisition_value_unknown_count
  FROM ct_open_aged o
  GROUP BY o.group_purpose_id, o.group_purpose_name, o.purpose_policy_status, o.age_bucket_order, o.age_bucket_label
),

-- open_capital_by_acquisition_band / ..._by_purpose (Query C) —
-- restricted to acquisition_value_status = 'positive', matching every
-- other module's band convention.
ct_open_items AS (
  SELECT * FROM target_items WHERE NOT is_realized
),
ct_band_eligible AS (
  SELECT * FROM ct_open_items WHERE acquisition_value_status = 'positive'
),
ct_band_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value)                                                         AS open_acquisition_capital,
    ROUND(SUM(acquisition_value)::numeric / NULLIF((SELECT amount FROM ct_total_open_capital_pooled), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL)                       AS estimated_upside_available_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total) FILTER (WHERE estimated_sold_value IS NOT NULL) AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM ct_band_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
ct_band_purpose_rows AS (
  SELECT
    b.group_purpose_id AS current_purpose_id, b.group_purpose_name AS current_purpose_name, b.purpose_policy_status,
    b.acquisition_value_band_order, b.acquisition_value_band_label,
    COUNT(*)                                                                       AS open_item_count,
    SUM(b.acquisition_value)                                                       AS open_acquisition_capital,
    ROUND(SUM(b.acquisition_value)::numeric / NULLIF((SELECT t.amount FROM ct_total_open_capital_by_purpose t WHERE t.group_purpose_id IS NOT DISTINCT FROM b.group_purpose_id AND t.purpose_policy_status = b.purpose_policy_status), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE b.current_status = 'listed')                            AS listed_item_count,
    COUNT(*) FILTER (WHERE b.current_status <> 'listed')                           AS unlisted_item_count,
    COUNT(*) FILTER (WHERE b.estimated_sold_value IS NOT NULL)                     AS estimated_upside_available_count,
    SUM(b.estimated_sold_value - b.acquisition_value - b.item_expenses_total) FILTER (WHERE b.estimated_sold_value IS NOT NULL) AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.holding_days) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue AND b.holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT b.is_historical_import AND b.holding_days IS NOT NULL AND NOT b.has_lifecycle_date_issue AND b.holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE b.is_historical_import)                                 AS historical_excluded_from_age_count
  FROM ct_band_eligible b
  GROUP BY b.group_purpose_id, b.group_purpose_name, b.purpose_policy_status, b.acquisition_value_band_order, b.acquisition_value_band_label
),

-- open_capital_by_acquisition_method / ..._by_purpose (Query D) — open
-- items, ALL acquisition-value statuses (not restricted to positive,
-- unlike Query C).
ct_method_rows AS (
  SELECT
    COALESCE(acquisition_method, 'unknown')                                        AS acquisition_method,
    COUNT(*)                                                                       AS open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT amount FROM ct_total_open_capital_pooled), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS unlisted_item_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM ct_open_items
  GROUP BY COALESCE(acquisition_method, 'unknown')
),
ct_method_purpose_rows AS (
  SELECT
    o.group_purpose_id AS current_purpose_id, o.group_purpose_name AS current_purpose_name, o.purpose_policy_status,
    COALESCE(o.acquisition_method, 'unknown')                                      AS acquisition_method,
    COUNT(*)                                                                       AS open_item_count,
    SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)        AS open_acquisition_capital,
    ROUND(SUM(o.acquisition_value) FILTER (WHERE o.acquisition_value IS NOT NULL)::numeric / NULLIF((SELECT t.amount FROM ct_total_open_capital_by_purpose t WHERE t.group_purpose_id IS NOT DISTINCT FROM o.group_purpose_id AND t.purpose_policy_status = o.purpose_policy_status), 0) * 100, 2) AS open_capital_percent,
    COUNT(*) FILTER (WHERE o.current_status = 'listed')                            AS listed_item_count,
    COUNT(*) FILTER (WHERE o.current_status <> 'listed')                           AS unlisted_item_count,
    SUM(o.estimated_sold_value - o.acquisition_value - o.item_expenses_total)
      FILTER (WHERE o.estimated_sold_value IS NOT NULL AND o.acquisition_value IS NOT NULL)     AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY o.holding_days) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue AND o.holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT o.is_historical_import AND o.holding_days IS NOT NULL AND NOT o.has_lifecycle_date_issue AND o.holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE o.is_historical_import)                                 AS historical_excluded_from_age_count
  FROM ct_open_items o
  GROUP BY o.group_purpose_id, o.group_purpose_name, o.purpose_policy_status, COALESCE(o.acquisition_method, 'unknown')
),

-- realized_capital_efficiency_by_acquisition_band / ..._by_purpose
-- (Query E) and realized_capital_efficiency_by_acquisition_method /
-- ..._by_purpose (Query F) — realized items, acquisition_value_status =
-- 'positive' only (capital efficiency is undefined otherwise).
ct_eff_eligible AS (
  SELECT
    *,
    CASE
      WHEN NOT is_historical_import AND holding_days IS NOT NULL AND holding_days > 0 AND NOT has_lifecycle_date_issue
        THEN (net_profit / holding_days::numeric) * 30
    END AS net_profit_per_30_holding_days
  FROM target_items
  WHERE is_realized AND acquisition_value_status = 'positive'
),
ct_effband_rows AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ct_eff_eligible
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
ct_effband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    acquisition_value_band_order, acquisition_value_band_label,
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ct_eff_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_value_band_order, acquisition_value_band_label
),
ct_effmethod_rows AS (
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ct_eff_eligible
  GROUP BY acquisition_method
),
ct_effmethod_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
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
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ct_eff_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, acquisition_method
)

SELECT jsonb_build_object(
  'shared_capital_liquidity_evidence', jsonb_build_object(
    'population_summary',                                              (SELECT COALESCE(jsonb_agg(to_jsonb(cl_pop_row)), '[]'::jsonb) FROM cl_pop_row),
    'purpose_population_summary',                                       (SELECT COALESCE(jsonb_agg(to_jsonb(cl_pop_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST), '[]'::jsonb) FROM cl_pop_purpose_rows),
    'open_capital_by_age_bucket',                                       (SELECT COALESCE(jsonb_agg(to_jsonb(cl_age_rows) ORDER BY age_bucket_order), '[]'::jsonb) FROM cl_age_rows),
    'open_capital_by_age_bucket_by_purpose',                            (SELECT COALESCE(jsonb_agg(to_jsonb(cl_age_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, age_bucket_order), '[]'::jsonb) FROM cl_age_purpose_rows),
    'open_capital_by_acquisition_band',                                 (SELECT COALESCE(jsonb_agg(to_jsonb(cl_band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM cl_band_rows),
    'open_capital_by_acquisition_band_by_purpose',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cl_band_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cl_band_purpose_rows),
    'open_capital_by_acquisition_method',                               (SELECT COALESCE(jsonb_agg(to_jsonb(cl_method_rows) ORDER BY acquisition_method), '[]'::jsonb) FROM cl_method_rows),
    'open_capital_by_acquisition_method_by_purpose',                    (SELECT COALESCE(jsonb_agg(to_jsonb(cl_method_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM cl_method_purpose_rows),
    'realized_capital_efficiency_by_acquisition_band',                  (SELECT COALESCE(jsonb_agg(to_jsonb(cl_effband_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM cl_effband_rows),
    'realized_capital_efficiency_by_acquisition_band_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(cl_effband_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM cl_effband_purpose_rows),
    'realized_capital_efficiency_by_acquisition_method',                (SELECT COALESCE(jsonb_agg(to_jsonb(cl_effmethod_rows) ORDER BY acquisition_method), '[]'::jsonb) FROM cl_effmethod_rows),
    'realized_capital_efficiency_by_acquisition_method_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(cl_effmethod_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM cl_effmethod_purpose_rows)
  ),
  'target_user_capital_liquidity_evidence', jsonb_build_object(
    'population_summary',                                              (SELECT COALESCE(jsonb_agg(to_jsonb(ct_pop_row)), '[]'::jsonb) FROM ct_pop_row),
    'purpose_population_summary',                                       (SELECT COALESCE(jsonb_agg(to_jsonb(ct_pop_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST), '[]'::jsonb) FROM ct_pop_purpose_rows),
    'open_capital_by_age_bucket',                                       (SELECT COALESCE(jsonb_agg(to_jsonb(ct_age_rows) ORDER BY age_bucket_order), '[]'::jsonb) FROM ct_age_rows),
    'open_capital_by_age_bucket_by_purpose',                            (SELECT COALESCE(jsonb_agg(to_jsonb(ct_age_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, age_bucket_order), '[]'::jsonb) FROM ct_age_purpose_rows),
    'open_capital_by_acquisition_band',                                 (SELECT COALESCE(jsonb_agg(to_jsonb(ct_band_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM ct_band_rows),
    'open_capital_by_acquisition_band_by_purpose',                      (SELECT COALESCE(jsonb_agg(to_jsonb(ct_band_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM ct_band_purpose_rows),
    'open_capital_by_acquisition_method',                               (SELECT COALESCE(jsonb_agg(to_jsonb(ct_method_rows) ORDER BY acquisition_method), '[]'::jsonb) FROM ct_method_rows),
    'open_capital_by_acquisition_method_by_purpose',                    (SELECT COALESCE(jsonb_agg(to_jsonb(ct_method_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM ct_method_purpose_rows),
    'realized_capital_efficiency_by_acquisition_band',                  (SELECT COALESCE(jsonb_agg(to_jsonb(ct_effband_rows) ORDER BY acquisition_value_band_order), '[]'::jsonb) FROM ct_effband_rows),
    'realized_capital_efficiency_by_acquisition_band_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(ct_effband_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM ct_effband_purpose_rows),
    'realized_capital_efficiency_by_acquisition_method',                (SELECT COALESCE(jsonb_agg(to_jsonb(ct_effmethod_rows) ORDER BY acquisition_method), '[]'::jsonb) FROM ct_effmethod_rows),
    'realized_capital_efficiency_by_acquisition_method_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(ct_effmethod_purpose_rows) ORDER BY
                                                                            CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                                            current_purpose_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM ct_effmethod_purpose_rows)
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_capital_liquidity_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_capital_liquidity_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_capital_liquidity_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_capital_liquidity_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_7(p_target_user_id int)
-- Calls build_analytics_snapshot_v2_6 WHOLESALE (which itself validates
-- p_target_user_id and RAISEs on failure — not repeated here), preserves
-- every v2.6 section unchanged, and adds shared_capital_liquidity_
-- evidence / target_user_capital_liquidity_evidence as new top-level
-- keys.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_7(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v26               jsonb;
  v_generated_at       timestamptz := now();
  v_capital_liquidity  jsonb;
BEGIN
  v_v26 := public.build_analytics_snapshot_v2_6(p_target_user_id);
  v_capital_liquidity := public._build_capital_liquidity_snapshot_v2(p_target_user_id);

  RETURN v_v26
    || jsonb_build_object(
         'snapshot_schema_version', '2.7',
         'analytics_definition_version', '2.7',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_capital_liquidity_evidence', v_capital_liquidity -> 'shared_capital_liquidity_evidence',
         'target_user_capital_liquidity_evidence', v_capital_liquidity -> 'target_user_capital_liquidity_evidence'
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_7(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_7(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_7(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_7(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_7(int) IS
  'Analytics v2.7 — Capital & Liquidity — the current PRODUCTION '
  'analytics snapshot version. SECURITY INVOKER, service_role execution '
  'only. Calls build_analytics_snapshot_v2_6 wholesale (unchanged) and '
  'adds shared_capital_liquidity_evidence / target_user_capital_'
  'liquidity_evidence, containing population_summary, open_capital_by_'
  'age_bucket, open_capital_by_acquisition_band, open_capital_by_'
  'acquisition_method, realized_capital_efficiency_by_acquisition_band, '
  'and realized_capital_efficiency_by_acquisition_method — ported from '
  'the v1 Capital & Liquidity file to read every Purpose (Business/'
  'Hybrid/Personal/missing-purpose/missing-policy) instead of Business '
  'only, with purpose_population_summary additionally surfacing '
  'analytics_purpose_policy fields (never new judgmental labels). '
  'v1.0-v1.8 and v2.0-v2.6 are completely unaffected. Persists nothing — '
  'see analytics_runs (20260727000000) for the persistence step. See '
  'analytics/README.md and analytics/SEMANTIC_CONTRACT.md for the full '
  'v2.7 contract.';
