// Pure helpers for the /listings "Lead Activity by Item" section —
// importable from a plain Node test script. Nothing here recomputes an
// analytical number: it only picks the exact window off Listing Demand
// Evidence, sorts, and formats what the server already returned.

import type { ListingDemandEvidence } from './analytics/listingDemandEvidence';
import type { ItemActivityEntry } from './analytics/listingItemActivity';

export type { ItemActivityEntry };

export interface ItemActivityWindow {
  from: string;
  to: string;
}

/**
 * The exact analytical window behind Market/Channel Activity's Trend
 * Window: first weekly bucket's start -> last weekly bucket's end. Null
 * when the evidence has no weekly buckets.
 */
export function itemActivityWindow(evidence: ListingDemandEvidence | null): ItemActivityWindow | null {
  const w = evidence?.weekly_trend;
  if (!w || w.length === 0) return null;
  return { from: w[0].start_date, to: w[w.length - 1].end_date };
}

export function itemActivityWindowKey(win: ItemActivityWindow | null): string {
  return win ? `${win.from}|${win.to}` : '';
}

/**
 * Default order: attributed leads DESC, Serious+ DESC, Offers DESC, last
 * attributed lead date DESC (none last), item name ASC. Zero-activity
 * items are kept (they sort below active ones), never dropped.
 */
export function sortItemActivity(items: ItemActivityEntry[]): ItemActivityEntry[] {
  return [...items].sort((a, b) => {
    if (b.item_attributed_leads !== a.item_attributed_leads) return b.item_attributed_leads - a.item_attributed_leads;
    if (b.serious_plus_attributed_leads !== a.serious_plus_attributed_leads) return b.serious_plus_attributed_leads - a.serious_plus_attributed_leads;
    if (b.offer_attributed_leads !== a.offer_attributed_leads) return b.offer_attributed_leads - a.offer_attributed_leads;
    const da = a.last_attributed_lead_date;
    const db = b.last_attributed_lead_date;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? 1 : -1;
    }
    return a.item_display_name.localeCompare(b.item_display_name) || a.item_id - b.item_id;
  });
}

/** "Marketplace · Kijiji" — the item's current active channels, or an empty string. */
export function itemActiveChannelsLabel(item: Pick<ItemActivityEntry, 'active_channels'>): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const c of item.active_channels) {
    if (!seen.has(c.channel_name)) { seen.add(c.channel_name); names.push(c.channel_name); }
  }
  return names.join(' · ');
}
