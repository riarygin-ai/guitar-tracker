-- Operation drafts: persist the FULL operation-form state (Save Draft).
--
-- The draft is now edited in the normal Buy / Sell / Trade form. Save Draft
-- stores everything that form holds before an operation exists: date,
-- channel, winning lead, the item set (items added / removed in the form)
-- and each item's planned value (Value Out / Value In / sale value / cost),
-- cash paid / received and notes. Still planning data only: nothing is
-- written to deals / deal_items / cash_flow / listings / leads — the values
-- reach the completed tables only through finalize_operation_draft, which is
-- unchanged.
--
-- 1. operation_draft_items.planned_value — the form's per-item value (NULL =
--    not set yet). Not a Value In: no analytics or operation logic reads it.
-- 2. save_operation_draft(p_draft_id, p_request) — replaces the OPEN draft's
--    form state in one transaction. Item rules = draft rules: the caller's
--    own items; outgoing owned / listed; incoming 'new'; no duplicates; Buy
--    has no outgoing, Sell no incoming; at least one item. An incoming item
--    the DRAFT created and the form removed is deleted only when untouched
--    (still 'new', no other operation / open draft / lead / listing /
--    expense / photo — the discard rules); otherwise it is kept as a plain
--    'new' item and reported.
-- 3. The guard trigger now also covers DELETE on operation_draft_items
--    (RPC-only; foreign-key cascades — an item or draft being deleted —
--    still pass).

ALTER TABLE public.operation_draft_items
  ADD COLUMN planned_value numeric(12,2) CHECK (planned_value IS NULL OR (planned_value >= 0 AND planned_value <= 10000000));

COMMENT ON COLUMN public.operation_draft_items.planned_value IS
  'Planned value from the draft operation form (Value Out / Value In / sale value / cost). Planning only — never read as an acquisition or exit value.';

GRANT UPDATE, DELETE ON public.operation_draft_items TO authenticated;

CREATE POLICY "operation_draft_items: update own" ON public.operation_draft_items FOR UPDATE TO authenticated
  USING (user_id = public.get_app_user_id()) WITH CHECK (user_id = public.get_app_user_id());
CREATE POLICY "operation_draft_items: delete own" ON public.operation_draft_items FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── Guard: + DELETE ──────────────────────────────────────────────────────
-- Verbatim from 20261031000000 except the DELETE branch.
CREATE OR REPLACE FUNCTION public.operation_drafts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Foreign-key cascades (an inventory item or the draft itself being deleted) run nested.
    IF pg_trigger_depth() > 1 OR COALESCE(current_setting('app.operation_draft_write', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'OPERATION_DRAFT_RPC_ONLY: operation drafts change only through their RPCs';
  END IF;
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

CREATE TRIGGER trg_operation_draft_items_guard_delete
  BEFORE DELETE ON public.operation_draft_items
  FOR EACH ROW EXECUTE FUNCTION public.operation_drafts_guard();

-- ─── Why a draft-created item must be kept (empty = safe to delete) ───────
-- The same rules discard_operation_draft applies.
CREATE OR REPLACE FUNCTION public._operation_draft_item_keep_reasons(p_uid int, p_item_id bigint, p_draft_id bigint)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY_REMOVE(ARRAY[
    (SELECT 'status ' || i.status FROM public.inventory_items i WHERE i.id = p_item_id AND i.user_id = p_uid AND i.status <> 'new'),
    CASE WHEN EXISTS (SELECT 1 FROM public.deal_items di WHERE di.item_id = p_item_id) THEN 'used in an operation' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.operation_draft_items o JOIN public.operation_drafts od ON od.id = o.draft_id
                      WHERE o.item_id = p_item_id AND o.draft_id <> p_draft_id AND od.status = 'OPEN') THEN 'in another open draft' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.item_leads il WHERE il.inventory_item_id = p_item_id) THEN 'has leads' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.item_listings l WHERE l.inventory_item_id = p_item_id) THEN 'has listings' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.inventory_expenses e WHERE e.item_id = p_item_id) THEN 'has expenses' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.inventory_item_photos p WHERE p.inventory_item_id = p_item_id) THEN 'has photos' END
  ], NULL);
$$;

-- ─── save_operation_draft ─────────────────────────────────────────────────
-- p_request: { proposed_date, deal_channel_id, lead_id, cash_paid,
--   cash_received, notes, items: [{ item_id, direction 'in'|'out',
--   planned_value }] } — a full replacement (retrying it is harmless).
-- contact_name (as captured from ChatGPT) is kept unchanged.

CREATE OR REPLACE FUNCTION public.save_operation_draft(p_draft_id bigint, p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      int := public.get_app_user_id();
  v_d        public.operation_drafts%ROWTYPE;
  v_items    jsonb := COALESCE(p_request->'items', '[]'::jsonb);
  v_paid     numeric := COALESCE((p_request->>'cash_paid')::numeric, 0);
  v_received numeric := COALESCE((p_request->>'cash_received')::numeric, 0);
  v_channel  bigint := (p_request->>'deal_channel_id')::bigint;
  v_lead_id  bigint := (p_request->>'lead_id')::bigint;
  v_it       jsonb;
  v_item_id  bigint;
  v_dir      text;
  v_value    numeric;
  v_status   text;
  v_out      bigint[] := '{}';
  v_all      bigint[] := '{}';
  v_pos      int := 0;
  v_row      record;
  v_reasons  text[];
  v_removed  bigint[] := '{}';
  v_kept     jsonb := '[]'::jsonb;
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
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: a draft needs at least one item — discard it instead';
  END IF;
  IF jsonb_array_length(v_items) > 40 THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: at most 40 items';
  END IF;

  -- Validate the new item set.
  FOR v_it IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_item_id := (v_it->>'item_id')::bigint;
    v_dir := v_it->>'direction';
    v_value := (v_it->>'planned_value')::numeric;
    IF v_item_id IS NULL OR v_dir NOT IN ('in', 'out') THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: every item needs item_id and direction in/out';
    END IF;
    IF v_item_id = ANY (v_all) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: item % appears twice', v_item_id;
    END IF;
    IF v_value IS NOT NULL AND (v_value < 0 OR v_value > 10000000) THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: item values must be 0 or more';
    END IF;
    IF (v_d.operation_type = 'BUY' AND v_dir = 'out') OR (v_d.operation_type = 'SELL' AND v_dir = 'in') THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: a % draft cannot have % items', lower(v_d.operation_type), CASE v_dir WHEN 'in' THEN 'incoming' ELSE 'outgoing' END;
    END IF;
    SELECT i.status INTO v_status FROM public.inventory_items i WHERE i.id = v_item_id AND i.user_id = v_uid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND: item %', v_item_id;
    END IF;
    IF v_dir = 'out' AND v_status NOT IN ('owned', 'listed') THEN
      RAISE EXCEPTION 'ITEM_NOT_AVAILABLE: item % is %, not owned or listed', v_item_id, v_status;
    END IF;
    IF v_dir = 'in' AND v_status <> 'new' THEN
      RAISE EXCEPTION 'ITEM_NOT_AVAILABLE: incoming item % is %, not new', v_item_id, v_status;
    END IF;
    v_all := v_all || v_item_id;
    IF v_dir = 'out' THEN v_out := v_out || v_item_id; END IF;
  END LOOP;

  IF v_lead_id IS NOT NULL THEN
    PERFORM public._operation_draft_check_lead(v_uid, v_lead_id, v_out);
  END IF;

  PERFORM set_config('app.operation_draft_write', 'on', true);

  -- Items removed in the form: drop the link; a draft-created incoming item
  -- is deleted only when untouched, otherwise kept as a plain 'new' item.
  FOR v_row IN
    SELECT odi.id, odi.item_id, odi.created_by_draft FROM public.operation_draft_items odi
    WHERE odi.draft_id = p_draft_id AND NOT (odi.item_id = ANY (v_all))
    ORDER BY odi.position
  LOOP
    DELETE FROM public.operation_draft_items WHERE id = v_row.id;
    IF v_row.created_by_draft THEN
      v_reasons := public._operation_draft_item_keep_reasons(v_uid, v_row.item_id, p_draft_id);
      IF cardinality(v_reasons) = 0 THEN
        DELETE FROM public.inventory_items i WHERE i.id = v_row.item_id AND i.user_id = v_uid;
        v_removed := v_removed || v_row.item_id;
      ELSE
        v_kept := v_kept || jsonb_build_object('item_id', v_row.item_id, 'reasons', to_jsonb(v_reasons));
      END IF;
    END IF;
  END LOOP;

  -- Upsert the current set in form order.
  FOR v_it IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_item_id := (v_it->>'item_id')::bigint;
    v_dir := v_it->>'direction';
    v_value := (v_it->>'planned_value')::numeric;
    UPDATE public.operation_draft_items SET planned_value = v_value, position = v_pos, direction = v_dir
    WHERE draft_id = p_draft_id AND item_id = v_item_id AND (created_by_draft = false OR v_dir = 'in');
    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM public.operation_draft_items WHERE draft_id = p_draft_id AND item_id = v_item_id) THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: item % was created by this draft as an incoming item', v_item_id;
      END IF;
      INSERT INTO public.operation_draft_items (draft_id, user_id, item_id, direction, created_by_draft, position, planned_value)
      VALUES (p_draft_id, v_uid, v_item_id, v_dir, false, v_pos, v_value);
    END IF;
    v_pos := v_pos + 1;
  END LOOP;

  UPDATE public.operation_drafts SET
    proposed_date   = (p_request->>'proposed_date')::date,
    deal_channel_id = v_channel,
    lead_id         = v_lead_id,
    cash_paid       = v_paid,
    cash_received   = v_received,
    notes           = NULLIF(btrim(p_request->>'notes'), '')
  WHERE id = p_draft_id;
  PERFORM set_config('app.operation_draft_write', '', true);

  RETURN jsonb_build_object('status', 'OK', 'draft_id', p_draft_id, 'removed_item_ids', to_jsonb(v_removed), 'kept_items', v_kept);
END;
$$;

REVOKE ALL ON FUNCTION public.save_operation_draft(bigint, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._operation_draft_item_keep_reasons(int, bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_operation_draft(bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public._operation_draft_item_keep_reasons(int, bigint, bigint) TO authenticated;
