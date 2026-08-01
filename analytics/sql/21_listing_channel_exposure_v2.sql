-- ============================================================================
-- 21_listing_channel_exposure_v2.sql
--
-- Purpose-aware v2 port of 07_listing_channel_exposure.sql. See
-- public._build_listing_channel_exposure_snapshot_v2(int)
-- (supabase/migrations/20260817000000_build_analytics_snapshot_v2_6.sql)
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
-- Current Purpose is never presented as Purpose at listing or exit time.
--
-- ── WHAT DID NOT CHANGE ───────────────────────────────────────────────────
-- Listing Channel is where an item was ADVERTISED — read directly from
-- `item_listings` joined to `deal_channels`, never inferred from Deal In
-- or Deal Out Channel. An eligible listing record requires (a)
-- `deal_channels.is_listing_platform = true` (the existing, already-
-- normalized flag — no new flag or hardcoded platform list is introduced
-- here) and (b) `listed_at IS NOT NULL`. Multiple item_listings rows for
-- the same (item, channel) pair collapse into ONE canonical exposure row
-- — never double-counted. Cross-listing is non-mutually-exclusive:
-- performance_by_listing_channel, listing_to_deal_out, and open_
-- inventory_by_listing_channel are EXPOSURE-LEVEL (a cross-listed item
-- appears in multiple rows); only population_summary and
-- cross_listing_summary report UNIQUE item counts. item_listings has NO
-- active/current-state column — CURRENT/ACTIVE exposure means an OPEN
-- item with at least one eligible record; this module never infers a
-- confirmed sale from a listing merely disappearing. "Same channel"
-- (listing_channel_id = deal_out_channel_id) remains descriptive
-- exposure/path evidence only, never a conversion rate. Historical
-- Imports remain eligible for listing/DOM evidence (a historical
-- acquisition does not make a real listing date untrustworthy); excluded
-- ONLY from holding/ownership-age metrics, unchanged from every prior
-- module. Confidence is tiered from the row's own item count (1-2
-- insufficient, 3-5 low, 6-9 moderate, 10+ stronger), unchanged from 07's
-- own convention.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────────
-- ALL SIX of 07's queries are self-classified shared aggregate evidence
-- (see its own "QUERY CLASSIFICATION INDEX") — none are developer-only,
-- so all six are ported in full:
--   Query A -> population_summary
--   Query B -> performance_by_listing_channel
--   Query C -> cross_listing_summary (special shape: scalar fields
--     alongside a nested `buckets` array)
--   Query D -> listing_to_deal_out (exposure associations, NOT a
--     mutually-exclusive matrix)
--   Query E -> open_inventory_by_listing_channel
--   Query F -> open_unlisted_summary
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Query A (shared) is SHARED AGGREGATE EVIDENCE — pooled across every
-- user, no item identity, no per-user grouping.
-- Query B (target) is TARGET-USER-ONLY AGGREGATE EVIDENCE — restricted to
-- one user_id (REPLACE 2 with a real user id), still aggregate-only.
-- ============================================================================

-- Query A -> shared_listing_channel_evidence
WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
-- Listing Channel Exposure — SHARED (pooled, all users)
-- ============================================================================

-- Eligible listing record: deal_channels.is_listing_platform = true AND
-- listed_at IS NOT NULL — the existing, already-normalized flag, reused
-- verbatim (no new flag or hardcoded platform list introduced).
ls_eligible_records AS (
  SELECT
    il.inventory_item_id, il.deal_channel_id, il.listed_at,
    ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
-- Canonical exposure: one row per (item, channel) — never double-counts
-- an item on the same channel even if multiple item_listings rows exist.
ls_canonical_exposure AS (
  SELECT
    inventory_item_id, deal_channel_id, group_purpose_id, group_purpose_name, purpose_policy_status,
    COUNT(*)       AS listing_record_count,
    MIN(listed_at) AS first_listed_at,
    MAX(listed_at) AS latest_listed_at
  FROM ls_eligible_records
  GROUP BY inventory_item_id, deal_channel_id, group_purpose_id, group_purpose_name, purpose_policy_status
),
ls_item_has_eligible_listing AS (
  SELECT DISTINCT inventory_item_id FROM ls_canonical_exposure
),
-- Non-eligible records, for population_summary's audit-visibility counts.
ls_ignored_records AS (
  SELECT il.inventory_item_id
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = false
),
ls_missing_records AS (
  SELECT il.inventory_item_id
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NULL
),

-- population_summary / purpose_population_summary (Query A) — UNIQUE ITEM
-- COUNTS ONLY. Reconciliation: total = with_eligible_listing +
-- without_eligible_listing (same split for realized/open subsets).
ls_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))     AS item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)) AS item_without_eligible_listing_count,
    ROUND(COUNT(*) FILTER (WHERE item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS listing_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))     AS realized_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE is_realized AND item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)) AS realized_item_without_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))     AS open_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)) AS open_item_without_eligible_listing_count,
    (SELECT COUNT(*) FROM ls_canonical_exposure)                                   AS eligible_listing_exposure_count,
    (SELECT COALESCE(SUM(listing_record_count), 0) FROM ls_canonical_exposure)     AS eligible_listing_record_count,
    (SELECT COUNT(DISTINCT deal_channel_id) FROM ls_canonical_exposure)            AS distinct_listing_channel_count,
    (SELECT COUNT(*) FROM ls_ignored_records)                                      AS ignored_non_listing_channel_record_count,
    (SELECT COUNT(*) FROM ls_missing_records)                                      AS missing_listing_channel_record_count
  FROM all_items
),
ls_pop_purpose_rows AS (
  SELECT
    ai.group_purpose_id AS current_purpose_id, ai.group_purpose_name AS current_purpose_name, ai.purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE ai.is_realized)                                         AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized)                                     AS open_item_count,
    COUNT(*) FILTER (WHERE ai.item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))     AS item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE ai.item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)) AS item_without_eligible_listing_count,
    ROUND(COUNT(*) FILTER (WHERE ai.item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS listing_coverage_percent,
    COUNT(*) FILTER (WHERE ai.is_realized AND ai.item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))     AS realized_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE ai.is_realized AND ai.item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)) AS realized_item_without_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.item_id IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing))     AS open_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)) AS open_item_without_eligible_listing_count,
    (SELECT COUNT(*) FROM ls_canonical_exposure ce WHERE ce.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ce.purpose_policy_status = ai.purpose_policy_status)                    AS eligible_listing_exposure_count,
    (SELECT COALESCE(SUM(ce.listing_record_count), 0) FROM ls_canonical_exposure ce WHERE ce.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ce.purpose_policy_status = ai.purpose_policy_status) AS eligible_listing_record_count,
    (SELECT COUNT(DISTINCT ce.deal_channel_id) FROM ls_canonical_exposure ce WHERE ce.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ce.purpose_policy_status = ai.purpose_policy_status) AS distinct_listing_channel_count,
    (SELECT COUNT(*) FROM ls_ignored_records ir JOIN all_items ai2 ON ai2.item_id = ir.inventory_item_id WHERE ai2.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ai2.purpose_policy_status = ai.purpose_policy_status) AS ignored_non_listing_channel_record_count,
    (SELECT COUNT(*) FROM ls_missing_records mr JOIN all_items ai3 ON ai3.item_id = mr.inventory_item_id WHERE ai3.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ai3.purpose_policy_status = ai.purpose_policy_status) AS missing_listing_channel_record_count
  FROM all_items ai
  GROUP BY ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status
),

-- performance_by_listing_channel / ..._by_purpose (Query B) — EXPOSURE-
-- LEVEL, not unique item totals. A cross-listed item appears in every
-- eligible channel row it has exposure on.
ls_eligible_listing AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count
  FROM all_items ai
  JOIN ls_canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
ls_perf_rows AS (
  SELECT
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_exposed_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL)        AS realized_exposed_item_with_known_deal_out_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id) AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL AND deal_out_channel_id <> listing_channel_id) AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id)::numeric / NULLIF(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL), 0) * 100, 2) AS same_channel_exit_percent,
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
  FROM ls_eligible_listing
  GROUP BY listing_channel_id, listing_channel_name
),
ls_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_exposed_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL)        AS realized_exposed_item_with_known_deal_out_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id) AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL AND deal_out_channel_id <> listing_channel_id) AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id)::numeric / NULLIF(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL), 0) * 100, 2) AS same_channel_exit_percent,
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
  FROM ls_eligible_listing
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name
),

-- cross_listing_summary / ..._by_purpose (Query C) — UNIQUE ITEM COUNTS.
-- Special object shape: scalar fields alongside a nested `buckets` array
-- (not a plain array like every other section in this module).
ls_cross_item_channel_counts AS (
  SELECT ai.item_id, ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, ai.is_realized, ai.exit_type, ai.net_profit, ai.roi, ai.global_days_on_market,
    COUNT(ce.deal_channel_id) AS channel_count
  FROM all_items ai
  LEFT JOIN ls_canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  GROUP BY ai.item_id, ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, ai.is_realized, ai.exit_type, ai.net_profit, ai.roi, ai.global_days_on_market
),
ls_cross_bucketed AS (
  SELECT
    *,
    CASE WHEN channel_count = 0 THEN 0 WHEN channel_count = 1 THEN 1 WHEN channel_count = 2 THEN 2 ELSE 3 END AS bucket_order,
    CASE WHEN channel_count = 0 THEN '0 channels' WHEN channel_count = 1 THEN '1 channel' WHEN channel_count = 2 THEN '2 channels' ELSE '3+ channels' END AS bucket_label
  FROM ls_cross_item_channel_counts
),
ls_cross_buckets_pooled AS (
  SELECT
    bucket_order, bucket_label,
    COUNT(*)                                                                       AS business_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ls_cross_bucketed
  GROUP BY bucket_order, bucket_label
),
ls_cross_scalars_pooled AS (
  SELECT
    (SELECT COUNT(*) FROM ls_cross_bucketed WHERE channel_count = 1)  AS single_listed_item_count,
    (SELECT COUNT(*) FROM ls_cross_bucketed WHERE channel_count >= 2) AS cross_listed_item_count,
    ROUND((SELECT COUNT(*) FROM ls_cross_bucketed WHERE channel_count >= 2)::numeric / NULLIF((SELECT COUNT(*) FROM ls_cross_bucketed), 0) * 100, 2) AS cross_listed_item_percent
),
ls_cross_buckets_purpose AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    bucket_order, bucket_label,
    COUNT(*)                                                                       AS business_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ls_cross_bucketed
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, bucket_order, bucket_label
),
ls_cross_scalars_purpose AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*) FILTER (WHERE channel_count = 1)  AS single_listed_item_count,
    COUNT(*) FILTER (WHERE channel_count >= 2) AS cross_listed_item_count,
    ROUND(COUNT(*) FILTER (WHERE channel_count >= 2)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS cross_listed_item_percent
  FROM ls_cross_bucketed
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),
ls_cross_purpose_rows AS (
  SELECT
    s.current_purpose_id, s.current_purpose_name, s.purpose_policy_status,
    s.single_listed_item_count, s.cross_listed_item_count, s.cross_listed_item_percent,
    (SELECT COALESCE(jsonb_agg(to_jsonb(bk) - 'current_purpose_id' - 'current_purpose_name' - 'purpose_policy_status' ORDER BY bk.bucket_order), '[]'::jsonb)
       FROM ls_cross_buckets_purpose bk
       WHERE bk.current_purpose_id IS NOT DISTINCT FROM s.current_purpose_id AND bk.purpose_policy_status = s.purpose_policy_status) AS buckets
  FROM ls_cross_scalars_purpose s
),

-- listing_to_deal_out / ..._by_purpose (Query D) — exposure associations,
-- NOT a mutually-exclusive matrix. A cross-listed realized item appears
-- in multiple rows (one per channel it was exposed on).
ls_realized_with_deal_out AS (
  SELECT * FROM ls_eligible_listing WHERE is_realized AND deal_out_channel_id IS NOT NULL
),
ls_matrix_rows AS (
  SELECT
    listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS exposed_realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    bool_and(listing_channel_id = deal_out_channel_id)                             AS same_channel_flag,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ls_realized_with_deal_out
  GROUP BY listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name
),
ls_matrix_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS exposed_realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    bool_and(listing_channel_id = deal_out_channel_id)                             AS same_channel_flag,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM ls_realized_with_deal_out
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- open_inventory_by_listing_channel / ..._by_purpose (Query E) —
-- EXPOSURE-LEVEL, channel-specific listing age (never the item's overall
-- any-channel first_listed_at).
ls_open_eligible_listing AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count,
    CASE WHEN ai.has_lifecycle_date_issue THEN NULL ELSE (CURRENT_DATE - ce.first_listed_at) END AS current_listing_age_days
  FROM all_items ai
  JOIN ls_canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
  WHERE NOT ai.is_realized
),
ls_open_rows AS (
  SELECT
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS open_exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_listing_age_days IS NOT NULL)                  AS current_listing_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY current_listing_age_days) FILTER (WHERE current_listing_age_days IS NOT NULL)::numeric, 2) AS median_current_listing_age_days,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 60)                        AS items_listing_age_60_plus,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 120)                       AS items_listing_age_120_plus
  FROM ls_open_eligible_listing
  GROUP BY listing_channel_id, listing_channel_name
),
ls_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS open_exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_listing_age_days IS NOT NULL)                  AS current_listing_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY current_listing_age_days) FILTER (WHERE current_listing_age_days IS NOT NULL)::numeric, 2) AS median_current_listing_age_days,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 60)                        AS items_listing_age_60_plus,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 120)                       AS items_listing_age_120_plus
  FROM ls_open_eligible_listing
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name
),

-- open_unlisted_summary / ..._by_purpose (Query F) — single row, zero
-- eligible Listing Channels, open items only.
ls_open_unlisted AS (
  SELECT * FROM all_items
  WHERE NOT is_realized AND item_id NOT IN (SELECT inventory_item_id FROM ls_item_has_eligible_listing)
),
ls_unlisted_row AS (
  SELECT
    COUNT(*)                                                                       AS open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_unlisted_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM ls_open_unlisted
),
ls_unlisted_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_unlisted_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM ls_open_unlisted
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
)
SELECT jsonb_build_object(
    'population_summary',                                (SELECT COALESCE(jsonb_agg(to_jsonb(ls_pop_row)), '[]'::jsonb) FROM ls_pop_row),
    'purpose_population_summary',                         (SELECT COALESCE(jsonb_agg(to_jsonb(ls_pop_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST), '[]'::jsonb) FROM ls_pop_purpose_rows),
    'performance_by_listing_channel',                     (SELECT COALESCE(jsonb_agg(to_jsonb(ls_perf_rows) ORDER BY listing_channel_name NULLS LAST), '[]'::jsonb) FROM ls_perf_rows),
    'performance_by_listing_channel_by_purpose',          (SELECT COALESCE(jsonb_agg(to_jsonb(ls_perf_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST, listing_channel_name NULLS LAST), '[]'::jsonb) FROM ls_perf_purpose_rows),
    'cross_listing_summary',                              (SELECT jsonb_build_object(
                                                              'single_listed_item_count', s.single_listed_item_count,
                                                              'cross_listed_item_count', s.cross_listed_item_count,
                                                              'cross_listed_item_percent', s.cross_listed_item_percent,
                                                              'buckets', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.bucket_order), '[]'::jsonb) FROM ls_cross_buckets_pooled b)
                                                            ) FROM ls_cross_scalars_pooled s),
    'cross_listing_summary_by_purpose',                   (SELECT COALESCE(jsonb_agg(to_jsonb(ls_cross_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST), '[]'::jsonb) FROM ls_cross_purpose_rows),
    'listing_to_deal_out',                                (SELECT COALESCE(jsonb_agg(to_jsonb(ls_matrix_rows) ORDER BY listing_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM ls_matrix_rows),
    'listing_to_deal_out_by_purpose',                     (SELECT COALESCE(jsonb_agg(to_jsonb(ls_matrix_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST, listing_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM ls_matrix_purpose_rows),
    'open_inventory_by_listing_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(ls_open_rows) ORDER BY listing_channel_name NULLS LAST), '[]'::jsonb) FROM ls_open_rows),
    'open_inventory_by_listing_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(ls_open_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST, listing_channel_name NULLS LAST), '[]'::jsonb) FROM ls_open_purpose_rows),
    'open_unlisted_summary',                              (SELECT COALESCE(jsonb_agg(to_jsonb(ls_unlisted_row)), '[]'::jsonb) FROM ls_unlisted_row),
    'open_unlisted_summary_by_purpose',                   (SELECT COALESCE(jsonb_agg(to_jsonb(ls_unlisted_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST), '[]'::jsonb) FROM ls_unlisted_purpose_rows)
);

-- ============================================================================
-- Query B -> target_user_listing_channel_evidence
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
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
  WHERE user_id = 2 -- REPLACE 2 with a real user id
),
-- Listing Channel Exposure — TARGET USER ONLY
-- ============================================================================

-- Eligible listing record: deal_channels.is_listing_platform = true AND
-- listed_at IS NOT NULL — the existing, already-normalized flag, reused
-- verbatim (no new flag or hardcoded platform list introduced).
lt_eligible_records AS (
  SELECT
    il.inventory_item_id, il.deal_channel_id, il.listed_at,
    ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
-- Canonical exposure: one row per (item, channel) — never double-counts
-- an item on the same channel even if multiple item_listings rows exist.
lt_canonical_exposure AS (
  SELECT
    inventory_item_id, deal_channel_id, group_purpose_id, group_purpose_name, purpose_policy_status,
    COUNT(*)       AS listing_record_count,
    MIN(listed_at) AS first_listed_at,
    MAX(listed_at) AS latest_listed_at
  FROM lt_eligible_records
  GROUP BY inventory_item_id, deal_channel_id, group_purpose_id, group_purpose_name, purpose_policy_status
),
lt_item_has_eligible_listing AS (
  SELECT DISTINCT inventory_item_id FROM lt_canonical_exposure
),
-- Non-eligible records, for population_summary's audit-visibility counts.
lt_ignored_records AS (
  SELECT il.inventory_item_id
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = false
),
lt_missing_records AS (
  SELECT il.inventory_item_id
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NULL
),

-- population_summary / purpose_population_summary (Query A) — UNIQUE ITEM
-- COUNTS ONLY. Reconciliation: total = with_eligible_listing +
-- without_eligible_listing (same split for realized/open subsets).
lt_pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))     AS item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)) AS item_without_eligible_listing_count,
    ROUND(COUNT(*) FILTER (WHERE item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS listing_coverage_percent,
    COUNT(*) FILTER (WHERE is_realized AND item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))     AS realized_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE is_realized AND item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)) AS realized_item_without_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))     AS open_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)) AS open_item_without_eligible_listing_count,
    (SELECT COUNT(*) FROM lt_canonical_exposure)                                   AS eligible_listing_exposure_count,
    (SELECT COALESCE(SUM(listing_record_count), 0) FROM lt_canonical_exposure)     AS eligible_listing_record_count,
    (SELECT COUNT(DISTINCT deal_channel_id) FROM lt_canonical_exposure)            AS distinct_listing_channel_count,
    (SELECT COUNT(*) FROM lt_ignored_records)                                      AS ignored_non_listing_channel_record_count,
    (SELECT COUNT(*) FROM lt_missing_records)                                      AS missing_listing_channel_record_count
  FROM all_items
),
lt_pop_purpose_rows AS (
  SELECT
    ai.group_purpose_id AS current_purpose_id, ai.group_purpose_name AS current_purpose_name, ai.purpose_policy_status,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE ai.is_realized)                                         AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized)                                     AS open_item_count,
    COUNT(*) FILTER (WHERE ai.item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))     AS item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE ai.item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)) AS item_without_eligible_listing_count,
    ROUND(COUNT(*) FILTER (WHERE ai.item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS listing_coverage_percent,
    COUNT(*) FILTER (WHERE ai.is_realized AND ai.item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))     AS realized_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE ai.is_realized AND ai.item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)) AS realized_item_without_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.item_id IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing))     AS open_item_with_eligible_listing_count,
    COUNT(*) FILTER (WHERE NOT ai.is_realized AND ai.item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)) AS open_item_without_eligible_listing_count,
    (SELECT COUNT(*) FROM lt_canonical_exposure ce WHERE ce.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ce.purpose_policy_status = ai.purpose_policy_status)                    AS eligible_listing_exposure_count,
    (SELECT COALESCE(SUM(ce.listing_record_count), 0) FROM lt_canonical_exposure ce WHERE ce.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ce.purpose_policy_status = ai.purpose_policy_status) AS eligible_listing_record_count,
    (SELECT COUNT(DISTINCT ce.deal_channel_id) FROM lt_canonical_exposure ce WHERE ce.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ce.purpose_policy_status = ai.purpose_policy_status) AS distinct_listing_channel_count,
    (SELECT COUNT(*) FROM lt_ignored_records ir JOIN all_items ai2 ON ai2.item_id = ir.inventory_item_id WHERE ai2.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ai2.purpose_policy_status = ai.purpose_policy_status) AS ignored_non_listing_channel_record_count,
    (SELECT COUNT(*) FROM lt_missing_records mr JOIN all_items ai3 ON ai3.item_id = mr.inventory_item_id WHERE ai3.group_purpose_id IS NOT DISTINCT FROM ai.group_purpose_id AND ai3.purpose_policy_status = ai.purpose_policy_status) AS missing_listing_channel_record_count
  FROM all_items ai
  GROUP BY ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status
),

-- performance_by_listing_channel / ..._by_purpose (Query B) — EXPOSURE-
-- LEVEL, not unique item totals. A cross-listed item appears in every
-- eligible channel row it has exposure on.
lt_eligible_listing AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count
  FROM all_items ai
  JOIN lt_canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
lt_perf_rows AS (
  SELECT
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_exposed_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL)        AS realized_exposed_item_with_known_deal_out_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id) AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL AND deal_out_channel_id <> listing_channel_id) AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id)::numeric / NULLIF(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL), 0) * 100, 2) AS same_channel_exit_percent,
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
  FROM lt_eligible_listing
  GROUP BY listing_channel_id, listing_channel_name
),
lt_perf_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_exposed_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL)        AS realized_exposed_item_with_known_deal_out_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id) AS same_channel_exit_item_count,
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL AND deal_out_channel_id <> listing_channel_id) AS different_channel_exit_item_count,
    ROUND(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id)::numeric / NULLIF(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL), 0) * 100, 2) AS same_channel_exit_percent,
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
  FROM lt_eligible_listing
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name
),

-- cross_listing_summary / ..._by_purpose (Query C) — UNIQUE ITEM COUNTS.
-- Special object shape: scalar fields alongside a nested `buckets` array
-- (not a plain array like every other section in this module).
lt_cross_item_channel_counts AS (
  SELECT ai.item_id, ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, ai.is_realized, ai.exit_type, ai.net_profit, ai.roi, ai.global_days_on_market,
    COUNT(ce.deal_channel_id) AS channel_count
  FROM all_items ai
  LEFT JOIN lt_canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  GROUP BY ai.item_id, ai.group_purpose_id, ai.group_purpose_name, ai.purpose_policy_status, ai.is_realized, ai.exit_type, ai.net_profit, ai.roi, ai.global_days_on_market
),
lt_cross_bucketed AS (
  SELECT
    *,
    CASE WHEN channel_count = 0 THEN 0 WHEN channel_count = 1 THEN 1 WHEN channel_count = 2 THEN 2 ELSE 3 END AS bucket_order,
    CASE WHEN channel_count = 0 THEN '0 channels' WHEN channel_count = 1 THEN '1 channel' WHEN channel_count = 2 THEN '2 channels' ELSE '3+ channels' END AS bucket_label
  FROM lt_cross_item_channel_counts
),
lt_cross_buckets_pooled AS (
  SELECT
    bucket_order, bucket_label,
    COUNT(*)                                                                       AS business_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM lt_cross_bucketed
  GROUP BY bucket_order, bucket_label
),
lt_cross_scalars_pooled AS (
  SELECT
    (SELECT COUNT(*) FROM lt_cross_bucketed WHERE channel_count = 1)  AS single_listed_item_count,
    (SELECT COUNT(*) FROM lt_cross_bucketed WHERE channel_count >= 2) AS cross_listed_item_count,
    ROUND((SELECT COUNT(*) FROM lt_cross_bucketed WHERE channel_count >= 2)::numeric / NULLIF((SELECT COUNT(*) FROM lt_cross_bucketed), 0) * 100, 2) AS cross_listed_item_percent
),
lt_cross_buckets_purpose AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    bucket_order, bucket_label,
    COUNT(*)                                                                       AS business_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM lt_cross_bucketed
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, bucket_order, bucket_label
),
lt_cross_scalars_purpose AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*) FILTER (WHERE channel_count = 1)  AS single_listed_item_count,
    COUNT(*) FILTER (WHERE channel_count >= 2) AS cross_listed_item_count,
    ROUND(COUNT(*) FILTER (WHERE channel_count >= 2)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS cross_listed_item_percent
  FROM lt_cross_bucketed
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
),
lt_cross_purpose_rows AS (
  SELECT
    s.current_purpose_id, s.current_purpose_name, s.purpose_policy_status,
    s.single_listed_item_count, s.cross_listed_item_count, s.cross_listed_item_percent,
    (SELECT COALESCE(jsonb_agg(to_jsonb(bk) - 'current_purpose_id' - 'current_purpose_name' - 'purpose_policy_status' ORDER BY bk.bucket_order), '[]'::jsonb)
       FROM lt_cross_buckets_purpose bk
       WHERE bk.current_purpose_id IS NOT DISTINCT FROM s.current_purpose_id AND bk.purpose_policy_status = s.purpose_policy_status) AS buckets
  FROM lt_cross_scalars_purpose s
),

-- listing_to_deal_out / ..._by_purpose (Query D) — exposure associations,
-- NOT a mutually-exclusive matrix. A cross-listed realized item appears
-- in multiple rows (one per channel it was exposed on).
lt_realized_with_deal_out AS (
  SELECT * FROM lt_eligible_listing WHERE is_realized AND deal_out_channel_id IS NOT NULL
),
lt_matrix_rows AS (
  SELECT
    listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS exposed_realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    bool_and(listing_channel_id = deal_out_channel_id)                             AS same_channel_flag,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM lt_realized_with_deal_out
  GROUP BY listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name
),
lt_matrix_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name,
    COUNT(*)                                                                       AS exposed_realized_item_count,
    COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    bool_and(listing_channel_id = deal_out_channel_id)                             AS same_channel_flag,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE WHEN COUNT(*) <= 2 THEN 'insufficient' WHEN COUNT(*) <= 5 THEN 'low' WHEN COUNT(*) <= 9 THEN 'moderate' ELSE 'stronger' END AS confidence
  FROM lt_realized_with_deal_out
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name
),

-- open_inventory_by_listing_channel / ..._by_purpose (Query E) —
-- EXPOSURE-LEVEL, channel-specific listing age (never the item's overall
-- any-channel first_listed_at).
lt_open_eligible_listing AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count,
    CASE WHEN ai.has_lifecycle_date_issue THEN NULL ELSE (CURRENT_DATE - ce.first_listed_at) END AS current_listing_age_days
  FROM all_items ai
  JOIN lt_canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
  WHERE NOT ai.is_realized
),
lt_open_rows AS (
  SELECT
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS open_exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_listing_age_days IS NOT NULL)                  AS current_listing_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY current_listing_age_days) FILTER (WHERE current_listing_age_days IS NOT NULL)::numeric, 2) AS median_current_listing_age_days,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 60)                        AS items_listing_age_60_plus,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 120)                       AS items_listing_age_120_plus
  FROM lt_open_eligible_listing
  GROUP BY listing_channel_id, listing_channel_name
),
lt_open_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name,
    COUNT(*)                                                                       AS open_exposed_item_count,
    SUM(listing_record_count)                                                      AS listing_record_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE current_listing_age_days IS NOT NULL)                  AS current_listing_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY current_listing_age_days) FILTER (WHERE current_listing_age_days IS NOT NULL)::numeric, 2) AS median_current_listing_age_days,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 60)                        AS items_listing_age_60_plus,
    COUNT(*) FILTER (WHERE current_listing_age_days >= 120)                       AS items_listing_age_120_plus
  FROM lt_open_eligible_listing
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name
),

-- open_unlisted_summary / ..._by_purpose (Query F) — single row, zero
-- eligible Listing Channels, open items only.
lt_open_unlisted AS (
  SELECT * FROM all_items
  WHERE NOT is_realized AND item_id NOT IN (SELECT inventory_item_id FROM lt_item_has_eligible_listing)
),
lt_unlisted_row AS (
  SELECT
    COUNT(*)                                                                       AS open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_unlisted_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM lt_open_unlisted
),
lt_unlisted_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    COUNT(*)                                                                       AS open_unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_unlisted_acquisition_capital,
    COUNT(*) FILTER (WHERE acquisition_value_status IN ('positive', 'zero_assigned')) AS acquisition_value_known_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS acquisition_value_zero_assigned_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS acquisition_value_unknown_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)                          AS estimated_value_missing_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_upside_available_count,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_net_upside,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS ownership_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS items_ownership_age_120_plus,
    COUNT(*) FILTER (WHERE is_historical_import)                                   AS historical_excluded_from_age_count
  FROM lt_open_unlisted
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status
)

SELECT jsonb_build_object(
    'population_summary',                                (SELECT COALESCE(jsonb_agg(to_jsonb(lt_pop_row)), '[]'::jsonb) FROM lt_pop_row),
    'purpose_population_summary',                         (SELECT COALESCE(jsonb_agg(to_jsonb(lt_pop_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST), '[]'::jsonb) FROM lt_pop_purpose_rows),
    'performance_by_listing_channel',                     (SELECT COALESCE(jsonb_agg(to_jsonb(lt_perf_rows) ORDER BY listing_channel_name NULLS LAST), '[]'::jsonb) FROM lt_perf_rows),
    'performance_by_listing_channel_by_purpose',          (SELECT COALESCE(jsonb_agg(to_jsonb(lt_perf_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST, listing_channel_name NULLS LAST), '[]'::jsonb) FROM lt_perf_purpose_rows),
    'cross_listing_summary',                              (SELECT jsonb_build_object(
                                                              'single_listed_item_count', s.single_listed_item_count,
                                                              'cross_listed_item_count', s.cross_listed_item_count,
                                                              'cross_listed_item_percent', s.cross_listed_item_percent,
                                                              'buckets', (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.bucket_order), '[]'::jsonb) FROM lt_cross_buckets_pooled b)
                                                            ) FROM lt_cross_scalars_pooled s),
    'cross_listing_summary_by_purpose',                   (SELECT COALESCE(jsonb_agg(to_jsonb(lt_cross_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST), '[]'::jsonb) FROM lt_cross_purpose_rows),
    'listing_to_deal_out',                                (SELECT COALESCE(jsonb_agg(to_jsonb(lt_matrix_rows) ORDER BY listing_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM lt_matrix_rows),
    'listing_to_deal_out_by_purpose',                     (SELECT COALESCE(jsonb_agg(to_jsonb(lt_matrix_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST, listing_channel_name NULLS LAST, deal_out_channel_name NULLS LAST), '[]'::jsonb) FROM lt_matrix_purpose_rows),
    'open_inventory_by_listing_channel',                  (SELECT COALESCE(jsonb_agg(to_jsonb(lt_open_rows) ORDER BY listing_channel_name NULLS LAST), '[]'::jsonb) FROM lt_open_rows),
    'open_inventory_by_listing_channel_by_purpose',       (SELECT COALESCE(jsonb_agg(to_jsonb(lt_open_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST, listing_channel_name NULLS LAST), '[]'::jsonb) FROM lt_open_purpose_rows),
    'open_unlisted_summary',                              (SELECT COALESCE(jsonb_agg(to_jsonb(lt_unlisted_row)), '[]'::jsonb) FROM lt_unlisted_row),
    'open_unlisted_summary_by_purpose',                   (SELECT COALESCE(jsonb_agg(to_jsonb(lt_unlisted_purpose_rows) ORDER BY
                                                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                                              current_purpose_name NULLS LAST), '[]'::jsonb) FROM lt_unlisted_purpose_rows)
);

-- ── INTERPRETATION SAFEGUARDS ────────────────────────────────────────────
-- Same as 07_listing_channel_exposure.sql: platform results are
-- descriptive exposure associations, not causal platform performance.
-- Never sum performance_by_listing_channel / listing_to_deal_out / open_
-- inventory_by_listing_channel item counts across channels and compare
-- to population_summary's unique item total — cross-listed items make
-- that comparison invalid by construction. A sale or profit is never
-- attributed exclusively to one listing platform when multiple platforms
-- exposed the same item. Purpose breakdown rows are descriptive only.
--
-- ── LIMITATION ────────────────────────────────────────────────────────────
-- Because one item may be listed on multiple platforms simultaneously,
-- this module cannot exclusively attribute a realized sale, trade, or
-- profit outcome to a single listing platform when cross-listing
-- occurred — every profit/ROI/DOM figure in an exposure-level section
-- describes items exposed on that channel (which may also have been
-- exposed elsewhere), never items whose outcome is solely credited to
-- it. item_listings also has no active/inactive state column, so
-- "current exposure" can only mean "an open item with an eligible
-- listing record today," not "still actively promoted."
