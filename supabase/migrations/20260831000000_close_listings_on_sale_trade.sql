-- Close open item_listings when an item leaves inventory via sale or trade.
-- Forward-only, does not modify any prior migration.
--
-- BUG: create_sell_operation / create_trade_operation / edit_trade_operation
-- (current definitions in 20260713000000_deal_channels.sql) flip
-- inventory_items.status to 'sold'/'traded' but never touch item_listings.
-- A listing that was 'active' (or 'draft') when the item sold/traded stayed
-- 'active'/'draft' forever — the item_listings_sync_inventory_status
-- trigger's own guard already refuses to move a 'sold'/'traded' item back to
-- 'listed'/'owned' (see 20260828000000_item_listings_lifecycle.sql), so this
-- was never visible as a status regression, only as a permanently-stuck
-- listing row.
--
-- FIX: each function below now closes open listings for every item it just
-- marked sold/traded, in the same transaction as that status change:
--   - 'active'  -> 'ended',     ended_at     = the sale/trade deal date
--   - 'draft'   -> 'cancelled', cancelled_at = the sale/trade deal date
--   - 'ended'/'cancelled' rows are already terminal and are never touched
--     (the WHERE clauses below only ever match 'active'/'draft').
-- Only items transitioning OUT (sold, or the outgoing side of a trade) are
-- touched — incoming/received trade items are never included in these
-- UPDATEs.
--
-- SAFETY: item_listings_ended_at_after_listed_at_check requires
-- ended_at >= listed_at. A deal_date earlier than an active listing's
-- listed_at (bad historical data) would violate that constraint and abort
-- the entire sale/trade if not guarded — so the 'active' -> 'ended' UPDATE
-- only matches rows where listed_at <= p_deal_date. Any row that fails that
-- guard is left 'active' on a now-sold/traded item; use
-- scripts/fix-stale-open-listings.ts (report mode) to find and manually
-- review it. Draft rows have no listed_at to violate, so no such guard is
-- needed there.
--
-- item_listings.updated_at is maintained by the existing
-- item_listings_set_updated_at BEFORE UPDATE trigger — not set explicitly
-- here.

-- ── create_sell_operation ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_sell_operation(
  p_deal_date      date,
  p_cash_received  numeric,
  p_channel_id     bigint,
  p_item_id        bigint,
  p_notes          text    DEFAULT NULL,
  p_cf_description text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id bigint;
  v_cf_id   bigint;
  v_status  text;
BEGIN
  IF p_cash_received <= 0 THEN
    RAISE EXCEPTION 'Cash received must be greater than 0';
  END IF;
  IF p_channel_id IS NULL THEN
    RAISE EXCEPTION 'Channel is required';
  END IF;

  SELECT status INTO v_status FROM inventory_items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item % not found', p_item_id; END IF;
  IF v_status NOT IN ('owned', 'listed') THEN
    RAISE EXCEPTION 'Item must be owned or listed to sell (current: %)', v_status;
  END IF;

  INSERT INTO deals (deal_type, deal_date, deal_channel_id, cash_paid, cash_received, fees, notes)
  VALUES ('sale', p_deal_date, p_channel_id, 0, p_cash_received, 0, p_notes)
  RETURNING id INTO v_deal_id;

  INSERT INTO deal_items (deal_id, item_id, direction, total_value)
  VALUES (v_deal_id, p_item_id, 'out', p_cash_received);

  UPDATE inventory_items SET status = 'sold', sold_date = p_deal_date WHERE id = p_item_id;

  UPDATE item_listings
  SET    status = 'ended', ended_at = p_deal_date
  WHERE  inventory_item_id = p_item_id
    AND  status = 'active'
    AND  listed_at <= p_deal_date;

  UPDATE item_listings
  SET    status = 'cancelled', cancelled_at = p_deal_date::timestamptz
  WHERE  inventory_item_id = p_item_id
    AND  status = 'draft';

  INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
  VALUES (v_deal_id, p_deal_date, 0, p_cash_received, 0, 0, p_cf_description)
  RETURNING id INTO v_cf_id;

  PERFORM recalculate_cash_flow_balances_from(v_cf_id);

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;

-- ── create_trade_operation ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_trade_operation(
  p_deal_date           date,
  p_channel_id          bigint  DEFAULT NULL,
  p_notes               text    DEFAULT NULL,
  p_cash_paid           numeric DEFAULT 0,
  p_cash_received       numeric DEFAULT 0,
  p_outgoing_items      jsonb   DEFAULT '[]',
  p_incoming_items      jsonb   DEFAULT '[]',
  p_cf_transaction_date date    DEFAULT NULL,
  p_cf_description      text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id      bigint;
  v_cf_id        bigint;
  v_cf_date      date;
  v_out_sum      numeric;
  v_in_sum       numeric;
  v_item         jsonb;
  v_item_id      bigint;
BEGIN
  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_out_sum FROM jsonb_array_elements(p_outgoing_items) v;
  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_in_sum  FROM jsonb_array_elements(p_incoming_items)  v;

  IF ROUND(v_out_sum + p_cash_paid, 2) <> ROUND(v_in_sum + p_cash_received, 2) THEN
    RAISE EXCEPTION 'Trade does not balance: given=% received=%', v_out_sum + p_cash_paid, v_in_sum + p_cash_received;
  END IF;

  INSERT INTO deals (deal_type, deal_date, deal_channel_id, cash_paid, cash_received, fees, notes)
  VALUES ('trade', p_deal_date, p_channel_id, p_cash_paid, p_cash_received, 0, p_notes)
  RETURNING id INTO v_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_outgoing_items) LOOP
    v_item_id := (v_item->>'item_id')::bigint;

    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (v_deal_id, v_item_id, 'out', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'traded', sold_date = p_deal_date WHERE id = v_item_id;

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

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_incoming_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (v_deal_id, (v_item->>'item_id')::bigint, 'in', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'owned' WHERE id = (v_item->>'item_id')::bigint AND status = 'new';
  END LOOP;

  v_cf_date := COALESCE(p_cf_transaction_date, p_deal_date);

  IF p_cash_paid > 0 OR p_cash_received > 0 THEN
    INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
    VALUES (v_deal_id, v_cf_date, 0, p_cash_received, p_cash_paid, 0, p_cf_description)
    RETURNING id INTO v_cf_id;
    PERFORM recalculate_cash_flow_balances_from(v_cf_id);
  END IF;

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;

-- ── edit_trade_operation ─────────────────────────────────────────────────
-- Same closing logic applied to the NEW outgoing set only. The existing
-- "revert outgoing items to owned" step at the top (for items dropped from
-- the trade on edit) is unchanged — it does not resurrect any listing that
-- a prior save already ended; that stays a manual Start Listing action, not
-- an automatic side effect of editing an unrelated deal.

CREATE OR REPLACE FUNCTION edit_trade_operation(
  p_deal_id             integer,
  p_deal_date           date,
  p_channel_id          bigint  DEFAULT NULL,
  p_notes               text    DEFAULT NULL,
  p_cash_paid           numeric DEFAULT 0,
  p_cash_received       numeric DEFAULT 0,
  p_outgoing_items      jsonb   DEFAULT '[]',
  p_incoming_items      jsonb   DEFAULT '[]',
  p_cf_transaction_date date    DEFAULT NULL,
  p_cf_description      text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal        deals%ROWTYPE;
  v_old_cf      cash_flow%ROWTYPE;
  v_cf_id       bigint;
  v_cf_date     date;
  v_out_sum     numeric;
  v_in_sum      numeric;
  v_item        jsonb;
  v_item_id     integer;
  v_succ_id     bigint;
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deal % not found', p_deal_id; END IF;
  IF v_deal.deal_type <> 'trade' THEN RAISE EXCEPTION 'Deal % is not a trade', p_deal_id; END IF;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_out_sum FROM jsonb_array_elements(p_outgoing_items) v;
  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_in_sum  FROM jsonb_array_elements(p_incoming_items)  v;

  IF ROUND(v_out_sum + p_cash_paid, 2) <> ROUND(v_in_sum + p_cash_received, 2) THEN
    RAISE EXCEPTION 'Trade does not balance: given=% received=%', v_out_sum + p_cash_paid, v_in_sum + p_cash_received;
  END IF;

  -- Revert outgoing items
  UPDATE inventory_items SET status = 'owned', sold_date = NULL
  WHERE id IN (SELECT item_id FROM deal_items WHERE deal_id = p_deal_id AND direction = 'out');

  -- Capture existing CF
  SELECT * INTO v_old_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN v_cf_id := v_old_cf.id; END IF;

  DELETE FROM deal_items WHERE deal_id = p_deal_id;

  UPDATE deals SET
    deal_date       = p_deal_date,
    deal_channel_id = p_channel_id,
    notes           = p_notes,
    cash_paid       = p_cash_paid,
    cash_received   = p_cash_received
  WHERE id = p_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_outgoing_items) LOOP
    v_item_id := (v_item->>'item_id')::integer;

    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (p_deal_id, v_item_id, 'out', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'traded', sold_date = p_deal_date WHERE id = v_item_id;

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

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_incoming_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (p_deal_id, (v_item->>'item_id')::integer, 'in', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'owned' WHERE id = (v_item->>'item_id')::integer AND status = 'new';
  END LOOP;

  v_cf_date := COALESCE(p_cf_transaction_date, p_deal_date);

  IF v_cf_id IS NOT NULL THEN
    IF p_cash_paid = 0 AND p_cash_received = 0 THEN
      SELECT id INTO v_succ_id FROM cash_flow
      WHERE (transaction_date > v_old_cf.transaction_date
          OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
        AND id <> v_cf_id
      ORDER BY transaction_date, id LIMIT 1;

      DELETE FROM cash_flow WHERE id = v_cf_id;
      IF v_succ_id IS NOT NULL THEN PERFORM recalculate_cash_flow_balances_from(v_succ_id); END IF;
    ELSE
      -- Find old position's successor before updating
      SELECT id INTO v_succ_id FROM cash_flow
      WHERE (transaction_date > v_old_cf.transaction_date
          OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
        AND id <> v_cf_id
      ORDER BY transaction_date, id LIMIT 1;

      UPDATE cash_flow SET
        transaction_date = v_cf_date,
        cash_out         = p_cash_paid,
        cash_in          = p_cash_received,
        description      = p_cf_description
      WHERE id = v_cf_id;

      IF v_cf_date > v_old_cf.transaction_date AND v_succ_id IS NOT NULL THEN
        PERFORM recalculate_cash_flow_balances_from(v_succ_id);
      ELSE
        PERFORM recalculate_cash_flow_balances_from(v_cf_id);
      END IF;
    END IF;
  ELSE
    IF p_cash_paid > 0 OR p_cash_received > 0 THEN
      INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
      VALUES (p_deal_id, v_cf_date, 0, p_cash_received, p_cash_paid, 0, p_cf_description)
      RETURNING id INTO v_cf_id;
      PERFORM recalculate_cash_flow_balances_from(v_cf_id);
    END IF;
  END IF;
END;
$$;
