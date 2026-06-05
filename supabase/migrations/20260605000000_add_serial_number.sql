ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS serial_number text;
