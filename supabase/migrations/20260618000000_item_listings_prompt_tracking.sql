-- Replace prompt_version (loose text) with proper relational tracking:
--   ai_prompt_id  → FK to ai_prompts.id (which row was active at generation time)
--   prompt_snapshot → the exact prompt_text used, preserved even after future edits

ALTER TABLE public.item_listings
  DROP COLUMN IF EXISTS prompt_version;

ALTER TABLE public.item_listings
  ADD COLUMN ai_prompt_id   bigint REFERENCES public.ai_prompts(id) ON DELETE SET NULL,
  ADD COLUMN prompt_snapshot text;
