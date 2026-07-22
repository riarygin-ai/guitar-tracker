-- ============================================================================
-- correct_historical_import_operations.sql
--
-- One-off data correction: relabels deals.deal_type from 'Historical Import'
-- to 'Historical Purchase' or 'Historical Trade' for specific items, based on
-- a mapping you supply below — while preserving "Historical Import" as a
-- human-readable note and keeping analytics_item_lifecycle.is_historical_import
-- true for those items going forward.
--
-- This is a data fix, not a schema migration — it is NOT auto-applied by
-- `supabase db push` / the migrations runner (same convention as
-- supabase/tests/). Run it manually against the target database.
--
-- ── PREREQUISITE ────────────────────────────────────────────────────────────
-- supabase/migrations/20260724000000_historical_deal_type_labels.sql should
-- be applied so analytics_item_lifecycle recognizes 'Historical Purchase' /
-- 'Historical Trade' immediately. Unlike an earlier version of this design,
-- there is no hard ordering requirement — is_historical_import and
-- acquisition_method are fully DERIVED from deal_type at query time, nothing
-- is backfilled, so there's no window where running this script first could
-- lose historical-import identification. Applying the view migration first
-- is still recommended so nothing is ever misread in between.
--
-- Review analytics/sql/02_historical_import_audit.sql for every item you're
-- about to list below — only rows where safe_to_correct is TRUE are handled
-- by this script; anything else needs manual review first.
--
-- ── WHY 'Historical Purchase' / 'Historical Trade' AND NOT 'purchase' / 'trade' ──
-- Every Historical Import deal has exactly one deal_items row (direction=
-- 'in'), no outgoing item, cash_paid=0, cash_received=0 — nothing about what
-- (if anything) was given up for a pre-app trade was ever recorded.
-- Relabeling to the literal 'trade' would make the deal indistinguishable
-- from a normal trade that every OTHER piece of code expects to balance
-- (create_trade_operation's SUM(outgoing)+cash_paid = SUM(incoming)+
-- cash_received invariant, the /operations/[id] edit page's trade-balance
-- check, etc.) — a deal with only an incoming side would look broken there.
--
-- Keeping the corrected value as its own distinct string sidesteps this
-- entirely: nothing in the app matches deal_type against 'Historical
-- Purchase' / 'Historical Trade', so nothing tries to enforce balance,
-- editability, or cash-flow assumptions that don't apply to it. Full
-- inspection (see 20260724000000_historical_deal_type_labels.sql's header
-- for the complete list of files/lines checked): edit_buy_operation /
-- edit_trade_operation (RPCs) both `RAISE EXCEPTION` on any deal_type other
-- than the exact literal they expect — a Historical Purchase/Trade deal is
-- rejected at the DB layer even if something tried to open it as a normal
-- operation. The /operations/[id]
-- edit page's handleSave() falls through to its generic "individual field
-- updates" branch (deal_date/channel/notes only — same branch 'Historical
-- Import' already uses today). Cash-impact and cash-flow filtering code
-- (operations/page.tsx, cash-flow/page.tsx, src/app/page.tsx's monthly
-- dashboard) all match against the literal {'purchase','sale','trade',
-- 'expense'} set and exclude anything else. The item lifecycle chain page's
-- trade-walking logic (`dealTypeById[acqDeal] !== 'trade'`) stops at a
-- Historical Trade acquisition instead of trying to walk into a nonexistent
-- outgoing side.
--
-- UI note: src/lib/supabase.ts's getHistoricalImportByItemId() (and the
-- read-only "Acquired [date] / Value in $X" box on the item edit form,
-- InventoryForm.tsx) already recognizes 'Historical Purchase' and
-- 'Historical Trade' alongside 'Historical Import', and displays the
-- specific corrected label — that box keeps showing after this script runs.
--
-- ── What changes / what's preserved ─────────────────────────────────────────
-- Changes:   deals.deal_type, deals.notes (marker appended, not duplicated).
-- Untouched: deals.cash_paid, deals.cash_received, deal_items (direction,
--            total_value, notes), inventory_items (status and everything
--            else), cash_flow (no rows inserted, modified, or recalculated —
--            running cash balance is unaffected).
--
-- ── Safety ───────────────────────────────────────────────────────────────
-- Runs inside an explicit transaction. Every guard in step 3 aborts the
-- WHOLE transaction (RAISE EXCEPTION) on the first problem found — nothing
-- partial gets applied. ROLLBACK is the default outcome of running this
-- file top-to-bottom unmodified: review the RETURNING output in step 4 and
-- the validation queries in step 5, THEN comment out the final ROLLBACK and
-- uncomment COMMIT if everything looks right.
-- ============================================================================

BEGIN;

-- ── 1. Your mapping ─────────────────────────────────────────────────────────
-- Edit this VALUES list only. acquisition_method is 'purchase' (-> deal_type
-- 'Historical Purchase') or 'trade' (-> deal_type 'Historical Trade') —
-- matching the same 'purchase'/'trade' terminology already stored in
-- deals.deal_type; 'cash' is never used as a stored value anywhere in this
-- schema.

CREATE TEMP TABLE _corrections (
  item_id            bigint PRIMARY KEY,
  acquisition_method text NOT NULL CHECK (acquisition_method IN ('purchase', 'trade'))
) ON COMMIT DROP;

INSERT INTO _corrections (item_id, acquisition_method) VALUES
  (101, 'purchase'),
  (102, 'trade'),
  (103, 'purchase');
  -- add / remove rows here — item_id must be a real inventory_items.id


-- ── 2. Resolve each mapped item to its Historical Import deal ───────────────
-- `deal_id` is deliberately taken from the FILTERED join (ad.deal_type =
-- 'Historical Import'), not straight from deal_items — so it comes out NULL
-- whenever the item's incoming deal_item exists but the deal isn't (or no
-- longer is) deal_type = 'Historical Import' — e.g. already corrected by a
-- previous run of this script. That NULL is exactly what guard 3b below
-- checks for. `actual_deal_type` is kept separately, unfiltered, purely so
-- guard 3b's error message can say what the deal_type actually is instead of
-- a misleading "no matching deal".

CREATE TEMP TABLE _resolved ON COMMIT DROP AS
SELECT
  c.item_id,
  c.acquisition_method,
  di.id                                                          AS deal_item_id,
  ad.deal_type                                                   AS actual_deal_type,
  CASE WHEN ad.deal_type = 'Historical Import' THEN di.deal_id END AS deal_id
FROM _corrections c
LEFT JOIN deal_items di ON di.item_id = c.item_id AND di.direction = 'in'
LEFT JOIN deals ad      ON ad.id = di.deal_id;


-- ── 3. Hard guards — any of these aborts the whole transaction ─────────────

-- 3a. item_id not present in inventory_items at all
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(c.item_id::text, ', ' ORDER BY c.item_id)
  INTO   v_missing
  FROM   _corrections c
  WHERE  NOT EXISTS (SELECT 1 FROM inventory_items ii WHERE ii.id = c.item_id);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Item(s) not found in inventory_items: %', v_missing;
  END IF;
END $$;

-- 3b. item has no Historical Import acquisition deal to correct — already
--     corrected, never was one, or has no incoming deal_item at all. This is
--     also how "no unique acquisition deal can be identified" is enforced:
--     a NULL deal_id here means step 2 could not pin down exactly one
--     Historical Import deal for this item.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(
           item_id::text || ' (current deal_type: ' || COALESCE(actual_deal_type, 'no incoming deal_item found') || ')',
           ', ' ORDER BY item_id
         )
  INTO   v_bad
  FROM   _resolved
  WHERE  deal_id IS NULL;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Item(s) have no Historical Import acquisition deal to correct — re-check analytics/sql/02_historical_import_audit.sql (may already be corrected, or was never Historical Import): %', v_bad;
  END IF;
END $$;

-- 3c. item maps to more than one Historical Import deal (duplicate-import bug)
DO $$
DECLARE v_dup text;
BEGIN
  SELECT string_agg(item_id::text, ', ' ORDER BY item_id)
  INTO   v_dup
  FROM   (
    SELECT item_id FROM _resolved GROUP BY item_id HAVING COUNT(*) > 1
  ) x;

  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'Item(s) resolve to more than one Historical Import deal — investigate before correcting: %', v_dup;
  END IF;
END $$;

-- 3d. a deal is targeted by more than one mapped item with DIFFERENT
--     requested methods — deal_type is deal-level, so every item sharing a
--     deal must agree on what it's being corrected to
DO $$
DECLARE v_conflict text;
BEGIN
  SELECT string_agg('deal ' || deal_id::text || ': ' || methods, '; ' ORDER BY deal_id)
  INTO   v_conflict
  FROM   (
    SELECT deal_id, string_agg(DISTINCT acquisition_method, ' vs ' ORDER BY acquisition_method) AS methods
    FROM   _resolved
    GROUP  BY deal_id
    HAVING COUNT(DISTINCT acquisition_method) > 1
  ) x;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'Conflicting requested acquisition_method for items sharing one deal: %', v_conflict;
  END IF;
END $$;

-- 3e. the resolved deal has more than one deal_items row at all (even if
--     every mapped item agrees on the method) — this script only ever
--     handles the standard one-item-per-deal Historical Import shape (see
--     analytics/sql/02_historical_import_audit.sql's safe_to_correct); a
--     shared deal is not that shape and needs manual review, not a blind
--     bulk relabel. Applies equally to 'purchase' and 'trade' requests —
--     unlike an earlier version of this script, 'trade' requests are NOT separately
--     blocked for lacking an outgoing item, because 'Historical Trade' is
--     deliberately allowed to stay structurally incomplete (see header).
DO $$
DECLARE v_shared text;
BEGIN
  SELECT string_agg(deal_id::text, ', ' ORDER BY deal_id)
  INTO   v_shared
  FROM   (
    SELECT deal_id, COUNT(*) AS c
    FROM   deal_items
    WHERE  deal_id IN (SELECT deal_id FROM _resolved)
    GROUP  BY deal_id
    HAVING COUNT(*) > 1
  ) x;

  IF v_shared IS NOT NULL THEN
    RAISE EXCEPTION 'Deal(s) have more than one deal_items row attached — not a plain single-item Historical Import; review manually before correcting: %', v_shared;
  END IF;
END $$;


-- ── 4. Snapshot "before" state for the mapped items, for step 5 ────────────

CREATE TEMP TABLE _before_snapshot ON COMMIT DROP AS
SELECT
  a.item_id, a.acquisition_deal_id, a.acquisition_deal_type, a.acquisition_date,
  a.acquisition_value, a.acquisition_method, a.is_historical_import, a.current_status,
  d.cash_paid, d.cash_received
FROM analytics_item_lifecycle a
JOIN _resolved r ON r.item_id = a.item_id
JOIN deals d      ON d.id = r.deal_id;

CREATE TEMP TABLE _before_globals ON COMMIT DROP AS
SELECT
  (SELECT COUNT(*) FROM analytics_item_lifecycle)                        AS lifecycle_row_count,
  (SELECT COUNT(*) FROM analytics_item_lifecycle WHERE acquisition_method = 'unknown') AS unknown_method_count,
  (SELECT COUNT(*) FROM cash_flow)                                       AS cash_flow_row_count,
  (SELECT closing_balance FROM cash_flow ORDER BY transaction_date DESC, id DESC LIMIT 1) AS latest_closing_balance;


-- ── 5. Apply the correction ─────────────────────────────────────────────────
-- Only deal_type and notes change. cash_paid, cash_received, deal_items,
-- inventory_items are all left exactly as they are.

WITH updated AS (
  UPDATE deals d
  SET
    deal_type = CASE r.acquisition_method WHEN 'purchase' THEN 'Historical Purchase' WHEN 'trade' THEN 'Historical Trade' END,
    notes     = CASE
                  WHEN d.notes IS NULL OR d.notes = ''      THEN 'Historical Import'
                  WHEN d.notes ILIKE '%historical%import%'  THEN d.notes
                  ELSE d.notes || ' | Historical Import'
                END
  FROM   _resolved r
  WHERE  d.id = r.deal_id
  RETURNING d.id AS deal_id, d.deal_type, d.cash_paid, d.cash_received, d.notes
)
SELECT
  r.item_id,
  r.acquisition_method AS requested_method,
  u.deal_id,
  u.deal_type          AS new_deal_type,
  u.cash_paid,
  u.cash_received,
  u.notes
FROM   updated u
JOIN   _resolved r ON r.deal_id = u.deal_id
ORDER  BY r.item_id;


-- ── 6. Validation — review before deciding COMMIT vs ROLLBACK ──────────────

-- 6a. Per-item before/after: deal_type + acquisition_method corrected,
--     is_historical_import still true, and everything else (acquisition
--     date/value, item status, cash_paid/cash_received) UNCHANGED.
SELECT
  b.item_id,
  b.acquisition_deal_type    AS old_deal_type,
  a.acquisition_deal_type    AS new_deal_type,
  b.acquisition_method       AS old_acquisition_method,
  a.acquisition_method       AS new_acquisition_method,
  a.is_historical_import     AS is_historical_import_still_true,
  (b.acquisition_date  = a.acquisition_date)  AS acquisition_date_unchanged,
  (b.acquisition_value = a.acquisition_value) AS acquisition_value_unchanged,
  (b.current_status    = a.current_status)    AS item_status_unchanged,
  (b.cash_paid = d.cash_paid AND b.cash_received = d.cash_received) AS cash_fields_unchanged
FROM   _before_snapshot b
JOIN   analytics_item_lifecycle a ON a.item_id = b.item_id
JOIN   _resolved r ON r.item_id = b.item_id
JOIN   deals d      ON d.id = r.deal_id
ORDER  BY b.item_id;

-- 6b. Global invariants: lifecycle row count unchanged, no duplicate item
--     rows, cash_flow untouched (row count + latest running balance both
--     identical), unknown-method count dropped by exactly the corrected count.
SELECT
  g.lifecycle_row_count                                                       AS lifecycle_row_count_before,
  (SELECT COUNT(*) FROM analytics_item_lifecycle)                             AS lifecycle_row_count_after,
  g.unknown_method_count                                                      AS unknown_method_count_before,
  (SELECT COUNT(*) FROM analytics_item_lifecycle WHERE acquisition_method = 'unknown') AS unknown_method_count_after,
  g.cash_flow_row_count                                                       AS cash_flow_row_count_before,
  (SELECT COUNT(*) FROM cash_flow)                                            AS cash_flow_row_count_after,
  g.latest_closing_balance                                                    AS latest_closing_balance_before,
  (SELECT closing_balance FROM cash_flow ORDER BY transaction_date DESC, id DESC LIMIT 1) AS latest_closing_balance_after,
  (SELECT COUNT(*) FROM (SELECT item_id FROM analytics_item_lifecycle GROUP BY item_id HAVING COUNT(*) > 1) dup) AS duplicate_item_rows
FROM _before_globals g;

-- 6c. Confirms corrected deals cannot be mistaken for, or routed into, a
--     normal editable purchase/trade/sale/expense operation: the new
--     deal_type must NOT be a literal match for any value
--     edit_buy_operation, edit_trade_operation, or the frontend's
--     purchase/trade/sale/expense branches key off of. (edit_buy_operation /
--     edit_trade_operation are not invoked here — both RAISE EXCEPTION on
--     deal_type mismatch before touching anything, so this is checked
--     structurally instead of by calling them, to avoid aborting this
--     transaction from inside its own validation step.)
SELECT
  r.item_id,
  d.deal_type,
  (d.deal_type = ANY (ARRAY['purchase','sale','trade','expense'])) AS collides_with_normal_operation_type
FROM _resolved r
JOIN deals d ON d.id = r.deal_id
ORDER BY r.item_id;

-- 6d. Scoped re-run of Query G1's shape (historical-import sensitivity) and
--     Query G3's shape (acquisition-method comparison), restricted to the
--     corrected items' price bands, as a quick sanity check. Re-run the
--     FULL queries from analytics/sql/01_price_band_performance.sql
--     separately for the complete picture.
WITH price_band AS (
  SELECT *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS price_band_order
  FROM analytics_item_lifecycle
  WHERE purpose_name = 'Business' AND acquisition_value > 0
)
SELECT
  price_band_order,
  acquisition_method,
  is_historical_import,
  COUNT(*) AS sample_size
FROM price_band
WHERE item_id IN (SELECT item_id FROM _corrections)
   OR price_band_order IN (
        SELECT price_band_order FROM price_band WHERE item_id IN (SELECT item_id FROM _corrections)
      )
GROUP BY price_band_order, acquisition_method, is_historical_import
ORDER BY price_band_order, acquisition_method;


-- ── 7. Outcome — defaults to ROLLBACK ──────────────────────────────────────
-- Nothing is kept until you comment out ROLLBACK and uncomment COMMIT below.

-- COMMIT;
ROLLBACK;
