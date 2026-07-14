-- Normalize ai_prompts.category text → category_id FK to item_categories.

-- 1. Add nullable FK column
ALTER TABLE public.ai_prompts
  ADD COLUMN category_id bigint REFERENCES public.item_categories(id);

-- 2. Backfill explicit matches (singular AI names → plural item_categories names)
UPDATE public.ai_prompts
  SET category_id = (SELECT id FROM public.item_categories WHERE name = 'Guitars')
  WHERE category = 'Guitar';

UPDATE public.ai_prompts
  SET category_id = (SELECT id FROM public.item_categories WHERE name = 'Amps')
  WHERE category = 'Amp';

UPDATE public.ai_prompts
  SET category_id = (SELECT id FROM public.item_categories WHERE name = 'Pedals')
  WHERE category = 'Pedal';

-- 3. Report unmatched rows (Cabinet and Other have no matching item_categories row)
DO $$
DECLARE
  unmatched_count integer;
BEGIN
  SELECT COUNT(*) INTO unmatched_count
    FROM public.ai_prompts
    WHERE category_id IS NULL;

  IF unmatched_count > 0 THEN
    RAISE NOTICE '% ai_prompts row(s) have category_id = NULL — Cabinet and Other have no matching item_categories row. These rows are orphaned.', unmatched_count;
  END IF;
END $$;

-- 4. Drop old text-based unique constraint
ALTER TABLE public.ai_prompts
  DROP CONSTRAINT IF EXISTS ai_prompts_user_category_channel_key;

-- 5. Add new FK-based unique constraint
--    NULLs (orphaned Cabinet/Other rows) are treated as distinct by PG, so the
--    constraint does not affect them.
ALTER TABLE public.ai_prompts
  ADD CONSTRAINT ai_prompts_user_category_id_channel_key
  UNIQUE (user_id, category_id, deal_channel_id);

-- 6. Drop old text column
ALTER TABLE public.ai_prompts
  DROP COLUMN category;
