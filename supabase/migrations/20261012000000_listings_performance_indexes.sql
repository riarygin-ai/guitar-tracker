-- /listings performance investigation — missing indexes.
--
-- Found by EXPLAIN ANALYZE against a locally-built, realistically large
-- fixture (scripts/test-listings-performance.ts: 150-1200 items, several
-- months of listing/lead/deal history) while investigating intermittent
-- 500s on /listings ("Could not load listing evidence / demand evidence
-- (server returned 500)"). Every query below is exercised repeatedly per
-- page load: once per (current, previous) period in build_listing_demand_
-- evidence_v1_1, and again once per weekly bucket in _listing_demand_
-- weekly_trend_v1_0 (so up to 2 + 2*trend_weeks times for a single /listings
-- request), plus independently again from listing_demand_item_activity_v1_0
-- and the /leads channel-attributed drill-down RPC. None of the four
-- tables below had an index matching their own WHERE clause before this
-- migration — every one of these filters forced a full-table Seq Scan
-- (scoped only by Postgres's post-scan Filter, not an index), repeated on
-- every one of those calls.
--
-- No semantics change: these are pure read-path indexes. Nothing here
-- alters a single row, a single formula, or a single returned value —
-- every existing Listing Demand Evidence / Listing Evidence / Item
-- Activity regression test must produce byte-identical output before and
-- after this migration.

-- ── 1. deals(user_id, deal_type, deal_date) ─────────────────────────────
-- Before: ONLY deals_pkey existed — every realized-deal query
-- ("WHERE d.user_id = :target AND d.deal_type IN ('sale','trade') AND
-- d.deal_date BETWEEN :start AND :end") was a Seq Scan across EVERY
-- user's deals. Used by _listing_demand_period_metrics_v1_0's `realized`
-- CTE and _listing_demand_channel_metrics_v1_0's `realized_by_channel`
-- CTE — both called per period/week.
CREATE INDEX IF NOT EXISTS idx_deals_user_id_deal_type_deal_date
  ON public.deals (user_id, deal_type, deal_date);

-- ── 2. item_leads(user_id, first_contact_at) ────────────────────────────
-- Before: only a plain (user_id) index existed — a date-range filter on
-- first_contact_at within one user's leads needed to visit every one of
-- that user's lead rows. Used by _listing_demand_period_metrics_v1_0's
-- and _listing_demand_channel_metrics_v1_0's `cohort_leads` CTEs, and by
-- build_listing_demand_evidence_v1_1's own data_quality undated-lead
-- query — all called per period/week, and the dominant row-growth table
-- as Lead Log volume increases (the production symptom this task
-- investigates).
CREATE INDEX IF NOT EXISTS idx_item_leads_user_id_first_contact_at
  ON public.item_leads (user_id, first_contact_at);

-- ── 3. item_listings(user_id, status) ───────────────────────────────────
-- Before: only a plain (user_id) index existed — listing_exposure_days_
-- v1_0's `eligible_cycles` CTE ("WHERE il.user_id = :target AND il.status
-- IN ('active','ended')") scanned every one of the user's listing cycles
-- regardless of status. listing_exposure_days_v1_0 is the single most
-- reused helper in this module (period/channel metrics, Item Activity,
-- the /leads channel-attributed drill-down) and runs many times per
-- /listings request.
CREATE INDEX IF NOT EXISTS idx_item_listings_user_id_status
  ON public.item_listings (user_id, status);

-- ── 4. deal_items(deal_id, direction) ───────────────────────────────────
-- Before: only (item_id, direction) existed (20260723000000) — the
-- realized-deal join ("JOIN deal_items di ON di.deal_id = d.id AND
-- di.direction = 'out'") had no index on deal_id at all and fell back to
-- a Seq Scan of deal_items. Complements the existing (item_id, direction)
-- index rather than replacing it — that one serves analytics_item_
-- lifecycle's own per-item exit-deal lookups, a different access path.
CREATE INDEX IF NOT EXISTS idx_deal_items_deal_id_direction
  ON public.deal_items (deal_id, direction);

COMMENT ON INDEX public.idx_deals_user_id_deal_type_deal_date IS
  'Listing Demand Evidence performance (2026-10 /listings investigation): '
  'covers the realized-deal WHERE clause repeated per period/week in '
  '_listing_demand_period_metrics_v1_0 / _listing_demand_channel_metrics_'
  'v1_0. Read-only; no semantic change.';
COMMENT ON INDEX public.idx_item_leads_user_id_first_contact_at IS
  'Listing Demand Evidence performance (2026-10 /listings investigation): '
  'covers the cohort_leads date-range WHERE clause repeated per period/'
  'week. Read-only; no semantic change.';
COMMENT ON INDEX public.idx_item_listings_user_id_status IS
  'Listing Demand Evidence performance (2026-10 /listings investigation): '
  'covers listing_exposure_days_v1_0''s eligible_cycles WHERE clause, the '
  'most-reused helper in this module. Read-only; no semantic change.';
COMMENT ON INDEX public.idx_deal_items_deal_id_direction IS
  'Listing Demand Evidence performance (2026-10 /listings investigation): '
  'covers the realized-deal join on deal_items.deal_id, complementing the '
  'existing (item_id, direction) index (a different access path). '
  'Read-only; no semantic change.';
