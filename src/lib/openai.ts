// Server-only module. Never import this in client components.
// The OPENAI_API_KEY env var is intentionally not prefixed with NEXT_PUBLIC_.

import OpenAI from 'openai';

// ── Model configuration ────────────────────────────────────────────────────────
// Change MODEL_ID here to swap models without touching other code.
// Options: 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'
const MODEL_ID = 'gpt-4o';
const MAX_TOKENS = 900;
const TEMPERATURE = 0.65;

// ── Types ──────────────────────────────────────────────────────────────────────

export type ListingType = 'reverb' | 'marketplace' | 'trade';

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

const SYSTEM_PROMPT = `You are an experienced guitar dealer writing marketplace listings. Your writing is natural, knowledgeable, and honest — not over-hyped or salesy.

Rules you must follow:
- Only describe specs that are explicitly provided. Do not invent pickup configurations, tonewoods, hardware details, year, origin, or history.
- If a key detail is missing (year, color, serial), either omit it gracefully or acknowledge it honestly (e.g. "year unverified").
- Use the provided condition rating as the basis for describing cosmetic state. Do not embellish or downplay.
- Avoid hollow superlatives: "incredible", "one of a kind", "rare gem", "amazing tone". Describe, don't hype.
- Write in first person as the seller.
- If an asking price is provided, use it naturally. If not, do not mention price at all.`;

const LISTING_INSTRUCTIONS: Record<ListingType, string> = {
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

  trade: `Write a gear-forum trade post.
Format: 2 short paragraphs.
First: describe what you have and its condition honestly.
Second: state you are open to trades for similar-value gear (keep it general — guitars, amps, pedals), and mention that cash adjustments either way are possible.
Tone: direct and peer-to-peer — gear traders value brevity and honesty over marketing language.
Keep it under 130 words.`,
};

// ── Item context builder ───────────────────────────────────────────────────────

function buildItemContext(item: ListingItem): string {
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
): Promise<string> {
  const client = getClient();

  const userMessage = [
    'Item details:',
    buildItemContext(item),
    '',
    `Task: ${LISTING_INSTRUCTIONS[listingType]}`,
    currentDraft?.trim()
      ? `\nThe seller has an existing draft they would like improved:\n"""\n${currentDraft.trim()}\n"""`
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const response = await client.chat.completions.create({
    model: MODEL_ID,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('OpenAI returned an empty response');
  return text;
}
