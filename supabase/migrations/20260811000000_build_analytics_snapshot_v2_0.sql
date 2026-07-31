-- build_analytics_snapshot_v2_0
--
-- Analytics v2.0 Snapshot Foundation and Purpose Overview. Adds a NEW,
-- INDEPENDENT snapshot builder — the first Purpose-aware contract in this
-- analytics layer. Does NOT call, embed, or extend
-- build_analytics_snapshot_v1_8 (or any v1.x builder) in any way. v1.0-v1.8
-- and every previously stored analytics_runs.snapshot row remain entirely
-- unchanged and independently callable — this migration only ADDS new
-- objects. runAnalytics.ts is NOT updated in this step; production runs
-- continue to call v1.8 until the v2 evidence modules are sufficiently
-- complete.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._build_purpose_overview_snapshot_v2(int)  -- NEW
--   public.build_analytics_snapshot_v2_0(int)         -- NEW
--
-- ── WHY A CLEAN CONTRACT, NOT A v1.8 WRAPPER ─────────────────────────────
-- Every v1.x builder narrows to `purpose_name = 'Business'` (see
-- analytics/SEMANTIC_CONTRACT.md section 9 — EVIDENCE_SCOPE is NOT
-- redefined by this migration). Layering Purpose-aware evidence on top of
-- that Business-only population would misrepresent Business-only evidence
-- as Purpose-aware. v2.0 instead reads directly from
-- public.analytics_item_lifecycle_v2 (20260810000000), which is a strict
-- superset of every item regardless of Purpose/policy state, and builds an
-- entirely separate top-level snapshot shape (see PART 2).
--
-- ── PURPOSE CONTROLS INTERPRETATION, NEVER ELIGIBILITY ──────────────────
-- Every metric here (population counts, capital, profit, ROI, DOM, holding
-- time) is computed identically for Business/Hybrid/Personal/missing-
-- purpose/missing-policy items — Purpose is never an economic eligibility
-- filter in this module. `purpose_policy_status` and current_purpose_*
-- fields are exposed so a consumer CAN group or interpret differently by
-- Purpose, not because this module already does so beyond straightforward
-- breakdown rows.
--
-- ── CURRENT PURPOSE, NOT HISTORICAL PURPOSE ──────────────────────────────
-- analytics_item_lifecycle_v2.current_purpose_id/current_purpose_name
-- reflect an item's Purpose RIGHT NOW. Purpose is mutable and this schema
-- has no historical-Purpose record (see that view's own migration header)
-- — every count/sum/median below reflects each item's CURRENT Purpose,
-- not whatever Purpose it may have held at acquisition or during any past
-- period of its lifecycle. See module_limitations in PART 2.
--
-- ── PURPOSE_BREAKDOWN / PURPOSE_POSITION_BREAKDOWN GROUPING ──────────────
-- Grouped by (current_purpose_id, current_purpose_name,
-- purpose_policy_status, disposition_mode, realization_priority_order,
-- active_realization_flag, expected_holding_policy). For 'mapped' rows
-- this naturally yields one row per Purpose (Business/Hybrid/Personal —
-- their disposition_mode/priority/etc. differ, so they never collapse
-- into each other). For 'missing_purpose' and 'missing_policy' rows,
-- current_purpose_id/current_purpose_name are deliberately NULLed before
-- grouping (see `group_purpose_id`/`group_purpose_name` below) so every
-- item lacking a Purpose collapses into ONE missing_purpose row, and every
-- item whose Purpose lacks a policy row (regardless of which unmapped
-- Purpose name it is) collapses into ONE missing_policy row — explicit
-- coverage rows, never merged into a mapped Purpose, "unknown," or an
-- acquisition-method bucket.
--
-- ── PRIVACY ──────────────────────────────────────────────────────────────
-- shared_purpose_evidence pools aggregate statistics (counts/sums/medians)
-- across every user's items — no item_id, item name, model, notes, or
-- other item identity is ever exposed, and no row is grouped by user (no
-- per-user breakdown anywhere in shared_purpose_evidence). Another user's
-- items may affect a pooled count/sum/median but can never be isolated
-- from the snapshot output. target_user_purpose_evidence is filtered to
-- `user_id = p_target_user_id` and, like shared_purpose_evidence, exposes
-- only aggregates — no individual item row is produced anywhere in this
-- module (contrast with Open Inventory Decision Support's
-- item_decision_evidence, which this module does not touch or include).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._build_purpose_overview_snapshot_v2(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH all_items AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL THEN 'unknown'
      WHEN acquisition_value = 0    THEN 'zero_assigned'
      WHEN acquisition_value < 0    THEN 'negative_invalid'
      ELSE 'positive'
    END AS acquisition_value_status,
    -- Missing-purpose / missing-policy rows collapse to ONE row each
    -- (see migration header) — current_purpose_id/name are only kept for
    -- 'mapped' rows, where they're the real, distinct Business/Hybrid/
    -- Personal identity.
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_id   END AS group_purpose_id,
    CASE WHEN purpose_policy_status = 'mapped' THEN current_purpose_name END AS group_purpose_name
  FROM public.analytics_item_lifecycle_v2
),
target_items AS (
  SELECT * FROM all_items WHERE user_id = p_target_user_id
),

-- ── shared_purpose_evidence.population_summary ──────────────────────────
pop_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'mapped')                       AS mapped_purpose_item_count,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_purpose')              AS missing_purpose_item_count,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_policy')               AS missing_policy_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'positive')                  AS positive_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'zero_assigned')             AS zero_assigned_acquisition_item_count,
    COUNT(*) FILTER (WHERE acquisition_value_status = 'unknown')                   AS unknown_acquisition_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import AND acquisition_date IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_acquisition_date_item_count,
    COUNT(*) FILTER (WHERE is_historical_import OR acquisition_date IS NULL OR has_lifecycle_date_issue)               AS unreliable_acquisition_date_item_count
  FROM all_items
),

-- ── shared_purpose_evidence.purpose_breakdown ───────────────────────────
purpose_rows AS (
  SELECT
    group_purpose_id                                                               AS current_purpose_id,
    group_purpose_name                                                             AS current_purpose_name,
    purpose_policy_status,
    disposition_mode,
    realization_priority_order,
    active_realization_flag,
    expected_holding_policy,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE is_realized AND acquisition_value_status = 'positive')  AS realized_positive_acquisition_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)      AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_ownership_age_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND (is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue))             AS unreliable_ownership_age_open_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_open_ownership_age_days
  FROM all_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy
),

-- ── target_user_purpose_evidence.position_summary ───────────────────────
pos_row AS (
  SELECT
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'mapped')                       AS mapped_purpose_item_count,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_purpose')              AS missing_purpose_item_count,
    COUNT(*) FILTER (WHERE purpose_policy_status = 'missing_policy')               AS missing_policy_item_count
  FROM target_items
),

-- ── target_user_purpose_evidence.purpose_position_breakdown ─────────────
pos_purpose_rows AS (
  SELECT
    group_purpose_id                                                               AS current_purpose_id,
    group_purpose_name                                                             AS current_purpose_name,
    purpose_policy_status,
    disposition_mode,
    realization_priority_order,
    active_realization_flag,
    expected_holding_policy,
    COUNT(*)                                                                       AS total_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized)                                        AS open_item_count,
    COUNT(*) FILTER (WHERE is_realized)                                            AS realized_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed')          AS listed_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND current_status <> 'listed')         AS unlisted_open_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value IS NOT NULL)            AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND acquisition_value IS NOT NULL) AS open_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized AND acquisition_value IS NOT NULL)     AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                                     AS total_realized_net_profit,
    COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL) AS estimated_open_upside_available_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NULL)     AS estimated_open_upside_indeterminate_count,
    SUM(estimated_sold_value - acquisition_value - item_expenses_total)
      FILTER (WHERE NOT is_realized AND estimated_sold_value IS NOT NULL AND acquisition_value IS NOT NULL)         AS estimated_open_net_upside,
    COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue) AS reliable_ownership_age_open_item_count,
    COUNT(*) FILTER (WHERE NOT is_realized AND (is_historical_import OR holding_days IS NULL OR has_lifecycle_date_issue))             AS unreliable_ownership_age_open_item_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue)::numeric, 2) AS median_open_ownership_age_days,
    COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 60)  AS open_items_ownership_age_60_plus,
    COUNT(*) FILTER (WHERE NOT is_realized AND NOT is_historical_import AND holding_days IS NOT NULL AND NOT has_lifecycle_date_issue AND holding_days >= 120) AS open_items_ownership_age_120_plus
  FROM target_items
  GROUP BY group_purpose_id, group_purpose_name, purpose_policy_status, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy
)

SELECT jsonb_build_object(
  'shared_purpose_evidence', jsonb_build_object(
    'population_summary', (SELECT COALESCE(jsonb_agg(to_jsonb(pop_row)), '[]'::jsonb) FROM pop_row),
    'purpose_breakdown',  (SELECT COALESCE(jsonb_agg(to_jsonb(purpose_rows) ORDER BY
                              CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                              realization_priority_order NULLS LAST,
                              current_purpose_name NULLS LAST
                            ), '[]'::jsonb) FROM purpose_rows)
  ),
  'target_user_purpose_evidence', jsonb_build_object(
    'position_summary',           (SELECT COALESCE(jsonb_agg(to_jsonb(pos_row)), '[]'::jsonb) FROM pos_row),
    'purpose_position_breakdown', (SELECT COALESCE(jsonb_agg(to_jsonb(pos_purpose_rows) ORDER BY
                                      CASE purpose_policy_status WHEN 'mapped' THEN 0 WHEN 'missing_purpose' THEN 1 WHEN 'missing_policy' THEN 2 ELSE 3 END,
                                      realization_priority_order NULLS LAST,
                                      current_purpose_name NULLS LAST
                                    ), '[]'::jsonb) FROM pos_purpose_rows)
  )
);
$$;

REVOKE ALL ON FUNCTION public._build_purpose_overview_snapshot_v2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_purpose_overview_snapshot_v2(int) FROM anon;
REVOKE ALL ON FUNCTION public._build_purpose_overview_snapshot_v2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._build_purpose_overview_snapshot_v2(int) TO service_role;


-- ============================================================================
-- PART 2: public.build_analytics_snapshot_v2_0(p_target_user_id int)
-- A CLEAN, INDEPENDENT top-level contract — does NOT call
-- build_analytics_snapshot_v1_8 or merge any v1.x evidence_aggregates /
-- recommendation_candidates into its output. Validates p_target_user_id
-- itself (NULL check + app_users existence check — the same pattern
-- v1.2 introduced) since there is no earlier v2.x builder to inherit
-- validation from.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_0(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_target_count      int;
  v_generated_at      timestamptz := now();
  v_purpose_overview  jsonb;
BEGIN
  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'build_analytics_snapshot_v2_0: p_target_user_id must not be NULL';
  END IF;

  SELECT COUNT(*) INTO v_target_count
  FROM public.app_users
  WHERE id = p_target_user_id;

  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'build_analytics_snapshot_v2_0: expected exactly 1 app_users row for id % (target user), found %',
      p_target_user_id, v_target_count;
  END IF;

  v_purpose_overview := public._build_purpose_overview_snapshot_v2(p_target_user_id);

  RETURN jsonb_build_object(
    'snapshot_schema_version', '2.0',
    'analytics_definition_version', '2.0',
    'generated_at', to_jsonb(v_generated_at),
    'evidence_scope', 'shared_inventory_population',
    'purpose_semantics', 'current_item_purpose',
    'shared_purpose_evidence', v_purpose_overview -> 'shared_purpose_evidence',
    'target_user_purpose_evidence', v_purpose_overview -> 'target_user_purpose_evidence',
    'module_limitations', jsonb_build_array(
      'CURRENT_PURPOSE_IS_NOT_HISTORICAL_PURPOSE',
      'PURPOSE_CHANGES_ARE_NOT_HISTORICALLY_TRACKED',
      'LISTING_ACTIVE_STATE_INFERRED_NO_IS_ACTIVE_FIELD'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_0(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_0(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_0(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_0(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_0(int) IS
  'Analytics v2.0 Snapshot Foundation and Purpose Overview — the first '
  'Purpose-aware snapshot contract. SECURITY INVOKER, service_role '
  'execution only. Does NOT call build_analytics_snapshot_v1_8 or include '
  'any v1.x evidence_aggregates/recommendation_candidates/Open Inventory '
  'Decision Support — a clean, independent shape. Reads '
  'analytics_item_lifecycle_v2 (all Purposes, including missing-purpose '
  'and missing-policy items) rather than filtering to purpose_name = '
  '''Business''. Purpose is the item''s CURRENT Purpose only — see '
  'module_limitations. v1.0-v1.8 are completely unaffected and remain the '
  'production runner''s contract (runAnalytics.ts is not updated by this '
  'migration). Persists nothing — see analytics_runs (20260727000000) for '
  'the persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v2.0 contract.';
