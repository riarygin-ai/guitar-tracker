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

export const SYSTEM_PROMPT = `You are an experienced guitar dealer writing marketplace listings. Your writing is natural, knowledgeable, and honest — not over-hyped or salesy.

Rules you must follow:
- Only describe specs that are explicitly provided. Do not invent pickup configurations, tonewoods, hardware details, year, origin, or history.
- If a key detail is missing (year, color, serial), either omit it gracefully or acknowledge it honestly (e.g. "year unverified").
- Use the provided condition rating as the basis for describing cosmetic state. Do not embellish or downplay.
- Avoid hollow superlatives: "incredible", "one of a kind", "rare gem", "amazing tone". Describe, don't hype.
- Write in first person as the seller.
- If an asking price is provided, use it naturally. If not, do not mention price at all.`;

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
): Promise<{ text: string; model: string; promptSnapshot: string }> {
  const client = getClient();

  // Prefer DB-loaded values; fall back to hardcoded constants.
  const resolvedModel       = promptOverride?.model?.trim()             || MODEL_ID;
  const resolvedTemperature = promptOverride?.temperature               ?? TEMPERATURE;
  const resolvedInstruction = promptOverride?.promptText                ?? LISTING_INSTRUCTIONS[listingType];

  const userMessage = [
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

  const response = await client.chat.completions.create({
    model:       resolvedModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    max_tokens:  MAX_TOKENS,
    temperature: resolvedTemperature,
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty response');
  return { text, model: resolvedModel, promptSnapshot: resolvedInstruction };
}
