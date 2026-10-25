// Pure search / sort for /listings "Lead Activity by Item" (client-side over
// the full, bounded row set: one row per open item that has leads).

import type { ItemLeadActivityRow } from './analytics/itemLeadActivity';

export type { ItemLeadActivityRow };

export const ITEM_ACTIVITY_SORTS = [
  { key: 'recent', label: 'Recent activity' },
  { key: 'leads', label: 'Leads' },
  { key: 'negotiating', label: 'Negotiating+' },
  { key: 'offers', label: 'Offers' },
  { key: 'channel_days', label: 'Channel Days' },
  { key: 'item', label: 'Item' },
] as const;
export type ItemActivitySort = (typeof ITEM_ACTIVITY_SORTS)[number]['key'];
export const DEFAULT_ITEM_ACTIVITY_SORT: ItemActivitySort = 'recent';

export function parseItemActivitySort(v: string | null | undefined): ItemActivitySort {
  return ITEM_ACTIVITY_SORTS.some((s) => s.key === v) ? (v as ItemActivitySort) : DEFAULT_ITEM_ACTIVITY_SORT;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Case-insensitive; every query word must match the item name (which carries
 * year / brand / model) or brand. A short all-letter word (2-4) also matches
 * the initials of consecutive name words, so "LP" finds "Les Paul" and
 * "LP Special" finds "1994 Gibson Les Paul Special custom shop".
 */
export function matchesItemQuery(row: Pick<ItemLeadActivityRow, 'item_display_name' | 'brand_name'>, query: string): boolean {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const hay = norm(`${row.item_display_name} ${row.brand_name ?? ''}`);
  const tokens = hay.split(/[^a-z0-9]+/).filter(Boolean);
  return words.every((w) => {
    if (hay.includes(w)) return true;
    if (!/^[a-z]{2,4}$/.test(w)) return false;
    for (let i = 0; i + w.length <= tokens.length; i++) {
      if (tokens.slice(i, i + w.length).map((t) => t[0]).join('') === w) return true;
    }
    return false;
  });
}

const desc = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
const byDateDesc = (a: string | null, b: string | null) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : a < b ? 1 : -1);
const byName = (a: ItemLeadActivityRow, b: ItemLeadActivityRow) => a.item_display_name.localeCompare(b.item_display_name, undefined, { sensitivity: 'base' }) || a.item_id - b.item_id;

/** Explicit modes only (no weighted score). Ties: most recent activity, then name. */
export function sortItemLeadActivity(rows: ItemLeadActivityRow[], mode: ItemActivitySort): ItemLeadActivityRow[] {
  const tie = (a: ItemLeadActivityRow, b: ItemLeadActivityRow) => byDateDesc(a.last_activity_date, b.last_activity_date) || byName(a, b);
  const cmp: Record<ItemActivitySort, (a: ItemLeadActivityRow, b: ItemLeadActivityRow) => number> = {
    recent: (a, b) => byDateDesc(a.last_activity_date, b.last_activity_date) || desc(a.lead_count, b.lead_count) || byName(a, b),
    leads: (a, b) => desc(a.lead_count, b.lead_count) || tie(a, b),
    negotiating: (a, b) => desc(a.negotiating_plus_count, b.negotiating_plus_count) || tie(a, b),
    offers: (a, b) => desc(a.offer_count, b.offer_count) || tie(a, b),
    channel_days: (a, b) => desc(a.channel_days, b.channel_days) || tie(a, b),
    item: byName,
  };
  return [...rows].sort(cmp[mode]);
}

/** Only items with >= 1 lead (the server already drops zero-lead items; kept here as a guard), searched, then sorted. */
export function viewItemLeadActivity(rows: ItemLeadActivityRow[], query: string, mode: ItemActivitySort): ItemLeadActivityRow[] {
  return sortItemLeadActivity(rows.filter((r) => r.lead_count > 0 && matchesItemQuery(r, query)), mode);
}

/** "13 open · 1 agreed" — current lead situation, omitted when neither. */
export function itemLeadStatusLabel(row: Pick<ItemLeadActivityRow, 'open_lead_count' | 'agreed_lead_count'>): string | null {
  const parts = [row.agreed_lead_count ? `${row.agreed_lead_count} agreed` : null, row.open_lead_count ? `${row.open_lead_count} open` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
