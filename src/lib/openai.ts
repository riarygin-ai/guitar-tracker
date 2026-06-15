// Server-only module. Never import this in client components.
// The OPENAI_API_KEY env var is intentionally not prefixed with NEXT_PUBLIC_.

import OpenAI from 'openai';

// ── Model configuration ────────────────────────────────────────────────────────
// Change MODEL_ID here to swap models without touching other code.
// Options: 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'
export const MODEL_ID    = 'gpt-4o';
export const MAX_TOKENS  = 900;
export const TEMPERATURE = 0.65;

// ── Types ──────────────────────────────────────────────────────────────────────

export type ListingType = 'reverb' | 'marketplace' | 'kijiji';

// When an active ai_prompts row exists, the API route passes this to override
// the hardcoded defaults. Null/undefined fields fall back to the hardcoded values.
export interface PromptOverride {
  promptText:   string;
  model?:       string | null;
  temperature?: number | null;
}

export interface ListingItem {
  brandName: string;
  model: string;
  itemType: string;
  subtypeName: string | null;
  year: number | null;
  color: string | null;
  condition: string | null;
  serialNumber: string | null;
  estimatedSoldValue: number | null;
  notes: string | null;
}

// ── Prompts ────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are an experienced guitar and music gear dealer creating listings for musicians, collectors, and enthusiasts.

Write like a knowledgeable gear enthusiast speaking to another musician — not a retail store or marketing department.

Information Priority:
Use information in the following order of importance:
1. Seller Notes — the most important source. Often contain key selling points, unique features, condition details, upgrades, accessories, history, and observations that should drive the listing. If Seller Notes contain meaningful details, prioritize them in the opening paragraph and throughout.
2. Structured item data fields (brand, model, year, color, condition, serial number).
3. Photo observations — use to confirm or supplement item data, not to lead the narrative.
4. General musical instrument knowledge — use only to fill genuine gaps, never to replace seller-provided information.

Do not replace seller-provided information with generic descriptions of the product category. Do not fill space with generic statements when seller notes provide specific information that makes the item more interesting.

Listing Focus:
Lead with the details that make this specific item interesting. Examples of details worth highlighting:
- Unusual or rare finish, color, or aging/relic work
- Exceptional top figuring or wood aesthetics
- Roasted flame maple neck or other notable materials
- Lacquer checking or attractive patina
- Original accessories, case, COA, paperwork, or case candy
- Modifications, service history, or upgrades (stated factually)
- Collector appeal or production notes (only when provided)
- Unique visual details visible in photos

Avoid generic descriptions that could apply to any similar instrument.

Writing Tone:
Write like an experienced guitar enthusiast and gear dealer. Prioritize authenticity, accuracy, readability, and trust. Prefer specific observations over generic praise.

Good examples:
- "Beautiful roasted flame maple neck with exceptional figuring."
- "The VOS finish has developed attractive lacquer checking."
- "Includes original case, COA, and paperwork."

Avoid these phrases and patterns:
- "Perfect for any player."
- "Amazing tone." / "Incredible guitar."
- "High-quality craftsmanship." / "Renowned build quality."
- "Must-have." / "Rare opportunity." / "Collector's dream." / "Rare gem."
- "Best guitar ever." / "One of a kind." / "Minty."
- "Priced to sell." / "Firm on price." / "Lowballers ignored."

Do not describe an item using generic praise unless supported by information in the seller notes or photos.

Narrative Style:
Write in a neutral seller voice rather than first person, unless otherwise requested.

Preferred: "2022 Xotic XSC-1 in Fiesta Red with light aging."
Less preferred: "I'm selling my 2022 Xotic XSC-1."

Accuracy Requirements:
- Only use information explicitly provided in the input.
- Never invent specifications, features, pickup models, electronics, hardware, wood types, country of origin, production numbers, artist associations, ownership history, or accessories.
- Do not infer specifications from the model name alone.
- If information is missing, uncertain, or unverified, either omit it or note it is unverified.
- Prioritize accuracy over completeness. It is better to omit than to guess.
- Every factual statement must be supported by the provided input.

Condition & Originality:
- Use the provided condition as the basis for cosmetic and functional descriptions.
- Describe condition accurately without exaggeration or minimizing flaws.
- Clearly distinguish original from modified components when such information is provided.
- Present modifications factually without assuming they are improvements.
- Never claim an item is all-original unless explicitly stated.

Accessories & Completeness:
- Mention included accessories when provided: hard case, gig bag, COA, paperwork, original parts, manuals, covers, footswitches, power supplies, hang tags, certificates, receipts, case candy.
- Buyers value completeness and originality; include these details when available.

Pricing & Negotiation:
- Do not mention price, trade value, offers, payment methods, financing, shipping costs, or negotiation terms unless explicitly instructed.
- Assume pricing is displayed separately by the platform.

Photo Analysis (when photos are provided):
- Observe photos before writing the listing.
- At the very start of your response, output a brief internal observation block in this exact format:
  <vision_notes>
  [2–4 concise lines describing visible condition, color/finish, and any notable cosmetic details]
  </vision_notes>
- After the closing tag, write the listing as instructed.
- Only describe what is clearly and directly visible in the photos.
- Do not infer pickup models, wood species, hardware brand, country of origin, serial number, or any specification that cannot be read as text from the photo.
- Use visual observations to confirm or supplement item data, not to contradict it.
- Do not claim modifications, damage, or accessories that are not clearly visible.`;

export const LISTING_INSTRUCTIONS: Record<ListingType, string> = {
  reverb: `Write a Reverb.com listing body (no title needed).
Format: 2–3 focused paragraphs.
Cover: what the instrument is and its condition, any notable details from the seller notes, what is included for shipping/case.
Tone: professional but approachable — like a knowledgeable shop owner who has handled many instruments.
End with a brief, natural invitation to ask questions.`,

  marketplace: `Write a short Facebook Marketplace or Kijiji post.
Format:
- One direct opening sentence stating what it is
- 3–5 bullet points covering key details (use only what is provided)
- "Asking: $X" on its own line if a price is provided
- One closing line about meeting locally or shipping
Tone: casual, no filler phrases, under 120 words total.`,

  kijiji: `Write a Kijiji classified ad.
Format: 2–3 short paragraphs — no bullet points.
First: state what the item is and its condition in plain language.
Middle: cover any relevant details provided (year, color, notable features from seller notes). Do not invent specs.
End: mention asking price naturally if provided, state "firm" or "or best offer" only if price flexibility is implied by the notes; add one line about local pickup and whether shipping is possible.
Tone: casual, honest, matter-of-fact — like a knowledgeable seller placing a newspaper ad.
Keep it under 130 words.`,
};

// ── Item context builder ───────────────────────────────────────────────────────

export function buildItemContext(item: ListingItem): string {
  const rows: string[] = [
    `Brand: ${item.brandName}`,
    `Model: ${item.model}`,
    `Type: ${item.subtypeName || item.itemType}`,
    `Year: ${item.year != null ? item.year : 'Unknown'}`,
    `Color/Finish: ${item.color || 'Not specified'}`,
    `Condition: ${item.condition || 'Not specified'}`,
    `Serial number: ${item.serialNumber || 'Not available'}`,
    item.estimatedSoldValue != null
      ? `Asking price: $${item.estimatedSoldValue.toLocaleString()}`
      : 'Price: omit from the listing',
    item.notes?.trim() ? `Seller notes: ${item.notes.trim()}` : '',
  ];
  return rows.filter(Boolean).join('\n');
}

// ── Client singleton ───────────────────────────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function generateListing(
  item: ListingItem,
  listingType: ListingType,
  currentDraft?: string,
  promptOverride?: PromptOverride,
  imageUrls?: string[],
): Promise<{ text: string; model: string; promptSnapshot: string; visionNotes: string | null }> {
  const client = getClient();

  // Prefer DB-loaded values; fall back to hardcoded constants.
  const resolvedModel       = promptOverride?.model?.trim()             || MODEL_ID;
  const resolvedTemperature = promptOverride?.temperature               ?? TEMPERATURE;
  const resolvedInstruction = promptOverride?.promptText                ?? LISTING_INSTRUCTIONS[listingType];

  const textContent = [
    'Item details:',
    buildItemContext(item),
    '',
    `Task: ${resolvedInstruction}`,
    currentDraft?.trim()
      ? `\nThe seller has an existing draft they would like improved:\n"""\n${currentDraft.trim()}\n"""`
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const hasImages = (imageUrls?.length ?? 0) > 0;

  type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail: 'low' } };

  const userContent: string | ContentPart[] = hasImages
    ? [
        { type: 'text', text: textContent },
        ...imageUrls!.map((url): ContentPart => ({
          type: 'image_url',
          image_url: { url, detail: 'low' },
        })),
      ]
    : textContent;

  const response = await client.chat.completions.create({
    model:       resolvedModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userContent as any },
    ],
    max_tokens:  MAX_TOKENS,
    temperature: resolvedTemperature,
  });

  const raw = response.choices[0]?.message?.content?.trim();
  if (!raw) throw new Error('OpenAI returned an empty response');

  let text        = raw;
  let visionNotes: string | null = null;

  if (hasImages) {
    const match = raw.match(/<vision_notes>([\s\S]*?)<\/vision_notes>/);
    if (match) {
      visionNotes = match[1].trim();
      text = raw.replace(/<vision_notes>[\s\S]*?<\/vision_notes>\s*/g, '').trim();
    }
  }

  return { text, model: resolvedModel, promptSnapshot: resolvedInstruction, visionNotes };
}
