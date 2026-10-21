-- Direct lead writes, part 3: listing-demand analytics move from legacy
-- lead_quality to peak_stage.
--
-- "Serious+" (SERIOUS + HIGH_INTENT) is replaced by Negotiating+ (NEGOTIATING
-- + HIGH_INTENT + CONVERTED) and "High intent" by High Intent+ (HIGH_INTENT +
-- CONVERTED), via public.lead_is_negotiating_plus / lead_is_high_intent_plus
-- (20261021000000). While a row's peak_stage is still NULL (not yet
-- backfilled) those helpers fall back to the legacy lead_quality mapping, so
-- nothing changes until the backfill runs and DIRECT leads (no lead_quality)
-- are counted correctly from day one.
--
-- External JSON key names (serious_plus_*, high_intent_*) are KEPT for one
-- release as compatibility aliases — they now carry the Negotiating+ /
-- High Intent+ values. Function bodies are otherwise verbatim copies of
-- their latest definitions (listed per function below).

-- ── public._listing_demand_period_metrics_v1_0 (from 20260914000000_build_listing_demand_evidence_v1_0.sql) ──

CREATE OR REPLACE FUNCTION public._listing_demand_period_metrics_v1_0(
  p_target_user_id int,
  p_period_start   date,
  p_period_end     date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH period_days AS (
    SELECT (p_period_end - p_period_start + 1) AS days
  ),
  exposure AS (
    SELECT * FROM public.listing_exposure_days_v1_0(p_target_user_id, p_period_start, p_period_end)
  ),
  item_days AS (
    SELECT COUNT(DISTINCT inventory_item_id) AS distinct_listed_item_count,
           COUNT(DISTINCT (inventory_item_id, activity_date)) AS item_listing_days
    FROM exposure
  ),
  channel_days AS (
    -- exposure is already deduped at the (item, channel, day) grain, so a
    -- plain row count IS the channel-listing-day count.
    SELECT COUNT(*) AS channel_listing_days FROM exposure
  ),
  -- Every lead whose first_contact_at falls in the period, for this user —
  -- no Purpose check of any kind.
  cohort_leads AS (
    SELECT l.id, l.deal_channel_id, l.inventory_item_id, l.first_contact_at,
           l.lead_quality, l.peak_stage, l.status, l.offer_type, l.buyer_message_count, l.our_message_count
    FROM public.item_leads l
    WHERE l.user_id = p_target_user_id
      AND l.first_contact_at BETWEEN p_period_start AND p_period_end
  ),
  lead_aggregates AS (
    SELECT
      COUNT(*) AS leads_started,
      COUNT(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM exposure e WHERE e.inventory_item_id = cl.inventory_item_id AND e.activity_date = cl.first_contact_at)
      ) AS item_attributed_leads,
      COUNT(*) FILTER (
        WHERE cl.deal_channel_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM exposure e
          WHERE e.inventory_item_id = cl.inventory_item_id AND e.deal_channel_id = cl.deal_channel_id AND e.activity_date = cl.first_contact_at
        )
      ) AS channel_attributed_leads,
      COUNT(*) FILTER (WHERE cl.deal_channel_id IS NOT NULL) AS leads_with_normalized_channel,
      COUNT(*) FILTER (WHERE cl.deal_channel_id IS NULL)     AS leads_without_normalized_channel,
      COUNT(*) FILTER (WHERE public.lead_is_negotiating_plus(cl.peak_stage, cl.lead_quality)) AS serious_plus_leads_from_cohort,
      COUNT(*) FILTER (WHERE public.lead_is_high_intent_plus(cl.peak_stage, cl.lead_quality))               AS high_intent_leads_from_cohort,
      COUNT(*) FILTER (WHERE cl.status = 'COMPLETED')                      AS completed_leads_from_cohort,
      COUNT(*) FILTER (WHERE cl.offer_type = 'CASH')                       AS cash_offer_leads_from_cohort,
      COUNT(*) FILTER (WHERE cl.offer_type = 'TRADE')                      AS trade_offer_leads_from_cohort,
      COUNT(*) FILTER (WHERE cl.offer_type = 'MIXED')                      AS mixed_offer_leads_from_cohort,
      COALESCE(SUM(cl.buyer_message_count), 0) AS buyer_messages_from_cohort,
      COALESCE(SUM(cl.our_message_count), 0)   AS our_messages_from_cohort
    FROM cohort_leads cl
  ),
  -- Canonical realized Sell/Trade for this user in the period — no
  -- Purpose check of any kind.
  realized AS (
    SELECT
      COUNT(DISTINCT d.id)      AS realized_deal_count,
      COUNT(DISTINCT di.item_id) AS realized_item_count
    FROM public.deals d
    JOIN public.deal_items di ON di.deal_id = d.id AND di.direction = 'out'
    WHERE d.user_id = p_target_user_id
      AND d.deal_type IN ('sale', 'trade')
      AND d.deal_date BETWEEN p_period_start AND p_period_end
  )
  SELECT jsonb_build_object(
    'item_listing_days', id.item_listing_days,
    'channel_listing_days', cd.channel_listing_days,
    'distinct_listed_item_count', id.distinct_listed_item_count,
    'avg_listed_items', CASE WHEN pd.days > 0 THEN ROUND(id.item_listing_days::numeric / pd.days, 4) END,
    'avg_channel_exposure', CASE WHEN pd.days > 0 THEN ROUND(cd.channel_listing_days::numeric / pd.days, 4) END,
    'exposure_multiplier', CASE WHEN id.item_listing_days > 0 THEN ROUND(cd.channel_listing_days::numeric / id.item_listing_days, 4) END,
    'leads_started', la.leads_started,
    'item_attributed_leads', la.item_attributed_leads,
    'channel_attributed_leads', la.channel_attributed_leads,
    'leads_with_normalized_channel', la.leads_with_normalized_channel,
    'leads_without_normalized_channel', la.leads_without_normalized_channel,
    'serious_plus_leads_from_cohort', la.serious_plus_leads_from_cohort,
    'high_intent_leads_from_cohort', la.high_intent_leads_from_cohort,
    'completed_leads_from_cohort', la.completed_leads_from_cohort,
    'cash_offer_leads_from_cohort', la.cash_offer_leads_from_cohort,
    'trade_offer_leads_from_cohort', la.trade_offer_leads_from_cohort,
    'mixed_offer_leads_from_cohort', la.mixed_offer_leads_from_cohort,
    'buyer_messages_from_cohort', la.buyer_messages_from_cohort,
    'our_messages_from_cohort', la.our_messages_from_cohort,
    'leads_per_100_item_listing_days', CASE WHEN id.item_listing_days > 0 THEN ROUND(la.item_attributed_leads::numeric / id.item_listing_days * 100, 4) END,
    'leads_per_100_channel_listing_days', CASE WHEN cd.channel_listing_days > 0 THEN ROUND(la.channel_attributed_leads::numeric / cd.channel_listing_days * 100, 4) END,
    'realized_deal_count', r.realized_deal_count,
    'realized_item_count', r.realized_item_count
  )
  FROM period_days pd, item_days id, channel_days cd, lead_aggregates la, realized r;
$$;

-- ── public._listing_demand_channel_metrics_v1_0 (from 20260915000000_fix_listing_demand_channel_last_lead_date.sql) ──

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
           l.lead_quality, l.peak_stage, l.status, l.buyer_message_count, l.our_message_count
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
      COUNT(*) FILTER (WHERE public.lead_is_negotiating_plus(peak_stage, lead_quality)) AS serious_plus_attributed_leads_from_cohort,
      COUNT(*) FILTER (WHERE public.lead_is_high_intent_plus(peak_stage, lead_quality))               AS high_intent_attributed_leads_from_cohort,
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

-- ── public._listing_demand_item_evidence_v1_0 (from 20260914000000_build_listing_demand_evidence_v1_0.sql) ──

CREATE OR REPLACE FUNCTION public._listing_demand_item_evidence_v1_0(
  p_target_user_id int,
  p_period_start   date,
  p_period_end     date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH currently_listed_items AS (
    SELECT ai.item_id, ai.item_display_name, ai.brand_id, ai.brand_name,
           ai.category_id, ai.category_name, ai.type_id, ai.type_name,
           -- Informational metadata only — already free on this same row;
           -- never used to include/exclude an item or affect any number
           -- below.
           ai.purpose_id, ai.purpose_name
    FROM public.analytics_item_lifecycle_v2 ai
    WHERE ai.user_id = p_target_user_id
      AND NOT ai.is_realized
      AND EXISTS (
        SELECT 1 FROM public.item_listings il
        WHERE il.inventory_item_id = ai.item_id AND il.user_id = p_target_user_id AND il.status = 'active'
      )
  ),
  active_channels AS (
    SELECT
      il.inventory_item_id AS item_id,
      jsonb_agg(
        jsonb_build_object('channel_id', dc.id, 'channel_name', dc.name, 'listed_at', il.listed_at)
        ORDER BY dc.sort_order
      ) AS channels_json
    FROM public.item_listings il
    JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
    WHERE il.user_id = p_target_user_id AND il.status = 'active'
    GROUP BY il.inventory_item_id
  ),
  exposure AS (
    SELECT * FROM public.listing_exposure_days_v1_0(p_target_user_id, p_period_start, p_period_end)
  ),
  item_exposure_agg AS (
    SELECT
      inventory_item_id AS item_id,
      COUNT(DISTINCT activity_date) AS item_listing_days_in_period,
      COUNT(*)                      AS channel_listing_days_in_period
    FROM exposure
    GROUP BY inventory_item_id
  ),
  period_leads AS (
    SELECT l.*
    FROM public.item_leads l
    WHERE l.user_id = p_target_user_id
      AND l.first_contact_at BETWEEN p_period_start AND p_period_end
      AND l.inventory_item_id IN (SELECT item_id FROM currently_listed_items)
  ),
  period_lead_agg AS (
    SELECT
      inventory_item_id AS item_id,
      COUNT(*) AS leads_started_in_period,
      COUNT(*) FILTER (
        WHERE EXISTS (SELECT 1 FROM exposure e WHERE e.inventory_item_id = pl.inventory_item_id AND e.activity_date = pl.first_contact_at)
      ) AS item_attributed_leads_in_period,
      COUNT(*) FILTER (
        WHERE pl.deal_channel_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM exposure e
          WHERE e.inventory_item_id = pl.inventory_item_id AND e.deal_channel_id = pl.deal_channel_id AND e.activity_date = pl.first_contact_at
        )
      ) AS channel_attributed_leads_in_period,
      COUNT(*) FILTER (WHERE public.lead_is_negotiating_plus(peak_stage, lead_quality)) AS serious_plus_leads_from_cohort,
      COUNT(*) FILTER (WHERE public.lead_is_high_intent_plus(peak_stage, lead_quality))               AS high_intent_leads_from_cohort,
      COUNT(*) FILTER (WHERE status = 'COMPLETED')                      AS completed_leads_from_cohort,
      COALESCE(SUM(buyer_message_count), 0) AS buyer_messages_from_cohort,
      COALESCE(SUM(our_message_count), 0)   AS our_messages_from_cohort,
      COUNT(*) FILTER (WHERE offer_type = 'CASH')  AS cash_offer_lead_count,
      COUNT(*) FILTER (WHERE offer_type = 'TRADE') AS trade_offer_lead_count,
      COUNT(*) FILTER (WHERE offer_type = 'MIXED') AS mixed_offer_lead_count,
      MAX(best_cash_offer) AS best_cash_offer_in_cohort
    FROM period_leads pl
    GROUP BY inventory_item_id
  ),
  -- Lifetime fact, not period-bounded — same rationale as the channel-level
  -- last_lead_date.
  last_lead_global AS (
    SELECT inventory_item_id AS item_id, MAX(first_contact_at) AS last_lead_date
    FROM public.item_leads
    WHERE user_id = p_target_user_id AND first_contact_at IS NOT NULL
      AND inventory_item_id IN (SELECT item_id FROM currently_listed_items)
    GROUP BY inventory_item_id
  ),
  -- current_listing_cycle_leads: leads attributable to the item's CURRENT
  -- active cycle(s) specifically (from whenever that cycle started through
  -- today), independent of the requested reporting period. A lead is
  -- counted at most once per item even if the item is cross-listed and the
  -- lead's date falls inside more than one active cycle's window (DISTINCT
  -- on the lead's own id).
  current_cycle_leads AS (
    SELECT DISTINCT l.id AS lead_pk, l.inventory_item_id AS item_id
    FROM public.item_leads l
    JOIN public.item_listings il
      ON il.inventory_item_id = l.inventory_item_id
     AND il.user_id = l.user_id
     AND il.status = 'active'
    WHERE l.user_id = p_target_user_id
      AND l.first_contact_at IS NOT NULL
      AND l.first_contact_at >= il.listed_at
      AND l.first_contact_at <= CURRENT_DATE
      AND l.inventory_item_id IN (SELECT item_id FROM currently_listed_items)
  ),
  current_cycle_lead_agg AS (
    SELECT item_id, COUNT(DISTINCT lead_pk) AS current_listing_cycle_leads
    FROM current_cycle_leads
    GROUP BY item_id
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'item_id', cli.item_id,
      'item_display_name', cli.item_display_name,
      'brand_id', cli.brand_id,
      'brand_name', cli.brand_name,
      'category_id', cli.category_id,
      'category_name', cli.category_name,
      'type_id', cli.type_id,
      'type_name', cli.type_name,
      'purpose_id', cli.purpose_id,
      'purpose_name', cli.purpose_name,
      'current_active_channels', COALESCE(ac.channels_json, '[]'::jsonb),
      'item_listing_days_in_period', COALESCE(iea.item_listing_days_in_period, 0),
      'channel_listing_days_in_period', COALESCE(iea.channel_listing_days_in_period, 0),
      'leads_started_in_period', COALESCE(pla.leads_started_in_period, 0),
      'item_attributed_leads_in_period', COALESCE(pla.item_attributed_leads_in_period, 0),
      'channel_attributed_leads_in_period', COALESCE(pla.channel_attributed_leads_in_period, 0),
      'serious_plus_leads_from_cohort', COALESCE(pla.serious_plus_leads_from_cohort, 0),
      'high_intent_leads_from_cohort', COALESCE(pla.high_intent_leads_from_cohort, 0),
      'completed_leads_from_cohort', COALESCE(pla.completed_leads_from_cohort, 0),
      'buyer_messages_from_cohort', COALESCE(pla.buyer_messages_from_cohort, 0),
      'our_messages_from_cohort', COALESCE(pla.our_messages_from_cohort, 0),
      'cash_offer_lead_count', COALESCE(pla.cash_offer_lead_count, 0),
      'trade_offer_lead_count', COALESCE(pla.trade_offer_lead_count, 0),
      'mixed_offer_lead_count', COALESCE(pla.mixed_offer_lead_count, 0),
      'best_cash_offer_in_cohort', pla.best_cash_offer_in_cohort,
      'last_lead_date', llg.last_lead_date,
      'current_listing_cycle_leads', COALESCE(ccl.current_listing_cycle_leads, 0)
    ) ORDER BY cli.item_id
  ), '[]'::jsonb)
  FROM currently_listed_items cli
  LEFT JOIN active_channels ac          ON ac.item_id  = cli.item_id
  LEFT JOIN item_exposure_agg iea       ON iea.item_id = cli.item_id
  LEFT JOIN period_lead_agg pla         ON pla.item_id = cli.item_id
  LEFT JOIN last_lead_global llg        ON llg.item_id = cli.item_id
  LEFT JOIN current_cycle_lead_agg ccl  ON ccl.item_id = cli.item_id;
$$;

-- ── public.listing_demand_item_activity_v1_0 (from 20260919000000_lead_activity_by_item.sql) ──

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
    SELECT l.inventory_item_id AS attributed_item_id, l.lead_quality, l.peak_stage, l.offer_type, l.first_contact_at
    FROM public._lead_item_attributed_v1_0(p_target_user_id, p_period_start, p_period_end) a
    JOIN public.item_leads l ON l.id = a.lead_row_id
  ),
  agg AS (
    SELECT
      attributed_item_id,
      COUNT(*) AS leads,
      COUNT(*) FILTER (WHERE public.lead_is_negotiating_plus(peak_stage, lead_quality)) AS serious_plus,
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

