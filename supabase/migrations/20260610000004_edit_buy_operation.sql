-- edit_buy_operation: atomically replace all items in an existing purchase deal.
--
-- Reverts all current incoming items to 'new' (if still 'owned'), deletes all
-- deal_items, then re-inserts the new set and marks them 'owned'.  Cash flow is
-- updated/deleted/created to reflect the new total cost.

CREATE OR REPLACE FUNCTION edit_buy_operation(
  p_deal_id        integer,
  p_deal_date      date,
  p_channel        text    DEFAULT NULL,
  p_notes          text    DEFAULT NULL,
  p_incoming_items jsonb   DEFAULT '[]',
  p_cf_description text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal             deals%ROWTYPE;
  v_cf               cash_flow%ROWTYPE;
  v_cf_id            integer;
  v_old_cf_date      date;
  v_old_successor_id integer;
  v_total_value      numeric;
  v_item             jsonb;
BEGIN
  -- 1. Load and validate deal
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Deal % not found', p_deal_id;
  END IF;
  IF v_deal.deal_type <> 'purchase' THEN
    RAISE EXCEPTION 'Deal % is not a purchase (type: %)', p_deal_id, v_deal.deal_type;
  END IF;

  -- 2. Must have at least one item
  IF jsonb_array_length(p_incoming_items) = 0 THEN
    RAISE EXCEPTION 'Purchase must have at least one item';
  END IF;

  -- 3. Revert ALL current incoming items to 'new' (only if still 'owned').
  --    Runs BEFORE step 5 deletes deal_items so we can still query them.
  UPDATE inventory_items
  SET status = 'new'
  WHERE id IN (
    SELECT item_id FROM deal_items
    WHERE deal_id = p_deal_id AND direction = 'in'
  )
  AND status = 'owned';

  -- 4. Capture existing cash flow row (if any)
  SELECT * INTO v_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN
    v_cf_id       := v_cf.id;
    v_old_cf_date := v_cf.transaction_date;
  END IF;

  -- 5. Delete all deal_items for this deal
  DELETE FROM deal_items WHERE deal_id = p_deal_id;

  -- 6. Calculate new total cost
  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_total_value
  FROM jsonb_array_elements(p_incoming_items) v;

  -- 7. Update the deal row
  UPDATE deals SET
    deal_date = p_deal_date,
    channel   = p_channel,
    notes     = p_notes,
    cash_paid = v_total_value
  WHERE id = p_deal_id;

  -- 8. Re-insert incoming deal_items and promote 'new' items to 'owned'
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
    WHERE id = (v_item->>'item_id')::integer AND status = 'new';
  END LOOP;

  -- 9. Handle cash flow row
  IF v_cf_id IS NOT NULL THEN
    IF v_total_value = 0 THEN
      -- No cost — delete the cash flow entry and recalculate from its old successor
      SELECT id INTO v_old_successor_id
      FROM cash_flow
      WHERE (transaction_date > v_old_cf_date
          OR (transaction_date = v_old_cf_date AND id > v_cf_id))
        AND id <> v_cf_id
      ORDER BY transaction_date, id
      LIMIT 1;

      DELETE FROM cash_flow WHERE id = v_cf_id;

      IF v_old_successor_id IS NOT NULL THEN
        PERFORM recalculate_cash_flow_balances_from(v_old_successor_id);
      END IF;
    ELSE
      -- If date moves later, find the old successor before updating
      IF p_deal_date > v_old_cf_date THEN
        SELECT id INTO v_old_successor_id
        FROM cash_flow
        WHERE (transaction_date > v_old_cf_date
            OR (transaction_date = v_old_cf_date AND id > v_cf_id))
          AND id <> v_cf_id
        ORDER BY transaction_date, id
        LIMIT 1;
      END IF;

      UPDATE cash_flow SET
        transaction_date = p_deal_date,
        cash_out         = v_total_value,
        cash_in          = 0,
        description      = COALESCE(p_cf_description, description)
      WHERE id = v_cf_id;

      IF p_deal_date > v_old_cf_date AND v_old_successor_id IS NOT NULL THEN
        PERFORM recalculate_cash_flow_balances_from(v_old_successor_id);
      ELSE
        PERFORM recalculate_cash_flow_balances_from(v_cf_id);
      END IF;
    END IF;
  ELSE
    IF v_total_value > 0 THEN
      -- Create new cash flow row
      INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
      VALUES (p_deal_id, p_deal_date, 0, 0, v_total_value, 0, p_cf_description);
    END IF;
  END IF;

END;
$$;
