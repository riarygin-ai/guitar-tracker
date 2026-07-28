-- analytics_item_lifecycle: add Deal In Channel columns
--
-- Channel Analytics, module 1 of N: Deal In Channel Performance (see
-- analytics/sql/04_deal_in_channel_performance.sql and
-- analytics/SEMANTIC_CONTRACT.md). This migration ONLY extends the view
-- with three new columns; it creates no new table, changes no existing
-- column, and does not touch RLS or any base table.
--
-- ── SEMANTIC DEFINITION ──────────────────────────────────────────────────
-- Deal In Channel is the channel where contact with the seller or trade
-- partner originated for the operation through which an item ENTERED
-- inventory (Marketplace / Kijiji / Reverb / Regular Buyer / Seller). It is
-- NOT a payment method, a shipping method, or "where the deal was
-- technically completed." For a purchase, this is the purchase deal's
-- deal_channel_id; for a trade acquisition, the trade deal's
-- deal_channel_id; for Historical Purchase/Historical Trade, the
-- historical deal's channel when one was recorded. Historical Import (and
-- any acquisition with no recorded channel) has deal_in_channel_id = NULL
-- — this is a real, visible "missing channel" state, never hidden or
-- defaulted to a fake value.
--
-- ── WHY NEW COLUMNS INSTEAD OF REUSING acquisition_channel_id/_name ─────
-- The view already exposes acquisition_channel_id/acquisition_channel_name
-- (added in 20260724000000_historical_deal_type_labels.sql), sourced from
-- exactly the same acquisition-deal join this migration reads from. Those
-- names predate this project's "no ambiguous analytics names" naming rule
-- (analytics/SEMANTIC_CONTRACT.md) and are NOT renamed or removed here —
-- doing so would break every existing reader of this view. The three new
-- columns below are the explicit, Channel-Analytics-facing names going
-- forward; acquisition_channel_id/_name remain as they were, unchanged.
--
-- ── COLUMNS ADDED (appended at the end of the SELECT list, so
-- CREATE OR REPLACE VIEW succeeds without dropping/recreating the view —
-- existing column positions for every prior column are preserved) ───────
--   deal_in_channel_id               bigint  — same value as
--     acquisition_channel_id (dc.id from the acquisition deal's channel).
--   deal_in_channel_name             text    — same value as
--     acquisition_channel_name (dc.name).
--   deal_in_channel_requires_listing boolean — dc.is_listing_platform for
--     that channel; NULL when deal_in_channel_id is NULL (channel unknown,
--     not "does not require listing").
--
-- Everything else — SECURITY INVOKER behavior, user_id, every existing
-- column, every existing calculation — is UNCHANGED. This migration is a
-- pure additive column extension.
-- ============================================================================

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
    -- Deal In Channel (new) — same join, explicit Channel-Analytics naming.
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
    (d.deal_type IN ('sale', 'trade'))                       AS is_realized
  FROM public.deal_items do_
  JOIN public.deals d          ON d.id = do_.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE do_.direction = 'out'
  ORDER BY do_.item_id, d.deal_date DESC, do_.id DESC
),

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
    COALESCE(exp.item_expenses_total, 0)        AS item_expenses_total,

    -- Deal In Channel (new)
    acq.deal_in_channel_id,
    acq.deal_in_channel_name,
    acq.deal_in_channel_requires_listing
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
  )                                                                            AS has_lifecycle_date_issue,

  -- ── Deal In Channel (new) — appended at the end so every prior column's
  -- position is preserved for CREATE OR REPLACE VIEW. ────────────────────
  lifecycle_dates.deal_in_channel_id,
  lifecycle_dates.deal_in_channel_name,
  lifecycle_dates.deal_in_channel_requires_listing

FROM lifecycle_dates;

COMMENT ON VIEW public.analytics_item_lifecycle IS
  'One row per inventory item: acquisition/exit/listing/expense/tag/profitability lifecycle data. '
  'security_invoker view — exposes exactly what the querying role can already read via base-table RLS; '
  'no additional user_id filter is applied here. user_id is inventory_items.user_id verbatim, kept '
  'stable for a future organization/workspace model. roi is a PERCENTAGE (matches src/app/page.tsx '
  'convention), NULL for open items. marketplace/kijiji/reverb_listed_at mirror item_listings.listed_at '
  'for the three current listing-platform deal_channels rows. is_historical_import and acquisition_method '
  'are derived from deal_type, which recognizes ''Historical Purchase''/''Historical Trade'' (known real '
  'method, corrected from a generic ''Historical Import'') alongside plain ''Historical Import'' (method '
  'still unknown) — see 20260724000000_historical_deal_type_labels.sql. deal_in_channel_id/_name/'
  '_requires_listing (added 20260731000000) are the Channel-Analytics-facing names for the SAME '
  'acquisition-deal channel already exposed as acquisition_channel_id/_name — NULL when no channel was '
  'recorded for the acquisition (e.g. Historical Import), never defaulted to a fake value. See '
  'analytics/sql/04_deal_in_channel_performance.sql and analytics/SEMANTIC_CONTRACT.md for the full '
  'Deal In Channel definition. See migration file header for full notes on listing-exposure limitations, '
  'Historical Import placeholder-date limitations, and the invalid-date (has_lifecycle_date_issue) policy.';
