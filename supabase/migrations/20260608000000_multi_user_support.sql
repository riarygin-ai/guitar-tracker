-- ============================================================
-- Multi-user support
--
-- Steps:
--   1.  Create app_users table
--   2.  Create get_app_user_id() SECURITY DEFINER helper
--   3.  Auto-create app_users row on auth signup (trigger)
--   4.  Seed Roman's record
--   5.  Add nullable user_id to all business tables
--   6.  Backfill all existing rows to Roman
--   7.  Make user_id NOT NULL + DEFAULT get_app_user_id()
--   8.  Fix cash_flow_before_insert trigger (user-aware)
--   9.  Replace recalculate_cash_flow_balances_from (user-aware)
--  10.  Enable RLS
--  11.  RLS policies
--  12.  Replace inventory_item_photos owner_id policies with user_id
--  13.  Recreate views with security_invoker=true
-- ============================================================

-- ─── 1. app_users ────────────────────────────────────────────────────────────

CREATE TABLE public.app_users (
  id            int          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id  uuid         NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text,
  display_name  text         NOT NULL,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.app_users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_users TO service_role;

-- ─── 2. get_app_user_id() ────────────────────────────────────────────────────
-- SECURITY DEFINER so it can read app_users even while RLS is bootstrapping.
-- auth.uid() reads request.jwt.claims GUC set by PostgREST — works inside
-- triggers, RPCs, and SECURITY DEFINER functions in the same session.

CREATE OR REPLACE FUNCTION public.get_app_user_id()
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.app_users WHERE auth_user_id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION public.get_app_user_id() TO authenticated, service_role;

-- ─── 3. Auto-create app_users row on auth signup ─────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.app_users (auth_user_id, email, display_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), 'User')
  )
  ON CONFLICT (auth_user_id) DO UPDATE
    SET email = EXCLUDED.email;
  RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ─── 4. Seed Roman's record ───────────────────────────────────────────────────

INSERT INTO public.app_users (auth_user_id, email, display_name)
SELECT
  id,
  email,
  COALESCE(raw_user_meta_data->>'full_name', split_part(email, '@', 1), 'Roman')
FROM auth.users
WHERE email = 'romzzzes@gmail.com'
ON CONFLICT (auth_user_id) DO UPDATE
  SET email         = EXCLUDED.email,
      display_name  = EXCLUDED.display_name;

-- ─── 5. Add nullable user_id columns ─────────────────────────────────────────

ALTER TABLE public.inventory_items      ADD COLUMN IF NOT EXISTS user_id int REFERENCES public.app_users(id);
ALTER TABLE public.deals                ADD COLUMN IF NOT EXISTS user_id int REFERENCES public.app_users(id);
ALTER TABLE public.cash_flow            ADD COLUMN IF NOT EXISTS user_id int REFERENCES public.app_users(id);
ALTER TABLE public.inventory_item_photos ADD COLUMN IF NOT EXISTS user_id int REFERENCES public.app_users(id);
ALTER TABLE public.inventory_expenses   ADD COLUMN IF NOT EXISTS user_id int REFERENCES public.app_users(id);
ALTER TABLE public.deal_items           ADD COLUMN IF NOT EXISTS user_id int REFERENCES public.app_users(id);

-- ─── 6. Backfill all existing rows to Roman ──────────────────────────────────

DO $$
DECLARE
  v_roman_id int;
BEGIN
  SELECT id INTO v_roman_id
  FROM public.app_users
  WHERE email = 'romzzzes@gmail.com'
  LIMIT 1;

  IF v_roman_id IS NULL THEN
    RAISE EXCEPTION 'Roman app_user record not found — step 4 may have failed';
  END IF;

  UPDATE public.inventory_items       SET user_id = v_roman_id WHERE user_id IS NULL;
  UPDATE public.deals                 SET user_id = v_roman_id WHERE user_id IS NULL;
  UPDATE public.cash_flow             SET user_id = v_roman_id WHERE user_id IS NULL;
  UPDATE public.inventory_item_photos SET user_id = v_roman_id WHERE user_id IS NULL;
  UPDATE public.inventory_expenses    SET user_id = v_roman_id WHERE user_id IS NULL;
  UPDATE public.deal_items            SET user_id = v_roman_id WHERE user_id IS NULL;
END $$;

-- ─── 7. NOT NULL + DEFAULT get_app_user_id() ─────────────────────────────────
-- DEFAULT fires automatically for any INSERT that omits user_id.
-- All existing RPCs (create_buy_operation, create_sell_operation,
-- create_trade_operation, create_expense_operation, edit_trade_operation)
-- omit user_id from their INSERTs — DEFAULT handles it without code changes.

ALTER TABLE public.inventory_items
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT public.get_app_user_id();

ALTER TABLE public.deals
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT public.get_app_user_id();

ALTER TABLE public.cash_flow
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT public.get_app_user_id();

ALTER TABLE public.inventory_item_photos
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT public.get_app_user_id();

ALTER TABLE public.inventory_expenses
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT public.get_app_user_id();

ALTER TABLE public.deal_items
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN user_id SET DEFAULT public.get_app_user_id();

-- ─── 8. User-aware cash_flow_before_insert trigger ───────────────────────────
-- Triggers run as the trigger function owner (postgres), bypassing RLS.
-- Must explicitly filter cash_flow by user via get_app_user_id().
-- auth.uid() GUC is still set in the session, so get_app_user_id() works here.

CREATE OR REPLACE FUNCTION public.cash_flow_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF new.opening_balance IS NULL OR new.opening_balance = 0 THEN
    SELECT closing_balance INTO new.opening_balance
    FROM public.cash_flow
    WHERE user_id = public.get_app_user_id()
    ORDER BY transaction_date DESC, id DESC
    LIMIT 1;

    IF new.opening_balance IS NULL THEN
      new.opening_balance := 0;
    END IF;
  END IF;

  new.closing_balance := new.opening_balance
    - COALESCE(new.cash_out, 0)
    + COALESCE(new.cash_in, 0);
  RETURN new;
END;
$$;

-- ─── 9. User-aware recalculate_cash_flow_balances_from ───────────────────────
-- Replaces the existing function (which was applied outside migrations and has
-- no user filtering). SECURITY DEFINER so it can write all rows for the
-- current user even if called mid-transaction while RLS is in effect.

CREATE OR REPLACE FUNCTION public.recalculate_cash_flow_balances_from(p_start_id bigint)
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
    v_running := 0;
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

GRANT EXECUTE ON FUNCTION public.recalculate_cash_flow_balances_from(bigint) TO authenticated, service_role;

-- ─── 10. Enable RLS ──────────────────────────────────────────────────────────

ALTER TABLE public.app_users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_flow           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_expenses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_items          ENABLE ROW LEVEL SECURITY;
-- inventory_item_photos RLS already enabled (from photos migration)

-- ─── 11. RLS policies ────────────────────────────────────────────────────────

-- app_users: each user sees and manages only their own record
CREATE POLICY "app_users: select own"
  ON public.app_users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "app_users: insert own"
  ON public.app_users FOR INSERT TO authenticated
  WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY "app_users: update own"
  ON public.app_users FOR UPDATE TO authenticated
  USING  (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- inventory_items
CREATE POLICY "inventory_items: select own"
  ON public.inventory_items FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "inventory_items: insert own"
  ON public.inventory_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "inventory_items: update own"
  ON public.inventory_items FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "inventory_items: delete own"
  ON public.inventory_items FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- deals
CREATE POLICY "deals: select own"
  ON public.deals FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "deals: insert own"
  ON public.deals FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "deals: update own"
  ON public.deals FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "deals: delete own"
  ON public.deals FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- cash_flow
CREATE POLICY "cash_flow: select own"
  ON public.cash_flow FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "cash_flow: insert own"
  ON public.cash_flow FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "cash_flow: update own"
  ON public.cash_flow FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "cash_flow: delete own"
  ON public.cash_flow FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- inventory_expenses
CREATE POLICY "inventory_expenses: select own"
  ON public.inventory_expenses FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "inventory_expenses: insert own"
  ON public.inventory_expenses FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "inventory_expenses: update own"
  ON public.inventory_expenses FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "inventory_expenses: delete own"
  ON public.inventory_expenses FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- deal_items
CREATE POLICY "deal_items: select own"
  ON public.deal_items FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "deal_items: insert own"
  ON public.deal_items FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "deal_items: update own"
  ON public.deal_items FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "deal_items: delete own"
  ON public.deal_items FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── 12. Replace inventory_item_photos policies ───────────────────────────────
-- Old policies used owner_id (auth UUID). New policies use user_id (app int FK)
-- for consistency with all other tables. owner_id is retained on the table
-- because storage paths are still keyed on auth.uid() (unchanged).

DROP POLICY IF EXISTS "photos_select" ON public.inventory_item_photos;
DROP POLICY IF EXISTS "photos_insert" ON public.inventory_item_photos;
DROP POLICY IF EXISTS "photos_update" ON public.inventory_item_photos;
DROP POLICY IF EXISTS "photos_delete" ON public.inventory_item_photos;

CREATE POLICY "photos_select"
  ON public.inventory_item_photos FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "photos_insert"
  ON public.inventory_item_photos FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "photos_update"
  ON public.inventory_item_photos FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "photos_delete"
  ON public.inventory_item_photos FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── 13. Recreate views with security_invoker=true ───────────────────────────
-- Without security_invoker, views run as their owner (postgres) and bypass RLS.
-- Also adds serial_number and user_id columns that were missing from the
-- original view definitions.

CREATE OR REPLACE VIEW public.inventory_items_search
WITH (security_invoker = true)
AS
SELECT
  i.id,
  i.brand_id,
  i.item_type,
  i.model,
  i.serial_number,
  i.date_listed,
  i.sold_date,
  i.estimated_sold_value,
  i.collection_type,
  i.condition,
  i.status,
  i.notes,
  i.created_at,
  i.updated_at,
  i.year,
  i.color,
  i.user_id,
  b.name AS brand_name
FROM public.inventory_items i
JOIN public.brands b ON (b.id = i.brand_id);

CREATE OR REPLACE VIEW public.inventory_items_with_value
WITH (security_invoker = true)
AS
SELECT
  i.id,
  i.brand_id,
  i.item_type,
  i.model,
  i.serial_number,
  i.date_listed,
  i.sold_date,
  i.estimated_sold_value,
  i.collection_type,
  i.condition,
  i.status,
  i.notes,
  i.created_at,
  i.updated_at,
  i.year,
  i.color,
  i.user_id,
  di.total_value AS value_in
FROM public.inventory_items i
LEFT JOIN public.deal_items di ON (di.item_id = i.id AND di.direction = 'in');
