-- Direct lead writes, part 4: one-time historical backfill function.
--
-- Called ONLY by scripts/backfill-lead-semantics.ts (service_role, offline —
-- never MCP), after a reviewed dry-run report. All rows are applied in ONE
-- transaction; a lead that already has a LEGACY_SNAPSHOT is skipped, so the
-- function is idempotent and can be re-run safely.
--
-- Per lead (values computed by application code — src/lib/leads/classification.ts
-- and the read-only classification audit data in scripts/data/):
--   * peak_stage + provenance (LEGACY_AUDIT where the 2026-10-21 audit
--     classified the lead, LEGACY_STRUCTURED otherwise), negotiation_rounds,
--     offer_is_concrete, latest_cash_offer, contact_key, semantics_version;
--   * optional restoration of a parenthetical contact-name qualifier that the
--     20261020 notes-prefix backfill stripped — applied only if the stored
--     name still equals the expected old value;
--   * exactly ONE LEGACY_SNAPSHOT event preserving the legacy baseline (no
--     reconstructed chronology — historical prose stays in item_leads.notes);
--   * OPEN leads whose item is already sold/traded → CLOSED / ITEM_UNAVAILABLE
--     with a BACKFILL STATUS_CHANGE event (re-verified here at apply time).
-- legacy lead_quality, notes and every other legacy column are untouched.

CREATE OR REPLACE FUNCTION public.apply_lead_semantics_backfill_v1(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row        jsonb;
  v_lead       public.item_leads%ROWTYPE;
  v_set        jsonb;
  v_applied    int := 0;
  v_skipped    int := 0;
  v_closed     int := 0;
  v_renamed    int := 0;
  v_new_name   text;
  v_close      boolean;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    SELECT * INTO v_lead FROM public.item_leads il WHERE il.id = (v_row->>'lead_id')::bigint FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BACKFILL_LEAD_NOT_FOUND: %', v_row->>'lead_id';
    END IF;
    IF EXISTS (SELECT 1 FROM public.lead_events e WHERE e.item_lead_id = v_lead.id AND e.event_type = 'LEGACY_SNAPSHOT') THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_set := v_row->'set';

    -- Qualifier restoration, guarded by the expected current value.
    v_new_name := NULL;
    IF v_row ? 'restore_contact_name' AND v_lead.contact_name = v_row->'restore_contact_name'->>'from' THEN
      v_new_name := v_row->'restore_contact_name'->>'to';
      v_renamed := v_renamed + 1;
    END IF;

    INSERT INTO public.lead_events (
      user_id, item_lead_id, event_type, direction, occurred_at, occurred_at_precision, summary,
      payload, provenance, actor, source, content_hash
    ) VALUES (
      v_lead.user_id, v_lead.id, 'LEGACY_SNAPSHOT', 'INTERNAL', (v_row->'snapshot_event'->>'occurred_at')::timestamptz, 'DATE',
      v_row->'snapshot_event'->>'summary', v_row->'snapshot_event'->'payload', 'LEGACY', 'SYSTEM', 'BACKFILL',
      v_row->'snapshot_event'->>'content_hash'
    );

    v_close := COALESCE((v_row->>'close_item_unavailable')::boolean, false) AND v_lead.status = 'OPEN'
      AND EXISTS (SELECT 1 FROM public.inventory_items i WHERE i.id = v_lead.inventory_item_id AND i.status IN ('sold', 'traded'));
    IF v_close THEN
      INSERT INTO public.lead_events (
        user_id, item_lead_id, event_type, direction, occurred_at, occurred_at_precision, summary,
        payload, provenance, actor, source, content_hash
      ) VALUES (
        v_lead.user_id, v_lead.id, 'STATUS_CHANGE', 'INTERNAL', clock_timestamp(), 'TIME',
        'Backfill: item already sold/traded — open lead closed as ITEM_UNAVAILABLE',
        jsonb_build_object('from', 'OPEN', 'to', 'CLOSED', 'outcome_reason', 'ITEM_UNAVAILABLE', 'trigger', 'BACKFILL_ITEM_UNAVAILABLE'),
        'SYSTEM', 'SYSTEM', 'BACKFILL', md5('backfill-close:' || v_lead.id::text)
      );
      v_closed := v_closed + 1;
    END IF;

    UPDATE public.item_leads il SET
      peak_stage         = v_set->>'peak_stage',
      peak_stage_source  = v_set->>'peak_stage_source',
      negotiation_rounds = COALESCE((v_set->>'negotiation_rounds')::smallint, 0),
      offer_is_concrete  = (v_set->>'offer_is_concrete')::boolean,
      latest_cash_offer  = (v_set->>'latest_cash_offer')::numeric,
      contact_name       = COALESCE(v_new_name, il.contact_name),
      contact_key        = v_set->>'contact_key',
      semantics_version  = (v_set->>'semantics_version')::smallint,
      status             = CASE WHEN v_close THEN 'CLOSED' ELSE il.status END,
      outcome_reason     = CASE WHEN v_close THEN 'ITEM_UNAVAILABLE' ELSE il.outcome_reason END,
      waiting_on         = CASE WHEN v_close THEN 'NONE' ELSE il.waiting_on END,
      last_write_source  = 'BACKFILL',
      updated_at         = now()
    WHERE il.id = v_lead.id;
    v_applied := v_applied + 1;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'skipped_already_backfilled', v_skipped, 'closed_item_unavailable', v_closed, 'contact_names_restored', v_renamed);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_lead_semantics_backfill_v1(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_lead_semantics_backfill_v1(jsonb) TO service_role;
