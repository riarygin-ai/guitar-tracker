-- GT Lead Log import — Phase 2, Part 2: the actual write path
--
-- Three service_role-only functions plus one item_leads safety trigger.
-- Together they are the ONLY way a lead row is ever written.
--
-- ── TRANSACTION BOUNDARY (Part 10 of the task spec) ───────────────────────
-- Three separate database transactions, deliberately:
--
--   1. start_lead_import_run()   — commits a RUNNING claim row.
--   2. apply_lead_import_batch() — ONE transaction that applies every valid
--                                  row, writes every audit row, finalizes
--                                  the run's counts/status AND advances the
--                                  source's successful-import metadata.
--   3. fail_lead_import_run()    — only reached when (2) rolled back.
--
-- The claim in (1) must commit on its own, because it is what makes a
-- concurrent import of the same source impossible while (2) is still
-- reading the sheet and classifying — a claim rolled into (2) would be
-- invisible to other sessions for the whole duration of the import.
--
-- (2) is all-or-nothing: if any single valid row fails to apply, the
-- entire batch, its audit rows, its run counts and the source metadata
-- update all roll back together. Nothing is left half-applied. The run row
-- itself survives (it was committed by (1), still RUNNING), so (3) can then
-- record the failure in a fresh transaction — the failed attempt stays
-- visible in history without any lead write having survived.
--
-- ── CONCURRENCY (Part 15) ─────────────────────────────────────────────────
-- Two layers, both in the database:
--   * pg_advisory_xact_lock(LEAD_IMPORT_LOCK_CLASS, source_id) serializes
--     the claim itself, so two simultaneous claims cannot both observe "no
--     run is RUNNING".
--   * idx_lead_import_runs_one_running_per_source (a partial UNIQUE index)
--     makes a second RUNNING row for the same source impossible even if a
--     future caller ever bypassed the advisory lock.
-- Different sources take different advisory-lock keys and never block each
-- other.
--
-- The advisory lock is intentionally transaction-scoped rather than held
-- for the life of the import: an import spans several separate HTTP/
-- pooled-connection round trips, and a session-level lock cannot be
-- relied upon to survive them. The committed RUNNING row is the durable
-- lock; the advisory lock only closes the claim race.
--
-- ── SAFE UPSERT CONDITION (Part 4/5/7) ────────────────────────────────────
-- INSERT ... ON CONFLICT (user_id, lead_id) DO UPDATE ... WHERE
--   item_leads.source_updated_at < EXCLUDED.source_updated_at
-- Logical identity is (user_id, lead_id). An equal timestamp updates
-- nothing (idempotent retry), an older one updates nothing, and the whole
-- decision is made by the database — never by the TypeScript caller.
--
-- ── NO DELETE PATH ────────────────────────────────────────────────────────
-- Nothing here deletes, soft-deletes, or status-flags an item_leads row.
-- A lead absent from the sheet is simply not mentioned by the import.

-- ─── 1. item_leads: source state may only change when the source is newer ──
-- Independent of the upsert's own WHERE guard above: even a direct
-- service_role UPDATE cannot rewrite a lead's source-mirrored state
-- without presenting a strictly newer source_updated_at. Internal-only
-- changes (last_imported_at, updated_at) are unaffected.

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
      NEW.status, NEW.outcome_reason, NEW.notes)
     IS DISTINCT FROM
     (OLD.inventory_item_id, OLD.lead_id, OLD.first_contact_at, OLD.last_contact_at,
      OLD.source_channel, OLD.deal_channel_id, OLD.buyer_message_count, OLD.our_message_count,
      OLD.lead_quality, OLD.offer_type, OLD.initial_cash_offer, OLD.best_cash_offer,
      OLD.trade_item, OLD.cash_component, OLD.trade_est_value,
      OLD.status, OLD.outcome_reason, OLD.notes)
  THEN
    RAISE EXCEPTION
      'item_leads source state cannot change unless source_updated_at advances (stored %, incoming %)',
      OLD.source_updated_at, NEW.source_updated_at;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_item_leads_require_newer_source
  BEFORE UPDATE ON public.item_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.item_leads_require_newer_source();

GRANT EXECUTE ON FUNCTION public.item_leads_require_newer_source() TO service_role;

COMMENT ON FUNCTION public.item_leads_require_newer_source() IS
  'Rejects any UPDATE that changes a source-mirrored item_leads column '
  'without a strictly newer source_updated_at. The database-level twin of '
  'apply_lead_import_batch()''s own upsert guard, so the invariant holds '
  'even for a direct service_role write.';

-- ─── 2. start_lead_import_run ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.start_lead_import_run(
  p_source_id            bigint,
  p_requested_by_user_id int,
  p_stale_after          interval DEFAULT interval '15 minutes'
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- 0x4C454144 = 'LEAD'. A dedicated advisory-lock class so these keys can
  -- never collide with 20260826000000's single-argument
  -- pg_advisory_xact_lock(analytics_run_id) space.
  c_lock_class constant int := 1279413828;
  v_user_id    int;
  v_enabled    boolean;
  v_run_id     bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_users u WHERE u.id = p_requested_by_user_id AND u.admin) THEN
    RAISE EXCEPTION 'REQUESTER_NOT_ADMIN';
  END IF;

  PERFORM pg_advisory_xact_lock(c_lock_class, p_source_id::int);

  SELECT s.user_id, s.is_enabled INTO v_user_id, v_enabled
  FROM public.lead_import_sources s
  WHERE s.id = p_source_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_NOT_FOUND';
  END IF;
  IF NOT v_enabled THEN
    RAISE EXCEPTION 'SOURCE_DISABLED';
  END IF;

  -- Reap a run whose server died between the claim and its result. Without
  -- this a crashed import would wedge the source as permanently RUNNING.
  UPDATE public.lead_import_runs r
     SET status        = 'FAILED',
         completed_at  = now(),
         error_summary = COALESCE(
           r.error_summary,
           'Abandoned: the import process stopped before recording a result. No leads were written.')
   WHERE r.source_id = p_source_id
     AND r.status    = 'RUNNING'
     AND r.started_at < now() - p_stale_after;

  IF EXISTS (SELECT 1 FROM public.lead_import_runs r WHERE r.source_id = p_source_id AND r.status = 'RUNNING') THEN
    RAISE EXCEPTION 'IMPORT_ALREADY_RUNNING';
  END IF;

  INSERT INTO public.lead_import_runs (source_id, user_id, requested_by_user_id, status)
  VALUES (p_source_id, v_user_id, p_requested_by_user_id, 'RUNNING')
  RETURNING id INTO v_run_id;

  RETURN v_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_lead_import_run(bigint, int, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_lead_import_run(bigint, int, interval) TO service_role;

COMMENT ON FUNCTION public.start_lead_import_run(bigint, int, interval) IS
  'Claims the single RUNNING import slot for one source and returns the new '
  'lead_import_runs.id. Raises IMPORT_ALREADY_RUNNING when another import '
  'of the same source is in flight, SOURCE_NOT_FOUND/SOURCE_DISABLED for an '
  'unusable source, and REQUESTER_NOT_ADMIN when the requester is not an '
  'admin. service_role only; the target user_id is always read from '
  'lead_import_sources, never supplied by the caller.';

-- ─── 3. apply_lead_import_batch ─────────────────────────────────────────────

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

    INSERT INTO public.item_leads (
      user_id, source_id, inventory_item_id, lead_id,
      first_contact_at, last_contact_at, source_channel, deal_channel_id,
      buyer_message_count, our_message_count, lead_quality, offer_type,
      initial_cash_offer, best_cash_offer, trade_item, cash_component, trade_est_value,
      status, outcome_reason, notes, source_updated_at,
      created_at, updated_at, last_imported_at
    ) VALUES (
      v_user_id, v_source_id, v_row.inventory_item_id, v_row.lead_id,
      v_row.first_contact_at, v_row.last_contact_at, v_row.source_channel, v_row.deal_channel_id,
      v_row.buyer_message_count, v_row.our_message_count, v_row.lead_quality, v_row.offer_type,
      v_row.initial_cash_offer, v_row.best_cash_offer, v_row.trade_item, v_row.cash_component, v_row.trade_est_value,
      v_row.status, v_row.outcome_reason, v_row.notes, v_row.source_updated_at,
      now(), now(), now()
    )
    ON CONFLICT (user_id, lead_id) DO UPDATE SET
      -- Whole-row replacement, never a per-field merge: a newer source row
      -- is the authoritative current representation of the lead, so a
      -- blanked optional cell legitimately becomes NULL here.
      -- id and created_at are deliberately absent — they are preserved.
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
  -- Part 11: last_source_updated_at_seen is exactly the MAX validly parsed
  -- source updated_at observed in THIS read (not now(), and not a running
  -- high-water mark) — and is never used to filter a later scan. When the
  -- read produced no parseable timestamp at all, the previous value is
  -- kept rather than erased. In a FAILED run this statement never
  -- commits, so a failure can never advance it.
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

REVOKE ALL ON FUNCTION public.apply_lead_import_batch(bigint, jsonb, jsonb, int, int, int, int, int, int, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_lead_import_batch(bigint, jsonb, jsonb, int, int, int, int, int, int, timestamptz) TO service_role;

COMMENT ON FUNCTION public.apply_lead_import_batch(bigint, jsonb, jsonb, int, int, int, int, int, int, timestamptz) IS
  'Applies one import run''s valid NEW/UPDATE rows, writes every row''s '
  'audit record, finalizes the run and advances the source metadata — all '
  'in a single transaction, so a failure anywhere leaves no partially '
  'applied batch. Upsert identity is (user_id, lead_id) and an existing '
  'lead is only overwritten when the incoming source_updated_at is '
  'strictly newer. Never deletes. service_role only.';

-- ─── 4. fail_lead_import_run ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fail_lead_import_run(
  p_run_id                bigint,
  p_error_summary         text,
  p_audit_rows            jsonb,
  p_source_row_count      int,
  p_new_count             int,
  p_update_count          int,
  p_unchanged_count       int,
  p_source_older_count    int,
  p_invalid_count         int,
  p_failed_count          int,
  p_source_max_updated_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_status text;
BEGIN
  SELECT r.status INTO v_run_status
  FROM public.lead_import_runs r
  WHERE r.id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND';
  END IF;

  -- Already finalized (a double-report, or a run reaped as abandoned):
  -- leave the recorded outcome exactly as it stands.
  IF v_run_status <> 'RUNNING' THEN
    RETURN jsonb_build_object('run_id', p_run_id, 'status', v_run_status, 'changed', false);
  END IF;

  -- Deliberately runs AFTER a rolled-back apply, so no audit row for this
  -- run survives — ON CONFLICT DO NOTHING only guards against a repeated
  -- report of the same failure.
  INSERT INTO public.lead_import_run_rows (
    import_run_id, sheet_row_number, lead_id, inventory_item_id,
    source_updated_at, classification, result, issue_codes, issue_message
  )
  SELECT
    p_run_id, a.sheet_row_number, a.lead_id, a.inventory_item_id,
    a.source_updated_at, a.classification, a.result,
    COALESCE(a.issue_codes, '{}'::text[]), a.issue_message
  FROM jsonb_to_recordset(COALESCE(p_audit_rows, '[]'::jsonb)) AS a(
    sheet_row_number   int,
    lead_id            uuid,
    inventory_item_id  bigint,
    source_updated_at  timestamptz,
    classification     text,
    result             text,
    issue_codes        text[],
    issue_message      text
  )
  ON CONFLICT (import_run_id, sheet_row_number) DO NOTHING;

  UPDATE public.lead_import_runs r SET
    status                = 'FAILED',
    completed_at          = now(),
    source_row_count      = p_source_row_count,
    new_count             = p_new_count,
    update_count          = p_update_count,
    unchanged_count       = p_unchanged_count,
    source_older_count    = p_source_older_count,
    invalid_count         = p_invalid_count,
    inserted_count        = 0,
    updated_count         = 0,
    failed_count          = p_failed_count,
    source_max_updated_at = p_source_max_updated_at,
    error_summary         = left(COALESCE(NULLIF(btrim(p_error_summary), ''), 'Import failed.'), 2000)
  WHERE r.id = p_run_id;

  RETURN jsonb_build_object('run_id', p_run_id, 'status', 'FAILED', 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fail_lead_import_run(bigint, text, jsonb, int, int, int, int, int, int, int, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_lead_import_run(bigint, text, jsonb, int, int, int, int, int, int, int, timestamptz) TO service_role;

COMMENT ON FUNCTION public.fail_lead_import_run(bigint, text, jsonb, int, int, int, int, int, int, int, timestamptz) IS
  'Records a failed import attempt in a fresh transaction after '
  'apply_lead_import_batch() rolled back (or after the source could not be '
  'read at all). Never touches item_leads and never advances '
  'lead_import_sources'' successful-import metadata, so a retry is always '
  'safe. service_role only.';
