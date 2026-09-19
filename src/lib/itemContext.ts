// Builds the plain-text "Copy Item Context" snapshot for one inventory item
// (Inventory Item detail page). Deliberately a pure function — no
// Supabase/React here — so the caller only has to gather data and hand it
// over (see itemContextData.ts for the efficient loader). The output is
// meant to be pasted into a dedicated ChatGPT conversation for the item, and
// separately an external GPT workflow reads the "Item ID: <id>" line to
// update a Google Sheet — that label and the underlying inventory_items.id
// value (never a database UUID) must never be renamed or removed, and it
// stays the first line after the title.
//
// Human-readable text, not JSON. Empty sections/fields are omitted (no
// "N/A" filler). Nothing is inferred: a price that was never recorded is
// simply not printed, and free-text notes are only ever quoted, never
// classified.

import type { InventoryItem } from '@/types';
import { fmtCad, formatOfferSummary, leadChannelLabel, outcomeReasonLabel, OFFER_TYPE_LABEL, QUALITY_LABEL, STATUS_LABEL } from './leads/leadFormat';
import type { LeadRow, LeadStatus } from './leads/leadTypes';
import { LEAD_QUALITIES, LEAD_STATUSES, OFFER_TYPES } from './leads/leadTypes';

export interface ItemContextPriceChange {
  /** timestamptz from item_listing_price_history.changed_at */
  changedAt: string;
  oldPrice: number | null;
  newPrice: number;
}

/** One item_listings row (one listing CYCLE) with its own price history. */
export interface ItemContextListingCycle {
  id: number;
  platformName: string;
  status: 'draft' | 'active' | 'ended' | 'cancelled';
  listedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  askingPrice: number | null;
  tradeValue: number | null;
  priceHistory: ItemContextPriceChange[];
}

/** The item_leads columns this snapshot uses (channel_name = canonical deal channel). */
export type ItemContextLead = Pick<LeadRow,
  | 'id' | 'first_contact_at' | 'last_contact_at' | 'channel_name' | 'source_channel' | 'lead_quality' | 'status'
  | 'offer_type' | 'initial_cash_offer' | 'best_cash_offer' | 'trade_item' | 'cash_component' | 'trade_est_value'
  | 'outcome_reason' | 'notes' | 'buyer_message_count' | 'our_message_count'>;

export interface ItemContextRelatedData {
  brandName: string | null;
  categoryName: string | null;
  typeName: string | null;
  purposeName: string | null;
  tagNames: string[];
  valueIn: number | null;
  valueOut: number | null;
  totalExpenses: number;
  potentialReward: number | null;
  potentialRoi: number | null;
  realizedGain: number | null;
  realizedRoi: number | null;
  acquiredDate: string | null;
  /** Every listing cycle for the item (all platforms, all statuses). */
  listingCycles?: ItemContextListingCycle[];
  /** Every lead for the item. */
  leads?: ItemContextLead[];
  /** YYYY-MM-DD used for "Days Listed" on active cycles; defaults to today (local). */
  asOfDate?: string;
}

const MAX_NOTE_CHARS = 200;

function fmtCurrency(v: number | null | undefined): string | null {
  if (v == null || Number.isNaN(v)) return null;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function fmtPercent(v: number | null | undefined): string | null {
  if (v == null || Number.isNaN(v)) return null;
  return `${v.toFixed(1)}%`;
}

function pushLine(lines: string[], label: string, value: string | number | null | undefined) {
  if (value == null || value === '') return;
  lines.push(`${label}: ${value}`);
}

/** Local calendar date (YYYY-MM-DD) of a timestamptz; date-only strings pass through unchanged. */
export function toDateOnly(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(from: string, to: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(to);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return ms >= 0 ? Math.round(ms / 86400000) : null;
}

/** One line, whitespace collapsed, capped — long notes stay compact but keep their opening content. */
export function compactNote(text: string | null | undefined, max = MAX_NOTE_CHARS): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const STATUS_TITLE: Record<ItemContextListingCycle['status'], string> = {
  draft: 'Draft (never listed)',
  active: 'Active',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

function cycleSortKey(c: ItemContextListingCycle): string {
  // Chronological by start; drafts (no listed_at) sort last.
  return c.listedAt ? toDateOnly(c.listedAt) : '9999-12-31';
}

function priceHistoryLines(cycle: ItemContextListingCycle): string[] {
  const rows = [...cycle.priceHistory].sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : 0));
  return rows.map((h, i) => {
    const date = toDateOnly(h.changedAt);
    if (h.oldPrice == null) {
      // The trigger logs the initial price as old=NULL; a later NULL->price is a price being set for the first time.
      return i === 0 ? `- ${date}: Listed at ${fmtCurrency(h.newPrice)}` : `- ${date}: Price set to ${fmtCurrency(h.newPrice)}`;
    }
    return `- ${date}: ${fmtCurrency(h.oldPrice)} → ${fmtCurrency(h.newPrice)}`;
  });
}

function listingHistorySection(cycles: ItemContextListingCycle[], asOf: string): string[] {
  if (cycles.length === 0) return [];
  const byPlatform = new Map<string, ItemContextListingCycle[]>();
  for (const c of cycles) {
    const list = byPlatform.get(c.platformName) ?? [];
    list.push(c);
    byPlatform.set(c.platformName, list);
  }
  const platforms = Array.from(byPlatform.entries())
    .map(([name, list]) => ({
      name,
      cycles: [...list].sort((a, b) => (cycleSortKey(a) < cycleSortKey(b) ? -1 : cycleSortKey(a) > cycleSortKey(b) ? 1 : a.id - b.id)),
    }))
    .sort((a, b) => (cycleSortKey(a.cycles[0]) < cycleSortKey(b.cycles[0]) ? -1 : cycleSortKey(a.cycles[0]) > cycleSortKey(b.cycles[0]) ? 1 : a.name.localeCompare(b.name)));

  const out: string[] = ['', 'LISTING HISTORY'];
  for (const p of platforms) {
    out.push('', p.name);
    p.cycles.forEach((c, i) => {
      out.push(`Cycle ${i + 1}:`);
      const cl: string[] = [];
      pushLine(cl, 'Listed', c.listedAt ? toDateOnly(c.listedAt) : null);
      pushLine(cl, 'Ended', c.endedAt ? toDateOnly(c.endedAt) : null);
      pushLine(cl, 'Cancelled', c.cancelledAt ? toDateOnly(c.cancelledAt) : null);
      pushLine(cl, 'Status', STATUS_TITLE[c.status]);
      if (c.listedAt && (c.status === 'ended' || c.status === 'active')) {
        const end = c.status === 'ended' && c.endedAt ? toDateOnly(c.endedAt) : asOf;
        const days = daysBetween(toDateOnly(c.listedAt), end);
        if (days != null) pushLine(cl, 'Days Listed', days);
      }
      pushLine(cl, c.status === 'ended' || c.status === 'cancelled' ? 'Last Asking Price' : 'Asking Price', fmtCurrency(c.askingPrice));
      pushLine(cl, 'Trade Value', fmtCurrency(c.tradeValue));
      out.push(...cl);
      const ph = priceHistoryLines(c);
      if (ph.length > 0) out.push('Price History:', ...ph);
      if (i < p.cycles.length - 1) out.push('');
    });
  }
  return out;
}

function leadDateKey(l: ItemContextLead): string {
  return l.first_contact_at ?? '9999-12-31';
}

function countBy<K extends string>(values: K[], order: readonly K[]): string {
  const counts = new Map<K, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return order.filter((k) => counts.has(k)).map((k) => `${k} ${counts.get(k)}`).join(', ');
}

function leadsSection(leads: ItemContextLead[]): string[] {
  if (leads.length === 0) return [];
  const sorted = [...leads].sort((a, b) => (leadDateKey(a) < leadDateKey(b) ? -1 : leadDateKey(a) > leadDateKey(b) ? 1 : a.id - b.id));

  const out: string[] = ['', 'LEADS', ''];
  out.push(`Total Leads: ${leads.length}`);

  const open = leads.filter((l) => l.status === 'OPEN').length;
  out.push(`Open: ${open}`);

  const statusLine = LEAD_STATUSES
    .map((s) => ({ s, n: leads.filter((l) => l.status === s).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${STATUS_LABEL[x.s as LeadStatus]} ${x.n}`)
    .join(', ');
  if (statusLine) out.push(`By Status: ${statusLine}`);

  const platformCounts = new Map<string, number>();
  for (const l of leads) {
    const name = leadChannelLabel(l);
    platformCounts.set(name, (platformCounts.get(name) ?? 0) + 1);
  }
  out.push('By Platform:');
  Array.from(platformCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([name, n]) => out.push(`${name}: ${n}`));

  const qualityLine = LEAD_QUALITIES
    .map((q) => ({ q, n: leads.filter((l) => l.lead_quality === q).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${QUALITY_LABEL[x.q]} ${x.n}`)
    .join(', ');
  if (qualityLine) out.push(`By Quality (highest reached): ${qualityLine}`);

  const withOffer = leads.filter((l) => l.offer_type !== 'NONE');
  if (withOffer.length > 0) {
    const kinds = countBy(withOffer.map((l) => l.offer_type), OFFER_TYPES.filter((t) => t !== 'NONE'));
    out.push(`With Offers: ${withOffer.length} (${kinds.replace(/(CASH|TRADE|MIXED)/g, (m) => OFFER_TYPE_LABEL[m as 'CASH' | 'TRADE' | 'MIXED'])})`);
  }

  const dated = sorted.filter((l) => l.first_contact_at);
  if (dated.length > 0) {
    out.push(`First Lead: ${dated[0].first_contact_at}`);
    out.push(`Last Lead: ${dated[dated.length - 1].first_contact_at}`);
  }

  out.push('', 'Lead History:');
  for (const l of sorted) {
    const parts: string[] = [
      l.first_contact_at ?? 'undated',
      leadChannelLabel(l),
      QUALITY_LABEL[l.lead_quality],
      formatOfferSummary(l),
    ];
    if ((l.offer_type === 'TRADE' || l.offer_type === 'MIXED') && l.trade_est_value != null) {
      parts[3] = `${parts[3]} (trade est. ${fmtCad(l.trade_est_value)})`;
    }
    const outcome = l.outcome_reason ? ` (${outcomeReasonLabel(l.outcome_reason)})` : '';
    parts.push(`${STATUS_LABEL[l.status]}${outcome}`);
    if (l.buyer_message_count != null || l.our_message_count != null) {
      parts.push(`Msgs ${l.buyer_message_count ?? '—'}/${l.our_message_count ?? '—'}`);
    }
    if (l.last_contact_at && l.last_contact_at !== l.first_contact_at) parts.push(`last contact ${l.last_contact_at}`);
    const note = compactNote(l.notes);
    if (note) parts.push(`Note: ${note}`);
    out.push(`- ${parts.join(' | ')}`);
  }
  return out;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildItemContext(item: InventoryItem, related: ItemContextRelatedData): string {
  const isSoldOrTraded = item.status === 'sold' || item.status === 'traded';

  const header: string[] = [];
  // Always first and always present — the external GPT workflow keys off
  // this exact "Item ID: <n>" label to update a Google Sheet.
  header.push(`Item ID: ${item.id}`);
  pushLine(header, 'Brand', related.brandName);
  pushLine(header, 'Model', item.model);
  pushLine(header, 'Year', item.year);
  pushLine(header, 'Color', item.color);
  pushLine(header, 'Serial Number', item.serial_number);
  pushLine(header, 'Category', related.categoryName);
  pushLine(header, 'Type', related.typeName);
  pushLine(header, 'Purpose', related.purposeName);
  pushLine(header, 'Condition', item.condition);
  pushLine(header, 'Status', item.status);

  const sections: string[] = ['ITEM CONTEXT', '', header.join('\n')];

  if (related.tagNames.length > 0) {
    sections.push('', `Tags: ${related.tagNames.join(', ')}`);
  }

  const finLines: string[] = [];
  pushLine(finLines, 'Value In', fmtCurrency(related.valueIn));
  pushLine(finLines, 'Estimated Sold Value', fmtCurrency(item.estimated_sold_value));
  if (related.totalExpenses > 0) pushLine(finLines, 'Expenses', fmtCurrency(related.totalExpenses));
  if (isSoldOrTraded) {
    pushLine(finLines, 'Value Out', fmtCurrency(related.valueOut));
    pushLine(finLines, 'Realized Profit', fmtCurrency(related.realizedGain));
    pushLine(finLines, 'ROI', fmtPercent(related.realizedRoi));
  } else {
    pushLine(finLines, 'Estimated Profit', fmtCurrency(related.potentialReward));
    pushLine(finLines, 'ROI', fmtPercent(related.potentialRoi));
  }
  if (finLines.length > 0) sections.push('', 'FINANCIALS', finLines.join('\n'));

  const dateLines: string[] = [];
  pushLine(dateLines, 'Acquired', related.acquiredDate);
  if (isSoldOrTraded) pushLine(dateLines, 'Sold', item.sold_date);
  if (dateLines.length > 0) sections.push('', 'DATES', dateLines.join('\n'));

  const asOf = related.asOfDate ?? localToday();
  sections.push(...listingHistorySection(related.listingCycles ?? [], asOf));
  sections.push(...leadsSection(related.leads ?? []));

  if (item.notes && item.notes.trim()) {
    sections.push('', 'NOTES', item.notes.trim());
  }

  return sections.join('\n');
}
