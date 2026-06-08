-- Backfill sold_date for sold/traded items where it is NULL.
--
-- Root cause: InventoryForm.tsx was sending `sold_date: null` on every save,
-- including edits of already-sold/traded items, silently wiping the field.
-- This was fixed in the corresponding app code change.
--
-- This migration restores sold_date from each item's most recent 'out'
-- deal_item's deal_date (matching the logic in create_sell_operation /
-- create_trade_operation which set `sold_date = p_deal_date`).

UPDATE inventory_items i
SET sold_date = latest_out.deal_date
FROM (
  SELECT DISTINCT ON (di.item_id)
    di.item_id,
    d.deal_date
  FROM deal_items di
  JOIN deals d ON d.id = di.deal_id
  WHERE di.direction = 'out'
  ORDER BY di.item_id, di.deal_id DESC
) AS latest_out
WHERE latest_out.item_id = i.id
  AND i.status IN ('sold', 'traded')
  AND i.sold_date IS NULL;
