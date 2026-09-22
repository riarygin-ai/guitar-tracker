-- Per-user AI Advice language (General Business Coach + Listing Advice only;
-- this is NOT application localization).
--
-- Additive: one new column on the app-owned user table public.app_users
-- (never auth.users). text + CHECK rather than a PostgreSQL enum so adding a
-- language later is a one-line constraint change instead of an enum ALTER.
-- Existing rows and all future users default to English.

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en';

ALTER TABLE public.app_users
  ADD CONSTRAINT app_users_preferred_language_check
  CHECK (preferred_language IN ('en', 'ru'));

COMMENT ON COLUMN public.app_users.preferred_language IS
  'Language for AI-generated advice prose (General Coach + Listing Advice). Supported: en, ru. Read server-side at generation time and persisted with each advice revision; changing it never rewrites existing advice.';

-- The two real accounts (Roman and his brother) are app_users ids 1 and 2:
-- id 1 is Roman's seeded row (20260608000000_multi_user_support.sql section 4,
-- the first row inserted into the freshly created identity table) and id 2 is
-- the second real account. Identified by these stable identity ids — never by
-- display name. Do NOT blanket-update: any other/test account stays 'en'.
-- On a database without those ids (fresh local reset, CI) this is a no-op.
UPDATE public.app_users
   SET preferred_language = 'ru'
 WHERE id IN (1, 2);
