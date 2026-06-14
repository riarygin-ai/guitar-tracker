-- ============================================================
-- Fix inventory views: explicit user filter
--
-- security_invoker = true (PostgreSQL 15 feature) may not be
-- effective on this database version.  Replace it with an
-- explicit WHERE clause that calls get_app_user_id(), which
-- reads auth.uid() from the PostgREST JWT GUC regardless of
-- which role the view body executes as.
--
-- This guarantees every query against these views returns only
-- the authenticated user's own rows.
-- ============================================================

DROP VIEW IF EXISTS public.inventory_items_with_value;
DROP VIEW IF EXISTS public.inventory_items_search;

-- Primary view used by all inventory/dashboard queries.
-- The WHERE clause is evaluated before the JOIN, so the LEFT JOIN
-- only matches deal_items that belong to the current user's items.
CREATE VIEW public.inventory_items_with_value AS
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
LEFT JOIN public.deal_items di ON (di.item_id = i.id AND di.direction = 'in')
WHERE i.user_id = public.get_app_user_id();

-- Search view (used by inventory search / autocomplete).
CREATE VIEW public.inventory_items_search AS
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
JOIN public.brands b ON (b.id = i.brand_id)
WHERE i.user_id = public.get_app_user_id();

GRANT SELECT ON public.inventory_items_with_value TO authenticated;
GRANT SELECT ON public.inventory_items_search     TO authenticated;
