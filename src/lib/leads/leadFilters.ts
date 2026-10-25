// URL <-> filter model for /leads. The URL is the ONLY source of truth:
// the page derives LeadFilters from searchParams on every render via
// parseLeadFilters() and writes changes back with leadsUrl() +
// router.replace/push — no mirrored local filter state exists to drift.
//
// Query params (all optional, invalid values are silently ignored):
//   search       free text: contact name, item name, trade item, notes
//   name         EXACT contact_name (table click). Filters by the displayed
//                name only — the same name is NOT asserted to be the same person.
//   channel_id   deal_channels.id, or "none" (no normalized channel)
//   stage        peak_stage: INQUIRY | ENGAGED | NEGOTIATING | HIGH_INTENT | CONVERTED
//   negotiating_plus 1 -> peak_stage IN (NEGOTIATING, HIGH_INTENT, CONVERTED);
//                legacy quality SERIOUS/HIGH_INTENT while peak_stage is unset
//                (same rule as Listing Demand). Old serious_plus=1 links parse as this.
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
//   return_to    internal /listings URL the back arrow returns to (validated by
//                safeReturnTo; anything else is dropped -> back goes to /listings)
//   expected     diagnostic only: the count the drill-down source claimed;
//                compared (console-only) against the actual result.
//   sort / dir   table sort (LEAD_SORT_KEYS, asc | desc; see sortLeads);
//                absent = the default recent-first order.

import { safeReturnTo } from '../listingsReturn';
import { normalizeContactName } from './contactName';
import { leadChannelLabel } from './leadFormat';
import {
  OFFER_TYPES, LEAD_STATUSES, SERIOUS_PLUS_QUALITIES,
  type LeadRow, type OfferType, type LeadStatus,
} from './leadTypes';
import { LEAD_STAGES, LEAD_STATUSES as LIFECYCLE_STATUSES, NEGOTIATING_PLUS_STAGES, STAGE_RANK, type LeadStage } from './semantics';

export const NO_CHANNEL = 'none' as const;

export const LEAD_SORT_KEYS = ['date', 'name', 'item', 'channel', 'stage', 'offer', 'status', 'messages', 'last_contact'] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface LeadFilters {
  search: string;
  /** Exact contact_name (null = no name filter). */
  name: string | null;
  channel: number | typeof NO_CHANNEL | null;
  stage: LeadStage | null;
  negotiatingPlus: boolean;
  offerType: OfferType | null;
  offers: boolean;
  status: LeadStatus | null;
  from: string | null;
  to: string | null;
  itemId: number | null;
  attributed: boolean;
  itemAttributed: boolean;
  returnTo: string | null;
  expected: number | null;
  sort: LeadSortKey | null;
  dir: SortDir;
}

export const EMPTY_LEAD_FILTERS: LeadFilters = {
  search: '', name: null, channel: null, stage: null, negotiatingPlus: false, offerType: null, offers: false,
  status: null, from: null, to: null, itemId: null, attributed: false, itemAttributed: false, returnTo: null, expected: null,
  sort: null, dir: 'asc',
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
  const name = (get('name') ?? '').trim().slice(0, 200);
  const sort = oneOf(get('sort'), LEAD_SORT_KEYS);
  return {
    search: (get('search') ?? '').trim().slice(0, 200),
    name: name || null,
    channel,
    stage: oneOf(get('stage'), LEAD_STAGES),
    negotiatingPlus: get('negotiating_plus') === '1' || get('serious_plus') === '1',
    offerType: oneOf(get('offer_type'), OFFER_TYPES),
    offers: get('offers') === '1',
    status: oneOf(get('status'), LEAD_STATUSES),
    from,
    to,
    itemId,
    attributed,
    itemAttributed,
    returnTo: safeReturnTo(get('return_to')),
    expected: (() => { const n = get('expected'); return n !== null && /^\d{1,7}$/.test(n) ? Number(n) : null; })(),
    sort,
    dir: sort && get('dir') === 'desc' ? 'desc' : 'asc',
  };
}

/** Canonical /leads URL for a filter set (defaults omitted, stable param order). */
export function leadsUrl(f: Partial<LeadFilters> = {}): string {
  const p = new URLSearchParams();
  if (f.search) p.set('search', f.search);
  if (f.name) p.set('name', f.name);
  if (f.channel != null) p.set('channel_id', String(f.channel));
  if (f.itemId != null) p.set('item_id', String(f.itemId));
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.attributed) p.set('attributed', '1');
  if (f.itemAttributed) p.set('item_attributed', '1');
  if (f.stage) p.set('stage', f.stage);
  if (f.negotiatingPlus) p.set('negotiating_plus', '1');
  if (f.offerType) p.set('offer_type', f.offerType);
  if (f.offers) p.set('offers', '1');
  if (f.status) p.set('status', f.status);
  if (f.expected != null) p.set('expected', String(f.expected));
  if (f.sort) { p.set('sort', f.sort); p.set('dir', f.dir === 'desc' ? 'desc' : 'asc'); }
  if (f.returnTo) p.set('return_to', f.returnTo);
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
  // contact_name also in its contact-matching normalization (accents, apostrophe variants, periods) so "zoe" finds "Zoë".
  const name = lead.contact_name ?? '';
  const haystack = `${name}\n${normalizeContactName(name)}\n${lead.item_name}\n${lead.trade_item ?? ''}\n${lead.notes ?? ''}`.toLowerCase();
  return tokens.every((t) => haystack.includes(t) || haystack.includes(normalizeContactName(t)));
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
    if (f.name != null && l.contact_name !== f.name) return false;
    if (f.stage && l.peak_stage !== f.stage) return false;
    // Negotiating+ (same rule as the listing-demand SQL: peak_stage, legacy quality while unset).
    if (f.negotiatingPlus && !(l.peak_stage != null ? NEGOTIATING_PLUS_STAGES.includes(l.peak_stage) : l.lead_quality != null && SERIOUS_PLUS_QUALITIES.includes(l.lead_quality))) return false;
    if (f.offerType && l.offer_type !== f.offerType) return false;
    if (f.offers && l.offer_type === 'NONE') return false;
    if (f.status && l.status !== f.status) return false;
    if (f.itemId != null && l.inventory_item_id !== f.itemId) return false;
    if (f.from && !(l.first_contact_at && l.first_contact_at >= f.from)) return false;
    if (f.to && !(l.first_contact_at && l.first_contact_at <= f.to)) return false;
    return matchesSearch(l, tokens);
  });
}

const cmpDesc = (a: string | null, b: string | null) => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
};
const recentFirst = (a: LeadRow, b: LeadRow) => cmpDesc(a.first_contact_at, b.first_contact_at) || cmpDesc(a.last_contact_at, b.last_contact_at) || b.id - a.id;

/** first_contact_at DESC (undated last), then last_contact_at DESC, then id DESC — deterministic. */
export function sortLeadsRecentFirst(rows: LeadRow[]): LeadRow[] {
  return [...rows].sort(recentFirst);
}

// ── Table sort ───────────────────────────────────────────────────────────
// Each column maps a row to a comparable value; null = unknown and is ALWAYS
// last, in either direction. Ties fall back to the default recent-first order.
//   date / last_contact   first_contact_at / last_contact_at
//   name / item / channel case-insensitive text (item = the displayed item_name)
//   stage     INQUIRY < ENGAGED < NEGOTIATING < HIGH_INTENT < CONVERTED
//   status    lifecycle order of semantics.LEAD_STATUSES: OPEN, AGREED,
//             COMPLETED, FAILED_AFTER_AGREEMENT, DECLINED_BY_ME,
//             DECLINED_BY_THEM, GHOSTED, CLOSED
//   offer     "No offer" counts as unknown (last); then offer type
//             CASH < MIXED < TRADE; then that type's stored amount (CASH: best
//             ?? initial cash offer, MIXED: cash_component, TRADE:
//             trade_est_value), a missing amount last within its type.
//             No valuation is invented.
//   messages  buyer + our count; one missing count adds 0, both missing = unknown
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const OFFER_TYPE_ORDER: Record<OfferType, number> = { CASH: 1, MIXED: 2, TRADE: 3, NONE: 0 };
const STATUS_ORDER = new Map<string, number>(LIFECYCLE_STATUSES.map((s, i) => [s, i]));

type SortValue = string | number | (number | null)[] | null;
function sortValue(l: LeadRow, key: LeadSortKey): SortValue {
  switch (key) {
    case 'date': return l.first_contact_at;
    case 'last_contact': return l.last_contact_at;
    case 'name': return l.contact_name?.trim() || null;
    case 'item': return l.item_name;
    case 'channel': return leadChannelLabel(l);
    case 'stage': return l.peak_stage ? STAGE_RANK[l.peak_stage] : null;
    case 'status': return STATUS_ORDER.get(l.status) ?? null;
    case 'messages': return l.buyer_message_count == null && l.our_message_count == null ? null : (l.buyer_message_count ?? 0) + (l.our_message_count ?? 0);
    case 'offer': {
      if (l.offer_type === 'NONE') return null;
      const amount = l.offer_type === 'CASH' ? l.best_cash_offer ?? l.initial_cash_offer : l.offer_type === 'MIXED' ? l.cash_component : l.trade_est_value;
      return [OFFER_TYPE_ORDER[l.offer_type], amount == null ? null : Number(amount)];
    }
  }
}

/** Two known values; tuples compare element-wise with a missing element last in either direction. */
function compareValues(a: Exclude<SortValue, null>, b: Exclude<SortValue, null>, sign: number): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? null;
      const y = b[i] ?? null;
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sign;
    }
    return 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b) * sign;
  return (a < b ? -1 : a > b ? 1 : 0) * sign;
}

/** Sorts by a table column (no column = the default recent-first order). Never filters: the count is unchanged. */
export function sortLeads(rows: LeadRow[], sort: LeadSortKey | null, dir: SortDir = 'asc'): LeadRow[] {
  if (!sort) return sortLeadsRecentFirst(rows);
  const sign = dir === 'desc' ? -1 : 1;
  const keyed = rows.map((l) => ({ l, v: sortValue(l, sort) }));
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === b.v ? recentFirst(a.l, b.l) : a.v === null ? 1 : -1;
    return compareValues(a.v, b.v, sign) || recentFirst(a.l, b.l);
  });
  return keyed.map((k) => k.l);
}

/** Header click cycle: other column -> ascending -> descending -> off (default order). */
export function nextSort(current: Pick<LeadFilters, 'sort' | 'dir'>, key: LeadSortKey): Pick<LeadFilters, 'sort' | 'dir'> {
  if (current.sort !== key) return { sort: key, dir: 'asc' };
  if (current.dir === 'asc') return { sort: key, dir: 'desc' };
  return { sort: null, dir: 'asc' };
}

// ── Quick filters (conveniences over the same params, no new semantics) ──

export type QuickFilterKey = 'all' | 'open' | 'negotiating' | 'offers' | 'completed';

export const QUICK_FILTERS: { key: QuickFilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'negotiating', label: 'Negotiating+' },
  { key: 'offers', label: 'Offers' },
  { key: 'completed', label: 'Completed' },
];

export function activeQuickFilter(f: LeadFilters): QuickFilterKey | null {
  if (!f.status && !f.negotiatingPlus && !f.offers) return 'all';
  if (f.status === 'OPEN' && !f.negotiatingPlus && !f.offers) return 'open';
  if (f.status === 'COMPLETED' && !f.negotiatingPlus && !f.offers) return 'completed';
  if (f.negotiatingPlus && !f.status && !f.offers) return 'negotiating';
  if (f.offers && !f.status && !f.negotiatingPlus) return 'offers';
  return null;
}

/** Patch that selects one quick filter (each replaces the other quick-controlled params). */
export function quickFilterPatch(key: QuickFilterKey): Partial<LeadFilters> {
  const base = { status: null, negotiatingPlus: false, offers: false };
  switch (key) {
    case 'open': return { ...base, status: 'OPEN' };
    case 'negotiating': return { ...base, negotiatingPlus: true };
    case 'offers': return { ...base, offers: true };
    case 'completed': return { ...base, status: 'COMPLETED' };
    default: return base;
  }
}
