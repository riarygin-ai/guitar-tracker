-- build_analytics_snapshot_v2_1
--
-- Open Inventory Decision Support v2.1 — the first Purpose-aware,
-- item-level evidence module. Adds a NEW helper and a NEW top-level
-- builder that calls build_analytics_snapshot_v2_0 WHOLESALE and adds ONE
-- new top-level section, target_user_open_inventory_evidence. Does NOT
-- call, embed, or replace any v1.0-v1.8 builder. v1.0-v1.8 and every
-- previously stored analytics_runs.snapshot row remain entirely unchanged
-- and independently callable. runAnalytics.ts is NOT updated by this
-- migration; production runs continue to call build_analytics_snapshot_
-- v1_8 until the v2 evidence modules are sufficiently complete.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_open_inventory_decision_support_snapshot_v2(int) -- NEW
--   public.build_analytics_snapshot_v2_1(int)                       -- NEW
--
-- ── POPULATION — EVERY OPEN ITEM OF THE TARGET USER, EVERY PURPOSE ──────
-- Unlike v1.8 (purpose_name = 'Business' only), this module's target
-- population is every OPEN item belonging to p_target_user_id regardless
-- of Purpose: Business, Hybrid, Personal, missing_purpose, missing_policy.
-- Economic eligibility (whether profit/ROI/DOM/holding are computed at
-- all) never depends on Purpose — only urgency INTERPRETATION does (see
-- below). Comparable-cohort STATISTICS pool every user's items (all
-- Purposes) — the same shared population every other module already
-- reads; no other user's item identity is ever exposed (see PRIVACY).
--
-- ── HYBRID IS NOT ENCODED AS "BAD" ───────────────────────────────────────
-- Hybrid items intentionally receive NEITHER Business-style urgency NOR
-- Personal-style "no urgency" treatment. They get their own neutral
-- REVIEW evidence (HYBRID_* reason codes, the separate hybrid_purpose_
-- review section) — descriptive behavioral signals only
-- (listed/unlisted, long-hold, high-capital, low-upside, recent/
-- insufficient-history), never a reclassify_to_business/
-- reclassify_to_personal/keep_hybrid/recommended_purpose output. A future
-- Coach combines this evidence with the user's own goals; this layer
-- never decides FOR the user.
--
-- ── TWO SEPARATE COHORT OBJECTS ──────────────────────────────────────────
-- economic_cohort (profit/ROI/realization rate) pools ALL purposes — no
-- purpose predicate — because economic eligibility is shared. Hierarchy
-- (7 levels, no exact-model level — model is free text, see
-- MODEL_COHORT_UNAVAILABLE_FREE_TEXT_MODEL_FIELD): brand+type+band ->
-- brand+band -> brand -> category+band -> category -> band -> all
-- inventory.
-- liquidity_cohort (DOM/holding time/realization speed) PREFERS the
-- item's own current Purpose first (4 purpose-matched levels: brand+
-- type+band+purpose -> brand+band+purpose -> category+band+purpose ->
-- purpose alone), falling back to 4 cross-purpose levels reusing the
-- SAME underlying level_* CTEs the economic cohort uses (brand+type+band
-- -> brand+band -> category+band -> all inventory) if no purpose-matched
-- cohort clears the confidence bar. Both cohorts use the SAME selection
-- rule as every other module in this analytics layer: first candidate
-- (in specificity order) with realized_item_count >= 5, else first with
-- >= 3, else the most specific with >= 1, else no cohort. Because
-- purpose-matched levels are ordered before cross-purpose ones, this rule
-- naturally prefers a purpose-matched cohort whenever one clears the same
-- confidence tier as any cross-purpose alternative.
-- `liquidity_cohort_match` is 'purpose_matched' / 'cross_purpose_fallback'
-- / 'unavailable'; a cross-purpose fallback adds the reason code
-- PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE.
--
-- ── PURPOSE-AWARE URGENCY (section 7 of the task) ────────────────────────
-- Business: DOM urgency only at current_dom_days >= 30 (BUSINESS_DOM_
-- ABOVE_COMPARABLE_MEDIAN/P75); ownership-age urgency at 120+ reliable
-- days (BUSINESS_OWNERSHIP_AGE_120_PLUS); unlisted open items may carry
-- BUSINESS_UNLISTED_OPEN_ITEM.
-- Hybrid: no Business-style urgency. HYBRID_REVIEW_REQUIRED is
-- unconditional on every Hybrid row (the user's own stated goal is to
-- periodically resolve Hybrid ambiguity). Listed/unlisted/long-hold/
-- high-capital/low-upside/recent-history are REVIEW signals, not
-- realization recommendations. DOM only becomes a review signal at
-- current_dom_days >= 60 (via PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE
-- style comparison is NOT generated for Hybrid — Hybrid has no DOM-vs-
-- cohort-median/p75 reason code at all, per the task's explicit scope;
-- the >=60 threshold instead gates HYBRID_LISTED_SIGNAL's long-hold
-- companion HYBRID_LONG_HOLD_SIGNAL together with the 120-reliable-day
-- ownership-age check).
-- Personal: NO DOM or ownership-age urgency reason code exists anywhere
-- for Personal items (PERSONAL_AGE_UNRELIABLE is a DATA-COMPLETENESS
-- flag — unreliable/unknown date — never an urgency signal; unlisted
-- state never produces a reason code at all for Personal). Personal
-- focuses on capital concentration (PERSONAL_HIGH_CAPITAL_EXPOSURE),
-- missing estimates (PERSONAL_ESTIMATED_VALUE_MISSING), zero/unknown
-- values (PERSONAL_ZERO_OR_UNKNOWN_ACQUISITION_VALUE), and a neutral
-- listed-for-opportunistic-exit note (PERSONAL_LISTED_FOR_OPPORTUNISTIC_
-- EXIT) — long ownership and slow DOM are never treated as negative.
-- Items whose Purpose is missing or unmapped ('unclassified' bucket
-- below) receive only the GENERAL codes — no Business/Hybrid/Personal
-- urgency is assumed for an item whose disposition is not yet known.
--
-- ── NO SCORE, NO RECOMMENDED ACTION, NO AUTOMATIC PURPOSE CHANGE ────────
-- No `score`, `priority_score`, `recommended_action`, `recommended_
-- purpose`, `reclassify_to_business`, `reclassify_to_personal`, or
-- `keep_hybrid` field or value exists anywhere in this module. reason_
-- codes / behavioral_signals / control_reason_codes are deterministic,
-- independent evidence flags — never counted, weighted, or combined into
-- a single number. This module never writes to inventory_items.purpose_id
-- — Purpose changes remain a manual, user-driven action elsewhere in the
-- app.
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- item_decision_evidence, hybrid_purpose_review, and personal_inventory_
-- control.personal_item_control are filtered to `user_id = p_target_
-- user_id` — identical to every prior target-user-only module's pattern.
-- economic_cohort/liquidity_cohort STATISTICS may pool every user's
-- items, but no other user's item_id, item name, model, or any other
-- item-identity field is ever exposed, and no shared/cohort-level output
-- is grouped by user.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_open_inventory_decision_support_snapshot_v2(
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
    END AS acquisition_value_band_label
  FROM public.analytics_item_lifecycle_v2
),

-- ── Economic + liquidity-fallback cohort levels (pooled, ALL purposes) ──
level_brand_type_band AS (
  SELECT
    brand_id, type_id, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY brand_id, type_id, acquisition_value_band_order, acquisition_value_band_label
),
level_brand_band AS (
  SELECT
    brand_id, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY brand_id, acquisition_value_band_order, acquisition_value_band_label
),
level_brand AS (
  SELECT
    brand_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY brand_id
),
level_category_band AS (
  SELECT
    category_id, acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY category_id, acquisition_value_band_order, acquisition_value_band_label
),
level_category AS (
  SELECT
    category_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY category_id
),
level_band AS (
  SELECT
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY acquisition_value_band_order, acquisition_value_band_label
),
level_all AS (
  SELECT
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
),

-- ── Liquidity cohort levels — PURPOSE-MATCHED (specificity 1-4) ─────────
liq_level_brand_type_band_purpose AS (
  SELECT
    brand_id, type_id, acquisition_value_band_order, acquisition_value_band_label, current_purpose_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY brand_id, type_id, acquisition_value_band_order, acquisition_value_band_label, current_purpose_id
),
liq_level_brand_band_purpose AS (
  SELECT
    brand_id, acquisition_value_band_order, acquisition_value_band_label, current_purpose_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY brand_id, acquisition_value_band_order, acquisition_value_band_label, current_purpose_id
),
liq_level_category_band_purpose AS (
  SELECT
    category_id, acquisition_value_band_order, acquisition_value_band_label, current_purpose_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  WHERE acquisition_value_status = 'positive'
  GROUP BY category_id, acquisition_value_band_order, acquisition_value_band_label, current_purpose_id
),
liq_level_purpose AS (
  SELECT
    current_purpose_id,
    COUNT(*)                                                                       AS cohort_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS p75_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 2 THEN 'insufficient'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 5 THEN 'low'
      WHEN COUNT(*) FILTER (WHERE is_realized) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM all_items
  GROUP BY current_purpose_id
),

-- ── Target user's own OPEN items, every Purpose ──────────────────────────
target_base AS (
  SELECT
    ai.*,
    CASE WHEN ai.purpose_policy_status = 'mapped' THEN ai.current_purpose_id   END AS group_purpose_id,
    CASE WHEN ai.purpose_policy_status = 'mapped' THEN ai.current_purpose_name END AS group_purpose_name,
    CASE
      WHEN ai.purpose_policy_status = 'mapped' AND ai.current_purpose_name = 'Business' THEN 'business'
      WHEN ai.purpose_policy_status = 'mapped' AND ai.current_purpose_name = 'Hybrid'   THEN 'hybrid'
      WHEN ai.purpose_policy_status = 'mapped' AND ai.current_purpose_name = 'Personal' THEN 'personal'
      ELSE 'unclassified'
    END                                                                            AS disposition_bucket,
    (ai.first_listed_at IS NOT NULL)                                              AS listed_flag,
    CASE WHEN NOT ai.is_historical_import AND ai.holding_days IS NOT NULL AND NOT ai.has_lifecycle_date_issue
         THEN ai.holding_days ELSE NULL END                                       AS ownership_age_days,
    CASE WHEN ai.first_listed_at IS NULL THEN NULL ELSE ai.global_days_on_market END AS current_dom_days,
    CASE WHEN ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NOT NULL
         THEN ai.estimated_sold_value - ai.acquisition_value - ai.item_expenses_total END AS estimated_net_upside,
    ( (CASE WHEN ai.marketplace_listed_at IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN ai.kijiji_listed_at      IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN ai.reverb_listed_at      IS NOT NULL THEN 1 ELSE 0 END) )         AS listing_channel_count,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN ai.marketplace_listed_at IS NOT NULL THEN 'Marketplace' END,
      CASE WHEN ai.kijiji_listed_at      IS NOT NULL THEN 'Kijiji' END,
      CASE WHEN ai.reverb_listed_at      IS NOT NULL THEN 'Reverb' END
    ], NULL)                                                                       AS listing_channel_names
  FROM all_items ai
  WHERE ai.user_id = p_target_user_id AND NOT ai.is_realized
),
target_open_capital AS (
  SELECT SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount FROM target_base
),

-- Query A -> population_summary
a_row AS (
  SELECT
    COUNT(*)                                                                       AS open_item_count,
    COUNT(*) FILTER (WHERE disposition_bucket = 'business')                       AS business_open_item_count,
    COUNT(*) FILTER (WHERE disposition_bucket = 'hybrid')                          AS hybrid_open_item_count,
    COUNT(*) FILTER (WHERE disposition_bucket = 'personal')                        AS personal_open_item_count,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_purpose')             AS missing_purpose_open_item_count,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_policy')              AS missing_policy_open_item_count,
    COUNT(*) FILTER (WHERE listed_flag)                                           AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT listed_flag)                                       AS unlisted_open_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                 AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS unknown_acquisition_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)           AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_net_upside)                                                     AS estimated_open_net_upside,
    COUNT(*) FILTER (WHERE ownership_age_days IS NOT NULL)                        AS reliable_ownership_age_item_count,
    COUNT(*) FILTER (WHERE ownership_age_days IS NULL)                            AS unreliable_ownership_age_item_count
  FROM target_base
),

-- Query B -> purpose_position_summary
b_rows AS (
  SELECT
    group_purpose_id                                                               AS current_purpose_id,
    group_purpose_name                                                             AS current_purpose_name,
    purpose_policy_status,
    disposition_mode,
    realization_priority_order,
    active_realization_flag,
    expected_holding_policy,
    COUNT(*)                                                                       AS open_item_count,
    COUNT(*) FILTER (WHERE listed_flag)                                            AS listed_item_count,
    COUNT(*) FILTER (WHERE NOT listed_flag)                                        AS unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    ROUND(
      SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)::numeric
        / NULLIF((SELECT amount FROM target_open_capital), 0) * 100,
      2
    )                                                                               AS open_capital_percent,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    SUM(estimated_net_upside)                                                      AS estimated_net_upside,
    COUNT(*) FILTER (WHERE ownership_age_days IS NOT NULL)                         AS reliable_ownership_age_item_count,
    COUNT(*) FILTER (WHERE ownership_age_days IS NULL)                             AS unreliable_ownership_age_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ownership_age_days) FILTER (WHERE ownership_age_days IS NOT NULL)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE ownership_age_days >= 60)                               AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE ownership_age_days >= 120)                              AS items_ownership_age_120_plus
  FROM target_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy
),

-- ── Per-item economic + liquidity cohort selection (LATERAL) ────────────
target_with_cohorts AS (
  SELECT
    tb.*,
    econ.cohort_scope AS econ_cohort_scope, econ.cohort_key AS econ_cohort_key,
    econ.cohort_item_count AS econ_cohort_item_count, econ.realized_item_count AS econ_realized_item_count,
    econ.open_item_count AS econ_open_item_count, econ.realization_rate_percent AS econ_realization_rate_percent,
    econ.median_net_profit AS econ_median_net_profit, econ.median_roi AS econ_median_roi, econ.confidence AS econ_confidence,
    liq.cohort_scope AS liq_cohort_scope, liq.specificity_order AS liq_specificity_order, liq.cohort_key AS liq_cohort_key,
    liq.cohort_item_count AS liq_cohort_item_count, liq.realized_item_count AS liq_realized_item_count,
    liq.open_item_count AS liq_open_item_count, liq.dom_sample_size AS liq_dom_sample_size,
    liq.median_days_on_market AS liq_median_days_on_market, liq.p75_days_on_market AS liq_p75_days_on_market,
    liq.holding_sample_size AS liq_holding_sample_size, liq.median_holding_days AS liq_median_holding_days,
    liq.confidence AS liq_confidence
  FROM target_base tb
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT
        'brand_type_band' AS cohort_scope, 1 AS specificity_order,
        ('brand_id=' || l.brand_id || ',type_id=' || l.type_id || ',band=' || l.acquisition_value_band_label) AS cohort_key,
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_brand_type_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM tb.brand_id
        AND l.type_id IS NOT DISTINCT FROM tb.type_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'brand_band', 2,
        ('brand_id=' || l.brand_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_brand_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM tb.brand_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'brand', 3, ('brand_id=' || l.brand_id),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_brand l
      WHERE l.brand_id IS NOT DISTINCT FROM tb.brand_id
      UNION ALL
      SELECT
        'category_band', 4, ('category_id=' || l.category_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_category_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.category_id IS NOT DISTINCT FROM tb.category_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'category', 5, ('category_id=' || l.category_id),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_category l
      WHERE l.category_id IS NOT DISTINCT FROM tb.category_id
      UNION ALL
      SELECT
        'acquisition_value_band', 6, ('band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'all_inventory', 7, 'all_inventory',
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.realization_rate_percent, l.median_net_profit, l.median_roi, l.confidence
      FROM level_all l
    ) candidates
    WHERE realized_item_count >= 1
    ORDER BY (CASE WHEN realized_item_count >= 5 THEN 0 ELSE 1 END), (CASE WHEN realized_item_count >= 3 THEN 0 ELSE 1 END), specificity_order ASC
    LIMIT 1
  ) econ ON true
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT
        'brand_type_band_purpose' AS cohort_scope, 1 AS specificity_order,
        ('brand_id=' || l.brand_id || ',type_id=' || l.type_id || ',band=' || l.acquisition_value_band_label || ',purpose_id=' || COALESCE(l.current_purpose_id::text, 'null')) AS cohort_key,
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM liq_level_brand_type_band_purpose l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM tb.brand_id
        AND l.type_id IS NOT DISTINCT FROM tb.type_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
        AND l.current_purpose_id IS NOT DISTINCT FROM tb.current_purpose_id
      UNION ALL
      SELECT
        'brand_band_purpose', 2,
        ('brand_id=' || l.brand_id || ',band=' || l.acquisition_value_band_label || ',purpose_id=' || COALESCE(l.current_purpose_id::text, 'null')),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM liq_level_brand_band_purpose l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM tb.brand_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
        AND l.current_purpose_id IS NOT DISTINCT FROM tb.current_purpose_id
      UNION ALL
      SELECT
        'category_band_purpose', 3,
        ('category_id=' || l.category_id || ',band=' || l.acquisition_value_band_label || ',purpose_id=' || COALESCE(l.current_purpose_id::text, 'null')),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM liq_level_category_band_purpose l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.category_id IS NOT DISTINCT FROM tb.category_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
        AND l.current_purpose_id IS NOT DISTINCT FROM tb.current_purpose_id
      UNION ALL
      SELECT
        'purpose', 4, ('purpose_id=' || COALESCE(l.current_purpose_id::text, 'null')),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM liq_level_purpose l
      WHERE l.current_purpose_id IS NOT DISTINCT FROM tb.current_purpose_id
      UNION ALL
      SELECT
        'brand_type_band_all_purposes', 5,
        ('brand_id=' || l.brand_id || ',type_id=' || l.type_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_brand_type_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM tb.brand_id
        AND l.type_id IS NOT DISTINCT FROM tb.type_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'brand_band_all_purposes', 6,
        ('brand_id=' || l.brand_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_brand_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.brand_id IS NOT DISTINCT FROM tb.brand_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'category_band_all_purposes', 7,
        ('category_id=' || l.category_id || ',band=' || l.acquisition_value_band_label),
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_category_band l
      WHERE tb.acquisition_value_status = 'positive'
        AND l.category_id IS NOT DISTINCT FROM tb.category_id
        AND l.acquisition_value_band_order = tb.acquisition_value_band_order
      UNION ALL
      SELECT
        'all_inventory', 8, 'all_inventory',
        l.cohort_item_count, l.realized_item_count, l.open_item_count, l.dom_sample_size, l.median_days_on_market, l.p75_days_on_market, l.holding_sample_size, l.median_holding_days, l.confidence
      FROM level_all l
    ) candidates
    WHERE realized_item_count >= 1
    ORDER BY (CASE WHEN realized_item_count >= 5 THEN 0 ELSE 1 END), (CASE WHEN realized_item_count >= 3 THEN 0 ELSE 1 END), specificity_order ASC
    LIMIT 1
  ) liq ON true
),
target_with_rank AS (
  SELECT
    twc.*,
    RANK() OVER (ORDER BY acquisition_value DESC NULLS LAST) AS acquisition_value_rank,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) OVER (PARTITION BY group_purpose_id, purpose_policy_status) AS purpose_open_capital
  FROM target_with_cohorts twc
),
target_facts AS (
  SELECT
    twr.*,
    CASE WHEN acquisition_value_status = 'positive'
         THEN ROUND(acquisition_value::numeric / NULLIF((SELECT amount FROM target_open_capital), 0) * 100, 2) END AS open_capital_share_percent,
    CASE WHEN acquisition_value_status = 'positive'
         THEN ROUND(acquisition_value::numeric / NULLIF(purpose_open_capital, 0) * 100, 2) END AS purpose_open_capital_share_percent,
    CASE WHEN acquisition_value_status = 'positive' AND estimated_sold_value IS NOT NULL
         THEN ROUND(estimated_net_upside::numeric / NULLIF(acquisition_value, 0) * 100, 2) END AS estimated_upside_percent,
    CASE
      WHEN liq_cohort_scope IS NULL THEN 'unavailable'
      WHEN liq_specificity_order <= 4 THEN 'purpose_matched'
      ELSE 'cross_purpose_fallback'
    END AS liquidity_cohort_match
  FROM target_with_rank twr
),

-- Query C -> item_decision_evidence
c_rows AS (
  SELECT
    item_id, item_display_name, brand_id, brand_name, category_id, category_name, type_id, type_name, model,
    current_purpose_id, current_purpose_name, purpose_policy_status, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy,
    acquisition_method, acquisition_value, acquisition_value_band_order, acquisition_value_band_label,
    estimated_sold_value, estimated_net_upside, estimated_upside_percent, is_historical_import, ownership_age_days, listed_flag,
    'open_item_with_listing_record'                                                AS listing_state_basis,
    listing_channel_count, listing_channel_names, first_listed_at, current_dom_days,
    open_capital_share_percent, purpose_open_capital_share_percent,
    CASE WHEN econ_cohort_scope IS NOT NULL THEN jsonb_build_object(
      'cohort_scope', econ_cohort_scope, 'cohort_key', econ_cohort_key,
      'cohort_item_count', econ_cohort_item_count, 'realized_item_count', econ_realized_item_count, 'open_item_count', econ_open_item_count,
      'realization_rate_percent', econ_realization_rate_percent, 'median_net_profit', econ_median_net_profit, 'median_roi', econ_median_roi,
      'confidence', econ_confidence
    ) ELSE NULL END                                                                AS economic_cohort,
    CASE WHEN liq_cohort_scope IS NOT NULL THEN jsonb_build_object(
      'cohort_scope', liq_cohort_scope, 'cohort_key', liq_cohort_key,
      'cohort_item_count', liq_cohort_item_count, 'realized_item_count', liq_realized_item_count, 'open_item_count', liq_open_item_count,
      'dom_sample_size', liq_dom_sample_size, 'median_days_on_market', liq_median_days_on_market, 'p75_days_on_market', liq_p75_days_on_market,
      'holding_sample_size', liq_holding_sample_size, 'median_holding_days', liq_median_holding_days, 'confidence', liq_confidence
    ) ELSE NULL END                                                                AS liquidity_cohort,
    liquidity_cohort_match,
    (econ_cohort_scope IS NOT NULL)                                                AS comparable_evidence_available,
    ARRAY(
      SELECT code FROM (VALUES
        -- General
        (CASE WHEN disposition_bucket IN ('business', 'unclassified') AND acquisition_value_status = 'positive'
                AND (acquisition_value_rank <= 3 OR open_capital_share_percent >= 10) THEN 'HIGH_CAPITAL_EXPOSURE' END),
        (CASE WHEN disposition_bucket IN ('business', 'unclassified') AND acquisition_value_status = 'positive' AND estimated_sold_value IS NOT NULL
                AND estimated_net_upside >= 0 AND estimated_upside_percent < 15 THEN 'LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL' END),
        (CASE WHEN disposition_bucket IN ('business', 'unclassified') AND estimated_net_upside IS NOT NULL AND estimated_net_upside < 0 THEN 'NEGATIVE_ESTIMATED_UPSIDE' END),
        (CASE WHEN econ_cohort_scope IS NOT NULL AND econ_confidence IN ('insufficient', 'low') THEN 'LOW_COMPARABLE_CONFIDENCE' END),
        (CASE WHEN econ_cohort_scope IS NULL THEN 'NO_COMPARABLE_EVIDENCE' END),
        (CASE WHEN is_historical_import AND disposition_bucket <> 'personal' THEN 'HISTORICAL_AGE_UNRELIABLE' END),
        (CASE WHEN acquisition_value_status = 'zero_assigned' AND disposition_bucket <> 'personal' THEN 'ZERO_ASSIGNED_ACQUISITION_VALUE' END),
        (CASE WHEN acquisition_value_status = 'unknown' AND disposition_bucket <> 'personal' THEN 'UNKNOWN_ACQUISITION_VALUE' END),
        (CASE WHEN estimated_sold_value IS NULL AND disposition_bucket <> 'personal' THEN 'ESTIMATED_VALUE_MISSING' END),
        (CASE WHEN liquidity_cohort_match = 'cross_purpose_fallback' THEN 'PURPOSE_MATCHED_LIQUIDITY_COHORT_UNAVAILABLE' END),
        ('LISTING_ACTIVE_STATE_INFERRED'),
        -- Business
        (CASE WHEN disposition_bucket = 'business' AND NOT listed_flag THEN 'BUSINESS_UNLISTED_OPEN_ITEM' END),
        (CASE WHEN disposition_bucket = 'business' AND listed_flag AND current_dom_days >= 30
                AND liq_median_days_on_market IS NOT NULL AND current_dom_days > liq_median_days_on_market THEN 'BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN' END),
        (CASE WHEN disposition_bucket = 'business' AND listed_flag AND current_dom_days >= 30
                AND liq_p75_days_on_market IS NOT NULL AND current_dom_days > liq_p75_days_on_market THEN 'BUSINESS_DOM_ABOVE_COMPARABLE_P75' END),
        (CASE WHEN disposition_bucket = 'business' AND ownership_age_days IS NOT NULL AND ownership_age_days >= 120 THEN 'BUSINESS_OWNERSHIP_AGE_120_PLUS' END),
        -- Hybrid
        (CASE WHEN disposition_bucket = 'hybrid' THEN 'HYBRID_REVIEW_REQUIRED' END),
        (CASE WHEN disposition_bucket = 'hybrid' AND listed_flag THEN 'HYBRID_LISTED_SIGNAL' END),
        (CASE WHEN disposition_bucket = 'hybrid' AND NOT listed_flag THEN 'HYBRID_UNLISTED_SIGNAL' END),
        (CASE WHEN disposition_bucket = 'hybrid' AND ownership_age_days IS NOT NULL AND ownership_age_days >= 120 THEN 'HYBRID_LONG_HOLD_SIGNAL' END),
        (CASE WHEN disposition_bucket = 'hybrid' AND acquisition_value_status = 'positive'
                AND (acquisition_value_rank <= 3 OR open_capital_share_percent >= 10) THEN 'HYBRID_HIGH_CAPITAL_SIGNAL' END),
        (CASE WHEN disposition_bucket = 'hybrid' AND acquisition_value_status = 'positive' AND estimated_sold_value IS NOT NULL
                AND (estimated_upside_percent < 15 OR estimated_net_upside < 0) THEN 'HYBRID_LOW_UPSIDE_SIGNAL' END),
        (CASE WHEN disposition_bucket = 'hybrid' AND (ownership_age_days IS NULL OR ownership_age_days < 30) THEN 'HYBRID_RECENT_INSUFFICIENT_HISTORY' END),
        -- Personal
        (CASE WHEN disposition_bucket = 'personal' AND acquisition_value_status = 'positive'
                AND (acquisition_value_rank <= 3 OR open_capital_share_percent >= 10) THEN 'PERSONAL_HIGH_CAPITAL_EXPOSURE' END),
        (CASE WHEN disposition_bucket = 'personal' AND listed_flag THEN 'PERSONAL_LISTED_FOR_OPPORTUNISTIC_EXIT' END),
        (CASE WHEN disposition_bucket = 'personal' AND estimated_sold_value IS NULL THEN 'PERSONAL_ESTIMATED_VALUE_MISSING' END),
        (CASE WHEN disposition_bucket = 'personal' AND acquisition_value_status IN ('zero_assigned', 'unknown') THEN 'PERSONAL_ZERO_OR_UNKNOWN_ACQUISITION_VALUE' END),
        (CASE WHEN disposition_bucket = 'personal' AND ownership_age_days IS NULL THEN 'PERSONAL_AGE_UNRELIABLE' END)
      ) AS t(code)
      WHERE code IS NOT NULL
    )                                                                               AS reason_codes
  FROM target_facts
),

-- Query D -> hybrid_purpose_review
d_rows AS (
  SELECT
    item_id, item_display_name, acquisition_value, estimated_net_upside, ownership_age_days, listed_flag,
    current_dom_days, listing_channel_count, open_capital_share_percent, purpose_open_capital_share_percent,
    ARRAY(
      SELECT code FROM (VALUES
        (CASE WHEN listed_flag THEN 'LISTED_ACTIVE_REALIZATION_SIGNAL' END),
        (CASE WHEN NOT listed_flag THEN 'UNLISTED_HOLDING_SIGNAL' END),
        (CASE WHEN ownership_age_days IS NOT NULL AND ownership_age_days >= 120 THEN 'LONG_HOLD_SIGNAL' END),
        (CASE WHEN acquisition_value_status = 'positive' AND (acquisition_value_rank <= 3 OR open_capital_share_percent >= 10) THEN 'HIGH_CAPITAL_SIGNAL' END),
        (CASE WHEN acquisition_value_status = 'positive' AND estimated_sold_value IS NOT NULL
                AND (estimated_upside_percent < 15 OR estimated_net_upside < 0) THEN 'LOW_UPSIDE_SIGNAL' END),
        (CASE WHEN ownership_age_days IS NOT NULL AND ownership_age_days < 30 THEN 'RECENT_ITEM_SIGNAL' END),
        (CASE WHEN ownership_age_days IS NULL THEN 'INSUFFICIENT_HISTORY_SIGNAL' END)
      ) AS t(code) WHERE code IS NOT NULL
    )                                                                               AS behavioral_signals,
    ARRAY(
      SELECT code FROM (VALUES
        (CASE WHEN is_historical_import THEN 'HISTORICAL_ACQUISITION_DATE_UNRELIABLE' END),
        (CASE WHEN estimated_sold_value IS NOT NULL THEN 'ESTIMATED_VALUE_IS_USER_ESTIMATE' END),
        (CASE WHEN econ_cohort_scope IS NOT NULL AND econ_confidence IN ('insufficient', 'low') THEN 'COMPARABLE_SAMPLE_SMALL' END),
        ('PERSONAL_INTEREST_AND_APPRECIATION_THESIS_NOT_STORED')
      ) AS t(code) WHERE code IS NOT NULL
    )                                                                               AS limitations
  FROM target_facts
  WHERE disposition_bucket = 'hybrid'
),

-- Query E -> personal_inventory_control.personal_item_control
e_rows AS (
  SELECT
    item_id, item_display_name, acquisition_value, estimated_sold_value, estimated_net_upside, ownership_age_days, listed_flag,
    listing_channel_names,
    purpose_open_capital_share_percent                                            AS personal_capital_share_percent,
    open_capital_share_percent                                                     AS target_open_capital_share_percent,
    ARRAY(
      SELECT code FROM (VALUES
        (CASE WHEN acquisition_value_status = 'positive' AND (acquisition_value_rank <= 3 OR open_capital_share_percent >= 10) THEN 'PERSONAL_HIGH_CAPITAL_EXPOSURE' END),
        (CASE WHEN listed_flag THEN 'PERSONAL_LISTED_FOR_OPPORTUNISTIC_EXIT' END),
        (CASE WHEN estimated_sold_value IS NULL THEN 'PERSONAL_ESTIMATED_VALUE_MISSING' END),
        (CASE WHEN acquisition_value_status IN ('zero_assigned', 'unknown') THEN 'PERSONAL_ZERO_OR_UNKNOWN_ACQUISITION_VALUE' END),
        (CASE WHEN ownership_age_days IS NULL THEN 'PERSONAL_AGE_UNRELIABLE' END)
      ) AS t(code) WHERE code IS NOT NULL
    )                                                                               AS control_reason_codes,
    ARRAY(
      SELECT code FROM (VALUES
        (CASE WHEN is_historical_import THEN 'HISTORICAL_ACQUISITION_DATE_UNRELIABLE' END),
        (CASE WHEN estimated_sold_value IS NOT NULL THEN 'ESTIMATED_VALUE_IS_USER_ESTIMATE' END)
      ) AS t(code) WHERE code IS NOT NULL
    )                                                                               AS limitations
  FROM target_facts
  WHERE disposition_bucket = 'personal'
),
personal_capital AS (
  SELECT
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL) AS amount
  FROM target_facts WHERE disposition_bucket = 'personal'
),
personal_top_three AS (
  SELECT SUM(v) AS amount FROM (
    SELECT acquisition_value AS v FROM target_facts
    WHERE disposition_bucket = 'personal' AND acquisition_value IS NOT NULL
    ORDER BY acquisition_value DESC LIMIT 3
  ) t
),

-- personal_inventory_control.personal_position_summary
f_row AS (
  SELECT
    COUNT(*)                                                                       AS personal_open_item_count,
    (SELECT amount FROM personal_capital)                                          AS personal_open_acquisition_capital,
    ROUND(
      (SELECT amount FROM personal_capital)::numeric / NULLIF((SELECT amount FROM target_open_capital), 0) * 100, 2
    )                                                                               AS personal_capital_percent_of_target_open_capital,
    SUM(estimated_net_upside)                                                      AS estimated_open_net_upside,
    COUNT(*) FILTER (WHERE listed_flag)                                            AS listed_item_count,
    COUNT(*) FILTER (WHERE NOT listed_flag)                                        AS unlisted_item_count,
    COUNT(*) FILTER (WHERE ownership_age_days IS NOT NULL)                         AS reliable_age_item_count,
    COUNT(*) FILTER (WHERE ownership_age_days IS NULL)                             AS unreliable_age_item_count,
    (SELECT amount FROM personal_top_three)                                        AS top_three_item_capital,
    ROUND(
      (SELECT amount FROM personal_top_three)::numeric / NULLIF((SELECT amount FROM personal_capital), 0) * 100, 2
    )                                                                               AS top_three_item_capital_percent_of_personal_capital
  FROM target_facts
  WHERE disposition_bucket = 'personal'
)

SELECT jsonb_build_object(
  'population_summary',         (SELECT COALESCE(jsonb_agg(to_jsonb(a_row)), '[]'::jsonb) FROM a_row),
  'purpose_position_summary',   (SELECT COALESCE(jsonb_agg(to_jsonb(b_rows) ORDER BY
                                    CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                    realization_priority_order NULLS LAST, current_purpose_name NULLS LAST
                                  ), '[]'::jsonb) FROM b_rows),
  'item_decision_evidence',     (SELECT COALESCE(jsonb_agg(to_jsonb(c_rows) ORDER BY
                                    (CASE WHEN acquisition_value_band_order NOT IN (0, 8, -1) THEN acquisition_value ELSE NULL END) DESC NULLS LAST,
                                    COALESCE(ownership_age_days, -1) DESC, item_id ASC
                                  ), '[]'::jsonb) FROM c_rows),
  'hybrid_purpose_review',      (SELECT COALESCE(jsonb_agg(to_jsonb(d_rows) ORDER BY
                                    acquisition_value DESC NULLS LAST, COALESCE(ownership_age_days, -1) DESC, item_id ASC
                                  ), '[]'::jsonb) FROM d_rows),
  'personal_inventory_control', jsonb_build_object(
    'personal_position_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(f_row)), '[]'::jsonb) FROM f_row),
    'personal_item_control',     (SELECT COALESCE(jsonb_agg(to_jsonb(e_rows) ORDER BY
                                     acquisition_value DESC NULLS LAST, item_id ASC
                                   ), '[]'::jsonb) FROM e_rows)
  ),
  'module_limitations', jsonb_build_array(
    'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
    'PURPOSE_CHANGES_ARE_NOT_HISTORICALLY_TRACKED',
    'PERSONAL_INTEREST_AND_APPRECIATION_THESIS_NOT_STORED',
    'LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD',
    'MODEL_COHORT_UNAVAILABLE_FREE_TEXT_MODEL_FIELD'
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_open_inventory_decision_support_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_open_inventory_decision_support_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_open_inventory_decision_support_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_open_inventory_decision_support_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_1(p_target_user_id int)
-- Calls build_analytics_snapshot_v2_0 WHOLESALE (which itself validates
-- p_target_user_id and RAISEs on failure — not repeated here), preserves
-- shared_purpose_evidence/target_user_purpose_evidence/evidence_scope/
-- purpose_semantics UNCHANGED, and adds target_user_open_inventory_
-- evidence as a new top-level key. module_limitations is REPLACED with
-- the superset this section requires (jsonb `||` replaces same-named
-- top-level keys rather than merging arrays) — this is metadata, not one
-- of the "v2.0 sections" being preserved.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_1(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v20          jsonb;
  v_generated_at timestamptz := now();
BEGIN
  v_v20 := public.build_analytics_snapshot_v2_0(p_target_user_id);

  RETURN v_v20
    || jsonb_build_object(
         'snapshot_schema_version', '2.1',
         'analytics_definition_version', '2.1',
         'generated_at', to_jsonb(v_generated_at),
         'module_limitations', jsonb_build_array(
           'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
           'PURPOSE_CHANGES_ARE_NOT_HISTORICALLY_TRACKED',
           'PERSONAL_INTEREST_AND_APPRECIATION_THESIS_NOT_STORED',
           'LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD',
           'MODEL_COHORT_UNAVAILABLE_FREE_TEXT_MODEL_FIELD'
         )
       )
    || jsonb_build_object(
         'target_user_open_inventory_evidence',
         public._build_open_inventory_decision_support_snapshot_v2(p_target_user_id)
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_1(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_1(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_1(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_1(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_1(int) IS
  'Open Inventory Decision Support v2.1 — Purpose-aware, item-level '
  'evidence for every open item of one target user (Business/Hybrid/'
  'Personal/missing-purpose/missing-policy). SECURITY INVOKER, '
  'service_role execution only. Calls build_analytics_snapshot_v2_0 '
  'wholesale and adds target_user_open_inventory_evidence — does NOT '
  'call or embed any v1.x builder. Hybrid receives neutral review '
  'evidence (never Business-style urgency, never an automatic '
  'reclassify/keep decision); Personal receives no DOM/ownership-age '
  'urgency codes at all. No score, priority_score, recommended_action, '
  'or recommended_purpose exists anywhere. v1.0-v1.8 and v2.0 are '
  'completely unaffected; runAnalytics.ts still calls v1.8 for '
  'production runs. Persists nothing. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v2.1 contract.';
