-- analytics_advice_dismissals
--
-- Advice Dismissal / Resurface v1. Lets a user hide an individual Advice
-- card from the Dashboard's "Latest Analytics Advice" section for a fixed
-- 30-day suppression window, WITHOUT touching analytics_run_advice at all
-- — that table (and every revision it holds) remains exactly as generated,
-- forever. This table is pure presentation/coach state layered on top.
--
-- ── WHY A NEW TABLE, NOT A COLUMN/FLAG ON analytics_run_advice ────────────
-- analytics_run_advice rows are immutable once completed (see
-- 20260826000000's own audit-immutability trigger) and a single revision
-- can be superseded by a later one that repeats the same semantic advice —
-- "dismissed" is a property of the USER's relationship to a piece of
-- advice across runs, not a property of one revision's row. A flag on the
-- advice row could only ever suppress that one exact row, never the same
-- advice reappearing in next week's revision, and would require mutating
-- an otherwise-immutable audit row to set it.
--
-- ── IDENTITY: advice_key ──────────────────────────────────────────────────
-- Computed by the pure function computeAdviceKey() in
-- src/lib/analytics/advice/adviceKey.ts (imported by both the dismiss API
-- route and the Dashboard) from ONLY: advice_type, item_id, and the sorted
-- set of the card's cited source_ids. Deliberately never the LLM-authored
-- advice_code, headline, advice text, or why_it_matters — those can reword
-- run to run for the same underlying finding (advice_code is confirmed to
-- be a per-response label like "C1"/"C2", never a stable taxonomy code —
-- see ADVICE_JSON_SCHEMA in src/lib/openai.ts and the worked examples in
-- scripts/test-analytics-advice.ts). source_ids, by contrast, are built by
-- buildInputPacket.ts from each deterministic finding/pattern's own
-- finding_code/pattern_code/pattern_key plus its structural segment
-- identity (item_id/band/category/channel/journey) — stable across runs as
-- long as the same underlying condition is still true, independent of any
-- wording. No hash is applied: the key is the canonicalized string itself
-- (advice_type + item_id + a JSON-encoded sorted source_ids array), which
-- keeps the same identity computable with plain JS in both the Node API
-- route and the browser Dashboard bundle without needing a shared crypto
-- primitive, and stays human-inspectable for support/debugging.
--
-- ── OWNERSHIP MODEL (mirrors analytics_run_advice) ────────────────────────
-- user_id is always the server-resolved authenticated caller's own
-- app_users.id (via get_app_user_id() at the RLS layer, and independently
-- resolved server-side in the dismiss API route before ever writing) —
-- never client-suppliable.
--
-- ── WHAT THIS TABLE DOES NOT STORE ────────────────────────────────────────
-- No advice text, headline, source_ids, or any other LLM-authored content
-- — only the derived advice_key string, so a dismissal row on its own
-- reveals nothing about what was actually said.

-- ─── 1. analytics_advice_dismissals table ───────────────────────────────────

CREATE TABLE public.analytics_advice_dismissals (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  user_id           int         NOT NULL
                                 REFERENCES public.app_users(id),
  advice_key        text        NOT NULL,

  dismissed_at      timestamptz NOT NULL DEFAULT now(),
  resurface_after   timestamptz NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT analytics_advice_dismissals_advice_key_check
    CHECK (btrim(advice_key) <> ''),

  -- Fixed v1 resurface policy is always +30 days from dismissed_at — this
  -- doesn't hard-code "exactly 30 days" (a future policy change to the
  -- window shouldn't require a schema change) but does guarantee the
  -- suppression window is always forward-looking relative to the dismissal
  -- it belongs to.
  CONSTRAINT analytics_advice_dismissals_resurface_after_check
    CHECK (resurface_after > dismissed_at),

  -- One suppression row per (user, semantic advice) — a re-dismiss of the
  -- same advice_key after it resurfaced UPDATEs this row (dismissed_at/
  -- resurface_after refreshed) rather than inserting a second row.
  CONSTRAINT analytics_advice_dismissals_user_key_unique
    UNIQUE (user_id, advice_key)
);

CREATE INDEX idx_analytics_advice_dismissals_user_resurface
  ON public.analytics_advice_dismissals (user_id, resurface_after);

-- ─── 2. updated_at maintenance ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_analytics_advice_dismissals_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_analytics_advice_dismissals_updated_at
  BEFORE UPDATE ON public.analytics_advice_dismissals
  FOR EACH ROW
  EXECUTE FUNCTION public.set_analytics_advice_dismissals_updated_at();

-- ─── 3. Row-level security ──────────────────────────────────────────────────
-- SELECT only, gated on user_id alone (own coach state, never another
-- user's) — same shape as analytics_run_advice. The Dashboard reads active
-- dismissals directly through this policy (RLS-scoped, anon/authenticated
-- key). All writes go through the dismiss API route using the service
-- role, exactly like Advice generation's own no-authenticated-write
-- precedent — the client never inserts/updates this table directly, so
-- user_id can never be spoofed from client input.

ALTER TABLE public.analytics_advice_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytics_advice_dismissals: select own"
  ON public.analytics_advice_dismissals FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── 4. Grants ──────────────────────────────────────────────────────────────
-- This project's ambient default privileges grant anon/authenticated full
-- CRUD on every new table regardless of migration-local GRANTs (see
-- 20260729000000_analytics_runs_grant_hardening.sql's own discovery) — so
-- both layers (table privilege AND RLS policy) must independently deny
-- writes from day one here, not as a follow-up correction.

REVOKE ALL PRIVILEGES ON public.analytics_advice_dismissals FROM anon;
REVOKE ALL PRIVILEGES ON public.analytics_advice_dismissals FROM authenticated;

GRANT SELECT ON public.analytics_advice_dismissals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.analytics_advice_dismissals TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.analytics_advice_dismissals_id_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.analytics_advice_dismissals_id_seq FROM authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.analytics_advice_dismissals_id_seq TO service_role;

GRANT EXECUTE ON FUNCTION public.set_analytics_advice_dismissals_updated_at() TO service_role;

-- ─── 5. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.analytics_advice_dismissals IS
  'Per-user Advice coach state for Advice Dismissal / Resurface v1 — hides '
  'an Advice card from the Dashboard for a fixed 30-day window keyed on '
  'its deterministic advice_key (see src/lib/analytics/advice/adviceKey.ts). '
  'Never stores Advice text, and never mutates/deletes analytics_run_advice '
  'rows — Analytics Run Detail always shows the complete, original Advice '
  'for a run regardless of dismissal state here. All writes are '
  'server-side (service_role) via the dismiss API route; user_id is always '
  'resolved server-side and is never client-suppliable.';

COMMENT ON COLUMN public.analytics_advice_dismissals.advice_key IS
  'Deterministic identity string computed by computeAdviceKey() from ONLY '
  'advice_type + item_id + the sorted set of the card''s cited source_ids '
  '— never the LLM-authored advice_code/headline/advice/why_it_matters, '
  'which may reword run to run for the same underlying finding. Not a '
  'copy of any Advice text.';

COMMENT ON COLUMN public.analytics_advice_dismissals.resurface_after IS
  'Fixed v1 policy: dismissed_at + 30 days, set/refreshed by the dismiss '
  'API route. While resurface_after > now(), the matching advice_key is '
  'hidden from the Dashboard. Once resurface_after <= now(), the advice '
  'becomes ELIGIBLE to reappear — it only actually reappears if the '
  'current/latest completed Advice still contains a card with this exact '
  'advice_key; 30 days passing never force-creates or force-shows advice '
  'on its own.';
