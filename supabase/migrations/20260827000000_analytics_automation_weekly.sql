-- Weekly Analytics + Advice automation — audit table and atomic weekly
-- claim RPC. Forward-only, does not modify any prior migration.
--
-- Purpose: back the /api/cron/weekly-analytics-advice route (Vercel Cron,
-- CRON_SECRET-protected) with a database-backed, race-free "has this user's
-- weekly automation already run for this Toronto local week?" check — the
-- route may be invoked twice for the same week (one EDT UTC slot, one EST
-- UTC slot — only one is ever inside the actual Wednesday-9pm-Toronto
-- window at a time, but both physically exist as separate Vercel Cron
-- entries year-round) and Vercel may retry a slow/failed invocation, so a
-- read-then-insert check in application code would race.
--
-- CONFIRMED SCHEMA FACTS THIS MIGRATION DEPENDS ON (re-verified live before
-- writing any DDL below, same discipline as 20260826000000's own header):
--   - public.app_users.id is the real user-identity column every other
--     ownership FK in this schema (analytics_runs.recommendation_target_
--     user_id, analytics_run_advice.user_id, ...) points at. This
--     migration's target_user_id column follows the same convention.
--   - public.analytics_runs has NO `user_id` column (see 20260826000000's
--     own header) — not referenced by name here, but noted again because
--     this migration's target_user_id is deliberately NOT a copy of
--     anything on analytics_runs; it is independently supplied by the
--     caller (the cron route) per eligible user it enumerates from
--     app_users directly.
--   - public.analytics_runs(id) and public.analytics_run_advice(id) are
--     both `bigint generated always as identity` — this migration's
--     analytics_run_id/analytics_run_advice_id columns match that type.

-- ── 1. Audit table ──────────────────────────────────────────────────────

CREATE TABLE public.analytics_automation_executions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  automation_code         text NOT NULL,
  target_user_id          integer NOT NULL REFERENCES public.app_users(id),
  -- The Toronto-local calendar week this execution is for, as the ISO
  -- date (YYYY-MM-DD) of that week's Wednesday — computed entirely in
  -- application code (see src/lib/analytics/automation/torontoSchedule.ts)
  -- from an America/Toronto-aware calculation; the database does not need
  -- to know about time zones or DST at all, only that this key uniquely
  -- identifies one automation-week per user.
  local_period_key        text NOT NULL,
  status                  text NOT NULL DEFAULT 'running',
  analytics_run_id        bigint REFERENCES public.analytics_runs(id) ON DELETE SET NULL,
  analytics_run_advice_id bigint REFERENCES public.analytics_run_advice(id) ON DELETE SET NULL,
  started_at              timestamptz,
  completed_at            timestamptz,
  error_code              text,
  error_message           text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_automation_executions_automation_code_check CHECK (btrim(automation_code) <> ''),
  CONSTRAINT analytics_automation_executions_local_period_key_check CHECK (btrim(local_period_key) <> ''),
  CONSTRAINT analytics_automation_executions_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  -- A 'completed' execution must have actually produced an Analytics Run
  -- (whether or not Advice generation itself then succeeded — Advice's
  -- own completed/failed/NO_VALID_EVIDENCE outcome lives on the
  -- analytics_run_advice row this points at, not duplicated here). A
  -- 'failed' execution must explain why. Preserved, never deleted, on
  -- failure — this is the audit trail requirement itself.
  CONSTRAINT analytics_automation_executions_completed_has_run_check CHECK (status <> 'completed' OR analytics_run_id IS NOT NULL),
  CONSTRAINT analytics_automation_executions_failed_has_error_check CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

COMMENT ON TABLE public.analytics_automation_executions IS
  'Audit + idempotency record for scheduled automations (currently: weekly Analytics + Advice generation). One row per (automation_code, target_user_id, local_period_key) — enforced by the unique index below and claimed exclusively via claim_weekly_automation_execution(). Service-role only; no authenticated access (no UI need for this table today).';

-- The real uniqueness/idempotency guarantee: one execution per automation
-- per user per local week. claim_weekly_automation_execution below relies
-- on this unique index via a plain INSERT + EXCEPTION WHEN unique_violation
-- (see that function) — a concurrent INSERT that would violate it blocks
-- until the other transaction commits or rolls back, so this is already
-- race-free without needing an advisory lock the way the revision-
-- allocation RPC needed one for its extra auto/retry branching logic.
CREATE UNIQUE INDEX analytics_automation_executions_unique_period
  ON public.analytics_automation_executions (automation_code, target_user_id, local_period_key);

CREATE INDEX idx_analytics_automation_executions_target_created_at
  ON public.analytics_automation_executions (target_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_analytics_automation_executions_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_analytics_automation_executions_updated_at
  BEFORE UPDATE ON public.analytics_automation_executions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_analytics_automation_executions_updated_at();

-- Row Level Security enabled with NO policies at all: authenticated/anon
-- get zero rows either way (RLS defaults to deny with no matching policy),
-- and are additionally blocked at the grant level below — belt and
-- suspenders, matching this schema's established pattern. service_role
-- bypasses RLS entirely, as with every other table in this schema.
ALTER TABLE public.analytics_automation_executions ENABLE ROW LEVEL SECURITY;

-- Ambient default privileges in this project grant new tables full CRUD to
-- anon/authenticated regardless of migration-local intent (see
-- 20260729000000_analytics_runs_grant_hardening.sql) — explicit REVOKE is
-- required on every new table, not optional cleanup.
REVOKE ALL ON public.analytics_automation_executions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.analytics_automation_executions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.analytics_automation_executions_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.analytics_automation_executions_id_seq FROM PUBLIC, anon, authenticated;

-- ── 2. Atomic weekly claim RPC ──────────────────────────────────────────
-- Attempts to INSERT a new 'running' execution row for
-- (p_automation_code, p_target_user_id, p_local_period_key); if one
-- already exists (this exact user/week has already been claimed by an
-- earlier invocation — the other DST UTC slot, a Vercel retry, or a
-- genuinely concurrent request), returns that EXISTING row instead with
-- was_created = false, so the caller can skip re-running Analytics/Advice
-- for it entirely rather than erroring.

CREATE OR REPLACE FUNCTION public.claim_weekly_automation_execution(
  p_automation_code text,
  p_target_user_id integer,
  p_local_period_key text
)
RETURNS TABLE (
  id bigint,
  automation_code text,
  target_user_id integer,
  local_period_key text,
  status text,
  analytics_run_id bigint,
  analytics_run_advice_id bigint,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz,
  updated_at timestamptz,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_id bigint;
BEGIN
  -- Not ON CONFLICT: RETURNS TABLE's column list (automation_code,
  -- target_user_id, local_period_key, ...) implicitly declares PL/pgSQL
  -- variables of those exact names, which makes a bare ON CONFLICT
  -- (automation_code, target_user_id, local_period_key) target list
  -- genuinely ambiguous to plpgsql ("could be the variable or the
  -- column") and a hard parse error. A nested EXCEPTION block sidesteps
  -- this entirely (same proven pattern as claim_next_analytics_run_
  -- advice_revision's own unique-violation handling) and is exactly as
  -- safe under concurrency — the unique index still does the real work.
  BEGIN
    INSERT INTO public.analytics_automation_executions (
      automation_code, target_user_id, local_period_key, status, started_at
    ) VALUES (
      p_automation_code, p_target_user_id, p_local_period_key, 'running', now()
    )
    RETURNING analytics_automation_executions.id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    v_new_id := NULL;
  END;

  IF v_new_id IS NOT NULL THEN
    RETURN QUERY
    SELECT e.id, e.automation_code, e.target_user_id, e.local_period_key, e.status,
           e.analytics_run_id, e.analytics_run_advice_id, e.started_at, e.completed_at,
           e.error_code, e.error_message, e.created_at, e.updated_at, true
    FROM public.analytics_automation_executions e
    WHERE e.id = v_new_id;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT e.id, e.automation_code, e.target_user_id, e.local_period_key, e.status,
         e.analytics_run_id, e.analytics_run_advice_id, e.started_at, e.completed_at,
         e.error_code, e.error_message, e.created_at, e.updated_at, false
  FROM public.analytics_automation_executions e
  WHERE e.automation_code = p_automation_code
    AND e.target_user_id = p_target_user_id
    AND e.local_period_key = p_local_period_key;
END;
$$;

COMMENT ON FUNCTION public.claim_weekly_automation_execution(text, integer, text) IS
  'Atomically claims (or, if already claimed, returns) one weekly automation execution row for one (automation_code, target_user_id, local_period_key). service_role only; p_target_user_id is always a server-enumerated eligible app_users.id, never client-suppliable.';

REVOKE ALL ON FUNCTION public.claim_weekly_automation_execution(text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_weekly_automation_execution(text, integer, text) TO service_role;
