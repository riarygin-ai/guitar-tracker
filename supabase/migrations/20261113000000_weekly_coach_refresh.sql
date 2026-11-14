-- Weekly Coach Refresh: independent General Coach + Listing Advice module
-- results on the weekly execution record, an in-flight guard for Analytics
-- runs, and a batch-scoped statement timeout for the snapshot builder.
-- Forward-only; no existing row is rewritten.
--
-- ── 1. Snapshot builder timeout (root cause of the 2026-11-12 failures) ──
-- build_analytics_snapshot_v2_13 is ONE PostgREST statement that runs 14
-- nested builder layers (~150 ms of planning per call even on a fast
-- local machine, ~2.3 MB of jsonb merged layer by layer). Production
-- typically finished it in 2-4 s, but it inherited the authenticator
-- role's interactive 8 s statement_timeout, and the production database
-- has bursts where the SAME read-only call takes 3-4x longer (reproduced
-- 2026-11-13: 1.0 s -> 8.6 s within minutes, with trivial 60-row counts
-- taking ~0.9 s). Both users' weekly runs hit 57014 in the same minute on
-- 2026-11-12. No single query regressed — the data set is small (248
-- items) and the 2026-10-31 draft filter on analytics_item_lifecycle is
-- an indexed EXISTS — so the application-side fix removes the duplicate
-- concurrent evidence loads that ran alongside it (see coachRefresh.ts),
-- and this gives ONLY the service-role-only batch builder a batch-sized
-- ceiling. PostgREST applies a function's SET statement_timeout to the
-- call. Interactive endpoints keep the 8 s default; anon/authenticated
-- cannot execute this function at all.
ALTER FUNCTION public.build_analytics_snapshot_v2_13(int) SET statement_timeout = '25s';

-- ── 2. One in-flight Analytics run per user ──────────────────────────────
-- A manual "Refresh Coach" double-click (or a manual refresh racing the
-- weekly run) must not create two concurrent snapshot runs. Rows left
-- pending/running by a killed function are failed out by the runner
-- before it claims (STALE threshold in runAnalytics.ts), so this index can
-- never block a user permanently.
-- Same abandonment rule the runner applies (zero rows in production on 2026-11-13).
UPDATE public.analytics_runs
   SET status = 'failed', completed_at = now(), error_message = 'Run did not finish and was abandoned.'
 WHERE status IN ('pending', 'running')
   AND created_at < now() - interval '10 minutes';

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_runs_one_inflight_per_user
  ON public.analytics_runs (requested_by_user_id)
  WHERE status IN ('pending', 'running');

-- ── 3. Per-module results on the weekly execution ───────────────────────
-- status keeps its lifecycle meaning; 'partial' = one module succeeded and
-- the other failed. Module statuses are what the Dashboard reports.
ALTER TABLE public.analytics_automation_executions
  ADD COLUMN general_status        text,
  ADD COLUMN general_error_code    text,
  ADD COLUMN listing_status        text,
  ADD COLUMN listing_error_code    text,
  ADD COLUMN listing_advice_run_id bigint REFERENCES public.listing_advice_runs(id) ON DELETE SET NULL;

ALTER TABLE public.analytics_automation_executions
  DROP CONSTRAINT analytics_automation_executions_status_check,
  ADD CONSTRAINT analytics_automation_executions_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed')),
  ADD CONSTRAINT analytics_automation_executions_general_status_check
    CHECK (general_status IS NULL OR general_status IN ('completed', 'no_material_advice', 'failed', 'skipped')),
  ADD CONSTRAINT analytics_automation_executions_listing_status_check
    CHECK (listing_status IS NULL OR listing_status IN ('completed', 'no_material_advice', 'failed', 'skipped')),
  ADD CONSTRAINT analytics_automation_executions_partial_has_error_check
    CHECK (status <> 'partial' OR error_code IS NOT NULL),
  -- A completed refresh normally has its run; the one exception is a General
  -- module skipped because another Analytics run for the user was in flight.
  DROP CONSTRAINT analytics_automation_executions_completed_has_run_check,
  ADD CONSTRAINT analytics_automation_executions_completed_has_run_check
    CHECK (status <> 'completed' OR analytics_run_id IS NOT NULL OR general_status = 'skipped');

COMMENT ON COLUMN public.analytics_automation_executions.general_status IS
  'Weekly Coach Refresh — General Business Coach module result (completed | no_material_advice | failed | skipped). NULL on rows written before 20261113000000.';
COMMENT ON COLUMN public.analytics_automation_executions.listing_status IS
  'Weekly Coach Refresh — Listing Advice module result (completed | no_material_advice | failed | skipped). Runs even when the General module failed. NULL on rows written before 20261113000000.';
