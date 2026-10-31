// Optional return destination for the inventory item editor
// (/inventory/[id]?returnTo=...). After Save / Cancel / Back the editor goes
// there instead of the Inventory list. The value is user-controllable, so
// ONLY explicitly allowlisted internal pages are honored (no open redirect):
// currently an operation draft page, /operations/drafts/<id>. Everything else
// is ignored and the editor keeps its normal Inventory behavior.

const ALLOWED: { pattern: RegExp; label: string }[] = [
  { pattern: /^\/operations\/drafts\/[1-9][0-9]{0,15}$/, label: 'Back to draft' },
];

/** The validated return target, or null. */
export function safeItemReturnTo(value: string | string[] | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  return ALLOWED.some((a) => a.pattern.test(value)) ? value : null;
}

/** Back-link label for a validated return target. */
export function itemReturnLabel(returnTo: string | null): string {
  return (returnTo && ALLOWED.find((a) => a.pattern.test(returnTo))?.label) || 'Back to Inventory';
}
