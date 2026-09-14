-- Listing Demand Evidence v1.0 — DATA/EVIDENCE FOUNDATION ONLY.
--
-- Answers, for an explicit inclusive [p_start_date, p_end_date] period and
-- its automatically-derived equal-length previous period:
--   1. How much inventory/listing exposure did I have in a period?
--   2. How many leads did that exposure generate?
--   3. How did exposure-normalized demand change vs. the previous period?
--   4. How did individual listing channels perform?
--   5. Which currently listed items are generating interest?
--   6. How many actual realized sell/trade deals occurred in the period?
--
-- Does NOT attempt causal inference and explicitly does NOT claim a
-- lead -> deal conversion rate (no canonical lead_id -> deal_id
-- relationship exists in this schema — see analysis_context.
-- deal_linkage_semantics and the limitations array in the output).
--
-- ── PURPOSE (Business/Hybrid/Personal): COMPLETELY AGNOSTIC ──────────────
-- Before this migration was ever applied to production, v1.0 was patched
-- to remove Purpose from every calculation. Every exposure day, every
-- lead, every attribution, every realized deal, and every currently-listed
-- item participates identically regardless of Business/Hybrid/Personal/
-- unmapped Purpose — the user's current goal is simply exposure -> leads
-- -> realized activity across ALL listed inventory, and Purpose is
-- explicitly out of scope for v1.0 (it may be revisited in a later
-- version, as its own dimension, never smuggled back in as a filter
-- here). There is no personal_summary, no primary_purposes context, and
-- no Purpose-based exclusion anywhere below. Item evidence still surfaces
-- purpose_id/purpose_name as plain informational metadata (already free
-- on the same analytics_item_lifecycle_v2 row every item evidence query
-- reads for its other display fields) — it never affects inclusion or any
-- computed number.
--
-- ── CANONICAL RULES REUSED, NOT REINVENTED (audited before writing any of
-- this SQL) ──────────────────────────────────────────────────────────────
-- - "Open item" / is_realized: read directly from analytics_item_lifecycle_
--   v2 — byte-identical to build_listing_evidence_v1_0's own base_items
--   CTE (is_realized = latest outgoing deal_items row's deal.deal_type IN
--   ('sale','trade'), computed in analytics_item_lifecycle's exit_deal
--   CTE, 20260723000000 through 20260829000000). Never recomputed here.
-- - item_listings lifecycle: status ('draft'/'active'/'ended'/'cancelled',
--   20260828000000_item_listings_lifecycle.sql) is the sole source of
--   listing-cycle truth. Cancelled rows are NEVER exposure (they were
--   never a real listing attempt — same rule as analytics_item_lifecycle's
--   own `listings` CTE, 20260829000000). Draft rows carry no listed_at
--   (item_listings_status_fields_check) so they are structurally inert.
-- - Stale active listings: create_sell_operation/create_trade_operation/
--   edit_trade_operation (20260831000000_close_listings_on_sale_trade.sql)
--   close an 'active' cycle to 'ended' at the deal date when they mark an
--   item sold/traded, but only when listed_at <= deal_date — a row that
--   fails that guard (bad historical listed_at) is left 'active' forever
--   on a now-realized item. build_listing_evidence_v1_0 handles this by
--   excluding such rows from its CURRENT snapshot entirely (stale_active_
--   listings_excluded_count) via an INNER JOIN to open-only base_items.
--   THIS module is period-historical, not a current snapshot, so a
--   different fix is needed: listing_exposure_days_v1_0 below clips an
--   'active' cycle's effective end date to the item's own canonical
--   exit_date (analytics_item_lifecycle_v2.exit_date) whenever the item
--   is_realized — reusing that exact same disposition fact rather than
--   inventing a second lifecycle engine — so exposure BEFORE a genuine
--   sale/trade still counts (it really happened), but a stale 'active' row
--   can never generate exposure past the day the item actually left
--   inventory. See this migration's own final COMMENT for the full report.
-- - Realized Sell/Trade: deal_type IN ('sale','trade') on public.deals,
--   the exact same predicate analytics_item_lifecycle's exit_deal CTE
--   uses for is_realized. Buy ('purchase'), Expense ('expense'), and every
--   Historical* label are excluded, matching DealType in src/types/
--   index.d.ts and every analytics_item_lifecycle_* migration. Applies
--   across ALL of the target user's inventory — never Purpose-filtered.
-- - Lead cohort date: item_leads.first_contact_at only — never source_
--   updated_at/updated_at/last_contact_at. NULL first_contact_at is never
--   assigned to a period (SQL BETWEEN is NULL-safe: NULL BETWEEN x AND y
--   is NULL, never true).
-- - lead_quality: item_leads' own documented "highest intent level ever
--   reached" semantics (20260908000001_item_leads.sql) are preserved by
--   naming every quality-derived field '..._from_cohort' — never implying
--   the lead WAS that quality on first_contact_at.
--
-- ── DATE / CALENDAR-DAY CONVENTION (audited, not invented) ────────────────
-- item_listings.listed_at/ended_at, deals.deal_date, and item_leads.
-- first_contact_at are all plain `date` columns (no timezone) — used
-- directly, with plain date arithmetic (GREATEST/LEAST/BETWEEN/+/-,
-- exactly like every other migration in this schema, e.g. analytics_item_
-- lifecycle's `CURRENT_DATE - il.listed_at`). No per-user timezone
-- architecture exists anywhere in this schema and none is introduced
-- here — CURRENT_DATE is the Postgres session date, the same "today" every
-- other lifecycle/listing-age computation in this codebase already uses.
--
-- ── GRAIN / DEDUPLICATION ──────────────────────────────────────────────────
-- listing_exposure_days_v1_0 returns at most ONE row per
-- (user [implicit — always p_target_user_id], activity_date,
-- inventory_item_id, deal_channel_id) — a final `SELECT DISTINCT` over the
-- generated day-rows guarantees this even if two 'ended' cycles (or an
-- 'ended' + a later 'active' cycle) for the same item+channel happen to
-- have overlapping date ranges in the underlying data (item_listings_
-- unique_open_per_item_channel only prevents two concurrent non-terminal
-- rows — it says nothing about historical/ended rows never overlapping).
--
-- ── ARCHITECTURE ──────────────────────────────────────────────────────────
-- One reusable, period-bounded table function (listing_exposure_days_v1_0)
-- is the single daily-exposure foundation, called by every other piece
-- below — never a second lifecycle/exposure engine. Three small STABLE SQL
-- functions each compute one dimension for ONE period (period metrics,
-- per-channel metrics, item evidence); the top-level plpgsql orchestrator
-- (build_listing_demand_evidence_v1_0) validates the input dates, derives
-- the equal-length previous period, calls the per-period functions once
-- each for current/previous as needed, and assembles the final
-- deterministic JSON. All service_role EXECUTE only, matching
-- build_listing_evidence_v1_0's own security model exactly — the caller
-- always resolves its own app_users.id server-side and passes it as
-- p_target_user_id, never a client-suppliable value.
--
-- ── PATCH NOTE (pre-production, no data migration needed) ────────────────
-- This migration was edited in place — never applied to production — to
-- remove Purpose filtering entirely before its first real deployment.
-- listing_exposure_days_v1_0's RETURNS TABLE dropped a column
-- (purpose_bucket), which PostgreSQL cannot do via CREATE OR REPLACE
-- FUNCTION alone, and _listing_demand_personal_summary_v1_0 no longer
-- exists at all — both are explicitly DROPped below before being
-- (re)created, so replaying this single migration file from a clean
-- database, or over a local database that already ran an earlier version
-- of it, both converge on the same end state.

DROP FUNCTION IF EXISTS public.listing_exposure_days_v1_0(int, date, date);
DROP FUNCTION IF EXISTS public._listing_demand_personal_summary_v1_0(int, date, date);

-- ═══════════════════════════════════════════════════════════════════════
-- 1. listing_exposure_days_v1_0 — the reusable daily exposure foundation
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.listing_exposure_days_v1_0(
  p_target_user_id int,
  p_period_start   date,
  p_period_end     date
)
RETURNS TABLE (
  inventory_item_id bigint,
  deal_channel_id   bigint,
  activity_date     date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH item_lifecycle AS (
    -- Only is_realized/exit_date are needed here (the stale-active clip
    -- below) — Purpose is deliberately never read/joined in this function.
    SELECT ai.item_id, ai.is_realized, ai.exit_date
    FROM public.analytics_item_lifecycle_v2 ai
    WHERE ai.user_id = p_target_user_id
  ),
  -- Only real listing attempts (Rule: cancelled rows never generate
  -- exposure; draft rows have no listed_at so are structurally excluded
  -- by the join below regardless).
  eligible_cycles AS (
    SELECT
      il.inventory_item_id,
      il.deal_channel_id,
      GREATEST(il.listed_at, p_period_start) AS cycle_start,
      LEAST(
        CASE
          WHEN il.status = 'ended'  THEN il.ended_at
          WHEN il.status = 'active' THEN
            -- Stale-active clip: an 'active' row on an item that HAS since
            -- been realized (sold/traded) never generates exposure past
            -- its own canonical exit_date, even if the row itself was
            -- never properly closed to 'ended'.
            CASE WHEN it.is_realized AND it.exit_date IS NOT NULL
                 THEN it.exit_date
                 ELSE p_period_end
            END
        END,
        p_period_end
      ) AS cycle_end
    FROM public.item_listings il
    JOIN public.deal_channels dc ON dc.id = il.deal_channel_id AND dc.is_listing_platform = true
    JOIN item_lifecycle it ON it.item_id = il.inventory_item_id
    WHERE il.user_id = p_target_user_id
      AND il.status IN ('active', 'ended')
  ),
  exposure_rows AS (
    SELECT
      ec.inventory_item_id,
      ec.deal_channel_id,
      d::date AS activity_date
    FROM eligible_cycles ec
    CROSS JOIN LATERAL generate_series(ec.cycle_start, ec.cycle_end, interval '1 day') AS d
    WHERE ec.cycle_start <= ec.cycle_end
  )
  SELECT DISTINCT inventory_item_id, deal_channel_id, activity_date
  FROM exposure_rows;
$$;

REVOKE ALL ON FUNCTION public.listing_exposure_days_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listing_exposure_days_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public.listing_exposure_days_v1_0(int, date, date) IS
  'Reusable daily listing-exposure foundation for Listing Demand Evidence '
  'v1.0. One row per (activity_date, inventory_item_id, deal_channel_id) '
  'for the given user within [p_period_start, p_period_end] — never more '
  'than one, even across overlapping/duplicate historical listing cycles. '
  'Cancelled cycles never generate exposure; an active cycle on an '
  'item that has since been realized (sold/traded) is clipped to that '
  'item''s own exit_date, never generating exposure after a genuine '
  'disposition. Completely Purpose-agnostic — every listing for the '
  'target user participates regardless of Business/Hybrid/Personal/'
  'unmapped Purpose. Reused by every other Listing Demand Evidence '
  'function below. STABLE, SECURITY INVOKER, service_role EXECUTE only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. _listing_demand_period_metrics_v1_0 — all-inventory summary, one period
-- ═══════════════════════════════════════════════════════════════════════

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
           l.lead_quality, l.status, l.offer_type, l.buyer_message_count, l.our_message_count
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
      COUNT(*) FILTER (WHERE cl.lead_quality IN ('SERIOUS', 'HIGH_INTENT')) AS serious_plus_leads_from_cohort,
      COUNT(*) FILTER (WHERE cl.lead_quality = 'HIGH_INTENT')               AS high_intent_leads_from_cohort,
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

REVOKE ALL ON FUNCTION public._listing_demand_period_metrics_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._listing_demand_period_metrics_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public._listing_demand_period_metrics_v1_0(int, date, date) IS
  'Internal to Listing Demand Evidence v1.0. All-inventory (completely '
  'Purpose-agnostic) exposure/lead/realized-deal summary metrics for '
  'exactly one period — called twice (current, previous) by '
  'build_listing_demand_evidence_v1_0. item_attributed_leads/channel_'
  'attributed_leads are ATTRIBUTED counts (see listing_exposure_days_'
  'v1_0), never all leads_started. Ratio fields are NULL, never 0 or a '
  'crash, when their denominator is zero. service_role EXECUTE only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. _listing_demand_channel_metrics_v1_0 — per canonical channel, one period
-- ═══════════════════════════════════════════════════════════════════════

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
      COALESCE(SUM(our_message_count), 0)   AS our_messages_from_attributed_lead_cohort
    FROM channel_attributed
    GROUP BY deal_channel_id
  ),
  -- Lifetime fact (not period-bounded) — same convention as item-level
  -- last_lead_date: useful context even outside the requested period.
  channel_last_lead_global AS (
    SELECT deal_channel_id, MAX(first_contact_at) AS last_lead_date
    FROM public.item_leads
    WHERE user_id = p_target_user_id AND deal_channel_id IS NOT NULL AND first_contact_at IS NOT NULL
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
    cllg.last_lead_date,
    COALESCE(rbc.realized_deal_count_by_recorded_channel, 0)
  FROM channels c
  LEFT JOIN channel_exposure_agg cea   ON cea.deal_channel_id  = c.deal_channel_id
  LEFT JOIN channel_lead_agg cla       ON cla.deal_channel_id  = c.deal_channel_id
  LEFT JOIN channel_last_lead_global cllg ON cllg.deal_channel_id = c.deal_channel_id
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
  'Purpose-agnostic. realized_deal_count_by_recorded_channel is grouped '
  'by deals.deal_channel_id (a factual recorded field) and is explicitly '
  'NOT a lead-attributed or lead-conversion figure. service_role EXECUTE '
  'only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. _listing_demand_item_evidence_v1_0 — currently-listed items (all Purpose)
-- ═══════════════════════════════════════════════════════════════════════

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
      COUNT(*) FILTER (WHERE lead_quality IN ('SERIOUS', 'HIGH_INTENT')) AS serious_plus_leads_from_cohort,
      COUNT(*) FILTER (WHERE lead_quality = 'HIGH_INTENT')               AS high_intent_leads_from_cohort,
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

REVOKE ALL ON FUNCTION public._listing_demand_item_evidence_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._listing_demand_item_evidence_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public._listing_demand_item_evidence_v1_0(int, date, date) IS
  'Internal to Listing Demand Evidence v1.0. Returns a jsonb array, one '
  'entry per currently-listed (status=active right now), open (NOT '
  'is_realized) item, regardless of Purpose. purpose_id/purpose_name are '
  'informational metadata only — they never affect inclusion or any '
  'computed number. "_in_period"/"_from_cohort" fields are scoped to '
  '[p_period_start, p_period_end]; current_active_channels and '
  'last_lead_date are live/lifetime facts, not period-scoped. '
  'current_listing_cycle_leads counts leads whose first_contact_at falls '
  'within the item''s CURRENT active cycle(s) (from listed_at through '
  'CURRENT_DATE), independent of the requested period, counted at most '
  'once per item even when cross-listed. service_role EXECUTE only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. _listing_demand_numeric_change_v1_0 — {current, previous, absolute_
--    change, percent_change} helper, reused for every compared metric.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._listing_demand_numeric_change_v1_0(
  p_current  numeric,
  p_previous numeric
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'current', p_current,
    'previous', p_previous,
    'absolute_change', CASE WHEN p_current IS NULL OR p_previous IS NULL THEN NULL ELSE p_current - p_previous END,
    'percent_change', CASE
      WHEN p_current IS NULL OR p_previous IS NULL THEN NULL
      WHEN p_previous = 0 THEN NULL
      ELSE ROUND((p_current - p_previous) / p_previous * 100, 4)
    END
  );
$$;

REVOKE ALL ON FUNCTION public._listing_demand_numeric_change_v1_0(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._listing_demand_numeric_change_v1_0(numeric, numeric) TO service_role;

COMMENT ON FUNCTION public._listing_demand_numeric_change_v1_0(numeric, numeric) IS
  'Internal to Listing Demand Evidence v1.0. {current, previous, '
  'absolute_change, percent_change} for one metric. percent_change is '
  'NULL (never Infinity/NaN/misleading 0) whenever previous is NULL or 0, '
  'or current is NULL.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6. build_listing_demand_evidence_v1_0 — top-level orchestrator
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.build_listing_demand_evidence_v1_0(
  p_target_user_id int,
  p_start_date     date,
  p_end_date       date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_days                        int;
  v_previous_end                date;
  v_previous_start              date;
  v_current_metrics             jsonb;
  v_previous_metrics            jsonb;
  v_channels                    jsonb;
  v_items                       jsonb;
  v_leads_started                numeric;
  v_item_attributed_leads        numeric;
  v_channel_attributed_leads     numeric;
  v_item_attribution_pct         numeric;
  v_channel_attribution_pct      numeric;
  v_undated_lead_count           int;
  v_earliest_dated_lead          date;
  v_earliest_listing_exposure_date date;
  v_data_quality                 jsonb;
  v_limitations                  jsonb;
  v_result                       jsonb;
BEGIN
  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'p_target_user_id is required';
  END IF;
  IF p_start_date IS NULL OR p_end_date IS NULL THEN
    RAISE EXCEPTION 'p_start_date and p_end_date are required';
  END IF;
  IF p_start_date > p_end_date THEN
    RAISE EXCEPTION 'p_start_date (%) must be <= p_end_date (%)', p_start_date, p_end_date;
  END IF;

  -- ── Period contract (section 4): explicit inclusive dates, no "last
  -- month" logic — the equal-length previous period is derived purely
  -- from arithmetic on the caller's own explicit dates. ──────────────────
  v_days           := (p_end_date - p_start_date + 1);
  v_previous_end   := p_start_date - 1;
  v_previous_start := v_previous_end - (v_days - 1);

  v_current_metrics  := public._listing_demand_period_metrics_v1_0(p_target_user_id, p_start_date, p_end_date);
  v_previous_metrics := public._listing_demand_period_metrics_v1_0(p_target_user_id, v_previous_start, v_previous_end);

  -- ── Channels: every canonical listing-platform channel, current +
  -- previous merged by deal_channel_id (FULL OUTER JOIN — defensive; both
  -- calls always return the same full channel universe in practice). ─────
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'deal_channel_id', COALESCE(cur.deal_channel_id, prev.deal_channel_id),
      'channel_name', COALESCE(cur.channel_name, prev.channel_name),
      'current', jsonb_build_object(
        'channel_listing_days', cur.channel_listing_days,
        'distinct_listed_items', cur.distinct_listed_items,
        'channel_attributed_leads', cur.channel_attributed_leads,
        'serious_plus_attributed_leads_from_cohort', cur.serious_plus_attributed_leads_from_cohort,
        'high_intent_attributed_leads_from_cohort', cur.high_intent_attributed_leads_from_cohort,
        'completed_leads_from_cohort', cur.completed_leads_from_cohort,
        'buyer_messages_from_attributed_lead_cohort', cur.buyer_messages_from_attributed_lead_cohort,
        'our_messages_from_attributed_lead_cohort', cur.our_messages_from_attributed_lead_cohort,
        'leads_per_100_channel_listing_days', cur.leads_per_100_channel_listing_days,
        'last_lead_date', cur.last_lead_date,
        'realized_deal_count_by_recorded_channel', cur.realized_deal_count_by_recorded_channel
      ),
      'previous', jsonb_build_object(
        'channel_listing_days', prev.channel_listing_days,
        'distinct_listed_items', prev.distinct_listed_items,
        'channel_attributed_leads', prev.channel_attributed_leads,
        'serious_plus_attributed_leads_from_cohort', prev.serious_plus_attributed_leads_from_cohort,
        'high_intent_attributed_leads_from_cohort', prev.high_intent_attributed_leads_from_cohort,
        'completed_leads_from_cohort', prev.completed_leads_from_cohort,
        'buyer_messages_from_attributed_lead_cohort', prev.buyer_messages_from_attributed_lead_cohort,
        'our_messages_from_attributed_lead_cohort', prev.our_messages_from_attributed_lead_cohort,
        'leads_per_100_channel_listing_days', prev.leads_per_100_channel_listing_days,
        'last_lead_date', prev.last_lead_date,
        'realized_deal_count_by_recorded_channel', prev.realized_deal_count_by_recorded_channel
      )
    ) ORDER BY COALESCE(cur.sort_order, prev.sort_order)
  ), '[]'::jsonb)
  INTO v_channels
  FROM public._listing_demand_channel_metrics_v1_0(p_target_user_id, p_start_date, p_end_date) cur
  FULL OUTER JOIN public._listing_demand_channel_metrics_v1_0(p_target_user_id, v_previous_start, v_previous_end) prev
    ON prev.deal_channel_id = cur.deal_channel_id;

  -- ── Items: currently-listed items (all Purpose), CURRENT period only
  -- (section 16 — a live/current-state view, not a period comparison). ───
  v_items := public._listing_demand_item_evidence_v1_0(p_target_user_id, p_start_date, p_end_date);

  -- ── Data quality / coverage (section 18). Reuses the CURRENT period's
  -- already-computed lead counts rather than recomputing them. ───────────
  v_leads_started            := (v_current_metrics->>'leads_started')::numeric;
  v_item_attributed_leads    := (v_current_metrics->>'item_attributed_leads')::numeric;
  v_channel_attributed_leads := (v_current_metrics->>'channel_attributed_leads')::numeric;
  v_item_attribution_pct    := CASE WHEN v_leads_started > 0 THEN ROUND(v_item_attributed_leads / v_leads_started * 100, 4) END;
  v_channel_attribution_pct := CASE WHEN v_leads_started > 0 THEN ROUND(v_channel_attributed_leads / v_leads_started * 100, 4) END;

  SELECT COUNT(*) FILTER (WHERE first_contact_at IS NULL), MIN(first_contact_at) FILTER (WHERE first_contact_at IS NOT NULL)
  INTO v_undated_lead_count, v_earliest_dated_lead
  FROM public.item_leads
  WHERE user_id = p_target_user_id;

  SELECT MIN(listed_at) INTO v_earliest_listing_exposure_date
  FROM public.item_listings
  WHERE user_id = p_target_user_id AND status IN ('active', 'ended');

  v_data_quality := jsonb_build_object(
    'current_period', jsonb_build_object(
      'leads_started', v_current_metrics->'leads_started',
      'item_attributed_leads', v_current_metrics->'item_attributed_leads',
      'channel_attributed_leads', v_current_metrics->'channel_attributed_leads',
      'item_attribution_pct', v_item_attribution_pct,
      'channel_attribution_pct', v_channel_attribution_pct,
      'leads_with_normalized_channel', v_current_metrics->'leads_with_normalized_channel',
      'leads_without_normalized_channel', v_current_metrics->'leads_without_normalized_channel'
    ),
    'undated_lead_count', v_undated_lead_count,
    'earliest_dated_lead', v_earliest_dated_lead,
    'earliest_listing_exposure_date', v_earliest_listing_exposure_date
  );

  v_limitations := to_jsonb(ARRAY[
    'lead_quality reflects the highest intent level a lead has ever reached, not its state on first_contact_at — serious_plus_leads_from_cohort and high_intent_leads_from_cohort describe leads that eventually/currently reached that quality, never that they started there.',
    'buyer_messages_from_cohort and our_messages_from_cohort are lifetime/current message-count totals belonging to leads whose first_contact_at fell in the period — never a claim about messages sent during the period itself.',
    'realized_deal_count and realized_item_count are factual Sell/Trade activity in the period and are explicitly NOT a lead-to-deal conversion metric — no canonical lead_id -> deal_id relationship exists in this schema yet. A deal in this period may originate from a lead that started in an earlier period, or from no logged lead at all.',
    'realized_deal_count_by_recorded_channel (channels[]) groups realized deals by the deal''s own recorded deal_channel_id and is independent of lead attribution — it is not evidence that a lead on that channel caused that deal.',
    'Historical Lead Log completeness varies by source and time period and must not be assumed complete merely because a first_contact_at date exists.',
    'This evidence is completely Purpose-agnostic — Business, Hybrid, Personal, and unmapped-Purpose listings, leads, and realized deals all participate identically. purpose_id/purpose_name on each item in items[] are informational metadata only and never affect any count here.',
    'item_listing_days/channel_listing_days are PERIOD exposure metrics, not a snapshot of current listing state — see Listing Evidence v1.0 (build_listing_evidence_v1_0) for that.'
  ]);

  v_result := jsonb_build_object(
    'schema_version', '1.0',
    'generated_at', now(),
    'target_user_id', p_target_user_id,
    'period', jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'days', v_days),
    'comparison_period', jsonb_build_object('start_date', v_previous_start, 'end_date', v_previous_end, 'days', v_days),
    'analysis_context', jsonb_build_object(
      'lead_quality_semantics', 'lead_quality is the highest intent level a lead has ever reached, not its quality on first_contact_at.',
      'deal_linkage_semantics', 'not directly linked — no canonical lead_id -> deal_id relationship exists; Lead Activity and Realized Deal Activity are reported side by side as separate, non-causal facts.'
    ),
    'summary', jsonb_build_object(
      'current', v_current_metrics,
      'previous', v_previous_metrics,
      'change', jsonb_build_object(
        'item_listing_days', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'item_listing_days')::numeric, (v_previous_metrics->>'item_listing_days')::numeric),
        'channel_listing_days', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'channel_listing_days')::numeric, (v_previous_metrics->>'channel_listing_days')::numeric),
        'avg_listed_items', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'avg_listed_items')::numeric, (v_previous_metrics->>'avg_listed_items')::numeric),
        'avg_channel_exposure', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'avg_channel_exposure')::numeric, (v_previous_metrics->>'avg_channel_exposure')::numeric),
        'leads_started', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'leads_started')::numeric, (v_previous_metrics->>'leads_started')::numeric),
        'item_attributed_leads', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'item_attributed_leads')::numeric, (v_previous_metrics->>'item_attributed_leads')::numeric),
        'channel_attributed_leads', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'channel_attributed_leads')::numeric, (v_previous_metrics->>'channel_attributed_leads')::numeric),
        'serious_plus_leads_from_cohort', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'serious_plus_leads_from_cohort')::numeric, (v_previous_metrics->>'serious_plus_leads_from_cohort')::numeric),
        'realized_deal_count', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'realized_deal_count')::numeric, (v_previous_metrics->>'realized_deal_count')::numeric),
        'realized_item_count', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'realized_item_count')::numeric, (v_previous_metrics->>'realized_item_count')::numeric),
        'leads_per_100_item_listing_days', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'leads_per_100_item_listing_days')::numeric, (v_previous_metrics->>'leads_per_100_item_listing_days')::numeric),
        'leads_per_100_channel_listing_days', public._listing_demand_numeric_change_v1_0((v_current_metrics->>'leads_per_100_channel_listing_days')::numeric, (v_previous_metrics->>'leads_per_100_channel_listing_days')::numeric)
      )
    ),
    'channels', v_channels,
    'items', v_items,
    'data_quality', v_data_quality,
    'limitations', v_limitations
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.build_listing_demand_evidence_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_listing_demand_evidence_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public.build_listing_demand_evidence_v1_0(int, date, date) IS
  'Listing Demand Evidence v1.0 — EXPOSURE -> LEADS -> REALIZED ACTIVITY, '
  'data/evidence foundation only (no recommendations, no AI, no scheduled '
  'jobs, no materialized aggregates). p_start_date/p_end_date are explicit '
  'inclusive dates (validated start <= end); the equal-length previous '
  'period is derived by pure date arithmetic, never "last month" logic. '
  'Completely Purpose-agnostic — every metric (summary/channels/items) '
  'covers ALL of the target user''s inventory regardless of Business/'
  'Hybrid/Personal/unmapped Purpose; there is no personal_summary and no '
  'Purpose-based exclusion anywhere. Built entirely from listing_exposure_'
  'days_v1_0 and canonical is_realized/deal_type facts already established '
  'by analytics_item_lifecycle_v2 and build_listing_evidence_v1_0 — no '
  'second lifecycle engine. Does not claim lead -> deal conversion (see '
  'analysis_context.deal_linkage_semantics and the limitations array). '
  'STABLE, SECURITY INVOKER, service_role EXECUTE only — the caller '
  'always passes its own resolved app_users.id as p_target_user_id, never '
  'a client-suppliable value. See src/lib/analytics/listingDemandEvidence.ts.';
