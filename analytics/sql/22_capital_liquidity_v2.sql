-- ============================================================================
-- 22_capital_liquidity_v2.sql
--
-- Purpose-aware v2 port of 09_capital_liquidity.sql. See
-- public._build_capital_liquidity_snapshot_v2(int)
-- (supabase/migrations/20260818000000_build_analytics_snapshot_v2_7.sql)
-- for the actual transformation; nothing in this file creates a database
-- object and nothing here writes to production data.
--
-- ── WHAT CHANGED FROM v1 ──────────────────────────────────────────────────
-- Population is analytics_item_lifecycle_v2's FULL population — Business,
-- Hybrid, Personal, missing_purpose, missing_policy — instead of
-- `purpose_name = 'Business'`. Every section is produced twice: once
-- pooled across ALL purposes, once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status), using the SAME missing-
-- purpose/missing-policy collapsing rule as every other v2 module.
-- Purpose is a current disposition POLICY, not an economic eligibility
-- filter and not proven historical intent — never presented as "Purpose
-- at acquisition, listing, or exit time." The purpose_population_summary
-- rows additionally LEFT JOIN public.analytics_purpose_policy — the ONLY
-- source of Purpose-level interpretive framing this module surfaces
-- (disposition_mode / realization_priority_order / active_realization_
-- flag / expected_holding_policy / description), NULL for missing_
-- purpose/missing_policy rows. No new judgmental label, score, or
-- universal "stale"/"trapped"/urgency interpretation is invented — the
-- SAME neutral age/holding/DOM buckets are reported for every Purpose,
-- and any policy interpretation comes from these pre-existing,
-- already-reviewed fields, never a rule this module invents.
--
-- ── WHAT DID NOT CHANGE ───────────────────────────────────────────────────
-- This module reports CAPITAL (acquisition value assigned to inventory),
-- never a cash_flow/cash-balance ledger. Positive acquisition value
-- contributes to every capital total; zero-assigned remains visible and
-- contributes exactly $0; unknown (NULL) remains visible in coverage but
-- is excluded from SUMs by ordinary NULL propagation. Historical Imports
-- are included in acquisition capital, realized profit, ROI, values,
-- listing state, and estimated upside; excluded ONLY from acquisition-
-- date-dependent metrics (ownership age, holding days, profit-per-30-
-- holding-days) — DOM is NOT excluded for historical imports. Open
-- capital age buckets (0-29/30-59/60-119/120+ days, plus "unreliable/
-- unknown age") are MUTUALLY EXCLUSIVE. Every `*_capital_percent` field
-- divides by the SAME denominator within its scope (pooled rows use the
-- scope-wide open-capital total; `_by_purpose` rows use that Purpose's
-- own open-capital total, so percentages sum to ~100% within their own
-- scope). `profit_to_acquisition_capital_percent` is an aggregate
-- descriptive ratio, never a substitute for `median_roi`. `median_net_
-- profit_per_30_holding_days` is computed PER ITEM FIRST, then medianed
-- — never a group-level ratio of medians. Confidence is tiered from the
-- row's own item count, unchanged from 09's own convention. This module
-- never duplicates OIDS' item-level decision evidence.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- ALL SIX of 09's queries are self-classified shared aggregate evidence
-- (see its own "QUERY CLASSIFICATION INDEX") — none are developer-only
-- diagnostics, and none are superseded by Purpose-aware OIDS (OIDS
-- reports item-level decision evidence for one target user; this module
-- reports only aggregate capital/liquidity totals — different scope).
-- All six are therefore ported in full:
--   Query A -> population_summary
--   Query B -> open_capital_by_age_bucket
--   Query C -> open_capital_by_acquisition_band
--   Query D -> open_capital_by_acquisition_method
--   Query E -> realized_capital_efficiency_by_acquisition_band
--   Query F -> realized_capital_efficiency_by_acquisition_method
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_capital_liquidity_evidence
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
)
SELECT jsonb_build_object(
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
);

-- ============================================================================
-- Query B -> target_user_capital_liquidity_evidence
-- ============================================================================
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
  WHERE user_id = 2 -- REPLACE 2 with a real user id
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
  FROM all_items
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
  FROM all_items ai
  LEFT JOIN public.analytics_purpose_policy pp ON pp.purpose_id = ai.group_purpose_id AND ai.purpose_policy_status = 'mapped'
  GROUP BY ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, pp.disposition_mode, pp.realization_priority_order, pp.active_realization_flag, pp.expected_holding_policy, pp.description
),

-- Denominators for open_capital_percent in Query B/C/D. Pooled rows use
-- the scope-wide open-capital total; _by_purpose rows use that Purpose's
-- own open-capital total, so percentages sum to ~100% within their scope.
ct_total_open_capital_pooled AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM all_items WHERE NOT is_realized
),
ct_total_open_capital_by_purpose AS (
  SELECT group_purpose_id, group_purpose_name, purpose_policy_status, SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount
  FROM all_items WHERE NOT is_realized
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
  FROM all_items
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
  SELECT * FROM all_items WHERE NOT is_realized
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
  FROM all_items
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
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 09_capital_liquidity.sql: open acquisition capital is capital
-- ASSIGNED TO INVENTORY, not current market value. Estimated upside is a
-- manual guess, not guaranteed profit. `profit_to_acquisition_capital_
-- percent` is never a substitute for `median_roi`. Old inventory is NOT
-- automatically bad inventory — Business, Hybrid, and Personal Purpose
-- rows carry different, already-reviewed expected-holding policies
-- (`expected_holding_policy` on purpose_population_summary); the SAME
-- neutral age/holding/DOM buckets are reported for every Purpose, and no
-- universal "stale"/"trapped"/urgency label is applied across all of
-- them. A zero-assigned acquisition value never produces an infinite or
-- undefined ROI/capital-efficiency figure — every ratio divides with
-- NULLIF(..., 0). This module never duplicates OIDS' item-level decision
-- evidence — no item_id, item row, reason code, or recommendation is
-- produced here.
