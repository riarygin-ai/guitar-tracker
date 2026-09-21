// Semantic identity for a Listing Advice card, used for dismissal — the same
// idea as the general Coach's computeAdviceKey (advice/adviceKey.ts): the key
// is derived ONLY from the sources the card cites (mechanically, never from
// LLM-authored title/summary wording, which may reword between runs for the
// same underlying finding). A new Analytics run that produces a card resting
// on the same primary source therefore keeps the same key and stays
// dismissed until the fixed 30-day resurface window passes.
//
// Namespaced with `listing:` so a Listing Advice key can never collide with a
// general Coach key in the shared analytics_advice_dismissals table (both can
// cite e.g. demand:market_trend). Pure and client-safe (no crypto/server
// imports).

export const LISTING_ADVICE_KEY_PREFIX = 'listing:';
export const LISTING_ADVICE_KEY_VERSION = 'v1';

const PRIORITY: { prefix: string; rank: number }[] = [
  { prefix: 'demand:item:', rank: 0 }, // an item-level card is anchored on its item
  { prefix: 'demand:channel:', rank: 1 },
  { prefix: 'demand:market_trend', rank: 2 },
  { prefix: 'demand:data_quality', rank: 3 },
];

function rank(id: string): number {
  return PRIORITY.find((p) => id.startsWith(p.prefix))?.rank ?? 99;
}

/** Deterministic primary cited source: item > channel > market > data quality, ties broken lexicographically. */
export function pickListingPrimarySource(sourceIds: readonly string[]): string {
  if (sourceIds.length === 0) return '';
  return [...sourceIds].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

export function listingAdviceKey(card: { source_ids: readonly string[] }): string {
  return `${LISTING_ADVICE_KEY_PREFIX}${LISTING_ADVICE_KEY_VERSION}:${pickListingPrimarySource(card.source_ids)}`;
}
