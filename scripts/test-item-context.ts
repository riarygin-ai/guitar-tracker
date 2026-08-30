/**
 * test-item-context.ts
 *
 * Focused validation for the "Copy Item Context" feature (Inventory Item
 * detail page): the pure formatter (src/lib/itemContext.ts) and the
 * clipboard wiring (src/lib/itemContextClipboard.ts, src/components/
 * CopyItemContextButton.tsx). This is pure logic/unit coverage — writeText
 * is an injected dependency and buildItemContext takes plain fixtures, so
 * none of this needs a DOM, a browser, or a running Next.js server — same
 * "no test framework, local check()" convention as every other script in
 * this directory, and no local-Supabase gate since nothing here touches a
 * database.
 *
 * Usage:
 *   npx tsx scripts/test-item-context.ts
 */

import { buildItemContext, type ItemContextRelatedData, type ItemContextListingSummary } from '../src/lib/itemContext';
import { copyItemContextToClipboard, createItemContextCopier, type ItemContextClipboardDeps } from '../src/lib/itemContextClipboard';
import type { InventoryItem } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`, detail !== undefined ? detail : '');
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────

const BASE_ITEM: InventoryItem = {
  id: 123,
  user_id: 1,
  brand_id: 1,
  item_subtype_id: 1,
  model: 'Les Paul Standard 50s',
  serial_number: null,
  sold_date: null,
  estimated_sold_value: 3000,
  collection_type: 'Business',
  purpose_id: 1,
  condition: 'Excellent',
  status: 'listed',
  notes: null,
  year: 2021,
  color: 'Heritage Cherry Sunburst',
  created_at: '2026-05-03T00:00:00.000Z',
  updated_at: '2026-05-03T00:00:00.000Z',
};

const EMPTY_RELATED: ItemContextRelatedData = {
  brandName: null,
  categoryName: null,
  typeName: null,
  purposeName: null,
  tagNames: [],
  valueIn: null,
  valueOut: null,
  totalExpenses: 0,
  potentialReward: null,
  potentialRoi: null,
  realizedGain: null,
  realizedRoi: null,
  acquiredDate: null,
  listings: [],
};

const FULL_RELATED: ItemContextRelatedData = {
  brandName: 'Gibson',
  categoryName: 'Guitar',
  typeName: 'Electric Guitar',
  purposeName: 'Business',
  tagNames: ['COA', 'Original Case', 'Case Candy'],
  valueIn: 2200,
  valueOut: null,
  totalExpenses: 50,
  potentialReward: 750,
  potentialRoi: 34.1,
  realizedGain: null,
  realizedRoi: null,
  acquiredDate: '2026-05-03',
  listings: [
    { platformName: 'Reverb', status: 'active', listedAt: '2026-07-10', endedAt: null },
    { platformName: 'Marketplace', status: 'active', listedAt: '2026-07-15', endedAt: null },
  ],
};

async function main() {
  console.log('\n[A — Item ID is always included, first, and uses the app ID (not a UUID)]');
  {
    const text = buildItemContext(BASE_ITEM, EMPTY_RELATED);
    check('contains the exact "Item ID: 123" label', text.includes('Item ID: 123'), text);
    const lines = text.split('\n').filter((l) => l.trim());
    check('"Item ID:" is the first content line after the title', lines[1] === 'Item ID: 123', lines);
    check('never renders a UUID-looking value', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text), text);

    const bigIdItem = { ...BASE_ITEM, id: 987654 };
    const text2 = buildItemContext(bigIdItem, EMPTY_RELATED);
    check('Item ID reflects the actual item id passed in, not a hardcoded value', text2.includes('Item ID: 987654'), text2);
  }

  console.log('\n[B — full item renders every populated section]');
  {
    const text = buildItemContext(BASE_ITEM, FULL_RELATED);
    check('header includes Brand/Model/Year/Color/Category/Type/Purpose/Condition/Status',
      ['Brand: Gibson', 'Model: Les Paul Standard 50s', 'Year: 2021', 'Color: Heritage Cherry Sunburst',
       'Category: Guitar', 'Type: Electric Guitar', 'Purpose: Business', 'Condition: Excellent', 'Status: listed']
        .every((line) => text.includes(line)),
      text);
    check('Tags rendered as a comma-separated list', text.includes('Tags: COA, Original Case, Case Candy'), text);
    check('Financials section present', text.includes('Financials:'), text);
    check('Value In formatted with thousands separator, no forced decimals', text.includes('Value In: $2,200'), text);
    check('Estimated Sold Value included', text.includes('Estimated Sold Value: $3,000'), text);
    check('Expenses included when > 0', text.includes('Expenses: $50'), text);
    check('Potential Reward shown for a non-sold/traded item', text.includes('Potential Reward: $750'), text);
    check('ROI formatted to one decimal with a percent sign', text.includes('ROI: 34.1%'), text);
    check('Dates section present with Acquired', text.includes('Dates:') && text.includes('Acquired: 2026-05-03'), text);
    check('Listings section compact per-platform', text.includes('Listings:') && text.includes('- Reverb: listed 2026-07-10') && text.includes('- Marketplace: listed 2026-07-15'), text);
  }

  console.log('\n[C — empty/missing fields are omitted cleanly, no blank/undefined/null leaks]');
  {
    const text = buildItemContext(BASE_ITEM, EMPTY_RELATED);
    check('no line ever renders the literal "null"', !text.includes('null'), text);
    check('no line ever renders the literal "undefined"', !text.includes('undefined'), text);
    check('Brand line omitted when brandName is null', !text.includes('Brand:'), text);
    check('Category line omitted when categoryName is null', !text.includes('Category:'), text);
    check('Purpose line omitted when purposeName is null', !text.includes('Purpose:'), text);
    check('Serial Number line omitted when null', !text.includes('Serial Number:'), text);
    check('Tags block omitted entirely when there are no tags', !text.includes('Tags:'), text);
    check('Listings block omitted entirely when there are no listings', !text.includes('Listings:'), text);
    check('Notes block omitted entirely when notes is null', !text.includes('Notes:'), text);
    // Financials still renders because Estimated Sold Value exists on BASE_ITEM.
    check('Financials block present (Estimated Sold Value still populated on the item)', text.includes('Financials:'), text);
    check('Value In omitted from Financials when null', !text.includes('Value In:'), text);
    check('Expenses omitted from Financials when 0', !text.includes('Expenses:'), text);
  }

  console.log('\n[C2 — an item with nothing populated at all produces just the ID + required fields]');
  {
    const minimalItem: InventoryItem = {
      ...BASE_ITEM,
      estimated_sold_value: null,
      condition: null,
      color: null,
      year: null,
      serial_number: null,
      notes: null,
    };
    const text = buildItemContext(minimalItem, EMPTY_RELATED);
    check('still includes Item ID', text.includes('Item ID: 123'), text);
    check('still includes Model (always present on InventoryItem)', text.includes(`Model: ${minimalItem.model}`), text);
    check('still includes Status', text.includes(`Status: ${minimalItem.status}`), text);
    check('no Financials section when nothing to report', !text.includes('Financials:'), text);
    check('no Dates section when nothing to report', !text.includes('Dates:'), text);
  }

  console.log('\n[D — sold/traded items show Value Out / Realized Gain / Sold date instead of Potential Reward]');
  {
    const soldItem: InventoryItem = { ...BASE_ITEM, status: 'sold', sold_date: '2026-08-01' };
    const soldRelated: ItemContextRelatedData = {
      ...FULL_RELATED,
      valueOut: 3200,
      realizedGain: 950,
      realizedRoi: 43.2,
      potentialReward: null,
      potentialRoi: null,
    };
    const text = buildItemContext(soldItem, soldRelated);
    check('shows Value Out', text.includes('Value Out: $3,200'), text);
    check('shows Realized Gain', text.includes('Realized Gain: $950'), text);
    check('shows ROI from the realized figure', text.includes('ROI: 43.2%'), text);
    check('does not show Potential Reward for a sold item', !text.includes('Potential Reward'), text);
    check('shows Sold date under Dates', text.includes('Sold: 2026-08-01'), text);
  }

  console.log('\n[E — listings: cancelled cycles excluded, ended cycles annotated]');
  {
    const listings: ItemContextListingSummary[] = [
      { platformName: 'Reverb', status: 'ended', listedAt: '2026-07-10', endedAt: '2026-08-01' },
      { platformName: 'CraigsList', status: 'cancelled', listedAt: '2026-06-01', endedAt: null },
      { platformName: 'Marketplace', status: 'draft', listedAt: null, endedAt: null },
    ];
    const text = buildItemContext(BASE_ITEM, { ...EMPTY_RELATED, listings });
    check('ended listing shown with its listed date and ended-date annotation', text.includes('- Reverb: listed 2026-07-10 (ended 2026-08-01)'), text);
    check('cancelled listing never appears', !text.includes('CraigsList'), text);
    check('draft listing with no listed_at never appears', !text.includes('Marketplace'), text);
  }

  console.log('\n[F — Notes preserved verbatim, never invented]');
  {
    const withNotes: InventoryItem = { ...BASE_ITEM, notes: '  Small buckle rash on back. Original pickups included.  ' };
    const text = buildItemContext(withNotes, EMPTY_RELATED);
    check('Notes section trims surrounding whitespace but preserves content', text.includes('Notes:\nSmall buckle rash on back. Original pickups included.'), text);
  }

  console.log('\n[G — clipboard copy: success path]');
  {
    const captured: { text: string | null } = { text: null };
    const deps: ItemContextClipboardDeps = { writeText: async (text) => { captured.text = text; } };
    const result = await copyItemContextToClipboard(deps, 'ITEM CONTEXT\n\nItem ID: 123');
    check('result is success', result.status === 'success', result);
    check('exact text handed to writeText, unmodified', captured.text === 'ITEM CONTEXT\n\nItem ID: 123', captured.text);
  }

  console.log('\n[H — clipboard copy: write failure produces a clear, safe error]');
  {
    const deps: ItemContextClipboardDeps = { writeText: async () => { throw new Error('NotAllowedError: permission denied'); } };
    const result = await copyItemContextToClipboard(deps, 'text');
    check('result status is clipboard_failed', result.status === 'clipboard_failed', result);
    if (result.status === 'clipboard_failed') {
      check('message is clear and does not leak the raw browser error', !result.message.includes('NotAllowedError') && result.message.length > 0, result.message);
    }
  }

  console.log('\n[I — repeated clicks while a copy is in flight only ever write once]');
  {
    let writeCount = 0;
    let resolveFirst: (() => void) | null = null;
    const deps: ItemContextClipboardDeps = {
      writeText: async () => {
        writeCount++;
        if (writeCount === 1) {
          await new Promise<void>((resolve) => { resolveFirst = resolve; });
        }
      },
    };
    const copier = createItemContextCopier(deps);
    const firstCall = copier.copy('text');
    const secondResult = await copier.copy('text');
    check('second concurrent call rejected as already_in_progress', secondResult.status === 'already_in_progress', secondResult);
    check('writeText only called once so far', writeCount === 1, writeCount);
    resolveFirst!();
    const firstResult = await firstCall;
    check('first call completes successfully', firstResult.status === 'success', firstResult);
    const thirdResult = await copier.copy('text');
    check('a new call after completion is allowed through', thirdResult.status === 'success', thirdResult);
    check('writeText called exactly twice total', writeCount === 2, writeCount);
  }

  console.log('\n[J — no accidental logging of item content]');
  {
    const libSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'itemContext.ts'), 'utf8');
    const clipboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'itemContextClipboard.ts'), 'utf8');
    const componentSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CopyItemContextButton.tsx'), 'utf8');
    check('itemContext.ts contains no console.* calls', !/console\.(log|error|warn|info|debug)\s*\(/.test(libSource), 'console call found');
    check('itemContextClipboard.ts contains no console.* calls', !/console\.(log|error|warn|info|debug)\s*\(/.test(clipboardSource), 'console call found');
    check('CopyItemContextButton.tsx contains no console.* calls', !/console\.(log|error|warn|info|debug)\s*\(/.test(componentSource), 'console call found');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
