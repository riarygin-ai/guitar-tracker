// Contact city / phone on a lead — identity SIGNALS, never lead identity.
// Pure, no dependencies.
//
// Phone: one person, possibly many leads (items, channels, episodes). A shared
// normalized phone means "likely the same contact", never "the same lead";
// leads are never merged on it.
//
// Normalization is deliberately narrow: Canada/US (NANP) numbers only.
// Anything else (international, extensions, too few/many digits, invalid area
// or exchange code) keeps its display form but gets NO normalized value — a
// country code is never guessed.
//
// City: the contact's own city (residence/base), explicitly stated. A meeting
// place is not a city. Compared case-/space-insensitively; a trailing
// ", ON" / ", Ontario" province suffix is ignored.

export const CONTACT_CITY_MAX = 80;
export const CONTACT_PHONE_MAX = 40;

const NANP_10 = /^([2-9]\d{2})([2-9]\d{2})(\d{4})$/;

/**
 * Canonical E.164 form (+1XXXXXXXXXX) of a Canada/US number, or null when the
 * input cannot be interpreted safely.
 *   647-555-1234 | (647) 555-1234 | +1 647 555 1234 | 1-647-555-1234 → +16475551234
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || s.length > CONTACT_PHONE_MAX) return null;
  // Only phone punctuation: letters (ext, x, words) make the number unreliable.
  if (!/^\+?[\d\s().\-]+$/.test(s)) return null;
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  let national: string;
  if (digits.length === 10 && !plus) national = digits;
  else if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else return null; // +44…, 7-digit local numbers, extensions written as digits, etc.
  const m = NANP_10.exec(national);
  if (!m) return null;
  // N11 service codes (411, 911…) are never a person's area code.
  if (m[1][1] === '1' && m[1][2] === '1') return null;
  return `+1${national}`;
}

/** Digits only — the comparison key for a phone that could not be normalized. */
export function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** "(647) 555-1234" for a normalized number. */
export function formatNanp(normalized: string): string {
  const n = normalized.replace(/^\+1/, '');
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
}

/**
 * The stored display form: the observed text (whitespace collapsed), except
 * that a bare digit string of a normalizable number is formatted readably.
 */
export function displayPhone(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  const n = normalizePhone(s);
  return n && /^\+?\d+$/.test(s) ? formatNanp(n) : s;
}

/** "…1234" — a short hint that never exposes the full number. */
export function maskedPhone(phone: string | null | undefined): string | null {
  const d = phoneDigits(phone);
  return d.length >= 4 ? `…${d.slice(-4)}` : null;
}

export type PhoneValidation =
  | { ok: true; display: string; normalized: string | null }
  | { ok: false; message: string };

/** Validates an observed phone for storage. Too few digits = not a phone number (rejected); unusual formats are kept un-normalized. */
export function validatePhone(raw: string): PhoneValidation {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length > CONTACT_PHONE_MAX) return { ok: false, message: `contact_phone must be at most ${CONTACT_PHONE_MAX} characters` };
  const digits = phoneDigits(s);
  if (digits.length < 7 || digits.length > 15) return { ok: false, message: 'contact_phone must contain a phone number (7-15 digits)' };
  return { ok: true, display: displayPhone(s), normalized: normalizePhone(s) };
}

/** Same phone? Normalized values when both have one; otherwise digit strings. */
export function samePhone(a: { phone: string | null; normalized: string | null }, b: { phone: string | null; normalized: string | null }): boolean {
  if (a.normalized && b.normalized) return a.normalized === b.normalized;
  const da = phoneDigits(a.phone);
  return da !== '' && da === phoneDigits(b.phone);
}

/** Stored form of a typed city: whitespace collapsed, trimmed; '' → null. */
export function cleanCity(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Comparison key: case, accents, punctuation spacing and a trailing Ontario suffix ignored. */
export function cityKey(raw: string | null | undefined): string | null {
  const s = cleanCity(raw);
  if (!s) return null;
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // A separate province token only: "Burlington" must keep its trailing "on".
    .replace(/(?:,\s*|\s+)(on|ont|ontario)\.?$/, '')
    .replace(/[.]/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

export function validateCity(raw: string): { ok: true; city: string } | { ok: false; message: string } {
  const c = cleanCity(raw);
  if (!c) return { ok: false, message: 'contact_city must not be empty' };
  if (c.length > CONTACT_CITY_MAX) return { ok: false, message: `contact_city must be at most ${CONTACT_CITY_MAX} characters` };
  if (!/[a-zA-ZÀ-ɏ]/.test(c) || /\d{3,}/.test(c)) return { ok: false, message: 'contact_city must be a place name' };
  return { ok: true, city: c };
}
