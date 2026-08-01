-- build_analytics_snapshot_v2_5
--
-- Analytics v2.5 — Deal Channel Performance. Ports three v1 modules to
-- Purpose-aware v2 semantics: Deal In Channel Performance
-- (analytics/sql/04_deal_in_channel_performance.sql), Deal Out Channel
-- Performance (analytics/sql/05_deal_out_channel_performance.sql), and
-- Channel Journey (analytics/sql/06_channel_journey.sql). Adds a NEW
-- helper and a NEW top-level builder that calls build_analytics_snapshot_
-- v2_4 WHOLESALE and adds two new top-level sections, shared_deal_
-- channel_evidence and target_user_deal_channel_evidence. Does NOT call,
-- embed, or replace any v1.0-v1.8 or v2.0-v2.4 builder — those remain
-- entirely unchanged and independently callable.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_deal_channel_snapshot_v2(int)    -- NEW
--   public.build_analytics_snapshot_v2_5(int)       -- NEW
--
-- ── POPULATION — EVERY ITEM, EVERY PURPOSE ───────────────────────────────
-- Unlike v1.x (purpose_name = 'Business' only), this module reads
-- analytics_item_lifecycle_v2's full population: Business, Hybrid,
-- Personal, missing_purpose, missing_policy. Purpose is the item's CURRENT
-- disposition only — never an economic eligibility filter, and never
-- presented as "Purpose at acquisition" or "Purpose at exit" (Purpose has
-- no historical record — see analytics_item_lifecycle_v2's own migration
-- header). Every section below is produced twice: once pooled across ALL
-- purposes, and once broken down by (current_purpose_id,
-- current_purpose_name, purpose_policy_status), using the same missing-
-- purpose/missing-policy collapsing rule established in v2.0 and reused
-- by every v2 module since.
--
-- ── SCOPE DECISION — ALL THREE v1 FILES PORTED IN FULL ───────────────────
-- 04_deal_in_channel_performance.sql (5 queries A-E), 05_deal_out_channel_
-- performance.sql (6 queries A-F), and 06_channel_journey.sql (5 queries
-- A-E) each self-classify EVERY one of their queries as shared aggregate
-- evidence in their own "QUERY CLASSIFICATION INDEX" — none are
-- developer-only diagnostics (unlike 03_brand_performance.sql's Query
-- G/H). All 16 queries are therefore ported in full:
--   Deal In Channel:  population_summary, performance_by_deal_in_channel,
--     performance_by_deal_in_channel_and_method, performance_by_deal_in_
--     channel_and_acquisition_band, open_inventory_by_deal_in_channel.
--   Deal Out Channel: population_summary, performance_by_deal_out_
--     channel, cash_sales_by_deal_out_channel, trade_exits_by_deal_out_
--     channel, performance_by_deal_out_channel_and_exit_band,
--     performance_by_deal_out_channel_and_acquisition_band.
--   Channel Journey: population_summary, deal_in_to_deal_out_matrix,
--     same_channel_summary, same_channel_summary_by_deal_in_channel,
--     paths_by_acquisition_and_exit_method.
-- Listing-Channel data (analytics_item_lifecycle_v2's listing-platform
-- columns) is explicitly NOT read anywhere in this module — Deal In/Out
-- Channel and Channel Journey are distinct from Listing Channel Exposure
-- (a separate v1.5 module, not touched here), matching every v1 source
-- file's own "OUT of scope" note.
--
-- ── SEMANTIC RULES PRESERVED FROM v1 ──────────────────────────────────────
-- - Deal In Channel is where contact with the seller/trade partner
--   ORIGINATED for the operation an item ENTERED inventory through,
--   Deal Out Channel is where it LEFT — never a payment method or
--   shipping method. A Reverb contact followed by an off-platform payment
--   remains Reverb. For a Trade, one deal_channel_id applies to BOTH the
--   incoming and outgoing item(s) on that deal — never split into two.
--   Regular Buyer / Seller is a relationship channel, reported like any
--   other channel.
-- - Missing Deal In/Out Channel (deal_in_channel_id/deal_out_channel_id
--   IS NULL) is a real, visible state — GROUP BY keeps the NULL group
--   visible in every per-channel section, and population_summary reports
--   its coverage explicitly. Never silently dropped or backfilled.
-- - Historical Imports participate fully wherever a Deal In or Deal Out
--   channel is available (a historical ACQUISITION record does not make a
--   real Deal In/Out Channel untrustworthy) — excluded ONLY from
--   holding_days-based duration metrics (acquisition_date is the one
--   approximate field), same as every prior module. Rows with
--   has_lifecycle_date_issue are excluded from the same holding-based
--   metrics regardless of Purpose.
-- - acquisition_method is normalized to 'purchase' / 'trade' / 'unknown'
--   for most rows, but the view can still leave it NULL for some (unlike
--   04's own header claim of full normalization — verified against live
--   data). Every "unknown acquisition method" count in this module
--   therefore uses `acquisition_method IS NULL OR acquisition_method NOT
--   IN ('purchase', 'trade')`, not 04's own `NOT IN (...)` alone — a
--   plain NOT IN silently excludes NULL rows from every bucket (SQL's
--   NULL NOT IN (...) evaluates to NULL, not TRUE), which would break
--   population_summary's own documented reconciliation
--   (purchase + trade + unknown = total) and silently hide missing-method
--   rows from coverage. This is the one deliberate correction made to a
--   v1 query in this module (04/05/06 are otherwise byte-for-byte
--   ported); exit_type is 'sale' / 'trade' for every realized row today
--   (defensively treated as 'unknown' if a future exit method appears,
--   matching 05/06's own convention) — the two paths are never
--   conflated: exit_value is called a "sale price" only in cash-sale-
--   scoped sections and an "assigned trade exit value" only in
--   trade-exit-scoped sections, never in a section that mixes both.
-- - ROI requires a positive acquisition value (the view's own roi column
--   is already NULL otherwise). Acquisition value bands restrict to
--   acquisition_value_status = 'positive', exactly like every prior
--   module; zero-assigned/unknown coverage is reported separately, never
--   mixed into a positive band.
-- - Deal Out Channel and Channel Journey populations are realized items
--   only (is_realized) — an open item has no exit deal yet to read a
--   channel from, unchanged from v1. Deal In Channel's population is
--   every item (open + realized), unchanged from v1.
-- - Channel Journey's journey_eligible population additionally requires
--   BOTH deal_in_channel_id AND deal_out_channel_id to be known — a
--   missing-channel realized item is excluded from the journey matrix but
--   counted in population_summary's coverage fields, never silently
--   dropped. "Same channel" (deal_in_channel_id = deal_out_channel_id) is
--   descriptive path evidence only, never a conversion rate and never
--   presented as proof a channel caused the exit.
-- - item_count and distinct_deal_count are semantically distinct
--   throughout: a single multi-item deal contributes many to an item
--   count but only one to its deal count.
-- - Additive totals (counts, capital sums) return 0 for an empty group;
--   medians/percentiles/ROI/durations remain NULL when no valid sample
--   exists — never fabricated. Confidence is tiered from the row's own
--   item count (1-2 insufficient, 3-5 low, 6-9 moderate, 10+ stronger),
--   the single-tier convention 04/05/06 already use (not Brand
--   Performance's dual sample/realized tiering).
-- - Realization rate and every path/percentage for Hybrid/Personal rows
--   is descriptive only — no urgency, recommendation, score, item row, or
--   AI prose is produced anywhere in this module.
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- shared_deal_channel_evidence pools every user's items (aggregate only —
-- no item_id, item name, model, or other item identity, and no row
-- grouped by user_id). target_user_deal_channel_evidence is filtered to
-- `user_id = p_target_user_id` and is, like the shared section, aggregate
-- only.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_deal_channel_snapshot_v2(
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
    END AS exit_value_band_label,
    CASE WHEN exit_type IN ('sale', 'trade') THEN exit_type ELSE 'unknown' END AS exit_method,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
target_items AS (
  SELECT * FROM all_items WHERE user_id = p_target_user_id
),

-- ============================================================================
-- MODULE 1: Deal In Channel Performance — SHARED (pooled, all users)
-- ============================================================================

-- population_summary / purpose_population_summary (Query A)
dis_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM all_items
),
dis_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_in_channel / ..._by_purpose (Query B)
dis_perf_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),
dis_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),

-- performance_by_deal_in_channel_and_method / ..._by_purpose (Query C)
dis_method_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_method
),
dis_method_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_method
),

-- performance_by_deal_in_channel_and_acquisition_band / ..._by_purpose (Query D)
dis_band_eligible AS (
  SELECT * FROM all_items WHERE acquisition_value_status = 'positive'
),
dis_band_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dis_band_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dis_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dis_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_deal_in_channel / ..._by_purpose (Query E)
dis_open_base AS (
  SELECT * FROM all_items WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),
dis_open_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dis_open_base
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
dis_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dis_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
),
-- MODULE 1: Deal In Channel Performance — TARGET USER ONLY
-- ============================================================================

-- population_summary / purpose_population_summary (Query A)
dit_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM target_items
),
dit_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)                        AS deal_in_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_in_channel_id IS NULL)                            AS deal_in_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_in_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_channel_coverage_percent,
    COUNT(DISTINCT deal_in_channel_id) FILTER (WHERE deal_in_channel_id IS NOT NULL) AS distinct_deal_in_channel_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                       AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                          AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method IS NULL OR acquisition_method NOT IN ('purchase', 'trade'))       AS unknown_acquisition_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                  AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                              AS app_tracked_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')            AS deal_in_zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                  AS deal_in_unknown_acquisition_item_count
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_in_channel / ..._by_purpose (Query B)
dit_perf_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM target_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),
dit_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE acquisition_method = 'purchase')                        AS purchase_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_method = 'trade')                           AS trade_acquisition_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_in_channel_requires_listing
),

-- performance_by_deal_in_channel_and_method / ..._by_purpose (Query C)
dit_method_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM target_items
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_method
),
dit_method_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, acquisition_method,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS deal_in_distinct_deal_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_method
),

-- performance_by_deal_in_channel_and_acquisition_band / ..._by_purpose (Query D)
dit_band_eligible AS (
  SELECT * FROM target_items WHERE acquisition_value_status = 'positive'
),
dit_band_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dit_band_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dit_band_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_in_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS deal_in_realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS deal_in_open_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_in_realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dit_band_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, acquisition_value_band_order, acquisition_value_band_label
),

-- open_inventory_by_deal_in_channel / ..._by_purpose (Query E)
dit_open_base AS (
  SELECT * FROM target_items WHERE NOT is_realized AND acquisition_value_status <> 'negative_invalid'
),
dit_open_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dit_open_base
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
dit_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS deal_in_open_item_count,
    COUNT(*) FILTER (WHERE current_status = 'listed')                              AS deal_in_open_listed_item_count,
    COUNT(*) FILTER (WHERE current_status <> 'listed')                             AS deal_in_open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value IS NOT NULL)                          AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value = 0)                                  AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value IS NULL)                              AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL) AS current_dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_current_days_on_market,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 60)  AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE current_status = 'listed' AND NOT has_lifecycle_date_issue AND global_days_on_market >= 120) AS items_dom_120_plus
  FROM dit_open_base
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
),

-- ============================================================================
-- MODULE 2: Deal Out Channel Performance — SHARED (pooled, all users)
-- Population is REALIZED items only (Query A onward) — an open item has
-- no exit deal yet to read a channel from.
-- ============================================================================

dos_realized AS (
  SELECT * FROM all_items WHERE is_realized
),

-- population_summary / purpose_population_summary (Query A)
dos_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dos_realized
),
dos_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dos_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_out_channel / ..._by_purpose (Query B)
dos_perf_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),
dos_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),

-- cash_sales_by_deal_out_channel / ..._by_purpose (Query C) — the ONLY
-- sections where exit_value may be called "sale price"
dos_cash_sales AS (
  SELECT * FROM dos_realized WHERE exit_type = 'sale'
),
dos_cash_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_cash_sales
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dos_cash_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_cash_sales
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- trade_exits_by_deal_out_channel / ..._by_purpose (Query D) — exit_value
-- here is an ASSIGNED OUTGOING TRADE VALUE, never a "sale price"
dos_trade_exits AS (
  SELECT * FROM dos_realized WHERE exit_type = 'trade'
),
dos_trade_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_trade_exits
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dos_trade_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_trade_exits
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- performance_by_deal_out_channel_and_exit_band / ..._by_purpose (Query E)
dos_exitband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),
dos_exitband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),

-- performance_by_deal_out_channel_and_acquisition_band / ..._by_purpose (Query F)
dos_acqband_eligible AS (
  SELECT * FROM dos_realized WHERE acquisition_value_status = 'positive'
),
dos_acqband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_acqband_eligible
  GROUP BY deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dos_acqband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dos_acqband_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
-- MODULE 2: Deal Out Channel Performance — TARGET USER ONLY
-- Population is REALIZED items only (Query A onward) — an open item has
-- no exit deal yet to read a channel from.
-- ============================================================================

dot_realized AS (
  SELECT * FROM target_items WHERE is_realized
),

-- population_summary / purpose_population_summary (Query A)
dot_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dot_realized
),
dot_pop_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS realized_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)                       AS deal_out_channel_known_item_count,
    COUNT(*) FILTER (WHERE deal_out_channel_id IS NULL)                           AS deal_out_channel_missing_item_count,
    ROUND(COUNT(*) FILTER (WHERE deal_out_channel_id IS NOT NULL)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS deal_out_channel_coverage_percent,
    COUNT(DISTINCT deal_out_channel_id) FILTER (WHERE deal_out_channel_id IS NOT NULL) AS distinct_deal_out_channel_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type IS NULL OR exit_type NOT IN ('sale', 'trade')) AS unknown_exit_method_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count
  FROM dot_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- performance_by_deal_out_channel / ..._by_purpose (Query B)
dot_perf_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),
dot_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, deal_out_channel_requires_listing
),

-- cash_sales_by_deal_out_channel / ..._by_purpose (Query C) — the ONLY
-- sections where exit_value may be called "sale price"
dot_cash_sales AS (
  SELECT * FROM dot_realized WHERE exit_type = 'sale'
),
dot_cash_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_cash_sales
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dot_cash_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS sale_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS sale_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_sale_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_sale_price,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_cash_sales
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- trade_exits_by_deal_out_channel / ..._by_purpose (Query D) — exit_value
-- here is an ASSIGNED OUTGOING TRADE VALUE, never a "sale price"
dot_trade_exits AS (
  SELECT * FROM dot_realized WHERE exit_type = 'trade'
),
dot_trade_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_trade_exits
  GROUP BY deal_out_channel_id, deal_out_channel_name
),
dot_trade_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS trade_exit_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS trade_exit_distinct_deal_count,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY exit_value)::numeric, 2)     AS median_assigned_trade_exit_value,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_trade_exits
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name
),

-- performance_by_deal_out_channel_and_exit_band / ..._by_purpose (Query E)
dot_exitband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),
dot_exitband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    exit_value_band_order, exit_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_realized
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, exit_value_band_order, exit_value_band_label
),

-- performance_by_deal_out_channel_and_acquisition_band / ..._by_purpose (Query F)
dot_acqband_eligible AS (
  SELECT * FROM dot_realized WHERE acquisition_value_status = 'positive'
),
dot_acqband_rows AS (
  SELECT
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_acqband_eligible
  GROUP BY deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
),
dot_acqband_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_out_channel_id, deal_out_channel_name,
    acquisition_value_band_order, acquisition_value_band_label,
    COUNT(*)                                                                       AS deal_out_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS deal_out_distinct_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM dot_acqband_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_out_channel_id, deal_out_channel_name, acquisition_value_band_order, acquisition_value_band_label
),

-- ============================================================================
-- MODULE 3: Channel Journey — SHARED (pooled, all users)
-- journey_eligible requires BOTH deal_in_channel_id AND deal_out_channel_id
-- known — a missing-channel realized item is excluded from the journey
-- matrix but counted in population_summary's coverage fields.
-- ============================================================================

cjs_realized AS (
  SELECT * FROM all_items WHERE is_realized
),
cjs_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM cjs_realized
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
),

-- population_summary / purpose_population_summary (Query A)
cjs_pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM cjs_realized)                                            AS realized_item_count,
    (SELECT COUNT(*) FROM cjs_eligible)                                             AS journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjs_realized WHERE deal_in_channel_id IS NULL)            AS missing_deal_in_channel_item_count,
    (SELECT COUNT(*) FROM cjs_realized WHERE deal_out_channel_id IS NULL)           AS missing_deal_out_channel_item_count,
    (SELECT COUNT(*) FROM cjs_realized WHERE deal_in_channel_id IS NULL AND deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND((SELECT COUNT(*) FROM cjs_eligible)::numeric / NULLIF((SELECT COUNT(*) FROM cjs_realized), 0) * 100, 2) AS journey_coverage_percent,
    (SELECT COUNT(*) FROM cjs_eligible WHERE exit_type = 'sale')                    AS journey_sale_exit_item_count,
    (SELECT COUNT(*) FROM cjs_eligible WHERE exit_type = 'trade')                   AS journey_trade_exit_item_count,
    (SELECT COUNT(*) FROM cjs_eligible WHERE is_historical_import)                  AS historical_journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjs_eligible WHERE NOT is_historical_import)              AS app_tracked_journey_eligible_item_count,
    (SELECT COUNT(DISTINCT deal_in_channel_id) FROM cjs_eligible)                   AS distinct_deal_in_channel_count,
    (SELECT COUNT(DISTINCT deal_out_channel_id) FROM cjs_eligible)                  AS distinct_deal_out_channel_count
),
cjs_pop_purpose_rows AS (
  SELECT
    r.group_purpose_id AS current_purpose_id, r.group_purpose_name AS current_purpose_name, r.purpose_policy_status,
    COUNT(*) FILTER (WHERE true)                                                   AS realized_item_count,
    COUNT(e.item_id)                                                               AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL)                           AS missing_deal_in_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_out_channel_id IS NULL)                          AS missing_deal_out_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL AND r.deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND(COUNT(e.item_id)::numeric / NULLIF(COUNT(*), 0) * 100, 2)                AS journey_coverage_percent,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'sale')                           AS journey_sale_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'trade')                          AS journey_trade_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.is_historical_import)                         AS historical_journey_eligible_item_count,
    COUNT(e.item_id) FILTER (WHERE NOT e.is_historical_import)                     AS app_tracked_journey_eligible_item_count,
    COUNT(DISTINCT e.deal_in_channel_id)                                           AS distinct_deal_in_channel_count,
    COUNT(DISTINCT e.deal_out_channel_id)                                          AS distinct_deal_out_channel_count
  FROM cjs_realized r
  LEFT JOIN cjs_eligible e ON e.item_id = r.item_id
  GROUP BY r.group_purpose_id, r.group_purpose_name, r.purpose_policy_status
),

-- deal_in_to_deal_out_matrix / ..._by_purpose (Query B)
cjs_matrix_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),
cjs_matrix_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- same_channel_summary / ..._by_purpose (Query C) — single-row summary
cjs_samechan_row AS (
  SELECT
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjs_eligible
),
cjs_samechan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- same_channel_summary_by_deal_in_channel / ..._by_purpose (Query D)
cjs_samechan_bychan_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
cjs_samechan_bychan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
),

-- paths_by_acquisition_and_exit_method / ..._by_purpose (Query E)
cjs_paths_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
),
cjs_paths_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjs_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
),
-- MODULE 3: Channel Journey — TARGET USER ONLY
-- journey_eligible requires BOTH deal_in_channel_id AND deal_out_channel_id
-- known — a missing-channel realized item is excluded from the journey
-- matrix but counted in population_summary's coverage fields.
-- ============================================================================

cjt_realized AS (
  SELECT * FROM target_items WHERE is_realized
),
cjt_eligible AS (
  SELECT
    *,
    (deal_in_channel_id = deal_out_channel_id) AS is_same_channel_exit
  FROM cjt_realized
  WHERE deal_in_channel_id IS NOT NULL AND deal_out_channel_id IS NOT NULL
),

-- population_summary / purpose_population_summary (Query A)
cjt_pop_row AS (
  SELECT
    (SELECT COUNT(*) FROM cjt_realized)                                            AS realized_item_count,
    (SELECT COUNT(*) FROM cjt_eligible)                                             AS journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjt_realized WHERE deal_in_channel_id IS NULL)            AS missing_deal_in_channel_item_count,
    (SELECT COUNT(*) FROM cjt_realized WHERE deal_out_channel_id IS NULL)           AS missing_deal_out_channel_item_count,
    (SELECT COUNT(*) FROM cjt_realized WHERE deal_in_channel_id IS NULL AND deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND((SELECT COUNT(*) FROM cjt_eligible)::numeric / NULLIF((SELECT COUNT(*) FROM cjt_realized), 0) * 100, 2) AS journey_coverage_percent,
    (SELECT COUNT(*) FROM cjt_eligible WHERE exit_type = 'sale')                    AS journey_sale_exit_item_count,
    (SELECT COUNT(*) FROM cjt_eligible WHERE exit_type = 'trade')                   AS journey_trade_exit_item_count,
    (SELECT COUNT(*) FROM cjt_eligible WHERE is_historical_import)                  AS historical_journey_eligible_item_count,
    (SELECT COUNT(*) FROM cjt_eligible WHERE NOT is_historical_import)              AS app_tracked_journey_eligible_item_count,
    (SELECT COUNT(DISTINCT deal_in_channel_id) FROM cjt_eligible)                   AS distinct_deal_in_channel_count,
    (SELECT COUNT(DISTINCT deal_out_channel_id) FROM cjt_eligible)                  AS distinct_deal_out_channel_count
),
cjt_pop_purpose_rows AS (
  SELECT
    r.group_purpose_id AS current_purpose_id, r.group_purpose_name AS current_purpose_name, r.purpose_policy_status,
    COUNT(*) FILTER (WHERE true)                                                   AS realized_item_count,
    COUNT(e.item_id)                                                               AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL)                           AS missing_deal_in_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_out_channel_id IS NULL)                          AS missing_deal_out_channel_item_count,
    COUNT(*) FILTER (WHERE r.deal_in_channel_id IS NULL AND r.deal_out_channel_id IS NULL) AS missing_both_channels_item_count,
    ROUND(COUNT(e.item_id)::numeric / NULLIF(COUNT(*), 0) * 100, 2)                AS journey_coverage_percent,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'sale')                           AS journey_sale_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.exit_type = 'trade')                          AS journey_trade_exit_item_count,
    COUNT(e.item_id) FILTER (WHERE e.is_historical_import)                         AS historical_journey_eligible_item_count,
    COUNT(e.item_id) FILTER (WHERE NOT e.is_historical_import)                     AS app_tracked_journey_eligible_item_count,
    COUNT(DISTINCT e.deal_in_channel_id)                                           AS distinct_deal_in_channel_count,
    COUNT(DISTINCT e.deal_out_channel_id)                                          AS distinct_deal_out_channel_count
  FROM cjt_realized r
  LEFT JOIN cjt_eligible e ON e.item_id = r.item_id
  GROUP BY r.group_purpose_id, r.group_purpose_name, r.purpose_policy_status
),

-- deal_in_to_deal_out_matrix / ..._by_purpose (Query B)
cjt_matrix_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),
cjt_matrix_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                               AS app_tracked_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(exit_value) FILTER (WHERE exit_value IS NOT NULL)                          AS total_exit_value,
    SUM(net_profit)                                                                AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- same_channel_summary / ..._by_purpose (Query C) — single-row summary
cjt_samechan_row AS (
  SELECT
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjt_eligible
),
cjt_samechan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS journey_eligible_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2)    AS same_channel_exit_percent,
    ROUND(COUNT(*) FILTER (WHERE NOT is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS different_channel_exit_percent,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'sale')            AS same_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit AND exit_type = 'trade')           AS same_channel_trade_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'sale')        AS different_channel_sale_exit_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit AND exit_type = 'trade')       AS different_channel_trade_exit_count
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),

-- same_channel_summary_by_deal_in_channel / ..._by_purpose (Query D)
cjt_samechan_bychan_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name
),
cjt_samechan_bychan_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name,
    COUNT(*)                                                                       AS eligible_realized_item_count,
    COUNT(*) FILTER (WHERE is_same_channel_exit)                                   AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE NOT is_same_channel_exit)                               AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_same_channel_exit)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS same_channel_exit_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name
),

-- paths_by_acquisition_and_exit_method / ..._by_purpose (Query E)
cjt_paths_rows AS (
  SELECT
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
),
cjt_paths_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name,
    acquisition_method, exit_method,
    COUNT(*)                                                                       AS journey_item_count,
    COUNT(DISTINCT acquisition_deal_id)                                            AS distinct_acquisition_deal_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM cjt_eligible
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, deal_in_channel_id, deal_in_channel_name, deal_out_channel_id, deal_out_channel_name, acquisition_method, exit_method
)

SELECT jsonb_build_object(
  'shared_deal_channel_evidence', jsonb_build_object(
    'deal_in_channel_performance', jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dis_pop_row)), '[]'::jsonb) FROM dis_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dis_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dis_pop_purpose_rows),
      'performance_by_deal_in_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dis_perf_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_perf_rows),
      'performance_by_deal_in_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dis_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_perf_purpose_rows),
      'performance_by_deal_in_channel_and_method',       (SELECT COALESCE(jsonb_agg(to_jsonb(dis_method_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dis_method_rows),
      'performance_by_deal_in_channel_and_method_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dis_method_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dis_method_purpose_rows),
      'performance_by_deal_in_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dis_band_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dis_band_rows),
      'performance_by_deal_in_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dis_band_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dis_band_purpose_rows),
      'open_inventory_by_deal_in_channel',                (SELECT COALESCE(jsonb_agg(to_jsonb(dis_open_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_open_rows),
      'open_inventory_by_deal_in_channel_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(dis_open_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dis_open_purpose_rows)
    ),
    'deal_out_channel_performance', jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dos_pop_row)), '[]'::jsonb) FROM dos_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dos_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dos_pop_purpose_rows),
      'performance_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dos_perf_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_perf_rows),
      'performance_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dos_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_perf_purpose_rows),
      'cash_sales_by_deal_out_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dos_cash_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_cash_rows),
      'cash_sales_by_deal_out_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dos_cash_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_cash_purpose_rows),
      'trade_exits_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dos_trade_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_trade_rows),
      'trade_exits_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dos_trade_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dos_trade_purpose_rows),
      'performance_by_deal_out_channel_and_exit_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(dos_exitband_rows) ORDER BY deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dos_exitband_rows),
      'performance_by_deal_out_channel_and_exit_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dos_exitband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dos_exitband_purpose_rows),
      'performance_by_deal_out_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dos_acqband_rows) ORDER BY deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dos_acqband_rows),
      'performance_by_deal_out_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dos_acqband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dos_acqband_purpose_rows)
    ),
    'channel_journey', jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_pop_row)), '[]'::jsonb) FROM cjs_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjs_pop_purpose_rows),
      'deal_in_to_deal_out_matrix',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_matrix_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_matrix_rows),
      'deal_in_to_deal_out_matrix_by_purpose',           (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_matrix_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_matrix_purpose_rows),
      'same_channel_summary',                            (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_row)), '[]'::jsonb) FROM cjs_samechan_row),
      'same_channel_summary_by_purpose',                 (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjs_samechan_purpose_rows),
      'same_channel_summary_by_deal_in_channel',          (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_bychan_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_samechan_bychan_rows),
      'same_channel_summary_by_deal_in_channel_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_samechan_bychan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjs_samechan_bychan_purpose_rows),
      'paths_by_acquisition_and_exit_method',             (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_paths_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjs_paths_rows),
      'paths_by_acquisition_and_exit_method_by_purpose',  (SELECT COALESCE(jsonb_agg(to_jsonb(cjs_paths_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjs_paths_purpose_rows)
    )
  ),
  'target_user_deal_channel_evidence', jsonb_build_object(
    'deal_in_channel_performance', jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dit_pop_row)), '[]'::jsonb) FROM dit_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dit_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dit_pop_purpose_rows),
      'performance_by_deal_in_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dit_perf_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_perf_rows),
      'performance_by_deal_in_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dit_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_perf_purpose_rows),
      'performance_by_deal_in_channel_and_method',       (SELECT COALESCE(jsonb_agg(to_jsonb(dit_method_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dit_method_rows),
      'performance_by_deal_in_channel_and_method_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dit_method_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_method), '[]'::jsonb) FROM dit_method_purpose_rows),
      'performance_by_deal_in_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dit_band_rows) ORDER BY deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dit_band_rows),
      'performance_by_deal_in_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dit_band_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dit_band_purpose_rows),
      'open_inventory_by_deal_in_channel',                (SELECT COALESCE(jsonb_agg(to_jsonb(dit_open_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_open_rows),
      'open_inventory_by_deal_in_channel_by_purpose',     (SELECT COALESCE(jsonb_agg(to_jsonb(dit_open_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM dit_open_purpose_rows)
    ),
    'deal_out_channel_performance', jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(dot_pop_row)), '[]'::jsonb) FROM dot_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(dot_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM dot_pop_purpose_rows),
      'performance_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dot_perf_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_perf_rows),
      'performance_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dot_perf_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_perf_purpose_rows),
      'cash_sales_by_deal_out_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(dot_cash_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_cash_rows),
      'cash_sales_by_deal_out_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(dot_cash_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_cash_purpose_rows),
      'trade_exits_by_deal_out_channel',                 (SELECT COALESCE(jsonb_agg(to_jsonb(dot_trade_rows) ORDER BY deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_trade_rows),
      'trade_exits_by_deal_out_channel_by_purpose',      (SELECT COALESCE(jsonb_agg(to_jsonb(dot_trade_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM dot_trade_purpose_rows),
      'performance_by_deal_out_channel_and_exit_band',   (SELECT COALESCE(jsonb_agg(to_jsonb(dot_exitband_rows) ORDER BY deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dot_exitband_rows),
      'performance_by_deal_out_channel_and_exit_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dot_exitband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, exit_value_band_order), '[]'::jsonb) FROM dot_exitband_purpose_rows),
      'performance_by_deal_out_channel_and_acquisition_band', (SELECT COALESCE(jsonb_agg(to_jsonb(dot_acqband_rows) ORDER BY deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dot_acqband_rows),
      'performance_by_deal_out_channel_and_acquisition_band_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(dot_acqband_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_value_band_order), '[]'::jsonb) FROM dot_acqband_purpose_rows)
    ),
    'channel_journey', jsonb_build_object(
      'population_summary',                             (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_pop_row)), '[]'::jsonb) FROM cjt_pop_row),
      'purpose_population_summary',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_pop_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjt_pop_purpose_rows),
      'deal_in_to_deal_out_matrix',                      (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_matrix_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_matrix_rows),
      'deal_in_to_deal_out_matrix_by_purpose',           (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_matrix_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_matrix_purpose_rows),
      'same_channel_summary',                            (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_row)), '[]'::jsonb) FROM cjt_samechan_row),
      'same_channel_summary_by_purpose',                 (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST), '[]'::jsonb) FROM cjt_samechan_purpose_rows),
      'same_channel_summary_by_deal_in_channel',          (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_bychan_rows) ORDER BY deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_samechan_bychan_rows),
      'same_channel_summary_by_deal_in_channel_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_samechan_bychan_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST), '[]'::jsonb) FROM cjt_samechan_bychan_purpose_rows),
      'paths_by_acquisition_and_exit_method',             (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_paths_rows) ORDER BY deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjt_paths_rows),
      'paths_by_acquisition_and_exit_method_by_purpose',  (SELECT COALESCE(jsonb_agg(to_jsonb(cjt_paths_purpose_rows) ORDER BY
                                                             CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                             current_purpose_name NULLS LAST, deal_in_channel_name NULLS LAST, deal_out_channel_name NULLS LAST, acquisition_method, exit_method), '[]'::jsonb) FROM cjt_paths_purpose_rows)
    )
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_deal_channel_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_deal_channel_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_deal_channel_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_deal_channel_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_5(p_target_user_id int)
-- Calls build_analytics_snapshot_v2_4 WHOLESALE (which itself validates
-- p_target_user_id and RAISEs on failure — not repeated here), preserves
-- every v2.4 section unchanged, and adds shared_deal_channel_evidence /
-- target_user_deal_channel_evidence as new top-level keys.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_5(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v24              jsonb;
  v_generated_at      timestamptz := now();
  v_deal_channel      jsonb;
BEGIN
  v_v24 := public.build_analytics_snapshot_v2_4(p_target_user_id);
  v_deal_channel := public._build_deal_channel_snapshot_v2(p_target_user_id);

  RETURN v_v24
    || jsonb_build_object(
         'snapshot_schema_version', '2.5',
         'analytics_definition_version', '2.5',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'shared_deal_channel_evidence', v_deal_channel -> 'shared_deal_channel_evidence',
         'target_user_deal_channel_evidence', v_deal_channel -> 'target_user_deal_channel_evidence'
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_5(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_5(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_5(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_5(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_5(int) IS
  'Analytics v2.5 — Deal Channel Performance — the current PRODUCTION '
  'analytics snapshot version. SECURITY INVOKER, service_role execution '
  'only. Calls build_analytics_snapshot_v2_4 wholesale (unchanged) and '
  'adds shared_deal_channel_evidence / target_user_deal_channel_evidence, '
  'each containing deal_in_channel_performance, deal_out_channel_'
  'performance, and channel_journey ported from the v1 Deal In Channel, '
  'Deal Out Channel, and Channel Journey files to read every Purpose '
  '(Business/Hybrid/Personal/missing-purpose/missing-policy) instead of '
  'Business only. v1.0-v1.8 and v2.0-v2.4 are completely unaffected. '
  'Persists nothing — see analytics_runs (20260727000000) for the '
  'persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v2.5 contract.';
