-- Lead contact name: user correction from the Leads detail panel.
--
-- contact_name gains a fourth provenance, USER_EDIT (the user typed / fixed
-- the name in Guitar Tracker), next to LEAD_LOG, NOTES_PREFIX_V1 and DIRECT.
--
-- rename_lead_contact applies, in ONE transaction:
--   1. the apply_lead_interaction request planned by application code
--      (src/lib/leads/leadContactEdit.ts via leadWriteService — the single
--      source of lead rules): an INTERNAL NOTE audit event ("Contact name
--      changed from … to …"), preceded by a fresh LEGACY_SNAPSHOT when the
--      Sheet last wrote the lead; optimistic concurrency on version; the
--      derived snapshot is unchanged (a NOTE without estimate/assessment
--      alters no stage, status, offer or count);
--   2. contact_name / contact_key / contact_name_source = USER_EDIT.
-- contact_key is computed by application code (classification.contactKey —
-- the same normalization the direct-write matcher uses); SQL never derives
-- it. SQL re-checks only the hard invariant: no OTHER lead of this user on the
-- same item + channel + channel detail may already hold the new key.
--
-- Like every direct write, the lead's last_write_source becomes UI, so the
-- Lead Log importer no longer overwrites it (20261021000001 coexistence).

ALTER TABLE public.item_leads DROP CONSTRAINT item_leads_contact_name_source_check;
ALTER TABLE public.item_leads ADD CONSTRAINT item_leads_contact_name_source_check CHECK (
  (contact_name IS NULL AND contact_name_source IS NULL)
  OR (contact_name IS NOT NULL AND contact_name_source IS NOT NULL
      AND contact_name_source IN ('LEAD_LOG', 'NOTES_PREFIX_V1', 'DIRECT', 'USER_EDIT'))
);

COMMENT ON COLUMN public.item_leads.contact_name_source IS
  'Provenance of contact_name: LEAD_LOG (sheet column), NOTES_PREFIX_V1 (notes backfill), DIRECT (first direct write), USER_EDIT (corrected by the user in the app).';

CREATE OR REPLACE FUNCTION public.rename_lead_contact(
  p_request      jsonb,
  p_contact_name text,
  p_contact_key  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      int := public.get_app_user_id();
  v_lead_id  bigint := (p_request->>'lead_id')::bigint;
  v_name     text := NULLIF(btrim(COALESCE(p_contact_name, '')), '');
  v_lead     public.item_leads%ROWTYPE;
  v_conflict bigint;
  v_res      jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  IF v_lead_id IS NULL OR p_request->>'mode' IS DISTINCT FROM 'update' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: an update request for one lead is required';
  END IF;
  IF (v_name IS NULL) <> (p_contact_key IS NULL) OR (v_name IS NOT NULL AND length(v_name) > 120) THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: contact name and key must both be set (max 120 chars) or both be empty';
  END IF;

  SELECT * INTO v_lead FROM public.item_leads il WHERE il.id = v_lead_id AND il.user_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'NOT_FOUND');
  END IF;

  IF p_contact_key IS NOT NULL THEN
    SELECT il.id INTO v_conflict FROM public.item_leads il
    WHERE il.user_id = v_uid AND il.inventory_item_id = v_lead.inventory_item_id AND il.id <> v_lead.id
      AND lower(btrim(COALESCE(il.source_channel, ''))) = lower(btrim(COALESCE(v_lead.source_channel, '')))
      AND lower(btrim(COALESCE(il.channel_detail, ''))) = lower(btrim(COALESCE(v_lead.channel_detail, '')))
      AND il.contact_key = p_contact_key
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'CONTACT_KEY_CONFLICT: lead %', v_conflict;
    END IF;
  END IF;

  v_res := public.apply_lead_interaction(p_request);
  IF v_res->>'status' IS DISTINCT FROM 'OK' THEN
    RETURN v_res; -- CONFLICT / NOT_FOUND / REPLAY: nothing renamed
  END IF;

  UPDATE public.item_leads il SET
    contact_name        = v_name,
    contact_key         = p_contact_key,
    contact_name_source = CASE WHEN v_name IS NULL THEN NULL ELSE 'USER_EDIT' END,
    updated_at          = now()
  WHERE il.id = v_lead_id;

  RETURN v_res || jsonb_build_object('version', (SELECT il.version FROM public.item_leads il WHERE il.id = v_lead_id));
END;
$$;

REVOKE ALL ON FUNCTION public.rename_lead_contact(jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_lead_contact(jsonb, text, text) TO authenticated;

COMMENT ON FUNCTION public.rename_lead_contact(jsonb, text, text) IS
  'User correction of a lead''s contact name (Leads detail panel): planned NOTE audit event + contact_name/contact_key/USER_EDIT in one transaction. '
  'contact_key comes from application code (classification.contactKey).';
