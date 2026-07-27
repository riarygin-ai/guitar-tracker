-- ============================================================================
-- 03_brand_performance.sql
--
-- Business question: which brands produce RELIABLE profit, ROI, market
-- velocity, and realization — not merely which brand has one unusually
-- successful item?
--
-- EXPERIMENTAL. Read-only. Every query below reads only from the existing
-- view `analytics_item_lifecycle`. Nothing in this file creates a database
-- object (no views/tables/functions/migrations) and nothing here writes to
-- production data. See analytics/README.md.
--
-- ── METHODOLOGY ──────────────────────────────────────────────────────────
--
-- PRIMARY POPULATION: purpose_name = 'Business' AND acquisition_value > 0.
-- Used by every profit/ROI/acquisition-value-band/brand-ranking query (B,
-- B2, C, C2, D, D2, F, G, H, I). Zero/unknown acquisition-value items are
-- deliberately kept OUT of that population (an unknown acquisition value
-- makes ROI and acquisition-value-band placement meaningless) but are still
-- counted in the coverage queries (A1, A2) and in the open-inventory queries
-- (E1/E2, which are about risk exposure, not profit math, and use the full
-- Business population regardless of acquisition value — matching
-- 01_acquisition_value_band_performance.sql's Query E).
--
-- ACQUISITION VALUE BANDS: copied byte-for-byte from
-- 01_acquisition_value_band_performance.sql's `acquisition_value_band` CTE.
-- Do not edit the boundaries here without editing them there too, or Query
-- C's bands will silently stop agreeing with that file's Query B/C/F/G
-- bands. Boundaries:
--   Zero / unknown, $1-999, $1,000-1,999, $2,000-2,999, $3,000-3,999,
--   $4,000-4,999, $5,000+.
--
-- TERMINOLOGY: acquisition_value may be a cash purchase value OR an
-- assigned incoming trade value — every query that groups by it uses
-- "Acquisition Value Band," never "Purchase Price Band," because trade
-- acquisitions are included (see Query D's acquisition-method breakdown).
-- Exit-side queries (E1/E2) similarly use "exit value," not "sale price,"
-- because trade exits are included alongside cash sales. See
-- analytics/SEMANTIC_CONTRACT.md for the full definitions.
--
-- BRAND NORMALIZATION: brands ARE already normalized via a lookup table —
-- inventory_items.brand_id is a NOT NULL foreign key into public.brands
-- (id, name), and analytics_item_lifecycle.brand_name is br.name joined in
-- through that FK (see 20260724000000_historical_deal_type_labels.sql's
-- `base` CTE: "LEFT JOIN public.brands br ON br.id = i.brand_id" /
-- "br.name AS brand_name"). inventory_items never stores a free-text brand
-- string directly.
--
-- brands.name has a UNIQUE constraint, but it is a plain case-sensitive
-- btree index (no LOWER()/trim() normalization at the database level), so
-- "Gibson", "gibson", and " Gibson" can all exist as three DISTINCT brands
-- rows, each with their own id, each referenced by different
-- inventory_items — the uniqueness constraint only blocks an exact
-- byte-for-byte repeat of an existing name. The item-creation UI
-- (InventoryForm.tsx) does an additional client-side, case-insensitive,
-- trimmed match before offering to create a new brand, which reduces but
-- does not eliminate this: it's UI-side only (not enforced by the
-- database), doesn't apply to historical/pre-existing rows, and can't
-- catch a genuine misspelling like "Gibdon" (a different string even after
-- case/whitespace normalization).
--
-- brand_name can still be NULL or blank in analytical output (an orphaned
-- brand_id if the FK was ever left NOT VALID and not backfilled, or simply
-- a brands.name row that is blank — brands.name has no non-blank CHECK).
-- NULL and blank brand names are grouped under the label 'Unknown brand'
-- for analytical output ONLY — this file never writes to brands or
-- inventory_items, and never merges two DIFFERENT brands rows that the
-- database treats as distinct (e.g. "Gibdon" is never folded into "Gibson"
-- here, even though A3 flags the pair for review). Query A3 audits the
-- brands lookup table itself — via the distinct brand names it sees
-- through analytics_item_lifecycle, since that view remains this file's
-- only read path — for duplicate, misspelled, or case/whitespace-variant
-- rows, for a human to fix at the source; nothing downstream of A3 acts on
-- its findings automatically.
--
-- DOM vs. HOLDING (see 01_acquisition_value_band_performance.sql's TIMING
-- SEMANTICS section for the full explanation — summarized here):
-- - global_days_on_market (DOM) is the PRIMARY market-liquidity/velocity
--   metric — time actually listed for sale. Historical Import/Purchase/
--   Trade items ARE included in DOM metrics whenever they have a valid
--   global_days_on_market and has_lifecycle_date_issue = false — a
--   historical ACQUISITION record does not make a real, currently-ticking
--   listing date untrustworthy.
-- - holding_days is SECONDARY ownership/capital-cycle context — time since
--   acquisition. NEVER described as liquidity or market speed anywhere in
--   this file. Historical Import/Purchase/Trade items are EXCLUDED from
--   "reliable holding" medians specifically because their acquisition_date
--   (not their listing date) may be approximate.
-- - acquisition_to_first_listing_days is the delay before an item was first
--   listed — not market time, not evidence of poor liquidity.
-- - Missing DOM always stays NULL. Never backfilled with holding_days or 0.
--
-- PROFIT / ROI: net_profit and roi are computed by the view ONLY for
-- realized (is_realized = true) rows; every median in this file that
-- reports profit or ROI is filtered to realized rows only. Open items'
-- net_profit/roi are NULL by definition (not zero, not bad — just not yet
-- known) and never enter a realized median.
--
-- OPEN ESTIMATED UPSIDE: estimated_net_upside = estimated_sold_value -
-- acquisition_value - item_expenses_total, for OPEN items only. This is a
-- projection based on estimated_sold_value (a user-entered estimate), NOT a
-- guaranteed profit — it is never labeled "profit" or "gross" anywhere in
-- this file precisely because it hasn't happened yet and may not subtract
-- every eventual expense.
--
-- CONFIDENCE METHODOLOGY: every grouped query in this file that ranks or
-- compares brands includes sample_confidence, realized_confidence,
-- overall_confidence, and confidence_warning. Base tiers:
--   sample_confidence   (by total sample_size):    1-2 insufficient, 3-5
--                        low, 6-9 moderate, 10+ stronger.
--   realized_confidence (by realized_items):        0 "no realized
--                        evidence", 1-2 "insufficient realized evidence",
--                        3-5 "low realized evidence", 6-9 "moderate
--                        realized evidence", 10+ "stronger realized
--                        evidence".
-- overall_confidence is the WEAKER of the two, expressed on the same
-- 4-level scale as sample_confidence (insufficient/low/moderate/stronger) —
-- computed by mapping both to a shared 0-3 ordinal tier and taking the
-- minimum (see any query's `scored` CTE for the exact tiering, repeated
-- verbatim per query the same way acquisition_value_band is).
--
-- Small samples are NEVER hidden — they are shown with a confidence_warning
-- so they can be inspected, but nothing in this file should be read as a
-- "best brands" ranking without checking overall_confidence first. A brand
-- with one spectacular item and nothing else is evidence of one sale, not
-- of brand performance.
--
-- Every query below is fully self-contained and independently runnable —
-- copy-paste any single query out and it should execute on its own.
--
-- ── QUERY CLASSIFICATION INDEX (evidence vs. recommendation vs. developer-only;
-- see analytics/SEMANTIC_CONTRACT.md for the full definitions) ─────────────
-- Every query below is SHARED AGGREGATE EVIDENCE — pooled across every user
-- accessible to the querying role, returning only counts/medians/labels,
-- with ONE exception:
--   Query H — DEVELOPER-ONLY item-level verification drilldown (returns
--     item_id, user_id, item_display_name for every eligible item across
--     every user). Not part of a future shared aggregate snapshot or
--     user-facing recommendation output — see H's own header. H2 (its
--     integrity rollup) is a one-row aggregate and stays shared evidence.
-- No query in this file is a current-user recommendation candidate: nothing
-- here filters to a single target user's own items. Query G groups results
-- BY user_id for robustness-checking, but every row is still an aggregate
-- over multiple items, never a single item's own data.
-- ============================================================================


-- ============================================================================
-- QUERY A1 — Coverage and reconciliation
-- CLASSIFICATION: shared aggregate evidence.
-- Run this first. Establishes whether the primary population and brand
-- coverage are large enough to interpret anything below, and reconciles
-- the population splits used throughout this file.
--
-- Reconciliation (verify by eye against this row):
--   realized_business_items + open_business_items = business_items
--   business_positive_acquisition_items + business_zero_or_unknown_acquisition_items = business_items
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
)
SELECT
  (SELECT COUNT(*) FROM acquisition_value_band)                                                                       AS total_lifecycle_rows,
  (SELECT COUNT(*) FROM business)                                                                          AS business_items,
  (SELECT COUNT(*) FROM business WHERE acquisition_value > 0)                                              AS business_positive_acquisition_items,
  (SELECT COUNT(*) FROM business WHERE acquisition_value IS NULL OR acquisition_value <= 0)                AS business_zero_or_unknown_acquisition_items,
  (SELECT COUNT(*) FROM business WHERE is_realized)                                                        AS realized_business_items,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized)                                                    AS open_business_items,
  (SELECT COUNT(DISTINCT brand_label) FROM business)                                                       AS distinct_brand_count,
  (SELECT COUNT(*) FROM business WHERE brand_label = 'Unknown brand')                                      AS unknown_brand_item_count,
  (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NOT NULL)                  AS realized_dom_usable_count,
  (SELECT COUNT(*) FROM business WHERE is_realized AND global_days_on_market IS NULL)                      AS realized_dom_missing_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NOT NULL) AS open_listed_dom_usable_count,
  (SELECT COUNT(*) FROM business WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL)     AS open_listed_dom_missing_count,
  (SELECT COUNT(*) FROM business WHERE is_historical_import)                                               AS historical_business_items,
  (SELECT COUNT(*) FROM business WHERE NOT is_historical_import)                                           AS non_historical_business_items;


-- ============================================================================
-- QUERY A2 — Brand coverage distribution
-- CLASSIFICATION: shared aggregate evidence.
-- How fragmented is the brand dataset? Read this before trusting any brand
-- ranking below — if most brands have 1-2 items, "top brand" results are
-- mostly noise. Scoped to the PRIMARY population (acquisition_value > 0),
-- since that's the population everything else in this file ranks.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
brand_counts AS (
  SELECT
    brand_label,
    COUNT(*)                            AS item_count,
    COUNT(*) FILTER (WHERE is_realized) AS realized_count
  FROM eligible
  GROUP BY brand_label
),
bucketed AS (
  SELECT
    *,
    CASE
      WHEN item_count = 1 THEN '1 item'
      WHEN item_count = 2 THEN '2 items'
      WHEN item_count BETWEEN 3 AND 5 THEN '3-5 items'
      WHEN item_count BETWEEN 6 AND 9 THEN '6-9 items'
      ELSE '10+ items'
    END AS bucket,
    CASE
      WHEN item_count = 1 THEN 1
      WHEN item_count = 2 THEN 2
      WHEN item_count BETWEEN 3 AND 5 THEN 3
      WHEN item_count BETWEEN 6 AND 9 THEN 4
      ELSE 5
    END AS bucket_order
  FROM brand_counts
),
bucket_summary AS (
  SELECT bucket, bucket_order, COUNT(*) AS brand_count, SUM(item_count) AS items_in_bucket
  FROM bucketed
  GROUP BY bucket, bucket_order
),
totals AS (
  SELECT
    (SELECT COUNT(*) FROM eligible)                                    AS total_items,
    (SELECT COUNT(*) FROM brand_counts WHERE item_count >= 3)          AS brands_with_3plus_items,
    (SELECT COUNT(*) FROM brand_counts WHERE realized_count >= 3)      AS brands_with_3plus_realized,
    (SELECT COUNT(*) FROM brand_counts WHERE realized_count >= 5)      AS brands_with_5plus_realized
),
top5 AS (
  SELECT COALESCE(SUM(item_count), 0) AS top5_item_count
  FROM (SELECT item_count FROM brand_counts ORDER BY item_count DESC, brand_label LIMIT 5) x
),
small AS (
  SELECT COALESCE(SUM(item_count), 0) AS small_brand_item_count
  FROM brand_counts
  WHERE item_count < 3
)
SELECT
  bucket_summary.bucket,
  bucket_summary.brand_count,
  bucket_summary.items_in_bucket,
  totals.brands_with_3plus_items,
  totals.brands_with_3plus_realized,
  totals.brands_with_5plus_realized,
  ROUND(top5.top5_item_count::numeric / NULLIF(totals.total_items, 0) * 100, 2)  AS top5_brand_share_percent,
  ROUND(small.small_brand_item_count::numeric / NULLIF(totals.total_items, 0) * 100, 2) AS brands_under_3_items_share_percent
FROM bucket_summary
CROSS JOIN totals
CROSS JOIN top5
CROSS JOIN small
ORDER BY bucket_summary.bucket_order;


-- ============================================================================
-- QUERY A3 — brands lookup-table data-quality audit
-- CLASSIFICATION: shared aggregate evidence (audits the shared brands
-- lookup table itself, grouped by brand name — no item_id/user_id/item
-- display name in its output).
-- Brands ARE already normalized behind a foreign key (inventory_items.
-- brand_id -> public.brands.id) — this query is NOT looking for free-text
-- brand strings scattered across inventory_items; it's auditing the
-- public.brands ROWS themselves (surfaced here via the distinct brand_name
-- values analytics_item_lifecycle exposes through that FK, since this file
-- only reads through that view — see BRAND NORMALIZATION in the file
-- header). brands.name has a case-sensitive, non-blank-agnostic UNIQUE
-- constraint, which blocks an exact repeat but not "Gibson" vs "gibson" vs
-- " Gibson" as three distinct rows, and does nothing at all for a genuine
-- misspelling like "Gibdon". Conservative, dependency-free heuristics only
-- (no fuzzy-match extension required/assumed) — designed to avoid a large
-- false-positive list:
--   1. null_or_blank: brand_name is missing, or the underlying brands.name
--      row is blank (brands.name has no non-blank CHECK).
--   2. capitalization_or_whitespace: two DIFFERENT brands rows whose names
--      normalize (lowercased, whitespace-collapsed and trimmed) to the same
--      string — almost certainly the same brand entered as two separate
--      rows instead of reused.
--   3. possible_typo: two brands rows of the SAME name length differing at
--      EXACTLY one character position, where one side has very few items
--      (<=2) and the other is clearly established (>=5) — matches the
--      "Gibdon" vs "Gibson" pattern without flagging two legitimately
--      similar but unrelated brand names of comparable size.
-- This does NOT modify brands or inventory_items — it only reports
-- candidates for manual review (e.g. re-pointing inventory_items.brand_id
-- to the correct brands.id and deleting the duplicate row). Nothing
-- elsewhere in this file merges these automatically.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT * FROM acquisition_value_band WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
brand_stats AS (
  SELECT brand_name, COUNT(*) AS item_count
  FROM eligible
  WHERE brand_name IS NOT NULL AND trim(brand_name) <> ''
  GROUP BY brand_name
),
null_blank AS (
  SELECT
    COALESCE(brand_name, '(null)')     AS brand_name,
    COUNT(*)                          AS item_count,
    NULL::text                        AS possible_matching_brand,
    NULL::bigint                      AS matching_brand_item_count,
    'null_or_blank'                    AS issue_type,
    'Brand name is missing or the underlying brands row is blank — grouped under ''Unknown brand'' in analytical output; not merged with any real brands row.' AS review_note
  FROM eligible
  WHERE brand_name IS NULL OR trim(brand_name) = ''
  GROUP BY brand_name
),
case_whitespace_dupes AS (
  SELECT
    a.brand_name                      AS brand_name,
    a.item_count,
    b.brand_name                      AS possible_matching_brand,
    b.item_count                      AS matching_brand_item_count,
    'capitalization_or_whitespace'     AS issue_type,
    'Normalizes to the same name as "' || b.brand_name || '" (' || b.item_count || ' items) — likely two separate brands rows for what should be one brand.' AS review_note
  FROM brand_stats a
  JOIN brand_stats b
    ON a.brand_name <> b.brand_name
   AND a.brand_name > b.brand_name
   AND trim(LOWER(regexp_replace(a.brand_name, '\s+', ' ', 'g'))) = trim(LOWER(regexp_replace(b.brand_name, '\s+', ' ', 'g')))
),
near_duplicate_typo AS (
  SELECT
    a.brand_name                      AS brand_name,
    a.item_count,
    b.brand_name                      AS possible_matching_brand,
    b.item_count                      AS matching_brand_item_count,
    'possible_typo'                    AS issue_type,
    'Same length, differs by exactly one character from "' || b.brand_name || '" (' || b.item_count || ' items) — review for a possible misspelled brands row.' AS review_note
  FROM brand_stats a
  JOIN brand_stats b
    ON a.brand_name <> b.brand_name
   AND length(a.brand_name) = length(b.brand_name)
   AND a.item_count <= 2
   AND b.item_count >= 5
   AND (
     SELECT COUNT(*)
     FROM generate_series(1, length(a.brand_name)) i
     WHERE substring(a.brand_name FROM i FOR 1) <> substring(b.brand_name FROM i FOR 1)
   ) = 1
)
SELECT brand_name, item_count, possible_matching_brand, matching_brand_item_count, issue_type, review_note FROM null_blank
UNION ALL
SELECT brand_name, item_count, possible_matching_brand, matching_brand_item_count, issue_type, review_note FROM case_whitespace_dupes
UNION ALL
SELECT brand_name, item_count, possible_matching_brand, matching_brand_item_count, issue_type, review_note FROM near_duplicate_typo
ORDER BY issue_type, brand_name;


-- ============================================================================
-- QUERY B — Overall brand performance
-- CLASSIFICATION: shared aggregate evidence.
-- DESCRIPTIVE EVIDENCE, NOT A FINAL "BEST BRANDS" RANKING. Read
-- overall_confidence/confidence_warning before acting on any row — a brand
-- with high median profit and "insufficient" confidence is one good item,
-- not a proven pattern. Profit/ROI use realized rows only; median is the
-- headline (no average profit/ROI is shown, by design — see methodology).
-- Ordered by evidence quality first, then realized count, then median
-- profit — NOT by profit alone, so a thin, lucky brand can't outrank a
-- well-evidenced one just by having a bigger single number. "Evidence
-- quality" here is LEAST(sample_tier, realized_tier) — the same 0-3
-- INTEGER tiers sample_confidence/realized_confidence/overall_confidence
-- are derived from — sorted numerically, NOT the overall_confidence TEXT
-- label sorted alphabetically (which would wrongly put "insufficient"
-- ahead of "stronger").
--
-- holding_sample_size/median_holding_days additionally exclude Historical
-- Import/Purchase/Trade items (acquisition dates may be approximate — see
-- methodology); dom_sample_size/median_days_on_market do NOT, since DOM is
-- measured from the listing date, not the acquisition date. See Query F to
-- see how much any of this file's other metrics change once historical
-- items are removed entirely.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
agg AS (
  SELECT
    brand_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    SUM(acquisition_value)                                                   AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized)                        AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                               AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count
  FROM eligible
  GROUP BY brand_label
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  brand_label AS brand_name,
  sample_size,
  realized_items,
  open_items,
  realization_rate_percent,
  sale_count,
  trade_count,
  total_acquisition_capital,
  realized_acquisition_capital,
  total_realized_net_profit,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  historical_item_count,
  non_historical_item_count,
  CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
  CASE
    WHEN realized_items = 0 THEN 'no realized evidence'
    WHEN realized_items <= 2 THEN 'insufficient realized evidence'
    WHEN realized_items <= 5 THEN 'low realized evidence'
    WHEN realized_items <= 9 THEN 'moderate realized evidence'
    ELSE 'stronger realized evidence'
  END AS realized_confidence,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
  CASE
    WHEN realized_items = 0 THEN 'No realized items yet'
    WHEN realized_items = 1 THEN 'Only 1 realized item'
    WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
    WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
    WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
    WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
    ELSE 'Stronger evidence'
  END AS confidence_warning
FROM scored
ORDER BY LEAST(sample_tier, realized_tier) DESC, realized_items DESC, median_net_profit DESC NULLS LAST;


-- ============================================================================
-- QUERY B2 — Decision-ready brand summary
-- CLASSIFICATION: shared aggregate evidence.
-- Same metrics as Query B (including the same historical exclusion from
-- holding_sample_size/median_holding_days only — see Query B's header),
-- filtered to brands with sample_size >= 3 AND realized_items >= 3. Adds
-- descriptive (NOT composite-scored) fields: typical_profit_per_item /
-- typical_roi_percent are just aliases for the medians already shown, and
-- market_velocity_label translates median_days_on_market into a
-- plain-language speed bucket. No weighting between profit, ROI, DOM, and
-- realization rate is applied anywhere here.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
agg AS (
  SELECT
    brand_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    SUM(acquisition_value)                                                   AS total_acquisition_capital,
    SUM(acquisition_value) FILTER (WHERE is_realized)                        AS realized_acquisition_capital,
    SUM(net_profit) FILTER (WHERE is_realized)                               AS total_realized_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count,
    COUNT(*) FILTER (WHERE NOT is_historical_import)                        AS non_historical_item_count
  FROM eligible
  GROUP BY brand_label
  HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  brand_label AS brand_name,
  sample_size,
  realized_items,
  open_items,
  realization_rate_percent,
  sale_count,
  trade_count,
  total_acquisition_capital,
  realized_acquisition_capital,
  total_realized_net_profit,
  median_net_profit                                                          AS typical_profit_per_item,
  median_roi                                                                 AS typical_roi_percent,
  dom_sample_size,
  median_days_on_market,
  CASE
    WHEN median_days_on_market IS NULL THEN 'insufficient DOM data'
    WHEN median_days_on_market <= 14 THEN 'very fast'
    WHEN median_days_on_market <= 30 THEN 'fast'
    WHEN median_days_on_market <= 60 THEN 'moderate'
    WHEN median_days_on_market <= 120 THEN 'slow'
    ELSE 'very slow'
  END                                                                         AS market_velocity_label,
  holding_sample_size,
  median_holding_days,
  historical_item_count,
  non_historical_item_count,
  CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
  CASE
    WHEN realized_items = 0 THEN 'no realized evidence'
    WHEN realized_items <= 2 THEN 'insufficient realized evidence'
    WHEN realized_items <= 5 THEN 'low realized evidence'
    WHEN realized_items <= 9 THEN 'moderate realized evidence'
    ELSE 'stronger realized evidence'
  END AS realized_confidence,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
  CASE
    WHEN realized_items = 0 THEN 'No realized items yet'
    WHEN realized_items = 1 THEN 'Only 1 realized item'
    WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
    WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
    WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
    WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
    ELSE 'Stronger evidence'
  END AS confidence_warning
FROM scored
ORDER BY LEAST(sample_tier, realized_tier) DESC, realized_items DESC, median_net_profit DESC NULLS LAST;


-- ============================================================================
-- QUERY C — Brand x Acquisition Value Band
-- CLASSIFICATION: shared aggregate evidence.
-- Overall brand results (Query B) can simply reflect the acquisition-value
-- ranges a brand happens to appear in. This breaks every brand's results
-- down by acquisition value band too, so a brand's performance can't be
-- attributed to "the brand" without controlling for acquisition value — do
-- not claim a brand effect without checking this query. All combinations
-- are shown (including thin ones); see confidence_warning before treating
-- any cell as decided evidence. Not called "Brand x Purchase Price Band" —
-- trade-acquired items are included. Acquisition value bands are copied
-- byte-for-byte from 01_acquisition_value_band_performance.sql. Same
-- historical exclusion from holding_sample_size/median_holding_days as
-- Query B (DOM is unaffected).
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
agg AS (
  SELECT
    brand_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY brand_label, acquisition_value_band_order, acquisition_value_band_label
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  brand_label AS brand_name,
  acquisition_value_band_order,
  acquisition_value_band_label,
  sample_size,
  realized_items,
  open_items,
  realization_rate_percent,
  sale_count,
  trade_count,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
  CASE
    WHEN realized_items = 0 THEN 'no realized evidence'
    WHEN realized_items <= 2 THEN 'insufficient realized evidence'
    WHEN realized_items <= 5 THEN 'low realized evidence'
    WHEN realized_items <= 9 THEN 'moderate realized evidence'
    ELSE 'stronger realized evidence'
  END AS realized_confidence,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
  CASE
    WHEN realized_items = 0 THEN 'No realized items yet'
    WHEN realized_items = 1 THEN 'Only 1 realized item'
    WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
    WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
    WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
    WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
    ELSE 'Stronger evidence'
  END AS confidence_warning
FROM scored
ORDER BY brand_label, acquisition_value_band_order;


-- ============================================================================
-- QUERY C2 — Brand x Acquisition Value Band (decision-ready only)
-- CLASSIFICATION: shared aggregate evidence.
-- Same as Query C (including the same historical exclusion from holding
-- metrics), filtered to sample_size >= 3 AND realized_items >= 3.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
agg AS (
  SELECT
    brand_label,
    acquisition_value_band_order,
    acquisition_value_band_label,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM eligible
  GROUP BY brand_label, acquisition_value_band_order, acquisition_value_band_label
  HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  brand_label AS brand_name,
  acquisition_value_band_order,
  acquisition_value_band_label,
  sample_size,
  realized_items,
  open_items,
  realization_rate_percent,
  sale_count,
  trade_count,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
  CASE
    WHEN realized_items = 0 THEN 'no realized evidence'
    WHEN realized_items <= 2 THEN 'insufficient realized evidence'
    WHEN realized_items <= 5 THEN 'low realized evidence'
    WHEN realized_items <= 9 THEN 'moderate realized evidence'
    ELSE 'stronger realized evidence'
  END AS realized_confidence,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
  CASE
    WHEN realized_items = 0 THEN 'No realized items yet'
    WHEN realized_items = 1 THEN 'Only 1 realized item'
    WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
    WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
    WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
    WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
    ELSE 'Stronger evidence'
  END AS confidence_warning
FROM scored
ORDER BY brand_label, acquisition_value_band_order;


-- ============================================================================
-- QUERY D — Brand x acquisition method
-- CLASSIFICATION: shared aggregate evidence.
-- Distinguishes brands that perform well when purchased vs. brands that are
-- mainly trade-chain inventory vs. brands whose apparent performance rests
-- on a single acquisition method. acquisition_method values are exactly
-- 'purchase' | 'trade' | 'unknown' (never 'cash' — see
-- analytics_item_lifecycle's derivation). ALWAYS check confidence_warning
-- before comparing purchase vs. trade for the same brand — a brand with
-- 15 purchases and 1 trade should never be read as "this brand does badly
-- as a trade," only as "insufficient trade evidence." Same historical
-- exclusion from holding_sample_size/median_holding_days as Query B (DOM is
-- unaffected).
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
agg AS (
  SELECT
    brand_label,
    acquisition_method,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count
  FROM eligible
  GROUP BY brand_label, acquisition_method
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  brand_label AS brand_name,
  acquisition_method,
  sample_size,
  realized_items,
  open_items,
  sale_count,
  trade_count,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  historical_item_count,
  CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
  CASE
    WHEN realized_items = 0 THEN 'no realized evidence'
    WHEN realized_items <= 2 THEN 'insufficient realized evidence'
    WHEN realized_items <= 5 THEN 'low realized evidence'
    WHEN realized_items <= 9 THEN 'moderate realized evidence'
    ELSE 'stronger realized evidence'
  END AS realized_confidence,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
  CASE
    WHEN realized_items = 0 THEN 'No realized items yet'
    WHEN realized_items = 1 THEN 'Only 1 realized item'
    WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
    WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
    WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
    WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
    ELSE 'Stronger evidence'
  END AS confidence_warning
FROM scored
ORDER BY brand_label, acquisition_method;


-- ============================================================================
-- QUERY D2 — Brand x acquisition method (decision-ready only)
-- CLASSIFICATION: shared aggregate evidence.
-- Same as Query D (including the same historical exclusion from holding
-- metrics), filtered to sample_size >= 3 AND realized_items >= 3.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
agg AS (
  SELECT
    brand_label,
    acquisition_method,
    COUNT(*)                                                                 AS sample_size,
    COUNT(*) FILTER (WHERE is_realized)                                      AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized)                                  AS open_items,
    COUNT(*) FILTER (WHERE exit_type = 'sale')                               AS sale_count,
    COUNT(*) FILTER (WHERE exit_type = 'trade')                              AS trade_count,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days,
    COUNT(*) FILTER (WHERE is_historical_import)                            AS historical_item_count
  FROM eligible
  GROUP BY brand_label, acquisition_method
  HAVING COUNT(*) >= 3 AND COUNT(*) FILTER (WHERE is_realized) >= 3
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  brand_label AS brand_name,
  acquisition_method,
  sample_size,
  realized_items,
  open_items,
  sale_count,
  trade_count,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  historical_item_count,
  CASE sample_tier WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS sample_confidence,
  CASE
    WHEN realized_items = 0 THEN 'no realized evidence'
    WHEN realized_items <= 2 THEN 'insufficient realized evidence'
    WHEN realized_items <= 5 THEN 'low realized evidence'
    WHEN realized_items <= 9 THEN 'moderate realized evidence'
    ELSE 'stronger realized evidence'
  END AS realized_confidence,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence,
  CASE
    WHEN realized_items = 0 THEN 'No realized items yet'
    WHEN realized_items = 1 THEN 'Only 1 realized item'
    WHEN LEAST(sample_tier, realized_tier) = 0 AND realized_tier < sample_tier THEN 'Mostly open inventory'
    WHEN LEAST(sample_tier, realized_tier) = 0 THEN 'Small total sample'
    WHEN LEAST(sample_tier, realized_tier) = 1 THEN 'Low evidence'
    WHEN LEAST(sample_tier, realized_tier) = 2 THEN 'Moderate evidence'
    ELSE 'Stronger evidence'
  END AS confidence_warning
FROM scored
ORDER BY brand_label, acquisition_method;


-- ============================================================================
-- QUERY E1 — Open listed inventory by brand
-- CLASSIFICATION: shared aggregate evidence.
-- Business items, ALL acquisition values (this is risk exposure, not
-- profit/ROI math — matches 01_acquisition_value_band_performance.sql's Query E1).
-- estimated_net_upside = estimated_sold_value - acquisition_value -
-- item_expenses_total — a PROJECTION, not a guaranteed profit.
--
-- DOM metrics (dom_sample_size / median_current_days_on_market /
-- max_current_days_on_market / items_dom_60_plus / items_dom_120_plus)
-- include historical items whenever global_days_on_market is available and
-- has_lifecycle_date_issue = false. Holding metrics additionally exclude
-- historical items (acquisition dates may be approximate) —
-- holding_excluded_historical_count makes that exclusion's size visible.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
listed_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status = 'listed'
),
listed_full AS (
  SELECT
    brand_label,
    COUNT(*)                                                    AS listed_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS listed_acquisition_capital,
    SUM(estimated_sold_value)                                   AS listed_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)        AS estimated_upside_missing_count
  FROM listed_items
  GROUP BY brand_label
),
listed_dom_eligible AS (
  SELECT * FROM listed_items WHERE NOT has_lifecycle_date_issue
),
listed_dom_summary AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE global_days_on_market IS NOT NULL) AS dom_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market)
      FILTER (WHERE global_days_on_market IS NOT NULL)        AS median_current_days_on_market,
    MAX(global_days_on_market)                                 AS max_current_days_on_market,
    COUNT(*) FILTER (WHERE global_days_on_market >= 60)        AS items_dom_60_plus,
    COUNT(*) FILTER (WHERE global_days_on_market >= 120)       AS items_dom_120_plus
  FROM listed_dom_eligible
  GROUP BY brand_label
),
listed_holding_eligible AS (
  SELECT * FROM listed_items WHERE NOT has_lifecycle_date_issue AND NOT is_historical_import
),
listed_holding_summary AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL) AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)        AS median_holding_days
  FROM listed_holding_eligible
  GROUP BY brand_label
),
listed_holding_excluded AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL) AS holding_excluded_historical_count
  FROM listed_dom_eligible
  GROUP BY brand_label
)
SELECT
  listed_full.brand_label AS brand_name,
  listed_full.listed_item_count,
  listed_full.listed_acquisition_capital,
  listed_full.listed_estimated_value,
  CASE
    WHEN listed_full.listed_estimated_value IS NOT NULL AND listed_full.acquisition_for_upside IS NOT NULL
    THEN listed_full.listed_estimated_value
         - listed_full.acquisition_for_upside
         - COALESCE(listed_full.item_expenses_for_upside, 0)
    ELSE NULL
  END                                                                       AS listed_estimated_net_upside,
  COALESCE(listed_dom_summary.dom_sample_size, 0)                          AS dom_sample_size,
  ROUND(listed_dom_summary.median_current_days_on_market::numeric, 2)     AS median_current_days_on_market,
  listed_dom_summary.max_current_days_on_market,
  COALESCE(listed_dom_summary.items_dom_60_plus, 0)                        AS items_dom_60_plus,
  COALESCE(listed_dom_summary.items_dom_120_plus, 0)                       AS items_dom_120_plus,
  COALESCE(listed_holding_summary.holding_sample_size, 0)                  AS holding_sample_size,
  ROUND(listed_holding_summary.median_holding_days::numeric, 2)          AS median_holding_days,
  COALESCE(listed_holding_excluded.holding_excluded_historical_count, 0)   AS holding_excluded_historical_count,
  listed_full.estimated_upside_missing_count
FROM listed_full
LEFT JOIN listed_dom_summary      ON listed_dom_summary.brand_label      = listed_full.brand_label
LEFT JOIN listed_holding_summary  ON listed_holding_summary.brand_label  = listed_full.brand_label
LEFT JOIN listed_holding_excluded ON listed_holding_excluded.brand_label = listed_full.brand_label
ORDER BY listed_full.listed_acquisition_capital DESC NULLS LAST;


-- ============================================================================
-- QUERY E2 — Open owned/not-listed inventory by brand
-- CLASSIFICATION: shared aggregate evidence.
-- Companion to E1. No DOM here at all — these items have never been listed,
-- so there is no market exposure to report (see TIMING SEMANTICS in
-- 01_acquisition_value_band_performance.sql). median_ownership_age_days /
-- max_ownership_age_days are holding_days — ownership duration, not market
-- time. Dollar totals use the full unlisted population; only the
-- reliable-age metrics exclude historical items.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
unlisted_items AS (
  SELECT * FROM business WHERE NOT is_realized AND current_status <> 'listed'
),
unlisted_full AS (
  SELECT
    brand_label,
    COUNT(*)                                                    AS unlisted_item_count,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS unlisted_acquisition_capital,
    SUM(estimated_sold_value)                                   AS unlisted_estimated_value,
    SUM(acquisition_value) FILTER (WHERE acquisition_value > 0) AS acquisition_for_upside,
    SUM(item_expenses_total)                                    AS item_expenses_for_upside,
    COUNT(*) FILTER (WHERE estimated_sold_value IS NULL)        AS estimated_upside_missing_count
  FROM unlisted_items
  GROUP BY brand_label
),
unlisted_reliable AS (
  SELECT * FROM unlisted_items WHERE NOT has_lifecycle_date_issue AND NOT is_historical_import
),
unlisted_reliable_summary AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE holding_days IS NOT NULL)         AS holding_sample_size,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days)
      FILTER (WHERE holding_days IS NOT NULL)                AS median_ownership_age_days,
    MAX(holding_days)                                         AS max_ownership_age_days
  FROM unlisted_reliable
  GROUP BY brand_label
),
unlisted_excluded AS (
  SELECT
    brand_label,
    COUNT(*) FILTER (WHERE is_historical_import AND holding_days IS NOT NULL) AS historical_excluded_from_age_count
  FROM unlisted_items
  WHERE NOT has_lifecycle_date_issue
  GROUP BY brand_label
)
SELECT
  unlisted_full.brand_label AS brand_name,
  unlisted_full.unlisted_item_count,
  unlisted_full.unlisted_acquisition_capital,
  unlisted_full.unlisted_estimated_value,
  CASE
    WHEN unlisted_full.unlisted_estimated_value IS NOT NULL AND unlisted_full.acquisition_for_upside IS NOT NULL
    THEN unlisted_full.unlisted_estimated_value
         - unlisted_full.acquisition_for_upside
         - COALESCE(unlisted_full.item_expenses_for_upside, 0)
    ELSE NULL
  END                                                                     AS unlisted_estimated_net_upside,
  COALESCE(unlisted_reliable_summary.holding_sample_size, 0)             AS holding_sample_size,
  ROUND(unlisted_reliable_summary.median_ownership_age_days::numeric, 2) AS median_ownership_age_days,
  unlisted_reliable_summary.max_ownership_age_days,
  COALESCE(unlisted_excluded.historical_excluded_from_age_count, 0)      AS historical_excluded_from_age_count,
  unlisted_full.estimated_upside_missing_count
FROM unlisted_full
LEFT JOIN unlisted_reliable_summary ON unlisted_reliable_summary.brand_label = unlisted_full.brand_label
LEFT JOIN unlisted_excluded         ON unlisted_excluded.brand_label         = unlisted_full.brand_label
ORDER BY unlisted_full.unlisted_acquisition_capital DESC NULLS LAST;


-- ============================================================================
-- QUERY F — Cohort comparison: imported historical vs. app-tracked, by brand
-- CLASSIFICATION: shared aggregate evidence.
-- "Imported historical" = is_historical_import = true, which covers all
-- three deal types (Historical Import, Historical Purchase, Historical
-- Trade). Three population rows per brand: all eligible items, the imported
-- historical cohort alone, and the app-tracked cohort alone. Only brands
-- where AT LEAST ONE of the three populations clears sample_size >= 3 AND
-- realized_items >= 3 are shown — everything below that bar is noise
-- either way. The populations are never combined into a single figure; each
-- row is clearly labeled.
--
-- This is a COHORT COMPARISON, not a data-reliability test. Historical
-- imports were transferred from Excel; their listing dates and
-- days-on-market were tracked accurately, and they remain fully included in
-- sample_size, realized_items, median_net_profit, median_roi,
-- dom_sample_size, and median_days_on_market for every row below, including
-- "All eligible Business items" and "Imported historical Business items". A
-- difference between the imported-historical cohort and the app-tracked
-- cohort may reflect changes in deal quality, inventory mix, or business
-- behavior over time — it is NOT proof that the historical cohort's profit,
-- ROI, or DOM figures are inaccurate.
--
-- holding_sample_size/median_holding_days are the one exception: they are
-- excluded from EVERY row (including "All eligible") for any item whose
-- acquisition_date is approximate — the only field this file treats as
-- unreliable for historical imports (see METHODOLOGY). This is why the
-- "Imported historical Business items" row always shows
-- holding_sample_size = 0 / median_holding_days = NULL by construction, not
-- a coverage gap: presenting a holding-time figure for a cohort whose
-- acquisition dates are the one approximate field would misrepresent it as
-- reliable. "App-tracked Business items" is the row with a full, reliable
-- set of metrics including holding time; "All eligible Business items" has
-- reliable holding metrics too (once the acquisition-date-approximate rows
-- are excluded from that pair of columns only), because it draws from the
-- same reliable subset — see Query B's header for the same rule applied to
-- brand performance generally.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
combined AS (
  SELECT 'All eligible Business items' AS population_label,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  UNION ALL
  SELECT 'Imported historical Business items' AS population_label,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  WHERE is_historical_import
  UNION ALL
  SELECT 'App-tracked Business items' AS population_label,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
  WHERE NOT is_historical_import
),
agg AS (
  SELECT
    population_label,
    brand_label,
    COUNT(*)                            AS sample_size,
    COUNT(*) FILTER (WHERE is_realized) AS realized_items,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    -- Excluded from EVERY population row, including "All eligible" — see
    -- header. Always 0/NULL for "Imported historical Business items" by
    -- construction.
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM combined
  GROUP BY population_label, brand_label
),
qualifying_brands AS (
  SELECT DISTINCT brand_label
  FROM agg
  WHERE sample_size >= 3 AND realized_items >= 3
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
  WHERE brand_label IN (SELECT brand_label FROM qualifying_brands)
)
SELECT
  population_label,
  brand_label AS brand_name,
  sample_size,
  realized_items,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence
FROM scored
ORDER BY brand_label, population_label;


-- ============================================================================
-- QUERY G — Results by user
-- CLASSIFICATION: shared aggregate evidence — grouped BY user_id as a
-- dimension for robustness-checking, but every row is still an aggregate
-- (median/count) over multiple items, never a single item's own data.
-- Reveals whether a brand's apparent overall performance is really just one
-- user's behavior. Includes a combined "All accessible users" row per
-- brand for comparison. Do not read a difference between two users' rows
-- for the same brand as a brand effect if their sample sizes or
-- acquisition-method mix differ — check Query D first. Same historical
-- exclusion from holding_sample_size/median_holding_days as Query B (DOM is
-- unaffected).
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
per_user AS (
  SELECT
    user_id::text AS user_group,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
),
combined_all AS (
  SELECT
    'All accessible users' AS user_group,
    brand_label, is_realized, net_profit, roi, holding_days, global_days_on_market, is_historical_import
  FROM eligible
),
unioned AS (
  SELECT * FROM per_user
  UNION ALL
  SELECT * FROM combined_all
),
agg AS (
  SELECT
    user_group,
    brand_label,
    COUNT(*)                            AS sample_size,
    COUNT(*) FILTER (WHERE is_realized) AS realized_items,
    COUNT(*) FILTER (WHERE NOT is_realized) AS open_items,
    ROUND(COUNT(*) FILTER (WHERE is_realized)::numeric / NULLIF(COUNT(*), 0) * 100, 2) AS realization_rate_percent,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_profit) FILTER (WHERE is_realized)::numeric, 2) AS median_net_profit,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY roi) FILTER (WHERE is_realized AND roi IS NOT NULL)::numeric, 2) AS median_roi,
    COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL) AS dom_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY global_days_on_market) FILTER (WHERE is_realized AND global_days_on_market IS NOT NULL)::numeric, 2) AS median_days_on_market,
    COUNT(*) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)         AS holding_sample_size,
    ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY holding_days) FILTER (WHERE is_realized AND NOT is_historical_import AND holding_days IS NOT NULL)::numeric, 2) AS median_holding_days
  FROM unioned
  GROUP BY user_group, brand_label
),
scored AS (
  SELECT
    *,
    CASE
      WHEN sample_size <= 2 THEN 0
      WHEN sample_size <= 5 THEN 1
      WHEN sample_size <= 9 THEN 2
      ELSE 3
    END AS sample_tier,
    CASE
      WHEN realized_items <= 2 THEN 0
      WHEN realized_items <= 5 THEN 1
      WHEN realized_items <= 9 THEN 2
      ELSE 3
    END AS realized_tier
  FROM agg
)
SELECT
  user_group,
  brand_label AS brand_name,
  sample_size,
  realized_items,
  open_items,
  realization_rate_percent,
  median_net_profit,
  median_roi,
  dom_sample_size,
  median_days_on_market,
  holding_sample_size,
  median_holding_days,
  CASE LEAST(sample_tier, realized_tier) WHEN 0 THEN 'insufficient' WHEN 1 THEN 'low' WHEN 2 THEN 'moderate' ELSE 'stronger' END AS overall_confidence
FROM scored
ORDER BY brand_label, user_group;


-- ============================================================================
-- QUERY H — Developer-only item-level verification drilldown (brand).
-- CLASSIFICATION: developer-only verification. Not part of a future shared
-- aggregate snapshot or user-facing recommendation output. Returns
-- item_id, user_id, and item_display_name across every user accessible to
-- the querying role, with no target-user filtering — see
-- analytics/SEMANTIC_CONTRACT.md's developer verification population
-- definition. Never send this query's rows to an AI recommendation
-- process or a current user's UI as-is.
-- Source rows for the same primary population used by Query B/C/D/F/G, for
-- manually verifying which specific items produced any aggregate above.
-- Integrity flags match 01_acquisition_value_band_performance.sql's Query G5
-- conventions exactly (see that file for the full rationale): all three
-- default to FALSE (never NULL) so missing data is never conflated with a
-- flagged inconsistency. estimated_net_upside is populated for OPEN items
-- only (NULL for realized items, which already have a real net_profit).
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
flagged AS (
  SELECT
    *,
    COALESCE(days_acquisition_to_first_listing < 0, false) AS acquisition_to_listing_is_negative,
    COALESCE(
      global_days_on_market IS NOT NULL
      AND holding_days IS NOT NULL
      AND global_days_on_market > holding_days,
      false
    ) AS dom_exceeds_holding_days,
    COALESCE(
      is_realized
      AND first_listed_at IS NOT NULL
      AND exit_date IS NOT NULL
      AND global_days_on_market IS NOT NULL
      AND (exit_date - first_listed_at) <> global_days_on_market,
      false
    ) AS realized_dom_date_mismatch
  FROM eligible
)
SELECT
  item_id,
  user_id,
  item_display_name,
  brand_label                        AS brand_name,
  category_name,
  type_name,

  acquisition_value_band_order,
  acquisition_value_band_label,

  acquisition_date,
  acquisition_method,
  acquisition_value,
  is_historical_import,

  current_status,
  is_realized,

  first_listed_at                    AS first_listing_date,
  days_acquisition_to_first_listing  AS acquisition_to_first_listing_days,
  global_days_on_market,
  holding_days,

  exit_date,
  exit_type,
  exit_channel_name,
  exit_value,

  item_expenses_total,
  net_profit,
  roi,

  estimated_sold_value,
  CASE
    WHEN NOT is_realized THEN estimated_sold_value - acquisition_value - item_expenses_total
    ELSE NULL
  END                                 AS estimated_net_upside,

  acquisition_to_listing_is_negative,
  dom_exceeds_holding_days,
  realized_dom_date_mismatch,

  has_lifecycle_date_issue
FROM flagged
ORDER BY brand_name, acquisition_value, item_id;


-- ============================================================================
-- QUERY H2 — Brand drilldown summary / integrity check
-- CLASSIFICATION: shared aggregate evidence (one-row rollup of counts, no
-- item-level detail).
-- One-row rollup of Query H's integrity flags plus coverage counts. Read
-- this before H — it tells you whether there's anything worth drilling
-- into row by row. Missing DOM for realized items is coverage information
-- and may legitimately be greater than zero; the other counts should not be.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
flagged AS (
  SELECT
    *,
    COALESCE(days_acquisition_to_first_listing < 0, false) AS acquisition_to_listing_is_negative,
    COALESCE(
      global_days_on_market IS NOT NULL
      AND holding_days IS NOT NULL
      AND global_days_on_market > holding_days,
      false
    ) AS dom_exceeds_holding_days,
    COALESCE(
      is_realized
      AND first_listed_at IS NOT NULL
      AND exit_date IS NOT NULL
      AND global_days_on_market IS NOT NULL
      AND (exit_date - first_listed_at) <> global_days_on_market,
      false
    ) AS realized_dom_date_mismatch
  FROM eligible
)
SELECT
  COUNT(*)                                                                                   AS item_count,
  COUNT(DISTINCT brand_label)                                                                 AS distinct_brand_count,
  COUNT(*) FILTER (WHERE brand_label = 'Unknown brand')                                       AS unknown_brand_item_count,
  (SELECT COUNT(*) FROM (SELECT item_id FROM flagged GROUP BY item_id HAVING COUNT(*) > 1) dup) AS duplicate_item_id_count,
  COUNT(*) FILTER (WHERE acquisition_to_listing_is_negative)                                   AS negative_acquisition_to_listing_count,
  COUNT(*) FILTER (WHERE dom_exceeds_holding_days)                                             AS dom_exceeds_holding_count,
  COUNT(*) FILTER (WHERE realized_dom_date_mismatch)                                           AS realized_dom_date_mismatch_count,
  COUNT(*) FILTER (WHERE is_realized AND global_days_on_market IS NULL)                        AS realized_items_missing_dom_count,
  COUNT(*) FILTER (WHERE NOT is_realized AND current_status = 'listed' AND global_days_on_market IS NULL) AS open_listed_items_missing_dom_count
FROM flagged;


-- ============================================================================
-- QUERY I (OPTIONAL) — Brand capital concentration
-- CLASSIFICATION: shared aggregate evidence.
-- How much of total acquisition capital sits in each brand, and how that
-- concentration splits between open (listed vs. unlisted) inventory. FACTS
-- ONLY — no "safe concentration" threshold is defined here; that's a
-- business judgment call for later.
-- ============================================================================
WITH acquisition_value_band AS (
  SELECT
    *,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 0
      WHEN acquisition_value < 1000 THEN 1
      WHEN acquisition_value < 2000 THEN 2
      WHEN acquisition_value < 3000 THEN 3
      WHEN acquisition_value < 4000 THEN 4
      WHEN acquisition_value < 5000 THEN 5
      ELSE 6
    END AS acquisition_value_band_order,
    CASE
      WHEN acquisition_value IS NULL OR acquisition_value <= 0 THEN 'Zero / unknown'
      WHEN acquisition_value < 1000 THEN '$1-999'
      WHEN acquisition_value < 2000 THEN '$1,000-1,999'
      WHEN acquisition_value < 3000 THEN '$2,000-2,999'
      WHEN acquisition_value < 4000 THEN '$3,000-3,999'
      WHEN acquisition_value < 5000 THEN '$4,000-4,999'
      ELSE '$5,000+'
    END AS acquisition_value_band_label
  FROM analytics_item_lifecycle
),
business AS (
  SELECT
    *,
    CASE
      WHEN brand_name IS NULL OR trim(brand_name) = '' THEN 'Unknown brand'
      ELSE brand_name
    END AS brand_label
  FROM acquisition_value_band
  WHERE purpose_name = 'Business'
),
eligible AS (
  SELECT * FROM business WHERE acquisition_value > 0
),
brand_capital AS (
  SELECT
    brand_label,
    SUM(acquisition_value)                                                                   AS brand_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized)                                     AS open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status = 'listed')       AS listed_open_capital,
    SUM(acquisition_value) FILTER (WHERE NOT is_realized AND current_status <> 'listed')      AS unlisted_open_capital
  FROM eligible
  GROUP BY brand_label
),
totals AS (
  SELECT
    SUM(brand_capital)         AS total_capital,
    SUM(open_capital)          AS total_open_capital,
    SUM(listed_open_capital)   AS total_listed_open_capital,
    SUM(unlisted_open_capital) AS total_unlisted_open_capital
  FROM brand_capital
),
ranked AS (
  SELECT
    *,
    SUM(brand_capital) OVER (ORDER BY brand_capital DESC, brand_label ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_capital
  FROM brand_capital
)
SELECT
  ranked.brand_label                                                                     AS brand_name,
  totals.total_capital                                                                    AS total_business_acquisition_capital,
  ranked.brand_capital                                                                    AS acquisition_capital,
  ROUND(ranked.brand_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)         AS brand_share_of_total_capital_percent,
  ROUND(ranked.cumulative_capital::numeric / NULLIF(totals.total_capital, 0) * 100, 2)    AS cumulative_capital_share_percent,
  ranked.open_capital,
  ROUND(ranked.open_capital::numeric / NULLIF(totals.total_open_capital, 0) * 100, 2)     AS open_capital_share_percent,
  ranked.listed_open_capital,
  ROUND(ranked.listed_open_capital::numeric / NULLIF(totals.total_listed_open_capital, 0) * 100, 2)   AS listed_open_capital_share_percent,
  ranked.unlisted_open_capital,
  ROUND(ranked.unlisted_open_capital::numeric / NULLIF(totals.total_unlisted_open_capital, 0) * 100, 2) AS unlisted_open_capital_share_percent
FROM ranked
CROSS JOIN totals
ORDER BY ranked.brand_capital DESC NULLS LAST, ranked.brand_label;
