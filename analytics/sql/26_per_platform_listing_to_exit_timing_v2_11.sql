-- ============================================================================
-- 26_per_platform_listing_to_exit_timing_v2_11.sql
--
-- Analytics v2.11 — Per-Platform Listing-to-Exit Timing. See public.
-- _build_per_platform_listing_to_exit_timing_v2_11() and public.
-- build_analytics_snapshot_v2_11() (supabase/migrations/
-- 20260822000000_build_analytics_snapshot_v2_11.sql) for the actual
-- production functions and the full, authoritative logic; nothing in this
-- file creates a database object. This file illustrates the core
-- canonicalization + duration computation standalone, target-user scope
-- only (shared scope is the identical expression over ALL users' items
-- instead of one user's).
--
-- ── THE GAP THIS FILLS ────────────────────────────────────────────────────
-- v2.6's performance_by_listing_channel.median_days_on_market is GLOBAL
-- lifecycle DOM (exit_date - the item's own first_listed_at across ALL
-- its listing channels), not a genuinely per-channel span. For a
-- cross-listed item, that date can belong to a channel OTHER than the one
-- the row is about. This adds the missing per-channel metric under a
-- clearly distinct name (median_channel_listing_to_exit_days), without
-- touching the existing global-DOM fields.
--
-- ── QUERY CLASSIFICATION INDEX ────────────────────────────────────────────
-- Query A is SHARED/TARGET AGGREGATE EVIDENCE (pooled median/counts keyed
-- by listing_channel_id, no item-level row) — the same classification as
-- every field it sits beside in performance_by_listing_channel.
--
-- Query A — canonical per-channel listing date, then listing-to-exit
-- duration for realized items only:

WITH eligible_records AS (
  -- is_listing_platform = true, listed_at IS NOT NULL — reused verbatim
  -- from v2.6 (07_listing_channel_exposure.sql Query B's own eligibility
  -- rule); no new flag or hardcoded platform list.
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN public.analytics_item_lifecycle_v2 ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true
    AND il.listed_at IS NOT NULL
    AND ai.user_id = :target_user_id
),
canonical_exposure AS (
  -- item_listings enforces UNIQUE(inventory_item_id, deal_channel_id), so
  -- at most one row can exist per (item, channel) today — MIN(listed_at)
  -- canonicalizes correctly regardless, matching v2.6's own
  -- ls_canonical_exposure / lt_canonical_exposure rule.
  SELECT inventory_item_id, deal_channel_id, MIN(listed_at) AS canonical_channel_listed_at
  FROM eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
exposure AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.canonical_channel_listed_at
  FROM public.analytics_item_lifecycle_v2 ai
  JOIN canonical_exposure ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
  WHERE ai.user_id = :target_user_id
),
timed AS (
  SELECT
    *,
    -- Historical Imports are NOT excluded here — this timing depends only
    -- on listed_at/exit_date, never acquisition_date, unlike holding_days.
    (is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL
       AND canonical_channel_listed_at > exit_date)                                 AS is_invalid_after_exit,
    CASE
      -- Same-day listing and exit (difference of 0) is VALID, included.
      WHEN is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL
           AND canonical_channel_listed_at <= exit_date
      THEN (exit_date - canonical_channel_listed_at)
      -- listed_at AFTER exit_date is a data-entry-order inconsistency —
      -- excluded from the sample (never a negative duration), counted
      -- under invalid_channel_listing_after_exit_count instead.
    END                                                                             AS channel_listing_to_exit_days
  FROM exposure
)
SELECT
  listing_channel_id,
  listing_channel_name,
  COUNT(*) FILTER (WHERE is_realized)                                  AS realized_exposed_item_count,
  COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)     AS channel_listing_to_exit_sample_size,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY channel_listing_to_exit_days)
    FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric, 2)         AS median_channel_listing_to_exit_days,
  -- Coverage reconciles exactly: sample_size + invalid_after_exit_count +
  -- missing_count = realized_exposed_item_count, for every channel.
  ROUND(COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric
    / NULLIF(COUNT(*) FILTER (WHERE is_realized), 0) * 100, 2)                    AS channel_listing_to_exit_coverage_percent,
  COUNT(*) FILTER (WHERE is_invalid_after_exit)                        AS invalid_channel_listing_after_exit_count,
  COUNT(*) FILTER (WHERE is_realized AND channel_listing_to_exit_days IS NULL AND NOT is_invalid_after_exit)
                                                                        AS missing_channel_listing_to_exit_count
FROM timed
GROUP BY listing_channel_id, listing_channel_name
ORDER BY listing_channel_name NULLS LAST;

-- Cross-listed items appear once per eligible channel above (never
-- collapsed into one row) — see this migration's header ("CROSS-LISTING")
-- for why platform cohorts stay non-mutually-exclusive and no buyer
-- attribution is ever inferred. Cross-listing EFFECTIVENESS is explicitly
-- out of scope here — a separate, later rule.
