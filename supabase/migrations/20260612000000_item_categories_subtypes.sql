-- ─── 1. Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS item_categories (
  id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text    NOT NULL UNIQUE,
  sort_order  int     NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_subtypes (
  id          bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id bigint  NOT NULL REFERENCES item_categories(id),
  name        text    NOT NULL,
  sort_order  int     NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (category_id, name)
);

-- Nullable FK — backward-compatible; item_type column stays until Phase 2
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS item_subtype_id bigint REFERENCES item_subtypes(id);

-- ─── 2. RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE item_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_subtypes   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read item_categories"
  ON item_categories FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage item_categories"
  ON item_categories FOR ALL TO authenticated
  USING (get_app_user_is_admin())
  WITH CHECK (get_app_user_is_admin());

CREATE POLICY "Authenticated users can read item_subtypes"
  ON item_subtypes FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage item_subtypes"
  ON item_subtypes FOR ALL TO authenticated
  USING (get_app_user_is_admin())
  WITH CHECK (get_app_user_is_admin());

-- ─── 3. Seed categories ───────────────────────────────────────────────────────

INSERT INTO item_categories (name, sort_order) VALUES
  ('Guitars', 10),
  ('Amps',    20),
  ('Pedals',  30),
  ('Parts',   40)
ON CONFLICT (name) DO NOTHING;

-- ─── 4. Seed subtypes ─────────────────────────────────────────────────────────

INSERT INTO item_subtypes (category_id, name, sort_order)
SELECT c.id, v.name, v.sort_order
FROM item_categories c
JOIN (VALUES
  ('Guitars', 'Electric Guitar',  10),
  ('Guitars', 'Bass',             20),
  ('Guitars', 'Acoustic Guitar',  30),
  ('Amps',    'Amp',              10),
  ('Amps',    'Cabinet',          20),
  ('Amps',    'Processor',        30),
  ('Pedals',  'Pedal',            10),
  ('Parts',   'Parts',            10),
  ('Parts',   'Pickups',          20)
) AS v(cat_name, name, sort_order) ON c.name = v.cat_name
ON CONFLICT (category_id, name) DO NOTHING;

-- ─── 5. Data migration ────────────────────────────────────────────────────────

UPDATE inventory_items ii
SET item_subtype_id = st.id
FROM item_subtypes st
WHERE ii.item_subtype_id IS NULL
  AND st.name = CASE lower(ii.item_type)
    WHEN 'guitar'          THEN 'Electric Guitar'
    WHEN 'electric guitar' THEN 'Electric Guitar'
    WHEN 'bass'            THEN 'Bass'
    WHEN 'acoustic guitar' THEN 'Acoustic Guitar'
    WHEN 'amp'             THEN 'Amp'
    WHEN 'cab'             THEN 'Cabinet'
    WHEN 'cabinet'         THEN 'Cabinet'
    WHEN 'processor'       THEN 'Processor'
    WHEN 'pedal'           THEN 'Pedal'
    WHEN 'parts'           THEN 'Parts'
    WHEN 'pickups'         THEN 'Pickups'
    ELSE NULL
  END;

-- ─── 6. Refresh views to expose item_subtype_id ───────────────────────────────
-- DROP + CREATE required because CREATE OR REPLACE VIEW cannot reorder existing
-- columns. item_subtype_id is appended at the end, matching the pattern used
-- when serial_number and user_id were added in the multi-user migration.

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
