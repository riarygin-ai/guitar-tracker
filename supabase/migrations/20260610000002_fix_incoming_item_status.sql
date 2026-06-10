-- Fix: incoming items added to a trade should have their status upgraded from
-- 'new' to 'owned'.  Previously, step 8 of both RPCs only inserted deal_items
-- rows and never touched inventory_items.status for incoming items.  Items that
-- were already 'owned' are unaffected (the WHERE clause guards on status = 'new').

-- ── edit_trade_operation ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION edit_trade_operation(
  p_deal_id             integer,
  p_deal_date           date,
  p_channel             text    DEFAULT NULL,
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
  v_deal              deals%ROWTYPE;
  v_cf                cash_flow%ROWTYPE;
  v_cf_id             integer;
  v_old_cf_date       date;
  v_effective_cf_date date;
  v_old_successor_id  integer;
  v_out_sum           numeric;
  v_in_sum            numeric;
  v_item              jsonb;
BEGIN
  -- 1. Load and validate deal
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deal % not found', p_deal_id;
  END IF;
  IF v_deal.deal_type <> 'trade' THEN
    RAISE EXCEPTION 'Deal % is not a trade (type: %)', p_deal_id, v_deal.deal_type;
  END IF;

  -- 2. Validate trade balance
  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_out_sum
  FROM jsonb_array_elements(p_outgoing_items) v;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_in_sum
  FROM jsonb_array_elements(p_incoming_items) v;

  IF ROUND(v_out_sum + p_cash_paid, 2) <> ROUND(v_in_sum + p_cash_received, 2) THEN
    RAISE EXCEPTION 'Trade does not balance: given=% received=%',
      v_out_sum + p_cash_paid, v_in_sum + p_cash_received;
  END IF;

  -- 3. Revert ALL current outgoing items to 'owned' (step 7 re-marks kept ones as 'traded').
  --    Must run BEFORE step 5 deletes deal_items so we can still query them.
  UPDATE inventory_items
  SET status = 'owned', sold_date = NULL
  WHERE id IN (
    SELECT item_id FROM deal_items
    WHERE deal_id = p_deal_id AND direction = 'out'
  );

  -- 4. Capture existing cash flow row (if any)
  SELECT * INTO v_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN
    v_cf_id       := v_cf.id;
    v_old_cf_date := v_cf.transaction_date;
  END IF;

  -- 5. Delete all deal_items for this deal
  DELETE FROM deal_items WHERE deal_id = p_deal_id;

  -- 6. Update the deal row
  UPDATE deals SET
    deal_date     = p_deal_date,
    channel       = p_channel,
    notes         = p_notes,
    cash_paid     = p_cash_paid,
    cash_received = p_cash_received
  WHERE id = p_deal_id;

  -- 7. Re-insert outgoing deal_items and mark inventory as traded
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_outgoing_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (
      p_deal_id,
      (v_item->>'item_id')::integer,
      'out',
      (v_item->>'total_value')::numeric
    );

    UPDATE inventory_items
    SET status = 'traded', sold_date = p_deal_date
    WHERE id = (v_item->>'item_id')::integer;
  END LOOP;

  -- 8. Re-insert incoming deal_items and promote 'new' items to 'owned'.
  --    Items already 'owned', 'listed', etc. are untouched.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_incoming_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (
      p_deal_id,
      (v_item->>'item_id')::integer,
      'in',
      (v_item->>'total_value')::numeric
    );

    UPDATE inventory_items
    SET status = 'owned'
    WHERE id = (v_item->>'item_id')::integer
      AND status = 'new';
  END LOOP;

  -- 9. Handle cash flow row
  v_effective_cf_date := COALESCE(p_cf_transaction_date, p_deal_date);

  IF v_cf_id IS NOT NULL THEN
    IF p_cash_paid = 0 AND p_cash_received = 0 THEN
      SELECT id INTO v_old_successor_id
      FROM cash_flow
      WHERE transaction_date > v_old_cf_date
        OR (transaction_date = v_old_cf_date AND id > v_cf_id)
      ORDER BY transaction_date, id
      LIMIT 1;

      DELETE FROM cash_flow WHERE id = v_cf_id;

      IF v_old_successor_id IS NOT NULL THEN
        PERFORM recalculate_cash_flow_balances_from(v_old_successor_id);
      END IF;
    ELSE
      IF v_effective_cf_date > v_old_cf_date THEN
        SELECT id INTO v_old_successor_id
        FROM cash_flow
        WHERE (transaction_date > v_old_cf_date
            OR (transaction_date = v_old_cf_date AND id > v_cf_id))
          AND id <> v_cf_id
        ORDER BY transaction_date, id
        LIMIT 1;
      END IF;

      UPDATE cash_flow SET
        transaction_date = v_effective_cf_date,
        cash_out         = p_cash_paid,
        cash_in          = p_cash_received,
        description      = p_cf_description
      WHERE id = v_cf_id;

      IF v_effective_cf_date > v_old_cf_date AND v_old_successor_id IS NOT NULL THEN
        PERFORM recalculate_cash_flow_balances_from(v_old_successor_id);
      ELSE
        PERFORM recalculate_cash_flow_balances_from(v_cf_id);
      END IF;
    END IF;
  ELSE
    IF p_cash_paid > 0 OR p_cash_received > 0 THEN
      INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
      VALUES (p_deal_id, v_effective_cf_date, 0, p_cash_received, p_cash_paid, 0, p_cf_description);
    END IF;
  END IF;

END;
$$;


-- ── create_trade_operation ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_trade_operation(
  p_deal_date           date,
  p_channel             text    DEFAULT NULL,
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
  v_deal_id           bigint;
  v_cf_id             bigint;
  v_effective_cf_date date;
  v_out_sum           numeric;
  v_in_sum            numeric;
  v_item              jsonb;
BEGIN
  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_out_sum
  FROM jsonb_array_elements(p_outgoing_items) v;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_in_sum
  FROM jsonb_array_elements(p_incoming_items) v;

  IF ROUND(v_out_sum + p_cash_paid, 2) <> ROUND(v_in_sum + p_cash_received, 2) THEN
    RAISE EXCEPTION 'Trade does not balance: given=% received=%',
      v_out_sum + p_cash_paid, v_in_sum + p_cash_received;
  END IF;

  INSERT INTO deals (deal_type, deal_date, channel, cash_paid, cash_received, fees, notes)
  VALUES ('trade', p_deal_date, p_channel, p_cash_paid, p_cash_received, 0, p_notes)
  RETURNING id INTO v_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_outgoing_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (
      v_deal_id,
      (v_item->>'item_id')::bigint,
      'out',
      (v_item->>'total_value')::numeric
    );

    UPDATE inventory_items
    SET status = 'traded', sold_date = p_deal_date
    WHERE id = (v_item->>'item_id')::bigint;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_incoming_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (
      v_deal_id,
      (v_item->>'item_id')::bigint,
      'in',
      (v_item->>'total_value')::numeric
    );

    UPDATE inventory_items
    SET status = 'owned'
    WHERE id = (v_item->>'item_id')::bigint
      AND status = 'new';
  END LOOP;

  v_effective_cf_date := COALESCE(p_cf_transaction_date, p_deal_date);

  IF p_cash_paid > 0 OR p_cash_received > 0 THEN
    INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
    VALUES (v_deal_id, v_effective_cf_date, 0, p_cash_received, p_cash_paid, 0, p_cf_description)
    RETURNING id INTO v_cf_id;

    PERFORM recalculate_cash_flow_balances_from(v_cf_id);
  END IF;

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;
