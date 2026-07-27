-- analytics_runs: least-privilege table + sequence grants
--
-- 20260727000000_analytics_runs.sql intended two independent write
-- protections for public.analytics_runs: authenticated holding SELECT
-- table privilege only, and RLS providing target-only SELECT with no
-- write policies. Phase 2 Step 3 testing found that, like every other
-- table in this project, analytics_runs was created under this project's
-- ambient default-privilege grants (\dp shows anon/authenticated with
-- full arwdDxtm on the table and rwU on its identity sequence regardless
-- of any GRANT statement in the migration itself) — so authenticated
-- UPDATE/DELETE was being denied only because RLS filtered the affected
-- rows to zero, not because the role lacked table permission. This
-- migration makes both layers independently deny writes, matching the
-- original design intent.
--
-- 20260727000000_analytics_runs.sql and
-- 20260728000000_build_analytics_snapshot_v1.sql have already been
-- committed and pushed, so this is a forward-only correction rather than
-- a rewrite of either file.

-- ─── 1. Table privileges: least privilege for anon/authenticated ──────────

REVOKE ALL PRIVILEGES ON public.analytics_runs FROM anon;
REVOKE ALL PRIVILEGES ON public.analytics_runs FROM authenticated;

-- anon has no legitimate use case for this table at all (the existing
-- RLS SELECT policy is `TO authenticated` only) — it gets no grant back.
GRANT SELECT ON public.analytics_runs TO authenticated;

-- ─── 2. Sequence privileges: no client role can INSERT, so none needs the sequence ──

REVOKE ALL PRIVILEGES ON SEQUENCE public.analytics_runs_id_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.analytics_runs_id_seq FROM authenticated;

-- service_role performs every insert via the server-side runner
-- (src/lib/analytics/runAnalytics.ts) and needs full sequence privileges
-- to do so. Explicit, matching this table's existing explicit service_role
-- table grant, even though the project's default privileges already cover it.
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.analytics_runs_id_seq TO service_role;
