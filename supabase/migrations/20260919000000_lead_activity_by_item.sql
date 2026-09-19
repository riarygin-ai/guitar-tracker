-- Lead Activity by Item: exact item-attributed cohort + compact item activity
--
-- Two additive, read-only, service_role-only helpers for the /listings
-- "Lead Activity by Item" section and its /leads drill-down. Nothing
-- existing is modified or replaced.
--
-- ── ITEM attribution (same rule as Listing Demand Evidence's
--    item_attributed_leads / item_attributed_leads_in_period) ──────────
-- A lead is ITEM-attributed only when ALL hold:
--   1. same user (item_leads.user_id = target user)
--   2. first_contact_at falls inside [period_start, period_end]
--   3. listing exposure exists for that inventory item, on ANY channel,
--      ON first_contact_at (listing_exposure_days_v1_0 — which already
--      handles cancelled/draft cycles, the stale-active clip for realized
--      items, and is_listing_platform)
-- No normalized channel is required: a lead with deal_channel_id NULL (or
-- tagged with a channel the item was not listed on that day) can be
-- item-attributed even though it can never be channel-attributed. That
-- distinction is intentional and preserved.
--
-- ── 1. _lead_item_attributed_v1_0(user, start, end) ───────────────────
-- (lead_row_id, inventory_item_id) for every item-attributed lead in the
-- period — the single definition both helpers below build on.
--
-- ── 2. lead_drilldown_item_attributed_ids_v1_0(user, item, start, end) ─
-- item_leads.id set for ONE item: exactly the cohort behind the counts on
-- /listings, so the /leads drill-down reconciles by construction.
--
-- ── 3. listing_demand_item_activity_v1_0(user, start, end) ────────────
-- Compact per-item activity for CURRENTLY LISTED items (the exact same
-- set, current_active_channels, item_listing_days and channel_listing_days
-- that _listing_demand_item_evidence_v1_0 reports for the same period —
-- read from it directly rather than re-derived), plus the aggregates that
-- evidence does not provide on an attributed basis:
--   item_attributed_leads           == evidence item_attributed_leads_in_period
--   serious_plus_attributed_leads   attributed leads with SERIOUS/HIGH_INTENT
--   offer_attributed_leads          attributed leads with offer_type <> 'NONE'
--                                   (a lead contributes at most 1)
--   last_attributed_lead_date       latest first_contact_at among the
--                                   ATTRIBUTED leads of THIS period; NULL
--                                   when none (never a lifetime value)
--
-- Access: SECURITY INVOKER, service_role EXECUTE only, like every other
-- listing-demand helper. The only callers (GET /api/leads and
-- GET /api/listing-item-activity) always pass the authenticated caller's
-- OWN app_users.id.

CREATE OR REPLACE FUNCTION public._lead_item_attributed_v1_0(
  p_target_user_id int,
  p_period_start   date,
  p_period_end     date
)
RETURNS TABLE (lead_row_id bigint, inventory_item_id bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH exposure AS (
    SELECT * FROM public.listing_exposure_days_v1_0(p_target_user_id, p_period_start, p_period_end)
  )
  SELECT l.id, l.inventory_item_id
  FROM public.item_leads l
  WHERE l.user_id = p_target_user_id
    AND l.first_contact_at BETWEEN p_period_start AND p_period_end
    AND EXISTS (
      SELECT 1 FROM exposure e
      WHERE e.inventory_item_id = l.inventory_item_id
        AND e.activity_date     = l.first_contact_at
    );
$$;

REVOKE ALL ON FUNCTION public._lead_item_attributed_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._lead_item_attributed_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public._lead_item_attributed_v1_0(int, date, date) IS
  'Internal. (lead_row_id, inventory_item_id) for every ITEM-attributed lead '
  'of the user in the period: first_contact_at in the period AND listing '
  'exposure for that item on ANY channel on first_contact_at '
  '(listing_exposure_days_v1_0). Same rule as Listing Demand Evidence '
  'item_attributed_leads. No normalized channel required. service_role only.';

CREATE OR REPLACE FUNCTION public.lead_drilldown_item_attributed_ids_v1_0(
  p_target_user_id int,
  p_item_id        bigint,
  p_period_start   date,
  p_period_end     date
)
RETURNS TABLE (lead_row_id bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT a.lead_row_id
  FROM public._lead_item_attributed_v1_0(p_target_user_id, p_period_start, p_period_end) a
  WHERE a.inventory_item_id = p_item_id
  ORDER BY a.lead_row_id;
$$;

REVOKE ALL ON FUNCTION public.lead_drilldown_item_attributed_ids_v1_0(int, bigint, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_drilldown_item_attributed_ids_v1_0(int, bigint, date, date) TO service_role;

COMMENT ON FUNCTION public.lead_drilldown_item_attributed_ids_v1_0(int, bigint, date, date) IS
  'Read-only Leads drill-down helper. item_leads.id for exactly the ITEM-'
  'attributed cohort of one item in the period (see _lead_item_attributed_'
  'v1_0). count(*) equals item_attributed_leads for the same user/item/'
  'period. service_role only.';

CREATE OR REPLACE FUNCTION public.listing_demand_item_activity_v1_0(
  p_target_user_id int,
  p_period_start   date,
  p_period_end     date
)
RETURNS TABLE (
  item_id                        bigint,
  item_display_name              text,
  active_channels                jsonb,
  item_attributed_leads          bigint,
  serious_plus_attributed_leads  bigint,
  offer_attributed_leads         bigint,
  item_listing_days              bigint,
  channel_listing_days           bigint,
  last_attributed_lead_date      date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH items AS (
    SELECT t.e
    FROM jsonb_array_elements(
      public._listing_demand_item_evidence_v1_0(p_target_user_id, p_period_start, p_period_end)
    ) AS t(e)
  ),
  attributed AS (
    SELECT l.inventory_item_id AS attributed_item_id, l.lead_quality, l.offer_type, l.first_contact_at
    FROM public._lead_item_attributed_v1_0(p_target_user_id, p_period_start, p_period_end) a
    JOIN public.item_leads l ON l.id = a.lead_row_id
  ),
  agg AS (
    SELECT
      attributed_item_id,
      COUNT(*) AS leads,
      COUNT(*) FILTER (WHERE lead_quality IN ('SERIOUS', 'HIGH_INTENT')) AS serious_plus,
      COUNT(*) FILTER (WHERE offer_type <> 'NONE') AS offers,
      MAX(first_contact_at) AS last_date
    FROM attributed
    GROUP BY attributed_item_id
  )
  SELECT
    (i.e->>'item_id')::bigint,
    i.e->>'item_display_name',
    COALESCE(i.e->'current_active_channels', '[]'::jsonb),
    COALESCE(agg.leads, 0),
    COALESCE(agg.serious_plus, 0),
    COALESCE(agg.offers, 0),
    (i.e->>'item_listing_days_in_period')::bigint,
    (i.e->>'channel_listing_days_in_period')::bigint,
    agg.last_date
  FROM items i
  LEFT JOIN agg ON agg.attributed_item_id = (i.e->>'item_id')::bigint
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.listing_demand_item_activity_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_demand_item_activity_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public.listing_demand_item_activity_v1_0(int, date, date) IS
  'Compact per-item buyer activity for CURRENTLY LISTED items over an '
  'arbitrary period (the /listings Trend Window). Item set, active '
  'channels and exposure days come from _listing_demand_item_evidence_v1_0; '
  'lead counts are ITEM-attributed (no channel required). Offers = '
  'attributed leads with offer_type <> NONE (max 1 per lead). '
  'last_attributed_lead_date is period-scoped and NULL when no attributed '
  'lead exists in the period. service_role only.';
