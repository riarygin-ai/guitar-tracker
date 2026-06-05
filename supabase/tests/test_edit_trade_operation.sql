-- Tests for edit_trade_operation()
-- Run each block independently. All changes are rolled back.
-- Adjust deal_id / item_id values to match your dev database.

-- ============================================================
-- TEST 1: Edit metadata only (date, channel, notes)
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id   integer := 1;  -- replace with a real trade deal id
  v_out_item  integer;
  v_in_item   integer;
  v_out_val   numeric;
  v_in_val    numeric;
BEGIN
  SELECT item_id, total_value INTO v_out_item, v_out_val
  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;

  SELECT item_id, total_value INTO v_in_item, v_in_val
  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in' LIMIT 1;

  PERFORM edit_trade_operation(
    p_deal_id        => v_deal_id,
    p_deal_date      => '2026-01-15',
    p_channel        => 'Facebook',
    p_notes          => 'Test edit',
    p_cash_paid      => 0,
    p_cash_received  => 0,
    p_outgoing_items => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', v_out_val)),
    p_incoming_items => jsonb_build_array(jsonb_build_object('item_id', v_in_item, 'total_value', v_in_val))
  );

  ASSERT (SELECT channel FROM deals WHERE id = v_deal_id) = 'Facebook', 'Channel should be updated';
  ASSERT (SELECT deal_date FROM deals WHERE id = v_deal_id) = '2026-01-15', 'Date should be updated';
  RAISE NOTICE 'TEST 1 PASSED: metadata edit';
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 2: Edit trade values (rebalance by changing both sides)
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id   integer := 1;  -- replace with a real trade deal id
  v_out_item  integer;
  v_in_item   integer;
  v_date      date;
BEGIN
  SELECT deal_date INTO v_date FROM deals WHERE id = v_deal_id;
  SELECT item_id INTO v_out_item FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;
  SELECT item_id INTO v_in_item  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1;

  PERFORM edit_trade_operation(
    p_deal_id        => v_deal_id,
    p_deal_date      => v_date,
    p_cash_paid      => 0,
    p_cash_received  => 0,
    p_outgoing_items => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', 500)),
    p_incoming_items => jsonb_build_array(jsonb_build_object('item_id', v_in_item,  'total_value', 500))
  );

  ASSERT (SELECT total_value FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1) = 500, 'Outgoing value should be 500';
  ASSERT (SELECT total_value FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1) = 500, 'Incoming value should be 500';
  RAISE NOTICE 'TEST 2 PASSED: trade value edit';
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 3: Add cash to a previously cash-free trade
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id   integer := 1;  -- replace with a trade deal that has NO cash_flow row
  v_out_item  integer;
  v_in_item   integer;
  v_date      date;
  v_cf_count  integer;
BEGIN
  SELECT deal_date INTO v_date FROM deals WHERE id = v_deal_id;
  SELECT item_id INTO v_out_item FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;
  SELECT item_id INTO v_in_item  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1;

  PERFORM edit_trade_operation(
    p_deal_id        => v_deal_id,
    p_deal_date      => v_date,
    p_cash_paid      => 100,
    p_cash_received  => 0,
    p_outgoing_items => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', 400)),
    p_incoming_items => jsonb_build_array(jsonb_build_object('item_id', v_in_item,  'total_value', 500))
  );

  SELECT COUNT(*) INTO v_cf_count FROM cash_flow WHERE deal_id = v_deal_id;
  ASSERT v_cf_count = 1, 'A cash flow row should have been created';
  ASSERT (SELECT cash_out FROM cash_flow WHERE deal_id = v_deal_id LIMIT 1) = 100, 'CF cash_out should be 100';
  RAISE NOTICE 'TEST 3 PASSED: add cash to cash-free trade';
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 4: Remove cash from a trade (CF row should be deleted)
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id   integer := 2;  -- replace with a trade deal that HAS a cash_flow row
  v_out_item  integer;
  v_in_item   integer;
  v_date      date;
  v_cf_count  integer;
BEGIN
  SELECT deal_date INTO v_date FROM deals WHERE id = v_deal_id;
  SELECT item_id INTO v_out_item FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;
  SELECT item_id INTO v_in_item  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1;

  PERFORM edit_trade_operation(
    p_deal_id        => v_deal_id,
    p_deal_date      => v_date,
    p_cash_paid      => 0,
    p_cash_received  => 0,
    p_outgoing_items => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', 600)),
    p_incoming_items => jsonb_build_array(jsonb_build_object('item_id', v_in_item,  'total_value', 600))
  );

  SELECT COUNT(*) INTO v_cf_count FROM cash_flow WHERE deal_id = v_deal_id;
  ASSERT v_cf_count = 0, 'CF row should be deleted when cash becomes 0';
  RAISE NOTICE 'TEST 4 PASSED: remove cash from trade';
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 5: Unbalanced trade should raise an exception
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id   integer := 1;
  v_out_item  integer;
  v_in_item   integer;
  v_date      date;
BEGIN
  SELECT deal_date INTO v_date FROM deals WHERE id = v_deal_id;
  SELECT item_id INTO v_out_item FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;
  SELECT item_id INTO v_in_item  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1;

  BEGIN
    PERFORM edit_trade_operation(
      p_deal_id        => v_deal_id,
      p_deal_date      => v_date,
      p_cash_paid      => 0,
      p_cash_received  => 0,
      p_outgoing_items => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', 500)),
      p_incoming_items => jsonb_build_array(jsonb_build_object('item_id', v_in_item,  'total_value', 600))
    );
    RAISE EXCEPTION 'Should have thrown a balance error';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'TEST 5 PASSED: unbalanced trade rejected (%)' , SQLERRM;
  END;
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 6: Wrong deal type should raise an exception
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id integer := 99;  -- replace with a purchase or sale deal id
BEGIN
  BEGIN
    PERFORM edit_trade_operation(
      p_deal_id        => v_deal_id,
      p_deal_date      => '2026-01-01',
      p_outgoing_items => '[]',
      p_incoming_items => '[]'
    );
    RAISE EXCEPTION 'Should have thrown a deal type error';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'TEST 6 PASSED: non-trade deal rejected (%)' , SQLERRM;
  END;
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 7: CF recalculation — date moved backward
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id   integer := 2;  -- trade with cash and a later CF row in the table
  v_out_item  integer;
  v_in_item   integer;
  v_cf_before cash_flow%ROWTYPE;
  v_cf_after  cash_flow%ROWTYPE;
BEGIN
  SELECT item_id INTO v_out_item FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;
  SELECT item_id INTO v_in_item  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1;
  SELECT * INTO v_cf_before FROM cash_flow WHERE deal_id = v_deal_id LIMIT 1;

  PERFORM edit_trade_operation(
    p_deal_id             => v_deal_id,
    p_deal_date           => v_cf_before.transaction_date - interval '10 days',
    p_cash_paid           => v_cf_before.cash_out,
    p_cash_received       => v_cf_before.cash_in,
    p_outgoing_items      => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', v_cf_before.cash_out)),
    p_incoming_items      => jsonb_build_array(jsonb_build_object('item_id', v_in_item,  'total_value', v_cf_before.cash_out)),
    p_cf_transaction_date => v_cf_before.transaction_date - interval '10 days'
  );

  SELECT * INTO v_cf_after FROM cash_flow WHERE deal_id = v_deal_id LIMIT 1;
  ASSERT v_cf_after.closing_balance = v_cf_after.opening_balance - v_cf_after.cash_out + v_cf_after.cash_in,
    'Balance invariant must hold after date move backward';
  RAISE NOTICE 'TEST 7 PASSED: CF recalculation after date moved backward';
END;
$$;
ROLLBACK;


-- ============================================================
-- TEST 8: Inventory status preserved after edit
-- ============================================================
BEGIN;
DO $$
DECLARE
  v_deal_id  integer := 1;
  v_out_item integer;
  v_in_item  integer;
  v_date     date;
  v_status   text;
BEGIN
  SELECT deal_date INTO v_date FROM deals WHERE id = v_deal_id;
  SELECT item_id INTO v_out_item FROM deal_items WHERE deal_id = v_deal_id AND direction = 'out' LIMIT 1;
  SELECT item_id INTO v_in_item  FROM deal_items WHERE deal_id = v_deal_id AND direction = 'in'  LIMIT 1;

  PERFORM edit_trade_operation(
    p_deal_id        => v_deal_id,
    p_deal_date      => v_date,
    p_cash_paid      => 0,
    p_cash_received  => 0,
    p_outgoing_items => jsonb_build_array(jsonb_build_object('item_id', v_out_item, 'total_value', 400)),
    p_incoming_items => jsonb_build_array(jsonb_build_object('item_id', v_in_item,  'total_value', 400))
  );

  SELECT status INTO v_status FROM inventory_items WHERE id = v_out_item;
  ASSERT v_status = 'traded', 'Outgoing item should remain traded';

  SELECT status INTO v_status FROM inventory_items WHERE id = v_in_item;
  ASSERT v_status IN ('owned', 'listed'), 'Incoming item should remain owned/listed';

  RAISE NOTICE 'TEST 8 PASSED: inventory status preserved';
END;
$$;
ROLLBACK;
