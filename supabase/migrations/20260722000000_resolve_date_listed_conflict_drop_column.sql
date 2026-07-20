-- Follow-up to 20260721000000_migrate_date_listed_to_item_listings.sql.
--
-- That migration found one unresolved conflict (item_listings.id=26 /
-- inventory_item_id=174: Reverb listed_at 2026-07-03 vs. legacy
-- date_listed 2026-07-06) and left inventory_items.date_listed in place
-- rather than guess. Per manual review, the legacy date_listed value wins.
-- Resolve any such conflicts, then drop the now-fully-backfilled column.

DO $$
DECLARE
  v_reverb_id      bigint;
  v_reverb_count   integer;
  v_resolved_count integer := 0;
  v_row            RECORD;
BEGIN
  SELECT COUNT(*) INTO v_reverb_count FROM public.deal_channels WHERE name = 'Reverb';
  IF v_reverb_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one ''Reverb'' deal_channels row, found %.', v_reverb_count;
  END IF;
  SELECT id INTO v_reverb_id FROM public.deal_channels WHERE name = 'Reverb';

  -- Resolve every remaining conflict (not just item 174) the same way:
  -- legacy date_listed wins over the current Reverb listed_at.
  FOR v_row IN
    SELECT i.id, i.date_listed, il.id AS listing_id, il.listed_at
    FROM public.inventory_items i
    JOIN public.item_listings il
      ON il.inventory_item_id = i.id AND il.deal_channel_id = v_reverb_id
    WHERE i.date_listed IS NOT NULL
      AND il.listed_at IS NOT NULL
      AND il.listed_at <> i.date_listed
  LOOP
    UPDATE public.item_listings
    SET listed_at = v_row.date_listed
    WHERE id = v_row.listing_id;

    v_resolved_count := v_resolved_count + 1;
    RAISE NOTICE 'item_listings.id=% (inventory_item_id=%) listed_at % -> % (legacy date_listed wins).',
      v_row.listing_id, v_row.id, v_row.listed_at, v_row.date_listed;
  END LOOP;

  RAISE NOTICE '% conflicting Reverb listed_at value(s) resolved in favor of legacy date_listed.', v_resolved_count;

  ALTER TABLE public.inventory_items DROP COLUMN date_listed;
  RAISE NOTICE 'inventory_items.date_listed dropped.';
END $$;
