-- item_listings: support multiple listing cycles per item + platform.
-- Forward-only, does not modify any prior migration.
--
-- CONFIRMED SCHEMA FACTS THIS MIGRATION DEPENDS ON (re-verified live before
-- writing any DDL below, same discipline as every prior hardening
-- migration this session):
--   - public.item_listings currently has NO status column at all — one
--     existed once (20260614000000_item_listings.sql: 'draft'/'published'/
--     'archived') but was deliberately dropped in
--     20260720000000_item_listings_listed_at.sql in favor of a
--     "listed_at IS NOT NULL means published" model. That same migration
--     added item_listings_unique_item_channel UNIQUE (inventory_item_id,
--     deal_channel_id) — exactly the constraint this migration replaces —
--     and confirmed via live query that zero duplicate (item, channel)
--     groups existed at the time, so it's safe to assume this schema has
--     never supported more than one row per item+channel since.
--   - prompt_snapshot also existed once (20260618000000) and was dropped
--     by the SAME 20260720000000 migration. It is NOT restored here — see
--     this session's final report for why (the API route that would set
--     it never persists it today either; this is pre-existing, unrelated
--     to this migration, and out of scope to fix here).
--   - public.item_listings.description is already nullable (also
--     20260720000000) — a row can already represent "draft text only, no
--     listing date yet"; this migration's new 'draft' status formalizes
--     that existing shape rather than introducing it.
--   - public.sync_inventory_status_from_listings() currently computes
--     "has_listed" as EXISTS(... WHERE listed_at IS NOT NULL) and its
--     trigger fires on `UPDATE OF listed_at` only. Both are updated below
--     to use status = 'active' instead, and the trigger is extended to
--     also fire on `UPDATE OF status` — ending/cancelling a listing
--     changes status WITHOUT changing listed_at (that column is now a
--     permanent historical "when this cycle started" record), so without
--     this the item would incorrectly stay 'listed' forever after an End
--     Listing/Cancel action.
--   - public.inventory_items.status is application-enforced (new, owned,
--     listed, sold, traded) with no DB CHECK constraint. The sync
--     function's existing IF/ELSIF already only ever flips between
--     'owned' and 'listed' — it never touches 'sold'/'traded'/'new' — and
--     that guard is UNCHANGED by this migration.

-- ── 1. New lifecycle columns ─────────────────────────────────────────────
-- status default 'draft': every row inserted without an explicit status
-- (e.g. a text-only AI draft save) is a draft, never a listing cycle, by
-- default — matching the existing "a row can hold just text" shape.

ALTER TABLE public.item_listings
  ADD COLUMN status       text NOT NULL DEFAULT 'draft',
  ADD COLUMN ended_at     date,
  ADD COLUMN cancelled_at timestamptz;

-- ── 2. Backfill existing rows ────────────────────────────────────────────
-- Preserves current app behavior exactly: a row that was already
-- considered "listed" (listed_at IS NOT NULL, under the old model)
-- becomes 'active'; a text-only draft row becomes 'draft'. Nothing here
-- can produce an 'ended'/'cancelled' row — those states did not exist
-- before this migration, so there is nothing to backfill into them.

UPDATE public.item_listings
SET status = CASE WHEN listed_at IS NOT NULL THEN 'active' ELSE 'draft' END;

-- ── 3. Constraints ────────────────────────────────────────────────────────

ALTER TABLE public.item_listings
  ADD CONSTRAINT item_listings_status_check
    CHECK (status IN ('draft', 'active', 'ended', 'cancelled'));

-- Mirrors this schema's established status_fields_check pattern
-- (analytics_run_advice, most recently). A row's date fields must be
-- internally consistent with its own status — enforced at the DB level,
-- not just trusted from application code.
ALTER TABLE public.item_listings
  ADD CONSTRAINT item_listings_status_fields_check
    CHECK (
      CASE status
        WHEN 'draft'     THEN listed_at IS NULL     AND ended_at IS NULL AND cancelled_at IS NULL
        WHEN 'active'    THEN listed_at IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL
        WHEN 'ended'     THEN listed_at IS NOT NULL AND ended_at IS NOT NULL AND cancelled_at IS NULL
        WHEN 'cancelled' THEN cancelled_at IS NOT NULL AND ended_at IS NULL
        ELSE false
      END
    );

-- Date-sanity guards backing (not replacing) the application-level
-- validation in Part 7 — neither date may be in the future, and an ended
-- cycle can never claim to have ended before it started.
ALTER TABLE public.item_listings
  ADD CONSTRAINT item_listings_listed_at_not_future_check
    CHECK (listed_at IS NULL OR listed_at <= CURRENT_DATE),
  ADD CONSTRAINT item_listings_ended_at_not_future_check
    CHECK (ended_at IS NULL OR ended_at <= CURRENT_DATE),
  ADD CONSTRAINT item_listings_ended_at_after_listed_at_check
    CHECK (ended_at IS NULL OR listed_at IS NULL OR ended_at >= listed_at);

-- ── 4. Replace the old one-row-per-item-channel constraint ──────────────
-- Historical (ended/cancelled) rows are explicitly EXCLUDED from this
-- index — any number of them may exist per (item, channel). Only ONE
-- non-terminal row (a draft being written, or a currently active listing)
-- may exist per (item, channel) at a time: draft and active are mutually
-- exclusive states for the same platform in practice (see this session's
-- report — starting a listing transitions the existing draft row in
-- place rather than inserting a second row), and this single partial
-- index is what makes both halves of that guarantee atomic under
-- concurrent requests, the same way every other uniqueness guarantee in
-- this schema is enforced by an index rather than application code alone.

ALTER TABLE public.item_listings
  DROP CONSTRAINT item_listings_unique_item_channel;

CREATE UNIQUE INDEX item_listings_unique_open_per_item_channel
  ON public.item_listings (inventory_item_id, deal_channel_id)
  WHERE status IN ('draft', 'active');

-- ── 5. sync_inventory_status_from_listings(): status-aware ─────────────

CREATE OR REPLACE FUNCTION public.sync_inventory_status_from_listings()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_item_id    bigint;
  v_has_listed boolean;
  v_status     text;
BEGIN
  v_item_id := COALESCE(NEW.inventory_item_id, OLD.inventory_item_id);

  SELECT EXISTS (
    SELECT 1 FROM public.item_listings
    WHERE inventory_item_id = v_item_id AND status = 'active'
  ) INTO v_has_listed;

  SELECT status INTO v_status FROM public.inventory_items WHERE id = v_item_id;

  IF v_status = 'owned' AND v_has_listed THEN
    UPDATE public.inventory_items SET status = 'listed' WHERE id = v_item_id;
  ELSIF v_status = 'listed' AND NOT v_has_listed THEN
    UPDATE public.inventory_items SET status = 'owned' WHERE id = v_item_id;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER item_listings_sync_inventory_status ON public.item_listings;

CREATE TRIGGER item_listings_sync_inventory_status
  AFTER INSERT OR DELETE OR UPDATE OF listed_at, status ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.sync_inventory_status_from_listings();

-- ── 6. Never hard-delete — no existing code path uses DELETE on this
-- table (confirmed by repo-wide search before writing this migration);
-- Cancel is the intended "undo an accidental record" action from here on,
-- and it is an UPDATE, not a DELETE. Revoking closes the gap between "the
-- UI never deletes" and "the database cannot be asked to delete" the same
-- way every other soft-lifecycle table in this schema is hardened.

DROP POLICY "item_listings: delete own" ON public.item_listings;
REVOKE DELETE ON public.item_listings FROM authenticated;
