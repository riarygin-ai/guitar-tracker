// Return context for the Listings -> Leads drill-down. A drill-down URL
// carries `return_to=<the exact current /listings URL>` (path + query, so
// trend_weeks — and any future Listings query param — survives without the
// drill-down builders knowing about it). The value is user-controllable
// input on /leads, so it is validated: ONLY an internal `/listings` path
// (optionally with a query string) is ever honored; everything else —
// absolute URLs, protocol-relative `//host`, `javascript:`, backslashes,
// control chars, whitespace, fragments, other internal routes — falls back
// to `/listings`. No open redirect is possible.
//
// The only other honored target is the Dashboard root, exactly `/` (no query,
// no fragment) — used when the shared Business Coach drawer is opened from the
// Dashboard. Any further caller must be added to this allowlist explicitly.

export const LISTINGS_PATH = '/listings';
export const DASHBOARD_PATH = '/';
const MAX_LEN = 500;

/** Returns the value when it is a safe internal return target (/listings[?query] or exactly `/`), else null. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LEN) return null;
  if (value === DASHBOARD_PATH) return value;
  if (value !== LISTINGS_PATH && !value.startsWith(`${LISTINGS_PATH}?`)) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // control chars, space, DEL, non-ASCII, '#' (fragment), '\' (backslash)
    if (c <= 0x20 || c >= 0x7f || c === 0x23 || c === 0x5c) return null;
  }
  return value;
}

/** Where the /leads back arrow goes: validated return_to, else plain /listings. */
export function resolveBackHref(returnTo: string | null | undefined): string {
  return safeReturnTo(returnTo) ?? LISTINGS_PATH;
}

/** Label for the /leads back arrow matching the validated return target. */
export function resolveBackLabel(returnTo: string | null | undefined): string {
  return safeReturnTo(returnTo) === DASHBOARD_PATH ? 'Back to Dashboard' : 'Back to Listings';
}

/** The canonical current Listings URL (path + the real query string) to embed as return_to. */
export function currentListingsReturnTo(search: string): string {
  const qs = search.startsWith('?') ? search.slice(1) : search;
  return safeReturnTo(qs ? `${LISTINGS_PATH}?${qs}` : LISTINGS_PATH) ?? LISTINGS_PATH;
}
