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

import { buildItemContext, compactNote, type ItemContextRelatedData, type ItemContextListingCycle, type ItemContextLead } from '../src/lib/itemContext';
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
  listingCycles: [
    { id: 1, platformName: 'Reverb', status: 'active', listedAt: '2026-07-10', endedAt: null, cancelledAt: null, askingPrice: null, tradeValue: null, priceHistory: [] },
    { id: 2, platformName: 'Marketplace', status: 'active', listedAt: '2026-07-15', endedAt: null, cancelledAt: null, askingPrice: null, tradeValue: null, priceHistory: [] },
  ],
  asOfDate: '2026-08-01',
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
    check('FINANCIALS section present', text.includes('\nFINANCIALS\n'), text);
    check('Value In formatted with thousands separator, no forced decimals', text.includes('Value In: $2,200'), text);
    check('Estimated Sold Value included', text.includes('Estimated Sold Value: $3,000'), text);
    check('Expenses included when > 0', text.includes('Expenses: $50'), text);
    check('Estimated Profit shown for a non-sold/traded item', text.includes('Estimated Profit: $750'), text);
    check('ROI formatted to one decimal with a percent sign', text.includes('ROI: 34.1%'), text);
    check('DATES section present with Acquired', text.includes('\nDATES\n') && text.includes('Acquired: 2026-05-03'), text);
    check('LISTING HISTORY section lists each platform with its cycle', text.includes('\nLISTING HISTORY\n') && text.includes('\nReverb\nCycle 1:\nListed: 2026-07-10') && text.includes('\nMarketplace\nCycle 1:\nListed: 2026-07-15'), text);
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
    check('LISTING HISTORY omitted entirely when there are no listing cycles', !text.includes('LISTING HISTORY'), text);
    check('LEADS omitted entirely when there are no leads', !text.includes('LEADS'), text);
    check('NOTES block omitted entirely when notes is null', !text.includes('NOTES'), text);
    // Financials still renders because Estimated Sold Value exists on BASE_ITEM.
    check('FINANCIALS block present (Estimated Sold Value still populated on the item)', text.includes('FINANCIALS'), text);
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
    check('no FINANCIALS section when nothing to report', !text.includes('FINANCIALS'), text);
    check('no DATES section when nothing to report', !text.includes('DATES'), text);
  }

  console.log('\n[D — sold/traded items show Value Out / Realized Profit / Sold date instead of Estimated Profit]');
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
    check('shows Realized Profit', text.includes('Realized Profit: $950'), text);
    check('shows ROI from the realized figure', text.includes('ROI: 43.2%'), text);
    check('does not show Estimated Profit for a sold item', !text.includes('Estimated Profit'), text);
    check('shows Sold date under Dates', text.includes('Sold: 2026-08-01'), text);
  }

  console.log('\n[E — listing history: ALL cycles, all platforms, chronological, price history attached to the right cycle]');
  {
    const cycles: ItemContextListingCycle[] = [
      // deliberately shuffled input order
      { id: 30, platformName: 'Reverb', status: 'active', listedAt: '2026-07-11', endedAt: null, cancelledAt: null, askingPrice: 2950, tradeValue: 2800,
        priceHistory: [
          { changedAt: '2026-08-15T15:00:00Z', oldPrice: 3100, newPrice: 2950 },
          { changedAt: '2026-07-11T15:00:00Z', oldPrice: null, newPrice: 3200 },
          { changedAt: '2026-07-28T15:00:00Z', oldPrice: 3200, newPrice: 3100 },
        ] },
      { id: 10, platformName: 'Reverb', status: 'ended', listedAt: '2026-05-10', endedAt: '2026-06-15', cancelledAt: null, askingPrice: 3400, tradeValue: null,
        priceHistory: [{ changedAt: '2026-05-10T15:00:00Z', oldPrice: null, newPrice: 3400 }] },
      { id: 20, platformName: 'Marketplace', status: 'cancelled', listedAt: '2026-06-01', endedAt: null, cancelledAt: '2026-06-03', askingPrice: 2500, tradeValue: null, priceHistory: [] },
      { id: 40, platformName: 'Kijiji', status: 'draft', listedAt: null, endedAt: null, cancelledAt: null, askingPrice: 2999, tradeValue: null, priceHistory: [] },
    ];
    const text = buildItemContext(BASE_ITEM, { ...EMPTY_RELATED, listingCycles: cycles, asOfDate: '2026-08-20' });
    const at = (needle: string) => text.indexOf(needle);
    check('multiple cycles on the same platform stay separate (Cycle 1 / Cycle 2)', text.includes('Reverb\nCycle 1:\nListed: 2026-05-10') && text.includes('Cycle 2:\nListed: 2026-07-11'), text);
    check('cycles are numbered chronologically regardless of input order', at('Listed: 2026-05-10') < at('Listed: 2026-07-11'));
    check('platforms ordered by their first cycle (Reverb, then Marketplace, then draft-only Kijiji)', at('\nReverb\n') < at('\nMarketplace\n') && at('\nMarketplace\n') < at('\nKijiji\n'), text);
    check('ended cycle shows Ended date, Status and Days Listed (36)', text.includes('Listed: 2026-05-10\nEnded: 2026-06-15\nStatus: Ended\nDays Listed: 36\nLast Asking Price: $3,400'), text);
    check('active cycle shows Status Active, Days Listed to asOf (40) and Asking Price', text.includes('Listed: 2026-07-11\nStatus: Active\nDays Listed: 40\nAsking Price: $2,950'), text);
    check('trade value shown only when recorded', text.includes('Trade Value: $2,800') && (text.match(/Trade Value:/g) ?? []).length === 1);
    check('cancelled cycle is INCLUDED with its cancelled date', text.includes('Marketplace\nCycle 1:\nListed: 2026-06-01\nCancelled: 2026-06-03\nStatus: Cancelled'), text);
    check('draft cycle is included and clearly marked never listed', text.includes('Kijiji\nCycle 1:\nStatus: Draft (never listed)\nAsking Price: $2,999'), text);
    check('price history is chronological (input was shuffled) inside the correct cycle', text.includes('Price History:\n- 2026-07-11: Listed at $3,200\n- 2026-07-28: $3,200 → $3,100\n- 2026-08-15: $3,100 → $2,950'), text);
    const reverbCycle1 = text.slice(at('Cycle 1:'), at('Cycle 2:'));
    check('cycle 1 (May) only carries ITS OWN single price entry', reverbCycle1.includes('- 2026-05-10: Listed at $3,400') && !reverbCycle1.includes('3,200'), reverbCycle1);
    check('a cycle with no history prints no Price History block', !text.slice(at('Marketplace\nCycle 1:'), at('Kijiji')).includes('Price History'));
    check('no asking-price/original price is invented when history is absent', !text.includes('Listed at $2,500') && !text.includes('Listed at $2,999'));
    const lateNull = buildItemContext(BASE_ITEM, { ...EMPTY_RELATED, listingCycles: [
      { id: 1, platformName: 'Reverb', status: 'active', listedAt: '2026-07-01', endedAt: null, cancelledAt: null, askingPrice: 900, tradeValue: null,
        priceHistory: [{ changedAt: '2026-07-01T15:00:00Z', oldPrice: 1000, newPrice: 950 }, { changedAt: '2026-07-05T15:00:00Z', oldPrice: null, newPrice: 900 }] },
    ] });
    check('a first-ever entry with a previous price is a plain change; a later NULL->price is "Price set to"', lateNull.includes('- 2026-07-01: $1,000 → $950') && lateNull.includes('- 2026-07-05: Price set to $900'), lateNull);
  }

  console.log('\n[E2 — leads: compact summary + chronological history]');
  {
    const mk = (over: Partial<ItemContextLead> & { id: number }): ItemContextLead => ({
      first_contact_at: '2026-07-13', last_contact_at: '2026-07-13', channel_name: 'Marketplace', source_channel: 'Marketplace', lead_quality: 'LOW', status: 'OPEN',
      offer_type: 'NONE', initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null, trade_est_value: null, outcome_reason: null, notes: null,
      buyer_message_count: 3, our_message_count: 1, ...over,
    });
    const leads: ItemContextLead[] = [
      mk({ id: 4, first_contact_at: '2026-08-14', last_contact_at: '2026-08-14', channel_name: 'Reverb', lead_quality: 'ENGAGED', status: 'GHOSTED' }),
      mk({ id: 1, first_contact_at: '2026-07-13', last_contact_at: '2026-07-15', lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 2600, initial_cash_offer: 2400, status: 'DECLINED_BY_ME', outcome_reason: 'LOW_OFFER', notes: 'Wanted it for $2,400 first, then moved up.' }),
      mk({ id: 2, first_contact_at: '2026-07-20', last_contact_at: '2026-07-20', channel_name: 'Kijiji', lead_quality: 'ENGAGED', offer_type: 'TRADE', trade_item: 'Fender Strat', cash_component: 0, trade_est_value: 1800, status: 'OPEN' }),
      mk({ id: 3, first_contact_at: '2026-08-02', last_contact_at: '2026-08-02', offer_type: 'MIXED', trade_item: 'Rickenbacker 330', cash_component: -500, lead_quality: 'HIGH_INTENT', status: 'COMPLETED', notes: 'x '.repeat(300) }),
      mk({ id: 5, first_contact_at: null, last_contact_at: null, channel_name: null, source_channel: 'Other', buyer_message_count: null, our_message_count: null }),
    ];
    const text = buildItemContext(BASE_ITEM, { ...EMPTY_RELATED, leads });
    check('Total Leads matches the input count (5)', text.includes('Total Leads: 5'), text);
    check('Open count matches (OPEN: leads 2, 5, => 2)', text.includes('Open: 2'), text);
    check('By Status only lists statuses that exist', text.includes('By Status: Open 2, Ghosted 1, Declined by me 1, Completed 1'), text);
    check('By Platform counts (Marketplace 2, then Kijiji 1, Other 1, Reverb 1)', text.includes('By Platform:\nMarketplace: 2\nKijiji: 1\nOther: 1\nReverb: 1'), text);
    check('By Quality reports the highest level reached', text.includes('By Quality (highest reached): Low 1, Engaged 2, Serious 1, High intent 1'), text);
    check('With Offers counts leads (max 1 each) by kind', text.includes('With Offers: 3 (Cash 1, Trade 1, Mixed 1)'), text);
    check('First/Last Lead dates from dated leads only', text.includes('First Lead: 2026-07-13') && text.includes('Last Lead: 2026-08-14'));
    const hist = text.slice(text.indexOf('Lead History:')).split('\n').filter((l) => l.startsWith('- '));
    check('history is chronological, undated last', hist.length === 5 && hist[0].startsWith('- 2026-07-13') && hist[1].startsWith('- 2026-07-20') && hist[2].startsWith('- 2026-08-02') && hist[3].startsWith('- 2026-08-14') && hist[4].startsWith('- undated'), hist);
    check('cash lead line: date | platform | quality | offer | status (reason) | msgs | last contact | note', hist[0] === '- 2026-07-13 | Marketplace | Serious | $2,600 cash | Declined by me (Low offer) | Msgs 3/1 | last contact 2026-07-15 | Note: Wanted it for $2,400 first, then moved up.', hist[0]);
    check('trade lead line uses the app\'s offer wording + trade estimate', hist[1].includes('Kijiji | Engaged | Trade: Fender Strat (trade est. $1,800) | Open'), hist[1]);
    check('mixed lead keeps cash direction (from us) and status', hist[2].includes('Rickenbacker 330 + $500 from us') && hist[2].includes('Completed'), hist[2]);
    check('long notes are compacted to one capped line', hist[2].length < 420 && hist[2].includes('…') && !hist[2].includes('\n'), hist[2].length);
    check('missing message counts render as em-dashes only when partially known; omitted when both unknown', !hist[4].includes('Msgs'));
    check('NULL-channel lead falls back to its logged source channel', hist[4].includes('| Other |'), hist[4]);
    check('compactNote collapses whitespace/newlines and trims', compactNote('  a\n\n b\t c ') === 'a b c' && compactNote('   ') === null && compactNote(null) === null);
    check('no free-text classification: notes are quoted verbatim, never turned into statuses', !/Declined|Ghosted/.test(hist[3].split('| Note:')[1] ?? ''));
  }

  console.log('\n[F — Notes preserved verbatim, never invented]');
  {
    const withNotes: InventoryItem = { ...BASE_ITEM, notes: '  Small buckle rash on back. Original pickups included.  ' };
    const text = buildItemContext(withNotes, EMPTY_RELATED);
    check('NOTES section trims surrounding whitespace but preserves content', text.includes('NOTES\nSmall buckle rash on back. Original pickups included.'), text);
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

  console.log('\n[I2 — clipboard: text may be a Promise (history loads at click time)]');
  {
    const captured: { text: string | null } = { text: null };
    const plain: ItemContextClipboardDeps = { writeText: async (t) => { captured.text = t; } };
    const ok = await copyItemContextToClipboard(plain, Promise.resolve('LOADED'));
    check('a Promise text is awaited and written via writeText when no promise-write is available', ok.status === 'success' && captured.text === 'LOADED', ok);

    const viaPromise: { text: string | null } = { text: null };
    const withLazy: ItemContextClipboardDeps = { writeText: async () => { throw new Error('should not be used'); }, writeTextFromPromise: async (p) => { viaPromise.text = await p; } };
    const lazy = await copyItemContextToClipboard(withLazy, Promise.resolve('LAZY'));
    check('with promise-write support the pending text is handed over unresolved (user-gesture safe)', lazy.status === 'success' && viaPromise.text === 'LAZY', lazy);

    const failedLoad = await copyItemContextToClipboard(plain, Promise.reject(new Error('rls exploded')));
    check('a failed history load reports load_failed and copies nothing', failedLoad.status === 'load_failed' && captured.text === 'LOADED', failedLoad);
    if (failedLoad.status === 'load_failed') check('load error message is safe/clear', !failedLoad.message.includes('rls exploded') && failedLoad.message.length > 0);

    const failedLoadLazy = await copyItemContextToClipboard({ writeText: async () => {}, writeTextFromPromise: async (p) => { await p; } }, Promise.reject(new Error('boom')));
    check('a failed load through the promise-write path is also load_failed (not a clipboard error)', failedLoadLazy.status === 'load_failed', failedLoadLazy);

    let plainWrites = 0;
    const lazyUnsupported: ItemContextClipboardDeps = { writeText: async () => { plainWrites++; }, writeTextFromPromise: async () => { throw new Error('ClipboardItem not supported'); } };
    const fallback = await copyItemContextToClipboard(lazyUnsupported, Promise.resolve('FB'));
    check('if the promise-write is unsupported it falls back to writeText', fallback.status === 'success' && plainWrites === 1, fallback);

    const denied = await copyItemContextToClipboard({ writeText: async () => { throw new Error('denied'); } }, Promise.resolve('x'));
    check('clipboard denial after a good load is still clipboard_failed', denied.status === 'clipboard_failed', denied);
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

  console.log('\n[K — Deal ID: the completed EXIT deal, never the acquisition deal]');
  {
    const soldItem = { ...BASE_ITEM, status: 'sold' as const, sold_date: '2026-08-01' };
    const tradedItem = { ...BASE_ITEM, status: 'traded' as const, sold_date: '2026-08-01' };
    const ownedItem = { ...BASE_ITEM, status: 'owned' as const, sold_date: null };

    // A. Bought item, still owned -> no completed exit Deal ID (line omitted, never "Deal ID: —").
    {
      const text = buildItemContext(ownedItem, { ...EMPTY_RELATED, exitDealId: null });
      check('A: owned item omits the Deal ID line entirely', !text.includes('Deal ID'), text);
    }

    // B. Bought item, later SOLD -> Deal ID = the SELL deal id, never the acquisition deal id.
    {
      const text = buildItemContext(soldItem, { ...EMPTY_RELATED, exitDealId: 501 });
      check('B: sold item shows "Deal ID: 501" (the sell deal, not an acquisition deal id)', text.includes('Deal ID: 501'), text);
      check('B: exactly one Deal ID line is rendered', (text.match(/Deal ID:/g) ?? []).length === 1, text);
    }

    // C. Bought item, later TRADED AWAY -> Deal ID = the trade deal it went OUT on.
    {
      const text = buildItemContext(tradedItem, { ...EMPTY_RELATED, exitDealId: 777 });
      check('C: traded-away item shows "Deal ID: 777" (the trade it went out on)', text.includes('Deal ID: 777'), text);
    }

    // D. Multi-item Sell -> every outgoing item's own context carries the SAME Sell Deal ID.
    {
      const itemX = buildItemContext({ ...soldItem, id: 901 }, { ...EMPTY_RELATED, exitDealId: 850 });
      const itemY = buildItemContext({ ...soldItem, id: 902 }, { ...EMPTY_RELATED, exitDealId: 850 });
      check('D: two items sold together both show the same Deal ID', itemX.includes('Deal ID: 850') && itemY.includes('Deal ID: 850'));
    }

    // E. Multi-item Trade -> every outgoing item's own context carries the SAME Trade Deal ID.
    {
      const itemX = buildItemContext({ ...tradedItem, id: 903 }, { ...EMPTY_RELATED, exitDealId: 860 });
      const itemY = buildItemContext({ ...tradedItem, id: 904 }, { ...EMPTY_RELATED, exitDealId: 860 });
      check('E: two items traded away together both show the same Deal ID', itemX.includes('Deal ID: 860') && itemY.includes('Deal ID: 860'));
    }

    // F. Incoming item from a trade, STILL OWNED -> must NOT expose that trade as an exit Deal ID.
    // (The loader never returns an exitDealId for an item whose only deal_items row is 'in' — modeled
    // here simply as exitDealId: null, since buildItemContext itself has no direction concept; the
    // resolver-level guarantee is asserted separately below via itemContextData.ts's source.)
    {
      const text = buildItemContext(ownedItem, { ...EMPTY_RELATED, exitDealId: null });
      check('F: an item only ever acquired (including via an incoming trade) and still owned has no Deal ID line', !text.includes('Deal ID'), text);
    }

    // G. Historical import / opening acquisition only -> not treated as an exit Deal ID.
    {
      const text = buildItemContext(ownedItem, { ...EMPTY_RELATED, exitDealId: null, acquiredDate: '2020-01-01' });
      check('G: a historical-import-only item (acquisition recorded, never realized) has no Deal ID line', !text.includes('Deal ID'), text);
    }

    // Placement: near Status, and omitted (not "—") when null — matches this formatter's
    // existing "no N/A filler" convention (contrast with sold/traded fields, which DO use "—"
    // for a genuinely blank required-looking value elsewhere in this codebase's other UI).
    {
      const withDeal = buildItemContext(soldItem, { ...EMPTY_RELATED, exitDealId: 123 });
      const lines = withDeal.split('\n');
      const statusIdx = lines.findIndex((l) => l === 'Status: sold');
      const dealIdx = lines.findIndex((l) => l === 'Deal ID: 123');
      check('Deal ID line sits immediately after Status in the header', dealIdx === statusIdx + 1, { statusIdx, dealIdx, lines });
      check('Deal ID is never rendered as "Deal ID: —"', !withDeal.includes('Deal ID: —'));
    }

    // itemContextData.ts's own exit-deal resolver: outgoing-only, realized-deal-type-only.
    const dataSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'itemContextData.ts'), 'utf8');
    check('the exit-deal loader only ever reads the OUTGOING (\'out\') side of deal_items', /\.eq\('direction', 'out'\)/.test(dataSource), 'no direction=out filter found');
    check('the exit-deal loader restricts to realized deal types (sale/trade), mirroring analytics_item_lifecycle\'s exit_deal CTE', /REALIZED_EXIT_DEAL_TYPES/.test(dataSource) && /'sale'/.test(dataSource) && /'trade'/.test(dataSource));
    check('the exit-deal loader never reads the acquisition (\'in\') side as an exit', !/eq\('direction',\s*'in'\)/.test(dataSource));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
