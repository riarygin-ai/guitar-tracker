-- GT Lead Log import — Phase 2, Part 1: import run/audit history
--
-- Phase 1 (20260908000000/20260908000001) created lead_import_sources and
-- item_leads and shipped a read-only Preview. This migration adds the
-- audit tables the actual import writes into. The write path itself (the
-- atomic apply function) lives in 20260909000001_apply_lead_import.sql —
-- split so the tables it depends on exist first.
--
-- ── WHY TWO TABLES ────────────────────────────────────────────────────────
-- lead_import_runs is one row per import attempt (the header: who, which
-- source, when, the classification/outcome counts, final status).
-- lead_import_run_rows is one row per SOURCE SHEET ROW in that attempt, so
-- a run can be fully reconstructed afterwards: what each sheet row was
-- classified as, and what actually happened to it.
--
-- ── WHAT THE AUDIT DELIBERATELY DOES NOT STORE ────────────────────────────
-- No `notes`. No copy of the lead payload (no JSON blob of the row). The
-- canonical imported source state already lives in item_leads — duplicating
-- it here would create a second, silently-diverging copy of user content
-- and would drag free-text buyer conversation notes into an audit log that
-- exists only to answer "what did this run do". lead_import_run_rows
-- therefore has no notes column at all, and issue_message is a short,
-- code-derived sentence produced by src/lib/leadImport/validate.ts (never
-- assembled from sheet content beyond the offending field's own value).
--
-- ── ONE RUNNING IMPORT PER SOURCE ─────────────────────────────────────────
-- idx_lead_import_runs_one_running_per_source is a partial UNIQUE index —
-- the database itself, not the application, is what makes a second
-- concurrent import of the same source impossible. See
-- start_lead_import_run() below for the claim protocol built on it.

-- ─── 1. lead_import_runs ────────────────────────────────────────────────────

CREATE TABLE public.lead_import_runs (
  id                     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  source_id              bigint      NOT NULL REFERENCES public.lead_import_sources(id),
  -- The user whose leads this run imports (always lead_import_sources.
  -- user_id — never the admin who pressed the button, and never anything
  -- client-supplied). The composite FK below pins the pair together.
  user_id                int         NOT NULL REFERENCES public.app_users(id),
  -- The admin who requested the run. Usually different from user_id.
  requested_by_user_id   int         NOT NULL REFERENCES public.app_users(id),

  status                 text        NOT NULL,

  started_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,

  -- ── Classification counts (what the source read said) ────────────────
  source_row_count       int         NOT NULL DEFAULT 0,
  new_count              int         NOT NULL DEFAULT 0,
  update_count           int         NOT NULL DEFAULT 0,
  unchanged_count        int         NOT NULL DEFAULT 0,
  source_older_count     int         NOT NULL DEFAULT 0,
  invalid_count          int         NOT NULL DEFAULT 0,

  -- ── Outcome counts (what the database actually did) ──────────────────
  inserted_count         int         NOT NULL DEFAULT 0,
  updated_count          int         NOT NULL DEFAULT 0,
  -- Eligible (valid NEW/UPDATE) rows that were NOT applied: either the
  -- whole apply transaction failed (all of them), or the upsert's own
  -- source_updated_at guard rejected the row because another writer had
  -- already applied an equal-or-newer version.
  failed_count           int         NOT NULL DEFAULT 0,

  -- ── Metadata ──────────────────────────────────────────────────────────
  source_max_updated_at  timestamptz,
  error_summary          text,

  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lead_import_runs_status_check
    CHECK (status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')),

  -- A run is finished exactly when it is no longer RUNNING.
  CONSTRAINT lead_import_runs_completed_at_check
    CHECK ((status = 'RUNNING') = (completed_at IS NULL)),

  CONSTRAINT lead_import_runs_error_summary_check
    CHECK (error_summary IS NULL OR (btrim(error_summary) <> '' AND length(error_summary) <= 2000)),

  CONSTRAINT lead_import_runs_counts_check CHECK (
    source_row_count   >= 0 AND new_count       >= 0 AND update_count    >= 0 AND
    unchanged_count    >= 0 AND source_older_count >= 0 AND invalid_count >= 0 AND
    inserted_count     >= 0 AND updated_count   >= 0 AND failed_count    >= 0
  ),

  -- A run can never claim a source belonging to a different user than the
  -- run itself records — same composite-FK protection item_leads uses.
  CONSTRAINT lead_import_runs_source_owner_fk
    FOREIGN KEY (source_id, user_id) REFERENCES public.lead_import_sources(id, user_id)
);

-- At most one RUNNING import per source, enforced by the database rather
-- than by application-level checking (Part 15). A second concurrent
-- import attempt for the same source cannot insert its claim row at all.
CREATE UNIQUE INDEX idx_lead_import_runs_one_running_per_source
  ON public.lead_import_runs (source_id)
  WHERE status = 'RUNNING';

CREATE INDEX idx_lead_import_runs_source_started
  ON public.lead_import_runs (source_id, started_at DESC);

CREATE INDEX idx_lead_import_runs_user_started
  ON public.lead_import_runs (user_id, started_at DESC);

-- ─── 2. lead_import_run_rows ────────────────────────────────────────────────

CREATE TABLE public.lead_import_run_rows (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  import_run_id       bigint      NOT NULL REFERENCES public.lead_import_runs(id) ON DELETE CASCADE,

  -- 1-based sheet row number (the header is row 1, so data starts at 2).
  sheet_row_number    int         NOT NULL,

  -- NULL when the source row's lead_id was missing or not a valid UUID —
  -- the reason is then in issue_codes.
  lead_id             uuid,
  inventory_item_id   bigint,
  source_updated_at   timestamptz,

  classification      text        NOT NULL,
  result              text        NOT NULL,

  issue_codes         text[]      NOT NULL DEFAULT '{}',
  -- A short, code-derived sentence. Never sheet `notes` content — see this
  -- migration's header.
  issue_message       text,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lead_import_run_rows_classification_check
    CHECK (classification IN ('NEW', 'UPDATE', 'UNCHANGED', 'SOURCE_OLDER', 'INVALID')),

  CONSTRAINT lead_import_run_rows_result_check
    CHECK (result IN (
      'INSERTED',              -- applied as a new item_leads row
      'UPDATED',               -- applied over an older stored version
      'SKIPPED_UNCHANGED',     -- stored source_updated_at is identical
      'SKIPPED_SOURCE_OLDER',  -- sheet row is older than what is stored
      'SKIPPED_INVALID',       -- row-level validation errors
      'SKIPPED_NOT_APPLIED',   -- eligible, but the upsert's timestamp guard rejected it
      'FAILED'                 -- eligible, but the apply transaction rolled back
    )),

  CONSTRAINT lead_import_run_rows_sheet_row_number_check CHECK (sheet_row_number >= 2),

  CONSTRAINT lead_import_run_rows_issue_message_check
    CHECK (issue_message IS NULL OR (btrim(issue_message) <> '' AND length(issue_message) <= 500)),

  -- One audit record per source row per run.
  CONSTRAINT lead_import_run_rows_run_row_unique UNIQUE (import_run_id, sheet_row_number)
);

CREATE INDEX idx_lead_import_run_rows_run_result
  ON public.lead_import_run_rows (import_run_id, result);

-- ─── 3. Row-level security ──────────────────────────────────────────────────
-- Same shape as lead_import_sources: the owning user may read their own
-- history, an admin may read all, and there is NO authenticated write
-- policy whatsoever — every write goes through service_role via the
-- functions in 20260909000001_apply_lead_import.sql.

ALTER TABLE public.lead_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_import_run_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_import_runs: select own or admin"
  ON public.lead_import_runs FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id() OR public.get_app_user_is_admin());

CREATE POLICY "lead_import_run_rows: select via own or admin run"
  ON public.lead_import_run_rows FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.lead_import_runs r
    WHERE r.id = lead_import_run_rows.import_run_id
      AND (r.user_id = public.get_app_user_id() OR public.get_app_user_is_admin())
  ));

-- ─── 4. Grants ──────────────────────────────────────────────────────────────
-- This project's ambient default privileges grant anon/authenticated full
-- CRUD on every new table regardless of migration-local GRANTs (see
-- 20260729000000_analytics_runs_grant_hardening.sql), so table privileges
-- must be revoked explicitly and independently of RLS.

REVOKE ALL PRIVILEGES ON public.lead_import_runs     FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON public.lead_import_run_rows FROM anon, authenticated;

GRANT SELECT ON public.lead_import_runs     TO authenticated;
GRANT SELECT ON public.lead_import_run_rows TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_import_runs     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_import_run_rows TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.lead_import_runs_id_seq     FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.lead_import_run_rows_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.lead_import_runs_id_seq     TO service_role;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.lead_import_run_rows_id_seq TO service_role;

-- ─── 5. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.lead_import_runs IS
  'One row per GT Lead Log import attempt. status: RUNNING (claimed, not '
  'yet finished), COMPLETED, COMPLETED_WITH_ERRORS (valid rows applied, '
  'some rows were invalid or could not be applied), FAILED (the apply '
  'transaction rolled back, or the source could not be read at all — no '
  'lead was written). At most one RUNNING run per source exists at a time '
  '(idx_lead_import_runs_one_running_per_source).';

COMMENT ON COLUMN public.lead_import_runs.user_id IS
  'The user whose leads this run imports — always lead_import_sources.'
  'user_id, never the requesting admin and never client-supplied.';

COMMENT ON COLUMN public.lead_import_runs.failed_count IS
  'Eligible (valid NEW/UPDATE) source rows that were NOT applied: every '
  'eligible row when the apply transaction rolled back, or the individual '
  'rows the upsert''s source_updated_at guard rejected because a '
  'concurrent writer had already stored an equal-or-newer version.';

COMMENT ON COLUMN public.lead_import_runs.source_max_updated_at IS
  'MAX of the validly parsed source updated_at values observed in this '
  'run''s full-sheet read. Recorded for history/diagnostics only — never '
  'used to filter which sheet rows a later run scans.';

COMMENT ON TABLE public.lead_import_run_rows IS
  'One audit record per source sheet row per import run: how the row was '
  'classified and what actually happened to it. Deliberately stores NO '
  'sheet `notes` and no copy of the lead payload — the canonical imported '
  'state lives in item_leads.';

COMMENT ON COLUMN public.lead_import_run_rows.issue_message IS
  'Short, code-derived explanation from src/lib/leadImport/validate.ts. '
  'Never sheet `notes` content.';
