-- create_item_with_historical_import: accept a known acquisition method
--
-- Context: Historical Import records a synthetic acquisition deal for an
-- item that predates this app — no cash_flow row, no cash_paid/cash_received,
-- because nothing was tracked at the time. Until now every such deal was
-- stamped deal_type = 'Historical Import' regardless of whether the item was
-- actually bought for cash or acquired by trade; that distinction, when
-- known, previously had to be corrected after the fact (see
-- supabase/data-fixes/correct_historical_import_operations.sql). This
-- migration lets the creation form capture it up front instead.
--
-- New parameter: p_historical_acquisition_method text DEFAULT NULL, one of
-- 'purchase' | 'trade' | 'unknown' | NULL. Mapped SERVER-SIDE (never trust
-- the browser to pick the stored deal_type) to:
--   'purchase' -> deal_type 'Historical Purchase'
--   'trade'    -> deal_type 'Historical Trade'
--   'unknown'  -> deal_type 'Historical Import'
--   NULL       -> deal_type 'Historical Import'  (backward compatible: an
--                 older frontend build that doesn't send this parameter yet
--                 gets today's existing behavior, not an error — this is
--                 what avoids a deploy-order dependency between this
--                 migration and the frontend change that sends the new
--                 parameter)
-- Any other value is rejected with RAISE EXCEPTION.
--
-- No new column, no CHECK constraint added (deals.deal_type remains plain
-- text, as established in 20260724000000_historical_deal_type_labels.sql —
-- 'Historical Purchase'/'Historical Trade' are already-recognized values).
-- deal_items, cash_paid, cash_received, and the 'in'-only single-item deal
-- shape are completely unchanged — this migration only changes what string
-- goes into deals.deal_type and does not touch anything else that
-- create_item_with_historical_import already does.
--
-- The old 13-argument signature is dropped explicitly (rather than left as
-- a second, orphaned overload the way earlier parameter additions to this
-- function were made) so there is exactly one create_item_with_historical_import
-- overload after this migration.

DROP FUNCTION IF EXISTS public.create_item_with_historical_import(
  bigint, bigint, text, text, int, text, text, text, numeric, text, date, numeric, bigint
);

CREATE OR REPLACE FUNCTION public.create_item_with_historical_import(
  p_brand_id                      bigint,
  p_item_subtype_id               bigint    DEFAULT NULL,
  p_model                         text      DEFAULT NULL,
  p_serial_number                 text      DEFAULT NULL,
  p_year                          int       DEFAULT NULL,
  p_color                         text      DEFAULT NULL,
  p_condition                     text      DEFAULT NULL,
  p_collection_type               text      DEFAULT NULL,
  p_estimated_sold_value          numeric   DEFAULT NULL,
  p_notes                         text      DEFAULT NULL,
  p_acquisition_date              date      DEFAULT NULL,
  p_value_in                      numeric   DEFAULT NULL,
  p_purpose_id                    bigint    DEFAULT NULL,
  p_historical_acquisition_method text      DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id   bigint;
  v_deal_id   bigint;
  v_deal_type text;
BEGIN
  IF p_brand_id IS NULL THEN RAISE EXCEPTION 'brand_id is required'; END IF;
  IF trim(COALESCE(p_model, '')) = '' THEN RAISE EXCEPTION 'model is required'; END IF;
  IF p_acquisition_date IS NULL THEN RAISE EXCEPTION 'acquisition_date is required'; END IF;
  IF p_value_in IS NULL OR p_value_in <= 0 THEN RAISE EXCEPTION 'value_in must be greater than 0'; END IF;

  -- Server-side mapping — the client sends 'purchase' | 'trade' | 'unknown'
  -- | NULL and never the stored deal_type string directly. A searched
  -- IF/ELSIF (not a simple CASE) because `CASE x WHEN NULL THEN ...` never
  -- matches — `NULL = NULL` isn't true in SQL — so NULL needs its own
  -- explicit branch rather than falling out of a WHEN comparison.
  IF p_historical_acquisition_method IS NULL THEN
    v_deal_type := 'Historical Import';
  ELSIF p_historical_acquisition_method = 'purchase' THEN
    v_deal_type := 'Historical Purchase';
  ELSIF p_historical_acquisition_method = 'trade' THEN
    v_deal_type := 'Historical Trade';
  ELSIF p_historical_acquisition_method = 'unknown' THEN
    v_deal_type := 'Historical Import';
  ELSE
    RAISE EXCEPTION 'historical_acquisition_method must be one of: purchase, trade, unknown (got: %)', p_historical_acquisition_method;
  END IF;

  INSERT INTO public.inventory_items (
    brand_id, item_subtype_id,
    model, serial_number, year, color,
    condition, collection_type, purpose_id, estimated_sold_value, notes,
    status, sold_date
  ) VALUES (
    p_brand_id, p_item_subtype_id,
    p_model, p_serial_number, p_year, p_color,
    p_condition, p_collection_type, p_purpose_id, p_estimated_sold_value, p_notes,
    'owned', NULL
  )
  RETURNING id INTO v_item_id;

  INSERT INTO public.deals (deal_date, deal_type, cash_received, cash_paid, fees, notes)
  VALUES (p_acquisition_date, v_deal_type, 0, 0, 0, 'Historical inventory import')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.deal_items (deal_id, item_id, direction, total_value, notes)
  VALUES (v_deal_id, v_item_id, 'in', p_value_in, 'Historical import. Value in: $' || p_value_in::text);

  RETURN jsonb_build_object('item_id', v_item_id, 'deal_id', v_deal_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_item_with_historical_import(
  bigint, bigint, text, text, int, text, text, text, numeric, text, date, numeric, bigint, text
) TO authenticated;
