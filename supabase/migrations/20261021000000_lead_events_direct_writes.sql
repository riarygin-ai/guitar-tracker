-- Direct lead writes, part 1: item_leads snapshot fields, append-only
-- lead_events, the single authenticated write function, and the neutral
-- auto-close when an item leaves inventory.
--
-- ── MODEL ────────────────────────────────────────────────────────────────
-- item_leads  = current materialized state of one lead relationship.
-- lead_events = append-only chronological history (what actually happened).
-- Every event-backed snapshot field is DERIVED by application code
-- (src/lib/leads/classification.ts, SEMANTICS_VERSION) from the latest
-- LEGACY_SNAPSHOT baseline + the events after it, and written here in the
-- SAME transaction as the events. SQL enforces invariants only (vocabulary,
-- ownership, idempotency, append-only, monotonic peak stage, optimistic
-- concurrency) — it never re-implements the stage rules.
--
-- ── WRITE PATH ───────────────────────────────────────────────────────────
-- authenticated has SELECT only on both tables. The ONLY write path is
-- public.apply_lead_interaction(jsonb) — SECURITY DEFINER, identity resolved
-- internally via get_app_user_id(), never a caller-supplied user. The Lead
-- Log importer keeps its own service_role-only path (apply_lead_import_batch,
-- see 20261021000001 for its coexistence guards).
--
-- ── LEGACY ───────────────────────────────────────────────────────────────
-- lead_quality becomes legacy/historical: nullable, never written by direct
-- writes (CHECK: only DIRECT-origin rows may lack it). Notes stay as legacy
-- text: direct writes never modify item_leads.notes.

-- ─── 0. Small immutable helpers (vocabulary invariants, not classification) ──

CREATE OR REPLACE FUNCTION public.lead_stage_rank(p_stage text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_stage
    WHEN 'INQUIRY' THEN 1 WHEN 'ENGAGED' THEN 2 WHEN 'NEGOTIATING' THEN 3
    WHEN 'HIGH_INTENT' THEN 4 WHEN 'CONVERTED' THEN 5 ELSE 0 END
$$;

-- Negotiating+ (replaces legacy Serious+) and High Intent+. While peak_stage
-- is NULL (a row not yet backfilled) the documented legacy mapping applies.
CREATE OR REPLACE FUNCTION public.lead_is_negotiating_plus(p_peak_stage text, p_lead_quality text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_peak_stage IS NOT NULL
              THEN p_peak_stage IN ('NEGOTIATING', 'HIGH_INTENT', 'CONVERTED')
              ELSE COALESCE(p_lead_quality IN ('SERIOUS', 'HIGH_INTENT'), false) END
$$;

CREATE OR REPLACE FUNCTION public.lead_is_high_intent_plus(p_peak_stage text, p_lead_quality text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_peak_stage IS NOT NULL
              THEN p_peak_stage IN ('HIGH_INTENT', 'CONVERTED')
              ELSE COALESCE(p_lead_quality = 'HIGH_INTENT', false) END
$$;

GRANT EXECUTE ON FUNCTION public.lead_stage_rank(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lead_is_negotiating_plus(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lead_is_high_intent_plus(text, text) TO authenticated, service_role;

-- ─── 1. item_leads: new snapshot columns ──────────────────────────────────

ALTER TABLE public.item_leads
  ADD COLUMN origin                  text        NOT NULL DEFAULT 'SHEET',
  ADD COLUMN last_write_source       text        NOT NULL DEFAULT 'SHEET',
  ADD COLUMN channel_detail          text,
  ADD COLUMN contact_key             text,
  ADD COLUMN peak_stage              text,
  ADD COLUMN peak_stage_source       text,
  ADD COLUMN peak_stage_at           timestamptz,
  ADD COLUMN negotiation_rounds      smallint    NOT NULL DEFAULT 0,
  ADD COLUMN latest_cash_offer       numeric(12,2),
  ADD COLUMN offer_is_concrete       boolean,
  ADD COLUMN offer_assessment        text,
  ADD COLUMN offer_assessment_source text,
  ADD COLUMN last_inbound_at         timestamptz,
  ADD COLUMN last_outbound_at        timestamptz,
  ADD COLUMN waiting_on              text,
  ADD COLUMN unanswered_followups    smallint    NOT NULL DEFAULT 0,
  ADD COLUMN reopen_count            smallint    NOT NULL DEFAULT 0,
  ADD COLUMN version                 integer     NOT NULL DEFAULT 1,
  ADD COLUMN semantics_version       smallint;

ALTER TABLE public.item_leads ALTER COLUMN lead_quality DROP NOT NULL;
ALTER TABLE public.item_leads ALTER COLUMN source_id DROP NOT NULL;

ALTER TABLE public.item_leads
  ADD CONSTRAINT item_leads_origin_check CHECK (origin IN ('SHEET', 'DIRECT')),
  ADD CONSTRAINT item_leads_last_write_source_check CHECK (last_write_source IN ('SHEET', 'MCP', 'UI', 'SYSTEM', 'BACKFILL')),
  ADD CONSTRAINT item_leads_legacy_quality_check CHECK (lead_quality IS NOT NULL OR origin = 'DIRECT'),
  ADD CONSTRAINT item_leads_source_required_check CHECK (source_id IS NOT NULL OR origin = 'DIRECT'),
  ADD CONSTRAINT item_leads_channel_detail_check CHECK (
    channel_detail IS NULL
    OR (length(btrim(channel_detail)) BETWEEN 1 AND 80 AND source_channel IN ('Other', 'Regular Buyer / Seller'))
  ),
  ADD CONSTRAINT item_leads_peak_stage_check CHECK (peak_stage IS NULL OR peak_stage IN ('INQUIRY', 'ENGAGED', 'NEGOTIATING', 'HIGH_INTENT', 'CONVERTED')),
  ADD CONSTRAINT item_leads_peak_stage_source_check CHECK (
    (peak_stage IS NULL AND peak_stage_source IS NULL)
    OR (peak_stage IS NOT NULL AND peak_stage_source IN ('DERIVED', 'LEGACY_AUDIT', 'LEGACY_STRUCTURED'))
  ),
  ADD CONSTRAINT item_leads_negotiation_rounds_check CHECK (negotiation_rounds >= 0),
  ADD CONSTRAINT item_leads_latest_cash_offer_check CHECK (latest_cash_offer IS NULL OR (latest_cash_offer >= 0 AND offer_type = 'CASH')),
  ADD CONSTRAINT item_leads_offer_assessment_check CHECK (
    (offer_assessment IS NULL AND offer_assessment_source IS NULL)
    OR (offer_assessment IN ('ACCEPTABLE', 'NEAR', 'FAR_BELOW', 'NOT_RELEVANT')
        AND offer_assessment_source IN ('USER', 'AI', 'COMPUTED'))
  ),
  ADD CONSTRAINT item_leads_waiting_on_check CHECK (waiting_on IS NULL OR waiting_on IN ('BUYER', 'US', 'NONE')),
  ADD CONSTRAINT item_leads_followups_check CHECK (unanswered_followups >= 0),
  ADD CONSTRAINT item_leads_reopen_count_check CHECK (reopen_count >= 0),
  ADD CONSTRAINT item_leads_id_user_unique UNIQUE (id, user_id);

-- Status / outcome: neutral CLOSED + two neutral reasons, tied together.
ALTER TABLE public.item_leads DROP CONSTRAINT item_leads_status_check;
ALTER TABLE public.item_leads ADD CONSTRAINT item_leads_status_check
  CHECK (status IN ('OPEN', 'GHOSTED', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'AGREED', 'FAILED_AFTER_AGREEMENT', 'COMPLETED', 'CLOSED'));
ALTER TABLE public.item_leads DROP CONSTRAINT item_leads_outcome_reason_check;
ALTER TABLE public.item_leads ADD CONSTRAINT item_leads_outcome_reason_check
  CHECK (outcome_reason IS NULL OR outcome_reason IN (
    'LOW_OFFER', 'TRADE_NOT_INTERESTING', 'PRICE', 'CONDITION', 'LOGISTICS', 'NO_SHOW', 'CHANGED_MIND', 'FOUND_ANOTHER', 'UNKNOWN',
    'ITEM_UNAVAILABLE', 'INACTIVE'));
ALTER TABLE public.item_leads ADD CONSTRAINT item_leads_closed_reason_check
  CHECK ((status = 'CLOSED') = (outcome_reason IS NOT NULL AND outcome_reason IN ('ITEM_UNAVAILABLE', 'INACTIVE')));

ALTER TABLE public.item_leads DROP CONSTRAINT item_leads_contact_name_source_check;
ALTER TABLE public.item_leads ADD CONSTRAINT item_leads_contact_name_source_check CHECK (
  (contact_name IS NULL AND contact_name_source IS NULL)
  OR (contact_name IS NOT NULL AND contact_name_source IS NOT NULL
      AND contact_name_source IN ('LEAD_LOG', 'NOTES_PREFIX_V1', 'DIRECT'))
);

CREATE INDEX idx_item_leads_user_item_contact_key ON public.item_leads (user_id, inventory_item_id, contact_key);
CREATE INDEX idx_item_leads_user_contact_key ON public.item_leads (user_id, contact_key) WHERE contact_key IS NOT NULL;

COMMENT ON COLUMN public.item_leads.lead_quality IS
  'LEGACY (Lead Log) subjective quality — historical only. Never written by direct writes (NULL on DIRECT-origin leads). Superseded by peak_stage.';
COMMENT ON COLUMN public.item_leads.peak_stage IS
  'Highest observable stage reached (INQUIRY/ENGAGED/NEGOTIATING/HIGH_INTENT/CONVERTED) — see src/lib/leads/semantics.ts. Provenance in peak_stage_source.';
COMMENT ON COLUMN public.item_leads.offer_type IS
  'Shape of the LATEST BUYER offer (NONE/CASH/TRADE/MIXED). Offer/counter chronology lives in lead_events; final terms live in the deal.';
COMMENT ON COLUMN public.item_leads.cash_component IS
  'Latest buyer cash term on a TRADE/MIXED offer, signed (+ to us, - from us). NULL on MIXED = amount not stated. Semantics enforced by item_leads_offer_cash_semantics_check.';
COMMENT ON COLUMN public.item_leads.trade_est_value IS 'OUR resale estimate of the latest incoming package — never the buyer''s claimed value.';
COMMENT ON COLUMN public.item_leads.initial_cash_offer IS 'Derived compatibility field: first buyer cash-only amount ever observed.';
COMMENT ON COLUMN public.item_leads.best_cash_offer IS 'Derived compatibility field: highest buyer cash-only amount ever observed.';
COMMENT ON COLUMN public.item_leads.notes IS 'Legacy Lead Log narrative. Preserved verbatim; direct writes never modify it (new information enters as lead_events).';
COMMENT ON COLUMN public.item_leads.contact_key IS 'Strong match key for contact_name (normalized, parenthetical qualifiers KEPT). Written by application code.';
COMMENT ON COLUMN public.item_leads.reopen_count IS 'Objective count of reopen transitions (returning buyer reopened a declined/ghosted/inactive lead). Not a time-threshold metric.';
COMMENT ON COLUMN public.item_leads.version IS 'Optimistic-concurrency counter, incremented by trg_item_leads_version on every UPDATE.';

-- ─── 2. Version counter + newer-source guard limited to Sheet writes ─────

CREATE OR REPLACE FUNCTION public.item_leads_bump_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_item_leads_version
  BEFORE UPDATE ON public.item_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.item_leads_bump_version();

-- The Lead Log's "source state only changes when updated_at advances" rule
-- governs SHEET writes only. Direct/system/backfill writes are governed by
-- version + the event log instead.
CREATE OR REPLACE FUNCTION public.item_leads_require_newer_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.last_write_source <> 'SHEET' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_updated_at > OLD.source_updated_at THEN
    RETURN NEW;
  END IF;

  IF (NEW.inventory_item_id, NEW.lead_id, NEW.first_contact_at, NEW.last_contact_at,
      NEW.source_channel, NEW.deal_channel_id, NEW.buyer_message_count, NEW.our_message_count,
      NEW.lead_quality, NEW.offer_type, NEW.initial_cash_offer, NEW.best_cash_offer,
      NEW.trade_item, NEW.cash_component, NEW.trade_est_value,
      NEW.status, NEW.outcome_reason, NEW.notes, NEW.deal_id, NEW.contact_name)
     IS DISTINCT FROM
     (OLD.inventory_item_id, OLD.lead_id, OLD.first_contact_at, OLD.last_contact_at,
      OLD.source_channel, OLD.deal_channel_id, OLD.buyer_message_count, OLD.our_message_count,
      OLD.lead_quality, OLD.offer_type, OLD.initial_cash_offer, OLD.best_cash_offer,
      OLD.trade_item, OLD.cash_component, OLD.trade_est_value,
      OLD.status, OLD.outcome_reason, OLD.notes, OLD.deal_id, OLD.contact_name)
  THEN
    RAISE EXCEPTION
      'item_leads source state cannot change unless source_updated_at advances (stored %, incoming %)',
      OLD.source_updated_at, NEW.source_updated_at;
  END IF;

  RETURN NEW;
END;
$$;

-- The legacy "quality never decreases" trigger only fires when lead_quality
-- changes between two non-null values.
CREATE OR REPLACE FUNCTION public.item_leads_prevent_quality_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rank jsonb := '{"LOW": 1, "ENGAGED": 2, "SERIOUS": 3, "HIGH_INTENT": 4}'::jsonb;
BEGIN
  IF OLD.lead_quality IS NOT NULL AND NEW.lead_quality IS NULL THEN
    RAISE EXCEPTION 'legacy lead_quality cannot be cleared';
  END IF;
  IF OLD.lead_quality IS NOT NULL AND NEW.lead_quality IS NOT NULL
     AND (v_rank->>NEW.lead_quality)::int < (v_rank->>OLD.lead_quality)::int THEN
    RAISE EXCEPTION 'lead_quality cannot decrease (was %, attempted %)', OLD.lead_quality, NEW.lead_quality;
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 3. lead_events (append-only) ─────────────────────────────────────────

CREATE TABLE public.lead_events (
  id                     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                int         NOT NULL REFERENCES public.app_users(id),
  item_lead_id           bigint      NOT NULL,
  event_type             text        NOT NULL,
  direction              text        NOT NULL,
  occurred_at            timestamptz NOT NULL,
  occurred_at_precision  text        NOT NULL DEFAULT 'TIME',
  summary                text        NOT NULL,
  message_count          smallint    NOT NULL DEFAULT 0,
  expects_reply          boolean     NOT NULL DEFAULT false,
  payload                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  payload_version        smallint    NOT NULL DEFAULT 1,
  provenance             text        NOT NULL,
  actor                  text        NOT NULL,
  source                 text        NOT NULL,
  client_label           text,
  mutation_id            uuid,
  mutation_seq           smallint,
  request_hash           text,
  content_hash           text        NOT NULL,
  applied_changes        jsonb,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  voided_at              timestamptz,
  void_reason            text,
  voided_by_mutation_id  uuid,

  CONSTRAINT lead_events_lead_owner_fk FOREIGN KEY (item_lead_id, user_id)
    REFERENCES public.item_leads(id, user_id) ON DELETE CASCADE,
  CONSTRAINT lead_events_type_check CHECK (event_type IN
    ('MESSAGE', 'OFFER', 'AGREEMENT', 'LOGISTICS', 'STATUS_CHANGE', 'DEAL_LINKED', 'NOTE', 'LEGACY_SNAPSHOT')),
  CONSTRAINT lead_events_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND', 'INTERNAL')),
  CONSTRAINT lead_events_type_direction_check CHECK (
    CASE event_type
      WHEN 'MESSAGE' THEN direction <> 'INTERNAL'
      WHEN 'OFFER'   THEN direction <> 'INTERNAL'
      WHEN 'STATUS_CHANGE' THEN direction = 'INTERNAL'
      WHEN 'DEAL_LINKED' THEN direction = 'INTERNAL'
      WHEN 'NOTE' THEN direction = 'INTERNAL'
      WHEN 'LEGACY_SNAPSHOT' THEN direction = 'INTERNAL'
      ELSE true
    END),
  CONSTRAINT lead_events_precision_check CHECK (occurred_at_precision IN ('TIME', 'DATE')),
  CONSTRAINT lead_events_summary_check CHECK (length(btrim(summary)) BETWEEN 1 AND 1000),
  CONSTRAINT lead_events_message_count_check CHECK (message_count BETWEEN 0 AND 50 AND (direction <> 'INTERNAL' OR message_count = 0)),
  CONSTRAINT lead_events_expects_reply_check CHECK (direction <> 'INTERNAL' OR expects_reply = false),
  CONSTRAINT lead_events_payload_check CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 16384),
  CONSTRAINT lead_events_provenance_check CHECK (provenance IN ('OBSERVED', 'STATED', 'INFERRED', 'LEGACY', 'SYSTEM')),
  CONSTRAINT lead_events_actor_check CHECK (actor IN ('USER', 'AI', 'SYSTEM')),
  CONSTRAINT lead_events_source_check CHECK (source IN ('MCP', 'UI', 'SYSTEM', 'BACKFILL')),
  CONSTRAINT lead_events_legacy_snapshot_source_check CHECK (event_type <> 'LEGACY_SNAPSHOT' OR source IN ('SYSTEM', 'BACKFILL')),
  CONSTRAINT lead_events_client_label_check CHECK (client_label IS NULL OR length(client_label) <= 64),
  CONSTRAINT lead_events_mutation_check CHECK ((mutation_id IS NULL) = (mutation_seq IS NULL)),
  CONSTRAINT lead_events_void_check CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

CREATE INDEX idx_lead_events_lead_time ON public.lead_events (item_lead_id, occurred_at, id);
CREATE INDEX idx_lead_events_lead_content ON public.lead_events (item_lead_id, content_hash);
CREATE INDEX idx_lead_events_user ON public.lead_events (user_id);
CREATE UNIQUE INDEX idx_lead_events_mutation ON public.lead_events (user_id, mutation_id, mutation_seq) WHERE mutation_id IS NOT NULL;
CREATE INDEX idx_lead_events_void_mutation ON public.lead_events (user_id, voided_by_mutation_id) WHERE voided_by_mutation_id IS NOT NULL;

COMMENT ON TABLE public.lead_events IS
  'Append-only lead history. Rows are never updated except to set the void markers once; never deleted. '
  'Snapshot fields on item_leads are derived from the latest LEGACY_SNAPSHOT + later unvoided events '
  '(src/lib/leads/classification.ts). Written only by apply_lead_interaction / the item auto-close trigger / the backfill.';
COMMENT ON COLUMN public.lead_events.expects_reply IS
  'Event-level: does this message/offer/step leave the other side owing a reply? Drives waiting_on, unanswered follow-ups and ghosting preconditions.';
COMMENT ON COLUMN public.lead_events.applied_changes IS 'On mutation_seq 0 only: the machine-readable result of the mutation, replayed verbatim on retry.';

-- Append-only enforcement: the only permitted UPDATE sets the void markers once.
CREATE OR REPLACE FUNCTION public.lead_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only service_role (account deletion, local test cleanup, cascades from a
    -- service_role lead delete) may remove history; no app path does.
    -- (FK cascades run as the table owner, hence postgres.)
    IF current_user IN ('service_role', 'postgres') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'lead_events is append-only (delete refused)';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'lead_events row % is already voided', OLD.id;
  END IF;
  IF NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - 'voided_at' - 'void_reason' - 'voided_by_mutation_id')
        IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'void_reason' - 'voided_by_mutation_id') THEN
    RAISE EXCEPTION 'lead_events is append-only (only the void markers may be set, once)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lead_events_append_only
  BEFORE UPDATE OR DELETE ON public.lead_events
  FOR EACH ROW
  EXECUTE FUNCTION public.lead_events_append_only();

ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_events: select own"
  ON public.lead_events FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

REVOKE ALL PRIVILEGES ON public.lead_events FROM anon;
REVOKE ALL PRIVILEGES ON public.lead_events FROM authenticated;
GRANT SELECT ON public.lead_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_events TO service_role;
REVOKE ALL PRIVILEGES ON SEQUENCE public.lead_events_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.lead_events_id_seq TO service_role;

-- ─── 4. apply_lead_interaction — the single authenticated write path ─────
--
-- p_request (built by src/lib/leads/leadWriteService.ts):
--   mode            'create' | 'update' | 'void'
--   mutation_id     uuid      (idempotency key; required)
--   request_hash    text
--   lead_id         bigint    (update/void)
--   expected_version int      (update/void)
--   force_new       boolean   (create: user explicitly chose CREATE_NEW)
--   lead            { inventory_item_id, source_channel, deal_channel_id, channel_detail, contact_name, contact_key }
--   snapshot        { every derived snapshot field }
--   events          [ { event_type, direction, occurred_at, occurred_at_precision, summary, message_count,
--                       expects_reply, payload, provenance, actor, source, client_label, mutation_seq, content_hash } ]
--   void_event_ids  [bigint]  (void)
--   void_reason     text      (void)
--   result          jsonb     (stored on mutation_seq 0 for replay)
-- Returns { status: OK | REPLAY | CONFLICT | NOT_FOUND, ... }. Business
-- validation failures RAISE (whole transaction rolled back, nothing written).

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
      clock_timestamp(), 'DIRECT', 'MCP'
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
    last_write_source       = 'MCP',
    updated_at              = now()
  WHERE il.id = v_lead_id;

  RETURN jsonb_build_object('status', 'OK', 'lead_id', v_lead_id, 'version', (SELECT il.version FROM public.item_leads il WHERE il.id = v_lead_id),
    'event_ids', to_jsonb(v_event_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_lead_interaction(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_lead_interaction(jsonb) TO authenticated;

COMMENT ON FUNCTION public.apply_lead_interaction(jsonb) IS
  'The only authenticated lead write path (MCP record_lead_interaction / void_lead_event). Identity from get_app_user_id(); '
  'idempotent per (user, mutation_id); optimistic concurrency on item_leads.version; events + snapshot in one transaction.';

-- ─── 5. Neutral auto-close when an item leaves inventory ──────────────────
-- Fires on every path that marks an item sold/traded (sell, multi-item sell,
-- trade, trade edits). OPEN leads → CLOSED / ITEM_UNAVAILABLE with a SYSTEM
-- STATUS_CHANGE event. AGREED leads are left for explicit resolution (the
-- read tools flag them); every other status is never touched. A later
-- DEAL_LINKED on the winning lead moves it to COMPLETED.

CREATE OR REPLACE FUNCTION public.item_leads_close_on_item_unavailable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lead record;
BEGIN
  FOR v_lead IN
    SELECT il.id, il.user_id FROM public.item_leads il
    WHERE il.user_id = NEW.user_id AND il.inventory_item_id = NEW.id AND il.status = 'OPEN'
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

REVOKE ALL ON FUNCTION public.item_leads_close_on_item_unavailable() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_item_leads_close_on_item_unavailable
  AFTER UPDATE OF status ON public.inventory_items
  FOR EACH ROW
  WHEN (NEW.status IN ('sold', 'traded') AND OLD.status IS DISTINCT FROM NEW.status AND OLD.status NOT IN ('sold', 'traded'))
  EXECUTE FUNCTION public.item_leads_close_on_item_unavailable();
