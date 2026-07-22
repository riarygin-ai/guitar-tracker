-- ============================================================================
-- 02_historical_import_audit.sql
--
-- Read-only audit of every "Historical Import" acquisition deal, ahead of a
-- planned data correction that relabels deal_type to 'Historical Purchase' or
-- 'Historical Trade' for items whose real acquisition method is now known —
-- while keeping the deal_type distinct from plain 'purchase'/'trade' (so nothing
-- treats it as a normal, balance-checked, editable operation) and preserving
-- "Historical Import" identification for analytics.
--
-- Companion files (not part of this analytics/ folder's read-only scope —
-- see analytics/README.md):
--   supabase/migrations/20260724000000_historical_deal_type_labels.sql
--     Updates analytics_item_lifecycle to derive acquisition_method and
--     is_historical_import from deal_type IN ('Historical Import',
--     'Historical Purchase', 'Historical Trade') — no new column, no backfill.
--   supabase/data-fixes/correct_historical_import_operations.sql
--     The actual correction, driven by an item_id -> acquisition_method
--     mapping you supply. Reads this audit's safe_to_correct column as its
--     own pre-flight guard, so this file and that one must stay in agreement.
--
-- Nothing here writes to the database — SELECT only, no database objects
-- created. Reads deals/deal_items/inventory_items/brands directly rather
-- than through analytics_item_lifecycle, because the view's `acquisition`
-- CTE uses DISTINCT ON (item_id) to collapse to one row per item — exactly
-- the kind of multi-deal/multi-item edge case this audit needs to surface,
-- not hide.
--
-- Safety model (revised): a Historical Import deal has exactly one deal_items
-- row (direction='in') and no outgoing item — by design, since nothing about
-- what may have been given up in a pre-app trade was ever recorded. Relabeling
-- to 'Historical Purchase' or 'Historical Trade' is equally safe either way,
-- BECAUSE the corrected value stays distinct from the literal 'purchase'/
-- 'trade' the app's RPCs and balance invariants apply to — a 'Historical
-- Trade' is explicitly allowed to stay structurally incomplete (see the
-- migration file header for the full reasoning and code paths checked). The
-- only thing that still blocks a correction is the deal having MORE than one
-- deal_items row (a shape this file's correction script doesn't handle) —
-- see blocking_reason.
-- ============================================================================

WITH historical_deals AS (
  SELECT d.id AS deal_id
  FROM   deals d
  WHERE  d.deal_type = 'Historical Import'
),
deal_item_stats AS (
  -- One row per Historical Import deal, describing its FULL deal_items
  -- composition (not just this item's own row) — this is what
  -- safe_to_correct is actually based on.
  SELECT
    di.deal_id,
    COUNT(*)                                                  AS deal_item_count,
    BOOL_OR(di.direction = 'in')                               AS deal_has_incoming,
    BOOL_OR(di.direction = 'out')                              AS deal_has_outgoing
  FROM   deal_items di
  JOIN   historical_deals hd ON hd.deal_id = di.deal_id
  GROUP  BY di.deal_id
)
SELECT
  ii.id                                AS item_id,
  ii.user_id,
  CONCAT_WS(' ', ii.year::text, br.name, ii.model) AS item_name,
  ii.status                            AS current_status,

  d.id                                 AS acquisition_deal_id,
  d.deal_type                          AS current_deal_type,
  di.direction                         AS deal_item_direction,
  d.deal_date                          AS acquisition_date,
  di.total_value                       AS acquisition_value,
  d.cash_paid,
  d.cash_received,
  d.notes                              AS deal_notes,
  di.notes                             AS deal_item_notes,

  dis.deal_item_count                  AS items_on_same_deal,
  dis.deal_has_incoming,
  dis.deal_has_outgoing,

  'unknown'                            AS current_acquisition_method,
  true                                 AS current_is_historical_import,

  -- Structurally safe to correct (to EITHER 'Historical Purchase' or
  -- 'Historical Trade'): the deal must have exactly this one deal_items row
  -- (no sibling items to conflict with) and it must be the incoming side.
  -- Unlike a plain 'trade', a 'Historical Trade' does not need a balancing
  -- outgoing item — see the migration file header for why that's safe here.
  (dis.deal_item_count = 1 AND dis.deal_has_incoming AND NOT dis.deal_has_outgoing) AS safe_to_correct,

  CASE
    WHEN dis.deal_item_count > 1
      THEN 'Deal ' || d.id || ' has ' || dis.deal_item_count || ' deal_items rows — shared with other item(s); correct the whole deal together, not one item at a time.'
    WHEN dis.deal_has_outgoing
      THEN 'Deal ' || d.id || ' already has an outgoing item — not a plain single-item Historical Import shape; review manually.'
    WHEN NOT dis.deal_has_incoming
      THEN 'Deal ' || d.id || ' has no incoming deal_item for this item — investigate before correcting.'
    ELSE NULL
  END                                                          AS blocking_reason

FROM   inventory_items ii
JOIN   deal_items di       ON di.item_id = ii.id AND di.direction = 'in'
JOIN   deals d             ON d.id = di.deal_id
JOIN   historical_deals hd ON hd.deal_id = d.id
JOIN   deal_item_stats dis ON dis.deal_id = d.id
LEFT JOIN brands br        ON br.id = ii.brand_id
ORDER BY d.id, ii.id;
