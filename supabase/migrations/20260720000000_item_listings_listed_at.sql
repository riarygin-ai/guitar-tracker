-- item_listings: track actual platform listing date instead of a status field.
--
-- A row now represents "this item has a listing record for this platform" —
-- it may hold generated/manual text, a listed_at date, both, or (for a new
-- row created just to record a date) neither title nor description.
-- Publication is determined solely by `listed_at IS NOT NULL`.

-- ─── 1. Add listed_at ─────────────────────────────────────────────────────────
-- Left NULL for all existing rows on purpose: created_at reflects when a draft
-- was generated, not when the item was actually listed on the platform, and
-- there is no reliable source to backfill from.

ALTER TABLE public.item_listings
  ADD COLUMN listed_at date;

-- ─── 2. description must be nullable ──────────────────────────────────────────
-- A row can now be created to record only a platform + listed_at, with no
-- listing text at all.

ALTER TABLE public.item_listings
  ALTER COLUMN description DROP NOT NULL;

-- ─── 3. Drop obsolete columns ──────────────────────────────────────────────────
-- Dropping a column also drops CHECK constraints defined on it
-- (item_listings_status_check, item_listings_currency_check), so no separate
-- DROP CONSTRAINT is needed. No views or other objects reference these
-- columns, so CASCADE is not required.

ALTER TABLE public.item_listings
  DROP COLUMN currency,
  DROP COLUMN status,
  DROP COLUMN ai_model,
  DROP COLUMN prompt_snapshot;

-- ─── 4. Unique per (inventory_item_id, deal_channel_id) ────────────────────────
-- Checked live data before writing this migration: no duplicate
-- (inventory_item_id, deal_channel_id) groups exist. Guard it anyway so the
-- migration reports conflicts instead of failing opaquely if that has
-- changed by the time it runs, and never deletes/merges anything itself.

DO $$
DECLARE
  dup_count integer;
  dup RECORD;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT inventory_item_id, deal_channel_id
    FROM public.item_listings
    GROUP BY inventory_item_id, deal_channel_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count = 0 THEN
    ALTER TABLE public.item_listings
      ADD CONSTRAINT item_listings_unique_item_channel
        UNIQUE (inventory_item_id, deal_channel_id);
  ELSE
    RAISE WARNING 'item_listings: % duplicate (inventory_item_id, deal_channel_id) group(s) found; unique constraint NOT applied. Conflicting rows:', dup_count;

    FOR dup IN
      SELECT id, inventory_item_id, deal_channel_id, user_id, created_at
      FROM public.item_listings il
      WHERE (inventory_item_id, deal_channel_id) IN (
        SELECT inventory_item_id, deal_channel_id
        FROM public.item_listings
        GROUP BY inventory_item_id, deal_channel_id
        HAVING COUNT(*) > 1
      )
      ORDER BY inventory_item_id, deal_channel_id, id
    LOOP
      RAISE WARNING '  id=%, inventory_item_id=%, deal_channel_id=%, user_id=%, created_at=%',
        dup.id, dup.inventory_item_id, dup.deal_channel_id, dup.user_id, dup.created_at;
    END LOOP;
  END IF;
END $$;
