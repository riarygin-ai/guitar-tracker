// Listing terms — asking price + Trade flag — per platform. Pure (no I/O):
// shared by the item page's listing card, the MCP manage_listing service
// and the read models.
//
// The database is authoritative: public.listing_terms_error() (migration
// 20261026000000) enforces the same rule for every write. This module only
// mirrors it so the UI can show a friendly message before saving, and maps
// the database's error codes back to the same wording.
//
//   Marketplace  price required; Trade optional
//   Kijiji       price OR Trade (Trade with no price = trade only)
//   Reverb       price required; no Trade (a Reverb listing is a sale listing)
//
// Offer mode is derived, never stored: price + no Trade = sale only,
// price + Trade = sale + trade, no price + Trade = trade only.

export type ListingTermsErrorCode =
  | 'LISTING_TRADE_NOT_SUPPORTED'
  | 'LISTING_PRICE_INVALID'
  | 'LISTING_PRICE_OR_TRADE_REQUIRED'
  | 'LISTING_PRICE_REQUIRED';

export type ListingOfferMode = 'SALE_ONLY' | 'SALE_AND_TRADE' | 'TRADE_ONLY';

function platformKey(platformName: string | null | undefined): string {
  return (platformName ?? '').trim().toLowerCase();
}

/** Marketplace and Kijiji listings can be offered for trade; Reverb (and any other platform) cannot. */
export function platformSupportsTrade(platformName: string | null | undefined): boolean {
  const k = platformKey(platformName);
  return k === 'marketplace' || k === 'kijiji';
}

/** Kijiji is the only platform where a listing may have no asking price (trade only). */
export function platformAllowsTradeOnly(platformName: string | null | undefined): boolean {
  return platformKey(platformName) === 'kijiji';
}

/** Same rule, same order, as public.listing_terms_error(). null = valid terms for an active listing. */
export function listingTermsError(platformName: string | null | undefined, askingPrice: number | null, tradeEnabled: boolean): ListingTermsErrorCode | null {
  if (tradeEnabled && !platformSupportsTrade(platformName)) return 'LISTING_TRADE_NOT_SUPPORTED';
  if (askingPrice != null && !(askingPrice > 0)) return 'LISTING_PRICE_INVALID';
  if (platformAllowsTradeOnly(platformName)) return askingPrice == null && !tradeEnabled ? 'LISTING_PRICE_OR_TRADE_REQUIRED' : null;
  if (askingPrice == null) return 'LISTING_PRICE_REQUIRED';
  return null;
}

export const LISTING_TERMS_MESSAGE: Record<ListingTermsErrorCode, string> = {
  LISTING_TRADE_NOT_SUPPORTED: 'Trade is not available for this platform.',
  LISTING_PRICE_INVALID: 'Listed price must be greater than 0.',
  LISTING_PRICE_OR_TRADE_REQUIRED: 'Enter a price or enable Trade.',
  LISTING_PRICE_REQUIRED: 'Listed price is required.',
};

/** The UI message for a terms problem, or null when the terms are valid. */
export function listingTermsMessage(platformName: string | null | undefined, askingPrice: number | null, tradeEnabled: boolean): string | null {
  const code = listingTermsError(platformName, askingPrice, tradeEnabled);
  return code ? LISTING_TERMS_MESSAGE[code] : null;
}

export function listingOfferMode(askingPrice: number | null, tradeEnabled: boolean): ListingOfferMode | null {
  if (askingPrice != null) return tradeEnabled ? 'SALE_AND_TRADE' : 'SALE_ONLY';
  return tradeEnabled ? 'TRADE_ONLY' : null;
}

export function fmtListingPrice(price: number): string {
  return `C$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** "C$1,800", "C$1,800 · Trade", "Trade only", or "No price" (legacy listings without a price). */
export function formatListingTerms(askingPrice: number | null, tradeEnabled: boolean): string {
  if (askingPrice != null) return tradeEnabled ? `${fmtListingPrice(askingPrice)} · Trade` : fmtListingPrice(askingPrice);
  return tradeEnabled ? 'Trade only' : 'No price';
}
