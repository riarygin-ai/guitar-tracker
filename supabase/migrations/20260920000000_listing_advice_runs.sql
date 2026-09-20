-- listing_advice_runs
--
-- Persisted AI "Listing Advice" for /listings. One row per generation
-- ATTEMPT. Deliberately NOT part of analytics_run_advice: that table is
-- keyed to a saved analytics run snapshot; Listing Advice interprets the
-- CURRENT compact Listing Demand context and is refreshed manually and
-- independently of any Analytics Run. It reuses the same conventions
-- (status lifecycle CHECK, service-role-only writes, own-read RLS,
-- audit-field immutability, sanitized errors) without the run FK/revision
-- machinery.
--
-- Lifecycle: 'generating' (row inserted WITH its immutable input packet +
-- hash, BEFORE the model is called) -> 'completed' | 'failed'. A completed
-- or failed row never changes again. The latest completed advice for a user
-- is resolved deterministically: ORDER BY generated_at DESC, id DESC.
--
-- Concurrency: at most ONE 'generating' row per user (partial unique
-- index). A second simultaneous generation attempt fails the insert and the
-- server reports "already generating" — no duplicate model call. A crashed
-- server can leave a 'generating' row behind; the generator marks such rows
-- (older than 10 minutes) failed before inserting a new one.

CREATE TABLE public.listing_advice_runs (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  user_id           int         NOT NULL REFERENCES public.app_users(id),
  status            text        NOT NULL DEFAULT 'generating',

  provider          text        NOT NULL,
  model             text        NOT NULL,
  schema_version    text        NOT NULL,
  prompt_version    text        NOT NULL,

  -- The 4-week evidence window the advice interprets (also inside the packet).
  window_start      date        NOT NULL,
  window_end        date        NOT NULL,

  input_hash        text        NOT NULL,
  input_packet      jsonb       NOT NULL,
  output            jsonb,

  generated_at      timestamptz,
  error_code        text,
  error_message     text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT listing_advice_runs_status_check
    CHECK (status IN ('generating', 'completed', 'failed')),
  CONSTRAINT listing_advice_runs_provider_check CHECK (btrim(provider) <> ''),
  CONSTRAINT listing_advice_runs_model_check CHECK (btrim(model) <> ''),
  CONSTRAINT listing_advice_runs_schema_version_check CHECK (btrim(schema_version) <> ''),
  CONSTRAINT listing_advice_runs_prompt_version_check CHECK (btrim(prompt_version) <> ''),
  CONSTRAINT listing_advice_runs_input_hash_check CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT listing_advice_runs_window_check CHECK (window_start <= window_end),

  -- Status/field shape (mirrors analytics_run_advice):
  --   generating — packet+hash present, no output/generated_at/error.
  --   completed  — output + generated_at required, no error.
  --   failed     — error_code + error_message required, no output/generated_at.
  CONSTRAINT listing_advice_runs_status_fields_check
    CHECK (
      CASE status
        WHEN 'generating' THEN output IS NULL AND generated_at IS NULL AND error_code IS NULL AND error_message IS NULL
        WHEN 'completed'  THEN output IS NOT NULL AND generated_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL
        WHEN 'failed'     THEN output IS NULL AND generated_at IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL
        ELSE false
      END
    )
);

-- At most one in-flight generation per user (the concurrency guard).
CREATE UNIQUE INDEX uq_listing_advice_runs_one_generating_per_user
  ON public.listing_advice_runs (user_id)
  WHERE status = 'generating';

-- Deterministic "latest completed" lookup and recency listing.
CREATE INDEX idx_listing_advice_runs_user_completed
  ON public.listing_advice_runs (user_id, generated_at DESC, id DESC)
  WHERE status = 'completed';
CREATE INDEX idx_listing_advice_runs_user_created_at
  ON public.listing_advice_runs (user_id, created_at DESC);

-- ─── updated_at ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_listing_advice_runs_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_advice_runs_updated_at
  BEFORE UPDATE ON public.listing_advice_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_listing_advice_runs_updated_at();

-- ─── Immutability ───────────────────────────────────────────────────────────
-- Identity/audit fields never change after insert; a completed or failed row
-- is frozen entirely. The only legal UPDATE is generating -> completed|failed.

CREATE OR REPLACE FUNCTION public.enforce_listing_advice_runs_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'listing_advice_runs row % is % and cannot be modified', OLD.id, OLD.status;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
     OR NEW.window_start IS DISTINCT FROM OLD.window_start
     OR NEW.window_end IS DISTINCT FROM OLD.window_end
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.input_packet IS DISTINCT FROM OLD.input_packet
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'listing_advice_runs audit fields (identity, versions, window, input packet/hash) are immutable (row id %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_advice_runs_immutability
  BEFORE UPDATE ON public.listing_advice_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_advice_runs_immutability();

-- ─── RLS + grants (same shape as analytics_run_advice) ─────────────────────
-- Owner may SELECT their own rows. No authenticated INSERT/UPDATE/DELETE
-- policy or grant at all — generation is entirely server-side (service_role).

ALTER TABLE public.listing_advice_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "listing_advice_runs: select own"
  ON public.listing_advice_runs FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

REVOKE ALL PRIVILEGES ON public.listing_advice_runs FROM anon;
REVOKE ALL PRIVILEGES ON public.listing_advice_runs FROM authenticated;
GRANT SELECT ON public.listing_advice_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.listing_advice_runs TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.listing_advice_runs_id_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.listing_advice_runs_id_seq FROM authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.listing_advice_runs_id_seq TO service_role;

GRANT EXECUTE ON FUNCTION public.set_listing_advice_runs_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_listing_advice_runs_immutability() TO service_role;

COMMENT ON TABLE public.listing_advice_runs IS
  'Persisted AI Listing Advice (/listings). One row per generation attempt, '
  'independent of analytics runs. input_packet/input_hash are stored at '
  'insert (before the model call) and immutable; completed/failed rows are '
  'frozen. One in-flight (generating) row per user. Own-read RLS; all '
  'writes are service_role only.';
COMMENT ON COLUMN public.listing_advice_runs.input_packet IS
  'The exact compact Listing Advice Input Packet sent to the model (4-week '
  'Listing Demand context, closed allowed_source_ids, semantics reminders). '
  'Never contains raw leads, lead ids, notes or buyer data.';
COMMENT ON COLUMN public.listing_advice_runs.output IS
  'Exact validated structured model response (schema_version, cards[]) — '
  'present only once status = completed.';
