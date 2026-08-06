-- analytics_run_advice hardening
--
-- Forward-only follow-up to 20260825000000_analytics_run_advice.sql (that
-- migration is NOT modified — it has already been applied). Three
-- independent hardenings, verified against the ACTUAL applied schema
-- before writing this file (via `docker exec ... psql -c '\d ...'` against
-- a local reset):
--   1. Database-level owner-consistency guarantee between
--      analytics_run_advice.user_id and its parent analytics_runs row —
--      today user_id is merely a denormalized COPY, trusted but not
--      enforced.
--   2. Persist the exact Advice Input Packet used for each revision
--      (input_packet jsonb), and make every audit-trail column immutable
--      after insertion (aside from the one legitimate NULL -> value
--      transition canonical_input_hash/input_packet make when a revision
--      moves from pending to generating).
--   3. Atomic, race-free revision-number allocation via a SECURITY
--      DEFINER RPC using a per-run advisory transaction lock, replacing
--      the application-level read-max-then-insert pattern.
--
-- CONFIRMED SCHEMA FACTS THIS MIGRATION DEPENDS ON (re-verified against
-- the live local database before writing any DDL below — see the
-- accompanying session's own psql \d output):
--   - public.analytics_runs has NO `user_id` column. Its authoritative
--     owner column is `recommendation_target_user_id` (int, NOT NULL,
--     already indexed via idx_analytics_runs_target_created_at, already
--     the sole column analytics_runs' own RLS policy checks). This
--     migration uses that exact column name throughout — never a
--     nonexistent `analytics_runs.user_id`.
--   - public.analytics_run_advice.analytics_run_id (bigint) currently has
--     its own single-column FK, auto-named
--     analytics_run_advice_analytics_run_id_fkey, referencing
--     analytics_runs(id) ON DELETE CASCADE.
--   - public.analytics_run_advice.user_id (int) currently has its own
--     single-column FK, auto-named analytics_run_advice_user_id_fkey,
--     referencing app_users(id) — this one is UNTOUCHED below, per the
--     task's own "preserve the app_users FK for user_id" instruction.
--   - analytics_runs.id is already the PRIMARY KEY (globally unique on
--     its own); no UNIQUE constraint on (id, recommendation_target_user_id)
--     exists yet — required before a composite FK can reference it.

-- ════════════════════════════════════════════════════════════════════════
-- PART 1 — composite ownership FK (mandatory) + RLS defense-in-depth
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1a. Reconcile any existing mismatched rows first ──────────────────────
-- On a fresh install (confirmed: 0 rows in analytics_run_advice at the
-- point this migration was authored) this is a no-op. On any environment
-- with existing rows, analytics_runs.recommendation_target_user_id is
-- authoritative — user_id was always SUPPOSED to be a same-request copy of
-- it (see 20260825000000's own header), so correcting a stale/incorrect
-- copy to match its real parent is safe and lossless (it does not change
-- what the row's advice content says, only which user account it is
-- attributed to, to match the row it was actually generated from).

DO $$
DECLARE
  v_mismatched_count int;
BEGIN
  SELECT count(*) INTO v_mismatched_count
  FROM public.analytics_run_advice a
  JOIN public.analytics_runs r ON r.id = a.analytics_run_id
  WHERE a.user_id IS DISTINCT FROM r.recommendation_target_user_id;

  IF v_mismatched_count > 0 THEN
    RAISE NOTICE 'analytics_run_advice_hardening: reconciling % row(s) whose user_id did not match their parent run''s recommendation_target_user_id (analytics_runs.recommendation_target_user_id is authoritative).', v_mismatched_count;

    UPDATE public.analytics_run_advice a
    SET user_id = r.recommendation_target_user_id
    FROM public.analytics_runs r
    WHERE r.id = a.analytics_run_id
      AND a.user_id IS DISTINCT FROM r.recommendation_target_user_id;
  END IF;
END $$;

-- ─── 1b. Fail loudly rather than silently if reconciliation is impossible ──
-- Every analytics_run_advice.analytics_run_id already has a NOT NULL,
-- validated single-column FK into analytics_runs(id) today, so an orphan
-- should be structurally impossible — this is a defensive check, not an
-- expected code path, run AFTER 1a so it only fires if something is
-- genuinely unreconcilable (e.g. a row whose analytics_run_id is somehow
-- not resolvable at all).

DO $$
DECLARE
  v_orphan_count int;
BEGIN
  SELECT count(*) INTO v_orphan_count
  FROM public.analytics_run_advice a
  LEFT JOIN public.analytics_runs r ON r.id = a.analytics_run_id
  WHERE r.id IS NULL;

  IF v_orphan_count > 0 THEN
    RAISE EXCEPTION 'analytics_run_advice_hardening: % analytics_run_advice row(s) reference a nonexistent analytics_run_id — cannot safely add the composite ownership FK. Investigate and fix manually before re-running this migration.', v_orphan_count;
  END IF;
END $$;

-- ─── 1c. Composite unique constraint analytics_runs(id, recommendation_
-- target_user_id) — required so a composite FK can reference it. Cheap and
-- safe: id alone is already the primary key (already globally unique), so
-- this composite is trivially satisfiable by every existing row. ─────────

ALTER TABLE public.analytics_runs
  ADD CONSTRAINT analytics_runs_id_target_user_unique
  UNIQUE (id, recommendation_target_user_id);

-- ─── 1d. Drop the now-redundant single-column analytics_run_id FK ──────────
-- The composite FK added in 1e already validates that analytics_run_id
-- corresponds to a real analytics_runs.id (a composite FK requires EVERY
-- referenced column, including analytics_run_id, to match one real row) —
-- keeping both would be pure redundancy, not additional safety, so this
-- is the "cleanest non-redundant schema design" the task asks for.

ALTER TABLE public.analytics_run_advice
  DROP CONSTRAINT analytics_run_advice_analytics_run_id_fkey;

-- ─── 1e. The mandatory composite ownership FK ──────────────────────────────
-- From this point on, INSERT/UPDATE of analytics_run_advice.user_id +
-- analytics_run_id is REJECTED by Postgres itself unless that exact pair
-- matches a real analytics_runs row — the database now guarantees what
-- was previously only an application-level convention.

ALTER TABLE public.analytics_run_advice
  ADD CONSTRAINT analytics_run_advice_run_owner_fkey
  FOREIGN KEY (analytics_run_id, user_id)
  REFERENCES public.analytics_runs(id, recommendation_target_user_id)
  ON DELETE CASCADE;

-- ─── 1f. RLS defense-in-depth ───────────────────────────────────────────
-- The composite FK above already guarantees user_id can never diverge from
-- the parent run's true owner for any row that exists in the table at all
-- — so this EXISTS re-check is intentionally redundant with that
-- guarantee, not a replacement for it. It protects against a narrower
-- future risk: a privileged, RLS-bypassing write path (service_role, or a
-- future migration) that sets user_id correctly at insert time per the FK,
-- but where a reader's assumption about "user_id already proves ownership"
-- would otherwise be the ONLY check. Implemented as a plain EXISTS against
-- analytics_runs' own primary key + owner column (both already indexed);
-- analytics_runs' OWN RLS policy is untouched and unaffected — this
-- subquery runs as the same `authenticated` role already subject to that
-- policy, so it never bypasses or weakens it.

DROP POLICY "analytics_run_advice: select own" ON public.analytics_run_advice;

CREATE POLICY "analytics_run_advice: select own"
  ON public.analytics_run_advice FOR SELECT TO authenticated
  USING (
    user_id = public.get_app_user_id()
    AND EXISTS (
      SELECT 1 FROM public.analytics_runs r
      WHERE r.id = analytics_run_advice.analytics_run_id
        AND r.recommendation_target_user_id = public.get_app_user_id()
    )
  );

COMMENT ON CONSTRAINT analytics_run_advice_run_owner_fkey ON public.analytics_run_advice IS
  'Composite FK guaranteeing (analytics_run_id, user_id) always matches a '
  'real analytics_runs row''s (id, recommendation_target_user_id) — the '
  'database, not just application code, now enforces that an advice row''s '
  'owner can never diverge from its parent run''s true owner. Supersedes '
  'the single-column analytics_run_id FK this table was created with '
  '(dropped above as redundant, not as a safety reduction).';

-- ════════════════════════════════════════════════════════════════════════
-- PART 2 — input_packet persistence + audit-field immutability
-- ════════════════════════════════════════════════════════════════════════

-- ─── 2a. input_packet column ────────────────────────────────────────────
-- Nullable: existing rows created before this migration (if any) predate
-- this column and cannot have their exact historical packet reconstructed
-- byte-for-byte after the fact (the packet depends on evidence extraction
-- logic that may since have changed) — they keep input_packet = NULL
-- permanently rather than being backfilled with an approximation that
-- could misrepresent what was actually sent to OpenAI. Every ROW CREATED
-- FROM THIS MIGRATION FORWARD populates it (enforced at the application
-- layer in generateAdvice.ts, which sets it in the same UPDATE that sets
-- canonical_input_hash).

ALTER TABLE public.analytics_run_advice
  ADD COLUMN input_packet jsonb;

COMMENT ON COLUMN public.analytics_run_advice.input_packet IS
  'The EXACT Advice Input Packet built for this revision — the same '
  'object canonical_input_hash was computed from and the same one sent to '
  'OpenAI, never reconstructed differently later. NULL only for rows '
  'created before this column existed (see migration comment); every row '
  'created afterward always populates it once status reaches ''generating'' '
  'or later. Contains run metadata/versions, deterministic_insights, '
  'confirmed_patterns, preliminary_hypotheses, pattern_selection_summary, '
  'and allowed_source_ids ONLY — never the full snapshot, never '
  'rule_evaluations/candidate_evaluations, never secrets.';

-- ─── 2b. Audit-field immutability ───────────────────────────────────────
-- analytics_run_id/user_id/revision_number/provider/model/advice_schema_
-- version/prompt_template_version are all set once, at INSERT, and never
-- legitimately change afterward — any UPDATE attempting to change one is
-- rejected outright. canonical_input_hash/input_packet start NULL (at
-- 'pending') and are set exactly once during the pending -> generating
-- transition — that single NULL -> value write is allowed; any further
-- change after they are first set is rejected, same as the other fields.

CREATE OR REPLACE FUNCTION public.enforce_analytics_run_advice_audit_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.analytics_run_id IS DISTINCT FROM OLD.analytics_run_id THEN
    RAISE EXCEPTION 'analytics_run_advice.analytics_run_id is immutable after insert (row id %)', OLD.id;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'analytics_run_advice.user_id is immutable after insert (row id %)', OLD.id;
  END IF;
  IF NEW.revision_number IS DISTINCT FROM OLD.revision_number THEN
    RAISE EXCEPTION 'analytics_run_advice.revision_number is immutable after insert (row id %)', OLD.id;
  END IF;
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'analytics_run_advice.provider is immutable after insert (row id %)', OLD.id;
  END IF;
  IF NEW.model IS DISTINCT FROM OLD.model THEN
    RAISE EXCEPTION 'analytics_run_advice.model is immutable after insert (row id %)', OLD.id;
  END IF;
  IF NEW.advice_schema_version IS DISTINCT FROM OLD.advice_schema_version THEN
    RAISE EXCEPTION 'analytics_run_advice.advice_schema_version is immutable after insert (row id %)', OLD.id;
  END IF;
  IF NEW.prompt_template_version IS DISTINCT FROM OLD.prompt_template_version THEN
    RAISE EXCEPTION 'analytics_run_advice.prompt_template_version is immutable after insert (row id %)', OLD.id;
  END IF;
  IF OLD.canonical_input_hash IS NOT NULL AND NEW.canonical_input_hash IS DISTINCT FROM OLD.canonical_input_hash THEN
    RAISE EXCEPTION 'analytics_run_advice.canonical_input_hash cannot change once set (row id %)', OLD.id;
  END IF;
  IF OLD.input_packet IS NOT NULL AND NEW.input_packet IS DISTINCT FROM OLD.input_packet THEN
    RAISE EXCEPTION 'analytics_run_advice.input_packet cannot change once set (row id %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_analytics_run_advice_audit_immutability
  BEFORE UPDATE ON public.analytics_run_advice
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_analytics_run_advice_audit_immutability();

COMMENT ON FUNCTION public.enforce_analytics_run_advice_audit_immutability() IS
  'BEFORE UPDATE guard: rejects any change to analytics_run_id/user_id/'
  'revision_number/provider/model/advice_schema_version/prompt_template_'
  'version once set at insert, and rejects any change to '
  'canonical_input_hash/input_packet once first populated (the single '
  'legitimate NULL -> value write during the pending -> generating '
  'transition remains allowed). status/advice/source_refs/generated_at/'
  'error_code/error_message/updated_at remain freely updatable by the '
  'existing generation lifecycle.';

GRANT EXECUTE ON FUNCTION public.enforce_analytics_run_advice_audit_immutability() TO service_role;

-- ════════════════════════════════════════════════════════════════════════
-- PART 3 — atomic, race-free revision allocation
-- ════════════════════════════════════════════════════════════════════════
-- Replaces the application-level "SELECT MAX(revision_number) ... then
-- INSERT" pattern (a genuine TOCTOU race under concurrent requests) with a
-- single SECURITY DEFINER function that takes a per-run PostgreSQL
-- advisory TRANSACTION lock before reading or writing anything — a second
-- concurrent call for the SAME analytics_run_id blocks until the first
-- call's transaction commits or rolls back (the lock releases
-- automatically at transaction end), then proceeds with a fully
-- up-to-date view of existing revisions. This is the ONLY advisory-lock
-- usage in this schema, so using the bare run id (bigint) as the lock key
-- is unambiguous — no separate namespace/classid is needed.
--
-- service_role-only (never callable by `authenticated`/`anon` directly) —
-- ownership/run-completion validation happens INSIDE this function using
-- caller-supplied p_user_id, exactly mirroring how the existing
-- build_analytics_snapshot_v2_13 RPC and this table's own INSERT path are
-- already service_role-only, with the caller's identity resolved
-- server-side before ever reaching the database.

CREATE OR REPLACE FUNCTION public.claim_next_analytics_run_advice_revision(
  p_analytics_run_id bigint,
  p_user_id int,
  p_mode text,
  p_provider text,
  p_model text,
  p_advice_schema_version text,
  p_prompt_template_version text
)
RETURNS TABLE (
  id bigint,
  analytics_run_id bigint,
  user_id int,
  revision_number int,
  status text,
  provider text,
  model text,
  advice_schema_version text,
  prompt_template_version text,
  created_at timestamptz,
  updated_at timestamptz,
  was_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_status text;
  v_run_owner int;
  v_existing_id bigint;
  v_next_revision int;
  v_new_id bigint;
BEGIN
  IF p_mode NOT IN ('auto', 'retry') THEN
    RAISE EXCEPTION 'INVALID_MODE: %', p_mode;
  END IF;

  -- Serialized per analytics_run_id — released automatically when this
  -- function's calling transaction ends (commit or rollback).
  PERFORM pg_advisory_xact_lock(p_analytics_run_id);

  SELECT r.status, r.recommendation_target_user_id
    INTO v_run_status, v_run_owner
  FROM public.analytics_runs r
  WHERE r.id = p_analytics_run_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND';
  END IF;
  IF v_run_owner IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'RUN_NOT_OWNED_BY_CALLER';
  END IF;
  IF v_run_status <> 'completed' THEN
    RAISE EXCEPTION 'RUN_NOT_COMPLETED';
  END IF;

  IF p_mode = 'auto' THEN
    -- Idempotent: if ANY revision already exists for this run (whatever
    -- its status), auto mode never creates another — return the current
    -- highest revision instead, flagged was_created = false, so the
    -- caller knows to skip generation rather than start a duplicate.
    SELECT a.id INTO v_existing_id
    FROM public.analytics_run_advice a
    WHERE a.analytics_run_id = p_analytics_run_id
    ORDER BY a.revision_number DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY
      SELECT a.id, a.analytics_run_id, a.user_id, a.revision_number, a.status,
             a.provider, a.model, a.advice_schema_version, a.prompt_template_version,
             a.created_at, a.updated_at, false
      FROM public.analytics_run_advice a
      WHERE a.id = v_existing_id;
      RETURN;
    END IF;

    v_next_revision := 1;
  ELSE
    SELECT COALESCE(MAX(a.revision_number), 0) + 1 INTO v_next_revision
    FROM public.analytics_run_advice a
    WHERE a.analytics_run_id = p_analytics_run_id;
  END IF;

  BEGIN
    INSERT INTO public.analytics_run_advice (
      analytics_run_id, user_id, revision_number, status,
      provider, model, advice_schema_version, prompt_template_version
    ) VALUES (
      p_analytics_run_id, p_user_id, v_next_revision, 'pending',
      p_provider, p_model, p_advice_schema_version, p_prompt_template_version
    )
    RETURNING analytics_run_advice.id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    -- Defensive fallback only — unreachable under the advisory lock above
    -- as long as every caller goes through this function, but kept in
    -- case of a future direct-insert bypass. Returns the row that already
    -- holds this revision number instead of propagating a raw constraint
    -- error to the caller.
    SELECT a.id INTO v_new_id
    FROM public.analytics_run_advice a
    WHERE a.analytics_run_id = p_analytics_run_id
      AND a.revision_number = v_next_revision;

    RETURN QUERY
    SELECT a.id, a.analytics_run_id, a.user_id, a.revision_number, a.status,
           a.provider, a.model, a.advice_schema_version, a.prompt_template_version,
           a.created_at, a.updated_at, false
    FROM public.analytics_run_advice a
    WHERE a.id = v_new_id;
    RETURN;
  END;

  RETURN QUERY
  SELECT a.id, a.analytics_run_id, a.user_id, a.revision_number, a.status,
         a.provider, a.model, a.advice_schema_version, a.prompt_template_version,
         a.created_at, a.updated_at, true
  FROM public.analytics_run_advice a
  WHERE a.id = v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_analytics_run_advice_revision(bigint, int, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_analytics_run_advice_revision(bigint, int, text, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.claim_next_analytics_run_advice_revision(bigint, int, text, text, text, text, text) IS
  'Atomically validates run ownership/completion and allocates (or, for '
  '''auto'' mode when one already exists, returns) the next '
  'analytics_run_advice revision for one run, serialized per '
  'analytics_run_id via pg_advisory_xact_lock — replaces the application-'
  'level read-max-then-insert pattern this table originally shipped with. '
  'service_role only; p_user_id is always the server-resolved '
  'authenticated caller''s own app_users.id, never client-suppliable.';
