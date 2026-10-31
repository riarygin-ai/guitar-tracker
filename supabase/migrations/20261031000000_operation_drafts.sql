-- Operation drafts: capture a planned Buy / Sell / Trade (from ChatGPT/MCP or
-- the GT UI) without any completed-operation effect, then finalize it through
-- the EXISTING operation RPCs.
--
-- ── WHY A SEPARATE TABLE (not a status column on deals) ──────────────────
-- deals / deal_items / cash_flow are read as "completed operations" by 22
-- database functions, 2 views (analytics_item_lifecycle,
-- inventory_items_with_value) and ~10 application modules (operations
-- analytics, trade chain, item context/lineage, profit, Business Coach,
-- MCP analytics). A draft row there would need a filter in every one of
-- them — and every FUTURE query would include drafts by default. Keeping
-- drafts in their own tables makes "a draft is never a completed
-- operation" structural: nothing is written to deals / deal_items /
-- cash_flow / item_listings / item_leads until finalization, and
-- finalization is the unchanged create_trade_operation /
-- create_sell_operation / create_buy_operation (or
-- create_operation_with_winning_lead), so its status / listing / cash /
-- lead effects are exactly those of a normal operation.
--
-- ── WHAT A DRAFT HOLDS ───────────────────────────────────────────────────
-- operation_drafts: type, proposed date (may be in the future), channel,
-- contact name, optional lead (never mutated while draft), planned cash
-- paid / received, notes (meeting logistics etc.), lifecycle
-- OPEN -> FINALIZED (deal_id set) | DISCARDED; mutation_id + request_hash +
-- the saved result for idempotent replays.
-- operation_draft_items: outgoing existing items (direction 'out') and
-- incoming items (direction 'in'). Incoming items the draft created are
-- ordinary inventory_items with the EXISTING status 'new' — real ids, so
-- photos / edits work immediately — flagged created_by_draft. The
-- (item_id, user_id) foreign key makes a cross-user link impossible.
--
-- ── WRITE PATH ───────────────────────────────────────────────────────────
-- Only the RPCs below write these tables (SECURITY INVOKER: every
-- inventory / deal write runs under the caller's own RLS, exactly as when
-- the operation forms call the RPCs). Direct client INSERT / UPDATE is
-- refused by the guard triggers: the RPCs set the transaction-local
-- app.operation_draft_write, which a PostgREST client cannot set (same
-- mechanism as app.operation_deal_id, 20261024000000). FINALIZED and
-- DISCARDED are terminal.
--
-- ── ANALYTICS ────────────────────────────────────────────────────────────
-- analytics_item_lifecycle (and analytics_item_lifecycle_v2 on top of it,
-- which every analytics snapshot builder reads) counts EVERY inventory
-- item as open inventory. A 'new' item that exists only because of an OPEN
-- draft is not inventory yet, so the view now leaves it out (one WHERE in
-- the base CTE; nothing else changes). It appears there the moment the
-- draft is finalized (status owned + its acquisition deal), or again as a
-- plain 'new' item if the draft is discarded and the item kept.

-- ─── 1. Tables ────────────────────────────────────────────────────────────

CREATE TABLE public.operation_drafts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         int          NOT NULL DEFAULT public.get_app_user_id() REFERENCES public.app_users(id),
  operation_type  text         NOT NULL CHECK (operation_type IN ('BUY', 'SELL', 'TRADE')),
  status          text         NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FINALIZED', 'DISCARDED')),
  proposed_date   date,
  deal_channel_id bigint       REFERENCES public.deal_channels(id),
  contact_name    text         CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 200),
  lead_id         bigint       REFERENCES public.item_leads(id) ON DELETE SET NULL,
  cash_paid       numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_paid >= 0),
  cash_received   numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_received >= 0),
  notes           text         CHECK (notes IS NULL OR length(notes) <= 4000),
  source          text         NOT NULL CHECK (source IN ('MCP', 'UI')),
  client_label    text,
  mutation_id     uuid         NOT NULL,
  request_hash    text,
  result          jsonb,
  deal_id         bigint       REFERENCES public.deals(id),
  finalized_at    timestamptz,
  discarded_at    timestamptz,
  discard_result  jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT operation_drafts_mutation_unique UNIQUE (user_id, mutation_id),
  CONSTRAINT operation_drafts_finalized_has_deal CHECK ((status = 'FINALIZED') = (deal_id IS NOT NULL)),
  CONSTRAINT operation_drafts_cash_by_type CHECK (
    (operation_type <> 'BUY' OR cash_received = 0) AND (operation_type <> 'SELL' OR cash_paid = 0))
);

CREATE INDEX idx_operation_drafts_user_status ON public.operation_drafts (user_id, status, id DESC);

CREATE TABLE public.operation_draft_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id         bigint  NOT NULL REFERENCES public.operation_drafts(id) ON DELETE CASCADE,
  user_id          int     NOT NULL DEFAULT public.get_app_user_id(),
  item_id          bigint  NOT NULL,
  direction        text    NOT NULL CHECK (direction IN ('in', 'out')),
  created_by_draft boolean NOT NULL DEFAULT false,
  position         smallint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operation_draft_items_item_owner_fk FOREIGN KEY (item_id, user_id)
    REFERENCES public.inventory_items (id, user_id) ON DELETE CASCADE,
  CONSTRAINT operation_draft_items_unique UNIQUE (draft_id, item_id),
  CONSTRAINT operation_draft_items_created_is_incoming CHECK (NOT created_by_draft OR direction = 'in')
);

CREATE INDEX idx_operation_draft_items_item ON public.operation_draft_items (item_id);

COMMENT ON TABLE public.operation_drafts IS
  'Planned (not completed) Buy / Sell / Trade. Never read as a completed operation: nothing reaches deals / deal_items / '
  'cash_flow / listings / leads until finalize_operation_draft runs the existing operation RPC. Written only through '
  'create_operation_draft / update_operation_draft / discard_operation_draft / finalize_operation_draft.';
COMMENT ON TABLE public.operation_draft_items IS
  'Items of an operation draft. direction out = existing item the user plans to give; in = item to receive. '
  'created_by_draft = an inventory item (status ''new'') created by create_operation_draft.';

ALTER TABLE public.operation_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_draft_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operation_drafts: select own" ON public.operation_drafts FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());
CREATE POLICY "operation_drafts: insert own" ON public.operation_drafts FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());
CREATE POLICY "operation_drafts: update own" ON public.operation_drafts FOR UPDATE TO authenticated
  USING (user_id = public.get_app_user_id()) WITH CHECK (user_id = public.get_app_user_id());
CREATE POLICY "operation_draft_items: select own" ON public.operation_draft_items FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());
CREATE POLICY "operation_draft_items: insert own" ON public.operation_draft_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

REVOKE ALL ON public.operation_drafts, public.operation_draft_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.operation_drafts TO authenticated;
GRANT SELECT, INSERT ON public.operation_draft_items TO authenticated;
GRANT ALL ON public.operation_drafts, public.operation_draft_items TO service_role;

-- ─── 2. Guards: RPC-only writes, terminal states ─────────────────────────

CREATE OR REPLACE FUNCTION public.operation_drafts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- The lead's ON DELETE SET NULL (nothing else changes) is always allowed.
  IF TG_TABLE_NAME = 'operation_drafts' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD)->>'lead_id') IS NOT NULL AND (to_jsonb(NEW)->>'lead_id') IS NULL
       AND (to_jsonb(NEW) - 'lead_id' - 'updated_at') = (to_jsonb(OLD) - 'lead_id' - 'updated_at') THEN
      RETURN NEW;
    END IF;
  END IF;
  IF COALESCE(current_setting('app.operation_draft_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'OPERATION_DRAFT_RPC_ONLY: operation drafts change only through their RPCs';
  END IF;
  IF TG_TABLE_NAME = 'operation_drafts' AND TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'OPEN' THEN
      RAISE EXCEPTION 'DRAFT_NOT_OPEN: draft % is %', OLD.id, OLD.status;
    END IF;
    IF NEW.user_id <> OLD.user_id OR NEW.operation_type <> OLD.operation_type OR NEW.mutation_id <> OLD.mutation_id THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: owner, type and mutation id of a draft are fixed';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_operation_drafts_guard
  BEFORE INSERT OR UPDATE ON public.operation_drafts
  FOR EACH ROW EXECUTE FUNCTION public.operation_drafts_guard();
CREATE TRIGGER trg_operation_draft_items_guard
  BEFORE INSERT OR UPDATE ON public.operation_draft_items
  FOR EACH ROW EXECUTE FUNCTION public.operation_drafts_guard();

-- ─── 3. Shared validation ─────────────────────────────────────────────────

-- Lead for a draft: the caller's own, on one of the draft's OUTGOING items,
-- and still eligible to become a winning lead (no deal link, not COMPLETED)
-- — the same eligibility as the operation forms' lead picker. Read only.
CREATE OR REPLACE FUNCTION public._operation_draft_check_lead(p_uid int, p_lead_id bigint, p_outgoing bigint[])
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lead record;
BEGIN
  IF p_lead_id IS NULL THEN RETURN; END IF;
  SELECT il.inventory_item_id, il.deal_id, il.status INTO v_lead
  FROM public.item_leads il WHERE il.id = p_lead_id AND il.user_id = p_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND: lead %', p_lead_id;
  END IF;
  IF NOT (v_lead.inventory_item_id = ANY (COALESCE(p_outgoing, '{}'))) THEN
    RAISE EXCEPTION 'LEAD_NOT_ON_OUTGOING_ITEM: lead % is on item %, which is not an outgoing item of this draft', p_lead_id, v_lead.inventory_item_id;
  END IF;
  IF v_lead.deal_id IS NOT NULL OR v_lead.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: lead % is already completed / linked to an operation', p_lead_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._operation_draft_check_cash(p_type text, p_cash_paid numeric, p_cash_received numeric)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_cash_paid < 0 OR p_cash_received < 0 OR p_cash_paid > 10000000 OR p_cash_received > 10000000 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: cash amounts must be between 0 and 10,000,000';
  END IF;
  IF p_type = 'BUY' AND p_cash_received <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a Buy draft has no cash received';
  END IF;
  IF p_type = 'SELL' AND p_cash_paid <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a Sell draft has no cash paid';
  END IF;
END;
$$;

-- ─── 4. create_operation_draft ───────────────────────────────────────────
-- p_request (built by src/lib/operations/operationDraftService.ts, which
-- resolves names to ids):
--   mutation_id, request_hash, source 'MCP'|'UI', client_label,
--   operation_type 'BUY'|'SELL'|'TRADE', proposed_date, deal_channel_id,
--   contact_name, lead_id, cash_paid, cash_received, notes,
--   outgoing_item_ids [bigint],
--   incoming_items [{ brand_id | brand_name, model, year, color,
--     serial_number, item_subtype_id, condition, purpose_id,
--     estimated_sold_value, notes, tag_ids [bigint] }]
-- One transaction: draft + every incoming 'new' item + links, or nothing.
-- Same mutation_id + same request -> the saved result (status REPLAY), never
-- a second draft or second set of items; same id + different request ->
-- MUTATION_ID_REUSED.

CREATE OR REPLACE FUNCTION public.create_operation_draft(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       int := public.get_app_user_id();
  v_mutation  uuid;
  v_type      text := p_request->>'operation_type';
  v_out       bigint[];
  v_in        jsonb := COALESCE(p_request->'incoming_items', '[]'::jsonb);
  v_paid      numeric := COALESCE((p_request->>'cash_paid')::numeric, 0);
  v_received  numeric := COALESCE((p_request->>'cash_received')::numeric, 0);
  v_channel   bigint := (p_request->>'deal_channel_id')::bigint;
  v_lead_id   bigint := (p_request->>'lead_id')::bigint;
  v_existing  record;
  v_draft_id  bigint;
  v_item      jsonb;
  v_item_id   bigint;
  v_brand_id  bigint;
  v_status    text;
  v_in_ids    bigint[] := '{}';
  v_pos       int := 0;
  v_year      int;
  v_esv       numeric;
  v_result    jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  BEGIN
    v_mutation := (p_request->>'mutation_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: mutation_id must be a UUID';
  END;
  IF v_mutation IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: mutation_id is required';
  END IF;

  -- ── Idempotency: serialize this mutation id, then replay a saved result ──
  PERFORM pg_advisory_xact_lock(hashtextextended('operation-draft:' || v_uid::text || ':' || v_mutation::text, 0));
  SELECT d.id, d.request_hash, d.result INTO v_existing
  FROM public.operation_drafts d WHERE d.user_id = v_uid AND d.mutation_id = v_mutation;
  IF FOUND THEN
    IF v_existing.request_hash IS DISTINCT FROM (p_request->>'request_hash') THEN
      RAISE EXCEPTION 'MUTATION_ID_REUSED: this mutation_id already created draft % from a different request', v_existing.id;
    END IF;
    RETURN v_existing.result || jsonb_build_object('status', 'REPLAY');
  END IF;

  -- ── Draft validation (capture needs minimal facts; finalization stays strict) ──
  IF v_type IS NULL OR v_type NOT IN ('BUY', 'SELL', 'TRADE') THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: operation_type must be BUY, SELL or TRADE';
  END IF;
  IF jsonb_typeof(v_in) <> 'array' OR jsonb_typeof(COALESCE(p_request->'outgoing_item_ids', '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: outgoing_item_ids and incoming_items must be arrays';
  END IF;
  v_out := ARRAY(SELECT (x)::bigint FROM jsonb_array_elements_text(COALESCE(p_request->'outgoing_item_ids', '[]'::jsonb)) x);
  IF cardinality(v_out) <> (SELECT count(DISTINCT x) FROM unnest(v_out) x) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: an outgoing item is listed twice';
  END IF;
  IF cardinality(v_out) > 20 OR jsonb_array_length(v_in) > 20 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: at most 20 outgoing and 20 incoming items';
  END IF;
  IF v_type = 'BUY' AND (cardinality(v_out) > 0 OR jsonb_array_length(v_in) = 0) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a Buy draft needs at least one incoming item and no outgoing items';
  END IF;
  IF v_type = 'SELL' AND (jsonb_array_length(v_in) > 0 OR cardinality(v_out) = 0) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a Sell draft needs at least one outgoing item and no incoming items';
  END IF;
  IF v_type = 'TRADE' AND cardinality(v_out) + jsonb_array_length(v_in) = 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a Trade draft needs at least one item';
  END IF;
  PERFORM public._operation_draft_check_cash(v_type, v_paid, v_received);
  IF v_channel IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.deal_channels dc WHERE dc.id = v_channel) THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: channel % not found', v_channel;
  END IF;

  -- Outgoing: the caller's own existing items, currently owned / listed (the
  -- same states the Sell / Trade forms offer). Never created or duplicated.
  FOREACH v_item_id IN ARRAY v_out LOOP
    SELECT i.status INTO v_status FROM public.inventory_items i WHERE i.id = v_item_id AND i.user_id = v_uid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND: item %', v_item_id;
    END IF;
    IF v_status NOT IN ('owned', 'listed') THEN
      RAISE EXCEPTION 'ITEM_NOT_AVAILABLE: item % is %, not owned or listed', v_item_id, v_status;
    END IF;
  END LOOP;

  PERFORM public._operation_draft_check_lead(v_uid, v_lead_id, v_out);

  PERFORM set_config('app.operation_draft_write', 'on', true);

  INSERT INTO public.operation_drafts (
    user_id, operation_type, proposed_date, deal_channel_id, contact_name, lead_id, cash_paid, cash_received,
    notes, source, client_label, mutation_id, request_hash
  ) VALUES (
    v_uid, v_type, (p_request->>'proposed_date')::date, v_channel, NULLIF(btrim(p_request->>'contact_name'), ''), v_lead_id,
    v_paid, v_received, NULLIF(btrim(p_request->>'notes'), ''),
    CASE WHEN p_request->>'source' = 'UI' THEN 'UI' ELSE 'MCP' END, NULLIF(p_request->>'client_label', ''),
    v_mutation, p_request->>'request_hash'
  ) RETURNING id INTO v_draft_id;

  FOREACH v_item_id IN ARRAY v_out LOOP
    INSERT INTO public.operation_draft_items (draft_id, user_id, item_id, direction, created_by_draft, position)
    VALUES (v_draft_id, v_uid, v_item_id, 'out', false, v_pos);
    v_pos := v_pos + 1;
  END LOOP;

  -- Incoming: new inventory items with the existing status 'new'. Unknown
  -- facts stay NULL — never placeholders.
  v_pos := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_in) LOOP
    v_pos := v_pos + 1;
    IF NULLIF(btrim(v_item->>'model'), '') IS NULL THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item % needs a model', v_pos;
    END IF;
    v_brand_id := (v_item->>'brand_id')::bigint;
    IF v_brand_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.brands b WHERE b.id = v_brand_id) THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: incoming item %: brand % not found', v_pos, v_brand_id;
      END IF;
    ELSIF NULLIF(btrim(v_item->>'brand_name'), '') IS NOT NULL THEN
      SELECT b.id INTO v_brand_id FROM public.brands b WHERE lower(b.name) = lower(btrim(v_item->>'brand_name')) ORDER BY b.id LIMIT 1;
      IF v_brand_id IS NULL THEN
        -- Same as the inventory form: a brand typed that does not exist yet is created.
        INSERT INTO public.brands (name) VALUES (btrim(v_item->>'brand_name'))
        ON CONFLICT (name) DO NOTHING RETURNING id INTO v_brand_id;
        IF v_brand_id IS NULL THEN
          SELECT b.id INTO v_brand_id FROM public.brands b WHERE b.name = btrim(v_item->>'brand_name');
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item % needs a brand', v_pos;
    END IF;
    v_year := (v_item->>'year')::int;
    IF v_year IS NOT NULL AND (v_year < 1900 OR v_year > 2100) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item %: year must be between 1900 and 2100', v_pos;
    END IF;
    v_esv := (v_item->>'estimated_sold_value')::numeric;
    IF v_esv IS NOT NULL AND (v_esv <= 0 OR v_esv > 10000000) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item %: estimated_sold_value must be greater than 0', v_pos;
    END IF;
    IF (v_item->>'condition') IS NOT NULL AND (v_item->>'condition') NOT IN ('Mint', 'Excellent', 'Very Good', 'Good', 'Fair') THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item %: condition must be Mint, Excellent, Very Good, Good or Fair', v_pos;
    END IF;
    IF (v_item->>'item_subtype_id') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.item_subtypes st WHERE st.id = (v_item->>'item_subtype_id')::bigint AND st.is_active) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item %: item type not found', v_pos;
    END IF;
    IF (v_item->>'purpose_id') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.item_purposes pu WHERE pu.id = (v_item->>'purpose_id')::bigint AND pu.is_active) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: incoming item %: purpose not found', v_pos;
    END IF;

    INSERT INTO public.inventory_items (
      user_id, brand_id, model, year, color, serial_number, item_subtype_id, condition, purpose_id,
      estimated_sold_value, notes, status
    ) VALUES (
      v_uid, v_brand_id, btrim(v_item->>'model'), v_year, NULLIF(btrim(v_item->>'color'), ''),
      NULLIF(btrim(v_item->>'serial_number'), ''), (v_item->>'item_subtype_id')::bigint, v_item->>'condition',
      (v_item->>'purpose_id')::bigint, v_esv, NULLIF(btrim(v_item->>'notes'), ''), 'new'
    ) RETURNING id INTO v_item_id;

    INSERT INTO public.inventory_item_tags (item_id, tag_id)
    SELECT v_item_id, t.id FROM public.inventory_tags t
    WHERE t.is_active AND t.id IN (SELECT (x)::bigint FROM jsonb_array_elements_text(COALESCE(v_item->'tag_ids', '[]'::jsonb)) x)
    ON CONFLICT DO NOTHING;

    INSERT INTO public.operation_draft_items (draft_id, user_id, item_id, direction, created_by_draft, position)
    VALUES (v_draft_id, v_uid, v_item_id, 'in', true, v_pos - 1);
    v_in_ids := v_in_ids || v_item_id;
  END LOOP;

  v_result := jsonb_build_object(
    'draft_id', v_draft_id, 'operation_type', v_type, 'outgoing_item_ids', to_jsonb(v_out),
    'incoming_item_ids', to_jsonb(v_in_ids), 'lead_id', v_lead_id);
  UPDATE public.operation_drafts SET result = v_result WHERE id = v_draft_id;
  PERFORM set_config('app.operation_draft_write', '', true);

  RETURN v_result || jsonb_build_object('status', 'OK');
END;
$$;

-- ─── 5. update_operation_draft (planning terms only) ─────────────────────
-- Full replacement of the planning fields of an OPEN draft (date, channel,
-- contact name, lead, cash, notes). Items are edited on the items themselves
-- (inventory page) and the operation's item set in the finalization form.

CREATE OR REPLACE FUNCTION public.update_operation_draft(p_draft_id bigint, p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      int := public.get_app_user_id();
  v_d        public.operation_drafts%ROWTYPE;
  v_paid     numeric := COALESCE((p_request->>'cash_paid')::numeric, 0);
  v_received numeric := COALESCE((p_request->>'cash_received')::numeric, 0);
  v_channel  bigint := (p_request->>'deal_channel_id')::bigint;
  v_lead_id  bigint := (p_request->>'lead_id')::bigint;
  v_out      bigint[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  SELECT * INTO v_d FROM public.operation_drafts d WHERE d.id = p_draft_id AND d.user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND: draft %', p_draft_id;
  END IF;
  IF v_d.status <> 'OPEN' THEN
    RAISE EXCEPTION 'DRAFT_NOT_OPEN: draft % is %', p_draft_id, v_d.status;
  END IF;
  PERFORM public._operation_draft_check_cash(v_d.operation_type, v_paid, v_received);
  IF v_channel IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.deal_channels dc WHERE dc.id = v_channel) THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: channel % not found', v_channel;
  END IF;
  v_out := ARRAY(SELECT odi.item_id FROM public.operation_draft_items odi WHERE odi.draft_id = p_draft_id AND odi.direction = 'out');
  IF v_lead_id IS DISTINCT FROM v_d.lead_id THEN
    PERFORM public._operation_draft_check_lead(v_uid, v_lead_id, v_out);
  END IF;

  PERFORM set_config('app.operation_draft_write', 'on', true);
  UPDATE public.operation_drafts SET
    proposed_date   = (p_request->>'proposed_date')::date,
    deal_channel_id = v_channel,
    contact_name    = NULLIF(btrim(p_request->>'contact_name'), ''),
    lead_id         = v_lead_id,
    cash_paid       = v_paid,
    cash_received   = v_received,
    notes           = NULLIF(btrim(p_request->>'notes'), '')
  WHERE id = p_draft_id;
  PERFORM set_config('app.operation_draft_write', '', true);
  RETURN jsonb_build_object('status', 'OK', 'draft_id', p_draft_id);
END;
$$;

-- ─── 6. discard_operation_draft ──────────────────────────────────────────
-- No business effect (nothing was posted). With p_remove_new_items, an
-- incoming item the draft created is deleted ONLY when it is still 'new'
-- and has gained nothing of its own: no other operation, no other open
-- draft, no lead, no listing, no expense, no photo. Anything else is kept
-- (and reported with the reason); a kept item stays a plain 'new' item.

CREATE OR REPLACE FUNCTION public.discard_operation_draft(p_draft_id bigint, p_remove_new_items boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     int := public.get_app_user_id();
  v_d       public.operation_drafts%ROWTYPE;
  v_it      record;
  v_reasons text[];
  v_removed bigint[] := '{}';
  v_kept    jsonb := '[]'::jsonb;
  v_result  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  SELECT * INTO v_d FROM public.operation_drafts d WHERE d.id = p_draft_id AND d.user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND: draft %', p_draft_id;
  END IF;
  IF v_d.status = 'DISCARDED' THEN
    RETURN COALESCE(v_d.discard_result, '{}'::jsonb) || jsonb_build_object('status', 'REPLAY', 'draft_id', p_draft_id);
  END IF;
  IF v_d.status <> 'OPEN' THEN
    RAISE EXCEPTION 'DRAFT_NOT_OPEN: draft % is %', p_draft_id, v_d.status;
  END IF;

  FOR v_it IN
    SELECT odi.item_id, i.status FROM public.operation_draft_items odi
    JOIN public.inventory_items i ON i.id = odi.item_id AND i.user_id = v_uid
    WHERE odi.draft_id = p_draft_id AND odi.created_by_draft
    ORDER BY odi.position
  LOOP
    v_reasons := ARRAY_REMOVE(ARRAY[
      CASE WHEN v_it.status <> 'new' THEN 'status ' || v_it.status END,
      CASE WHEN EXISTS (SELECT 1 FROM public.deal_items di WHERE di.item_id = v_it.item_id) THEN 'used in an operation' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.operation_draft_items o JOIN public.operation_drafts od ON od.id = o.draft_id
                        WHERE o.item_id = v_it.item_id AND o.draft_id <> p_draft_id AND od.status = 'OPEN') THEN 'in another open draft' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.item_leads il WHERE il.inventory_item_id = v_it.item_id) THEN 'has leads' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.item_listings l WHERE l.inventory_item_id = v_it.item_id) THEN 'has listings' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.inventory_expenses e WHERE e.item_id = v_it.item_id) THEN 'has expenses' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.inventory_item_photos p WHERE p.inventory_item_id = v_it.item_id) THEN 'has photos' END
    ], NULL);
    IF p_remove_new_items AND cardinality(v_reasons) = 0 THEN
      DELETE FROM public.inventory_items i WHERE i.id = v_it.item_id AND i.user_id = v_uid;
      v_removed := v_removed || v_it.item_id;
    ELSE
      v_kept := v_kept || jsonb_build_object('item_id', v_it.item_id,
        'reasons', to_jsonb(CASE WHEN cardinality(v_reasons) = 0 THEN ARRAY['kept by request'] ELSE v_reasons END));
    END IF;
  END LOOP;

  v_result := jsonb_build_object('draft_id', p_draft_id, 'removed_item_ids', to_jsonb(v_removed), 'kept_items', v_kept);
  PERFORM set_config('app.operation_draft_write', 'on', true);
  UPDATE public.operation_drafts SET status = 'DISCARDED', discarded_at = now(), discard_result = v_result WHERE id = p_draft_id;
  PERFORM set_config('app.operation_draft_write', '', true);
  RETURN v_result || jsonb_build_object('status', 'OK');
END;
$$;

-- ─── 7. finalize_operation_draft ─────────────────────────────────────────
-- The deliberate GT-UI action. p_kind 'trade' | 'sale' | 'purchase' (must
-- match the draft); p_operation = the named arguments of the UNCHANGED
-- create_trade_operation / create_sell_operation / create_buy_operation,
-- exactly as the form sends them; with a winning lead, p_deal_id +
-- p_lead_request go to the UNCHANGED create_operation_with_winning_lead.
-- One transaction: the operation (its normal status / listing / cash / lead
-- effects) + the draft -> FINALIZED, or nothing. Already FINALIZED -> REPLAY
-- with its deal id (a retried or double-submitted finalize never creates a
-- second operation).
-- Finalization validation on top of the operation RPC's own: every item is
-- the caller's; outgoing items are still owned / listed (the item may have
-- been sold since the draft); incoming items of a trade / purchase are still
-- 'new' and complete — type, condition, purpose and estimated sold value,
-- the inventory form's required fields.

CREATE OR REPLACE FUNCTION public.finalize_operation_draft(
  p_draft_id     bigint,
  p_kind         text,
  p_operation    jsonb,
  p_deal_id      bigint DEFAULT NULL,
  p_lead_request jsonb  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     int := public.get_app_user_id();
  v_d       public.operation_drafts%ROWTYPE;
  v_kind    text;
  v_out     jsonb;
  v_in      jsonb;
  v_ids     bigint[];
  v_row     record;
  v_missing text[];
  v_op      jsonb;
  v_deal_id bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  SELECT * INTO v_d FROM public.operation_drafts d WHERE d.id = p_draft_id AND d.user_id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND: draft %', p_draft_id;
  END IF;
  IF v_d.status = 'FINALIZED' THEN
    RETURN jsonb_build_object('status', 'REPLAY', 'draft_id', p_draft_id, 'deal_id', v_d.deal_id);
  END IF;
  IF v_d.status <> 'OPEN' THEN
    RAISE EXCEPTION 'DRAFT_NOT_OPEN: draft % is %', p_draft_id, v_d.status;
  END IF;
  v_kind := CASE v_d.operation_type WHEN 'TRADE' THEN 'trade' WHEN 'SELL' THEN 'sale' ELSE 'purchase' END;
  IF p_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: draft % is a % draft, not %', p_draft_id, v_kind, p_kind;
  END IF;
  IF p_lead_request IS NOT NULL AND v_kind = 'purchase' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a purchase has no winning lead';
  END IF;

  v_out := CASE v_kind WHEN 'trade' THEN p_operation->'p_outgoing_items' WHEN 'sale' THEN p_operation->'p_items' ELSE '[]'::jsonb END;
  v_in  := CASE v_kind WHEN 'sale' THEN '[]'::jsonb ELSE p_operation->'p_incoming_items' END;
  v_out := COALESCE(v_out, '[]'::jsonb);
  v_in  := COALESCE(v_in, '[]'::jsonb);

  v_ids := ARRAY(SELECT (e->>'item_id')::bigint FROM jsonb_array_elements(v_out || v_in) e);
  IF EXISTS (SELECT 1 FROM unnest(v_ids) x WHERE x IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.inventory_items i WHERE i.id = x AND i.user_id = v_uid)) THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND: an operation item does not exist';
  END IF;
  IF cardinality(v_ids) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) x) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: an item appears twice in the operation';
  END IF;

  FOR v_row IN
    SELECT i.id, i.status FROM public.inventory_items i
    WHERE i.id IN (SELECT (e->>'item_id')::bigint FROM jsonb_array_elements(v_out) e)
  LOOP
    IF v_row.status NOT IN ('owned', 'listed') THEN
      RAISE EXCEPTION 'ITEM_NOT_AVAILABLE: item % is %, not owned or listed — it cannot be given in this operation', v_row.id, v_row.status;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT i.id, i.status, i.item_subtype_id, i.condition, i.purpose_id, i.estimated_sold_value FROM public.inventory_items i
    WHERE i.id IN (SELECT (e->>'item_id')::bigint FROM jsonb_array_elements(v_in) e)
    ORDER BY i.id
  LOOP
    IF v_row.status <> 'new' THEN
      RAISE EXCEPTION 'ITEM_NOT_AVAILABLE: incoming item % is %, not new', v_row.id, v_row.status;
    END IF;
    v_missing := ARRAY_REMOVE(ARRAY[
      CASE WHEN v_row.item_subtype_id IS NULL THEN 'type' END,
      CASE WHEN v_row.condition IS NULL THEN 'condition' END,
      CASE WHEN v_row.purpose_id IS NULL THEN 'purpose' END,
      CASE WHEN v_row.estimated_sold_value IS NULL THEN 'estimated sold value' END], NULL);
    IF cardinality(v_missing) > 0 THEN
      RAISE EXCEPTION 'DRAFT_ITEM_INCOMPLETE: item #% needs %', v_row.id, array_to_string(v_missing, ', ');
    END IF;
  END LOOP;

  IF p_lead_request IS NOT NULL THEN
    v_op := public.create_operation_with_winning_lead(p_kind, p_deal_id, p_operation, p_lead_request);
    IF v_op->>'status' IS DISTINCT FROM 'OK' THEN
      -- REPLAY here would mean the lead mutation committed without this draft: refuse rather than guess.
      RAISE EXCEPTION 'LEAD_LINK_%: the winning lead was already linked by this request', COALESCE(v_op->>'status', 'FAILED');
    END IF;
  ELSIF v_kind = 'trade' THEN
    v_op := public.create_trade_operation(
      p_deal_date           => (p_operation->>'p_deal_date')::date,
      p_channel_id          => (p_operation->>'p_channel_id')::bigint,
      p_notes               => p_operation->>'p_notes',
      p_cash_paid           => COALESCE((p_operation->>'p_cash_paid')::numeric, 0),
      p_cash_received       => COALESCE((p_operation->>'p_cash_received')::numeric, 0),
      p_outgoing_items      => v_out,
      p_incoming_items      => v_in,
      p_cf_transaction_date => (p_operation->>'p_cf_transaction_date')::date,
      p_cf_description      => p_operation->>'p_cf_description');
  ELSIF v_kind = 'sale' THEN
    v_op := public.create_sell_operation(
      p_deal_date      => (p_operation->>'p_deal_date')::date,
      p_channel_id     => (p_operation->>'p_channel_id')::bigint,
      p_items          => v_out,
      p_notes          => p_operation->>'p_notes',
      p_cf_description => p_operation->>'p_cf_description');
  ELSE
    v_op := public.create_buy_operation(
      p_deal_date      => (p_operation->>'p_deal_date')::date,
      p_channel_id     => (p_operation->>'p_channel_id')::bigint,
      p_incoming_items => v_in,
      p_notes          => p_operation->>'p_notes',
      p_cf_description => p_operation->>'p_cf_description');
  END IF;
  v_deal_id := (v_op->>'deal_id')::bigint;
  IF v_deal_id IS NULL THEN
    RAISE EXCEPTION 'FINALIZE_FAILED: the operation was not created';
  END IF;

  PERFORM set_config('app.operation_draft_write', 'on', true);
  UPDATE public.operation_drafts SET status = 'FINALIZED', deal_id = v_deal_id, finalized_at = now() WHERE id = p_draft_id;
  PERFORM set_config('app.operation_draft_write', '', true);

  RETURN jsonb_build_object('status', 'OK', 'draft_id', p_draft_id, 'deal_id', v_deal_id, 'cf_id', v_op->'cf_id');
END;
$$;

REVOKE ALL ON FUNCTION public.create_operation_draft(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_operation_draft(bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.discard_operation_draft(bigint, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finalize_operation_draft(bigint, text, jsonb, bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._operation_draft_check_lead(int, bigint, bigint[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._operation_draft_check_cash(text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_operation_draft(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_operation_draft(bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.discard_operation_draft(bigint, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_operation_draft(bigint, text, jsonb, bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public._operation_draft_check_lead(int, bigint, bigint[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public._operation_draft_check_cash(text, numeric, numeric) TO authenticated;

-- ─── 8. analytics_item_lifecycle: leave out open-draft-only 'new' items ──
-- Verbatim from 20260829000000 except the WHERE at the end of the base CTE.

CREATE OR REPLACE VIEW public.analytics_item_lifecycle
WITH (security_invoker = true)
AS
WITH

acquisition AS (
  SELECT DISTINCT ON (di.item_id)
    di.item_id,
    di.deal_id                                            AS acquisition_deal_id,
    d.deal_date                                            AS acquisition_date,
    d.deal_type                                            AS acquisition_deal_type,
    d.deal_channel_id                                       AS acquisition_channel_id,
    dc.name                                                 AS acquisition_channel_name,
    di.total_value                                          AS acquisition_value,
    (d.deal_type IN ('Historical Import', 'Historical Purchase', 'Historical Trade')) AS is_historical_import,
    CASE
      WHEN d.deal_type IN ('purchase', 'Historical Purchase') THEN 'purchase'
      WHEN d.deal_type IN ('trade', 'Historical Trade')       THEN 'trade'
      WHEN d.deal_type = 'Historical Import'                  THEN 'unknown'
      ELSE 'unknown'
    END                                                      AS acquisition_method,
    -- Deal In Channel (added 20260731000000)
    dc.id                                                    AS deal_in_channel_id,
    dc.name                                                  AS deal_in_channel_name,
    dc.is_listing_platform                                   AS deal_in_channel_requires_listing
  FROM public.deal_items di
  JOIN public.deals d          ON d.id = di.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE di.direction = 'in'
  ORDER BY di.item_id, d.deal_date DESC, di.id DESC
),

exit_deal AS (
  SELECT DISTINCT ON (do_.item_id)
    do_.item_id,
    do_.deal_id                                             AS exit_deal_id,
    d.deal_date                                             AS exit_date,
    d.deal_type                                             AS exit_type,
    d.deal_channel_id                                        AS exit_channel_id,
    dc.name                                                  AS exit_channel_name,
    do_.total_value                                          AS exit_value,
    (d.deal_type IN ('sale', 'trade'))                       AS is_realized,
    -- Deal Out Channel (added 20260802000000)
    dc.id                                                     AS deal_out_channel_id,
    dc.name                                                   AS deal_out_channel_name,
    dc.is_listing_platform                                    AS deal_out_channel_requires_listing
  FROM public.deal_items do_
  JOIN public.deals d          ON d.id = do_.deal_id
  LEFT JOIN public.deal_channels dc ON dc.id = d.deal_channel_id
  WHERE do_.direction = 'out'
  ORDER BY do_.item_id, d.deal_date DESC, do_.id DESC
),

-- ── listings: status-aware (new) ─────────────────────────────────────────
-- Cancelled rows are excluded from every aggregate below (Rule 1). Draft
-- rows never carry a listed_at (item_listings_status_fields_check), so
-- they contribute nothing to any of these either way (Rule 2) — the
-- explicit status IN ('active','ended')/= 'active' filters make that
-- guarantee structural here rather than incidental.
listings AS (
  SELECT
    il.inventory_item_id                                                                                    AS item_id,

    -- Historical (Rule 4/6) — latest real listed_at per platform. Existing
    -- column names, never renamed; semantics corrected to exclude
    -- cancelled.
    MAX(CASE WHEN dc.name = 'Marketplace' AND il.status IN ('active', 'ended') THEN il.listed_at END)        AS marketplace_listed_at,
    MAX(CASE WHEN dc.name = 'Kijiji'      AND il.status IN ('active', 'ended') THEN il.listed_at END)        AS kijiji_listed_at,
    MAX(CASE WHEN dc.name = 'Reverb'      AND il.status IN ('active', 'ended') THEN il.listed_at END)        AS reverb_listed_at,

    -- Current (Rule 3/5, new) — this platform's listed_at ONLY if a cycle
    -- is active on it right now. At most one such row can ever exist per
    -- item+platform (item_listings_unique_open_per_item_channel).
    MAX(CASE WHEN dc.name = 'Marketplace' AND il.status = 'active' THEN il.listed_at END)                    AS marketplace_active_listed_at,
    MAX(CASE WHEN dc.name = 'Kijiji'      AND il.status = 'active' THEN il.listed_at END)                    AS kijiji_active_listed_at,
    MAX(CASE WHEN dc.name = 'Reverb'      AND il.status = 'active' THEN il.listed_at END)                    AS reverb_active_listed_at,

    -- Historical cycle counts (Rule 6, new) — real cycles only.
    COUNT(*) FILTER (WHERE dc.name = 'Marketplace' AND il.status IN ('active', 'ended'))                     AS marketplace_listing_cycle_count,
    COUNT(*) FILTER (WHERE dc.name = 'Kijiji'      AND il.status IN ('active', 'ended'))                     AS kijiji_listing_cycle_count,
    COUNT(*) FILTER (WHERE dc.name = 'Reverb'      AND il.status IN ('active', 'ended'))                     AS reverb_listing_cycle_count,
    COUNT(*) FILTER (WHERE il.status IN ('active', 'ended'))                                                 AS listing_cycle_count,

    -- Total real listed days across every cycle (new): ended cycles
    -- contribute ended_at - listed_at; the current active cycle, if any,
    -- contributes today - listed_at. Cancelled/draft contribute nothing.
    SUM(CASE
          WHEN dc.name = 'Marketplace' AND il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN dc.name = 'Marketplace' AND il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS marketplace_total_listed_days,
    SUM(CASE
          WHEN dc.name = 'Kijiji' AND il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN dc.name = 'Kijiji' AND il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS kijiji_total_listed_days,
    SUM(CASE
          WHEN dc.name = 'Reverb' AND il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN dc.name = 'Reverb' AND il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS reverb_total_listed_days,
    SUM(CASE
          WHEN il.status = 'ended'  THEN (il.ended_at - il.listed_at)
          WHEN il.status = 'active' THEN (CURRENT_DATE - il.listed_at)
        END)                                                                                                 AS total_listed_days,

    -- True earliest real listed_at across EVERY cycle on EVERY platform
    -- (not derived from the three MAX(...) columns above, which each
    -- collapse to that platform's LATEST cycle — LEAST() of three maxes
    -- is not the same as MIN() over the whole set once a platform can
    -- have more than one cycle). GREATEST() of the three per-platform
    -- MAX columns IS still a valid global latest (max-of-maxes == max of
    -- the union), so last_listed_at needs no equivalent fix.
    MIN(CASE WHEN il.status IN ('active', 'ended') THEN il.listed_at END)                                    AS earliest_listed_at

  FROM public.item_listings il
  JOIN public.deal_channels dc ON dc.id = il.deal_channel_id
  WHERE dc.is_listing_platform = true
  GROUP BY il.inventory_item_id
),

expenses AS (
  SELECT
    item_id,
    COUNT(*)::integer AS item_expense_count,
    SUM(amount)        AS item_expenses_total
  FROM public.inventory_expenses
  WHERE item_id IS NOT NULL
  GROUP BY item_id
),

tags AS (
  SELECT
    iit.item_id,
    ARRAY_AGG(t.id   ORDER BY t.name, t.id) AS tag_ids,
    ARRAY_AGG(t.name ORDER BY t.name, t.id) AS tag_names,
    COUNT(*)::integer                        AS tag_count
  FROM public.inventory_item_tags iit
  JOIN public.inventory_tags t ON t.id = iit.tag_id
  GROUP BY iit.item_id
),

base AS (
  SELECT
    i.id                                                     AS item_id,
    i.user_id,
    CONCAT_WS(' ', i.year::text, br.name, i.model)            AS item_display_name,
    i.model,
    i.year,
    i.color,
    i.brand_id,
    br.name                                                   AS brand_name,
    cat.id                                                     AS category_id,
    cat.name                                                   AS category_name,
    i.item_subtype_id                                          AS type_id,
    st.name                                                     AS type_name,
    i.condition                                                  AS condition_name,
    i.purpose_id,
    pu.name                                                       AS purpose_name,
    i.status                                                       AS current_status,
    i.estimated_sold_value,

    COALESCE(tg.tag_ids,   ARRAY[]::bigint[]) AS tag_ids,
    COALESCE(tg.tag_names, ARRAY[]::text[])   AS tag_names,
    COALESCE(tg.tag_count, 0)                  AS tag_count,

    acq.acquisition_deal_id,
    acq.acquisition_date,
    acq.acquisition_deal_type,
    acq.acquisition_channel_id,
    acq.acquisition_channel_name,
    acq.acquisition_method,
    acq.acquisition_value,
    COALESCE(acq.is_historical_import, false) AS is_historical_import,
    false                                       AS acquisition_date_is_placeholder,

    ex.exit_deal_id,
    ex.exit_date,
    ex.exit_type,
    ex.exit_channel_id,
    ex.exit_channel_name,
    ex.exit_value,
    COALESCE(ex.is_realized, false)             AS is_realized,

    lst.marketplace_listed_at,
    lst.kijiji_listed_at,
    lst.reverb_listed_at,

    lst.marketplace_active_listed_at,
    lst.kijiji_active_listed_at,
    lst.reverb_active_listed_at,
    lst.marketplace_listing_cycle_count,
    lst.kijiji_listing_cycle_count,
    lst.reverb_listing_cycle_count,
    lst.listing_cycle_count,
    lst.marketplace_total_listed_days,
    lst.kijiji_total_listed_days,
    lst.reverb_total_listed_days,
    lst.total_listed_days,
    lst.earliest_listed_at,

    COALESCE(exp.item_expense_count, 0)         AS item_expense_count,
    COALESCE(exp.item_expenses_total, 0)        AS item_expenses_total,

    -- Deal In Channel (added 20260731000000)
    acq.deal_in_channel_id,
    acq.deal_in_channel_name,
    acq.deal_in_channel_requires_listing,

    -- Deal Out Channel (added 20260802000000)
    ex.deal_out_channel_id,
    ex.deal_out_channel_name,
    ex.deal_out_channel_requires_listing
  FROM public.inventory_items i
  LEFT JOIN public.brands         br  ON br.id  = i.brand_id
  LEFT JOIN public.item_subtypes  st  ON st.id  = i.item_subtype_id
  LEFT JOIN public.item_categories cat ON cat.id = st.category_id
  LEFT JOIN public.item_purposes  pu  ON pu.id  = i.purpose_id
  LEFT JOIN acquisition acq ON acq.item_id = i.id
  LEFT JOIN exit_deal   ex  ON ex.item_id  = i.id
  LEFT JOIN listings    lst ON lst.item_id = i.id
  LEFT JOIN expenses    exp ON exp.item_id = i.id
  LEFT JOIN tags        tg  ON tg.item_id  = i.id
  -- An item that exists only because of an OPEN operation draft is not inventory yet (20261031000000).
  WHERE NOT (
    i.status = 'new'
    AND EXISTS (
      SELECT 1 FROM public.operation_draft_items odi
      JOIN public.operation_drafts od ON od.id = odi.draft_id
      WHERE odi.item_id = i.id AND odi.direction = 'in' AND od.status = 'OPEN'
    )
  )
),

lifecycle_dates AS (
  SELECT
    base.*,
    -- first_listed_at: true MIN(listed_at) across every cycle on every
    -- platform (earliest_listed_at, computed directly in the listings
    -- CTE) — NOT LEAST() of the three per-platform MAX columns, which
    -- would silently drop an earlier cycle on a platform that also has a
    -- later one.
    earliest_listed_at                                                  AS first_listed_at,
    -- last_listed_at: GREATEST() of the three per-platform MAX columns
    -- IS still a valid true global MAX (max-of-maxes == max of the
    -- union), so this needs no equivalent fix.
    GREATEST(marketplace_listed_at, kijiji_listed_at, reverb_listed_at) AS last_listed_at,
    ( (CASE WHEN marketplace_listed_at IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN kijiji_listed_at      IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN reverb_listed_at      IS NOT NULL THEN 1 ELSE 0 END) ) AS listing_platform_count,
    CASE WHEN is_realized THEN (exit_value - acquisition_value)                          END AS gross_profit,
    CASE WHEN is_realized THEN (exit_value - acquisition_value - item_expenses_total)    END AS net_profit
  FROM base
)

SELECT
  lifecycle_dates.item_id,
  lifecycle_dates.user_id,

  lifecycle_dates.item_display_name,
  lifecycle_dates.model,
  lifecycle_dates.year,
  lifecycle_dates.color,

  lifecycle_dates.brand_id,
  lifecycle_dates.brand_name,

  lifecycle_dates.category_id,
  lifecycle_dates.category_name,

  lifecycle_dates.type_id,
  lifecycle_dates.type_name,

  lifecycle_dates.condition_name,

  lifecycle_dates.purpose_id,
  lifecycle_dates.purpose_name,

  lifecycle_dates.current_status,
  lifecycle_dates.estimated_sold_value,

  lifecycle_dates.tag_ids,
  lifecycle_dates.tag_names,
  lifecycle_dates.tag_count,

  lifecycle_dates.acquisition_deal_id,
  lifecycle_dates.acquisition_date,
  lifecycle_dates.acquisition_deal_type,
  lifecycle_dates.acquisition_channel_id,
  lifecycle_dates.acquisition_channel_name,
  lifecycle_dates.acquisition_method,
  lifecycle_dates.acquisition_value,
  lifecycle_dates.is_historical_import,
  lifecycle_dates.acquisition_date_is_placeholder,

  lifecycle_dates.marketplace_listed_at,
  lifecycle_dates.kijiji_listed_at,
  lifecycle_dates.reverb_listed_at,

  lifecycle_dates.first_listed_at,
  lifecycle_dates.last_listed_at,
  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL THEN NULL
    WHEN ( (CASE WHEN lifecycle_dates.marketplace_listed_at = lifecycle_dates.first_listed_at THEN 1 ELSE 0 END)
         + (CASE WHEN lifecycle_dates.kijiji_listed_at      = lifecycle_dates.first_listed_at THEN 1 ELSE 0 END)
         + (CASE WHEN lifecycle_dates.reverb_listed_at      = lifecycle_dates.first_listed_at THEN 1 ELSE 0 END) ) > 1
      THEN 'Multiple'
    WHEN lifecycle_dates.marketplace_listed_at = lifecycle_dates.first_listed_at THEN 'Marketplace'
    WHEN lifecycle_dates.kijiji_listed_at      = lifecycle_dates.first_listed_at THEN 'Kijiji'
    WHEN lifecycle_dates.reverb_listed_at      = lifecycle_dates.first_listed_at THEN 'Reverb'
  END                                                                          AS first_listing_platform,

  lifecycle_dates.listing_platform_count,
  (lifecycle_dates.listing_platform_count > 1)                                AS is_cross_listed,

  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL OR lifecycle_dates.acquisition_date IS NULL THEN NULL
    ELSE (lifecycle_dates.first_listed_at - lifecycle_dates.acquisition_date)
  END                                                                          AS days_acquisition_to_first_listing,

  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL THEN NULL
    ELSE (lifecycle_dates.last_listed_at - lifecycle_dates.first_listed_at)
  END                                                                          AS days_first_to_last_listing,

  CASE
    WHEN lifecycle_dates.first_listed_at IS NULL THEN NULL
    WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.first_listed_at)
    ELSE (CURRENT_DATE - lifecycle_dates.first_listed_at)
  END                                                                          AS global_days_on_market,

  -- Marketplace
  CASE WHEN lifecycle_dates.marketplace_listed_at IS NULL THEN NULL
       ELSE (lifecycle_dates.marketplace_listed_at - lifecycle_dates.first_listed_at) END AS marketplace_listing_delay_days,
  CASE WHEN lifecycle_dates.marketplace_listed_at IS NULL THEN NULL
       WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.marketplace_listed_at)
       ELSE (CURRENT_DATE - lifecycle_dates.marketplace_listed_at) END                    AS marketplace_listing_age_days,
  CASE WHEN lifecycle_dates.marketplace_listed_at IS NULL OR lifecycle_dates.exit_date IS NULL THEN NULL
       ELSE (lifecycle_dates.exit_date - lifecycle_dates.marketplace_listed_at) END       AS marketplace_days_to_exit,

  -- Kijiji
  CASE WHEN lifecycle_dates.kijiji_listed_at IS NULL THEN NULL
       ELSE (lifecycle_dates.kijiji_listed_at - lifecycle_dates.first_listed_at) END      AS kijiji_listing_delay_days,
  CASE WHEN lifecycle_dates.kijiji_listed_at IS NULL THEN NULL
       WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.kijiji_listed_at)
       ELSE (CURRENT_DATE - lifecycle_dates.kijiji_listed_at) END                         AS kijiji_listing_age_days,
  CASE WHEN lifecycle_dates.kijiji_listed_at IS NULL OR lifecycle_dates.exit_date IS NULL THEN NULL
       ELSE (lifecycle_dates.exit_date - lifecycle_dates.kijiji_listed_at) END            AS kijiji_days_to_exit,

  -- Reverb
  CASE WHEN lifecycle_dates.reverb_listed_at IS NULL THEN NULL
       ELSE (lifecycle_dates.reverb_listed_at - lifecycle_dates.first_listed_at) END      AS reverb_listing_delay_days,
  CASE WHEN lifecycle_dates.reverb_listed_at IS NULL THEN NULL
       WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.reverb_listed_at)
       ELSE (CURRENT_DATE - lifecycle_dates.reverb_listed_at) END                         AS reverb_listing_age_days,
  CASE WHEN lifecycle_dates.reverb_listed_at IS NULL OR lifecycle_dates.exit_date IS NULL THEN NULL
       ELSE (lifecycle_dates.exit_date - lifecycle_dates.reverb_listed_at) END            AS reverb_days_to_exit,

  lifecycle_dates.exit_deal_id,
  lifecycle_dates.exit_date,
  lifecycle_dates.exit_type,
  lifecycle_dates.exit_channel_id,
  lifecycle_dates.exit_channel_name,
  lifecycle_dates.exit_value,
  lifecycle_dates.is_realized,

  lifecycle_dates.item_expense_count,
  lifecycle_dates.item_expenses_total,

  lifecycle_dates.gross_profit,
  lifecycle_dates.net_profit,
  CASE
    WHEN NOT lifecycle_dates.is_realized THEN NULL
    WHEN lifecycle_dates.acquisition_value IS NULL OR lifecycle_dates.acquisition_value <= 0 THEN NULL
    ELSE (lifecycle_dates.net_profit / lifecycle_dates.acquisition_value) * 100
  END                                                                          AS roi,

  CASE
    WHEN lifecycle_dates.acquisition_date IS NULL THEN NULL
    WHEN lifecycle_dates.exit_date IS NOT NULL THEN (lifecycle_dates.exit_date - lifecycle_dates.acquisition_date)
    ELSE (CURRENT_DATE - lifecycle_dates.acquisition_date)
  END                                                                          AS holding_days,

  COALESCE(
    lifecycle_dates.acquisition_date IS NOT NULL
    AND lifecycle_dates.first_listed_at IS NOT NULL
    AND lifecycle_dates.first_listed_at < lifecycle_dates.acquisition_date,
    false
  )                                                                            AS has_listing_before_acquisition,

  COALESCE(
    lifecycle_dates.exit_date IS NOT NULL
    AND lifecycle_dates.last_listed_at IS NOT NULL
    AND lifecycle_dates.last_listed_at > lifecycle_dates.exit_date,
    false
  )                                                                            AS has_listing_after_exit,

  ( COALESCE(
      lifecycle_dates.acquisition_date IS NOT NULL
      AND lifecycle_dates.first_listed_at IS NOT NULL
      AND lifecycle_dates.first_listed_at < lifecycle_dates.acquisition_date,
      false
    )
    OR
    COALESCE(
      lifecycle_dates.exit_date IS NOT NULL
      AND lifecycle_dates.last_listed_at IS NOT NULL
      AND lifecycle_dates.last_listed_at > lifecycle_dates.exit_date,
      false
    )
  )                                                                            AS has_lifecycle_date_issue,

  -- Deal In Channel (added 20260731000000)
  lifecycle_dates.deal_in_channel_id,
  lifecycle_dates.deal_in_channel_name,
  lifecycle_dates.deal_in_channel_requires_listing,

  -- Deal Out Channel (added 20260802000000)
  lifecycle_dates.deal_out_channel_id,
  lifecycle_dates.deal_out_channel_name,
  lifecycle_dates.deal_out_channel_requires_listing,

  -- ── Status-aware listing metrics (new, this migration) — appended at
  -- the very end so every prior column's position is preserved for
  -- CREATE OR REPLACE VIEW. ────────────────────────────────────────────
  lifecycle_dates.marketplace_active_listed_at,
  lifecycle_dates.kijiji_active_listed_at,
  lifecycle_dates.reverb_active_listed_at,

  CASE WHEN lifecycle_dates.marketplace_active_listed_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - lifecycle_dates.marketplace_active_listed_at) END AS marketplace_current_listing_age_days,
  CASE WHEN lifecycle_dates.kijiji_active_listed_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - lifecycle_dates.kijiji_active_listed_at) END      AS kijiji_current_listing_age_days,
  CASE WHEN lifecycle_dates.reverb_active_listed_at IS NULL THEN NULL
       ELSE (CURRENT_DATE - lifecycle_dates.reverb_active_listed_at) END      AS reverb_current_listing_age_days,

  lifecycle_dates.marketplace_listing_cycle_count,
  lifecycle_dates.kijiji_listing_cycle_count,
  lifecycle_dates.reverb_listing_cycle_count,
  lifecycle_dates.listing_cycle_count,

  lifecycle_dates.marketplace_total_listed_days,
  lifecycle_dates.kijiji_total_listed_days,
  lifecycle_dates.reverb_total_listed_days,
  lifecycle_dates.total_listed_days

FROM lifecycle_dates;
