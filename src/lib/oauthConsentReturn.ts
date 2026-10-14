// Safe post-login redirect target for the OAuth consent flow ONLY. The
// value is attacker-controllable (an unauthenticated visitor can craft
// `/login?redirect_to=...`), so — same convention as
// src/lib/listingsReturn.ts's safeReturnTo for /listings — only one exact
// internal path prefix is ever honored; everything else (absolute URLs,
// protocol-relative `//host`, `javascript:`, backslashes, control chars,
// fragments, any other route) falls back to `null` (caller then uses its
// own default, e.g. `/`). No open redirect is possible.

const CONSENT_PATH = '/oauth/consent';
const MAX_LEN = 500;

/** Returns `value` when it is a safe `/oauth/consent[?query]` target, else null. */
export function safeLoginRedirect(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LEN) return null;
  if (value !== CONSENT_PATH && !value.startsWith(`${CONSENT_PATH}?`)) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    // control chars, space, DEL, non-ASCII, '#' (fragment), '\' (backslash)
    if (c <= 0x20 || c >= 0x7f || c === 0x23 || c === 0x5c) return null;
  }
  return value;
}
