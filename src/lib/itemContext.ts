// Builds the plain-text "Copy Item Context" summary for one inventory item
// (Inventory Item detail page). Deliberately a pure function — no
// Supabase/React here — so the Item Detail page only has to gather data it
// has already loaded and hand it to this formatter. The output is meant to
// be pasted into an external ChatGPT conversation, and separately an
// external GPT workflow reads the "Item ID: <id>" line to update a Google
// Sheet — that label and the underlying inventory_items.id value (never a
// database UUID) must never be renamed or removed.

import type { InventoryItem } from '@/types';

export interface ItemContextListingSummary {
  platformName: string;
  status: 'draft' | 'active' | 'ended' | 'cancelled';
  listedAt: string | null;
  endedAt: string | null;
}

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
  listings: ItemContextListingSummary[];
}

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
    pushLine(finLines, 'Realized Gain', fmtCurrency(related.realizedGain));
    pushLine(finLines, 'ROI', fmtPercent(related.realizedRoi));
  } else {
    pushLine(finLines, 'Potential Reward', fmtCurrency(related.potentialReward));
    pushLine(finLines, 'ROI', fmtPercent(related.potentialRoi));
  }
  if (finLines.length > 0) sections.push('', 'Financials:', finLines.join('\n'));

  const dateLines: string[] = [];
  pushLine(dateLines, 'Acquired', related.acquiredDate);
  if (isSoldOrTraded) pushLine(dateLines, 'Sold', item.sold_date);
  if (dateLines.length > 0) sections.push('', 'Dates:', dateLines.join('\n'));

  const listingLines = related.listings
    .filter((l) => l.status !== 'cancelled' && l.listedAt)
    .map((l) => {
      const suffix = l.status === 'ended' && l.endedAt ? ` (ended ${l.endedAt})` : '';
      return `- ${l.platformName}: listed ${l.listedAt}${suffix}`;
    });
  if (listingLines.length > 0) sections.push('', 'Listings:', listingLines.join('\n'));

  if (item.notes && item.notes.trim()) {
    sections.push('', 'Notes:', item.notes.trim());
  }

  return sections.join('\n');
}
