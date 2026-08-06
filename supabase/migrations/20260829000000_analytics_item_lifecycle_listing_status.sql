-- analytics_item_lifecycle: status-aware listing metrics (multi-cycle
-- item_listings support).
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────
-- 20260828000000_item_listings_lifecycle.sql added status ('draft'/
-- 'active'/'ended'/'cancelled') to item_listings so the same item+platform
-- can be listed, ended, and relisted any number of times. This view's own
-- `listings` CTE (unchanged since 20260720000000, before status existed)
-- still computes marketplace_listed_at/kijiji_listed_at/reverb_listed_at
-- as a bare MAX(listed_at) with no status filter at all — it does not
-- double-count now that multiple rows can exist per item+platform (MAX
-- collapses them), but it DOES currently include cancelled rows' dates,
-- which must never count as real listing evidence.
--
-- ── FIX (Rules 1, 2, 5, 6) ────────────────────────────────────────────────
-- marketplace_listed_at/kijiji_listed_at/reverb_listed_at — existing
-- columns, NEVER renamed (this view's own established policy — see
-- 20260802000000's header) — now filter to status IN ('active', 'ended')
-- only. Cancelled rows are excluded outright (Rule 1). Draft rows are
-- unaffected either way (Rule 2) — item_listings_status_fields_check
-- guarantees a 'draft' row always has listed_at IS NULL, so they were
-- already inert here, but the explicit status filter makes that
-- structural rather than incidental. last_listed_at (below) is
-- GREATEST() of these same three columns, so fixing the source columns
-- fixes it for free — max-of-per-platform-maxes is a valid true global
-- max. first_listed_at is NOT similarly free: LEAST() of three
-- per-platform MAX(listed_at) values is NOT the true global MIN once a
-- single platform can have multiple cycles (an earlier cycle on a
-- platform that also has a later one gets silently dropped) — it needs
-- its own MIN(listed_at) computed directly across every eligible row,
-- added below as earliest_listed_at.
--
-- ── NEW COLUMNS (Rules 3, 4, 5, 6 + this task's requested metrics) ───────
-- Appended at the very end of the SELECT list, exactly like every prior
-- extension to this view (Deal In/Out Channel) — existing column
-- positions are fully preserved, so CREATE OR REPLACE VIEW succeeds
-- without dropping/recreating it:
--   {platform}_active_listed_at       — that platform's listed_at ONLY
--     when a cycle is active on it RIGHT NOW (Rule 3/5); NULL otherwise.
--     At most one such row can ever exist per item+platform — enforced by
--     item_listings_unique_open_per_item_channel.
--   {platform}_listing_cycle_count / listing_cycle_count (global) — COUNT
--     of status IN ('active','ended') rows (Rule 6) — real listing
--     attempts, cancelled/draft excluded.
--   {platform}_total_listed_days / total_listed_days (global) — SUM of
--     (ended_at - listed_at) for ended cycles + (today - listed_at) for
--     the current active cycle, if any — total real days listed across
--     every cycle, cancelled/draft excluded.
--   {platform}_current_listing_age_days — CURRENT_DATE -
--     {platform}_active_listed_at, NULL unless that platform is currently
--     active. Deliberately DISTINCT from the pre-existing
--     {platform}_listing_age_days (unchanged, still historical — counts
--     age through an ENDED cycle too via exit_date/CURRENT_DATE, not
--     "is it still listed right now").
-- No single global current_active_listed_at/current_listing_age_days is
-- added: an item can legitimately be active on more than one platform at
-- once (is_cross_listed), so "the" current active date/age is only ever
-- well-defined per platform — see this session's report for the same
-- reasoning applied to the two per-platform pairs above.
--
-- ── WHAT IS UNCHANGED ─────────────────────────────────────────────────────
-- Every other column, every other CTE (acquisition, exit_deal, expenses,
-- tags), SECURITY INVOKER behavior, and every pre-existing listing column
-- (marketplace_listing_delay_days/_age_days/_days_to_exit and its Kijiji/
-- Reverb equivalents, first_listing_platform, is_cross_listed, the two
-- has_listing_.../has_lifecycle_date_issue flags) computes exactly as
-- before, off the same (now correctly filtered) source dates. No version
-- bump: this view is a shared, already-repeatedly-extended foundation
-- (four prior CREATE OR REPLACE VIEW migrations), not a frozen
-- build_analytics_snapshot_vX output contract — build_analytics_snapshot_
-- v2_13 and every version before it remain independently callable,
-- unaffected in shape; only the underlying VALUES for the three renamed-
-- in-nothing, fixed-in-place *_listed_at columns become correct (cancelled
-- listings never counted before is what changes — a real bug fix, not a
-- new output shape).

CREATE OR REPLACE VIEW public.analytics_item_lifecycle
WITH (security_invoker = true)
AS
WITH

acquisition AS (
  SELECT DISTINCT ON (di.item_id)
    di.item_id,
    di.deal_id                                            AS acquisition_deal_id,
    d.deal_date                                            AS acquisition_date,
    d.deal_type                                            AS acquisition_deal_type,
    d.deal_channel_id                                       AS acquisition_channel_id,
    dc.name                                                 AS acquisition_channel_name,
    di.total_value                                          AS acquisition_value,
    (d.deal_type IN ('Historical Import', 'Historical Purchase', 'Historical Trade')) AS is_historical_import,
    CASE
      WHEN d.deal_type IN ('purchase', 'Historical Purchase') THEN 'purchase'
      WHEN d.deal_type IN ('trade', 'Historical Trade')       THEN 'trade'
      WHEN d.deal_type = 'Historical Import'                  THEN 'unknown'
      ELSE 'unknown'
    END                                                      AS acquisition_method,
    -- Deal In Channel (added 20260731000000)
    dc.id                                                    AS deal_in_channel_id,
    dc.name                                                  AS deal_in_channel_name,
    dc.is_listing_platform                                   AS deal_in_channel_requires_listing
  FROM public.deal_items di
  JOIN public.deals d          ON d.id = di.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE di.direction = 'in'
  ORDER BY di.item_id, d.deal_date DESC, di.id DESC
),

exit_deal AS (
  SELECT DISTINCT ON (do_.item_id)
    do_.item_id,
    do_.deal_id                                             AS exit_deal_id,
    d.deal_date                                             AS exit_date,
    d.deal_type                                             AS exit_type,
    d.deal_channel_id                                        AS exit_channel_id,
    dc.name                                                  AS exit_channel_name,
    do_.total_value                                          AS exit_value,
    (d.deal_type IN ('sale', 'trade'))                       AS is_realized,
    -- Deal Out Channel (added 20260802000000)
    dc.id                                                     AS deal_out_channel_id,
    dc.name                                                   AS deal_out_channel_name,
    dc.is_listing_platform                                    AS deal_out_channel_requires_listing
  FROM public.deal_items do_
  JOIN public.deals d          ON d.id = do_.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE do_.direction = 'out'
  ORDER BY do_.item_id, d.deal_date DESC, do_.id DESC
),

-- ── listings: status-aware (new) ─────────────────────────────────────────
-- Cancelled rows are excluded from every aggregate below (Rule 1). Draft
-- rows never carry a listed_at (item_listings_status_fields_check), so
-- they contribute nothing to any of these either way (Rule 2) — the
-- explicit status IN ('active','ended')/= 'active' filters make that
-- guarantee structural here rather than incidental.
listings AS (
  SELECT
    il.inventory_item_id                                                                                    AS item_id,

    -- Historical (Rule 4/6) — latest real listed_at per platform. Existing
    -- column names, never renamed; semantics corrected to exclude
    -- cancelled.
    MAX(CASE WHEN dc.name = 'Marketplace' AND il.status IN ('active', 'ended') THEN il.listed_at END)        AS marketplace_listed_at,
    MAX(CASE WHEN dc.name = 'Kijiji'      AND il.status IN ('active', 'ended') THEN il.listed_at END)        AS kijiji_listed_at,
    MAX(CASE WHEN dc.name = 'Reverb'      AND il.status IN ('active', 'ended') THEN il.listed_at END)        AS reverb_listed_at,

    -- Current (Rule 3/5, new) — this platform's listed_at ONLY if a cycle
    -- is active on it right now. At most one such row can ever exist per
    -- item+platform (item_listings_unique_open_per_item_channel).
    MAX(CASE WHEN dc.name = 'Marketplace' AND il.status = 'active' THEN il.listed_at END)                    AS marketplace_active_listed_at,
    MAX(CASE WHEN dc.name = 'Kijiji'      AND il.status = 'active' THEN il.listed_at END)                    AS kijiji_active_listed_at,
    MAX(CASE WHEN dc.name = 'Reverb'      AND il.status = 'active' THEN il.listed_at END)                    AS reverb_active_listed_at,

    -- Historical cycle counts (Rule 6, new) — real cycles only.
    COUNT(*) FILTER (WHERE dc.name = 'Marketplace' AND il.status IN ('active', 'ended'))                     AS marketplace_listing_cycle_count,
    COUNT(*) FILTER (WHERE dc.name = 'Kijiji'      AND il.status IN ('active', 'ended'))                     AS kijiji_listing_cycle_count,
    COUNT(*) FILTER (WHERE dc.name = 'Reverb'      AND il.status IN ('active', 'ended'))                     AS reverb_listing_cycle_count,
    COUNT(*) FILTER (WHERE il.status IN ('active', 'ended'))                                                 AS listing_cycle_count,

    -- Total real listed days across every cycle (new): ended cycles
    -- contribute ended_at - listed_at; the current active cycle, if any,
    -- contributes today - listed_at. Cancelled/draft contribute nothing.
    SUM(CASE
          WHEN dc.name = 'Marketplace' AND il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN dc.name = 'Marketplace' AND il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS marketplace_total_listed_days,
    SUM(CASE
          WHEN dc.name = 'Kijiji' AND il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN dc.name = 'Kijiji' AND il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS kijiji_total_listed_days,
    SUM(CASE
          WHEN dc.name = 'Reverb' AND il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN dc.name = 'Reverb' AND il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS reverb_total_listed_days,
    SUM(CASE
          WHEN il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS total_listed_days,

    -- True earliest real listed_at across EVERY cycle on EVERY platform
    -- (not derived from the three MAX(...) columns above, which each
    -- collapse to that platform's LATEST cycle — LEAST() of three maxes
    -- is not the same as MIN() over the whole set once a platform can
    -- have more than one cycle). GREATEST() of the three per-platform
    -- MAX columns IS still a valid global latest (max-of-maxes == max of
    -- the union), so last_listed_at needs no equivalent fix.
    MIN(CASE WHEN il.status IN ('active', 'ended') THEN il.listed_at END)                                    AS earliest_listed_at

  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  WHERE dc.is_listing_platform = true
  GROUP BY il.inventory_item_id
),

expenses AS (
  SELECT
    item_id,
    COUNT(*)::integer AS item_expense_count,
    SUM(amount)        AS item_expenses_total
  FROM public.inventory_expenses
  WHERE item_id IS NOT NULL
  GROUP BY item_id
),

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

    lst.marketplace_active_listed_at,
    lst.kijiji_active_listed_at,
    lst.reverb_active_listed_at,
    lst.marketplace_listing_cycle_count,
    lst.kijiji_listing_cycle_count,
    lst.reverb_listing_cycle_count,
    lst.listing_cycle_count,
    lst.marketplace_total_listed_days,
    lst.kijiji_total_listed_days,
    lst.reverb_total_listed_days,
    lst.total_listed_days,
    lst.earliest_listed_at,

    COALESCE(exp.item_expense_count, 0)         AS item_expense_count,
    COALESCE(exp.item_expenses_total, 0)        AS item_expenses_total,

    -- Deal In Channel (added 20260731000000)
    acq.deal_in_channel_id,
    acq.deal_in_channel_name,
    acq.deal_in_channel_requires_listing,

    -- Deal Out Channel (added 20260802000000)
    ex.deal_out_channel_id,
    ex.deal_out_channel_name,
    ex.deal_out_channel_requires_listing
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

lifecycle_dates AS (
  SELECT
    base.*,
    -- first_listed_at: true MIN(listed_at) across every cycle on every
    -- platform (earliest_listed_at, computed directly in the listings
    -- CTE) — NOT LEAST() of the three per-platform MAX columns, which
    -- would silently drop an earlier cycle on a platform that also has a
    -- later one.
    earliest_listed_at                                                  AS first_listed_at,
    -- last_listed_at: GREATEST() of the three per-platform MAX columns
    -- IS still a valid true global MAX (max-of-maxes == max of the
    -- union), so this needs no equivalent fix.
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
  )                                                                            AS has_lifecycle_date_issue,

  -- Deal In Channel (added 20260731000000)
  lifecycle_dates.deal_in_channel_id,
  lifecycle_dates.deal_in_channel_name,
  lifecycle_dates.deal_in_channel_requires_listing,

  -- Deal Out Channel (added 20260802000000)
  lifecycle_dates.deal_out_channel_id,
  lifecycle_dates.deal_out_channel_name,
  lifecycle_dates.deal_out_channel_requires_listing,

  -- ── Status-aware listing metrics (new, this migration) — appended at
  -- the very end so every prior column's position is preserved for
  -- CREATE OR REPLACE VIEW. ────────────────────────────────────────────
  lifecycle_dates.marketplace_active_listed_at,
  lifecycle_dates.kijiji_active_listed_at,
  lifecycle_dates.reverb_active_listed_at,

  CASE WHEN lifecycle_dates.marketplace_active_listed_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - lifecycle_dates.marketplace_active_listed_at) END AS marketplace_current_listing_age_days,
  CASE WHEN lifecycle_dates.kijiji_active_listed_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - lifecycle_dates.kijiji_active_listed_at) END      AS kijiji_current_listing_age_days,
  CASE WHEN lifecycle_dates.reverb_active_listed_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - lifecycle_dates.reverb_active_listed_at) END      AS reverb_current_listing_age_days,

  lifecycle_dates.marketplace_listing_cycle_count,
  lifecycle_dates.kijiji_listing_cycle_count,
  lifecycle_dates.reverb_listing_cycle_count,
  lifecycle_dates.listing_cycle_count,

  lifecycle_dates.marketplace_total_listed_days,
  lifecycle_dates.kijiji_total_listed_days,
  lifecycle_dates.reverb_total_listed_days,
  lifecycle_dates.total_listed_days

FROM lifecycle_dates;

COMMENT ON VIEW public.analytics_item_lifecycle IS
  'One row per inventory item: acquisition/exit/listing/expense/tag/profitability lifecycle data. '
  'security_invoker view — exposes exactly what the querying role can already read via base-table RLS; '
  'no additional user_id filter is applied here. user_id is inventory_items.user_id verbatim, kept '
  'stable for a future organization/workspace model. roi is a PERCENTAGE (matches src/app/page.tsx '
  'convention), NULL for open items. marketplace/kijiji/reverb_listed_at mirror the LATEST real '
  '(status IN (''active'',''ended'')) item_listings.listed_at per platform, across however many listing '
  'cycles that item+platform has had — cancelled and draft rows never contribute (20260829000000). '
  'is_historical_import and acquisition_method are derived from deal_type, which recognizes ''Historical '
  'Purchase''/''Historical Trade'' (known real method, corrected from a generic ''Historical Import'') '
  'alongside plain ''Historical Import'' (method still unknown) — see '
  '20260724000000_historical_deal_type_labels.sql. deal_in_channel_id/_name/_requires_listing (added '
  '20260731000000) are the Channel-Analytics-facing names for the SAME acquisition-deal channel already '
  'exposed as acquisition_channel_id/_name. deal_out_channel_id/_name/_requires_listing (added '
  '20260802000000) are the Channel-Analytics-facing names for the SAME exit-deal channel already exposed '
  'as exit_channel_id/_name — NULL for open items (no exit deal yet) and for a realized trade whose '
  'channel was left unset, never defaulted to a fake value. {platform}_active_listed_at / '
  '{platform}_current_listing_age_days (added 20260829000000) reflect ONLY a listing that is active RIGHT '
  'NOW on that platform (NULL otherwise) — distinct from the historical {platform}_listing_age_days above, '
  'which includes ended cycles via exit_date/CURRENT_DATE. {platform}_listing_cycle_count / '
  'listing_cycle_count and {platform}_total_listed_days / total_listed_days (added 20260829000000) count/'
  'sum real (active+ended) cycles only. See analytics/sql/04_deal_in_channel_performance.sql, '
  'analytics/sql/05_deal_out_channel_performance.sql, and analytics/SEMANTIC_CONTRACT.md for the full Deal '
  'In/Out Channel definitions. See migration file headers for full notes on listing-exposure limitations, '
  'Historical Import placeholder-date limitations, the invalid-date (has_lifecycle_date_issue) policy, and '
  'the multi-cycle item_listings model (20260828000000/20260829000000).';
