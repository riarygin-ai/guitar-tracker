-- Multi-item Sale operations.
--
-- Purchase (create_buy_operation/edit_buy_operation, 20260713000000) and
-- Trade (create_trade_operation/edit_trade_operation) already accept an
-- array of items per deal. Sale was the odd one out: create_sell_operation
-- took a scalar p_item_id/p_cash_received, and edit_sell_operation
-- (20260902000000) inherited that same one-item shape. This migration
-- brings Sale to the same array-of-items pattern, so e.g. a guitar sold
-- together with its case can be recorded as two inventory items under one
-- deal_id, each with its own sale value and its own realized profit/ROI.
--
-- Both functions here are a different parameter list from what they used
-- to be (jsonb array instead of scalar item_id/cash_received), so an
-- explicit DROP of the old signatures is required first — CREATE OR REPLACE
-- with a different argument list creates a SECOND overload rather than
-- replacing the old one, which is exactly the "function ... is not unique"
-- ambiguity bug already fixed once this session
-- (20260831000001_fix_recalculate_cash_flow_overload_ambiguity.sql). Only
-- ever one signature of each of these functions should exist.

DROP FUNCTION IF EXISTS create_sell_operation(date, numeric, bigint, bigint, text, text);
DROP FUNCTION IF EXISTS edit_sell_operation(integer, date, bigint, text, numeric, text);

-- ── create_sell_operation ────────────────────────────────────────────────
-- p_items: jsonb array of {item_id, total_value}. Per-item validation and
-- per-item side effects (deal_items row, inventory_items.status, listing
-- closure) are identical to the previous single-item body, just looped —
-- mirrors create_trade_operation's item loop. Item selling remains
-- unconditionally required to be > 0 per item (Sale has always hard-required
-- cash_received > 0 — unlike Purchase, there is no existing $0-item pattern
-- to preserve here).

CREATE OR REPLACE FUNCTION create_sell_operation(
  p_deal_date      date,
  p_channel_id     bigint,
  p_items          jsonb,
  p_notes          text    DEFAULT NULL,
  p_cf_description text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id bigint;
  v_cf_id   bigint;
  v_total   numeric;
  v_item    jsonb;
  v_item_id bigint;
  v_status  text;
BEGIN
  IF p_channel_id IS NULL THEN
    RAISE EXCEPTION 'Channel is required';
  END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sale must have at least one item';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(p_items) v) <>
     (SELECT count(DISTINCT (v->>'item_id')::bigint) FROM jsonb_array_elements(p_items) v) THEN
    RAISE EXCEPTION 'Cannot sell the same item twice in one sale';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'total_value')::numeric <= 0 THEN
      RAISE EXCEPTION 'Sale value must be greater than 0 for item %', (v_item->>'item_id');
    END IF;
  END LOOP;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0)
  INTO v_total
  FROM jsonb_array_elements(p_items) v;

  INSERT INTO deals (deal_type, deal_date, deal_channel_id, cash_paid, cash_received, fees, notes)
  VALUES ('sale', p_deal_date, p_channel_id, 0, v_total, 0, p_notes)
  RETURNING id INTO v_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_item_id := (v_item->>'item_id')::bigint;

    SELECT status INTO v_status FROM inventory_items WHERE id = v_item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Item % not found', v_item_id; END IF;
    IF v_status NOT IN ('owned', 'listed') THEN
      RAISE EXCEPTION 'Item must be owned or listed to sell (current: %)', v_status;
    END IF;

    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (v_deal_id, v_item_id, 'out', (v_item->>'total_value')::numeric);

    UPDATE inventory_items SET status = 'sold', sold_date = p_deal_date WHERE id = v_item_id;

    UPDATE item_listings
    SET    status = 'ended', ended_at = p_deal_date
    WHERE  inventory_item_id = v_item_id
      AND  status = 'active'
      AND  listed_at <= p_deal_date;

    UPDATE item_listings
    SET    status = 'cancelled', cancelled_at = p_deal_date::timestamptz
    WHERE  inventory_item_id = v_item_id
      AND  status = 'draft';
  END LOOP;

  INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
  VALUES (v_deal_id, p_deal_date, 0, v_total, 0, 0, p_cf_description)
  RETURNING id INTO v_cf_id;

  PERFORM recalculate_cash_flow_balances_from(v_cf_id);

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;

GRANT EXECUTE ON FUNCTION create_sell_operation(date, bigint, jsonb, text, text) TO authenticated, service_role;

-- ── edit_sell_operation ──────────────────────────────────────────────────
-- p_items: jsonb array of {item_id, total_value} for the sale's EXISTING
-- outgoing items only — the item set itself is immutable on edit (add/
-- remove is rejected). Reopening a sold item's status/listing/deal chain to
-- support swapping which items were sold is genuinely complex (and for a
-- single item was already judged too risky to automate in
-- 20260902000000) — that risk doesn't shrink just because there are now N
-- items instead of 1, so it stays out of scope here too. This is enforced
-- server-side (not just by the UI never sending a different set) by
-- comparing the passed item_id set against deal_items exactly.

CREATE OR REPLACE FUNCTION edit_sell_operation(
  p_deal_id        integer,
  p_deal_date      date,
  p_channel_id     bigint  DEFAULT NULL,
  p_notes          text    DEFAULT NULL,
  p_items          jsonb   DEFAULT NULL,
  p_cf_description text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal         deals%ROWTYPE;
  v_old_cf       cash_flow%ROWTYPE;
  v_cf_id        bigint;
  v_succ_id      bigint;
  v_total        numeric;
  v_item         jsonb;
  v_existing_ids bigint[];
  v_new_ids      bigint[];
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deal % not found', p_deal_id; END IF;
  IF v_deal.deal_type <> 'sale' THEN RAISE EXCEPTION 'Deal % is not a sale', p_deal_id; END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sale must have at least one item';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(p_items) v) <>
     (SELECT count(DISTINCT (v->>'item_id')::bigint) FROM jsonb_array_elements(p_items) v) THEN
    RAISE EXCEPTION 'Cannot sell the same item twice in one sale';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'total_value')::numeric <= 0 THEN
      RAISE EXCEPTION 'Sale value must be greater than 0 for item %', (v_item->>'item_id');
    END IF;
  END LOOP;

  SELECT array_agg(item_id ORDER BY item_id) INTO v_existing_ids
  FROM deal_items WHERE deal_id = p_deal_id AND direction = 'out';

  SELECT array_agg((v->>'item_id')::bigint ORDER BY (v->>'item_id')::bigint) INTO v_new_ids
  FROM jsonb_array_elements(p_items) v;

  IF v_existing_ids IS DISTINCT FROM v_new_ids THEN
    RAISE EXCEPTION 'Cannot change which items are part of an existing sale — edit sale values only, or create a new sale';
  END IF;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_total
  FROM jsonb_array_elements(p_items) v;

  UPDATE deals SET
    deal_date       = p_deal_date,
    deal_channel_id = p_channel_id,
    notes           = p_notes,
    cash_received   = v_total
  WHERE id = p_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE deal_items
    SET total_value = (v_item->>'total_value')::numeric
    WHERE deal_id = p_deal_id AND direction = 'out' AND item_id = (v_item->>'item_id')::bigint;
  END LOOP;

  SELECT * INTO v_old_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN v_cf_id := v_old_cf.id; END IF;

  IF v_cf_id IS NOT NULL THEN
    SELECT id INTO v_succ_id FROM cash_flow
    WHERE (transaction_date > v_old_cf.transaction_date
        OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
      AND id <> v_cf_id
    ORDER BY transaction_date, id LIMIT 1;

    UPDATE cash_flow SET
      transaction_date = p_deal_date,
      cash_in          = v_total,
      cash_out         = 0,
      description      = COALESCE(p_cf_description, description)
    WHERE id = v_cf_id;

    IF p_deal_date > v_old_cf.transaction_date AND v_succ_id IS NOT NULL THEN
      PERFORM recalculate_cash_flow_balances_from(v_succ_id);
    ELSE
      PERFORM recalculate_cash_flow_balances_from(v_cf_id);
    END IF;
  ELSE
    -- No cash_flow row existed (shouldn't normally happen for a sale) — create one
    INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
    VALUES (p_deal_id, p_deal_date, 0, v_total, 0, 0, p_cf_description)
    RETURNING id INTO v_cf_id;
    PERFORM recalculate_cash_flow_balances_from(v_cf_id);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION edit_sell_operation(integer, date, bigint, text, jsonb, text) TO authenticated, service_role;
