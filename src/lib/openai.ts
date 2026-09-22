// Server-only module. Never import this in client components.
// The OPENAI_API_KEY env var is intentionally not prefixed with NEXT_PUBLIC_.

import OpenAI from 'openai';
import { LEAD_DEAL_RULES, LISTING_DEMAND_SEMANTICS, PURPOSE_SEMANTICS } from './analytics/advice/sharedSemantics';
import { normalizeAdviceLanguage, withAdviceLanguage, type AdviceLanguage } from './analytics/advice/adviceLanguage';

// ── Model configuration ────────────────────────────────────────────────────────
// Change MODEL_ID here to swap models without touching other code.
// Options: 'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'
export const MODEL_ID    = 'gpt-4o';
export const MAX_TOKENS  = 900;
export const TEMPERATURE = 0.65;

// ── Types ──────────────────────────────────────────────────────────────────────

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

Product Knowledge Usage:
You may use well-established product information when it is widely documented by the manufacturer or part of the product's standard specifications. Examples of acceptable product knowledge:
- Pickup type (e.g. single-coil, humbucker, P-90)
- Pedal function (e.g. overdrive, delay, compressor)
- Amplifier format (e.g. combo, head, solid-state, tube)
- Control layout
- Manufacturer specifications
- Intended product purpose

Do not invent or assume:
- Tonal characteristics
- Rarity or desirability
- Collector status or market value
- Performance claims
- Player preferences

When product knowledge is used, present it factually rather than promotionally. Avoid subjective marketing language such as: "amazing tone", "incredible sounding", "perfect for", "elevate your sound", "renowned craftsmanship", "high-quality".

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

// Keys are lowercase channel names (e.g. 'reverb', 'marketplace', 'kijiji').
// Used as fallback when no custom DB prompt exists for a channel.
export const LISTING_INSTRUCTIONS: Record<string, string> = {
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

const DEFAULT_LISTING_INSTRUCTION = LISTING_INSTRUCTIONS['reverb'];

// ── Item context builder ───────────────────────────────────────────────────────

export function buildItemContext(item: ListingItem): string {
  const rows: string[] = [
    `Brand: ${item.brandName}`,
    `Model: ${item.model}`,
    `Type: ${item.subtypeName ?? ''}`,
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

// ── Auditable AI Advice v1.0 ─────────────────────────────────────────────────────
// Second call surface on the SAME client singleton/model configuration above —
// deliberately not a second OpenAI client architecture. See src/lib/analytics/
// advice/ for packet construction, canonical hashing, response validation, and
// the pending -> generating -> completed/failed persistence lifecycle; this
// function only makes the API call and returns the raw JSON text.

export const ADVICE_MODEL_ID = MODEL_ID;
export const ADVICE_MAX_TOKENS = 1400;
export const ADVICE_TEMPERATURE = 0.4;
// Structured-output calls can run longer than the listing-generation path
// (larger, schema-constrained response) — no existing timeout convention to
// reuse (generateListing above sets none), so this establishes a first,
// deliberate bound for this new, more failure-sensitive call site rather
// than relying on the SDK's own default.
const ADVICE_REQUEST_TIMEOUT_MS = 45_000;

const ADVICE_JSON_SCHEMA = {
  name: 'analytics_advice_v1',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      schema_version: { type: 'string', enum: ['1.0'] },
      run_summary: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          source_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['headline', 'summary', 'source_ids'],
        additionalProperties: false,
      },
      advice_cards: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            advice_code: { type: 'string' },
            advice_type: { type: 'string', enum: ['action', 'observation', 'watch', 'review'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            headline: { type: 'string' },
            advice: { type: 'string' },
            why_it_matters: { type: 'string' },
            confidence_label: { type: 'string', enum: ['stronger', 'moderate', 'low', 'preliminary'] },
            source_ids: { type: 'array', items: { type: 'string' } },
            limitations: { type: 'array', items: { type: 'string' } },
            item_id: { type: ['integer', 'null'] },
          },
          required: ['advice_code', 'advice_type', 'priority', 'headline', 'advice', 'why_it_matters', 'confidence_label', 'source_ids', 'limitations', 'item_id'],
          additionalProperties: false,
        },
      },
      limitations: { type: 'array', items: { type: 'string' } },
    },
    required: ['schema_version', 'run_summary', 'advice_cards', 'limitations'],
    additionalProperties: false,
  },
} as const;

// AI behavior contract — every rule here is a hard constraint the model must
// follow; validateAdviceResponse.ts independently re-enforces the source-ID
// and structural rules server-side rather than trusting the prompt alone.
export const ADVICE_SYSTEM_PROMPT = `You are an auditing assistant that writes concise, sourced advice summaries from a business inventory analytics run for a musical-instrument reseller.

You will receive a JSON "Advice Input Packet" containing:
- run metadata (versions, evidence scope);
- deterministic_insights: findings already selected by a fixed, non-AI rules engine;
- confirmed_patterns: patterns already selected by a deterministic pattern-discovery engine, meeting confirmed statistical sample/peer thresholds;
- preliminary_hypotheses: patterns that meet only looser, exploratory thresholds — NOT confirmed;
- pattern_selection_summary: aggregate counts only;
- listing_demand (optional — may be absent): compact, factual buyer/listing-activity evidence for the last 4 weekly buckets (see "Listing Demand semantics" below), organised as market_trend, channels, items (highest_activity and zero_activity_high_exposure) and data_quality; each part carries a source_id beginning "demand:";
- allowed_source_ids: the COMPLETE list of source IDs you are permitted to cite (including any demand:* ids).

Hard rules — follow every one exactly:
1. Use ONLY the supplied packet. Do not inspect, infer, or assume any field, item, value, or pattern that is not explicitly present in the packet.
2. Do not calculate new ROI, profit, days-on-market, realization rates, or peer baselines. Only quote or accurately paraphrase the numbers already given. You may COMPARE provided values (for example raw leads next to exposure next to leads_per_100_channel_listing_days, or one week against another), but do not compute new rates, conversion figures, or totals of your own.
3. Never invent item names, values, channels, dates, patterns, sample sizes, or any other detail not present in the packet.
4. Clearly distinguish a Deterministic Insight (fixed rule, always true given the evidence) from a Confirmed Pattern (meets confirmed statistical thresholds) from a Preliminary Hypothesis (exploratory only). Label a Preliminary Hypothesis as preliminary in your own wording — never present it as confirmed or proven, and never convert a hypothesis into a stated fact.
5. Treat every source as a statistical ASSOCIATION, never as proof of causation. Do not use causal language ("this caused", "because of this").
6. Never promise or imply a specific financial outcome.
7. Never recommend an automatic database change, and never recommend automatically changing a listing, price, Purpose, or any inventory record. You may describe what the evidence shows and suggest the user consider reviewing something — you may never instruct an automated system to act.
8. Never pressure the user to sell Personal-purpose inventory. Personal inventory is not failed Business inventory — long personal holding time is not automatically negative.
9. Treat Hybrid Purpose neutrally. A Hybrid review does not imply the item must become Business. KEEP_HYBRID, CHANGE_TO_BUSINESS, and CHANGE_TO_PERSONAL may all be valid outcomes — never push toward one.
10. Every advice card must cite at least one source_id from allowed_source_ids. Never write a substantive claim without a source. A card whose claim is not backed by a cited source will be rejected.
11. When confidence is low or a source is a preliminary hypothesis, explicitly say the evidence is preliminary/limited rather than sounding confident.
12. Avoid generic motivational language ("take action now", "don't miss out", "this is huge"). Be concise, specific, and practical.
13. Generate at most 3 advice_cards. When evidence supports it, prefer covering: (a) the single most important immediate Business inventory action, (b) the most useful confirmed performance insight or pattern, and (c) one watch/review item drawn from a preliminary hypothesis or a Hybrid-purpose finding. Do not force a category the evidence does not support — a neutral run summary with only one or two cards, or zero cards, is a valid and expected outcome when the evidence is thin or entirely neutral.
14. item_id in an advice card must be null UNLESS the card is specifically about one target-user item already identified by item_id in a cited deterministic_insights source or a cited demand:item:<id> source — never invent or guess an item_id.

${LEAD_DEAL_RULES}

${LISTING_DEMAND_SEMANTICS}
- When listing_demand supports it, one of the (at most 3) cards may address buyer activity versus exposure; do not force it when the evidence is thin, and never let it crowd out the Business inventory action described in rule 13.

${PURPOSE_SEMANTICS}

Respond with ONLY the structured JSON object matching the required schema — no prose outside the JSON.`;

/** Language recorded in an advice packet (legacy/malformed -> English). */
function packetLanguage(packet: unknown): AdviceLanguage {
  return normalizeAdviceLanguage((packet as { language?: unknown } | null)?.language);
}

/** The exact system prompt for a General Coach call: ONE canonical prompt + the language instruction. */
export function adviceSystemPromptFor(language: AdviceLanguage): string {
  return withAdviceLanguage(ADVICE_SYSTEM_PROMPT, language);
}

/** The exact system prompt for a Listing Advice call: ONE canonical prompt + the language instruction. */
export function listingAdviceSystemPromptFor(language: AdviceLanguage): string {
  return withAdviceLanguage(LISTING_ADVICE_SYSTEM_PROMPT, language);
}

export interface AnalyticsAdviceGenerationResult {
  raw: string;
  model: string;
}

/**
 * Calls OpenAI with the Advice Input Packet as the user message and returns
 * the raw JSON text the model produced. Never validates source IDs or
 * business rules itself — see src/lib/analytics/advice/validateAdviceResponse.ts
 * for that, applied by the caller after this returns. Throws on any OpenAI-
 * level failure (network, auth, empty response) — the caller is responsible
 * for catching this and persisting a 'failed' advice row; this function
 * never touches the database.
 */
export async function generateAnalyticsAdvice(packet: unknown): Promise<AnalyticsAdviceGenerationResult> {
  const client = getClient();

  const response = await client.chat.completions.create(
    {
      model: ADVICE_MODEL_ID,
      messages: [
        { role: 'system', content: adviceSystemPromptFor(packetLanguage(packet)) },
        { role: 'user', content: `Advice Input Packet:\n${JSON.stringify(packet)}` },
      ],
      max_tokens: ADVICE_MAX_TOKENS,
      temperature: ADVICE_TEMPERATURE,
      response_format: { type: 'json_schema', json_schema: ADVICE_JSON_SCHEMA },
    },
    { timeout: ADVICE_REQUEST_TIMEOUT_MS },
  );

  const raw = response.choices[0]?.message?.content?.trim();
  if (!raw) throw new Error('OpenAI returned an empty response');

  return { raw, model: ADVICE_MODEL_ID };
}

// ── Listing Advice (listing-advice-v1) ───────────────────────────────────────────
// Separate AI surface for /listings: interprets ONLY the compact Listing Demand
// packet. Same client singleton/model configuration/structured-output approach as
// the general Coach above; its own schema, prompt and version. The shared
// semantics blocks (leads/deals hard rules, Listing Demand semantics, Purpose)
// are imported from ONE module so they cannot drift from the general Coach.

export const LISTING_ADVICE_MODEL_ID = MODEL_ID;
export const LISTING_ADVICE_MAX_TOKENS = 1400;
export const LISTING_ADVICE_TEMPERATURE = 0.4;
const LISTING_ADVICE_REQUEST_TIMEOUT_MS = 45_000;

const LISTING_ADVICE_JSON_SCHEMA = {
  name: 'listing_advice_v1',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      schema_version: { type: 'string', enum: ['1.0'] },
      cards: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            advice_code: { type: 'string' },
            advice_type: { type: 'string', enum: ['action', 'observation', 'watch'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            confidence_label: { type: 'string', enum: ['stronger', 'moderate', 'low', 'preliminary'] },
            title: { type: 'string' },
            summary: { type: 'string' },
            why_it_matters: { type: 'string' },
            next_steps: { type: 'array', maxItems: 3, items: { type: 'string' } },
            source_ids: { type: 'array', items: { type: 'string' } },
            limitations: { type: 'array', items: { type: 'string' } },
          },
          required: ['advice_code', 'advice_type', 'priority', 'confidence_label', 'title', 'summary', 'why_it_matters', 'next_steps', 'source_ids', 'limitations'],
          additionalProperties: false,
        },
      },
    },
    required: ['schema_version', 'cards'],
    additionalProperties: false,
  },
} as const;

export const LISTING_ADVICE_SYSTEM_PROMPT = `You are an analyst that writes concise, sourced "Listing Advice" for a musical-instrument reseller, interpreting ONLY their current listing and buyer-demand evidence.

You will receive a JSON "Listing Advice Input Packet" containing:
- window: the 4-week evidence window;
- listing_demand: compact factual evidence — market_trend (4 weekly rows), channels (the same 4 weeks per channel), items (highest_activity and zero_activity_high_exposure selections plus totals) and data_quality;
- semantics: fixed reminders (notably that no lead-to-deal linkage exists);
- allowed_source_ids: the COMPLETE list of source IDs you may cite. Each part of listing_demand carries its own source_id beginning "demand:".

Your job: say what is important in this listing demand data and what the user should pay attention to. The deterministic numbers are already shown to the user below your cards; do not restate tables — interpret them.

Hard rules — follow every one exactly:
1. Use ONLY the supplied packet. Never invent items, channels, dates, values, or sample sizes.
2. Do not calculate new metrics (no new rates, ratios, totals, scores, or conversion figures). Quote or accurately paraphrase provided numbers; you may COMPARE provided values (raw leads next to exposure next to leads_per_100_channel_listing_days, week against week, channel against channel).
3. Every card must cite at least one source_id from allowed_source_ids for the evidence it relies on. A card whose claim is not backed by a cited source will be rejected. Never invent a source id.
4. Treat everything as observational association, never proof of causation.
5. Never promise or imply a financial outcome. Never recommend an automatic change to a listing, price, or any record; you may suggest the user consider reviewing or checking something.
6. Generate 0 to 3 cards. Do NOT pad: if no materially useful signal exists, return fewer cards (or none). Do not create advice from tiny differences — weigh magnitude, persistence across the four weeks, exposure/sample size, and data quality. If evidence is weak, use a "watch" card or return fewer cards.
7. Cards must be materially distinct. Prefer different useful dimensions when the evidence supports them (an item, a channel, the market trend, a high-exposure/low-response case) but never force one of each and never write three cards that all say leads are high.
8. advice_type: "action" = something specific worth doing or checking soon; "observation" = a notable pattern; "watch" = weak or emerging evidence worth monitoring. priority: high/medium/low by materiality. confidence_label: stronger/moderate/low/preliminary — use low or preliminary for small samples, incomplete logging, or short-lived changes.
9. Keep text short: a title, a 1–3 sentence summary, a 1–2 sentence why_it_matters, at most 3 short next_steps (concrete checks, not orders), and only limitations that materially apply to that card.
10. Do NOT invent scores or labels (no hot/cold, winner/loser, grades). Do not use generic motivational language.
11. Use the packet's data_quality: mention incomplete logging or low attribution where it materially limits a conclusion.
12. Card selection — positive item demand is first-class evidence, not a footnote. Consider materially strong item signals (for example an item with notably more attributed leads, Serious+ leads or offers than the others) ALONGSIDE weak or zero-response signals (high exposure with no attributed leads). Do not omit a clearly material positive item signal merely because channel or market observations also exist. When three materially distinct, useful signals exist, prefer three cards; when only one or two exist, return one or two. Never add filler to reach three and never force exactly three.
13. Wording: describe demand as "buyer/lead response" (or "attributed leads" / "lead activity"), not as broad "channel performance" — the packet records leads and listing exposure, not channel quality. High listing exposure with zero attributed leads "warrants review" or is "worth checking": do NOT assert that the listing has a problem, that the price is wrong, or that the listing is failing; the evidence is observational and other causes are possible.

${LEAD_DEAL_RULES}

${LISTING_DEMAND_SEMANTICS}

${PURPOSE_SEMANTICS}
Purpose metadata is not part of this packet: never infer or assume an item's Purpose, and never pressure the user to sell because demand is low.

Respond with ONLY the structured JSON object matching the required schema — no prose outside the JSON.`;

export async function generateListingAdviceFromModel(packet: unknown): Promise<AnalyticsAdviceGenerationResult> {
  const client = getClient();

  const response = await client.chat.completions.create(
    {
      model: LISTING_ADVICE_MODEL_ID,
      messages: [
        { role: 'system', content: listingAdviceSystemPromptFor(packetLanguage(packet)) },
        { role: 'user', content: `Listing Advice Input Packet:\n${JSON.stringify(packet)}` },
      ],
      max_tokens: LISTING_ADVICE_MAX_TOKENS,
      temperature: LISTING_ADVICE_TEMPERATURE,
      response_format: { type: 'json_schema', json_schema: LISTING_ADVICE_JSON_SCHEMA },
    },
    { timeout: LISTING_ADVICE_REQUEST_TIMEOUT_MS },
  );

  const raw = response.choices[0]?.message?.content?.trim();
  if (!raw) throw new Error('OpenAI returned an empty response');

  return { raw, model: LISTING_ADVICE_MODEL_ID };
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function generateListing(
  item: ListingItem,
  channelName: string,
  currentDraft?: string,
  promptOverride?: PromptOverride,
  imageUrls?: string[],
): Promise<{ text: string; model: string; promptSnapshot: string; visionNotes: string | null }> {
  const client = getClient();

  // Prefer DB-loaded values; fall back to built-in defaults keyed by lowercase channel name.
  const resolvedModel       = promptOverride?.model?.trim()             || MODEL_ID;
  const resolvedTemperature = promptOverride?.temperature               ?? TEMPERATURE;
  const resolvedInstruction = promptOverride?.promptText
    ?? LISTING_INSTRUCTIONS[channelName.toLowerCase()]
    ?? DEFAULT_LISTING_INSTRUCTION;

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
