-- Contact city = contact-associated LOCATION EVIDENCE with provenance and history.
--
-- Corrects the meaning of item_leads.contact_city (20261029000000): it is the
-- current / best observed city associated with the contact — shown on their own
-- Marketplace/Kijiji listing (LISTING), their profile (PROFILE), stated in their
-- message (MESSAGE) or entered by the user (MANUAL). It is NOT a proven
-- residence, and never the user's own listing location, a meeting / pickup /
-- delivery place or a travel destination.
--
--   item_leads.contact_city_source   provenance of the current snapshot city
--                                    (NULL = unknown: recorded before sources existed)
--   lead_contact_locations           every observation (city, source, when) — the
--                                    history used for matching; never overwritten
--
-- A different city is NOT a conflict and not evidence of a different person
-- (another listing location, profile change, relocation, neighbouring market):
-- the new observation is added to the history and the snapshot follows the
-- newest observation (application policy, src/lib/leads/leadWriteService.ts
-- planContact). Phone conflict semantics are unchanged.
--
-- Written only through apply_lead_interaction (SECURITY DEFINER, resolves the
-- caller itself). authenticated may only SELECT its own rows. No backfill: the
-- three existing production cities keep a NULL source until the user decides.

ALTER TABLE public.item_leads
  ADD COLUMN contact_city_source text;

ALTER TABLE public.item_leads
  ADD CONSTRAINT item_leads_contact_city_source_check CHECK (
    contact_city_source IS NULL OR (contact_city_source IN ('LISTING', 'PROFILE', 'MESSAGE', 'MANUAL') AND contact_city IS NOT NULL));

COMMENT ON COLUMN public.item_leads.contact_city IS
  'Current / best observed city associated with the contact (their own listing, profile, message, or entered by the user). '
  'Location evidence for matching — not a proven residence; never a meeting place, travel destination or the user''s own listing location. '
  'History of all observations: lead_contact_locations.';
COMMENT ON COLUMN public.item_leads.contact_city_source IS
  'Where the current contact_city was observed: LISTING | PROFILE | MESSAGE | MANUAL. NULL = unknown provenance.';

CREATE TABLE public.lead_contact_locations (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           int         NOT NULL REFERENCES public.app_users(id),
  item_lead_id      bigint      NOT NULL,
  city              text        NOT NULL,
  -- Comparison key from src/lib/leads/contactDetails.ts cityKey (case, accents, ", ON" ignored).
  city_key          text        NOT NULL,
  source            text,
  -- A short safe reference ("Kijiji listing", "Marketplace profile"); never copied message content.
  source_context    text,
  -- First / latest time this (city, source) was observed. NULL only for a city carried over
  -- from a snapshot recorded before history existed (time unknown).
  observed_at       timestamptz,
  last_observed_at  timestamptz,
  mutation_id       uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lead_contact_locations_lead_owner_fk FOREIGN KEY (item_lead_id, user_id)
    REFERENCES public.item_leads(id, user_id) ON DELETE CASCADE,
  CONSTRAINT lead_contact_locations_city_check CHECK (length(city) BETWEEN 1 AND 80 AND city = btrim(city)),
  CONSTRAINT lead_contact_locations_city_key_check CHECK (length(city_key) BETWEEN 1 AND 80 AND city_key = lower(city_key)),
  CONSTRAINT lead_contact_locations_source_check CHECK (source IS NULL OR source IN ('LISTING', 'PROFILE', 'MESSAGE', 'MANUAL')),
  CONSTRAINT lead_contact_locations_context_check CHECK (
    source_context IS NULL OR (length(source_context) BETWEEN 1 AND 80 AND source_context = btrim(source_context))),
  CONSTRAINT lead_contact_locations_observed_check CHECK (
    (observed_at IS NULL AND last_observed_at IS NULL) OR (observed_at IS NOT NULL AND last_observed_at >= observed_at))
);

-- One observation row per lead / city / source (NULL source = one "unknown" row).
CREATE UNIQUE INDEX lead_contact_locations_lead_city_source_key
  ON public.lead_contact_locations (item_lead_id, city_key, COALESCE(source, ''));
-- Historical city matching per user (find_contact_history, direct-write matching).
CREATE INDEX idx_lead_contact_locations_user_city ON public.lead_contact_locations (user_id, city_key);

COMMENT ON TABLE public.lead_contact_locations IS
  'Every observed contact-associated city per lead, with provenance. item_leads.contact_city is the current snapshot; this is the history. '
  'Identity evidence only (supportive, never proof); a different city never means a different person.';

ALTER TABLE public.lead_contact_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lead_contact_locations: select own"
  ON public.lead_contact_locations FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

REVOKE ALL PRIVILEGES ON public.lead_contact_locations FROM anon;
REVOKE ALL PRIVILEGES ON public.lead_contact_locations FROM authenticated;
GRANT SELECT ON public.lead_contact_locations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_contact_locations TO service_role;
REVOKE ALL PRIVILEGES ON SEQUENCE public.lead_contact_locations_id_seq FROM anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.lead_contact_locations_id_seq TO service_role;

-- ─── apply_lead_interaction: city source + location observations ──────────
-- Verbatim from 20261029000000 except v_loc, contact_city_source and the
-- lead_contact_locations loop.

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
  v_c            jsonb := COALESCE(p_request->'contact', '{}'::jsonb);
  v_loc          jsonb;
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
    -- Contact city / phone: set only when the planned request carries the key (enrichment of an
    -- empty field, or a user-confirmed replacement); otherwise untouched.
    contact_city             = CASE WHEN v_c ? 'contact_city' THEN NULLIF(btrim(v_c->>'contact_city'), '') ELSE il.contact_city END,
    -- The city's provenance travels with it (the snapshot is the newest observation; see lead_contact_locations).
    contact_city_source      = CASE WHEN v_c ? 'contact_city' THEN NULLIF(btrim(v_c->>'contact_city_source'), '') ELSE il.contact_city_source END,
    contact_phone            = CASE WHEN v_c ? 'contact_phone' THEN NULLIF(btrim(v_c->>'contact_phone'), '') ELSE il.contact_phone END,
    contact_phone_normalized = CASE WHEN v_c ? 'contact_phone' THEN NULLIF(btrim(v_c->>'contact_phone_normalized'), '') ELSE il.contact_phone_normalized END,
    source_updated_at       = GREATEST(il.source_updated_at, clock_timestamp()),
    last_write_source       = v_write_source,
    updated_at              = now()
  WHERE il.id = v_lead_id;

  -- ── Location observations (history; never deleted or overwritten) ─────
  -- One row per (lead, city key, source); a repeat observation only widens its
  -- observed_at .. last_observed_at range.
  FOR v_loc IN SELECT * FROM jsonb_array_elements(COALESCE(v_c->'locations', '[]'::jsonb)) LOOP
    UPDATE public.lead_contact_locations lc SET
      observed_at      = CASE WHEN lc.observed_at IS NULL THEN (v_loc->>'observed_at')::timestamptz
                              ELSE LEAST(lc.observed_at, (v_loc->>'observed_at')::timestamptz) END,
      last_observed_at = GREATEST(lc.last_observed_at, (v_loc->>'observed_at')::timestamptz),
      source_context   = COALESCE(lc.source_context, NULLIF(btrim(v_loc->>'source_context'), ''))
    WHERE lc.user_id = v_uid AND lc.item_lead_id = v_lead_id
      AND lc.city_key = v_loc->>'city_key'
      AND lc.source IS NOT DISTINCT FROM NULLIF(v_loc->>'source', '');
    IF NOT FOUND THEN
      INSERT INTO public.lead_contact_locations (
        user_id, item_lead_id, city, city_key, source, source_context, observed_at, last_observed_at, mutation_id
      ) VALUES (
        v_uid, v_lead_id, btrim(v_loc->>'city'), v_loc->>'city_key', NULLIF(v_loc->>'source', ''),
        NULLIF(btrim(v_loc->>'source_context'), ''), (v_loc->>'observed_at')::timestamptz, (v_loc->>'observed_at')::timestamptz,
        v_mutation_id
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('status', 'OK', 'lead_id', v_lead_id, 'version', (SELECT il.version FROM public.item_leads il WHERE il.id = v_lead_id),
    'event_ids', to_jsonb(v_event_ids));
END;
$$;

COMMENT ON FUNCTION public.apply_lead_interaction(jsonb) IS
  'Atomic direct lead write (record_lead_interaction / void_lead_event / rename / operation link): events + derived snapshot, '
  'plus optional contact city (with source) / phone and contact location observations from the planned request''s "contact" object.';
