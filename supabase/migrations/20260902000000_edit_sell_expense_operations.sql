-- edit_sell_operation / edit_expense_operation
--
-- Sale and Expense operations had no edit RPC at all — only edit_buy_operation
-- and edit_trade_operation existed (see 20260713000000_deal_channels.sql).
-- The operation detail page's inline edit UI only ever patched deals/cash_flow/
-- inventory_expenses directly for Sale/Expense, and never touched amount:
-- updateInventoryExpense() (src/lib/supabase.ts) has no cash_flow awareness, so
-- an expense amount edit would desync inventory_expenses.amount from
-- cash_flow.cash_out even if the UI had exposed the field. This is the fix.
--
-- Both functions follow the exact successor-vs-self recalculation pattern
-- already used by edit_buy_operation / edit_trade_operation: capture the old
-- cash_flow row, and after moving it, recalc from the OLD SUCCESSOR (the row
-- that used to come right after it) if the date moved later — because the
-- edited row may now sort past that successor — otherwise recalc from the
-- row itself (walking forward from an earlier point already covers
-- everything from there on).
--
-- edit_sell_operation intentionally never touches inventory_items.status or
-- item_listings — the sold item and its listing-closure are immutable on
-- edit (see plan doc: reopening a sold item's status/listing/deal chain is
-- genuinely complex, and item_listings has no deal_id back-link to safely
-- identify which listing this sale closed).

CREATE OR REPLACE FUNCTION edit_sell_operation(
  p_deal_id        integer,
  p_deal_date      date,
  p_channel_id     bigint  DEFAULT NULL,
  p_notes          text    DEFAULT NULL,
  p_cash_received  numeric DEFAULT NULL,
  p_cf_description text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal    deals%ROWTYPE;
  v_old_cf  cash_flow%ROWTYPE;
  v_cf_id   bigint;
  v_succ_id bigint;
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deal % not found', p_deal_id; END IF;
  IF v_deal.deal_type <> 'sale' THEN RAISE EXCEPTION 'Deal % is not a sale', p_deal_id; END IF;

  IF p_cash_received IS NULL OR p_cash_received <= 0 THEN
    RAISE EXCEPTION 'Cash received must be greater than 0';
  END IF;

  UPDATE deals SET
    deal_date       = p_deal_date,
    deal_channel_id = p_channel_id,
    notes           = p_notes,
    cash_received   = p_cash_received
  WHERE id = p_deal_id;

  UPDATE deal_items SET
    total_value = p_cash_received
  WHERE deal_id = p_deal_id AND direction = 'out';

  SELECT * INTO v_old_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN v_cf_id := v_old_cf.id; END IF;

  IF v_cf_id IS NOT NULL THEN
    -- Find old position's successor before updating date
    SELECT id INTO v_succ_id FROM cash_flow
    WHERE (transaction_date > v_old_cf.transaction_date
        OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
      AND id <> v_cf_id
    ORDER BY transaction_date, id LIMIT 1;

    UPDATE cash_flow SET
      transaction_date = p_deal_date,
      cash_in          = p_cash_received,
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
    VALUES (p_deal_id, p_deal_date, 0, p_cash_received, 0, 0, p_cf_description)
    RETURNING id INTO v_cf_id;
    PERFORM recalculate_cash_flow_balances_from(v_cf_id);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION edit_sell_operation(integer, date, bigint, text, numeric, text) TO authenticated, service_role;

-- edit_expense_operation: amount, date, notes, and the linked inventory item
-- are all editable. Unlike Sale/Trade, create_expense_operation never
-- touches inventory_items.status, so there is no chain to reverse when the
-- linked item changes — it's a plain FK swap.

CREATE OR REPLACE FUNCTION edit_expense_operation(
  p_deal_id        integer,
  p_expense_date   date,
  p_amount         numeric,
  p_notes          text,
  p_item_id        bigint DEFAULT NULL,
  p_cf_description text   DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal    deals%ROWTYPE;
  v_old_cf  cash_flow%ROWTYPE;
  v_cf_id   bigint;
  v_succ_id bigint;
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deal % not found', p_deal_id; END IF;
  IF v_deal.deal_type <> 'expense' THEN RAISE EXCEPTION 'Deal % is not an expense', p_deal_id; END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than 0';
  END IF;
  IF trim(p_notes) = '' OR p_notes IS NULL THEN
    RAISE EXCEPTION 'Notes are required';
  END IF;

  UPDATE deals SET
    deal_date = p_expense_date,
    notes     = p_notes,
    cash_paid = p_amount
  WHERE id = p_deal_id;

  UPDATE inventory_expenses SET
    expense_date = p_expense_date,
    amount       = p_amount,
    notes        = p_notes,
    item_id      = p_item_id
  WHERE deal_id = p_deal_id;

  SELECT * INTO v_old_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN v_cf_id := v_old_cf.id; END IF;

  IF v_cf_id IS NOT NULL THEN
    SELECT id INTO v_succ_id FROM cash_flow
    WHERE (transaction_date > v_old_cf.transaction_date
        OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
      AND id <> v_cf_id
    ORDER BY transaction_date, id LIMIT 1;

    UPDATE cash_flow SET
      transaction_date = p_expense_date,
      cash_out         = p_amount,
      cash_in          = 0,
      description      = COALESCE(p_cf_description, description)
    WHERE id = v_cf_id;

    IF p_expense_date > v_old_cf.transaction_date AND v_succ_id IS NOT NULL THEN
      PERFORM recalculate_cash_flow_balances_from(v_succ_id);
    ELSE
      PERFORM recalculate_cash_flow_balances_from(v_cf_id);
    END IF;
  ELSE
    INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
    VALUES (p_deal_id, p_expense_date, 0, 0, p_amount, 0, p_cf_description)
    RETURNING id INTO v_cf_id;
    PERFORM recalculate_cash_flow_balances_from(v_cf_id);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION edit_expense_operation(integer, date, numeric, text, bigint, text) TO authenticated, service_role;
