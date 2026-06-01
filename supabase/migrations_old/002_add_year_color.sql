-- Add year and color columns to inventory_items
ALTER TABLE inventory_items ADD COLUMN year integer;
ALTER TABLE inventory_items ADD COLUMN color text;
