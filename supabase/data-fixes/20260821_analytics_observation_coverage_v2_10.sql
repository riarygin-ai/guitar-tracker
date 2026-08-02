-- ============================================================================
-- 20260821_analytics_observation_coverage_v2_10.sql
--
-- Production configuration for public.analytics_observation_coverage
-- (table created by supabase/migrations/20260820000000_build_analytics_
-- snapshot_v2_9.sql). This is a DATA FIX, not a schema migration — it is
-- NOT auto-applied by `supabase db push` / the migrations runner (same
-- convention as supabase/data-fixes/correct_historical_import_operations.sql
-- and supabase/tests/). Run it manually against the target database,
-- service_role / postgres connection only (the table denies both anon
-- and authenticated all privileges).
--
-- Kept deliberately OUT of the generic schema migration
-- (20260821000000_build_analytics_snapshot_v2_10.sql) — that migration
-- contains no user-specific dates, so it stays safe to apply to any
-- environment (including a fresh/disposable local stack) without
-- silently seeding real production configuration into it. This script is
-- the "separate explicit production SQL step" instead.
--
-- ── CONFIRMED VALUES (per explicit operator confirmation, not inferred
-- from any acquisition/listing/exit/record-creation date) ────────────────
--   app_users.id = 1: complete history confirmed from 2025-11-01.
--   app_users.id = 2: complete history confirmed from 2026-03-01.
--
-- Idempotent — safe to re-run; ON CONFLICT (user_id) DO UPDATE keeps the
-- row's identity (user_id) fixed and refreshes the other columns to
-- exactly these confirmed values, so re-running this file after an
-- unrelated manual edit re-asserts the confirmed configuration rather
-- than erroring or duplicating a row.
-- ============================================================================

INSERT INTO public.analytics_observation_coverage
  (user_id, complete_history_start_date, coverage_status, notes)
VALUES
  (1, DATE '2025-11-01', 'confirmed', 'Complete transaction and listing history confirmed from November 2025.'),
  (2, DATE '2026-03-01', 'confirmed', 'Complete transaction and listing history confirmed from March 2026.')
ON CONFLICT (user_id) DO UPDATE SET
  complete_history_start_date = EXCLUDED.complete_history_start_date,
  coverage_status              = EXCLUDED.coverage_status,
  notes                         = EXCLUDED.notes;

-- ── Verification query (read-only, safe to run after the INSERT above) ──
-- SELECT user_id, complete_history_start_date, coverage_status, notes
-- FROM public.analytics_observation_coverage
-- WHERE user_id IN (1, 2)
-- ORDER BY user_id;
