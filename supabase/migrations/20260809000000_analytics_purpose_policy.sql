-- analytics_purpose_policy
--
-- Purpose-Aware Analytics Foundation, part 1 of 2. Centralized policy
-- metadata mapping each public.item_purposes row to how it should
-- influence ANALYTICS INTERPRETATION — realization urgency, ownership-age
-- interpretation, DOM interpretation, listing urgency, and future
-- prioritization — never economic ELIGIBILITY. Profit, ROI, acquisition/
-- exit values, and every other economic fact remain computed identically
-- for every Purpose; this table never gates that.
--
-- This migration does NOT touch analytics_item_lifecycle, any snapshot
-- builder (v1.0-v1.8), runAnalytics.ts, recommendation_candidates, Open
-- Inventory Decision Support, or any UI. It only adds a new, currently
-- unconsumed reference table. See 20260810000000_analytics_item_lifecycle_v2.sql
-- for the (also currently unconsumed by any builder) view that joins it.
--
-- ── WHY A SEPARATE TABLE, NOT COLUMNS ON item_purposes ──────────────────
-- item_purposes is an app-facing reference table with its own RLS/admin-
-- CRUD story (authenticated admins can rename/deactivate a purpose via the
-- existing Admin page). Analytics policy metadata is a distinct concern —
-- keeping it in its own table avoids widening an app-facing reference
-- table with analytics-only columns, and lets this table follow the
-- stricter service-role-managed-only grant model used by analytics_runs,
-- rather than item_purposes' own admin-writable model.
--
-- ── NO NUMERIC THRESHOLDS YET ────────────────────────────────────────────
-- expected_holding_policy is a descriptive LABEL (e.g.
-- 'shorter_holding_preferred'), never a day count. Numeric DOM/holding-day
-- thresholds are explicitly deferred to a future step, per this task's own
-- instruction — inventing them here would bake in unreviewed business
-- rules ahead of any actual Purpose-aware module needing them.
-- ============================================================================

CREATE TABLE public.analytics_purpose_policy (
  purpose_id                  bigint      PRIMARY KEY REFERENCES public.item_purposes(id),
  disposition_mode            text        NOT NULL,
  realization_priority_order  integer     NOT NULL,
  active_realization_flag     boolean     NOT NULL,
  expected_holding_policy     text        NOT NULL,
  description                 text        NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_purpose_policy_priority_positive
    CHECK (realization_priority_order > 0),
  CONSTRAINT analytics_purpose_policy_disposition_mode_nonempty
    CHECK (length(trim(disposition_mode)) > 0),
  CONSTRAINT analytics_purpose_policy_holding_policy_nonempty
    CHECK (length(trim(expected_holding_policy)) > 0)
);

-- ─── updated_at trigger — reuses the shared trigger function already
-- created for item_listings (20260614000000_item_listings.sql); safe to
-- reference here since that migration runs first. ──────────────────────

CREATE TRIGGER analytics_purpose_policy_set_updated_at
  BEFORE UPDATE ON public.analytics_purpose_policy
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.analytics_purpose_policy IS
  'Centralized Purpose-aware analytics policy, one row per public.item_purposes '
  'row. Governs realization urgency / ownership-age interpretation / DOM '
  'interpretation / listing urgency for future Purpose-aware analytics '
  '(v2.0+) — NEVER economic eligibility. Not yet consumed by any snapshot '
  'builder; analytics_item_lifecycle_v2 (20260810000000) is the first '
  'consumer. See analytics/SEMANTIC_CONTRACT.md for the full policy '
  'semantics and analytics/README.md for the Purpose-Aware Analytics '
  'Foundation overview.';

-- ─── Seed — resolved by CASE-INSENSITIVE NAME, never by assuming IDs ────
-- item_purposes.id values happen to be stable today (seeded via a single
-- literal VALUES insert), but this migration deliberately does not rely on
-- that — it looks each purpose up by name and fails loudly if any of the
-- three required names is missing or duplicated, rather than silently
-- seeding against the wrong row or skipping a purpose.

DO $$
DECLARE
  v_business_id  bigint;
  v_hybrid_id    bigint;
  v_personal_id  bigint;
  v_count        integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM public.item_purposes WHERE lower(name) = 'business';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'analytics_purpose_policy seed: expected exactly 1 item_purposes row named ''Business'' (case-insensitive), found %. Aborting — fix item_purposes before rerunning this migration.', v_count;
  END IF;
  SELECT id INTO v_business_id FROM public.item_purposes WHERE lower(name) = 'business';

  SELECT COUNT(*) INTO v_count FROM public.item_purposes WHERE lower(name) = 'hybrid';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'analytics_purpose_policy seed: expected exactly 1 item_purposes row named ''Hybrid'' (case-insensitive), found %. Aborting — fix item_purposes before rerunning this migration.', v_count;
  END IF;
  SELECT id INTO v_hybrid_id FROM public.item_purposes WHERE lower(name) = 'hybrid';

  SELECT COUNT(*) INTO v_count FROM public.item_purposes WHERE lower(name) = 'personal';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'analytics_purpose_policy seed: expected exactly 1 item_purposes row named ''Personal'' (case-insensitive), found %. Aborting — fix item_purposes before rerunning this migration.', v_count;
  END IF;
  SELECT id INTO v_personal_id FROM public.item_purposes WHERE lower(name) = 'personal';

  INSERT INTO public.analytics_purpose_policy
    (purpose_id, disposition_mode, realization_priority_order, active_realization_flag, expected_holding_policy, description)
  VALUES
    (
      v_business_id,
      'active_realization',
      1,
      true,
      'shorter_holding_preferred',
      'Actively intended for realization; highest urgency and faster capital turnover preferred.'
    ),
    (
      v_hybrid_id,
      'selective_realization',
      2,
      true,
      'extended_holding_acceptable',
      'Commercially relevant with personal interest or appreciation potential; longer holding and higher asking price may be intentional.'
    ),
    (
      v_personal_id,
      'opportunistic_realization',
      3,
      false,
      'long_holding_acceptable',
      'Primarily personal or showcase inventory; sale or trade remains economically relevant but active realization is not required.'
    );
END $$;

-- ─── Security — non-sensitive reference data, service-role-managed only ──
-- Matches the analytics_runs least-privilege pattern
-- (20260729000000_analytics_runs_grant_hardening.sql): this project's
-- ambient default privileges grant anon/authenticated full table
-- privileges on any newly created table regardless of the GRANTs below, so
-- writes must be explicitly REVOKEd here rather than left to RLS alone.

ALTER TABLE public.analytics_purpose_policy ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytics_purpose_policy: select all"
  ON public.analytics_purpose_policy FOR SELECT TO authenticated
  USING (true);

REVOKE ALL PRIVILEGES ON public.analytics_purpose_policy FROM anon;
REVOKE ALL PRIVILEGES ON public.analytics_purpose_policy FROM authenticated;

-- anon has no legitimate use case for this table (the RLS SELECT policy is
-- `TO authenticated` only) — it gets no grant back.
GRANT SELECT ON public.analytics_purpose_policy TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_purpose_policy TO service_role;
