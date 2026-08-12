/**
 * fix-stale-open-listings.ts
 *
 * Finds (and optionally fixes) sold/traded inventory_items that still have
 * "open" item_listings rows (status 'draft' or 'active') left over from
 * before 20260831000000_close_listings_on_sale_trade.sql started closing
 * listings automatically on sale/trade. That migration only affects
 * operations created from here on — it cannot retroactively fix listings
 * that were already stuck open on items that sold/traded earlier.
 *
 * Definitions (per spec):
 *   - Open listing = item_listings.status IN ('draft', 'active')
 *   - Sold item    = inventory_items.status = 'sold'
 *   - Traded item  = inventory_items.status = 'traded'
 *
 * For each affected item, the "out date" used to close its listings is:
 *   - Sold item:   deal_date of its 'sale'  deal_items row with direction='out'
 *   - Traded item: deal_date of its 'trade' deal_items row with direction='out'
 * If an item has more than one distinct matching out-date (bad historical
 * data), the earliest one on/after its acquisition date is used, and the
 * row is flagged "ambiguous" in the report for visibility — it is still
 * fixed, since spec says "use the earliest valid out date ... and report
 * ambiguity" (report AND proceed), unlike the "no date found" case below.
 * If no matching out-date can be found at all, the row is left untouched
 * and reported under "needs manual review" — never guessed.
 *
 * Per-listing validation before writing anything:
 *   - active row: skipped (manual review) if the proposed ended_at would be
 *     before its own listed_at, or in the future — both would violate
 *     item_listings' own CHECK constraints anyway; caught here first so one
 *     bad row can't abort the whole fix pass, and so it shows up in the
 *     report instead of a raw DB error.
 *   - draft row: skipped (manual review) only if the proposed cancelled_at
 *     is in the future (drafts have no listed_at to violate).
 *
 * Never deletes anything — active rows become 'ended', draft rows become
 * 'cancelled'. Already-'ended'/'cancelled' rows are never selected (they
 * are not "open") and untouched rows for other reasons are simply skipped.
 *
 * Usage:
 *   npx tsx scripts/fix-stale-open-listings.ts            # report only (default, no writes)
 *   npx tsx scripts/fix-stale-open-listings.ts --fix       # apply the fixes reported above
 *
 * Connects to whatever NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * resolve to (local Supabase CLI defaults if unset) — unlike the test
 * scripts in this directory, this one is NOT restricted to local-only,
 * because its entire purpose is to repair real data. Always run without
 * --fix first and read the report before rerunning with --fix.
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from './setup-analytics-test-fixtures';

const FIX_MODE = process.argv.includes('--fix');

type ItemStatus = 'sold' | 'traded';

interface InventoryItemRow {
  id: number;
  brand_id: number | null;
  model: string | null;
  status: ItemStatus;
  sold_date: string | null;
  user_id: number;
}

interface ListingRow {
  id: number;
  inventory_item_id: number;
  deal_channel_id: number;
  status: 'draft' | 'active';
  listed_at: string | null;
}

interface DealItemRow {
  item_id: number;
  deal_id: number;
  direction: 'in' | 'out';
}

interface DealRow {
  id: number;
  deal_date: string;
  deal_type: string;
}

interface ReportRow {
  inventory_item_id: number;
  item_name: string;
  item_status: ItemStatus;
  out_date: string | null;
  listing_id: number;
  deal_channel_id: number;
  platform_name: string;
  listing_status: 'draft' | 'active';
  listed_at: string | null;
  proposed_date: string | null; // ended_at (active) or cancelled_at (draft)
  ambiguous: boolean;
  manual_review_reason: string | null;
}

function todayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  console.log(`[connect] Supabase URL: ${SUPABASE_URL}`);
  console.log(`[mode] ${FIX_MODE ? 'FIX — writes will be applied' : 'REPORT ONLY — no writes (pass --fix to apply)'}`);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const today = todayDateString();

  // ── 1. Sold/traded items ────────────────────────────────────────────────
  const { data: items, error: itemsError } = await db
    .from('inventory_items')
    .select('id, brand_id, model, status, sold_date, user_id')
    .in('status', ['sold', 'traded']);
  if (itemsError) throw new Error(`Failed to load inventory_items: ${itemsError.message}`);
  const itemRows = (items ?? []) as InventoryItemRow[];
  if (itemRows.length === 0) {
    console.log('No sold/traded inventory items found. Nothing to check.');
    return;
  }
  const itemIds = itemRows.map((i) => i.id);
  const itemById = new Map(itemRows.map((i) => [i.id, i]));

  // ── 2. Open listings on those items ─────────────────────────────────────
  const { data: listings, error: listingsError } = await db
    .from('item_listings')
    .select('id, inventory_item_id, deal_channel_id, status, listed_at')
    .in('inventory_item_id', itemIds)
    .in('status', ['draft', 'active']);
  if (listingsError) throw new Error(`Failed to load item_listings: ${listingsError.message}`);
  const listingRows = (listings ?? []) as ListingRow[];
  if (listingRows.length === 0) {
    console.log('No open (draft/active) listings on any sold/traded item. Nothing to fix.');
    return;
  }
  const affectedItemIds = Array.from(new Set(listingRows.map((l) => l.inventory_item_id)));

  // ── 3. Lookups: brands, deal_channels ───────────────────────────────────
  const { data: brands } = await db.from('brands').select('id, name');
  const brandNameById = new Map((brands ?? []).map((b: { id: number; name: string }) => [b.id, b.name]));

  const { data: channels } = await db.from('deal_channels').select('id, name');
  const channelNameById = new Map((channels ?? []).map((c: { id: number; name: string }) => [c.id, c.name]));

  // ── 4. deal_items ('in' and 'out') for the affected items, + their deals ─
  const { data: dealItems, error: dealItemsError } = await db
    .from('deal_items')
    .select('item_id, deal_id, direction')
    .in('item_id', affectedItemIds)
    .in('direction', ['in', 'out']);
  if (dealItemsError) throw new Error(`Failed to load deal_items: ${dealItemsError.message}`);
  const dealItemRows = (dealItems ?? []) as DealItemRow[];

  const dealIds = Array.from(new Set(dealItemRows.map((d) => d.deal_id)));
  const { data: deals, error: dealsError } = dealIds.length
    ? await db.from('deals').select('id, deal_date, deal_type').in('id', dealIds)
    : { data: [] as DealRow[], error: null };
  if (dealsError) throw new Error(`Failed to load deals: ${dealsError.message}`);
  const dealById = new Map(((deals ?? []) as DealRow[]).map((d) => [d.id, d]));

  // Acquisition date per item — earliest 'in' deal_date.
  const acquiredDateByItem = new Map<number, string>();
  for (const di of dealItemRows) {
    if (di.direction !== 'in') continue;
    const deal = dealById.get(di.deal_id);
    if (!deal) continue;
    const existing = acquiredDateByItem.get(di.item_id);
    if (!existing || deal.deal_date < existing) acquiredDateByItem.set(di.item_id, deal.deal_date);
  }

  // Candidate out-dates per item — 'out' deal_items whose deal_type matches
  // the item's current status ('sold' -> 'sale', 'traded' -> 'trade').
  const expectedDealType: Record<ItemStatus, string> = { sold: 'sale', traded: 'trade' };
  const outDatesByItem = new Map<number, string[]>();
  for (const di of dealItemRows) {
    if (di.direction !== 'out') continue;
    const deal = dealById.get(di.deal_id);
    if (!deal) continue;
    const item = itemById.get(di.item_id);
    if (!item) continue;
    if (deal.deal_type !== expectedDealType[item.status]) continue;
    const acquired = acquiredDateByItem.get(di.item_id);
    if (acquired && deal.deal_date < acquired) continue; // before acquisition — not a valid exit
    const list = outDatesByItem.get(di.item_id) ?? [];
    list.push(deal.deal_date);
    outDatesByItem.set(di.item_id, list);
  }

  // ── 5. Build the report ─────────────────────────────────────────────────
  const report: ReportRow[] = [];

  for (const listing of listingRows) {
    const item = itemById.get(listing.inventory_item_id)!;
    const candidates = Array.from(new Set(outDatesByItem.get(item.id) ?? [])).sort();
    const ambiguous = candidates.length > 1;
    const outDate = candidates[0] ?? null;

    const itemName = `${brandNameById.get(item.brand_id ?? -1) ?? 'Unknown brand'} ${item.model ?? ''}`.trim();
    const platformName = channelNameById.get(listing.deal_channel_id) ?? `channel #${listing.deal_channel_id}`;

    let proposedDate: string | null = null;
    let manualReviewReason: string | null = null;

    if (outDate === null) {
      manualReviewReason = `no ${expectedDealType[item.status]} deal with direction='out' found for this item (checked acquisition-date-filtered deal_items)`;
    } else if (listing.status === 'active') {
      if (listing.listed_at && outDate < listing.listed_at) {
        manualReviewReason = `deal date ${outDate} is before listed_at ${listing.listed_at} — would violate item_listings_ended_at_after_listed_at_check`;
      } else if (outDate > today) {
        manualReviewReason = `deal date ${outDate} is in the future`;
      } else {
        proposedDate = outDate;
      }
    } else {
      // draft
      if (outDate > today) {
        manualReviewReason = `deal date ${outDate} is in the future`;
      } else {
        proposedDate = outDate;
      }
    }

    report.push({
      inventory_item_id: item.id,
      item_name: itemName,
      item_status: item.status,
      out_date: outDate,
      listing_id: listing.id,
      deal_channel_id: listing.deal_channel_id,
      platform_name: platformName,
      listing_status: listing.status,
      listed_at: listing.listed_at,
      proposed_date: proposedDate,
      ambiguous,
      manual_review_reason: manualReviewReason,
    });
  }

  // ── 6. Print the report ─────────────────────────────────────────────────
  const fixable = report.filter((r) => r.manual_review_reason === null);
  const needsReview = report.filter((r) => r.manual_review_reason !== null);
  const ambiguousFixable = fixable.filter((r) => r.ambiguous);

  console.log(`\n[report] ${report.length} open listing(s) found on sold/traded items.`);
  console.log(`  fixable:              ${fixable.length} (${ambiguousFixable.length} using an earliest-of-multiple-dates heuristic — see "ambiguous" column)`);
  console.log(`  needs manual review:  ${needsReview.length}\n`);

  console.table(
    report.map((r) => ({
      item_id: r.inventory_item_id,
      item: r.item_name,
      item_status: r.item_status,
      out_date: r.out_date ?? '—',
      listing_id: r.listing_id,
      platform: r.platform_name,
      listing_status: r.listing_status,
      listed_at: r.listed_at ?? '—',
      proposed: r.proposed_date ? (r.listing_status === 'active' ? `ended_at=${r.proposed_date}` : `cancelled_at=${r.proposed_date}`) : '—',
      ambiguous: r.ambiguous ? 'yes' : '',
      needs_review: r.manual_review_reason ?? '',
    })),
  );

  if (!FIX_MODE) {
    console.log('\nDry run only — rerun with --fix to apply the updates listed above as "proposed".');
    return;
  }

  // ── 7. Apply fixes ──────────────────────────────────────────────────────
  console.log('\n[fix] Applying updates...');
  let ended = 0;
  let cancelled = 0;
  let failed = 0;

  for (const r of fixable) {
    const isActive = r.listing_status === 'active';
    const { error } = await db
      .from('item_listings')
      .update(
        isActive
          ? { status: 'ended', ended_at: r.proposed_date }
          : { status: 'cancelled', cancelled_at: r.proposed_date },
      )
      .eq('id', r.listing_id)
      .eq('status', r.listing_status); // defense in depth against a concurrent change since the report was built

    if (error) {
      failed++;
      console.error(`  FAILED listing_id=${r.listing_id}: ${error.message}`);
    } else if (isActive) {
      ended++;
    } else {
      cancelled++;
    }
  }

  console.log(`\n[fix] Done. ${ended} listing(s) -> ended, ${cancelled} listing(s) -> cancelled, ${failed} failed.`);
  console.log(`[fix] ${needsReview.length} listing(s) left untouched — see "needs_review" column above.`);
}

main().catch((err) => {
  console.error('Script crashed:', err);
  process.exit(1);
});
