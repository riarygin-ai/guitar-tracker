-- analytics_item_lifecycle
--
-- Analytical foundation for future Business Coach / dashboard / data-analysis
-- features. One row per inventory item, combining item, acquisition, listing,
-- exit, expense, tag, profitability, and lifecycle-timing data.
--
-- GRAIN: exactly one row per public.inventory_items row. Every join below is
-- either to a dimension table via its primary key (at most one match) or to
-- a pre-aggregated CTE that is grouped/deduplicated down to at most one row
-- per item_id before it is joined. No join in this view can multiply rows.
--
-- SCOPE / RLS: this is an ordinary view created WITH (security_invoker = true),
-- so it exposes exactly the inventory_items (and related) rows the querying
-- role can already read under the base tables' own RLS policies — it adds no
-- extra "WHERE user_id = ..." restriction of its own. `user_id` is exposed
-- as-is from inventory_items.user_id (not renamed) so a future
-- organizations/organization_members/inventory_items.organization_id model
-- can be layered in by changing base-table RLS, without changing any
-- lifecycle formula in this view.
--   NOTE: this deliberately diverges from this project's other views
--   (inventory_items_with_value / inventory_items_search), which use an
--   explicit `WHERE i.user_id = public.get_app_user_id()` clause instead of
--   security_invoker — see 20260621000001_fix_views_explicit_user_filter.sql,
--   which abandoned security_invoker after a prior production RLS data leak
--   because it was suspected not to behave as expected on the remote
--   database at that time. This view uses security_invoker per this
--   feature's explicit multi-tenant-compatibility requirement (local
--   Postgres is confirmed 17, which fully supports it). Re-verify RLS
--   behavior with two distinct test users after deploying; if any leak is
--   observed, fall back to the explicit-WHERE pattern used elsewhere in
--   this schema.
--
-- LISTING EXPOSURE LIMITATION: the app does not track listing removal,
-- pausing, or relisting. All "days on market" / "listing age" metrics here
-- measure time since the earliest *recorded* listed_at, not actual
-- continuous ad-active duration.
--
-- PLATFORM METRIC LIMITATION: per-platform delay/age/days_to_exit measure
-- platform exposure prior to exit. They do not imply that any particular
-- platform caused the sale/trade.
--
-- HISTORICAL IMPORT LIMITATION: as of this migration, the app has no
-- documented placeholder/sentinel acquisition-date convention for Historical
-- Imports — create_item_with_historical_import requires a real, user-
-- provided acquisition_date (RAISE EXCEPTION if NULL). acquisition_method
-- has no dedicated column anywhere in the schema; it is derived entirely
-- from deals.deal_type ('purchase' -> cash, 'trade' -> trade,
-- 'Historical Import' -> unknown). acquisition_date_is_placeholder is
-- therefore always false today; the column is kept so a future placeholder
-- convention can populate it without a further migration touching this
-- view's shape.
--
-- REALIZED-PROFIT FORMULAS: gross_profit = exit_value - acquisition_value;
-- net_profit = gross_profit - item_expenses_total; roi = (net_profit /
-- acquisition_value) * 100 — expressed as a PERCENTAGE, matching the
-- existing convention in src/app/page.tsx's brand-performance ROI calc, not
-- a 0-1 ratio. All three are NULL for non-realized (open) items, and roi is
-- additionally NULL when acquisition_value is NULL or <= 0.
--
-- CONDITION DIMENSION: inventory_items.condition is a plain text column —
-- there is no conditions lookup table in this schema, so this view exposes
-- only condition_name (no condition_id; one was not fabricated).
--
-- TAG ARRAYS: tag_ids/tag_names are deduplicated (backed by the
-- inventory_item_tags UNIQUE(item_id, tag_id) constraint), sorted by tag
-- name then id, and returned as empty arrays (never NULL) with
-- tag_count = 0 when an item has no tags.
--
-- INVALID DATE POLICY: has_listing_before_acquisition / has_listing_after_exit
-- / has_lifecycle_date_issue flag impossible date sequences explicitly.
-- Every date-difference metric in this view returns the RAW (possibly
-- negative) day count rather than clamping with GREATEST(x, 0) — the flags
-- are how consumers detect and filter bad data, not silent correction.

-- ─── 0. Validate the listing-platform assumption this view's column shape
--        depends on. Channel IDs are never hardcoded — only the channel
--        *name* is matched — but the view still hardcodes three platform
--        *columns* (marketplace/kijiji/reverb_listed_at), so if the
--        platform set has changed, this migration must be updated rather
--        than silently producing a stale view. Aborts the whole migration
--        (nothing below is applied) if the assumption doesn't hold.

DO $$
DECLARE
  v_marketplace_count integer;
  v_kijiji_count      integer;
  v_reverb_count      integer;
  v_total_platforms   integer;
BEGIN
  SELECT COUNT(*) INTO v_marketplace_count FROM public.deal_channels WHERE name = 'Marketplace' AND is_listing_platform = true;
  SELECT COUNT(*) INTO v_kijiji_count      FROM public.deal_channels WHERE name = 'Kijiji'      AND is_listing_platform = true;
  SELECT COUNT(*) INTO v_reverb_count      FROM public.deal_channels WHERE name = 'Reverb'      AND is_listing_platform = true;
  SELECT COUNT(*) INTO v_total_platforms   FROM public.deal_channels WHERE is_listing_platform = true;

  IF v_marketplace_count <> 1 THEN
    RAISE EXCEPTION 'analytics_item_lifecycle: expected exactly one listing-platform deal_channels row named ''Marketplace'', found %. Update this migration''s platform assumptions before proceeding.', v_marketplace_count;
  END IF;
  IF v_kijiji_count <> 1 THEN
    RAISE EXCEPTION 'analytics_item_lifecycle: expected exactly one listing-platform deal_channels row named ''Kijiji'', found %. Update this migration''s platform assumptions before proceeding.', v_kijiji_count;
  END IF;
  IF v_reverb_count <> 1 THEN
    RAISE EXCEPTION 'analytics_item_lifecycle: expected exactly one listing-platform deal_channels row named ''Reverb'', found %. Update this migration''s platform assumptions before proceeding.', v_reverb_count;
  END IF;
  IF v_total_platforms <> 3 THEN
    RAISE EXCEPTION 'analytics_item_lifecycle: expected exactly 3 listing-platform deal_channels rows (Marketplace, Kijiji, Reverb), found %. A platform may have been added/removed — update this migration to match before proceeding.', v_total_platforms;
  END IF;
END $$;

-- ─── 1. Supporting indexes ──────────────────────────────────────────────────
-- Only adding what's genuinely missing for this view's join patterns.
-- deal_items had no non-PK index at all; item_listings.deal_channel_id and
-- inventory_expenses.item_id likewise. inventory_item_tags already has a
-- UNIQUE(item_id, tag_id) index whose leading column serves item_id lookups,
-- so no further tag index is added (would be redundant).

CREATE INDEX IF NOT EXISTS idx_deal_items_item_id_direction
  ON public.deal_items (item_id, direction);

CREATE INDEX IF NOT EXISTS idx_item_listings_deal_channel_id
  ON public.item_listings (deal_channel_id);

CREATE INDEX IF NOT EXISTS idx_inventory_expenses_item_id
  ON public.inventory_expenses (item_id);

-- ─── 2. The view ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.analytics_item_lifecycle
WITH (security_invoker = true)
AS
WITH

-- One row per item that has ever been acquired (direction = 'in'). DISTINCT
-- ON is a defensive grain guard: today the app's RPCs only ever leave at
-- most one 'in' deal_items row live per item, but this makes that an
-- enforced property of the view rather than an unchecked assumption.
acquisition AS (
  SELECT DISTINCT ON (di.item_id)
    di.item_id,
    di.deal_id                                            AS acquisition_deal_id,
    d.deal_date                                            AS acquisition_date,
    d.deal_type                                            AS acquisition_deal_type,
    d.deal_channel_id                                       AS acquisition_channel_id,
    dc.name                                                 AS acquisition_channel_name,
    di.total_value                                          AS acquisition_value,
    (d.deal_type = 'Historical Import')                     AS is_historical_import,
    CASE
      WHEN d.deal_type = 'purchase'          THEN 'cash'
      WHEN d.deal_type = 'trade'              THEN 'trade'
      WHEN d.deal_type = 'Historical Import'  THEN 'unknown'
      ELSE 'unknown'
    END                                                      AS acquisition_method
  FROM public.deal_items di
  JOIN public.deals d          ON d.id = di.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE di.direction = 'in'
  ORDER BY di.item_id, d.deal_date DESC, di.id DESC
),

-- One row per item that has ever exited (direction = 'out'). Same defensive
-- DISTINCT ON grain guard as acquisition.
exit_deal AS (
  SELECT DISTINCT ON (do_.item_id)
    do_.item_id,
    do_.deal_id                                             AS exit_deal_id,
    d.deal_date                                             AS exit_date,
    d.deal_type                                             AS exit_type,
    d.deal_channel_id                                        AS exit_channel_id,
    dc.name                                                  AS exit_channel_name,
    do_.total_value                                          AS exit_value,
    (d.deal_type IN ('sale', 'trade'))                       AS is_realized
  FROM public.deal_items do_
  JOIN public.deals d          ON d.id = do_.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE do_.direction = 'out'
  ORDER BY do_.item_id, d.deal_date DESC, do_.id DESC
),

-- One row per item, unpivoting item_listings into the three current
-- platform columns. item_listings has UNIQUE(inventory_item_id,
-- deal_channel_id), so at most one row can match each CASE per item —
-- MAX() here is just "pick the one non-null value", not a real aggregate
-- choice among ties. Channels are matched by name, never by hardcoded id.
listings AS (
  SELECT
    il.inventory_item_id                                                    AS item_id,
    MAX(CASE WHEN dc.name = 'Marketplace' THEN il.listed_at END)            AS marketplace_listed_at,
    MAX(CASE WHEN dc.name = 'Kijiji'      THEN il.listed_at END)            AS kijiji_listed_at,
    MAX(CASE WHEN dc.name = 'Reverb'      THEN il.listed_at END)            AS reverb_listed_at
  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  WHERE dc.is_listing_platform = true
  GROUP BY il.inventory_item_id
),

-- One row per item with any directly-assigned expense. General expenses
-- (item_id IS NULL) are intentionally excluded, never auto-allocated.
expenses AS (
  SELECT
    item_id,
    COUNT(*)::integer AS item_expense_count,
    SUM(amount)        AS item_expenses_total
  FROM public.inventory_expenses
  WHERE item_id IS NOT NULL
  GROUP BY item_id
),

-- One row per item with any tags, arrays deduplicated (via the underlying
-- UNIQUE(item_id, tag_id) constraint) and sorted by tag name then id.
tags AS (
  SELECT
    iit.item_id,
    ARRAY_AGG(t.id   ORDER BY t.name, t.id) AS tag_ids,
    ARRAY_AGG(t.name ORDER BY t.name, t.id) AS tag_names,
    COUNT(*)::integer                        AS tag_count
  FROM public.inventory_item_tags iit
  JOIN public.inventory_tags t ON t.id = iit.tag_id
  GROUP BY iit.item_id
),

-- Item dimensions + raw acquisition/exit/listing/expense/tag fields. Every
-- join here is to a dimension table by primary key or to a CTE already
-- grouped down to <=1 row per item_id, so this preserves inventory_items'
-- exact row count and grain.
base AS (
  SELECT
    i.id                                                     AS item_id,
    i.user_id,
    CONCAT_WS(' ', i.year::text, br.name, i.model)            AS item_display_name,
    i.model,
    i.year,
    i.color,
    i.brand_id,
    br.name                                                   AS brand_name,
    cat.id                                                     AS category_id,
    cat.name                                                   AS category_name,
    i.item_subtype_id                                          AS type_id,
    st.name                                                     AS type_name,
    i.condition                                                  AS condition_name,
    i.purpose_id,
    pu.name                                                       AS purpose_name,
    i.status                                                       AS current_status,
    i.estimated_sold_value,

    COALESCE(tg.tag_ids,   ARRAY[]::bigint[]) AS tag_ids,
    COALESCE(tg.tag_names, ARRAY[]::text[])   AS tag_names,
    COALESCE(tg.tag_count, 0)                  AS tag_count,

    acq.acquisition_deal_id,
    acq.acquisition_date,
    acq.acquisition_deal_type,
    acq.acquisition_channel_id,
    acq.acquisition_channel_name,
    acq.acquisition_method,
    acq.acquisition_value,
    COALESCE(acq.is_historical_import, false) AS is_historical_import,
    -- No placeholder/sentinel acquisition-date convention exists in the app
    -- today (create_item_with_historical_import requires a real date) — see
    -- the migration-level comment above. Always false until such a
    -- convention exists.
    false                                       AS acquisition_date_is_placeholder,

    ex.exit_deal_id,
    ex.exit_date,
    ex.exit_type,
    ex.exit_channel_id,
    ex.exit_channel_name,
    ex.exit_value,
    COALESCE(ex.is_realized, false)             AS is_realized,

    lst.marketplace_listed_at,
    lst.kijiji_listed_at,
    lst.reverb_listed_at,

    COALESCE(exp.item_expense_count, 0)         AS item_expense_count,
    COALESCE(exp.item_expenses_total, 0)        AS item_expenses_total
  FROM public.inventory_items i
  LEFT JOIN public.brands         br  ON br.id  = i.brand_id
  LEFT JOIN public.item_subtypes  st  ON st.id  = i.item_subtype_id
  LEFT JOIN public.item_categories cat ON cat.id = st.category_id
  LEFT JOIN public.item_purposes  pu  ON pu.id  = i.purpose_id
  LEFT JOIN acquisition acq ON acq.item_id = i.id
  LEFT JOIN exit_deal   ex  ON ex.item_id  = i.id
  LEFT JOIN listings    lst ON lst.item_id = i.id
  LEFT JOIN expenses    exp ON exp.item_id = i.id
  LEFT JOIN tags        tg  ON tg.item_id  = i.id
),

-- Metrics that other final-layer metrics need to reference (Postgres can't
-- reference a sibling SELECT-list alias within the same SELECT), plus
-- realized-profit, which only ever depends on base columns.
lifecycle_dates AS (
  SELECT
    base.*,
    LEAST(marketplace_listed_at, kijiji_listed_at, reverb_listed_at)    AS first_listed_at,
    GREATEST(marketplace_listed_at, kijiji_listed_at, reverb_listed_at) AS last_listed_at,
    ( (CASE WHEN marketplace_listed_at IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN kijiji_listed_at      IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN reverb_listed_at      IS NOT NULL THEN 1 ELSE 0 END) ) AS listing_platform_count,
    CASE WHEN is_realized THEN (exit_value - acquisition_value)                          END AS gross_profit,
    CASE WHEN is_realized THEN (exit_value - acquisition_value - item_expenses_total)    END AS net_profit
  FROM base
)

SELECT
  lifecycle_dates.item_id,
  lifecycle_dates.user_id,

  lifecycle_dates.item_display_name,
  lifecycle_dates.model,
  lifecycle_dates.year,
  lifecycle_dates.color,

  lifecycle_dates.brand_id,
  lifecycle_dates.brand_name,

  lifecycle_dates.category_id,
  lifecycle_dates.category_name,

  lifecycle_dates.type_id,
  lifecycle_dates.type_name,

  -- No conditions lookup table exists in this schema — see migration
  -- header comment. condition_id is intentionally not included.
  lifecycle_dates.condition_name,

  lifecycle_dates.purpose_id,
  lifecycle_dates.purpose_name,

  lifecycle_dates.current_status,
  lifecycle_dates.estimated_sold_value,

  lifecycle_dates.tag_ids,
  lifecycle_dates.tag_names,
  lifecycle_dates.tag_count,

  lifecycle_dates.acquisition_deal_id,
  lifecycle_dates.acquisition_date,
  lifecycle_dates.acquisition_deal_type,
  lifecycle_dates.acquisition_channel_id,
  lifecycle_dates.acquisition_channel_name,
  lifecycle_dates.acquisition_method,
  lifecycle_dates.acquisition_value,
  lifecycle_dates.is_historical_import,
  lifecycle_dates.acquisition_date_is_placeholder,

  lifecycle_dates.marketplace_listed_at,
  lifecycle_dates.kijiji_listed_at,
  lifecycle_dates.reverb_listed_at,

  lifecycle_dates.first_listed_at,
  lifecycle_dates.last_listed_at,
  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL THEN NULL
    WHEN ( (CASE WHEN lifecycle_dates.marketplace_listed_at = lifecycle_dates.first_listed_at THEN 1 ELSE 0 END)
         + (CASE WHEN lifecycle_dates.kijiji_listed_at      = lifecycle_dates.first_listed_at THEN 1 ELSE 0 END)
         + (CASE WHEN lifecycle_dates.reverb_listed_at      = lifecycle_dates.first_listed_at THEN 1 ELSE 0 END) ) > 1
      THEN 'Multiple'
    WHEN lifecycle_dates.marketplace_listed_at = lifecycle_dates.first_listed_at THEN 'Marketplace'
    WHEN lifecycle_dates.kijiji_listed_at      = lifecycle_dates.first_listed_at THEN 'Kijiji'
    WHEN lifecycle_dates.reverb_listed_at      = lifecycle_dates.first_listed_at THEN 'Reverb'
  END                                                                          AS first_listing_platform,

  lifecycle_dates.listing_platform_count,
  (lifecycle_dates.listing_platform_count > 1)                                AS is_cross_listed,

  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL OR lifecycle_dates.acquisition_date IS NULL THEN NULL
    ELSE (lifecycle_dates.first_listed_at - lifecycle_dates.acquisition_date)
  END                                                                          AS days_acquisition_to_first_listing,

  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL THEN NULL
    ELSE (lifecycle_dates.last_listed_at - lifecycle_dates.first_listed_at)
  END                                                                          AS days_first_to_last_listing,

  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL THEN NULL
    WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.first_listed_at)
    ELSE (CURRENT_DATE - lifecycle_dates.first_listed_at)
  END                                                                          AS global_days_on_market,

  -- Marketplace
  CASE WHEN lifecycle_dates.marketplace_listed_at IS NULL THEN NULL
       ELSE (lifecycle_dates.marketplace_listed_at - lifecycle_dates.first_listed_at) END AS marketplace_listing_delay_days,
  CASE WHEN lifecycle_dates.marketplace_listed_at IS NULL THEN NULL
       WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.marketplace_listed_at)
       ELSE (CURRENT_DATE - lifecycle_dates.marketplace_listed_at) END                    AS marketplace_listing_age_days,
  CASE WHEN lifecycle_dates.marketplace_listed_at IS NULL OR lifecycle_dates.exit_date IS NULL THEN NULL
       ELSE (lifecycle_dates.exit_date - lifecycle_dates.marketplace_listed_at) END       AS marketplace_days_to_exit,

  -- Kijiji
  CASE WHEN lifecycle_dates.kijiji_listed_at IS NULL THEN NULL
       ELSE (lifecycle_dates.kijiji_listed_at - lifecycle_dates.first_listed_at) END      AS kijiji_listing_delay_days,
  CASE WHEN lifecycle_dates.kijiji_listed_at IS NULL THEN NULL
       WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.kijiji_listed_at)
       ELSE (CURRENT_DATE - lifecycle_dates.kijiji_listed_at) END                         AS kijiji_listing_age_days,
  CASE WHEN lifecycle_dates.kijiji_listed_at IS NULL OR lifecycle_dates.exit_date IS NULL THEN NULL
       ELSE (lifecycle_dates.exit_date - lifecycle_dates.kijiji_listed_at) END            AS kijiji_days_to_exit,

  -- Reverb
  CASE WHEN lifecycle_dates.reverb_listed_at IS NULL THEN NULL
       ELSE (lifecycle_dates.reverb_listed_at - lifecycle_dates.first_listed_at) END      AS reverb_listing_delay_days,
  CASE WHEN lifecycle_dates.reverb_listed_at IS NULL THEN NULL
       WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.reverb_listed_at)
       ELSE (CURRENT_DATE - lifecycle_dates.reverb_listed_at) END                         AS reverb_listing_age_days,
  CASE WHEN lifecycle_dates.reverb_listed_at IS NULL OR lifecycle_dates.exit_date IS NULL THEN NULL
       ELSE (lifecycle_dates.exit_date - lifecycle_dates.reverb_listed_at) END            AS reverb_days_to_exit,

  lifecycle_dates.exit_deal_id,
  lifecycle_dates.exit_date,
  lifecycle_dates.exit_type,
  lifecycle_dates.exit_channel_id,
  lifecycle_dates.exit_channel_name,
  lifecycle_dates.exit_value,
  lifecycle_dates.is_realized,

  lifecycle_dates.item_expense_count,
  lifecycle_dates.item_expenses_total,

  lifecycle_dates.gross_profit,
  lifecycle_dates.net_profit,
  CASE
    WHEN NOT lifecycle_dates.is_realized THEN NULL
    WHEN lifecycle_dates.acquisition_value IS NULL OR lifecycle_dates.acquisition_value <= 0 THEN NULL
    ELSE (lifecycle_dates.net_profit / lifecycle_dates.acquisition_value) * 100
  END                                                                          AS roi,

  CASE
    WHEN lifecycle_dates.acquisition_date IS NULL THEN NULL
    WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.acquisition_date)
    ELSE (CURRENT_DATE - lifecycle_dates.acquisition_date)
  END                                                                          AS holding_days,

  COALESCE(
    lifecycle_dates.acquisition_date IS NOT NULL
    AND lifecycle_dates.first_listed_at IS NOT NULL
    AND lifecycle_dates.first_listed_at < lifecycle_dates.acquisition_date,
    false
  )                                                                            AS has_listing_before_acquisition,

  COALESCE(
    lifecycle_dates.exit_date IS NOT NULL
    AND lifecycle_dates.last_listed_at IS NOT NULL
    AND lifecycle_dates.last_listed_at > lifecycle_dates.exit_date,
    false
  )                                                                            AS has_listing_after_exit,

  ( COALESCE(
      lifecycle_dates.acquisition_date IS NOT NULL
      AND lifecycle_dates.first_listed_at IS NOT NULL
      AND lifecycle_dates.first_listed_at < lifecycle_dates.acquisition_date,
      false
    )
    OR
    COALESCE(
      lifecycle_dates.exit_date IS NOT NULL
      AND lifecycle_dates.last_listed_at IS NOT NULL
      AND lifecycle_dates.last_listed_at > lifecycle_dates.exit_date,
      false
    )
  )                                                                            AS has_lifecycle_date_issue

FROM lifecycle_dates;

GRANT SELECT ON public.analytics_item_lifecycle TO authenticated;

COMMENT ON VIEW public.analytics_item_lifecycle IS
  'One row per inventory item: acquisition/exit/listing/expense/tag/profitability lifecycle data. '
  'security_invoker view — exposes exactly what the querying role can already read via base-table RLS; '
  'no additional user_id filter is applied here. user_id is inventory_items.user_id verbatim, kept '
  'stable for a future organization/workspace model. roi is a PERCENTAGE (matches src/app/page.tsx '
  'convention), NULL for open items. marketplace/kijiji/reverb_listed_at mirror item_listings.listed_at '
  'for the three current listing-platform deal_channels rows; see migration file header for full notes '
  'on listing-exposure limitations, Historical Import placeholder-date limitations, and the invalid-date '
  '(has_lifecycle_date_issue) policy.';
