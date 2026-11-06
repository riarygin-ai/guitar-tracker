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
// City: the current / best observed city ASSOCIATED with the contact — shown
// on their own listing (LISTING) or profile (PROFILE), stated in their message
// (MESSAGE) or entered by the user (MANUAL). Location evidence, not a proven
// residence. Never the user's own listing location, a meeting / pickup place
// or a travel destination. Compared case-/space-insensitively; a trailing
// ", ON" / ", Ontario" province suffix is ignored. A different city never
// means a different person.

export const CONTACT_CITY_MAX = 80;
export const CONTACT_CITY_CONTEXT_MAX = 80;
export const CONTACT_PHONE_MAX = 40;

export const CONTACT_CITY_SOURCES = ['LISTING', 'PROFILE', 'MESSAGE', 'MANUAL'] as const;
export type ContactCitySource = (typeof CONTACT_CITY_SOURCES)[number];

export const CITY_SOURCE_LABEL: Record<ContactCitySource, string> = {
  LISTING: 'Listing', PROFILE: 'Profile', MESSAGE: 'Message', MANUAL: 'Manual',
};

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

/** A short, safe provenance reference ("Kijiji listing"); not copied message text. */
export function validateCityContext(raw: string): { ok: true; context: string } | { ok: false; message: string } {
  const c = cleanCity(raw);
  if (!c) return { ok: false, message: 'contact_city_source_context must not be empty' };
  if (c.length > CONTACT_CITY_CONTEXT_MAX) return { ok: false, message: `contact_city_source_context must be at most ${CONTACT_CITY_CONTEXT_MAX} characters (a short reference such as "Kijiji listing", not message text)` };
  return { ok: true, context: c };
}

// ── How a city is mentioned in a message ───────────────────────────────────
//
// SELF: the city belongs to the contact ("I'm in Barrie", "I live in Oakville",
// "based in Hamilton", "located in Windsor", "I'm from Belleville").
// LOGISTICS: a meeting / pickup / delivery / shipping place ("can meet in
// Burlington", "pickup in Barrie"). TRAVEL: somewhere they are going ("I'm
// driving to Barrie tomorrow", "I'll be in Toronto"). Only SELF makes a
// MESSAGE-sourced contact city; the server refuses a MESSAGE city that the
// interaction mentions only as logistics/travel.

export type CityMention = 'SELF' | 'LOGISTICS' | 'TRAVEL';

const plain = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cityMentions(text: string, city: string): CityMention[] {
  const c = cleanCity(city);
  if (!c) return [];
  const t = plain(text);
  // "St. Catharines" also matches "st catharines"; the city must end at a word boundary.
  const C = escapeRe(plain(c)).replace(/\\\.\s*|\s+/g, String.raw`\.?\s*`) + '(?![a-z])';
  const out = new Set<CityMention>();
  const travel = String.raw`\b(?:going|driving|heading|travell?ing|coming|flying|commuting|visiting|trip|drive|go|head|travel|be)\s+(?:to|into|through|over to|down to|up to|in)\s+` + C;
  const logistics = String.raw`\b(?:meet|meeting|meetup|meet-up|pick\s?-?up|drop\s?-?off|deliver|delivery|ship|shipping|shipped|halfway|exchange|handoff|hand-off)\b[^.;!?\n]{0,30}?\b(?:in|at|to|near|around)\s+` + C;
  // Self-location needs the city right after the phrase, so "I'm driving to Barrie" never qualifies.
  const self = [
    String.raw`\b(?:i'?m|i am|im|we'?re|we are)\s+(?:(?:currently\s+|also\s+)?(?:in|near|from|out of|around)\s+)?` + C,
    String.raw`\b(?:live|lives|living|based|located|reside|resides|residing|is|are)\s+(?:in|near|out of|around)\s+` + C,
  ];
  if (new RegExp(travel).test(t)) out.add('TRAVEL');
  if (new RegExp(logistics).test(t)) out.add('LOGISTICS');
  if (self.some((p) => new RegExp(p).test(t))) out.add('SELF');
  return Array.from(out);
}

/** Does the text only place the city as logistics/travel (never as the contact's own location)? */
export function cityIsOnlyLogistics(texts: string[], city: string): boolean {
  const all = texts.flatMap((t) => cityMentions(t, city));
  return all.length > 0 && !all.includes('SELF');
}
