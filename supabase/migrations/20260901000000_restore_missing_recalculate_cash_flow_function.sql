-- Production is missing recalculate_cash_flow_balances_from entirely.
--
-- Confirmed directly against the hosted project (PostgREST schema-cache
-- probe via /rest/v1/rpc/recalculate_cash_flow_balances_from):
--   PGRST202 — "Could not find the function
--   public.recalculate_cash_flow_balances_from(p_start_id) in the schema
--   cache"
-- and the function is absent from the /rest/v1/ OpenAPI listing altogether,
-- while create_buy_operation, create_sell_operation, create_trade_operation,
-- create_expense_operation, edit_buy_operation, and edit_trade_operation
-- (which all PERFORM it after writing a cash_flow row) are present. Since
-- plpgsql does not validate function bodies against objects they reference
-- until call time, those operation functions were created successfully but
-- fail at runtime with "function recalculate_cash_flow_balances_from(bigint)
-- does not exist" — for every operation type that touches cash flow
-- (Purchase, Sale, Trade, Expense), not only Sale. Each call happens inside
-- the operation's own transaction, so a failure here rolls back the whole
-- save — no partial writes, no corrupted cash_flow history.
--
-- Local history shows this function should exist as a single overload:
-- created bigint-only in 20260608000000_multi_user_support, extended with an
-- optional p_seed_balance in 20260620000001_recalculate_seed_balance
-- (bigint, numeric DEFAULT NULL), then had the now-redundant bigint-only
-- overload dropped in 20260831000001_fix_recalculate_cash_flow_overload_ambiguity
-- to resolve a "not unique" error. On production, apparently only some
-- subset of that history actually landed (e.g. the DROP ran without the
-- corresponding CREATE), leaving no version of the function behind.
--
-- Fix: recreate the canonical 2-arg version — CREATE OR REPLACE, so this is
-- safe to re-run — and defensively drop the old 1-arg overload in case it
-- exists on whatever database this runs against, so the result converges to
-- the same single-overload state regardless of starting point. No business
-- logic changes: body is identical to the last-known-good definition in
-- 20260620000001.

DROP FUNCTION IF EXISTS public.recalculate_cash_flow_balances_from(bigint);

CREATE OR REPLACE FUNCTION public.recalculate_cash_flow_balances_from(
  p_start_id     bigint,
  p_seed_balance numeric(12, 2) DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    int;
  v_start_date date;
  v_running    numeric(12, 2);
  r            record;
BEGIN
  v_user_id := public.get_app_user_id();

  SELECT transaction_date INTO v_start_date
  FROM public.cash_flow
  WHERE id = p_start_id AND user_id = v_user_id;

  IF NOT FOUND THEN RETURN; END IF;

  -- Opening balance = closing balance of the row just before p_start_id for this user
  SELECT closing_balance INTO v_running
  FROM public.cash_flow
  WHERE user_id = v_user_id
    AND (
      transaction_date < v_start_date
      OR (transaction_date = v_start_date AND id < p_start_id)
    )
  ORDER BY transaction_date DESC, id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    -- No predecessor: use caller-supplied seed or default to 0
    v_running := COALESCE(p_seed_balance, 0);
  END IF;

  -- Walk all rows from p_start_id forward for this user and recalculate balances
  FOR r IN
    SELECT id, cash_in, cash_out
    FROM public.cash_flow
    WHERE user_id = v_user_id
      AND (
        transaction_date > v_start_date
        OR (transaction_date = v_start_date AND id >= p_start_id)
      )
    ORDER BY transaction_date ASC, id ASC
  LOOP
    UPDATE public.cash_flow
    SET opening_balance = v_running,
        closing_balance = v_running + COALESCE(r.cash_in, 0) - COALESCE(r.cash_out, 0)
    WHERE id = r.id;

    v_running := v_running + COALESCE(r.cash_in, 0) - COALESCE(r.cash_out, 0);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recalculate_cash_flow_balances_from(bigint, numeric) TO authenticated, service_role;
