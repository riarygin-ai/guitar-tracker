-- GT Lead Log import — Phase 1, Part 2: item_leads
--
-- Lead storage table. Created now so the importer (a later phase) has a
-- stable target, but Phase 1 NEVER writes to this table — no INSERT/UPDATE
-- path exists yet anywhere in the app. See src/lib/leadImport/preview.ts,
-- which only ever reads it for classification.
--
-- ── LOGICAL IDENTITY ────────────────────────────────────────────────────────
-- Internal PK is `id`. The logical Sheet identity is (user_id, lead_id) —
-- UNIQUE below — never the bare lead_id UUID alone, so the same UUID
-- accidentally reused across two different users' sheets can never collide.
-- lead_id is never regenerated/replaced/normalized once assigned by the
-- source sheet.
--
-- ── OWNERSHIP ────────────────────────────────────────────────────────────
-- The sheet itself never supplies or is trusted for Guitar Tracker user_id —
-- a lead's user_id always comes from its lead_import_sources row
-- (source.user_id is authoritative). The composite FKs below enforce, at
-- the database level, that:
--   1. item_leads.(source_id, user_id)         must match an existing
--      lead_import_sources.(id, user_id) row — a lead can never claim a
--      source it doesn't actually belong to.
--   2. item_leads.(inventory_item_id, user_id) must match an existing
--      inventory_items.(id, user_id) row — a lead can never point at an
--      inventory item owned by a different user (ITEM_NOT_OWNED_BY_SOURCE_
--      USER in Preview validation is the same rule, checked before any
--      write would ever be attempted).
--
-- ── FIELD SPLIT ──────────────────────────────────────────────────────────
-- id/user_id/source_id/inventory_item_id/created_at/updated_at/
-- last_imported_at are internal/database-owned. Every other column is
-- source-mirrored (written verbatim, blank -> NULL, from the Sheet — never
-- derived/computed here). All monetary values are CAD; there is
-- deliberately no currency column. Deliberately excluded: any derived
-- analytics field (ghost_flag, conversion_flag, offer_to_price_percentage,
-- etc.) — those belong to a future analytics layer, not this table.

-- ─── 1. inventory_items(id, user_id) — required target for the composite
-- ownership FK below. Purely additive: inventory_items.id is already the
-- PRIMARY KEY, so (id, user_id) is trivially unique — this adds no new
-- constraint on real data, just a second unique index Postgres requires as
-- an FK target. ────────────────────────────────────────────────────────────

ALTER TABLE public.inventory_items
  ADD CONSTRAINT inventory_items_id_user_unique UNIQUE (id, user_id);

-- ─── 2. Table ───────────────────────────────────────────────────────────────

CREATE TABLE public.item_leads (
  id                     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  user_id                int         NOT NULL REFERENCES public.app_users(id),
  source_id              bigint      NOT NULL REFERENCES public.lead_import_sources(id),
  inventory_item_id      bigint      NOT NULL REFERENCES public.inventory_items(id),

  lead_id                uuid        NOT NULL,

  first_contact_at       date,
  last_contact_at        date,

  source_channel         text,
  deal_channel_id        bigint      REFERENCES public.deal_channels(id),

  buyer_message_count    integer,
  our_message_count      integer,

  lead_quality           text        NOT NULL,
  offer_type             text        NOT NULL,

  initial_cash_offer     numeric(12,2),
  best_cash_offer        numeric(12,2),

  trade_item             text,
  cash_component         numeric(12,2),
  trade_est_value        numeric(12,2),

  status                 text        NOT NULL,
  outcome_reason         text,
  notes                  text,

  source_updated_at      timestamptz NOT NULL,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_imported_at       timestamptz,

  -- ── Logical Sheet identity ────────────────────────────────────────────
  CONSTRAINT item_leads_user_lead_unique UNIQUE (user_id, lead_id),

  -- ── Composite ownership FKs (see header) ──────────────────────────────
  CONSTRAINT item_leads_source_owner_fk
    FOREIGN KEY (source_id, user_id) REFERENCES public.lead_import_sources(id, user_id),
  CONSTRAINT item_leads_item_owner_fk
    FOREIGN KEY (inventory_item_id, user_id) REFERENCES public.inventory_items(id, user_id),

  -- ── Closed vocabularies: text + CHECK, never a Postgres ENUM ──────────
  CONSTRAINT item_leads_lead_quality_check
    CHECK (lead_quality IN ('LOW', 'ENGAGED', 'SERIOUS', 'HIGH_INTENT')),

  CONSTRAINT item_leads_offer_type_check
    CHECK (offer_type IN ('NONE', 'CASH', 'TRADE', 'MIXED')),

  CONSTRAINT item_leads_status_check
    CHECK (status IN ('OPEN', 'GHOSTED', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'AGREED', 'FAILED_AFTER_AGREEMENT', 'COMPLETED')),

  CONSTRAINT item_leads_outcome_reason_check
    CHECK (outcome_reason IS NULL OR outcome_reason IN (
      'LOW_OFFER', 'TRADE_NOT_INTERESTING', 'PRICE', 'CONDITION',
      'LOGISTICS', 'NO_SHOW', 'CHANGED_MIND', 'FOUND_ANOTHER', 'UNKNOWN'
    )),

  -- ── Sensible ranges on historically-incomplete data ───────────────────
  CONSTRAINT item_leads_buyer_message_count_check CHECK (buyer_message_count IS NULL OR buyer_message_count >= 0),
  CONSTRAINT item_leads_our_message_count_check   CHECK (our_message_count   IS NULL OR our_message_count   >= 0),
  CONSTRAINT item_leads_initial_cash_offer_check  CHECK (initial_cash_offer  IS NULL OR initial_cash_offer  >= 0),
  CONSTRAINT item_leads_best_cash_offer_check     CHECK (best_cash_offer     IS NULL OR best_cash_offer     >= 0),
  CONSTRAINT item_leads_trade_est_value_check     CHECK (trade_est_value     IS NULL OR trade_est_value     >= 0),

  CONSTRAINT item_leads_best_ge_initial_check CHECK (
    initial_cash_offer IS NULL OR best_cash_offer IS NULL OR best_cash_offer >= initial_cash_offer
  ),

  CONSTRAINT item_leads_contact_dates_check CHECK (
    first_contact_at IS NULL OR last_contact_at IS NULL OR last_contact_at >= first_contact_at
  ),

  -- ── offer_type / cash_component semantics (never coerce NULL to 0) ────
  --   TRADE + 0        -> valid   (straight trade, no cash)
  --   TRADE + NULL     -> invalid (explicit data-quality issue)
  --   TRADE + non-zero -> invalid
  --   MIXED + NULL     -> valid   (cash known to exist, amount unknown)
  --   MIXED + +/-      -> valid
  --   MIXED + 0        -> invalid (known zero cash is a straight TRADE)
  --   NONE/CASH + non-null cash_component -> invalid
  -- NOTE: a bare `cash_component = 0` would silently PASS when
  -- cash_component IS NULL — CHECK constraints only fail on an explicit
  -- FALSE, and `NULL = 0` evaluates to NULL, not FALSE. TRADE + NULL must
  -- be explicitly rejected, hence the `IS NOT NULL AND` below.
  CONSTRAINT item_leads_offer_cash_semantics_check CHECK (
    CASE offer_type
      WHEN 'TRADE' THEN cash_component IS NOT NULL AND cash_component = 0
      WHEN 'MIXED' THEN cash_component IS NULL OR cash_component <> 0
      WHEN 'NONE'  THEN cash_component IS NULL
      WHEN 'CASH'  THEN cash_component IS NULL
      ELSE false
    END
  )
);

-- ─── 2. Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX idx_item_leads_user_id           ON public.item_leads (user_id);
CREATE INDEX idx_item_leads_source_id         ON public.item_leads (source_id);
CREATE INDEX idx_item_leads_inventory_item_id ON public.item_leads (inventory_item_id);

-- ─── 3. updated_at maintenance ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_item_leads_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_item_leads_updated_at
  BEFORE UPDATE ON public.item_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_item_leads_updated_at();

-- ─── 4. Quality-regression protection (DB-level safety net for future
-- writes — Preview itself independently flags LEAD_QUALITY_REGRESSION
-- application-side before any write is ever attempted) ─────────────────────
-- lead_quality represents the highest intent level ever reached and must
-- never decrease.

CREATE OR REPLACE FUNCTION public.item_leads_prevent_quality_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rank jsonb := '{"LOW": 1, "ENGAGED": 2, "SERIOUS": 3, "HIGH_INTENT": 4}'::jsonb;
BEGIN
  IF (v_rank->>NEW.lead_quality)::int < (v_rank->>OLD.lead_quality)::int THEN
    RAISE EXCEPTION 'lead_quality cannot decrease (was %, attempted %)', OLD.lead_quality, NEW.lead_quality;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_item_leads_prevent_quality_regression
  BEFORE UPDATE ON public.item_leads
  FOR EACH ROW
  WHEN (NEW.lead_quality IS DISTINCT FROM OLD.lead_quality)
  EXECUTE FUNCTION public.item_leads_prevent_quality_regression();

-- ─── 5. Row-level security ──────────────────────────────────────────────────
-- Owner may SELECT their own leads. No authenticated INSERT/UPDATE/DELETE
-- policy at all — this table has no write path yet; the future importer
-- writes exclusively via service_role, matching analytics_runs/
-- analytics_run_advice's own "no authenticated write policy" precedent.

ALTER TABLE public.item_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "item_leads: select own"
  ON public.item_leads FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

-- ─── 6. Grants ──────────────────────────────────────────────────────────────
-- Same independent table-privilege hardening as lead_import_sources (see
-- that migration's own comment on this project's ambient default grants).

REVOKE ALL PRIVILEGES ON public.item_leads FROM anon;
REVOKE ALL PRIVILEGES ON public.item_leads FROM authenticated;

GRANT SELECT ON public.item_leads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_leads TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE public.item_leads_id_seq FROM anon;
REVOKE ALL PRIVILEGES ON SEQUENCE public.item_leads_id_seq FROM authenticated;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.item_leads_id_seq TO service_role;

GRANT EXECUTE ON FUNCTION public.set_item_leads_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.item_leads_prevent_quality_regression() TO service_role;

-- ─── 7. Comments ─────────────────────────────────────────────────────────────

COMMENT ON TABLE public.item_leads IS
  'GT Lead Log rows mirrored from a user''s Google Sheet source. Phase 1 '
  '(2026-09) creates this table only — no importer writes to it yet; see '
  'src/lib/leadImport/preview.ts for the read-only classification that '
  'will eventually drive the write path. Logical Sheet identity is '
  '(user_id, lead_id), never lead_id alone. All monetary columns are CAD; '
  'there is deliberately no currency column, and deliberately no derived '
  'analytics column (ghost_flag, conversion_flag, etc.) — those belong to '
  'a future analytics layer.';

COMMENT ON COLUMN public.item_leads.lead_id IS
  'Source-assigned UUID identifying this lead within one user''s sheet. '
  'Never regenerated/replaced/normalized. Unique per user (user_id, '
  'lead_id) — the same UUID may independently exist for two different '
  'users without conflict.';

COMMENT ON COLUMN public.item_leads.source_channel IS
  'Raw channel value as it appeared in the sheet (Marketplace/Kijiji/'
  'Reverb/Other/blank). Always preserved even when deal_channel_id is '
  'NULL (Other, or a blank historical row).';

COMMENT ON COLUMN public.item_leads.lead_quality IS
  'Highest intent level ever reached for this lead. Must never decrease — '
  'enforced at write time by trg_item_leads_prevent_quality_regression and '
  'flagged during Preview as LEAD_QUALITY_REGRESSION before any write is '
  'attempted.';

COMMENT ON COLUMN public.item_leads.cash_component IS
  'CAD. Semantics depend on offer_type — see '
  'item_leads_offer_cash_semantics_check. NULL is never coerced to 0: for '
  'MIXED it means "cash is part of the deal, exact amount unknown"; for '
  'TRADE it is an explicit data-quality error (a straight trade must '
  'record exactly 0).';

COMMENT ON COLUMN public.item_leads.last_imported_at IS
  'Most recent time a newer source version of this lead was successfully '
  'applied by the (future) importer. Schema preparation only in Phase 1 — '
  'always NULL until the write path exists.';
