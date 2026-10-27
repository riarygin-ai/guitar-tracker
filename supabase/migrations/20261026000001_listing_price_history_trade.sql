-- Listing price history also records the Trade flag. Forward-only.
--
-- item_listing_price_history stays the single history of a listing's
-- pricing terms; in this business trade_enabled is part of those terms
-- (offer mode is derived from asking_price + trade_enabled, see
-- 20261026000000). No new table, no rename.
--
-- ── Before applying: confirm production still has the 20260905000000 body ─
--   SELECT pg_get_functiondef('public.track_item_listing_price_history'::regproc);
--   SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'item_listings_track_price_history';
-- Expected: the INSERT/UPDATE body from 20260905000000 and
-- `AFTER INSERT OR UPDATE OF asking_price`. The function below keeps that
-- body's INSERT rule, ownership (user_id = NEW.user_id), SECURITY INVOKER
-- (RLS "insert own" still authorizes the write) and IS DISTINCT FROM guard.
--
-- ── 1. old_trade_enabled / new_trade_enabled ──────────────────────────────
-- Nullable, never backfilled. Rows written before this migration keep both
-- NULL = "Trade was not tracked then" (NOT false). Every UPDATE row written
-- from now on carries both values (the full before/after terms), so it is
-- always non-NULL on both sides. An INSERT row (initial price) has
-- old_trade_enabled NULL (there is no "before") and new_trade_enabled set.
-- The historical Kijiji trade-only backfill is deliberately not replayed
-- into history: its date is unknown and no synthetic event is written.
--
-- ── 2. new_asking_price becomes nullable ──────────────────────────────────
-- Required, not cosmetic: a Trade change on a listing with no asking price
-- (a Kijiji trade-only listing, or a legacy unpriced row) must still be
-- recorded — and with NOT NULL it would instead abort the listing UPDATE
-- itself. It also lets "price removed, now trade only" (Sale + Trade ->
-- Trade only) be recorded, which the old "clearing a price is never
-- logged" rule dropped; that rule predates trade-only listings, when a NULL
-- price had no business meaning. Both price CHECKs still hold (> 0 when set).
--
-- ── 3. Trigger rule ───────────────────────────────────────────────────────
--   INSERT  unchanged: one row only when asking_price is set (initial
--           price); a trade-only listing starts with no row. The listing
--           row itself holds the initial terms.
--   UPDATE  fires on `UPDATE OF asking_price, trade_enabled`; writes ONE row
--           when either value IS DISTINCT FROM its old value, carrying the
--           complete before/after of both. Same-value updates and updates to
--           any other column write nothing.

ALTER TABLE public.item_listing_price_history
  ADD COLUMN old_trade_enabled boolean,
  ADD COLUMN new_trade_enabled boolean;

ALTER TABLE public.item_listing_price_history
  ALTER COLUMN new_asking_price DROP NOT NULL;

COMMENT ON COLUMN public.item_listing_price_history.old_trade_enabled IS
  'trade_enabled before the change. NULL on rows written before 2026-10-26 (Trade not tracked - not false) and on the initial-price INSERT row.';
COMMENT ON COLUMN public.item_listing_price_history.new_trade_enabled IS
  'trade_enabled after the change. NULL only on rows written before 2026-10-26 (Trade not tracked - not false).';
COMMENT ON COLUMN public.item_listing_price_history.new_asking_price IS
  'asking_price after the change. NULL = no asking price (trade only when new_trade_enabled).';

CREATE OR REPLACE FUNCTION public.track_item_listing_price_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.asking_price IS NOT NULL THEN
      INSERT INTO public.item_listing_price_history (user_id, item_listing_id, old_asking_price, new_asking_price, old_trade_enabled, new_trade_enabled)
      VALUES (NEW.user_id, NEW.id, NULL, NEW.asking_price, NULL, NEW.trade_enabled);
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE' (`UPDATE OF asking_price, trade_enabled` only means a
  -- column was in the SET list, not that its VALUE changed — hence the
  -- IS DISTINCT FROM checks). One row for the whole transition.
  IF NEW.asking_price IS DISTINCT FROM OLD.asking_price OR NEW.trade_enabled IS DISTINCT FROM OLD.trade_enabled THEN
    INSERT INTO public.item_listing_price_history (user_id, item_listing_id, old_asking_price, new_asking_price, old_trade_enabled, new_trade_enabled)
    VALUES (NEW.user_id, NEW.id, OLD.asking_price, NEW.asking_price, OLD.trade_enabled, NEW.trade_enabled);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER item_listings_track_price_history ON public.item_listings;
CREATE TRIGGER item_listings_track_price_history
  AFTER INSERT OR UPDATE OF asking_price, trade_enabled ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.track_item_listing_price_history();

COMMENT ON FUNCTION public.track_item_listing_price_history() IS
  'Sole writer of item_listing_price_history (pricing terms = asking_price + trade_enabled). INSERT: one row when '
  'asking_price is set. UPDATE: one row when asking_price or trade_enabled actually changed (IS DISTINCT FROM), '
  'with the full before/after of both. Never fires for updates to other columns.';

COMMENT ON TABLE public.item_listing_price_history IS
  'Append-only history of a listing''s pricing terms (asking_price and, from 2026-10-26, trade_enabled), written '
  'exclusively by the item_listings_track_price_history trigger - never inserted into directly by application code. '
  'Preserved across End/Unlist/Cancel. Rows from before 2026-10-26 have NULL trade columns (not tracked).';
