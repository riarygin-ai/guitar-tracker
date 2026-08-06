-- analytics_run_advice
--
-- Auditable AI Advice v1.0. One row per AI-advice generation ATTEMPT for an
-- existing, immutable public.analytics_runs row — never a second run-
-- history table, never a duplicate snapshot store. The authoritative
-- snapshot remains exclusively in analytics_runs.snapshot; this table adds
-- only a compact, versioned interpretation layer on top of it, keyed by
-- analytics_run_id, with its own independent revision history.
--
-- ── WHY A NEW TABLE, NOT A NEW COLUMN ON analytics_runs ────────────────────
-- analytics_runs rows are immutable once completed (see
-- 20260727000000_analytics_runs.sql's own status/field-presence CHECK
-- constraints) and analytics_runs itself has no authenticated write path at
-- all. AI advice must support retries and revisions (pending -> generating
-- -> completed|failed, and a fresh revision on every regenerate) without
-- ever touching the analytics_runs row it interprets — a single nullable
-- column could not represent "3 attempts, 2 failed, 1 completed" for one
-- run. A separate table with its own revision_number keeps every attempt,
-- immutable once completed, exactly like the run it's attached to.
--
-- ── OWNERSHIP MODEL (mirrors analytics_runs exactly — see that file's own
-- header) ────────────────────────────────────────────────────────────────
-- user_id is a DENORMALIZED copy of the parent run's
-- recommendation_target_user_id, always set server-side to the same value
-- (never client-suppliable, never independently chosen) — this keeps RLS a
-- single indexed column comparison instead of an EXISTS subquery into
-- analytics_runs on every read, while remaining impossible to point at a
-- run the row doesn't actually belong to in practice (the server always
-- derives both from the same authenticated caller in the same request).
--
-- ── WHAT THIS TABLE DOES NOT STORE ──────────────────────────────────────
-- No copy of analytics_runs.snapshot, and no full Raw Snapshot. source_refs
-- is the same small, closed source registry (headline/summary/key metrics/
-- limitations per allowed source_id) already built to construct the advice
-- input packet and to validate the model's response — not a re-export of
-- the run's evidence.

-- ─── 1. analytics_run_advice table ─────────────────────────────────────────

CREATE TABLE public.analytics_run_advice (
  id                        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  analytics_run_id          bigint      NOT NULL
                                         REFERENCES public.analytics_runs(id) ON DELETE CASCADE,
  user_id                   int         NOT NULL
                                         REFERENCES public.app_users(id),

  revision_number           int         NOT NULL DEFAULT 1,
  status                    text        NOT NULL DEFAULT 'pending',

  provider                  text        NOT NULL,
  model                     text        NOT NULL,
  advice_schema_version     text        NOT NULL,
  prompt_template_version   text        NOT NULL,

  canonical_input_hash      text,
  advice                    jsonb,
  source_refs               jsonb,

  generated_at              timestamptz,
  error_code                text,
  error_message             text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- ── Simple, always-applicable checks ──────────────────────────────────
  CONSTRAINT analytics_run_advice_status_check
    CHECK (status IN ('pending', 'generating', 'completed', 'failed')),

  CONSTRAINT analytics_run_advice_revision_number_check
    CHECK (revision_number >= 1),

  CONSTRAINT analytics_run_advice_provider_check
    CHECK (btrim(provider) <> ''),

  CONSTRAINT analytics_run_advice_model_check
    CHECK (btrim(model) <> ''),

  CONSTRAINT analytics_run_advice_advice_schema_version_check
    CHECK (btrim(advice_schema_version) <> ''),

  CONSTRAINT analytics_run_advice_prompt_template_version_check
    CHECK (btrim(prompt_template_version) <> ''),

  -- ── One revision number per run ───────────────────────────────────────
  CONSTRAINT analytics_run_advice_run_revision_unique
    UNIQUE (analytics_run_id, revision_number),

  -- ── Status lifecycle shape (mirrors analytics_runs' own convention) ────
  --   pending    — row created, packet not yet built: no hash, no advice,
  --                no generated_at, no error.
  --   generating — canonical input packet built and hashed, OpenAI call in
  --                flight: hash required, advice/generated_at/error still
  --                unset.
  --   completed  — finished successfully: hash + advice + source_refs +
  --                generated_at all required, error forbidden.
  --   failed     — finished unsuccessfully: error_code + error_message
  --                required, advice/generated_at forbidden. hash is
  --                intentionally UNCONSTRAINED here — generation can fail
  --                before the packet was ever built (hash still NULL) or
  --                after (hash already set), and both are legitimate.
  CONSTRAINT analytics_run_advice_status_fields_check
    CHECK (
      CASE status
        WHEN 'pending' THEN
          canonical_input_hash IS NULL AND advice IS NULL AND source_refs IS NULL
          AND generated_at IS NULL AND error_code IS NULL AND error_message IS NULL
        WHEN 'generating' THEN
          canonical_input_hash IS NOT NULL AND advice IS NULL AND source_refs IS NULL
          AND generated_at IS NULL AND error_code IS NULL AND error_message IS NULL
        WHEN 'completed' THEN
          canonical_input_hash IS NOT NULL AND advice IS NOT NULL AND source_refs IS NOT NULL
          AND generated_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL
        WHEN 'failed' THEN
          advice IS NULL AND source_refs IS NULL AND generated_at IS NULL
          AND error_code IS NOT NULL AND error_message IS NOT NULL
        ELSE false
      END
    )
);

-- ─── 2. updated_at maintenance ──────────────────────────────────────────────
-- Every status transition is a server-side UPDATE (never a client write —
-- see grants/RLS below) — a trigger keeps updated_at honest without every
-- call site having to remember to set it.

CREATE OR REPLACE FUNCTION public.set_analytics_run_advice_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_analytics_run_advice_updated_at
  BEFORE UPDATE ON public.analytics_run_advice
  FOR EACH ROW
  EXECUTE FUNCTION public.set_analytics_run_advice_updated_at();

-- ─── 3. Indexes ─────────────────────────────────────────────────────────────
-- analytics_run_id alone, and (analytics_run_id, revision_number), are both
-- served by the UNIQUE constraint above (leading-column + composite) — no
-- separate index needed for either. Added here: owner+recency (History/
-- Dashboard "latest for this user" lookups, mirrors analytics_runs' own
-- idx_analytics_runs_target_created_at) and status (cheap filtering, e.g.
-- "any generating/failed rows stuck" diagnostics).

CREATE INDEX idx_analytics_run_advice_user_created_at
  ON public.analytics_run_advice (user_id, created_at DESC);

CREATE INDEX idx_analytics_run_advice_status
  ON public.analytics_run_advice (status);

-- ─── 4. Row-level security ──────────────────────────────────────────────────
-- Same shape as analytics_runs: SELECT only, gated on user_id alone. No
-- INSERT/UPDATE/DELETE policy for `authenticated` at all — generation runs
-- entirely server-side (service_role), matching "Advice generation must
-- execute server-side" and analytics_runs' own no-authenticated-write
-- precedent exactly.

ALTER TABLE public.analytics_run_advice ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytics_run_advice: select own"
  ON public.analytics_run_advice FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── 5. Grants ──────────────────────────────────────────────────────────────
-- This project's ambient default privileges grant anon/authenticated full
-- CRUD on every new table regardless of migration-local GRANTs (see
-- 20260729000000_analytics_runs_grant_hardening.sql's own discovery) — so
-- both layers (table privilege AND RLS policy) must independently deny
-- writes from day one here, not as a follow-up correction.

REVOKE ALL PRIVILEGES ON public.analytics_run_advice FROM anon;
REVOKE ALL PRIVILEGES ON public.analytics_run_advice FROM authenticated;

GRANT SELECT ON public.analytics_run_advice TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_run_advice TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.analytics_run_advice_id_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.analytics_run_advice_id_seq FROM authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.analytics_run_advice_id_seq TO service_role;

GRANT EXECUTE ON FUNCTION public.set_analytics_run_advice_updated_at() TO service_role;

-- ─── 6. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.analytics_run_advice IS
  'One row per AI-advice generation attempt for an existing, immutable '
  'analytics_runs row. Never a second run-history table and never a copy '
  'of analytics_runs.snapshot — the authoritative snapshot stays exclusively '
  'in analytics_runs. A run may have multiple revisions (retries/'
  'regenerations); a completed or failed row is never overwritten — retry '
  'always inserts revision_number + 1. Read access (RLS) is gated on '
  'user_id alone, a denormalized copy of the parent run''s '
  'recommendation_target_user_id. All writes are server-side (service_role) '
  '— no authenticated write policy or grant exists.';

COMMENT ON COLUMN public.analytics_run_advice.analytics_run_id IS
  'FK to the existing analytics_runs table (never a new/duplicate run-'
  'history store). The advice generator loads analytics_runs.snapshot by '
  'this id and must never substitute current live inventory data or the '
  'newest run for an older run''s advice.';

COMMENT ON COLUMN public.analytics_run_advice.user_id IS
  'app_users.id — denormalized from the parent run''s '
  'recommendation_target_user_id at write time, always server-derived from '
  'the authenticated caller, never client-suppliable. Controls read access '
  'via RLS.';

COMMENT ON COLUMN public.analytics_run_advice.revision_number IS
  'Starts at 1 for the first generation attempt on a run; a Retry/'
  'Regenerate always inserts revision_number + 1 rather than overwriting a '
  'prior row. Unique per (analytics_run_id, revision_number).';

COMMENT ON COLUMN public.analytics_run_advice.canonical_input_hash IS
  'SHA-256 (hex) of the deterministic canonical JSON representation of the '
  'Advice Input Packet built from this run''s saved snapshot — lets a '
  'reader verify the saved advice corresponds to the exact packet derived '
  'from that saved run. Set once the packet is built (status = generating '
  'or later); never recomputed after.';

COMMENT ON COLUMN public.analytics_run_advice.advice IS
  'Exact validated structured AI response (schema_version, run_summary, '
  'advice_cards[], limitations) — present only once status = completed, '
  'and never mutated afterward.';

COMMENT ON COLUMN public.analytics_run_advice.source_refs IS
  'The closed source registry (source_id, source_type, and the compact '
  'presentation fields — headline/summary/confidence/key metrics/'
  'limitations) that every advice_cards[].source_ids value was validated '
  'against — NOT a copy of the full run snapshot. Present only once status '
  '= completed.';

COMMENT ON COLUMN public.analytics_run_advice.error_code IS
  'Short machine-readable failure category (e.g. NO_VALID_EVIDENCE, '
  'OPENAI_ERROR, INVALID_RESPONSE, SOURCE_VALIDATION_FAILED) — populated '
  'only when status = failed.';

COMMENT ON COLUMN public.analytics_run_advice.error_message IS
  'Sanitized, human-readable failure detail — populated only when status = '
  'failed. Never contains API keys, tokens, or connection strings (see '
  'sanitizeErrorMessage in src/lib/analytics/runAnalytics.ts, reused for '
  'this table''s writes).';
