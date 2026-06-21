-- ============================================================
-- Secure guitar_import_staging table
--
-- This is a one-time import staging table from before multi-user
-- support. It has no user_id column and no RLS, and the original
-- remote_schema granted full access to the anon role.
--
-- Fix: enable RLS (which defaults to deny-all when no policies
-- exist) and revoke the anon grants that were copied from the
-- initial schema dump.
-- ============================================================

-- Enable RLS — with no policies, all access is denied by default.
ALTER TABLE public.guitar_import_staging ENABLE ROW LEVEL SECURITY;

-- Revoke the blanket anon grants from the original remote_schema dump.
REVOKE ALL ON public.guitar_import_staging FROM anon;

-- Revoke broad authenticated grants too; the table is not used by
-- the live app and should not be accessible from client code.
REVOKE ALL ON public.guitar_import_staging FROM authenticated;
