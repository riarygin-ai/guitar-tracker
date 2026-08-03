-- build_analytics_snapshot_v2_12
--
-- Analytics v2.12 — Hybrid Comparable-DOM Signals. A narrow, additive
-- follow-up to v2.1 (Open Inventory Decision Support) / v2.2 (Hybrid
-- reason-code correction): adds two genuine Hybrid-specific reason codes
-- to target_user_open_inventory_evidence.item_decision_evidence[*].
-- reason_codes, mirroring the EXISTING Business comparable-DOM logic
-- exactly. Does NOT implement HYBRID_PURPOSE_REVIEW_PRIORITY (a Findings
-- Selector rule) — that remains blocked on this evidence and will be
-- attempted again in a separate task now that the gap is closed.
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────
-- v2.1's item_decision_evidence reason_codes ARRAY(...) computes
-- BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN / BUSINESS_DOM_ABOVE_COMPARABLE_P75
-- for Business rows (disposition_bucket = 'business') but has NO
-- equivalent branch for Hybrid rows at all — confirmed by direct
-- inspection of 20260812000000_build_analytics_snapshot_v2_1.sql's own
-- header comment: "Hybrid has no DOM-vs-cohort-median/p75 reason code at
-- all, per the task's explicit scope." This was surfaced as a blocking
-- evidence gap while attempting Insights Engine v1.8 (HYBRID_PURPOSE_
-- REVIEW_PRIORITY), which requires exactly this signal for 4 of its 8
-- priority profiles. This migration closes that gap at the Analytics
-- layer only — no Insights rule is added here.
--
-- ── THE DATA WAS ALREADY THERE ───────────────────────────────────────────
-- v2.1's liquidity-cohort selection (the `liq` LATERAL join inside
-- target_with_cohorts) is ALREADY purpose-aware and disposition-agnostic
-- — it runs identically for every open item regardless of disposition_
-- bucket, preferring a same-Purpose cohort (4 specificity levels keyed by
-- tb.current_purpose_id, i.e. whatever Purpose the item actually has —
-- Business, Hybrid, or Personal) before falling back to 4 cross-purpose
-- levels, using the SAME realized_item_count >= 5 / >= 3 / >= 1 sample-
-- size preference for every item. liquidity_cohort.median_days_on_market
-- and .p75_days_on_market are therefore ALREADY present and correctly
-- computed on every Hybrid item_decision_evidence row today (confirmed
-- against live local evidence) — v2.1 simply never wrote a reason code
-- that reads them for Hybrid. This migration adds no new cohort logic,
-- no new joins, and no new base-table access whatsoever: it is a pure
-- JSON post-processing step over v2.11's own already-computed output,
-- reading only fields the row already carries (current_purpose_name,
-- purpose_policy_status, listed_flag, current_dom_days, liquidity_
-- cohort.median_days_on_market, liquidity_cohort.p75_days_on_market).
--
-- ── EXACT BUSINESS LOGIC MIRRORED (v2.1, lines ~704-708 — unchanged by
-- v2.2 through v2.11; grep confirms no migration after v2.2 touches
-- disposition_bucket, liq_median_days_on_market, or item_decision_
-- evidence) ────────────────────────────────────────────────────────────
--   BUSINESS_DOM_ABOVE_COMPARABLE_MEDIAN: disposition_bucket = 'business'
--     AND listed_flag AND current_dom_days >= 30 AND liq_median_days_on_
--     market IS NOT NULL AND current_dom_days > liq_median_days_on_market
--   BUSINESS_DOM_ABOVE_COMPARABLE_P75: identical shape, p75 in place of
--     median.
-- This migration reproduces both conditions verbatim for Hybrid rows,
-- with disposition_bucket = 'hybrid' reconstructed from the two exposed
-- fields it is itself derived from (current_purpose_name = 'Hybrid' AND
-- purpose_policy_status = 'mapped' — see target_base's own disposition_
-- bucket CASE expression) since disposition_bucket itself is never
-- exposed in the JSON. No new threshold, no >= vs > ambiguity resolved
-- differently, no confidence-value gate added (Business itself gates
-- only on the median/p75 value being non-null — cohort sample-size
-- preference already happened upstream, during cohort SELECTION, not as
-- a second gate here — so neither does this). Historical Imports are
-- never excluded (Business's own condition never checks is_historical_
-- import either) — acquisition date / ownership age are never read by
-- either signal, matching Business exactly.
--
-- ── REASON-CODE ORDERING ─────────────────────────────────────────────────
-- The two new codes are APPENDED to each qualifying Hybrid item's existing
-- reason_codes array, in the order HYBRID_DOM_ABOVE_COMPARABLE_MEDIAN then
-- HYBRID_DOM_ABOVE_COMPARABLE_P75 (matching Business's own median-before-
-- p75 relative order) — every pre-existing code keeps its exact prior
-- relative order; nothing is reordered, removed, or renamed.
--
-- ── SCOPE ─────────────────────────────────────────────────────────────
-- Only rows where current_purpose_name = 'Hybrid' AND purpose_policy_
-- status = 'mapped' are ever touched. Business, Personal, and
-- unclassified/unmapped rows are returned byte-identical to v2.11 — this
-- migration touches no other field, no other section, no shared-scope
-- data (Open Inventory Decision Support has no shared/pooled counterpart
-- at all, target-user-only, unchanged), and no cohort or numeric field.
--
-- ── STRUCTURE ────────────────────────────────────────────────────────────
--   public._enrich_hybrid_comparable_dom_signals_v2_12(jsonb)  -- NEW
--   public.build_analytics_snapshot_v2_12(int)                 -- NEW
--
-- See analytics/sql/27_hybrid_comparable_dom_signals_v2_12.sql for a
-- standalone, illustrative copy of the enrichment logic.
-- ============================================================================

-- ── PART 1: focused helper — pure JSON transform, no table access ────────
-- Takes item_decision_evidence[] as-is and returns it with the two new
-- codes appended to qualifying Hybrid rows only. Every other row (and
-- every other field on a qualifying row) passes through unchanged. Takes
-- jsonb directly (not p_target_user_id) since everything needed is
-- already present in the array itself — no DB query of any kind.

CREATE OR REPLACE FUNCTION public._enrich_hybrid_comparable_dom_signals_v2_12(
  p_item_decision_evidence jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN (item ->> 'current_purpose_name') = 'Hybrid'
        AND (item ->> 'purpose_policy_status') = 'mapped'
        AND (item ->> 'listed_flag')::boolean IS TRUE
        AND (item ->> 'current_dom_days') IS NOT NULL
        AND (item ->> 'current_dom_days')::numeric >= 30
      THEN
        item || jsonb_build_object(
          'reason_codes',
          (item -> 'reason_codes')
            || CASE
                 WHEN (item -> 'liquidity_cohort' ->> 'median_days_on_market') IS NOT NULL
                   AND (item ->> 'current_dom_days')::numeric > (item -> 'liquidity_cohort' ->> 'median_days_on_market')::numeric
                 THEN jsonb_build_array('HYBRID_DOM_ABOVE_COMPARABLE_MEDIAN')
                 ELSE '[]'::jsonb
               END
            || CASE
                 WHEN (item -> 'liquidity_cohort' ->> 'p75_days_on_market') IS NOT NULL
                   AND (item ->> 'current_dom_days')::numeric > (item -> 'liquidity_cohort' ->> 'p75_days_on_market')::numeric
                 THEN jsonb_build_array('HYBRID_DOM_ABOVE_COMPARABLE_P75')
                 ELSE '[]'::jsonb
               END
        )
      ELSE item
    END
    ORDER BY item_ord
  ), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_item_decision_evidence, '[]'::jsonb)) WITH ORDINALITY AS t(item, item_ord)
$$;

REVOKE ALL ON FUNCTION public._enrich_hybrid_comparable_dom_signals_v2_12(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._enrich_hybrid_comparable_dom_signals_v2_12(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public._enrich_hybrid_comparable_dom_signals_v2_12(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public._enrich_hybrid_comparable_dom_signals_v2_12(jsonb) TO service_role;

-- ── PART 2: builder — wraps v2.11 wholesale, enriches only
-- target_user_open_inventory_evidence.item_decision_evidence ────────────

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_12(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
WITH v211 AS MATERIALIZED (
  SELECT public.build_analytics_snapshot_v2_11(p_target_user_id) AS snapshot
),
enriched AS MATERIALIZED (
  SELECT public._enrich_hybrid_comparable_dom_signals_v2_12(
    (SELECT snapshot -> 'target_user_open_inventory_evidence' -> 'item_decision_evidence' FROM v211)
  ) AS item_decision_evidence
)
SELECT
  v211.snapshot
  || jsonb_build_object(
       'snapshot_schema_version', '2.12',
       'analytics_definition_version', '2.12',
       'generated_at', to_jsonb(now())
     )
  || jsonb_build_object(
       'target_user_open_inventory_evidence',
       (v211.snapshot -> 'target_user_open_inventory_evidence')
         || jsonb_build_object('item_decision_evidence', (SELECT item_decision_evidence FROM enriched))
     )
FROM v211;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_12(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_12(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_12(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_12(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_12(int) IS
  'Hybrid Comparable-DOM Signals — adds HYBRID_DOM_ABOVE_COMPARABLE_MEDIAN '
  '/ HYBRID_DOM_ABOVE_COMPARABLE_P75 to item_decision_evidence for mapped '
  'Hybrid rows only, mirroring the existing Business comparable-DOM logic '
  'exactly (see this migration''s own header). SECURITY INVOKER, '
  'service_role execution only. Wraps build_analytics_snapshot_v2_11 '
  'wholesale — v2.11 and every version before it remain independently '
  'callable and unchanged. Does NOT implement HYBRID_PURPOSE_REVIEW_'
  'PRIORITY. See analytics/README.md and analytics/SEMANTIC_CONTRACT.md '
  'for the full v2.12 contract.';
