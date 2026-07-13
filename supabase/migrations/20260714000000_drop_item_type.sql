-- Remove legacy inventory_items.item_type column.
-- All rows have item_subtype_id populated (0 null rows confirmed).

-- 1. Drop views that reference item_type
DROP VIEW IF EXISTS public.inventory_items_with_value;
DROP VIEW IF EXISTS public.inventory_items_search;

-- 2. Recreate views without item_type, exposing item_subtype_name via join
CREATE VIEW public.inventory_items_with_value AS
SELECT
  i.id,
  i.brand_id,
  s.name AS item_subtype_name,
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
  i.item_subtype_id,
  i.purpose_id,
  ip.name AS purpose_name
FROM public.inventory_items i
LEFT JOIN public.item_subtypes   s  ON s.id  = i.item_subtype_id
LEFT JOIN public.deal_items      di ON (di.item_id = i.id AND di.direction = 'in')
LEFT JOIN public.item_purposes   ip ON ip.id = i.purpose_id
WHERE i.user_id = public.get_app_user_id();

CREATE VIEW public.inventory_items_search AS
SELECT
  i.id,
  i.brand_id,
  s.name AS item_subtype_name,
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
  i.item_subtype_id,
  i.purpose_id,
  ip.name AS purpose_name
FROM public.inventory_items i
JOIN  public.brands        b  ON b.id  = i.brand_id
LEFT JOIN public.item_subtypes  s  ON s.id  = i.item_subtype_id
LEFT JOIN public.item_purposes  ip ON ip.id = i.purpose_id
WHERE i.user_id = public.get_app_user_id();

GRANT SELECT ON public.inventory_items_with_value TO authenticated;
GRANT SELECT ON public.inventory_items_search     TO authenticated;

-- 3. Drop both old overloads of create_item_with_historical_import (both had p_item_type)
DROP FUNCTION IF EXISTS public.create_item_with_historical_import(
  bigint, text, bigint, text, text, int, text, text, text, numeric, text, date, numeric
);
DROP FUNCTION IF EXISTS public.create_item_with_historical_import(
  bigint, text, bigint, text, text, int, text, text, text, numeric, text, date, numeric, bigint
);

-- 4. New function without p_item_type, keeping p_purpose_id
CREATE FUNCTION public.create_item_with_historical_import(
  p_brand_id              bigint,
  p_item_subtype_id       bigint    DEFAULT NULL,
  p_model                 text      DEFAULT NULL,
  p_serial_number         text      DEFAULT NULL,
  p_year                  int       DEFAULT NULL,
  p_color                 text      DEFAULT NULL,
  p_condition             text      DEFAULT NULL,
  p_collection_type       text      DEFAULT NULL,
  p_estimated_sold_value  numeric   DEFAULT NULL,
  p_notes                 text      DEFAULT NULL,
  p_acquisition_date      date      DEFAULT NULL,
  p_value_in              numeric   DEFAULT NULL,
  p_purpose_id            bigint    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id bigint;
  v_deal_id bigint;
BEGIN
  IF p_brand_id IS NULL THEN RAISE EXCEPTION 'brand_id is required'; END IF;
  IF trim(COALESCE(p_model, '')) = '' THEN RAISE EXCEPTION 'model is required'; END IF;
  IF p_acquisition_date IS NULL THEN RAISE EXCEPTION 'acquisition_date is required'; END IF;
  IF p_value_in IS NULL OR p_value_in <= 0 THEN RAISE EXCEPTION 'value_in must be greater than 0'; END IF;

  INSERT INTO public.inventory_items (
    brand_id, item_subtype_id,
    model, serial_number, year, color,
    condition, collection_type, purpose_id, estimated_sold_value, notes,
    status, date_listed, sold_date
  ) VALUES (
    p_brand_id, p_item_subtype_id,
    p_model, p_serial_number, p_year, p_color,
    p_condition, p_collection_type, p_purpose_id, p_estimated_sold_value, p_notes,
    'owned', NULL, NULL
  )
  RETURNING id INTO v_item_id;

  INSERT INTO public.deals (deal_date, deal_type, cash_received, cash_paid, fees, notes)
  VALUES (p_acquisition_date, 'Historical Import', 0, 0, 0, 'Historical inventory import')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.deal_items (deal_id, item_id, direction, total_value, notes)
  VALUES (v_deal_id, v_item_id, 'in', p_value_in, 'Historical import. Value in: $' || p_value_in::text);

  RETURN jsonb_build_object('item_id', v_item_id, 'deal_id', v_deal_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_item_with_historical_import(
  bigint, bigint, text, text, int, text, text, text, numeric, text, date, numeric, bigint
) TO authenticated;

-- 5. Drop the column
ALTER TABLE public.inventory_items DROP COLUMN item_type;
