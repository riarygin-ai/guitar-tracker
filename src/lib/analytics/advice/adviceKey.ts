// Advice Dismissal / Resurface v1 — deterministic advice_key. Pure, no I/O,
// no node-only imports (deliberately isomorphic: imported by both the
// server-side dismiss API route, src/app/api/analytics/advice/dismiss/
// route.ts, and the browser Dashboard bundle, src/app/page.tsx, so both
// sides always compute the exact same key from the exact same rule).
//
// ── WHY THESE FIELDS, AND ONLY THESE ─────────────────────────────────────
// advice_type + item_id + the card's cited source_ids are the only fields
// on an AdviceCard that are NOT free-form LLM wording:
// - advice_code is a per-response label the model invents fresh each call
//   (e.g. "C1"/"C2" — see ADVICE_JSON_SCHEMA in src/lib/openai.ts and the
//   worked fixtures in scripts/test-analytics-advice.ts). It is never a
//   stable taxonomy code, so it must never be part of identity.
// - headline/advice/why_it_matters/confidence_label/priority can all
//   legitimately reword or shift between runs while describing the exact
//   same underlying finding — using any of them would let re-wording
//   defeat dismissal (the advice would "come back" every run even though
//   nothing about the evidence changed).
// - source_ids are built deterministically by buildInputPacket.ts from
//   each finding/pattern's own finding_code/pattern_code/pattern_key plus
//   its structural segment identity (item_id, acquisition-value band,
//   category, channel, journey) — never the model's own words. The same
//   underlying condition produces the same source_id run after run; a
//   genuinely different condition produces a different one.
// - item_id is included explicitly (not just left implicit inside
//   source_ids) so two cards that happen to cite the same source(s) but
//   were written for two different items are still never confused —
//   though validateAdviceResponse.ts already guarantees a non-null
//   item_id is one of the cited sources' own item_id, so in practice this
//   is redundant-but-explicit, matching the task's own preferred inputs.
//
// ── WHY NO HASH ────────────────────────────────────────────────────────────
// A SHA-256 digest was considered but dropped: Node's `crypto` module isn't
// available to the browser bundle, and the Web Crypto `subtle.digest` API
// is async, which would force every call site (including the synchronous
// Dashboard render-time filter) to become async for no real benefit — the
// canonicalized string below is already collision-safe (JSON-encoding the
// sorted source_ids array means no delimiter inside a source_id can ever
// be misread as a separator) and stays human-inspectable for support/
// debugging, at the cost of being a little longer than a digest would be.

export interface AdviceKeyInput {
  advice_type: string;
  item_id: number | null;
  source_ids: string[];
}

/** Bump only if the identity rule itself changes — a version bump changes
 *  every advice_key, which (by design) makes every existing dismissal stop
 *  matching anything and the suppression silently lapses. Not expected to
 *  change as part of this feature. */
export const ADVICE_KEY_VERSION = 'v1';

export function computeAdviceKey(card: AdviceKeyInput): string {
  const sortedSourceIds = [...card.source_ids].sort();
  return `${ADVICE_KEY_VERSION}:${card.advice_type}:${card.item_id ?? '-'}:${JSON.stringify(sortedSourceIds)}`;
}
