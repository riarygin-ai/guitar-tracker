-- Fix: Listing Demand Evidence v1.0 — channel last_lead_date was a
-- lifetime value inside a period-scoped object.
--
-- 20260914000000_build_listing_demand_evidence_v1_0.sql (already applied
-- to production) is NOT edited here — this is a new, additive migration
-- that replaces only the one affected function via CREATE OR REPLACE
-- (its RETURNS TABLE columns are unchanged, so no DROP is required).
--
-- ── ROOT CAUSE ────────────────────────────────────────────────────────────
-- _listing_demand_channel_metrics_v1_0's `channel_last_lead_global` CTE
-- computed MAX(first_contact_at) across EVERY lead ever recorded for that
-- channel — user-scoped, but completely unbounded by p_period_start/
-- p_period_end. build_listing_demand_evidence_v1_0 calls this function
-- TWICE (once for the current period, once for the previous period), so
-- both calls independently computed and returned the exact same
-- lifetime-lifetime value — which is why production evidence showed the
-- identical 2026-08-14 date sitting inside BOTH channels[].current AND
-- channels[].previous, even though the current period was
-- 2026-08-16..2026-09-14 (a date entirely outside it) and
-- channel_attributed_leads was 0 for that period.
--
-- ── FIX ───────────────────────────────────────────────────────────────────
-- last_lead_date is now computed as MAX(first_contact_at) over the SAME
-- channel_attributed cohort that already backs channel_attributed_leads /
-- serious_plus_attributed_leads_from_cohort / high_intent_attributed_
-- leads_from_cohort / completed_leads_from_cohort / buyer_messages_from_
-- attributed_lead_cohort / our_messages_from_attributed_lead_cohort — the
-- channel_last_lead_global CTE and its LEFT JOIN are removed entirely, and
-- the field is added straight into the existing channel_lead_agg
-- aggregation. Because channel_lead_agg only ever contains a row for a
-- channel with at least one attributed lead in [p_period_start,
-- p_period_end], a channel with zero attributed leads in that period
-- naturally gets last_lead_date = NULL via the existing LEFT JOIN (never
-- COALESCEd to a fake value — NULL is the correct "no qualifying lead"
-- answer, matching every other nullable field in this schema).
--
-- Field is NOT renamed (requirement 4) — "last_lead_date" already reads
-- unambiguously once it is correctly scoped inside a period-labeled
-- current/previous object; every other field/semantic in Listing Demand
-- Evidence v1.0 is untouched.

CREATE OR REPLACE FUNCTION public._listing_demand_channel_metrics_v1_0(
  p_target_user_id int,
  p_period_start   date,
  p_period_end     date
)
RETURNS TABLE (
  deal_channel_id                             bigint,
  channel_name                                text,
  sort_order                                  int,
  channel_listing_days                        bigint,
  distinct_listed_items                       bigint,
  channel_attributed_leads                    bigint,
  serious_plus_attributed_leads_from_cohort   bigint,
  high_intent_attributed_leads_from_cohort    bigint,
  completed_leads_from_cohort                 bigint,
  buyer_messages_from_attributed_lead_cohort  bigint,
  our_messages_from_attributed_lead_cohort    bigint,
  leads_per_100_channel_listing_days          numeric,
  last_lead_date                              date,
  realized_deal_count_by_recorded_channel     bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH channels AS (
    SELECT id AS deal_channel_id, name AS channel_name, sort_order
    FROM public.deal_channels
    WHERE is_listing_platform = true
  ),
  exposure AS (
    SELECT * FROM public.listing_exposure_days_v1_0(p_target_user_id, p_period_start, p_period_end)
  ),
  channel_exposure_agg AS (
    SELECT deal_channel_id,
           COUNT(*) AS channel_listing_days,
           COUNT(DISTINCT inventory_item_id) AS distinct_listed_items
    FROM exposure
    GROUP BY deal_channel_id
  ),
  -- Every lead with a normalized channel whose first_contact_at falls in
  -- the period, for this user — no Purpose check of any kind.
  cohort_leads AS (
    SELECT l.id, l.deal_channel_id, l.inventory_item_id, l.first_contact_at,
           l.lead_quality, l.status, l.buyer_message_count, l.our_message_count
    FROM public.item_leads l
    WHERE l.user_id = p_target_user_id
      AND l.first_contact_at BETWEEN p_period_start AND p_period_end
      AND l.deal_channel_id IS NOT NULL
  ),
  -- The exact same CHANNEL-ATTRIBUTED cohort that backs every other
  -- attributed metric below (Requirement 3 — never all leads_started, and
  -- never merely "has a normalized channel" without exposure on that
  -- exact date). A lead whose item/channel pair was not actually listed
  -- on first_contact_at (e.g. a different channel was active that day, or
  -- none was) never enters this CTE and therefore never affects
  -- last_lead_date either.
  channel_attributed AS (
    SELECT cl.*
    FROM cohort_leads cl
    WHERE EXISTS (
      SELECT 1 FROM exposure e
      WHERE e.inventory_item_id = cl.inventory_item_id
        AND e.deal_channel_id = cl.deal_channel_id
        AND e.activity_date = cl.first_contact_at
    )
  ),
  channel_lead_agg AS (
    SELECT
      deal_channel_id,
      COUNT(*) AS channel_attributed_leads,
      COUNT(*) FILTER (WHERE lead_quality IN ('SERIOUS', 'HIGH_INTENT')) AS serious_plus_attributed_leads_from_cohort,
      COUNT(*) FILTER (WHERE lead_quality = 'HIGH_INTENT')               AS high_intent_attributed_leads_from_cohort,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')                      AS completed_leads_from_cohort,
      COALESCE(SUM(buyer_message_count), 0) AS buyer_messages_from_attributed_lead_cohort,
      COALESCE(SUM(our_message_count), 0)   AS our_messages_from_attributed_lead_cohort,
      -- FIX: latest first_contact_at within THIS SAME period-bounded,
      -- channel-attributed cohort — never a lifetime/global value. A
      -- channel with no attributed lead in the period has no row here at
      -- all, so the LEFT JOIN below naturally yields NULL, never a stale
      -- or out-of-period date.
      MAX(first_contact_at) AS last_lead_date
    FROM channel_attributed
    GROUP BY deal_channel_id
  ),
  -- Section 15: grouped by the DEAL's own recorded deal_channel_id — a
  -- factual field on public.deals, never derived from lead attribution.
  -- Explicitly NOT lead-to-deal conversion; see this function's own
  -- comment and the top-level limitations array. No Purpose check.
  realized_by_channel AS (
    SELECT d.deal_channel_id, COUNT(DISTINCT d.id) AS realized_deal_count_by_recorded_channel
    FROM public.deals d
    JOIN public.deal_items di ON di.deal_id = d.id AND di.direction = 'out'
    WHERE d.user_id = p_target_user_id
      AND d.deal_type IN ('sale', 'trade')
      AND d.deal_date BETWEEN p_period_start AND p_period_end
      AND d.deal_channel_id IS NOT NULL
    GROUP BY d.deal_channel_id
  )
  SELECT
    c.deal_channel_id,
    c.channel_name,
    c.sort_order,
    COALESCE(cea.channel_listing_days, 0),
    COALESCE(cea.distinct_listed_items, 0),
    COALESCE(cla.channel_attributed_leads, 0),
    COALESCE(cla.serious_plus_attributed_leads_from_cohort, 0),
    COALESCE(cla.high_intent_attributed_leads_from_cohort, 0),
    COALESCE(cla.completed_leads_from_cohort, 0),
    COALESCE(cla.buyer_messages_from_attributed_lead_cohort, 0),
    COALESCE(cla.our_messages_from_attributed_lead_cohort, 0),
    CASE WHEN COALESCE(cea.channel_listing_days, 0) > 0
         THEN ROUND(COALESCE(cla.channel_attributed_leads, 0)::numeric / cea.channel_listing_days * 100, 4)
    END,
    cla.last_lead_date,
    COALESCE(rbc.realized_deal_count_by_recorded_channel, 0)
  FROM channels c
  LEFT JOIN channel_exposure_agg cea   ON cea.deal_channel_id  = c.deal_channel_id
  LEFT JOIN channel_lead_agg cla       ON cla.deal_channel_id  = c.deal_channel_id
  LEFT JOIN realized_by_channel rbc    ON rbc.deal_channel_id  = c.deal_channel_id
  ORDER BY c.sort_order;
$$;

REVOKE ALL ON FUNCTION public._listing_demand_channel_metrics_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._listing_demand_channel_metrics_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public._listing_demand_channel_metrics_v1_0(int, date, date) IS
  'Internal to Listing Demand Evidence v1.0. One row per canonical '
  '(is_listing_platform=true) deal_channels row, for exactly one period — '
  'every listing-capable channel always appears, even with zero activity '
  '(never hardcoded to Marketplace/Kijiji/Reverb). Completely '
  'Purpose-agnostic. last_lead_date is the latest first_contact_at within '
  'THIS period''s channel-attributed cohort (same cohort as channel_'
  'attributed_leads/serious_plus_attributed_leads_from_cohort/etc.) — '
  'never a lifetime value, and NULL whenever no lead was attributed to '
  'this channel in this period (fixed 20260915000000; was previously an '
  'unbounded lifetime MAX that leaked the same date into both current and '
  'previous). realized_deal_count_by_recorded_channel is grouped by '
  'deals.deal_channel_id (a factual recorded field) and is explicitly '
  'NOT a lead-attributed or lead-conversion figure. service_role EXECUTE '
  'only.';
