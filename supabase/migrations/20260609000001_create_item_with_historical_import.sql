-- create_item_with_historical_import
--
-- Atomically:
--   1. Inserts an inventory_item with status = 'owned'
--   2. Inserts a deals row with deal_type = 'Historical Import'
--   3. Inserts a deal_items row (direction = 'in', total_value = p_value_in)
--
-- No cash_flow row is created — historical imports do not affect cash balance.
-- user_id on all rows is populated automatically via the DEFAULT get_app_user_id()
-- that was set in the multi-user migration (20260608000000).
--
-- Returns: jsonb { "item_id": n, "deal_id": n }

CREATE OR REPLACE FUNCTION public.create_item_with_historical_import(
  -- inventory_item fields
  p_brand_id              bigint,
  p_item_type             text,
  p_item_subtype_id       bigint    DEFAULT NULL,
  p_model                 text      DEFAULT NULL,
  p_serial_number         text      DEFAULT NULL,
  p_year                  int       DEFAULT NULL,
  p_color                 text      DEFAULT NULL,
  p_condition             text      DEFAULT NULL,
  p_collection_type       text      DEFAULT NULL,
  p_estimated_sold_value  numeric   DEFAULT NULL,
  p_notes                 text      DEFAULT NULL,
  -- historical import fields
  p_acquisition_date      date      DEFAULT NULL,
  p_value_in              numeric   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id  bigint;
  v_deal_id  bigint;
BEGIN
  -- Validate required fields
  IF p_brand_id IS NULL THEN
    RAISE EXCEPTION 'brand_id is required';
  END IF;
  IF trim(COALESCE(p_model, '')) = '' THEN
    RAISE EXCEPTION 'model is required';
  END IF;
  IF p_acquisition_date IS NULL THEN
    RAISE EXCEPTION 'acquisition_date is required';
  END IF;
  IF p_value_in IS NULL OR p_value_in <= 0 THEN
    RAISE EXCEPTION 'value_in must be greater than 0';
  END IF;

  -- 1. Insert inventory item (status = owned, no date_listed or sold_date)
  INSERT INTO public.inventory_items (
    brand_id, item_type, item_subtype_id,
    model, serial_number, year, color,
    condition, collection_type, estimated_sold_value, notes,
    status, date_listed, sold_date
  ) VALUES (
    p_brand_id, p_item_type, p_item_subtype_id,
    p_model, p_serial_number, p_year, p_color,
    p_condition, p_collection_type, p_estimated_sold_value, p_notes,
    'owned', NULL, NULL
  )
  RETURNING id INTO v_item_id;

  -- 2. Insert Historical Import deal
  INSERT INTO public.deals (
    deal_date, deal_type, channel,
    cash_received, cash_paid, fees, notes
  ) VALUES (
    p_acquisition_date, 'Historical Import', 'Opening Balance',
    0, 0, 0, 'Historical inventory import'
  )
  RETURNING id INTO v_deal_id;

  -- 3. Insert deal_item: item coming in, value = acquisition cost
  INSERT INTO public.deal_items (
    deal_id, item_id, direction,
    total_value, notes
  ) VALUES (
    v_deal_id, v_item_id, 'in',
    p_value_in, 'Historical import. Value in: $' || p_value_in::text
  );

  RETURN jsonb_build_object('item_id', v_item_id, 'deal_id', v_deal_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_item_with_historical_import(
  bigint, text, bigint, text, text, int, text, text, text, numeric, text, date, numeric
) TO authenticated;
