-- Migrate legacy inventory_items.date_listed (Reverb-only, item-level) to
-- item_listings.listed_at (per-platform), add an owned<->listed status sync
-- trigger driven by item_listings, reconcile existing statuses, then drop
-- the legacy column once the backfill is conflict-free.

-- ─── 1. Recreate views without date_listed ─────────────────────────────────────
-- A view's output column list can't be shrunk via CREATE OR REPLACE, so we
-- drop and recreate (same pattern as 20260714000000_drop_item_type.sql).

DROP VIEW IF EXISTS public.inventory_items_with_value;
DROP VIEW IF EXISTS public.inventory_items_search;

CREATE VIEW public.inventory_items_with_value AS
SELECT
  i.id,
  i.brand_id,
  s.name AS item_subtype_name,
  i.model,
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

-- ─── 2. create_item_with_historical_import — stop inserting date_listed ───────
-- Signature is unchanged, so CREATE OR REPLACE is enough (no DROP needed).

CREATE OR REPLACE FUNCTION public.create_item_with_historical_import(
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
    status, sold_date
  ) VALUES (
    p_brand_id, p_item_subtype_id,
    p_model, p_serial_number, p_year, p_color,
    p_condition, p_collection_type, p_purpose_id, p_estimated_sold_value, p_notes,
    'owned', NULL
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

-- ─── 3. Backfill, reconcile, and (if safe) drop the legacy column ─────────────
-- Runs before the sync trigger exists (§4) so this block's own counts are the
-- single source of truth for what changed — nothing here double-fires through
-- the trigger.

DO $$
DECLARE
  v_reverb_id       bigint;
  v_reverb_count    integer;
  v_created_count   integer := 0;
  v_updated_count   integer := 0;
  v_conflict_count  integer := 0;
  v_to_listed_count integer := 0;
  v_to_owned_count  integer := 0;
  v_row             RECORD;
  v_existing        RECORD;
BEGIN
  -- 3a. Resolve the Reverb channel by name — never hardcode its id.
  SELECT COUNT(*) INTO v_reverb_count FROM public.deal_channels WHERE name = 'Reverb';
  IF v_reverb_count = 0 THEN
    RAISE EXCEPTION 'No deal_channels row named ''Reverb'' found — aborting migration.';
  ELSIF v_reverb_count > 1 THEN
    RAISE EXCEPTION 'Expected exactly one ''Reverb'' deal_channels row, found %.', v_reverb_count;
  END IF;
  SELECT id INTO v_reverb_id FROM public.deal_channels WHERE name = 'Reverb';

  -- 3b. Backfill date_listed -> item_listings.listed_at (Reverb only).
  FOR v_row IN
    SELECT id, user_id, date_listed
    FROM public.inventory_items
    WHERE date_listed IS NOT NULL
  LOOP
    SELECT id, listed_at INTO v_existing
    FROM public.item_listings
    WHERE inventory_item_id = v_row.id AND deal_channel_id = v_reverb_id;

    IF NOT FOUND THEN
      -- No Reverb row yet: create one carrying just the migrated date.
      INSERT INTO public.item_listings
        (user_id, inventory_item_id, deal_channel_id, listed_at, is_ai_generated)
      VALUES
        (v_row.user_id, v_row.id, v_reverb_id, v_row.date_listed, false);
      v_created_count := v_created_count + 1;

    ELSIF v_existing.listed_at IS NULL THEN
      -- Reverb row exists (e.g. has generated text) but has no date yet.
      UPDATE public.item_listings
      SET listed_at = v_row.date_listed
      WHERE id = v_existing.id;
      v_updated_count := v_updated_count + 1;

    ELSIF v_existing.listed_at <> v_row.date_listed THEN
      -- Both populated and disagree — report, touch neither value.
      v_conflict_count := v_conflict_count + 1;
      RAISE WARNING 'inventory_items.id=% date_listed=% differs from item_listings.id=% (Reverb) listed_at=% — neither value overwritten.',
        v_row.id, v_row.date_listed, v_existing.id, v_existing.listed_at;
    END IF;
    -- ELSE: values already match — nothing to do.
  END LOOP;

  RAISE NOTICE 'date_listed backfill: % item_listings row(s) created, % updated, % conflict(s) found.',
    v_created_count, v_updated_count, v_conflict_count;

  -- 3c. Reconcile existing item statuses against ALL platforms (not just the
  -- Reverb rows just backfilled) — owned<->listed only, per the same rules
  -- the trigger in §4 will enforce going forward.
  WITH has_listed AS (
    SELECT DISTINCT inventory_item_id FROM public.item_listings WHERE listed_at IS NOT NULL
  ),
  promoted AS (
    UPDATE public.inventory_items i
    SET status = 'listed'
    WHERE i.status = 'owned'
      AND EXISTS (SELECT 1 FROM has_listed h WHERE h.inventory_item_id = i.id)
    RETURNING i.id
  )
  SELECT COUNT(*) INTO v_to_listed_count FROM promoted;

  WITH has_listed AS (
    SELECT DISTINCT inventory_item_id FROM public.item_listings WHERE listed_at IS NOT NULL
  ),
  demoted AS (
    UPDATE public.inventory_items i
    SET status = 'owned'
    WHERE i.status = 'listed'
      AND NOT EXISTS (SELECT 1 FROM has_listed h WHERE h.inventory_item_id = i.id)
    RETURNING i.id
  )
  SELECT COUNT(*) INTO v_to_owned_count FROM demoted;

  RAISE NOTICE 'status reconciliation: % item(s) owned -> listed, % item(s) listed -> owned.',
    v_to_listed_count, v_to_owned_count;

  -- 3d. Only drop the legacy column once the backfill is fully validated.
  IF v_conflict_count = 0 THEN
    ALTER TABLE public.inventory_items DROP COLUMN date_listed;
    RAISE NOTICE 'inventory_items.date_listed dropped.';
  ELSE
    RAISE WARNING 'inventory_items.date_listed NOT dropped: % unresolved conflict(s) — resolve manually (see WARNINGs above), then drop the column in a follow-up migration.',
      v_conflict_count;
  END IF;
END $$;

-- ─── 4. Status sync trigger — owned<->listed only ──────────────────────────────
-- Created after §3 so this migration's own backfill/reconcile writes don't
-- double-fire it. From here on, any item_listings insert/update(listed_at)
-- /delete keeps inventory_items.status in sync for owned/listed items only;
-- new/sold/traded are left untouched (their transitions are owned by the
-- buy/sell/trade RPCs).

CREATE OR REPLACE FUNCTION public.sync_inventory_status_from_listings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id    bigint;
  v_has_listed boolean;
  v_status     text;
BEGIN
  v_item_id := COALESCE(NEW.inventory_item_id, OLD.inventory_item_id);

  SELECT EXISTS (
    SELECT 1 FROM public.item_listings
    WHERE inventory_item_id = v_item_id AND listed_at IS NOT NULL
  ) INTO v_has_listed;

  SELECT status INTO v_status FROM public.inventory_items WHERE id = v_item_id;

  IF v_status = 'owned' AND v_has_listed THEN
    UPDATE public.inventory_items SET status = 'listed' WHERE id = v_item_id;
  ELSIF v_status = 'listed' AND NOT v_has_listed THEN
    UPDATE public.inventory_items SET status = 'owned' WHERE id = v_item_id;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS item_listings_sync_inventory_status ON public.item_listings;

CREATE TRIGGER item_listings_sync_inventory_status
  AFTER INSERT OR UPDATE OF listed_at OR DELETE ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.sync_inventory_status_from_listings();
