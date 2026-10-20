-- item_leads.contact_name — conservative one-time BACKFILL from historical
-- notes, plus provenance and import protection.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
-- 20261019000000 added item_leads.contact_name for the MCP
-- find_contact_history tool, but every pre-existing lead has it NULL. The
-- historical Lead Log notes already carry the counterparty's name under one
-- deterministic convention, observed in production on 2026-10-19 (352
-- leads, 1 user): 216 notes begin "<display name> — <narrative>" (an em
-- dash, U+2014, with whitespace on both sides), e.g.
--   "Jane Doe — mint rig offered; …"
--   "Nick (collector) — offered LP + $500–1,000; …"
-- The other 136 notes are free prose ("Sam asked the cash price…",
-- "Alex Kim. Previously offered…", "Pat Lee: offered…") and are
-- deliberately NOT parsed: names inside prose are never extracted.
-- Dry run on that data: 210 backfilled (178 distinct names), 142 stay NULL
-- (136 prose + 6 em-dash prefixes rejected by rules 3-4).
--
-- ── EXTRACTION RULES (extract_lead_contact_name_from_notes_v1) ─────────
-- 1. The trimmed note must contain an em dash surrounded by whitespace; the
--    candidate is the text BEFORE THE FIRST such em dash.
-- 2. One trailing parenthetical qualifier is dropped:
--    "Nick (collector)" -> "Nick", "Alex (Km)" -> "Alex".
-- 3. Whitespace is collapsed; the result must be 1-40 characters, 1-4
--    words, start with a letter-like character (not ' . - space), and
--    contain no digits or symbols other than apostrophe, period and hyphen
--    (so "initiated_by=ME. Alex Kim" is rejected). Locale-independent:
--    the check is a deny-list of ASCII digits/symbols, so non-ASCII
--    letters (e.g. "Zoë") are accepted the same on every server.
-- 4. Rejected if any word (case-insensitive) is a role/channel descriptor
--    or a prose connector: anonymous, lead, seller, buyer, collector,
--    trader, dealer, customer, kijiji, marketplace, reverb, facebook, fb,
--    unknown, someone, user, from, for, at, via, and, or, the, re.
--    ("Kijiji Seller", "Anonymous Reverb lead", "Sam Lee from
--    Oakville", "Pizza for Alex Kim" all stay NULL.)
-- Anything not matching stays NULL. Display names are stored as written
-- (lower-case names and shop/profile names included): they are
-- the sender label the user recorded, and matching is case-insensitive.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────
-- - Only rows with contact_name IS NULL are touched; notes are never
--   modified. A non-null contact_name is never overwritten.
-- - Provenance: new contact_name_source column — 'LEAD_LOG' (the structured
--   sheet column) or 'NOTES_PREFIX_V1' (this backfill). Existing non-null
--   names (imported from the sheet) are marked 'LEAD_LOG' first.
-- - The newer-source guard trigger (trg_item_leads_require_newer_source)
--   is disabled ONLY around the backfill UPDATE, inside this migration's
--   transaction, because the backfill intentionally changes contact_name
--   without a newer sheet timestamp. It is re-enabled immediately after.
-- - Re-imports can no longer erase a name: apply_lead_import_batch now
--   writes contact_name = COALESCE(sheet value, existing value). A sheet
--   WITHOUT column T (or with a blank cell) keeps the stored name; a
--   non-blank sheet value always wins and is marked 'LEAD_LOG'. Future
--   imports therefore keep using the structured column.
-- - Audit afterwards:
--     SELECT contact_name_source, count(*) FROM item_leads GROUP BY 1;
--     SELECT id, contact_name, left(notes, 60) FROM item_leads
--      WHERE contact_name_source = 'NOTES_PREFIX_V1' ORDER BY id;

-- ── 1. Pure extraction function (also used by the test suite) ──────────
CREATE OR REPLACE FUNCTION public.extract_lead_contact_name_from_notes_v1(p_notes text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_prefix text;
  v_name   text;
  v_word   text;
BEGIN
  IF p_notes IS NULL THEN
    RETURN NULL;
  END IF;

  -- Rule 1: text before the FIRST whitespace-surrounded em dash.
  v_prefix := substring(btrim(p_notes) FROM '^(.+?)\s+—\s');
  IF v_prefix IS NULL OR strpos(v_prefix, '—') > 0 THEN
    RETURN NULL;
  END IF;

  -- Rule 2: drop one trailing "(qualifier)".
  v_name := btrim(regexp_replace(v_prefix, '\s*\([^()]*\)\s*$', ''));
  -- Rule 3: collapse whitespace, length, allowed characters, first char.
  v_name := regexp_replace(v_name, '\s+', ' ', 'g');
  IF v_name = '' OR length(v_name) > 40 THEN
    RETURN NULL;
  END IF;
  IF v_name ~ '[0-9=;:,!?@#$%&*+/\\<>(){}"|_~^`\[\]]' THEN
    RETURN NULL;
  END IF;
  IF left(v_name, 1) IN ('''', '.', '-', ' ', '’') THEN
    RETURN NULL;
  END IF;
  IF array_length(string_to_array(v_name, ' '), 1) > 4 THEN
    RETURN NULL;
  END IF;

  -- Rule 4: descriptor / connector words.
  FOREACH v_word IN ARRAY string_to_array(lower(v_name), ' ') LOOP
    IF v_word = ANY (ARRAY[
      'anonymous', 'lead', 'seller', 'buyer', 'collector', 'trader', 'dealer', 'customer',
      'kijiji', 'marketplace', 'reverb', 'facebook', 'fb', 'unknown', 'someone', 'user',
      'from', 'for', 'at', 'via', 'and', 'or', 'the', 're'
    ]) THEN
      RETURN NULL;
    END IF;
  END LOOP;

  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.extract_lead_contact_name_from_notes_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extract_lead_contact_name_from_notes_v1(text) TO service_role;

COMMENT ON FUNCTION public.extract_lead_contact_name_from_notes_v1(text) IS
  'Pure, deterministic: the counterparty display name from a historical Lead '
  'Log note of the form "<name> — <narrative>", or NULL when the note does '
  'not follow that convention with high confidence. See migration '
  '20261020000000 for the exact rules. service_role only.';

-- ── 2. Provenance column ────────────────────────────────────────────────
ALTER TABLE public.item_leads
  ADD COLUMN contact_name_source text;

UPDATE public.item_leads SET contact_name_source = 'LEAD_LOG'
WHERE contact_name IS NOT NULL AND contact_name_source IS NULL;

ALTER TABLE public.item_leads
  ADD CONSTRAINT item_leads_contact_name_source_check
  CHECK (
    (contact_name IS NULL AND contact_name_source IS NULL)
    OR (contact_name IS NOT NULL AND contact_name_source IS NOT NULL
        AND contact_name_source IN ('LEAD_LOG', 'NOTES_PREFIX_V1'))
  );

COMMENT ON COLUMN public.item_leads.contact_name_source IS
  'Where contact_name came from: LEAD_LOG (structured Sheet column T) or '
  'NOTES_PREFIX_V1 (one-time backfill from the "<name> — …" notes '
  'convention, migration 20261020000000). NULL exactly when contact_name is NULL.';

-- ── 3. One-time backfill ─────────────────────────────────────────────────
ALTER TABLE public.item_leads DISABLE TRIGGER trg_item_leads_require_newer_source;

-- BEGIN BACKFILL
UPDATE public.item_leads
SET contact_name        = public.extract_lead_contact_name_from_notes_v1(notes),
    contact_name_source = 'NOTES_PREFIX_V1'
WHERE contact_name IS NULL
  AND public.extract_lead_contact_name_from_notes_v1(notes) IS NOT NULL;
-- END BACKFILL

ALTER TABLE public.item_leads ENABLE TRIGGER trg_item_leads_require_newer_source;

-- ── 4. Importer: never erase a stored name; mark sheet names LEAD_LOG ───
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
      status, outcome_reason, notes, deal_id, contact_name, contact_name_source, source_updated_at,
      created_at, updated_at, last_imported_at
    ) VALUES (
      v_user_id, v_source_id, v_row.inventory_item_id, v_row.lead_id,
      v_row.first_contact_at, v_row.last_contact_at, v_row.source_channel, v_row.deal_channel_id,
      v_row.buyer_message_count, v_row.our_message_count, v_row.lead_quality, v_row.offer_type,
      v_row.initial_cash_offer, v_row.best_cash_offer, v_row.trade_item, v_row.cash_component, v_row.trade_est_value,
      v_row.status, v_row.outcome_reason, v_row.notes, v_row.deal_id, v_row.contact_name,
      CASE WHEN v_row.contact_name IS NOT NULL THEN 'LEAD_LOG' END, v_row.source_updated_at,
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
      -- A blank/absent sheet value never erases a stored (e.g. backfilled) name.
      contact_name        = COALESCE(EXCLUDED.contact_name, item_leads.contact_name),
      contact_name_source = CASE WHEN EXCLUDED.contact_name IS NOT NULL THEN 'LEAD_LOG' ELSE item_leads.contact_name_source END,
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
