-- GT Lead Log import — Phase 1, Part 1: lead_import_sources
--
-- One row per Guitar Tracker user's Google Sheet "GT Lead Log". Multi-user
-- from day one: each app_users row may configure its own spreadsheet, all
-- read by a single Google service account (the spreadsheet owner shares it
-- with that service account as Viewer — see src/lib/leadImport/
-- googleSheets.ts). No Google credentials are ever stored here — only the
-- per-user spreadsheet/source configuration itself.
--
-- Ownership: user_id is authoritative and is never inferred from the sheet
-- content — see item_leads' own header for why. Configuration is
-- admin-managed only (this app has no per-user self-service import setup
-- yet); RLS below lets an owner SELECT their own row (harmless visibility)
-- but restricts INSERT/UPDATE to get_app_user_is_admin(), mirroring the
-- brands/deal_channels admin-authorization convention already used by
-- 20260610000000_admin_support.sql.

-- ─── 1. Table ───────────────────────────────────────────────────────────────

CREATE TABLE public.lead_import_sources (
  id                            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  user_id                       int         NOT NULL REFERENCES public.app_users(id),

  source_code                   text        NOT NULL,
  source_name                   text        NOT NULL,
  provider                      text        NOT NULL,

  spreadsheet_id                text        NOT NULL,
  sheet_name                    text        NOT NULL DEFAULT 'Leads',
  is_enabled                    boolean     NOT NULL DEFAULT true,

  last_successful_import_at     timestamptz,
  last_source_updated_at_seen   timestamptz,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  -- v1 only ever writes one fixed (source_code, provider) pair — CHECK
  -- rather than a lookup table, matching this project's text+CHECK
  -- convention (no enum types) for small closed vocabularies.
  CONSTRAINT lead_import_sources_source_code_check CHECK (source_code = 'GT_LEAD_LOG'),
  CONSTRAINT lead_import_sources_provider_check     CHECK (provider = 'GOOGLE_SHEETS'),

  CONSTRAINT lead_import_sources_source_name_check   CHECK (btrim(source_name) <> ''),
  CONSTRAINT lead_import_sources_spreadsheet_id_check CHECK (btrim(spreadsheet_id) <> ''),
  CONSTRAINT lead_import_sources_sheet_name_check    CHECK (btrim(sheet_name) <> ''),

  -- One GT_LEAD_LOG source per user for now (Part 2 of the task spec).
  CONSTRAINT lead_import_sources_user_source_unique UNIQUE (user_id, source_code),

  -- Lets item_leads' composite ownership FK below pin (source_id, user_id)
  -- together, so a lead row can never reference a source belonging to a
  -- different user than the lead itself claims.
  CONSTRAINT lead_import_sources_id_user_unique UNIQUE (id, user_id)
);

-- ─── 2. updated_at maintenance (mirrors analytics_run_advice's own trigger) ──

CREATE OR REPLACE FUNCTION public.set_lead_import_sources_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lead_import_sources_updated_at
  BEFORE UPDATE ON public.lead_import_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.set_lead_import_sources_updated_at();

-- ─── 3. Row-level security ──────────────────────────────────────────────────

ALTER TABLE public.lead_import_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_import_sources: select own or admin"
  ON public.lead_import_sources FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id() OR public.get_app_user_is_admin());

CREATE POLICY "lead_import_sources: admin insert"
  ON public.lead_import_sources FOR INSERT TO authenticated
  WITH CHECK (public.get_app_user_is_admin());

CREATE POLICY "lead_import_sources: admin update"
  ON public.lead_import_sources FOR UPDATE TO authenticated
  USING  (public.get_app_user_is_admin())
  WITH CHECK (public.get_app_user_is_admin());

-- No DELETE policy — deactivate via is_enabled instead of deleting.

-- ─── 4. Grants ──────────────────────────────────────────────────────────────
-- This project's ambient default privileges grant anon/authenticated full
-- CRUD on every new table regardless of migration-local GRANTs (see
-- 20260729000000_analytics_runs_grant_hardening.sql's own discovery) — so
-- both layers (table privilege AND RLS policy) must independently restrict
-- writes from day one here, not as a follow-up correction.

REVOKE ALL PRIVILEGES ON public.lead_import_sources FROM anon;
REVOKE ALL PRIVILEGES ON public.lead_import_sources FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON public.lead_import_sources TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_import_sources TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.lead_import_sources_id_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.lead_import_sources_id_seq FROM authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.lead_import_sources_id_seq TO authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.lead_import_sources_id_seq TO service_role;

GRANT EXECUTE ON FUNCTION public.set_lead_import_sources_updated_at() TO authenticated, service_role;

-- ─── 5. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.lead_import_sources IS
  'Per-user Google Sheet "GT Lead Log" source configuration. One row per '
  '(user_id, source_code) — v1 always source_code=''GT_LEAD_LOG'', '
  'provider=''GOOGLE_SHEETS''. Never stores Google credentials — only the '
  'spreadsheet_id/sheet_name to read. user_id is authoritative and is never '
  'derived from the sheet content. Admin-managed only (RLS restricts '
  'INSERT/UPDATE to get_app_user_is_admin()).';

COMMENT ON COLUMN public.lead_import_sources.spreadsheet_id IS
  'Canonicalized Google Sheets spreadsheet ID (never a full URL) — see '
  'extractSpreadsheetId() in src/lib/leadImport/googleSheets.ts.';

COMMENT ON COLUMN public.lead_import_sources.last_source_updated_at_seen IS
  'Informational/future-optimization only — the maximum source '
  'updated_at observed across the last Preview/import. Never used to '
  'exclude sheet rows from a Preview scan (Phase 1 always does a full-sheet '
  'scan); see src/lib/leadImport/preview.ts.';
