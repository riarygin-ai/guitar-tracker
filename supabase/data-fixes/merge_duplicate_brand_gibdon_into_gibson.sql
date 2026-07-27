-- ============================================================================
-- merge_duplicate_brand_gibdon_into_gibson.sql
--
-- One-off data correction: merges the misspelled/duplicate brand "Gibdon"
-- into the existing "Gibson" brand, found by
-- analytics/sql/03_brand_performance.sql's Query A3 (capitalization/
-- typo audit): Gibdon (1 item, in A3's Business + acquisition_value > 0
-- scope) vs. Gibson (20 items, same scope).
--
-- This is a data fix, not a schema migration — it is NOT auto-applied by
-- `supabase db push` / the migrations runner (same convention as
-- supabase/tests/ and supabase/data-fixes/correct_historical_import_operations.sql).
-- Run it manually against the target database.
--
-- ── SCHEMA INSPECTION — every FK/reference to public.brands ────────────────
-- Grepped every migration for "brands"/"brand_id". Findings:
--   - inventory_items.brand_id (bigint, NOT NULL) is the ONLY column in the
--     entire schema with a foreign key into public.brands(id)
--     (inventory_items_brand_id_fkey). This is the only row-level reference
--     this script needs to move.
--   - Every other hit is either a VIEW selecting/joining brand_id/brands
--     (inventory_items_search, inventory_items_with_value,
--     analytics_item_lifecycle, and their historical predecessors) — views
--     re-read live data, so they need no separate fix — or an RPC parameter
--     (p_brand_id on create_buy_operation/create_item_with_historical_import/
--     etc.) that is written straight into inventory_items.brand_id at
--     INSERT time, not stored anywhere else.
--   - brands itself has no user_id column and no RLS policies (a shared,
--     non-per-user catalog table) — this script does not need to run as any
--     particular role, but should be run with a role that can UPDATE
--     inventory_items and DELETE from brands regardless of RLS (e.g. the
--     Supabase SQL Editor's default role), since it intentionally touches
--     rows that may belong to more than one app user.
--
-- ── SCOPE CAVEAT — read before relying on "1 item" ──────────────────────────
-- Query A3's "Gibdon: 1 item" / "Gibson: 20 items" counts were taken from
-- analytics_item_lifecycle filtered to purpose_name = 'Business' AND
-- acquisition_value > 0 (03_brand_performance.sql's primary analytical
-- population). This script does NOT trust that number — guard 3 below
-- independently counts EVERY inventory_items row referencing Gibdon,
-- regardless of purpose or acquisition value, and aborts if that true count
-- isn't exactly 1, so a Personal-purpose or zero-value Gibdon item A3 would
-- never have shown you can't slip through unnoticed.
--
-- ── What changes / what's preserved ─────────────────────────────────────────
-- Changes:   inventory_items.brand_id (Gibdon's id -> Gibson's id), for
--            whichever row(s) currently reference Gibdon. The brands row
--            for Gibdon itself is deleted ONLY after confirming zero
--            references remain.
-- Untouched: inventory_items.model / item_display_name (the affected item's
--            own name is not modified by this script — see the read-only
--            check near the end for whether the model name itself contains
--            a typo; nothing acts on that automatically), acquisition data,
--            deals, deal_items, cash_flow, listings, statuses — nothing
--            about the item's history or financials changes, only which
--            brands row it points to. The existing "Gibson" brand row is
--            reused as-is — no new brand is created, no brand is renamed.
--
-- ── Safety ───────────────────────────────────────────────────────────────
-- Runs inside an explicit transaction. Every guard aborts the WHOLE
-- transaction (RAISE EXCEPTION) on the first problem found. ROLLBACK is the
-- default outcome of running this file top-to-bottom unmodified: review the
-- RETURNING output and the validation queries, THEN comment out the final
-- ROLLBACK and uncomment COMMIT if everything looks right.
-- ============================================================================

BEGIN;

-- ── 1. Names to merge — edit here if reusing this script for a different pair ──

CREATE TEMP TABLE _brand_merge (
  source_name text NOT NULL,
  target_name text NOT NULL,
  source_id   bigint,
  target_id   bigint
) ON COMMIT DROP;

INSERT INTO _brand_merge (source_name, target_name) VALUES ('Gibdon', 'Gibson');


-- ── 2. Hard guards — any of these aborts the whole transaction ─────────────

-- 2a. exactly one brands row named 'Gibdon', exactly one named 'Gibson'
DO $$
DECLARE
  v_source_count int;
  v_target_count int;
BEGIN
  SELECT COUNT(*) INTO v_source_count FROM brands WHERE name = (SELECT source_name FROM _brand_merge);
  SELECT COUNT(*) INTO v_target_count FROM brands WHERE name = (SELECT target_name FROM _brand_merge);

  IF v_source_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 brands row named ''%'', found %. Resolve manually before re-running.',
      (SELECT source_name FROM _brand_merge), v_source_count;
  END IF;
  IF v_target_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 brands row named ''%'', found %. Resolve manually before re-running.',
      (SELECT target_name FROM _brand_merge), v_target_count;
  END IF;
END $$;

-- 2b. resolve the two IDs now that both counts are confirmed == 1
UPDATE _brand_merge m
SET source_id = (SELECT id FROM brands WHERE name = m.source_name),
    target_id = (SELECT id FROM brands WHERE name = m.target_name);

-- 2c. source and target IDs must differ (guards against the names somehow
--     resolving to the same row, or this script being misconfigured to
--     "merge" a brand into itself)
DO $$
DECLARE
  v_source_id bigint;
  v_target_id bigint;
BEGIN
  SELECT source_id, target_id INTO v_source_id, v_target_id FROM _brand_merge;
  IF v_source_id = v_target_id THEN
    RAISE EXCEPTION 'source_id and target_id are the same brand (id %) — nothing to merge.', v_source_id;
  END IF;
END $$;

-- 2d. expected source item count is exactly 1 — checked against the FULL
--     inventory_items table (every purpose, every acquisition value), NOT
--     just A3's Business + acquisition_value > 0 analytical scope. If a
--     Gibdon item outside that scope exists, this aborts rather than
--     silently merging a larger or smaller set than what was reviewed.
DO $$
DECLARE
  v_actual_count int;
  v_source_id    bigint;
BEGIN
  SELECT source_id INTO v_source_id FROM _brand_merge;
  SELECT COUNT(*) INTO v_actual_count FROM inventory_items WHERE brand_id = v_source_id;

  IF v_actual_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 inventory_items row referencing Gibdon (brand_id %), found %. Re-review before proceeding — the item(s) may be outside analytics_item_lifecycle''s Business/acquisition_value>0 scope.',
      v_source_id, v_actual_count;
  END IF;
END $$;


-- ── 3. Snapshot "before" state ───────────────────────────────────────────────

CREATE TEMP TABLE _before_items ON COMMIT DROP AS
SELECT
  i.id AS item_id, i.brand_id, b.name AS brand_name, i.model, i.item_subtype_id,
  i.status, i.purpose_id, i.year, i.color, i.condition, i.notes
FROM inventory_items i
JOIN brands b ON b.id = i.brand_id
WHERE i.brand_id = (SELECT source_id FROM _brand_merge);

CREATE TEMP TABLE _before_globals ON COMMIT DROP AS
SELECT
  (SELECT COUNT(*) FROM inventory_items WHERE brand_id = (SELECT source_id FROM _brand_merge)) AS source_item_count,
  (SELECT COUNT(*) FROM inventory_items WHERE brand_id = (SELECT target_id FROM _brand_merge)) AS target_item_count,
  (SELECT COUNT(*) FROM brands) AS brands_row_count;

-- Read-only check: does the affected item's own model/display name also
-- contain the "Gibdon" misspelling (or something close to it)? This is
-- REPORT ONLY — nothing below changes inventory_items.model. If this shows
-- rows, decide separately whether you want the model text corrected too,
-- and say so explicitly; this script will not do it automatically.
SELECT
  item_id,
  model,
  (model ILIKE '%gibdon%') AS model_contains_gibdon_literally,
  'Report only — model name is NOT modified by this script. Confirm before requesting a separate fix.' AS note
FROM _before_items;

-- "Before" snapshot of the affected item(s)
SELECT * FROM _before_items ORDER BY item_id;


-- ── 4. Apply the merge ───────────────────────────────────────────────────────
-- Re-point every inventory_items row from Gibdon's id to Gibson's id.
-- Nothing else about the item (acquisition, deals, listings, status,
-- financials) is touched.

WITH updated AS (
  UPDATE inventory_items i
  SET brand_id = (SELECT target_id FROM _brand_merge)
  WHERE i.brand_id = (SELECT source_id FROM _brand_merge)
  RETURNING i.id AS item_id, i.brand_id AS new_brand_id, i.model
)
SELECT
  u.item_id,
  u.model,
  u.new_brand_id,
  b.name AS new_brand_name
FROM updated u
JOIN brands b ON b.id = u.new_brand_id
ORDER BY u.item_id;


-- ── 5. Guard before delete: no unresolved references may remain ────────────

DO $$
DECLARE
  v_remaining int;
  v_source_id bigint;
BEGIN
  SELECT source_id INTO v_source_id FROM _brand_merge;
  SELECT COUNT(*) INTO v_remaining FROM inventory_items WHERE brand_id = v_source_id;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'Refusing to delete brands row % (Gibdon) — % inventory_items row(s) still reference it.',
      v_source_id, v_remaining;
  END IF;
END $$;


-- ── 6. Delete the now-unreferenced Gibdon brand row ─────────────────────────
-- Only reached if step 5's guard passed. Gibson is never renamed, never
-- recreated — it is the existing row, reused as-is.

DELETE FROM brands WHERE id = (SELECT source_id FROM _brand_merge);


-- ── 7. Validation — review before deciding COMMIT vs ROLLBACK ──────────────

-- 7a. Affected items after the merge (should show the same item_id(s) as
--     the "before" snapshot in step 3, now pointing at Gibson).
SELECT
  b.item_id,
  b.brand_name AS brand_name_before,
  i.brand_id   AS brand_id_after,
  br.name      AS brand_name_after,
  (b.model = i.model)                     AS model_unchanged,
  (b.status = i.status)                   AS status_unchanged,
  (b.item_subtype_id IS NOT DISTINCT FROM i.item_subtype_id) AS item_subtype_unchanged,
  (b.purpose_id IS NOT DISTINCT FROM i.purpose_id)           AS purpose_unchanged
FROM _before_items b
JOIN inventory_items i ON i.id = b.item_id
JOIN brands br ON br.id = i.brand_id
ORDER BY b.item_id;

-- 7b. Global counts before vs. after
SELECT
  g.source_item_count                                                                        AS gibdon_item_count_before,
  (SELECT COUNT(*) FROM inventory_items WHERE brand_id = (SELECT source_id FROM _brand_merge)) AS gibdon_item_count_after,
  g.target_item_count                                                                        AS gibson_item_count_before,
  (SELECT COUNT(*) FROM inventory_items WHERE brand_id = (SELECT target_id FROM _brand_merge)) AS gibson_item_count_after,
  g.brands_row_count                                                                          AS brands_row_count_before,
  (SELECT COUNT(*) FROM brands)                                                               AS brands_row_count_after,
  (SELECT COUNT(*) FROM inventory_items WHERE brand_id = (SELECT source_id FROM _brand_merge)) AS remaining_references_to_gibdon_id
FROM _before_globals g;


-- ── 8. Outcome — defaults to ROLLBACK ──────────────────────────────────────
-- Nothing is kept until you comment out ROLLBACK and uncomment COMMIT below.

-- COMMIT;
ROLLBACK;
