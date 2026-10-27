-- Listing management: Trade flag, Unlist vs inventory-exit end, and one
-- atomic, idempotent write path shared by the item page and MCP
-- (manage_listing). Forward-only.
--
-- ── 1. trade_enabled ──────────────────────────────────────────────────────
-- "This specific published listing is explicitly offered for trade."
-- Describes the LISTING, not general willingness to trade; unrelated to the
-- pre-existing trade_value column. Every existing row becomes false — no
-- historical Trade state is inferred.
--
-- Offer mode is DERIVED, never stored:
--   Sale only     asking_price IS NOT NULL AND NOT trade_enabled
--   Sale + Trade  asking_price IS NOT NULL AND trade_enabled
--   Trade only    asking_price IS NULL     AND trade_enabled
--
-- ── 2. end_reason ─────────────────────────────────────────────────────────
-- status stays exactly as it was ('draft' | 'active' | 'ended' |
-- 'cancelled'). 'cancelled' keeps its existing meaning — a record that was
-- never a real listing (created by mistake), excluded from every analytics
-- function (20260829000000, 20260830000000, build_listing_evidence). A
-- manual Unlist removes a REAL ad that was live for some time, so it must
-- stay a real listing cycle: it is status 'ended' with end_reason
-- 'UNLISTED'. Sell/Trade closing an active listing is 'ended' with
-- end_reason 'ITEM_EXITED'. Pre-existing ended rows keep end_reason NULL
-- (unknown — the old End Listing button was used for both).
--
-- ── 3. Listing terms rule (one SQL definition) ────────────────────────────
-- listing_terms_error() is the rule apply_listing_changes applies to every
-- LIST and UPDATE (the business path both the item page and MCP use):
--   Kijiji           asking_price OR trade_enabled
--   other platforms  asking_price required
--   trade_enabled    only on Marketplace and Kijiji (Reverb is a sale listing)
-- It is deliberately NOT a table-wide constraint: production holds active
-- listings created before prices were required (17 on 2026-10-26: 2
-- Marketplace, 6 Kijiji, 9 Reverb) — a real legacy state that analytics
-- reports as "asking price unavailable" and that must stay representable.
-- The one invariant with no legacy exception — Trade never on a platform
-- that doesn't offer it — IS enforced on every write by
-- item_listings_validate_terms. src/lib/listings/listingTerms.ts mirrors the
-- rule for UI messages.

-- ── Columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.item_listings
  ADD COLUMN trade_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN end_reason    text;

ALTER TABLE public.item_listings
  ADD CONSTRAINT item_listings_end_reason_check
    CHECK (end_reason IS NULL OR (end_reason IN ('UNLISTED', 'ITEM_EXITED') AND status = 'ended'));

COMMENT ON COLUMN public.item_listings.trade_enabled IS
  'This published listing is explicitly offered for trade (Marketplace/Kijiji only). Not trade_value. '
  'Offer mode is derived: price+no trade = sale only, price+trade = sale + trade, no price+trade = trade only.';
COMMENT ON COLUMN public.item_listings.end_reason IS
  'Why an ended cycle ended: UNLISTED (ad removed while the item is still owned) or ITEM_EXITED (Sell/Trade). '
  'NULL on cycles ended before 2026-10-26 (not recorded).';

-- ── Terms rule ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.listing_terms_error(p_channel_name text, p_asking_price numeric, p_trade_enabled boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN COALESCE(p_trade_enabled, false) AND lower(btrim(COALESCE(p_channel_name, ''))) NOT IN ('marketplace', 'kijiji')
      THEN 'LISTING_TRADE_NOT_SUPPORTED'
    WHEN p_asking_price IS NOT NULL AND p_asking_price <= 0
      THEN 'LISTING_PRICE_INVALID'
    WHEN lower(btrim(COALESCE(p_channel_name, ''))) = 'kijiji'
      THEN CASE WHEN p_asking_price IS NULL AND NOT COALESCE(p_trade_enabled, false) THEN 'LISTING_PRICE_OR_TRADE_REQUIRED' END
    WHEN p_asking_price IS NULL
      THEN 'LISTING_PRICE_REQUIRED'
  END;
$$;

COMMENT ON FUNCTION public.listing_terms_error(text, numeric, boolean) IS
  'NULL when (platform, asking_price, trade_enabled) are valid terms for an ACTIVE listing, else an error code. '
  'Applied by apply_listing_changes to every LIST/UPDATE.';

CREATE OR REPLACE FUNCTION public.item_listings_validate_terms()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.trade_enabled AND NOT EXISTS (
    SELECT 1 FROM public.deal_channels dc
    WHERE dc.id = NEW.deal_channel_id AND lower(btrim(dc.name)) IN ('marketplace', 'kijiji')
  ) THEN
    RAISE EXCEPTION 'LISTING_TRADE_NOT_SUPPORTED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_listings_validate_terms
  BEFORE INSERT OR UPDATE OF trade_enabled, deal_channel_id ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.item_listings_validate_terms();

-- ── end_reason defaulting ─────────────────────────────────────────────────
-- Every Sell/Trade/multi-sell/trade-edit function marks the item sold/traded
-- BEFORE it ends that item's active listings (same transaction), so an end
-- without an explicit reason on an exited item is an inventory-exit end; on
-- an item still in inventory it can only be a manual removal. Explicit
-- reasons (apply_listing_changes UNLIST) are kept as given.

CREATE OR REPLACE FUNCTION public.item_listings_set_end_reason()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ended' AND OLD.status IS DISTINCT FROM 'ended' AND NEW.end_reason IS NULL THEN
    NEW.end_reason := CASE
      WHEN (SELECT i.status FROM public.inventory_items i WHERE i.id = NEW.inventory_item_id) IN ('sold', 'traded')
        THEN 'ITEM_EXITED'
      ELSE 'UNLISTED'
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_listings_set_end_reason
  BEFORE UPDATE OF status ON public.item_listings
  FOR EACH ROW EXECUTE FUNCTION public.item_listings_set_end_reason();

-- ── Mutation ledger (idempotency) ─────────────────────────────────────────

CREATE TABLE public.item_listing_mutations (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           int         NOT NULL REFERENCES public.app_users(id) DEFAULT public.get_app_user_id(),
  mutation_id       uuid        NOT NULL,
  inventory_item_id bigint      NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  request_hash      text        NOT NULL,
  result            jsonb       NOT NULL,
  source            text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_listing_mutations_source_check CHECK (source IN ('UI', 'MCP'))
);

CREATE UNIQUE INDEX item_listing_mutations_user_mutation ON public.item_listing_mutations (user_id, mutation_id);
CREATE INDEX idx_item_listing_mutations_item ON public.item_listing_mutations (inventory_item_id);

COMMENT ON TABLE public.item_listing_mutations IS
  'One row per APPLIED/NO_CHANGE apply_listing_changes call; a retry with the same (user, mutation_id) replays result. '
  'REVIEW_REQUIRED/REJECTED calls write nothing, so the corrected request may reuse the mutation_id.';

ALTER TABLE public.item_listing_mutations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "item_listing_mutations: select own"
  ON public.item_listing_mutations FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "item_listing_mutations: insert own"
  ON public.item_listing_mutations FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

REVOKE ALL PRIVILEGES ON public.item_listing_mutations FROM anon;
REVOKE ALL PRIVILEGES ON public.item_listing_mutations FROM authenticated;
GRANT SELECT, INSERT ON public.item_listing_mutations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_listing_mutations TO service_role;
GRANT USAGE ON SEQUENCE public.item_listing_mutations_id_seq TO authenticated;

-- ── apply_listing_changes ─────────────────────────────────────────────────
--
-- The single business write path for LIST / UPDATE / UNLIST, called by the
-- item page (src/components/AiAssistantCard.tsx) and MCP manage_listing,
-- both through src/lib/listings/listingWriteService.ts. SECURITY INVOKER:
-- every read/write goes through the caller's own RLS (another user's item
-- is simply not found), and the existing triggers (price history, inventory
-- status sync, terms guard, end_reason) run exactly as for any write.
--
-- p_request:
--   mutation_id  uuid    (required)
--   item_id      bigint  (required)
--   source       'UI' | 'MCP'
--   actions      [ { action: LIST|UPDATE|UNLIST, deal_channel_id,
--                    set_price bool, asking_price numeric|null,
--                    set_trade bool, trade_enabled bool,
--                    date 'YYYY-MM-DD' (LIST: listed_at, UNLIST: ended_at) } ]
--
-- All actions are planned first; if ANY is REJECTED or needs REVIEW nothing
-- is written. Otherwise every write happens in this one transaction, so a
-- batch is all-or-nothing. Returns
--   { status: APPLIED | NO_CHANGE | REVIEW_REQUIRED | REJECTED, replay,
--     item_id, item_status_before, item_status_after, active_channel_ids_after,
--     actions: [ { index, action, channel_id, channel_name, outcome, code,
--                  listing_id, before {...} | null, after {...} | null } ] }

CREATE OR REPLACE FUNCTION public.apply_listing_changes(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          int := public.get_app_user_id();
  v_mutation_id  uuid;
  v_item_id      bigint;
  v_source       text := COALESCE(p_request->>'source', 'UI');
  v_actions      jsonb := COALESCE(p_request->'actions', '[]'::jsonb);
  v_hash         text;
  v_prior        record;
  v_item_status  text;
  v_acquired     date;
  v_a            jsonb;
  v_i            int;
  v_kind         text;
  v_channel_id   bigint;
  v_channel      text;
  v_is_platform  boolean;
  v_cur          public.item_listings%ROWTYPE;
  v_has_cur      boolean;
  v_price        numeric;
  v_trade        boolean;
  v_date         date;
  v_err          text;
  v_plan         jsonb := '[]'::jsonb;
  v_p            jsonb;
  v_row          public.item_listings%ROWTYPE;
  v_out          jsonb := '[]'::jsonb;
  v_status       text;
  v_result       jsonb;
  v_any_change   boolean := false;
  v_seen         bigint[] := '{}';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  BEGIN
    v_mutation_id := (p_request->>'mutation_id')::uuid;
    v_item_id := (p_request->>'item_id')::bigint;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('status', 'REJECTED', 'code', 'VALIDATION_ERROR', 'message', 'mutation_id must be a UUID and item_id an integer.');
  END;
  IF v_mutation_id IS NULL OR v_item_id IS NULL OR jsonb_typeof(v_actions) <> 'array'
     OR jsonb_array_length(v_actions) = 0 OR jsonb_array_length(v_actions) > 10 THEN
    RETURN jsonb_build_object('status', 'REJECTED', 'code', 'VALIDATION_ERROR', 'message', 'mutation_id, item_id and 1-10 actions are required.');
  END IF;
  IF v_source NOT IN ('UI', 'MCP') THEN
    RETURN jsonb_build_object('status', 'REJECTED', 'code', 'VALIDATION_ERROR', 'message', 'source must be UI or MCP.');
  END IF;

  v_hash := md5(v_item_id::text || ':' || v_actions::text);

  -- ── Idempotency: serialize this mutation id, replay if already applied ──
  PERFORM pg_advisory_xact_lock(hashtextextended('item_listing_mutation:' || v_uid::text || ':' || v_mutation_id::text, 0));
  SELECT m.request_hash, m.result INTO v_prior FROM public.item_listing_mutations m
  WHERE m.user_id = v_uid AND m.mutation_id = v_mutation_id;
  IF FOUND THEN
    IF v_prior.request_hash = v_hash THEN
      RETURN v_prior.result || jsonb_build_object('replay', true);
    END IF;
    RETURN jsonb_build_object('status', 'REJECTED', 'code', 'MUTATION_ID_REUSED',
      'message', 'This mutation_id was already used for a different listing change. Use a new mutation_id.');
  END IF;

  -- ── The item (own only — RLS), locked so concurrent changes serialize ──
  SELECT i.status INTO v_item_status FROM public.inventory_items i
  WHERE i.id = v_item_id AND i.user_id = v_uid
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'REJECTED', 'code', 'ITEM_NOT_FOUND', 'item_id', v_item_id, 'message', 'Item not found.');
  END IF;

  SELECT min(d.deal_date) INTO v_acquired
  FROM public.deal_items di JOIN public.deals d ON d.id = di.deal_id
  WHERE di.item_id = v_item_id AND di.direction = 'in';

  -- ── Plan every action (no writes) ───────────────────────────────────────
  v_i := 0;
  FOR v_a IN SELECT * FROM jsonb_array_elements(v_actions) LOOP
    v_kind := upper(COALESCE(v_a->>'action', ''));
    v_channel_id := (v_a->>'deal_channel_id')::bigint;
    v_err := NULL;
    v_status := NULL;
    v_has_cur := false;
    v_price := NULL;
    v_trade := NULL;
    v_date := NULL;

    SELECT dc.name, dc.is_listing_platform INTO v_channel, v_is_platform FROM public.deal_channels dc WHERE dc.id = v_channel_id;

    IF v_kind NOT IN ('LIST', 'UPDATE', 'UNLIST') THEN
      v_status := 'REJECTED'; v_err := 'INVALID_ACTION';
    ELSIF v_channel IS NULL OR NOT COALESCE(v_is_platform, false) THEN
      v_status := 'REJECTED'; v_err := 'INVALID_PLATFORM';
    ELSIF v_channel_id = ANY (v_seen) THEN
      v_status := 'REJECTED'; v_err := 'DUPLICATE_PLATFORM';
    END IF;
    v_seen := v_seen || v_channel_id;

    IF v_status IS NULL THEN
      SELECT * INTO v_cur FROM public.item_listings il
      WHERE il.inventory_item_id = v_item_id AND il.deal_channel_id = v_channel_id AND il.status IN ('draft', 'active')
      FOR UPDATE;
      v_has_cur := FOUND;

      v_date := NULLIF(v_a->>'date', '')::date;

      IF v_kind IN ('LIST', 'UPDATE') AND v_item_status IN ('sold', 'traded') THEN
        v_status := 'REJECTED'; v_err := 'ITEM_NOT_IN_INVENTORY';
      ELSIF v_kind = 'LIST' THEN
        IF v_has_cur AND v_cur.status = 'active' THEN
          v_status := 'REVIEW'; v_err := 'LISTING_ALREADY_ACTIVE';
        ELSE
          v_price := CASE WHEN COALESCE((v_a->>'set_price')::boolean, false) THEN (v_a->>'asking_price')::numeric
                          WHEN v_has_cur THEN v_cur.asking_price END;
          v_trade := CASE WHEN COALESCE((v_a->>'set_trade')::boolean, false) THEN COALESCE((v_a->>'trade_enabled')::boolean, false)
                          ELSE false END;
          v_err := public.listing_terms_error(v_channel, v_price, v_trade);
          IF v_err IS NULL AND v_date IS NULL THEN v_err := 'DATE_REQUIRED'; END IF;
          IF v_err IS NULL AND v_date > CURRENT_DATE THEN v_err := 'DATE_IN_FUTURE'; END IF;
          IF v_err IS NULL AND v_acquired IS NOT NULL AND v_date < v_acquired THEN v_err := 'LISTED_BEFORE_ACQUIRED'; END IF;
          v_status := CASE WHEN v_err IS NULL THEN 'CREATED' ELSE 'REJECTED' END;
        END IF;
      ELSIF v_kind = 'UPDATE' THEN
        IF NOT v_has_cur OR v_cur.status <> 'active' THEN
          v_status := 'REVIEW'; v_err := 'NO_ACTIVE_LISTING';
        ELSE
          v_price := CASE WHEN COALESCE((v_a->>'set_price')::boolean, false) THEN (v_a->>'asking_price')::numeric ELSE v_cur.asking_price END;
          v_trade := CASE WHEN COALESCE((v_a->>'set_trade')::boolean, false) THEN COALESCE((v_a->>'trade_enabled')::boolean, false) ELSE v_cur.trade_enabled END;
          IF v_price IS NOT DISTINCT FROM v_cur.asking_price AND v_trade = v_cur.trade_enabled THEN
            v_status := 'NO_CHANGE';
          ELSE
            v_err := public.listing_terms_error(v_channel, v_price, v_trade);
            v_status := CASE WHEN v_err IS NULL THEN 'UPDATED' ELSE 'REJECTED' END;
          END IF;
        END IF;
      ELSE -- UNLIST
        IF NOT v_has_cur OR v_cur.status <> 'active' THEN
          v_status := 'NO_CHANGE'; v_err := 'NOT_LISTED';
        ELSE
          v_date := COALESCE(v_date, CURRENT_DATE);
          IF v_date > CURRENT_DATE THEN v_err := 'DATE_IN_FUTURE';
          ELSIF v_date < v_cur.listed_at THEN v_err := 'UNLISTED_BEFORE_LISTED';
          END IF;
          v_status := CASE WHEN v_err IS NULL THEN 'UNLISTED' ELSE 'REJECTED' END;
        END IF;
      END IF;
    END IF;

    v_plan := v_plan || jsonb_build_object(
      'index', v_i, 'action', v_kind, 'channel_id', v_channel_id, 'channel_name', v_channel,
      'outcome', v_status, 'code', v_err,
      'listing_id', CASE WHEN v_has_cur THEN v_cur.id END,
      'draft_id', CASE WHEN v_has_cur AND v_cur.status = 'draft' THEN v_cur.id END,
      'before', CASE WHEN v_has_cur AND v_cur.status = 'active' THEN jsonb_build_object(
        'status', v_cur.status, 'asking_price', v_cur.asking_price, 'trade_enabled', v_cur.trade_enabled, 'listed_at', v_cur.listed_at) END,
      'new_price', v_price, 'new_trade', v_trade, 'date', v_date);
    v_i := v_i + 1;
  END LOOP;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan) p WHERE p->>'outcome' = 'REJECTED') THEN
    v_status := 'REJECTED';
  ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_plan) p WHERE p->>'outcome' = 'REVIEW') THEN
    v_status := 'REVIEW_REQUIRED';
  END IF;
  IF v_status IN ('REJECTED', 'REVIEW_REQUIRED') THEN
    SELECT jsonb_agg(p - 'new_price' - 'new_trade' - 'date' - 'draft_id' ORDER BY (p->>'index')::int) INTO v_out FROM jsonb_array_elements(v_plan) p;
    RETURN jsonb_build_object('status', v_status, 'replay', false, 'item_id', v_item_id,
      'item_status_before', v_item_status, 'item_status_after', v_item_status, 'actions', v_out);
  END IF;

  -- ── Apply (same transaction; any trigger error aborts everything) ───────
  FOR v_p IN SELECT * FROM jsonb_array_elements(v_plan) LOOP
    v_row := NULL;
    IF v_p->>'outcome' = 'CREATED' THEN
      IF (v_p->>'draft_id') IS NOT NULL THEN
        UPDATE public.item_listings il
           SET status = 'active', listed_at = (v_p->>'date')::date,
               asking_price = (v_p->>'new_price')::numeric, trade_enabled = (v_p->>'new_trade')::boolean, updated_at = now()
         WHERE il.id = (v_p->>'draft_id')::bigint
        RETURNING * INTO v_row;
      ELSE
        INSERT INTO public.item_listings (user_id, inventory_item_id, deal_channel_id, status, listed_at, asking_price, trade_enabled)
        VALUES (v_uid, v_item_id, (v_p->>'channel_id')::bigint, 'active', (v_p->>'date')::date,
                (v_p->>'new_price')::numeric, (v_p->>'new_trade')::boolean)
        RETURNING * INTO v_row;
      END IF;
      v_any_change := true;
    ELSIF v_p->>'outcome' = 'UPDATED' THEN
      -- asking_price is only SET when it changes, so the price-history
      -- trigger (UPDATE OF asking_price) never fires for a Trade-only change.
      IF ((v_p->>'new_price')::numeric) IS DISTINCT FROM ((v_p->'before'->>'asking_price')::numeric) THEN
        UPDATE public.item_listings il
           SET asking_price = (v_p->>'new_price')::numeric, trade_enabled = (v_p->>'new_trade')::boolean, updated_at = now()
         WHERE il.id = (v_p->>'listing_id')::bigint
        RETURNING * INTO v_row;
      ELSE
        UPDATE public.item_listings il
           SET trade_enabled = (v_p->>'new_trade')::boolean, updated_at = now()
         WHERE il.id = (v_p->>'listing_id')::bigint
        RETURNING * INTO v_row;
      END IF;
      v_any_change := true;
    ELSIF v_p->>'outcome' = 'UNLISTED' THEN
      UPDATE public.item_listings il
         SET status = 'ended', ended_at = (v_p->>'date')::date, end_reason = 'UNLISTED', updated_at = now()
       WHERE il.id = (v_p->>'listing_id')::bigint AND il.status = 'active'
      RETURNING * INTO v_row;
      v_any_change := true;
    END IF;

    v_out := v_out || ((v_p - 'new_price' - 'new_trade' - 'date' - 'draft_id') || jsonb_build_object(
      'listing_id', COALESCE(v_row.id, (v_p->>'listing_id')::bigint),
      'after', CASE WHEN v_row.id IS NOT NULL THEN jsonb_build_object(
        'status', v_row.status, 'asking_price', v_row.asking_price, 'trade_enabled', v_row.trade_enabled,
        'listed_at', v_row.listed_at, 'ended_at', v_row.ended_at, 'end_reason', v_row.end_reason) END));
  END LOOP;

  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_change THEN 'APPLIED' ELSE 'NO_CHANGE' END,
    'replay', false,
    'item_id', v_item_id,
    'item_status_before', v_item_status,
    'item_status_after', (SELECT i.status FROM public.inventory_items i WHERE i.id = v_item_id),
    'active_channel_ids_after', COALESCE((SELECT jsonb_agg(il.deal_channel_id ORDER BY il.deal_channel_id) FROM public.item_listings il
                                          WHERE il.inventory_item_id = v_item_id AND il.status = 'active'), '[]'::jsonb),
    'actions', v_out);

  INSERT INTO public.item_listing_mutations (user_id, mutation_id, inventory_item_id, request_hash, result, source)
  VALUES (v_uid, v_mutation_id, v_item_id, v_hash, v_result, v_source);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_listing_changes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_listing_changes(jsonb) TO authenticated;

COMMENT ON FUNCTION public.apply_listing_changes(jsonb) IS
  'LIST / UPDATE / UNLIST for one item, all-or-nothing, idempotent per (user, mutation_id). SECURITY INVOKER (caller RLS). '
  'Never ends a listing as an inventory exit — Sell/Trade operations do that (end_reason ITEM_EXITED).';
