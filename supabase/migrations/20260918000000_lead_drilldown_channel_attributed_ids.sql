-- Leads drill-down: exact channel-attributed lead cohort (read-only helper)
--
-- Purpose: the /leads screen is reached from /listings by clicking a
-- channel's "Attributed Leads" / "Serious+" value. Those numbers come from
-- Listing Demand Evidence (_listing_demand_channel_metrics_v1_0, latest
-- definition in 20260915000000), where a lead is CHANNEL-ATTRIBUTED only
-- when ALL of the following hold:
--   1. same user (item_leads.user_id = target user)
--   2. item_leads.deal_channel_id is the channel in question (non-NULL)
--   3. first_contact_at falls inside [period_start, period_end]
--   4. an (item, channel, day) listing-exposure row exists for the lead's
--      inventory_item_id + deal_channel_id ON first_contact_at
--      (listing_exposure_days_v1_0 — which already handles cancelled/draft
--      cycles, the stale-active clip for realized items, and
--      is_listing_platform)
-- Re-deriving (4) in application code would silently drift from the
-- evidence, so this function returns the SAME cohort by calling the SAME
-- exposure foundation with the SAME predicate. It returns only lead row
-- ids (item_leads.id); the application then loads those rows under the
-- caller's own RLS.
--
-- Purely additive and read-only: nothing existing is modified or replaced,
-- no table/column is created, and no evidence semantics change.
--
-- Access: SECURITY INVOKER, service_role EXECUTE only — identical to every
-- other listing-demand helper (the exposure foundation it calls is itself
-- service_role only). It takes the target user id explicitly; the only
-- caller (GET /api/leads) always passes the authenticated caller's OWN
-- app_users.id, never a client-supplied value. A user id that owns no
-- leads simply yields no rows, and rows of any other user are never
-- returned because of the user_id predicate below.

CREATE OR REPLACE FUNCTION public.lead_drilldown_channel_attributed_ids_v1_0(
  p_target_user_id  int,
  p_deal_channel_id bigint,
  p_period_start    date,
  p_period_end      date
)
RETURNS TABLE (lead_row_id bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH exposure AS (
    SELECT * FROM public.listing_exposure_days_v1_0(p_target_user_id, p_period_start, p_period_end)
  )
  SELECT l.id
  FROM public.item_leads l
  WHERE l.user_id = p_target_user_id
    AND l.deal_channel_id = p_deal_channel_id
    AND l.first_contact_at BETWEEN p_period_start AND p_period_end
    AND EXISTS (
      SELECT 1 FROM exposure e
      WHERE e.inventory_item_id = l.inventory_item_id
        AND e.deal_channel_id   = l.deal_channel_id
        AND e.activity_date     = l.first_contact_at
    )
  ORDER BY l.id;
$$;

REVOKE ALL ON FUNCTION public.lead_drilldown_channel_attributed_ids_v1_0(int, bigint, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_drilldown_channel_attributed_ids_v1_0(int, bigint, date, date) TO service_role;

COMMENT ON FUNCTION public.lead_drilldown_channel_attributed_ids_v1_0(int, bigint, date, date) IS
  'Read-only Leads drill-down helper. Returns item_leads.id for exactly the '
  'CHANNEL-ATTRIBUTED cohort used by Listing Demand Evidence '
  '(_listing_demand_channel_metrics_v1_0): same user, same normalized '
  'channel, first_contact_at within the period, AND listing exposure for '
  'that item+channel on first_contact_at (listing_exposure_days_v1_0). '
  'count(*) therefore equals channel_attributed_leads for the same '
  'user/channel/period. STABLE, SECURITY INVOKER, service_role EXECUTE only.';
