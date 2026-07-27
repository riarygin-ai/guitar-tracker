-- analytics_runs
--
-- Records one execution of the (future, not yet built) analytics autorunner
-- and holds its versioned JSON snapshot once complete. This migration is
-- Phase 2 Step 1 of the analytics autorunner plan: persistence + status
-- contract only. No orchestrator, API route, frontend UI, scheduled job, or
-- Business Coach reads or writes this table yet — see analytics/README.md.
--
-- OWNERSHIP MODEL THIS TABLE ASSUMES (see analytics/SEMANTIC_CONTRACT.md
-- section 12 for the full audit): public.app_users.id is an integer
-- identity primary key; public.app_users.auth_user_id is the uuid FK to
-- auth.users.id; public.get_app_user_id() maps auth.uid() to app_users.id.
-- No workspace/organization model exists yet, so this table has no
-- workspace_id/organization_id column — see evidence_scope below.
--
-- EVIDENCE VS. RECOMMENDATION SCOPE (see analytics/SEMANTIC_CONTRACT.md
-- sections 9-11): a run is requested by one user (requested_by_user_id) on
-- behalf of one recommendation target (recommendation_target_user_id) —
-- usually, but not necessarily, the same person. evidence_aggregates
-- inside the future snapshot may be computed over the full shared Business
-- population; recommendation_candidates inside it must be restricted to
-- recommendation_target_user_id before the row is ever written. Developer-
-- only multi-user drilldowns (see analytics/sql/*.sql's Query
-- Classification Index) must never be persisted into snapshot.

-- ─── 1. analytics_runs table ───────────────────────────────────────────────

CREATE TABLE public.analytics_runs (
  id                              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  requested_by_user_id            int         NOT NULL
                                               REFERENCES public.app_users(id),
  recommendation_target_user_id   int         NOT NULL
                                               REFERENCES public.app_users(id),

  analytics_version               text        NOT NULL DEFAULT '1.0',
  evidence_scope                  text        NOT NULL DEFAULT 'shared_business_population',

  status                          text        NOT NULL DEFAULT 'pending',

  created_at                      timestamptz NOT NULL DEFAULT now(),
  started_at                      timestamptz,
  completed_at                    timestamptz,
  duration_ms                     int,

  snapshot                        jsonb,
  error_message                   text,

  -- ── Simple, always-applicable checks ──────────────────────────────────
  CONSTRAINT analytics_runs_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  CONSTRAINT analytics_runs_duration_ms_check
    CHECK (duration_ms IS NULL OR duration_ms >= 0),

  CONSTRAINT analytics_runs_completed_at_after_started_check
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),

  CONSTRAINT analytics_runs_analytics_version_check
    CHECK (btrim(analytics_version) <> ''),

  CONSTRAINT analytics_runs_evidence_scope_check
    CHECK (btrim(evidence_scope) <> ''),

  -- ── Status lifecycle shape ────────────────────────────────────────────
  -- One named, readable constraint (rather than many small ones) for the
  -- field-presence rules that depend on status. The future runner sets
  -- these fields explicitly on each transition — no trigger computes them.
  --   pending   — nothing has happened yet: no start/end time, no
  --               duration, no snapshot, no error.
  --   running   — started, not yet finished: started_at set, everything
  --               that only makes sense once finished stays NULL.
  --   completed — finished successfully: started_at/completed_at both
  --               set, snapshot required, error_message forbidden.
  --               duration_ms is NOT required here (the runner may not
  --               always compute it), so it is intentionally unconstrained
  --               for this status.
  --   failed    — finished unsuccessfully: started_at/completed_at both
  --               set, error_message required. snapshot/duration_ms are
  --               intentionally unconstrained — a failed run may or may
  --               not have a partial snapshot or a measured duration.
  CONSTRAINT analytics_runs_status_fields_check
    CHECK (
      CASE status
        WHEN 'pending' THEN
          started_at IS NULL AND completed_at IS NULL AND duration_ms IS NULL
          AND snapshot IS NULL AND error_message IS NULL
        WHEN 'running' THEN
          started_at IS NOT NULL AND completed_at IS NULL AND duration_ms IS NULL
          AND snapshot IS NULL AND error_message IS NULL
        WHEN 'completed' THEN
          started_at IS NOT NULL AND completed_at IS NOT NULL
          AND snapshot IS NOT NULL AND error_message IS NULL
        WHEN 'failed' THEN
          started_at IS NOT NULL AND completed_at IS NOT NULL
          AND error_message IS NOT NULL
        ELSE false
      END
    )
);

-- ─── 2. Indexes ─────────────────────────────────────────────────────────────
-- Newest-run lookups for the two roles a run can be read by (see RLS below).
-- No status-lookup index yet — no future-runner query pattern justifies one
-- today; add it when that design exists, not speculatively. No GIN index on
-- snapshot yet — its structure isn't defined until the next phase.

CREATE INDEX idx_analytics_runs_requested_by_created_at
  ON public.analytics_runs (requested_by_user_id, created_at DESC);

CREATE INDEX idx_analytics_runs_target_created_at
  ON public.analytics_runs (recommendation_target_user_id, created_at DESC);

-- ─── 3. Row-level security ──────────────────────────────────────────────────
-- SELECT only, for both roles a run concerns. No INSERT/UPDATE/DELETE policy
-- is created for `authenticated` at all — with RLS enabled and no permissive
-- policy for those commands, they are denied outright. The future runner
-- (server-side / service_role) creates and updates rows; service_role
-- bypasses RLS entirely by Supabase convention, so no service_role-specific
-- policy is added here (matches every other table in this schema).

ALTER TABLE public.analytics_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytics_runs: select own or target"
  ON public.analytics_runs FOR SELECT TO authenticated
  USING (
    requested_by_user_id = public.get_app_user_id()
    OR recommendation_target_user_id = public.get_app_user_id()
  );

-- ─── 4. Grants ──────────────────────────────────────────────────────────────
-- authenticated gets SELECT only — deliberately narrower than this schema's
-- usual "grant full CRUD, let RLS gate it" pattern (see ai_prompts,
-- inventory_items), because this table has no authenticated write path at
-- all yet. Not granting INSERT/UPDATE/DELETE here is a second, independent
-- layer on top of RLS already having no policy for them.

GRANT SELECT ON public.analytics_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_runs TO service_role;

-- ─── 5. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.analytics_runs IS
  'One row per analytics execution (Phase 2 Step 1 of the autorunner plan — '
  'no orchestrator/API/UI/scheduler reads or writes this table yet). '
  'Evidence aggregates inside snapshot may be computed over the controlled '
  'shared Business population (evidence_scope); the persisted snapshot must '
  'NOT include another user''s item IDs, item names, or item-level financial '
  'details. recommendation_candidates inside snapshot must be restricted to '
  'recommendation_target_user_id before this row is written. Developer-only '
  'multi-user drilldowns (see analytics/sql/*.sql Query Classification '
  'Index) must never be persisted here. snapshot JSON structure is not '
  'enforced at the database level yet — see analytics/SEMANTIC_CONTRACT.md.';

COMMENT ON COLUMN public.analytics_runs.requested_by_user_id IS
  'app_users.id of the user who initiated this run.';

COMMENT ON COLUMN public.analytics_runs.recommendation_target_user_id IS
  'app_users.id of the user whose open Business items may appear as '
  'recommendation candidates in this run''s snapshot. Normally equal to '
  'requested_by_user_id today, but not constrained to be — a future '
  'controlled admin/server workflow may run analytics for a different '
  'target user than the one who requested it.';

COMMENT ON COLUMN public.analytics_runs.evidence_scope IS
  'Free-text label for which population evidence_aggregates were computed '
  'over (default ''shared_business_population''). Never a hardcoded user '
  'ID. Never a workspace/organization ID — no such model exists yet, see '
  'analytics/SEMANTIC_CONTRACT.md.';

COMMENT ON COLUMN public.analytics_runs.analytics_version IS
  'Version of the analytical definition/snapshot contract that produced '
  'snapshot (default ''1.0'') — NOT this application''s release version.';

COMMENT ON COLUMN public.analytics_runs.snapshot IS
  'Versioned analytics output, present only once status = completed. Must '
  'never contain another user''s item_id, item display name, or item-level '
  'financial detail: only pooled evidence_aggregates plus '
  'recommendation_candidates already filtered to '
  'recommendation_target_user_id. JSON structure is defined in a future '
  'phase, not enforced here.';

COMMENT ON COLUMN public.analytics_runs.error_message IS
  'Populated only when status = failed; NULL for every other status.';
