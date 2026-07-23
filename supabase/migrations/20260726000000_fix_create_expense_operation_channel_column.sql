-- Fix create_expense_operation: deals.channel was dropped, this function
-- was never updated to match
--
-- Root cause: 20260713000000_deal_channels.sql dropped deals.channel (text)
-- and replaced it with deals.deal_channel_id (bigint FK to deal_channels),
-- and redefined create_buy_operation / create_sell_operation /
-- create_trade_operation / edit_buy_operation / edit_trade_operation /
-- create_item_with_historical_import to match — but create_expense_operation
-- was left out of that list entirely. It has been INSERTing into a column
-- that hasn't existed since that migration:
--
--   INSERT INTO deals (deal_type, deal_date, channel, cash_paid, ...)
--
-- Every call to create_expense_operation since then has failed with
-- `ERROR: column "channel" of relation "deals" does not exist`
-- (Postgres 42703, undefined_column), which Supabase/PostgREST surfaces to
-- the browser as HTTP 400. The frontend (ExpenseOperationForm.tsx) then
-- discards that error entirely and shows a hardcoded "Could not save
-- expense." — which is why the real cause never appeared in the UI or
-- console. That discard is fixed separately in ExpenseOperationForm.tsx.
--
-- Fix: drop the channel reference. Expenses never had a channel selector in
-- the UI to begin with (unlike Buy/Sell/Trade) — channel was always passed
-- as a literal NULL — so this isn't adding deal_channel_id support, just
-- removing a reference to a column that no longer exists. Everything else
-- this function does (validation, inventory_expenses row, cash_flow row,
-- balance recalculation) is unchanged.

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

  INSERT INTO deals (deal_type, deal_date, cash_paid, cash_received, fees, notes)
  VALUES ('expense', p_expense_date, p_amount, 0, 0, p_notes)
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
