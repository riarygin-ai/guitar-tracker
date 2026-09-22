// Per-user AI Advice language (General Business Coach + Listing Advice ONLY —
// deliberately not application localization). Pure and client-safe: shared by
// the server generators, the prompt builders and the advice UI.
//
// Design: ONE canonical analytical prompt per advice system; the language is a
// small deterministic instruction appended to it, and the language code is a
// field of the persisted input packet (so it is hashed, auditable and
// immutable with each revision). Evidence is never translated — only the
// model-written prose fields are.

export const ADVICE_LANGUAGES = ['en', 'ru'] as const;
export type AdviceLanguage = (typeof ADVICE_LANGUAGES)[number];
export const DEFAULT_ADVICE_LANGUAGE: AdviceLanguage = 'en';

export function isAdviceLanguage(value: unknown): value is AdviceLanguage {
  return typeof value === 'string' && (ADVICE_LANGUAGES as readonly string[]).includes(value);
}

/** Any unknown/missing/malformed value falls back to English — never throws. */
export function normalizeAdviceLanguage(value: unknown): AdviceLanguage {
  return isAdviceLanguage(value) ? value : DEFAULT_ADVICE_LANGUAGE;
}

/** Admin-facing option labels (English UI), in display order. */
export const ADVICE_LANGUAGE_OPTIONS: { value: AdviceLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Russian' },
];

/** "Russian (ru)" / "English (en)" — for debug/audit lines. */
export function describeAdviceLanguage(language: AdviceLanguage): string {
  const label = ADVICE_LANGUAGE_OPTIONS.find((o) => o.value === language)?.label ?? language;
  return `${label} (${language})`;
}

const INSTRUCTIONS: Record<AdviceLanguage, string> = {
  en: `Response language: English (en).
Write all user-facing advice prose naturally in English. Keep proper nouns, brands, model names, channel names, identifiers and source IDs unchanged.`,
  ru: `Response language: Russian (ru).
Write all user-facing advice prose naturally in Russian. This covers every human-readable string field: titles/headlines, summaries, advice text, why-it-matters text, next steps / suggested checks, and limitations.
Keep proper nouns, brands, model names, channel names, identifiers and source IDs unchanged where appropriate (for example Fender, Gibson, PRS, Reverb, Kijiji, Marketplace, Neural DSP Quad Cortex, item model names and finish names) — do not translate or transliterate them. Do NOT translate or alter any structured/canonical value: source_ids, advice_code, item_id, and the enum values advice_type, priority and confidence_label stay exactly as specified in the schema (for example "action", "high", "moderate"). The evidence in the packet is factual data: do not translate or rewrite it — only your prose is in Russian. The analytical rules above apply unchanged in Russian; language must not change meaning (still no conversion claims, no causal claims, no invented figures).`,
};

/** The deterministic language block appended to a canonical system prompt. */
export function adviceLanguageInstruction(language: AdviceLanguage): string {
  return INSTRUCTIONS[language];
}

/** Canonical system prompt + the language instruction for `language` (never a separate per-language prompt). */
export function withAdviceLanguage(canonicalPrompt: string, language: AdviceLanguage): string {
  return `${canonicalPrompt}\n\n${adviceLanguageInstruction(language)}`;
}
