-- analytics_advice_dismissals: advice_key documentation update (v2)
--
-- Forward-only follow-up to 20260906000000_analytics_advice_dismissals.sql
-- (that migration is NOT modified — it has already been applied, and its
-- table/column/constraint/RLS/grant DDL is completely unchanged here). This
-- migration touches ONLY the descriptive COMMENT ON text — no table
-- structure, no data — to keep the live schema's own documentation honest
-- after a focused post-ship audit found the ORIGINAL advice_key algorithm
-- (computeAdviceKey() in src/lib/analytics/advice/adviceKey.ts) too
-- fragile:
--
--   1. advice_type is chosen by the LLM's own editorial judgment (see
--      ADVICE_SYSTEM_PROMPT rule 13, src/lib/openai.ts) — not a
--      deterministic mapping from evidence to a fixed type. Removed from
--      identity entirely.
--   2. Keying on the FULL sorted source_ids set meant one added/removed
--      supporting source (the model is never required to cite every
--      available corroborating source) silently changed the key even
--      though the core underlying condition was unchanged. Replaced with a
--      single mechanically-selected PRIMARY source (item-justifying source
--      for item-level cards; a fixed pattern > insight > hypothesis
--      priority for portfolio-level cards) — see adviceKey.ts's own header
--      for the full rationale.
--
-- advice_key itself is bumped from the 'v1:' prefix to 'v2:' in application
-- code (no schema change required for that — the column is a plain `text`
-- with no format CHECK constraint) — no real dismissal rows existed under
-- the v1 algorithm at the time of this fix (confirmed during the audit), so
-- there is no v1-keyed data to migrate or reconcile.

COMMENT ON TABLE public.analytics_advice_dismissals IS
  'Per-user Advice coach state for Advice Dismissal / Resurface v1 — hides '
  'an Advice card from the Dashboard for a fixed 30-day window keyed on '
  'its deterministic advice_key (see src/lib/analytics/advice/adviceKey.ts '
  '— v2 as of 20260907000000: item_id + one mechanically-selected primary '
  'source_id, never the LLM-chosen advice_type or the full source_ids '
  'set). Never stores Advice text, and never mutates/deletes '
  'analytics_run_advice rows — Analytics Run Detail always shows the '
  'complete, original Advice for a run regardless of dismissal state here. '
  'All writes are server-side (service_role) via the dismiss API route; '
  'user_id is always resolved server-side and is never client-suppliable.';

COMMENT ON COLUMN public.analytics_advice_dismissals.advice_key IS
  'Deterministic identity string computed by computeAdviceKey() (v2) from '
  'ONLY item_id + one mechanically-selected primary cited source_id — '
  'never the LLM-authored advice_code/headline/advice/why_it_matters, and '
  '(as of v2) never the LLM-chosen advice_type or the full source_ids set '
  'either, since both were found too fragile across weekly runs (see '
  '20260907000000). Not a copy of any Advice text.';
