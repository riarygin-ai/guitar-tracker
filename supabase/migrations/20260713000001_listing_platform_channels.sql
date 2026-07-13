DO $$
DECLARE
  v_reverb_id      bigint;
  v_marketplace_id bigint;
  v_kijiji_id      bigint;
  v_unmatched      bigint;
BEGIN
  SELECT id INTO v_reverb_id      FROM public.deal_channels WHERE name = 'Reverb'      LIMIT 1;
  SELECT id INTO v_marketplace_id FROM public.deal_channels WHERE name = 'Marketplace' LIMIT 1;
  SELECT id INTO v_kijiji_id      FROM public.deal_channels WHERE name = 'Kijiji'      LIMIT 1;

  IF v_reverb_id IS NULL OR v_marketplace_id IS NULL OR v_kijiji_id IS NULL THEN
    RAISE EXCEPTION 'Required deal_channels rows (Reverb, Marketplace, Kijiji) not found. Run the deal_channels migration first.';
  END IF;

  -- ── item_listings ────────────────────────────────────────────────────────────

  ALTER TABLE public.item_listings
    ADD COLUMN deal_channel_id bigint REFERENCES public.deal_channels(id);

  UPDATE public.item_listings
  SET deal_channel_id = CASE listing_type
    WHEN 'reverb'      THEN v_reverb_id
    WHEN 'marketplace' THEN v_marketplace_id
    WHEN 'kijiji'      THEN v_kijiji_id
  END;

  SELECT COUNT(*) INTO v_unmatched
  FROM public.item_listings
  WHERE deal_channel_id IS NULL;

  IF v_unmatched > 0 THEN
    RAISE WARNING 'item_listings: % rows have unrecognized listing_type values', v_unmatched;
    RAISE EXCEPTION 'item_listings backfill incomplete: % rows unmatched. Aborting.', v_unmatched;
  END IF;

  ALTER TABLE public.item_listings ALTER COLUMN deal_channel_id SET NOT NULL;

  ALTER TABLE public.item_listings
    DROP CONSTRAINT IF EXISTS item_listings_listing_type_check,
    DROP CONSTRAINT IF EXISTS item_listings_unique_per_item;

  ALTER TABLE public.item_listings DROP COLUMN listing_type;

  -- ── ai_prompts ───────────────────────────────────────────────────────────────

  ALTER TABLE public.ai_prompts
    ADD COLUMN deal_channel_id bigint REFERENCES public.deal_channels(id);

  UPDATE public.ai_prompts
  SET deal_channel_id = CASE listing_type
    WHEN 'reverb'      THEN v_reverb_id
    WHEN 'marketplace' THEN v_marketplace_id
    WHEN 'kijiji'      THEN v_kijiji_id
  END;

  SELECT COUNT(*) INTO v_unmatched
  FROM public.ai_prompts
  WHERE deal_channel_id IS NULL;

  IF v_unmatched > 0 THEN
    RAISE WARNING 'ai_prompts: % rows have unrecognized listing_type values', v_unmatched;
    RAISE EXCEPTION 'ai_prompts backfill incomplete: % rows unmatched. Aborting.', v_unmatched;
  END IF;

  ALTER TABLE public.ai_prompts ALTER COLUMN deal_channel_id SET NOT NULL;

  ALTER TABLE public.ai_prompts
    DROP CONSTRAINT IF EXISTS ai_prompts_user_category_listing_key;

  ALTER TABLE public.ai_prompts DROP COLUMN listing_type;

  ALTER TABLE public.ai_prompts
    ADD CONSTRAINT ai_prompts_user_category_channel_key
      UNIQUE (user_id, category, deal_channel_id);

END $$;
