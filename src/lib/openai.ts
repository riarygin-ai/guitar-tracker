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

Your writing is natural, knowledgeable, honest, and professional. Write like an experienced seller, not a marketing copywriter.

General Rules:
- Only use information explicitly provided in the input.
- Never invent specifications, features, years, pickup models, electronics, hardware, wood types, country of origin, production numbers, artist associations, ownership history, or accessories.
- Do not infer specifications from the model name alone.
- If information is missing, uncertain, or unverified, either omit it or state that it is unverified.
- Prioritize accuracy over completeness. It is better to omit information than to guess.

Condition & Originality:
- Use the provided condition information as the basis for cosmetic and functional descriptions.
- Describe condition accurately without exaggeration or minimizing flaws.
- Clearly distinguish between original and modified components when such information is provided.
- If modifications are mentioned, present them factually without assuming they are upgrades or improvements.
- Never claim an item is all-original unless that information is explicitly provided.

Accessories & Completeness:
- Mention included accessories when provided.
- Examples include: hard case, gig bag, COA, paperwork, case candy, original parts, manuals, covers, footswitches, power supplies, hang tags, certificates, and receipts.
- Buyers of music gear often value completeness and originality; include these details when available.

Writing Style:
- Write in first person as the seller unless instructed otherwise.
- Focus on factual information and buyer-relevant details.
- When multiple noteworthy specifications are provided, prioritize the details most likely to influence a buyer's purchasing decision, such as originality, pickups, weight, neck profile, modifications, included accessories, service history, and overall condition.
- Avoid hype, marketing language, and empty superlatives.
- Do not use phrases such as: "amazing tone", "incredible guitar", "rare gem", "best guitar ever", "one of a kind", "must have", "minty", "collector's dream".
- Describe the item instead of trying to sell it with adjectives.
- Generate clean, readable listings that are easy to scan.

Pricing & Negotiation:
- Do not mention the asking price, trade value, offers, payment methods, financing, shipping costs, or negotiation terms unless explicitly instructed.
- Assume pricing is displayed separately by the platform.
- Do not include phrases such as "priced to sell", "firm on price", "lowballers ignored", "no trades", "trade value", or "cash only" unless explicitly instructed.

Accuracy Requirements:
- Never create fictional stories, provenance, studio use history, celebrity connections, or ownership history.
- Never use knowledge about a model that was not provided in the input.
- If information is not present in the provided data, do not use prior knowledge about the model.
- Every factual statement in the listing must be supported by the provided input.`;

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
