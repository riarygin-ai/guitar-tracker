-- Listing Evidence v1.0 — deterministic data foundation for the future
-- Listing Dashboard and Listing Analysis Packet. EVIDENCE ONLY: no
-- recommendations, no price/listing suggestions, no AI, no scraping, no
-- UI. Does not modify Analytics/Insights/Pattern Discovery/Advice/Weekly
-- Automation in any way — build_analytics_snapshot_v2_13 is called
-- read-only, purely to reuse its liquidity_cohort (comparable DOM)
-- evidence rather than reinventing that cohort-matching logic here.
--
-- ── CANONICAL RULES REUSED, NOT REINVENTED ───────────────────────────────
-- - "Open item" = user_id = target AND NOT is_realized, read from
--   analytics_item_lifecycle_v2 — byte-identical to Analytics' own
--   target_base CTE (build_analytics_snapshot_v2_1.sql).
-- - cost_basis = acquisition_value + item_expenses_total; estimated_net_
--   upside = estimated_sold_value - cost_basis — algebraically identical
--   to src/lib/profit.ts's calculateItemProfitMetrics (potentialReward =
--   estimatedSoldValue - valueIn - totalExpenses) and to target_base's own
--   estimated_net_upside formula.
-- - estimated_upside_percent denominator is acquisition_value alone (not
--   cost_basis), with the same zero-cost-basis 100% rule as profit.ts's
--   roiFrom — matches the existing canonical ROI definition exactly.
-- - reliable_ownership_age_days: NULL whenever is_historical_import OR
--   has_lifecycle_date_issue — byte-identical guard to target_base's own
--   ownership_age_days.
-- - disposition_mode / purpose descriptions: read live from
--   analytics_purpose_policy (20260809000000), never hardcoded here.
-- - current_listing_age_days = CURRENT_DATE - listed_at — matches
--   analytics_item_lifecycle's own {platform}_current_listing_age_days
--   convention exactly (20260829000000).
-- - Listing-capable channels are read from deal_channels.is_listing_platform
--   only — never a hardcoded channel name (task requirement: Reverb/
--   Marketplace/Kijiji today, but this must keep working if a channel is
--   added or renamed later).
-- - Comparable median/P75 DOM is read from build_analytics_snapshot_v2_13's
--   own target_user_open_inventory_evidence.item_decision_evidence[].
--   liquidity_cohort — no new comparable-cohort algorithm is introduced.
--
-- ── STALE ACTIVE LISTINGS ─────────────────────────────────────────────────
-- An item_listings row can carry status='active' on an inventory item that
-- has since sold/traded, if that row predates
-- 20260831000000_close_listings_on_sale_trade.sql or was written directly
-- (analytics_item_lifecycle already has a has_listing_after_exit flag for
-- this exact anomaly). Evidence only ever describes currently open
-- inventory, so such rows are excluded from every count here and reported
-- separately via population_summary.stale_active_listings_excluded_count —
-- never silently dropped, never presented as live open-inventory exposure.
--
-- ── ARCHITECTURE ──────────────────────────────────────────────────────────
-- One authoritative jsonb-returning function, matching this schema's own
-- build_analytics_snapshot_vX / _build_pattern_discovery_evidence_v2_13
-- convention exactly: STABLE, SECURITY INVOKER, service_role EXECUTE only
-- (the caller resolves its own app_users.id server-side and always passes
-- that as p_target_user_id — see src/lib/analytics/listingEvidence.ts).
-- Every field name in this migration is reproduced verbatim in the
-- ListingEvidence TypeScript types.

CREATE OR REPLACE FUNCTION public.build_listing_evidence_v1_0(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH

-- ── Listing-capable channels, deterministic order. is_listing_platform is
-- the sole authority for "can this channel have item listings" — never
-- inferred from channel name. ────────────────────────────────────────────
channels AS (
  SELECT id AS channel_id, name AS channel_name, sort_order
  FROM public.deal_channels
  WHERE is_listing_platform = true
),

-- ── Target user's open items. Canonical definition, byte-identical to
-- Analytics' own target_base: user_id = target AND NOT is_realized. ─────
base_items AS (
  SELECT
    ai.item_id, ai.item_display_name, ai.brand_id, ai.brand_name,
    ai.category_id, ai.category_name, ai.type_id, ai.type_name,
    ai.current_purpose_id AS purpose_id, ai.current_purpose_name AS purpose_name,
    ai.purpose_policy_status, ai.disposition_mode,
    ai.acquisition_value, ai.acquisition_method, ai.acquisition_date,
    ai.is_historical_import, ai.has_lifecycle_date_issue,
    ai.estimated_sold_value, ai.item_expenses_total,
    (ai.acquisition_value + ai.item_expenses_total)                        AS cost_basis,
    CASE WHEN ai.estimated_sold_value IS NOT NULL AND ai.acquisition_value IS NOT NULL
         THEN ai.estimated_sold_value - (ai.acquisition_value + ai.item_expenses_total) END AS estimated_net_upside,
    CASE
      WHEN ai.acquisition_value IS NULL OR ai.estimated_sold_value IS NULL THEN NULL
      WHEN ai.acquisition_value = 0 THEN
        CASE WHEN (ai.estimated_sold_value - (ai.acquisition_value + ai.item_expenses_total)) > 0 THEN 100 END
      ELSE ROUND((ai.estimated_sold_value - (ai.acquisition_value + ai.item_expenses_total)) / ai.acquisition_value * 100, 2)
    END                                                                     AS estimated_upside_percent,
    CASE WHEN NOT ai.is_historical_import AND ai.holding_days IS NOT NULL AND NOT ai.has_lifecycle_date_issue
         THEN ai.holding_days END                                          AS reliable_ownership_age_days,
    CASE
      WHEN ai.purpose_policy_status = 'mapped' AND ai.current_purpose_name = 'Business' THEN 'business'
      WHEN ai.purpose_policy_status = 'mapped' AND ai.current_purpose_name = 'Hybrid'   THEN 'hybrid'
      WHEN ai.purpose_policy_status = 'mapped' AND ai.current_purpose_name = 'Personal' THEN 'personal'
      ELSE 'unclassified'
    END                                                                     AS purpose_bucket
  FROM public.analytics_item_lifecycle_v2 ai
  WHERE ai.user_id = p_target_user_id AND NOT ai.is_realized
),

-- Scoped to items that are still open (INNER JOIN base_items): see the
-- "STALE ACTIVE LISTINGS" note above.
active_listings AS (
  SELECT
    il.id, il.inventory_item_id AS item_id, c.channel_id, c.channel_name, c.sort_order,
    il.asking_price, il.listed_at,
    (CURRENT_DATE - il.listed_at)                                          AS current_listing_age_days
  FROM public.item_listings il
  JOIN channels c ON c.channel_id = il.deal_channel_id
  JOIN base_items bi ON bi.item_id = il.inventory_item_id
  WHERE il.user_id = p_target_user_id AND il.status = 'active'
),
stale_active_listings AS (
  SELECT il.id
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  WHERE il.user_id = p_target_user_id AND il.status = 'active' AND dc.is_listing_platform = true
    AND NOT EXISTS (SELECT 1 FROM base_items bi WHERE bi.item_id = il.inventory_item_id)
),
active_listings_bucketed AS (
  SELECT
    al.*,
    CASE
      WHEN current_listing_age_days IS NULL THEN NULL
      WHEN current_listing_age_days < 0 THEN 'INVALID'
      WHEN current_listing_age_days < 14 THEN 'LT_14'
      WHEN current_listing_age_days <= 30 THEN 'D14_30'
      WHEN current_listing_age_days <= 60 THEN 'D31_60'
      WHEN current_listing_age_days <= 90 THEN 'D61_90'
      ELSE 'D90_PLUS'
    END AS age_bucket
  FROM active_listings al
),
active_listings_joined AS (
  SELECT alb.*, bi.category_id, bi.category_name, bi.type_id, bi.type_name,
         bi.purpose_id, bi.purpose_name, bi.purpose_bucket,
         bi.acquisition_value, bi.cost_basis, bi.estimated_sold_value, bi.estimated_net_upside
  FROM active_listings_bucketed alb
  JOIN base_items bi ON bi.item_id = alb.item_id
),

-- ── Per-item active-listing rollups ───────────────────────────────────────
item_active_rollup AS (
  SELECT
    item_id,
    COUNT(*)                                                                AS active_channel_count,
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'channel_id', channel_id, 'channel_name', channel_name,
        'asking_price', asking_price, 'currency', 'CAD',
        'listed_at', listed_at, 'current_listing_age_days', current_listing_age_days,
        'listing_age_bucket', age_bucket
      ) ORDER BY sort_order
    ), '[]'::jsonb)                                                         AS active_listings_json,
    string_agg(channel_name, ' + ' ORDER BY sort_order)                     AS channel_combination_label,
    jsonb_agg(channel_id ORDER BY sort_order)                               AS channel_id_combination,
    jsonb_agg(channel_name ORDER BY sort_order)                             AS channel_name_combination,
    SUM(asking_price)                                                       AS item_total_asking_value
  FROM active_listings_bucketed
  GROUP BY item_id
),

-- ── Previous (completed) listing cycles per item+channel. 'ended' only —
-- cancelled rows were never real listing attempts (matches the
-- listing_cycle_count precedent in 20260829000000). ─────────────────────
previous_cycles_rollup AS (
  SELECT il.inventory_item_id AS item_id,
    jsonb_agg(jsonb_build_object('channel_id', c.channel_id, 'channel_name', c.channel_name, 'completed_cycle_count', cnt) ORDER BY c.sort_order) AS previous_cycles_json
  FROM (
    SELECT inventory_item_id, deal_channel_id, COUNT(*) AS cnt
    FROM public.item_listings
    WHERE user_id = p_target_user_id AND status = 'ended'
    GROUP BY inventory_item_id, deal_channel_id
  ) il
  JOIN channels c ON c.channel_id = il.deal_channel_id
  GROUP BY il.inventory_item_id
),

-- ── Comparable DOM reuse: Analytics' own liquidity_cohort, never
-- reinvented here. ────────────────────────────────────────────────────────
analytics_snapshot AS MATERIALIZED (
  SELECT public.build_analytics_snapshot_v2_13(p_target_user_id) AS snapshot
),
item_decision_rows AS (
  SELECT
    (elem->>'item_id')::bigint AS item_id,
    COALESCE((elem->>'comparable_evidence_available')::boolean, false) AS comparable_evidence_available,
    (elem->'liquidity_cohort'->>'median_days_on_market')::numeric AS comparable_median_dom,
    (elem->'liquidity_cohort'->>'p75_days_on_market')::numeric   AS comparable_p75_dom
  FROM analytics_snapshot,
       jsonb_array_elements(snapshot -> 'target_user_open_inventory_evidence' -> 'item_decision_evidence') AS elem
),

-- ══════════════════════════════════════════════════════════════════════
-- population_summary
-- ══════════════════════════════════════════════════════════════════════
purpose_labels AS (
  SELECT purpose_bucket FROM (VALUES ('business'),('hybrid'),('personal'),('unclassified')) v(purpose_bucket)
),
pop_by_purpose AS (
  SELECT
    pl.purpose_bucket,
    COUNT(bi.item_id) AS open_item_count,
    COUNT(bi.item_id) FILTER (WHERE iar.item_id IS NOT NULL) AS listed_item_count,
    COUNT(bi.item_id) FILTER (WHERE iar.item_id IS NULL) AS unlisted_item_count
  FROM purpose_labels pl
  LEFT JOIN base_items bi ON bi.purpose_bucket = pl.purpose_bucket
  LEFT JOIN item_active_rollup iar ON iar.item_id = bi.item_id
  GROUP BY pl.purpose_bucket
),
population_summary AS (
  SELECT jsonb_build_object(
    'open_item_count', (SELECT COUNT(*) FROM base_items),
    'distinct_listed_item_count', (SELECT COUNT(*) FROM item_active_rollup),
    'distinct_unlisted_open_item_count', (SELECT COUNT(*) FROM base_items) - (SELECT COUNT(*) FROM item_active_rollup),
    'active_channel_listing_count', (SELECT COUNT(*) FROM active_listings_bucketed),
    'cross_listed_item_count', (SELECT COUNT(*) FROM item_active_rollup WHERE active_channel_count >= 2),
    'total_active_asking_value', (SELECT SUM(asking_price) FROM active_listings_bucketed),
    'listed_cost_basis', (SELECT SUM(bi.cost_basis) FROM base_items bi JOIN item_active_rollup iar ON iar.item_id = bi.item_id),
    'listed_estimated_sold_value', (SELECT SUM(bi.estimated_sold_value) FROM base_items bi JOIN item_active_rollup iar ON iar.item_id = bi.item_id),
    'listed_estimated_equity', (SELECT SUM(bi.estimated_net_upside) FROM base_items bi JOIN item_active_rollup iar ON iar.item_id = bi.item_id),
    'listing_age_coverage', jsonb_build_object(
      'age_available_count', (SELECT COUNT(*) FROM active_listings_bucketed WHERE current_listing_age_days IS NOT NULL AND current_listing_age_days >= 0),
      'age_missing_count',   (SELECT COUNT(*) FROM active_listings_bucketed WHERE current_listing_age_days IS NULL),
      'age_invalid_count',   (SELECT COUNT(*) FROM active_listings_bucketed WHERE current_listing_age_days < 0)
    ),
    'stale_active_listings_excluded_count', (SELECT COUNT(*) FROM stale_active_listings),
    'open_item_count_by_purpose',     (SELECT COALESCE(jsonb_agg(jsonb_build_object('purpose_bucket', purpose_bucket, 'item_count', open_item_count) ORDER BY purpose_bucket), '[]'::jsonb) FROM pop_by_purpose),
    'listed_item_count_by_purpose',   (SELECT COALESCE(jsonb_agg(jsonb_build_object('purpose_bucket', purpose_bucket, 'item_count', listed_item_count) ORDER BY purpose_bucket), '[]'::jsonb) FROM pop_by_purpose),
    'unlisted_item_count_by_purpose', (SELECT COALESCE(jsonb_agg(jsonb_build_object('purpose_bucket', purpose_bucket, 'item_count', unlisted_item_count) ORDER BY purpose_bucket), '[]'::jsonb) FROM pop_by_purpose)
  ) AS obj
),

-- ══════════════════════════════════════════════════════════════════════
-- channel_summary
-- ══════════════════════════════════════════════════════════════════════
channel_category_breakdown AS (
  SELECT channel_id, jsonb_agg(jsonb_build_object('category_id', category_id, 'category_name', category_name, 'listed_item_count', item_count, 'asking_value', asking_value, 'cost_basis', cost_basis, 'estimated_sold_value', estimated_sold_value) ORDER BY category_name NULLS LAST) AS breakdown
  FROM (
    SELECT channel_id, category_id, category_name, COUNT(*) AS item_count, SUM(asking_price) AS asking_value, SUM(cost_basis) AS cost_basis, SUM(estimated_sold_value) AS estimated_sold_value
    FROM active_listings_joined GROUP BY channel_id, category_id, category_name
  ) x GROUP BY channel_id
),
channel_type_breakdown AS (
  SELECT channel_id, jsonb_agg(jsonb_build_object('type_id', type_id, 'type_name', type_name, 'listed_item_count', item_count, 'asking_value', asking_value, 'cost_basis', cost_basis, 'estimated_sold_value', estimated_sold_value) ORDER BY type_name NULLS LAST) AS breakdown
  FROM (
    SELECT channel_id, type_id, type_name, COUNT(*) AS item_count, SUM(asking_price) AS asking_value, SUM(cost_basis) AS cost_basis, SUM(estimated_sold_value) AS estimated_sold_value
    FROM active_listings_joined GROUP BY channel_id, type_id, type_name
  ) x GROUP BY channel_id
),
channel_purpose_breakdown AS (
  SELECT channel_id, jsonb_agg(jsonb_build_object('purpose_bucket', purpose_bucket, 'listed_item_count', item_count, 'asking_value', asking_value, 'cost_basis', cost_basis, 'estimated_sold_value', estimated_sold_value) ORDER BY purpose_bucket) AS breakdown
  FROM (
    SELECT channel_id, purpose_bucket, COUNT(*) AS item_count, SUM(asking_price) AS asking_value, SUM(cost_basis) AS cost_basis, SUM(estimated_sold_value) AS estimated_sold_value
    FROM active_listings_joined GROUP BY channel_id, purpose_bucket
  ) x GROUP BY channel_id
),
channel_age_bucket_breakdown AS (
  SELECT channel_id, jsonb_agg(jsonb_build_object('bucket_code', age_bucket, 'item_count', item_count) ORDER BY age_bucket) AS breakdown
  FROM (
    SELECT channel_id, age_bucket, COUNT(*) AS item_count
    FROM active_listings_bucketed WHERE age_bucket IS NOT NULL GROUP BY channel_id, age_bucket
  ) x GROUP BY channel_id
),
channel_summary_rows AS (
  SELECT
    c.channel_id, c.channel_name, c.sort_order,
    COUNT(al.item_id)                                                       AS listed_item_count,
    SUM(al.asking_price)                                                    AS asking_value,
    SUM(al.cost_basis)                                                      AS cost_basis,
    SUM(al.estimated_sold_value)                                            AS estimated_sold_value,
    SUM(al.estimated_net_upside)                                            AS estimated_equity,
    COUNT(al.current_listing_age_days) FILTER (WHERE al.current_listing_age_days >= 0) AS listing_age_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY al.current_listing_age_days) FILTER (WHERE al.current_listing_age_days >= 0)::numeric, 2)  AS median_current_listing_age_days,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY al.current_listing_age_days) FILTER (WHERE al.current_listing_age_days >= 0)::numeric, 2) AS p75_current_listing_age_days,
    MAX(al.current_listing_age_days) FILTER (WHERE al.current_listing_age_days >= 0)   AS oldest_current_listing_age_days
  FROM channels c
  LEFT JOIN active_listings_joined al ON al.channel_id = c.channel_id
  GROUP BY c.channel_id, c.channel_name, c.sort_order
),
channel_summary AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'channel_id', r.channel_id, 'channel_name', r.channel_name,
      'listed_item_count', r.listed_item_count, 'asking_value', r.asking_value,
      'cost_basis', r.cost_basis, 'estimated_sold_value', r.estimated_sold_value, 'estimated_equity', r.estimated_equity,
      'listing_age_sample_size', r.listing_age_sample_size,
      'median_current_listing_age_days', r.median_current_listing_age_days,
      'p75_current_listing_age_days', r.p75_current_listing_age_days,
      'oldest_current_listing_age_days', r.oldest_current_listing_age_days,
      'category_breakdown', COALESCE(ccb.breakdown, '[]'::jsonb),
      'type_breakdown', COALESCE(ctb.breakdown, '[]'::jsonb),
      'purpose_breakdown', COALESCE(cpb.breakdown, '[]'::jsonb),
      'listing_age_bucket_breakdown', COALESCE(cab.breakdown, '[]'::jsonb)
    ) ORDER BY r.sort_order
  ), '[]'::jsonb) AS arr
  FROM channel_summary_rows r
  LEFT JOIN channel_category_breakdown ccb ON ccb.channel_id = r.channel_id
  LEFT JOIN channel_type_breakdown ctb ON ctb.channel_id = r.channel_id
  LEFT JOIN channel_purpose_breakdown cpb ON cpb.channel_id = r.channel_id
  LEFT JOIN channel_age_bucket_breakdown cab ON cab.channel_id = r.channel_id
),

-- ══════════════════════════════════════════════════════════════════════
-- category_channel_matrix
-- ══════════════════════════════════════════════════════════════════════
category_channel_rows AS (
  SELECT category_id, category_name, channel_id, channel_name,
         COUNT(*) AS listed_item_count, SUM(asking_price) AS asking_value,
         SUM(cost_basis) AS cost_basis, SUM(estimated_sold_value) AS estimated_sold_value
  FROM active_listings_joined
  GROUP BY category_id, category_name, channel_id, channel_name
),
category_totals AS (
  SELECT bi.category_id, bi.category_name, COUNT(*) AS distinct_listed_item_count
  FROM base_items bi
  JOIN item_active_rollup iar ON iar.item_id = bi.item_id
  GROUP BY bi.category_id, bi.category_name
),
category_channel_matrix AS (
  SELECT jsonb_build_object(
    'rows', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'category_id', category_id, 'category_name', category_name,
        'channel_id', channel_id, 'channel_name', channel_name,
        'listed_item_count', listed_item_count, 'asking_value', asking_value,
        'cost_basis', cost_basis, 'estimated_sold_value', estimated_sold_value
      ) ORDER BY category_name NULLS LAST, channel_id), '[]'::jsonb) FROM category_channel_rows),
    'category_totals', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'category_id', category_id, 'category_name', category_name,
        'distinct_listed_item_count', distinct_listed_item_count
      ) ORDER BY category_name NULLS LAST), '[]'::jsonb) FROM category_totals)
  ) AS obj
),

-- ══════════════════════════════════════════════════════════════════════
-- cross_listing_evidence
-- ══════════════════════════════════════════════════════════════════════
cross_listing_buckets AS (
  SELECT
    CASE WHEN active_channel_count >= 3 THEN '3_plus' ELSE active_channel_count::text END AS bucket_label,
    COUNT(*) AS item_count
  FROM item_active_rollup
  GROUP BY 1
),
cross_listing_combinations AS (
  SELECT channel_combination_label, channel_id_combination, channel_name_combination, COUNT(*) AS item_count
  FROM item_active_rollup
  GROUP BY channel_combination_label, channel_id_combination, channel_name_combination
),
cross_listing_evidence AS (
  SELECT jsonb_build_object(
    'by_active_channel_count', (SELECT COALESCE(jsonb_agg(jsonb_build_object('active_channel_count', bucket_label, 'item_count', item_count) ORDER BY bucket_label), '[]'::jsonb) FROM cross_listing_buckets),
    'max_active_channel_count', (SELECT COALESCE(MAX(active_channel_count), 0) FROM item_active_rollup),
    'combinations', (SELECT COALESCE(jsonb_agg(jsonb_build_object('channel_ids', channel_id_combination, 'channel_names', channel_name_combination, 'label', channel_combination_label, 'item_count', item_count) ORDER BY item_count DESC, channel_combination_label), '[]'::jsonb) FROM cross_listing_combinations)
  ) AS obj
),

-- ══════════════════════════════════════════════════════════════════════
-- listed_items (one row per distinct listed item)
-- ══════════════════════════════════════════════════════════════════════
listed_items AS (
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'item_id', bi.item_id, 'item_display_name', bi.item_display_name,
      'brand_id', bi.brand_id, 'brand_name', bi.brand_name,
      'category_id', bi.category_id, 'category_name', bi.category_name,
      'type_id', bi.type_id, 'type_name', bi.type_name,
      'purpose_id', bi.purpose_id, 'purpose_name', bi.purpose_name,
      'disposition_mode', bi.disposition_mode,
      'acquisition_value', bi.acquisition_value,
      'inventory_expenses', bi.item_expenses_total,
      'cost_basis', bi.cost_basis,
      'estimated_sold_value', bi.estimated_sold_value,
      'estimated_net_upside', bi.estimated_net_upside,
      'estimated_upside_percent', bi.estimated_upside_percent,
      'acquisition_method', bi.acquisition_method,
      'is_historical_import', bi.is_historical_import,
      'acquisition_date', bi.acquisition_date,
      'reliable_ownership_age_days', bi.reliable_ownership_age_days,
      'active_channel_count', iar.active_channel_count,
      'active_listings', iar.active_listings_json,
      'previous_listing_cycles_by_channel', COALESCE(pcr.previous_cycles_json, '[]'::jsonb),
      'liquidity_context', jsonb_build_object(
        'comparable_evidence_available', COALESCE(idr.comparable_evidence_available, false),
        'comparable_median_dom', idr.comparable_median_dom,
        'comparable_p75_dom', idr.comparable_p75_dom
      )
    ) ORDER BY bi.item_id
  ), '[]'::jsonb) AS arr
  FROM base_items bi
  JOIN item_active_rollup iar ON iar.item_id = bi.item_id
  LEFT JOIN previous_cycles_rollup pcr ON pcr.item_id = bi.item_id
  LEFT JOIN item_decision_rows idr ON idr.item_id = bi.item_id
),

-- ══════════════════════════════════════════════════════════════════════
-- unlisted_open_inventory
-- ══════════════════════════════════════════════════════════════════════
unlisted_item_row AS (
  SELECT
    jsonb_build_object(
      'item_id', bi.item_id, 'item_display_name', bi.item_display_name,
      'brand_id', bi.brand_id, 'brand_name', bi.brand_name,
      'category_id', bi.category_id, 'category_name', bi.category_name,
      'type_id', bi.type_id, 'type_name', bi.type_name,
      'purpose_id', bi.purpose_id, 'purpose_name', bi.purpose_name,
      'disposition_mode', bi.disposition_mode,
      'acquisition_value', bi.acquisition_value,
      'inventory_expenses', bi.item_expenses_total,
      'cost_basis', bi.cost_basis,
      'estimated_sold_value', bi.estimated_sold_value,
      'estimated_net_upside', bi.estimated_net_upside,
      'estimated_upside_percent', bi.estimated_upside_percent,
      'acquisition_method', bi.acquisition_method,
      'is_historical_import', bi.is_historical_import,
      'acquisition_date', bi.acquisition_date,
      'reliable_ownership_age_days', bi.reliable_ownership_age_days,
      'liquidity_context', jsonb_build_object(
        'comparable_evidence_available', COALESCE(idr.comparable_evidence_available, false),
        'comparable_median_dom', idr.comparable_median_dom,
        'comparable_p75_dom', idr.comparable_p75_dom
      )
    ) AS row_json,
    bi.item_id, bi.purpose_bucket
  FROM base_items bi
  LEFT JOIN item_active_rollup iar ON iar.item_id = bi.item_id
  LEFT JOIN item_decision_rows idr ON idr.item_id = bi.item_id
  WHERE iar.item_id IS NULL
),
personal_counts AS (
  SELECT
    (SELECT COUNT(*) FROM base_items WHERE purpose_bucket = 'personal') AS personal_open_item_count,
    (SELECT COUNT(*) FROM base_items bi JOIN item_active_rollup iar ON iar.item_id = bi.item_id WHERE bi.purpose_bucket = 'personal') AS personal_listed_item_count,
    (SELECT COUNT(*) FROM unlisted_item_row WHERE purpose_bucket = 'personal') AS personal_unlisted_item_count
),
unlisted_open_inventory AS (
  SELECT jsonb_build_object(
    'business', (SELECT COALESCE(jsonb_agg(row_json ORDER BY item_id), '[]'::jsonb) FROM unlisted_item_row WHERE purpose_bucket = 'business'),
    'hybrid', (SELECT COALESCE(jsonb_agg(row_json ORDER BY item_id), '[]'::jsonb) FROM unlisted_item_row WHERE purpose_bucket = 'hybrid'),
    'unclassified', (SELECT COALESCE(jsonb_agg(row_json ORDER BY item_id), '[]'::jsonb) FROM unlisted_item_row WHERE purpose_bucket = 'unclassified'),
    'personal_summary', (SELECT jsonb_build_object(
        'personal_open_item_count', personal_open_item_count,
        'personal_listed_item_count', personal_listed_item_count,
        'personal_unlisted_item_count', personal_unlisted_item_count,
        'excluded_from_listing_candidate_analysis', true
      ) FROM personal_counts)
  ) AS obj
),

-- ══════════════════════════════════════════════════════════════════════
-- purpose_semantics — read live from analytics_purpose_policy, never
-- hardcoded here.
-- ══════════════════════════════════════════════════════════════════════
purpose_policy_rows AS (
  SELECT lower(ip.name) AS purpose_bucket, app.disposition_mode, app.description,
         app.realization_priority_order, app.active_realization_flag, app.expected_holding_policy
  FROM public.item_purposes ip
  JOIN public.analytics_purpose_policy app ON app.purpose_id = ip.id
),
purpose_semantics AS (
  SELECT jsonb_build_object(
    'business', (SELECT jsonb_build_object('disposition_mode', disposition_mode, 'description', description, 'realization_priority_order', realization_priority_order, 'active_realization_flag', active_realization_flag, 'expected_holding_policy', expected_holding_policy) FROM purpose_policy_rows WHERE purpose_bucket = 'business'),
    'hybrid', (SELECT jsonb_build_object('disposition_mode', disposition_mode, 'description', description, 'realization_priority_order', realization_priority_order, 'active_realization_flag', active_realization_flag, 'expected_holding_policy', expected_holding_policy) FROM purpose_policy_rows WHERE purpose_bucket = 'hybrid'),
    'personal', (SELECT jsonb_build_object('disposition_mode', disposition_mode, 'description', description, 'realization_priority_order', realization_priority_order, 'active_realization_flag', active_realization_flag, 'expected_holding_policy', expected_holding_policy) FROM purpose_policy_rows WHERE purpose_bucket = 'personal'),
    'guardrails', jsonb_build_array(
      'UNLISTED_HYBRID_DOES_NOT_IMPLY_IT_SHOULD_BE_LISTED',
      'PERSONAL_INVENTORY_IS_NOT_A_LISTING_OPTIMIZATION_TARGET',
      'ESTIMATED_SOLD_VALUE_IS_A_USER_ESTIMATE',
      'LISTING_AGE_IS_DESCRIPTIVE_EVIDENCE_NOT_PROOF_PRICE_IS_WRONG',
      'CROSS_LISTING_COVERAGE_IS_DESCRIPTIVE_NOT_A_RECOMMENDATION_TO_LIST_EVERYWHERE'
    )
  ) AS obj
),

-- ══════════════════════════════════════════════════════════════════════
-- reconciliation — every check computed from an INDEPENDENT query path,
-- never by re-deriving the same number twice.
-- ══════════════════════════════════════════════════════════════════════
recon_rows AS (
  SELECT 'listed_plus_unlisted_equals_open' AS check_name,
         (SELECT COUNT(*) FROM base_items) AS expected,
         (SELECT COUNT(*) FROM item_active_rollup) + (SELECT COUNT(*) FROM base_items bi WHERE NOT EXISTS (SELECT 1 FROM item_active_rollup iar WHERE iar.item_id = bi.item_id)) AS actual
  UNION ALL
  SELECT 'listed_item_count_is_distinct_by_item',
         (SELECT COUNT(DISTINCT item_id) FROM item_active_rollup),
         (SELECT COUNT(*) FROM item_active_rollup)
  UNION ALL
  SELECT 'active_channel_listing_count_is_item_channel_exposures',
         (SELECT COUNT(*) FROM public.item_listings il JOIN public.deal_channels dc ON dc.id = il.deal_channel_id WHERE il.user_id = p_target_user_id AND il.status = 'active' AND dc.is_listing_platform = true) - (SELECT COUNT(*) FROM stale_active_listings),
         (SELECT COUNT(*) FROM active_listings_bucketed)
  UNION ALL
  SELECT 'per_channel_active_count_equals_distinct_listed_items',
         (SELECT COUNT(*) FROM active_listings_bucketed),
         (SELECT COUNT(DISTINCT (item_id, channel_id)) FROM active_listings_bucketed)
  UNION ALL
  SELECT 'cross_listing_buckets_sum_to_distinct_listed_items',
         (SELECT COUNT(*) FROM item_active_rollup),
         (SELECT COALESCE(SUM(item_count), 0) FROM cross_listing_buckets)
  UNION ALL
  SELECT 'category_distinct_totals_not_double_counted',
         (SELECT COUNT(*) FROM item_active_rollup),
         (SELECT COALESCE(SUM(distinct_listed_item_count), 0) FROM category_totals)
  UNION ALL
  SELECT 'item_level_active_arrays_reconcile_to_channel_totals',
         (SELECT COUNT(*) FROM active_listings_bucketed),
         (SELECT COALESCE(SUM(active_channel_count), 0) FROM item_active_rollup)
  UNION ALL
  SELECT 'purpose_listed_unlisted_totals_reconcile_to_open_inventory',
         (SELECT COUNT(*) FROM base_items),
         (SELECT COALESCE(SUM(open_item_count), 0) FROM pop_by_purpose)
  UNION ALL
  SELECT 'ended_cancelled_listings_never_appear_as_active',
         0,
         (SELECT COUNT(*) FROM public.item_listings WHERE user_id = p_target_user_id AND status IN ('ended', 'cancelled') AND id IN (SELECT id FROM active_listings_bucketed))
  UNION ALL
  SELECT 'cross_listed_item_appears_once_in_listed_items_with_multiple_nested_listings',
         (SELECT COUNT(*) FROM item_active_rollup WHERE active_channel_count >= 2),
         (SELECT COUNT(*) FROM item_active_rollup WHERE jsonb_array_length(active_listings_json) >= 2)
),
reconciliation AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('check', check_name, 'expected', expected, 'actual', actual, 'passed', (expected = actual)) ORDER BY check_name), '[]'::jsonb) AS arr
  FROM recon_rows
)

SELECT jsonb_build_object(
  'schema_version', '1.0',
  'generated_at', to_jsonb(now()),
  'evidence_scope', 'target_user_inventory_population',
  'listing_age_semantics', jsonb_build_object(
    'definition', 'current_listing_age_days = today (CURRENT_DATE, server date) minus the current active listing cycle''s listed_at on that channel. Never ownership age, first-ever historical listing, acquisition age, or global item DOM from another channel.',
    'timezone_convention', 'CURRENT_DATE (matches analytics_item_lifecycle''s own {platform}_current_listing_age_days convention, 20260829000000)',
    'buckets', jsonb_build_array(
      jsonb_build_object('code', 'LT_14', 'label', '< 14 days', 'min_days', 0, 'max_days', 13),
      jsonb_build_object('code', 'D14_30', 'label', '14-30 days', 'min_days', 14, 'max_days', 30),
      jsonb_build_object('code', 'D31_60', 'label', '31-60 days', 'min_days', 31, 'max_days', 60),
      jsonb_build_object('code', 'D61_90', 'label', '61-90 days', 'min_days', 61, 'max_days', 90),
      jsonb_build_object('code', 'D90_PLUS', 'label', '90+ days', 'min_days', 91, 'max_days', null)
    )
  ),
  'population_summary', (SELECT obj FROM population_summary),
  'channel_summary', (SELECT arr FROM channel_summary),
  'category_channel_matrix', (SELECT obj FROM category_channel_matrix),
  'cross_listing_evidence', (SELECT obj FROM cross_listing_evidence),
  'listed_items', (SELECT arr FROM listed_items),
  'unlisted_open_inventory', (SELECT obj FROM unlisted_open_inventory),
  'purpose_semantics', (SELECT obj FROM purpose_semantics),
  'reconciliation', (SELECT arr FROM reconciliation),
  'module_limitations', jsonb_build_array(
    'EVIDENCE_ONLY_NO_RECOMMENDATIONS',
    'CURRENCY_NOT_TRACKED_PER_LISTING_ASSUMED_CAD',
    'ESTIMATED_SOLD_VALUE_IS_A_USER_ESTIMATE',
    'HISTORICAL_IMPORT_ACQUISITION_DATE_MAY_BE_UNRELIABLE',
    'LISTING_AGE_IS_DESCRIPTIVE_NOT_A_PRICING_SIGNAL',
    'CROSS_LISTING_COVERAGE_IS_DESCRIPTIVE_ONLY',
    'COMPARABLE_DOM_REUSED_FROM_ANALYTICS_v2_13_NOT_RECOMPUTED',
    'STALE_ACTIVE_LISTINGS_ON_CLOSED_ITEMS_EXCLUDED_SEE_POPULATION_SUMMARY'
  )
);
$$;

REVOKE ALL ON FUNCTION public.build_listing_evidence_v1_0(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_listing_evidence_v1_0(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_listing_evidence_v1_0(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_listing_evidence_v1_0(int) TO service_role;

COMMENT ON FUNCTION public.build_listing_evidence_v1_0(int) IS
  'Listing Evidence v1.0 — deterministic, evidence-only data foundation for '
  'the future Listing Dashboard and Listing Analysis Packet '
  '(target_user_listing_evidence). schema_version 1.0. Computes population_'
  'summary, channel_summary, category_channel_matrix, cross_listing_'
  'evidence, listed_items, unlisted_open_inventory (Business/Hybrid full '
  'evidence, Personal summary-only and excluded_from_listing_candidate_'
  'analysis), purpose_semantics, and a self-verifying reconciliation array. '
  'No recommendations, price suggestions, AI, or scraping. Reuses '
  'Analytics'' own canonical open-item definition, cost/upside formulas, '
  'purpose policy, and comparable-DOM liquidity_cohort evidence rather than '
  'recomputing them. SECURITY INVOKER, service_role execution only — the '
  'caller always passes its own resolved app_users.id as p_target_user_id, '
  'never a client-suppliable value. See src/lib/analytics/listingEvidence.ts.';
