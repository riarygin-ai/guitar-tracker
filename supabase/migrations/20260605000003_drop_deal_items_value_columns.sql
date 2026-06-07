ALTER TABLE deal_items
  DROP COLUMN IF EXISTS cash_value,
  DROP COLUMN IF EXISTS trade_value;
