-- item_listings
-- Stores AI-generated and manual marketplace listing drafts for inventory items.
-- One draft per (inventory_item_id, listing_type) — enforced by UNIQUE constraint.

-- ─── 1. Shared updated_at trigger function ───────────────────────────────────
-- CREATE OR REPLACE is safe to run again if another migration adds it later.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;

-- ─── 2. item_listings table ───────────────────────────────────────────────────

CREATE TABLE public.item_listings (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             int         NOT NULL
                                  REFERENCES public.app_users(id)
                                  DEFAULT public.get_app_user_id(),
  inventory_item_id   bigint      NOT NULL
                                  REFERENCES public.inventory_items(id)
                                  ON DELETE CASCADE,
  listing_type        text        NOT NULL,
  title               text,
  description         text        NOT NULL,
  asking_price        numeric(12,2),
  trade_value         numeric(12,2),
  currency            text        NOT NULL DEFAULT 'CAD',
  status              text        NOT NULL DEFAULT 'draft',
  is_ai_generated     boolean     NOT NULL DEFAULT false,
  ai_model            text,
  prompt_version      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_listings_listing_type_check
    CHECK (listing_type IN ('reverb', 'marketplace', 'kijiji')),

  CONSTRAINT item_listings_status_check
    CHECK (status IN ('draft', 'published', 'archived')),

  CONSTRAINT item_listings_currency_check
    CHECK (char_length(currency) = 3),

  CONSTRAINT item_listings_unique_per_item
    UNIQUE (inventory_item_id, listing_type)
);

-- ─── 3. Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX idx_item_listings_item_id ON public.item_listings(inventory_item_id);
CREATE INDEX idx_item_listings_user_id  ON public.item_listings(user_id);

-- ─── 4. updated_at trigger ────────────────────────────────────────────────────

CREATE TRIGGER item_listings_set_updated_at
  BEFORE UPDATE ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 5. Row-level security ────────────────────────────────────────────────────

ALTER TABLE public.item_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "item_listings: select own"
  ON public.item_listings FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "item_listings: insert own"
  ON public.item_listings FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "item_listings: update own"
  ON public.item_listings FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "item_listings: delete own"
  ON public.item_listings FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── 6. Grants ────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_listings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_listings TO service_role;
