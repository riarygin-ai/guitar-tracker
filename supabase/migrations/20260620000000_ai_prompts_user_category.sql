-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: ai_prompts — per-user, per-category prompts
--
-- Changes:
--   • Add user_id (FK → app_users), category, listing_type columns
--   • Backfill existing 3 rows: first admin user, category='Guitar'
--   • Drop prompt_key uniqueness (make nullable); add UNIQUE(user_id,category,listing_type)
--   • Replace admin-only write policies with per-user policies
--   • Seed 12 additional category/listing_type combos for the first admin user
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Add new columns (nullable during backfill) ─────────────────────────────

ALTER TABLE public.ai_prompts
  ADD COLUMN user_id      bigint,
  ADD COLUMN category     text,
  ADD COLUMN listing_type text;

-- ── 2. Backfill existing rows → first admin user ──────────────────────────────

UPDATE public.ai_prompts
SET
  user_id      = (SELECT id FROM public.app_users WHERE admin = true ORDER BY id LIMIT 1),
  category     = 'Guitar',
  listing_type = CASE prompt_key
    WHEN 'listing_reverb'      THEN 'reverb'
    WHEN 'listing_marketplace' THEN 'marketplace'
    WHEN 'listing_kijiji'      THEN 'kijiji'
    ELSE LOWER(REPLACE(COALESCE(prompt_key, ''), 'listing_', ''))
  END
WHERE user_id IS NULL;

-- ── 3. FK + NOT NULL ──────────────────────────────────────────────────────────

ALTER TABLE public.ai_prompts
  ADD CONSTRAINT ai_prompts_user_fk
    FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

ALTER TABLE public.ai_prompts
  ALTER COLUMN user_id      SET NOT NULL,
  ALTER COLUMN category     SET NOT NULL,
  ALTER COLUMN listing_type SET NOT NULL;

-- ── 4. Drop prompt_key uniqueness; make nullable (kept for reference) ─────────

ALTER TABLE public.ai_prompts
  DROP CONSTRAINT IF EXISTS ai_prompts_prompt_key_key;

ALTER TABLE public.ai_prompts
  ALTER COLUMN prompt_key DROP NOT NULL;

-- ── 5. New unique constraint: one prompt per user × category × listing_type ───

ALTER TABLE public.ai_prompts
  ADD CONSTRAINT ai_prompts_user_category_listing_key
    UNIQUE (user_id, category, listing_type);

-- ── 6. Replace global/admin-only RLS with per-user policies ──────────────────

DROP POLICY IF EXISTS "ai_prompts: select authenticated" ON public.ai_prompts;
DROP POLICY IF EXISTS "ai_prompts: insert admin"         ON public.ai_prompts;
DROP POLICY IF EXISTS "ai_prompts: update admin"         ON public.ai_prompts;
DROP POLICY IF EXISTS "ai_prompts: delete admin"         ON public.ai_prompts;

CREATE POLICY "ai_prompts: select own"
  ON public.ai_prompts FOR SELECT TO authenticated
  USING (user_id = public.get_app_user_id());

CREATE POLICY "ai_prompts: insert own"
  ON public.ai_prompts FOR INSERT TO authenticated
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "ai_prompts: update own"
  ON public.ai_prompts FOR UPDATE TO authenticated
  USING  (user_id = public.get_app_user_id())
  WITH CHECK (user_id = public.get_app_user_id());

CREATE POLICY "ai_prompts: delete own"
  ON public.ai_prompts FOR DELETE TO authenticated
  USING (user_id = public.get_app_user_id());

-- ── 7. Seed 12 additional combos for the first admin user ────────────────────
-- Guitar × {reverb,marketplace,kijiji} already exist from the backfill above.
-- This adds Amp, Pedal, Cabinet, Other for all three listing types.

DO $$
DECLARE
  admin_id bigint;
BEGIN
  SELECT id INTO admin_id
  FROM public.app_users
  WHERE admin = true
  ORDER BY id
  LIMIT 1;

  IF admin_id IS NULL THEN
    RAISE NOTICE 'No admin user found — skipping non-Guitar seed prompts';
    RETURN;
  END IF;

  INSERT INTO public.ai_prompts
    (user_id, category, listing_type, name, description, prompt_text, model, temperature)
  VALUES

  -- ── Amp ──────────────────────────────────────────────────────────────────
  (admin_id, 'Amp', 'reverb',
   'Amp – Reverb Listing',
   'Reverb.com listing for guitar/bass amplifiers.',
   'Write a Reverb.com listing body for a guitar or bass amplifier (no title needed).
Format: 2–3 focused paragraphs.
Cover: amp type, wattage, and channel configuration; tone controls and notable features; condition including any cosmetic wear; what is included (footswitch, cover, cables).
Tone: professional but approachable — like a knowledgeable gear dealer.
End with a brief, natural invitation to ask questions or discuss shipping.',
   'gpt-4o', 0.65),

  (admin_id, 'Amp', 'marketplace',
   'Amp – Marketplace Post',
   'Facebook Marketplace post for guitar/bass amplifiers.',
   'Write a short Facebook Marketplace post for a guitar or bass amplifier.
Format:
- One direct opening sentence stating what it is
- 3–5 bullet points covering key details (wattage, channels, condition, included accessories)
- "Asking: $X" on its own line if a price is provided
- One closing line about local pickup or shipping
Tone: casual, no filler phrases, under 120 words total.',
   'gpt-4o', 0.65),

  (admin_id, 'Amp', 'kijiji',
   'Amp – Kijiji Ad',
   'Kijiji classified ad for guitar/bass amplifiers.',
   'Write a Kijiji classified ad for a guitar or bass amplifier.
Format: 2–3 short paragraphs — no bullet points.
First: state the amp brand, type, and wattage clearly.
Middle: cover channels, controls, condition, any cosmetic details from seller notes.
End: mention asking price if provided, local pickup, whether shipping is possible.
Tone: casual, honest, matter-of-fact, under 130 words.',
   'gpt-4o', 0.65),

  -- ── Pedal ─────────────────────────────────────────────────────────────────
  (admin_id, 'Pedal', 'reverb',
   'Pedal – Reverb Listing',
   'Reverb.com listing for effects pedals and multi-FX units.',
   'Write a Reverb.com listing body for a guitar or bass effects pedal (no title needed).
Format: 2–3 focused paragraphs.
Cover: effect type and brand; key controls and features; bypass type (true bypass, buffered, or DSP); power requirements; condition and any cosmetic details; what is included (original box, power supply, manual).
Tone: professional but approachable — like a knowledgeable effects dealer.
End with a brief invitation to ask questions.',
   'gpt-4o', 0.65),

  (admin_id, 'Pedal', 'marketplace',
   'Pedal – Marketplace Post',
   'Facebook Marketplace post for effects pedals.',
   'Write a short Facebook Marketplace post for a guitar or bass effects pedal.
Format:
- One direct opening sentence stating what it is
- 3–5 bullet points (effect type, key controls, bypass, power, condition, what is included)
- "Asking: $X" on its own line if a price is provided
- One closing line about local pickup or shipping
Tone: casual, no filler phrases, under 120 words total.',
   'gpt-4o', 0.65),

  (admin_id, 'Pedal', 'kijiji',
   'Pedal – Kijiji Ad',
   'Kijiji classified ad for effects pedals.',
   'Write a Kijiji classified ad for a guitar or bass effects pedal.
Format: 2–3 short paragraphs — no bullet points.
First: state the effect type, brand, and model clearly.
Middle: cover key controls, bypass type, power requirements, condition from seller notes.
End: mention asking price if provided, local pickup, whether shipping is possible.
Tone: casual, honest, under 130 words.',
   'gpt-4o', 0.65),

  -- ── Cabinet ───────────────────────────────────────────────────────────────
  (admin_id, 'Cabinet', 'reverb',
   'Cabinet – Reverb Listing',
   'Reverb.com listing for guitar/bass speaker cabinets.',
   'Write a Reverb.com listing body for a guitar or bass speaker cabinet (no title needed).
Format: 2–3 focused paragraphs.
Cover: cabinet configuration (e.g. 4×12, 2×12), speaker brand and type if known, ohm rating and power handling, condition including cosmetic wear, what is included.
Tone: professional but approachable — like a knowledgeable gear dealer.
End with a brief invitation to ask questions, including about matching heads or shipping logistics.',
   'gpt-4o', 0.65),

  (admin_id, 'Cabinet', 'marketplace',
   'Cabinet – Marketplace Post',
   'Facebook Marketplace post for guitar/bass cabinets.',
   'Write a short Facebook Marketplace post for a guitar or bass speaker cabinet.
Format:
- One direct opening sentence stating what it is
- 3–5 bullet points (configuration, speakers, ohms, condition, any notable details)
- "Asking: $X" on its own line if a price is provided
- One closing line about local pickup (note: cabinets are usually local pickup only due to size and weight)
Tone: casual, no filler phrases, under 120 words total.',
   'gpt-4o', 0.65),

  (admin_id, 'Cabinet', 'kijiji',
   'Cabinet – Kijiji Ad',
   'Kijiji classified ad for guitar/bass cabinets.',
   'Write a Kijiji classified ad for a guitar or bass speaker cabinet.
Format: 2–3 short paragraphs — no bullet points.
First: state the cabinet brand, configuration, and condition clearly.
Middle: mention speakers, ohm rating, any relevant details from seller notes.
End: mention asking price if provided; note that cabinets are typically local pickup due to size and weight.
Tone: casual, honest, under 130 words.',
   'gpt-4o', 0.65),

  -- ── Other ─────────────────────────────────────────────────────────────────
  (admin_id, 'Other', 'reverb',
   'Other – Reverb Listing',
   'Reverb.com listing for other musical gear.',
   'Write a Reverb.com listing body for a piece of musical gear (no title needed).
Format: 2–3 focused paragraphs.
Cover: what the item is and its purpose; key features and specifications from the seller notes; condition including any cosmetic wear; what is included.
Tone: professional but approachable — like a knowledgeable gear dealer.
End with a brief, natural invitation to ask questions.',
   'gpt-4o', 0.65),

  (admin_id, 'Other', 'marketplace',
   'Other – Marketplace Post',
   'Facebook Marketplace post for other musical gear.',
   'Write a short Facebook Marketplace post for a piece of musical gear.
Format:
- One direct opening sentence stating what it is
- 3–5 bullet points covering key details (use only what is provided)
- "Asking: $X" on its own line if a price is provided
- One closing line about local pickup or shipping
Tone: casual, no filler phrases, under 120 words total.',
   'gpt-4o', 0.65),

  (admin_id, 'Other', 'kijiji',
   'Other – Kijiji Ad',
   'Kijiji classified ad for other musical gear.',
   'Write a Kijiji classified ad for a piece of musical gear.
Format: 2–3 short paragraphs — no bullet points.
First: state what the item is and its condition in plain language.
Middle: cover any relevant details provided — do not invent specs.
End: mention asking price naturally if provided; add one line about local pickup and whether shipping is possible.
Tone: casual, honest, matter-of-fact, under 130 words.',
   'gpt-4o', 0.65)

  ON CONFLICT (user_id, category, listing_type) DO NOTHING;

END;
$$;
