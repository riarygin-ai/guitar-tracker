-- inventory_item_photos
-- Stores photo metadata; files live in Supabase Storage bucket "inventory-photos".
-- Path convention: {owner_id}/{inventory_item_id}/{timestamp}-{filename}

CREATE TABLE public.inventory_item_photos (
  id                  bigint generated always as identity primary key,
  inventory_item_id   bigint  not null references public.inventory_items(id) on delete cascade,
  owner_id            uuid    not null references auth.users(id),
  storage_path        text    not null,
  file_name           text,
  content_type        text,
  file_size           bigint,
  is_main             boolean not null default false,
  sort_order          int     not null default 0,
  created_at          timestamptz not null default now()
);

-- Indexes
CREATE INDEX idx_inventory_item_photos_item_id  ON public.inventory_item_photos(inventory_item_id);
CREATE INDEX idx_inventory_item_photos_owner_id ON public.inventory_item_photos(owner_id);
CREATE INDEX idx_inventory_item_photos_is_main  ON public.inventory_item_photos(inventory_item_id, is_main) WHERE is_main = true;

-- Row-level security
ALTER TABLE public.inventory_item_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "photos_select" ON public.inventory_item_photos
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_id);

CREATE POLICY "photos_insert" ON public.inventory_item_photos
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "photos_update" ON public.inventory_item_photos
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "photos_delete" ON public.inventory_item_photos
  FOR DELETE TO authenticated
  USING (auth.uid() = owner_id);
