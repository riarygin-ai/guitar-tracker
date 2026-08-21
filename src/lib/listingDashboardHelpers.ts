// Pure helpers for the Listing Dashboard (src/app/listings/page.tsx),
// extracted so they're importable from a plain Node test script — the
// page itself is 'use client' and imports next/navigation-adjacent
// modules that don't load outside the Next.js runtime.

import type { ListingEvidence } from './analytics/listingEvidence';

export function fmtMoney(v: number | null): string {
  if (v == null) return '—';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.round(Math.abs(v)).toLocaleString()}`;
}

export function fmtDays(v: number | null): string {
  if (v == null) return '—';
  return `${Math.round(v)}d`;
}

/** Builds an /inventory drill-down URL. Every value here is either a raw
 * evidence field or a simple filter code — never a recomputed listing
 * state. */
export function inventoryUrl(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `/inventory${s ? `?${s}` : ''}`;
}

/** First matching item's purpose_id for a given purpose_name, scanned
 * across every item array Listing Evidence exposes (listed + unlisted
 * business/hybrid/unclassified). Personal is intentionally excluded from
 * this search's typical use — the Dashboard's Personal section never
 * drills down at all. */
export function findPurposeId(evidence: ListingEvidence, purposeName: string): number | null {
  for (const item of evidence.listed_items) {
    if (item.purpose_name === purposeName && item.purpose_id != null) return item.purpose_id;
  }
  for (const item of [
    ...evidence.unlisted_open_inventory.business,
    ...evidence.unlisted_open_inventory.hybrid,
    ...evidence.unlisted_open_inventory.unclassified,
  ]) {
    if (item.purpose_name === purposeName && item.purpose_id != null) return item.purpose_id;
  }
  return null;
}
