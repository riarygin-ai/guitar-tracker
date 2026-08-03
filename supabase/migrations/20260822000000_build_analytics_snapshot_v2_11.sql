-- build_analytics_snapshot_v2_11
--
-- Analytics v2.11 — Per-Platform Listing-to-Exit Timing. A narrow,
-- additive follow-up to v2.6 (Listing Channel Exposure): adds genuine
-- per-listing-platform listing-to-exit duration fields to
-- performance_by_listing_channel (and its _by_purpose sibling), in both
-- shared_listing_channel_evidence and target_user_listing_channel_evidence.
-- Does NOT implement STRONG_LISTING_PLATFORM (a Findings Selector rule) —
-- that is out of scope for this migration and will be a separate task.
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────
-- v2.6's performance_by_listing_channel carries dom_sample_size /
-- median_days_on_market, but those are GLOBAL lifecycle DOM
-- (global_days_on_market = exit_date - the ITEM'S OWN first_listed_at
-- across ALL its listing channels — see 20260723000000_analytics_item_
-- lifecycle.sql). For a cross-listed item, that date may belong to a
-- DIFFERENT channel than the one a given performance_by_listing_channel
-- row is about. v2.6 never computed a genuinely PER-CHANNEL listing date
-- -> exit date span for realized items (the only per-channel, date-
-- derived field in v2.6, current_listing_age_days, exists solely for OPEN
-- items and measures CURRENT age, not a realized listing-to-exit span).
-- This migration adds that missing metric under clearly distinct field
-- names, without touching or renaming the existing global-DOM fields.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_per_platform_listing_to_exit_timing_v2_11(int)  -- NEW
--   public.build_analytics_snapshot_v2_11(int)                     -- NEW
--
-- ── DEFINITIONS (see analytics/sql/26_per_platform_listing_to_exit_
-- timing_v2_11.sql for a standalone, illustrative copy of this logic) ────
--
-- canonical_channel_listed_at — the earliest valid item_listings.listed_at
--   for a given (user, item, listing channel) triple, where the channel's
--   deal_channels.is_listing_platform = true and listed_at IS NOT NULL.
--   item_listings enforces UNIQUE(inventory_item_id, deal_channel_id), so
--   in practice at most one row can ever exist per (item, channel) pair —
--   the MIN(listed_at) GROUP BY (inventory_item_id, deal_channel_id) below
--   is nonetheless written to canonicalize correctly even if that
--   constraint were ever relaxed, exactly matching v2.6's own
--   ls_canonical_exposure / lt_canonical_exposure canonicalization (this
--   migration does not duplicate a NEW canonicalization rule — it reuses
--   the identical MIN(listed_at) GROUP BY (item, channel) expression v2.6
--   already established, since a v2.6 migration function's CTEs cannot be
--   referenced from a different function — each SQL function body is
--   self-contained).
--
-- channel_listing_to_exit_days — exit_date - canonical_channel_listed_at,
--   computed ONLY for realized items where canonical_channel_listed_at,
--   exit_date are both present AND canonical_channel_listed_at <=
--   exit_date. Same-day listing and exit (difference of exactly 0) is a
--   VALID entry, included in the sample. A row where
--   canonical_channel_listed_at is AFTER exit_date is a data-entry-order
--   inconsistency — EXCLUDED from the timing sample (never a negative
--   duration), but counted separately under invalid_channel_listing_
--   after_exit_count so coverage still reconciles.
--
-- ── CROSS-LISTING (unchanged from v2.6 — read before using any per-
-- channel section) ───────────────────────────────────────────────────────
-- A cross-listed item contributes ONE canonical exposure row per eligible
-- channel — its own canonical_channel_listed_at and (if valid)
-- channel_listing_to_exit_days are computed independently per channel.
-- This migration never infers which platform generated the buyer, and
-- platform cohorts remain non-mutually-exclusive (the same item's profit/
-- ROI/timing may appear under more than one channel's row). Cross-listing
-- EFFECTIVENESS (e.g. "did cross-listing shorten time to sale") is
-- explicitly NOT implemented here — a separate, later rule.
--
-- ── HISTORICAL IMPORT SEMANTICS ──────────────────────────────────────────
-- Historical Imports are NOT excluded from this timing metric merely
-- because their acquisition_date is approximate (that reliability concern
-- applies only to acquisition-date-anchored metrics like holding_days —
-- see every prior module's own "Historical Import" note). This timing is
-- anchored on listed_at and exit_date alone, neither of which depends on
-- acquisition_date, so a Historical Import item is eligible exactly like
-- any other item: canonical_channel_listed_at present, exit_date present,
-- listed_at not after exit_date.
--
-- ── COVERAGE RECONCILIATION (per listing_channel_id, per scope) ─────────
-- realized_exposed_item_count (all realized items with canonical exposure
-- on this channel) splits EXACTLY three ways, with no remainder:
--   channel_listing_to_exit_sample_size        (valid, included in median)
--   + invalid_channel_listing_after_exit_count (listed_at after exit_date)
--   + missing_channel_listing_to_exit_count     (either date absent)
--   = realized_exposed_item_count
-- channel_listing_to_exit_coverage_percent = sample_size / realized_
-- exposed_item_count * 100, so a report can explain exactly why some
-- realized platform exposures are outside the duration sample.
--
-- ── PURPOSE / PRIVACY ────────────────────────────────────────────────────
-- Purpose is never an eligibility filter here (Business, Hybrid, and
-- Personal are all included in both the pooled and the CURRENT-Purpose-
-- only _by_purpose rows, matching every other v2 module's convention — no
-- new Purpose filtering is introduced). Both shared and target scope
-- remain aggregate-only: no item_id, item name, model, notes, email, or
-- listing text is ever selected — only listing_channel_id/name (+ Purpose
-- grouping keys) and aggregate counts/medians, identical privacy posture
-- to every prior channel/journey module.
--
-- ── EXISTING FIELDS ARE UNCHANGED ─────────────────────────────────────────
-- dom_sample_size and median_days_on_market are NOT recomputed, renamed,
-- or reinterpreted by this migration — they remain exactly what v2.6
-- defined: global lifecycle DOM, based on the item's OWN earliest listing
-- across ALL its channels. The new fields
-- (median_channel_listing_to_exit_days et al.) are a DIFFERENT, additional
-- metric — platform-specific exposure timing — added alongside, never
-- substituted in place of the old ones.
--
-- ── ARCHITECTURE ──────────────────────────────────────────────────────────
-- build_analytics_snapshot_v2_11 calls build_analytics_snapshot_v2_10
-- WHOLESALE (v2.10 itself, and every migration before it, is completely
-- untouched by this file) and enriches ONLY the performance_by_listing_
-- channel / performance_by_listing_channel_by_purpose ARRAYS inside
-- shared_listing_channel_evidence / target_user_listing_channel_evidence —
-- every other top-level section, and every other key within those two
-- objects (population_summary, cross_listing_summary, listing_to_deal_out,
-- open_inventory_by_listing_channel, open_unlisted_summary, ...), passes
-- through byte-identical to what v2.10 produced. Because a jsonb `||`
-- merge cannot inject new keys into the ELEMENTS of an existing JSON
-- ARRAY, the enrichment reads v2.10's own array elements via
-- jsonb_array_elements, LEFT JOINs each element (by listing_channel_id,
-- plus Purpose keys for the _by_purpose arrays) against this migration's
-- own newly computed timing rows, and merges the two objects per element
-- via jsonb `||` (so every pre-existing field is the EXACT value v2.10
-- produced — never recomputed by a parallel, potentially-drifting
-- expression) before re-aggregating back into an array in the same order.
-- ============================================================================


-- ============================================================================
-- PART 1: public._build_per_platform_listing_to_exit_timing_v2_11(int)
--
-- Computes ONLY the new timing fields, keyed by listing_channel_id (+
-- Purpose grouping keys for the _by_purpose variant), for both shared
-- (pooled, all users) and target (one user) scope. Returns a single jsonb
-- object with four array keys — shared_pooled, shared_by_purpose,
-- target_pooled, target_by_purpose — which PART 2 merges onto v2.10's
-- existing arrays.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_per_platform_listing_to_exit_timing_v2_11(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH tm_all_items AS (
  SELECT
    *,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
tm_target_items AS (
  SELECT * FROM tm_all_items WHERE user_id = p_target_user_id
),

-- ── SHARED scope (pooled, all users) ─────────────────────────────────────
-- Eligible listing record + canonicalization: byte-identical rule to
-- v2.6's ls_eligible_records / ls_canonical_exposure (is_listing_platform
-- = true, listed_at IS NOT NULL, MIN(listed_at) per (item, channel)) —
-- this migration cannot reference that function's private CTEs, so the
-- identical expression is reproduced here rather than approximated.
tms_eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN tm_all_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
tms_canonical AS (
  SELECT inventory_item_id, deal_channel_id, MIN(listed_at) AS canonical_channel_listed_at
  FROM tms_eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
tms_exposure AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.canonical_channel_listed_at
  FROM tm_all_items ai
  JOIN tms_canonical ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
tms_timed AS (
  SELECT
    *,
    (is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL
       AND canonical_channel_listed_at > exit_date)                                  AS is_invalid_after_exit,
    CASE
      WHEN is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL
           AND canonical_channel_listed_at <= exit_date
      THEN (exit_date - canonical_channel_listed_at)
    END                                                                              AS channel_listing_to_exit_days
  FROM tms_exposure
),
tms_pooled_rows AS (
  SELECT
    listing_channel_id, listing_channel_name,
    COUNT(*) FILTER (WHERE is_realized)                                  AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)     AS channel_listing_to_exit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY channel_listing_to_exit_days)
      FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric, 2)          AS median_channel_listing_to_exit_days,
    ROUND(COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_realized), 0) * 100, 2)                     AS channel_listing_to_exit_coverage_percent,
    COUNT(*) FILTER (WHERE is_invalid_after_exit)                        AS invalid_channel_listing_after_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND channel_listing_to_exit_days IS NULL AND NOT is_invalid_after_exit)
                                                                          AS missing_channel_listing_to_exit_count
  FROM tms_timed
  GROUP BY listing_channel_id, listing_channel_name
),
tms_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name,
    COUNT(*) FILTER (WHERE is_realized)                                  AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)     AS channel_listing_to_exit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY channel_listing_to_exit_days)
      FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric, 2)          AS median_channel_listing_to_exit_days,
    ROUND(COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_realized), 0) * 100, 2)                     AS channel_listing_to_exit_coverage_percent,
    COUNT(*) FILTER (WHERE is_invalid_after_exit)                        AS invalid_channel_listing_after_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND channel_listing_to_exit_days IS NULL AND NOT is_invalid_after_exit)
                                                                          AS missing_channel_listing_to_exit_count
  FROM tms_timed
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name
),

-- ── TARGET scope (one user) ───────────────────────────────────────────────
tmt_eligible_records AS (
  SELECT il.inventory_item_id, il.deal_channel_id, il.listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  JOIN tm_target_items ai ON ai.item_id = il.inventory_item_id
  WHERE dc.is_listing_platform = true AND il.listed_at IS NOT NULL
),
tmt_canonical AS (
  SELECT inventory_item_id, deal_channel_id, MIN(listed_at) AS canonical_channel_listed_at
  FROM tmt_eligible_records
  GROUP BY inventory_item_id, deal_channel_id
),
tmt_exposure AS (
  SELECT
    ai.*,
    ce.deal_channel_id AS listing_channel_id,
    dc.name            AS listing_channel_name,
    ce.canonical_channel_listed_at
  FROM tm_target_items ai
  JOIN tmt_canonical ce ON ce.inventory_item_id = ai.item_id
  JOIN public.deal_channels dc ON dc.id = ce.deal_channel_id
),
tmt_timed AS (
  SELECT
    *,
    (is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL
       AND canonical_channel_listed_at > exit_date)                                  AS is_invalid_after_exit,
    CASE
      WHEN is_realized AND exit_date IS NOT NULL AND canonical_channel_listed_at IS NOT NULL
           AND canonical_channel_listed_at <= exit_date
      THEN (exit_date - canonical_channel_listed_at)
    END                                                                              AS channel_listing_to_exit_days
  FROM tmt_exposure
),
tmt_pooled_rows AS (
  SELECT
    listing_channel_id, listing_channel_name,
    COUNT(*) FILTER (WHERE is_realized)                                  AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)     AS channel_listing_to_exit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY channel_listing_to_exit_days)
      FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric, 2)          AS median_channel_listing_to_exit_days,
    ROUND(COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_realized), 0) * 100, 2)                     AS channel_listing_to_exit_coverage_percent,
    COUNT(*) FILTER (WHERE is_invalid_after_exit)                        AS invalid_channel_listing_after_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND channel_listing_to_exit_days IS NULL AND NOT is_invalid_after_exit)
                                                                          AS missing_channel_listing_to_exit_count
  FROM tmt_timed
  GROUP BY listing_channel_id, listing_channel_name
),
tmt_purpose_rows AS (
  SELECT
    group_purpose_id AS current_purpose_id, group_purpose_name AS current_purpose_name, purpose_policy_status,
    listing_channel_id, listing_channel_name,
    COUNT(*) FILTER (WHERE is_realized)                                  AS realized_exposed_item_count,
    COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)     AS channel_listing_to_exit_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY channel_listing_to_exit_days)
      FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric, 2)          AS median_channel_listing_to_exit_days,
    ROUND(COUNT(*) FILTER (WHERE channel_listing_to_exit_days IS NOT NULL)::numeric
      / NULLIF(COUNT(*) FILTER (WHERE is_realized), 0) * 100, 2)                     AS channel_listing_to_exit_coverage_percent,
    COUNT(*) FILTER (WHERE is_invalid_after_exit)                        AS invalid_channel_listing_after_exit_count,
    COUNT(*) FILTER (WHERE is_realized AND channel_listing_to_exit_days IS NULL AND NOT is_invalid_after_exit)
                                                                          AS missing_channel_listing_to_exit_count
  FROM tmt_timed
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, listing_channel_id, listing_channel_name
)

SELECT jsonb_build_object(
  'shared_pooled',     (SELECT COALESCE(jsonb_agg(to_jsonb(tms_pooled_rows) ORDER BY listing_channel_name NULLS LAST), '[]'::jsonb) FROM tms_pooled_rows),
  'shared_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(tms_purpose_rows) ORDER BY
                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                          current_purpose_name NULLS LAST, listing_channel_name NULLS LAST), '[]'::jsonb) FROM tms_purpose_rows),
  'target_pooled',     (SELECT COALESCE(jsonb_agg(to_jsonb(tmt_pooled_rows) ORDER BY listing_channel_name NULLS LAST), '[]'::jsonb) FROM tmt_pooled_rows),
  'target_by_purpose', (SELECT COALESCE(jsonb_agg(to_jsonb(tmt_purpose_rows) ORDER BY
                          CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                          current_purpose_name NULLS LAST, listing_channel_name NULLS LAST), '[]'::jsonb) FROM tmt_purpose_rows)
);
$$;

REVOKE ALL ON FUNCTION public._build_per_platform_listing_to_exit_timing_v2_11(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_per_platform_listing_to_exit_timing_v2_11(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_per_platform_listing_to_exit_timing_v2_11(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_per_platform_listing_to_exit_timing_v2_11(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_11(p_target_user_id int)
--
-- Calls build_analytics_snapshot_v2_10 WHOLESALE, then enriches ONLY the
-- performance_by_listing_channel / performance_by_listing_channel_by_
-- purpose arrays (see this migration's header for why element-wise jsonb
-- array enrichment, not a top-level `||`, is required). Every other
-- section and every other key is v2.10's own value, untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_11(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH v210 AS MATERIALIZED (
  SELECT public.build_analytics_snapshot_v2_10(p_target_user_id) AS snapshot
),
timing AS MATERIALIZED (
  SELECT public._build_per_platform_listing_to_exit_timing_v2_11(p_target_user_id) AS payload
),

shared_pooled_old AS (
  SELECT (elem ->> 'listing_channel_id')::bigint AS listing_channel_id, elem AS row_json
  FROM v210
  CROSS JOIN LATERAL jsonb_array_elements(v210.snapshot -> 'shared_listing_channel_evidence' -> 'performance_by_listing_channel') AS elem
),
shared_pooled_timing AS (
  SELECT
    (elem ->> 'listing_channel_id')::bigint AS listing_channel_id,
    (elem - 'listing_channel_id' - 'listing_channel_name') AS timing_json
  FROM timing
  CROSS JOIN LATERAL jsonb_array_elements(timing.payload -> 'shared_pooled') AS elem
),
shared_pooled_enriched AS (
  SELECT COALESCE(jsonb_agg(o.row_json || COALESCE(t.timing_json, '{}'::jsonb) ORDER BY o.row_json ->> 'listing_channel_name'), '[]'::jsonb) AS arr
  FROM shared_pooled_old o
  LEFT JOIN shared_pooled_timing t ON t.listing_channel_id = o.listing_channel_id
),

shared_purpose_old AS (
  SELECT
    (elem ->> 'listing_channel_id')::bigint AS listing_channel_id,
    (elem ->> 'current_purpose_id')::bigint AS current_purpose_id,
    (elem ->> 'purpose_policy_status')      AS purpose_policy_status,
    elem AS row_json
  FROM v210
  CROSS JOIN LATERAL jsonb_array_elements(v210.snapshot -> 'shared_listing_channel_evidence' -> 'performance_by_listing_channel_by_purpose') AS elem
),
shared_purpose_timing AS (
  SELECT
    (elem ->> 'listing_channel_id')::bigint AS listing_channel_id,
    (elem ->> 'current_purpose_id')::bigint AS current_purpose_id,
    (elem ->> 'purpose_policy_status')      AS purpose_policy_status,
    (elem - 'listing_channel_id' - 'listing_channel_name' - 'current_purpose_id' - 'current_purpose_name' - 'purpose_policy_status') AS timing_json
  FROM timing
  CROSS JOIN LATERAL jsonb_array_elements(timing.payload -> 'shared_by_purpose') AS elem
),
shared_purpose_enriched AS (
  SELECT COALESCE(jsonb_agg(o.row_json || COALESCE(t.timing_json, '{}'::jsonb)
           ORDER BY
             CASE o.purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
             o.row_json ->> 'current_purpose_name',
             o.row_json ->> 'listing_channel_name'
         ), '[]'::jsonb) AS arr
  FROM shared_purpose_old o
  LEFT JOIN shared_purpose_timing t
    ON t.listing_channel_id = o.listing_channel_id
   AND t.current_purpose_id IS NOT DISTINCT FROM o.current_purpose_id
   AND t.purpose_policy_status = o.purpose_policy_status
),

target_pooled_old AS (
  SELECT (elem ->> 'listing_channel_id')::bigint AS listing_channel_id, elem AS row_json
  FROM v210
  CROSS JOIN LATERAL jsonb_array_elements(v210.snapshot -> 'target_user_listing_channel_evidence' -> 'performance_by_listing_channel') AS elem
),
target_pooled_timing AS (
  SELECT
    (elem ->> 'listing_channel_id')::bigint AS listing_channel_id,
    (elem - 'listing_channel_id' - 'listing_channel_name') AS timing_json
  FROM timing
  CROSS JOIN LATERAL jsonb_array_elements(timing.payload -> 'target_pooled') AS elem
),
target_pooled_enriched AS (
  SELECT COALESCE(jsonb_agg(o.row_json || COALESCE(t.timing_json, '{}'::jsonb) ORDER BY o.row_json ->> 'listing_channel_name'), '[]'::jsonb) AS arr
  FROM target_pooled_old o
  LEFT JOIN target_pooled_timing t ON t.listing_channel_id = o.listing_channel_id
),

target_purpose_old AS (
  SELECT
    (elem ->> 'listing_channel_id')::bigint AS listing_channel_id,
    (elem ->> 'current_purpose_id')::bigint AS current_purpose_id,
    (elem ->> 'purpose_policy_status')      AS purpose_policy_status,
    elem AS row_json
  FROM v210
  CROSS JOIN LATERAL jsonb_array_elements(v210.snapshot -> 'target_user_listing_channel_evidence' -> 'performance_by_listing_channel_by_purpose') AS elem
),
target_purpose_timing AS (
  SELECT
    (elem ->> 'listing_channel_id')::bigint AS listing_channel_id,
    (elem ->> 'current_purpose_id')::bigint AS current_purpose_id,
    (elem ->> 'purpose_policy_status')      AS purpose_policy_status,
    (elem - 'listing_channel_id' - 'listing_channel_name' - 'current_purpose_id' - 'current_purpose_name' - 'purpose_policy_status') AS timing_json
  FROM timing
  CROSS JOIN LATERAL jsonb_array_elements(timing.payload -> 'target_by_purpose') AS elem
),
target_purpose_enriched AS (
  SELECT COALESCE(jsonb_agg(o.row_json || COALESCE(t.timing_json, '{}'::jsonb)
           ORDER BY
             CASE o.purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
             o.row_json ->> 'current_purpose_name',
             o.row_json ->> 'listing_channel_name'
         ), '[]'::jsonb) AS arr
  FROM target_purpose_old o
  LEFT JOIN target_purpose_timing t
    ON t.listing_channel_id = o.listing_channel_id
   AND t.current_purpose_id IS NOT DISTINCT FROM o.current_purpose_id
   AND t.purpose_policy_status = o.purpose_policy_status
)

SELECT
  v210.snapshot
  || jsonb_build_object(
       'snapshot_schema_version', '2.11',
       'analytics_definition_version', '2.11',
       'generated_at', to_jsonb(now())
     )
  || jsonb_build_object(
       'shared_listing_channel_evidence',
         (v210.snapshot -> 'shared_listing_channel_evidence')
         || jsonb_build_object(
              'performance_by_listing_channel', (SELECT arr FROM shared_pooled_enriched),
              'performance_by_listing_channel_by_purpose', (SELECT arr FROM shared_purpose_enriched)
            ),
       'target_user_listing_channel_evidence',
         (v210.snapshot -> 'target_user_listing_channel_evidence')
         || jsonb_build_object(
              'performance_by_listing_channel', (SELECT arr FROM target_pooled_enriched),
              'performance_by_listing_channel_by_purpose', (SELECT arr FROM target_purpose_enriched)
            )
     )
FROM v210;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_11(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_11(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_11(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_11(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_11(int) IS
  'Analytics v2.11 — Per-Platform Listing-to-Exit Timing — the current '
  'PRODUCTION analytics snapshot version. SECURITY INVOKER, service_role '
  'execution only. Calls build_analytics_snapshot_v2_10 wholesale and '
  'enriches ONLY performance_by_listing_channel / performance_by_listing_'
  'channel_by_purpose (both shared and target scope) with genuine '
  'per-platform listing-to-exit duration fields (channel_listing_to_exit_'
  'sample_size, median_channel_listing_to_exit_days, channel_listing_to_'
  'exit_coverage_percent, invalid_channel_listing_after_exit_count, '
  'realized_exposed_item_count, missing_channel_listing_to_exit_count) — '
  'every pre-existing field, including dom_sample_size / median_days_on_'
  'market (global lifecycle DOM, unchanged in meaning), is v2.10''s own '
  'value, never recomputed. Does NOT implement STRONG_LISTING_PLATFORM. '
  'v1.0-v1.8 and v2.0-v2.10 are completely unaffected and remain '
  'independently callable. Persists nothing — see analytics_runs '
  '(20260727000000) for the persistence step. See analytics/README.md '
  'and analytics/SEMANTIC_CONTRACT.md for the full v2.11 contract.';
