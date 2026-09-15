-- Listing Demand Evidence — make weekly_trend's window length configurable
-- (4 / 8 / 12 weeks, default 4).
--
-- 20260914000000_build_listing_demand_evidence_v1_0.sql,
-- 20260915000000_fix_listing_demand_channel_last_lead_date.sql, and
-- 20260916000000_listing_demand_weekly_trend.sql (all already applied to
-- production) are NOT edited here. This is a new, additive migration.
--
-- ── BACKWARD COMPATIBILITY / OVERLOAD-SAFETY DESIGN ────────────────────────
-- The app calls build_listing_demand_evidence_v1_0 via PostgREST RPC with
-- exactly 3 NAMED parameters (p_target_user_id, p_start_date, p_end_date —
-- see src/lib/analytics/listingDemandEvidence.ts). PostgREST/PostgreSQL
-- function-overload resolution can raise "function ... is not unique" when
-- two same-named functions exist and one of them merely adds a trailing
-- DEFAULTed parameter — calling with the original 3 argument names becomes
-- genuinely ambiguous between "the exact 3-arg function" and "the 4-arg
-- function using its default". To avoid that risk entirely, this migration
-- does NOT add a 4th parameter to build_listing_demand_evidence_v1_0 itself.
-- Instead:
--   - build_listing_demand_evidence_v1_1(p_target_user_id, p_start_date,
--     p_end_date, p_trend_weeks DEFAULT 4) is a NEW, distinctly-named
--     function — no overload of any existing name is created, so there is
--     zero PostgREST ambiguity for either RPC name.
--   - build_listing_demand_evidence_v1_0(p_target_user_id, p_start_date,
--     p_end_date) keeps its EXACT existing 3-argument signature (CREATE OR
--     REPLACE only changes its language/body, which is always legal — arg
--     types and return type are unchanged) and becomes a one-line
--     compatibility wrapper that calls v1_1 with p_trend_weeks := 4. Any
--     existing caller still using the v1_0 RPC name keeps getting exactly
--     the same 4-week weekly_trend behavior as before, byte-for-byte.
--   - The app/API (src/lib/analytics/listingDemandEvidence.ts) is updated
--     to call build_listing_demand_evidence_v1_1 going forward, always
--     passing an explicit p_trend_weeks (never relying on the SQL default,
--     even though one exists for safety/direct-RPC-testing convenience).
--
-- ── SQL-LEVEL GUARD (never relies on API validation alone) ────────────────
-- build_listing_demand_evidence_v1_1 RAISEs an EXCEPTION when p_trend_weeks
-- NOT IN (4, 8, 12) — the same defense-in-depth precedent already used for
-- p_start_date > p_end_date. _listing_demand_weekly_trend_v1_0 itself
-- trusts its caller (matching this schema's own established convention:
-- internal `_`-prefixed helpers are validated once, by their sole caller,
-- not redundantly re-validated at every layer).
--
-- ── NO DUPLICATED FORMULAS ─────────────────────────────────────────────────
-- _listing_demand_weekly_trend_v1_0 gains one new parameter (p_trend_weeks)
-- and its `generate_series(3, 0, -1)` becomes `generate_series(p_trend_
-- weeks - 1, 0, -1)` — the only change. It still extracts every week's
-- numbers from ordinary calls to the existing, untouched _listing_demand_
-- period_metrics_v1_0 / _listing_demand_channel_metrics_v1_0 (the latter
-- already period-scoping-correct since 20260915000000). This is a
-- RETURNS-shape-preserving, arity-changing edit, so the old 2-argument
-- version is explicitly DROPped first (CREATE OR REPLACE cannot change an
-- existing function's argument list) before being recreated with the new
-- signature — safe because nothing outside build_listing_demand_evidence_
-- v1_1 ever calls this internal helper directly.
--
-- ── EXACT WEEKLY WINDOW ARITHMETIC (unchanged formula, now parametric) ────
-- For weeks_ago IN (p_trend_weeks - 1, ..., 1, 0):
--   week_end   = p_end_date - (weeks_ago * 7)
--   week_start = week_end - 6
-- weeks_ago = 0 is the most recent week, ending exactly on p_end_date.
-- Rows are ordered oldest -> newest. Independent of p_start_date. For
-- p_end_date = 2026-09-14: 4 weeks ends with 2026-08-18..2026-09-14 (the
-- original fixed behavior, unchanged); 8 weeks prepends 4 earlier weekly
-- buckets; 12 weeks prepends 4 more before that — always exactly N
-- consecutive, non-overlapping, gap-free 7-day buckets.
--
-- ── JSON CONTRACT ──────────────────────────────────────────────────────────
-- One new top-level field: trend_window_weeks (the resolved 4/8/12 value).
-- weekly_trend[] row shape is completely unchanged from 20260916000000 —
-- same compact per-week/per-channel field list, still no item-level
-- evidence, no message-count totals, no category/brand/coverage analysis,
-- no lead-conversion field. schema_version stays '1.0' — purely additive.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. _listing_demand_weekly_trend_v1_0 — now accepts p_trend_weeks
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public._listing_demand_weekly_trend_v1_0(int, date);

CREATE FUNCTION public._listing_demand_weekly_trend_v1_0(
  p_target_user_id int,
  p_end_date       date,
  p_trend_weeks    int
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
    FROM generate_series(p_trend_weeks - 1, 0, -1) AS weeks_ago
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
    ) ORDER BY wm.weeks_ago DESC  -- oldest -> newest
  ), '[]'::jsonb)
  FROM week_metrics wm
  LEFT JOIN week_channels wc ON wc.week_start = wm.week_start AND wc.week_end = wm.week_end;
$$;

REVOKE ALL ON FUNCTION public._listing_demand_weekly_trend_v1_0(int, date, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._listing_demand_weekly_trend_v1_0(int, date, int) TO service_role;

COMMENT ON FUNCTION public._listing_demand_weekly_trend_v1_0(int, date, int) IS
  'Internal to Listing Demand Evidence. Exactly p_trend_weeks consecutive, '
  'non-overlapping 7-day periods ending on p_end_date, ordered oldest -> '
  'newest, independent of any p_start_date. p_trend_weeks is trusted '
  '(validated by the sole caller, build_listing_demand_evidence_v1_1, '
  'which enforces IN (4, 8, 12)). Each week''s summary metrics come from a '
  'normal call to _listing_demand_period_metrics_v1_0 and each week''s '
  'channel breakdown from a normal call to _listing_demand_channel_'
  'metrics_v1_0 (both already period-scoped and Purpose-agnostic) — no '
  'reimplemented formulas, no second exposure/attribution/realized-deal '
  'engine. Deliberately compact: a fixed field list per week/channel, no '
  'item-level evidence, no message-count totals, no category/brand/'
  'coverage analysis, no lead-conversion field. service_role EXECUTE only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. build_listing_demand_evidence_v1_1 — the configurable-trend builder
-- ═══════════════════════════════════════════════════════════════════════
-- Byte-identical to 20260916000000's build_listing_demand_evidence_v1_0
-- except: the new p_trend_weeks parameter (DEFAULT 4), one new validation
-- IF block, the weekly_trend call now passes p_trend_weeks through, and
-- one new `trend_window_weeks` key in the final jsonb_build_object.

CREATE OR REPLACE FUNCTION public.build_listing_demand_evidence_v1_1(
  p_target_user_id int,
  p_start_date     date,
  p_end_date       date,
  p_trend_weeks    int DEFAULT 4
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
  -- SQL-level guard (section 2 of the task) — never relies on API
  -- validation alone. Mirrors the existing date-range guard above.
  IF p_trend_weeks IS NULL OR p_trend_weeks NOT IN (4, 8, 12) THEN
    RAISE EXCEPTION 'p_trend_weeks must be one of 4, 8, 12 (got %)', p_trend_weeks;
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

  -- ── Weekly trend: a CONFIGURABLE (4/8/12-week) context window ending on
  -- p_end_date — deliberately independent of p_start_date/period length,
  -- so requests sharing the same end date and trend_weeks all produce the
  -- exact same trend regardless of the selected summary period. ──────────
  v_weekly_trend := public._listing_demand_weekly_trend_v1_0(p_target_user_id, p_end_date, p_trend_weeks);

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
    'weekly_trend is a fixed-length (trend_window_weeks) window of consecutive weeks ending on the requested end_date, independent of the requested start_date/period length — it is additional context alongside summary.current/summary.previous, not a replacement for either.'
  ]);

  v_result := jsonb_build_object(
    'schema_version', '1.0',
    'generated_at', now(),
    'target_user_id', p_target_user_id,
    'trend_window_weeks', p_trend_weeks,
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

REVOKE ALL ON FUNCTION public.build_listing_demand_evidence_v1_1(int, date, date, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_listing_demand_evidence_v1_1(int, date, date, int) TO service_role;

COMMENT ON FUNCTION public.build_listing_demand_evidence_v1_1(int, date, date, int) IS
  'Listing Demand Evidence — EXPOSURE -> LEADS -> REALIZED ACTIVITY, '
  'data/evidence foundation only. Identical contract to build_listing_'
  'demand_evidence_v1_0 (schema_version stays ''1.0'' — purely additive) '
  'plus a configurable weekly_trend window: p_trend_weeks (DEFAULT 4) '
  'must be one of 4/8/12, enforced here (never left to API validation '
  'alone), and echoed back as the new top-level trend_window_weeks field. '
  'p_start_date/p_end_date continue to control ONLY period/comparison_'
  'period/summary/channels/items — trend_weeks affects ONLY weekly_trend; '
  'these are independent. Completely Purpose-agnostic; does not claim '
  'lead -> deal conversion. STABLE, SECURITY INVOKER, service_role '
  'EXECUTE only — the caller always passes its own resolved app_users.id '
  'as p_target_user_id, never a client-suppliable value. See src/lib/'
  'analytics/listingDemandEvidence.ts.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. build_listing_demand_evidence_v1_0 — unchanged 3-arg signature,
--    now a compatibility wrapper (fixed at 4 weeks, byte-identical output
--    to before this migration).
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.build_listing_demand_evidence_v1_0(
  p_target_user_id int,
  p_start_date     date,
  p_end_date       date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT public.build_listing_demand_evidence_v1_1(p_target_user_id, p_start_date, p_end_date, 4);
$$;

REVOKE ALL ON FUNCTION public.build_listing_demand_evidence_v1_0(int, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_listing_demand_evidence_v1_0(int, date, date) TO service_role;

COMMENT ON FUNCTION public.build_listing_demand_evidence_v1_0(int, date, date) IS
  'Listing Demand Evidence v1.0 — COMPATIBILITY WRAPPER (20260917000000). '
  'Its 3-argument signature is deliberately UNCHANGED so no PostgREST/'
  'PostgreSQL overload ambiguity is ever introduced for this RPC name; '
  'the body now simply delegates to build_listing_demand_evidence_v1_1 '
  'with p_trend_weeks := 4, so any existing caller of this exact name '
  'keeps receiving byte-identical behavior (a fixed 4-week weekly_trend) '
  'to every version before this migration. New/updated callers should '
  'call build_listing_demand_evidence_v1_1 directly to select 4/8/12 '
  'weeks. service_role EXECUTE only.';
