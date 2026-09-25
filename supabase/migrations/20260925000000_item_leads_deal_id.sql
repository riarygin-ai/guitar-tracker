-- Lead -> Deal linkage storage (canonical linkage only — no conversion
-- analytics yet; see the task history for the next feature).
--
-- Adds public.item_leads.deal_id: the Guitar Tracker Deal ID a completed
-- Lead Log row has been manually linked to via the chat workflow (Sheet
-- column S, appended after `updated_at`). Nullable, no UNIQUE constraint —
-- a deal may legitimately be referenced by more than one lead (bundle
-- deals, multi-item trades, multiple conversations tied to one deal), so
-- this is deliberately many-to-one, never one-to-one.
--
-- FK convention: plain `REFERENCES public.deals(id)`, no ON DELETE clause —
-- the same convention already used by cash_flow.deal_id and
-- inventory_expenses.deal_id (20260601204505_remote_schema.sql), neither of
-- which cascades or nulls on a deal delete either. There is no deal-delete
-- path in this app today. This FK is referential integrity ONLY — it does
-- NOT enforce that the deal belongs to the lead's own user (deal.user_id ==
-- item_leads.user_id) or that the lead's item is the deal's OUTGOING
-- (realized) item. Both of those are validated at the application layer
-- (src/lib/leadImport/validate.ts: DEAL_NOT_OWNED_BY_SOURCE_USER,
-- DEAL_ITEM_MISMATCH) and, for the one write path that exists
-- (apply_lead_import_batch below), re-checked again in the database —
-- exactly the same "app validates + DB re-checks, never trusts the
-- payload" pattern item_leads_owner FKs already use for source/item
-- ownership, and the same reason deal_items has no simple FK expressing
-- "this item is on the correct side of this deal" (direction/role
-- constraints don't fit a plain foreign key).

ALTER TABLE public.item_leads
  ADD COLUMN deal_id bigint REFERENCES public.deals(id);

CREATE INDEX idx_item_leads_deal_id ON public.item_leads (deal_id);

COMMENT ON COLUMN public.item_leads.deal_id IS
  'The completed Sell/Trade deal (deals.id) this lead has been linked to, '
  'via Sheet column S (deal_id). NULL until the chat workflow links it. '
  'Not unique — bundle deals / multi-item trades / multiple conversations '
  'can legitimately share one deal_id. deal_id != NULL requires '
  'status = COMPLETED (item_leads_deal_id_requires_completed_check); the '
  'reverse (COMPLETED with deal_id NULL) stays valid for historical rows '
  'imported before linking existed.';

-- ── deal_id != NULL requires status = COMPLETED (Part 5A) ──────────────────
-- The reverse is intentionally NOT enforced: historical COMPLETED leads
-- with no deal_id remain valid (Part 5B) so links can be backfilled
-- gradually through the Sheet workflow.

ALTER TABLE public.item_leads
  ADD CONSTRAINT item_leads_deal_id_requires_completed_check
  CHECK (deal_id IS NULL OR status = 'COMPLETED');

-- ── Material-field comparison: deal_id is a material lead field ────────────
-- Re-declares trg_item_leads_require_newer_source's guard function (added
-- 20260909000001_apply_lead_import.sql) with deal_id added to BOTH sides of
-- the tuple comparison, so a direct service_role UPDATE can no longer
-- change deal_id (NULL -> 123, 123 -> 456, or 123 -> NULL) without a
-- strictly newer source_updated_at — same rule every other source-mirrored
-- column already follows. The trigger itself (trg_item_leads_require_newer_
-- source) is unchanged; only the function body it points at is replaced.

CREATE OR REPLACE FUNCTION public.item_leads_require_newer_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_updated_at > OLD.source_updated_at THEN
    RETURN NEW;
  END IF;

  IF (NEW.inventory_item_id, NEW.lead_id, NEW.first_contact_at, NEW.last_contact_at,
      NEW.source_channel, NEW.deal_channel_id, NEW.buyer_message_count, NEW.our_message_count,
      NEW.lead_quality, NEW.offer_type, NEW.initial_cash_offer, NEW.best_cash_offer,
      NEW.trade_item, NEW.cash_component, NEW.trade_est_value,
      NEW.status, NEW.outcome_reason, NEW.notes, NEW.deal_id)
     IS DISTINCT FROM
     (OLD.inventory_item_id, OLD.lead_id, OLD.first_contact_at, OLD.last_contact_at,
      OLD.source_channel, OLD.deal_channel_id, OLD.buyer_message_count, OLD.our_message_count,
      OLD.lead_quality, OLD.offer_type, OLD.initial_cash_offer, OLD.best_cash_offer,
      OLD.trade_item, OLD.cash_component, OLD.trade_est_value,
      OLD.status, OLD.outcome_reason, OLD.notes, OLD.deal_id)
  THEN
    RAISE EXCEPTION
      'item_leads source state cannot change unless source_updated_at advances (stored %, incoming %)',
      OLD.source_updated_at, NEW.source_updated_at;
  END IF;

  RETURN NEW;
END;
$$;

-- ── apply_lead_import_batch: write path gains deal_id ──────────────────────
-- Same function signature (still bigint, jsonb, jsonb, int×5, timestamptz) —
-- CREATE OR REPLACE in place. Adds:
--   * deal_id to the jsonb_to_recordset(p_apply_rows) column list (the
--     already-validated, already-normalized value src/lib/leadImport/
--     validate.ts produced — never re-derived here),
--   * a re-check that any non-null deal_id actually belongs to the run's
--     own user (defense in depth: the same DEAL_NOT_OWNED_BY_SOURCE_USER
--     rule Preview/Import already enforce before ever reaching this
--     function, mirroring the existing ITEM_NOT_OWNED_BY_SOURCE_USER
--     re-check immediately above it),
--   * deal_id in both the INSERT column list and the ON CONFLICT DO UPDATE
--     SET list (whole-row replacement, same as every other source-mirrored
--     column — a blanked deal_id legitimately becomes NULL here too).
-- Everything else in this function — transaction boundary, upsert guard,
-- audit rows, run/source finalization — is unchanged.

CREATE OR REPLACE FUNCTION public.apply_lead_import_batch(
  p_run_id                bigint,
  p_apply_rows            jsonb,
  p_skip_rows             jsonb,
  p_source_row_count      int,
  p_new_count             int,
  p_update_count          int,
  p_unchanged_count       int,
  p_source_older_count    int,
  p_invalid_count         int,
  p_source_max_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_id       bigint;
  v_user_id         int;
  v_run_status      text;
  v_row             record;
  v_inserted        boolean;
  v_result          text;
  v_inserted_count  int := 0;
  v_updated_count   int := 0;
  v_failed_count    int := 0;
  v_final_status    text;
BEGIN
  -- Everything below runs in the caller's single transaction: if any
  -- statement raises, every lead write, audit row, run update and source
  -- metadata change in this function is rolled back together.

  SELECT r.source_id, r.user_id, r.status
    INTO v_source_id, v_user_id, v_run_status
  FROM public.lead_import_runs r
  WHERE r.id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND';
  END IF;
  IF v_run_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'RUN_NOT_RUNNING: %', v_run_status;
  END IF;

  -- ── Apply the valid NEW/UPDATE rows ──────────────────────────────────
  FOR v_row IN
    SELECT *
    FROM jsonb_to_recordset(COALESCE(p_apply_rows, '[]'::jsonb)) AS x(
      sheet_row_number     int,
      lead_id              uuid,
      inventory_item_id    bigint,
      first_contact_at     date,
      last_contact_at      date,
      source_channel       text,
      deal_channel_id      bigint,
      buyer_message_count  int,
      our_message_count    int,
      lead_quality         text,
      offer_type           text,
      initial_cash_offer   numeric,
      best_cash_offer      numeric,
      trade_item           text,
      cash_component       numeric,
      trade_est_value      numeric,
      status               text,
      outcome_reason       text,
      notes                text,
      deal_id              bigint,
      source_updated_at    timestamptz,
      classification       text,
      issue_codes          text[],
      issue_message        text
    )
    ORDER BY x.sheet_row_number
  LOOP
    -- Ownership is re-derived here, never trusted from the payload: the
    -- item must belong to the run's own user. (item_leads' composite FK
    -- enforces the same thing on the write itself — this check exists to
    -- fail with a legible reason rather than a raw FK violation.)
    IF NOT EXISTS (
      SELECT 1 FROM public.inventory_items i
      WHERE i.id = v_row.inventory_item_id AND i.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'ITEM_NOT_OWNED_BY_SOURCE_USER: sheet row %, inventory item %',
        v_row.sheet_row_number, v_row.inventory_item_id;
    END IF;

    -- A supplied deal_channel_id must actually be the channel its own raw
    -- source_channel names — a normalized channel is never taken on trust.
    IF v_row.deal_channel_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.deal_channels dc
      WHERE dc.id = v_row.deal_channel_id
        AND lower(dc.name) = lower(btrim(COALESCE(v_row.source_channel, '')))
    ) THEN
      RAISE EXCEPTION 'DEAL_CHANNEL_MISMATCH: sheet row %, channel %',
        v_row.sheet_row_number, v_row.deal_channel_id;
    END IF;

    -- A supplied deal_id must belong to the run's own user — same defense-
    -- in-depth re-check as the item/channel checks above. Preview/Import
    -- already rejected an unowned or item-mismatched deal_id as INVALID
    -- (DEAL_NOT_OWNED_BY_SOURCE_USER / DEAL_ITEM_MISMATCH) before an
    -- eligible row ever reaches here.
    IF v_row.deal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.deals d WHERE d.id = v_row.deal_id AND d.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'DEAL_NOT_OWNED_BY_SOURCE_USER: sheet row %, deal %',
        v_row.sheet_row_number, v_row.deal_id;
    END IF;

    INSERT INTO public.item_leads (
      user_id, source_id, inventory_item_id, lead_id,
      first_contact_at, last_contact_at, source_channel, deal_channel_id,
      buyer_message_count, our_message_count, lead_quality, offer_type,
      initial_cash_offer, best_cash_offer, trade_item, cash_component, trade_est_value,
      status, outcome_reason, notes, deal_id, source_updated_at,
      created_at, updated_at, last_imported_at
    ) VALUES (
      v_user_id, v_source_id, v_row.inventory_item_id, v_row.lead_id,
      v_row.first_contact_at, v_row.last_contact_at, v_row.source_channel, v_row.deal_channel_id,
      v_row.buyer_message_count, v_row.our_message_count, v_row.lead_quality, v_row.offer_type,
      v_row.initial_cash_offer, v_row.best_cash_offer, v_row.trade_item, v_row.cash_component, v_row.trade_est_value,
      v_row.status, v_row.outcome_reason, v_row.notes, v_row.deal_id, v_row.source_updated_at,
      now(), now(), now()
    )
    ON CONFLICT (user_id, lead_id) DO UPDATE SET
      -- Whole-row replacement, never a per-field merge: a newer source row
      -- is the authoritative current representation of the lead, so a
      -- blanked optional cell (deal_id included) legitimately becomes NULL
      -- here. id and created_at are deliberately absent — they are
      -- preserved.
      source_id           = EXCLUDED.source_id,
      inventory_item_id   = EXCLUDED.inventory_item_id,
      first_contact_at    = EXCLUDED.first_contact_at,
      last_contact_at     = EXCLUDED.last_contact_at,
      source_channel      = EXCLUDED.source_channel,
      deal_channel_id     = EXCLUDED.deal_channel_id,
      buyer_message_count = EXCLUDED.buyer_message_count,
      our_message_count   = EXCLUDED.our_message_count,
      lead_quality        = EXCLUDED.lead_quality,
      offer_type          = EXCLUDED.offer_type,
      initial_cash_offer  = EXCLUDED.initial_cash_offer,
      best_cash_offer     = EXCLUDED.best_cash_offer,
      trade_item          = EXCLUDED.trade_item,
      cash_component      = EXCLUDED.cash_component,
      trade_est_value     = EXCLUDED.trade_est_value,
      status              = EXCLUDED.status,
      outcome_reason      = EXCLUDED.outcome_reason,
      notes               = EXCLUDED.notes,
      deal_id             = EXCLUDED.deal_id,
      source_updated_at   = EXCLUDED.source_updated_at,
      updated_at          = now(),
      last_imported_at    = now()
    WHERE item_leads.source_updated_at < EXCLUDED.source_updated_at
    RETURNING (xmax = 0) INTO v_inserted;

    IF NOT FOUND THEN
      -- The guard rejected it: something else already stored an equal or
      -- newer version of this lead between classification and now.
      v_result := 'SKIPPED_NOT_APPLIED';
      v_failed_count := v_failed_count + 1;
    ELSIF v_inserted THEN
      v_result := 'INSERTED';
      v_inserted_count := v_inserted_count + 1;
    ELSE
      v_result := 'UPDATED';
      v_updated_count := v_updated_count + 1;
    END IF;

    INSERT INTO public.lead_import_run_rows (
      import_run_id, sheet_row_number, lead_id, inventory_item_id,
      source_updated_at, classification, result, issue_codes, issue_message
    ) VALUES (
      p_run_id, v_row.sheet_row_number, v_row.lead_id, v_row.inventory_item_id,
      v_row.source_updated_at, v_row.classification, v_result,
      COALESCE(v_row.issue_codes, '{}'::text[]), v_row.issue_message
    );
  END LOOP;

  -- ── Audit the rows that were deliberately not applied ────────────────
  INSERT INTO public.lead_import_run_rows (
    import_run_id, sheet_row_number, lead_id, inventory_item_id,
    source_updated_at, classification, result, issue_codes, issue_message
  )
  SELECT
    p_run_id, s.sheet_row_number, s.lead_id, s.inventory_item_id,
    s.source_updated_at, s.classification, s.result,
    COALESCE(s.issue_codes, '{}'::text[]), s.issue_message
  FROM jsonb_to_recordset(COALESCE(p_skip_rows, '[]'::jsonb)) AS s(
    sheet_row_number   int,
    lead_id            uuid,
    inventory_item_id  bigint,
    source_updated_at  timestamptz,
    classification     text,
    result             text,
    issue_codes        text[],
    issue_message      text
  );

  -- ── Finalize the run ──────────────────────────────────────────────────
  v_final_status := CASE
    WHEN p_invalid_count > 0 OR v_failed_count > 0 THEN 'COMPLETED_WITH_ERRORS'
    ELSE 'COMPLETED'
  END;

  UPDATE public.lead_import_runs r SET
    status                = v_final_status,
    completed_at          = now(),
    source_row_count      = p_source_row_count,
    new_count             = p_new_count,
    update_count          = p_update_count,
    unchanged_count       = p_unchanged_count,
    source_older_count    = p_source_older_count,
    invalid_count         = p_invalid_count,
    inserted_count        = v_inserted_count,
    updated_count         = v_updated_count,
    failed_count          = v_failed_count,
    source_max_updated_at = p_source_max_updated_at,
    error_summary         = CASE
      WHEN p_invalid_count > 0 OR v_failed_count > 0 THEN
        format('%s invalid row(s) skipped; %s eligible row(s) not applied.', p_invalid_count, v_failed_count)
      ELSE NULL
    END
  WHERE r.id = p_run_id;

  -- ── Advance the source's successful-import metadata ───────────────────
  UPDATE public.lead_import_sources s SET
    last_successful_import_at   = now(),
    last_source_updated_at_seen = COALESCE(p_source_max_updated_at, s.last_source_updated_at_seen)
  WHERE s.id = v_source_id;

  RETURN jsonb_build_object(
    'run_id',         p_run_id,
    'status',         v_final_status,
    'inserted_count', v_inserted_count,
    'updated_count',  v_updated_count,
    'failed_count',   v_failed_count
  );
END;
$$;

COMMENT ON FUNCTION public.apply_lead_import_batch(bigint, jsonb, jsonb, int, int, int, int, int, int, timestamptz) IS
  'Applies one import run''s valid NEW/UPDATE rows (including deal_id), '
  'writes every row''s audit record, finalizes the run and advances the '
  'source metadata — all in a single transaction, so a failure anywhere '
  'leaves no partially applied batch. Upsert identity is (user_id, '
  'lead_id) and an existing lead is only overwritten when the incoming '
  'source_updated_at is strictly newer. Never deletes. service_role only.';
