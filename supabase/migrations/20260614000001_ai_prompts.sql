-- ai_prompts
-- Stores editable prompts used by AI listing generation.
-- One row per listing type; prompt_key maps to a listingType via naming convention.

-- ─── 1. is_app_admin() helper ─────────────────────────────────────────────────
-- Returns true when the current auth.uid() belongs to an admin app_user.

CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(admin, false) FROM public.app_users WHERE auth_user_id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated, service_role;

-- ─── 2. ai_prompts table ─────────────────────────────────────────────────────

CREATE TABLE public.ai_prompts (
  id           bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_key   text          NOT NULL UNIQUE,
  name         text          NOT NULL,
  description  text,
  prompt_text  text          NOT NULL,
  model        text,
  temperature  numeric(3,2)  DEFAULT 0.65,
  is_active    boolean       NOT NULL DEFAULT true,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

-- ─── 3. updated_at trigger (reuses set_updated_at from item_listings) ─────────

CREATE TRIGGER ai_prompts_set_updated_at
  BEFORE UPDATE ON public.ai_prompts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 4. Row-level security ────────────────────────────────────────────────────
-- All authenticated users can read (needed by the server API route with user JWT).
-- Only admins can write.

ALTER TABLE public.ai_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_prompts: select authenticated"
  ON public.ai_prompts FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "ai_prompts: insert admin"
  ON public.ai_prompts FOR INSERT TO authenticated
  WITH CHECK (public.is_app_admin());

CREATE POLICY "ai_prompts: update admin"
  ON public.ai_prompts FOR UPDATE TO authenticated
  USING  (public.is_app_admin())
  WITH CHECK (public.is_app_admin());

CREATE POLICY "ai_prompts: delete admin"
  ON public.ai_prompts FOR DELETE TO authenticated
  USING (public.is_app_admin());

-- ─── 5. Grants ────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_prompts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_prompts TO service_role;

-- ─── 6. Seed prompts ─────────────────────────────────────────────────────────
-- These match the hardcoded prompts in src/lib/openai.ts exactly.
-- Editing them in Settings will override these defaults at runtime.

INSERT INTO public.ai_prompts (prompt_key, name, description, prompt_text, model, temperature)
VALUES
(
  'listing_reverb',
  'Reverb.com Listing',
  'Listing format for Reverb.com — polished, professional, 2–3 paragraphs.',
  'Write a Reverb.com listing body (no title needed).
Format: 2–3 focused paragraphs.
Cover: what the instrument is and its condition, any notable details from the seller notes, what is included for shipping/case.
Tone: professional but approachable — like a knowledgeable shop owner who has handled many instruments.
End with a brief, natural invitation to ask questions.',
  'gpt-4o',
  0.65
),
(
  'listing_marketplace',
  'Facebook Marketplace Post',
  'Short casual post for Facebook Marketplace — bullet points, under 120 words.',
  'Write a short Facebook Marketplace post.
Format:
- One direct opening sentence stating what it is
- 3–5 bullet points covering key details (use only what is provided)
- "Asking: $X" on its own line if a price is provided
- One closing line about meeting locally or shipping
Tone: casual, no filler phrases, under 120 words total.',
  'gpt-4o',
  0.65
),
(
  'listing_kijiji',
  'Kijiji Ad',
  'Classifieds-style ad for Kijiji — 2–3 short paragraphs, under 130 words.',
  'Write a Kijiji classified ad.
Format: 2–3 short paragraphs — no bullet points.
First: state what the item is and its condition in plain language.
Middle: cover any relevant details provided (year, color, notable features from seller notes). Do not invent specs.
End: mention asking price naturally if provided, state "firm" or "or best offer" only if price flexibility is implied by the notes; add one line about local pickup and whether shipping is possible.
Tone: casual, honest, matter-of-fact — like a knowledgeable seller placing a newspaper ad.
Keep it under 130 words.',
  'gpt-4o',
  0.65
);
