-- Normalize inventory_items.collection_type into a lookup table.
-- Adds item_purposes, backfills purpose_id, updates views and the
-- create_item_with_historical_import RPC.

-- 1. Create lookup table
CREATE TABLE public.item_purposes (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX item_purposes_name_ci_idx ON public.item_purposes (lower(name));

-- 2. RLS
ALTER TABLE public.item_purposes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users read active purposes"
  ON public.item_purposes FOR SELECT TO authenticated
  USING (is_active = true OR get_app_user_is_admin());

CREATE POLICY "Admins insert purposes"
  ON public.item_purposes FOR INSERT TO authenticated
  WITH CHECK (get_app_user_is_admin());

CREATE POLICY "Admins update purposes"
  ON public.item_purposes FOR UPDATE TO authenticated
  USING (get_app_user_is_admin())
  WITH CHECK (get_app_user_is_admin());

CREATE POLICY "Admins delete purposes"
  ON public.item_purposes FOR DELETE TO authenticated
  USING (get_app_user_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_purposes TO authenticated;

-- 3. Seed standard purposes
INSERT INTO public.item_purposes (name) VALUES
  ('Business'),
  ('Personal'),
  ('Hybrid');

-- 4. Add purpose_id column to inventory_items
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS purpose_id bigint REFERENCES public.item_purposes(id);

-- 5. Safety check: abort if any collection_type values are unrecognized
DO $$
DECLARE
  unmatched_count integer;
  unmatched_values text;
BEGIN
  SELECT
    count(*),
    string_agg(DISTINCT lower(trim(collection_type)), ', ')
  INTO unmatched_count, unmatched_values
  FROM public.inventory_items
  WHERE
    collection_type IS NOT NULL
    AND lower(trim(collection_type)) NOT IN ('business', 'personal', 'hybrid');

  IF unmatched_count > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: % row(s) have unrecognized collection_type values: [%]. '
      'Fix these values before rerunning this migration.',
      unmatched_count, unmatched_values;
  END IF;
END;
$$;

-- 6. Backfill purpose_id from collection_type (case-insensitive match)
UPDATE public.inventory_items ii
SET    purpose_id = ip.id
FROM   public.item_purposes ip
WHERE  ii.purpose_id IS NULL
AND    ii.collection_type IS NOT NULL
AND    lower(trim(ii.collection_type)) = lower(ip.name);

-- 7. Rebuild views to expose purpose_id and purpose_name
DROP VIEW IF EXISTS public.inventory_items_with_value;
DROP VIEW IF EXISTS public.inventory_items_search;

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
  i.item_subtype_id,
  i.purpose_id,
  ip.name AS purpose_name
FROM public.inventory_items i
LEFT JOIN public.deal_items   di ON (di.item_id = i.id AND di.direction = 'in')
LEFT JOIN public.item_purposes ip ON ip.id = i.purpose_id
WHERE i.user_id = public.get_app_user_id();

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
  b.name  AS brand_name,
  i.serial_number,
  i.user_id,
  i.item_subtype_id,
  i.purpose_id,
  ip.name AS purpose_name
FROM public.inventory_items i
JOIN  public.brands         b  ON b.id  = i.brand_id
LEFT JOIN public.item_purposes ip ON ip.id = i.purpose_id
WHERE i.user_id = public.get_app_user_id();

GRANT SELECT ON public.inventory_items_with_value TO authenticated;
GRANT SELECT ON public.inventory_items_search     TO authenticated;

-- 8. Update create_item_with_historical_import to accept p_purpose_id
--    (p_collection_type kept for signature compat but no longer the primary field)
CREATE OR REPLACE FUNCTION public.create_item_with_historical_import(
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
  p_acquisition_date      date      DEFAULT NULL,
  p_value_in              numeric   DEFAULT NULL,
  p_purpose_id            bigint    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id  bigint;
  v_deal_id  bigint;
BEGIN
  IF p_brand_id IS NULL THEN RAISE EXCEPTION 'brand_id is required'; END IF;
  IF trim(COALESCE(p_model, '')) = '' THEN RAISE EXCEPTION 'model is required'; END IF;
  IF p_acquisition_date IS NULL THEN RAISE EXCEPTION 'acquisition_date is required'; END IF;
  IF p_value_in IS NULL OR p_value_in <= 0 THEN RAISE EXCEPTION 'value_in must be greater than 0'; END IF;

  INSERT INTO public.inventory_items (
    brand_id, item_type, item_subtype_id,
    model, serial_number, year, color,
    condition, collection_type, purpose_id, estimated_sold_value, notes,
    status, date_listed, sold_date
  ) VALUES (
    p_brand_id, p_item_type, p_item_subtype_id,
    p_model, p_serial_number, p_year, p_color,
    p_condition, p_collection_type, p_purpose_id, p_estimated_sold_value, p_notes,
    'owned', NULL, NULL
  )
  RETURNING id INTO v_item_id;

  INSERT INTO public.deals (
    deal_date, deal_type, channel,
    cash_received, cash_paid, fees, notes
  ) VALUES (
    p_acquisition_date, 'Historical Import', 'Opening Balance',
    0, 0, 0, 'Historical inventory import'
  )
  RETURNING id INTO v_deal_id;

  INSERT INTO public.deal_items (
    deal_id, item_id, direction, total_value, notes
  ) VALUES (
    v_deal_id, v_item_id, 'in', p_value_in,
    'Historical import. Value in: $' || p_value_in::text
  );

  RETURN jsonb_build_object('item_id', v_item_id, 'deal_id', v_deal_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_item_with_historical_import(
  bigint, text, bigint, text, text, int, text, text, text, numeric, text, date, numeric, bigint
) TO authenticated;
