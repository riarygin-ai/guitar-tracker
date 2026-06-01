-- Remove acquisition-related columns from inventory_items.
-- These belong to the deals table instead.
ALTER TABLE inventory_items DROP COLUMN IF EXISTS date_acquired;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS acquisition_channel;
ALTER TABLE inventory_items DROP COLUMN IF EXISTS channel;
