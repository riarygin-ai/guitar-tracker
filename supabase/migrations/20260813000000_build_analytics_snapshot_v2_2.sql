-- build_analytics_snapshot_v2_2
--
-- Hybrid reason-code correction. Adds a NEW, narrowly-scoped builder that
-- calls build_analytics_snapshot_v2_1 WHOLESALE and applies exactly one
-- deterministic correction: every occurrence of
-- HYBRID_RECENT_INSUFFICIENT_HISTORY inside
-- target_user_open_inventory_evidence.item_decision_evidence[*].reason_codes
-- is replaced with exactly one of HYBRID_RECENT_ITEM or
-- HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY, chosen from that SAME row's own
-- ownership_age_days field (already present on the row — nothing is
-- recomputed). Nothing else changes: no count, capital value, cohort,
-- other reason code, behavioral_signal, limitation, item ordering, or
-- privacy behavior is touched.
--
-- ── WHY THIS CORRECTION ───────────────────────────────────────────────────
-- v2.1's item_decision_evidence used HYBRID_RECENT_INSUFFICIENT_HISTORY
-- for two DIFFERENT situations conflated into one ambiguous code:
--   (a) a genuinely recent Hybrid item with a RELIABLE ownership age
--       under 30 days (the same condition hybrid_purpose_review's
--       RECENT_ITEM_SIGNAL already represents correctly);
--   (b) an item whose ownership age is UNAVAILABLE because its
--       acquisition date is historical or otherwise unreliable (the same
--       condition hybrid_purpose_review's INSUFFICIENT_HISTORY_SIGNAL
--       already represents correctly).
-- In production this produced historical items with DOM values of
-- 100-400+ days carrying a reason code containing the word "RECENT" —
-- backwards. v2.2 gives item_decision_evidence the same two-code
-- distinction hybrid_purpose_review already had, using NO new threshold:
-- HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY when ownership_age_days IS NULL;
-- HYBRID_RECENT_ITEM when ownership_age_days is reliable and < 30 (the
-- exact condition v2.1 already used for HYBRID_RECENT_INSUFFICIENT_
-- HISTORY's second half and for RECENT_ITEM_SIGNAL). These two conditions
-- are mutually exclusive (NULL vs. reliable-and-<30) and together are
-- exactly equivalent to v2.1's original combined condition — no item
-- gains or loses a flag, only the CODE NAME each already-flagged item
-- receives changes.
--
-- ── v2.1 IS NOT MODIFIED ─────────────────────────────────────────────────
-- _build_open_inventory_decision_support_snapshot_v2 and
-- build_analytics_snapshot_v2_1 are untouched by this migration.
-- Previously stored v2.1 snapshots (and any snapshot version before it)
-- remain historically interpretable exactly as generated. v2.2 reads
-- v2.1's OWN output and corrects it as a post-processing step — it does
-- not re-run or duplicate any of v2.1's query logic.
--
-- ── PRODUCTION PROMOTION ─────────────────────────────────────────────────
-- This migration only adds the SQL builder. runAnalytics.ts is updated in
-- the same change to call build_analytics_snapshot_v2_2 (see
-- src/lib/analytics/runAnalytics.ts) — see analytics/README.md and
-- analytics/SEMANTIC_CONTRACT.md for the full v2.2 contract and the
-- production-promotion notes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_analytics_snapshot_v2_2(
  p_target_user_id int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
DECLARE
  v_v21             jsonb;
  v_generated_at    timestamptz := now();
  v_corrected_items jsonb;
BEGIN
  -- build_analytics_snapshot_v2_1 -> v2_0 already validates
  -- p_target_user_id (NULL check + app_users existence check) and RAISEs
  -- on failure — not repeated here.
  v_v21 := public.build_analytics_snapshot_v2_1(p_target_user_id);

  SELECT COALESCE(jsonb_agg(corrected ORDER BY item_ord), '[]'::jsonb)
  INTO v_corrected_items
  FROM (
    SELECT
      item_ord,
      item || jsonb_build_object(
        'reason_codes',
        (
          SELECT COALESCE(jsonb_agg(
            CASE (code #>> '{}')
              WHEN 'HYBRID_RECENT_INSUFFICIENT_HISTORY' THEN
                to_jsonb(
                  CASE
                    WHEN (item -> 'ownership_age_days') = 'null'::jsonb THEN 'HYBRID_INSUFFICIENT_OWNERSHIP_HISTORY'
                    ELSE 'HYBRID_RECENT_ITEM'
                  END
                )
              ELSE code
            END
            ORDER BY code_ord
          ), '[]'::jsonb)
          FROM jsonb_array_elements(item -> 'reason_codes') WITH ORDINALITY AS rc(code, code_ord)
        )
      ) AS corrected
    FROM jsonb_array_elements(v_v21 -> 'target_user_open_inventory_evidence' -> 'item_decision_evidence') WITH ORDINALITY AS t(item, item_ord)
  ) sub;

  RETURN v_v21
    || jsonb_build_object(
         'snapshot_schema_version', '2.2',
         'analytics_definition_version', '2.2',
         'generated_at', to_jsonb(v_generated_at)
       )
    || jsonb_build_object(
         'target_user_open_inventory_evidence',
         (v_v21 -> 'target_user_open_inventory_evidence') || jsonb_build_object('item_decision_evidence', v_corrected_items)
       );
END;
$$;

REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_2(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_2(int) FROM anon;
REVOKE ALL ON FUNCTION public.build_analytics_snapshot_v2_2(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.build_analytics_snapshot_v2_2(int) TO service_role;

COMMENT ON FUNCTION public.build_analytics_snapshot_v2_2(int) IS
  'Hybrid reason-code correction — the current PRODUCTION analytics '
  'snapshot version (runAnalytics.ts calls this, not v1.8, as of this '
  'migration). SECURITY INVOKER, service_role execution only. Calls '
  'build_analytics_snapshot_v2_1 wholesale and replaces every occurrence '
  'of HYBRID_RECENT_INSUFFICIENT_HISTORY in target_user_open_inventory_'
  'evidence.item_decision_evidence[*].reason_codes with exactly one of '
  'HYBRID_RECENT_ITEM (reliable ownership_age_days < 30) or HYBRID_'
  'INSUFFICIENT_OWNERSHIP_HISTORY (ownership_age_days IS NULL) — no other '
  'value, count, cohort, reason code, behavioral_signal, limitation, or '
  'item ordering changes. v2.1 itself is untouched and remains '
  'historically interpretable. Persists nothing — see analytics_runs '
  '(20260727000000) for the persistence step. See analytics/README.md and '
  'analytics/SEMANTIC_CONTRACT.md for the full v2.2 contract.';
