// Advice Dismissal / Resurface v1 — deterministic advice_key. Pure, no I/O,
// no node-only imports (deliberately isomorphic: imported by both the
// server-side dismiss API route, src/app/api/analytics/advice/dismiss/
// route.ts, and the browser Dashboard bundle, src/app/page.tsx, so both
// sides always compute the exact same key from the exact same rule).
//
// ── v2 — AUDIT FINDINGS (commit 6a24a73's v1 was too fragile) ─────────────
// Two problems were found in the original (v1) algorithm and fixed here:
//
// 1. advice_type is LLM-CHOSEN, not deterministic. The system prompt
//    (ADVICE_SYSTEM_PROMPT rule 13, src/lib/openai.ts) leaves the
//    action/observation/watch/review split entirely to the model's own
//    editorial judgment about "the single most important immediate
//    action" vs. "a watch/review item" for a given run — there is no fixed
//    rule mapping a source/finding to a required advice_type. The exact
//    same underlying concern could reasonably be framed as a "review" one
//    week and an "action" the next. v1 included advice_type in the key,
//    so that reframing alone would have silently defeated dismissal.
//    Removed entirely from identity.
//
// 2. The FULL source_ids set is not guaranteed stable. The model is only
//    required to cite >=1 source per card (validateAdviceResponse.ts) —
//    it is never required to cite every available corroborating source,
//    and nothing stops it from citing an extra supporting pattern/insight
//    one week that it didn't cite (or that didn't yet exist) the week
//    before, while the CORE underlying condition is unchanged. v1 hashed
//    the entire sorted array, so adding or dropping one supporting source
//    changed the key and silently defeated dismissal. Fixed by keying on a
//    single, mechanically-selected PRIMARY source instead of the whole
//    set — see pickPrimarySourceId below. This does mean that if the one
//    source selected as primary itself stops being cited (its underlying
//    condition genuinely stopped holding), the key changes — that is
//    intentional: a genuinely different deterministic condition should
//    produce a different key, per the same audit's own target behavior.
//
// ── WHY advice_code/headline/advice/why_it_matters/confidence_label/
// priority ARE STILL EXCLUDED ─────────────────────────────────────────────
// - advice_code is a per-response label the model invents fresh each call
//   (e.g. "C1"/"C2" — see ADVICE_JSON_SCHEMA in src/lib/openai.ts and the
//   worked fixtures in scripts/test-analytics-advice.ts). Never a stable
//   taxonomy code.
// - headline/advice/why_it_matters/confidence_label/priority can all
//   legitimately reword or shift between runs while describing the exact
//   same underlying finding.
//
// ── PRIMARY SOURCE SELECTION (pickPrimarySourceId) ────────────────────────
// Purely mechanical — never LLM-chosen, never a new taxonomy (reuses the
// three source_id prefixes buildInputPacket.ts already emits: `insight:`,
// `pattern:`, `hypothesis:`, mirroring the existing closed SourceType
// enum):
// - Item-level cards (item_id set): the primary source is the card's own
//   item-justifying source — the `insight:*:item:{item_id}` entry among
//   its cited source_ids. validateAdviceResponse.ts already guarantees a
//   non-null item_id is backed by exactly this kind of source, so this is
//   always resolvable for any real, validated completed advice card. This
//   anchors identity to "this item + the specific deterministic rule
//   firing on it," ignoring any OTHER corroborating pattern/hypothesis the
//   card also happens to cite.
// - Portfolio-level cards (item_id null), or the defensive fallback if no
//   item-justifying source is found: pick by a fixed prefix priority
//   (pattern > insight > hypothesis — confirmed statistical significance
//   ranked above a fixed always-true rule finding, ranked above an
//   explicitly "exploratory only" hypothesis per the system prompt's own
//   language), tie-broken lexicographically for determinism.
//
// ── WHY NO HASH ────────────────────────────────────────────────────────────
// A SHA-256 digest was considered but dropped: Node's `crypto` module isn't
// available to the browser bundle, and the Web Crypto `subtle.digest` API
// is async, which would force every call site (including the synchronous
// Dashboard render-time filter) to become async for no real benefit — the
// canonicalized string below stays human-inspectable for support/debugging.

export interface AdviceKeyInput {
  item_id: number | null;
  source_ids: string[];
}

/** Bump only if the identity rule itself changes — a version bump changes
 *  every advice_key, which (by design) makes every existing dismissal stop
 *  matching anything and the suppression silently lapses. Bumped v1 -> v2
 *  for the audit fix above (no real dismissals existed under v1 at the
 *  time of this fix — see the audit report). */
export const ADVICE_KEY_VERSION = 'v2';

/** Fixed, deterministic tie-break for portfolio-level (item_id null, or no
 *  item-justifying source found) cards — never LLM-chosen. Any source_id
 *  prefix not in this map (should not happen — buildInputPacket.ts only
 *  ever emits these three) sorts last rather than throwing. */
const PORTFOLIO_SOURCE_PREFIX_PRIORITY: Record<string, number> = {
  pattern: 0,
  insight: 1,
  hypothesis: 2,
};

function sourcePrefix(sourceId: string): string {
  const colonIndex = sourceId.indexOf(':');
  return colonIndex === -1 ? sourceId : sourceId.slice(0, colonIndex);
}

function pickPrimarySourceId(itemId: number | null, sourceIds: string[]): string {
  if (sourceIds.length === 0) return '';
  const sorted = [...sourceIds].sort();

  if (itemId !== null) {
    const itemJustifyingSource = sorted.find((id) => id.startsWith('insight:') && id.endsWith(`:item:${itemId}`));
    if (itemJustifyingSource) return itemJustifyingSource;
    // Defensive fallback only (should not happen for real validated advice
    // — validateAdviceResponse.ts requires this to be resolvable whenever
    // item_id is non-null): falls through to the same portfolio-priority
    // selection below rather than throwing.
  }

  const byPortfolioPriority = [...sorted].sort((a, b) => {
    const priorityA = PORTFOLIO_SOURCE_PREFIX_PRIORITY[sourcePrefix(a)] ?? 99;
    const priorityB = PORTFOLIO_SOURCE_PREFIX_PRIORITY[sourcePrefix(b)] ?? 99;
    return priorityA !== priorityB ? priorityA - priorityB : a.localeCompare(b);
  });
  return byPortfolioPriority[0];
}

export function computeAdviceKey(card: AdviceKeyInput): string {
  const primarySourceId = pickPrimarySourceId(card.item_id, card.source_ids);
  return `${ADVICE_KEY_VERSION}:${card.item_id ?? '-'}:${primarySourceId}`;
}
