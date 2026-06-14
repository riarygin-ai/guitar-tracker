-- ============================================================
-- Fix multi-user data leak
--
-- Two confirmed bugs:
--
-- 1. inventory_expenses old policy (from remote_schema.sql)
--    "Allow authenticated users to manage inventory expenses"
--    was never dropped when the per-user policies were created
--    in multi_user_support.  PostgreSQL ORs permissive policies,
--    so USING(true) wins and ALL users see ALL expenses.
--
-- 2. inventory_items_with_value view
--    The view is defined WITH (security_invoker = true) in
--    migrations, but the live database state must be verified.
--    Drop + recreate both views to guarantee the flag is set.
--    Without security_invoker the view runs as its owner
--    (postgres / superuser) and bypasses RLS on inventory_items,
--    causing all items from all users to be returned.
-- ============================================================

-- ─── 1. Drop stale permissive policy on inventory_expenses ───────────────────

DROP POLICY IF EXISTS "Allow authenticated users to manage inventory expenses"
  ON public.inventory_expenses;

-- ─── 2. Recreate views with security_invoker = true ──────────────────────────
-- DROP + CREATE (not CREATE OR REPLACE) so the security option is guaranteed
-- to take effect.  Column list matches the latest definition from
-- 20260612000000_item_categories_subtypes.sql.

DROP VIEW IF EXISTS public.inventory_items_with_value;
DROP VIEW IF EXISTS public.inventory_items_search;

CREATE VIEW public.inventory_items_with_value
WITH (security_invoker = true)
AS
SELECT
  i.id,
  i.brand_id,
  i.item_type,
  i.model,
  i.date_listed,
  i.sold_date,
  i.estimated_sold_value,
  i.collection_type,
  i.condition,
  i.status,
  i.notes,
  i.created_at,
  i.updated_at,
  i.year,
  i.color,
  di.total_value AS value_in,
  i.serial_number,
  i.user_id,
  i.item_subtype_id
FROM public.inventory_items i
LEFT JOIN public.deal_items di ON (di.item_id = i.id AND di.direction = 'in');

CREATE VIEW public.inventory_items_search
WITH (security_invoker = true)
AS
SELECT
  i.id,
  i.brand_id,
  i.item_type,
  i.model,
  i.date_listed,
  i.sold_date,
  i.estimated_sold_value,
  i.collection_type,
  i.condition,
  i.status,
  i.notes,
  i.created_at,
  i.updated_at,
  i.year,
  i.color,
  b.name AS brand_name,
  i.serial_number,
  i.user_id,
  i.item_subtype_id
FROM public.inventory_items i
JOIN public.brands b ON (b.id = i.brand_id);

-- Re-grant SELECT on views to authenticated (grants are dropped with the view)
GRANT SELECT ON public.inventory_items_with_value  TO authenticated;
GRANT SELECT ON public.inventory_items_search       TO authenticated;

-- ─── 3. Diagnostic helper ─────────────────────────────────────────────────────
-- Returns the auth context visible to the current Supabase session.
-- Used to verify RLS is resolving to the correct user.
-- SECURITY INVOKER so it runs as the calling user, not as postgres.

CREATE OR REPLACE FUNCTION public.debug_auth_context()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT jsonb_build_object(
    'auth_uid',            auth.uid()::text,
    'app_user_id',         public.get_app_user_id(),
    'inventory_items',     (SELECT COUNT(*) FROM public.inventory_items),
    'deals',               (SELECT COUNT(*) FROM public.deals),
    'deal_items',          (SELECT COUNT(*) FROM public.deal_items),
    'cash_flow',           (SELECT COUNT(*) FROM public.cash_flow),
    'inventory_expenses',  (SELECT COUNT(*) FROM public.inventory_expenses),
    'view_rows',           (SELECT COUNT(*) FROM public.inventory_items_with_value)
  )
$$;

GRANT EXECUTE ON FUNCTION public.debug_auth_context() TO authenticated;
