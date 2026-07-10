-- ─── 1. inventory_tags ───────────────────────────────────────────────────────

CREATE TABLE public.inventory_tags (
  id         bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text    NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Case-insensitive uniqueness
CREATE UNIQUE INDEX inventory_tags_name_ci_idx ON public.inventory_tags (lower(name));

-- ─── 2. inventory_item_tags ──────────────────────────────────────────────────

CREATE TABLE public.inventory_item_tags (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES public.inventory_items(id)  ON DELETE CASCADE,
  tag_id     bigint NOT NULL REFERENCES public.inventory_tags(id)   ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (item_id, tag_id)
);

-- ─── 3. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.inventory_tags      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_item_tags ENABLE ROW LEVEL SECURITY;

-- inventory_tags: any authenticated user can read
CREATE POLICY "Authenticated users can read tags"
  ON public.inventory_tags FOR SELECT TO authenticated USING (true);

-- inventory_tags: admins manage (create / update / delete)
CREATE POLICY "Admins can manage tags"
  ON public.inventory_tags FOR ALL TO authenticated
  USING (get_app_user_is_admin())
  WITH CHECK (get_app_user_is_admin());

-- inventory_item_tags: users can manage tags only for their own inventory items
CREATE POLICY "Users can manage their own item tags"
  ON public.inventory_item_tags FOR ALL TO authenticated
  USING (
    item_id IN (
      SELECT id FROM public.inventory_items
      WHERE user_id = public.get_app_user_id()
    )
  )
  WITH CHECK (
    item_id IN (
      SELECT id FROM public.inventory_items
      WHERE user_id = public.get_app_user_id()
    )
  );

-- ─── 4. Seed tags ────────────────────────────────────────────────────────────

INSERT INTO public.inventory_tags (name) VALUES
  ('COA'),
  ('Original Case'),
  ('Original Box'),
  ('Case Candy'),
  ('Manual'),
  ('Gig Bag'),
  ('Modified'),
  ('Missing Parts')
ON CONFLICT DO NOTHING;
