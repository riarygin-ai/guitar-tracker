-- Atomic operation RPCs: create_expense_operation, create_buy_operation,
-- create_sell_operation, create_trade_operation
--
-- Prerequisites:
--   recalculate_cash_flow_balances_from() must already exist in the database.
--   cash_flow_before_insert trigger must already exist on cash_flow.
--
-- Each function inserts all related records in one transaction.
-- Cash flow rows are inserted with opening_balance=0; recalculate_cash_flow_balances_from
-- corrects all balances from the inserted row forward (handles backdated operations).
--
-- All four functions return jsonb: { "deal_id": n, "cf_id": n }
-- cf_id is null for pure item-swap trades with no cash.


-- ---------------------------------------------------------------------------
-- create_expense_operation
-- ---------------------------------------------------------------------------
-- Tables touched: deals, inventory_expenses, cash_flow
-- p_item_id is optional (expense may not be linked to a specific item)

CREATE OR REPLACE FUNCTION create_expense_operation(
  p_expense_date   date,
  p_amount         numeric,
  p_notes          text,
  p_item_id        bigint DEFAULT NULL,
  p_cf_description text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id bigint;
  v_cf_id   bigint;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than 0';
  END IF;
  IF trim(p_notes) = '' OR p_notes IS NULL THEN
    RAISE EXCEPTION 'Notes are required';
  END IF;

  INSERT INTO deals (deal_type, deal_date, channel, cash_paid, cash_received, fees, notes)
  VALUES ('expense', p_expense_date, NULL, p_amount, 0, 0, p_notes)
  RETURNING id INTO v_deal_id;

  INSERT INTO inventory_expenses (deal_id, item_id, expense_date, amount, notes)
  VALUES (v_deal_id, p_item_id, p_expense_date, p_amount, p_notes);

  INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
  VALUES (v_deal_id, p_expense_date, 0, 0, p_amount, 0, COALESCE(p_cf_description, 'Expense: ' || p_notes))
  RETURNING id INTO v_cf_id;

  PERFORM recalculate_cash_flow_balances_from(v_cf_id);

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;


-- ---------------------------------------------------------------------------
-- create_buy_operation
-- ---------------------------------------------------------------------------
-- Tables touched: deals, deal_items (direction='in'), cash_flow

CREATE OR REPLACE FUNCTION create_buy_operation(
  p_deal_date      date,
  p_cash_paid      numeric,
  p_channel        text,
  p_item_id        bigint,
  p_notes          text   DEFAULT NULL,
  p_cf_description text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id bigint;
  v_cf_id   bigint;
BEGIN
  IF p_cash_paid <= 0 THEN
    RAISE EXCEPTION 'Cash paid must be greater than 0';
  END IF;
  IF trim(p_channel) = '' OR p_channel IS NULL THEN
    RAISE EXCEPTION 'Channel is required';
  END IF;

  INSERT INTO deals (deal_type, deal_date, channel, cash_paid, cash_received, fees, notes)
  VALUES ('purchase', p_deal_date, p_channel, p_cash_paid, 0, 0, p_notes)
  RETURNING id INTO v_deal_id;

  INSERT INTO deal_items (deal_id, item_id, direction, total_value)
  VALUES (v_deal_id, p_item_id, 'in', p_cash_paid);

  INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
  VALUES (v_deal_id, p_deal_date, 0, 0, p_cash_paid, 0, p_cf_description)
  RETURNING id INTO v_cf_id;

  PERFORM recalculate_cash_flow_balances_from(v_cf_id);

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;


-- ---------------------------------------------------------------------------
-- create_sell_operation
-- ---------------------------------------------------------------------------
-- Tables touched: deals, deal_items (direction='out'),
--                 inventory_items (status='sold', sold_date), cash_flow

CREATE OR REPLACE FUNCTION create_sell_operation(
  p_deal_date      date,
  p_cash_received  numeric,
  p_channel        text,
  p_item_id        bigint,
  p_notes          text   DEFAULT NULL,
  p_cf_description text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id bigint;
  v_cf_id   bigint;
BEGIN
  IF p_cash_received <= 0 THEN
    RAISE EXCEPTION 'Cash received must be greater than 0';
  END IF;
  IF trim(p_channel) = '' OR p_channel IS NULL THEN
    RAISE EXCEPTION 'Channel is required';
  END IF;

  INSERT INTO deals (deal_type, deal_date, channel, cash_paid, cash_received, fees, notes)
  VALUES ('sale', p_deal_date, p_channel, 0, p_cash_received, 0, p_notes)
  RETURNING id INTO v_deal_id;

  INSERT INTO deal_items (deal_id, item_id, direction, total_value)
  VALUES (v_deal_id, p_item_id, 'out', p_cash_received);

  UPDATE inventory_items
  SET status = 'sold', sold_date = p_deal_date
  WHERE id = p_item_id;

  INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
  VALUES (v_deal_id, p_deal_date, 0, p_cash_received, 0, 0, p_cf_description)
  RETURNING id INTO v_cf_id;

  PERFORM recalculate_cash_flow_balances_from(v_cf_id);

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;


-- ---------------------------------------------------------------------------
-- create_trade_operation
-- ---------------------------------------------------------------------------
-- Tables touched: deals, deal_items (outgoing direction='out', incoming direction='in'),
--                 inventory_items (outgoing: status='traded', incoming: status='owned'),
--                 cash_flow (only when p_cash_paid > 0 OR p_cash_received > 0)
--
-- Balance invariant enforced before any inserts:
--   SUM(outgoing total_value) + p_cash_paid = SUM(incoming total_value) + p_cash_received

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
