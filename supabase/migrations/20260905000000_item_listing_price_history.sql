-- Listed price tracking + price history.
--
-- ── AUDIT (confirmed live before writing this migration) ────────────────
-- item_listings already has asking_price numeric(12,2) NULL (added
-- 20260614000000_item_listings.sql) and trade_value numeric(12,2) NULL
-- (same migration) — both currently unused by the UI, always NULL in
-- production. asking_price is the field this migration wires up as the
-- current listed/asking price for a listing cycle. trade_value is a
-- separate, pre-existing concept (not touched here — out of scope; this
-- task is about asking price only).
--
-- ── DESIGN ────────────────────────────────────────────────────────────────
-- A single AFTER INSERT OR UPDATE OF asking_price trigger on item_listings
-- is the sole writer of item_listing_price_history — every code path that
-- can set asking_price (startListing, a future updateListingPrice, any
-- direct SQL) gets correct, atomic history for free, with no risk of the
-- app writing a price without its history row (or vice versa) if a second
-- round trip failed. Mirrors this schema's own established pattern for
-- exactly this kind of cross-cutting side effect (see
-- sync_inventory_status_from_listings, 20260828000000): SECURITY INVOKER
-- (not DEFINER) — runs as the same role that triggered it, matching every
-- other trigger function in this schema, so item_listing_price_history's
-- own RLS/grants (below) are what actually authorizes the trigger's insert.
--
-- Rules implemented exactly as specified:
--   - INSERT with asking_price already set (Start Listing with a price):
--     one history row, old_asking_price = NULL, new_asking_price = value.
--   - INSERT with asking_price NULL (Start Listing with no price, or any
--     draft row): no history row.
--   - UPDATE where asking_price actually changes (IS DISTINCT FROM) to a
--     NON-NULL value: one history row, old = previous value (possibly
--     NULL, for the "populate a null price for the first time" case),
--     new = the new value.
--   - UPDATE where asking_price is unchanged: no history row (IS DISTINCT
--     FROM is false, trigger body no-ops).
--   - UPDATE where asking_price is cleared TO NULL: no history row. Per
--     the task's own preferred rule — "do not insert a price history row
--     with null new price unless there is a clear business reason" — none
--     exists here, so clearing a price is simply never logged. Combined
--     with new_asking_price NOT NULL below, a null transition structurally
--     cannot produce a history row rather than merely being discouraged by
--     application code.
--   - A row that is UPDATEd for an unrelated reason (text edit, End
--     Listing, Cancel) never touches this trigger at all — it's declared
--     `UPDATE OF asking_price` only, so it doesn't even fire.

-- ── 1. item_listing_price_history table ───────────────────────────────────

CREATE TABLE public.item_listing_price_history (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           int         NOT NULL
                                 REFERENCES public.app_users(id)
                                 DEFAULT public.get_app_user_id(),
  item_listing_id   bigint      NOT NULL
                                 REFERENCES public.item_listings(id)
                                 ON DELETE CASCADE,
  old_asking_price  numeric(12,2),
  new_asking_price  numeric(12,2) NOT NULL,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Mirrors the Part 3 validation rule ("asking_price, if provided, must
  -- be greater than 0") at the DB level too — defense in depth, matching
  -- every other numeric/date rule already enforced this way in this
  -- schema (see item_listings_ended_at_not_future_check etc.).
  CONSTRAINT item_listing_price_history_new_price_positive_check
    CHECK (new_asking_price > 0),
  CONSTRAINT item_listing_price_history_old_price_positive_check
    CHECK (old_asking_price IS NULL OR old_asking_price > 0)
);

CREATE INDEX idx_item_listing_price_history_item_listing_id
  ON public.item_listing_price_history (item_listing_id);
CREATE INDEX idx_item_listing_price_history_user_id
  ON public.item_listing_price_history (user_id);

COMMENT ON TABLE public.item_listing_price_history IS
  'Append-only audit trail of item_listings.asking_price changes, written '
  'exclusively by the item_listings_track_price_history trigger below — '
  'never inserted into directly by application code. Preserved across '
  'End/Cancel Listing (never deleted); a cancelled/ended listing''s '
  'history remains for audit but its asking_price must not be presented '
  'as a CURRENT listed price by the UI (application-level concern, not '
  'enforced here).';

-- ── 2. RLS — same ownership model as item_listings, append-only from the
-- client's perspective (no UPDATE/DELETE grant at all; see item_listings'
-- own "never hard-delete" precedent, 20260828000000). ─────────────────────

ALTER TABLE public.item_listing_price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "item_listing_price_history: select own"
  ON public.item_listing_price_history FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

-- INSERT policy exists so the AFTER-trigger (SECURITY INVOKER, runs as
-- the triggering `authenticated` role) can write its own row — the
-- trigger always sets user_id = NEW.user_id, which item_listings' own
-- RLS already guarantees equals the caller's app_users.id.
CREATE POLICY "item_listing_price_history: insert own"
  ON public.item_listing_price_history FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

-- This project's ambient default privileges grant anon/authenticated full
-- table privileges on any newly created table regardless of the GRANTs
-- below, so writes must be explicitly REVOKEd here rather than left to
-- RLS alone (same hardening pattern as analytics_purpose_policy,
-- 20260809000000).
REVOKE ALL PRIVILEGES ON public.item_listing_price_history FROM anon;
REVOKE ALL PRIVILEGES ON public.item_listing_price_history FROM authenticated;

GRANT SELECT, INSERT ON public.item_listing_price_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_listing_price_history TO service_role;
GRANT USAGE ON SEQUENCE public.item_listing_price_history_id_seq TO authenticated;

-- ── 3. asking_price >= 0 guard on item_listings itself ────────────────────
-- Defense in depth for the same Part 3 rule, on the source column. Safe
-- to add now — asking_price is NULL for every existing row in production
-- (confirmed before writing this migration).

ALTER TABLE public.item_listings
  ADD CONSTRAINT item_listings_asking_price_positive_check
    CHECK (asking_price IS NULL OR asking_price > 0);

-- ── 4. Trigger function + trigger ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.track_item_listing_price_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.asking_price IS NOT NULL THEN
      INSERT INTO public.item_listing_price_history (user_id, item_listing_id, old_asking_price, new_asking_price)
      VALUES (NEW.user_id, NEW.id, NULL, NEW.asking_price);
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'UPDATE' (trigger is declared `UPDATE OF asking_price`, so
  -- this only fires when the column is part of the UPDATE's SET list —
  -- but that alone doesn't guarantee the VALUE changed, hence the
  -- IS DISTINCT FROM check below).
  IF NEW.asking_price IS DISTINCT FROM OLD.asking_price AND NEW.asking_price IS NOT NULL THEN
    INSERT INTO public.item_listing_price_history (user_id, item_listing_id, old_asking_price, new_asking_price)
    VALUES (NEW.user_id, NEW.id, OLD.asking_price, NEW.asking_price);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_listings_track_price_history
  AFTER INSERT OR UPDATE OF asking_price ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.track_item_listing_price_history();

COMMENT ON FUNCTION public.track_item_listing_price_history() IS
  'Writes item_listing_price_history rows for item_listings.asking_price '
  'changes only. Never fires for text/status/date-only updates (trigger is '
  'scoped to `UPDATE OF asking_price`). Never logs a transition TO NULL '
  '(clearing a price is allowed but not audited) or an INSERT/UPDATE where '
  'the value did not actually change.';
