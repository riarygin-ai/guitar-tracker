-- ============================================================================
-- 07_listing_channel_exposure.sql
--
-- Business questions:
--   - On which listing platforms were Business items exposed?
--   - How often were items cross-listed?
--   - Which listing platforms were associated with realized exits?
--   - Which open inventory remains listed, cross-listed, or not listed?
--
-- EXPERIMENTAL. Read-only. Nothing in this file creates a database object
-- (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- ── CHANNEL ANALYTICS, MODULE 3B OF N ───────────────────────────────────
-- This is the fourth Channel Analytics module: Listing Channel Exposure
-- only. Category/Type Performance, Open Inventory Decision Support, AI
-- interpretation, and recommendations/rankings all remain OUT of scope for
-- this file — see analytics/SEMANTIC_CONTRACT.md.
--
-- ── LISTING CHANNEL IS NOT DEAL IN / DEAL OUT CHANNEL ───────────────────
-- Listing Channel is where an item was ADVERTISED, read directly from
-- `item_listings`. It is NOT Deal In Channel (module 1 — where seller/
-- trade-partner contact originated for the ACQUISITION) and NOT Deal Out
-- Channel (module 2 — where buyer/trade-partner contact originated for the
-- EXIT). This file never infers listing exposure from either of those —
-- every exposure fact here comes straight from `item_listings` joined to
-- `deal_channels`. Deal Out Channel is used ONLY in Query D, to relate
-- exposure to a KNOWN separate fact (where the deal that exited the item
-- actually happened), never as a substitute for listing data.
--
-- ── item_listings SCHEMA FINDINGS (read before touching this file) ─────
-- `item_listings` has NO active/current-state column — a `status` column
-- (draft/published/archived) existed briefly but was DROPPED in
-- `20260721000000_migrate_date_listed_to_item_listings.sql`, whose own
-- header states the replacement rule verbatim: "Publication is determined
-- solely by `listed_at IS NOT NULL`." There is no `unlisted_at`/
-- `delisted_at`/`is_active` column anywhere in this schema today. Per this
-- task's own instruction ("if no explicit active-state field exists,
-- define current exposure as an open Business item with an eligible
-- item_listings record and document this limitation"): CURRENT/ACTIVE
-- listing exposure in this file means an OPEN (NOT is_realized) Business
-- item with at least one eligible item_listings record — there is no way,
-- with today's schema, to distinguish "still actively listed" from "was
-- listed once, no longer promoted, but no delisting event was ever
-- recorded." This is a real, acknowledged limitation, not a design choice.
-- `item_listings.deal_channel_id` is `NOT NULL` (enforced since
-- `20260713000001_listing_platform_channels.sql`) — a record can never be
-- missing a channel; see the note on `missing_listing_channel_record_count`
-- in Query A below for what "missing" means in THIS file given that
-- constraint.
--
-- ── ELIGIBLE LISTING RECORD ──────────────────────────────────────────────
-- An item_listings row counts as an ELIGIBLE listing record only if:
--   (a) its `deal_channels.is_listing_platform = true` (Marketplace,
--       Kijiji, Reverb today — NOT "Regular Buyer / Seller", which is a
--       relationship/non-listing channel and is explicitly excluded from
--       every denominator in this file), AND
--   (b) `listed_at IS NOT NULL` (a draft never actually published is not
--       "exposure" — same convention analytics_item_lifecycle itself
--       already uses for marketplace_listed_at/kijiji_listed_at/
--       reverb_listed_at, which are populated only when listed_at is set).
--
-- ── CANONICAL EXPOSURE — ONE ROW PER (ITEM, LISTING CHANNEL) ────────────
-- Multiple item_listings rows CAN exist for the same (inventory_item_id,
-- deal_channel_id) pair — a UNIQUE constraint was added in
-- `20260721000000_migrate_date_listed_to_item_listings.sql` but ONLY if no
-- duplicates existed at that migration's run time; it is not a schema
-- guarantee for all time. This file NEVER double-counts an item on the
-- same channel: eligible records are grouped by (inventory_item_id,
-- deal_channel_id) into one canonical exposure row, preserving
-- `listing_record_count` (the physical record count) alongside
-- `first_listed_at` (`MIN(listed_at)`) and `latest_listed_at`
-- (`MAX(listed_at)`) for that item+channel pair.
--
-- ── CROSS-LISTING IS NON-MUTUALLY-EXCLUSIVE ─────────────────────────────
-- An item may have canonical exposure on more than one Listing Channel.
-- Query B (per-channel performance), D (listing-to-deal-out), and E (open
-- inventory by channel) are ALL exposure-level, not item-level — a
-- cross-listed item appears in MULTIPLE rows across those sections. Their
-- item counts must NEVER be summed across channels and compared to a
-- unique Business item total — that comparison is invalid by construction.
-- Only Query A (population_summary) and Query C (cross_listing_summary)
-- report UNIQUE item counts, each item counted exactly once.
--
-- ── PRIMARY EVIDENCE POPULATION ─────────────────────────────────────────
-- purpose_name = 'Business'. Unlike 05/06 (realized-only), this file
-- reports BOTH open and realized items throughout, because listing
-- exposure is a property items can have well before any exit occurs.
-- Query D narrows further to realized items with a KNOWN Deal Out Channel
-- (the only section that needs an exit fact); Query E/F narrow to open
-- items only.
--
-- ── SAME CHANNEL — DESCRIPTIVE, NOT CAUSAL (see file 06's own header) ───
-- "Same channel" (Query B's same_channel_exit_*, Query D's
-- same_channel_flag) means `listing_channel_id = deal_out_channel_id` — the
-- item was exposed on a channel and its exit also happened through that
-- same channel's contact. This is DESCRIPTIVE EXPOSURE/PATH EVIDENCE ONLY.
-- same_channel_exit_percent is NEVER a "conversion rate" and never implies
-- the listing CAUSED the exit. Query D is explicitly NOT a mutually
-- exclusive journey matrix and NOT a conversion funnel — because one item
-- can have multiple Listing Channel exposures, the SAME realized item may
-- appear in MULTIPLE Query D rows (one per channel it was exposed on).
-- Query D rows represent EXPOSURE ASSOCIATIONS, nothing more.
--
-- ── DOM vs. HOLDING vs. CHANNEL-SPECIFIC LISTING AGE ─────────────────────
-- global_days_on_market (DOM, from the view) is used in Query B (channel
-- performance, realized items only, matching 04/05's own convention).
-- Query E (open inventory) uses a CHANNEL-SPECIFIC listing age instead —
-- `CURRENT_DATE - <that channel's own first_listed_at>` — because a
-- cross-listed item can have staggered per-channel listing dates, and
-- substituting the item's overall (any-channel) first_listed_at would
-- misattribute exposure duration to the wrong channel. Query F
-- (open, zero-eligible-listings) uses `holding_days` read as ownership
-- age, same convention as 01/03/04/05. Historical imports are excluded
-- from holding/ownership-age metrics everywhere in this file, same as
-- every other module.
--
-- ── CONFIDENCE CONVENTION — reused from 02_acquisition_to_exit_analysis.sql ──
-- Every grouped section exposes one `confidence` column, computed from
-- that row's own item count using the SAME 4-tier thresholds used
-- throughout this analytics layer: 1-2 insufficient, 3-5 low, 6-9
-- moderate, 10+ stronger. No new threshold is invented here.
--
-- Each query is fully self-contained (its own WITH clause) so any single
-- query can be copy-pasted and run alone, matching this folder's
-- established convention.
--
-- ── QUERY CLASSIFICATION INDEX ───────────────────────────────────────────
-- Every query below is SHARED AGGREGATE EVIDENCE — pooled across every
-- user accessible to the querying role, returning only counts/medians/
-- labels/percentages, never an item ID, item name, model, or user
-- identity. No per-user channel breakdown exists in this file.
-- ============================================================================


-- ============================================================================
-- QUERY A — Population summary and listing coverage
-- CLASSIFICATION: shared aggregate evidence. UNIQUE ITEM COUNTS ONLY.
-- Run this first. Reconciliation (verify by eye against this row):
--   business_item_count = item_with_eligible_listing_count
--                        + item_without_eligible_listing_count
--   realized_business_item_count = realized_item_with_eligible_listing_count
--                                 + realized_item_without_eligible_listing_count
--   open_business_item_count = open_item_with_eligible_listing_count
--                             + open_item_without_eligible_listing_count
--
-- missing_listing_channel_record_count: item_listings.deal_channel_id is
-- NOT NULL (schema-enforced) — a record can never literally lack a
-- channel. "Missing" here means the record lacks the ONE OTHER thing that
-- makes it count as real exposure: a usable `listed_at` date. These
-- records are never silently dropped — they are counted here for audit
-- visibility, exactly like every other "missing" count in this analytics
-- layer.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
canonical_exposure AS (
  SELECT
    inventory_item_id,
    deal_channel_id,
    COUNT(*)         AS listing_record_count,
    MIN(listed_at)   AS first_listed_at,
    MAX(listed_at)   AS latest_listed_at
  FROM eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
item_has_eligible_listing AS (
  SELECT DISTINCT inventory_item_id FROM canonical_exposure
)
SELECT
  (SELECT COUNT(*) FROM business)                                                       AS business_item_count,
  (SELECT COUNT(*) FROM business WHERE is_realized)                                      AS realized_business_item_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized)                                  AS open_business_item_count,
  (SELECT COUNT(*) FROM business WHERE item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS item_with_eligible_listing_count,
  (SELECT COUNT(*) FROM business WHERE item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS item_without_eligible_listing_count,
  ROUND(
    (SELECT COUNT(*) FROM business WHERE item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing))::numeric
      / NULLIF((SELECT COUNT(*) FROM business), 0) * 100,
    2
  )                                                                                      AS listing_coverage_percent,
  (SELECT COUNT(*) FROM business WHERE is_realized AND item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS realized_item_with_eligible_listing_count,
  (SELECT COUNT(*) FROM business WHERE is_realized AND item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS realized_item_without_eligible_listing_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND item_id IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS open_item_with_eligible_listing_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)) AS open_item_without_eligible_listing_count,
  (SELECT COUNT(*) FROM canonical_exposure)                                              AS eligible_listing_exposure_count,
  (SELECT COALESCE(SUM(listing_record_count), 0) FROM canonical_exposure)                AS eligible_listing_record_count,
  (SELECT COUNT(DISTINCT deal_channel_id) FROM canonical_exposure)                       AS distinct_listing_channel_count,
  (SELECT COUNT(*) FROM public.item_listings il
     JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
     JOIN business b ON b.item_id = il.inventory_item_id
     WHERE dc.is_listing_platform = false)                                               AS ignored_non_listing_channel_record_count,
  (SELECT COUNT(*) FROM public.item_listings il
     JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
     JOIN business b ON b.item_id = il.inventory_item_id
     WHERE dc.is_listing_platform = true AND il.listed_at IS NULL)                       AS missing_listing_channel_record_count;


-- ============================================================================
-- QUERY B — Listing Channel performance (exposure-level, non-mutually-exclusive)
-- CLASSIFICATION: shared aggregate evidence. EXPOSURE COUNTS, not unique
-- item totals — a cross-listed item appears in EVERY eligible channel row
-- it has exposure on. Never sum exposed_item_count across rows and compare
-- to business_item_count (Query A).
--
-- realized_exposed_item_with_known_deal_out_count is the explicit
-- denominator for same_channel_exit_percent — always reported alongside
-- the percentage, per this file's own interpretation-safeguard rule.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
canonical_exposure AS (
  SELECT
    inventory_item_id,
    deal_channel_id,
    COUNT(*)         AS listing_record_count,
    MIN(listed_at)   AS first_listed_at,
    MAX(listed_at)   AS latest_listed_at
  FROM eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
eligible_listing AS (
  SELECT
    b.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count
  FROM business b
  JOIN canonical_exposure ce ON ce.inventory_item_id = b.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
)
SELECT
  listing_channel_id,
  listing_channel_name,
  COUNT(*)                                                                       AS exposed_item_count,
  SUM(listing_record_count)                                                      AS listing_record_count,
  COUNT(*) FILTER (WHERE is_realized)                                            AS realized_exposed_item_count,
  COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_exposed_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
  COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL)        AS realized_exposed_item_with_known_deal_out_count,
  COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id) AS same_channel_exit_item_count,
  COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL AND deal_out_channel_id <> listing_channel_id) AS different_channel_exit_item_count,
  ROUND(
    COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id = listing_channel_id)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_realized AND deal_out_channel_id IS NOT NULL), 0) * 100,
    2
  )                                                                               AS same_channel_exit_percent,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
  SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL) AS realized_acquisition_capital,
  SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM eligible_listing
GROUP BY listing_channel_id, listing_channel_name
ORDER BY listing_channel_name;


-- ============================================================================
-- QUERY C — Cross-listing summary, by unique item
-- CLASSIFICATION: shared aggregate evidence. UNIQUE ITEM COUNTS — each
-- Business item appears in EXACTLY ONE bucket row, based on its OWN total
-- distinct eligible-channel count (0, 1, 2, or 3+). Never claims
-- cross-listing CAUSED better performance — bucket medians are descriptive
-- cohort comparisons only, same interpretive caution as every band/cohort
-- comparison elsewhere in this analytics layer.
--
-- Top-level object shape (not a plain array, unlike every other section in
-- this file): { "buckets": [...], "single_listed_item_count": N,
-- "cross_listed_item_count": N, "cross_listed_item_percent": N } — the
-- three summary scalars are reported ONCE, alongside the per-bucket
-- breakdown, not duplicated onto every bucket row.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
canonical_exposure AS (
  SELECT DISTINCT inventory_item_id, deal_channel_id FROM eligible_records
),
item_channel_counts AS (
  SELECT b.item_id, COUNT(ce.deal_channel_id) AS channel_count
  FROM business b
  LEFT JOIN canonical_exposure ce ON ce.inventory_item_id = b.item_id
  GROUP BY b.item_id
),
bucketed AS (
  SELECT
    b.*,
    icc.channel_count,
    CASE
      WHEN icc.channel_count = 0 THEN 0
      WHEN icc.channel_count = 1 THEN 1
      WHEN icc.channel_count = 2 THEN 2
      ELSE 3
    END AS listing_channel_count_bucket_order,
    CASE
      WHEN icc.channel_count = 0 THEN '0 channels'
      WHEN icc.channel_count = 1 THEN '1 channel'
      WHEN icc.channel_count = 2 THEN '2 channels'
      ELSE '3+ channels'
    END AS listing_channel_count_bucket
  FROM business b
  JOIN item_channel_counts icc ON icc.item_id = b.item_id
),
buckets AS (
  SELECT
    listing_channel_count_bucket_order,
    listing_channel_count_bucket,
    COUNT(*)                                                                       AS business_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    CASE
      WHEN COUNT(*) <= 2 THEN 'insufficient'
      WHEN COUNT(*) <= 5 THEN 'low'
      WHEN COUNT(*) <= 9 THEN 'moderate'
      ELSE 'stronger'
    END AS confidence
  FROM bucketed
  GROUP BY listing_channel_count_bucket_order, listing_channel_count_bucket
)
SELECT
  (SELECT COUNT(*) FROM bucketed WHERE channel_count = 1)  AS single_listed_item_count,
  (SELECT COUNT(*) FROM bucketed WHERE channel_count >= 2) AS cross_listed_item_count,
  ROUND(
    (SELECT COUNT(*) FROM bucketed WHERE channel_count >= 2)::numeric
      / NULLIF((SELECT COUNT(*) FROM bucketed), 0) * 100,
    2
  )                                                          AS cross_listed_item_percent,
  (SELECT jsonb_agg(to_jsonb(buckets) ORDER BY listing_channel_count_bucket_order) FROM buckets) AS buckets;
-- ^ Manual-SQL convenience shape: run as a scalar row (single_listed_item_count/
-- cross_listed_item_count/cross_listed_item_percent alongside a `buckets`
-- JSONB array column). The v1.5 builder assembles the exact same object
-- shape described above.


-- ============================================================================
-- QUERY D — Listing Channel -> Deal Out Channel (exposure associations)
-- CLASSIFICATION: shared aggregate evidence.
-- NOT a mutually exclusive journey matrix. NOT a conversion funnel. Because
-- one realized item can have MULTIPLE Listing Channel exposures, the SAME
-- item may appear in MULTIPLE rows of this result (once per channel it was
-- exposed on) — rows represent EXPOSURE ASSOCIATIONS between a listing
-- channel and the channel through which the item ultimately exited, not a
-- single deterministic path per item.
-- ============================================================================
WITH business AS (
  SELECT * FROM analytics_item_lifecycle WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
canonical_exposure AS (
  SELECT DISTINCT inventory_item_id, deal_channel_id FROM eligible_records
),
eligible_listing AS (
  SELECT
    b.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name
  FROM business b
  JOIN canonical_exposure ce ON ce.inventory_item_id = b.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
realized_with_deal_out AS (
  SELECT * FROM eligible_listing
  WHERE is_realized AND deal_out_channel_id IS NOT NULL
)
SELECT
  listing_channel_id,
  listing_channel_name,
  deal_out_channel_id,
  deal_out_channel_name,
  COUNT(*)                                                                       AS exposed_realized_item_count,
  COUNT(DISTINCT exit_deal_id)                                                   AS distinct_exit_deal_count,
  COUNT(*) FILTER (WHERE exit_type = 'sale')                                     AS sale_exit_item_count,
  COUNT(*) FILTER (WHERE exit_type = 'trade')                                    AS trade_exit_item_count,
  (listing_channel_id = deal_out_channel_id)                                     AS same_channel_flag,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit)::numeric, 2)     AS median_net_profit,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE roi IS NOT NULL)::numeric, 2) AS median_roi,
  COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL)                      AS dom_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
  CASE
    WHEN COUNT(*) <= 2 THEN 'insufficient'
    WHEN COUNT(*) <= 5 THEN 'low'
    WHEN COUNT(*) <= 9 THEN 'moderate'
    ELSE 'stronger'
  END AS confidence
FROM realized_with_deal_out
GROUP BY listing_channel_id, listing_channel_name, deal_out_channel_id, deal_out_channel_name
ORDER BY listing_channel_name, deal_out_channel_name;


-- ============================================================================
-- QUERY E — Open inventory by Listing Channel (exposure-level)
-- CLASSIFICATION: shared aggregate evidence. EXPOSURE COUNTS — a
-- cross-listed OPEN item appears in every eligible channel row it has
-- exposure on, same non-mutually-exclusive rule as Query B/D.
--
-- current_listing_age is CHANNEL-SPECIFIC: CURRENT_DATE minus THIS
-- channel's own canonical first_listed_at — never the item's overall
-- (any-channel) first_listed_at, so a staggered cross-listing date is
-- never misattributed to the wrong channel.
-- ============================================================================
WITH business AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
canonical_exposure AS (
  SELECT
    inventory_item_id,
    deal_channel_id,
    COUNT(*)       AS listing_record_count,
    MIN(listed_at) AS channel_first_listed_at
  FROM eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
open_eligible_listing AS (
  SELECT
    b.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.listing_record_count,
    CASE WHEN b.has_lifecycle_date_issue THEN NULL ELSE (CURRENT_DATE - ce.channel_first_listed_at) END AS current_listing_age_days
  FROM business b
  JOIN canonical_exposure ce ON ce.inventory_item_id = b.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
  WHERE NOT b.is_realized
)
SELECT
  listing_channel_id,
  listing_channel_name,
  COUNT(*)                                                                       AS open_exposed_item_count,
  SUM(listing_record_count)                                                      AS listing_record_count,
  SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS open_acquisition_capital,
  COUNT(*) FILTER (WHERE acquisition_value_status = 'positive' OR acquisition_value_status = 'zero_assigned') AS acquisition_value_known_count,
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
FROM open_eligible_listing
GROUP BY listing_channel_id, listing_channel_name
ORDER BY listing_channel_name;


-- ============================================================================
-- QUERY F — Open, unlisted summary (zero eligible Listing Channels)
-- CLASSIFICATION: shared aggregate evidence. Single-row summary. Ownership
-- age reuses `holding_days` (CURRENT_DATE - acquisition_date for an open
-- item, per the view's own definition), excluding historical imports and
-- any lifecycle-date-issue row, same convention as every other module.
-- ============================================================================
WITH business AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business'
),
eligible_records AS (
  SELECT il.inventory_item_id
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN business b ON b.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
item_has_eligible_listing AS (
  SELECT DISTINCT inventory_item_id FROM eligible_records
),
open_unlisted AS (
  SELECT * FROM business
  WHERE NOT is_realized
    AND item_id NOT IN (SELECT inventory_item_id FROM item_has_eligible_listing)
)
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
FROM open_unlisted;
