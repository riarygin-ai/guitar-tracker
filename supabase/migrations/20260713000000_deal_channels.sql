-- deal_channels: normalized lookup table replacing deals.channel (free-text)
-- Seed: Marketplace, Kijiji, Reverb, Regular Buyer / Seller
-- Migration: backfill deal_channel_id from existing channel strings, then drop channel.
-- Recreates create_buy_operation, create_sell_operation, create_trade_operation,
--           edit_buy_operation, edit_trade_operation with p_channel_id bigint.
-- Also updates create_item_with_historical_import (Historical Import has no channel).

-- ── 1. deal_channels table ────────────────────────────────────────────────────

CREATE TABLE deal_channels (
  id                  bigint generated always as identity primary key,
  name                text    not null,
  is_listing_platform boolean not null default false,
  sort_order          int     not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

CREATE UNIQUE INDEX deal_channels_name_ci ON deal_channels (lower(name));

ALTER TABLE deal_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deal_channels_select" ON deal_channels FOR SELECT TO authenticated USING (true);
CREATE POLICY "deal_channels_all"    ON deal_channels FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- ── 2. Seed ───────────────────────────────────────────────────────────────────

INSERT INTO deal_channels (name, is_listing_platform, sort_order) VALUES
  ('Marketplace',            true,  10),
  ('Kijiji',                 true,  20),
  ('Reverb',                 true,  30),
  ('Regular Buyer / Seller', false, 40);

-- ── 3. Add FK column to deals ─────────────────────────────────────────────────

ALTER TABLE deals ADD COLUMN deal_channel_id bigint REFERENCES deal_channels(id);

-- ── 4. Backfill from existing channel text ────────────────────────────────────

UPDATE deals d
SET    deal_channel_id = dc.id
FROM   deal_channels dc
WHERE  LOWER(d.channel) = LOWER(dc.name)
  AND  d.channel IS NOT NULL
  AND  LOWER(d.channel) <> 'opening balance';

-- ── 5. Warn on unmatched values ───────────────────────────────────────────────

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT channel, COUNT(*) AS cnt
    FROM   deals
    WHERE  channel IS NOT NULL
      AND  LOWER(channel) <> 'opening balance'
      AND  deal_channel_id IS NULL
    GROUP  BY channel
  LOOP
    RAISE WARNING 'Unmatched channel "%" — % deal(s) left with deal_channel_id NULL', r.channel, r.cnt;
  END LOOP;
END $$;

-- ── 6. Drop old column ────────────────────────────────────────────────────────

ALTER TABLE deals DROP COLUMN channel;

-- ── 7. create_item_with_historical_import (remove channel reference) ──────────

CREATE OR REPLACE FUNCTION public.create_item_with_historical_import(
  p_brand_id              bigint,
  p_item_type             text,
  p_item_subtype_id       bigint    DEFAULT NULL,
  p_model                 text      DEFAULT NULL,
  p_serial_number         text      DEFAULT NULL,
  p_year                  int       DEFAULT NULL,
  p_color                 text      DEFAULT NULL,
  p_condition             text      DEFAULT NULL,
  p_collection_type       text      DEFAULT NULL,
  p_estimated_sold_value  numeric   DEFAULT NULL,
  p_notes                 text      DEFAULT NULL,
  p_acquisition_date      date      DEFAULT NULL,
  p_value_in              numeric   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id bigint;
  v_deal_id bigint;
BEGIN
  IF p_brand_id IS NULL THEN RAISE EXCEPTION 'brand_id is required'; END IF;
  IF trim(COALESCE(p_model, '')) = '' THEN RAISE EXCEPTION 'model is required'; END IF;
  IF p_acquisition_date IS NULL THEN RAISE EXCEPTION 'acquisition_date is required'; END IF;
  IF p_value_in IS NULL OR p_value_in <= 0 THEN RAISE EXCEPTION 'value_in must be greater than 0'; END IF;

  INSERT INTO public.inventory_items (
    brand_id, item_type, item_subtype_id,
    model, serial_number, year, color,
    condition, collection_type, estimated_sold_value, notes,
    status, date_listed, sold_date
  ) VALUES (
    p_brand_id, p_item_type, p_item_subtype_id,
    p_model, p_serial_number, p_year, p_color,
    p_condition, p_collection_type, p_estimated_sold_value, p_notes,
    'owned', NULL, NULL
  )
  RETURNING id INTO v_item_id;

  INSERT INTO public.deals (deal_date, deal_type, cash_received, cash_paid, fees, notes)
  VALUES (p_acquisition_date, 'Historical Import', 0, 0, 0, 'Historical inventory import')
  RETURNING id INTO v_deal_id;

  INSERT INTO public.deal_items (deal_id, item_id, direction, total_value, notes)
  VALUES (v_deal_id, v_item_id, 'in', p_value_in, 'Historical import. Value in: $' || p_value_in::text);

  RETURN jsonb_build_object('item_id', v_item_id, 'deal_id', v_deal_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_item_with_historical_import(
  bigint, text, bigint, text, text, int, text, text, text, numeric, text, date, numeric
) TO authenticated;

-- ── 8. create_buy_operation (p_incoming_items jsonb, p_channel_id bigint) ─────

CREATE OR REPLACE FUNCTION create_buy_operation(
  p_deal_date      date,
  p_channel_id     bigint  DEFAULT NULL,
  p_incoming_items jsonb   DEFAULT '[]',
  p_notes          text    DEFAULT NULL,
  p_cf_description text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal_id    bigint;
  v_cf_id      bigint;
  v_total      numeric;
  v_item       jsonb;
  v_status     text;
BEGIN
  IF p_channel_id IS NULL THEN
    RAISE EXCEPTION 'Channel is required';
  END IF;
  IF jsonb_array_length(p_incoming_items) = 0 THEN
    RAISE EXCEPTION 'Purchase must have at least one item';
  END IF;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0)
  INTO v_total
  FROM jsonb_array_elements(p_incoming_items) v;

  INSERT INTO deals (deal_type, deal_date, deal_channel_id, cash_paid, cash_received, fees, notes)
  VALUES ('purchase', p_deal_date, p_channel_id, v_total, 0, 0, p_notes)
  RETURNING id INTO v_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_incoming_items) LOOP
    SELECT status INTO v_status FROM inventory_items WHERE id = (v_item->>'item_id')::bigint;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item % not found', (v_item->>'item_id');
    END IF;
    IF v_status <> 'new' THEN
      RAISE EXCEPTION 'Item must have status ''new'' to be purchased (current: %)', v_status;
    END IF;

    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (v_deal_id, (v_item->>'item_id')::bigint, 'in', (v_item->>'total_value')::numeric);

    UPDATE inventory_items SET status = 'owned' WHERE id = (v_item->>'item_id')::bigint;
  END LOOP;

  IF v_total > 0 THEN
    INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
    VALUES (v_deal_id, p_deal_date, 0, 0, v_total, 0, p_cf_description)
    RETURNING id INTO v_cf_id;

    PERFORM recalculate_cash_flow_balances_from(v_cf_id);
  END IF;

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;

-- ── 9. create_sell_operation ──────────────────────────────────────────────────

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

  INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
  VALUES (v_deal_id, p_deal_date, 0, p_cash_received, 0, 0, p_cf_description)
  RETURNING id INTO v_cf_id;

  PERFORM recalculate_cash_flow_balances_from(v_cf_id);

  RETURN jsonb_build_object('deal_id', v_deal_id, 'cf_id', v_cf_id);
END;
$$;

-- ── 10. create_trade_operation ────────────────────────────────────────────────

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
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (v_deal_id, (v_item->>'item_id')::bigint, 'out', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'traded', sold_date = p_deal_date WHERE id = (v_item->>'item_id')::bigint;
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

-- ── 11. edit_buy_operation ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION edit_buy_operation(
  p_deal_id        integer,
  p_deal_date      date,
  p_channel_id     bigint  DEFAULT NULL,
  p_notes          text    DEFAULT NULL,
  p_incoming_items jsonb   DEFAULT '[]',
  p_cf_description text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_deal        deals%ROWTYPE;
  v_old_cf      cash_flow%ROWTYPE;
  v_cf_id       bigint;
  v_total       numeric;
  v_item        jsonb;
  v_succ_id     bigint;
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Deal % not found', p_deal_id; END IF;
  IF v_deal.deal_type <> 'purchase' THEN RAISE EXCEPTION 'Deal % is not a purchase', p_deal_id; END IF;

  IF jsonb_array_length(p_incoming_items) = 0 THEN
    RAISE EXCEPTION 'Purchase must have at least one item';
  END IF;

  -- Revert current items to 'new' if still 'owned'
  UPDATE inventory_items SET status = 'new'
  WHERE id IN (SELECT item_id FROM deal_items WHERE deal_id = p_deal_id AND direction = 'in')
    AND status = 'owned';

  -- Capture existing CF row
  SELECT * INTO v_old_cf FROM cash_flow WHERE deal_id = p_deal_id LIMIT 1;
  IF FOUND THEN v_cf_id := v_old_cf.id; END IF;

  DELETE FROM deal_items WHERE deal_id = p_deal_id;

  SELECT COALESCE(SUM((v->>'total_value')::numeric), 0) INTO v_total FROM jsonb_array_elements(p_incoming_items) v;

  UPDATE deals SET
    deal_date       = p_deal_date,
    deal_channel_id = p_channel_id,
    notes           = p_notes,
    cash_paid       = v_total
  WHERE id = p_deal_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_incoming_items) LOOP
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (p_deal_id, (v_item->>'item_id')::bigint, 'in', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'owned' WHERE id = (v_item->>'item_id')::bigint AND status = 'new';
  END LOOP;

  IF v_cf_id IS NOT NULL THEN
    IF v_total = 0 THEN
      SELECT id INTO v_succ_id FROM cash_flow
      WHERE (transaction_date > v_old_cf.transaction_date
          OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
        AND id <> v_cf_id
      ORDER BY transaction_date, id LIMIT 1;

      DELETE FROM cash_flow WHERE id = v_cf_id;
      IF v_succ_id IS NOT NULL THEN PERFORM recalculate_cash_flow_balances_from(v_succ_id); END IF;
    ELSE
      -- Find old position's successor before updating date
      SELECT id INTO v_succ_id FROM cash_flow
      WHERE (transaction_date > v_old_cf.transaction_date
          OR (transaction_date = v_old_cf.transaction_date AND id > v_cf_id))
        AND id <> v_cf_id
      ORDER BY transaction_date, id LIMIT 1;

      UPDATE cash_flow SET
        transaction_date = p_deal_date,
        cash_out         = v_total,
        cash_in          = 0,
        description      = COALESCE(p_cf_description, description)
      WHERE id = v_cf_id;

      IF p_deal_date > v_old_cf.transaction_date AND v_succ_id IS NOT NULL THEN
        PERFORM recalculate_cash_flow_balances_from(v_succ_id);
      ELSE
        PERFORM recalculate_cash_flow_balances_from(v_cf_id);
      END IF;
    END IF;
  ELSE
    IF v_total > 0 THEN
      INSERT INTO cash_flow (deal_id, transaction_date, opening_balance, cash_in, cash_out, closing_balance, description)
      VALUES (p_deal_id, p_deal_date, 0, 0, v_total, 0, p_cf_description)
      RETURNING id INTO v_cf_id;
      PERFORM recalculate_cash_flow_balances_from(v_cf_id);
    END IF;
  END IF;
END;
$$;

-- ── 12. edit_trade_operation ──────────────────────────────────────────────────

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
    INSERT INTO deal_items (deal_id, item_id, direction, total_value)
    VALUES (p_deal_id, (v_item->>'item_id')::integer, 'out', (v_item->>'total_value')::numeric);
    UPDATE inventory_items SET status = 'traded', sold_date = p_deal_date WHERE id = (v_item->>'item_id')::integer;
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
