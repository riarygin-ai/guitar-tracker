-- analytics_item_lifecycle_v2
--
-- Purpose-Aware Analytics Foundation, part 2 of 2. A thin, additive view
-- that joins analytics_purpose_policy (20260809000000) onto
-- analytics_item_lifecycle — the foundation future Purpose-aware analytics
-- modules (v2.0+) will read from. This migration does NOT modify
-- analytics_item_lifecycle itself, and is not yet consumed by any snapshot
-- builder, runAnalytics.ts, recommendation_candidates, Open Inventory
-- Decision Support, Calendar analytics, or any UI — v1.0-v1.8 continue to
-- read analytics_item_lifecycle exactly as before, completely unaffected
-- by this migration's existence.
--
-- ── EVERY EXISTING COLUMN, UNCHANGED ────────────────────────────────────
-- `SELECT l.*` re-exposes every analytics_item_lifecycle column verbatim,
-- including its own `purpose_id`/`purpose_name` — deliberately NOT
-- enumerated column-by-column here, so this view never drifts out of sync
-- if analytics_item_lifecycle gains columns later.
--
-- ── current_purpose_id / current_purpose_name — DOCUMENTED ALIASES ─────
-- These are byte-identical to the pre-existing `purpose_id`/`purpose_name`
-- columns (both are present on this view — NOT renamed, NOT removed, to
-- preserve full backward compatibility with anything already reading
-- analytics_item_lifecycle's shape through this view). The `current_`
-- prefix exists ONLY to state explicitly, at the type level, that this
-- value reflects CURRENT intent — Purpose is mutable and no historical-
-- Purpose record exists anywhere in this schema (see
-- analytics/SEMANTIC_CONTRACT.md). If a future migration ever adds a real
-- historical-Purpose model, `current_purpose_id`/`current_purpose_name`
-- are the names a "what is it now" column should keep; `purpose_id`/
-- `purpose_name` remain for any older reader that doesn't know about the
-- distinction. Until then, treat the two pairs as fully interchangeable.
--
-- ── purpose_policy_status — NEVER EXCLUDES A ROW ────────────────────────
-- A LEFT JOIN to analytics_purpose_policy — every analytics_item_lifecycle
-- row remains present in this view regardless of Purpose or policy state:
--   'mapped'           — purpose_id is set AND a policy row exists for it.
--   'missing_purpose'  — purpose_id itself is NULL (item has no Purpose
--                         assigned at all).
--   'missing_policy'   — purpose_id is set to a REAL item_purposes row,
--                         but no analytics_purpose_policy row exists for
--                         it (e.g. a future 4th Purpose added to
--                         item_purposes without a corresponding policy
--                         seeded yet).
-- disposition_mode / realization_priority_order / active_realization_flag
-- / expected_holding_policy are NULL whenever purpose_policy_status is not
-- 'mapped' — never defaulted to a fake value, never used to silently drop
-- the row.
--
-- ── PURPOSE CONTROLS INTERPRETATION, NEVER ECONOMIC ELIGIBILITY ─────────
-- This view adds NO population filter of its own — it is a strict
-- superset of analytics_item_lifecycle, one row per inventory item,
-- Personal/Hybrid/Business/NULL-purpose/unmapped-purpose all included.
-- Any future Purpose-aware module choosing to narrow, weight, or interpret
-- differently by disposition_mode does so in ITS OWN query — never here.
--
-- ── SECURITY MODEL — MATCHES analytics_item_lifecycle EXACTLY ──────────
-- security_invoker = true (same as analytics_item_lifecycle) — this view
-- exposes exactly what the querying role can already read via base-table
-- RLS, with no additional user_id filter of its own.
-- analytics_purpose_policy is global, non-user-scoped reference data, so
-- the join to it needs no RLS-equivalent condition.
-- ============================================================================

CREATE VIEW public.analytics_item_lifecycle_v2
WITH (security_invoker = true)
AS
SELECT
  l.*,
  l.purpose_id                         AS current_purpose_id,
  l.purpose_name                       AS current_purpose_name,
  p.disposition_mode,
  p.realization_priority_order,
  p.active_realization_flag,
  p.expected_holding_policy,
  CASE
    WHEN l.purpose_id IS NULL THEN 'missing_purpose'
    WHEN p.purpose_id IS NULL THEN 'missing_policy'
    ELSE 'mapped'
  END                                    AS purpose_policy_status
FROM public.analytics_item_lifecycle l
LEFT JOIN public.analytics_purpose_policy p ON p.purpose_id = l.purpose_id;

GRANT SELECT ON public.analytics_item_lifecycle_v2 TO authenticated;

COMMENT ON VIEW public.analytics_item_lifecycle_v2 IS
  'Purpose-Aware Analytics Foundation — the v2.0+ replacement read surface '
  'for analytics_item_lifecycle. Adds current_purpose_id/current_purpose_name '
  '(documented aliases of purpose_id/purpose_name — see migration header), '
  'disposition_mode, realization_priority_order, active_realization_flag, '
  'expected_holding_policy (all from analytics_purpose_policy, '
  '20260809000000), and purpose_policy_status (''mapped''/''missing_purpose''/'
  '''missing_policy'' — never excludes a row). security_invoker view, same '
  'security model as analytics_item_lifecycle: exposes exactly what the '
  'querying role can already read via base-table RLS. NOT consumed by any '
  'snapshot builder as of this migration — v1.0-v1.8 are entirely '
  'unaffected. See analytics/SEMANTIC_CONTRACT.md and analytics/README.md '
  'for the full Purpose-Aware Analytics Foundation contract.';
