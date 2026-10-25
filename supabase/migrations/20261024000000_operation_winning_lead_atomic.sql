-- Operation winning lead, atomic: Sell / Trade + winning-lead link + neutral
-- close of the other OPEN leads in ONE transaction, with correct provenance.
--
-- Before: the operation RPC committed first; its item-unavailable trigger
-- closed EVERY open lead (winner included: a false OPEN -> CLOSED /
-- ITEM_UNAVAILABLE event), then a second request linked the winner
-- (CLOSED -> COMPLETED). Lead writes from the operation UI were stamped
-- last_write_source = 'MCP'.
--
-- Now, when the user picks a winning lead on a NEW Sell / Trade:
--   1. the server reserves the deal id (reserve_deal_id) and plans the lead
--      mutation in application code (src/lib/leads/leadWriteService.ts — the
--      single source of lead rules) against that id;
--   2. create_operation_with_winning_lead runs, in one transaction: consume
--      the caller's reservation -> transaction-local settings (deal id,
--      winning lead id) -> the UNCHANGED create_sell_operation /
--      create_trade_operation (the deal row takes the reserved id via
--      trg_deals_assign_reserved_id; the auto-close trigger skips the winner)
--      -> apply_lead_interaction(planned request) (DEAL_LINKED +
--      OPEN/AGREED -> COMPLETED). Any failure rolls everything back.
-- SQL still enforces invariants only — no lead classification here.
--
-- Provenance: apply_lead_interaction now takes write_source from the
-- server-built request, limited to 'MCP' (default) or 'UI'; SHEET / SYSTEM /
-- BACKFILL can never be claimed through it. The MCP tools never set it.

-- ─── 1. Deal id reservations (owned by the caller, single use) ────────────

CREATE TABLE public.deal_id_reservations (
  deal_id    bigint      PRIMARY KEY,
  user_id    int         NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.deal_id_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON public.deal_id_reservations FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.deal_id_reservations TO service_role;

COMMENT ON TABLE public.deal_id_reservations IS
  'Single-use deal ids reserved by reserve_deal_id() so the winning-lead mutation can be planned before the operation exists. '
  'Only touched through reserve_deal_id / consume_deal_id_reservation. An unused reservation is a harmless sequence gap.';

CREATE OR REPLACE FUNCTION public.reserve_deal_id()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid int := public.get_app_user_id();
  v_id  bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  DELETE FROM public.deal_id_reservations WHERE created_at < now() - interval '1 day';
  v_id := nextval(pg_get_serial_sequence('public.deals', 'id'));
  INSERT INTO public.deal_id_reservations (deal_id, user_id) VALUES (v_id, v_uid);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_deal_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_deal_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.consume_deal_id_reservation(p_deal_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.deal_id_reservations r
  WHERE r.deal_id = p_deal_id AND r.user_id = public.get_app_user_id();
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_deal_id_reservation(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_deal_id_reservation(bigint) TO authenticated;

-- ─── 2. The operation's deal row takes the reserved id ────────────────────
-- Only while create_operation_with_winning_lead has set the transaction-local
-- app.operation_deal_id; the setting is cleared after the first deal row, so
-- every other insert keeps its normal identity value.

CREATE OR REPLACE FUNCTION public.deals_assign_reserved_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_id bigint := NULLIF(current_setting('app.operation_deal_id', true), '')::bigint;
BEGIN
  IF v_id IS NOT NULL THEN
    NEW.id := v_id;
    PERFORM set_config('app.operation_deal_id', '', true);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_assign_reserved_id
  BEFORE INSERT ON public.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.deals_assign_reserved_id();

-- ─── 3. Auto-close skips the operation's winning lead ─────────────────────
-- Verbatim from 20261021000000 except the winner exemption (transaction-local
-- app.operation_winning_lead_id, set only by create_operation_with_winning_lead,
-- which then completes that lead in the same transaction).

CREATE OR REPLACE FUNCTION public.item_leads_close_on_item_unavailable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lead   record;
  v_winner bigint := NULLIF(current_setting('app.operation_winning_lead_id', true), '')::bigint;
BEGIN
  FOR v_lead IN
    SELECT il.id, il.user_id FROM public.item_leads il
    WHERE il.user_id = NEW.user_id AND il.inventory_item_id = NEW.id AND il.status = 'OPEN'
      AND il.id IS DISTINCT FROM v_winner
    FOR UPDATE
  LOOP
    INSERT INTO public.lead_events (
      user_id, item_lead_id, event_type, direction, occurred_at, occurred_at_precision, summary,
      payload, provenance, actor, source, content_hash
    ) VALUES (
      v_lead.user_id, v_lead.id, 'STATUS_CHANGE', 'INTERNAL', clock_timestamp(), 'TIME',
      'Item ' || NEW.status || ' — open lead closed as ITEM_UNAVAILABLE',
      jsonb_build_object('from', 'OPEN', 'to', 'CLOSED', 'outcome_reason', 'ITEM_UNAVAILABLE',
                         'trigger', 'AUTO_ITEM_UNAVAILABLE', 'item_status', NEW.status),
      'SYSTEM', 'SYSTEM', 'SYSTEM', md5('auto-close:' || v_lead.id::text || ':' || clock_timestamp()::text)
    );
    UPDATE public.item_leads il SET
      status = 'CLOSED', outcome_reason = 'ITEM_UNAVAILABLE', waiting_on = 'NONE',
      last_write_source = 'SYSTEM', updated_at = now()
    WHERE il.id = v_lead.id;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ─── 4. apply_lead_interaction: write_source from the server-built request ──
-- Verbatim from 20261021000000 except v_write_source ('MCP' default, or 'UI').

CREATE OR REPLACE FUNCTION public.apply_lead_interaction(p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid          int;
  v_mode         text := p_request->>'mode';
  v_mutation_id  uuid := (p_request->>'mutation_id')::uuid;
  v_lead         public.item_leads%ROWTYPE;
  v_lead_id      bigint;
  v_snap         jsonb := COALESCE(p_request->'snapshot', '{}'::jsonb);
  v_l            jsonb := COALESCE(p_request->'lead', '{}'::jsonb);
  v_existing     record;
  v_ev           jsonb;
  v_event_ids    bigint[] := '{}';
  v_new_id       bigint;
  v_item_id      bigint;
  v_deal_id      bigint;
  v_void_count   int;
  v_write_source text := CASE WHEN p_request->>'write_source' = 'UI' THEN 'UI' ELSE 'MCP' END;
BEGIN
  v_uid := public.get_app_user_id();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF v_mode NOT IN ('create', 'update', 'void') OR v_mutation_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: mode and mutation_id are required';
  END IF;

  -- ── Idempotency (race-safe second check; the service checks first) ────
  IF v_mode = 'void' THEN
    SELECT e.item_lead_id INTO v_existing FROM public.lead_events e
    WHERE e.user_id = v_uid AND e.voided_by_mutation_id = v_mutation_id LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'REPLAY', 'lead_id', v_existing.item_lead_id);
    END IF;
  ELSE
    SELECT e.item_lead_id, e.applied_changes, e.request_hash INTO v_existing FROM public.lead_events e
    WHERE e.user_id = v_uid AND e.mutation_id = v_mutation_id AND e.mutation_seq = 0;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'REPLAY', 'lead_id', v_existing.item_lead_id,
        'result', v_existing.applied_changes, 'request_hash', v_existing.request_hash,
        'event_ids', (SELECT jsonb_agg(e.id ORDER BY e.mutation_seq) FROM public.lead_events e
                      WHERE e.user_id = v_uid AND e.mutation_id = v_mutation_id));
    END IF;
  END IF;

  -- ── Resolve / create the lead ─────────────────────────────────────────
  IF v_mode = 'create' THEN
    v_item_id := (v_l->>'inventory_item_id')::bigint;
    IF NOT EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = v_item_id AND i.user_id = v_uid) THEN
      RAISE EXCEPTION 'ITEM_NOT_FOUND';
    END IF;
    IF (v_l->>'deal_channel_id') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.deal_channels dc
      WHERE dc.id = (v_l->>'deal_channel_id')::bigint AND lower(dc.name) = lower(btrim(COALESCE(v_l->>'source_channel', '')))
    ) THEN
      RAISE EXCEPTION 'INVALID_CHANNEL';
    END IF;

    -- Serialize concurrent creates of the same relationship, then re-check.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      v_uid::text || ':' || v_item_id::text || ':' || lower(COALESCE(v_l->>'source_channel', '')) || ':' ||
      lower(btrim(COALESCE(v_l->>'channel_detail', ''))) || ':' || COALESCE(v_l->>'contact_key', ''), 0));
    IF (v_l->>'contact_key') IS NOT NULL AND COALESCE((p_request->>'force_new')::boolean, false) = false AND EXISTS (
      SELECT 1 FROM public.item_leads il
      WHERE il.user_id = v_uid AND il.inventory_item_id = v_item_id
        AND lower(btrim(COALESCE(il.source_channel, ''))) = lower(btrim(COALESCE(v_l->>'source_channel', '')))
        AND lower(btrim(COALESCE(il.channel_detail, ''))) = lower(btrim(COALESCE(v_l->>'channel_detail', '')))
        AND il.contact_key = v_l->>'contact_key'
    ) THEN
      RETURN jsonb_build_object('status', 'CONFLICT', 'reason', 'LEAD_CREATED_CONCURRENTLY');
    END IF;

    INSERT INTO public.item_leads (
      user_id, source_id, inventory_item_id, lead_id, source_channel, deal_channel_id, channel_detail,
      contact_name, contact_name_source, contact_key, lead_quality, offer_type, status, notes,
      source_updated_at, origin, last_write_source
    ) VALUES (
      v_uid, NULL, v_item_id, gen_random_uuid(), v_l->>'source_channel', (v_l->>'deal_channel_id')::bigint,
      NULLIF(btrim(v_l->>'channel_detail'), ''),
      NULLIF(btrim(v_l->>'contact_name'), ''), CASE WHEN NULLIF(btrim(v_l->>'contact_name'), '') IS NOT NULL THEN 'DIRECT' END,
      v_l->>'contact_key', NULL, 'NONE', 'OPEN', NULL,
      clock_timestamp(), 'DIRECT', v_write_source
    )
    RETURNING * INTO v_lead;
  ELSE
    SELECT * INTO v_lead FROM public.item_leads il
    WHERE il.id = (p_request->>'lead_id')::bigint AND il.user_id = v_uid
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'NOT_FOUND');
    END IF;
    IF (p_request->>'expected_version') IS NULL OR v_lead.version <> (p_request->>'expected_version')::int THEN
      RETURN jsonb_build_object('status', 'CONFLICT', 'reason', 'VERSION_MISMATCH', 'current_version', v_lead.version);
    END IF;
  END IF;
  v_lead_id := v_lead.id;

  -- ── Void ──────────────────────────────────────────────────────────────
  IF v_mode = 'void' THEN
    UPDATE public.lead_events e
       SET voided_at = now(),
           void_reason = COALESCE(NULLIF(btrim(p_request->>'void_reason'), ''), 'voided'),
           voided_by_mutation_id = v_mutation_id
     WHERE e.user_id = v_uid AND e.item_lead_id = v_lead_id AND e.voided_at IS NULL
       AND e.event_type <> 'LEGACY_SNAPSHOT'
       AND e.id IN (SELECT (x)::bigint FROM jsonb_array_elements_text(COALESCE(p_request->'void_event_ids', '[]'::jsonb)) x);
    GET DIAGNOSTICS v_void_count = ROW_COUNT;
    IF v_void_count = 0 THEN
      RAISE EXCEPTION 'EVENT_NOT_FOUND';
    END IF;
  ELSE
    -- Monotonic peak stage (only a void may lower it).
    IF v_mode = 'update' AND v_lead.peak_stage IS NOT NULL
       AND public.lead_stage_rank(v_snap->>'peak_stage') < public.lead_stage_rank(v_lead.peak_stage) THEN
      RAISE EXCEPTION 'PEAK_STAGE_REGRESSION';
    END IF;

    IF jsonb_array_length(COALESCE(p_request->'events', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION 'VALIDATION_ERROR: at least one event is required';
    END IF;

    FOR v_ev IN SELECT * FROM jsonb_array_elements(p_request->'events') LOOP
      IF v_ev->>'event_type' = 'LEGACY_SNAPSHOT' AND (v_ev->>'source' <> 'SYSTEM' OR v_ev->>'actor' <> 'SYSTEM') THEN
        RAISE EXCEPTION 'VALIDATION_ERROR: LEGACY_SNAPSHOT is system-only';
      END IF;
      IF v_ev->>'event_type' = 'DEAL_LINKED' THEN
        v_deal_id := (v_ev->'payload'->>'deal_id')::bigint;
        IF NOT EXISTS (
          SELECT 1 FROM public.deals d
          JOIN public.deal_items di ON di.deal_id = d.id AND di.direction = 'out' AND di.item_id = v_lead.inventory_item_id
          WHERE d.id = v_deal_id AND d.user_id = v_uid AND d.deal_type IN ('sale', 'trade')
        ) THEN
          RAISE EXCEPTION 'DEAL_NOT_VALID';
        END IF;
      END IF;

      INSERT INTO public.lead_events (
        user_id, item_lead_id, event_type, direction, occurred_at, occurred_at_precision, summary, message_count,
        expects_reply, payload, payload_version, provenance, actor, source, client_label,
        mutation_id, mutation_seq, request_hash, content_hash, applied_changes
      ) VALUES (
        v_uid, v_lead_id, v_ev->>'event_type', v_ev->>'direction', (v_ev->>'occurred_at')::timestamptz,
        COALESCE(v_ev->>'occurred_at_precision', 'TIME'), v_ev->>'summary', COALESCE((v_ev->>'message_count')::smallint, 0),
        COALESCE((v_ev->>'expects_reply')::boolean, false), COALESCE(v_ev->'payload', '{}'::jsonb), 1,
        v_ev->>'provenance', v_ev->>'actor', v_ev->>'source', NULLIF(v_ev->>'client_label', ''),
        v_mutation_id, (v_ev->>'mutation_seq')::smallint, p_request->>'request_hash', v_ev->>'content_hash',
        CASE WHEN (v_ev->>'mutation_seq')::int = 0 THEN p_request->'result' END
      )
      RETURNING id INTO v_new_id;
      v_event_ids := v_event_ids || v_new_id;
    END LOOP;
  END IF;

  -- ── Snapshot (derived by application code; invariants enforced by CHECKs) ──
  UPDATE public.item_leads il SET
    first_contact_at        = (v_snap->>'first_contact_at')::date,
    last_contact_at         = (v_snap->>'last_contact_at')::date,
    buyer_message_count     = (v_snap->>'buyer_message_count')::int,
    our_message_count       = (v_snap->>'our_message_count')::int,
    offer_type              = COALESCE(v_snap->>'offer_type', il.offer_type),
    initial_cash_offer      = (v_snap->>'initial_cash_offer')::numeric,
    best_cash_offer         = (v_snap->>'best_cash_offer')::numeric,
    latest_cash_offer       = (v_snap->>'latest_cash_offer')::numeric,
    trade_item              = v_snap->>'trade_item',
    cash_component          = (v_snap->>'cash_component')::numeric,
    trade_est_value         = (v_snap->>'trade_est_value')::numeric,
    offer_is_concrete       = (v_snap->>'offer_is_concrete')::boolean,
    offer_assessment        = v_snap->>'offer_assessment',
    offer_assessment_source = v_snap->>'offer_assessment_source',
    status                  = COALESCE(v_snap->>'status', il.status),
    outcome_reason          = v_snap->>'outcome_reason',
    deal_id                 = (v_snap->>'deal_id')::bigint,
    peak_stage              = v_snap->>'peak_stage',
    peak_stage_source       = v_snap->>'peak_stage_source',
    peak_stage_at           = (v_snap->>'peak_stage_at')::timestamptz,
    negotiation_rounds      = COALESCE((v_snap->>'negotiation_rounds')::smallint, 0),
    last_inbound_at         = (v_snap->>'last_inbound_at')::timestamptz,
    last_outbound_at        = (v_snap->>'last_outbound_at')::timestamptz,
    waiting_on              = v_snap->>'waiting_on',
    unanswered_followups    = COALESCE((v_snap->>'unanswered_followups')::smallint, 0),
    reopen_count            = COALESCE((v_snap->>'reopen_count')::smallint, 0),
    semantics_version       = (v_snap->>'semantics_version')::smallint,
    -- A name may be added to a lead that has none; an existing name is never replaced.
    contact_name            = COALESCE(il.contact_name, NULLIF(btrim(v_l->>'contact_name'), '')),
    contact_name_source     = CASE WHEN il.contact_name IS NULL AND NULLIF(btrim(v_l->>'contact_name'), '') IS NOT NULL
                                   THEN 'DIRECT' ELSE il.contact_name_source END,
    contact_key             = CASE WHEN il.contact_name IS NULL AND NULLIF(btrim(v_l->>'contact_name'), '') IS NOT NULL
                                   THEN v_l->>'contact_key' ELSE il.contact_key END,
    source_updated_at       = GREATEST(il.source_updated_at, clock_timestamp()),
    last_write_source       = v_write_source,
    updated_at              = now()
  WHERE il.id = v_lead_id;

  RETURN jsonb_build_object('status', 'OK', 'lead_id', v_lead_id, 'version', (SELECT il.version FROM public.item_leads il WHERE il.id = v_lead_id),
    'event_ids', to_jsonb(v_event_ids));
END;
$$;

-- ─── 5. Operation + winning lead in one transaction ───────────────────────
-- p_kind 'sale' | 'trade'; p_operation = the named arguments of
-- create_sell_operation / create_trade_operation; p_lead_request = the
-- apply_lead_interaction request planned by application code against
-- p_deal_id (mode 'update', a DEAL_LINKED event on that deal). SECURITY
-- INVOKER: the operation RPC runs under the caller's RLS exactly as when the
-- form calls it directly.

CREATE OR REPLACE FUNCTION public.create_operation_with_winning_lead(
  p_kind         text,
  p_deal_id      bigint,
  p_operation    jsonb,
  p_lead_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      int := public.get_app_user_id();
  v_lead_id  bigint := (p_lead_request->>'lead_id')::bigint;
  v_mutation uuid := (p_lead_request->>'mutation_id')::uuid;
  v_op       jsonb;
  v_link     jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('sale', 'trade') OR p_deal_id IS NULL OR v_lead_id IS NULL OR v_mutation IS NULL
     OR p_lead_request->>'mode' IS DISTINCT FROM 'update' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: kind, deal id, lead id, mutation id and an update request are required';
  END IF;

  -- Retried after a commit whose response was lost: return the saved result.
  IF EXISTS (SELECT 1 FROM public.lead_events e WHERE e.user_id = v_uid AND e.mutation_id = v_mutation) THEN
    RETURN jsonb_build_object('status', 'REPLAY', 'lead_id', v_lead_id,
      'deal_id', (SELECT il.deal_id FROM public.item_leads il WHERE il.id = v_lead_id AND il.user_id = v_uid));
  END IF;

  IF NOT public.consume_deal_id_reservation(p_deal_id) THEN
    RAISE EXCEPTION 'DEAL_RESERVATION_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.item_leads il WHERE il.id = v_lead_id AND il.user_id = v_uid) THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;

  PERFORM set_config('app.operation_deal_id', p_deal_id::text, true);
  PERFORM set_config('app.operation_winning_lead_id', v_lead_id::text, true);

  IF p_kind = 'sale' THEN
    v_op := public.create_sell_operation(
      p_deal_date      => (p_operation->>'p_deal_date')::date,
      p_channel_id     => (p_operation->>'p_channel_id')::bigint,
      p_items          => p_operation->'p_items',
      p_notes          => p_operation->>'p_notes',
      p_cf_description => p_operation->>'p_cf_description');
  ELSE
    v_op := public.create_trade_operation(
      p_deal_date           => (p_operation->>'p_deal_date')::date,
      p_channel_id          => (p_operation->>'p_channel_id')::bigint,
      p_notes               => p_operation->>'p_notes',
      p_cash_paid           => COALESCE((p_operation->>'p_cash_paid')::numeric, 0),
      p_cash_received       => COALESCE((p_operation->>'p_cash_received')::numeric, 0),
      p_outgoing_items      => p_operation->'p_outgoing_items',
      p_incoming_items      => p_operation->'p_incoming_items',
      p_cf_transaction_date => (p_operation->>'p_cf_transaction_date')::date,
      p_cf_description      => p_operation->>'p_cf_description');
  END IF;

  PERFORM set_config('app.operation_deal_id', '', true);
  PERFORM set_config('app.operation_winning_lead_id', '', true);

  IF (v_op->>'deal_id')::bigint IS DISTINCT FROM p_deal_id THEN
    RAISE EXCEPTION 'DEAL_RESERVATION_NOT_APPLIED';
  END IF;

  v_link := public.apply_lead_interaction(p_lead_request);
  IF v_link->>'status' IS DISTINCT FROM 'OK' THEN
    -- CONFLICT / NOT_FOUND / REPLAY: undo the operation too.
    RAISE EXCEPTION 'LEAD_LINK_%: %', COALESCE(v_link->>'status', 'FAILED'), COALESCE(v_link->>'reason', '');
  END IF;

  RETURN jsonb_build_object('status', 'OK', 'deal_id', p_deal_id, 'cf_id', v_op->'cf_id', 'lead', v_link);
END;
$$;

REVOKE ALL ON FUNCTION public.create_operation_with_winning_lead(text, bigint, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_operation_with_winning_lead(text, bigint, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.create_operation_with_winning_lead(text, bigint, jsonb, jsonb) IS
  'New Sell / Trade with a chosen winning lead: operation + DEAL_LINKED (-> COMPLETED) + neutral close of the other OPEN leads, one transaction. '
  'The lead mutation is planned by application code (leadWriteService) against a reserve_deal_id() id.';
