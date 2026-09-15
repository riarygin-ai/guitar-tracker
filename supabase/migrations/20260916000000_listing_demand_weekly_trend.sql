-- Listing Demand Evidence v1.0 — add weekly_trend (additive extension).
--
-- 20260914000000_build_listing_demand_evidence_v1_0.sql (already applied
-- to production) and 20260915000000_fix_listing_demand_channel_last_lead_
-- date.sql are NOT edited here. This is a new, additive migration that
-- CREATE OR REPLACEs only the two functions that actually need to change:
--   - _listing_demand_weekly_trend_v1_0  (new)
--   - build_listing_demand_evidence_v1_0 (existing — gains one new
--     `weekly_trend` key; every other line of its body is unchanged)
-- Neither function's public surface (build_listing_demand_evidence_v1_0's
-- signature/return type) changes, so no DROP is required.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────
-- The selected-period summary (summary.current/summary.previous) answers
-- "how did this period compare to the one right before it", but says
-- nothing about the shape of the last several weeks. weekly_trend adds a
-- FIXED 4-week context window — 4 consecutive, non-overlapping 7-day
-- periods ending exactly on the caller's own p_end_date, independent of
-- whatever p_start_date/period length was requested for the main summary
-- — so a 7-, 30-, or 90-day summary request all produce the exact same
-- 4-week trend when they share the same end date. This is deliberately
-- compact (a fixed, small field list per week and per channel — see the
-- explicit lists below) so it stays cheap enough to eventually pass into
-- /listings or Business Coach context without shipping a huge payload;
-- neither of those consumers exists yet — this migration is data/evidence
-- only, exactly like 20260914000000 itself.
--
-- ── EXACT WEEKLY WINDOW ARITHMETIC ──────────────────────────────────────
-- For weeks_ago IN (3, 2, 1, 0):
--   week_end   = p_end_date - (weeks_ago * 7)
--   week_start = week_end - 6
-- weeks_ago = 0 is the most recent (newest) week, ending exactly on
-- p_end_date; weeks_ago = 3 is the oldest. Rows are returned ordered
-- oldest -> newest (weeks_ago DESCENDING). Example, p_end_date =
-- 2026-09-14: 2026-08-18..2026-08-24, 2026-08-25..2026-08-31,
-- 2026-09-01..2026-09-07, 2026-09-08..2026-09-14 — matching the task's
-- own worked example exactly. No dependency on p_start_date whatsoever.
--
-- ── NO REIMPLEMENTED FORMULAS ────────────────────────────────────────────
-- Each week's summary metrics are extracted directly from a normal call
-- to _listing_demand_period_metrics_v1_0(p_target_user_id, week_start,
-- week_end) — the exact same function summary.current/summary.previous
-- already use. Each week's channel breakdown is extracted directly from
-- a normal call to _listing_demand_channel_metrics_v1_0(p_target_user_id,
-- week_start, week_end) — the exact same (already period-scoping-fixed,
-- 20260915000000) function channels[] already uses, including its
-- correctly period-bounded last_lead_date. Neither function's SQL body is
-- touched by this migration; weekly_trend is a pure, compact RESHAPE of
-- their existing output for four extra date ranges — no second set of
-- exposure/attribution/realized-deal formulas exists anywhere.
--
-- ── COMPACTNESS (explicit field lists, not "everything the helper has") ──
-- Per week: start_date, end_date, days, item_listing_days, channel_
-- listing_days, avg_listed_items, avg_channel_exposure, exposure_
-- multiplier, leads_started, item_attributed_leads, channel_attributed_
-- leads, serious_plus_leads_from_cohort, high_intent_leads_from_cohort,
-- realized_deal_count, realized_item_count, leads_per_100_item_listing_
-- days, leads_per_100_channel_listing_days, channels. Deliberately
-- EXCLUDED from the weekly row (present on the full-period summary but
-- not needed for a compact trend): distinct_listed_item_count, leads_
-- with/without_normalized_channel, completed_leads_from_cohort, cash/
-- trade/mixed_offer_leads_from_cohort, buyer_messages_from_cohort, our_
-- messages_from_cohort. Per channel: deal_channel_id, channel_name,
-- channel_listing_days, distinct_listed_items, channel_attributed_leads,
-- serious_plus_attributed_leads_from_cohort, high_intent_attributed_
-- leads_from_cohort, realized_deal_count_by_recorded_channel, leads_per_
-- 100_channel_listing_days, last_lead_date. Deliberately EXCLUDED:
-- completed_leads_from_cohort, buyer_messages_from_attributed_lead_
-- cohort, our_messages_from_attributed_lead_cohort — no item-level
-- evidence, no category/brand/coverage analysis, no lead-conversion
-- field of any kind.
--
-- ── RECONCILIATION NOTE (documented, not hidden) ──────────────────────────
-- sum(week.channels[].channel_attributed_leads) reconciles exactly to
-- week.channel_attributed_leads because deal_channel_id on item_leads is
-- a single nullable FK — one attributed lead can only ever match one
-- channel's exposure on its own first_contact_at, so it is counted in at
-- most one channel row. There is no scenario in the current schema where
-- a single lead is attributed to more than one channel in the same week.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. _listing_demand_weekly_trend_v1_0 — 4 fixed weeks ending p_end_date
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._listing_demand_weekly_trend_v1_0(
  p_target_user_id int,
  p_end_date       date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH week_bounds AS (
    SELECT
      weeks_ago,
      (p_end_date - (weeks_ago * 7))     AS week_end,
      (p_end_date - (weeks_ago * 7) - 6) AS week_start
    FROM generate_series(3, 0, -1) AS weeks_ago
  ),
  week_metrics AS (
    SELECT
      wb.weeks_ago, wb.week_start, wb.week_end,
      public._listing_demand_period_metrics_v1_0(p_target_user_id, wb.week_start, wb.week_end) AS metrics
    FROM week_bounds wb
  ),
  week_channels AS (
    SELECT
      wb.week_start, wb.week_end,
      COALESCE(jsonb_agg(
        jsonb_build_object(
          'deal_channel_id', cm.deal_channel_id,
          'channel_name', cm.channel_name,
          'channel_listing_days', cm.channel_listing_days,
          'distinct_listed_items', cm.distinct_listed_items,
          'channel_attributed_leads', cm.channel_attributed_leads,
          'serious_plus_attributed_leads_from_cohort', cm.serious_plus_attributed_leads_from_cohort,
          'high_intent_attributed_leads_from_cohort', cm.high_intent_attributed_leads_from_cohort,
          'realized_deal_count_by_recorded_channel', cm.realized_deal_count_by_recorded_channel,
          'leads_per_100_channel_listing_days', cm.leads_per_100_channel_listing_days,
          'last_lead_date', cm.last_lead_date
        ) ORDER BY cm.sort_order
      ), '[]'::jsonb) AS channels_json
    FROM week_bounds wb
    -- Dynamic canonical channels — _listing_demand_channel_metrics_v1_0
    -- itself reads every is_listing_platform deal_channels row; never
    -- hardcoded here.
    CROSS JOIN LATERAL public._listing_demand_channel_metrics_v1_0(p_target_user_id, wb.week_start, wb.week_end) cm
    GROUP BY wb.week_start, wb.week_end
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'start_date', wm.week_start,
      'end_date', wm.week_end,
      'days', 7,
      'item_listing_days', wm.metrics->'item_listing_days',
      'channel_listing_days', wm.metrics->'channel_listing_days',
      'avg_listed_items', wm.metrics->'avg_listed_items',
      'avg_channel_exposure', wm.metrics->'avg_channel_exposure',
      'exposure_multiplier', wm.metrics->'exposure_multiplier',
      'leads_started', wm.metrics->'leads_started',
      'item_attributed_leads', wm.metrics->'item_attributed_leads',
      'channel_attributed_leads', wm.metrics->'channel_attributed_leads',
      'serious_plus_leads_from_cohort', wm.metrics->'serious_plus_leads_from_cohort',
      'high_intent_leads_from_cohort', wm.metrics->'high_intent_leads_from_cohort',
      'realized_deal_count', wm.metrics->'realized_deal_count',
      'realized_item_count', wm.metrics->'realized_item_count',
      'leads_per_100_item_listing_days', wm.metrics->'leads_per_100_item_listing_days',
      'leads_per_100_channel_listing_days', wm.metrics->'leads_per_100_channel_listing_days',
      'channels', COALESCE(wc.channels_json, '[]'::jsonb)
    ) ORDER BY wm.weeks_ago DESC  -- oldest (3) -> newest (0)
  ), '[]'::jsonb)
  FROM week_metrics wm
  LEFT JOIN week_channels wc ON wc.week_start = wm.week_start AND wc.week_end = wm.week_end;
$$;

REVOKE ALL ON FUNCTION public._listing_demand_weekly_trend_v1_0(int, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._listing_demand_weekly_trend_v1_0(int, date) TO service_role;

COMMENT ON FUNCTION public._listing_demand_weekly_trend_v1_0(int, date) IS
  'Internal to Listing Demand Evidence v1.0. Exactly 4 consecutive, '
  'non-overlapping 7-day periods ending on p_end_date, ordered oldest -> '
  'newest, independent of any p_start_date. Each week''s summary metrics '
  'come from a normal call to _listing_demand_period_metrics_v1_0 and '
  'each week''s channel breakdown from a normal call to '
  '_listing_demand_channel_metrics_v1_0 (both already period-scoped and '
  'Purpose-agnostic) — no reimplemented formulas, no second exposure/'
  'attribution/realized-deal engine. Deliberately compact: a fixed field '
  'list per week/channel, no item-level evidence, no message-count '
  'totals, no category/brand/coverage analysis, no lead-conversion field. '
  'service_role EXECUTE only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. build_listing_demand_evidence_v1_0 — add weekly_trend to the output
-- ═══════════════════════════════════════════════════════════════════════
-- Every line below is byte-identical to 20260914000000's definition
-- except: one new DECLARE (v_weekly_trend), one new assignment (calling
-- the function above with p_end_date), and one new key in the final
-- jsonb_build_object. schema_version stays '1.0' — this is a purely
-- additive JSON field, not a breaking or renamed contract change.

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
  v_weekly_trend                jsonb;
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

  -- ── Weekly trend: a FIXED 4-week context window ending on p_end_date —
  -- deliberately independent of p_start_date/period length, so a 7-, 30-,
  -- or 90-day request sharing the same end date all produce the exact
  -- same trend. ───────────────────────────────────────────────────────────
  v_weekly_trend := public._listing_demand_weekly_trend_v1_0(p_target_user_id, p_end_date);

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
    'item_listing_days/channel_listing_days are PERIOD exposure metrics, not a snapshot of current listing state — see Listing Evidence v1.0 (build_listing_evidence_v1_0) for that.',
    'weekly_trend is a fixed 4-week window ending on the requested end_date, independent of the requested start_date/period length — it is additional context alongside summary.current/summary.previous, not a replacement for either.'
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
    'weekly_trend', v_weekly_trend,
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
  'Completely Purpose-agnostic — every metric (summary/channels/items/'
  'weekly_trend) covers ALL of the target user''s inventory regardless of '
  'Business/Hybrid/Personal/unmapped Purpose; there is no personal_'
  'summary and no Purpose-based exclusion anywhere. weekly_trend '
  '(20260916000000) is a fixed 4-consecutive-week window ending on '
  'p_end_date, independent of p_start_date, built by reshaping normal '
  '_listing_demand_period_metrics_v1_0/_listing_demand_channel_metrics_'
  'v1_0 calls — no reimplemented formulas. Built entirely from listing_'
  'exposure_days_v1_0 and canonical is_realized/deal_type facts already '
  'established by analytics_item_lifecycle_v2 and build_listing_evidence_'
  'v1_0 — no second lifecycle engine. Does not claim lead -> deal '
  'conversion (see analysis_context.deal_linkage_semantics and the '
  'limitations array). STABLE, SECURITY INVOKER, service_role EXECUTE '
  'only — the caller always passes its own resolved app_users.id as '
  'p_target_user_id, never a client-suppliable value. See src/lib/'
  'analytics/listingDemandEvidence.ts.';
