// URL <-> filter model for /leads. The URL is the ONLY source of truth:
// the page derives LeadFilters from searchParams on every render via
// parseLeadFilters() and writes changes back with leadsUrl() +
// router.replace/push — no mirrored local filter state exists to drift.
//
// Query params (all optional, invalid values are silently ignored):
//   search       free text: item name, trade item, notes
//   channel_id   deal_channels.id, or "none" (no normalized channel)
//   quality      LOW | ENGAGED | SERIOUS | HIGH_INTENT
//   serious_plus 1  -> quality IN (SERIOUS, HIGH_INTENT)
//   offer_type   NONE | CASH | TRADE | MIXED
//   offers       1  -> offer_type != NONE
//   status       OPEN | GHOSTED | ... | COMPLETED
//   from / to    YYYY-MM-DD, inclusive, on first_contact_at
//   item_id      inventory item id
//   attributed   1  -> ONLY meaningful with channel_id + from + to: restrict
//                to the exact channel-ATTRIBUTED cohort Listing Demand
//                Evidence counts (listing exposure on first_contact_at),
//                resolved server-side — never approximated here.
//   item_attributed 1 -> ONLY meaningful with item_id + from + to: restrict to
//                the exact ITEM-attributed cohort (listing exposure for that
//                item, on any channel, on first_contact_at), resolved
//                server-side. Plain item_id + from/to stays a raw filter.
//   expected     diagnostic only: the count the drill-down source claimed;
//                compared (console-only) against the actual result.

import {
  LEAD_QUALITIES, OFFER_TYPES, LEAD_STATUSES, SERIOUS_PLUS_QUALITIES,
  type LeadRow, type LeadQuality, type OfferType, type LeadStatus,
} from './leadTypes';

export const NO_CHANNEL = 'none' as const;

export interface LeadFilters {
  search: string;
  channel: number | typeof NO_CHANNEL | null;
  quality: LeadQuality | null;
  seriousPlus: boolean;
  offerType: OfferType | null;
  offers: boolean;
  status: LeadStatus | null;
  from: string | null;
  to: string | null;
  itemId: number | null;
  attributed: boolean;
  itemAttributed: boolean;
  expected: number | null;
}

export const EMPTY_LEAD_FILTERS: LeadFilters = {
  search: '', channel: null, quality: null, seriousPlus: false, offerType: null, offers: false,
  status: null, from: null, to: null, itemId: null, attributed: false, itemAttributed: false, expected: null,
};

/** True only for a real calendar date in strict YYYY-MM-DD form. */
export function isValidDateParam(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function posInt(v: string | null): number | null {
  return v !== null && /^\d{1,15}$/.test(v) && Number(v) > 0 ? Number(v) : null;
}

function oneOf<T extends string>(v: string | null, allowed: readonly T[]): T | null {
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** Derives filters from URL params. Anything invalid falls back to "no filter". */
export function parseLeadFilters(get: (key: string) => string | null): LeadFilters {
  const channelRaw = get('channel_id');
  const channel: LeadFilters['channel'] = channelRaw === NO_CHANNEL ? NO_CHANNEL : posInt(channelRaw);
  const fromRaw = get('from');
  const toRaw = get('to');
  const from = isValidDateParam(fromRaw) ? fromRaw : null;
  const to = isValidDateParam(toRaw) ? toRaw : null;
  // Attribution only makes sense for a concrete channel + a full date window.
  const attributed = get('attributed') === '1' && typeof channel === 'number' && from !== null && to !== null;
  const itemId = posInt(get('item_id'));
  const itemAttributed = get('item_attributed') === '1' && itemId !== null && from !== null && to !== null;
  return {
    search: (get('search') ?? '').trim().slice(0, 200),
    channel,
    quality: oneOf(get('quality'), LEAD_QUALITIES),
    seriousPlus: get('serious_plus') === '1',
    offerType: oneOf(get('offer_type'), OFFER_TYPES),
    offers: get('offers') === '1',
    status: oneOf(get('status'), LEAD_STATUSES),
    from,
    to,
    itemId,
    attributed,
    itemAttributed,
    expected: (() => { const n = get('expected'); return n !== null && /^\d{1,7}$/.test(n) ? Number(n) : null; })(),
  };
}

/** Canonical /leads URL for a filter set (defaults omitted, stable param order). */
export function leadsUrl(f: Partial<LeadFilters> = {}): string {
  const p = new URLSearchParams();
  if (f.search) p.set('search', f.search);
  if (f.channel != null) p.set('channel_id', String(f.channel));
  if (f.itemId != null) p.set('item_id', String(f.itemId));
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.attributed) p.set('attributed', '1');
  if (f.itemAttributed) p.set('item_attributed', '1');
  if (f.quality) p.set('quality', f.quality);
  if (f.seriousPlus) p.set('serious_plus', '1');
  if (f.offerType) p.set('offer_type', f.offerType);
  if (f.offers) p.set('offers', '1');
  if (f.status) p.set('status', f.status);
  if (f.expected != null) p.set('expected', String(f.expected));
  const qs = p.toString();
  return `/leads${qs ? `?${qs}` : ''}`;
}

/**
 * Applies a filter patch to the current (URL-derived) filters. Changing
 * channel/date drops the attribution cohort (a manual channel/date edit is
 * a plain filter again), and any change drops the diagnostic `expected`.
 */
export function patchLeadFilters(current: LeadFilters, patch: Partial<LeadFilters>): LeadFilters {
  const next: LeadFilters = { ...current, ...patch, expected: null };
  if ('channel' in patch || 'from' in patch || 'to' in patch) next.attributed = false;
  if ('itemId' in patch || 'from' in patch || 'to' in patch) next.itemAttributed = false;
  return next;
}

/** What the server needs to resolve the exact attributed cohort, or null when none applies. */
export function attributionRequest(f: LeadFilters): { channelId: number; from: string; to: string } | null {
  if (f.attributed && typeof f.channel === 'number' && f.from && f.to) {
    return { channelId: f.channel, from: f.from, to: f.to };
  }
  return null;
}

/** What the server needs to resolve the exact item-attributed cohort, or null when none applies. */
export function itemAttributionRequest(f: LeadFilters): { itemId: number; from: string; to: string } | null {
  if (f.itemAttributed && f.itemId !== null && f.from && f.to) {
    return { itemId: f.itemId, from: f.from, to: f.to };
  }
  return null;
}

function matchesSearch(lead: LeadRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${lead.item_name}\n${lead.trade_item ?? ''}\n${lead.notes ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

/**
 * Pure filter. `attributedIds` must be supplied when filters.attributed is
 * true (it is the server-resolved cohort); if it is missing the result is
 * empty rather than silently un-attributed.
 */
export function applyLeadFilters(
  rows: LeadRow[],
  f: LeadFilters,
  attributedIds: ReadonlySet<number> | null,
  itemAttributedIds: ReadonlySet<number> | null = null,
): LeadRow[] {
  const tokens = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((l) => {
    if (f.attributed && !(attributedIds && attributedIds.has(l.id))) return false;
    if (f.itemAttributed && !(itemAttributedIds && itemAttributedIds.has(l.id))) return false;
    if (f.channel === NO_CHANNEL && l.deal_channel_id !== null) return false;
    if (typeof f.channel === 'number' && l.deal_channel_id !== f.channel) return false;
    if (f.quality && l.lead_quality !== f.quality) return false;
    if (f.seriousPlus && !SERIOUS_PLUS_QUALITIES.includes(l.lead_quality)) return false;
    if (f.offerType && l.offer_type !== f.offerType) return false;
    if (f.offers && l.offer_type === 'NONE') return false;
    if (f.status && l.status !== f.status) return false;
    if (f.itemId != null && l.inventory_item_id !== f.itemId) return false;
    if (f.from && !(l.first_contact_at && l.first_contact_at >= f.from)) return false;
    if (f.to && !(l.first_contact_at && l.first_contact_at <= f.to)) return false;
    return matchesSearch(l, tokens);
  });
}

/** first_contact_at DESC (undated last), then last_contact_at DESC, then id DESC — deterministic. */
export function sortLeadsRecentFirst(rows: LeadRow[]): LeadRow[] {
  const cmpDesc = (a: string | null, b: string | null) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? 1 : -1;
  };
  return [...rows].sort((a, b) => cmpDesc(a.first_contact_at, b.first_contact_at) || cmpDesc(a.last_contact_at, b.last_contact_at) || b.id - a.id);
}

// ── Quick filters (conveniences over the same params, no new semantics) ──

export type QuickFilterKey = 'all' | 'open' | 'serious' | 'offers' | 'completed';

export const QUICK_FILTERS: { key: QuickFilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'serious', label: 'Serious+' },
  { key: 'offers', label: 'Offers' },
  { key: 'completed', label: 'Completed' },
];

export function activeQuickFilter(f: LeadFilters): QuickFilterKey | null {
  if (!f.status && !f.seriousPlus && !f.offers) return 'all';
  if (f.status === 'OPEN' && !f.seriousPlus && !f.offers) return 'open';
  if (f.status === 'COMPLETED' && !f.seriousPlus && !f.offers) return 'completed';
  if (f.seriousPlus && !f.status && !f.offers) return 'serious';
  if (f.offers && !f.status && !f.seriousPlus) return 'offers';
  return null;
}

/** Patch that selects one quick filter (each replaces the other quick-controlled params). */
export function quickFilterPatch(key: QuickFilterKey): Partial<LeadFilters> {
  const base = { status: null, seriousPlus: false, offers: false };
  switch (key) {
    case 'open': return { ...base, status: 'OPEN' };
    case 'serious': return { ...base, seriousPlus: true };
    case 'offers': return { ...base, offers: true };
    case 'completed': return { ...base, status: 'COMPLETED' };
    default: return base;
  }
}
