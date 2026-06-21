-- Add optional p_seed_balance parameter to recalculate_cash_flow_balances_from.
-- When provided and no predecessor row exists (i.e. this is the first record),
-- v_running is seeded with p_seed_balance instead of 0.
-- Default is NULL which preserves the existing behaviour.

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
