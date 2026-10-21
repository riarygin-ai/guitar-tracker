-- Direct lead writes, part 2: Lead Log importer coexistence guards.
--
-- While direct MCP writes are live the Google Sheet importer stays available
-- as a fallback, but it must never compete with direct writes:
--   1. A lead created by, or last written through, MCP/UI ("direct-owned")
--      is never overwritten by a Sheet row — the importer classifies it as
--      SOURCE_OLDER with warning DIRECT_OWNED_LEAD and audits the row as
--      SKIPPED_DIRECT_OWNED (new result value); the upsert below re-checks it.
--   2. A NEW Sheet row whose item + channel + contact_key strongly matches an
--      existing DIRECT lead is rejected by the importer (INVALID,
--      POSSIBLE_DUPLICATE_OF_DIRECT_LEAD) — see src/lib/leadImport/validate.ts.
--   3. Direct writes set source_updated_at = clock_timestamp(), so an older
--      Sheet row can never win the timestamp guard either.
--   4. Sheet rows carry the application-computed contact_key and a
--      LEGACY_STRUCTURED peak_stage (only ever raised, never lowered); the
--      Sheet's OPEN never reopens a neutral-CLOSED lead.
-- Only the function body changes; signature, grants and audit are unchanged.

ALTER TABLE public.lead_import_run_rows DROP CONSTRAINT lead_import_run_rows_result_check;
ALTER TABLE public.lead_import_run_rows ADD CONSTRAINT lead_import_run_rows_result_check
  CHECK (result IN (
    'INSERTED', 'UPDATED', 'SKIPPED_UNCHANGED', 'SKIPPED_SOURCE_OLDER', 'SKIPPED_INVALID',
    'SKIPPED_NOT_APPLIED', 'SKIPPED_DIRECT_OWNED', 'FAILED'
  ));

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
      contact_name         text,
      contact_key          text,
      peak_stage           text,
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

    -- One linked lead per item: a DIFFERENT existing lead already holding
    -- this item's link is rejected here too — Preview/Import's own
    -- ITEM_ALREADY_LINKED_TO_ANOTHER_LEAD / DUPLICATE_DEAL_LINK_IN_SHEET
    -- checks already prevent this from ever reaching here in practice; the
    -- partial unique index above is the final backstop regardless.
    IF v_row.deal_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.item_leads il
      WHERE il.user_id = v_user_id
        AND il.inventory_item_id = v_row.inventory_item_id
        AND il.deal_id IS NOT NULL
        AND il.lead_id <> v_row.lead_id
    ) THEN
      RAISE EXCEPTION 'ITEM_ALREADY_LINKED_TO_ANOTHER_LEAD: sheet row %, inventory item %',
        v_row.sheet_row_number, v_row.inventory_item_id;
    END IF;

    INSERT INTO public.item_leads (
      user_id, source_id, inventory_item_id, lead_id,
      first_contact_at, last_contact_at, source_channel, deal_channel_id,
      buyer_message_count, our_message_count, lead_quality, offer_type,
      initial_cash_offer, best_cash_offer, trade_item, cash_component, trade_est_value,
      status, outcome_reason, notes, deal_id, contact_name, contact_name_source, contact_key,
      peak_stage, peak_stage_source, semantics_version, origin, last_write_source, source_updated_at,
      created_at, updated_at, last_imported_at
    ) VALUES (
      v_user_id, v_source_id, v_row.inventory_item_id, v_row.lead_id,
      v_row.first_contact_at, v_row.last_contact_at, v_row.source_channel, v_row.deal_channel_id,
      v_row.buyer_message_count, v_row.our_message_count, v_row.lead_quality, v_row.offer_type,
      v_row.initial_cash_offer, v_row.best_cash_offer, v_row.trade_item, v_row.cash_component, v_row.trade_est_value,
      v_row.status, v_row.outcome_reason, v_row.notes, v_row.deal_id, v_row.contact_name,
      CASE WHEN v_row.contact_name IS NOT NULL THEN 'LEAD_LOG' END, v_row.contact_key,
      v_row.peak_stage, CASE WHEN v_row.peak_stage IS NOT NULL THEN 'LEGACY_STRUCTURED' END,
      CASE WHEN v_row.peak_stage IS NOT NULL THEN 1 END, 'SHEET', 'SHEET', v_row.source_updated_at,
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
      -- The Sheet has no CLOSED status: a Sheet 'OPEN' never reopens a neutral-closed lead.
      status              = CASE WHEN item_leads.status = 'CLOSED' AND EXCLUDED.status = 'OPEN' THEN item_leads.status ELSE EXCLUDED.status END,
      outcome_reason      = CASE WHEN item_leads.status = 'CLOSED' AND EXCLUDED.status = 'OPEN' THEN item_leads.outcome_reason ELSE EXCLUDED.outcome_reason END,
      notes               = EXCLUDED.notes,
      deal_id             = EXCLUDED.deal_id,
      -- A blank/absent sheet value never erases a stored (e.g. backfilled) name.
      contact_name        = COALESCE(EXCLUDED.contact_name, item_leads.contact_name),
      contact_name_source = CASE WHEN EXCLUDED.contact_name IS NOT NULL THEN 'LEAD_LOG' ELSE item_leads.contact_name_source END,
      contact_key         = CASE WHEN EXCLUDED.contact_name IS NOT NULL THEN EXCLUDED.contact_key ELSE item_leads.contact_key END,
      -- peak_stage only ever rises; a Sheet-derived (structured) stage never lowers an audit/derived one.
      peak_stage          = CASE WHEN public.lead_stage_rank(EXCLUDED.peak_stage) > public.lead_stage_rank(item_leads.peak_stage) THEN EXCLUDED.peak_stage ELSE item_leads.peak_stage END,
      peak_stage_source   = CASE WHEN public.lead_stage_rank(EXCLUDED.peak_stage) > public.lead_stage_rank(item_leads.peak_stage) THEN 'LEGACY_STRUCTURED' ELSE item_leads.peak_stage_source END,
      last_write_source   = 'SHEET',
      source_updated_at   = EXCLUDED.source_updated_at,
      updated_at          = now(),
      last_imported_at    = now()
    WHERE item_leads.source_updated_at < EXCLUDED.source_updated_at
      -- Direct-owned leads (created by, or last written through, MCP/UI) are never overwritten by the Sheet.
      AND item_leads.origin = 'SHEET' AND item_leads.last_write_source NOT IN ('MCP', 'UI')
    RETURNING (xmax = 0) INTO v_inserted;

    IF NOT FOUND AND EXISTS (
      SELECT 1 FROM public.item_leads il WHERE il.user_id = v_user_id AND il.lead_id = v_row.lead_id
        AND (il.origin = 'DIRECT' OR il.last_write_source IN ('MCP', 'UI'))
    ) THEN
      -- Became direct-owned between classification and apply: the direct write wins.
      v_result := 'SKIPPED_DIRECT_OWNED';
    ELSIF NOT FOUND THEN
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
